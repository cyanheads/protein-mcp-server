/**
 * @fileoverview RCSB Structural Comparison (alignment) service — wraps the hosted
 * async pairwise alignment API (`/api/v1/structures/submit` → `/results?uuid=`).
 * Native mode is `pairwise`; multi-structure comparison fans these out. Submit
 * returns a bare UUID; the results poll returns 404 until the job is computed.
 * Backs `protein_compare_structures`. No in-process alignment — edge-deployable.
 * @module services/alignment/alignment-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import type { ServerConfig } from '@/config/server-config.js';
import { type PollStep, withAsyncPoll } from '../shared/async.js';
import { fetchResponse, fetchText, parseJson } from '../shared/http.js';

/** Alignment method name accepted by the RCSB Structural Comparison API. */
export type AlignmentMethod = 'tm-align' | 'fatcat-rigid' | 'fatcat-flexible';

/** One structure (+ optional chain) in a comparison. */
export interface CompareStructure {
  asymId?: string;
  entryId: string;
}

/** Scores for one aligned pair. */
export interface PairScores {
  alignedResidues?: number;
  rmsd?: number;
  sequenceIdentity?: number;
  tmScore?: number;
}

/** Outcome of one pairwise alignment. */
export type PairOutcome =
  | { status: 'complete'; uuid: string; scores: PairScores }
  | { status: 'computing'; uuid: string }
  | { status: 'failed'; error: string };

export class AlignmentService {
  private readonly submitUrl: string;
  private readonly resultsUrl: string;

  constructor(_config: AppConfig, _storage: StorageService, serverConfig: ServerConfig) {
    this.submitUrl = `${serverConfig.rcsbAlignmentBaseUrl}/api/v1/structures/submit`;
    this.resultsUrl = `${serverConfig.rcsbAlignmentBaseUrl}/api/v1/structures/results`;
  }

  /** Submit a pairwise alignment job; returns the job UUID. */
  async submit(
    a: CompareStructure,
    b: CompareStructure,
    method: AlignmentMethod,
    ctx: Context,
  ): Promise<string> {
    const query = {
      context: {
        mode: 'pairwise',
        // The API's method schema is additionalProperties:false with only `name`
        // for tm-align — sending an (even empty) `parameters` object fails
        // validation. Methods that accept parameters all default sensibly.
        method: { name: method },
        structures: [toQueryStructure(a), toQueryStructure(b)],
      },
    };
    const url = `${this.submitUrl}?query=${encodeURIComponent(JSON.stringify(query))}`;
    const text = await fetchText(url, ctx, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      operation: 'AlignmentService.submit',
      label: 'RCSB Alignment API',
      baseDelayMs: 500,
    });
    return text.trim().replace(/^"|"$/g, '');
  }

  /**
   * Run one pairwise alignment end-to-end: submit, then bounded-poll the result.
   * Never throws — a submit/poll failure degrades to `{ status: 'failed' }` so
   * one bad pair doesn't sink the whole comparison.
   */
  async comparePair(
    a: CompareStructure,
    b: CompareStructure,
    method: AlignmentMethod,
    timeoutMs: number,
    ctx: Context,
  ): Promise<PairOutcome> {
    let uuid: string;
    try {
      uuid = await this.submit(a, b, method, ctx);
    } catch (err) {
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
    try {
      const outcome = await withAsyncPoll<PairScores>({
        step: () => this.pollResult(uuid, ctx),
        timeoutMs,
        ctx,
        intervalMs: 1500,
        maxIntervalMs: 2500,
      });
      return outcome.status === 'complete'
        ? { status: 'complete', uuid, scores: outcome.value }
        : { status: 'computing', uuid };
    } catch (err) {
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Resume an existing job: bounded-poll a UUID returned by a prior `comparePair`
   * without resubmitting. Reuses the same `pollResult` step, so a `404` — which the
   * RCSB API returns identically for an expired UUID and a job still computing —
   * degrades to `{ status: 'computing' }` on timeout rather than a false `failed`.
   * A legitimately in-flight job is never mistaken for a dead one. Never throws.
   */
  async resumePair(uuid: string, timeoutMs: number, ctx: Context): Promise<PairOutcome> {
    try {
      const outcome = await withAsyncPoll<PairScores>({
        step: () => this.pollResult(uuid, ctx),
        timeoutMs,
        ctx,
        intervalMs: 1500,
        maxIntervalMs: 2500,
      });
      return outcome.status === 'complete'
        ? { status: 'complete', uuid, scores: outcome.value }
        : { status: 'computing', uuid };
    } catch (err) {
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Single poll of a job's results. 404 = still computing; a result body = ready. */
  private async pollResult(uuid: string, ctx: Context): Promise<PollStep<PairScores>> {
    const res = await fetchResponse(`${this.resultsUrl}?uuid=${encodeURIComponent(uuid)}`, ctx, {
      operation: 'AlignmentService.pollResult',
      timeoutMs: 15_000,
      baseDelayMs: 400,
    });
    if (res.status === 404) return { ready: false };
    if (!res.ok) throw new Error(`RCSB Alignment results returned HTTP ${res.status}`);
    const raw = parseJson<RawAlignmentResponse>(await res.text(), 'RCSB Alignment API');
    const first = raw.results?.[0];
    if (!first) return { ready: false };
    return { ready: true, value: normalizeScores(first) };
  }
}

function toQueryStructure(s: CompareStructure): Record<string, unknown> {
  return {
    entry_id: s.entryId.toUpperCase(),
    ...(s.asymId ? { selection: { asym_id: s.asymId } } : {}),
  };
}

/**
 * Extract TM-score / RMSD / aligned-residue count from a result row. The summary
 * carries a heterogeneous `scores` array (`{ type, value }`); match by type name
 * so a field rename upstream degrades a single metric rather than the whole row.
 */
function normalizeScores(result: RawAlignmentResult): PairScores {
  const summary = result.summary ?? {};
  const scores = summary.scores ?? [];
  const byType = (re: RegExp): number | undefined =>
    scores.find((s) => s.type && re.test(s.type))?.value;
  const out: PairScores = {};
  const tm = byType(/tm[\s_-]?score/i);
  const rmsd = byType(/rmsd/i);
  const seqId = byType(/seq.*id|identity/i);
  const aligned =
    summary.n_aln_residue_pairs ??
    summary.aligned_residues ??
    summary.n_aligned_residues ??
    byType(/aligned/i);
  if (typeof tm === 'number') out.tmScore = tm;
  if (typeof rmsd === 'number') out.rmsd = rmsd;
  if (typeof seqId === 'number') out.sequenceIdentity = seqId;
  if (typeof aligned === 'number') out.alignedResidues = aligned;
  return out;
}

interface RawAlignmentResponse {
  info?: { status?: string };
  results?: RawAlignmentResult[];
}

interface RawAlignmentResult {
  summary?: {
    scores?: Array<{ type?: string; value?: number }>;
    n_aln_residue_pairs?: number;
    aligned_residues?: number;
    n_aligned_residues?: number;
  };
}

let _service: AlignmentService | undefined;

export function initAlignmentService(
  config: AppConfig,
  storage: StorageService,
  serverConfig: ServerConfig,
): void {
  _service = new AlignmentService(config, storage, serverConfig);
}

export function getAlignmentService(): AlignmentService {
  if (!_service)
    throw new Error('AlignmentService not initialized — call initAlignmentService() in setup()');
  return _service;
}
