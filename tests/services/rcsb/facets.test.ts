/**
 * @fileoverview Tests for the facet-dimension mapping: friendly dimension names →
 * RCSB attribute + aggregation type, default vs. overridden intervals, the
 * routing of an interval override to whichever cross-tab position can consume it
 * (with primary-wins precedence), and nested cross-tab specs.
 * @module tests/services/rcsb/facets.test
 */

import { describe, expect, it } from 'vitest';
import {
  buildFacetSpec,
  FACET_DIMENSION_NAMES,
  INTERVAL_DIMENSION_NAMES,
  intervalTarget,
} from '@/services/rcsb/facets.js';

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

  it('honours an explicit numeric interval override', () => {
    expect(buildFacetSpec('resolution', 1)).toMatchObject({
      aggregation: 'histogram',
      interval: 1,
    });
  });

  it('honours the only period RCSB accepts on a date histogram (#58)', () => {
    // "year" is the whole accepted set upstream; month/quarter fail JSON-schema
    // validation at RCSB, so they never reach a spec.
    expect(buildFacetSpec('release_year', 'year')).toMatchObject({
      aggregation: 'date_histogram',
      interval: 'year',
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

  it('names exactly the interval-capable dimensions (#51)', () => {
    expect(INTERVAL_DIMENSION_NAMES).toEqual(['resolution', 'release_year', 'molecular_weight']);
  });
});

describe('intervalTarget (#51)', () => {
  it('matches a numeric interval to a histogram dimension only', () => {
    expect(intervalTarget(1, 'resolution')).toBe('resolution');
    expect(intervalTarget(50, 'molecular_weight')).toBe('molecular_weight');
    // A numeric width is meaningless to a date histogram — type, not "not terms".
    expect(intervalTarget(1, 'release_year')).toBeUndefined();
    expect(intervalTarget(1, 'method')).toBeUndefined();
  });

  it('matches the "year" period to a date-histogram dimension only', () => {
    expect(intervalTarget('year', 'release_year')).toBe('release_year');
    expect(intervalTarget('year', 'resolution')).toBeUndefined();
    expect(intervalTarget('year', 'organism')).toBeUndefined();
  });

  it('reaches the nested child when the primary cannot consume the value', () => {
    expect(intervalTarget(1, 'method', 'resolution')).toBe('resolution');
    expect(intervalTarget('year', 'method', 'release_year')).toBe('release_year');
  });

  it('gives the primary precedence when both positions can consume the value', () => {
    expect(intervalTarget(1, 'resolution', 'molecular_weight')).toBe('resolution');
  });

  it('returns undefined when neither requested position can consume the value', () => {
    expect(intervalTarget(100, 'method')).toBeUndefined();
    expect(intervalTarget(100, 'method', 'organism')).toBeUndefined();
    expect(intervalTarget('year', 'method', 'organism')).toBeUndefined();
  });
});

describe('buildFacetSpec interval routing (#51)', () => {
  it('routes the override to a compatible nested child, leaving the parent alone', () => {
    const spec = buildFacetSpec('method', 1, 'resolution');
    expect(spec).not.toHaveProperty('interval'); // terms parent never carries one
    expect(spec.child).toMatchObject({ dimension: 'resolution', interval: 1 });
  });

  it('routes a period override to a compatible nested child', () => {
    const spec = buildFacetSpec('method', 'year', 'release_year');
    expect(spec.child).toMatchObject({ dimension: 'release_year', interval: 'year' });
  });

  it('gives the primary the override and leaves the child on its default', () => {
    const spec = buildFacetSpec('resolution', 1, 'molecular_weight');
    expect(spec.interval).toBe(1);
    expect(spec.child).toMatchObject({ dimension: 'molecular_weight', interval: 50 });
  });

  it('keeps a histogram primary on its own default when the child takes the override', () => {
    // "year" can only land on release_year, so resolution keeps its 0.5 Å bins.
    const spec = buildFacetSpec('resolution', 'year', 'release_year');
    expect(spec.interval).toBe(0.5);
    expect(spec.child).toMatchObject({ dimension: 'release_year', interval: 'year' });
  });

  it('falls back to both defaults when neither position can consume the override', () => {
    // The tool rejects this shape before calling; the spec builder must not
    // invent a placement for it either.
    const spec = buildFacetSpec('method', 100, 'organism');
    expect(spec).not.toHaveProperty('interval');
    expect(spec.child).not.toHaveProperty('interval');
  });

  it('leaves both positions on their defaults with no override at all', () => {
    const spec = buildFacetSpec('release_year', undefined, 'resolution');
    expect(spec.interval).toBe('year');
    expect(spec.child).toMatchObject({ interval: 0.5 });
  });
});
