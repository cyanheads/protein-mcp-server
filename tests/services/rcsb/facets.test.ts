/**
 * @fileoverview Tests for the facet-dimension mapping: friendly dimension names →
 * RCSB attribute + aggregation type, default vs. overridden intervals, and nested
 * cross-tab specs.
 * @module tests/services/rcsb/facets.test
 */

import { describe, expect, it } from 'vitest';
import { buildFacetSpec, FACET_DIMENSION_NAMES } from '@/services/rcsb/facets.js';

describe('buildFacetSpec', () => {
  it('maps a terms dimension with no interval', () => {
    expect(buildFacetSpec('method')).toEqual({
      dimension: 'method',
      attribute: 'exptl.method',
      aggregation: 'terms',
    });
  });

  it('applies the default interval for a histogram dimension', () => {
    expect(buildFacetSpec('resolution')).toMatchObject({ aggregation: 'histogram', interval: 0.5 });
  });

  it('honours an explicit interval override', () => {
    expect(buildFacetSpec('release_year', 'month')).toMatchObject({
      aggregation: 'date_histogram',
      interval: 'month',
    });
  });

  it('nests a child dimension for a cross-tab', () => {
    const spec = buildFacetSpec('method', undefined, 'release_year');
    expect(spec.child).toMatchObject({ dimension: 'release_year', aggregation: 'date_histogram' });
  });

  it('exposes all six supported dimensions', () => {
    expect(FACET_DIMENSION_NAMES).toEqual(
      expect.arrayContaining([
        'method',
        'organism',
        'polymer_type',
        'resolution',
        'release_year',
        'molecular_weight',
      ]),
    );
  });
});
