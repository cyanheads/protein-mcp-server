/**
 * @fileoverview Tests for protein_analyze_collection: single-dimension and
 * cross-tab facet projection through the tool, content_type → content-universe
 * mapping (including the "all" union), the bucket-cap truncation notice, the
 * experimental-only-dimension notice under predicted content and its composition
 * with the cap notice, the repeated-dimension rejection, the scope enrichment,
 * the realized bucket total across both dimension positions, scope-param
 * forwarding to the facet engine, and format() rendering. RCSB service mocked.
 * @module tests/tools/analyze-collection.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FACET_DIMENSION_NAMES } from '@/services/rcsb/facets.js';
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

  it('maps each content_type to its content universes, unioning "all" (#29)', async () => {
    for (const [contentType, expected] of [
      ['experimental', ['experimental']],
      ['predicted', ['computational']],
      // "all" must be an explicit union: omitting the scope is experimental-only
      // upstream, so every facet count silently excluded computed models.
      ['all', ['experimental', 'computational']],
    ] as const) {
      analyzeFacets.mockClear();
      analyzeFacets.mockResolvedValue({ total: 1, facets: [methodFacet([])] });
      await analyzeCollection.handler(
        analyzeCollection.input.parse({ group_by: ['organism'], content_type: contentType }),
        ctx(),
      );
      expect(analyzeFacets.mock.calls[0]?.[0]).toMatchObject({ contentType: expected });
    }
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
      contentType: ['experimental'],
    });
    expect(getEnrichment(c)).toMatchObject({ scope: 'kinase · Homo sapiens · X-RAY DIFFRACTION' });
  });

  it('caps buckets at bucket_limit and discloses the truncation', async () => {
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
    expect(getEnrichment(c)).toMatchObject({ truncated: true, shown: 2, cap: 2 });
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
    // Counts reconcile end to end (total = parent bucket = child bucket sum) so
    // the assertion isolates truncation from the coverage-gap marker (#32).
    analyzeFacets.mockResolvedValue({
      total: 6,
      facets: [
        {
          dimension: 'method',
          attribute: 'exptl.method',
          buckets: [
            {
              label: 'X-RAY DIFFRACTION',
              count: 6,
              child: {
                dimension: 'release_year',
                attribute: 'rcsb_accession_info.initial_release_date',
                buckets: [
                  { label: '1976', count: 4 },
                  { label: '1977', count: 1 },
                  { label: '1978', count: 1 },
                ],
              },
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
    const child = out.facets[0]?.buckets[0]?.child;
    expect(child?.buckets).toHaveLength(2);
    expect(child?.truncated).toBe(true);
    const text = (analyzeCollection.format!(out)[0] as { text: string }).text;
    expect(text).toContain('release_year → 1976: 4, 1977: 1 (truncated)');
  });

  it('coerces a stringified numeric interval onto the histogram spec (#15)', async () => {
    analyzeFacets.mockResolvedValue({ total: 1, facets: [methodFacet([])] });
    await analyzeCollection.handler(
      analyzeCollection.input.parse({ group_by: ['resolution'], interval: '0.5' }),
      ctx(),
    );
    const [spec] = analyzeFacets.mock.calls[0]![1] as Array<{ interval?: unknown }>;
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
    const [spec] = analyzeFacets.mock.calls[0]![1] as Array<{ interval?: unknown }>;
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

  it('rejects a repeated group_by dimension before any upstream call (#30)', async () => {
    await expect(
      analyzeCollection.handler(
        analyzeCollection.input.parse({ group_by: ['method', 'method'] }),
        ctx(),
      ),
    ).rejects.toMatchObject({
      data: {
        reason: 'duplicate_dimension',
        recovery: { hint: expect.stringContaining('at most once') },
      },
    });
    expect(analyzeFacets).not.toHaveBeenCalled();
  });

  it('rejects every same-value pair, naming the repeated dimension (#30)', async () => {
    for (const dimension of FACET_DIMENSION_NAMES) {
      analyzeFacets.mockClear();
      const err = await Promise.resolve(
        analyzeCollection.handler(
          analyzeCollection.input.parse({ group_by: [dimension, dimension] }),
          ctx(),
        ),
      ).catch((e: Error) => e);
      expect(err).toMatchObject({ data: { reason: 'duplicate_dimension' } });
      expect((err as Error).message).toContain(dimension);
      expect(analyzeFacets).not.toHaveBeenCalled();
    }
  });

  it('leaves unsupported dimension values to the enum boundary (#30)', () => {
    // Two distinct but invalid values still fail schema validation, not the
    // duplicate guard — the two rejections stay independent.
    expect(() => analyzeCollection.input.parse({ group_by: ['bogus', 'alsobogus'] })).toThrow();
  });

  it('explains an experimental-only dimension under predicted content (#27)', async () => {
    for (const dimension of ['method', 'resolution'] as const) {
      analyzeFacets.mockClear();
      analyzeFacets.mockResolvedValue({
        total: 1081,
        facets: [{ dimension, attribute: 'x', buckets: [] }],
      });
      const c = ctx();
      await analyzeCollection.handler(
        analyzeCollection.input.parse({ group_by: [dimension], content_type: 'predicted' }),
        c,
      );
      const notice = String(getEnrichment(c).notice);
      // Anchored: both dimension names appear in the boilerplate ("no experimental
      // method or resolution metadata"), so a substring check would pass even if
      // the notice named the dimension the caller did not group by.
      expect(notice).toMatch(new RegExp(`^${dimension} is empty under content_type "predicted"`));
      expect(notice).toMatch(/computed models carry no experimental/i);
      expect(notice).toMatch(/"experimental" or "all"/);
    }
  });

  it('names both experimental-only dimensions when both are grouped (#27)', async () => {
    analyzeFacets.mockResolvedValue({ total: 1081, facets: [methodFacet([])] });
    const c = ctx();
    await analyzeCollection.handler(
      analyzeCollection.input.parse({
        group_by: ['method', 'resolution'],
        content_type: 'predicted',
      }),
      c,
    );
    expect(String(getEnrichment(c).notice)).toMatch(/method and resolution are empty/i);
  });

  it('rejects a repeated experimental-only dimension instead of naming it once (#27, #30)', async () => {
    // Supersedes the notice-text dedup this case used to exercise: a repeated
    // dimension no longer reaches the advisory, because it no longer reaches the
    // handler body. Two *distinct* experimental-only dimensions still compose one
    // notice — covered above.
    const c = ctx();
    await expect(
      analyzeCollection.handler(
        analyzeCollection.input.parse({
          group_by: ['method', 'method'],
          content_type: 'predicted',
        }),
        c,
      ),
    ).rejects.toMatchObject({ data: { reason: 'duplicate_dimension' } });
    expect(analyzeFacets).not.toHaveBeenCalled();
    expect(getEnrichment(c)).not.toHaveProperty('notice');
  });

  it('fires for an experimental-only dimension in the cross-tab child position (#27)', async () => {
    analyzeFacets.mockResolvedValue({
      total: 1081,
      facets: [
        {
          dimension: 'organism',
          attribute: 'rcsb_entity_source_organism.ncbi_scientific_name',
          // Upstream drops the nested facet key entirely; the service still emits
          // the requested child, with an empty bucket list (#31).
          buckets: [
            {
              label: 'Mus musculus',
              count: 36,
              child: { dimension: 'method', attribute: 'exptl.method', buckets: [] },
            },
          ],
        },
      ],
    });
    const c = ctx();
    const out = await analyzeCollection.handler(
      analyzeCollection.input.parse({
        group_by: ['organism', 'method'],
        content_type: 'predicted',
      }),
      c,
    );
    // The requested second dimension stays in the output shape rather than
    // vanishing: buckets [] says it aggregated to nothing, and the gap equals
    // the whole parent bucket (#31).
    expect(out.facets[0]?.buckets[0]?.child).toEqual({
      dimension: 'method',
      buckets: [],
      missingValueCount: 36,
    });
    expect(String(getEnrichment(c).notice)).toMatch(/^method is empty under content_type/i);
  });

  it('renders an empty cross-tab child instead of dropping the dimension (#31)', async () => {
    analyzeFacets.mockResolvedValue({
      total: 1062058,
      facets: [
        {
          dimension: 'organism',
          attribute: 'rcsb_entity_source_organism.ncbi_scientific_name',
          buckets: [
            {
              label: 'Glycine max',
              count: 55796,
              child: { dimension: 'method', attribute: 'exptl.method', buckets: [] },
            },
          ],
        },
      ],
    });
    const c = ctx();
    const out = await analyzeCollection.handler(
      analyzeCollection.input.parse({
        group_by: ['organism', 'method'],
        content_type: 'predicted',
      }),
      c,
    );
    const text = (analyzeCollection.format!(out)[0] as { text: string }).text;
    expect(text).toContain('method → _no data in this scope_ (55796 with no value)');
    // An empty child earns no coverage advisory of its own — the #27 scope notice
    // is the explanation, and a 100%-gap fragment on top would be noise.
    expect(String(getEnrichment(c).notice)).not.toMatch(/method buckets cover/);
  });

  it('keeps the empty child on both consumption surfaces (#31)', async () => {
    analyzeFacets.mockResolvedValue({
      total: 1081,
      facets: [
        {
          dimension: 'organism',
          attribute: 'rcsb_entity_source_organism.ncbi_scientific_name',
          buckets: [
            {
              label: 'Mus musculus',
              count: 36,
              child: { dimension: 'method', attribute: 'exptl.method', buckets: [] },
            },
          ],
        },
      ],
    });
    const result = (await runToolContract(analyzeCollection, {
      group_by: ['organism', 'method'],
      content_type: 'predicted',
    })) as {
      structuredContent: { facets: Array<{ buckets: Array<{ child?: unknown }> }> };
      content: Array<{ type: string; text: string }>;
    };

    expect(result.structuredContent.facets[0]?.buckets[0]?.child).toEqual({
      dimension: 'method',
      buckets: [],
      missingValueCount: 36,
    });
    expect(result.content[0]?.text).toMatch(/method → _no data in this scope_/);
  });

  it('stays silent under experimental / all, and for unaffected dimensions (#27)', async () => {
    for (const [group_by, content_type] of [
      [['method'], 'experimental'],
      [['resolution'], 'experimental'],
      // #29 makes "all" a real union, so method/resolution do carry data there.
      [['method'], 'all'],
      [['resolution'], 'all'],
      [['organism'], 'predicted'],
      [['polymer_type'], 'predicted'],
      [['release_year'], 'predicted'],
      [['molecular_weight'], 'predicted'],
      [['organism', 'release_year'], 'predicted'],
    ] as const) {
      analyzeFacets.mockClear();
      // Bucket sum equals the total, so no coverage advisory competes here (#32).
      analyzeFacets.mockResolvedValue({
        total: 5,
        facets: [{ dimension: group_by[0], attribute: 'x', buckets: [{ label: 'v', count: 5 }] }],
      });
      const c = ctx();
      await analyzeCollection.handler(
        analyzeCollection.input.parse({ group_by: [...group_by], content_type }),
        c,
      );
      expect(getEnrichment(c)).not.toHaveProperty('notice');
    }
  });

  it('composes the bucket-cap and predicted-dimension advisories in one notice (#27)', async () => {
    // The real shape of `group_by: ["organism", "method"]` under predicted content:
    // 413 organism buckets blow the cap while the nested method facet aggregates
    // to nothing, so every parent carries an empty child (#31).
    const buckets = Array.from({ length: 6 }, (_, i) => ({
      label: `org${i}`,
      count: 6 - i,
      child: { dimension: 'method', attribute: 'exptl.method', buckets: [] },
    }));
    analyzeFacets.mockResolvedValue({
      total: 1081,
      facets: [
        {
          dimension: 'organism',
          attribute: 'rcsb_entity_source_organism.ncbi_scientific_name',
          buckets,
        },
      ],
    });
    const c = ctx();
    await analyzeCollection.handler(
      analyzeCollection.input.parse({
        group_by: ['organism', 'method'],
        content_type: 'predicted',
        bucket_limit: 2,
      }),
      c,
    );
    const enrichment = getEnrichment(c);
    // Neither advisory may overwrite the other on the shared `notice` field.
    expect(String(enrichment.notice)).toMatch(/exceeded 2 buckets and were capped/i);
    expect(String(enrichment.notice)).toMatch(/method is empty under content_type "predicted"/i);
    // The structured truncation disclosure survives the composition.
    expect(enrichment).toMatchObject({ truncated: true, shown: 2, cap: 2 });
  });

  it('carries the predicted-dimension notice on both consumption surfaces (#27)', async () => {
    analyzeFacets.mockResolvedValue({
      total: 1081,
      facets: [methodFacet([])],
    });
    const result = (await runToolContract(analyzeCollection, {
      group_by: ['method'],
      content_type: 'predicted',
      query: 'hemoglobin',
      bucket_limit: 3,
    })) as {
      structuredContent: { total: number; facets: unknown[]; notice?: string };
      content: Array<{ type: string; text: string }>;
    };

    expect(result.structuredContent.total).toBe(1081);
    expect(result.structuredContent.facets).toEqual([
      { dimension: 'method', buckets: [], missingValueCount: 1081 },
    ]);
    // A dimension that aggregated to nothing gets the scope notice, not a
    // redundant 100%-coverage-gap fragment on top of it (#32).
    expect(String(result.structuredContent.notice)).toMatch(/^method is empty/i);

    const [formatted, ...trailer] = result.content;
    // A non-zero total over an empty section is exactly the shape that read as a bug.
    expect(formatted?.text).toContain('Collection profile — 1081 entries');
    expect(formatted?.text).toMatch(/no data/i);
    expect(trailer.map((b) => b.text).join('\n')).toMatch(/method is empty/i);
  });

  it('discloses a facet coverage gap the buckets do not account for (#32)', async () => {
    // group_by ["method"] under content_type "all": computed models carry no
    // experimental method, so 58304 of 130104 matches fall in no bucket.
    analyzeFacets.mockResolvedValue({
      total: 130104,
      facets: [
        methodFacet([
          { label: 'X-RAY DIFFRACTION', count: 65000 },
          { label: 'ELECTRON MICROSCOPY', count: 6800 },
        ]),
      ],
    });
    const c = ctx();
    const out = await analyzeCollection.handler(
      analyzeCollection.input.parse({
        group_by: ['method'],
        query: 'kinase',
        content_type: 'all',
      }),
      c,
    );
    expect(out.facets[0]?.missingValueCount).toBe(58304);
    const notice = String(getEnrichment(c).notice);
    expect(notice).toContain('method');
    expect(notice).toContain('58304');
    expect(notice).toMatch(/44\.8%/);
  });

  it('discloses a record-level gap inside the experimental universe (#32)', async () => {
    // resolution under content_type "experimental": solution-NMR entries carry no
    // diffraction resolution, so the gap needs no computed model to appear.
    analyzeFacets.mockResolvedValue({
      total: 71862,
      facets: [
        {
          dimension: 'resolution',
          attribute: 'rcsb_entry_info.resolution_combined',
          buckets: [{ label: '1.5', count: 69155, rangeFrom: 1.5, rangeTo: 2.0 }],
        },
      ],
    });
    const c = ctx();
    await analyzeCollection.handler(
      analyzeCollection.input.parse({
        group_by: ['resolution'],
        query: 'kinase',
        content_type: 'experimental',
      }),
      c,
    );
    expect(String(getEnrichment(c).notice)).toMatch(/resolution.*2707/);
  });

  it('stays silent on a rounding-scale coverage gap (#32)', async () => {
    // method under content_type "experimental": 62 of 71862 (0.09%).
    analyzeFacets.mockResolvedValue({
      total: 71862,
      facets: [methodFacet([{ label: 'X-RAY DIFFRACTION', count: 71800 }])],
    });
    const c = ctx();
    const out = await analyzeCollection.handler(
      analyzeCollection.input.parse({ group_by: ['method'], content_type: 'experimental' }),
      c,
    );
    // The structural field is unconditional; only the prose is gated.
    expect(out.facets[0]?.missingValueCount).toBe(62);
    expect(getEnrichment(c)).not.toHaveProperty('notice');
  });

  it('reports zero gap when a multi-valued dimension over-counts the total (#32)', async () => {
    // An entry with two source organisms lands in two organism buckets, so the
    // bucket sum exceeds the total. Over-counting is not missing coverage.
    analyzeFacets.mockResolvedValue({
      total: 71862,
      facets: [
        {
          dimension: 'organism',
          attribute: 'rcsb_entity_source_organism.ncbi_scientific_name',
          buckets: [
            { label: 'Homo sapiens', count: 50000 },
            { label: 'Escherichia coli', count: 34453 },
          ],
        },
      ],
    });
    const c = ctx();
    const out = await analyzeCollection.handler(
      analyzeCollection.input.parse({ group_by: ['organism'], content_type: 'experimental' }),
      c,
    );
    expect(out.facets[0]?.missingValueCount).toBe(0);
    expect(getEnrichment(c)).not.toHaveProperty('notice');
  });

  it('measures the coverage gap before the bucket cap slices the list (#32)', async () => {
    // 10 buckets of 100 = 1000 accounted for out of 1200; the cap keeps 2 of them.
    // A gap measured after the slice would read 1000, conflating the two conditions.
    const buckets = Array.from({ length: 10 }, (_, i) => ({ label: `m${i}`, count: 100 }));
    analyzeFacets.mockResolvedValue({ total: 1200, facets: [methodFacet(buckets)] });
    const c = ctx();
    const out = await analyzeCollection.handler(
      analyzeCollection.input.parse({ group_by: ['method'], bucket_limit: 2 }),
      c,
    );
    expect(out.facets[0]?.buckets).toHaveLength(2);
    expect(out.facets[0]?.truncated).toBe(true);
    expect(out.facets[0]?.missingValueCount).toBe(200);
    const notice = String(getEnrichment(c).notice);
    expect(notice).toMatch(/capped/i);
    expect(notice).toContain('200');
    // The cap disclosure stays structurally separate from the coverage gap.
    expect(getEnrichment(c)).toMatchObject({ truncated: true, shown: 2, cap: 2 });
  });

  it('measures a cross-tab child gap against its parent bucket (#32)', async () => {
    analyzeFacets.mockResolvedValue({
      total: 130104,
      facets: [
        {
          dimension: 'polymer_type',
          attribute: 'rcsb_entry_info.polymer_composition',
          buckets: [
            {
              label: 'homomeric protein',
              count: 98505,
              child: {
                dimension: 'method',
                attribute: 'exptl.method',
                buckets: [{ label: 'X-RAY DIFFRACTION', count: 40903 }],
              },
            },
            {
              label: 'heteromeric protein',
              count: 19214,
              child: {
                dimension: 'method',
                attribute: 'exptl.method',
                buckets: [{ label: 'X-RAY DIFFRACTION', count: 18527 }],
              },
            },
          ],
        },
      ],
    });
    const c = ctx();
    const out = await analyzeCollection.handler(
      analyzeCollection.input.parse({
        group_by: ['polymer_type', 'method'],
        content_type: 'all',
      }),
      c,
    );
    expect(out.facets[0]?.missingValueCount).toBe(12385);
    expect(out.facets[0]?.buckets[0]?.child?.missingValueCount).toBe(57602);
    expect(out.facets[0]?.buckets[1]?.child?.missingValueCount).toBe(687);
    // The child dimension is aggregated into one advisory, not one per bucket.
    const notice = String(getEnrichment(c).notice);
    expect(notice.match(/method buckets/g)).toHaveLength(1);
    const text = (analyzeCollection.format!(out)[0] as { text: string }).text;
    expect(text).toContain('(57602 with no value)');
  });

  it('composes the coverage gap with the cap and predicted-scope notices (#32)', async () => {
    const buckets = Array.from({ length: 6 }, (_, i) => ({
      label: `org${i}`,
      count: 100,
      child: { dimension: 'method', attribute: 'exptl.method', buckets: [] },
    }));
    analyzeFacets.mockResolvedValue({
      total: 1200,
      facets: [
        {
          dimension: 'organism',
          attribute: 'rcsb_entity_source_organism.ncbi_scientific_name',
          buckets,
        },
      ],
    });
    const c = ctx();
    await analyzeCollection.handler(
      analyzeCollection.input.parse({
        group_by: ['organism', 'method'],
        content_type: 'predicted',
        bucket_limit: 2,
      }),
      c,
    );
    const notice = String(getEnrichment(c).notice);
    expect(notice).toMatch(/exceeded 2 buckets and were capped/i);
    expect(notice).toMatch(/method is empty under content_type "predicted"/i);
    expect(notice).toMatch(/organism buckets cover 600 of 1200/i);
  });

  it('carries the coverage gap on both consumption surfaces (#32)', async () => {
    analyzeFacets.mockResolvedValue({
      total: 130104,
      facets: [methodFacet([{ label: 'X-RAY DIFFRACTION', count: 71800 }])],
    });
    const result = (await runToolContract(analyzeCollection, {
      group_by: ['method'],
      query: 'kinase',
      content_type: 'all',
    })) as {
      structuredContent: { facets: Array<{ missingValueCount: number }>; notice?: string };
      content: Array<{ type: string; text: string }>;
    };

    expect(result.structuredContent.facets[0]?.missingValueCount).toBe(58304);
    expect(String(result.structuredContent.notice)).toContain('58304');

    const [formatted, ...trailer] = result.content;
    expect(formatted?.text).toContain('**method** (58304 with no value)');
    // The notice reaches content[] as a separate trailing block, never content[0].
    expect(formatted?.text).not.toContain('buckets cover');
    expect(trailer.map((b) => b.text).join('\n')).toContain('58304');
  });

  it('reports the realized bucket total for a single-dimension breakdown (#36)', async () => {
    analyzeFacets.mockResolvedValue({
      total: 1000,
      facets: [
        methodFacet([
          { label: 'X-RAY DIFFRACTION', count: 800 },
          { label: 'EM', count: 200 },
        ]),
      ],
    });
    const c = ctx();
    await analyzeCollection.handler(analyzeCollection.input.parse({ group_by: ['method'] }), c);
    expect(getEnrichment(c)).toMatchObject({ bucketsReturned: 2 });
  });

  it('counts parent and nested child buckets together for a cross-tab (#36)', async () => {
    analyzeFacets.mockResolvedValue({
      total: 1000,
      facets: [
        methodFacet([
          {
            label: 'X-RAY DIFFRACTION',
            count: 800,
            child: {
              dimension: 'release_year',
              attribute: 'rcsb_accession_info.initial_release_date',
              buckets: [
                { label: '2020', count: 400 },
                { label: '2021', count: 400 },
              ],
            },
          },
          {
            label: 'EM',
            count: 200,
            child: {
              dimension: 'release_year',
              attribute: 'rcsb_accession_info.initial_release_date',
              buckets: [{ label: '2021', count: 200 }],
            },
          },
        ]),
      ],
    });
    const c = ctx();
    await analyzeCollection.handler(
      analyzeCollection.input.parse({ group_by: ['method', 'release_year'] }),
      c,
    );
    // 2 parent buckets + 3 child buckets — the size bucket_limit alone does not convey.
    expect(getEnrichment(c)).toMatchObject({ bucketsReturned: 5 });
  });

  it('reports the cap-reached cross-tab size as cap × (1 + cap) (#36)', async () => {
    // Both levels blow the cap: the response holds bucket_limit parents, each
    // carrying bucket_limit children — the multiplication the parameter name hides.
    const buckets = Array.from({ length: 8 }, (_, i) => ({
      label: `org${i}`,
      count: 100,
      child: {
        dimension: 'method',
        attribute: 'exptl.method',
        buckets: Array.from({ length: 8 }, (_, j) => ({ label: `m${j}`, count: 12 })),
      },
    }));
    analyzeFacets.mockResolvedValue({
      total: 800,
      facets: [
        {
          dimension: 'organism',
          attribute: 'rcsb_entity_source_organism.ncbi_scientific_name',
          buckets,
        },
      ],
    });
    const c = ctx();
    const out = await analyzeCollection.handler(
      analyzeCollection.input.parse({ group_by: ['organism', 'method'], bucket_limit: 3 }),
      c,
    );
    expect(out.facets[0]?.truncated).toBe(true);
    expect(out.facets[0]?.buckets[0]?.child?.truncated).toBe(true);
    // shown counts the capped dimension alone (3); bucketsReturned counts the response (12).
    expect(getEnrichment(c)).toMatchObject({
      truncated: true,
      shown: 3,
      cap: 3,
      bucketsReturned: 12,
    });
  });

  it('reports zero buckets for a zero-match scope (#36)', async () => {
    analyzeFacets.mockResolvedValue({ total: 0, facets: [methodFacet([])] });
    const c = ctx();
    await analyzeCollection.handler(
      analyzeCollection.input.parse({ group_by: ['method'], query: 'zzzznotathing' }),
      c,
    );
    expect(getEnrichment(c)).toMatchObject({ bucketsReturned: 0 });
  });

  it('enriches nothing when the input is rejected before the upstream call (#36)', async () => {
    const c = ctx();
    await expect(
      analyzeCollection.handler(
        analyzeCollection.input.parse({ group_by: ['method', 'method'] }),
        c,
      ),
    ).rejects.toMatchObject({ data: { reason: 'duplicate_dimension' } });
    expect(getEnrichment(c)).not.toHaveProperty('bucketsReturned');
  });

  it('carries the realized bucket total on both consumption surfaces (#36)', async () => {
    analyzeFacets.mockResolvedValue({
      total: 1000,
      facets: [
        methodFacet([
          {
            label: 'X-RAY DIFFRACTION',
            count: 1000,
            child: {
              dimension: 'release_year',
              attribute: 'rcsb_accession_info.initial_release_date',
              buckets: [
                { label: '2020', count: 600 },
                { label: '2021', count: 400 },
              ],
            },
          },
        ]),
      ],
    });
    const result = (await runToolContract(analyzeCollection, {
      group_by: ['method', 'release_year'],
    })) as {
      structuredContent: { bucketsReturned?: number };
      content: Array<{ type: string; text: string }>;
    };

    expect(result.structuredContent.bucketsReturned).toBe(3);
    const [formatted, ...trailer] = result.content;
    // The realized total is agent context, not part of the rendered profile.
    expect(formatted?.text).not.toContain('bucketsReturned');
    expect(trailer.map((b) => b.text).join('\n')).toContain('bucketsReturned');
    expect(trailer.map((b) => b.text).join('\n')).toContain('3');
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

  it('format() explains a dimension that aggregated to nothing (#26)', () => {
    const text = (
      analyzeCollection.format!({
        total: 1081,
        facets: [{ dimension: 'method', buckets: [], missingValueCount: 1081 }],
      })[0] as {
        text: string;
      }
    ).text;
    expect(text).toContain('**method**');
    expect(text).toMatch(/no data/i);
    expect(text.trimEnd().endsWith('**method**')).toBe(false);
  });

  it('format() renders the total and per-bucket lines', () => {
    const blocks = analyzeCollection.format!({
      total: 1000,
      facets: [
        {
          dimension: 'method',
          missingValueCount: 200,
          buckets: [{ label: 'X-RAY DIFFRACTION', count: 800 }],
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Collection profile — 1000 entries');
    expect(text).toContain('**method**');
    expect(text).toContain('- X-RAY DIFFRACTION: 800');
  });
});
