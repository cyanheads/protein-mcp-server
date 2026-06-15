/**
 * @fileoverview Shared async primitives: bounded submit→poll for the RCSB
 * alignment and Foldseek services (both expose a job ticket that isn't ready on
 * the first poll), and a concurrency-capped fan-out for per-ID / per-pair work.
 * @module services/shared/async
 */

import type { Context } from '@cyanheads/mcp-ts-core';

/** Outcome of a bounded poll: the resolved value, or a "still computing" signal. */
export type PollOutcome<T> = { status: 'complete'; value: T } | { status: 'computing' };

/** One poll attempt result: ready with a value, or not ready yet. */
export type PollStep<T> = { ready: true; value: T } | { ready: false };

/** Sleep for `ms`, resolving early (without rejecting) if the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Poll `step` with backoff until it reports ready or the wall-clock budget is
 * spent, returning `status: 'computing'` on timeout rather than blocking past the
 * budget. The agent re-calls to resume — async jobs are modeled as success
 * variants, not thrown errors.
 */
export async function withAsyncPoll<T>(opts: {
  step: () => Promise<PollStep<T>>;
  timeoutMs: number;
  ctx: Context;
  intervalMs?: number;
  maxIntervalMs?: number;
}): Promise<PollOutcome<T>> {
  const start = Date.now();
  let interval = opts.intervalMs ?? 1000;
  const maxInterval = opts.maxIntervalMs ?? 2000;
  while (true) {
    const step = await opts.step();
    if (step.ready) return { status: 'complete', value: step.value };
    const elapsed = Date.now() - start;
    if (opts.ctx.signal.aborted || elapsed >= opts.timeoutMs) return { status: 'computing' };
    await sleep(Math.min(interval, opts.timeoutMs - elapsed), opts.ctx.signal);
    interval = Math.min(interval * 1.5, maxInterval);
  }
}

/**
 * Map `items` through `fn` with at most `limit` concurrent calls, preserving
 * input order. `fn` is expected to handle its own failures (return a result
 * variant) so one slow/failed unit degrades its row, not the whole call.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  };
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return results;
}
