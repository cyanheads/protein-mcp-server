/**
 * @fileoverview Tests for protein_search_structures: the no-criteria guard, the
 * rejection of a sequence-search threshold sent without a sequence,
 * content_type → content-universe scoping (including the "all" union),
 * computed-model (AlphaFold) ID parsing into a UniProt accession, experimental
 * metadata enrichment, the total/echo/empty-notice enrichment, the capped-facet
 * advisory and its sequence-search variant, the flat facet contract (no
 * cross-tab child requested or advertised), the repeated-facet-dimension
 * rejection, the empty-facet-dimension rendering across both consumption
 * surfaces, the unknown_method contract, the ligand filter and its zero-hit
 * pointer, the computed-model notice for experimental-only filters under
 * predicted content, and the per-hit sequence alignment with the query length.
 * The RCSB service instance is mocked; its query builders run for real.
 * @module tests/tools/search-structures.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const search = vi.fn();
const getEntries = vi.fn();
// Only the service instance is faked; the query builders run the real code.
vi.mock('@/services/rcsb/rcsb-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/rcsb/rcsb-service.js')>()),
  getRcsbService: () => ({ search, getEntries }),
}));

import { getServerConfig } from '@/config/server-config.js';
import { searchStructures } from '@/mcp-server/tools/definitions/search-structures.tool.js';
import { buildQuery } from '@/services/rcsb/rcsb-service.js';
import type { StructureSearchParams } from '@/services/rcsb/types.js';

const ctx = () => createMockContext({ errors: searchStructures.errors });
const FACET_CAP = getServerConfig().facetBucketCap;

/** A `runToolContract` failure — the envelope that carries the declared recovery fill. */
type ContractError = {
  isError?: boolean;
  structuredContent: {
    error: { code: number; data: { reason: string; recovery?: { hint: string } } };
  };
};

beforeEach(() => vi.clearAllMocks());

describe('protein_search_structures', () => {
  it('normalizes sequences while preserving filters, thresholds and offsets (#77)', async () => {
    search.mockResolvedValue({ total: 0, hits: [] });
    const result = await runToolContract(searchStructures, {
      sequence: ' abou xzcdef\n',
      query: 'globin',
      organism: 'Homo sapiens',
      min_identity: 0.8,
      start: 5,
      limit: 1,
    });
    expect(result.isError).not.toBe(true);
    expect(search.mock.calls[0]?.[0]).toMatchObject({
      sequence: 'ABOUXZCDEF',
      text: 'globin',
      organism: 'Homo sapiens',
      minIdentity: 0.8,
      start: 5,
      limit: 1,
    });
    expect(result.structuredContent).toMatchObject({ hits: [], totalCount: 0 });
    expect(JSON.stringify(result.content)).toContain('No structures matched');
  });
  it.each([' ', 'ACDEFGHIK', 'ACDEFGHIKJ', 'ACDEFGHIK*'])(
    'rejects %j with typed recovery on both surfaces (#77)',
    async (sequence) => {
      const result = await runToolContract(searchStructures, { sequence });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: -32602,
          data: {
            reason: 'invalid_sequence',
            recovery: { hint: expect.stringContaining('at least 10') },
          },
        },
      });
      const text = JSON.stringify(result.content);
      expect(text).toContain('invalid_sequence');
      expect(text).toContain('length');
      expect(search).not.toHaveBeenCalled();
    },
  );
  it('throws no_criteria (with its declared recovery hint) when nothing to search on', async () => {
    const result = (await runToolContract(searchStructures, {})) as ContractError;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({
      data: {
        reason: 'no_criteria',
        recovery: { hint: expect.stringContaining('free-text query') },
      },
    });
  });

  it('accepts method and maximum resolution as independent or combined criteria', async () => {
    search.mockResolvedValue({ total: 0, hits: [] });
    getEntries.mockResolvedValue([]);

    for (const input of [
      { method: 'ELECTRON MICROSCOPY' },
      { max_resolution: 2.5 },
      { method: 'ELECTRON MICROSCOPY', max_resolution: 3 },
    ]) {
      search.mockClear();
      await searchStructures.handler(searchStructures.input.parse(input), ctx());
      expect(search).toHaveBeenCalledOnce();
    }
  });

  it('keeps filter-only zero-result searches on the normal empty-result path', async () => {
    const c = ctx();
    search.mockResolvedValue({ total: 0, hits: [] });
    getEntries.mockResolvedValue([]);

    const out = await searchStructures.handler(
      searchStructures.input.parse({ method: 'X-RAY DIFFRACTION', max_resolution: 1.5 }),
      c,
    );

    expect(out.hits).toEqual([]);
    expect(getEnrichment(c)).toMatchObject({
      totalCount: 0,
      start: 0,
      notice: expect.stringMatching(/No structures matched/),
    });
  });

  it.each([
    ['sequence modifiers', { min_identity: 0.5 }],
    ['sequence modifiers', { max_evalue: 0.01 }],
    ['content type', { content_type: 'experimental' as const }],
    ['facets', { facets: ['method' as const] }],
    ['limit', { limit: 10 }],
    ['offset', { start: 10 }],
  ] as const)('rejects non-node search modifiers without criteria: %s', async (_label, input) => {
    await expect(
      searchStructures.handler(searchStructures.input.parse(input), ctx()),
    ).rejects.toMatchObject({ data: { reason: 'no_criteria' } });
    expect(search).not.toHaveBeenCalled();
  });

  it.each([
    ['min_identity', { query: 'hemoglobin', min_identity: 0.99 }],
    ['max_evalue', { query: 'hemoglobin', max_evalue: 0.01 }],
    ['both', { query: 'hemoglobin', min_identity: 0.99, max_evalue: 0.01 }],
    ['alongside an organism filter', { organism: 'Homo sapiens', min_identity: 0.99 }],
    ['alongside a resolution filter', { max_resolution: 2.5, max_evalue: 0.01 }],
  ] as const)(
    'rejects a sequence-search threshold sent without a sequence: %s (#56)',
    async (_label, input) => {
      const result = (await runToolContract(searchStructures, input)) as ContractError;
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error).toMatchObject({
        code: -32602,
        data: {
          reason: 'sequence_modifier_without_sequence',
          recovery: { hint: expect.stringContaining('sequence') },
        },
      });
      expect(search).not.toHaveBeenCalled();
    },
  );

  it('names the supplied thresholds in the rejection message (#56)', async () => {
    const err = await Promise.resolve(
      searchStructures.handler(
        searchStructures.input.parse({
          query: 'hemoglobin',
          min_identity: 0.99,
          max_evalue: 0.01,
        }),
        ctx(),
      ),
    ).catch((e: Error) => e);
    expect((err as Error).message).toContain(
      'min_identity and max_evalue are sequence-search thresholds',
    );
  });

  it('reads as one threshold when only one was supplied (#56)', async () => {
    const err = await Promise.resolve(
      searchStructures.handler(
        searchStructures.input.parse({ query: 'hemoglobin', min_identity: 0.99 }),
        ctx(),
      ),
    ).catch((e: Error) => e);
    expect((err as Error).message).toContain('min_identity is a sequence-search threshold');
  });

  it('forwards both thresholds unchanged when a sequence is present (#56)', async () => {
    search.mockResolvedValue({ total: 0, hits: [] });
    getEntries.mockResolvedValue([]);
    await searchStructures.handler(
      searchStructures.input.parse({
        sequence: 'MVLSPADKTN',
        min_identity: 0.9,
        max_evalue: 0.001,
      }),
      ctx(),
    );
    expect(search.mock.calls[0]?.[0]).toMatchObject({
      sequence: 'MVLSPADKTN',
      minIdentity: 0.9,
      maxEvalue: 0.001,
    });
  });

  it('leaves a sequence search with other filters and no thresholds unaffected (#56)', async () => {
    search.mockResolvedValue({ total: 0, hits: [] });
    getEntries.mockResolvedValue([]);
    await searchStructures.handler(
      searchStructures.input.parse({
        sequence: 'MVLSPADKTN',
        organism: 'Homo sapiens',
        method: 'X-RAY DIFFRACTION',
        max_resolution: 2.5,
      }),
      ctx(),
    );
    expect(search).toHaveBeenCalledOnce();
  });

  it('leaves the non-threshold modifiers unaffected without a sequence (#56)', async () => {
    // content_type / facets / limit / start are not sequence-scoped, so the new
    // guard must not touch a plain filtered search that carries them.
    search.mockResolvedValue({ total: 0, hits: [] });
    getEntries.mockResolvedValue([]);
    await searchStructures.handler(
      searchStructures.input.parse({
        query: 'hemoglobin',
        content_type: 'experimental',
        facets: ['method'],
        limit: 5,
        start: 10,
      }),
      ctx(),
    );
    expect(search).toHaveBeenCalledOnce();
  });

  it('keeps a threshold-only call on the no_criteria path (#56)', async () => {
    // The new guard is additive: with nothing to search on, no_criteria still wins.
    for (const input of [{ min_identity: 0.5 }, { max_evalue: 0.01 }] as const) {
      search.mockClear();
      await expect(
        searchStructures.handler(searchStructures.input.parse(input), ctx()),
      ).rejects.toMatchObject({ data: { reason: 'no_criteria' } });
      expect(search).not.toHaveBeenCalled();
    }
  });

  it('rejects a repeated facets dimension before any upstream call (#35)', async () => {
    const result = (await runToolContract(searchStructures, {
      query: 'hemoglobin',
      facets: ['method', 'method'],
    })) as ContractError;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({
      data: {
        reason: 'duplicate_dimension',
        recovery: { hint: expect.stringContaining('at most once') },
      },
    });
    expect(search).not.toHaveBeenCalled();
  });

  it('rejects a repeat anywhere in a longer facets list, naming the dimension (#35)', async () => {
    const err = await Promise.resolve(
      searchStructures.handler(
        searchStructures.input.parse({
          query: 'hemoglobin',
          facets: ['method', 'organism', 'release_year', 'organism'],
        }),
        ctx(),
      ),
    ).catch((e: Error) => e);
    expect(err).toMatchObject({ data: { reason: 'duplicate_dimension' } });
    expect((err as Error).message).toContain('organism');
    expect(search).not.toHaveBeenCalled();
  });

  it('leaves distinct facet dimensions and a single dimension unaffected (#35)', async () => {
    for (const facets of [['method', 'organism'], ['method']] as const) {
      search.mockClear();
      search.mockResolvedValue({ total: 0, hits: [] });
      getEntries.mockResolvedValue([]);
      await searchStructures.handler(
        searchStructures.input.parse({ query: 'hemoglobin', facets: [...facets] }),
        ctx(),
      );
      const specs = search.mock.calls[0]?.[2] as Array<{ dimension: string }>;
      expect(specs.map((s) => s.dimension)).toEqual([...facets]);
    }
  });

  it('requests one flat facet spec per dimension, never a cross-tab child (#34)', async () => {
    search.mockResolvedValue({ total: 0, hits: [] });
    getEntries.mockResolvedValue([]);
    await searchStructures.handler(
      searchStructures.input.parse({ query: 'hemoglobin', facets: ['method', 'release_year'] }),
      ctx(),
    );
    // rcsb.search(params, ctx, facetSpecs) — the third argument carries the specs.
    const specs = search.mock.calls[0]?.[2] as Array<{ dimension: string; child?: unknown }>;
    expect(specs.map((s) => s.dimension)).toEqual(['method', 'release_year']);
    for (const spec of specs) expect(spec).not.toHaveProperty('child');
  });

  it('advertises no nested cross-tab position on its facet buckets (#34)', async () => {
    // No child spec is ever requested, so the service cannot produce a nested
    // child here — one arriving anyway must not survive into the contract.
    search.mockResolvedValue({
      total: 500,
      hits: [],
      facets: [
        {
          dimension: 'method',
          attribute: 'exptl.method',
          buckets: [
            {
              label: 'X-RAY DIFFRACTION',
              count: 400,
              child: {
                dimension: 'release_year',
                attribute: 'rcsb_accession_info.initial_release_date',
                buckets: Array.from({ length: FACET_CAP + 3 }, (_, i) => ({
                  label: String(2000 + i),
                  count: FACET_CAP + 3 - i,
                })),
              },
            },
          ],
        },
      ],
    });
    getEntries.mockResolvedValue([]);
    const result = (await runToolContract(searchStructures, {
      query: 'hemoglobin',
      facets: ['method'],
      limit: 1,
    })) as {
      structuredContent: { facets: Array<{ buckets: Array<Record<string, unknown>> }> };
      content: Array<{ type: string; text: string }>;
    };

    const bucket = result.structuredContent.facets[0]?.buckets[0];
    expect(bucket).toEqual({ label: 'X-RAY DIFFRACTION', count: 400 });
    expect(bucket).not.toHaveProperty('children');
    // The flat breakdown itself still reaches both surfaces.
    expect(result.content[0]?.text).toContain('- X-RAY DIFFRACTION: 400');
  });

  it('sends both content universes for the default "all" scope (#29)', async () => {
    search.mockResolvedValue({ total: 0, hits: [] });
    getEntries.mockResolvedValue([]);
    await searchStructures.handler(searchStructures.input.parse({ query: 'hemoglobin' }), ctx());
    // "all" must reach RCSB as an explicit union — omitting the option is
    // experimental-only upstream, which silently drops every computed model.
    expect(search.mock.calls[0]?.[0]).toMatchObject({
      contentType: ['experimental', 'computational'],
    });
  });

  it('scopes to a single content universe for experimental and predicted (#29)', async () => {
    search.mockResolvedValue({ total: 0, hits: [] });
    getEntries.mockResolvedValue([]);

    await searchStructures.handler(
      searchStructures.input.parse({ query: 'hemoglobin', content_type: 'experimental' }),
      ctx(),
    );
    expect(search.mock.calls[0]?.[0]).toMatchObject({ contentType: ['experimental'] });

    search.mockClear();
    search.mockResolvedValue({ total: 0, hits: [] });
    await searchStructures.handler(
      searchStructures.input.parse({ query: 'hemoglobin', content_type: 'predicted' }),
      ctx(),
    );
    expect(search.mock.calls[0]?.[0]).toMatchObject({ contentType: ['computational'] });
  });

  it('parses a UniProt accession out of a predicted computed-model hit', async () => {
    search.mockResolvedValue({ total: 1, hits: [{ id: 'AF_AFP69905F1', score: 1 }] });
    getEntries.mockResolvedValue([]);
    const input = searchStructures.input.parse({ query: 'hemoglobin', content_type: 'predicted' });
    const out = await searchStructures.handler(input, ctx());

    expect(out.hits[0]).toMatchObject({
      id: 'AF_AFP69905F1',
      source: 'predicted',
      uniprotAccession: 'P69905',
    });
  });

  it('keeps a non-sequence predicted hit on its bare entry ID with no entityId (#60)', async () => {
    search.mockResolvedValue({
      total: 2,
      hits: [
        { id: 'AF_AFP69905F1', score: 1 },
        { id: 'MA_MAASFVASFVG001', score: 0.9 },
      ],
    });
    getEntries.mockResolvedValue([]);
    const out = await searchStructures.handler(
      searchStructures.input.parse({ query: 'hemoglobin', content_type: 'predicted' }),
      ctx(),
    );

    expect(out.hits).toEqual([
      { id: 'AF_AFP69905F1', source: 'predicted', score: 1, uniprotAccession: 'P69905' },
      { id: 'MA_MAASFVASFVG001', source: 'predicted', score: 0.9 },
    ]);
    expect(getEntries).not.toHaveBeenCalled();
  });

  it('returns the chainable entry ID plus entityId and accession for an AlphaFold sequence hit (#60)', async () => {
    search.mockResolvedValue({ total: 1, hits: [{ id: 'AF_AFP69905F1_1', score: 1 }] });
    getEntries.mockResolvedValue([]);

    const result = (await runToolContract(searchStructures, {
      sequence: 'VLSPADKTNVKAAWGKVGAHAGEYGAEALERMF',
      content_type: 'predicted',
      limit: 1,
    })) as {
      structuredContent: {
        hits: Array<{ id: string; entityId?: string; uniprotAccession?: string }>;
      };
      content: Array<{ text: string }>;
    };

    expect(result.structuredContent.hits[0]).toEqual({
      id: 'AF_AFP69905F1',
      entityId: 'AF_AFP69905F1_1',
      source: 'predicted',
      score: 1,
      uniprotAccession: 'P69905',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('### AF_AFP69905F1 _(predicted)_');
    expect(text).toContain('**Entity:** AF_AFP69905F1_1');
    expect(text).toContain('**UniProt:** P69905');
    // Computed models carry no experimental metadata worth an entry lookup.
    expect(getEntries).not.toHaveBeenCalled();
  });

  it('strips the entity suffix from a ModelArchive sequence hit, with no accession (#60)', async () => {
    search.mockResolvedValue({
      total: 3,
      hits: [
        { id: 'MA_MAASFVASFVG001_1', score: 1 },
        { id: 'AF_AFQ8WZ42F12_1', score: 0.8 },
        { id: '4HHB_1', score: 0.7 },
      ],
    });
    getEntries.mockResolvedValue([]);
    const out = await searchStructures.handler(
      searchStructures.input.parse({ sequence: 'MVLSPADKTN' }),
      ctx(),
    );

    expect(out.hits).toEqual([
      { id: 'MA_MAASFVASFVG001', entityId: 'MA_MAASFVASFVG001_1', source: 'predicted', score: 1 },
      // A multi-digit fragment number survives: only the trailing entity suffix goes.
      {
        id: 'AF_AFQ8WZ42F12',
        entityId: 'AF_AFQ8WZ42F12_1',
        source: 'predicted',
        score: 0.8,
        uniprotAccession: 'Q8WZ42',
      },
      { id: '4HHB', entityId: '4HHB_1', source: 'experimental', score: 0.7 },
    ]);
    expect(getEntries).toHaveBeenCalledWith(['4HHB'], expect.anything());
  });

  it('enriches experimental hits and records the total + echoed query', async () => {
    search.mockResolvedValue({ total: 9064, hits: [{ id: '4HHB', score: 1 }] });
    getEntries.mockResolvedValue([
      {
        id: '4HHB',
        title: 'Deoxyhaemoglobin',
        methods: ['X-RAY DIFFRACTION'],
        organisms: ['Homo sapiens'],
        resolution: 1.74,
        polymerEntities: [],
        ligands: [],
      },
    ]);
    const c = ctx();
    const out = await searchStructures.handler(
      searchStructures.input.parse({ query: 'hemoglobin' }),
      c,
    );

    expect(out.hits[0]).toMatchObject({
      id: '4HHB',
      source: 'experimental',
      title: 'Deoxyhaemoglobin',
      method: 'X-RAY DIFFRACTION',
      organisms: ['Homo sapiens'],
    });
    expect(out.hits[0]).not.toHaveProperty('organism');
    expect(getEnrichment(c)).toMatchObject({ totalCount: 9064, effectiveQuery: 'hemoglobin' });
  });

  /** 6M0J metadata as getEntries returns it: entities in entity-number order. */
  const META_6M0J = {
    id: '6M0J',
    title: 'Crystal structure of SARS-CoV-2 spike receptor-binding domain bound with ACE2',
    methods: ['X-RAY DIFFRACTION'],
    resolution: 2.45,
    organisms: ['Homo sapiens', 'Severe acute respiratory syndrome coronavirus 2'],
    polymerEntities: [
      { entityId: '6M0J_1', organisms: ['Homo sapiens'] },
      { entityId: '6M0J_2', organisms: ['Severe acute respiratory syndrome coronavirus 2'] },
    ],
    ligands: [],
  };

  /** 7BZ5: the SARS-CoV-2 spike RBD (entity 1) bound by a human antibody (entities 2 and 3). */
  const META_7BZ5 = {
    id: '7BZ5',
    title:
      'Structure of COVID-19 virus spike receptor-binding domain complexed with a neutralizing antibody',
    organisms: ['Severe acute respiratory syndrome coronavirus 2', 'Homo sapiens'],
    polymerEntities: [
      { entityId: '7BZ5_1', organisms: ['Severe acute respiratory syndrome coronavirus 2'] },
      { entityId: '7BZ5_2', organisms: ['Homo sapiens'] },
      { entityId: '7BZ5_3', organisms: ['Homo sapiens'] },
    ],
    ligands: [],
  };

  type HitsResult = {
    structuredContent: { hits: Array<{ id: string; entityId?: string; organisms?: string[] }> };
    content: Array<{ text: string }>;
  };

  it("lists every source organism of a text hit's entry on both surfaces (6M0J, #85)", async () => {
    search.mockResolvedValue({ total: 1, hits: [{ id: '6M0J', score: 1 }] });
    getEntries.mockResolvedValue([META_6M0J]);

    const result = (await runToolContract(searchStructures, {
      query: 'ACE2 spike',
      limit: 1,
    })) as HitsResult;

    expect(result.structuredContent.hits[0]?.organisms).toEqual([
      'Homo sapiens',
      'Severe acute respiratory syndrome coronavirus 2',
    ]);
    expect(result.content[0]?.text).toContain(
      '**Organisms:** Homo sapiens, Severe acute respiratory syndrome coronavirus 2',
    );
  });

  it("reports a sequence hit's matched-entity organisms, not the entry's, on both surfaces (7BZ5_1, #85)", async () => {
    search.mockResolvedValue({
      total: 2,
      hits: [
        { id: '7BZ5_1', score: 1 },
        { id: '7BZ5_2', score: 0.4 },
      ],
    });
    getEntries.mockResolvedValue([META_7BZ5]);

    const result = (await runToolContract(searchStructures, {
      sequence: 'RVQPTESIVRFPNITNLCPFGEVFNATRFASVYAWNRKRISNCVADYSVLYNSASFSTFKCYGVSPTKLNDLCFTNVYAD',
      limit: 2,
    })) as HitsResult;

    const [spike, heavy] = result.structuredContent.hits;
    expect(spike).toMatchObject({
      id: '7BZ5',
      entityId: '7BZ5_1',
      organisms: ['Severe acute respiratory syndrome coronavirus 2'],
    });
    expect(heavy).toMatchObject({ id: '7BZ5', entityId: '7BZ5_2', organisms: ['Homo sapiens'] });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain(
      '**Entity:** 7BZ5_1 | **Organisms:** Severe acute respiratory syndrome coronavirus 2',
    );
    expect(text).toContain('**Entity:** 7BZ5_2 | **Organisms:** Homo sapiens');
  });

  it('omits organisms on a sequence hit whose matched entity the entry metadata lacks (#85)', async () => {
    search.mockResolvedValue({ total: 1, hits: [{ id: '7BZ5_4', score: 1 }] });
    getEntries.mockResolvedValue([META_7BZ5]);

    const result = (await runToolContract(searchStructures, {
      sequence: 'MVLSPADKTN',
      limit: 1,
    })) as HitsResult;

    // The entry resolved (its title is there); only the entity is unknown.
    expect(result.structuredContent.hits[0]).toMatchObject({ id: '7BZ5', entityId: '7BZ5_4' });
    expect(result.structuredContent.hits[0]).toHaveProperty('title');
    // Neither the entry's list nor its first organism stands in for the unknown entity's.
    expect(result.structuredContent.hits[0]).not.toHaveProperty('organisms');
    expect(result.structuredContent.hits[0]).not.toHaveProperty('organism');
    expect(result.content[0]?.text).not.toMatch(/\*\*Organisms?:\*\*/);
  });

  it('uses bare entry IDs for sequence-hit metadata lookup', async () => {
    search.mockResolvedValue({ total: 1, hits: [{ id: '1A00_1', score: 1 }] });
    getEntries.mockResolvedValue([]);

    await searchStructures.handler(searchStructures.input.parse({ sequence: 'MVLSPADKTN' }), ctx());

    expect(getEntries).toHaveBeenCalledWith(['1A00'], expect.anything());
  });

  it('returns a chainable bare ID plus raw entityId for experimental sequence hits', async () => {
    search.mockResolvedValue({ total: 1, hits: [{ id: '1A00_1', score: 1 }] });
    getEntries.mockResolvedValue([]);

    const result = (await runToolContract(searchStructures, {
      sequence: 'MVLSPADKTN',
      limit: 1,
    })) as {
      structuredContent: { hits: Array<{ id: string; entityId?: string }> };
      content: Array<{ text: string }>;
    };

    expect(result.structuredContent.hits[0]).toMatchObject({ id: '1A00', entityId: '1A00_1' });
    expect(result.content[0]?.text).toContain('**Entity:** 1A00_1');
  });

  it('exposes offset paging through enrichment on both consumption surfaces', async () => {
    search.mockResolvedValue({ total: 30, hits: [{ id: '4HHB', score: 1 }] });
    getEntries.mockResolvedValue([]);

    const result = (await runToolContract(searchStructures, {
      query: 'hemoglobin',
      start: 25,
      limit: 1,
    })) as {
      structuredContent: { start: number; nextStart?: number; totalCount: number };
      content: Array<{ text: string }>;
    };

    expect(search.mock.calls[0]?.[0]).toMatchObject({ start: 25, limit: 1 });
    expect(result.structuredContent).toMatchObject({ totalCount: 30, start: 25, nextStart: 26 });
    const rendered = result.content.map((block) => block.text).join('\n');
    expect(rendered).toContain('**start:** 25');
    expect(rendered).toContain('**nextStart:** 26');
  });

  it('omits nextStart on a final or past-end page while preserving totalCount', async () => {
    for (const [start, total, hits] of [
      [29, 30, [{ id: '4HHB', score: 1 }]],
      [40, 30, []],
      [0, 0, []],
    ] as const) {
      search.mockResolvedValue({ total, hits });
      getEntries.mockResolvedValue([]);
      const c = ctx();
      await searchStructures.handler(
        searchStructures.input.parse({ query: 'hemoglobin', start, limit: 5 }),
        c,
      );
      expect(getEnrichment(c)).toMatchObject({ totalCount: total, start });
      expect(getEnrichment(c)).not.toHaveProperty('nextStart');
    }
  });

  it('names the offset on a past-end page instead of claiming no matches, on both surfaces (#66)', async () => {
    search.mockResolvedValue({ total: 9171, hits: [] });
    getEntries.mockResolvedValue([]);

    const result = (await runToolContract(searchStructures, {
      query: 'hemoglobin',
      content_type: 'experimental',
      start: 10000,
      limit: 1,
    })) as {
      structuredContent: {
        hits: unknown[];
        totalCount: number;
        nextStart?: number;
        notice?: string;
      };
      content: Array<{ text: string }>;
    };

    expect(result.structuredContent.hits).toEqual([]);
    expect(result.structuredContent.totalCount).toBe(9171);
    expect(result.structuredContent).not.toHaveProperty('nextStart');
    const notice = String(result.structuredContent.notice);
    expect(notice).toContain('start 10000 is past the end of the 9171 matches');
    expect(notice).toMatch(/lower start/);
    expect(notice).not.toMatch(/No experimental structures matched/);
    const rendered = result.content.map((block) => block.text).join('\n');
    expect(rendered).toContain('start 10000 is past the end of the 9171 matches');
    expect(rendered).not.toMatch(/No experimental structures matched/);
  });

  it('keeps the zero-match advice for every scope when the total is zero (#66)', async () => {
    for (const content_type of ['experimental', 'predicted', 'all'] as const) {
      search.mockResolvedValue({ total: 0, hits: [] });
      getEntries.mockResolvedValue([]);
      const c = ctx();
      await searchStructures.handler(
        searchStructures.input.parse({ query: 'zzzznotathing', content_type, start: 50 }),
        c,
      );
      const notice = String(getEnrichment(c).notice);
      expect(notice).toMatch(/matched/);
      expect(notice).not.toMatch(/past the end/);
    }
  });

  it('rejects negative or fractional offsets', () => {
    expect(searchStructures.input.safeParse({ query: 'x', start: -1 }).success).toBe(false);
    expect(searchStructures.input.safeParse({ query: 'x', start: 1.5 }).success).toBe(false);
  });

  it('notes an empty result set', async () => {
    search.mockResolvedValue({ total: 0, hits: [] });
    getEntries.mockResolvedValue([]);
    const c = ctx();
    const out = await searchStructures.handler(
      searchStructures.input.parse({ query: 'zzzznotathing' }),
      c,
    );

    expect(out.hits).toEqual([]);
    expect(String(getEnrichment(c).notice)).toMatch(/broaden|no structures/i);
  });

  it('only points a zero-hit caller at a scope wider than the one searched (#29)', async () => {
    for (const [content_type, wider] of [
      ['experimental', true],
      ['predicted', true],
      // "all" already searched both universes — telling this caller to switch
      // content_type sends them to a scope that cannot return more.
      ['all', false],
    ] as const) {
      search.mockClear();
      search.mockResolvedValue({ total: 0, hits: [] });
      getEntries.mockResolvedValue([]);
      const c = ctx();
      await searchStructures.handler(
        searchStructures.input.parse({ query: 'zzzznotathing', content_type }),
        c,
      );
      const notice = String(getEnrichment(c).notice);
      expect(/widen content_type to "all"/.test(notice)).toBe(wider);
      if (!wider) expect(notice).toMatch(/already the widest scope/i);
    }
  });

  it('explains a one-word organism that matched nothing on both surfaces, without a phrase fallback (#86)', async () => {
    search.mockResolvedValue({ total: 0, hits: [] });
    const result = (await runToolContract(searchStructures, { organism: 'Zika' })) as {
      structuredContent: { notice?: string };
      content: Array<{ text: string }>;
    };
    const advice = 'organism "Zika" matches only a taxon with exactly that name';
    expect(String(result.structuredContent.notice)).toContain(advice);
    expect(String(result.structuredContent.notice)).toContain('"Zika virus"');
    expect(result.content.map((b) => b.text).join('\n')).toContain(advice);
    // The query keeps the exact arms only: no phrase match reaches RCSB.
    const params = search.mock.calls[0]?.[0] as StructureSearchParams;
    expect(JSON.stringify(buildQuery(params))).not.toContain('contains_phrase');
  });

  it.each([
    [{ organism: 'Zika virus' }, 0],
    [{ organism: '9606' }, 0],
    [{ organism: 'Zika' }, 3],
  ])('adds no one-word organism advice for %j with %i matches', async (input, total) => {
    search.mockResolvedValue({ total, hits: [] });
    getEntries.mockResolvedValue([]);
    const c = ctx();
    await searchStructures.handler(searchStructures.input.parse(input), c);
    expect(String(getEnrichment(c).notice)).not.toContain('matches only a taxon');
  });

  it('leaves the notice unset when hits came back', async () => {
    search.mockResolvedValue({
      total: 500,
      hits: [{ id: '4HHB', score: 1 }],
      facets: [
        {
          dimension: 'method',
          attribute: 'exptl.method',
          buckets: [{ label: 'X-RAY DIFFRACTION', count: 500 }],
        },
      ],
    });
    getEntries.mockResolvedValue([]);
    const c = ctx();
    await searchStructures.handler(
      searchStructures.input.parse({ query: 'hemoglobin', facets: ['method'] }),
      c,
    );
    expect(getEnrichment(c)).not.toHaveProperty('notice');
  });

  it('discloses a facet coverage gap alongside a full page of hits (#32)', async () => {
    // The default content_type "all" unions both universes, but computed models
    // carry no experimental method — 58304 of 130104 matches fall in no bucket.
    search.mockResolvedValue({
      total: 130104,
      hits: [{ id: '4HHB', score: 1 }],
      facets: [
        {
          dimension: 'method',
          attribute: 'exptl.method',
          buckets: [{ label: 'X-RAY DIFFRACTION', count: 71800 }],
        },
      ],
    });
    getEntries.mockResolvedValue([]);
    const c = ctx();
    const out = await searchStructures.handler(
      searchStructures.input.parse({ query: 'kinase', facets: ['method'] }),
      c,
    );
    expect(out.facets?.[0]?.missingValueCount).toBe(58304);
    const notice = String(getEnrichment(c).notice);
    expect(notice).toContain('method');
    expect(notice).toMatch(/44\.8%/);
  });

  it('measures the facet coverage gap before the bucket cap slices the list (#32)', async () => {
    const buckets = Array.from({ length: FACET_CAP + 4 }, () => ({ label: 'org', count: 10 }));
    search.mockResolvedValue({
      total: (FACET_CAP + 4) * 10 + 500,
      hits: [{ id: '4HHB', score: 1 }],
      facets: [
        {
          dimension: 'organism',
          attribute: 'rcsb_entity_source_organism.ncbi_scientific_name',
          buckets,
        },
      ],
    });
    getEntries.mockResolvedValue([]);
    const c = ctx();
    const out = await searchStructures.handler(
      searchStructures.input.parse({ query: 'kinase', facets: ['organism'] }),
      c,
    );
    expect(out.facets?.[0]?.truncated).toBe(true);
    expect(out.facets?.[0]?.buckets).toHaveLength(FACET_CAP);
    expect(out.facets?.[0]?.missingValueCount).toBe(500);
    // The structural flag alone left the caller no route to the long tail (#52).
    const notice = String(getEnrichment(c).notice);
    expect(notice).toContain(`organism was capped at ${FACET_CAP} buckets.`);
    expect(notice).toContain('protein_analyze_collection');
    expect(notice).toContain('group_by');
    expect(notice).toContain(`bucket_limit above ${FACET_CAP}`);
  });

  it('names every truncated dimension, not just the first (#52)', async () => {
    const many = (label: string) =>
      Array.from({ length: FACET_CAP + 1 }, (_, i) => ({ label: `${label}${i}`, count: 1 }));
    search.mockResolvedValue({
      total: FACET_CAP + 1,
      hits: [{ id: '4HHB', score: 1 }],
      facets: [
        {
          dimension: 'organism',
          attribute: 'rcsb_entity_source_organism.ncbi_scientific_name',
          buckets: many('org'),
        },
        { dimension: 'method', attribute: 'exptl.method', buckets: many('m') },
      ],
    });
    getEntries.mockResolvedValue([]);
    const c = ctx();
    await searchStructures.handler(
      searchStructures.input.parse({ query: 'kinase', facets: ['organism', 'method'] }),
      c,
    );
    expect(String(getEnrichment(c).notice)).toContain(
      `organism and method were capped at ${FACET_CAP} buckets.`,
    );
  });

  it('does not offer protein_analyze_collection to a sequence search (#52)', async () => {
    // That tool has no sequence input, so it cannot reproduce this result set.
    const buckets = Array.from({ length: FACET_CAP + 1 }, (_, i) => ({
      label: `org${i}`,
      count: 1,
    }));
    search.mockResolvedValue({
      total: FACET_CAP + 1,
      hits: [{ id: '1A00_1', score: 1 }],
      facets: [
        {
          dimension: 'organism',
          attribute: 'rcsb_entity_source_organism.ncbi_scientific_name',
          buckets,
        },
      ],
    });
    getEntries.mockResolvedValue([]);
    const c = ctx();
    await searchStructures.handler(
      searchStructures.input.parse({ sequence: 'MVLSPADKTN', facets: ['organism'] }),
      c,
    );
    const notice = String(getEnrichment(c).notice);
    expect(notice).toContain(`organism was capped at ${FACET_CAP} buckets.`);
    expect(notice).toMatch(/cannot reproduce a sequence search/);
    expect(notice).toMatch(
      /drop sequence, or add organism, method, max_resolution, ligand, or query/,
    );
    expect(notice).not.toMatch(/bucket_limit/);
  });

  it('adds no truncation fragment when no requested facet was capped (#52)', async () => {
    search.mockResolvedValue({
      total: 500,
      hits: [{ id: '4HHB', score: 1 }],
      facets: [
        {
          dimension: 'method',
          attribute: 'exptl.method',
          buckets: [{ label: 'X-RAY DIFFRACTION', count: 500 }],
        },
      ],
    });
    getEntries.mockResolvedValue([]);
    const c = ctx();
    await searchStructures.handler(
      searchStructures.input.parse({ query: 'hemoglobin', facets: ['method'] }),
      c,
    );
    expect(getEnrichment(c)).not.toHaveProperty('notice');
  });

  it('composes the truncation fragment with the past-end and coverage notices (#52, #66)', async () => {
    const buckets = Array.from({ length: FACET_CAP + 1 }, (_, i) => ({
      label: `org${i}`,
      count: 10,
    }));
    const total = (FACET_CAP + 1) * 10 + 5000;
    search.mockResolvedValue({
      total,
      hits: [],
      facets: [
        {
          dimension: 'organism',
          attribute: 'rcsb_entity_source_organism.ncbi_scientific_name',
          buckets,
        },
      ],
    });
    getEntries.mockResolvedValue([]);
    const c = ctx();
    await searchStructures.handler(
      searchStructures.input.parse({
        query: 'kinase',
        content_type: 'experimental',
        facets: ['organism'],
        start: total + 100,
      }),
      c,
    );
    // One joined string carries all three; none may overwrite another.
    const notice = String(getEnrichment(c).notice);
    expect(notice).toMatch(
      new RegExp(`^start ${total + 100} is past the end of the ${total} matches`),
    );
    expect(notice).not.toMatch(/No experimental structures matched/);
    expect(notice).toContain(`organism was capped at ${FACET_CAP} buckets.`);
    expect(notice).toContain('organism buckets cover');
  });

  it('carries the truncation advisory on both consumption surfaces (#52)', async () => {
    const buckets = Array.from({ length: FACET_CAP + 1 }, (_, i) => ({
      label: `org${i}`,
      count: 1,
    }));
    search.mockResolvedValue({
      total: FACET_CAP + 1,
      hits: [{ id: '4HHB', score: 1 }],
      facets: [
        {
          dimension: 'organism',
          attribute: 'rcsb_entity_source_organism.ncbi_scientific_name',
          buckets,
        },
      ],
    });
    getEntries.mockResolvedValue([]);
    const result = (await runToolContract(searchStructures, {
      query: 'kinase',
      facets: ['organism'],
      limit: 1,
    })) as {
      structuredContent: { notice?: string };
      content: Array<{ type: string; text: string }>;
    };

    expect(String(result.structuredContent.notice)).toContain('protein_analyze_collection');
    const [formatted, ...trailer] = result.content;
    expect(formatted?.text).toContain('**organism** (truncated)');
    expect(trailer.map((b) => b.text).join('\n')).toContain('protein_analyze_collection');
  });

  it('composes the coverage gap with the past-end notice (#32, #66)', async () => {
    search.mockResolvedValue({
      total: 1000,
      hits: [],
      facets: [
        {
          dimension: 'method',
          attribute: 'exptl.method',
          buckets: [{ label: 'X-RAY DIFFRACTION', count: 400 }],
        },
      ],
    });
    getEntries.mockResolvedValue([]);
    const c = ctx();
    await searchStructures.handler(
      searchStructures.input.parse({
        query: 'kinase',
        content_type: 'experimental',
        facets: ['method'],
        start: 1000,
      }),
      c,
    );
    const notice = String(getEnrichment(c).notice);
    expect(notice).toMatch(/^start 1000 is past the end of the 1000 matches/);
    expect(notice).not.toMatch(/no experimental structures matched/i);
    expect(notice).toContain('600');
  });

  it('carries the facet coverage gap on both consumption surfaces (#32)', async () => {
    search.mockResolvedValue({
      total: 130104,
      hits: [{ id: '4HHB', score: 1 }],
      facets: [
        {
          dimension: 'method',
          attribute: 'exptl.method',
          buckets: [{ label: 'X-RAY DIFFRACTION', count: 71800 }],
        },
      ],
    });
    getEntries.mockResolvedValue([]);
    const result = (await runToolContract(searchStructures, {
      query: 'kinase',
      facets: ['method'],
      limit: 1,
    })) as {
      structuredContent: { facets: Array<{ missingValueCount: number }>; notice?: string };
      content: Array<{ type: string; text: string }>;
    };

    expect(result.structuredContent.facets[0]?.missingValueCount).toBe(58304);
    expect(String(result.structuredContent.notice)).toContain('58304');
    const [formatted, ...trailer] = result.content;
    expect(formatted?.text).toContain('**method** (58304 with no value)');
    expect(trailer.map((b) => b.text).join('\n')).toContain('58304');
  });

  it('explains an empty facet dimension on both consumption surfaces (#26)', async () => {
    search.mockResolvedValue({
      total: 0,
      hits: [],
      facets: [{ dimension: 'method', attribute: 'exptl.method', buckets: [] }],
    });
    getEntries.mockResolvedValue([]);

    const result = (await runToolContract(searchStructures, {
      query: 'zzzznotaproteinzzzz',
      content_type: 'experimental',
      facets: ['method'],
      limit: 3,
    })) as {
      structuredContent: { facets: unknown[]; notice?: string; totalCount: number };
      content: Array<{ type: string; text: string }>;
    };

    // The empty-dimension fix is presentational — the bucket list stays [].
    expect(result.structuredContent.facets).toEqual([
      { dimension: 'method', buckets: [], missingValueCount: 0 },
    ]);
    expect(result.structuredContent.totalCount).toBe(0);
    expect(String(result.structuredContent.notice)).toMatch(/no experimental structures matched/i);

    const [formatted, ...trailer] = result.content;
    expect(formatted?.text).toContain('**method**');
    expect(formatted?.text).toMatch(/no data/i);
    expect(formatted?.text.trimEnd().endsWith('**method**')).toBe(false);
    // The notice reaches content[] as a separate trailing block, never content[0].
    expect(trailer.map((b) => b.text).join('\n')).toMatch(/no experimental structures matched/i);
  });
});

/** A `runToolContract` result, success or failure, read on both surfaces. */
type ContractResult = {
  isError?: boolean;
  structuredContent: Record<string, unknown> & {
    error?: { code: number; data: { reason: string; recovery?: { hint: string } } };
    hits?: Array<Record<string, unknown>>;
    notice?: string;
  };
  content: Array<{ type: string; text: string }>;
};

const run = async (input: Record<string, unknown>) =>
  (await runToolContract(searchStructures, input)) as ContractResult;

/** Every content[] block joined — the formatted body and the enrichment trailer. */
const allText = (result: ContractResult) => result.content.map((b) => b.text).join('\n');

/** Run the real query builder on what the handler forwards, as the real search does before posting. */
const buildThenReturn = (result: unknown) =>
  search.mockImplementation(async (params: StructureSearchParams) => {
    buildQuery(params);
    return result;
  });

describe('protein_search_structures filters (#86, #95)', () => {
  it('rejects an unknown method with its declared recovery on both surfaces (#86)', async () => {
    buildThenReturn({ total: 0, hits: [] });
    const result = await run({ query: 'hemoglobin', method: 'cryo-ET' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({
      code: -32602,
      data: { reason: 'unknown_method', recovery: { hint: expect.stringMatching(/alias/) } },
    });
    const text = allText(result);
    expect(text).toContain('unknown_method');
    expect(text).toContain('"cryo-ET"');
    expect(text).toContain('SOLID-STATE NMR');
    expect(getEntries).not.toHaveBeenCalled();
  });

  it('passes a method alias through for the query builder to resolve (#86)', async () => {
    buildThenReturn({ total: 0, hits: [] });
    const result = await run({ query: 'hemoglobin', method: 'cryo-EM' });
    expect(result.isError).not.toBe(true);
    expect(search.mock.calls[0]?.[0]).toMatchObject({ text: 'hemoglobin', method: 'cryo-EM' });
  });

  it('lists the accepted methods and organism forms in the input descriptions (#86)', () => {
    const { method, organism, ligand } = searchStructures.input.shape;
    for (const value of ['X-RAY DIFFRACTION', 'SOLID-STATE NMR', 'THEORETICAL MODEL', 'cryo-EM']) {
      expect(method.description).toContain(value);
    }
    expect(organism.description).toMatch(/common name/);
    expect(organism.description).toMatch(/taxon ID/);
    expect(ligand.description).toMatch(/find_ligand/);
  });

  it('states that an active organism or method filter constrains its own facet (#86)', () => {
    expect(searchStructures.description).not.toMatch(/does not constrain by its own active filter/);
    expect(searchStructures.description).toMatch(
      /active organism or method filter also constrains its own facet/,
    );
  });

  it('accepts a ligand as the only criterion and forwards it (#95)', async () => {
    search.mockResolvedValue({ total: 29, hits: [{ id: '1XBB', score: 1 }] });
    getEntries.mockResolvedValue([]);
    const result = await run({ ligand: 'sti' });
    expect(result.isError).not.toBe(true);
    expect(search).toHaveBeenCalledOnce();
    expect(search.mock.calls[0]?.[0]).toMatchObject({ ligand: 'sti' });
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('names the ligand among the criteria no_criteria asks for (#95)', async () => {
    const result = await run({});
    expect(result.structuredContent.error?.data.reason).toBe('no_criteria');
    expect(result.structuredContent.error?.data.recovery?.hint).toMatch(/ligand/);
    expect(allText(result)).toMatch(/ligand to search on/);
    const contract = searchStructures.errors?.find((e) => e.reason === 'no_criteria');
    expect(contract?.when).toMatch(/ligand/);
  });

  it('points a zero-hit ligand search at find_ligand on both surfaces (#95)', async () => {
    for (const content_type of ['experimental', 'all'] as const) {
      search.mockResolvedValue({ total: 0, hits: [] });
      const result = await run({ query: 'SYK', ligand: 'ZZZQQ', content_type });
      const notice = String(result.structuredContent.notice);
      expect(notice).toMatch(/^No (experimental )?structures matched/);
      expect(notice).toContain('protein_track_ligands mode "find_ligand"');
      expect(allText(result)).toContain('protein_track_ligands mode "find_ligand"');
    }
  });

  it('adds no find_ligand pointer without a ligand or when the ligand search matched (#95)', async () => {
    search.mockResolvedValue({ total: 0, hits: [] });
    const unfiltered = await run({ query: 'zzzznotathing', content_type: 'experimental' });
    expect(String(unfiltered.structuredContent.notice)).not.toMatch(/find_ligand/);

    search.mockResolvedValue({ total: 1, hits: [{ id: '1XBB', score: 1 }] });
    getEntries.mockResolvedValue([]);
    const matched = await run({ query: 'SYK', ligand: 'STI' });
    expect(matched.isError).not.toBe(true);
    expect(matched.structuredContent.hits).toHaveLength(1);
    expect(matched.structuredContent).not.toHaveProperty('notice');
  });

  it.each([
    [{ method: 'X-RAY DIFFRACTION' }, 'experimental method', 'method matches'],
    [{ max_resolution: 2.5 }, 'resolution', 'max_resolution matches'],
    [{ ligand: 'STI' }, 'bound ligands', 'ligand matches'],
  ] as const)(
    'explains why %o matches no computed model under predicted content (#86, #95)',
    async (filter, lacking, named) => {
      buildThenReturn({ total: 0, hits: [] });
      const c = ctx();
      await searchStructures.handler(
        searchStructures.input.parse({ query: 'hemoglobin', ...filter, content_type: 'predicted' }),
        c,
      );
      const notice = String(getEnrichment(c).notice);
      expect(notice).toContain(`computed models carry no ${lacking}`);
      expect(notice).toContain(`so ${named} nothing under content_type "predicted"`);
      expect(notice).toMatch(/content_type to "experimental" or "all"/);
      expect(notice).not.toMatch(/Predicted search covers computed models/);
      expect(notice).not.toMatch(/find_ligand/);
    },
  );

  it('names every experimental-only filter supplied, on both surfaces (#86, #95)', async () => {
    buildThenReturn({ total: 0, hits: [] });
    const result = await run({
      method: 'cryo-EM',
      max_resolution: 2.5,
      ligand: 'HEM',
      content_type: 'predicted',
    });
    const fragment =
      'computed models carry no experimental method, resolution, or bound ligands, so method, max_resolution, and ligand match nothing under content_type "predicted"';
    expect(String(result.structuredContent.notice)).toContain(fragment);
    expect(allText(result)).toContain(fragment);
  });

  it('keeps the predicted notice for a zero-hit search with no experimental-only filter (#86)', async () => {
    search.mockResolvedValue({ total: 0, hits: [] });
    const result = await run({ organism: 'human', content_type: 'predicted' });
    // The predicted scope advice leads; a one-word organism adds its own.
    expect(result.structuredContent.notice).toBe(
      'No predicted models matched. Predicted search covers computed models indexed by RCSB; widen content_type to "all" to include experimental structures. organism "human" matches only a taxon with exactly that name, scientific or NCBI common (such as "human"), never a word inside a longer name; for a species, pass its full name (such as "Zika virus") or its NCBI taxon ID.',
    );
  });

  it('keeps the experimental and all notices for the same filters (#86)', async () => {
    for (const [content_type, expected] of [
      [
        'experimental',
        'No experimental structures matched. Broaden the query, drop filters, or widen content_type to "all" to include computed models.',
      ],
      [
        'all',
        'No structures matched in either the experimental or computed-model universe — content_type "all" is already the widest scope. Broaden the query or drop filters.',
      ],
    ] as const) {
      buildThenReturn({ total: 0, hits: [] });
      const result = await run({ method: 'NMR', max_resolution: 1, content_type });
      expect(result.structuredContent.notice).toBe(expected);
    }
  });
});

describe('protein_search_structures sequence alignment (#89)', () => {
  const SEQUENCE = 'MVLSPADKTNVKAAWGKVGA';
  /** 2MGE_1, the tail of the P69905 sequence search (live, start 1357). */
  const ALIGNED_2MGE_1 = {
    identity: 0.25,
    evalue: 0.0006589,
    bitscore: 42,
    alignmentLength: 148,
    queryStart: 1,
    queryEnd: 142,
    targetStart: 1,
    targetEnd: 148,
    targetLength: 154,
  };
  const ALIGNED_AF_P69905 = {
    identity: 1,
    evalue: 4.469e-90,
    bitscore: 291,
    alignmentLength: 142,
    queryStart: 1,
    queryEnd: 142,
    targetStart: 1,
    targetEnd: 142,
    targetLength: 142,
  };

  it('carries every hit’s alignment and the query length once, on both surfaces', async () => {
    search.mockResolvedValue({
      total: 1953,
      queryLength: 142,
      hits: [
        { id: '2MGE_1', score: 0, ...ALIGNED_2MGE_1 },
        { id: 'AF_AFP69905F1_1', score: 1, ...ALIGNED_AF_P69905 },
      ],
    });
    getEntries.mockResolvedValue([]);
    const result = await run({ sequence: SEQUENCE, limit: 2 });

    expect(result.structuredContent.queryLength).toBe(142);
    const [experimental, predicted] = result.structuredContent.hits ?? [];
    expect(experimental).toEqual({
      id: '2MGE',
      entityId: '2MGE_1',
      source: 'experimental',
      score: 0,
      ...ALIGNED_2MGE_1,
    });
    expect(predicted).toEqual({
      id: 'AF_AFP69905F1',
      entityId: 'AF_AFP69905F1_1',
      source: 'predicted',
      score: 1,
      uniprotAccession: 'P69905',
      ...ALIGNED_AF_P69905,
    });

    const text = allText(result);
    expect(text.match(/\*\*Query length:\*\* 142/g)).toHaveLength(1);
    expect(text).toContain(
      '**Score:** 0.000 | **Identity:** 0.25 | **E-value:** 0.0006589 | **Bit score:** 42',
    );
    expect(text).toContain(
      '**Alignment:** length 148 · query 1–142 · target 1–148 · target length 154',
    );
    expect(text).toContain(
      '**Alignment:** length 142 · query 1–142 · target 1–142 · target length 142',
    );
  });

  it('adds no alignment field or query length the service did not report', async () => {
    search.mockResolvedValue({
      total: 2,
      hits: [
        { id: '1A00_1', score: 1 },
        { id: '4HHB_1', score: 0.5, queryStart: 5 },
      ],
    });
    getEntries.mockResolvedValue([]);
    const result = await run({ sequence: SEQUENCE, limit: 2 });

    expect(result.structuredContent).not.toHaveProperty('queryLength');
    const [bare, partial] = result.structuredContent.hits ?? [];
    expect(bare).toEqual({ id: '1A00', entityId: '1A00_1', source: 'experimental', score: 1 });
    expect(partial).toEqual({
      id: '4HHB',
      entityId: '4HHB_1',
      source: 'experimental',
      score: 0.5,
      queryStart: 5,
    });
    const text = allText(result);
    expect(text).not.toMatch(/Query length|Identity|E-value|Bit score/);
    expect(text).toContain('**Alignment:** query 5–?');
    expect(text.match(/\*\*Alignment:\*\*/g)).toHaveLength(1);
  });
});
