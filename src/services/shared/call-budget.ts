/**
 * @fileoverview One wall-clock budget across every upstream request a tool or
 * resource call chains. The shared HTTP helpers read `ctx.signal`, so the budget
 * rides on a derived context whose signal also aborts — with a `TimeoutError`
 * reason, which `fetchWithTimeout` reports as `Timeout` — once the budget is spent.
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
 * {@link CALL_BUDGET_MS} elapses, whichever comes first, so every request made
 * through it shares one budget. A caller's cancellation keeps the caller's
 * reason. The clock is cleared when `run` settles; no timer outlives the call.
 */
export async function withCallBudget<T>(
  ctx: Context,
  run: (budgeted: Context) => Promise<T>,
): Promise<T> {
  const clock = new AbortController();
  // AbortController + setTimeout, not AbortSignal.timeout(), which can fail on a
  // realm mismatch under Bun's stdio transport.
  const timer = setTimeout(
    () =>
      clock.abort(
        new DOMException(
          `Upstream requests for this call ran past the ${CALL_BUDGET_MS / 1000} s budget.`,
          'TimeoutError',
        ),
      ),
    CALL_BUDGET_MS,
  );
  try {
    return await run({ ...ctx, signal: AbortSignal.any([ctx.signal, clock.signal]) });
  } finally {
    clearTimeout(timer);
  }
}
