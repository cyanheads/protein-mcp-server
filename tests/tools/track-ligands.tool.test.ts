/**
 * @fileoverview Tests for protein_track_ligands: the three modes (find_ligand,
 * structures_with_ligand, binding_site), the missing-param guards (InvalidParams),
 * find_ligand's block-ranked paging (first, second, last, and past-end pages, and
 * a nextStart walk that reads each candidate once) and its not_found branch, the
 * binding_site misses (no current entry, computed model, held components, BIRD
 * polymer-chain ligands) on both surfaces, binding_site's trimmed pdb_id and its
 * lookup under the 50 s call budget, structures_with_ligand's empty-result
 * set + notice (one chemical-component lookup telling an unknown ID from a real
 * component, degraded on failure, cancellation rethrown), its per-row title,
 * method, and host entities on both surfaces, the totalCount / resolvedCompId
 * enrichment, find_ligand's candidate-pool disclosure, comp_id upper-casing, and
 * format() rendering of ligands, structure lists, and binding sites (polymer
 * residues, amino acids or nucleotides) in both residue-numbering namespaces.
 * RCSB service mocked.
 * @module tests/tools/track-ligands.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const findChemComps = vi.fn();
const getChemComp = vi.fn();
const countEntriesWithLigand = vi.fn();
const searchByLigand = vi.fn();
const getEntries = vi.fn();
const getBindingSites = vi.fn();
vi.mock('@/services/rcsb/rcsb-service.js', () => ({
  getRcsbService: () => ({
    findChemComps,
    getChemComp,
    countEntriesWithLigand,
    searchByLigand,
    getEntries,
    getBindingSites,
  }),
}));

import { trackLigands } from '@/mcp-server/tools/definitions/track-ligands.tool.js';

const ctx = () => createMockContext({ errors: trackLigands.errors });

/** A `runToolContract` failure — the envelope that carries the declared recovery fill. */
type ContractError = {
  isError?: boolean;
  structuredContent: {
    error: { code: number; data: { reason: string; recovery?: { hint: string } } };
  };
};

beforeEach(() => vi.clearAllMocks());

describe('protein_track_ligands — find_ligand paging', () => {
  /** 60 candidate IDs in RCSB's name-match order, which is stable across calls and pages. */
  const NAME_ORDER = Array.from({ length: 60 }, (_, i) => `N${i}`);
  /**
   * Deposition counts that reverse name order inside each 25-candidate block and
   * put the most-deposited components in the second block, past the first
   * page's reach, as the live "iron" match set does (FE 2734, SF4 2615, and FE2
   * 1279 entries sit at name-match positions 26–50).
   */
  const countOf = (id: string) => {
    const i = Number(id.slice(1));
    return i < 25 ? i + 1 : i < 50 ? 1000 + i : 10 + i;
  };
  /** Every candidate in block-ranked order: the full walk's expected sequence. */
  const RANKED = [
    ...NAME_ORDER.slice(0, 25).toReversed(),
    ...NAME_ORDER.slice(25, 50).toReversed(),
    ...NAME_ORDER.slice(50).toReversed(),
  ];

  type Page = {
    structuredContent: {
      ligands: Array<{ compId: string }>;
      totalCount: number;
      candidatesConsidered?: number;
      start?: number;
      nextStart?: number;
      notice?: string;
    };
    content: Array<{ text: string }>;
  };
  const page = async (start: number, limit?: number) =>
    (await runToolContract(trackLigands, {
      mode: 'find_ligand',
      query: 'iron',
      start,
      ...(limit ? { limit } : {}),
    })) as Page;

  beforeEach(() => {
    findChemComps.mockImplementation(async (_q: string, p: { start: number; limit: number }) => ({
      ids: NAME_ORDER.slice(p.start, p.start + p.limit),
      total: NAME_ORDER.length,
    }));
    getChemComp.mockImplementation(async (id: string) => ({ compId: id }));
    countEntriesWithLigand.mockImplementation(async (id: string) => countOf(id));
  });

  it('ranks the first block on the first page and points at the next, on both surfaces', async () => {
    const first = await page(0);
    expect(findChemComps).toHaveBeenCalledExactlyOnceWith(
      'iron',
      { start: 0, limit: 25 },
      expect.anything(),
    );
    expect(first.structuredContent.ligands.map((l) => l.compId)).toEqual(RANKED.slice(0, 25));
    expect(first.structuredContent).toMatchObject({
      totalCount: 60,
      candidatesConsidered: 25,
      start: 0,
      nextStart: 25,
    });
    const notice =
      '25 of 60 components matching "iron" were ranked by deposition frequency (name matches 1–25, in blocks of 25); the ranking covers only those 25, so a more-deposited match can sit in another block. Re-call with start 25 for the next page, or narrow the query (a more specific name, a synonym, or a formula) to rank the full match set.';
    expect(first.structuredContent.notice).toBe(notice);
    const text = first.content.map((b) => b.text).join('\n');
    expect(text).toContain(notice);
    expect(text).toContain('**nextStart:** 25');
  });

  it('reaches the second block, where the most-deposited matches sit, on the second page', async () => {
    const second = await page(25);
    expect(findChemComps).toHaveBeenCalledExactlyOnceWith(
      'iron',
      { start: 25, limit: 25 },
      expect.anything(),
    );
    const ids = second.structuredContent.ligands.map((l) => l.compId);
    expect(ids).toEqual(RANKED.slice(25, 50));
    expect(ids[0]).toBe('N49');
    // Nothing the first page returned comes back.
    expect(ids.filter((id) => RANKED.slice(0, 25).includes(id))).toEqual([]);
    expect(second.structuredContent).toMatchObject({
      candidatesConsidered: 25,
      start: 25,
      nextStart: 50,
    });
    expect(second.structuredContent.notice).toContain('(name matches 26–50, in blocks of 25)');
  });

  it('ends on the last page with no nextStart and no next-page pointer', async () => {
    const last = await page(50);
    expect(findChemComps).toHaveBeenCalledExactlyOnceWith(
      'iron',
      { start: 50, limit: 25 },
      expect.anything(),
    );
    expect(last.structuredContent.ligands.map((l) => l.compId)).toEqual(RANKED.slice(50));
    expect(last.structuredContent).toMatchObject({ candidatesConsidered: 10, start: 50 });
    expect(last.structuredContent).not.toHaveProperty('nextStart');
    const notice = String(last.structuredContent.notice);
    expect(notice).toContain('10 of 60 components matching "iron" were ranked');
    expect(notice).toContain('(name matches 51–60, in blocks of 25)');
    expect(notice).not.toMatch(/Re-call with start/);
    expect(notice).toMatch(/Narrow the query/);
  });

  it.each([60, 75, 1000])(
    'answers start %i past the end with a notice and no ranking requests, on both surfaces',
    async (start) => {
      const past = await page(start);
      expect(findChemComps).toHaveBeenCalledTimes(1);
      expect(getChemComp).not.toHaveBeenCalled();
      expect(countEntriesWithLigand).not.toHaveBeenCalled();
      expect(past.structuredContent.ligands).toEqual([]);
      expect(past.structuredContent).toMatchObject({ totalCount: 60, start });
      expect(past.structuredContent).not.toHaveProperty('nextStart');
      const notice = `start ${start} is past the end of the 60 components matching "iron". Re-call with a lower start to read a populated page.`;
      expect(past.structuredContent.notice).toBe(notice);
      expect(past.content.map((b) => b.text).join('\n')).toContain(notice);
    },
  );

  it('walks every resolvable candidate exactly once by nextStart, across block boundaries and an unresolvable ID', async () => {
    // N30 no longer resolves to chemical-component metadata: it ranks after its
    // block's resolvable candidates and is left out of the page it falls on.
    getChemComp.mockImplementation(async (id: string) => (id === 'N30' ? null : { compId: id }));
    const seen: string[] = [];
    const fetched: unknown[] = [];
    let start: number | undefined = 0;
    while (start !== undefined) {
      findChemComps.mockClear();
      const p = await page(start, 10);
      fetched.push(findChemComps.mock.calls[0]?.[1]);
      seen.push(...p.structuredContent.ligands.map((l) => l.compId));
      start = p.structuredContent.nextStart;
    }
    expect(seen).toEqual(RANKED.filter((id) => id !== 'N30'));
    // A page straddling two blocks reads both in one search; the others read one.
    expect(fetched).toEqual([
      { start: 0, limit: 25 },
      { start: 0, limit: 25 },
      { start: 0, limit: 50 },
      { start: 25, limit: 25 },
      { start: 25, limit: 25 },
      { start: 50, limit: 25 },
    ]);
  });

  it('runs the name search and the per-candidate fan-out under one call budget (fake timers)', async () => {
    vi.useFakeTimers();
    try {
      // A stalled count lookup settles only when the signal it was handed aborts.
      countEntriesWithLigand.mockImplementation(
        (_id: string, c: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            c.signal.addEventListener('abort', () => reject(c.signal.reason), { once: true });
          }),
      );
      const pending = trackLigands.handler(
        trackLigands.input.parse({ mode: 'find_ligand', query: 'iron', start: 25 }),
        ctx(),
      );
      const settled = expect(pending).rejects.toThrow(
        'Upstream requests for this call ran past the 50 s budget.',
      );
      await vi.advanceTimersByTimeAsync(50_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws not_found for a query that matches nothing at any start', async () => {
    findChemComps.mockResolvedValue({ ids: [], total: 0 });
    for (const start of [0, 25]) {
      await expect(
        trackLigands.handler(
          trackLigands.input.parse({ mode: 'find_ligand', query: 'zzz', start }),
          ctx(),
        ),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound, data: { reason: 'not_found' } });
    }
  });
});

describe('protein_track_ligands — find_ligand', () => {
  /** Live "ATP" name/synonym match set: seven components, all inside the default pool. */
  const ATP_IDS = ['PRT', 'JSQ', 'AGS', 'ATP', 'DDS', 'APC', 'A1L15'];
  const ATP_COUNTS: Record<string, number> = {
    ATP: 2400,
    AGS: 480,
    APC: 420,
    PRT: 3,
    JSQ: 1,
    DDS: 2,
    A1L15: 1,
  };

  type FindLigandContract = {
    structuredContent: {
      ligands: Array<{ compId: string }>;
      totalCount?: number;
      candidatesConsidered?: number;
      notice?: string;
    };
    content: Array<{ text: string }>;
  };

  it('reports the upstream total and the considered pool with no notice when the pool covers every match (ATP, #67)', async () => {
    findChemComps.mockResolvedValue({ ids: ATP_IDS, total: 7 });
    getChemComp.mockImplementation(async (id: string) => ({ compId: id }));
    countEntriesWithLigand.mockImplementation(async (id: string) => ATP_COUNTS[id] ?? 0);

    const result = (await runToolContract(trackLigands, {
      mode: 'find_ligand',
      query: 'ATP',
      limit: 1,
    })) as FindLigandContract;

    // limit 1 still returns the most-deposited match; the totals say six more exist.
    expect(result.structuredContent.ligands.map((l) => l.compId)).toEqual(['ATP']);
    expect(result.structuredContent.totalCount).toBe(7);
    expect(result.structuredContent.candidatesConsidered).toBe(7);
    expect(result.structuredContent).not.toHaveProperty('notice');
    const rendered = result.content.map((block) => block.text).join('\n');
    expect(rendered).toContain('**7 total**');
    expect(rendered).toContain('**candidatesConsidered:** 7');
  });

  it('discloses a truncated candidate pool on both surfaces and keeps the deposition re-rank (iron, #67)', async () => {
    // "iron" matches 119 components upstream; the default pool pulls 25 of them.
    const pool = Array.from({ length: 25 }, (_, i) => `C${i}`);
    findChemComps.mockResolvedValue({ ids: pool, total: 119 });
    getChemComp.mockImplementation(async (id: string) => ({ compId: id }));
    countEntriesWithLigand.mockImplementation(async (id: string) => (id === 'C24' ? 900 : 1));

    const result = (await runToolContract(trackLigands, {
      mode: 'find_ligand',
      query: 'iron',
      limit: 2,
    })) as FindLigandContract;

    expect(findChemComps).toHaveBeenCalledWith('iron', { start: 0, limit: 25 }, expect.anything());
    // The last name-ranked candidate is the most deposited, so it still leads (#17).
    expect(result.structuredContent.ligands[0]?.compId).toBe('C24');
    expect(result.structuredContent.totalCount).toBe(119);
    expect(result.structuredContent.candidatesConsidered).toBe(25);
    const notice = String(result.structuredContent.notice);
    expect(notice).toContain('25 of 119');
    expect(notice).toMatch(/ranking covers only/i);
    expect(notice).toMatch(/narrow the query/i);
    const rendered = result.content.map((block) => block.text).join('\n');
    expect(rendered).toContain('25 of 119');
    expect(rendered).toContain('**119 total**');
  });

  it.each([
    [25, 25, false],
    [25, 26, true],
  ] as const)(
    'emits the truncation notice only when the %i-candidate pool is smaller than a total of %i (#67)',
    async (poolSize, total, truncated) => {
      const pool = Array.from({ length: poolSize }, (_, i) => `C${i}`);
      findChemComps.mockResolvedValue({ ids: pool, total });
      getChemComp.mockImplementation(async (id: string) => ({ compId: id }));
      countEntriesWithLigand.mockResolvedValue(1);
      const c = ctx();
      await trackLigands.handler(
        trackLigands.input.parse({ mode: 'find_ligand', query: 'kinase inhibitor' }),
        c,
      );
      expect(getEnrichment(c)).toMatchObject({ totalCount: total, candidatesConsidered: poolSize });
      if (truncated) expect(String(getEnrichment(c).notice)).toContain(`${poolSize} of ${total}`);
      else expect(getEnrichment(c)).not.toHaveProperty('notice');
    },
  );

  it('widens the candidate pool to the maximum limit and reports it against the total (#67)', async () => {
    const pool = Array.from({ length: 100 }, (_, i) => `C${i}`);
    findChemComps.mockResolvedValue({ ids: pool, total: 12412 });
    getChemComp.mockImplementation(async (id: string) => ({ compId: id }));
    countEntriesWithLigand.mockResolvedValue(1);
    const c = ctx();
    const out = await trackLigands.handler(
      trackLigands.input.parse({ mode: 'find_ligand', query: 'acid', limit: 100 }),
      c,
    );
    expect(findChemComps).toHaveBeenCalledWith('acid', { start: 0, limit: 100 }, expect.anything());
    expect(out.ligands).toHaveLength(100);
    expect(getEnrichment(c)).toMatchObject({ totalCount: 12412, candidatesConsidered: 100 });
    expect(String(getEnrichment(c).notice)).toContain('100 of 12412');
  });

  it('escapes the query it echoes in the candidate-pool notice', async () => {
    const pool = Array.from({ length: 25 }, (_, i) => `C${i}`);
    findChemComps.mockResolvedValue({ ids: pool, total: 119 });
    getChemComp.mockImplementation(async (id: string) => ({ compId: id }));
    countEntriesWithLigand.mockResolvedValue(1);
    const c = ctx();
    await trackLigands.handler(
      trackLigands.input.parse({ mode: 'find_ligand', query: '*iron* [x](y)' }),
      c,
    );
    expect(String(getEnrichment(c).notice)).toContain(
      '25 of 119 components matching "\\*iron\\* \\[x\\](y)" were ranked',
    );
    // The search itself receives the query as written.
    expect(findChemComps).toHaveBeenCalledWith(
      '*iron* [x](y)',
      { start: 0, limit: 25 },
      expect.anything(),
    );
  });

  it('resolves a name to chem-comp metadata with its deposition count', async () => {
    findChemComps.mockResolvedValue({ ids: ['HEM'], total: 1 });
    getChemComp.mockResolvedValue({
      compId: 'HEM',
      name: 'PROTOPORPHYRIN IX CONTAINING FE',
      formula: 'C34 H32 Fe N4 O4',
      formulaWeight: 616.5,
    });
    countEntriesWithLigand.mockResolvedValue(6475);
    const out = await trackLigands.handler(
      trackLigands.input.parse({ mode: 'find_ligand', query: 'heme' }),
      ctx(),
    );
    expect(out.mode).toBe('find_ligand');
    expect(out.ligands).toEqual([
      {
        compId: 'HEM',
        name: 'PROTOPORPHYRIN IX CONTAINING FE',
        formula: 'C34 H32 Fe N4 O4',
        formulaWeight: 616.5,
        depositionCount: 6475,
      },
    ]);
  });

  it('re-ranks candidates by deposition frequency: the most-deposited component leads, not the top name match (#17)', async () => {
    // RCSB name-string ranking returns HEC first, HEM last; HEM is far more
    // deposited (the canonical heme), so the re-rank must surface it first.
    findChemComps.mockResolvedValue({ ids: ['HEC', 'HEA', 'HEM'], total: 3 });
    getChemComp.mockImplementation(async (id: string) => ({ compId: id }));
    countEntriesWithLigand.mockImplementation(
      async (id: string) => ({ HEM: 6475, HEC: 1218, HEA: 202 })[id] ?? 0,
    );
    const out = await trackLigands.handler(
      trackLigands.input.parse({ mode: 'find_ligand', query: 'heme' }),
      ctx(),
    );
    expect(out.ligands?.map((l) => l.compId)).toEqual(['HEM', 'HEC', 'HEA']);
    expect(out.ligands?.map((l) => l.depositionCount)).toEqual([6475, 1218, 202]);
  });

  it('over-fetches beyond the display limit so a low-name-ranked canonical still surfaces, then slices to limit (#17)', async () => {
    // RCSB name order returns HEM last; at limit 2 a limit-coupled fetch would pull
    // only the first two names and never see HEM. The pool must exceed the display
    // limit so the most-deposited canonical is fetched, re-ranked, and surfaced. The
    // mock respects the requested count, so a coupled fetch (limit 2) fails this.
    findChemComps.mockImplementation(async (_q: string, p: { start: number; limit: number }) => ({
      ids: ['AAA', 'BBB', 'CCC', 'DDD', 'HEM'].slice(p.start, p.start + p.limit),
      total: 5,
    }));
    getChemComp.mockImplementation(async (id: string) => ({ compId: id }));
    countEntriesWithLigand.mockImplementation(
      async (id: string) => ({ HEM: 6475, AAA: 5, BBB: 4, CCC: 3, DDD: 2 })[id] ?? 0,
    );
    const out = await trackLigands.handler(
      trackLigands.input.parse({ mode: 'find_ligand', query: 'heme', limit: 2 }),
      ctx(),
    );
    // Sliced to the display limit (2), most-deposited first.
    expect(out.ligands?.map((l) => l.compId)).toEqual(['HEM', 'AAA']);
  });

  it('drops nulls from the per-id metadata fan-out', async () => {
    findChemComps.mockResolvedValue({ ids: ['HEM', 'GONE'], total: 2 });
    getChemComp.mockImplementation(async (id: string) => (id === 'HEM' ? { compId: 'HEM' } : null));
    countEntriesWithLigand.mockResolvedValue(6475);
    const out = await trackLigands.handler(
      trackLigands.input.parse({ mode: 'find_ligand', query: 'heme' }),
      ctx(),
    );
    expect(out.ligands).toEqual([{ compId: 'HEM', depositionCount: 6475 }]);
  });

  it('throws missing_param (InvalidParams) when query is missing', async () => {
    await expect(
      trackLigands.handler(trackLigands.input.parse({ mode: 'find_ligand' }), ctx()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'missing_param' },
    });
  });

  it('throws not_found when nothing resolves', async () => {
    findChemComps.mockResolvedValue({ ids: [], total: 0 });
    await expect(
      trackLigands.handler(trackLigands.input.parse({ mode: 'find_ligand', query: 'zzz' }), ctx()),
    ).rejects.toMatchObject({ data: { reason: 'not_found' } });
  });

  it.each(['C29 H31 N7 O', 'C29H31N7O'])(
    'resolves the formula %s to STI on both surfaces (#50)',
    async (query) => {
      // The formula reaches the service verbatim — spacing is the upstream
      // formula terminal's concern, not this layer's.
      findChemComps.mockResolvedValue({ ids: ['STI'], total: 1 });
      getChemComp.mockResolvedValue({
        compId: 'STI',
        name: 'IMATINIB',
        formula: 'C29 H31 N7 O',
      });
      countEntriesWithLigand.mockResolvedValue(31);

      const result = (await runToolContract(trackLigands, {
        mode: 'find_ligand',
        query,
        limit: 3,
      })) as {
        structuredContent: { ligands: Array<{ compId: string; formula?: string }> };
        content: Array<{ text: string }>;
      };

      expect(findChemComps).toHaveBeenCalledWith(query, { start: 0, limit: 25 }, expect.anything());
      expect(result.structuredContent.ligands.map((l) => l.compId)).toEqual(['STI']);
      expect(result.structuredContent.ligands[0]?.formula).toBe('C29 H31 N7 O');
      const rendered = result.content.map((block) => block.text).join('\n');
      expect(rendered).toContain('### STI');
      expect(rendered).toContain('**Formula:** C29 H31 N7 O');
    },
  );

  it('routes a formula with no upstream match through the existing not_found path (#50)', async () => {
    // A mis-guessed formula shape is an empty 204 upstream, never an error, so it
    // arrives here as an empty candidate list — no new failure mode is needed.
    findChemComps.mockResolvedValue({ ids: [], total: 0 });
    await expect(
      trackLigands.handler(
        trackLigands.input.parse({ mode: 'find_ligand', query: 'C99 H99 N99 O99' }),
        ctx(),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
  });

  it('carries the declared recovery hint on the missing_param error (#10)', async () => {
    const result = (await runToolContract(trackLigands, { mode: 'find_ligand' })) as ContractError;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({
      data: {
        reason: 'missing_param',
        recovery: {
          hint: expect.stringContaining('Provide the parameter the selected mode requires'),
        },
      },
    });
  });
});

describe('protein_track_ligands — structures_with_ligand', () => {
  it('returns matching structures with resolution, records the total + resolved comp id', async () => {
    searchByLigand.mockResolvedValue({
      total: 1200,
      hits: [
        { id: '4HHB', score: 1 },
        { id: '2HHB', score: 1 },
      ],
    });
    getEntries.mockResolvedValue([
      { id: '4HHB', resolution: 1.74, organisms: [], polymerEntities: [], ligands: [] },
      { id: '2HHB', resolution: 1.9, organisms: [], polymerEntities: [], ligands: [] },
    ]);
    const c = ctx();
    const out = await trackLigands.handler(
      trackLigands.input.parse({ mode: 'structures_with_ligand', comp_id: 'hem' }),
      c,
    );
    expect(out.structures).toEqual([
      { id: '4HHB', resolution: 1.74 },
      { id: '2HHB', resolution: 1.9 },
    ]);
    // comp_id is upper-cased before the search; hit ids feed the batched metadata fetch.
    expect(searchByLigand).toHaveBeenCalledWith('HEM', { limit: 25, start: 0 }, expect.anything());
    expect(getEntries).toHaveBeenCalledWith(['4HHB', '2HHB'], expect.anything());
    expect(getEnrichment(c)).toMatchObject({ totalCount: 1200, resolvedCompId: 'HEM' });
  });

  it('sorts by resolution (best first), carries no score, and puts entries lacking resolution last (#19)', async () => {
    searchByLigand.mockResolvedValue({
      total: 3,
      hits: [
        { id: 'AAAA', score: 1 },
        { id: 'BBBB', score: 1 },
        { id: 'CCCC', score: 1 },
      ],
    });
    // getEntries returns out of input order and omits resolution for one entry.
    getEntries.mockResolvedValue([
      { id: 'BBBB', resolution: 0.8, organisms: [], polymerEntities: [], ligands: [] },
      { id: 'AAAA', resolution: 2, organisms: [], polymerEntities: [], ligands: [] },
      { id: 'CCCC', organisms: [], polymerEntities: [], ligands: [] },
    ]);
    const out = await trackLigands.handler(
      trackLigands.input.parse({ mode: 'structures_with_ligand', comp_id: 'HEM' }),
      ctx(),
    );
    // Best resolution first; the entry with no resolution sorts last.
    expect(out.structures?.map((s) => s.id)).toEqual(['BBBB', 'AAAA', 'CCCC']);
    expect(out.structures?.[0]).toEqual({ id: 'BBBB', resolution: 0.8 });
    expect(out.structures?.[2]).toEqual({ id: 'CCCC' });
    // The meaningless containment score is gone entirely.
    for (const s of out.structures ?? []) expect(s).not.toHaveProperty('score');
  });

  it('throws missing_param (InvalidParams) when comp_id is missing', async () => {
    await expect(
      trackLigands.handler(trackLigands.input.parse({ mode: 'structures_with_ligand' }), ctx()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'missing_param' },
    });
  });

  it('returns an empty structure set (with a notice) when no structures contain the ligand', async () => {
    searchByLigand.mockResolvedValue({ total: 0, hits: [] });
    getChemComp.mockResolvedValue(null);
    const c = ctx();
    const out = await trackLigands.handler(
      trackLigands.input.parse({ mode: 'structures_with_ligand', comp_id: 'ZZZ' }),
      c,
    );
    expect(out.structures).toEqual([]);
    expect(getEnrichment(c)).toMatchObject({ totalCount: 0, resolvedCompId: 'ZZZ' });
    expect(String(getEnrichment(c).notice)).toMatch(/^ZZZ is not a chemical component ID: /);
  });

  /** The zero-hit notice text for a component ID the CCD does not hold. */
  const notAComponent = (id: string) =>
    `${id} is not a chemical component ID: the Chemical Component Dictionary has no entry for it, so no PDB entry contains it. Resolve a ligand name or formula to its ID via mode find_ligand.`;

  it('tells an ID the CCD does not hold from a real component with no bound copy, on both surfaces (ZZZZZ vs 000)', async () => {
    type Empty = {
      structuredContent: { structures: unknown[]; totalCount: number; notice?: string };
      content: Array<{ text: string }>;
    };
    searchByLigand.mockResolvedValue({ total: 0, hits: [] });

    // Live: /chemcomp/ZZZZZ answers 404 (getChemComp → null).
    getChemComp.mockResolvedValue(null);
    const none = (await runToolContract(trackLigands, {
      mode: 'structures_with_ligand',
      comp_id: 'zzzzz',
    })) as Empty;
    expect(getChemComp).toHaveBeenCalledExactlyOnceWith('ZZZZZ', expect.anything());
    expect(none.structuredContent).toMatchObject({ structures: [], totalCount: 0 });
    expect(none.structuredContent.notice).toBe(notAComponent('ZZZZZ'));
    expect(none.content.map((b) => b.text).join('\n')).toContain(notAComponent('ZZZZZ'));

    // Live: /chemcomp/000 answers 200, "methyl hydrogen carbonate".
    getChemComp.mockClear();
    getChemComp.mockResolvedValue({ compId: '000', name: 'methyl hydrogen carbonate' });
    const real = (await runToolContract(trackLigands, {
      mode: 'structures_with_ligand',
      comp_id: '000',
    })) as Empty;
    const notice =
      'No PDB entry holds a bound (non-polymer) copy of 000 (methyl hydrogen carbonate), a chemical component the Chemical Component Dictionary defines; a copy found only inside a polymer chain or a branched glycan is not counted.';
    expect(getChemComp).toHaveBeenCalledExactlyOnceWith('000', expect.anything());
    expect(real.structuredContent.notice).toBe(notice);
    expect(real.content.map((b) => b.text).join('\n')).toContain(notice);
  });

  it('names a real component with no recorded name by its ID alone, and escapes the name it echoes', async () => {
    searchByLigand.mockResolvedValue({ total: 0, hits: [] });
    getChemComp.mockResolvedValue({ compId: 'X1' });
    const bare = ctx();
    await trackLigands.handler(
      trackLigands.input.parse({ mode: 'structures_with_ligand', comp_id: 'X1' }),
      bare,
    );
    expect(String(getEnrichment(bare).notice)).toMatch(
      /^No PDB entry holds a bound \(non-polymer\) copy of X1, a chemical component/,
    );

    getChemComp.mockResolvedValue({ compId: 'X2', name: '2-*oxo*_acid' });
    const named = ctx();
    await trackLigands.handler(
      trackLigands.input.parse({ mode: 'structures_with_ligand', comp_id: 'X2' }),
      named,
    );
    expect(String(getEnrichment(named).notice)).toContain('copy of X2 (2-\\*oxo\\*\\_acid),');
  });

  it('makes the component lookup on the zero-hit path only: never on a populated or past-end page', async () => {
    searchByLigand.mockResolvedValue({ total: 1, hits: [{ id: '4HHB', score: 1 }] });
    getEntries.mockResolvedValue([]);
    await trackLigands.handler(
      trackLigands.input.parse({ mode: 'structures_with_ligand', comp_id: 'HEM' }),
      ctx(),
    );
    searchByLigand.mockResolvedValue({ total: 29, hits: [] });
    await trackLigands.handler(
      trackLigands.input.parse({ mode: 'structures_with_ligand', comp_id: 'STI', start: 29 }),
      ctx(),
    );
    expect(getChemComp).not.toHaveBeenCalled();
  });

  const UNCHECKED =
    'No PDB entry holds a bound (non-polymer) copy of HEM. The Chemical Component Dictionary lookup that tells an unknown ID from a component with no bound copy failed; verify the ID via mode find_ligand.';

  it('discloses a failed component lookup instead of guessing which zero-hit case it is, on both surfaces', async () => {
    searchByLigand.mockResolvedValue({ total: 0, hits: [] });
    getChemComp.mockRejectedValue(new Error('RCSB Data API unavailable'));
    const result = (await runToolContract(trackLigands, {
      mode: 'structures_with_ligand',
      comp_id: 'HEM',
    })) as {
      isError?: boolean;
      structuredContent: { structures: unknown[]; notice?: string };
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ structures: [], notice: UNCHECKED });
    expect(result.content.map((b) => b.text).join('\n')).toContain(UNCHECKED);
  });

  it('discloses a component lookup the call budget stopped as unchecked (fake timers)', async () => {
    vi.useFakeTimers();
    try {
      searchByLigand.mockResolvedValue({ total: 0, hits: [] });
      // Hang until the call's signal aborts, as a stalled upstream would.
      getChemComp.mockImplementation(
        (_id: string, c: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            c.signal.addEventListener('abort', () => reject(c.signal.reason), { once: true });
          }),
      );
      const c = ctx();
      const pending = trackLigands.handler(
        trackLigands.input.parse({ mode: 'structures_with_ligand', comp_id: 'HEM' }),
        c,
      );
      await vi.advanceTimersByTimeAsync(50_000);
      await expect(pending).resolves.toEqual({ mode: 'structures_with_ligand', structures: [] });
      expect(getEnrichment(c).notice).toBe(UNCHECKED);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rethrows a cancellation that arrives during the component lookup', async () => {
    searchByLigand.mockResolvedValue({ total: 0, hits: [] });
    const run = () => {
      const controller = new AbortController();
      getChemComp.mockImplementation(async (_id: string, c: { signal: AbortSignal }) => {
        // Abort once the lookup under test is in flight.
        controller.abort(new DOMException('client cancelled the call', 'AbortError'));
        throw c.signal.reason;
      });
      return controller;
    };

    const direct = run();
    await expect(
      trackLigands.handler(
        trackLigands.input.parse({ mode: 'structures_with_ligand', comp_id: 'HEM' }),
        createMockContext({ errors: trackLigands.errors, signal: direct.signal }),
      ),
    ).rejects.toThrow('client cancelled the call');

    const viaContract = run();
    const result = (await runToolContract(
      trackLigands,
      { mode: 'structures_with_ligand', comp_id: 'HEM' },
      { context: { signal: viaContract.signal } },
    )) as ContractError & { content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(result.content.map((b) => b.text).join('\n')).toContain('client cancelled the call');
  });

  it('names the offset on a past-end ligand page instead of claiming no entries, on both surfaces (#66)', async () => {
    searchByLigand.mockResolvedValue({ total: 29, hits: [] });

    const result = (await runToolContract(trackLigands, {
      mode: 'structures_with_ligand',
      comp_id: 'STI',
      start: 29,
      limit: 1,
    })) as {
      structuredContent: {
        structures: unknown[];
        totalCount: number;
        nextStart?: number;
        notice?: string;
      };
      content: Array<{ text: string }>;
    };

    expect(result.structuredContent.structures).toEqual([]);
    expect(result.structuredContent.totalCount).toBe(29);
    expect(result.structuredContent).not.toHaveProperty('nextStart');
    const notice = String(result.structuredContent.notice);
    expect(notice).toContain('start 29 is past the end of the 29 PDB entries containing STI');
    expect(notice).not.toMatch(/No PDB entries contain/);
    const rendered = result.content.map((block) => block.text).join('\n');
    expect(rendered).toContain('start 29 is past the end of the 29 PDB entries containing STI');
    expect(rendered).not.toMatch(/No PDB entries contain/);
  });

  it('keeps the zero-match notice when no entry contains the ligand at any offset (#66)', async () => {
    searchByLigand.mockResolvedValue({ total: 0, hits: [] });
    getChemComp.mockResolvedValue(null);
    const c = ctx();
    await trackLigands.handler(
      trackLigands.input.parse({ mode: 'structures_with_ligand', comp_id: 'ZZZ', start: 10 }),
      c,
    );
    expect(String(getEnrichment(c).notice)).toBe(notAComponent('ZZZ'));
  });

  it('exposes ligand-search offsets and nextStart on both consumption surfaces', async () => {
    searchByLigand.mockResolvedValue({
      total: 30,
      hits: [
        { id: '4HHB', score: 1 },
        { id: '2HHB', score: 1 },
      ],
    });
    getEntries.mockResolvedValue([]);

    const result = (await runToolContract(trackLigands, {
      mode: 'structures_with_ligand',
      comp_id: 'HEM',
      start: 25,
      limit: 2,
    })) as {
      structuredContent: { totalCount: number; start: number; nextStart?: number };
      content: Array<{ text: string }>;
    };

    expect(searchByLigand).toHaveBeenCalledWith('HEM', { start: 25, limit: 2 }, expect.anything());
    expect(result.structuredContent).toMatchObject({ totalCount: 30, start: 25, nextStart: 27 });
    const rendered = result.content.map((block) => block.text).join('\n');
    expect(rendered).toContain('**start:** 25');
    expect(rendered).toContain('**nextStart:** 27');
  });

  it('omits nextStart on final, past-end, and zero-match ligand pages', async () => {
    for (const [start, total, hits] of [
      [29, 30, [{ id: '4HHB', score: 1 }]],
      [40, 30, []],
      [0, 0, []],
    ] as const) {
      searchByLigand.mockResolvedValue({ total, hits });
      getEntries.mockResolvedValue([]);
      const c = ctx();
      await trackLigands.handler(
        trackLigands.input.parse({
          mode: 'structures_with_ligand',
          comp_id: 'HEM',
          start,
          limit: 5,
        }),
        c,
      );
      expect(getEnrichment(c)).toMatchObject({ totalCount: total, start });
      expect(getEnrichment(c)).not.toHaveProperty('nextStart');
    }
  });

  /** getEntries' normalized 3K5V and 6KTN (live STI hits), trimmed; entities in entity-number order. */
  const META_3K5V = {
    id: '3K5V',
    title: 'Structure of Abl kinase in complex with imatinib and GNF-2',
    methods: ['X-RAY DIFFRACTION'],
    resolution: 1.74,
    organisms: ['Mus musculus'],
    polymerEntities: [
      {
        entityId: '3K5V_1',
        description: 'Tyrosine-protein kinase ABL1',
        organisms: ['Mus musculus'],
        authAsymIds: ['A', 'B'],
        labelAsymIds: ['A', 'B'],
        sequenceLength: 293,
      },
    ],
    ligands: [
      { compId: 'CL', authAsymIds: ['A'] },
      { compId: 'STI', name: 'IMATINIB', authAsymIds: ['A', 'B'] },
      { compId: 'STJ', authAsymIds: ['A', 'B'] },
    ],
  };
  const META_6KTN = {
    id: '6KTN',
    title: 'Human PPARgamma ligand-binding domain R288A mutant in complex with imatinib',
    methods: ['X-RAY DIFFRACTION'],
    resolution: 2.752,
    organisms: ['Homo sapiens'],
    polymerEntities: [
      {
        entityId: '6KTN_1',
        description: 'Peroxisome proliferator-activated receptor gamma',
        organisms: ['Homo sapiens'],
        authAsymIds: ['A'],
      },
      {
        entityId: '6KTN_2',
        description: '16-mer peptide from Nuclear receptor coactivator 1',
        organisms: ['Homo sapiens'],
        authAsymIds: ['B'],
      },
    ],
    ligands: [{ compId: 'STI', authAsymIds: ['A'] }],
  };

  type StructuresResult = {
    structuredContent: {
      structures: Array<{
        id: string;
        resolution?: number;
        title?: string;
        method?: string;
        hostEntities?: Array<{ entityId: string; description?: string; organisms?: string[] }>;
      }>;
    };
    content: Array<{ text: string }>;
  };

  it("names each row's title, method, and host entities on both surfaces from the one getEntries call (#92)", async () => {
    searchByLigand.mockResolvedValue({
      total: 29,
      hits: [
        { id: '3K5V', score: 1 },
        { id: '6KTN', score: 1 },
      ],
    });
    getEntries.mockResolvedValue([META_6KTN, META_3K5V]);

    const result = (await runToolContract(trackLigands, {
      mode: 'structures_with_ligand',
      comp_id: 'sti',
      limit: 2,
    })) as StructuresResult;

    expect(result.structuredContent.structures).toEqual([
      {
        id: '3K5V',
        resolution: 1.74,
        title: 'Structure of Abl kinase in complex with imatinib and GNF-2',
        method: 'X-RAY DIFFRACTION',
        hostEntities: [
          {
            entityId: '3K5V_1',
            description: 'Tyrosine-protein kinase ABL1',
            organisms: ['Mus musculus'],
          },
        ],
      },
      {
        id: '6KTN',
        resolution: 2.752,
        title: 'Human PPARgamma ligand-binding domain R288A mutant in complex with imatinib',
        method: 'X-RAY DIFFRACTION',
        // Chain A carries STI: the receptor, not the coactivator peptide on chain B.
        hostEntities: [
          {
            entityId: '6KTN_1',
            description: 'Peroxisome proliferator-activated receptor gamma',
            organisms: ['Homo sapiens'],
          },
        ],
      },
    ]);
    expect(searchByLigand).toHaveBeenCalledTimes(1);
    expect(getEntries).toHaveBeenCalledTimes(1);

    const text = result.content.map((block) => block.text).join('\n');
    expect(text).toContain(
      '- 3K5V — 1.74 Å — X-RAY DIFFRACTION — Structure of Abl kinase in complex with imatinib and GNF-2',
    );
    expect(text).toContain('  - host entity 3K5V_1: Tyrosine-protein kinase ABL1 (Mus musculus)');
    expect(text).toContain(
      '  - host entity 6KTN_1: Peroxisome proliferator-activated receptor gamma (Homo sapiens)',
    );
    expect(text).not.toContain('6KTN_2');
  });

  it('lists only the entities whose chains carry the ligand in a many-entity complex (9PGI, #92)', async () => {
    // 9PGI holds 92 polymer entities; its one ATP sits on chain AX alone. MG
    // spans chain AX too, which must not pull its other chains' entities in.
    searchByLigand.mockResolvedValue({ total: 1, hits: [{ id: '9PGI', score: 1 }] });
    getEntries.mockResolvedValue([
      {
        id: '9PGI',
        organisms: ['Homo sapiens'],
        polymerEntities: [
          {
            entityId: '9PGI_74',
            description: '28S ribosomal protein S28, mitochondrial',
            authAsymIds: ['AW'],
          },
          {
            entityId: '9PGI_89',
            description: '28S ribosomal protein S29, mitochondrial',
            organisms: ['Homo sapiens'],
            authAsymIds: ['AX'],
          },
          { entityId: '9PGI_90', description: 'unrelated', authAsymIds: ['AY', 'A'] },
        ],
        ligands: [
          { compId: 'MG', authAsymIds: ['A', 'AX'] },
          { compId: 'ATP', authAsymIds: ['AX'] },
        ],
      },
    ]);
    const out = await trackLigands.handler(
      trackLigands.input.parse({ mode: 'structures_with_ligand', comp_id: 'ATP' }),
      ctx(),
    );
    expect(out.structures?.[0]?.hostEntities).toEqual([
      {
        entityId: '9PGI_89',
        description: '28S ribosomal protein S29, mitochondrial',
        organisms: ['Homo sapiens'],
      },
    ]);
  });

  it('lists every entity whose chains carry the ligand, in entity order, on both surfaces (4HHB HEM, #92)', async () => {
    // 4HHB's HEM sits on all four globin chains, so both entities host it; the
    // phosphate's chains (B, D) must not narrow or reorder that list.
    searchByLigand.mockResolvedValue({ total: 1, hits: [{ id: '4HHB', score: 1 }] });
    getEntries.mockResolvedValue([
      {
        id: '4HHB',
        resolution: 1.74,
        organisms: ['Homo sapiens'],
        polymerEntities: [
          {
            entityId: '4HHB_1',
            description: 'Hemoglobin subunit alpha',
            organisms: ['Homo sapiens'],
            authAsymIds: ['A', 'C'],
          },
          {
            entityId: '4HHB_2',
            description: 'Hemoglobin subunit beta',
            organisms: ['Homo sapiens'],
            authAsymIds: ['B', 'D'],
          },
        ],
        ligands: [
          { compId: 'PO4', authAsymIds: ['B', 'D'] },
          { compId: 'HEM', authAsymIds: ['A', 'B', 'C', 'D'] },
        ],
      },
    ]);

    const result = (await runToolContract(trackLigands, {
      mode: 'structures_with_ligand',
      comp_id: 'HEM',
    })) as StructuresResult;

    expect(result.structuredContent.structures[0]?.hostEntities).toEqual([
      { entityId: '4HHB_1', description: 'Hemoglobin subunit alpha', organisms: ['Homo sapiens'] },
      { entityId: '4HHB_2', description: 'Hemoglobin subunit beta', organisms: ['Homo sapiens'] },
    ]);
    const text = result.content.map((block) => block.text).join('\n');
    expect(text).toContain(
      '  - host entity 4HHB_1: Hemoglobin subunit alpha (Homo sapiens)\n  - host entity 4HHB_2: Hemoglobin subunit beta (Homo sapiens)',
    );
  });

  it('reads a comp_id through surrounding whitespace for the search, host entities, and notice', async () => {
    searchByLigand.mockResolvedValue({ total: 1, hits: [{ id: '4HHB', score: 1 }] });
    getEntries.mockResolvedValue([
      {
        id: '4HHB',
        organisms: [],
        polymerEntities: [{ entityId: '4HHB_1', authAsymIds: ['A'] }],
        ligands: [{ compId: 'HEM', authAsymIds: ['A'] }],
      },
    ]);
    const c = ctx();
    const out = await trackLigands.handler(
      trackLigands.input.parse({ mode: 'structures_with_ligand', comp_id: ' hem\t' }),
      c,
    );
    expect(searchByLigand).toHaveBeenCalledWith('HEM', { limit: 25, start: 0 }, expect.anything());
    expect(getEnrichment(c)).toMatchObject({ resolvedCompId: 'HEM' });
    expect(out.structures?.[0]?.hostEntities).toEqual([{ entityId: '4HHB_1' }]);

    searchByLigand.mockResolvedValue({ total: 0, hits: [] });
    getChemComp.mockResolvedValue(null);
    const empty = ctx();
    await trackLigands.handler(
      trackLigands.input.parse({ mode: 'structures_with_ligand', comp_id: ' STI ' }),
      empty,
    );
    expect(getChemComp).toHaveBeenCalledWith('STI', expect.anything());
    expect(getEnrichment(empty).notice).toBe(notAComponent('STI'));
  });

  it.each([
    [0, notAComponent('A\\*B\\_')],
    [
      3,
      'start 5 is past the end of the 3 PDB entries containing A\\*B\\_. Re-call with a lower start to read a populated page.',
    ],
  ])('escapes the comp_id it echoes in an empty-page notice (total %i)', async (total, notice) => {
    searchByLigand.mockResolvedValue({ total, hits: [] });
    getChemComp.mockResolvedValue(null);
    const c = ctx();
    await trackLigands.handler(
      trackLigands.input.parse({ mode: 'structures_with_ligand', comp_id: 'a*b_', start: 5 }),
      c,
    );
    expect(getEnrichment(c).notice).toBe(notice);
    // structuredContent keeps the ID as the search used it.
    expect(getEnrichment(c)).toMatchObject({ resolvedCompId: 'A*B_' });
  });

  it('omits hostEntities when no polymer chain carries the ligand, and title/method a row lacks, on both surfaces (#92)', async () => {
    searchByLigand.mockResolvedValue({
      total: 3,
      hits: [
        { id: '6E0O', score: 1 },
        { id: '1ABC', score: 1 },
        { id: '2ABC', score: 1 },
      ],
    });
    getEntries.mockResolvedValue([
      // No ATP non-polymer entity at all: the search hit came from elsewhere.
      {
        id: '6E0O',
        title: 'Some complex',
        methods: ['ELECTRON MICROSCOPY'],
        resolution: 3.1,
        organisms: [],
        polymerEntities: [{ entityId: '6E0O_1', authAsymIds: ['A'] }],
        ligands: [],
      },
      // ATP present, but on a chain no polymer entity reports; no title or method.
      {
        id: '1ABC',
        organisms: [],
        polymerEntities: [{ entityId: '1ABC_1', authAsymIds: ['A'] }],
        ligands: [{ compId: 'ATP', authAsymIds: ['Z'] }],
      },
      // ATP with no reported author chains.
      {
        id: '2ABC',
        organisms: [],
        polymerEntities: [{ entityId: '2ABC_1', authAsymIds: ['A'] }],
        ligands: [{ compId: 'ATP' }],
      },
    ]);

    const result = (await runToolContract(trackLigands, {
      mode: 'structures_with_ligand',
      comp_id: 'ATP',
    })) as StructuresResult;

    expect(result.structuredContent.structures).toEqual([
      { id: '6E0O', resolution: 3.1, title: 'Some complex', method: 'ELECTRON MICROSCOPY' },
      { id: '1ABC' },
      { id: '2ABC' },
    ]);
    const text = result.content.map((block) => block.text).join('\n');
    expect(text).toContain('- 6E0O — 3.10 Å — ELECTRON MICROSCOPY — Some complex');
    expect(text).not.toContain('host entity');
  });

  it('renders a host entity that lacks a description or organisms without inventing them (#92)', () => {
    const blocks = trackLigands.format!({
      mode: 'structures_with_ligand',
      structures: [
        {
          id: '7ABC',
          hostEntities: [
            { entityId: '7ABC_1' },
            { entityId: '7ABC_2', organisms: ['Homo sapiens', 'Tequatrovirus T4'] },
          ],
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('- 7ABC\n  - host entity 7ABC_1\n');
    expect(text).toContain('  - host entity 7ABC_2 (Homo sapiens, Tequatrovirus T4)');
  });

  it('rejects negative or fractional ligand-search offsets', () => {
    expect(
      trackLigands.input.safeParse({
        mode: 'structures_with_ligand',
        comp_id: 'HEM',
        start: -1,
      }).success,
    ).toBe(false);
    expect(
      trackLigands.input.safeParse({
        mode: 'structures_with_ligand',
        comp_id: 'HEM',
        start: 1.5,
      }).success,
    ).toBe(false);
  });
});

describe('protein_track_ligands — binding_site', () => {
  /** A `getBindingSites` hit. */
  const found = (sites: unknown[]) => ({ kind: 'found', sites });

  it('returns binding-site residues for a structure', async () => {
    getBindingSites.mockResolvedValue(
      found([
        {
          ligandCompId: 'HEM',
          ligandAsymId: 'A',
          residues: [{ residueCompId: 'HIS', asymId: 'A', seqId: 87, distance: 2.1 }],
        },
      ]),
    );
    const out = await trackLigands.handler(
      trackLigands.input.parse({ mode: 'binding_site', pdb_id: '4HHB', comp_id: 'hem' }),
      ctx(),
    );
    expect(out.bindingSites?.[0]).toMatchObject({ ligandCompId: 'HEM', ligandAsymId: 'A' });
    expect(getBindingSites).toHaveBeenCalledWith('4HHB', 'HEM', expect.anything());

    const c = ctx();
    await trackLigands.handler(
      trackLigands.input.parse({ mode: 'binding_site', pdb_id: '4HHB', comp_id: ' hem\n' }),
      c,
    );
    expect(getBindingSites).toHaveBeenLastCalledWith('4HHB', 'HEM', expect.anything());
    expect(getEnrichment(c)).toMatchObject({ resolvedCompId: 'HEM' });
  });

  it('returns label and author numbering for pocket residues on both surfaces (1IEP STI, #69)', async () => {
    getBindingSites.mockResolvedValue(
      found([
        {
          ligandCompId: 'STI',
          ligandAsymId: 'A',
          ligandAuthSeqId: 201,
          residues: [
            {
              residueCompId: 'ILE',
              asymId: 'A',
              seqId: 138,
              authAsymId: 'A',
              authSeqId: 360,
              distance: 2.668,
            },
            {
              residueCompId: 'THR',
              asymId: 'A',
              seqId: 93,
              authAsymId: 'A',
              authSeqId: 315,
              distance: 2.883,
            },
          ],
        },
      ]),
    );

    const result = (await runToolContract(trackLigands, {
      mode: 'binding_site',
      pdb_id: '1IEP',
      comp_id: 'STI',
      limit: 1,
    })) as {
      structuredContent: {
        bindingSites: Array<{
          ligandAuthSeqId?: number;
          residues: Array<{ seqId?: number; authSeqId?: number; authAsymId?: string }>;
        }>;
      };
      content: Array<{ text: string }>;
    };

    const [site] = result.structuredContent.bindingSites;
    expect(site?.ligandAuthSeqId).toBe(201);
    expect(site?.residues.map((r) => [r.seqId, r.authSeqId])).toEqual([
      [138, 360],
      [93, 315],
    ]);
    const rendered = result.content.map((block) => block.text).join('\n');
    expect(rendered).toContain('### Ligand STI (author chain A, residue 201)');
    expect(rendered).toContain('- ILE138 (chain A; author ILE360, chain A) — 2.67 Å');
    expect(rendered).toContain('- THR93 (chain A; author THR315, chain A) — 2.88 Å');
    expect(rendered).toMatch(/label_seq_id/);
    expect(rendered).toMatch(/auth_seq_id/);
  });

  it('names nucleotide contacts as polymer residues, not protein residues, on both surfaces (1D30 DAP)', async () => {
    // Live 1D30: DAP intercalated in a DNA dodecamer contacts DA, DC, and DT.
    getBindingSites.mockResolvedValue(
      found([
        {
          ligandCompId: 'DAP',
          ligandAsymId: 'A',
          ligandAuthSeqId: 25,
          residues: [
            { residueCompId: 'DA', asymId: 'A', seqId: 6, authAsymId: 'A', authSeqId: 6 },
            { residueCompId: 'DT', asymId: 'B', seqId: 8, authAsymId: 'B', authSeqId: 20 },
          ],
        },
      ]),
    );
    const result = (await runToolContract(trackLigands, {
      mode: 'binding_site',
      pdb_id: '1D30',
    })) as {
      structuredContent: { bindingSites: Array<{ residues: Array<{ residueCompId: string }> }> };
      content: Array<{ text: string }>;
    };
    expect(result.structuredContent.bindingSites[0]?.residues.map((r) => r.residueCompId)).toEqual([
      'DA',
      'DT',
    ]);
    const text = result.content.map((block) => block.text).join('\n');
    expect(text).toContain('polymer residues (amino acids or nucleotides)');
    expect(text).toContain('- DA6 (chain A; author DA6, chain A)');

    // The structured surface's schema and the tool description say the same.
    const schemaText = JSON.stringify(z.toJSONSchema(trackLigands.output));
    for (const text_ of [trackLigands.description, schemaText]) {
      expect(text_).not.toMatch(/protein residues/i);
      expect(text_).toMatch(/nucleotide/);
    }
  });

  it('renders a divergent author chain beside its label chain (6QNR, #69)', () => {
    const blocks = trackLigands.format!({
      mode: 'binding_site',
      bindingSites: [
        {
          ligandCompId: 'MG',
          ligandAsymId: '13',
          ligandAuthSeqId: 1687,
          residues: [
            {
              residueCompId: 'VAL',
              asymId: 'I',
              seqId: 109,
              authAsymId: '8E',
              authSeqId: 109,
              distance: 4.124,
            },
          ],
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('### Ligand MG (author chain 13, residue 1687)');
    expect(text).toContain('- VAL109 (chain I; author VAL109, chain 8E) — 4.12 Å');
  });

  it('throws missing_param (InvalidParams) when pdb_id is missing', async () => {
    await expect(
      trackLigands.handler(
        trackLigands.input.parse({ mode: 'binding_site', comp_id: 'HEM' }),
        ctx(),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'missing_param' },
    });
  });

  it('trims pdb_id before the lookup and in every message, on both surfaces', async () => {
    getBindingSites.mockResolvedValue({ kind: 'entry_not_found' });
    const padded = (await runToolContract(trackLigands, {
      mode: 'binding_site',
      pdb_id: ' 4hhb\n',
      comp_id: 'HEM',
    })) as ContractError & {
      content: Array<{ text: string }>;
      structuredContent: { error: { message: string } };
    };
    expect(getBindingSites).toHaveBeenCalledWith('4hhb', 'HEM', expect.anything());
    const message =
      'RCSB has no current PDB entry 4HHB (obsoleted, unreleased, or never assigned).';
    expect(padded.structuredContent.error.message).toBe(message);
    expect(padded.content.map((b) => b.text).join('\n')).toContain(`Error: ${message}`);

    getBindingSites.mockResolvedValue(
      found([{ ligandCompId: 'HEM', residues: [{ residueCompId: 'HIS', asymId: 'A' }] }]),
    );
    const page = (await runToolContract(trackLigands, {
      mode: 'binding_site',
      pdb_id: '\t4hhb ',
      comp_id: 'HEM',
      start: 3,
    })) as { structuredContent: { notice: string }; content: Array<{ text: string }> };
    const notice =
      'start 3 is past the end of the 1 binding-site instances in 4HHB for HEM. Re-call with a lower start to read a populated page.';
    expect(page.structuredContent.notice).toBe(notice);
    expect(page.content.map((b) => b.text).join('\n')).toContain(notice);
  });

  it('reads a whitespace-only pdb_id as missing (missing_param)', async () => {
    const result = (await runToolContract(trackLigands, {
      mode: 'binding_site',
      pdb_id: '  ',
    })) as ContractError;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'missing_param' },
    });
    expect(getBindingSites).not.toHaveBeenCalled();
  });

  describe('under the call budget (fake timers)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('settles a hung lookup at the 50 s budget, not before, leaving the caller signal alone', async () => {
      let seen: AbortSignal | undefined;
      // A stalled lookup settles only when the signal it was handed aborts.
      getBindingSites.mockImplementation(
        (_id: string, _comp: string | undefined, c: { signal: AbortSignal }) => {
          seen = c.signal;
          return new Promise((_resolve, reject) => {
            c.signal.addEventListener('abort', () => reject(c.signal.reason), { once: true });
          });
        },
      );
      const caller = new AbortController();
      let settled = false;
      const pending = Promise.resolve(
        trackLigands.handler(
          trackLigands.input.parse({ mode: 'binding_site', pdb_id: '4HHB' }),
          createMockContext({ errors: trackLigands.errors, signal: caller.signal }),
        ),
      )
        .catch((err: unknown) => err)
        .finally(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(49_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(await pending).toMatchObject({
        name: 'TimeoutError',
        message: 'Upstream requests for this call ran past the 50 s budget.',
      });
      expect(seen).not.toBe(caller.signal);
      expect(caller.signal.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('rethrows a cancellation that arrives during the lookup, on both surfaces', async () => {
      const run = () => {
        const controller = new AbortController();
        const seen: AbortSignal[] = [];
        getBindingSites.mockImplementation(
          async (_id: string, _comp: string | undefined, c: { signal: AbortSignal }) => {
            seen.push(c.signal);
            // Abort once the lookup under test is in flight.
            controller.abort(new DOMException('client cancelled the call', 'AbortError'));
            throw c.signal.reason;
          },
        );
        return { controller, seen };
      };

      const direct = run();
      await expect(
        trackLigands.handler(
          trackLigands.input.parse({ mode: 'binding_site', pdb_id: '4HHB' }),
          createMockContext({ errors: trackLigands.errors, signal: direct.controller.signal }),
        ),
      ).rejects.toThrow('client cancelled the call');
      // The lookup ran on the budget's derived signal, which kept the caller's reason.
      expect(direct.seen).toHaveLength(1);
      expect(direct.seen[0]).not.toBe(direct.controller.signal);
      expect(vi.getTimerCount()).toBe(0);

      const viaContract = run();
      const result = (await runToolContract(
        trackLigands,
        { mode: 'binding_site', pdb_id: '4HHB' },
        { context: { signal: viaContract.controller.signal } },
      )) as ContractError & { content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error.code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(result.content.map((b) => b.text).join('\n')).toContain('client cancelled the call');
    });
  });

  /** A `runToolContract` binding_site miss: the envelope plus the rendered text. */
  type MissResult = ContractError & {
    content: Array<{ text: string }>;
    structuredContent: {
      error: {
        message: string;
        data: {
          heldComponents?: string[];
          polymerLigands?: Array<{
            entityId: string;
            prdId: string;
            authAsymIds?: string[];
            description?: string;
          }>;
        };
      };
    };
  };
  const miss = async (input: Record<string, unknown>) => {
    const result = (await runToolContract(trackLigands, {
      mode: 'binding_site',
      ...input,
    })) as MissResult;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
    // The one binding-site query is the only upstream request a miss makes.
    expect(getBindingSites).toHaveBeenCalledTimes(1);
    for (const other of [findChemComps, getChemComp, countEntriesWithLigand, searchByLigand]) {
      expect(other).not.toHaveBeenCalled();
    }
    return {
      error: result.structuredContent.error,
      hint: String(result.structuredContent.error.data.recovery?.hint),
      text: result.content.map((block) => block.text).join('\n'),
    };
  };

  it('names the components the entry holds when none is the requested one, on both surfaces (4HHB ATP, #105)', async () => {
    getBindingSites.mockResolvedValue({
      kind: 'no_contacts',
      heldComponents: ['HEM', 'PO4'],
      polymerLigands: [],
    });
    const { error, hint, text } = await miss({ pdb_id: '4hhb', comp_id: 'atp' });

    expect(getBindingSites).toHaveBeenCalledWith('4hhb', 'ATP', expect.anything());
    expect(error.message).toBe('4HHB holds bound HEM, PO4; none is ATP.');
    expect(error.data).toMatchObject({ heldComponents: ['HEM', 'PO4'], polymerLigands: [] });
    expect(hint).toBe(
      'Pass one of HEM, PO4 as comp_id, or omit comp_id to list every ligand with pocket contacts.',
    );
    expect(text).toContain('Error: 4HHB holds bound HEM, PO4; none is ATP.');
    expect(text).toContain(`Recovery: ${hint}`);
    expect(`${error.message} ${hint}`).not.toMatch(/experimental-only/);
  });

  it('names a requested component the entry holds without pocket contacts (#105)', async () => {
    getBindingSites.mockResolvedValue({
      kind: 'no_contacts',
      heldComponents: ['SO4', 'GOL'],
      polymerLigands: [],
    });
    const { error, hint } = await miss({ pdb_id: '1XYZ', comp_id: 'SO4' });
    expect(error.message).toBe(
      '1XYZ holds bound SO4, GOL; RCSB reports no pocket contacts for SO4.',
    );
    expect(hint).toBe(
      'Pass GOL as comp_id, or omit comp_id to list every ligand with pocket contacts.',
    );
  });

  it('says no held component has contacts when no comp_id narrows the call (#105)', async () => {
    getBindingSites.mockResolvedValue({
      kind: 'no_contacts',
      heldComponents: ['SO4'],
      polymerLigands: [],
    });
    const { error, hint } = await miss({ pdb_id: '1XYZ' });
    expect(error.message).toBe('1XYZ holds bound SO4, none with pocket contacts.');
    expect(hint).toBe(
      'Mode structures_with_ligand lists the PDB entries holding a bound copy of a given component.',
    );
  });

  it('names a polymer-chain BIRD ligand by entity, description, BIRD ID, and chain on both surfaces (1CWA, #105)', async () => {
    const polymerLigands = [
      { entityId: '1CWA_2', prdId: 'PRD_000142', authAsymIds: ['C'], description: 'CYCLOSPORIN A' },
    ];
    getBindingSites.mockResolvedValue({ kind: 'no_contacts', heldComponents: [], polymerLigands });
    const { error, hint, text } = await miss({ pdb_id: '1CWA' });

    expect(error.message).toBe(
      '1CWA holds no bound non-polymer component. Polymer-chain ligands: 1CWA_2 (CYCLOSPORIN A; BIRD PRD_000142; chain C).',
    );
    expect(error.data).toMatchObject({ heldComponents: [], polymerLigands });
    expect(hint).toBe(
      'binding_site covers non-polymer ligands only, so a ligand deposited as a polymer chain (1CWA_2) has no pocket contacts to report.',
    );
    for (const item of ['1CWA_2', 'PRD_000142', 'chain C', 'CYCLOSPORIN A']) {
      expect(text).toContain(item);
    }
    expect(`${error.message} ${hint}`).not.toMatch(/experimental-only/);
  });

  it('names every polymer ligand and held component together, plural chains and a comp_id it lacks included (#105)', async () => {
    getBindingSites.mockResolvedValue({
      kind: 'no_contacts',
      heldComponents: ['CL'],
      polymerLigands: [
        {
          entityId: '173D_2',
          prdId: 'PRD_000001',
          authAsymIds: ['C', 'D'],
          description: 'ACTINOMYCIN D',
        },
        { entityId: '173D_3', prdId: 'PRD_000204' },
      ],
    });
    const { error, hint } = await miss({ pdb_id: '173D', comp_id: 'ATP' });
    expect(error.message).toBe(
      '173D holds bound CL; none is ATP. Polymer-chain ligands: 173D_2 (ACTINOMYCIN D; BIRD PRD_000001; chains C, D); 173D_3 (BIRD PRD_000204).',
    );
    expect(hint).toBe(
      'Pass CL as comp_id, or omit comp_id to list every ligand with pocket contacts. binding_site covers non-polymer ligands only, so a ligand deposited as a polymer chain (173D_2, 173D_3) has no pocket contacts to report.',
    );
  });

  it('says an entry with no ligand of either kind holds none (1CRN, #105)', async () => {
    getBindingSites.mockResolvedValue({
      kind: 'no_contacts',
      heldComponents: [],
      polymerLigands: [],
    });
    const { error, hint } = await miss({ pdb_id: '1CRN', comp_id: 'HEM' });
    expect(error.message).toBe('1CRN holds no bound non-polymer component, so it holds no HEM.');
    expect(hint).toBe(
      'Mode structures_with_ligand lists the PDB entries holding a bound copy of a given component.',
    );
  });

  it('says RCSB has no current entry, and no more, for an ID it does not hold (2ZZZ, #105)', async () => {
    getBindingSites.mockResolvedValue({ kind: 'entry_not_found' });
    const { error, hint, text } = await miss({ pdb_id: '2zzz' });
    expect(error.message).toBe(
      'RCSB has no current PDB entry 2ZZZ (obsoleted, unreleased, or never assigned).',
    );
    expect(hint).toBe(
      'Check the ID for a typo, or find a current entry with protein_search_structures.',
    );
    expect(error.data).not.toHaveProperty('heldComponents');
    expect(error.data).not.toHaveProperty('polymerLigands');
    expect(text).toContain('RCSB has no current PDB entry 2ZZZ');
    expect(`${error.message} ${hint}`).not.toMatch(/experimental-only/);
  });

  it('says RCSB has no such computed model for a computed-model ID it does not hold (#105)', async () => {
    getBindingSites.mockResolvedValue({ kind: 'entry_not_found' });
    const { error } = await miss({ pdb_id: 'AF_AFQ00000F1' });
    expect(error.message).toBe('RCSB has no computed model AF_AFQ00000F1.');
  });

  it('says a computed model carries no bound ligands, the one miss with the experimental-only clause (AF_AFP69905F1, #105)', async () => {
    getBindingSites.mockResolvedValue({
      kind: 'no_contacts',
      heldComponents: [],
      polymerLigands: [],
    });
    const { error, hint, text } = await miss({ pdb_id: 'af_afp69905f1' });
    expect(error.message).toBe(
      'AF_AFP69905F1 is a computed model, and computed models carry no bound ligands.',
    );
    expect(hint).toBe(
      'Binding sites are experimental-only: pass an experimental PDB entry, which protein_search_structures finds.',
    );
    expect(error.data).not.toHaveProperty('heldComponents');
    expect(text).toContain('Error: AF_AFP69905F1 is a computed model');
  });

  it('reads a computed model that holds a component like any other entry (#105)', async () => {
    getBindingSites.mockResolvedValue({
      kind: 'no_contacts',
      heldComponents: ['ZN'],
      polymerLigands: [],
    });
    const { error } = await miss({ pdb_id: 'MA_TEST1', comp_id: 'HEM' });
    expect(error.message).toBe('MA_TEST1 holds bound ZN; none is HEM.');
  });

  const fourHemSites = found(
    ['A', 'B', 'C', 'D'].map((chain) => ({
      ligandCompId: 'HEM',
      ligandAsymId: chain,
      residues: [{ residueCompId: 'HIS', asymId: chain, seqId: 87, distance: 2.1 }],
    })),
  );

  it('caps binding-site instances at limit and emits a truncation notice (#9)', async () => {
    getBindingSites.mockResolvedValue(fourHemSites);
    const c = ctx();
    const out = await trackLigands.handler(
      trackLigands.input.parse({ mode: 'binding_site', pdb_id: '4HHB', comp_id: 'hem', limit: 2 }),
      c,
    );
    expect(out.bindingSites).toHaveLength(2);
    // Instance-level cap, nearest-first order preserved (A, B — not the residue lists).
    expect(out.bindingSites?.map((s) => s.ligandAsymId)).toEqual(['A', 'B']);
    expect(String(getEnrichment(c).notice)).toMatch(/showing 2 of 4 binding-site instances/i);
    // The recovery points at a reachable next page, never a limit the schema rejects.
    expect(String(getEnrichment(c).notice)).toMatch(/start 2/);
    expect(String(getEnrichment(c).notice)).not.toMatch(/raise limit/i);
  });

  it('pages binding-site instances past the limit cap with start on both surfaces (#75)', async () => {
    getBindingSites.mockResolvedValue(fourHemSites);
    const first = (await runToolContract(trackLigands, {
      mode: 'binding_site',
      pdb_id: '4HHB',
      comp_id: 'HEM',
      limit: 2,
    })) as {
      structuredContent: { bindingSites: Array<{ ligandAsymId?: string }> };
      content: Array<{ text: string }>;
    };
    expect(first.structuredContent.bindingSites.map((s) => s.ligandAsymId)).toEqual(['A', 'B']);
    const firstText = first.content.map((b) => b.text).join('\n');
    expect(firstText).toMatch(/4 total/);
    expect(firstText).toMatch(/start 2/);

    const c = ctx();
    const out = await trackLigands.handler(
      trackLigands.input.parse({
        mode: 'binding_site',
        pdb_id: '4HHB',
        comp_id: 'HEM',
        limit: 2,
        start: 2,
      }),
      c,
    );
    expect(out.bindingSites?.map((s) => s.ligandAsymId)).toEqual(['C', 'D']);
    expect(getEnrichment(c)).toMatchObject({ totalCount: 4, start: 2 });
    expect(getEnrichment(c)).not.toHaveProperty('nextStart');
    expect(getEnrichment(c).notice).toBeUndefined();
  });

  it('reports nextStart on a binding-site page with instances remaining (#75)', async () => {
    getBindingSites.mockResolvedValue(fourHemSites);
    const c = ctx();
    await trackLigands.handler(
      trackLigands.input.parse({
        mode: 'binding_site',
        pdb_id: '4HHB',
        comp_id: 'HEM',
        limit: 1,
        start: 1,
      }),
      c,
    );
    expect(getEnrichment(c)).toMatchObject({ totalCount: 4, start: 1, nextStart: 2 });
  });

  it('discloses a binding-site start past the end distinctly from no binding sites (#75)', async () => {
    getBindingSites.mockResolvedValue(fourHemSites);
    const c = ctx();
    const out = await trackLigands.handler(
      trackLigands.input.parse({ mode: 'binding_site', pdb_id: '4HHB', comp_id: 'HEM', start: 4 }),
      c,
    );
    expect(out.bindingSites).toEqual([]);
    expect(getEnrichment(c)).toMatchObject({ totalCount: 4, start: 4 });
    expect(getEnrichment(c)).not.toHaveProperty('nextStart');
    expect(String(getEnrichment(c).notice)).toMatch(/start 4 is past the end of the 4/);
  });

  it('returns every binding site with no notice when under the limit (#9)', async () => {
    getBindingSites.mockResolvedValue(fourHemSites);
    const c = ctx();
    const out = await trackLigands.handler(
      trackLigands.input.parse({ mode: 'binding_site', pdb_id: '4HHB', comp_id: 'hem', limit: 25 }),
      c,
    );
    expect(out.bindingSites).toHaveLength(4);
    expect(getEnrichment(c).notice).toBeUndefined();
  });
});

describe('protein_track_ligands — format', () => {
  it('renders ligand identifiers (SMILES/InChIKey), structure lists, and pocket residues', () => {
    const blocks = trackLigands.format!({
      mode: 'find_ligand',
      ligands: [
        {
          compId: 'STI',
          name: 'IMATINIB',
          formula: 'C29 H31 N7 O',
          formulaWeight: 493.6,
          type: 'non-polymer',
          smiles: 'Cc1ccc(cc1)Nc1nccc(n1)-c1cccnc1',
          inchikey: 'KTUFNOKKBVMGRW-UHFFFAOYSA-N',
          depositionCount: 42,
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('### STI — IMATINIB');
    expect(text).toContain('**Formula:** C29 H31 N7 O');
    expect(text).toContain('**Weight:** 493.6 Da');
    expect(text).toContain('**PDB entries:** 42');
    expect(text).toContain('**SMILES:** Cc1ccc(cc1)Nc1nccc(n1)-c1cccnc1');
    expect(text).toContain('**InChIKey:** KTUFNOKKBVMGRW-UHFFFAOYSA-N');
  });

  it('renders binding-site residues with positions and distances', () => {
    const blocks = trackLigands.format!({
      mode: 'binding_site',
      bindingSites: [
        {
          ligandCompId: 'HEM',
          ligandAsymId: 'A',
          residues: [
            { residueCompId: 'HIS', asymId: 'A', seqId: 87, distance: 2.1 },
            { residueCompId: 'PHE', asymId: 'A' },
          ],
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('### Ligand HEM (author chain A)');
    // No author identifiers reported → the label form alone, nothing invented.
    expect(text).toContain('- HIS87 (chain A) — 2.10 Å');
    expect(text).toContain('- PHE (chain A)'); // no seqId, no distance
    expect(text).not.toContain('author HIS');
  });

  it('renders a structures list with the comma-joined ids and per-entry resolution', () => {
    const blocks = trackLigands.format!({
      mode: 'structures_with_ligand',
      structures: [{ id: '4HHB', resolution: 1.74 }, { id: '2HHB' }],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**2 structures:**');
    expect(text).toContain('4HHB, 2HHB');
    expect(text).toContain('- 4HHB — 1.74 Å');
    // An entry without a resolution gets no bullet line (no meaningless score column).
    expect(text).not.toContain('score');
  });
});
