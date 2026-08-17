/**
 * @fileoverview Tests for the shared facet projection helpers: toFacetOutput
 * (bucket cap + truncation flag + nested-child capping + the per-dimension
 * coverage gap), renderFacets (the markdown twin, including the truncation
 * marker, the coverage marker, the nested cross-tab line shape, and the
 * explanation that replaces a bare empty-dimension heading), and coverageNotices
 * (the materiality filter that decides which gaps earn prose).
 * @module tests/tools/_schemas.test
 */

import { describe, expect, it } from 'vitest';
import {
  coverageNotices,
  renderFacets,
  toFacetOutput,
} from '@/mcp-server/tools/definitions/_schemas.js';
import type { FacetDimension } from '@/services/rcsb/types.js';

const dim = (buckets: FacetDimension['buckets']): FacetDimension => ({
  dimension: 'method',
  attribute: 'exptl.method',
  buckets,
});

const childDim = (buckets: FacetDimension['buckets']): FacetDimension => ({
  dimension: 'release_year',
  attribute: 'rcsb_accession_info.initial_release_date',
  buckets,
});

describe('toFacetOutput', () => {
  it('passes through buckets under the cap without a truncated flag', () => {
    const out = toFacetOutput(
      dim([
        { label: 'X-RAY', count: 800 },
        { label: 'EM', count: 200 },
      ]),
      50,
      1000,
    );
    expect(out.buckets).toHaveLength(2);
    expect(out).not.toHaveProperty('truncated');
  });

  it('caps buckets at the limit and sets truncated:true', () => {
    const buckets = Array.from({ length: 10 }, (_, i) => ({ label: `v${i}`, count: 10 - i }));
    const out = toFacetOutput(dim(buckets), 3, 55);
    expect(out.buckets).toHaveLength(3);
    expect(out.buckets.map((b) => b.label)).toEqual(['v0', 'v1', 'v2']);
    expect(out.truncated).toBe(true);
  });

  it('treats exactly cap buckets as not truncated', () => {
    const buckets = Array.from({ length: 3 }, (_, i) => ({ label: `v${i}`, count: 1 }));
    expect(toFacetOutput(dim(buckets), 3, 3)).not.toHaveProperty('truncated');
  });

  it('projects and caps the nested cross-tab child independently', () => {
    const out = toFacetOutput(
      dim([
        {
          label: 'X-RAY',
          count: 800,
          child: {
            dimension: 'release_year',
            attribute: 'rcsb_accession_info.initial_release_date',
            buckets: [
              { label: '2019', count: 50 },
              { label: '2020', count: 60 },
              { label: '2021', count: 70 },
            ],
          },
        },
      ]),
      2,
      800,
    );
    // Child buckets capped at 2 as well, and the child carries its own truncation flag (#13).
    expect(out.buckets[0]?.child?.buckets).toHaveLength(2);
    expect(out.buckets[0]?.child).toMatchObject({ dimension: 'release_year' });
    expect(out.buckets[0]?.child?.truncated).toBe(true);
  });

  it('leaves a nested child untruncated when its buckets are within the cap (#13)', () => {
    const out = toFacetOutput(
      dim([
        {
          label: 'X-RAY',
          count: 800,
          child: {
            dimension: 'release_year',
            attribute: 'rcsb_accession_info.initial_release_date',
            buckets: [
              { label: '2020', count: 60 },
              { label: '2021', count: 70 },
            ],
          },
        },
      ]),
      5,
      800,
    );
    expect(out.buckets[0]?.child?.buckets).toHaveLength(2);
    expect(out.buckets[0]?.child).not.toHaveProperty('truncated');
  });

  it('projects a child that aggregated to nothing, charging the whole parent bucket (#31)', () => {
    const out = toFacetOutput(
      dim([
        {
          label: 'Glycine max',
          count: 55796,
          child: { dimension: 'method', attribute: 'exptl.method', buckets: [] },
        },
      ]),
      50,
      1062058,
    );
    expect(out.buckets[0]?.child).toEqual({
      dimension: 'method',
      buckets: [],
      missingValueCount: 55796,
    });
  });

  it('omits the child on a leaf bucket', () => {
    const out = toFacetOutput(dim([{ label: 'X-RAY', count: 800 }]), 50, 800);
    expect(out.buckets[0]).not.toHaveProperty('child');
    // The pre-flatten array field is gone from the contract entirely (#28).
    expect(out.buckets[0]).not.toHaveProperty('children');
  });

  it('carries rangeFrom/rangeTo through for numeric histogram buckets (#21)', () => {
    const out = toFacetOutput(
      {
        dimension: 'resolution',
        attribute: 'rcsb_entry_info.resolution_combined',
        buckets: [
          { label: '0.5', count: 1249, rangeFrom: 0.5, rangeTo: 1.0 },
          { label: '17.0', count: 30, rangeFrom: 17.0, rangeTo: 17.5 },
        ],
      },
      50,
      1279,
    );
    expect(out.buckets[0]).toEqual({ label: '0.5', count: 1249, rangeFrom: 0.5, rangeTo: 1.0 });
    expect(out.buckets[1]).toEqual({ label: '17.0', count: 30, rangeFrom: 17.0, rangeTo: 17.5 });
  });

  it('omits rangeFrom/rangeTo on term buckets (#21)', () => {
    const out = toFacetOutput(dim([{ label: 'X-RAY', count: 800 }]), 50, 800);
    expect(out.buckets[0]).not.toHaveProperty('rangeFrom');
    expect(out.buckets[0]).not.toHaveProperty('rangeTo');
  });

  it('carries ranges through a nested numeric cross-tab child (#21)', () => {
    const out = toFacetOutput(
      dim([
        {
          label: 'X-RAY',
          count: 800,
          child: {
            dimension: 'resolution',
            attribute: 'rcsb_entry_info.resolution_combined',
            buckets: [{ label: '1.5', count: 60, rangeFrom: 1.5, rangeTo: 2.0 }],
          },
        },
      ]),
      50,
      800,
    );
    expect(out.buckets[0]?.child?.buckets[0]).toEqual({
      label: '1.5',
      count: 60,
      rangeFrom: 1.5,
      rangeTo: 2.0,
    });
  });
});

describe('toFacetOutput coverage gap (#32)', () => {
  it('reports zero when the buckets account for the whole total', () => {
    const out = toFacetOutput(
      dim([
        { label: 'X-RAY', count: 800 },
        { label: 'EM', count: 200 },
      ]),
      50,
      1000,
    );
    expect(out.missingValueCount).toBe(0);
  });

  it('reports the entries the buckets do not account for', () => {
    // resolution under content_type "all": computed models carry no resolution.
    const out = toFacetOutput(
      dim([
        { label: 'X-RAY', count: 800 },
        { label: 'EM', count: 200 },
      ]),
      50,
      1450,
    );
    expect(out.missingValueCount).toBe(450);
  });

  it('reports the full total for a dimension that aggregated to nothing', () => {
    expect(toFacetOutput(dim([]), 50, 1081).missingValueCount).toBe(1081);
  });

  it('measures the gap on the uncapped bucket list, not the capped slice', () => {
    // 10 buckets summing to 55, capped to 3 (summing to 27). The gap must stay 5
    // — what the cap removed is already disclosed by truncated / shown / cap.
    const buckets = Array.from({ length: 10 }, (_, i) => ({ label: `v${i}`, count: 10 - i }));
    const out = toFacetOutput(dim(buckets), 3, 60);
    expect(out.truncated).toBe(true);
    expect(out.buckets).toHaveLength(3);
    expect(out.missingValueCount).toBe(5);
  });

  it('floors at zero when a multi-valued attribute over-counts the total', () => {
    // One entry with two source organisms lands in two organism buckets, so the
    // bucket sum exceeds the total. That is over-counting, not missing coverage.
    const out = toFacetOutput(
      {
        dimension: 'organism',
        attribute: 'rcsb_entity_source_organism.ncbi_scientific_name',
        buckets: [
          { label: 'Homo sapiens', count: 800 },
          { label: 'Escherichia coli', count: 400 },
        ],
      },
      50,
      1000,
    );
    expect(out.missingValueCount).toBe(0);
  });

  it('measures a nested child against its parent bucket count', () => {
    const out = toFacetOutput(
      {
        dimension: 'polymer_type',
        attribute: 'rcsb_entry_info.polymer_composition',
        buckets: [
          {
            label: 'homomeric protein',
            count: 1000,
            child: {
              dimension: 'method',
              attribute: 'exptl.method',
              buckets: [
                { label: 'X-RAY', count: 300 },
                { label: 'EM', count: 100 },
              ],
            },
          },
          {
            label: 'RNA',
            count: 50,
            child: {
              dimension: 'method',
              attribute: 'exptl.method',
              buckets: [{ label: 'X-RAY', count: 50 }],
            },
          },
        ],
      },
      50,
      1050,
    );
    expect(out.missingValueCount).toBe(0);
    expect(out.buckets[0]?.child?.missingValueCount).toBe(600);
    expect(out.buckets[1]?.child?.missingValueCount).toBe(0);
  });

  it('measures a nested child on its uncapped list while the cap slices the output', () => {
    const childBuckets = Array.from({ length: 6 }, (_, i) => ({ label: `y${i}`, count: 10 }));
    const out = toFacetOutput(
      dim([{ label: 'X-RAY', count: 100, child: childDim(childBuckets) }]),
      2,
      100,
    );
    const child = out.buckets[0]?.child;
    expect(child?.truncated).toBe(true);
    expect(child?.buckets).toHaveLength(2);
    // 6 uncapped buckets × 10 = 60 of the parent's 100 accounted for.
    expect(child?.missingValueCount).toBe(40);
  });
});

describe('renderFacets', () => {
  it('renders a dimension header and one line per bucket', () => {
    const lines = renderFacets([
      {
        dimension: 'method',
        missingValueCount: 0,
        buckets: [
          { label: 'X-RAY', count: 800 },
          { label: 'EM', count: 200 },
        ],
      },
    ]);
    const text = lines.join('\n');
    expect(text).toContain('**method**');
    expect(text).toContain('- X-RAY: 800');
    expect(text).toContain('- EM: 200');
  });

  it('marks a truncated dimension', () => {
    const lines = renderFacets([
      {
        dimension: 'organism',
        truncated: true,
        missingValueCount: 0,
        buckets: [{ label: 'Homo sapiens', count: 9 }],
      },
    ]);
    expect(lines.join('\n')).toContain('**organism** (truncated)');
  });

  it('renders the nested cross-tab child as an indented inline line', () => {
    const lines = renderFacets([
      {
        dimension: 'method',
        missingValueCount: 0,
        buckets: [
          {
            label: 'X-RAY',
            count: 800,
            child: {
              dimension: 'release_year',
              missingValueCount: 0,
              buckets: [
                { label: '2020', count: 60 },
                { label: '2021', count: 70 },
              ],
            },
          },
        ],
      },
    ]);
    const text = lines.join('\n');
    expect(text).toContain('  - release_year → 2020: 60, 2021: 70');
  });

  it('marks a truncated nested child dimension in the inline list (#13)', () => {
    const lines = renderFacets([
      {
        dimension: 'method',
        missingValueCount: 0,
        buckets: [
          {
            label: 'X-RAY',
            count: 800,
            child: {
              dimension: 'release_year',
              truncated: true,
              missingValueCount: 0,
              buckets: [
                { label: '2020', count: 60 },
                { label: '2021', count: 70 },
              ],
            },
          },
        ],
      },
    ]);
    expect(lines.join('\n')).toContain('  - release_year → 2020: 60, 2021: 70 (truncated)');
  });

  it('explains an empty dimension instead of leaving a bare heading (#26)', () => {
    const lines = renderFacets([{ dimension: 'method', missingValueCount: 0, buckets: [] }]);
    const text = lines.join('\n');
    expect(text).toContain('**method**');
    // The heading must not be the last thing a reader sees.
    expect(text.trimEnd().endsWith('**method**')).toBe(false);
    expect(text).toMatch(/no data/i);
  });

  it('explains an empty dimension that also carries the truncation marker (#26)', () => {
    const text = renderFacets([
      { dimension: 'method', truncated: true, missingValueCount: 0, buckets: [] },
    ]).join('\n');
    expect(text).toContain('**method** (truncated)');
    expect(text).toMatch(/no data/i);
  });

  it('keeps explaining empty dimensions alongside populated ones (#26)', () => {
    const text = renderFacets([
      { dimension: 'method', missingValueCount: 0, buckets: [] },
      {
        dimension: 'organism',
        missingValueCount: 0,
        buckets: [{ label: 'Homo sapiens', count: 9 }],
      },
    ]).join('\n');
    expect(text).toMatch(/\*\*method\*\*\n.*no data/i);
    expect(text).toContain('- Homo sapiens: 9');
  });

  it('explains an empty nested cross-tab child instead of a dangling arrow (#26)', () => {
    const text = renderFacets([
      {
        dimension: 'organism',
        missingValueCount: 0,
        buckets: [
          {
            label: 'Homo sapiens',
            count: 9,
            child: { dimension: 'method', missingValueCount: 0, buckets: [] },
          },
        ],
      },
    ]).join('\n');
    expect(text).toContain('- Homo sapiens: 9');
    expect(text).not.toMatch(/method → *$/m);
    expect(text).toMatch(/method → .*no data/i);
  });

  it('renders the half-open [rangeFrom–rangeTo) bin for numeric histogram buckets (#21)', () => {
    const lines = renderFacets([
      {
        dimension: 'resolution',
        missingValueCount: 0,
        buckets: [
          { label: '0.5', count: 1249, rangeFrom: 0.5, rangeTo: 1.0 },
          { label: '17.0', count: 30, rangeFrom: 17.0, rangeTo: 17.5 },
        ],
      },
    ]);
    const text = lines.join('\n');
    expect(text).toContain('- 0.5 [0.5–1): 1249');
    expect(text).toContain('- 17.0 [17–17.5): 30');
  });

  it('marks the coverage gap on the dimension heading (#32)', () => {
    const text = renderFacets([
      {
        dimension: 'resolution',
        missingValueCount: 60949,
        buckets: [{ label: '1.5', count: 100 }],
      },
    ]).join('\n');
    expect(text).toContain('**resolution** (60949 with no value)');
  });

  it('omits the coverage marker when nothing is missing (#32)', () => {
    const text = renderFacets([
      { dimension: 'method', missingValueCount: 0, buckets: [{ label: 'X-RAY', count: 100 }] },
    ]).join('\n');
    expect(text).toContain('**method**\n');
    expect(text).not.toMatch(/with no value/);
  });

  it('carries both the truncation and coverage markers in one heading (#32)', () => {
    const text = renderFacets([
      {
        dimension: 'resolution',
        truncated: true,
        missingValueCount: 450,
        buckets: [{ label: '1.5', count: 100 }],
      },
    ]).join('\n');
    expect(text).toContain('**resolution** (truncated; 450 with no value)');
  });

  it('marks a nested child dimension coverage gap in the inline list (#32)', () => {
    const text = renderFacets([
      {
        dimension: 'polymer_type',
        missingValueCount: 0,
        buckets: [
          {
            label: 'homomeric protein',
            count: 1000,
            child: {
              dimension: 'method',
              missingValueCount: 600,
              buckets: [{ label: 'X-RAY', count: 400 }],
            },
          },
        ],
      },
    ]).join('\n');
    expect(text).toContain('  - method → X-RAY: 400 (600 with no value)');
  });
});

describe('coverageNotices (#32)', () => {
  const facet = (
    dimension: string,
    missingValueCount: number,
    bucketCount = 1,
  ): Parameters<typeof coverageNotices>[0][number] => ({
    dimension,
    missingValueCount,
    buckets: Array.from({ length: bucketCount }, (_, i) => ({ label: `v${i}`, count: 1 })),
  });

  it('stays silent when a dimension accounts for its whole scope', () => {
    expect(coverageNotices([facet('method', 0)], 1000)).toEqual([]);
  });

  it('stays silent for a gap below the materiality floor', () => {
    // method under content_type "experimental": 62 of 71862 (0.09%).
    expect(coverageNotices([facet('method', 62)], 71862)).toEqual([]);
  });

  it('speaks for a record-level gap with no computed model involved', () => {
    // resolution under content_type "experimental": solution-NMR entries have no
    // diffraction resolution, so the gap exists inside the experimental universe.
    const [notice] = coverageNotices([facet('resolution', 2707)], 71862);
    expect(notice).toContain('resolution');
    expect(notice).toContain('2707');
    expect(notice).toMatch(/3\.8%/);
  });

  it('speaks for a scope-level gap under the mixed content universe', () => {
    const [notice] = coverageNotices([facet('method', 58304)], 130104);
    expect(notice).toMatch(/44\.8%/);
    expect(notice).toContain('71800');
  });

  it('stays silent for a dimension that aggregated to nothing', () => {
    // A dimension with no buckets at all is already reported by the empty-dimension
    // render line; quantifying a 100% gap on top of it adds nothing.
    expect(coverageNotices([facet('method', 1081, 0)], 1081)).toEqual([]);
  });

  it('stays silent on an empty scope', () => {
    expect(coverageNotices([facet('method', 0, 0)], 0)).toEqual([]);
  });

  it('emits one fragment per material dimension', () => {
    const notices = coverageNotices(
      [facet('method', 58304), facet('resolution', 60949), facet('organism', 0)],
      130104,
    );
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain('method');
    expect(notices[1]).toContain('resolution');
  });

  it('names a repeated dimension once', () => {
    expect(coverageNotices([facet('method', 58304), facet('method', 58304)], 130104)).toHaveLength(
      1,
    );
  });

  it('stays silent for a cross-tab child that aggregated to nothing (#31)', () => {
    // Every parent bucket carries an empty child: a 100% gap the empty-child
    // render line already reports, so quantifying it on top adds nothing.
    expect(
      coverageNotices(
        [
          {
            dimension: 'organism',
            missingValueCount: 0,
            buckets: [
              {
                label: 'Glycine max',
                count: 55796,
                child: { dimension: 'method', missingValueCount: 55796, buckets: [] },
              },
            ],
          },
        ],
        55796,
      ),
    ).toEqual([]);
  });

  it('aggregates a cross-tab child dimension into one fragment', () => {
    const notices = coverageNotices(
      [
        {
          dimension: 'polymer_type',
          missingValueCount: 0,
          buckets: [
            {
              label: 'homomeric protein',
              count: 98505,
              child: {
                dimension: 'method',
                missingValueCount: 57602,
                buckets: [{ label: 'X-RAY', count: 40903 }],
              },
            },
            {
              label: 'heteromeric protein',
              count: 19214,
              child: {
                dimension: 'method',
                missingValueCount: 687,
                buckets: [{ label: 'X-RAY', count: 18527 }],
              },
            },
          ],
        },
      ],
      130104,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('method');
    // 58289 missing across the 117719 matches the two parent buckets describe.
    expect(notices[0]).toContain('58289');
    expect(notices[0]).toContain('117719');
  });
});
