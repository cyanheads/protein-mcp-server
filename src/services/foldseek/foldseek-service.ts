/**
 * @fileoverview Foldseek service — wraps the public Foldseek structural-search
 * ticket API (`/api/ticket` → poll `/api/ticket/{id}` → `/api/result/queries/{id}/…`
 * + `/api/result/{id}/{query}`). Submits a query coordinate file against
 * experimental + predicted databases; Foldseek splits a multichain file into one
 * query per chain, so a completed ticket is read one query at a time. Returns a
 * page of that query's fold-similarity hits, ranked by score across databases,
 * alongside the full hit count and the ticket's query count, so a completed
 * ticket can be re-paged or re-read at another query instead of resubmitted.
 * Each hit is classified from its target name by a parser registered for the
 * database it came from. Backs `protein_find_similar` (`by: structure`).
 * Async: the ticket status field drives completion, not the HTTP code.
 * @module services/foldseek/foldseek-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import type { ServerConfig } from '@/config/server-config.js';
import { type PollStep, withAsyncPoll } from '../shared/async.js';
import { fetchJson } from '../shared/http.js';
import { isUniProtAccession } from '../shared/identifiers.js';

/**
 * The Foldseek databases a structure search can target, by the exact,
 * case-sensitive name Foldseek's `database[]` field accepts, each with a target
 * parser below. The other `/api/databases` entries do not serve a monomer
 * search: Folddisco motif indexes fail the job, `rnadb` is refused, and the
 * interface databases return no relevant hits.
 */
export const FOLDSEEK_DATABASES = [
  'afdb50',
  'afdb-swissprot',
  'afdb-proteome',
  'bfvd_v3',
  'cath50',
  'mgnify_esm30',
  'pdb100',
  'gmgcl_id',
  'bfmd',
] as const;

export type FoldseekDatabase = (typeof FOLDSEEK_DATABASES)[number];

/** A single fold-similarity hit. */
export interface FoldseekHit {
  /** Alignment length in columns, gaps included. */
  alignmentLength?: number;
  /** Matched chain of the PDB entry in `id`: the full pdb100 label (`A-2`), or a CATH domain's chain. */
  chain?: string;
  /** Source database the hit came from. */
  database: string;
  /** Alignment E-value. */
  evalue?: number;
  /** PDB entry ID or UniProt accession `protein_get_structure` resolves; absent when the target names neither. */
  id?: string;
  /** Foldseek's homology probability (0–1). */
  probability?: number;
  /** Last aligned query residue, 1-based. */
  queryEnd?: number;
  /** First aligned query residue, 1-based. */
  queryStart?: number;
  /** Alignment bit score. */
  score?: number;
  /** Sequence identity (0–1, 4 decimal places) over the alignment, from upstream's 0–100 `seqId`. */
  sequenceIdentity?: number;
  /** Whether the target is an experimental structure or a predicted model. */
  source: 'experimental' | 'predicted';
  /** Foldseek target name: the header text before the first space. */
  target: string;
  /** Last aligned residue of the target's indexed sequence, 1-based. */
  targetEnd?: number;
  /** Length of the target's indexed sequence. */
  targetLength?: number;
  /** First aligned residue of the target's indexed sequence, 1-based. */
  targetStart?: number;
  /** NCBI taxonomy ID of the target organism. */
  taxId?: number;
  /** Scientific name of the target organism. */
  taxName?: string;
  /** Header text after the target name: an entry title (pdb100) or protein name (AlphaFold DB, bfvd_v3). */
  title?: string;
  /** UniProt accession of the modeled protein. */
  uniprotAccession?: string;
}

/** What a target name alone says about the structure behind a hit. */
type TargetIdentity = Pick<FoldseekHit, 'chain' | 'id' | 'source' | 'uniprotAccession'>;

/**
 * What a completed ticket yields for one query: a page of its hits alongside the
 * full parsed hit count and the query's length, or the query count when the
 * requested index is past the end. The result endpoint returns every alignment
 * for the requested databases in one response, so the total is known without a
 * second call and paging is a slice of what is already in memory.
 */
type FoldseekRead =
  | { kind: 'page'; hits: FoldseekHit[]; total: number; queryCount: number; queryLength?: number }
  | { kind: 'query_out_of_range'; queryCount: number };

/** Outcome of polling a ticket, freshly submitted or resumed. */
export type FoldseekOutcome =
  | {
      status: 'complete';
      ticketId: string;
      /** Zero-based query index the hits belong to. */
      query: number;
      /** Number of queries (one per chain of the submitted file) the ticket holds. */
      queryCount: number;
      /** Residue length of the query, which every hit's query span indexes into. */
      queryLength?: number;
      hits: FoldseekHit[];
      total: number;
    }
  | { status: 'query_out_of_range'; ticketId: string; query: number; queryCount: number }
  | { status: 'computing'; ticketId: string }
  | { status: 'not_found'; ticketId: string }
  | {
      status: 'failed';
      error: string;
      /** The job's ticket, once Foldseek accepted it; absent when the submit itself failed. */
      ticketId?: string;
    };

/** Foldseek refused a submission with HTTP 400; resubmitting it unchanged cannot succeed. */
type FoldseekRejection = { status: 'rejected'; upstreamMessage?: string };

/**
 * Page size for the query-list request. The endpoint's `limit`/`offset` paging
 * is off by one upstream (a limit of N returns at most N−1 entries, and
 * `hasNext` can read false while entries remain), so the whole list is read in
 * a single oversized request rather than walked.
 */
const QUERY_LIST_LIMIT = 10_000;

export class FoldseekService {
  private readonly baseUrl: string;

  constructor(_config: AppConfig, _storage: StorageService, serverConfig: ServerConfig) {
    this.baseUrl = serverConfig.foldseekBaseUrl;
  }

  /**
   * Submit a structure and bounded-poll for fold-similarity hits. Never throws —
   * a submit Foldseek refuses with HTTP 400 is `{ status: 'rejected' }`, and any
   * other submit/poll failure degrades to `{ status: 'failed' }`, carrying the
   * ticket when the failure came after Foldseek accepted the job.
   */
  async search(
    params: {
      fileContent: string;
      fileName: string;
      databases: readonly FoldseekDatabase[];
      mode: string;
      limit: number;
      /** Zero-based query index to read; defaults to 0. */
      query?: number;
      start: number;
      timeoutMs: number;
    },
    ctx: Context,
  ): Promise<FoldseekOutcome | FoldseekRejection> {
    let ticketId: string;
    try {
      ticketId = await this.submit(
        params.fileContent,
        params.fileName,
        params.databases,
        params.mode,
        ctx,
      );
    } catch (err) {
      // `fetchWithTimeout` maps HTTP 400 to InvalidParams, which is never retried.
      // Foldseek answers 400 when it refuses the request itself — with every
      // database name schema-checked, a name it no longer accepts — so the
      // failure is deterministic, and its body states Foldseek's reason.
      if (err instanceof McpError && err.code === JsonRpcErrorCode.InvalidParams) {
        const body = err.data?.body;
        const upstreamMessage = typeof body === 'string' ? body.trim() : '';
        return { status: 'rejected', ...(upstreamMessage ? { upstreamMessage } : {}) };
      }
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }

    try {
      return await this.pollToOutcome(ticketId, params, ctx);
    } catch (err) {
      return {
        status: 'failed',
        ticketId,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Resume an existing ticket: bounded-poll a ticket returned by a prior `search`
   * without resubmitting. A bogus or expired ticket is a clean `400 "invalid ID"`
   * from Foldseek — surfaced as `{ status: 'not_found' }`, distinct from an
   * in-flight job (`computing`) or a processing error (`failed`, with the
   * ticket). Never throws.
   */
  async resume(
    params: { ticketId: string; limit: number; query?: number; start: number; timeoutMs: number },
    ctx: Context,
  ): Promise<FoldseekOutcome> {
    try {
      return await this.pollToOutcome(params.ticketId, params, ctx);
    } catch (err) {
      // A 400 from the ticket/result endpoint is Foldseek's "invalid ID" — the
      // ticket never existed or has expired. `fetchWithTimeout` maps 400 →
      // InvalidParams, so key the not-found branch off that code.
      if (err instanceof McpError && err.code === JsonRpcErrorCode.InvalidParams) {
        return { status: 'not_found', ticketId: params.ticketId };
      }
      return {
        status: 'failed',
        ticketId: params.ticketId,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async submit(
    fileContent: string,
    fileName: string,
    databases: readonly FoldseekDatabase[],
    mode: string,
    ctx: Context,
  ): Promise<string> {
    const form = new FormData();
    form.append('q', new Blob([fileContent], { type: 'chemical/x-pdb' }), fileName);
    for (const db of databases) form.append('database[]', db);
    form.append('mode', mode);
    // fetchWithTimeout sets the multipart boundary header from the FormData body.
    const raw = await fetchJson<{ id?: string; status?: string }>(
      `${this.baseUrl}/api/ticket`,
      ctx,
      {
        method: 'POST',
        body: form,
        operation: 'FoldseekService.submit',
        label: 'Foldseek',
        baseDelayMs: 1000,
        maxRetries: 1,
      },
    );
    if (!raw.id) throw new Error('Foldseek did not return a ticket ID');
    return raw.id;
  }

  /** Bounded-poll a ticket and map the read to an outcome. Throws on poll failure. */
  private async pollToOutcome(
    ticketId: string,
    page: { limit: number; query?: number; start: number; timeoutMs: number },
    ctx: Context,
  ): Promise<FoldseekOutcome> {
    const query = page.query ?? 0;
    const outcome = await withAsyncPoll<FoldseekRead>({
      step: () => this.pollTicket(ticketId, query, page.start, page.limit, ctx),
      timeoutMs: page.timeoutMs,
      ctx,
      intervalMs: 1500,
      maxIntervalMs: 2500,
    });
    if (outcome.status !== 'complete') return { status: 'computing', ticketId };
    const read = outcome.value;
    return read.kind === 'query_out_of_range'
      ? { status: 'query_out_of_range', ticketId, query, queryCount: read.queryCount }
      : {
          status: 'complete',
          ticketId,
          query,
          queryCount: read.queryCount,
          ...(read.queryLength !== undefined ? { queryLength: read.queryLength } : {}),
          hits: read.hits,
          total: read.total,
        };
  }

  private async pollTicket(
    ticketId: string,
    query: number,
    start: number,
    limit: number,
    ctx: Context,
  ): Promise<PollStep<FoldseekRead>> {
    const ticket = await fetchJson<{ status?: string }>(
      `${this.baseUrl}/api/ticket/${encodeURIComponent(ticketId)}`,
      ctx,
      {
        operation: 'FoldseekService.pollTicket',
        label: 'Foldseek',
        timeoutMs: 15_000,
        baseDelayMs: 400,
      },
    );
    const status = (ticket.status ?? '').toUpperCase();
    if (status === 'ERROR') throw new Error('Foldseek reported an error processing the structure');
    if (status !== 'COMPLETE') return { ready: false };
    return { ready: true, value: await this.fetchResults(ticketId, query, start, limit, ctx) };
  }

  /**
   * Read one query of a completed ticket and return the requested page of its
   * hits. The query index is range-checked against the ticket's query list first:
   * Foldseek answers an out-of-range index with HTTP 200 and empty blocks, which
   * would read as a search with no matches. The whole hit list is parsed and
   * ranked before slicing, so the caller learns the real hit count and pages walk
   * one stable ordering.
   */
  private async fetchResults(
    ticketId: string,
    query: number,
    start: number,
    limit: number,
    ctx: Context,
  ): Promise<FoldseekRead> {
    const ticket = encodeURIComponent(ticketId);
    const list = await fetchJson<RawQueryList>(
      `${this.baseUrl}/api/result/queries/${ticket}/${QUERY_LIST_LIMIT}/0`,
      ctx,
      { operation: 'FoldseekService.fetchQueries', label: 'Foldseek', baseDelayMs: 400 },
    );
    const queryCount = list.lookup?.length ?? 0;
    if (query >= queryCount) return { kind: 'query_out_of_range', queryCount };

    const raw = await fetchJson<RawResultResponse>(
      `${this.baseUrl}/api/result/${ticket}/${query}`,
      ctx,
      { operation: 'FoldseekService.fetchResults', label: 'Foldseek', baseDelayMs: 400 },
    );
    const hits: FoldseekHit[] = [];
    // `qLen` is the query's own length, the same on every alignment of one query.
    let queryLength: number | undefined;
    for (const dbResult of raw.results ?? []) {
      const db = dbResult.db ?? 'unknown';
      for (const group of dbResult.alignments ?? []) {
        for (const aln of group ?? []) {
          if (!aln.target) continue;
          hits.push(normalizeHit(aln, aln.target, db));
          if (typeof aln.qLen === 'number') queryLength ??= aln.qLen;
        }
      }
    }
    hits.sort(compareHits);
    return {
      kind: 'page',
      queryCount,
      total: hits.length,
      ...(queryLength !== undefined ? { queryLength } : {}),
      hits: hits.slice(start, start + limit),
    };
  }
}

/**
 * Best-first order across databases: `score` descending, a hit with no score
 * last, ties broken by database then target name so every page of a ticket walks
 * the same sequence. Each database block already arrives score-sorted upstream;
 * `score` is the one field comparable across them.
 */
function compareHits(a: FoldseekHit, b: FoldseekHit): number {
  if (a.score !== b.score) {
    if (a.score === undefined) return 1;
    if (b.score === undefined) return -1;
    return b.score - a.score;
  }
  return compareText(a.database, b.database) || compareText(a.target, b.target);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ─── Normalizers ──────────────────────────────────────────────────────────────

/**
 * Map one alignment to a hit. The header splits at its first space into the
 * target name, which the database's parser classifies, and the title after it.
 */
function normalizeHit(aln: RawAlignment, header: string, database: string): FoldseekHit {
  const space = header.indexOf(' ');
  const target = space === -1 ? header : header.slice(0, space);
  const title = space === -1 ? '' : header.slice(space + 1).trim();
  const identity = isFoldseekDatabase(database)
    ? TARGET_PARSERS[database](target)
    : parseUnregistered(target);
  const hit: FoldseekHit = { target, database, ...identity };
  if (title) hit.title = title;
  // Upstream (MMseqs2-App, which serves search.foldseek.com) emits `seqId` on a
  // 0–100 percentage scale with one decimal for structure search, while this
  // server declares sequence identity as a 0–1 fraction (matching the
  // `min_identity` inputs on the RCSB paths). Rounding to 4 places keeps that
  // precision exactly, without the float noise of a bare division (42.2 / 100).
  if (typeof aln.seqId === 'number') hit.sequenceIdentity = Math.round(aln.seqId * 100) / 10_000;
  if (typeof aln.prob === 'number') hit.probability = aln.prob;
  if (typeof aln.eval === 'number') hit.evalue = aln.eval;
  if (typeof aln.score === 'number') hit.score = aln.score;
  if (typeof aln.alnLength === 'number') hit.alignmentLength = aln.alnLength;
  if (typeof aln.qStartPos === 'number') hit.queryStart = aln.qStartPos;
  if (typeof aln.qEndPos === 'number') hit.queryEnd = aln.qEndPos;
  if (typeof aln.dbStartPos === 'number') hit.targetStart = aln.dbStartPos;
  if (typeof aln.dbEndPos === 'number') hit.targetEnd = aln.dbEndPos;
  if (typeof aln.dbLen === 'number') hit.targetLength = aln.dbLen;
  // Only taxonomy-indexed databases carry these keys, and `taxId: 0` with
  // `taxName: "unclassified"` is Foldseek's placeholder for no taxon.
  if (typeof aln.taxId === 'number' && aln.taxId > 0) {
    hit.taxId = aln.taxId;
    if (aln.taxName) hit.taxName = aln.taxName;
  }
  return hit;
}

// ─── Target parsers ───────────────────────────────────────────────────────────

/**
 * A pdb100 target: `<pdb>[-assembly<N>][.cif.gz]_<label>`. The label is the
 * author chain ID in the indexed file, with a `-<n>` suffix on a symmetry copy
 * (`A-2`), so it is kept whole.
 */
const PDB_TARGET_RE = /^(\d[a-z0-9]{3})(?:-assembly\d+)?(?:\.(?:cif|pdb|ent)(?:\.gz)?)?_(\S+)$/i;

/** An AlphaFold DB model: `AF-<accession>-F<fragment>-model_v<version>`. */
const ALPHAFOLD_TARGET_RE = /^AF-([A-Z0-9]+)-F\d+(?:-model_v\d+)?$/;

/**
 * A CATH domain of a PDB chain: PDB code, one chain character (`0` when the
 * PDB file had no chain field), two-digit domain number (`1cbnA00`).
 */
const CATH_DOMAIN_RE = /^(\d[a-z0-9]{3})([A-Za-z0-9])\d{2}$/i;

/** A CATH domain of an AlphaFold model: `af_<accession>_<start>_<end>_<superfamily>`. */
const CATH_ALPHAFOLD_RE = /^af_([A-Z0-9]+)_\d+_\d+_\d+\.\d+\.\d+\.\d+$/;

/** A predicted model of `accession`, chainable when it is a UniProt accession. */
function predictedModelOf(accession: string | undefined): TargetIdentity {
  return accession && isUniProtAccession(accession)
    ? { source: 'predicted', id: accession, uniprotAccession: accession }
    : { source: 'predicted' };
}

function parsePdb(target: string): TargetIdentity {
  const match = PDB_TARGET_RE.exec(target);
  if (!match) return { source: 'experimental' };
  return {
    source: 'experimental',
    id: (match[1] as string).toUpperCase(),
    chain: match[2] as string,
  };
}

function parseAlphaFold(target: string): TargetIdentity {
  return predictedModelOf(ALPHAFOLD_TARGET_RE.exec(target)?.[1]);
}

function parseCath(target: string): TargetIdentity {
  const domain = CATH_DOMAIN_RE.exec(target);
  if (domain) {
    const chain = domain[2] as string;
    return {
      source: 'experimental',
      id: (domain[1] as string).toUpperCase(),
      ...(chain !== '0' ? { chain } : {}),
    };
  }
  const model = CATH_ALPHAFOLD_RE.exec(target);
  return model ? predictedModelOf(model[1]) : { source: 'experimental' };
}

/**
 * A BFVD model is named by its UniProt accession (any `_…` suffix stripped, as
 * Foldseek's own web UI does). The accession is kept, but no `id` is emitted:
 * `protein_get_structure` serves no BFVD model, and through 3D-Beacons most of
 * these accessions resolve to nothing or to a different, AlphaFold DB model.
 */
function parseBfvd(target: string): TargetIdentity {
  const accession = target.replace(/_.*/, '');
  return isUniProtAccession(accession)
    ? { source: 'predicted', uniprotAccession: accession }
    : { source: 'predicted' };
}

/** A metagenomic or complex model whose name carries no PDB or UniProt identifier. */
function parseUnidentifiedModel(): TargetIdentity {
  return { source: 'predicted' };
}

const TARGET_PARSERS: Record<FoldseekDatabase, (target: string) => TargetIdentity> = {
  afdb50: parseAlphaFold,
  'afdb-swissprot': parseAlphaFold,
  'afdb-proteome': parseAlphaFold,
  bfvd_v3: parseBfvd,
  cath50: parseCath,
  mgnify_esm30: parseUnidentifiedModel,
  pdb100: parsePdb,
  gmgcl_id: parseUnidentifiedModel,
  bfmd: parseUnidentifiedModel,
};

const DATABASE_NAMES: ReadonlySet<string> = new Set(FOLDSEEK_DATABASES);

function isFoldseekDatabase(name: string): name is FoldseekDatabase {
  return DATABASE_NAMES.has(name);
}

/**
 * A database outside the registry reaches a result only through a resumed
 * ticket submitted elsewhere. Classify by target grammar alone: a PDB entry name
 * is experimental (its label is not read as a chain — interface databases pack
 * several into it), and everything else is predicted, since every non-PDB
 * database Foldseek serves holds models.
 */
function parseUnregistered(target: string): TargetIdentity {
  const pdb = PDB_TARGET_RE.exec(target);
  return pdb
    ? { source: 'experimental', id: (pdb[1] as string).toUpperCase() }
    : parseAlphaFold(target);
}

interface RawQueryList {
  lookup?: Array<{ id?: number; name?: string }>;
}

interface RawResultResponse {
  results?: Array<{ db?: string; alignments?: RawAlignment[][] }>;
}

/** One alignment row. `taxId`/`taxName` appear only for taxonomy-indexed databases. */
interface RawAlignment {
  alnLength?: number;
  dbEndPos?: number;
  dbLen?: number;
  dbStartPos?: number;
  eval?: number;
  prob?: number;
  qEndPos?: number;
  qLen?: number;
  qStartPos?: number;
  score?: number;
  /** Sequence identity as a 0–100 percentage — normalized to 0–1 in `normalizeHit`. */
  seqId?: number;
  target?: string;
  taxId?: number;
  taxName?: string;
}

let _service: FoldseekService | undefined;

export function initFoldseekService(
  config: AppConfig,
  storage: StorageService,
  serverConfig: ServerConfig,
): void {
  _service = new FoldseekService(config, storage, serverConfig);
}

export function getFoldseekService(): FoldseekService {
  if (!_service)
    throw new Error('FoldseekService not initialized — call initFoldseekService() in setup()');
  return _service;
}
