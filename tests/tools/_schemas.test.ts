/**
 * @fileoverview Tests for the shared facet projection helpers: toFacetOutput
 * (bucket cap + truncation flag + nested-child capping) and renderFacets (the
 * markdown twin, including the truncation marker and nested cross-tab line shape).
 * @module tests/tools/_schemas.test
 */

import { describe, expect, it } from 'vitest';
import { renderFacets, toFacetOutput } from '@/mcp-server/tools/definitions/_schemas.js';
import type { FacetDimension } from '@/services/rcsb/types.js';

const dim = (buckets: FacetDimension['buckets']): FacetDimension => ({
  dimension: 'method',
  attribute: 'exptl.method',
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
    );
    expect(out.buckets).toHaveLength(2);
    expect(out).not.toHaveProperty('truncated');
  });

  it('caps buckets at the limit and sets truncated:true', () => {
    const buckets = Array.from({ length: 10 }, (_, i) => ({ label: `v${i}`, count: 10 - i }));
    const out = toFacetOutput(dim(buckets), 3);
    expect(out.buckets).toHaveLength(3);
    expect(out.buckets.map((b) => b.label)).toEqual(['v0', 'v1', 'v2']);
    expect(out.truncated).toBe(true);
  });

  it('treats exactly cap buckets as not truncated', () => {
    const buckets = Array.from({ length: 3 }, (_, i) => ({ label: `v${i}`, count: 1 }));
    expect(toFacetOutput(dim(buckets), 3)).not.toHaveProperty('truncated');
  });

  it('projects and caps nested cross-tab children independently', () => {
    const out = toFacetOutput(
      dim([
        {
          label: 'X-RAY',
          count: 800,
          children: [
            {
              dimension: 'release_year',
              attribute: 'rcsb_accession_info.initial_release_date',
              buckets: [
                { label: '2019', count: 50 },
                { label: '2020', count: 60 },
                { label: '2021', count: 70 },
              ],
            },
          ],
        },
      ]),
      2,
    );
    // Child buckets capped at 2 as well, and the child carries its own truncation flag (#13).
    expect(out.buckets[0]?.children?.[0]?.buckets).toHaveLength(2);
    expect(out.buckets[0]?.children?.[0]).toMatchObject({ dimension: 'release_year' });
    expect(out.buckets[0]?.children?.[0]?.truncated).toBe(true);
  });

  it('leaves a nested child untruncated when its buckets are within the cap (#13)', () => {
    const out = toFacetOutput(
      dim([
        {
          label: 'X-RAY',
          count: 800,
          children: [
            {
              dimension: 'release_year',
              attribute: 'rcsb_accession_info.initial_release_date',
              buckets: [
                { label: '2020', count: 60 },
                { label: '2021', count: 70 },
              ],
            },
          ],
        },
      ]),
      5,
    );
    expect(out.buckets[0]?.children?.[0]?.buckets).toHaveLength(2);
    expect(out.buckets[0]?.children?.[0]).not.toHaveProperty('truncated');
  });

  it('omits children on a leaf bucket', () => {
    const out = toFacetOutput(dim([{ label: 'X-RAY', count: 800 }]), 50);
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
    );
    expect(out.buckets[0]).toEqual({ label: '0.5', count: 1249, rangeFrom: 0.5, rangeTo: 1.0 });
    expect(out.buckets[1]).toEqual({ label: '17.0', count: 30, rangeFrom: 17.0, rangeTo: 17.5 });
  });

  it('omits rangeFrom/rangeTo on term buckets (#21)', () => {
    const out = toFacetOutput(dim([{ label: 'X-RAY', count: 800 }]), 50);
    expect(out.buckets[0]).not.toHaveProperty('rangeFrom');
    expect(out.buckets[0]).not.toHaveProperty('rangeTo');
  });

  it('carries ranges through nested numeric cross-tab children (#21)', () => {
    const out = toFacetOutput(
      dim([
        {
          label: 'X-RAY',
          count: 800,
          children: [
            {
              dimension: 'resolution',
              attribute: 'rcsb_entry_info.resolution_combined',
              buckets: [{ label: '1.5', count: 60, rangeFrom: 1.5, rangeTo: 2.0 }],
            },
          ],
        },
      ]),
      50,
    );
    expect(out.buckets[0]?.children?.[0]?.buckets[0]).toEqual({
      label: '1.5',
      count: 60,
      rangeFrom: 1.5,
      rangeTo: 2.0,
    });
  });
});

describe('renderFacets', () => {
  it('renders a dimension header and one line per bucket', () => {
    const lines = renderFacets([
      {
        dimension: 'method',
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
      { dimension: 'organism', truncated: true, buckets: [{ label: 'Homo sapiens', count: 9 }] },
    ]);
    expect(lines.join('\n')).toContain('**organism** (truncated)');
  });

  it('renders nested cross-tab children as an indented inline list', () => {
    const lines = renderFacets([
      {
        dimension: 'method',
        buckets: [
          {
            label: 'X-RAY',
            count: 800,
            children: [
              {
                dimension: 'release_year',
                buckets: [
                  { label: '2020', count: 60 },
                  { label: '2021', count: 70 },
                ],
              },
            ],
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
        buckets: [
          {
            label: 'X-RAY',
            count: 800,
            children: [
              {
                dimension: 'release_year',
                truncated: true,
                buckets: [
                  { label: '2020', count: 60 },
                  { label: '2021', count: 70 },
                ],
              },
            ],
          },
        ],
      },
    ]);
    expect(lines.join('\n')).toContain('  - release_year → 2020: 60, 2021: 70 (truncated)');
  });

  it('renders the half-open [rangeFrom–rangeTo) bin for numeric histogram buckets (#21)', () => {
    const lines = renderFacets([
      {
        dimension: 'resolution',
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
});
