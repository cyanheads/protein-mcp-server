/**
 * @fileoverview Tests for protein_analyze_collection: single-dimension and
 * cross-tab facet projection through the tool, content_type → ContentType mapping,
 * the bucket-cap truncation notice, the scope enrichment, scope-param forwarding to
 * the facet engine, and format() rendering. RCSB service mocked.
 * @module tests/tools/analyze-collection.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FacetDimension } from '@/services/rcsb/types.js';

const analyzeFacets = vi.fn();
vi.mock('@/services/rcsb/rcsb-service.js', () => ({
  getRcsbService: () => ({ analyzeFacets }),
}));

import { analyzeCollection } from '@/mcp-server/tools/definitions/analyze-collection.tool.js';

const ctx = () => createMockContext({ errors: analyzeCollection.errors });

const methodFacet = (buckets: FacetDimension['buckets']): FacetDimension => ({
  dimension: 'method',
  attribute: 'exptl.method',
  buckets,
});

beforeEach(() => vi.clearAllMocks());

describe('protein_analyze_collection', () => {
  it('returns a single-dimension breakdown', async () => {
    analyzeFacets.mockResolvedValue({
      total: 1000,
      facets: [
        methodFacet([
          { label: 'X-RAY DIFFRACTION', count: 800 },
          { label: 'EM', count: 200 },
        ]),
      ],
    });
    const out = await analyzeCollection.handler(
      analyzeCollection.input.parse({ group_by: ['method'] }),
      ctx(),
    );
    expect(out.total).toBe(1000);
    expect(out.facets[0]?.buckets).toHaveLength(2);
  });

  it('returns total 0 with empty buckets for a zero-match scope (no throw)', async () => {
    analyzeFacets.mockResolvedValue({ total: 0, facets: [methodFacet([])] });
    const out = await analyzeCollection.handler(
      analyzeCollection.input.parse({ group_by: ['method'], query: 'zzzznotathing' }),
      ctx(),
    );
    expect(out.total).toBe(0);
    expect(out.facets[0]?.buckets).toEqual([]);
  });

  it('maps content_type predicted → computational and all → undefined scope', async () => {
    analyzeFacets.mockResolvedValue({ total: 1, facets: [methodFacet([])] });

    await analyzeCollection.handler(
      analyzeCollection.input.parse({ group_by: ['method'], content_type: 'predicted' }),
      ctx(),
    );
    expect(analyzeFacets.mock.calls[0]?.[0]).toMatchObject({ contentType: 'computational' });

    analyzeFacets.mockClear();
    analyzeFacets.mockResolvedValue({ total: 1, facets: [methodFacet([])] });
    await analyzeCollection.handler(
      analyzeCollection.input.parse({ group_by: ['method'], content_type: 'all' }),
      ctx(),
    );
    // "all" drops the contentType filter entirely.
    expect(analyzeFacets.mock.calls[0]?.[0]).not.toHaveProperty('contentType');
  });

  it('forwards query / organism / method / max_resolution scope to the facet engine', async () => {
    analyzeFacets.mockResolvedValue({ total: 5, facets: [methodFacet([])] });
    const c = ctx();
    await analyzeCollection.handler(
      analyzeCollection.input.parse({
        group_by: ['method'],
        query: 'kinase',
        organism: 'Homo sapiens',
        method: 'X-RAY DIFFRACTION',
        max_resolution: 2.5,
      }),
      c,
    );
    expect(analyzeFacets.mock.calls[0]?.[0]).toMatchObject({
      text: 'kinase',
      organism: 'Homo sapiens',
      method: 'X-RAY DIFFRACTION',
      maxResolution: 2.5,
      contentType: 'experimental',
    });
    expect(getEnrichment(c)).toMatchObject({ scope: 'kinase · Homo sapiens · X-RAY DIFFRACTION' });
  });

  it('caps buckets at bucket_limit and emits a truncation notice', async () => {
    const buckets = Array.from({ length: 5 }, (_, i) => ({ label: `org${i}`, count: 5 - i }));
    analyzeFacets.mockResolvedValue({
      total: 50,
      facets: [{ ...methodFacet(buckets), dimension: 'organism' }],
    });
    const c = ctx();
    const out = await analyzeCollection.handler(
      analyzeCollection.input.parse({ group_by: ['organism'], bucket_limit: 2 }),
      c,
    );
    expect(out.facets[0]?.buckets).toHaveLength(2);
    expect(out.facets[0]?.truncated).toBe(true);
    expect(String(getEnrichment(c).notice)).toMatch(/capped/i);
  });

  it('builds a nested facet spec for a two-dimension cross-tab', async () => {
    analyzeFacets.mockResolvedValue({ total: 1, facets: [methodFacet([])] });
    await analyzeCollection.handler(
      analyzeCollection.input.parse({ group_by: ['method', 'release_year'] }),
      ctx(),
    );
    const specs = analyzeFacets.mock.calls[0]?.[1] as Array<{
      dimension: string;
      child?: { dimension: string };
    }>;
    expect(specs[0]).toMatchObject({ dimension: 'method', child: { dimension: 'release_year' } });
  });

  it('marks nested cross-tab child dimensions truncated over bucket_limit (#13)', async () => {
    analyzeFacets.mockResolvedValue({
      total: 100,
      facets: [
        {
          dimension: 'method',
          attribute: 'exptl.method',
          buckets: [
            {
              label: 'X-RAY DIFFRACTION',
              count: 90,
              children: [
                {
                  dimension: 'release_year',
                  attribute: 'rcsb_accession_info.initial_release_date',
                  buckets: [
                    { label: '1976', count: 4 },
                    { label: '1977', count: 1 },
                    { label: '1978', count: 1 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const out = await analyzeCollection.handler(
      analyzeCollection.input.parse({
        group_by: ['method', 'release_year'],
        query: 'hemoglobin',
        bucket_limit: 2,
      }),
      ctx(),
    );
    const child = out.facets[0]?.buckets[0]?.children?.[0];
    expect(child?.buckets).toHaveLength(2);
    expect(child?.truncated).toBe(true);
    const text = (analyzeCollection.format?.(out)?.[0] as { text: string }).text;
    expect(text).toContain('release_year → 1976: 4, 1977: 1 (truncated)');
  });

  it('coerces a stringified numeric interval onto the histogram spec (#15)', async () => {
    analyzeFacets.mockResolvedValue({ total: 1, facets: [methodFacet([])] });
    await analyzeCollection.handler(
      analyzeCollection.input.parse({ group_by: ['resolution'], interval: '0.5' }),
      ctx(),
    );
    const [spec] = analyzeFacets.mock.calls[0]?.[1] as Array<{ interval?: unknown }>;
    expect(spec?.interval).toBe(0.5); // coerced to a number, not the string "0.5"
  });

  it('parses a string and a number interval identically (#15)', () => {
    const fromStr = analyzeCollection.input.parse({ group_by: ['resolution'], interval: '0.5' });
    const fromNum = analyzeCollection.input.parse({ group_by: ['resolution'], interval: 0.5 });
    expect(fromStr.interval).toBe(0.5);
    expect(fromNum.interval).toBe(0.5);
  });

  it('keeps a period interval string on the date-histogram arm (#15)', async () => {
    analyzeFacets.mockResolvedValue({ total: 1, facets: [methodFacet([])] });
    // "year" coerces to NaN on the numeric arm (rejected by .positive()) → enum arm.
    const parsed = analyzeCollection.input.parse({ group_by: ['release_year'], interval: 'year' });
    expect(parsed.interval).toBe('year');
    await analyzeCollection.handler(parsed, ctx());
    const [spec] = analyzeFacets.mock.calls[0]?.[1] as Array<{ interval?: unknown }>;
    expect(spec?.interval).toBe('year');
  });

  it('coerces stringified max_resolution and bucket_limit (#15)', async () => {
    const buckets = Array.from({ length: 5 }, (_, i) => ({ label: `org${i}`, count: 5 - i }));
    analyzeFacets.mockResolvedValue({
      total: 50,
      facets: [{ ...methodFacet(buckets), dimension: 'organism' }],
    });
    const out = await analyzeCollection.handler(
      analyzeCollection.input.parse({
        group_by: ['organism'],
        max_resolution: '2.5',
        bucket_limit: '2',
      }),
      ctx(),
    );
    expect(analyzeFacets.mock.calls[0]?.[0]).toMatchObject({ maxResolution: 2.5 });
    expect(out.facets[0]?.buckets).toHaveLength(2); // bucket_limit "2" applied as 2
  });

  it('carries the declared recovery hint on the unknown_dimension guard (#10)', async () => {
    const base = analyzeCollection.input.parse({ group_by: ['method'] });
    await expect(analyzeCollection.handler({ ...base, group_by: [] }, ctx())).rejects.toMatchObject(
      {
        data: {
          reason: 'unknown_dimension',
          recovery: { hint: expect.stringContaining('supported dimension') },
        },
      },
    );
  });

  it('output conforms to the declared schema', async () => {
    analyzeFacets.mockResolvedValue({
      total: 1000,
      facets: [methodFacet([{ label: 'X-RAY DIFFRACTION', count: 800 }])],
    });
    const out = await analyzeCollection.handler(
      analyzeCollection.input.parse({ group_by: ['method'] }),
      ctx(),
    );
    expect(out).toEqual(expect.schemaMatching(analyzeCollection.output));
  });

  it('format() renders the total and per-bucket lines', () => {
    const blocks = analyzeCollection.format?.({
      total: 1000,
      facets: [{ dimension: 'method', buckets: [{ label: 'X-RAY DIFFRACTION', count: 800 }] }],
    });
    const text = (blocks?.[0] as { text: string }).text;
    expect(text).toContain('Collection profile — 1000 entries');
    expect(text).toContain('**method**');
    expect(text).toContain('- X-RAY DIFFRACTION: 800');
  });
});
