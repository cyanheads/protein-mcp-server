/**
 * @fileoverview Foldseek service — wraps the public Foldseek structural-search
 * ticket API (`/api/ticket` → poll `/api/ticket/{id}` → `/api/result/{id}/{n}`).
 * Submits a query coordinate file against experimental + predicted databases and
 * returns fold-similarity hits. Backs `protein_find_similar` (`by: structure`).
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
  /** Sequence identity (0–1) over the alignment. */
  sequenceIdentity?: number;
  /** Raw target identifier as returned by Foldseek. */
  target: string;
  /** Resolved target kind. */
  targetType: 'pdb' | 'alphafold' | 'other';
  /** UniProt accession (AlphaFold targets). */
  uniprotAccession?: string;
}

/** Outcome of a structural search or ticket resume. */
export type FoldseekOutcome =
  | { status: 'complete'; ticketId: string; hits: FoldseekHit[] }
  | { status: 'computing'; ticketId: string }
  | { status: 'not_found'; ticketId: string }
  | { status: 'failed'; error: string };

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
      const outcome = await withAsyncPoll<FoldseekHit[]>({
        step: () => this.pollTicket(ticketId, params.limit, ctx),
        timeoutMs: params.timeoutMs,
        ctx,
        intervalMs: 1500,
        maxIntervalMs: 2500,
      });
      return outcome.status === 'complete'
        ? { status: 'complete', ticketId, hits: outcome.value }
        : { status: 'computing', ticketId };
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
    params: { ticketId: string; limit: number; timeoutMs: number },
    ctx: Context,
  ): Promise<FoldseekOutcome> {
    try {
      const outcome = await withAsyncPoll<FoldseekHit[]>({
        step: () => this.pollTicket(params.ticketId, params.limit, ctx),
        timeoutMs: params.timeoutMs,
        ctx,
        intervalMs: 1500,
        maxIntervalMs: 2500,
      });
      return outcome.status === 'complete'
        ? { status: 'complete', ticketId: params.ticketId, hits: outcome.value }
        : { status: 'computing', ticketId: params.ticketId };
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

  private async pollTicket(
    ticketId: string,
    limit: number,
    ctx: Context,
  ): Promise<PollStep<FoldseekHit[]>> {
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
    const hits = await this.fetchResults(ticketId, limit, ctx);
    return { ready: true, value: hits };
  }

  private async fetchResults(
    ticketId: string,
    limit: number,
    ctx: Context,
  ): Promise<FoldseekHit[]> {
    const raw = await fetchJson<RawResultResponse>(
      `${this.baseUrl}/api/result/${encodeURIComponent(ticketId)}/0`,
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
          if (hits.length >= limit) return hits;
        }
      }
    }
    return hits;
  }
}

// ─── Normalizers ──────────────────────────────────────────────────────────────

function normalizeHit(aln: RawAlignment, database: string): FoldseekHit {
  const target = aln.target as string;
  const hit: FoldseekHit = { target, database, ...parseTarget(target) };
  if (typeof aln.seqId === 'number') hit.sequenceIdentity = aln.seqId;
  if (typeof aln.alnLength === 'number') hit.alignmentLength = aln.alnLength;
  if (typeof aln.prob === 'number') hit.probability = aln.prob;
  if (typeof aln.eval === 'number') hit.evalue = aln.eval;
  if (typeof aln.score === 'number') hit.score = aln.score;
  return hit;
}

/** Resolve a Foldseek target header to an addressable identifier. */
function parseTarget(
  target: string,
): Pick<FoldseekHit, 'targetType' | 'pdbId' | 'chain' | 'uniprotAccession'> {
  const af = /^AF-([A-Za-z0-9]+)-F\d+/.exec(target);
  if (af) return { targetType: 'alphafold', uniprotAccession: af[1] as string };
  const pdb = /^(\d[A-Za-z0-9]{3})[_-]([A-Za-z0-9]+)/.exec(target);
  if (pdb)
    return { targetType: 'pdb', pdbId: (pdb[1] as string).toUpperCase(), chain: pdb[2] as string };
  return { targetType: 'other' };
}

interface RawResultResponse {
  results?: Array<{ db?: string; alignments?: RawAlignment[][] }>;
}

interface RawAlignment {
  alnLength?: number;
  eval?: number;
  prob?: number;
  score?: number;
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
