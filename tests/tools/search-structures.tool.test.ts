/**
 * @fileoverview Tests for protein_search_structures: the no-criteria guard,
 * content_type → content-universe scoping (including the "all" union),
 * computed-model (AlphaFold) ID parsing into a UniProt accession, experimental
 * metadata enrichment, the total/echo/empty-notice enrichment, and the
 * empty-facet-dimension rendering across both consumption surfaces. RCSB mocked.
 * @module tests/tools/search-structures.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const search = vi.fn();
const getEntries = vi.fn();
vi.mock('@/services/rcsb/rcsb-service.js', () => ({
  getRcsbService: () => ({ search, getEntries }),
}));

import { getServerConfig } from '@/config/server-config.js';
import { searchStructures } from '@/mcp-server/tools/definitions/search-structures.tool.js';

const ctx = () => createMockContext({ errors: searchStructures.errors });
const FACET_CAP = getServerConfig().facetBucketCap;

beforeEach(() => vi.clearAllMocks());

describe('protein_search_structures', () => {
  it('throws no_criteria (with its declared recovery hint) when nothing to search on', async () => {
    const input = searchStructures.input.parse({});
    await expect(searchStructures.handler(input, ctx())).rejects.toMatchObject({
      data: {
        reason: 'no_criteria',
        recovery: { hint: expect.stringContaining('free-text query') },
      },
    });
  });

  it('marks nested cross-tab child dimensions as truncated in the shared facet projection (#13)', async () => {
    // Simulate a nested facet from upstream whose child list exceeds the bucket cap.
    const childBuckets = Array.from({ length: FACET_CAP + 3 }, (_, i) => ({
      label: String(2000 + i),
      count: FACET_CAP + 3 - i,
    }));
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
              children: [
                {
                  dimension: 'release_year',
                  attribute: 'rcsb_accession_info.initial_release_date',
                  buckets: childBuckets,
                },
              ],
            },
          ],
        },
      ],
    });
    getEntries.mockResolvedValue([]);
    const out = await searchStructures.handler(
      searchStructures.input.parse({ query: 'hemoglobin', facets: ['method', 'release_year'] }),
      ctx(),
    );
    const child = out.facets?.[0]?.buckets[0]?.children?.[0];
    expect(child?.buckets).toHaveLength(FACET_CAP);
    expect(child?.truncated).toBe(true);
    // format() marks the nested truncation in the text surface too.
    const text = (searchStructures.format!(out)[0] as { text: string }).text;
    expect(text).toContain('release_year →');
    expect(text).toContain('(truncated)');
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
      organism: 'Homo sapiens',
    });
    expect(getEnrichment(c)).toMatchObject({ totalCount: 9064, effectiveQuery: 'hemoglobin' });
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
    const out = await searchStructures.handler(
      searchStructures.input.parse({ query: 'kinase', facets: ['organism'] }),
      ctx(),
    );
    expect(out.facets?.[0]?.truncated).toBe(true);
    expect(out.facets?.[0]?.buckets).toHaveLength(FACET_CAP);
    expect(out.facets?.[0]?.missingValueCount).toBe(500);
  });

  it('composes the coverage gap with the zero-hit notice (#32)', async () => {
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
      }),
      c,
    );
    const notice = String(getEnrichment(c).notice);
    expect(notice).toMatch(/no experimental structures matched/i);
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
