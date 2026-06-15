/**
 * @fileoverview Tests for protein_compare_structures: pair generation
 * (reference:first vs. all_pairs), the computing/ticket outcome with enrichment,
 * and format() rendering of both failure detail and job tickets. Alignment mocked.
 * @module tests/tools/compare-structures.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const comparePair = vi.fn();
vi.mock('@/services/alignment/alignment-service.js', () => ({
  getAlignmentService: () => ({ comparePair }),
}));

import { compareStructures } from '@/mcp-server/tools/definitions/compare-structures.tool.js';

const ctx = () => createMockContext({ errors: compareStructures.errors });
const three = [{ pdb_id: '4HHB' }, { pdb_id: '2HHB' }, { pdb_id: '1A3N' }];

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
