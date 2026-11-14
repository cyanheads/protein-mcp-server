/**
 * @fileoverview Wall-clock deadlines across every upstream request a span of
 * work chains: one budget per tool or resource call, and shorter deadlines
 * nested inside it. The shared HTTP helpers read `ctx.signal`, so a deadline
 * rides on a derived context whose signal also aborts — with a `TimeoutError`
 * reason, which `fetchWithTimeout` reports as `Timeout` — once it passes.
 * @module services/shared/call-budget
 */

import type { Context } from '@cyanheads/mcp-ts-core';

/**
 * Wall-clock budget for one call's upstream requests, under the 60 s request
 * timeout MCP clients default to, so the caller receives this server's `Timeout`
 * rather than a transport timeout.
 */
const CALL_BUDGET_MS = 50_000;

/**
 * Run `run` with a context whose signal aborts when the caller cancels or when
 * `ms` elapses, whichever comes first, so every request made through it shares
 * one deadline. The deadline aborts with a `TimeoutError` carrying `message`; a
 * caller's cancellation keeps the caller's reason. The clock is cleared when
 * `run` settles; no timer outlives the call.
 */
export async function withDeadline<T>(
  ctx: Context,
  ms: number,
  message: string,
  run: (bounded: Context) => Promise<T>,
): Promise<T> {
  const clock = new AbortController();
  // AbortController + setTimeout, not AbortSignal.timeout(), which fake timers
  // can't drive and which can fail on a realm mismatch under Bun's stdio transport.
  const timer = setTimeout(() => clock.abort(new DOMException(message, 'TimeoutError')), ms);
  try {
    return await run({ ...ctx, signal: AbortSignal.any([ctx.signal, clock.signal]) });
  } finally {
    clearTimeout(timer);
  }
}

/** {@link withDeadline} at the {@link CALL_BUDGET_MS} budget every tool and resource call keeps. */
export function withCallBudget<T>(
  ctx: Context,
  run: (budgeted: Context) => Promise<T>,
): Promise<T> {
  return withDeadline(
    ctx,
    CALL_BUDGET_MS,
    `Upstream requests for this call ran past the ${CALL_BUDGET_MS / 1000} s budget.`,
    run,
  );
}

/**
 * The abort reason when `ctx.signal` stopped at a deadline — the call budget, or
 * a {@link withDeadline} nested inside it — and `undefined` otherwise. It reads
 * the context it is handed: under nesting, an inner deadline that fired first is
 * a stop on the inner context and not on the outer one, whose signal never
 * aborted. A caller's cancellation keeps the caller's reason, so it is never
 * read as a deadline stop and stays a cancellation.
 */
export function budgetExhaustion(ctx: Context): DOMException | undefined {
  const reason: unknown = ctx.signal.reason;
  return ctx.signal.aborted && reason instanceof DOMException && reason.name === 'TimeoutError'
    ? reason
    : undefined;
}

/**
 * True when `ctx.signal` aborted for something other than a deadline — the
 * caller's own cancellation, which no degraded result may absorb: rethrow it.
 */
export function cancelledByCaller(ctx: Context): boolean {
  return ctx.signal.aborted && !budgetExhaustion(ctx);
}
