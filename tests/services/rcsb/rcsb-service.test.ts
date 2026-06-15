/**
 * @fileoverview Tests for the RCSB query builders: the search-query node tree
 * (match-all, single terminal, AND group, sequence, resolution ceiling) and the
 * facet-spec translation to the RCSB request shape (terms vs. histogram, nesting).
 * @module tests/services/rcsb/rcsb-service.test
 */

import { describe, expect, it } from 'vitest';
import { buildQuery, type FacetSpec, toRcsbFacet } from '@/services/rcsb/rcsb-service.js';

describe('buildQuery', () => {
  it('returns a match-all terminal when no constraints are given', () => {
    expect(buildQuery({})).toMatchObject({
      type: 'terminal',
      service: 'text',
      parameters: { attribute: 'rcsb_accession_info.initial_release_date', operator: 'exists' },
    });
  });

  it('builds a single full-text terminal for a text query', () => {
    expect(buildQuery({ text: 'kinase' })).toMatchObject({
      type: 'terminal',
      service: 'full_text',
      parameters: { value: 'kinase' },
    });
  });

  it('groups multiple constraints under a logical AND', () => {
    const q = buildQuery({ text: 'kinase', organism: 'Homo sapiens' }) as {
      type: string;
      logical_operator: string;
      nodes: unknown[];
    };
    expect(q.type).toBe('group');
    expect(q.logical_operator).toBe('and');
    expect(q.nodes).toHaveLength(2);
  });

  it('emits a sequence terminal with identity and e-value cutoffs', () => {
    expect(buildQuery({ sequence: 'MVLS', minIdentity: 0.5, maxEvalue: 0.01 })).toMatchObject({
      type: 'terminal',
      service: 'sequence',
      parameters: {
        identity_cutoff: 0.5,
        evalue_cutoff: 0.01,
        sequence_type: 'protein',
        value: 'MVLS',
      },
    });
  });

  it('adds a resolution ceiling as a less_or_equal text node', () => {
    const q = buildQuery({ text: 'x', maxResolution: 2.5 }) as { nodes: unknown[] };
    expect(q.nodes).toContainEqual(
      expect.objectContaining({
        parameters: expect.objectContaining({
          attribute: 'rcsb_entry_info.resolution_combined',
          operator: 'less_or_equal',
          value: 2.5,
        }),
      }),
    );
  });
});

describe('toRcsbFacet', () => {
  it('maps a terms facet without an interval', () => {
    const spec: FacetSpec = {
      dimension: 'method',
      attribute: 'exptl.method',
      aggregation: 'terms',
    };
    expect(toRcsbFacet(spec)).toEqual({
      name: 'method',
      aggregation_type: 'terms',
      attribute: 'exptl.method',
      min_interval_population: 1,
    });
  });

  it('includes the interval for a histogram facet', () => {
    const spec: FacetSpec = {
      dimension: 'resolution',
      attribute: 'rcsb_entry_info.resolution_combined',
      aggregation: 'histogram',
      interval: 0.5,
    };
    expect(toRcsbFacet(spec)).toMatchObject({ aggregation_type: 'histogram', interval: 0.5 });
  });

  it('nests a child facet recursively', () => {
    const spec: FacetSpec = {
      dimension: 'method',
      attribute: 'exptl.method',
      aggregation: 'terms',
      child: {
        dimension: 'release_year',
        attribute: 'rcsb_accession_info.initial_release_date',
        aggregation: 'date_histogram',
        interval: 'year',
      },
    };
    const out = toRcsbFacet(spec) as { facets: Array<Record<string, unknown>> };
    expect(out.facets).toHaveLength(1);
    expect(out.facets[0]).toMatchObject({ name: 'release_year', interval: 'year' });
  });
});
