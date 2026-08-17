/**
 * @fileoverview Shared schemas and helpers for the two tools that expose a facet
 * breakdown and a `content_type` scope — `protein_analyze_collection` and
 * `protein_search_structures`. Facet nesting is bounded to two levels (a
 * dimension's buckets may each carry one child dimension), matching the deepest
 * cross-tab the facet engine produces; the flat variant drops the child position
 * for the tool that requests single-dimension breakdowns only. Every dimension
 * position also reports its coverage gap, so buckets that sum to less than the
 * stated total say so.
 * @module mcp-server/tools/definitions/_schemas
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { ContentType, FacetDimension } from '@/services/rcsb/types.js';

/**
 * The agent-facing `content_type` scope → the RCSB content universes it selects.
 * `all` names both members explicitly: omitting `results_content_type` upstream
 * is experimental-only, not a union. Shared so the two tools that expose the
 * enum cannot drift apart on what a scope means.
 */
export const CONTENT_TYPE_SCOPES = {
  experimental: ['experimental'],
  predicted: ['computational'],
  all: ['experimental', 'computational'],
} satisfies Record<'experimental' | 'predicted' | 'all', ContentType[]>;

/** A flat (leaf) facet bucket. */
const leafBucketSchema = z
  .object({
    label: z.string().describe('Bucket value — category, numeric bin start, or period.'),
    count: z.number().describe('Number of entries in the bucket.'),
    rangeFrom: z
      .number()
      .optional()
      .describe(
        'Inclusive lower bound of a numeric histogram bin (= label). Present only for numeric facets (resolution, molecular_weight); absent for term/period facets.',
      ),
    rangeTo: z
      .number()
      .optional()
      .describe(
        'Exclusive upper bound of a numeric histogram bin (rangeFrom + bin interval), so the bin covers [rangeFrom, rangeTo). Present only for numeric facets.',
      ),
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
    missingValueCount: z
      .number()
      .describe(
        'Matches inside the parent bucket that carry no value for this nested attribute, so they fall in no nested bucket. 0 when the nested buckets account for the whole parent bucket.',
      ),
  })
  .describe('A nested cross-tab dimension within a parent bucket.');

/** A top-level facet bucket, optionally carrying a nested cross-tab dimension. */
const bucketSchema = leafBucketSchema
  .extend({
    child: childDimensionSchema
      .optional()
      .describe(
        'Nested dimension breakdown for a cross-tab. Present whenever a second dimension was requested — with an empty bucket list when nothing in this bucket carries a value for it — so its absence means no cross-tab was asked for. At most one: a bucket is never cross-tabbed by more than one dimension.',
      ),
  })
  .describe('A top-level aggregation bucket, optionally cross-tabbed by a nested dimension.');

/**
 * A facet dimension whose buckets are flat — the shape for a tool that requests
 * single-dimension breakdowns only, so no bucket can ever carry a cross-tab.
 */
export const flatFacetDimensionSchema = z
  .object({
    dimension: z
      .string()
      .describe('Friendly dimension name (e.g. method, organism, release_year).'),
    buckets: z.array(leafBucketSchema).describe('Aggregation buckets, count-descending for terms.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when buckets were capped by the per-dimension bucket limit.'),
    missingValueCount: z
      .number()
      .describe(
        'Matches in scope that carry no value for this attribute, so they count toward the response total but fall in no bucket (e.g. computed models have no experimental method; solution-NMR entries have no diffraction resolution). Independent of truncation — measured before the bucket cap is applied. 0 means no shortfall was detectable: a multi-valued attribute such as organism can place one match in several buckets, which offsets the shortfall rather than adding to it.',
      ),
  })
  .describe('A facet dimension and its aggregation buckets.');

/** A facet dimension whose buckets may each carry one nested cross-tab dimension. */
export const facetDimensionSchema = flatFacetDimensionSchema
  .extend({
    buckets: z.array(bucketSchema).describe('Aggregation buckets, count-descending for terms.'),
  })
  .describe('A facet dimension and its aggregation buckets, each optionally cross-tabbed.');

export type FacetDimensionOutput = z.infer<typeof facetDimensionSchema>;

export type FlatFacetDimensionOutput = z.infer<typeof flatFacetDimensionSchema>;

/** Copy the numeric-histogram range onto an output bucket when present. */
function withRange<T extends { rangeFrom?: number; rangeTo?: number }>(
  b: T,
): { rangeFrom: number; rangeTo: number } | Record<string, never> {
  return b.rangeFrom !== undefined && b.rangeTo !== undefined
    ? { rangeFrom: b.rangeFrom, rangeTo: b.rangeTo }
    : {};
}

/**
 * How many of `total` the buckets leave unaccounted for — matches carrying no
 * value for the faceted attribute, which land in no bucket.
 *
 * Two properties carry the correctness:
 *
 * - `buckets` must be the UNCAPPED list. Measured after {@link toFacetOutput}
 *   slices to the bucket cap, the difference would fold in what the cap removed
 *   — a separate condition the response already discloses through `truncated` /
 *   `shown` / `cap`.
 * - The result floors at 0. A multi-valued attribute puts one match in several
 *   buckets (an entry with two source organisms lands in both), so the sum can
 *   legitimately exceed the total. That is over-counting, a different phenomenon
 *   from missing coverage, and this field does not claim to describe it. On a
 *   dimension that is both multi-valued and sparse the two net out, so 0 means
 *   "no shortfall detectable", not proof that every match reached a bucket.
 */
function missingValueCount(buckets: readonly { count: number }[], total: number): number {
  return Math.max(0, total - buckets.reduce((sum, b) => sum + b.count, 0));
}

/**
 * Project a domain {@link FacetDimension} to the output shape, capping buckets.
 * `total` is the population the buckets describe — the response total for a
 * top-level dimension, and the parent bucket's count for a nested one.
 */
export function toFacetOutput(
  facet: FacetDimension,
  cap: number,
  total: number,
): FacetDimensionOutput {
  const truncated = facet.buckets.length > cap;
  return {
    dimension: facet.dimension,
    buckets: facet.buckets.slice(0, cap).map((b) => ({
      label: b.label,
      count: b.count,
      ...withRange(b),
      ...(b.child
        ? {
            child: {
              dimension: b.child.dimension,
              buckets: b.child.buckets
                .slice(0, cap)
                .map((cb) => ({ label: cb.label, count: cb.count, ...withRange(cb) })),
              ...(b.child.buckets.length > cap ? { truncated: true } : {}),
              missingValueCount: missingValueCount(b.child.buckets, b.count),
            },
          }
        : {}),
    })),
    ...(truncated ? { truncated: true } : {}),
    missingValueCount: missingValueCount(facet.buckets, total),
  };
}

/**
 * Buckets the response actually carries, summed over every dimension position:
 * each dimension's own bucket list plus the nested cross-tab list under each of
 * its buckets.
 *
 * Counted after {@link toFacetOutput} has sliced each position to the cap, so it
 * is the realized size rather than what upstream aggregated. The cap bounds each
 * position independently — a cross-tab reaches `cap × (1 + cap)` buckets — and
 * the per-position `truncated` flags do not compose into that size, so a caller
 * cannot derive it from the levels.
 */
export function countBuckets(facets: FacetDimensionOutput[]): number {
  let count = 0;
  for (const f of facets) {
    count += f.buckets.length;
    for (const b of f.buckets) count += b.child?.buckets.length ?? 0;
  }
  return count;
}

/**
 * Render one bucket's `label: count` line, annotating numeric histogram buckets
 * with their explicit half-open `[rangeFrom, rangeTo)` bin so the bare boundary
 * label isn't ambiguous (does `1.0` count `[0.5, 1.0)` or `[1.0, 1.5)`?).
 */
function renderBucket(b: {
  label: string;
  count: number;
  rangeFrom?: number | undefined;
  rangeTo?: number | undefined;
}): string {
  const range =
    b.rangeFrom !== undefined && b.rangeTo !== undefined ? ` [${b.rangeFrom}–${b.rangeTo})` : '';
  return `${b.label}${range}: ${b.count}`;
}

/**
 * Stands in for a dimension that aggregated to nothing. A bare `**dimension**`
 * heading with no buckets under it reads as a broken response; say the scope
 * produced no data instead. Why it is empty (a zero-hit query, or an attribute
 * the scoped content universe does not carry) is the caller's notice to give.
 */
const EMPTY_DIMENSION_LINE = '_No data for this dimension in the current scope._';

/** Inline twin of {@link EMPTY_DIMENSION_LINE} for a nested cross-tab child that aggregated to nothing. */
const EMPTY_CHILD_DIMENSION_TEXT = '_no data in this scope_';

/**
 * The parenthetical after a dimension's name: the bucket-cap marker and the
 * coverage gap, in one group so a dimension carrying both does not sprout two
 * sets of parentheses.
 */
function dimensionFlags(d: { truncated?: boolean | undefined; missingValueCount: number }): string {
  const flags = [
    d.truncated ? 'truncated' : '',
    d.missingValueCount > 0 ? `${d.missingValueCount} with no value` : '',
  ].filter(Boolean);
  return flags.length > 0 ? ` (${flags.join('; ')})` : '';
}

/** Render a list of facet dimensions to markdown lines for `format()` parity. */
export function renderFacets(facets: FacetDimensionOutput[]): string[] {
  const lines: string[] = [];
  for (const f of facets) {
    lines.push(`\n**${f.dimension}**${dimensionFlags(f)}`);
    if (f.buckets.length === 0) {
      lines.push(EMPTY_DIMENSION_LINE);
      continue;
    }
    for (const b of f.buckets) {
      lines.push(`- ${renderBucket(b)}`);
      const c = b.child;
      if (!c) continue;
      const inner =
        c.buckets.length === 0
          ? EMPTY_CHILD_DIMENSION_TEXT
          : c.buckets.map(renderBucket).join(', ');
      lines.push(`  - ${c.dimension} → ${inner}${dimensionFlags(c)}`);
    }
  }
  return lines;
}

/**
 * Share of a dimension's scope that must carry no value before the coverage gap
 * earns prose on top of the always-present `missingValueCount` field.
 *
 * 1% separates the two regimes seen in the live data. Below it the difference is
 * rounding-scale against the distribution the buckets describe — `method` under
 * `content_type: "experimental"` misses 0.09% — and prose on every response
 * would be noise. At or above it the buckets describe a visibly different
 * population than the stated total: `resolution` under `"experimental"` misses
 * 3.8% to entries with no diffraction resolution, and every experimental-only
 * dimension misses ~45% of a mixed `"all"` scope.
 */
const MATERIAL_COVERAGE_GAP = 0.01;

/** One dimension position in a facet tree, with the population its buckets describe. */
interface CoveragePosition {
  bucketCount: number;
  dimension: string;
  missing: number;
  scope: number;
}

/**
 * Flatten a facet tree to one entry per dimension position. A child dimension
 * repeats under every parent bucket, so its counts are summed into a single
 * position — otherwise a 50-bucket cross-tab would yield fifty advisories about
 * the same attribute. Parent buckets the cap removed are not represented, which
 * is correct: the aggregate then describes exactly the buckets the response shows.
 */
function coveragePositions(facets: FacetDimensionOutput[], total: number): CoveragePosition[] {
  const positions: CoveragePosition[] = [];
  for (const f of facets) {
    positions.push({
      dimension: f.dimension,
      missing: f.missingValueCount,
      scope: total,
      bucketCount: f.buckets.length,
    });
    const children = new Map<string, Omit<CoveragePosition, 'dimension'>>();
    for (const b of f.buckets) {
      const c = b.child;
      if (!c) continue;
      const acc = children.get(c.dimension) ?? { missing: 0, scope: 0, bucketCount: 0 };
      acc.missing += c.missingValueCount;
      acc.scope += b.count;
      acc.bucketCount += c.buckets.length;
      children.set(c.dimension, acc);
    }
    for (const [dimension, acc] of children) positions.push({ dimension, ...acc });
  }
  return positions;
}

/**
 * Advisory fragments for the dimensions whose coverage gap is material, ready to
 * join into the shared `notice` field alongside a caller's other advisories.
 *
 * A dimension that aggregated to nothing at all is skipped: the empty-dimension
 * line in `format()` (and, where it applies, the caller's scope notice) already
 * report it, and quantifying a 100% gap on top adds nothing.
 */
export function coverageNotices(facets: FacetDimensionOutput[], total: number): string[] {
  const seen = new Set<string>();
  const notices: string[] = [];
  for (const p of coveragePositions(facets, total)) {
    if (p.scope <= 0 || p.bucketCount === 0) continue;
    if (p.missing / p.scope < MATERIAL_COVERAGE_GAP) continue;
    if (seen.has(p.dimension)) continue;
    seen.add(p.dimension);
    const pct = ((p.missing / p.scope) * 100).toFixed(1);
    notices.push(
      `${p.dimension} buckets cover ${p.scope - p.missing} of ${p.scope} matches; the other ${p.missing} (${pct}%) carry no ${p.dimension} value and fall in no bucket.`,
    );
  }
  return notices;
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
