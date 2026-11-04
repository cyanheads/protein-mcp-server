/**
 * @fileoverview UniProt service — wraps the UniProt REST API (sequence features,
 * function, variants, accession status) and the InterPro REST API (domain/family
 * memberships across Pfam, PROSITE, … with GO terms). Backs
 * `protein_get_annotations`, and decides accession status for every surface
 * keyed by a UniProt accession: UniProt redirects a merged accession to its
 * successor, answers a demerged or deleted one with an `Inactive` entry, and
 * 404s one it never assigned. Field selection trims UniProt payloads to what the
 * requested `include` scope needs.
 * @module services/uniprot/uniprot-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import type { ServerConfig } from '@/config/server-config.js';
import { fetchJson } from '../shared/http.js';
import { isUniProtEntryName } from '../shared/identifiers.js';

/** Which annotation classes to fetch. */
export type AnnotationInclude = 'features' | 'domains' | 'variants' | 'all';

/** A positional sequence feature (domain, binding site, PTM, or variant). */
export interface SequenceFeature {
  alternativeSequences?: string[];
  /** `feature` (structural/functional) or `variant`. */
  category: 'feature' | 'variant';
  /** Free-text description. */
  description?: string;
  /** End residue (1-based). */
  end?: number;
  featureId?: string;
  originalSequence?: string;
  /** Start residue (1-based). */
  start?: number;
  /** UniProt feature type (e.g. "Domain", "Binding site", "Natural variant"). */
  type: string;
}

/** Normalized UniProt entry. */
export interface UniProtEntry {
  /** The entry's accession — the successor when UniProt merged the requested one. */
  accession: string;
  features: SequenceFeature[];
  function?: string;
  geneNames: string[];
  /** The requested accession, when UniProt merged it into `accession`. */
  mergedFrom?: string;
  organism?: string;
  proteinName?: string;
  sequenceLength?: number;
  taxonId?: number;
}

/** A UniProt sequence, keyed to the entry it came from. */
export interface UniProtSequence {
  /** The entry's accession — the successor when UniProt merged the requested one. */
  accession: string;
  /** The requested accession, when UniProt merged it into `accession`. */
  mergedFrom?: string;
  /** One-letter amino-acid sequence. */
  sequence: string;
}

/** An accession UniProt lists as inactive: demerged into several entries, or deleted. */
export interface InactiveAccession {
  /** The accession as requested, upper-cased. */
  accession: string;
  /** UniProt's `deletedReason`, for a deleted entry. */
  deletedReason?: string;
  /** UniProt's `inactiveReasonType` as sent (`DEMERGED`, `DELETED`, …). */
  inactiveReason?: string;
  /** Accessions that replaced it (`mergeDemergeTo`); empty for a deletion. */
  replacements: string[];
}

/**
 * UniProt's verdict on an accession, from one lightweight lookup:
 * - `active` — a live entry under the requested accession (canonical or isoform),
 *   or the accession of the entry a requested entry name names;
 * - `merged` — UniProt merged it into `successor` and redirects there;
 * - `inactive` — demerged or deleted, with its replacements;
 * - `unknown` — UniProt has no entry (never assigned, or an isoform number the
 *   entry lacks).
 */
export type AccessionStatus =
  | { kind: 'active'; accession: string }
  | { kind: 'merged'; accession: string; successor: string }
  | ({ kind: 'inactive' } & InactiveAccession)
  | { kind: 'unknown'; accession: string };

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
  locations?: Array<{ fragments?: Array<{ start?: number; end?: number; dcStatus?: string }> }>;
  memberDatabases: string[];
  name: string;
  type: string;
}

/** A protein's InterPro memberships as retrieved, beside InterPro's own count. */
export interface InterProMemberships {
  /** Memberships in InterPro's order, each once. */
  entries: InterProEntry[];
  /**
   * InterPro's membership count (`count`). Exceeds `entries.length` when paging
   * stopped early — at the page cap, or on a page that added nothing new.
   */
  total: number;
}

const BASE_FIELDS = [
  'accession',
  'protein_name',
  'gene_names',
  'organism_name',
  'cc_function',
  'sequence',
];
/**
 * Positional annotations of the canonical sequence. Secondary structure
 * (`ft_helix`, `ft_strand`, `ft_turn`), isoform sequences (`ft_var_seq`), and
 * sequence-record notes (`ft_conflict`, `ft_unsure`, `ft_non_cons`, `ft_non_ter`)
 * stay out.
 */
const FEATURE_FIELDS = [
  'ft_domain',
  'ft_binding',
  'ft_act_site',
  'ft_site',
  'ft_mod_res',
  'ft_carbohyd',
  'ft_disulfid',
  'ft_crosslnk',
  'ft_lipid',
  'ft_signal',
  'ft_transmem',
  'ft_topo_dom',
  'ft_intramem',
  'ft_dna_bind',
  'ft_zn_fing',
  'ft_motif',
  'ft_region',
  'ft_repeat',
  'ft_coiled',
  'ft_compbias',
  'ft_non_std',
  'ft_mutagen',
  'ft_chain',
  'ft_init_met',
  'ft_peptide',
  'ft_propep',
  'ft_transit',
];
const VARIANT_FIELDS = ['ft_variant'];

/** Memberships per InterPro page; one page covers every protein measured (the largest, 81). */
const INTERPRO_PAGE_SIZE = 200;
/** Ceiling on InterPro pages per walk (1,000 memberships). */
const MAX_INTERPRO_PAGES = 5;

/** One UniProtKB entry request, classified; `raw` rides only on an active answer. */
type EntryAnswer =
  | Exclude<AccessionStatus, { kind: 'active' }>
  | { kind: 'active'; accession: string; raw: RawUniProtEntry };

export class UniProtService {
  private readonly uniprotBase: string;
  private readonly interproBase: string;

  constructor(_config: AppConfig, _storage: StorageService, serverConfig: ServerConfig) {
    this.uniprotBase = serverConfig.uniprotBaseUrl;
    this.interproBase = serverConfig.interproBaseUrl;
  }

  /**
   * Fetch a UniProt entry, selecting only the fields the include scope needs. A
   * merged accession resolves to its successor (`mergedFrom` set). Throws
   * `inactive_accession` (NotFound) for a demerged or deleted accession; `null`
   * when UniProt has no entry for it.
   */
  async getEntry(
    accession: string,
    include: AnnotationInclude,
    ctx: Context,
  ): Promise<UniProtEntry | null> {
    const fields = [...BASE_FIELDS];
    if (include === 'features' || include === 'all') fields.push(...FEATURE_FIELDS);
    if (include === 'variants' || include === 'all') fields.push(...VARIANT_FIELDS);
    const live = await this.liveEntry(accession, fields, 'UniProtService.getEntry', ctx);
    if (!live) return null;
    return {
      ...normalizeEntry(live.accession, live.raw),
      ...(live.mergedFrom ? { mergedFrom: live.mergedFrom } : {}),
    };
  }

  /**
   * Fetch the one-letter sequence for a canonical or isoform accession, or an
   * entry name (`HBA_HUMAN`), keyed to its entry's accession. A merged
   * accession resolves to its successor's sequence (`mergedFrom` set). Throws
   * `inactive_accession` (NotFound) for a demerged or deleted accession; `null`
   * when UniProt has no entry or the entry carries no sequence.
   */
  async getSequence(accession: string, ctx: Context): Promise<UniProtSequence | null> {
    const live = await this.liveEntry(accession, ['sequence'], 'UniProtService.getSequence', ctx);
    const sequence = live?.raw.sequence?.value;
    if (!live || !sequence) return null;
    return {
      accession: live.accession,
      sequence,
      ...(live.mergedFrom ? { mergedFrom: live.mergedFrom } : {}),
    };
  }

  /**
   * UniProt's verdict on an accession from one accession-only request; an entry
   * name (`HBA_HUMAN`) resolves to its entry's accession as `active`. Never
   * throws for an inactive or unknown accession — those are verdicts — so a
   * per-ID batch can report them row by row. For surfaces backed by another
   * provider, call it only after that provider misses or answers for a
   * different accession.
   */
  async resolveAccession(accession: string, ctx: Context): Promise<AccessionStatus> {
    const answer = await this.request(
      accession,
      ['accession'],
      'UniProtService.resolveAccession',
      ctx,
    );
    return answer.kind === 'active' ? { kind: 'active', accession: answer.accession } : answer;
  }

  /**
   * InterPro domain/family memberships for an active UniProt accession. The
   * count comes from InterPro's protein record first: InterPro answers a protein
   * without memberships with a 204 carrying `content-length`, which Node's HTTP/2
   * fetch rejects as a protocol error, so the entries walk runs only when the
   * count is not zero. The walk asks for 200 per page and follows `next` for at
   * most five pages, stopping early on a repeated URL or a page that adds
   * nothing new. Every request reads `ctx.signal`, so the call's deadline stops
   * the walk too.
   */
  async getInterPro(accession: string, ctx: Context): Promise<InterProMemberships> {
    const acc = accession.toUpperCase();
    if ((await this.interProMembershipCount(acc, ctx)) === 0) return { entries: [], total: 0 };

    const entries = new Map<string, InterProEntry>();
    const requested = new Set<string>();
    let total: number | undefined;
    let next: string | null | undefined =
      `${this.interproBase}/entry/interpro/protein/UniProt/${encodeURIComponent(acc)}/?page_size=${INTERPRO_PAGE_SIZE}`;
    while (next && requested.size < MAX_INTERPRO_PAGES && !requested.has(next)) {
      requested.add(next);
      const page: RawInterProResponse | null = await fetchJson<RawInterProResponse | null>(
        next,
        ctx,
        {
          operation: 'UniProtService.getInterPro',
          label: 'InterPro',
          baseDelayMs: 400,
          // InterPro's answer for "no memberships" is a 204, not an outage.
          onEmptyBody: () => null,
        },
      );
      if (!page) break;
      total ??= page.count;
      const before = entries.size;
      for (const entry of normalizeInterProPage(page, acc)) {
        if (!entries.has(entry.accession)) entries.set(entry.accession, entry);
      }
      // An empty or repeated page: the upstream is not advancing.
      if (entries.size === before) break;
      next = page.next;
    }
    const retrieved = [...entries.values()];
    // InterPro's list responses always carry `count`; without one, the retrieved set is the only count there is.
    return { entries: retrieved, total: total ?? retrieved.length };
  }

  /**
   * InterPro's membership count for a protein, from its protein record. `0` for
   * a 204 or 404 (InterPro has no record) and for a record whose `dbEntries`
   * omits `interpro` (InterPro omits zero counters); `undefined` when the record
   * carries no counters at all.
   */
  private async interProMembershipCount(
    accession: string,
    ctx: Context,
  ): Promise<number | undefined> {
    let record: RawInterProProtein | null;
    try {
      record = await fetchJson<RawInterProProtein | null>(
        `${this.interproBase}/protein/UniProt/${encodeURIComponent(accession)}/`,
        ctx,
        {
          operation: 'UniProtService.getInterPro',
          label: 'InterPro',
          baseDelayMs: 400,
          expectedStatuses: [404],
          onEmptyBody: () => null,
        },
      );
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) return 0;
      throw err;
    }
    if (!record) return 0;
    const dbEntries = record.metadata?.counters?.dbEntries;
    return dbEntries ? (dbEntries.interpro ?? 0) : undefined;
  }

  /**
   * The live entry behind an accession: a merge is followed to the successor,
   * which is requested again with `fields` because UniProt's redirect drops them.
   * Throws `inactive_accession` for a demerged or deleted accession; `null` when
   * UniProt has no entry.
   */
  private async liveEntry(
    accession: string,
    fields: readonly string[],
    operation: string,
    ctx: Context,
  ): Promise<{ accession: string; raw: RawUniProtEntry; mergedFrom?: string } | null> {
    const first = await this.request(accession, fields, operation, ctx);
    const answer =
      first.kind === 'merged' ? await this.request(first.successor, fields, operation, ctx) : first;
    switch (answer.kind) {
      case 'active':
        return {
          accession: answer.accession,
          raw: answer.raw,
          ...(first.kind === 'merged' ? { mergedFrom: first.accession } : {}),
        };
      case 'inactive':
        throw inactiveAccessionError(answer);
      case 'unknown':
        return null;
      case 'merged':
        // UniProt redirects a merged accession straight to the live entry.
        throw serviceUnavailable(
          `UniProt redirected ${first.accession} to ${answer.accession}, which redirects again to ${answer.successor}.`,
        );
    }
  }

  /** One UniProtKB entry request, classified by UniProt's verdict on the accession. */
  private async request(
    accession: string,
    fields: readonly string[],
    operation: string,
    ctx: Context,
  ): Promise<EntryAnswer> {
    const requested = accession.toUpperCase();
    const url = `${this.uniprotBase}/uniprotkb/${encodeURIComponent(requested)}?format=json&fields=${fields.join(',')}`;
    let raw: RawUniProtEntry;
    try {
      raw = await fetchJson<RawUniProtEntry>(url, ctx, {
        operation,
        label: 'UniProt',
        baseDelayMs: 400,
        expectedStatuses: [404],
      });
    } catch (err) {
      // UniProt 404s an accession it never assigned, and an isoform number the entry lacks.
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        return { kind: 'unknown', accession: requested };
      }
      throw err;
    }
    if (raw.entryType === 'Inactive') {
      const why = raw.inactiveReason;
      return {
        kind: 'inactive',
        accession: requested,
        ...(why?.inactiveReasonType ? { inactiveReason: why.inactiveReasonType } : {}),
        ...(why?.deletedReason ? { deletedReason: why.deletedReason } : {}),
        replacements: why?.mergeDemergeTo ?? [],
      };
    }
    // UniProt answers a merged accession with a 303 to its successor, which fetch
    // follows (dropping `fields`), so the entry that arrives names the successor.
    // An entry name always differs from the accession of the entry it names.
    const primary = raw.primaryAccession?.toUpperCase();
    if (primary && primary !== requested && !isUniProtEntryName(requested)) {
      return { kind: 'merged', accession: requested, successor: primary };
    }
    return { kind: 'active', accession: primary ?? requested, raw };
  }
}

/** One sentence naming an inactive accession, its reason, and its replacements or their absence. */
export function inactiveAccessionMessage(inactive: InactiveAccession): string {
  const why = [inactive.inactiveReason, inactive.deletedReason].filter(Boolean).join(': ');
  const head = `${inactive.accession} is inactive in UniProtKB${why ? ` (${why})` : ''}`;
  return inactive.replacements.length > 0
    ? `${head}; replaced by ${inactive.replacements.join(', ')}.`
    : `${head} and has no replacement accession.`;
}

/**
 * The `inactive_accession` (NotFound) failure every accession-keyed surface
 * raises: `data` carries `accession`, `inactiveReason`, and `replacements`, plus a
 * recovery hint naming the replacements when there are any. Declare it on the
 * consuming definition with `thrownBy: 'service'`.
 */
export function inactiveAccessionError(inactive: InactiveAccession): McpError {
  return notFound(inactiveAccessionMessage(inactive), {
    reason: 'inactive_accession',
    accession: inactive.accession,
    ...(inactive.inactiveReason ? { inactiveReason: inactive.inactiveReason } : {}),
    replacements: inactive.replacements,
    ...(inactive.replacements.length > 0
      ? {
          recovery: {
            hint: `Retry with a replacement accession: ${inactive.replacements.join(', ')}.`,
          },
        }
      : {}),
  });
}

/** The notice an answer carries when UniProt merged the requested accession into another entry. */
export function mergedAccessionNotice(requested: string, successor: string): string {
  return `${requested} was merged into ${successor} in UniProtKB; this answer is for ${successor}.`;
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
    ...(raw.featureId !== undefined ? { featureId: raw.featureId } : {}),
    ...(raw.alternativeSequence?.originalSequence !== undefined
      ? { originalSequence: raw.alternativeSequence.originalSequence }
      : {}),
    ...(raw.alternativeSequence?.alternativeSequences !== undefined
      ? { alternativeSequences: raw.alternativeSequence.alternativeSequences }
      : {}),
  };
}

/** One InterPro page's memberships, each with its locations on `accession` only. */
function normalizeInterProPage(page: RawInterProResponse, accession: string): InterProEntry[] {
  return (page.results ?? []).flatMap((r) => {
    if (!r.metadata?.accession) return [];
    const locations = r.proteins?.find(
      (p) => p.accession?.toUpperCase() === accession,
    )?.entry_protein_locations;
    return [
      {
        ...normalizeInterPro(r.metadata),
        ...(locations !== undefined
          ? {
              locations: locations.map((location) => ({
                ...(location.fragments !== undefined
                  ? {
                      fragments: location.fragments.map((fragment) => ({
                        ...(fragment.start !== undefined ? { start: fragment.start } : {}),
                        ...(fragment.end !== undefined ? { end: fragment.end } : {}),
                        ...(fragment['dc-status'] !== undefined
                          ? { dcStatus: fragment['dc-status'] }
                          : {}),
                      })),
                    }
                  : {}),
              })),
            }
          : {}),
      },
    ];
  });
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
  /** `Inactive` for a demerged or deleted accession. */
  entryType?: string;
  features?: RawFeature[];
  genes?: Array<{ geneName?: { value?: string } }>;
  inactiveReason?: {
    deletedReason?: string;
    inactiveReasonType?: string;
    mergeDemergeTo?: string[];
  };
  organism?: { scientificName?: string; taxonId?: number };
  primaryAccession?: string;
  proteinDescription?: { recommendedName?: { fullName?: { value?: string } } };
  sequence?: { length?: number; value?: string };
}

interface RawFeature {
  alternativeSequence?: { originalSequence?: string; alternativeSequences?: string[] };
  description?: string;
  featureId?: string;
  location?: { start?: { value?: number }; end?: { value?: number } };
  type?: string;
}

interface RawInterProResponse {
  count?: number;
  /** Cursor URL of the next page; `null` on the last. */
  next?: string | null;
  results?: Array<{
    metadata?: RawInterProMetadata;
    proteins?: Array<{
      accession?: string;
      entry_protein_locations?: Array<{
        fragments?: Array<{ start?: number; end?: number; 'dc-status'?: string }>;
      }>;
    }>;
  }>;
}

interface RawInterProMetadata {
  accession?: string;
  go_terms?: Array<{ identifier?: string; name?: string; category?: { name?: string } }>;
  member_databases?: Record<string, unknown>;
  name?: string;
  type?: string;
}

/** InterPro `/protein/UniProt/{acc}/` — only the membership counter is read. */
interface RawInterProProtein {
  metadata?: { counters?: { dbEntries?: { interpro?: number } } };
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
