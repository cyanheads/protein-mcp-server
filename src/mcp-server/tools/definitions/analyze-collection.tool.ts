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
} from '@/services/rcsb/facets.js';
import { getRcsbService } from '@/services/rcsb/rcsb-service.js';
import {
  CONTENT_TYPE_SCOPES,
  countBuckets,
  coverageNotices,
  facetDimensionSchema,
  renderFacets,
  toFacetOutput,
} from './_schemas.js';

/**
 * Dimensions RCSB cannot aggregate over computed models: an AlphaFold /
 * ModelArchive record carries no experimental method or resolution, so the
 * facet key is absent from the response rather than returning empty buckets.
 * The other four dimensions aggregate normally under predicted content.
 */
const EXPERIMENTAL_ONLY_DIMENSIONS = new Set<FacetDimensionName>(['method', 'resolution']);

export const analyzeCollection = tool('protein_analyze_collection', {
  title: 'protein-mcp-server: analyze collection',
  description:
    'Profile the PDB into distributions and trends over an optional scoping query: counts by method, ' +
    'organism, or polymer composition; resolution and molecular-weight histograms; release-year timelines; ' +
    'and multidimensional cross-tabs (e.g. method × release_year). Aggregation runs server-side at RCSB — ' +
    'one call returns compact buckets, no row pull. Pass one group_by dimension for a single breakdown, or ' +
    'two distinct dimensions for a cross-tab (the first nests the second). bucket_limit caps each dimension ' +
    'level separately rather than the response, so a cross-tab returns up to that many nested buckets under ' +
    'each of its capped parent buckets; bucketsReturned reports the realized total.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'unknown_dimension',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A group_by value is outside the supported dimension set.',
      recovery:
        'Use a supported dimension: method, organism, polymer_type, resolution, release_year, or molecular_weight.',
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
        'Which structure universe to profile. Default experimental. Computed models carry no ' +
          'experimental metadata, so method and resolution return nothing under "predicted".',
      ),
    interval: z
      .union([
        // Coerce the numeric arm: many clients stringify tool args, and "0.5" must
        // still reach the histogram path. z.coerce.number() on "year" yields NaN,
        // which .positive() rejects, so period strings still fall through to the enum.
        z.coerce
          .number()
          .positive()
          .describe('Numeric bin width for a value histogram (e.g. resolution Å).'),
        z.enum(['year', 'month', 'quarter']).describe('Period granularity for a date histogram.'),
      ])
      .optional()
      .describe(
        'Bin width for a histogram dimension (number) or period for a date histogram (year/month/quarter).',
      ),
    bucket_limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe(
        'Max buckets per dimension level, not per response. A cross-tab applies the cap separately to the ' +
          'parent dimension and to the nested child inside each parent bucket, so up to ' +
          'bucket_limit × (1 + bucket_limit) buckets can come back — 2550 at the default 50. The realized ' +
          'count comes back as bucketsReturned. Defaults to the server PROTEIN_FACET_BUCKET_CAP.',
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
        'Advisory note (bucket truncation, empty scope, dimensions with no data under the requested content_type, dimensions whose buckets cover materially less than the total). Carries every applicable advisory in one string.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe('True when a dimension had more buckets than the applied cap.'),
    shown: z.number().optional().describe('Buckets returned for the capped dimension.'),
    cap: z.number().optional().describe('Per-dimension bucket cap that was applied.'),
    bucketsReturned: z
      .number()
      .describe(
        'Buckets in this response, summed over every dimension level: the top-level buckets plus, for a ' +
          'cross-tab, the nested child buckets under each of them. Since bucket_limit caps each level ' +
          'separately, this is the size those caps actually produced — always present, cross-tab or not.',
      ),
  },

  async handler(input, ctx) {
    const cfg = getServerConfig();
    const rcsb = getRcsbService();
    const cap = input.bucket_limit ?? cfg.facetBucketCap;
    const [primary, secondary] = input.group_by;
    if (!primary)
      throw ctx.fail('unknown_dimension', 'group_by requires at least one dimension.', {
        ...ctx.recoveryFor('unknown_dimension'),
      });
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
    const capped = out.find((f) => f.truncated);
    if (capped) {
      ctx.enrich({ truncated: true, shown: capped.buckets.length, cap });
      notices.push(
        `One or more dimensions exceeded ${cap} buckets and were capped; scope the query tighter for the long tail.`,
      );
    }
    if (input.content_type === 'predicted') {
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
