/**
 * @fileoverview RCSB service — wraps the RCSB Search API v2 (text / sequence /
 * chemical search + server-side faceted aggregation), the Data API GraphQL
 * endpoint (batched entry metadata + ligand binding-site residues via
 * `rcsb_target_neighbors`), the REST chemical-component endpoint, and coordinate
 * file URLs. The PDB's full query surface lives only here; predicted models are
 * served by the AlphaFold / 3D-Beacons services.
 * @module services/rcsb/rcsb-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import type { ServerConfig } from '@/config/server-config.js';
import { fetchJson } from '../shared/http.js';
import type {
  BindingResidue,
  BindingSite,
  ChemComp,
  ContentType,
  EntryMeta,
  FacetBucket,
  FacetDimension,
  LigandMeta,
  PolymerEntityMeta,
  SearchHit,
  SearchResult,
  StructureSearchParams,
} from './types.js';

/** RCSB return types relevant to this server. */
export type ReturnType = 'entry' | 'polymer_entity' | 'mol_definition';

/** A facet dimension request: friendly name + how RCSB should aggregate it. */
export interface FacetSpec {
  /** Aggregation kind. */
  aggregation: 'terms' | 'histogram' | 'date_histogram';
  /** RCSB attribute to aggregate. */
  attribute: string;
  /** Optional nested dimension for a cross-tab. */
  child?: FacetSpec;
  /** Friendly dimension name surfaced to the agent. */
  dimension: string;
  /** Numeric bin width (histogram) or period string `year`/`month`/`quarter` (date_histogram). */
  interval?: number | string;
}

/** Match-all base terminal — every entry carries a release date. */
const MATCH_ALL = {
  type: 'terminal' as const,
  service: 'text' as const,
  parameters: { attribute: 'rcsb_accession_info.initial_release_date', operator: 'exists' },
};

interface RawSearchResponse {
  facets?: RawFacet[];
  result_set?: Array<{ identifier: string; score: number }>;
  total_count?: number;
}

interface RawFacet {
  attribute?: string;
  buckets?: RawBucket[];
  name?: string;
}

interface RawBucket {
  count?: number;
  facets?: RawFacet[];
  label?: string;
  population?: number;
  value?: string | number;
}

export class RcsbService {
  private readonly searchUrl: string;
  private readonly graphqlUrl: string;
  private readonly dataRestBase: string;
  private readonly filesBase: string;

  constructor(_config: AppConfig, _storage: StorageService, serverConfig: ServerConfig) {
    this.searchUrl = `${serverConfig.rcsbSearchBaseUrl}/rcsbsearch/v2/query`;
    this.graphqlUrl = `${serverConfig.rcsbDataBaseUrl}/graphql`;
    this.dataRestBase = `${serverConfig.rcsbDataBaseUrl}/rest/v1/core`;
    this.filesBase = serverConfig.rcsbFilesBaseUrl;
  }

  // ─── Search ────────────────────────────────────────────────────────────────

  /** Full-text / filtered structure search, optionally with a facet breakdown. */
  async search(
    params: StructureSearchParams,
    ctx: Context,
    facets?: FacetSpec[],
  ): Promise<SearchResult> {
    const query = buildQuery(params);
    const returnType: ReturnType = params.sequence ? 'polymer_entity' : 'entry';
    const body = {
      query,
      return_type: returnType,
      request_options: {
        ...contentTypeOption(params.contentType),
        paginate: { start: params.start ?? 0, rows: params.limit ?? 25 },
        ...(facets && facets.length > 0 ? { facets: facets.map(toRcsbFacet) } : {}),
        scoring_strategy: 'combined',
      },
    };
    const raw = await this.postSearch(body, ctx, 'RcsbService.search');
    return {
      total: raw.total_count ?? 0,
      hits: normalizeHits(raw.result_set),
      ...(facets && facets.length > 0 ? { facets: normalizeFacets(raw.facets, facets) } : {}),
    };
  }

  /** mmseqs2 sequence-similarity search. Returns polymer-entity hits. */
  async searchSequence(
    sequence: string,
    opts: { maxEvalue?: number; minIdentity?: number; limit?: number; contentType?: ContentType },
    ctx: Context,
  ): Promise<SearchResult> {
    const body = {
      query: {
        type: 'terminal' as const,
        service: 'sequence' as const,
        parameters: {
          evalue_cutoff: opts.maxEvalue ?? 1,
          identity_cutoff: opts.minIdentity ?? 0,
          sequence_type: 'protein',
          value: sequence,
        },
      },
      return_type: 'polymer_entity' as const,
      request_options: {
        ...contentTypeOption(opts.contentType),
        paginate: { start: 0, rows: opts.limit ?? 25 },
        scoring_strategy: 'sequence',
      },
    };
    const raw = await this.postSearch(body, ctx, 'RcsbService.searchSequence');
    return { total: raw.total_count ?? 0, hits: normalizeHits(raw.result_set) };
  }

  /** Find entries containing a given ligand (exact chemical component ID). */
  async searchByLigand(
    compId: string,
    opts: { limit?: number; contentType?: ContentType },
    ctx: Context,
  ): Promise<SearchResult> {
    const body = {
      query: {
        type: 'terminal' as const,
        service: 'text_chem' as const,
        parameters: {
          attribute: 'rcsb_chem_comp_container_identifiers.comp_id',
          operator: 'exact_match',
          value: compId.toUpperCase(),
        },
      },
      return_type: 'entry' as const,
      request_options: {
        ...contentTypeOption(opts.contentType ?? 'experimental'),
        paginate: { start: 0, rows: opts.limit ?? 25 },
      },
    };
    const raw = await this.postSearch(body, ctx, 'RcsbService.searchByLigand');
    return { total: raw.total_count ?? 0, hits: normalizeHits(raw.result_set) };
  }

  /** Resolve a ligand name/synonym to candidate chemical component IDs. */
  async findChemComps(query: string, limit: number, ctx: Context): Promise<string[]> {
    // Match the term against both the formal component name and its synonyms:
    // common names ("heme", "aspirin") live in synonyms, not the formal name
    // ("PROTOPORPHYRIN IX CONTAINING FE"). A plain full_text search over
    // mol_definition matches far too broadly and buries the intended component.
    const chemTerm = (attribute: string) => ({
      type: 'terminal' as const,
      service: 'text_chem' as const,
      parameters: { attribute, operator: 'contains_words', value: query },
    });
    const body = {
      query: {
        type: 'group' as const,
        logical_operator: 'or' as const,
        nodes: [chemTerm('chem_comp.name'), chemTerm('rcsb_chem_comp_synonyms.name')],
      },
      return_type: 'mol_definition' as const,
      request_options: { paginate: { start: 0, rows: limit } },
    };
    const raw = await this.postSearch(body, ctx, 'RcsbService.findChemComps');
    return normalizeHits(raw.result_set).map((h) => h.id);
  }

  /** Facet-only aggregation over an optional scoping query (no row pull). */
  async analyzeFacets(
    params: StructureSearchParams,
    facets: FacetSpec[],
    ctx: Context,
  ): Promise<{ total: number; facets: FacetDimension[] }> {
    const body = {
      query: buildQuery(params),
      return_type: 'entry' as const,
      request_options: {
        ...contentTypeOption(params.contentType),
        facets: facets.map(toRcsbFacet),
        paginate: { start: 0, rows: 0 },
      },
    };
    const raw = await this.postSearch(body, ctx, 'RcsbService.analyzeFacets');
    return { total: raw.total_count ?? 0, facets: normalizeFacets(raw.facets, facets) };
  }

  // ─── GraphQL metadata ────────────────────────────────────────────────────────

  /** Batched entry metadata for up to N PDB IDs in one GraphQL call. */
  async getEntries(ids: string[], ctx: Context): Promise<EntryMeta[]> {
    if (ids.length === 0) return [];
    const data = await this.graphql<{ entries: RawEntry[] | null }>(
      ENTRIES_QUERY,
      { ids: ids.map((id) => id.toUpperCase()) },
      ctx,
      'RcsbService.getEntries',
    );
    return (data.entries ?? []).filter((e): e is RawEntry => e != null).map(normalizeEntry);
  }

  /** Resolve a PDB entry to its cross-referenced UniProt accession(s). */
  async resolveUniprot(pdbId: string, ctx: Context): Promise<string[]> {
    const data = await this.graphql<{ entry: RawXrefEntry | null }>(
      XREF_QUERY,
      { id: pdbId.toUpperCase() },
      ctx,
      'RcsbService.resolveUniprot',
    );
    const accessions = new Set<string>();
    for (const entity of data.entry?.polymer_entities ?? []) {
      for (const ref of entity.rcsb_polymer_entity_container_identifiers
        ?.reference_sequence_identifiers ?? []) {
        if (/uniprot/i.test(ref.database_name ?? '') && ref.database_accession) {
          accessions.add(ref.database_accession.toUpperCase());
        }
      }
    }
    return [...accessions];
  }

  /** First polymer entity's one-letter sequence for a PDB entry. */
  async getSequence(
    pdbId: string,
    ctx: Context,
  ): Promise<{ entityId: string; sequence: string } | null> {
    const data = await this.graphql<{ entry: RawSequenceEntry | null }>(
      SEQUENCE_QUERY,
      { id: pdbId.toUpperCase() },
      ctx,
      'RcsbService.getSequence',
    );
    const entity = data.entry?.polymer_entities?.find(
      (e) => e.entity_poly?.pdbx_seq_one_letter_code_can,
    );
    const seq = entity?.entity_poly?.pdbx_seq_one_letter_code_can;
    if (!entity || !seq) return null;
    return { entityId: entity.rcsb_id ?? pdbId, sequence: seq.replace(/\s+/g, '') };
  }

  /** Ligand binding-site residues for an entry, optionally filtered to one ligand. */
  async getBindingSites(
    pdbId: string,
    compId: string | undefined,
    ctx: Context,
  ): Promise<BindingSite[]> {
    const data = await this.graphql<{ entry: RawBindingEntry | null }>(
      BINDING_SITE_QUERY,
      { id: pdbId.toUpperCase() },
      ctx,
      'RcsbService.getBindingSites',
    );
    const sites: BindingSite[] = [];
    const want = compId?.toUpperCase();
    for (const nonpoly of data.entry?.nonpolymer_entities ?? []) {
      const ligand = nonpoly.rcsb_nonpolymer_entity_container_identifiers?.nonpolymer_comp_id;
      if (!ligand || (want && ligand.toUpperCase() !== want)) continue;
      for (const inst of nonpoly.nonpolymer_entity_instances ?? []) {
        const neighbors = inst.rcsb_target_neighbors ?? [];
        if (neighbors.length === 0) continue;
        sites.push({
          ligandCompId: ligand,
          ...(inst.rcsb_nonpolymer_entity_instance_container_identifiers?.auth_asym_id
            ? {
                ligandAsymId:
                  inst.rcsb_nonpolymer_entity_instance_container_identifiers.auth_asym_id,
              }
            : {}),
          residues: neighbors
            .map(normalizeNeighbor)
            .filter((r): r is BindingResidue => r != null)
            .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity)),
        });
      }
    }
    return sites;
  }

  // ─── REST chemical component ──────────────────────────────────────────────────

  /** Chemical-component metadata (formula, weight, SMILES, InChIKey). */
  async getChemComp(compId: string, ctx: Context): Promise<ChemComp | null> {
    const id = compId.toUpperCase();
    let raw: RawChemComp;
    try {
      raw = await fetchJson<RawChemComp>(
        `${this.dataRestBase}/chemcomp/${encodeURIComponent(id)}`,
        ctx,
        {
          operation: 'RcsbService.getChemComp',
          label: 'RCSB Data API',
          baseDelayMs: 400,
        },
      );
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) return null;
      throw err;
    }
    return normalizeChemComp(id, raw);
  }

  // ─── Files ────────────────────────────────────────────────────────────────────

  /** Construct a coordinate-file download URL for a PDB entry. */
  coordinateFileUrl(pdbId: string, format: 'cif' | 'pdb' | 'bcif'): string {
    return `${this.filesBase}/download/${pdbId.toUpperCase()}.${format}`;
  }

  // ─── Private ───────────────────────────────────────────────────────────────────

  private postSearch(body: unknown, ctx: Context, operation: string): Promise<RawSearchResponse> {
    return fetchJson<RawSearchResponse>(this.searchUrl, ctx, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      operation,
      label: 'RCSB Search API',
      baseDelayMs: 400,
    });
  }

  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    ctx: Context,
    operation: string,
  ): Promise<T> {
    const body = await fetchJson<{ data?: T; errors?: Array<{ message: string }> }>(
      this.graphqlUrl,
      ctx,
      {
        method: 'POST',
        body: JSON.stringify({ query, variables }),
        headers: { 'Content-Type': 'application/json' },
        operation,
        label: 'RCSB GraphQL API',
        baseDelayMs: 400,
      },
    );
    if (body.data) return body.data;
    const message = body.errors?.[0]?.message ?? 'unknown error';
    throw new McpError(JsonRpcErrorCode.InternalError, `RCSB GraphQL error: ${message}`, {
      retryable: false,
    });
  }
}

// ─── Query builders ──────────────────────────────────────────────────────────

/** Build the RCSB query node from search params (match-all when no constraint given). */
export function buildQuery(params: StructureSearchParams): unknown {
  const nodes: unknown[] = [];
  if (params.text) {
    nodes.push({ type: 'terminal', service: 'full_text', parameters: { value: params.text } });
  }
  if (params.sequence) {
    nodes.push({
      type: 'terminal',
      service: 'sequence',
      parameters: {
        evalue_cutoff: params.maxEvalue ?? 1,
        identity_cutoff: params.minIdentity ?? 0,
        sequence_type: 'protein',
        value: params.sequence,
      },
    });
  }
  if (params.organism) {
    nodes.push(
      textNode(
        'rcsb_entity_source_organism.ncbi_scientific_name',
        'contains_phrase',
        params.organism,
      ),
    );
  }
  if (params.method) {
    nodes.push(textNode('exptl.method', 'exact_match', params.method));
  }
  if (typeof params.maxResolution === 'number') {
    nodes.push(
      textNode('rcsb_entry_info.resolution_combined', 'less_or_equal', params.maxResolution),
    );
  }
  if (nodes.length === 0) return MATCH_ALL;
  if (nodes.length === 1) return nodes[0];
  return { type: 'group', logical_operator: 'and', nodes };
}

function textNode(attribute: string, operator: string, value: string | number): unknown {
  return { type: 'terminal', service: 'text', parameters: { attribute, operator, value } };
}

function contentTypeOption(contentType?: ContentType): { results_content_type?: string[] } {
  if (!contentType) return {};
  return { results_content_type: [contentType] };
}

/** Translate a friendly FacetSpec into the RCSB facet request shape (recursively). */
export function toRcsbFacet(spec: FacetSpec): Record<string, unknown> {
  const facet: Record<string, unknown> = {
    name: spec.dimension,
    aggregation_type: spec.aggregation,
    attribute: spec.attribute,
    min_interval_population: 1,
  };
  if (spec.aggregation !== 'terms' && spec.interval !== undefined) facet.interval = spec.interval;
  if (spec.child) facet.facets = [toRcsbFacet(spec.child)];
  return facet;
}

// ─── Normalizers ──────────────────────────────────────────────────────────────

function normalizeHits(resultSet: RawSearchResponse['result_set']): SearchHit[] {
  return (resultSet ?? []).map((r) => ({ id: r.identifier, score: r.score }));
}

function normalizeFacets(raw: RawFacet[] | undefined, specs: FacetSpec[]): FacetDimension[] {
  const byAttr = new Map((raw ?? []).map((f) => [f.attribute ?? f.name, f]));
  return specs.map((spec) => {
    const match = byAttr.get(spec.attribute) ?? byAttr.get(spec.dimension);
    return {
      dimension: spec.dimension,
      attribute: spec.attribute,
      buckets: normalizeBuckets(match?.buckets, spec.child),
    };
  });
}

function normalizeBuckets(raw: RawBucket[] | undefined, child?: FacetSpec): FacetBucket[] {
  return (raw ?? []).map((b) => {
    const label = b.label ?? (b.value != null ? String(b.value) : '');
    const count = b.population ?? b.count ?? 0;
    const bucket: FacetBucket = { label, count };
    if (child && b.facets) {
      bucket.children = [
        {
          dimension: child.dimension,
          attribute: child.attribute,
          buckets: normalizeBuckets(b.facets[0]?.buckets, child.child),
        },
      ];
    }
    return bucket;
  });
}

function normalizeEntry(raw: RawEntry): EntryMeta {
  const polymerEntities = (raw.polymer_entities ?? []).map(normalizePolymerEntity);
  const organisms = [
    ...new Set(polymerEntities.map((e) => e.organism).filter((o): o is string => !!o)),
  ];
  const ligands = (raw.nonpolymer_entities ?? [])
    .map(normalizeLigand)
    .filter((l): l is LigandMeta => l != null);
  const methods = (raw.exptl ?? []).map((e) => e.method).filter((m): m is string => !!m);
  const resolution = raw.rcsb_entry_info?.resolution_combined?.[0];
  return {
    id: raw.rcsb_id,
    ...(raw.struct?.title ? { title: raw.struct.title } : {}),
    ...(methods.length > 0 ? { methods } : {}),
    ...(typeof resolution === 'number' ? { resolution } : {}),
    ...(typeof raw.rcsb_entry_info?.molecular_weight === 'number'
      ? { molecularWeight: raw.rcsb_entry_info.molecular_weight }
      : {}),
    ...(raw.rcsb_accession_info?.initial_release_date
      ? { releaseDate: raw.rcsb_accession_info.initial_release_date }
      : {}),
    organisms,
    polymerEntities,
    ligands,
  };
}

function normalizePolymerEntity(raw: RawPolymerEntity): PolymerEntityMeta {
  const organism = raw.rcsb_entity_source_organism?.find(
    (o) => o.ncbi_scientific_name,
  )?.ncbi_scientific_name;
  const chains = raw.rcsb_polymer_entity_container_identifiers?.auth_asym_ids;
  return {
    entityId: raw.rcsb_id ?? '',
    ...(raw.rcsb_polymer_entity?.pdbx_description
      ? { description: raw.rcsb_polymer_entity.pdbx_description }
      : {}),
    ...(organism ? { organism } : {}),
    ...(chains && chains.length > 0 ? { chains } : {}),
    ...(typeof raw.entity_poly?.rcsb_sample_sequence_length === 'number'
      ? { sequenceLength: raw.entity_poly.rcsb_sample_sequence_length }
      : {}),
  };
}

function normalizeLigand(raw: RawNonpolymerEntity): LigandMeta | undefined {
  const compId = raw.rcsb_nonpolymer_entity_container_identifiers?.nonpolymer_comp_id;
  if (!compId) return;
  const chem = raw.nonpolymer_comp?.chem_comp;
  return {
    compId,
    ...(chem?.name ? { name: chem.name } : {}),
    ...(chem?.formula ? { formula: chem.formula } : {}),
  };
}

function normalizeNeighbor(raw: RawTargetNeighbor): BindingResidue | undefined {
  if (!raw.target_comp_id || !raw.target_asym_id) return;
  return {
    residueCompId: raw.target_comp_id,
    asymId: raw.target_asym_id,
    ...(typeof raw.target_seq_id === 'number' ? { seqId: raw.target_seq_id } : {}),
    ...(typeof raw.distance === 'number' ? { distance: raw.distance } : {}),
  };
}

function normalizeChemComp(id: string, raw: RawChemComp): ChemComp {
  const descriptors = raw.rcsb_chem_comp_descriptor;
  const smiles =
    descriptors?.SMILES_stereo ??
    descriptors?.SMILES ??
    raw.pdbx_chem_comp_descriptor?.find((d) => d.type === 'SMILES_CANONICAL')?.descriptor ??
    raw.pdbx_chem_comp_descriptor?.find((d) => d.type === 'SMILES')?.descriptor;
  const inchikey =
    descriptors?.InChIKey ??
    raw.pdbx_chem_comp_descriptor?.find((d) => d.type === 'InChIKey')?.descriptor;
  return {
    compId: id,
    ...(raw.chem_comp?.name ? { name: raw.chem_comp.name } : {}),
    ...(raw.chem_comp?.formula ? { formula: raw.chem_comp.formula } : {}),
    ...(typeof raw.chem_comp?.formula_weight === 'number'
      ? { formulaWeight: raw.chem_comp.formula_weight }
      : {}),
    ...(smiles ? { smiles } : {}),
    ...(inchikey ? { inchikey } : {}),
    ...(raw.chem_comp?.type ? { type: raw.chem_comp.type } : {}),
  };
}

// ─── Raw GraphQL/REST payload shapes (all optional — upstream is sparse) ─────────

interface RawEntry {
  exptl?: Array<{ method?: string }>;
  nonpolymer_entities?: RawNonpolymerEntity[];
  polymer_entities?: RawPolymerEntity[];
  rcsb_accession_info?: { initial_release_date?: string };
  rcsb_entry_info?: { resolution_combined?: number[]; molecular_weight?: number };
  rcsb_id: string;
  struct?: { title?: string };
}

interface RawPolymerEntity {
  entity_poly?: { rcsb_sample_sequence_length?: number; pdbx_seq_one_letter_code_can?: string };
  rcsb_entity_source_organism?: Array<{ ncbi_scientific_name?: string }>;
  rcsb_id?: string;
  rcsb_polymer_entity?: { pdbx_description?: string };
  rcsb_polymer_entity_container_identifiers?: { auth_asym_ids?: string[] };
}

interface RawNonpolymerEntity {
  nonpolymer_comp?: { chem_comp?: { name?: string; formula?: string } };
  rcsb_nonpolymer_entity_container_identifiers?: { nonpolymer_comp_id?: string };
}

interface RawXrefEntry {
  polymer_entities?: Array<{
    rcsb_polymer_entity_container_identifiers?: {
      reference_sequence_identifiers?: Array<{
        database_accession?: string;
        database_name?: string;
      }>;
    };
  }>;
}

interface RawSequenceEntry {
  polymer_entities?: Array<{
    rcsb_id?: string;
    entity_poly?: { pdbx_seq_one_letter_code_can?: string };
  }>;
}

interface RawBindingEntry {
  nonpolymer_entities?: Array<{
    rcsb_nonpolymer_entity_container_identifiers?: { nonpolymer_comp_id?: string };
    nonpolymer_entity_instances?: Array<{
      rcsb_nonpolymer_entity_instance_container_identifiers?: { auth_asym_id?: string };
      rcsb_target_neighbors?: RawTargetNeighbor[];
    }>;
  }>;
}

interface RawTargetNeighbor {
  distance?: number;
  target_asym_id?: string;
  target_comp_id?: string;
  target_seq_id?: number;
}

interface RawChemComp {
  chem_comp?: { name?: string; formula?: string; formula_weight?: number; type?: string };
  pdbx_chem_comp_descriptor?: Array<{ type?: string; descriptor?: string }>;
  rcsb_chem_comp_descriptor?: { SMILES?: string; SMILES_stereo?: string; InChIKey?: string };
}

// ─── GraphQL queries ──────────────────────────────────────────────────────────

const ENTRIES_QUERY = `query Entries($ids: [String!]!) {
  entries(entry_ids: $ids) {
    rcsb_id
    struct { title }
    exptl { method }
    rcsb_entry_info { resolution_combined molecular_weight }
    rcsb_accession_info { initial_release_date }
    polymer_entities {
      rcsb_id
      rcsb_polymer_entity { pdbx_description }
      rcsb_polymer_entity_container_identifiers { auth_asym_ids }
      entity_poly { rcsb_sample_sequence_length }
      rcsb_entity_source_organism { ncbi_scientific_name }
    }
    nonpolymer_entities {
      rcsb_nonpolymer_entity_container_identifiers { nonpolymer_comp_id }
      nonpolymer_comp { chem_comp { name formula } }
    }
  }
}`;

const XREF_QUERY = `query Xref($id: String!) {
  entry(entry_id: $id) {
    polymer_entities {
      rcsb_polymer_entity_container_identifiers {
        reference_sequence_identifiers { database_accession database_name }
      }
    }
  }
}`;

const SEQUENCE_QUERY = `query Sequence($id: String!) {
  entry(entry_id: $id) {
    polymer_entities {
      rcsb_id
      entity_poly { pdbx_seq_one_letter_code_can }
    }
  }
}`;

const BINDING_SITE_QUERY = `query BindingSite($id: String!) {
  entry(entry_id: $id) {
    nonpolymer_entities {
      rcsb_nonpolymer_entity_container_identifiers { nonpolymer_comp_id }
      nonpolymer_entity_instances {
        rcsb_nonpolymer_entity_instance_container_identifiers { auth_asym_id }
        rcsb_target_neighbors { target_asym_id target_comp_id target_seq_id distance }
      }
    }
  }
}`;

// ─── Init/accessor ──────────────────────────────────────────────────────────────

let _service: RcsbService | undefined;

export function initRcsbService(
  config: AppConfig,
  storage: StorageService,
  serverConfig: ServerConfig,
): void {
  _service = new RcsbService(config, storage, serverConfig);
}

export function getRcsbService(): RcsbService {
  if (!_service) throw new Error('RcsbService not initialized — call initRcsbService() in setup()');
  return _service;
}
