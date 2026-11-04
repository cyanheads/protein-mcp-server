/**
 * @fileoverview Tests for withCallBudget: the derived context's signal aborts
 * with a TimeoutError at 50 s and with the caller's own reason on cancellation,
 * the clock is cleared once the run settles, the rest of the context passes
 * through, and a request in flight at the deadline fails as `Timeout` through
 * the real HTTP layer.
 * @module tests/services/shared/call-budget.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withCallBudget } from '@/services/shared/call-budget.js';
import { fetchJson } from '@/services/shared/http.js';

/** A run that holds the call open until its signal fires, then reports the reason. */
const untilAborted = (budgeted: { signal: AbortSignal }) =>
  new Promise<unknown>((resolve) =>
    budgeted.signal.addEventListener('abort', () => resolve(budgeted.signal.reason), {
      once: true,
    }),
  );

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('withCallBudget', () => {
  it('aborts the derived signal with a TimeoutError once 50 s elapse, not before', async () => {
    let signal: AbortSignal | undefined;
    const running = withCallBudget(createMockContext(), (budgeted) => {
      signal = budgeted.signal;
      return untilAborted(budgeted);
    });

    await vi.advanceTimersByTimeAsync(49_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    const reason = (await running) as DOMException;
    expect(reason.name).toBe('TimeoutError');
    expect(reason.message).toContain('50 s');
  });

  it("passes the caller's cancellation through with the caller's own reason", async () => {
    const caller = new AbortController();
    const running = withCallBudget(createMockContext({ signal: caller.signal }), untilAborted);
    caller.abort('client went away');
    expect(await running).toBe('client went away');
  });

  it('clears its clock when the run settles, either way', async () => {
    await withCallBudget(createMockContext(), async () => 'done');
    expect(vi.getTimerCount()).toBe(0);
    await expect(
      withCallBudget(createMockContext(), async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('hands the run the same context apart from its signal', async () => {
    const ctx = createMockContext({ requestId: 'req-1' });
    const seen = await withCallBudget(ctx, async (budgeted) => budgeted);
    expect(seen.requestId).toBe('req-1');
    expect(seen.log).toBe(ctx.log);
    expect(seen.enrich).toBe(ctx.enrich);
    expect(seen.signal).not.toBe(ctx.signal);
  });

  it('fails a request still in flight at the deadline as Timeout, through the real HTTP layer', async () => {
    const http = createFetchMock([
      {
        match: (req) => new URL(req.url).hostname === 'slow.test',
        respond: (req) =>
          new Promise<Response>((_, reject) =>
            req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true }),
          ),
      },
    ]);
    http.install();
    try {
      const running = withCallBudget(createMockContext(), (budgeted) =>
        fetchJson('https://slow.test/x', budgeted, {
          operation: 'test',
          label: 'Slow',
          timeoutMs: 120_000,
          maxRetries: 0,
        }),
      ).catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(50_000);
      expect(await running).toMatchObject({ code: JsonRpcErrorCode.Timeout });
    } finally {
      http.restore();
    }
  });
});
