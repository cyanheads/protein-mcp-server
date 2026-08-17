/**
 * @fileoverview Tests for protein_compare_structures: pair generation
 * (reference:first vs. all_pairs), repeated-structure de-duplication and the
 * pair-key uniqueness invariant it protects, the computing/ticket outcome with
 * enrichment, and format() rendering of both failure detail and job tickets.
 * Alignment mocked.
 * @module tests/tools/compare-structures.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
    const blocks = compareStructures.format!({
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
    const text = (blocks[0] as { text: string }).text;

    expect(text).toContain('4HHB ↔ 2HHB');
    expect(text).toContain('job u1');
    expect(text).toContain('no structure');
  });

  it('keys resume entries on a delimited pair key, so labels that concatenate alike do not collide', async () => {
    // Labels '1AB' + 'C' and '1A' + 'BC' both concatenate to '1ABC'; only a
    // delimiter between them keeps the two pairs distinct.
    const input = compareStructures.input.parse({
      structures: [{ pdb_id: '1AB' }, { pdb_id: 'C' }],
      reference: 'first',
      resume: [{ a: '1A', b: 'BC', uuid: 'u' }],
    });
    await expect(compareStructures.handler(input, ctx())).rejects.toMatchObject({
      data: { reason: 'resume_pair_unmatched' },
    });
    expect(resumePair).not.toHaveBeenCalled();
  });
});

describe('protein_compare_structures repeated structures (#33)', () => {
  it('compares a repeated structure once, naming the repeat in the notice', async () => {
    comparePair.mockResolvedValue({ status: 'complete', uuid: 'u', scores: { tmScore: 0.9 } });
    const c = ctx();
    const out = await compareStructures.handler(
      compareStructures.input.parse({
        structures: [{ pdb_id: '4HHB' }, { pdb_id: '2HHB' }, { pdb_id: '4HHB' }],
        reference: 'all_pairs',
      }),
      c,
    );

    // Was three pairs: 4HHB↔2HHB, the self-pair 4HHB↔4HHB, and 2HHB↔4HHB.
    expect(out.pairs.map((p) => `${p.a}-${p.b}`)).toEqual(['4HHB-2HHB']);
    expect(comparePair).toHaveBeenCalledTimes(1);
    expect(getEnrichment(c)).toMatchObject({ pairsTotal: 1 });
    expect(String(getEnrichment(c).notice)).toContain('4HHB');
  });

  it('keeps the pair key unique across every generated pair', async () => {
    comparePair.mockResolvedValue({ status: 'complete', uuid: 'u', scores: {} });
    const repeats = [
      [{ pdb_id: '4HHB' }, { pdb_id: '2HHB' }, { pdb_id: '4HHB' }],
      [{ pdb_id: '4hhb' }, { pdb_id: '2HHB' }, { pdb_id: '4HHB' }, { pdb_id: '1A3N' }],
      [{ pdb_id: '4HHB', chain: 'A' }, { pdb_id: '4HHB', chain: 'a' }, { pdb_id: '2HHB' }],
    ];
    for (const structures of repeats) {
      for (const reference of ['first', 'all_pairs'] as const) {
        comparePair.mockClear();
        const out = await compareStructures.handler(
          compareStructures.input.parse({ structures, reference }),
          ctx(),
        );
        // The canonical key the resume lookup uses — order-insensitive, and
        // case-insensitive on the entry ID only (chain is label_asym_id, case-sensitive).
        const norm = (v: string) => {
          const dot = v.indexOf('.');
          return dot === -1
            ? v.toUpperCase()
            : `${v.slice(0, dot).toUpperCase()}.${v.slice(dot + 1)}`;
        };
        const keys = out.pairs.map((p) => [norm(p.a), norm(p.b)].sort().join('|'));
        expect(new Set(keys).size).toBe(out.pairs.length);
        expect(out.pairs.every((p) => norm(p.a) !== norm(p.b))).toBe(true);
      }
    }
  });

  it('treats chains A and a as distinct structures, not a repeat (#33)', async () => {
    // mmCIF label_asym_id is case-sensitive. De-duplicating on an upper-cased label
    // would collapse two genuinely different chains into one and then reject the call
    // as having no distinct pair.
    comparePair.mockResolvedValue({ status: 'complete', uuid: 'u', scores: {} });
    const c = ctx();
    const out = await compareStructures.handler(
      compareStructures.input.parse({
        structures: [
          { pdb_id: '4HHB', chain: 'A' },
          { pdb_id: '4HHB', chain: 'a' },
        ],
      }),
      c,
    );

    expect(out.pairs).toHaveLength(1);
    expect(out.pairs[0]).toMatchObject({ a: '4HHB.A', b: '4HHB.a' });
    expect(comparePair).toHaveBeenCalledTimes(1);
    expect(getEnrichment(c).notice).toBeUndefined();
  });

  it('applies a resume ticket to exactly one job when a structure repeats', async () => {
    resumePair.mockResolvedValue({ status: 'complete', uuid: 'known', scores: {} });
    comparePair.mockResolvedValue({ status: 'complete', uuid: 'fresh', scores: {} });
    const out = await compareStructures.handler(
      compareStructures.input.parse({
        structures: [{ pdb_id: '4HHB' }, { pdb_id: '2HHB' }, { pdb_id: '4HHB' }],
        reference: 'all_pairs',
        resume: [{ a: '4HHB', b: '2HHB', uuid: 'known' }],
      }),
      ctx(),
    );

    expect(out.pairs).toHaveLength(1);
    expect(resumePair).toHaveBeenCalledTimes(1);
    expect(comparePair).not.toHaveBeenCalled();
  });

  it('fails when every structure denotes the same one', async () => {
    await expect(
      compareStructures.handler(
        compareStructures.input.parse({ structures: [{ pdb_id: '4HHB' }, { pdb_id: '4hhb' }] }),
        ctx(),
      ),
    ).rejects.toMatchObject({
      data: {
        reason: 'no_distinct_pair',
        recovery: { hint: expect.stringContaining('two different structures') },
      },
    });
    expect(comparePair).not.toHaveBeenCalled();
  });

  it('drops repeats before the cap, so distinct structures are not crowded out', async () => {
    comparePair.mockResolvedValue({ status: 'complete', uuid: 'u', scores: {} });
    const distinct = Array.from({ length: CAP }, (_, i) => ({
      pdb_id: `2${String(i).padStart(3, '0')}`,
    }));
    const c = ctx();
    const out = await compareStructures.handler(
      compareStructures.input.parse({
        structures: [...distinct, ...distinct].slice(0, 25),
        reference: 'first',
      }),
      c,
    );

    expect(out.pairs).toHaveLength(CAP - 1);
    expect(String(getEnrichment(c).notice)).not.toContain('Capped at');
  });

  it('carries the de-duplicated pair set on both consumption surfaces', async () => {
    comparePair.mockResolvedValue({ status: 'complete', uuid: 'u1', scores: { tmScore: 0.87 } });
    const result = (await runToolContract(compareStructures, {
      structures: [{ pdb_id: '4HHB' }, { pdb_id: '2HHB' }, { pdb_id: '4HHB' }],
      reference: 'all_pairs',
    })) as {
      structuredContent: { pairs: Array<{ a: string; b: string }>; notice?: string };
      content: Array<{ type: string; text: string }>;
    };

    expect(result.structuredContent.pairs).toEqual([
      expect.objectContaining({ a: '4HHB', b: '2HHB' }),
    ]);
    const [formatted, ...trailer] = result.content;
    expect(formatted?.text).toContain('4HHB ↔ 2HHB');
    expect(formatted?.text).not.toContain('4HHB ↔ 4HHB');
    expect(trailer.map((b) => b.text).join('\n')).toContain('4HHB');
  });
});

describe('protein_compare_structures per-structure length and coverage', () => {
  it('carries modeledResidues and coverage from the alignment scores into the pair row', async () => {
    comparePair.mockResolvedValue({
      status: 'complete',
      uuid: 'u',
      scores: {
        tmScore: 0.71,
        rmsd: 2.4,
        alignedResidues: 141,
        modeledResidues: [141, 153],
        coverage: [100, 92],
      },
    });
    const input = compareStructures.input.parse({
      structures: [
        { pdb_id: '2HHB', chain: 'A' },
        { pdb_id: '1MBN', chain: 'A' },
      ],
    });
    const out = await compareStructures.handler(input, ctx());

    expect(out.pairs[0]).toMatchObject({
      a: '2HHB.A',
      b: '1MBN.A',
      status: 'complete',
      modeledResidues: [141, 153],
      coverage: [100, 92],
    });
    expect(out).toEqual(expect.schemaMatching(compareStructures.output));
  });

  it('omits both fields when the alignment result carries neither', async () => {
    comparePair.mockResolvedValue({ status: 'complete', uuid: 'u', scores: { tmScore: 0.9 } });
    const input = compareStructures.input.parse({
      structures: [{ pdb_id: '4HHB' }, { pdb_id: '2HHB' }],
    });
    const out = await compareStructures.handler(input, ctx());

    expect(out.pairs[0]).not.toHaveProperty('modeledResidues');
    expect(out.pairs[0]).not.toHaveProperty('coverage');
  });

  it('renders modeled residues and coverage in format() output', () => {
    const blocks = compareStructures.format!({
      method: 'tm-align',
      reference: 'first',
      pairs: [
        {
          a: '2HHB.A',
          b: '1MBN.A',
          status: 'complete',
          tmScore: 0.71,
          rmsd: 2.4,
          alignedResidues: 141,
          modeledResidues: [141, 153],
          coverage: [100, 92],
          uuid: 'u1',
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;

    expect(text).toContain('141 / 153');
    expect(text).toContain('100 / 92');
  });

  it('documents the own-length coverage denominator on the coverage output field', () => {
    const js = z.toJSONSchema(compareStructures.output) as unknown as {
      properties: {
        pairs: {
          items: {
            properties: {
              coverage: { description?: string };
              modeledResidues: { description?: string };
            };
          };
        };
      };
    };
    const props = js.properties.pairs.items.properties;
    // The denominator is each structure's OWN modeled length, not the shorter of
    // the pair — the whole point of surfacing the two side by side.
    expect(props.coverage.description ?? '').toMatch(/own/i);
    expect(props.coverage.description ?? '').toMatch(/0–100|0-100/);
    expect(props.coverage.description ?? '').toMatch(/\[a, b\]/);
    expect(props.modeledResidues.description ?? '').toMatch(/\[a, b\]/);
  });
});

describe('protein_compare_structures TM-score length-normalization caveat', () => {
  it('documents the length-normalization caveat in the tool description', () => {
    expect(compareStructures.description).toMatch(/length-normalized/i);
    expect(compareStructures.description).toMatch(/terminal/i);
  });

  it('documents the caveat on the tmScore output field, pointing at rmsd and alignedResidues', () => {
    const js = z.toJSONSchema(compareStructures.output) as unknown as {
      properties: { pairs: { items: { properties: { tmScore: { description?: string } } } } };
    };
    const desc = js.properties.pairs.items.properties.tmScore.description ?? '';
    expect(desc).toMatch(/length-normalized/i);
    expect(desc).toMatch(/terminal/i);
    expect(desc).toMatch(/rmsd/i);
    expect(desc).toMatch(/alignedResidues/i);
  });
});
