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

/** The histogram / date-histogram dimensions, in enum order — the set an `interval` can reach. */
export const INTERVAL_DIMENSION_NAMES = FACET_DIMENSION_NAMES.filter(
  (d) => FACET_DIMENSIONS[d].aggregation !== 'terms',
);

/**
 * Which requested dimension can consume an `interval` override, or `undefined`
 * when neither can. Compatibility is by value type rather than merely "not
 * terms": a numeric bin width belongs to a `histogram` dimension, the `year`
 * period to a `date_histogram` one. The primary position wins when both could
 * take it, so an ambiguous override lands where the caller can predict.
 */
export function intervalTarget(
  interval: number | string,
  dimension: FacetDimensionName,
  child?: FacetDimensionName,
): FacetDimensionName | undefined {
  const wanted = typeof interval === 'number' ? 'histogram' : 'date_histogram';
  if (FACET_DIMENSIONS[dimension].aggregation === wanted) return dimension;
  if (child && FACET_DIMENSIONS[child].aggregation === wanted) return child;
  return undefined;
}

/** Build one position's {@link FacetSpec}, falling back to its default bin width or period. */
function specFor(dimension: FacetDimensionName, interval?: number | string): FacetSpec {
  const def: DimensionDef = FACET_DIMENSIONS[dimension];
  const resolvedInterval = interval ?? def.defaultInterval;
  return {
    dimension,
    attribute: def.attribute,
    aggregation: def.aggregation,
    ...(def.aggregation !== 'terms' && resolvedInterval !== undefined
      ? { interval: resolvedInterval }
      : {}),
  };
}

/**
 * Build a {@link FacetSpec} for a dimension, with an optional interval override
 * and nested child. The override reaches whichever of the two positions can
 * consume it ({@link intervalTarget}) — RCSB honours a per-position `interval`
 * on a nested facet, so a histogram child is not stuck on its default just
 * because the parent aggregates by terms. The position that cannot consume it
 * keeps its own default, and an override no position accepts is dropped rather
 * than sent upstream; callers that must reject that case ask
 * {@link intervalTarget} first.
 */
export function buildFacetSpec(
  dimension: FacetDimensionName,
  interval?: number | string,
  child?: FacetDimensionName,
): FacetSpec {
  const target = interval === undefined ? undefined : intervalTarget(interval, dimension, child);
  return {
    ...specFor(dimension, target === dimension ? interval : undefined),
    ...(child ? { child: specFor(child, target === child ? interval : undefined) } : {}),
  };
}
