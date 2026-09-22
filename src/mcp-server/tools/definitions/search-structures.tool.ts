/**
 * @fileoverview protein_search_structures — federated search across experimental
 * (PDB) and predicted (computed model) structures via RCSB Search v2, with
 * optional metadata enrichment of the experimental page and an optional facet
 * breakdown for instant corpus orientation.
 * @module mcp-server/tools/definitions/search-structures.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { buildFacetSpec, FACET_DIMENSION_NAMES } from '@/services/rcsb/facets.js';
import { getRcsbService } from '@/services/rcsb/rcsb-service.js';
import type { EntryMeta, SearchHit } from '@/services/rcsb/types.js';
import { entryIdOf } from '@/services/shared/identifiers.js';
import {
  CONTENT_TYPE_SCOPES,
  coverageNotices,
  flatFacetDimensionSchema,
  renderFacets,
  toFacetOutput,
} from './_schemas.js';

/**
 * Zero-hit advice, per scope. Only the two single-universe scopes have a wider
 * one to switch to; under `all` both universes were already searched, so telling
 * the caller to change content_type would send them nowhere.
 */
const ZERO_HIT_NOTICE = {
  experimental:
    'No experimental structures matched. Broaden the query, drop filters, or widen content_type to "all" to include computed models.',
  predicted:
    'No predicted models matched. Predicted search covers computed models indexed by RCSB; widen content_type to "all" to include experimental structures.',
  all: 'No structures matched in either the experimental or computed-model universe — content_type "all" is already the widest scope. Broaden the query or drop filters.',
} satisfies Record<'experimental' | 'predicted' | 'all', string>;

/** A computed-model identifier (AlphaFold / ModelArchive) vs an experimental PDB entry. */
function isPredictedId(id: string): boolean {
  return /^(AF|MA)_/i.test(id);
}

/** Pull a UniProt accession out of a computed-model identifier when present (`AF_AFP69905F1` → `P69905`). */
function accessionFromCsm(id: string): string | undefined {
  return /AF_AF([A-Z0-9]+?)F\d+$/i.exec(id)?.[1]?.toUpperCase();
}

/**
 * Advisory for the facet dimensions the bucket cap sliced, naming every one of
 * them rather than the first. The cap here is fixed server-side with no per-call
 * override, so the route to the long tail is another tool: every dimension this
 * tool facets is also a `protein_analyze_collection` `group_by` value, and that
 * tool takes a `bucket_limit` up to 500.
 *
 * A sequence search has no such route — `protein_analyze_collection` has no
 * sequence input, so it cannot reproduce the result set the facet describes.
 * Pointing there would hand back a different distribution under the same name,
 * so that case is told to narrow the request instead.
 */
function truncationNotice(dimensions: string[], cap: number, sequenceSearch: boolean): string {
  const named = `${dimensions.join(' and ')} ${dimensions.length > 1 ? 'were' : 'was'} capped at ${cap} buckets`;
  return sequenceSearch
    ? `${named}. protein_analyze_collection cannot reproduce a sequence search, so narrow this request instead: drop sequence, or add organism, method, max_resolution, or query filters to shrink the distribution before the cap.`
    : `${named}. Call protein_analyze_collection with ${dimensions.length > 1 ? 'each dimension' : 'that dimension'} in group_by and a bucket_limit above ${cap} (up to 500) to reach the long tail.`;
}

export const searchStructures = tool('protein_search_structures', {
  title: 'protein-mcp-server: search structures',
  description:
    'Search experimental (PDB) and predicted (computed-model) protein structures by free text, protein sequence (triggers an mmseqs2 similarity search), and/or organism, method, and resolution filters. Returns ranked hits; the experimental page is enriched with title, method, resolution, and organism. Chain hit IDs into protein_get_structure. Optionally returns a facet breakdown (counts by method / organism / release year / …) alongside the hits at no extra call. A facet on a dimension you are already filtering (e.g. the organism facet while organism is set) lists unfiltered alternatives by design — it does not constrain by its own active filter, so you can see sibling values to pivot to. Numeric histogram buckets (resolution, molecular weight) carry explicit rangeFrom/rangeTo bounds so a boundary label is unambiguous.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'no_criteria',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'No query, sequence, organism, method, or maximum resolution was provided — nothing to search on.',
      recovery:
        'Provide a free-text query, protein sequence, organism name, experimental method, or maximum resolution.',
    },
    {
      reason: 'sequence_modifier_without_sequence',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'min_identity or max_evalue was supplied with no sequence, so the threshold would never reach a sequence search.',
      recovery:
        'Add a sequence to run a similarity search these thresholds can filter, or drop min_identity and max_evalue and search on the remaining criteria.',
    },
    {
      reason: 'duplicate_dimension',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'facets lists the same dimension twice, which would return that breakdown twice.',
      recovery: 'List each facet dimension at most once; drop the repeated value and re-call.',
    },
  ],

  input: z.object({
    query: z
      .string()
      .optional()
      .describe('Free-text query (protein name, gene, keyword, PDB title terms).'),
    sequence: z
      .string()
      .optional()
      .describe(
        'One-letter amino-acid sequence; triggers an RCSB mmseqs2 sequence-similarity search.',
      ),
    organism: z
      .string()
      .optional()
      .describe('Filter by source organism scientific name (e.g. "Homo sapiens").'),
    method: z
      .string()
      .optional()
      .describe('Filter by experimental method (e.g. "X-RAY DIFFRACTION", "ELECTRON MICROSCOPY").'),
    max_resolution: z
      .number()
      .positive()
      .optional()
      .describe('Maximum resolution in Å (lower is sharper); applies to experimental structures.'),
    min_identity: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        'Minimum sequence identity (0–1) for a sequence search. Requires sequence — supplying it without one is rejected, since the threshold would never reach RCSB. Default 0.',
      ),
    max_evalue: z
      .number()
      .positive()
      .optional()
      .describe(
        'Maximum E-value for a sequence search. Requires sequence — supplying it without one is rejected, since the threshold would never reach RCSB. Default 1.',
      ),
    content_type: z
      .enum(['experimental', 'predicted', 'all'])
      .default('all')
      .describe(
        'Which structure universe to search: experimental (PDB), predicted (computed models), or all.',
      ),
    facets: z
      .array(z.enum(FACET_DIMENSION_NAMES))
      .optional()
      .describe(
        'Optional dimensions to summarize as a facet breakdown alongside the hits. Each dimension at most once; repeating one is rejected.',
      ),
    limit: z.number().int().min(1).max(100).default(25).describe('Maximum hits to return (1–100).'),
    start: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Zero-based result offset. Combine with limit to retrieve later pages.'),
  }),

  output: z.object({
    hits: z
      .array(
        z
          .object({
            id: z.string().describe('Structure identifier (PDB entry ID or computed-model ID).'),
            entityId: z
              .string()
              .optional()
              .describe(
                'Matched polymer-entity ID for experimental sequence hits; id remains the chainable PDB entry ID.',
              ),
            source: z
              .enum(['experimental', 'predicted'])
              .describe('Which universe the hit came from.'),
            score: z.number().optional().describe('RCSB relevance score.'),
            uniprotAccession: z
              .string()
              .optional()
              .describe('UniProt accession parsed from a computed-model ID, when available.'),
            title: z.string().optional().describe('Structure title (enriched experimental hits).'),
            method: z
              .string()
              .optional()
              .describe('Experimental method(s) (enriched experimental hits).'),
            resolution: z
              .number()
              .optional()
              .describe('Resolution in Å (enriched experimental hits).'),
            organism: z
              .string()
              .optional()
              .describe('Primary source organism (enriched experimental hits).'),
          })
          .describe('A ranked structure hit with optional enrichment metadata.'),
      )
      .describe('Ranked structure hits.'),
    facets: z
      .array(flatFacetDimensionSchema)
      .optional()
      .describe(
        'Optional facet breakdown when requested — one flat dimension per requested facet. Cross-tabs (a dimension nested inside another) are protein_analyze_collection territory.',
      ),
  }),

  enrichment: {
    totalCount: z.number().describe('Total matches upstream before pagination.'),
    start: z.number().describe('Zero-based offset of the returned page.'),
    nextStart: z
      .number()
      .optional()
      .describe('Offset for the next page; absent on the final or past-end page.'),
    effectiveQuery: z.string().optional().describe('Echoed text query for follow-up calls.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Advisory note (empty results, predicted-search caveats, truncation, facet dimensions whose buckets cover materially less than totalCount). Carries every applicable advisory in one string.',
      ),
  },

  async handler(input, ctx) {
    if (
      !input.query &&
      !input.sequence &&
      !input.organism &&
      !input.method &&
      typeof input.max_resolution !== 'number'
    ) {
      throw ctx.fail(
        'no_criteria',
        'Provide a query, sequence, organism, method, or maximum resolution to search on.',
        {
          ...ctx.recoveryFor('no_criteria'),
        },
      );
    }
    // buildQuery() reads these two only inside its sequence branch, so without a
    // sequence they never reach RCSB and the response looks like a filtered search
    // that was never filtered. Rejected here rather than in the schema so the
    // caller gets a data.reason and the declared recovery hint alongside -32602.
    const sequenceModifiers = [
      typeof input.min_identity === 'number' ? 'min_identity' : undefined,
      typeof input.max_evalue === 'number' ? 'max_evalue' : undefined,
    ].filter((name) => name !== undefined);
    if (!input.sequence && sequenceModifiers.length > 0) {
      const many = sequenceModifiers.length > 1;
      throw ctx.fail(
        'sequence_modifier_without_sequence',
        `${sequenceModifiers.join(' and ')} ${many ? 'are sequence-search thresholds' : 'is a sequence-search threshold'}, but this request has no sequence — ${many ? 'they' : 'it'} would never reach RCSB.`,
        { ...ctx.recoveryFor('sequence_modifier_without_sequence') },
      );
    }
    // RCSB collapses two identically-named facet requests into one raw facet, and
    // the attribute-keyed lookup maps both specs back onto it — a repeated
    // dimension would return the same breakdown twice and double-count on any sum.
    const duplicate = input.facets?.find((d, i, all) => all.indexOf(d) !== i);
    if (duplicate)
      throw ctx.fail(
        'duplicate_dimension',
        `facets lists "${duplicate}" more than once; each dimension is summarized once.`,
        { ...ctx.recoveryFor('duplicate_dimension') },
      );
    const cfg = getServerConfig();
    const rcsb = getRcsbService();
    const facetSpecs = input.facets?.map((d) => buildFacetSpec(d));

    const result = await rcsb.search(
      {
        ...(input.query ? { text: input.query } : {}),
        ...(input.sequence ? { sequence: input.sequence } : {}),
        ...(input.organism ? { organism: input.organism } : {}),
        ...(input.method ? { method: input.method } : {}),
        ...(typeof input.max_resolution === 'number'
          ? { maxResolution: input.max_resolution }
          : {}),
        ...(typeof input.min_identity === 'number' ? { minIdentity: input.min_identity } : {}),
        ...(typeof input.max_evalue === 'number' ? { maxEvalue: input.max_evalue } : {}),
        contentType: CONTENT_TYPE_SCOPES[input.content_type],
        limit: input.limit,
        start: input.start,
      },
      ctx,
      facetSpecs,
    );

    const experimentalIds = [
      ...new Set(result.hits.filter((h) => !isPredictedId(h.id)).map((h) => entryIdOf(h.id))),
    ];
    const metaById = new Map<string, EntryMeta>();
    if (experimentalIds.length > 0) {
      for (const meta of await rcsb.getEntries(experimentalIds, ctx)) metaById.set(meta.id, meta);
    }

    const hits = result.hits.map((h) => toHit(h, metaById, Boolean(input.sequence)));
    const facets = result.facets?.map((f) => toFacetOutput(f, cfg.facetBucketCap, result.total));

    ctx.enrich.total(result.total);
    const nextStart = input.start + hits.length;
    ctx.enrich({
      start: input.start,
      ...(nextStart < result.total ? { nextStart } : {}),
    });
    if (input.query) ctx.enrich.echo(input.query);

    // `notice` is a single last-wins field, so the zero-hit advice, the capped-facet
    // advice, and one fragment per under-covered facet dimension compose into ONE string.
    const notices: string[] = [];
    if (hits.length === 0) notices.push(ZERO_HIT_NOTICE[input.content_type]);
    if (facets) {
      const capped = facets.filter((f) => f.truncated).map((f) => f.dimension);
      if (capped.length > 0)
        notices.push(truncationNotice(capped, cfg.facetBucketCap, Boolean(input.sequence)));
      notices.push(...coverageNotices(facets, result.total));
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return { hits, ...(facets ? { facets } : {}) };
  },

  format: (result) => {
    const lines: string[] = [`## Structure search — ${result.hits.length} hits`];
    for (const h of result.hits) {
      lines.push(`\n### ${h.id} _(${h.source})_`);
      if (h.title) lines.push(h.title);
      const meta = [
        h.entityId ? `**Entity:** ${h.entityId}` : null,
        h.method ? `**Method:** ${h.method}` : null,
        typeof h.resolution === 'number' ? `**Resolution:** ${h.resolution} Å` : null,
        h.organism ? `**Organism:** ${h.organism}` : null,
        h.uniprotAccession ? `**UniProt:** ${h.uniprotAccession}` : null,
        typeof h.score === 'number' ? `**Score:** ${h.score.toFixed(3)}` : null,
      ].filter(Boolean);
      if (meta.length > 0) lines.push(meta.join(' | '));
    }
    if (result.facets && result.facets.length > 0) {
      lines.push('\n## Facets');
      lines.push(...renderFacets(result.facets));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/** Build one output hit, folding in enrichment metadata when available. */
function toHit(hit: SearchHit, metaById: Map<string, EntryMeta>, sequenceSearch: boolean) {
  if (isPredictedId(hit.id)) {
    const accession = accessionFromCsm(hit.id);
    return {
      id: hit.id,
      source: 'predicted' as const,
      score: hit.score,
      ...(accession ? { uniprotAccession: accession } : {}),
    };
  }
  const entryId = entryIdOf(hit.id);
  const meta = metaById.get(entryId);
  return {
    id: sequenceSearch ? entryId : hit.id,
    ...(sequenceSearch ? { entityId: hit.id } : {}),
    source: 'experimental' as const,
    score: hit.score,
    ...(meta?.title ? { title: meta.title } : {}),
    ...(meta?.methods && meta.methods.length > 0 ? { method: meta.methods.join(', ') } : {}),
    ...(typeof meta?.resolution === 'number' ? { resolution: meta.resolution } : {}),
    ...(meta?.organisms && meta.organisms.length > 0 ? { organism: meta.organisms[0] } : {}),
  };
}
