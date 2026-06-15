/**
 * @fileoverview UniProt service — wraps the UniProt REST API (sequence features,
 * function, variants) and the InterPro REST API (domain/family memberships across
 * Pfam, PROSITE, … with GO terms). Backs `protein_get_annotations`. Field
 * selection trims UniProt payloads to what the requested `include` scope needs.
 * @module services/uniprot/uniprot-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import type { ServerConfig } from '@/config/server-config.js';
import { fetchJson } from '../shared/http.js';

/** Which annotation classes to fetch. */
export type AnnotationInclude = 'features' | 'domains' | 'variants' | 'all';

/** A positional sequence feature (domain, binding site, PTM, or variant). */
export interface SequenceFeature {
  /** `feature` (structural/functional) or `variant`. */
  category: 'feature' | 'variant';
  /** Free-text description. */
  description?: string;
  /** End residue (1-based). */
  end?: number;
  /** Start residue (1-based). */
  start?: number;
  /** UniProt feature type (e.g. "Domain", "Binding site", "Natural variant"). */
  type: string;
}

/** Normalized UniProt entry. */
export interface UniProtEntry {
  accession: string;
  features: SequenceFeature[];
  function?: string;
  geneNames: string[];
  organism?: string;
  proteinName?: string;
  sequenceLength?: number;
  taxonId?: number;
}

/** A GO term annotation. */
export interface GoTerm {
  category?: string;
  id: string;
  name: string;
}

/** An InterPro domain/family membership for a protein. */
export interface InterProEntry {
  accession: string;
  goTerms: GoTerm[];
  memberDatabases: string[];
  name: string;
  type: string;
}

const BASE_FIELDS = [
  'accession',
  'protein_name',
  'gene_names',
  'organism_name',
  'cc_function',
  'sequence',
];
const FEATURE_FIELDS = [
  'ft_domain',
  'ft_binding',
  'ft_act_site',
  'ft_site',
  'ft_mod_res',
  'ft_carbohyd',
  'ft_disulfid',
  'ft_signal',
  'ft_transmem',
  'ft_motif',
  'ft_region',
];
const VARIANT_FIELDS = ['ft_variant'];

export class UniProtService {
  private readonly uniprotBase: string;
  private readonly interproBase: string;

  constructor(_config: AppConfig, _storage: StorageService, serverConfig: ServerConfig) {
    this.uniprotBase = serverConfig.uniprotBaseUrl;
    this.interproBase = serverConfig.interproBaseUrl;
  }

  /** Fetch a UniProt entry, selecting only the fields the include scope needs. */
  async getEntry(
    accession: string,
    include: AnnotationInclude,
    ctx: Context,
  ): Promise<UniProtEntry> {
    const fields = [...BASE_FIELDS];
    if (include === 'features' || include === 'all') fields.push(...FEATURE_FIELDS);
    if (include === 'variants' || include === 'all') fields.push(...VARIANT_FIELDS);
    const url = `${this.uniprotBase}/uniprotkb/${encodeURIComponent(accession.toUpperCase())}?format=json&fields=${fields.join(',')}`;
    const raw = await fetchJson<RawUniProtEntry>(url, ctx, {
      operation: 'UniProtService.getEntry',
      label: 'UniProt',
      baseDelayMs: 400,
    });
    return normalizeEntry(accession.toUpperCase(), raw);
  }

  /** Fetch the one-letter amino-acid sequence for a UniProt accession. */
  async getSequence(accession: string, ctx: Context): Promise<string | null> {
    const url = `${this.uniprotBase}/uniprotkb/${encodeURIComponent(accession.toUpperCase())}?format=json&fields=sequence`;
    const raw = await fetchJson<RawUniProtEntry>(url, ctx, {
      operation: 'UniProtService.getSequence',
      label: 'UniProt',
      baseDelayMs: 400,
    });
    return raw.sequence?.value ?? null;
  }

  /** Fetch InterPro domain/family memberships for a UniProt accession. */
  async getInterPro(accession: string, ctx: Context): Promise<InterProEntry[]> {
    const url = `${this.interproBase}/entry/interpro/protein/UniProt/${encodeURIComponent(accession.toUpperCase())}/`;
    let raw: RawInterProResponse;
    try {
      raw = await fetchJson<RawInterProResponse>(url, ctx, {
        operation: 'UniProtService.getInterPro',
        label: 'InterPro',
        baseDelayMs: 400,
      });
    } catch (err) {
      // InterPro returns 404 when no entries match — that's "no domains", not a failure.
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) return [];
      throw err;
    }
    return (raw.results ?? [])
      .map((r) => r.metadata)
      .filter((m): m is RawInterProMetadata => m != null && !!m.accession)
      .map(normalizeInterPro);
  }
}

// ─── Normalizers ──────────────────────────────────────────────────────────────

function normalizeEntry(accession: string, raw: RawUniProtEntry): UniProtEntry {
  const proteinName = raw.proteinDescription?.recommendedName?.fullName?.value;
  const geneNames = (raw.genes ?? []).map((g) => g.geneName?.value).filter((n): n is string => !!n);
  const functionText = raw.comments
    ?.find((c) => c.commentType === 'FUNCTION')
    ?.texts?.map((t) => t.value)
    .filter((v): v is string => !!v)
    .join(' ');
  const features = (raw.features ?? []).map(normalizeFeature);
  return {
    accession: raw.primaryAccession ?? accession,
    ...(proteinName ? { proteinName } : {}),
    geneNames,
    ...(raw.organism?.scientificName ? { organism: raw.organism.scientificName } : {}),
    ...(typeof raw.organism?.taxonId === 'number' ? { taxonId: raw.organism.taxonId } : {}),
    ...(functionText ? { function: functionText } : {}),
    ...(typeof raw.sequence?.length === 'number' ? { sequenceLength: raw.sequence.length } : {}),
    features,
  };
}

function normalizeFeature(raw: RawFeature): SequenceFeature {
  const type = raw.type ?? 'Feature';
  return {
    category: /variant/i.test(type) ? 'variant' : 'feature',
    type,
    ...(raw.description ? { description: raw.description } : {}),
    ...(typeof raw.location?.start?.value === 'number' ? { start: raw.location.start.value } : {}),
    ...(typeof raw.location?.end?.value === 'number' ? { end: raw.location.end.value } : {}),
  };
}

function normalizeInterPro(raw: RawInterProMetadata): InterProEntry {
  const memberDatabases = raw.member_databases ? Object.keys(raw.member_databases) : [];
  const goTerms = (raw.go_terms ?? [])
    .map((g): GoTerm | undefined =>
      g.identifier && g.name
        ? {
            id: g.identifier,
            name: g.name,
            ...(g.category?.name ? { category: g.category.name } : {}),
          }
        : undefined,
    )
    .filter((g): g is GoTerm => g != null);
  return {
    accession: raw.accession as string,
    name: raw.name ?? raw.accession ?? '',
    type: raw.type ?? 'unknown',
    memberDatabases,
    goTerms,
  };
}

// ─── Raw payload shapes ─────────────────────────────────────────────────────────

interface RawUniProtEntry {
  comments?: Array<{ commentType?: string; texts?: Array<{ value?: string }> }>;
  features?: RawFeature[];
  genes?: Array<{ geneName?: { value?: string } }>;
  organism?: { scientificName?: string; taxonId?: number };
  primaryAccession?: string;
  proteinDescription?: { recommendedName?: { fullName?: { value?: string } } };
  sequence?: { length?: number; value?: string };
}

interface RawFeature {
  description?: string;
  location?: { start?: { value?: number }; end?: { value?: number } };
  type?: string;
}

interface RawInterProResponse {
  count?: number;
  results?: Array<{ metadata?: RawInterProMetadata }>;
}

interface RawInterProMetadata {
  accession?: string;
  go_terms?: Array<{ identifier?: string; name?: string; category?: { name?: string } }>;
  member_databases?: Record<string, unknown>;
  name?: string;
  type?: string;
}

let _service: UniProtService | undefined;

export function initUniProtService(
  config: AppConfig,
  storage: StorageService,
  serverConfig: ServerConfig,
): void {
  _service = new UniProtService(config, storage, serverConfig);
}

export function getUniProtService(): UniProtService {
  if (!_service)
    throw new Error('UniProtService not initialized — call initUniProtService() in setup()');
  return _service;
}
