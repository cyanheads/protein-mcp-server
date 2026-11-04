/**
 * @fileoverview Tests for TextBudget: reads hold their text whole while the
 * shared total fits (a chunk landing exactly on the budget included); the first
 * chunk that would pass it drops every read's held text, after which reads only
 * count; held text never exceeds the budget across interleaved reads; and a
 * released read returns its characters to the budget.
 * @module tests/services/shared/text-budget.test
 */

import { describe, expect, it } from 'vitest';
import { TextBudget } from '@/services/shared/text-budget.js';

describe('TextBudget', () => {
  it('holds each read whole while the shared total fits', () => {
    const budget = new TextBudget(30);
    budget.add('a', 'x'.repeat(10));
    budget.add('b', 'y'.repeat(12));
    budget.add('a', 'z'.repeat(3));

    expect(budget.overBudget).toBe(false);
    expect(budget.heldChars).toBe(25);
    expect(budget.text('a')).toBe(`${'x'.repeat(10)}zzz`);
    expect(budget.text('b')).toBe('y'.repeat(12));
    expect(budget.length('a')).toBe(13);
    expect(budget.length('b')).toBe(12);
  });

  it('holds a chunk that lands exactly on the budget', () => {
    const budget = new TextBudget(30);
    budget.add('a', 'x'.repeat(18));
    budget.add('b', 'y'.repeat(12));

    expect(budget.overBudget).toBe(false);
    expect(budget.heldChars).toBe(30);
    expect(budget.text('b')).toBe('y'.repeat(12));
  });

  it('drops every read’s held text once a chunk would pass the budget, then only counts', () => {
    const budget = new TextBudget(30);
    budget.add('a', 'x'.repeat(10));
    budget.add('b', 'y'.repeat(15));
    budget.add('a', 'z'.repeat(6));

    expect(budget.overBudget).toBe(true);
    expect(budget.heldChars).toBe(0);
    expect(budget.text('a')).toBe('');
    expect(budget.text('b')).toBe('');
    expect(budget.length('a')).toBe(16);
    expect(budget.length('b')).toBe(15);

    // A chunk that would fit on its own is counted, never held, once over.
    budget.add('b', 'w');
    budget.add('c', 'v'.repeat(100));
    expect(budget.heldChars).toBe(0);
    expect(budget.text('b')).toBe('');
    expect(budget.text('c')).toBe('');
    expect(budget.length('b')).toBe(16);
    expect(budget.length('c')).toBe(100);
  });

  it('never holds more than the budget across many interleaved chunks', () => {
    const limit = 24_000;
    const budget = new TextBudget(limit);
    let maxHeld = 0;
    let seen = 0;
    // Three reads of 1,000-character chunks, interleaved, 300,000 characters in all.
    for (let i = 0; i < 300; i++) {
      budget.add(`read-${i % 3}`, 'A'.repeat(1_000));
      seen += 1_000;
      maxHeld = Math.max(maxHeld, budget.heldChars);
    }

    expect(maxHeld).toBeLessThanOrEqual(limit);
    expect(budget.overBudget).toBe(true);
    expect(budget.length('read-0') + budget.length('read-1') + budget.length('read-2')).toBe(seen);
  });

  it('returns a released read’s held characters to the budget', () => {
    const budget = new TextBudget(30);
    budget.add('a', 'x'.repeat(20));
    budget.add('b', 'y'.repeat(5));
    budget.release('a');

    expect(budget.heldChars).toBe(5);
    expect(budget.text('a')).toBe('');
    expect(budget.length('a')).toBe(0);
    // The released characters make room: 5 + 20 fits a budget of 30.
    budget.add('b', 'w'.repeat(20));
    expect(budget.overBudget).toBe(false);
    expect(budget.text('b')).toBe(`${'y'.repeat(5)}${'w'.repeat(20)}`);
  });

  it('leaves nothing to return when a read is released after the budget was passed, or never started', () => {
    const budget = new TextBudget(10);
    budget.add('a', 'x'.repeat(8));
    budget.add('b', 'y'.repeat(8));
    budget.release('a');
    budget.release('never-read');

    expect(budget.overBudget).toBe(true);
    expect(budget.heldChars).toBe(0);
    expect(budget.length('b')).toBe(8);
  });

  it('reports an empty, zero-length read for a key that received no chunks', () => {
    const budget = new TextBudget(10);
    expect(budget.text('a')).toBe('');
    expect(budget.length('a')).toBe(0);
    expect(budget.heldChars).toBe(0);
    expect(budget.overBudget).toBe(false);
  });
});
