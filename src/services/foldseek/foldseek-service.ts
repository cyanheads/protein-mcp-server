/**
 * @fileoverview Foldseek service — wraps the public Foldseek structural-search
 * ticket API (`/api/ticket` → poll `/api/ticket/{id}` → `/api/result/queries/{id}/…`
 * + `/api/result/{id}/{query}`). Submits a query coordinate file against
 * experimental + predicted databases; Foldseek splits a multichain file into one
 * query per chain, so a completed ticket is read one query at a time. Returns a
 * page of that query's fold-similarity hits, ranked by score across databases,
 * alongside the full hit count and the ticket's query count, so a completed
 * ticket can be re-paged or re-read at another query instead of resubmitted.
 * Backs `protein_find_similar` (`by: structure`).
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

/** A single fold-similarity hit. */
export interface FoldseekHit {
  /** Aligned length. */
  alignmentLength?: number;
  /** Chain ID (pdb targets). */
  chain?: string;
  /** Source database the hit came from. */
  database: string;
  /** Alignment E-value. */
  evalue?: number;
  /** PDB entry ID (pdb targets). */
  pdbId?: string;
  /** Match probability (0–1). */
  probability?: number;
  /** Alignment bit score. */
  score?: number;
  /** Sequence identity (0–1) over the alignment, normalized from upstream's 0–100 `seqId`. */
  sequenceIdentity?: number;
  /** Raw target identifier as returned by Foldseek. */
  target: string;
  /** Resolved target kind. */
  targetType: 'pdb' | 'alphafold' | 'other';
  /** UniProt accession (AlphaFold targets). */
  uniprotAccession?: string;
}

/**
 * What a completed ticket yields for one query: a page of its hits alongside the
 * full parsed hit count, or the query count when the requested index is past the
 * end. The result endpoint returns every alignment for the requested databases in
 * one response, so the total is known without a second call and paging is a
 * slice of what is already in memory.
 */
type FoldseekRead =
  | { kind: 'page'; hits: FoldseekHit[]; total: number; queryCount: number }
  | { kind: 'query_out_of_range'; queryCount: number };

/** Outcome of a structural search or ticket resume. */
export type FoldseekOutcome =
  | {
      status: 'complete';
      ticketId: string;
      /** Zero-based query index the hits belong to. */
      query: number;
      /** Number of queries (one per chain of the submitted file) the ticket holds. */
      queryCount: number;
      hits: FoldseekHit[];
      total: number;
    }
  | { status: 'query_out_of_range'; ticketId: string; query: number; queryCount: number }
  | { status: 'computing'; ticketId: string }
  | { status: 'not_found'; ticketId: string }
  | { status: 'failed'; error: string };

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
   * a submit/poll failure degrades to `{ status: 'failed' }`.
   */
  async search(
    params: {
      fileContent: string;
      fileName: string;
      databases: string[];
      mode: string;
      limit: number;
      /** Zero-based query index to read; defaults to 0. */
      query?: number;
      start: number;
      timeoutMs: number;
    },
    ctx: Context,
  ): Promise<FoldseekOutcome> {
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
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }

    try {
      return await this.pollToOutcome(ticketId, params, ctx);
    } catch (err) {
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Resume an existing ticket: bounded-poll a ticket returned by a prior `search`
   * without resubmitting. A bogus or expired ticket is a clean `400 "invalid ID"`
   * from Foldseek — surfaced as `{ status: 'not_found' }`, distinct from an
   * in-flight job (`computing`) or a processing error (`failed`). Never throws.
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
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async submit(
    fileContent: string,
    fileName: string,
    databases: string[],
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
    for (const dbResult of raw.results ?? []) {
      const db = dbResult.db ?? 'unknown';
      for (const group of dbResult.alignments ?? []) {
        for (const aln of group ?? []) {
          if (!aln.target) continue;
          hits.push(normalizeHit(aln, db));
        }
      }
    }
    hits.sort(compareHits);
    return { kind: 'page', queryCount, total: hits.length, hits: hits.slice(start, start + limit) };
  }
}

/**
 * Best-first order across databases: `score` descending, a hit with no score
 * last, ties broken by database then target so every page of a ticket walks the
 * same sequence. Each database block already arrives score-sorted upstream;
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

function normalizeHit(aln: RawAlignment, database: string): FoldseekHit {
  const target = aln.target as string;
  const hit: FoldseekHit = { target, database, ...parseTarget(target) };
  // Upstream (MMseqs2-App, which serves search.foldseek.com) emits `seqId` on a
  // 0–100 percentage scale for structure search, while this server declares
  // sequence identity as a 0–1 fraction (matching the `min_identity` inputs on
  // the RCSB paths), so convert once at the service boundary.
  if (typeof aln.seqId === 'number') hit.sequenceIdentity = aln.seqId / 100;
  if (typeof aln.alnLength === 'number') hit.alignmentLength = aln.alnLength;
  if (typeof aln.prob === 'number') hit.probability = aln.prob;
  if (typeof aln.eval === 'number') hit.evalue = aln.eval;
  if (typeof aln.score === 'number') hit.score = aln.score;
  return hit;
}

/**
 * Resolve a Foldseek target header to an addressable identifier. PDB targets
 * arrive either bare (`1abc_A`) or as assembly files (`1abc-assembly1.cif.gz_A`);
 * the chain is the segment after the underscore in both.
 */
function parseTarget(
  target: string,
): Pick<FoldseekHit, 'targetType' | 'pdbId' | 'chain' | 'uniprotAccession'> {
  const af = /^AF-([A-Za-z0-9]+)-F\d+/.exec(target);
  if (af) return { targetType: 'alphafold', uniprotAccession: af[1] as string };
  const pdb = /^(\d[A-Za-z0-9]{3})(?:-assembly\d+\.cif(?:\.gz)?)?[_-]([A-Za-z0-9]+)/.exec(target);
  if (pdb)
    return { targetType: 'pdb', pdbId: (pdb[1] as string).toUpperCase(), chain: pdb[2] as string };
  return { targetType: 'other' };
}

interface RawQueryList {
  lookup?: Array<{ id?: number; name?: string }>;
}

interface RawResultResponse {
  results?: Array<{ db?: string; alignments?: RawAlignment[][] }>;
}

interface RawAlignment {
  alnLength?: number;
  eval?: number;
  prob?: number;
  score?: number;
  /** Sequence identity as a 0–100 percentage — normalized to 0–1 in `normalizeHit`. */
  seqId?: number;
  target?: string;
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
