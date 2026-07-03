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
import type { ContentType, EntryMeta, SearchHit } from '@/services/rcsb/types.js';
import { entryIdOf } from '@/services/shared/identifiers.js';
import { facetDimensionSchema, renderFacets, toFacetOutput } from './_schemas.js';

const CONTENT_TYPE_MAP = {
  experimental: ['experimental'],
  predicted: ['computational'],
  all: ['experimental', 'computational'],
} satisfies Record<'experimental' | 'predicted' | 'all', ContentType[]>;

/** A computed-model identifier (AlphaFold / ModelArchive) vs an experimental PDB entry. */
function isPredictedId(id: string): boolean {
  return /^(AF|MA)_/i.test(id);
}

/** Pull a UniProt accession out of a computed-model identifier when present (`AF_AFP69905F1` → `P69905`). */
function accessionFromCsm(id: string): string | undefined {
  return /AF_AF([A-Z0-9]+?)F\d+$/i.exec(id)?.[1]?.toUpperCase();
}

export const searchStructures = tool('protein_search_structures', {
  title: 'protein-mcp-server: search structures',
  description:
    'Search experimental (PDB) and predicted (computed-model) protein structures by free text, ' +
    'protein sequence (triggers an mmseqs2 similarity search), and/or organism, method, and ' +
    'resolution filters. Returns ranked hits; the experimental page is enriched with title, method, ' +
    'resolution, and organism. Chain hit IDs into protein_get_structure. Optionally returns a facet ' +
    'breakdown (counts by method / organism / release year / …) alongside the hits at no extra call.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'no_criteria',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'No query, sequence, or organism was provided — nothing to search on.',
      recovery:
        'Provide a free-text query, a protein sequence, or an organism name (filters alone are not enough).',
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
      .describe('Minimum sequence identity (0–1) for a sequence search. Default 0.'),
    max_evalue: z
      .number()
      .positive()
      .optional()
      .describe('Maximum E-value for a sequence search. Default 1.'),
    content_type: z
      .enum(['experimental', 'predicted', 'all'])
      .default('all')
      .describe(
        'Which structure universe to search: experimental (PDB), predicted (computed models), or all.',
      ),
    facets: z
      .array(z.enum(FACET_DIMENSION_NAMES))
      .optional()
      .describe('Optional dimensions to summarize as a facet breakdown alongside the hits.'),
    limit: z.number().int().min(1).max(100).default(25).describe('Maximum hits to return (1–100).'),
  }),

  output: z.object({
    hits: z
      .array(
        z
          .object({
            id: z.string().describe('Structure identifier (PDB entry ID or computed-model ID).'),
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
      .array(facetDimensionSchema)
      .optional()
      .describe('Optional facet breakdown when requested.'),
  }),

  enrichment: {
    totalCount: z.number().describe('Total matches upstream before pagination.'),
    effectiveQuery: z.string().optional().describe('Echoed text query for follow-up calls.'),
    notice: z
      .string()
      .optional()
      .describe('Advisory note (empty results, predicted-search caveats, truncation).'),
  },

  async handler(input, ctx) {
    if (!input.query && !input.sequence && !input.organism) {
      throw ctx.fail('no_criteria', 'Provide a query, sequence, or organism to search on.', {
        ...ctx.recoveryFor('no_criteria'),
      });
    }
    const cfg = getServerConfig();
    const rcsb = getRcsbService();
    const contentTypes = CONTENT_TYPE_MAP[input.content_type];
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
        // RCSB scopes by content type; multi-content searches just union both halves.
        ...(contentTypes.length === 1 ? { contentType: contentTypes[0] } : {}),
        limit: input.limit,
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

    const hits = result.hits.map((h) => toHit(h, metaById));
    const facets = result.facets?.map((f) => toFacetOutput(f, cfg.facetBucketCap));

    ctx.enrich.total(result.total);
    if (input.query) ctx.enrich.echo(input.query);
    if (hits.length === 0) {
      ctx.enrich.notice(
        input.content_type === 'predicted'
          ? 'No predicted models matched. Predicted search covers computed models indexed by RCSB; try content_type "all".'
          : 'No structures matched. Broaden the query, drop filters, or switch content_type.',
      );
    }

    return { hits, ...(facets ? { facets } : {}) };
  },

  format: (result) => {
    const lines: string[] = [`## Structure search — ${result.hits.length} hits`];
    for (const h of result.hits) {
      lines.push(`\n### ${h.id} _(${h.source})_`);
      if (h.title) lines.push(h.title);
      const meta = [
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
function toHit(hit: SearchHit, metaById: Map<string, EntryMeta>) {
  if (isPredictedId(hit.id)) {
    const accession = accessionFromCsm(hit.id);
    return {
      id: hit.id,
      source: 'predicted' as const,
      score: hit.score,
      ...(accession ? { uniprotAccession: accession } : {}),
    };
  }
  const meta = metaById.get(entryIdOf(hit.id));
  return {
    id: hit.id,
    source: 'experimental' as const,
    score: hit.score,
    ...(meta?.title ? { title: meta.title } : {}),
    ...(meta?.methods && meta.methods.length > 0 ? { method: meta.methods.join(', ') } : {}),
    ...(typeof meta?.resolution === 'number' ? { resolution: meta.resolution } : {}),
    ...(meta?.organisms && meta.organisms.length > 0 ? { organism: meta.organisms[0] } : {}),
  };
}
