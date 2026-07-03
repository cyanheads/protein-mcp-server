/**
 * @fileoverview Shared Zod output schemas and helpers for the facet breakdown
 * surfaced by `protein_analyze_collection` and `protein_search_structures`. Nesting
 * is bounded to two levels (a dimension's buckets may each carry one child
 * dimension), matching the deepest cross-tab the facet engine produces.
 * @module mcp-server/tools/definitions/_schemas
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { FacetDimension } from '@/services/rcsb/types.js';

/** A flat (leaf) facet bucket. */
const leafBucketSchema = z
  .object({
    label: z.string().describe('Bucket value — category, numeric bin start, or period.'),
    count: z.number().describe('Number of entries in the bucket.'),
  })
  .describe('A leaf aggregation bucket: a value and its entry count.');

/** A child (nested) facet dimension within a cross-tab bucket. */
const childDimensionSchema = z
  .object({
    dimension: z.string().describe('Nested dimension name.'),
    buckets: z.array(leafBucketSchema).describe('Nested buckets within the parent bucket.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when this nested bucket list was capped by the per-dimension bucket limit.'),
  })
  .describe('A nested cross-tab dimension within a parent bucket.');

/** A top-level facet bucket, optionally carrying a nested cross-tab dimension. */
const bucketSchema = z
  .object({
    label: z.string().describe('Bucket value — category, numeric bin start, or period.'),
    count: z.number().describe('Number of entries in the bucket.'),
    children: z
      .array(childDimensionSchema)
      .optional()
      .describe(
        'Nested dimension breakdown for cross-tabs (present only for multidimensional facets).',
      ),
  })
  .describe('A top-level aggregation bucket, optionally cross-tabbed by a nested dimension.');

/** A facet dimension and its buckets. */
export const facetDimensionSchema = z
  .object({
    dimension: z
      .string()
      .describe('Friendly dimension name (e.g. method, organism, release_year).'),
    buckets: z.array(bucketSchema).describe('Aggregation buckets, count-descending for terms.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when buckets were capped by the per-dimension bucket limit.'),
  })
  .describe('A facet dimension and its aggregation buckets.');

export type FacetDimensionOutput = z.infer<typeof facetDimensionSchema>;

/** Project a domain {@link FacetDimension} to the output shape, capping buckets. */
export function toFacetOutput(facet: FacetDimension, cap: number): FacetDimensionOutput {
  const truncated = facet.buckets.length > cap;
  return {
    dimension: facet.dimension,
    buckets: facet.buckets.slice(0, cap).map((b) => ({
      label: b.label,
      count: b.count,
      ...(b.children
        ? {
            children: b.children.map((c) => ({
              dimension: c.dimension,
              buckets: c.buckets.slice(0, cap).map((cb) => ({ label: cb.label, count: cb.count })),
              ...(c.buckets.length > cap ? { truncated: true } : {}),
            })),
          }
        : {}),
    })),
    ...(truncated ? { truncated: true } : {}),
  };
}

/** Render a list of facet dimensions to markdown lines for `format()` parity. */
export function renderFacets(facets: FacetDimensionOutput[]): string[] {
  const lines: string[] = [];
  for (const f of facets) {
    lines.push(`\n**${f.dimension}**${f.truncated ? ' (truncated)' : ''}`);
    for (const b of f.buckets) {
      lines.push(`- ${b.label}: ${b.count}`);
      for (const c of b.children ?? []) {
        const inner = c.buckets.map((cb) => `${cb.label}: ${cb.count}`).join(', ');
        lines.push(`  - ${c.dimension} → ${inner}${c.truncated ? ' (truncated)' : ''}`);
      }
    }
  }
  return lines;
}

/** License + citation for one upstream data source that contributed to a response. */
export const attributionSchema = z
  .object({
    source: z
      .string()
      .describe(
        'Contributing data-source display name (e.g. "RCSB PDB", "AlphaFold DB", "SWISS-MODEL", "UniProt"). Open-ended — best_available structures are federated through 3D-Beacons providers.',
      ),
    license: z.string().describe('License the source data is released under (e.g. "CC BY 4.0").'),
    citation: z.string().describe('Primary-literature citation to credit the source.'),
    homepage: z.string().describe('Source homepage (absolute URL).'),
  })
  .describe('Upstream data-source attribution: license, citation, and homepage.');

export type AttributionOutput = z.infer<typeof attributionSchema>;

/** Render an attribution list to one compact markdown line per source for `format()` parity. */
export function renderAttribution(attributions: AttributionOutput[]): string[] {
  const lines: string[] = [];
  for (const a of attributions) {
    lines.push(`- **${a.source}** (${a.license}) — ${a.citation} — ${a.homepage}`);
  }
  return lines;
}
