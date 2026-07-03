/**
 * @fileoverview Tests for protein_compare_structures: pair generation
 * (reference:first vs. all_pairs), the computing/ticket outcome with enrichment,
 * and format() rendering of both failure detail and job tickets. Alignment mocked.
 * @module tests/tools/compare-structures.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const comparePair = vi.fn();
const resumePair = vi.fn();
vi.mock('@/services/alignment/alignment-service.js', () => ({
  getAlignmentService: () => ({ comparePair, resumePair }),
}));

import { getServerConfig } from '@/config/server-config.js';
import { compareStructures } from '@/mcp-server/tools/definitions/compare-structures.tool.js';

const ctx = () => createMockContext({ errors: compareStructures.errors });
const three = [{ pdb_id: '4HHB' }, { pdb_id: '2HHB' }, { pdb_id: '1A3N' }];
/** The real, default configured cap (2–25, default 10) the handler slices to. */
const CAP = getServerConfig().maxCompareStructures;

beforeEach(() => vi.clearAllMocks());

describe('protein_compare_structures', () => {
  it('aligns every structure to the first under reference:first', async () => {
    comparePair.mockResolvedValue({ status: 'complete', uuid: 'u', scores: { tmScore: 0.9 } });
    const input = compareStructures.input.parse({ structures: three, reference: 'first' });
    const out = await compareStructures.handler(input, ctx());

    expect(out.pairs).toHaveLength(2);
    expect(out.pairs.map((p) => `${p.a}-${p.b}`)).toEqual(['4HHB-2HHB', '4HHB-1A3N']);
  });

  it('computes the full pairwise matrix under reference:all_pairs', async () => {
    comparePair.mockResolvedValue({ status: 'complete', uuid: 'u', scores: {} });
    const input = compareStructures.input.parse({ structures: three, reference: 'all_pairs' });
    const out = await compareStructures.handler(input, ctx());

    expect(out.pairs).toHaveLength(3); // C(3,2)
  });

  it('surfaces a still-computing pair with its ticket and a notice', async () => {
    comparePair.mockResolvedValue({ status: 'computing', uuid: 'pending-9' });
    const c = ctx();
    const input = compareStructures.input.parse({
      structures: [{ pdb_id: '4HHB' }, { pdb_id: '2HHB' }],
    });
    const out = await compareStructures.handler(input, c);

    expect(out.pairs[0]).toMatchObject({ status: 'computing', uuid: 'pending-9' });
    expect(getEnrichment(c)).toMatchObject({ pairsTotal: 1, computing: 1 });
  });

  it('resumes a matching pair by UUID (order-insensitive) instead of resubmitting', async () => {
    resumePair.mockResolvedValue({
      status: 'complete',
      uuid: 'known-uuid',
      scores: { tmScore: 0.95 },
    });
    const c = ctx();
    const input = compareStructures.input.parse({
      structures: [{ pdb_id: '4HHB' }, { pdb_id: '2HHB' }],
      reference: 'first',
      // Labels supplied b↔a (reversed) — must still match the 4HHB↔2HHB pair.
      resume: [{ a: '2HHB', b: '4HHB', uuid: 'known-uuid' }],
    });
    const out = await compareStructures.handler(input, c);

    expect(resumePair).toHaveBeenCalledWith('known-uuid', expect.any(Number), expect.anything());
    expect(comparePair).not.toHaveBeenCalled();
    expect(out.pairs[0]).toMatchObject({ status: 'complete', uuid: 'known-uuid', tmScore: 0.95 });
  });

  it('submits fresh for pairs with no resume entry, resumes only the matched pair', async () => {
    comparePair.mockResolvedValue({ status: 'complete', uuid: 'fresh', scores: {} });
    resumePair.mockResolvedValue({ status: 'complete', uuid: 'known', scores: {} });
    const input = compareStructures.input.parse({
      structures: three,
      reference: 'first', // pairs: 4HHB↔2HHB, 4HHB↔1A3N
      resume: [{ a: '4HHB', b: '1A3N', uuid: 'known' }],
    });
    await compareStructures.handler(input, ctx());

    expect(resumePair).toHaveBeenCalledTimes(1);
    expect(resumePair).toHaveBeenCalledWith('known', expect.any(Number), expect.anything());
    expect(comparePair).toHaveBeenCalledTimes(1); // the unmatched 4HHB↔2HHB pair
  });

  it('throws resume_pair_unmatched when a resume entry matches no generated pair', async () => {
    const input = compareStructures.input.parse({
      structures: [{ pdb_id: '4HHB' }, { pdb_id: '2HHB' }],
      reference: 'first',
      resume: [{ a: '9XXX', b: '8YYY', uuid: 'u' }],
    });
    await expect(compareStructures.handler(input, ctx())).rejects.toMatchObject({
      data: {
        reason: 'resume_pair_unmatched',
        recovery: { hint: expect.stringContaining('verbatim') },
      },
    });
    expect(comparePair).not.toHaveBeenCalled();
    expect(resumePair).not.toHaveBeenCalled();
  });

  it('accepts and executes 11–25 structures (previously rejected by the maxItems:10 schema)', async () => {
    comparePair.mockResolvedValue({ status: 'complete', uuid: 'u', scores: { tmScore: 0.9 } });
    const eleven = Array.from({ length: 11 }, (_, i) => ({
      pdb_id: `10${String(i).padStart(2, '0')}`,
    }));
    // Under the old `.max(10)` this parse threw; `.max(25)` now accepts it.
    const input = compareStructures.input.parse({ structures: eleven, reference: 'first' });
    expect(input.structures).toHaveLength(11);

    const out = await compareStructures.handler(input, ctx());
    expect(out.pairs.length).toBeGreaterThan(0); // executed, did not fail schema validation
  });

  it('rejects more than 25 structures at the schema boundary', () => {
    const twentySix = Array.from({ length: 26 }, (_, i) => ({
      pdb_id: `30${String(i).padStart(2, '0')}`,
    }));
    expect(() => compareStructures.input.parse({ structures: twentySix })).toThrow();
  });

  it('emits a truncation notice when the request exceeds the configured cap', async () => {
    comparePair.mockResolvedValue({ status: 'complete', uuid: 'u', scores: {} });
    const c = ctx();
    const sent = CAP + 2; // 12 at the default cap of 10 — within the schema max of 25
    const many = Array.from({ length: sent }, (_, i) => ({
      pdb_id: `2${String(i).padStart(3, '0')}`,
    }));
    await compareStructures.handler(
      compareStructures.input.parse({ structures: many, reference: 'first' }),
      c,
    );
    expect(String(getEnrichment(c).notice)).toContain(`Capped at ${CAP} structures; 2 ignored`);
  });

  it('renders both failure detail and a job ticket in format() output', () => {
    const blocks = compareStructures.format?.({
      method: 'tm-align',
      reference: 'first',
      pairs: [
        {
          a: '4HHB',
          b: '2HHB',
          status: 'complete',
          tmScore: 1,
          rmsd: 0.1,
          alignedResidues: 141,
          uuid: 'u1',
        },
        { a: '4HHB', b: '9ZZZ', status: 'failed', error: 'no structure' },
      ],
    });
    const text = (blocks?.[0] as { text: string }).text;

    expect(text).toContain('4HHB ↔ 2HHB');
    expect(text).toContain('job u1');
    expect(text).toContain('no structure');
  });
});
