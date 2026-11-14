/**
 * @fileoverview Tests for the shared async primitives on fake timers:
 * concurrency-capped fan-out (exactly `limit` in flight, input order kept when
 * items finish out of order) and bounded submit→poll (the backoff schedule, the
 * window end, and no step once the signal has aborted).
 * @module tests/services/shared/async.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mapWithConcurrency, withAsyncPoll } from '@/services/shared/async.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Resolve after `ms` of fake time. */
const elapse = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('mapWithConcurrency', () => {
  it('runs exactly `limit` items at once when there are more items than that', async () => {
    let active = 0;
    let peak = 0;
    const run = mapWithConcurrency(
      Array.from({ length: 12 }, (_, i) => i),
      3,
      async () => {
        active++;
        peak = Math.max(peak, active);
        await elapse(10);
        active--;
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(active).toBe(3);
    await vi.advanceTimersByTimeAsync(40);
    await run;
    expect(peak).toBe(3);
  });

  it('keeps input order when items finish out of order', async () => {
    const finished: number[] = [];
    const run = mapWithConcurrency([30, 5, 15], 3, async (ms, i) => {
      await elapse(ms);
      finished.push(i);
      return i;
    });
    await vi.advanceTimersByTimeAsync(5);
    expect(finished).toEqual([1]);
    await vi.advanceTimersByTimeAsync(10);
    expect(finished).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(15);
    expect(finished).toEqual([1, 2, 0]);
    expect(await run).toEqual([0, 1, 2]);
  });

  it('returns an empty array for no items without invoking fn', async () => {
    const fn = vi.fn(async () => 1);
    expect(await mapWithConcurrency([], 5, fn)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('withAsyncPoll', () => {
  /** A never-ready step that records the fake-clock offset of each call. */
  const recordingStep = () => {
    const start = Date.now();
    const calls: number[] = [];
    const step = vi.fn(async () => {
      calls.push(Date.now() - start);
      return { ready: false as const };
    });
    return { calls, step };
  };

  it('resolves complete after one call when the first step is ready', async () => {
    const step = vi.fn(async () => ({ ready: true as const, value: 42 }));
    const out = await withAsyncPoll({ step, timeoutMs: 1000, ctx: createMockContext() });
    expect(out).toEqual({ status: 'complete', value: 42 });
    expect(step).toHaveBeenCalledTimes(1);
  });

  it('polls on the backoff schedule and returns computing when the window ends, not before', async () => {
    const { calls, step } = recordingStep();
    let settled: unknown;
    const run = withAsyncPoll({
      step,
      timeoutMs: 5000,
      ctx: createMockContext(),
      intervalMs: 1000,
      maxIntervalMs: 2000,
    }).then((outcome) => {
      settled = outcome;
    });

    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(settled).toEqual({ status: 'computing' });
    // 1.5× backoff from 1000, capped at 2000, the last sleep clamped to the window.
    expect(calls).toEqual([0, 1000, 2500, 4500, 5000]);
  });

  it('issues no step after the signal aborts mid-sleep and rejects with its reason', async () => {
    const { calls, step } = recordingStep();
    const controller = new AbortController();
    const run = withAsyncPoll({
      step,
      timeoutMs: 5000,
      ctx: createMockContext({ signal: controller.signal }),
      intervalMs: 1000,
      maxIntervalMs: 2000,
    }).catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(500);
    const reason = new DOMException('budget spent', 'TimeoutError');
    controller.abort(reason);
    expect(await run).toBe(reason);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toEqual([0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('issues no step at all when the signal has already aborted', async () => {
    const { step } = recordingStep();
    const controller = new AbortController();
    controller.abort('client went away');
    await expect(
      withAsyncPoll({
        step,
        timeoutMs: 5000,
        ctx: createMockContext({ signal: controller.signal }),
      }),
    ).rejects.toBe('client went away');
    expect(step).not.toHaveBeenCalled();
  });
});
