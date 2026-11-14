/**
 * @fileoverview Tests for withCallBudget: the derived context's signal aborts
 * with a TimeoutError at 50 s and with the caller's own reason on cancellation,
 * the clock is cleared once the run settles, the rest of the context passes
 * through, and a request in flight at the deadline fails as `Timeout` through
 * the real HTTP layer. withDeadline, the general form, likewise at its own ms
 * and message, and nested under the budget, where budgetExhaustion reads a stop
 * on the context whose deadline fired and never on a caller's cancellation.
 * @module tests/services/shared/call-budget.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  budgetExhaustion,
  cancelledByCaller,
  withCallBudget,
  withDeadline,
} from '@/services/shared/call-budget.js';
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

describe('withDeadline', () => {
  const MESSAGE = 'The two searches ran past their 1.234 s deadline.';

  it("aborts the derived signal at ms with a TimeoutError carrying the deadline's message, not before", async () => {
    let signal: AbortSignal | undefined;
    const running = withDeadline(createMockContext(), 1_234, MESSAGE, (bounded) => {
      signal = bounded.signal;
      return untilAborted(bounded);
    });

    await vi.advanceTimersByTimeAsync(1_233);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const reason = (await running) as DOMException;
    expect([reason.name, reason.message]).toEqual(['TimeoutError', MESSAGE]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes the caller's cancellation through with the caller's own reason, clearing the clock", async () => {
    const caller = new AbortController();
    const running = withDeadline(
      createMockContext({ signal: caller.signal }),
      1_234,
      MESSAGE,
      untilAborted,
    );
    caller.abort('client went away');
    expect(await running).toBe('client went away');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its clock when the run settles, either way', async () => {
    expect(await withDeadline(createMockContext(), 1_234, MESSAGE, async () => 'done')).toBe(
      'done',
    );
    expect(vi.getTimerCount()).toBe(0);
    await expect(
      withDeadline(createMockContext(), 1_234, MESSAGE, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(vi.getTimerCount()).toBe(0);
  });

  describe('nested inside the call budget', () => {
    /** The budgeted (outer) and deadline-bound (inner) contexts a nested run sees, and its outcome. */
    const nest = (innerMs: number, caller = new AbortController()) => {
      const seen: { outer?: Context; inner?: Context } = {};
      const running = withCallBudget(createMockContext({ signal: caller.signal }), (outer) => {
        seen.outer = outer;
        return withDeadline(outer, innerMs, MESSAGE, (inner) => {
          seen.inner = inner;
          return untilAborted(inner);
        });
      });
      return { caller, running, seen };
    };

    it('an inner deadline that fires first is a stop on the inner context only', async () => {
      const { running, seen } = nest(35_000);
      await vi.advanceTimersByTimeAsync(35_000);
      await running;
      expect(budgetExhaustion(seen.inner as Context)?.message).toBe(MESSAGE);
      expect(seen.outer?.signal.aborted).toBe(false);
      expect(budgetExhaustion(seen.outer as Context)).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('the outer budget firing first reads as the budget on both contexts', async () => {
      const { running, seen } = nest(80_000);
      await vi.advanceTimersByTimeAsync(50_000);
      await running;
      const budget = budgetExhaustion(seen.outer as Context);
      expect(budget?.message).toBe('Upstream requests for this call ran past the 50 s budget.');
      expect(budgetExhaustion(seen.inner as Context)).toBe(budget);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("a caller's cancellation reads as no stop on either context", async () => {
      const { caller, running, seen } = nest(35_000);
      caller.abort(new DOMException('stop', 'AbortError'));
      await running;
      expect(seen.inner?.signal.aborted).toBe(true);
      expect(budgetExhaustion(seen.inner as Context)).toBeUndefined();
      expect(budgetExhaustion(seen.outer as Context)).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe('budgetExhaustion', () => {
  it("returns the budget's TimeoutError once the budget runs out, and nothing before", async () => {
    let budgeted: { signal: AbortSignal } | undefined;
    const running = withCallBudget(createMockContext(), (b) => {
      budgeted = b;
      return untilAborted(b);
    });
    const ctxOf = () => ({ ...createMockContext(), signal: budgeted?.signal as AbortSignal });

    expect(budgetExhaustion(ctxOf())).toBeUndefined();
    await vi.advanceTimersByTimeAsync(50_000);
    const reason = await running;
    expect(budgetExhaustion(ctxOf())).toBe(reason);
    expect(budgetExhaustion(ctxOf())?.name).toBe('TimeoutError');
  });

  it("reads a caller's cancellation as no budget stop, whatever its reason", async () => {
    for (const why of ['client went away', new DOMException('stop', 'AbortError')]) {
      const caller = new AbortController();
      const running = withCallBudget(createMockContext({ signal: caller.signal }), (b) =>
        untilAborted(b).then(() => budgetExhaustion({ ...createMockContext(), signal: b.signal })),
      );
      caller.abort(why);
      expect(await running).toBeUndefined();
    }
  });
});

describe('cancelledByCaller', () => {
  /** Start a budgeted run held open, handing back a context over the budgeted signal. */
  const start = (signal?: AbortSignal) => {
    let seen: Context | undefined;
    const running = withCallBudget(createMockContext(signal ? { signal } : {}), (b) => {
      seen = { ...createMockContext(), signal: b.signal };
      return untilAborted(b);
    });
    return { running, ctx: () => seen as Context };
  };

  it('is false while nothing has aborted and once the budget has stopped the call', async () => {
    const { running, ctx } = start();
    expect(cancelledByCaller(ctx())).toBe(false);
    await vi.advanceTimersByTimeAsync(50_000);
    await running;
    expect(cancelledByCaller(ctx())).toBe(false);
  });

  it("is true once the caller's own signal aborted, whatever its reason", async () => {
    for (const why of ['client went away', new DOMException('stop', 'AbortError')]) {
      const caller = new AbortController();
      const { running, ctx } = start(caller.signal);
      caller.abort(why);
      await running;
      expect(cancelledByCaller(ctx())).toBe(true);
    }
  });
});
