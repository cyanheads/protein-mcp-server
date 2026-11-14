/**
 * @fileoverview Tests for protein_compare_structures: pair generation
 * (reference:first vs. all_pairs), repeated-structure de-duplication and the
 * pair-key uniqueness invariant it protects, the computing/ticket outcome with
 * enrichment, the computing notice's resume recipe replayed with only the
 * arguments it names, and format() rendering of both failure detail and job tickets.
 * Alignment mocked, except for the call-budget cases, which run the real
 * alignment service over a fake upstream on fake timers.
 * @module tests/tools/compare-structures.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import {
  createFetchMock,
  createMockContext,
  type FetchMockHarness,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const comparePair = vi.fn();
const resumePair = vi.fn();
vi.mock('@/services/alignment/alignment-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/alignment/alignment-service.js')>()),
  getAlignmentService: () => ({ comparePair, resumePair }),
}));

import { getServerConfig } from '@/config/server-config.js';
import { compareStructures } from '@/mcp-server/tools/definitions/compare-structures.tool.js';
import { AlignmentService } from '@/services/alignment/alignment-service.js';

const ctx = () => createMockContext({ errors: compareStructures.errors });

/** A `runToolContract` failure — the envelope that carries the declared recovery fill. */
type ContractError = {
  isError?: boolean;
  structuredContent: {
    error: {
      code: number;
      message: string;
      data: { reason: string; recovery?: { hint: string } };
    };
  };
};

const three = [{ pdb_id: '4HHB' }, { pdb_id: '2HHB' }, { pdb_id: '1A3N' }];
/** The real, default configured cap (2–25, default 10) the handler slices to. */
const CAP = getServerConfig().maxCompareStructures;

beforeEach(() => vi.clearAllMocks());

describe('protein_compare_structures', () => {
  it('keeps optional scores on the original resumed orientation and renders mixed rows (#72)', async () => {
    resumePair.mockResolvedValue({
      status: 'complete',
      uuid: 'old',
      job: { method: 'fatcat-flexible', structures: [{ entryId: '4HHB' }, { entryId: '2HHB' }] },
      scores: {
        similarityScore: 52.17,
        sequenceSimilarity: 0.27,
        modeledResidues: [141, 46],
        coverage: [18, 57],
      },
    });
    comparePair.mockResolvedValue({ status: 'computing', uuid: 'pending' });
    const result = await runToolContract(compareStructures, {
      structures: [{ pdb_id: '2HHB' }, { pdb_id: '4HHB' }, { pdb_id: '1CRN' }],
      method: 'fatcat-flexible',
      resume: [{ a: '4HHB', b: '2HHB', uuid: 'old' }],
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      pairs: [
        {
          a: '4HHB',
          b: '2HHB',
          similarityScore: 52.17,
          sequenceSimilarity: 0.27,
          modeledResidues: [141, 46],
          coverage: [18, 57],
        },
        { status: 'computing' },
      ],
    });
    const text = result.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    expect(text).toContain('| Similarity score | Sequence similarity (0–1) |');
    expect(text).toContain(
      '| 4HHB ↔ 2HHB | complete | — | — | — | 141 / 46 | 18 / 57 | 52.17 | 0.27 |',
    );
    expect(text).toContain('| 2HHB ↔ 1CRN | computing | — | — | — | — | — | — | — |');
  });

  it.each([{ similarityScore: 0 }, { sequenceSimilarity: 0 }, {}])(
    'shows optional score columns independently by presence: %j (#72)',
    async (scores) => {
      comparePair
        .mockResolvedValueOnce({ status: 'complete', uuid: 'u', scores })
        .mockResolvedValueOnce({ status: 'failed', error: 'unavailable' });
      const result = await runToolContract(compareStructures, { structures: three });
      expect(result.structuredContent).toMatchObject({
        pairs: [{ ...scores }, { status: 'failed' }],
      });
      const text = result.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      expect(text.includes(' Similarity score |')).toBe('similarityScore' in scores);
      expect(text.includes(' Sequence similarity (0–1) |')).toBe('sequenceSimilarity' in scores);
      if (Object.keys(scores).length) expect(text).toContain('| 0 |');
    },
  );
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
    const result = (await runToolContract(compareStructures, {
      structures: [{ pdb_id: '4HHB' }, { pdb_id: '2HHB' }],
      reference: 'first',
      resume: [{ a: '9XXX', b: '8YYY', uuid: 'u' }],
    })) as ContractError;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({
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

  it('escapes the repeated labels it echoes in the notice', async () => {
    comparePair.mockResolvedValue({ status: 'complete', uuid: 'u', scores: {} });
    const c = ctx();
    await compareStructures.handler(
      compareStructures.input.parse({
        structures: [
          { pdb_id: '4hh*', chain: 'A_' },
          { pdb_id: '2HHB' },
          { pdb_id: '4HH*', chain: 'A_' },
        ],
      }),
      c,
    );
    expect(String(getEnrichment(c).notice)).toContain('Compared 4HH\\*.A\\_ once:');
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
    const result = (await runToolContract(compareStructures, {
      structures: [{ pdb_id: '4HHB' }, { pdb_id: '4hhb' }],
    })) as ContractError;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({
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

describe('protein_compare_structures batch cap names what it ignored (#93)', () => {
  /** Run `fn` with the configured structure cap set to `cap`, restoring it after. */
  async function withCap<T>(cap: number, fn: () => T): Promise<Awaited<T>> {
    const cfg = getServerConfig();
    const configured = cfg.maxCompareStructures;
    cfg.maxCompareStructures = cap;
    try {
      return await fn();
    } finally {
      cfg.maxCompareStructures = configured;
    }
  }

  type CapResult = {
    structuredContent: {
      pairs: Array<{ a: string; b: string }>;
      ignored?: Array<{ pdb_id: string; chain?: string }>;
      notice?: string;
    };
    content: Array<{ type: string; text: string }>;
  };

  const ACCEPTANCE = [
    { pdb_id: '1CRN' },
    { pdb_id: '1crn' },
    { pdb_id: '4HHB', chain: 'A' },
    { pdb_id: '1UBQ' },
  ];

  beforeEach(() =>
    comparePair.mockResolvedValue({ status: 'complete', uuid: 'u', scores: { tmScore: 0.5 } }),
  );

  it('drops repeats, caps, and returns the remainder in ignored with the repeat notice unchanged', async () => {
    const c = ctx();
    const out = await withCap(2, () =>
      compareStructures.handler(
        compareStructures.input.parse({ structures: ACCEPTANCE, reference: 'first' }),
        c,
      ),
    );

    expect(out.pairs.map((p) => `${p.a}↔${p.b}`)).toEqual(['1CRN↔4HHB.A']);
    expect(getEnrichment(c).ignored).toEqual([{ pdb_id: '1UBQ' }]);
    const notice = String(getEnrichment(c).notice);
    expect(notice).toContain(
      'Compared 1CRN once: a structure repeated in structures[] adds a self-alignment and a mirrored pair, not a new comparison.',
    );
    expect(notice).toContain(
      'Capped at 2 structures; 1 ignored and not compared — re-call with the structures in ignored alongside the ones to compare them against.',
    );
  });

  it('keeps the chain on a dropped structure that named one, and trims entry IDs before de-duplicating', async () => {
    const c = ctx();
    const out = await withCap(2, () =>
      compareStructures.handler(
        compareStructures.input.parse({
          structures: [
            { pdb_id: '1CRN' },
            { pdb_id: ' 1CRN ' },
            { pdb_id: '4HHB', chain: 'A' },
            { pdb_id: '1UBQ', chain: 'B' },
            { pdb_id: '2HHB' },
          ],
        }),
        c,
      ),
    );

    expect(out.pairs.map((p) => `${p.a}↔${p.b}`)).toEqual(['1CRN↔4HHB.A']);
    expect(getEnrichment(c).ignored).toEqual([{ pdb_id: '1UBQ', chain: 'B' }, { pdb_id: '2HHB' }]);
    expect(String(getEnrichment(c).notice)).toContain('Compared 1CRN once');
  });

  it('emits no ignored key on either surface for an in-cap call', async () => {
    const result = (await runToolContract(compareStructures, {
      structures: three,
      reference: 'first',
    })) as CapResult;

    expect(result.structuredContent.pairs).toHaveLength(2);
    expect(result.structuredContent).not.toHaveProperty('ignored');
    expect(result.content.map((b) => b.text).join('\n')).not.toContain('ignored');
  });

  it('carries the same ignored entries on both surfaces', async () => {
    const result = (await withCap(2, () =>
      runToolContract(compareStructures, { structures: ACCEPTANCE, reference: 'first' }),
    )) as CapResult;

    expect(result.structuredContent.ignored).toEqual([{ pdb_id: '1UBQ' }]);
    const text = result.content.map((b) => b.text).join('\n');
    expect(text).toContain('**ignored:** `[{"pdb_id":"1UBQ"}]`');
  });

  it('aligns each ignored structure against the original reference when passed back after it', async () => {
    const first = ctx();
    await withCap(2, () =>
      compareStructures.handler(
        compareStructures.input.parse({ structures: ACCEPTANCE, reference: 'first' }),
        first,
      ),
    );
    const ignored = getEnrichment(first).ignored as Array<{ pdb_id: string; chain?: string }>;

    comparePair.mockClear();
    const second = ctx();
    const out = await withCap(2, () =>
      compareStructures.handler(
        compareStructures.input.parse({
          structures: [ACCEPTANCE[0], ...ignored],
          reference: 'first',
        }),
        second,
      ),
    );
    expect(out.pairs.map((p) => `${p.a}↔${p.b}`)).toEqual(['1CRN↔1UBQ']);
    expect(comparePair).toHaveBeenCalledTimes(1);
    expect(getEnrichment(second)).not.toHaveProperty('ignored');
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

describe('protein_compare_structures resume keeps the job orientation (#62)', () => {
  /**
   * The live 4HHB.A → 1CRN.A tm-align job: 4HHB.A models 141 residues at 19%
   * coverage, 1CRN.A models 46 at 59%. TM-score is normalized by the first
   * structure's length, so it is directional too (0.17 here, 0.40 reversed).
   */
  const JOB = {
    status: 'complete' as const,
    uuid: 'job-1',
    scores: {
      tmScore: 0.17,
      rmsd: 3.18,
      sequenceIdentity: 0.03,
      alignedResidues: 27,
      modeledResidues: [141, 46] as [number, number],
      coverage: [19, 59] as [number, number],
    },
    job: {
      method: 'tm-align',
      structures: [
        { entryId: '4HHB', asymId: 'A' },
        { entryId: '1CRN', asymId: 'A' },
      ] as [{ entryId: string; asymId?: string }, { entryId: string; asymId?: string }],
    },
  };
  const forward = [
    { pdb_id: '4HHB', chain: 'A' },
    { pdb_id: '1CRN', chain: 'A' },
  ];
  const reversed = [...forward].reverse();
  const ticket = { a: '4HHB.A', b: '1CRN.A', uuid: 'job-1' };

  it('labels a resumed row in the order its job was submitted, not the current structures[] order', async () => {
    resumePair.mockResolvedValue(JOB);
    const out = await compareStructures.handler(
      compareStructures.input.parse({ structures: reversed, resume: [ticket] }),
      ctx(),
    );

    expect(comparePair).not.toHaveBeenCalled();
    expect(out.pairs).toEqual([
      {
        a: '4HHB.A',
        b: '1CRN.A',
        status: 'complete',
        uuid: 'job-1',
        tmScore: 0.17,
        rmsd: 3.18,
        alignedResidues: 27,
        modeledResidues: [141, 46],
        coverage: [19, 59],
      },
    ]);
  });

  it('attaches 1CRN.A to its own 46 residues and 59% coverage on both surfaces', async () => {
    resumePair.mockResolvedValue(JOB);
    const result = (await runToolContract(compareStructures, {
      structures: reversed,
      resume: [{ a: '1CRN.A', b: '4HHB.A', uuid: 'job-1' }], // ticket copied reversed too
    })) as {
      structuredContent: {
        pairs: Array<{ a: string; b: string; modeledResidues: number[]; coverage: number[] }>;
      };
      content: Array<{ type: string; text: string }>;
    };

    const [row] = result.structuredContent.pairs;
    if (!row) throw new Error('expected one pair');
    const side = (lbl: string) => (row.a === lbl ? 0 : 1);
    expect(row.modeledResidues[side('1CRN.A')]).toBe(46);
    expect(row.coverage[side('1CRN.A')]).toBe(59);
    expect(row.modeledResidues[side('4HHB.A')]).toBe(141);
    expect(row.coverage[side('4HHB.A')]).toBe(19);

    const text = result.content[0]?.text ?? '';
    expect(text).toContain(
      '| 4HHB.A ↔ 1CRN.A | complete | 0.170 | 3.18 | 27 | 141 / 46 | 19 / 59 |',
    );
    expect(text).not.toContain('1CRN.A ↔ 4HHB.A');
  });

  it('keeps the current order when the resumed job was submitted in that order', async () => {
    resumePair.mockResolvedValue(JOB);
    const out = await compareStructures.handler(
      compareStructures.input.parse({ structures: forward, resume: [ticket] }),
      ctx(),
    );

    expect(out.pairs[0]).toMatchObject({
      a: '4HHB.A',
      b: '1CRN.A',
      modeledResidues: [141, 46],
      coverage: [19, 59],
    });
  });

  it('remaps chainless structures by entry ID, case-insensitively', async () => {
    resumePair.mockResolvedValue({
      ...JOB,
      job: { method: 'tm-align', structures: [{ entryId: '4HHB' }, { entryId: '1CRN' }] },
    });
    const out = await compareStructures.handler(
      compareStructures.input.parse({
        structures: [{ pdb_id: '1crn' }, { pdb_id: '4hhb' }],
        resume: [{ a: '1crn', b: '4hhb', uuid: 'job-1' }],
      }),
      ctx(),
    );

    expect(out.pairs[0]).toMatchObject({ a: '4HHB', b: '1CRN', modeledResidues: [141, 46] });
  });

  it('remaps only the resumed row; freshly submitted rows keep their build order', async () => {
    resumePair.mockResolvedValue(JOB);
    comparePair.mockResolvedValue({ status: 'complete', uuid: 'fresh', scores: {} });
    const out = await compareStructures.handler(
      compareStructures.input.parse({
        structures: [...reversed, { pdb_id: '2HHB', chain: 'A' }],
        reference: 'all_pairs', // 1CRN.A↔4HHB.A, 1CRN.A↔2HHB.A, 4HHB.A↔2HHB.A
        resume: [ticket],
      }),
      ctx(),
    );

    expect(out.pairs.map((p) => `${p.a}-${p.b}`)).toEqual([
      '4HHB.A-1CRN.A',
      '1CRN.A-2HHB.A',
      '4HHB.A-2HHB.A',
    ]);
    expect(comparePair).toHaveBeenCalledTimes(2);
  });

  it('falls back to the current order when the job carries no echoed pair', async () => {
    resumePair.mockResolvedValue({ ...JOB, job: undefined });
    const out = await compareStructures.handler(
      compareStructures.input.parse({ structures: reversed, resume: [ticket] }),
      ctx(),
    );

    expect(out.pairs[0]).toMatchObject({ a: '1CRN.A', b: '4HHB.A', status: 'complete' });
  });

  it('rejects a resumed job that ran a different method than this call', async () => {
    resumePair.mockResolvedValue(JOB);
    const result = (await runToolContract(compareStructures, {
      structures: reversed,
      method: 'fatcat-rigid',
      resume: [ticket],
    })) as ContractError;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({
      message: expect.stringContaining('tm-align'),
      data: {
        reason: 'resume_method_mismatch',
        recovery: { hint: expect.stringContaining('method') },
      },
    });
  });

  it('rejects a resume ticket whose job aligned a different pair', async () => {
    resumePair.mockResolvedValue({
      ...JOB,
      job: {
        method: 'tm-align',
        structures: [
          { entryId: '2HHB', asymId: 'A' },
          { entryId: '1MBN', asymId: 'A' },
        ],
      },
    });
    const result = (await runToolContract(compareStructures, {
      structures: forward,
      resume: [ticket],
    })) as ContractError;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({
      message: expect.stringContaining('2HHB.A'),
      data: {
        reason: 'resume_job_mismatch',
        recovery: { hint: expect.stringContaining('uuid') },
      },
    });
  });

  it('does not check the method of a resumed job still computing', async () => {
    resumePair.mockResolvedValue({ status: 'computing', uuid: 'job-1' });
    const out = await compareStructures.handler(
      compareStructures.input.parse({
        structures: reversed,
        method: 'fatcat-rigid',
        resume: [ticket],
      }),
      ctx(),
    );

    expect(out.pairs[0]).toMatchObject({ status: 'computing', uuid: 'job-1' });
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

/** The text blocks of a tool result, joined. */
const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

describe('protein_compare_structures failed pairs keep a submitted job UUID (#101)', () => {
  it('carries the uuid of a failed pair whose job was submitted on both surfaces, and says how to resume it', async () => {
    comparePair
      .mockResolvedValueOnce({ status: 'failed', uuid: 'job-7', error: 'poll failed' })
      .mockResolvedValueOnce({ status: 'failed', error: 'submit failed' });
    const result = await runToolContract(compareStructures, { structures: three });
    const { pairs } = result.structuredContent as { pairs: Array<Record<string, unknown>> };
    expect(pairs).toEqual([
      { a: '4HHB', b: '2HHB', status: 'failed', uuid: 'job-7', error: 'poll failed' },
      { a: '4HHB', b: '1A3N', status: 'failed', error: 'submit failed' },
    ]);
    const text = textOf(result);
    expect(text).toContain('- 4HHB ↔ 2HHB: job job-7');
    expect(text).toContain('each failed pair that carries a uuid');
    expect(text).toContain('a failed pair without a uuid has no job to resume');
  });

  it('describes timeout_s as bounded by the 50 s call budget, with stopped pairs returning computing', () => {
    const js = z.toJSONSchema(compareStructures.input) as unknown as {
      properties: { timeout_s: { description?: string; maximum?: number } };
    };
    expect(js.properties.timeout_s.maximum).toBe(120);
    expect(js.properties.timeout_s.description).toContain('50 s');
    expect(js.properties.timeout_s.description).toContain('computing');
  });
});

describe('protein_compare_structures resume recipe in the computing notice', () => {
  it('resumes every pair when a client sends exactly the arguments the notice names', async () => {
    // A non-default reference and method, so a replay that drops either one fails.
    const first = { structures: three, reference: 'all_pairs', method: 'fatcat-rigid' } as const;
    comparePair.mockImplementation(async (a: { entryId: string }, b: { entryId: string }) => ({
      status: 'computing',
      uuid: `job-${a.entryId}-${b.entryId}`,
    }));
    const computing = await runToolContract(compareStructures, first);
    const { notice, pairs } = computing.structuredContent as {
      notice: string;
      pairs: Array<{ a: string; b: string; uuid: string }>;
    };

    // The literal client: every input argument the notice names — copied from
    // this call, resume entries from its pairs — and nothing else.
    const namedIn = (text: string) =>
      Object.keys(compareStructures.input.shape).filter((key) =>
        new RegExp(`\\b${key}\\b`).test(text),
      );
    const named = namedIn(notice);
    expect(namedIn(textOf(computing))).toEqual(named);
    const replay: Record<string, unknown> = Object.fromEntries(
      named.map((key) => [
        key,
        key === 'resume'
          ? pairs.map(({ a, b, uuid }) => ({ a, b, uuid }))
          : first[key as keyof typeof first],
      ]),
    );
    resumePair.mockImplementation(async (uuid: string) => ({
      status: 'complete',
      uuid,
      scores: { tmScore: 0.9 },
      job: { method: 'fatcat-rigid' },
    }));
    // Untyped, as a client sends it: runToolContract parses it against the schema,
    // which rejects a replay that leaves out a required argument.
    const resumed = await runToolContract(
      compareStructures,
      replay as z.input<typeof compareStructures.input>,
    );

    expect(resumed.isError).not.toBe(true);
    expect(resumed.structuredContent).toMatchObject({
      reference: 'all_pairs',
      method: 'fatcat-rigid',
      pairs: pairs.map(({ a, b, uuid }) => ({ a, b, uuid, status: 'complete', tmScore: 0.9 })),
    });
    expect(textOf(resumed)).toContain('| 2HHB ↔ 1A3N | complete | 0.900 |');
    // The replay polled the first call's jobs and submitted none of its own.
    expect(resumePair.mock.calls.map(([uuid]) => uuid)).toEqual(pairs.map((p) => p.uuid));
    expect(comparePair).toHaveBeenCalledTimes(pairs.length);
  });
});

describe('protein_compare_structures settles inside the 50 s call budget (#101)', () => {
  const ORIGIN = 'https://alignment.test';
  type Responder = (req: Request) => Promise<Response> | Response;
  type Output = Awaited<ReturnType<typeof compareStructures.handler>>;
  /** The second structure of every submit that went out, and the poll count. */
  const submitted: string[] = [];
  let polls = 0;
  let http: FetchMockHarness | undefined;

  const at = (path: string) => (req: Request) => {
    const url = new URL(req.url);
    return url.origin === ORIGIN && url.pathname === path;
  };
  /** An upstream that never answers: settles only when the request's signal aborts. */
  const hang = (req: Request) =>
    new Promise<Response>((_, reject) =>
      req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true }),
    );
  /** The submitted query's second structure, which names the pair under reference "first". */
  const partner = (req: Request): string =>
    JSON.parse(new URL(req.url).searchParams.get('query') ?? '{}').context.structures[1].entry_id;
  const serve = (submit: Responder, results: Responder) => {
    // A real fetch sends nothing once its signal has aborted.
    http = createFetchMock([
      {
        method: 'POST',
        match: at('/api/v1/structures/submit'),
        respond: (req) => {
          if (req.signal.aborted) return Promise.reject(req.signal.reason);
          submitted.push(partner(req));
          return submit(req);
        },
      },
      {
        method: 'GET',
        match: at('/api/v1/structures/results'),
        respond: (req) => {
          if (req.signal.aborted) return Promise.reject(req.signal.reason);
          polls++;
          return results(req);
        },
      },
    ]);
    http.install();
  };
  const accepted: Responder = (req) => new Response(`"job-${partner(req)}"`);
  const notReady: Responder = () => new Response('', { status: 404 });

  /** Start the handler directly with a context the test holds, tracking when it settles. */
  const start = (input: unknown) => {
    const c = ctx();
    const state: { out?: Output; settled: boolean } = { settled: false };
    const done = Promise.resolve(compareStructures.handler(compareStructures.input.parse(input), c))
      .then((out) => {
        state.out = out;
      })
      .finally(() => {
        state.settled = true;
      });
    return { c, state, done };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    submitted.length = 0;
    polls = 0;
    const real = new AlignmentService(
      {} as never,
      {} as never,
      {
        rcsbAlignmentBaseUrl: ORIGIN,
      } as never,
    );
    comparePair.mockImplementation(real.comparePair.bind(real));
    resumePair.mockImplementation(real.resumePair.bind(real));
  });
  afterEach(() => {
    http?.restore();
    http = undefined;
    comparePair.mockReset();
    resumePair.mockReset();
    vi.useRealTimers();
  });

  it('fails a pair whose submit never answers at its 30 s attempt timeout, inside the budget, sending it once', async () => {
    serve(hang, notReady);
    const { c, state, done } = start({ structures: [{ pdb_id: '4HHB' }, { pdb_id: '2HHB' }] });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled).toBe(true);
    await done;
    expect(state.out?.pairs).toEqual([
      { a: '4HHB', b: '2HHB', status: 'failed', error: expect.stringContaining('timed out') },
    ]);
    expect(String(getEnrichment(c).notice)).toContain(
      'a failed pair without a uuid has no job to resume',
    );
    expect(submitted).toEqual(['2HHB']);
    expect(polls).toBe(0);
  });

  it('returns computing with the uuid for a pair whose poll is still in flight at the budget', async () => {
    // Polls answer 404 until 40 s; the one sent at 41.25 s hangs past the budget.
    const startedAt = Date.now();
    serve(accepted, (req) => (Date.now() - startedAt < 40_000 ? notReady(req) : hang(req)));
    const { c, state, done } = start({
      structures: [{ pdb_id: '4HHB' }, { pdb_id: '2HHB' }],
      timeout_s: 120,
    });
    await vi.advanceTimersByTimeAsync(49_999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled).toBe(true);
    await done;
    expect(state.out?.pairs).toEqual([
      { a: '4HHB', b: '2HHB', status: 'computing', uuid: 'job-2HHB' },
    ]);
    expect(String(getEnrichment(c).notice)).toContain('ran past the 50 s budget');
  });

  it('keeps the uuid on a pair whose every poll attempt hangs, failing it before the budget', async () => {
    serve(accepted, hang);
    const { state, done } = start({ structures: [{ pdb_id: '4HHB' }, { pdb_id: '2HHB' }] });
    // Three 15 s poll attempts plus two backoffs (300–500 ms, then 600–1000 ms).
    await vi.advanceTimersByTimeAsync(45_899);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(47_000 - 45_899);
    expect(state.settled).toBe(true);
    await done;
    expect(state.out?.pairs).toEqual([
      {
        a: '4HHB',
        b: '2HHB',
        status: 'failed',
        uuid: 'job-2HHB',
        error: expect.stringContaining('failed after 3 attempts'),
      },
    ]);
    expect(polls).toBe(3);
  });

  it('fails a later-wave pair the budget reaches before its submit, sending no request for it', async () => {
    const { fanoutConcurrency } = getServerConfig();
    // One more pair than the fan-out runs at once, so the last pair waits for a slot.
    const structures = Array.from({ length: fanoutConcurrency + 2 }, (_, i) => ({
      pdb_id: `${i + 1}ABC`,
    }));
    serve(accepted, notReady);
    const { state, done } = start({ structures, timeout_s: 120 });
    await vi.advanceTimersByTimeAsync(49_999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled).toBe(true);
    await done;

    const pairs = state.out?.pairs ?? [];
    expect(pairs).toHaveLength(fanoutConcurrency + 1);
    const firstWave = pairs.slice(0, fanoutConcurrency);
    expect(firstWave.map((p) => p.status)).toEqual(Array(fanoutConcurrency).fill('computing'));
    expect(firstWave.map((p) => p.uuid)).toEqual(firstWave.map((p) => `job-${p.b}`));
    const last = pairs[fanoutConcurrency];
    expect(last).toEqual({
      a: '1ABC',
      b: `${fanoutConcurrency + 2}ABC`,
      status: 'failed',
      error: expect.stringContaining('without a resume entry'),
    });
    expect(submitted).toHaveLength(fanoutConcurrency);
    expect(submitted).not.toContain(last?.b);
  });

  it("rejects the handler with the caller's cancellation from a poll in flight, never rows", async () => {
    const caller = new AbortController();
    serve(accepted, (req) => {
      queueMicrotask(() => caller.abort('client went away'));
      return hang(req);
    });
    await expect(
      compareStructures.handler(
        compareStructures.input.parse({ structures: three }),
        createMockContext({ errors: compareStructures.errors, signal: caller.signal }),
      ),
    ).rejects.toBe('client went away');
  });

  it("reports the caller's cancellation as RequestCancelled on both surfaces", async () => {
    const caller = new AbortController();
    serve(accepted, (req) => {
      queueMicrotask(() => caller.abort('client went away'));
      return hang(req);
    });
    const result = (await runToolContract(
      compareStructures,
      { structures: three },
      { context: { signal: caller.signal } },
    )) as ContractError & { content: Array<{ type: string; text?: string }> };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({
      code: -32011,
      message: expect.stringContaining('client went away'),
    });
    expect(textOf(result)).toContain('client went away');
  });
});
