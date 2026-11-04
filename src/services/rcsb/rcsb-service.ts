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
import { MIN_SEQUENCE_RESIDUES, normalizeProteinSequence } from '../shared/protein-sequence.js';
import type {
  BindingResidue,
  BindingSite,
  ChemComp,
  ChemCompMatches,
  ContentType,
  CoordinateUrls,
  EntryMeta,
  EntrySequence,
  FacetBucket,
  FacetDimension,
  LigandMeta,
  PolymerEntityMeta,
  ProteinEntitySummary,
  SearchHit,
  SearchResult,
  StructureSearchParams,
  UniProtXref,
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
  result_set?: RawSearchRow[];
  total_count?: number;
}

/** One result row; `services` arrives only under `results_verbosity: "verbose"`. */
interface RawSearchRow {
  identifier: string;
  score: number;
  services?: Array<{
    nodes?: Array<{ match_context?: RawMatchContext[] | null }>;
    service_type?: string;
  }>;
}

/**
 * The mmseqs2 alignment a verbose sequence search attaches to its node. Values
 * are typed `unknown` and read only when numeric. The aligned strings,
 * `mismatches`, and `gaps_opened` are left unread: identity and alignment length
 * already express the last two.
 */
interface RawMatchContext {
  alignment_length?: unknown;
  bitscore?: unknown;
  evalue?: unknown;
  query_beg?: unknown;
  query_end?: unknown;
  query_length?: unknown;
  sequence_identity?: unknown;
  subject_beg?: unknown;
  subject_end?: unknown;
  subject_length?: unknown;
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
  private readonly modelsBase: string;

  constructor(_config: AppConfig, _storage: StorageService, serverConfig: ServerConfig) {
    this.searchUrl = `${serverConfig.rcsbSearchBaseUrl}/rcsbsearch/v2/query`;
    this.graphqlUrl = `${serverConfig.rcsbDataBaseUrl}/graphql`;
    this.dataRestBase = `${serverConfig.rcsbDataBaseUrl}/rest/v1/core`;
    this.filesBase = serverConfig.rcsbFilesBaseUrl;
    this.modelsBase = serverConfig.rcsbModelsBaseUrl;
  }

  // ─── Search ────────────────────────────────────────────────────────────────

  /**
   * Full-text / filtered structure search, optionally with a facet breakdown.
   * With a sequence it returns polymer-entity hits carrying their alignment to
   * the query (see {@link searchSequence}); the verbose response that carries the
   * alignment is only requested then.
   */
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
        ...(params.sequence ? { results_verbosity: 'verbose' } : {}),
      },
    };
    const raw = await this.postSearch(body, ctx, 'RcsbService.search');
    return {
      ...toSearchResult(raw),
      ...(facets && facets.length > 0 ? { facets: normalizeFacets(raw.facets, facets) } : {}),
    };
  }

  /**
   * mmseqs2 sequence-similarity search. Returns polymer-entity hits, each with
   * its identity, E-value, bit score, and aligned range from the verbose
   * response, plus the query length once on the result.
   */
  async searchSequence(
    sequence: string,
    opts: {
      maxEvalue?: number;
      minIdentity?: number;
      limit?: number;
      start?: number;
      contentType?: ContentType[];
    },
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
          value: normalizeProteinSequence(sequence),
        },
      },
      return_type: 'polymer_entity' as const,
      request_options: {
        ...contentTypeOption(opts.contentType),
        paginate: { start: opts.start ?? 0, rows: opts.limit ?? 25 },
        scoring_strategy: 'sequence',
        results_verbosity: 'verbose',
      },
    };
    const raw = await this.postSearch(body, ctx, 'RcsbService.searchSequence');
    return toSearchResult(raw);
  }

  /**
   * Find entries holding a bound copy of a ligand (exact chemical component ID),
   * highest-resolution first — see {@link ligandContainmentQuery} for what
   * counts as bound. Containment is boolean so RCSB's relevance score is
   * uniform; a server-side resolution sort orders the page by a signal that
   * actually discriminates (the returned page is the globally best-resolution
   * entries, not an arbitrary PDB-ID-ascending slice).
   */
  async searchByLigand(
    compId: string,
    opts: { limit?: number; start?: number; contentType?: ContentType[] },
    ctx: Context,
  ): Promise<SearchResult> {
    const raw = await this.postSearch(
      ligandContainmentQuery(compId, opts.contentType, opts.start ?? 0, opts.limit ?? 25, true),
      ctx,
      'RcsbService.searchByLigand',
    );
    return toSearchResult(raw);
  }

  /**
   * Count PDB entries holding a bound copy of a ligand (its deposition
   * frequency) — the same match set {@link searchByLigand} pages, so the two
   * totals agree. Used to re-rank name-search candidates so the canonical,
   * most-deposited component surfaces first — a count-only query (rows 0), no
   * rows or sort pulled.
   */
  async countEntriesWithLigand(compId: string, ctx: Context): Promise<number> {
    const raw = await this.postSearch(
      ligandContainmentQuery(compId, undefined, 0, 0, false),
      ctx,
      'RcsbService.countEntriesWithLigand',
    );
    return raw.total_count ?? 0;
  }

  /**
   * Resolve a ligand name, synonym, or molecular formula to candidate chemical
   * component IDs. A formula-shaped query routes to RCSB's `chemical` service,
   * which matches composition; anything else runs the name/synonym search, where
   * a formula would only match components whose *name* contains formula-like
   * tokens.
   *
   * Formula detection is a shape heuristic, so it can claim a string that is
   * really a component ID — an all-caps ID built only from single-letter element
   * symbols and a digit (`SF4`, `H4B`) tokenizes as a formula. An empty formula
   * match therefore falls through to the name/synonym search rather than ending
   * the resolution, which keeps those IDs reaching the path that can resolve
   * them. The extra call happens only when the formula terminal matched nothing.
   *
   * Returns the first `limit` candidate IDs in RCSB's order alongside the
   * upstream `total` for the search that produced them, so a caller can tell a
   * complete match set from a truncated one.
   */
  async findChemComps(query: string, limit: number, ctx: Context): Promise<ChemCompMatches> {
    const search = async (query_: unknown): Promise<ChemCompMatches> => {
      const raw = await this.postSearch(
        {
          query: query_,
          return_type: 'mol_definition' as const,
          request_options: { paginate: { start: 0, rows: limit } },
        },
        ctx,
        'RcsbService.findChemComps',
      );
      return { ids: normalizeHits(raw.result_set).map((h) => h.id), total: raw.total_count ?? 0 };
    };

    if (!isChemicalFormula(query)) return search(chemNameQuery(query));
    const byFormula = await search(formulaQuery(query));
    return byFormula.ids.length > 0 ? byFormula : search(chemNameQuery(query));
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

  /**
   * Resolve a PDB entry to its UniProt-cross-referenced polymer entities, in
   * entity-number order. Each returned entry carries the author chain IDs it
   * covers, the mapped UniProt accession, and the polymer description —
   * entity-grained so a caller can disambiguate a multi-chain entry by chain. One
   * entry per polymer entity that carries a UniProt xref; entities without one
   * are skipped. Single round trip.
   */
  async resolveUniprotEntities(pdbId: string, ctx: Context): Promise<UniProtXref[]> {
    const data = await this.graphql<{ entry: RawXrefEntry | null }>(
      XREF_QUERY,
      { id: pdbId.toUpperCase() },
      ctx,
      'RcsbService.resolveUniprotEntities',
    );
    const xrefs: UniProtXref[] = [];
    for (const entity of byEntityNumber(data.entry?.polymer_entities)) {
      const container = entity.rcsb_polymer_entity_container_identifiers;
      const accession = container?.reference_sequence_identifiers?.find(
        (ref) => /uniprot/i.test(ref.database_name ?? '') && ref.database_accession,
      )?.database_accession;
      if (!accession) continue;
      xrefs.push({
        accession: accession.toUpperCase(),
        chains: container?.auth_asym_ids ?? [],
        ...(entity.rcsb_polymer_entity?.pdbx_description
          ? { proteinName: entity.rcsb_polymer_entity.pdbx_description }
          : {}),
      });
    }
    return xrefs;
  }

  /**
   * The sequence-search query a PDB entry yields: the canonical one-letter
   * sequence of one protein polymer entity (`rcsb_entity_polymer_type`
   * `Protein`, L- and D-polypeptides alike; DNA and RNA never qualify), read in
   * entity-number order. With `chain`, the protein entity whose author chains
   * (`auth_asym_ids`) include it, matched exactly; without, the lowest-numbered
   * protein entity of at least 10 residues — RCSB's sequence-search minimum — or
   * the lowest-numbered one when every protein entity is shorter, which the
   * search then rejects. Single round trip.
   */
  async getSequence(
    pdbId: string,
    chain: string | undefined,
    ctx: Context,
  ): Promise<EntrySequence> {
    const data = await this.graphql<{ entry: RawSequenceEntry | null }>(
      SEQUENCE_QUERY,
      { id: pdbId.toUpperCase() },
      ctx,
      'RcsbService.getSequence',
    );
    if (!data.entry) return { kind: 'entry_not_found' };

    const proteins: Array<{ entity: ProteinEntitySummary; sequence: string }> = [];
    for (const raw of byEntityNumber(data.entry.polymer_entities)) {
      const sequence = raw.entity_poly?.pdbx_seq_one_letter_code_can?.replace(/\s+/g, '');
      if (raw.entity_poly?.rcsb_entity_polymer_type !== 'Protein' || !raw.rcsb_id || !sequence) {
        continue;
      }
      proteins.push({
        entity: {
          entityId: raw.rcsb_id,
          chains: raw.rcsb_polymer_entity_container_identifiers?.auth_asym_ids ?? [],
          length: sequence.length,
        },
        sequence,
      });
    }
    const [first] = proteins;
    if (!first) return { kind: 'no_protein' };

    const selected =
      chain === undefined
        ? (proteins.find((p) => p.entity.length >= MIN_SEQUENCE_RESIDUES) ?? first)
        : proteins.find((p) => p.entity.chains.includes(chain));
    if (!selected) {
      return { kind: 'chain_not_found', proteinEntities: proteins.map((p) => p.entity) };
    }
    return {
      kind: 'found',
      entity: selected.entity,
      sequence: selected.sequence,
      otherEntities: proteins.filter((p) => p !== selected).map((p) => p.entity),
    };
  }

  /**
   * Ligand binding-site residues for an entry, optionally filtered to one ligand.
   * Each pocket residue carries both numbering namespaces: `rcsb_target_neighbors`
   * reports the mmCIF label chain and position plus the author residue number,
   * and the author chain comes from the entry's own per-instance
   * `asym_id`/`auth_asym_id` pairs.
   *
   * Sites come back in one fixed order — ligand entities by entity number, each
   * entity's instances by author chain then author residue number — because the
   * caller pages them with `start`/`limit`, and upstream's own order varies
   * between connections: two pages read under different orders would skip or
   * repeat instances.
   */
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
    // Label → author chain, one pair per polymer instance. The entity-level
    // `asym_ids`/`auth_asym_ids` arrays are each sorted independently (6QNR_9:
    // ["I","OB"] vs ["82","8E"], where I is 8E), so they cannot be zipped.
    const authChainByLabel = new Map<string, string>();
    for (const poly of data.entry?.polymer_entities ?? []) {
      for (const inst of poly.polymer_entity_instances ?? []) {
        const ids = inst.rcsb_polymer_entity_instance_container_identifiers;
        if (ids?.asym_id && ids.auth_asym_id) authChainByLabel.set(ids.asym_id, ids.auth_asym_id);
      }
    }
    const sites: BindingSite[] = [];
    const want = compId?.toUpperCase();
    for (const nonpoly of byEntityNumber(data.entry?.nonpolymer_entities)) {
      const ligand = nonpoly.rcsb_nonpolymer_entity_container_identifiers?.nonpolymer_comp_id;
      if (!ligand || (want && ligand.toUpperCase() !== want)) continue;
      const entitySites: BindingSite[] = [];
      for (const inst of nonpoly.nonpolymer_entity_instances ?? []) {
        const neighbors = inst.rcsb_target_neighbors ?? [];
        if (neighbors.length === 0) continue;
        const ids = inst.rcsb_nonpolymer_entity_instance_container_identifiers;
        const ligandAuthSeqId = parseAuthSeqId(ids?.auth_seq_id);
        entitySites.push({
          ligandCompId: ligand,
          ...(ids?.auth_asym_id ? { ligandAsymId: ids.auth_asym_id } : {}),
          ...(ligandAuthSeqId !== undefined ? { ligandAuthSeqId } : {}),
          residues: neighbors
            .map((n) => normalizeNeighbor(n, authChainByLabel))
            .filter((r): r is BindingResidue => r != null)
            .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity)),
        });
      }
      sites.push(...entitySites.sort(compareLigandInstances));
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
          expectedStatuses: [404],
        },
      );
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) return null;
      throw err;
    }
    return normalizeChemComp(id, raw);
  }

  // ─── Files ────────────────────────────────────────────────────────────────────

  /**
   * Coordinate-file URLs RCSB serves for an entry. mmCIF and PDB format come from
   * the file-download host, BinaryCIF only from the ModelServer host. The PDB
   * format is omitted when the entry reports it is not PDB-format compatible
   * (large entries archived as mmCIF only); an unreported value keeps it. A
   * computed model is not in the file-download archive at all, so only its
   * BinaryCIF is listed — its provider publishes the text formats.
   */
  coordinateUrls(
    entry: Pick<EntryMeta, 'id' | 'computedModelProvider' | 'pdbFormatCompatible'>,
  ): CoordinateUrls {
    const id = entry.id.toUpperCase();
    const bcif = `${this.modelsBase}/${id}.bcif`;
    if (entry.computedModelProvider) return { bcif };
    return {
      cif: this.mmcifUrl(id),
      ...(entry.pdbFormatCompatible === false
        ? {}
        : { pdb: `${this.filesBase}/download/${id}.pdb` }),
      bcif,
    };
  }

  /** mmCIF download URL for an experimental entry — the one text format every entry has. */
  mmcifUrl(pdbId: string): string {
    return `${this.filesBase}/download/${pdbId.toUpperCase()}.cif`;
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
      // RCSB answers a zero-result query with 204 No Content. Treat that as an
      // empty result set rather than letting the empty-body guard classify it as
      // a transient outage and burn the full retry budget.
      onEmptyBody: () => ({ total_count: 0, result_set: [], facets: [] }),
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
    // GraphQL reports field-level failures in `errors` while still returning the
    // sub-selections that succeeded, so `errors` is evaluated before `data`: a
    // partial payload is indistinguishable from a genuinely sparse record, and
    // every metadata consumer of this helper treats a metadata-request failure as
    // a whole-call failure. An empty `errors` array is not a failure.
    if (body.errors && body.errors.length > 0) {
      const message = body.errors[0]?.message ?? 'unknown error';
      throw new McpError(JsonRpcErrorCode.InternalError, `RCSB GraphQL error: ${message}`, {
        retryable: false,
      });
    }
    if (body.data) return body.data;
    throw new McpError(JsonRpcErrorCode.InternalError, 'RCSB GraphQL error: unknown error', {
      retryable: false,
    });
  }
}

// ─── Query builders ──────────────────────────────────────────────────────────

/**
 * Build the RCSB query node from search params (match-all when no constraint
 * given). Throws before any request exists: `invalid_sequence` for a malformed
 * sequence, `unknown_method` for a method outside the vocabulary and its aliases.
 */
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
        value: normalizeProteinSequence(params.sequence),
      },
    });
  }
  if (params.organism) nodes.push(organismNode(params.organism));
  if (params.method) nodes.push(methodNode(params.method));
  if (typeof params.maxResolution === 'number') {
    nodes.push(
      textNode('rcsb_entry_info.resolution_combined', 'less_or_equal', params.maxResolution),
    );
  }
  if (params.ligand) nodes.push(ligandNode(params.ligand));
  if (nodes.length === 0) return MATCH_ALL;
  if (nodes.length === 1) return nodes[0];
  return { type: 'group', logical_operator: 'and', nodes };
}

function textNode(
  attribute: string,
  operator: string,
  value: string | number | readonly string[],
): unknown {
  return { type: 'terminal', service: 'text', parameters: { attribute, operator, value } };
}

/** A value with surrounding whitespace dropped and inner runs collapsed to one space. */
function collapseWhitespace(value: string): string {
  return value.trim().split(/\s+/).join(' ');
}

/**
 * How an organism filter value matches, once whitespace is collapsed: an
 * all-digit `taxon_id`, a `one_word` name (exact matches only), or a
 * `multi_word` name (exact matches plus a phrase match). See {@link organismNode}.
 */
export function organismForm(value: string): 'taxon_id' | 'one_word' | 'multi_word' {
  const name = collapseWhitespace(value);
  if (/^\d+$/.test(name)) return 'taxon_id';
  return name.includes(' ') ? 'multi_word' : 'one_word';
}

/**
 * Source-organism node. An all-digit value is an NCBI taxon ID, matched on the
 * entity's taxonomy lineage, so every taxon under it matches too (9606 takes in
 * each strain and subspecies of Homo sapiens). A name is matched exactly, in any
 * letter case, on the lineage, which lists each ancestor under its scientific
 * name, NCBI common names, and synonyms ("human", "E. coli"), or on the entity's
 * own scientific name. That second arm recovers records whose lineage labels a
 * node "Scientific (common)" ("Mus musculus (mouse)"), which a bare name never
 * equals. A multi-word name also keeps a phrase match on the scientific name, so
 * strain-labelled names ("Escherichia coli (strain K12)") stay in; a one-word
 * name never takes that arm, where "human" would match "Human immunodeficiency
 * virus 1" and "coli" every other species of the genus.
 */
function organismNode(value: string): unknown {
  const name = collapseWhitespace(value);
  const form = organismForm(name);
  if (form === 'taxon_id') {
    return textNode('rcsb_entity_source_organism.taxonomy_lineage.id', 'exact_match', name);
  }
  const arms = [
    textNode('rcsb_entity_source_organism.taxonomy_lineage.name', 'exact_match', name),
    textNode('rcsb_entity_source_organism.ncbi_scientific_name', 'exact_match', name),
  ];
  if (form === 'multi_word') {
    arms.push(
      textNode('rcsb_entity_source_organism.ncbi_scientific_name', 'contains_phrase', name),
    );
  }
  return { type: 'group', logical_operator: 'or', nodes: arms };
}

/**
 * The values RCSB's `exptl.method` takes: its search-schema enum, the same 13 the
 * method facet reports. Upstream matches them in any letter case.
 */
const EXPTL_METHODS = [
  'X-RAY DIFFRACTION',
  'ELECTRON MICROSCOPY',
  'SOLUTION NMR',
  'SOLID-STATE NMR',
  'ELECTRON CRYSTALLOGRAPHY',
  'NEUTRON DIFFRACTION',
  'FIBER DIFFRACTION',
  'POWDER DIFFRACTION',
  'SOLUTION SCATTERING',
  'EPR',
  'FLUORESCENCE TRANSFER',
  'INFRARED SPECTROSCOPY',
  'THEORETICAL MODEL',
] as const;

type ExptlMethod = (typeof EXPTL_METHODS)[number];

/** Common method spellings outside the vocabulary, as written, and the values each selects. */
const METHOD_ALIASES: ReadonlyArray<{
  aliases: readonly string[];
  methods: readonly [ExptlMethod, ...ExptlMethod[]];
}> = [
  { aliases: ['cryo-EM', 'cryoEM', 'EM'], methods: ['ELECTRON MICROSCOPY'] },
  { aliases: ['X-ray', 'xray'], methods: ['X-RAY DIFFRACTION'] },
  { aliases: ['NMR'], methods: ['SOLUTION NMR', 'SOLID-STATE NMR'] },
];

/** Every accepted method spelling, upper-cased, and the vocabulary values it selects. */
const METHOD_LOOKUP = new Map<string, readonly [ExptlMethod, ...ExptlMethod[]]>([
  ...EXPTL_METHODS.map((method) => [method, [method]] as const),
  ...METHOD_ALIASES.flatMap(({ aliases, methods }) =>
    aliases.map((alias) => [alias.toUpperCase(), methods] as const),
  ),
]);

/** What a method filter accepts — the vocabulary and its aliases, in one phrase. */
export const METHOD_VOCABULARY = `${EXPTL_METHODS.join(', ')} (any letter case), or an alias: ${METHOD_ALIASES.map(({ aliases, methods }) => `${aliases.join(' / ')} → ${methods.join(' + ')}`).join('; ')}`;

/**
 * Experimental-method node, matched on the vocabulary spelling an input
 * resolves to; `NMR` selects both NMR methods through `in`. The vocabulary is
 * closed, so any other value could only match nothing: it throws
 * `unknown_method` instead of reaching RCSB as a zero-hit search that reads as
 * data.
 */
function methodNode(value: string): unknown {
  const spelling = collapseWhitespace(value);
  const methods = METHOD_LOOKUP.get(spelling.toUpperCase());
  if (!methods) {
    throw new McpError(
      JsonRpcErrorCode.InvalidParams,
      `Unknown method ${JSON.stringify(spelling)}. method takes one of ${METHOD_VOCABULARY}.`,
      { reason: 'unknown_method' },
    );
  }
  return methods.length === 1
    ? textNode('exptl.method', 'exact_match', methods[0])
    : textNode('exptl.method', 'in', methods);
}

/**
 * Bound-ligand node (exact chemical-component ID, trimmed and upper-cased),
 * shared by the search filter and the ligand-containment search. An entry or
 * entity matches when it holds the component as a non-polymer entity, a bound
 * copy: the instances `getBindingSites` and the ligand author chains read. A
 * component present only as a residue inside a polymer chain (MSE,
 * selenomethionine) or a sugar inside a branched glycan (NAG) does not match.
 * The chemical-dictionary attribute `rcsb_chem_comp_container_identifiers.comp_id`
 * matched those too (for MSE, nearly every entry it returned), and matches
 * nothing at all under the `polymer_entity` return type a sequence search uses.
 */
function ligandNode(compId: string): unknown {
  return textNode(
    'rcsb_nonpolymer_entity_container_identifiers.nonpolymer_comp_id',
    'exact_match',
    compId.trim().toUpperCase(),
  );
}

/**
 * Name/synonym chemical-dictionary query. Matches the term against both the
 * formal component name and its synonyms: common names ("heme", "aspirin") live
 * in synonyms, not the formal name ("PROTOPORPHYRIN IX CONTAINING FE"). A plain
 * full_text search over mol_definition matches far too broadly and buries the
 * intended component.
 */
function chemNameQuery(query: string): unknown {
  const chemTerm = (attribute: string) => ({
    type: 'terminal' as const,
    service: 'text_chem' as const,
    parameters: { attribute, operator: 'contains_words', value: query },
  });
  return {
    type: 'group' as const,
    logical_operator: 'or' as const,
    nodes: [chemTerm('chem_comp.name'), chemTerm('rcsb_chem_comp_synonyms.name')],
  };
}

/**
 * Composition query against RCSB's `chemical` service. The formula terminal
 * accepts both CCD Hill notation (`C29 H31 N7 O`) and the unspaced form
 * (`C29H31N7O`), so the value is passed through unnormalized. `match_subset` is
 * left unset for an exact-composition match: the callers that consume the
 * resolved ID (`structures_with_ligand`, `binding_site`) expect a single
 * canonical component, which subset matching would dilute with supersets.
 * The `text_chem` attribute `chem_comp.formula` is not an alternative — RCSB
 * rejects it with "search is not enabled on [ chem_comp.formula ] attribute".
 */
function formulaQuery(query: string): unknown {
  return {
    type: 'terminal' as const,
    service: 'chemical' as const,
    parameters: { type: 'formula', value: query.trim() },
  };
}

/**
 * Element symbols in canonical casing — the token vocabulary formula detection
 * accepts. Token shape alone is not enough: an all-caps chemical name can
 * tokenize as element-shaped letters (`VITAMIN B12` → V·I·T·A·M·I·N·B12), and
 * mis-routing a name to the formula terminal returns an empty match set rather
 * than an error, so the miss would be silent.
 */
const ELEMENT_SYMBOLS = new Set(
  `H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se
   Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb
   Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm
   Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og`.split(/\s+/),
);

/** One formula token: an element symbol plus an optional count (`C29`, `Fe`). */
const FORMULA_TOKEN_RE = /[A-Z][a-z]?\d*/g;

/**
 * True when `query` is a molecular formula rather than a chemical name or a
 * component ID. Whitespace is insignificant — both the spaced CCD Hill notation
 * and the unspaced form resolve upstream — but every remaining character must
 * belong to an element-symbol token, and at least one element count must be
 * present. The digit requirement carries most of the discrimination: Hill
 * notation omits an implicit `1` only for the leading element, never for all of
 * them, so `STI` (S·Ti) and `HEM` (H·E·M) are IDs, not formulas.
 *
 * It is a shape test, not a decision about what the string means, and it cannot
 * separate every component ID from a formula: an all-caps ID built only from
 * single-letter element symbols plus a digit (`SF4`, `H4B`, `BU1`) satisfies
 * every rule here. `findChemComps` absorbs that by retrying the name/synonym
 * search when the formula terminal matches nothing, so a claimed ID still
 * resolves.
 */
export function isChemicalFormula(query: string): boolean {
  const compact = query.trim().replace(/\s+/g, '');
  if (!/\d/.test(compact)) return false;
  const tokens = compact.match(FORMULA_TOKEN_RE) ?? [];
  // Anything the tokenizer skipped (punctuation, a lowercase-leading word, a
  // digit-leading component ID) leaves the rejoined tokens shorter than the input.
  if (tokens.join('') !== compact) return false;
  return tokens.every((token) => ELEMENT_SYMBOLS.has(token.replace(/\d+$/, '')));
}

/**
 * Emit the `results_content_type` request option for a content scope. Omitting
 * the option is not a union — RCSB defaults to experimental only — so a caller
 * wanting both universes must list both members explicitly.
 */
function contentTypeOption(contentTypes?: ContentType[]): { results_content_type?: ContentType[] } {
  if (!contentTypes || contentTypes.length === 0) return {};
  return { results_content_type: contentTypes };
}

/**
 * Ligand-containment search body (exact chemical-component ID), shared by
 * searchByLigand and countEntriesWithLigand: entries holding a bound copy, as
 * {@link ligandNode} defines it. Defaults to experimental content; `rows` bounds
 * the page (0 for a count-only query), and `sortByResolution` orders entries
 * best-resolution-first (skip it for counts — order is moot).
 */
function ligandContainmentQuery(
  compId: string,
  contentType: ContentType[] | undefined,
  start: number,
  rows: number,
  sortByResolution: boolean,
): unknown {
  return {
    query: ligandNode(compId),
    return_type: 'entry',
    request_options: {
      ...contentTypeOption(contentType ?? ['experimental']),
      paginate: { start, rows },
      ...(sortByResolution
        ? { sort: [{ sort_by: 'rcsb_entry_info.resolution_combined', direction: 'asc' }] }
        : {}),
    },
  };
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

// ─── Entity order ─────────────────────────────────────────────────────────────

/** The entity number of an RCSB entity ID — the integer after its last `_` (`6M0J_2` → 2). */
function entityNumber(id: string | undefined): number {
  const suffix = /_(\d+)$/.exec(id ?? '')?.[1];
  return suffix === undefined ? Number.POSITIVE_INFINITY : Number(suffix);
}

/**
 * Order RCSB entity IDs by entity number, so `_10` follows `_9`. An ID with no
 * numeric suffix (or none at all) sorts after every numbered one; ties fall back
 * to a code-unit comparison of the whole ID, so the order never depends on the
 * input's.
 *
 * RCSB's GraphQL API returns `polymer_entities`, `nonpolymer_entities`, and their
 * instances in an order fixed per upstream connection that varies between
 * connections, so every method here orders each entity array where it reads the
 * response — anything order-sensitive downstream (the first organism, which
 * entity a sequence comes from, a paged binding-site list) is otherwise a coin
 * toss per connection.
 */
export function compareEntityIds(a: string | undefined, b: string | undefined): number {
  const byNumber = entityNumber(a) - entityNumber(b);
  if (byNumber !== 0 && !Number.isNaN(byNumber)) return byNumber;
  const [x, y] = [a ?? '', b ?? ''];
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A GraphQL entity array in entity-number order (a copy; absent reads as empty). */
function byEntityNumber<T extends { rcsb_id?: string }>(entities: T[] | undefined): T[] {
  return (entities ?? []).toSorted((a, b) => compareEntityIds(a.rcsb_id, b.rcsb_id));
}

/**
 * Order one ligand entity's binding sites by author chain (code-unit), then
 * author residue number; an instance missing either sorts after those carrying it.
 */
function compareLigandInstances(a: BindingSite, b: BindingSite): number {
  const [x, y] = [a.ligandAsymId, b.ligandAsymId];
  if (x !== y) {
    if (x === undefined) return 1;
    if (y === undefined) return -1;
    return x < y ? -1 : 1;
  }
  const [m, n] = [
    a.ligandAuthSeqId ?? Number.POSITIVE_INFINITY,
    b.ligandAuthSeqId ?? Number.POSITIVE_INFINITY,
  ];
  return m === n ? 0 : m - n;
}

// ─── Normalizers ──────────────────────────────────────────────────────────────

/** Total, hits, and (from a verbose sequence search) the query length of one search response. */
function toSearchResult(raw: RawSearchResponse): SearchResult {
  const queryLength = queryLengthOf(raw.result_set);
  return {
    total: raw.total_count ?? 0,
    hits: normalizeHits(raw.result_set),
    ...(queryLength !== undefined ? { queryLength } : {}),
  };
}

function normalizeHits(resultSet: RawSearchRow[] | undefined): SearchHit[] {
  return (resultSet ?? []).map((row) => ({
    id: row.identifier,
    score: row.score,
    ...alignmentOf(sequenceContext(row)),
  }));
}

/**
 * A verbose row's mmseqs2 context: the first node context of its `sequence`
 * service entry, found by type, since the entry's position in `services` follows
 * the order of the query's other criteria.
 */
function sequenceContext(row: RawSearchRow): RawMatchContext | undefined {
  return row.services
    ?.find((service) => service.service_type === 'sequence')
    ?.nodes?.find((node) => node.match_context && node.match_context.length > 0)
    ?.match_context?.[0];
}

/** The alignment fields a match context carries, each set only where upstream sent a number. */
function alignmentOf(context: RawMatchContext | undefined): Omit<SearchHit, 'id' | 'score'> {
  const alignment: Omit<SearchHit, 'id' | 'score'> = {};
  if (!context) return alignment;
  // Served with float noise on some rows (0.829 arrives as 0.8290000000000001).
  // Four places keeps every digit mmseqs2 reports and matches the precision the
  // Foldseek structure hits carry.
  if (typeof context.sequence_identity === 'number') {
    alignment.identity = Math.round(context.sequence_identity * 10_000) / 10_000;
  }
  if (typeof context.evalue === 'number') alignment.evalue = context.evalue;
  if (typeof context.bitscore === 'number') alignment.bitscore = context.bitscore;
  if (typeof context.alignment_length === 'number') {
    alignment.alignmentLength = context.alignment_length;
  }
  if (typeof context.query_beg === 'number') alignment.queryStart = context.query_beg;
  if (typeof context.query_end === 'number') alignment.queryEnd = context.query_end;
  if (typeof context.subject_beg === 'number') alignment.targetStart = context.subject_beg;
  if (typeof context.subject_end === 'number') alignment.targetEnd = context.subject_end;
  if (typeof context.subject_length === 'number') alignment.targetLength = context.subject_length;
  return alignment;
}

/** The query length a sequence search reports: constant within one search, so the first row carrying it speaks for all. */
function queryLengthOf(resultSet: RawSearchRow[] | undefined): number | undefined {
  for (const row of resultSet ?? []) {
    const length = sequenceContext(row)?.query_length;
    if (typeof length === 'number') return length;
  }
  return undefined;
}

function normalizeFacets(raw: RawFacet[] | undefined, specs: FacetSpec[]): FacetDimension[] {
  const byAttr = new Map((raw ?? []).map((f) => [f.attribute ?? f.name, f]));
  return specs.map((spec) => {
    const match = byAttr.get(spec.attribute) ?? byAttr.get(spec.dimension);
    return {
      dimension: spec.dimension,
      attribute: spec.attribute,
      buckets: normalizeBuckets(match?.buckets, spec),
    };
  });
}

/**
 * The fixed bin width for a numeric histogram facet, or `undefined` for term and
 * date-period facets. Only numeric histograms carry an interpretable numeric
 * `[label, label + interval)` range; date_histogram intervals are period words
 * (`year`) and terms have no interval.
 */
function binInterval(spec: FacetSpec): number | undefined {
  return spec.aggregation === 'histogram' && typeof spec.interval === 'number'
    ? spec.interval
    : undefined;
}

function normalizeBuckets(raw: RawBucket[] | undefined, spec: FacetSpec): FacetBucket[] {
  const interval = binInterval(spec);
  const child = spec.child;
  return (raw ?? []).map((b) => {
    const label = b.label ?? (b.value != null ? String(b.value) : '');
    const count = b.population ?? b.count ?? 0;
    const bucket: FacetBucket = { label, count };
    if (interval !== undefined) {
      const from = Number(label);
      // Range from the fixed bin width, not the next label — the histogram drops
      // empty bins, so adjacent labels can be >1 interval apart at the sparse tail.
      if (Number.isFinite(from)) {
        bucket.rangeFrom = from;
        bucket.rangeTo = from + interval;
      }
    }
    // Keyed on the SPEC, not the response: RCSB omits the nested facet key
    // outright when nothing in the parent bucket carries a value for the child
    // attribute (computed models have no experimental method). Emitting the child
    // with an empty bucket list keeps a two-dimension request two-dimensional, so
    // a present child means "a cross-tab was requested" and empty buckets mean
    // "it aggregated to nothing" — conditions an absent child conflated.
    if (child) {
      bucket.child = {
        dimension: child.dimension,
        attribute: child.attribute,
        buckets: normalizeBuckets(b.facets?.[0]?.buckets, child),
      };
    }
    return bucket;
  });
}

/**
 * RCSB's `source_db` spelling for a computed structure model → the attribution
 * display name for that provider. An unrecognized value passes through verbatim
 * rather than being dropped: crediting an unknown modelling provider by its own
 * name beats silently attributing its model to the PDB.
 */
const CSM_PROVIDER_NAMES: Record<string, string> = {
  AlphaFoldDB: 'AlphaFold DB',
  ModelArchive: 'ModelArchive',
};

function normalizeEntry(raw: RawEntry): EntryMeta {
  const provenance = raw.rcsb_comp_model_provenance;
  const sourceDb = provenance?.source_db;
  const computedModelProvider = sourceDb ? (CSM_PROVIDER_NAMES[sourceDb] ?? sourceDb) : undefined;
  const pdbCompatible = raw.pdbx_database_status?.pdb_format_compatible;
  const polymerEntities = byEntityNumber(raw.polymer_entities).map(normalizePolymerEntity);
  const organisms = [...new Set(polymerEntities.flatMap((e) => e.organisms ?? []))];
  const ligands = byEntityNumber(raw.nonpolymer_entities)
    .map(normalizeLigand)
    .filter((l): l is LigandMeta => l != null);
  const methods = (raw.exptl ?? []).map((e) => e.method).filter((m): m is string => !!m);
  const resolution = raw.rcsb_entry_info?.resolution_combined?.[0];
  return {
    id: raw.rcsb_id,
    ...(computedModelProvider ? { computedModelProvider } : {}),
    ...(provenance?.entry_id ? { computedModelEntryId: provenance.entry_id } : {}),
    ...(pdbCompatible === 'Y' || pdbCompatible === 'N'
      ? { pdbFormatCompatible: pdbCompatible === 'Y' }
      : {}),
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
  // Every named source, not the first: a chimera lists one source per fused
  // segment (2RH1_1: Homo sapiens 8–237, Homo sapiens 398–500, Tequatrovirus T4
  // 238–397). The array sits inside one entity document, so its order is stable.
  const organisms = [
    ...new Set(
      (raw.rcsb_entity_source_organism ?? [])
        .map((o) => o.ncbi_scientific_name)
        .filter((name): name is string => !!name),
    ),
  ];
  // Two distinct chain namespaces, never interchangeable: `auth_asym_ids` are the
  // depositor's labels (what protein_get_annotations.chain takes), `asym_ids` the
  // mmCIF label_asym_ids (what protein_compare_structures.chain takes). For many
  // entries they coincide; for 6QNR_9 they are ["82","8E"] vs ["I","OB"].
  const container = raw.rcsb_polymer_entity_container_identifiers;
  const authAsymIds = container?.auth_asym_ids;
  const labelAsymIds = container?.asym_ids;
  return {
    entityId: raw.rcsb_id ?? '',
    ...(authAsymIds && authAsymIds.length > 0 ? { authAsymIds } : {}),
    ...(raw.rcsb_polymer_entity?.pdbx_description
      ? { description: raw.rcsb_polymer_entity.pdbx_description }
      : {}),
    ...(labelAsymIds && labelAsymIds.length > 0 ? { labelAsymIds } : {}),
    ...(organisms.length > 0 ? { organisms } : {}),
    ...(typeof raw.entity_poly?.rcsb_sample_sequence_length === 'number'
      ? { sequenceLength: raw.entity_poly.rcsb_sample_sequence_length }
      : {}),
  };
}

function normalizeLigand(raw: RawNonpolymerEntity): LigandMeta | undefined {
  const container = raw.rcsb_nonpolymer_entity_container_identifiers;
  const compId = container?.nonpolymer_comp_id;
  if (!compId) return;
  const chem = raw.nonpolymer_comp?.chem_comp;
  const authAsymIds = container.auth_asym_ids;
  return {
    compId,
    ...(chem?.name ? { name: chem.name } : {}),
    ...(chem?.formula ? { formula: chem.formula } : {}),
    ...(authAsymIds && authAsymIds.length > 0 ? { authAsymIds } : {}),
  };
}

function normalizeNeighbor(
  raw: RawTargetNeighbor,
  authChainByLabel: ReadonlyMap<string, string>,
): BindingResidue | undefined {
  if (!raw.target_comp_id || !raw.target_asym_id) return;
  const authAsymId = authChainByLabel.get(raw.target_asym_id);
  return {
    residueCompId: raw.target_comp_id,
    asymId: raw.target_asym_id,
    ...(typeof raw.target_seq_id === 'number' ? { seqId: raw.target_seq_id } : {}),
    ...(authAsymId ? { authAsymId } : {}),
    ...(typeof raw.target_auth_seq_id === 'number' ? { authSeqId: raw.target_auth_seq_id } : {}),
    ...(typeof raw.distance === 'number' ? { distance: raw.distance } : {}),
  };
}

/**
 * The instance container reports `auth_seq_id` as a string ("201"); keep it only
 * when it is an integer, the form every author residue number in the archive takes.
 */
function parseAuthSeqId(raw: string | undefined): number | undefined {
  if (!raw?.trim()) return;
  const n = Number(raw);
  return Number.isInteger(n) ? n : undefined;
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
  /** `pdb_format_compatible` is "Y"/"N" on experimental entries, null on computed models. */
  pdbx_database_status?: { pdb_format_compatible?: string | null } | null;
  polymer_entities?: RawPolymerEntity[];
  rcsb_accession_info?: { initial_release_date?: string };
  /** Present only on computed structure models; `null` for experimental entries. */
  rcsb_comp_model_provenance?: { entry_id?: string | null; source_db?: string } | null;
  rcsb_entry_info?: { resolution_combined?: number[]; molecular_weight?: number };
  rcsb_id: string;
  struct?: { title?: string };
}

interface RawPolymerEntity {
  entity_poly?: { rcsb_sample_sequence_length?: number; pdbx_seq_one_letter_code_can?: string };
  rcsb_entity_source_organism?: Array<{ ncbi_scientific_name?: string }>;
  rcsb_id?: string;
  rcsb_polymer_entity?: { pdbx_description?: string };
  rcsb_polymer_entity_container_identifiers?: { asym_ids?: string[]; auth_asym_ids?: string[] };
}

interface RawNonpolymerEntity {
  nonpolymer_comp?: { chem_comp?: { name?: string; formula?: string } };
  rcsb_id?: string;
  rcsb_nonpolymer_entity_container_identifiers?: {
    auth_asym_ids?: string[];
    nonpolymer_comp_id?: string;
  };
}

interface RawXrefEntry {
  polymer_entities?: Array<{
    rcsb_id?: string;
    rcsb_polymer_entity?: { pdbx_description?: string };
    rcsb_polymer_entity_container_identifiers?: {
      auth_asym_ids?: string[];
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
    /** `rcsb_entity_polymer_type` is `Protein`, `DNA`, `RNA`, `NA-hybrid`, or `Other`. */
    entity_poly?: { pdbx_seq_one_letter_code_can?: string; rcsb_entity_polymer_type?: string };
    rcsb_polymer_entity_container_identifiers?: { auth_asym_ids?: string[] };
  }>;
}

interface RawBindingEntry {
  nonpolymer_entities?: Array<{
    rcsb_id?: string;
    rcsb_nonpolymer_entity_container_identifiers?: { nonpolymer_comp_id?: string };
    nonpolymer_entity_instances?: Array<{
      rcsb_nonpolymer_entity_instance_container_identifiers?: {
        auth_asym_id?: string;
        auth_seq_id?: string;
      };
      rcsb_target_neighbors?: RawTargetNeighbor[];
    }>;
  }>;
  polymer_entities?: Array<{
    polymer_entity_instances?: Array<{
      rcsb_polymer_entity_instance_container_identifiers?: {
        asym_id?: string;
        auth_asym_id?: string;
      };
    }>;
  }>;
}

interface RawTargetNeighbor {
  distance?: number;
  target_asym_id?: string;
  target_auth_seq_id?: number;
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
    pdbx_database_status { pdb_format_compatible }
    rcsb_comp_model_provenance { source_db entry_id }
    rcsb_entry_info { resolution_combined molecular_weight }
    rcsb_accession_info { initial_release_date }
    polymer_entities {
      rcsb_id
      rcsb_polymer_entity { pdbx_description }
      rcsb_polymer_entity_container_identifiers { auth_asym_ids asym_ids }
      entity_poly { rcsb_sample_sequence_length }
      rcsb_entity_source_organism { ncbi_scientific_name }
    }
    nonpolymer_entities {
      rcsb_id
      rcsb_nonpolymer_entity_container_identifiers { nonpolymer_comp_id auth_asym_ids }
      nonpolymer_comp { chem_comp { name formula } }
    }
  }
}`;

const XREF_QUERY = `query Xref($id: String!) {
  entry(entry_id: $id) {
    polymer_entities {
      rcsb_id
      rcsb_polymer_entity { pdbx_description }
      rcsb_polymer_entity_container_identifiers {
        auth_asym_ids
        reference_sequence_identifiers { database_accession database_name }
      }
    }
  }
}`;

const SEQUENCE_QUERY = `query Sequence($id: String!) {
  entry(entry_id: $id) {
    polymer_entities {
      rcsb_id
      entity_poly { rcsb_entity_polymer_type pdbx_seq_one_letter_code_can }
      rcsb_polymer_entity_container_identifiers { auth_asym_ids }
    }
  }
}`;

const BINDING_SITE_QUERY = `query BindingSite($id: String!) {
  entry(entry_id: $id) {
    polymer_entities {
      polymer_entity_instances {
        rcsb_polymer_entity_instance_container_identifiers { asym_id auth_asym_id }
      }
    }
    nonpolymer_entities {
      rcsb_id
      rcsb_nonpolymer_entity_container_identifiers { nonpolymer_comp_id }
      nonpolymer_entity_instances {
        rcsb_nonpolymer_entity_instance_container_identifiers { auth_asym_id auth_seq_id }
        rcsb_target_neighbors { target_asym_id target_comp_id target_seq_id target_auth_seq_id distance }
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
