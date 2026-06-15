/**
 * @fileoverview Maps the agent-facing facet dimension enum to RCSB attributes +
 * aggregation types. Shared by `protein_analyze_collection` and the optional
 * facet breakdown on `protein_search_structures`.
 * @module services/rcsb/facets
 */

import type { FacetSpec } from './rcsb-service.js';

interface DimensionDef {
  aggregation: 'terms' | 'histogram' | 'date_histogram';
  attribute: string;
  /** Default bin width (histogram) or period (date_histogram). */
  defaultInterval?: number | string;
  /** Human label for the dimension. */
  label: string;
}

/** The supported `group_by` / facet dimensions and how RCSB aggregates each. */
export const FACET_DIMENSIONS = {
  method: {
    attribute: 'exptl.method',
    aggregation: 'terms',
    label: 'Experimental method',
  },
  organism: {
    attribute: 'rcsb_entity_source_organism.ncbi_scientific_name',
    aggregation: 'terms',
    label: 'Source organism',
  },
  polymer_type: {
    attribute: 'rcsb_entry_info.polymer_composition',
    aggregation: 'terms',
    label: 'Polymer composition',
  },
  resolution: {
    attribute: 'rcsb_entry_info.resolution_combined',
    aggregation: 'histogram',
    defaultInterval: 0.5,
    label: 'Resolution (Å)',
  },
  release_year: {
    attribute: 'rcsb_accession_info.initial_release_date',
    aggregation: 'date_histogram',
    defaultInterval: 'year',
    label: 'Release year',
  },
  molecular_weight: {
    attribute: 'rcsb_entry_info.molecular_weight',
    aggregation: 'histogram',
    defaultInterval: 50,
    label: 'Molecular weight (kDa)',
  },
} as const satisfies Record<string, DimensionDef>;

/** A supported facet dimension name. */
export type FacetDimensionName = keyof typeof FACET_DIMENSIONS;

/** All supported dimension names (for Zod enums). */
export const FACET_DIMENSION_NAMES = Object.keys(FACET_DIMENSIONS) as [
  FacetDimensionName,
  ...FacetDimensionName[],
];

/** Build a {@link FacetSpec} for a dimension, with an optional interval override and nested child. */
export function buildFacetSpec(
  dimension: FacetDimensionName,
  interval?: number | string,
  child?: FacetDimensionName,
): FacetSpec {
  const def: DimensionDef = FACET_DIMENSIONS[dimension];
  const resolvedInterval = interval ?? def.defaultInterval;
  return {
    dimension,
    attribute: def.attribute,
    aggregation: def.aggregation,
    ...(def.aggregation !== 'terms' && resolvedInterval !== undefined
      ? { interval: resolvedInterval }
      : {}),
    ...(child ? { child: buildFacetSpec(child) } : {}),
  };
}
