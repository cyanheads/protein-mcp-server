/**
 * @fileoverview Tests for protein_track_ligands: the three modes (find_ligand,
 * structures_with_ligand, binding_site), the missing-param guards (InvalidParams),
 * the find_ligand / binding_site empty-result not_found branches,
 * structures_with_ligand's empty-result set + notice, the totalCount /
 * resolvedCompId enrichment, find_ligand's candidate-pool disclosure
 * (totalCount / candidatesConsidered / truncation notice), comp_id upper-casing,
 * and format() rendering of ligands, structure lists, and binding sites in both
 * residue-numbering namespaces. RCSB service mocked.
 * @module tests/tools/track-ligands.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

beforeEach(() => vi.clearAllMocks());

describe('protein_track_ligands — find_ligand', () => {
  it('ignores start without adding paging state to ligand-name resolution', async () => {
    findChemComps.mockResolvedValue({ ids: ['HEM'], total: 1 });
    getChemComp.mockResolvedValue({ compId: 'HEM' });
    countEntriesWithLigand.mockResolvedValue(6475);
    const c = ctx();

    await trackLigands.handler(
      trackLigands.input.parse({ mode: 'find_ligand', query: 'heme', start: 50 }),
      c,
    );

    expect(findChemComps).toHaveBeenCalledWith('heme', 25, expect.anything());
    expect(getEnrichment(c)).not.toHaveProperty('start');
    expect(getEnrichment(c)).not.toHaveProperty('nextStart');
  });

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

    expect(findChemComps).toHaveBeenCalledWith('iron', 25, expect.anything());
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
    expect(findChemComps).toHaveBeenCalledWith('acid', 100, expect.anything());
    expect(out.ligands).toHaveLength(100);
    expect(getEnrichment(c)).toMatchObject({ totalCount: 12412, candidatesConsidered: 100 });
    expect(String(getEnrichment(c).notice)).toContain('100 of 12412');
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
    findChemComps.mockImplementation(async (_q: string, limit: number) => ({
      ids: ['AAA', 'BBB', 'CCC', 'DDD', 'HEM'].slice(0, limit),
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

      expect(findChemComps).toHaveBeenCalledWith(query, 25, expect.anything());
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
    await expect(
      trackLigands.handler(trackLigands.input.parse({ mode: 'find_ligand' }), ctx()),
    ).rejects.toMatchObject({
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
    const c = ctx();
    const out = await trackLigands.handler(
      trackLigands.input.parse({ mode: 'structures_with_ligand', comp_id: 'ZZZ' }),
      c,
    );
    expect(out.structures).toEqual([]);
    expect(getEnrichment(c)).toMatchObject({ totalCount: 0, resolvedCompId: 'ZZZ' });
    expect(String(getEnrichment(c).notice)).toMatch(/no pdb entries contain zzz/i);
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
    const c = ctx();
    await trackLigands.handler(
      trackLigands.input.parse({ mode: 'structures_with_ligand', comp_id: 'ZZZ', start: 10 }),
      c,
    );
    expect(String(getEnrichment(c).notice)).toBe(
      'No PDB entries contain ZZZ. Verify the component ID via mode find_ligand.',
    );
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
  it('returns binding-site residues for a structure', async () => {
    getBindingSites.mockResolvedValue([
      {
        ligandCompId: 'HEM',
        ligandAsymId: 'A',
        residues: [{ residueCompId: 'HIS', asymId: 'A', seqId: 87, distance: 2.1 }],
      },
    ]);
    const out = await trackLigands.handler(
      trackLigands.input.parse({ mode: 'binding_site', pdb_id: '4HHB', comp_id: 'hem' }),
      ctx(),
    );
    expect(out.bindingSites?.[0]).toMatchObject({ ligandCompId: 'HEM', ligandAsymId: 'A' });
    expect(getBindingSites).toHaveBeenCalledWith('4HHB', 'HEM', expect.anything());
  });

  it('returns label and author numbering for pocket residues on both surfaces (1IEP STI, #69)', async () => {
    getBindingSites.mockResolvedValue([
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
    ]);

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

  it('throws not_found when no binding-site contacts are found', async () => {
    getBindingSites.mockResolvedValue([]);
    await expect(
      trackLigands.handler(
        trackLigands.input.parse({ mode: 'binding_site', pdb_id: '1ABC' }),
        ctx(),
      ),
    ).rejects.toMatchObject({ data: { reason: 'not_found' } });
  });

  const fourHemSites = ['A', 'B', 'C', 'D'].map((chain) => ({
    ligandCompId: 'HEM',
    ligandAsymId: chain,
    residues: [{ residueCompId: 'HIS', asymId: chain, seqId: 87, distance: 2.1 }],
  }));

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
