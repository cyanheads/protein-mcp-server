/**
 * @fileoverview protein_analyze_collection — profile the PDB into distributions
 * and trends (counts by method / organism / polymer type, resolution histograms,
 * release-year timelines, and multidimensional cross-tabs) over an optional
 * scoping query. Backed by RCSB's server-side facet engine: one call, compact
 * buckets, no row pull, no SQL canvas. Fully portable.
 * @module mcp-server/tools/definitions/analyze-collection.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import {
  buildFacetSpec,
  FACET_DIMENSION_NAMES,
  type FacetDimensionName,
  INTERVAL_DIMENSION_NAMES,
  intervalTarget,
} from '@/services/rcsb/facets.js';
import { getRcsbService } from '@/services/rcsb/rcsb-service.js';
import {
  CONTENT_TYPE_SCOPES,
  countBuckets,
  coverageNotices,
  facetDimensionSchema,
  renderFacets,
  toFacetOutput,
  truncationNotices,
} from './_schemas.js';

/**
 * Dimensions RCSB cannot aggregate over computed models: an AlphaFold /
 * ModelArchive record carries no experimental method or resolution, so the
 * facet key is absent from the response rather than returning empty buckets.
 * The other four dimensions aggregate normally under predicted content.
 */
const EXPERIMENTAL_ONLY_DIMENSIONS = new Set<FacetDimensionName>(['method', 'resolution']);

/**
 * Zero-match advice, per scope. Mirrors `protein_search_structures`: only the two
 * single-universe scopes have a wider one to switch to, so under `all` the advice
 * is to loosen the filters rather than to widen a scope already at its widest.
 */
const ZERO_MATCH_NOTICE = {
  experimental: `No experimental structures matched this scope, so every requested dimension aggregated to nothing. Broaden or drop the query, organism, method, and max_resolution filters, or widen content_type to "all" to include computed models.`,
  predicted: `No predicted models matched this scope, so every requested dimension aggregated to nothing. Broaden or drop the query, organism, method, and max_resolution filters, or widen content_type to "all" to include experimental structures.`,
  all: `No structures matched this scope in either the experimental or computed-model universe — content_type "all" is already the widest scope. Broaden or drop the query, organism, method, and max_resolution filters.`,
} satisfies Record<'experimental' | 'predicted' | 'all', string>;

export const analyzeCollection = tool('protein_analyze_collection', {
  title: 'protein-mcp-server: analyze collection',
  description:
    'Profile the PDB into distributions and trends over an optional scoping query: counts by method, organism, or polymer composition; resolution and molecular-weight histograms; release-year timelines; and multidimensional cross-tabs (e.g. method × release_year). Aggregation runs at RCSB, so the response carries compact counts per bucket rather than the matching entries. Pass one group_by dimension for a single breakdown, or two distinct dimensions for a cross-tab (the first nests the second). bucket_limit caps each dimension level separately rather than the response, so a cross-tab returns up to that many nested buckets under each of its capped parent buckets; bucketsReturned reports the realized total.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'interval_not_applicable',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'interval was supplied but neither requested group_by dimension aggregates by a histogram that accepts a value of that type.',
      recovery: `Group by resolution or molecular_weight for a numeric interval, or release_year for the "year" period; otherwise drop interval and let each dimension use its own default.`,
    },
    {
      reason: 'duplicate_dimension',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'group_by lists the same dimension twice, which would cross a dimension with itself.',
      recovery:
        'List each dimension at most once: one dimension for a breakdown, or two distinct dimensions for a cross-tab.',
    },
  ],

  input: z.object({
    group_by: z
      .array(z.enum(FACET_DIMENSION_NAMES))
      .min(1)
      .max(2)
      .describe(
        '1 dimension for a breakdown, or 2 distinct dimensions for a cross-tab (the first nests the second). Repeating a dimension is rejected.',
      ),
    query: z
      .string()
      .optional()
      .describe('Optional free-text scope (e.g. "kinase"); omit to profile the whole PDB.'),
    organism: z.string().optional().describe('Optional source-organism scope.'),
    method: z.string().optional().describe('Optional experimental-method scope.'),
    max_resolution: z.coerce
      .number()
      .positive()
      .optional()
      .describe('Optional maximum-resolution scope (Å).'),
    content_type: z
      .enum(['experimental', 'predicted', 'all'])
      .default('experimental')
      .describe(
        'Which structure universe to profile. Default experimental. Computed models carry no experimental metadata, so method and resolution return nothing under "predicted".',
      ),
    interval: z
      .union(
        [
          // Coerce the numeric arm: many clients stringify tool args, and "0.5" must
          // still reach the histogram path. z.coerce.number() on "year" yields NaN,
          // which .positive() rejects, so period strings still fall through to the enum.
          z.coerce
            .number()
            .positive()
            .describe('Numeric bin width for a value histogram (e.g. resolution Å).'),
          // RCSB's date_histogram schema accepts only "year"; month and quarter fail
          // upstream JSON-schema validation, so they are not advertised here.
          z.enum(['year']).describe('Period granularity for a date histogram. Only "year".'),
        ],
        // A union reports a bare "Invalid input" by default, so the rejection would
        // name neither arm; spell the accepted set out instead.
        { error: `Expected a positive number (histogram bin width) or "year" (date period).` },
      )
      .optional()
      .describe(
        `Bin width for a histogram dimension (a number, for resolution or molecular_weight) or period for a date histogram ("year", for release_year). Applies to whichever requested group_by dimension can consume that value type — primary or nested child — so a cross-tab like ["method","resolution"] bins its nested resolution child. When both requested dimensions can consume it the primary takes it and the child keeps its default. When neither can, the call is rejected rather than silently ignoring the override.`,
      ),
    bucket_limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe(
        'Max buckets per dimension level, not per response. A cross-tab applies the cap separately to the parent dimension and to the nested child inside each parent bucket, so up to bucket_limit × (1 + bucket_limit) buckets can come back — 2550 at the default 50. The realized count comes back as bucketsReturned. Defaults to the configured server cap.',
      ),
  }),

  output: z.object({
    total: z.number().describe('Total entries in the scoped collection.'),
    facets: z.array(facetDimensionSchema).describe('The requested breakdown(s).'),
  }),

  enrichment: {
    scope: z.string().optional().describe('Echoed scope description for follow-up calls.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Advisory note (per-position bucket truncation, a scope that matched nothing, dimensions with no data under the requested content_type, dimensions whose buckets cover materially less than the total). Carries every applicable advisory in one string.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when at least one dimension position — the top-level dimension or a nested cross-tab child — had more buckets than the applied cap. Which positions, and by how much, is named in notice.',
      ),
    bucketsReturned: z
      .number()
      .describe(
        'Buckets in this response, summed over every dimension level: the top-level buckets plus, for a cross-tab, the nested child buckets under each of them. Since bucket_limit caps each level separately, this is the size those caps actually produced — always present, cross-tab or not.',
      ),
  },

  async handler(input, ctx) {
    const cfg = getServerConfig();
    const rcsb = getRcsbService();
    const cap = input.bucket_limit ?? cfg.facetBucketCap;
    // `.min(1)` on the schema guarantees a primary; the array type does not carry
    // that, and an out-of-enum or empty group_by is rejected before the handler runs.
    const [primary, secondary] = input.group_by as [FacetDimensionName, FacetDimensionName?];
    // A repeated dimension would nest a facet inside itself upstream. RCSB answers
    // that with same-attribute overlap, not a cross-tab between two dimensions —
    // an undocumented shape no caller can read, so reject before the call.
    const duplicate = input.group_by.find((d, i, all) => all.indexOf(d) !== i);
    if (duplicate)
      throw ctx.fail(
        'duplicate_dimension',
        `group_by lists "${duplicate}" twice; a cross-tab needs two distinct dimensions.`,
        { ...ctx.recoveryFor('duplicate_dimension') },
      );
    // An override no requested position can consume would reach RCSB as nothing at
    // all — the call would succeed with default bins, looking like a filtered result.
    if (input.interval !== undefined && !intervalTarget(input.interval, primary, secondary))
      throw ctx.fail(
        'interval_not_applicable',
        `interval ${input.interval} does not apply to ${input.group_by.join(' or ')}; only ${INTERVAL_DIMENSION_NAMES.join(', ')} bin by an interval, and a numeric width needs resolution or molecular_weight while "year" needs release_year.`,
        { ...ctx.recoveryFor('interval_not_applicable') },
      );
    const spec = buildFacetSpec(primary, input.interval, secondary);

    const { total, facets } = await rcsb.analyzeFacets(
      {
        ...(input.query ? { text: input.query } : {}),
        ...(input.organism ? { organism: input.organism } : {}),
        ...(input.method ? { method: input.method } : {}),
        ...(typeof input.max_resolution === 'number'
          ? { maxResolution: input.max_resolution }
          : {}),
        contentType: CONTENT_TYPE_SCOPES[input.content_type],
      },
      [spec],
      ctx,
    );

    const out = facets.map((f) => toFacetOutput(f, cap, total));

    // The cap bounds each dimension level, so a cross-tab's size is the product of
    // two capped lists rather than one. Report what the response actually holds.
    ctx.enrich({ bucketsReturned: countBuckets(out) });

    // Every advisory writes the same `notice` field (ctx.enrich.truncated routes
    // through it and is last-wins), and a cross-tab under predicted content can
    // trip several at once — collect the fragments and emit them as ONE notice.
    const notices: string[] = [];
    // Every position the cap sliced is named, not just the first one `.find()` would
    // reach: a cross-tab caps the parent and each nested child independently.
    const truncations = truncationNotices(out, cap);
    if (truncations.length > 0) {
      ctx.enrich({ truncated: true });
      notices.push(...truncations);
    }
    if (total === 0) {
      // A scope that matched nothing explains every empty dimension by itself.
      // Stacking the predicted-content caveat on top would misattribute the cause.
      notices.push(ZERO_MATCH_NOTICE[input.content_type]);
    } else if (input.content_type === 'predicted') {
      const blind = input.group_by.filter((d) => EXPERIMENTAL_ONLY_DIMENSIONS.has(d));
      if (blind.length > 0) {
        notices.push(
          `${blind.join(' and ')} ${blind.length > 1 ? 'are' : 'is'} empty under content_type "predicted": computed models carry no experimental method or resolution metadata. Use content_type "experimental" or "all", or group by organism, polymer_type, release_year, or molecular_weight.`,
        );
      }
    }
    notices.push(...coverageNotices(out, total));
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    const scopeBits = [input.query, input.organism, input.method].filter(Boolean);
    if (scopeBits.length > 0) ctx.enrich({ scope: scopeBits.join(' · ') });

    return { total, facets: out };
  },

  format: (result) => {
    const lines: string[] = [`## Collection profile — ${result.total} entries`];
    lines.push(...renderFacets(result.facets));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
