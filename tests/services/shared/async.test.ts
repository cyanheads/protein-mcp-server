/**
 * @fileoverview Tests for the shared async primitives: concurrency-capped fan-out
 * (order preservation, bounded parallelism) and bounded submit→poll (ready vs.
 * "still computing" on budget exhaustion).
 * @module tests/services/shared/async.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { mapWithConcurrency, withAsyncPoll } from '@/services/shared/async.js';

describe('mapWithConcurrency', () => {
  it('preserves input order despite out-of-order completion', async () => {
    const out = await mapWithConcurrency([30, 5, 15], 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2]);
  });

  it('never exceeds the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 12 }, (_, i) => i),
      3,
      async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 4));
        active--;
      },
    );
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('returns an empty array for no items without invoking fn', async () => {
    const fn = vi.fn(async () => 1);
    expect(await mapWithConcurrency([], 5, fn)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('withAsyncPoll', () => {
  it('resolves complete as soon as a step reports ready', async () => {
    const out = await withAsyncPoll({
      step: async () => ({ ready: true, value: 42 }),
      timeoutMs: 1000,
      ctx: createMockContext(),
    });
    expect(out).toEqual({ status: 'complete', value: 42 });
  });

  it('returns computing once the wall-clock budget elapses', async () => {
    const step = vi.fn(async () => ({ ready: false as const }));
    const out = await withAsyncPoll({
      step,
      timeoutMs: 30,
      ctx: createMockContext(),
      intervalMs: 5,
      maxIntervalMs: 10,
    });
    expect(out).toEqual({ status: 'computing' });
    expect(step.mock.calls.length).toBeGreaterThan(0);
  });
});
