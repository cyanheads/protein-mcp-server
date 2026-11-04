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
import { getRcsbService, METHOD_VOCABULARY } from '@/services/rcsb/rcsb-service.js';
import type { EntryMeta, SearchHit } from '@/services/rcsb/types.js';
import { entryIdOf, isComputedModelId } from '@/services/shared/identifiers.js';
import { normalizeProteinSequence } from '@/services/shared/protein-sequence.js';
import {
  alignmentLine,
  CONTENT_TYPE_SCOPES,
  coverageNotices,
  flatFacetDimensionSchema,
  matchedEntityOrganisms,
  oneWordOrganismNotice,
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

/** Zero-hit pointer for a ligand filter, which matches one exact component ID and nothing near it. */
const LIGAND_ZERO_HIT_NOTICE =
  'The ligand filter matches one exact chemical component ID held as a bound copy; resolve a ligand name to its ID, or confirm an ID, with protein_track_ligands mode "find_ligand".';

/**
 * Filters that select on data no computed model carries, with what each selects
 * on: RCSB indexes no experimental method, resolution, or non-polymer entity for
 * one, so under content_type "predicted" each can only match nothing.
 */
const EXPERIMENTAL_ONLY_FILTERS = [
  ['method', 'experimental method'],
  ['max_resolution', 'resolution'],
  ['ligand', 'bound ligands'],
] as const;

/**
 * Zero-hit advice under content_type "predicted" when experimental-only filters
 * were supplied: they emptied the result, whatever the rest of the request was.
 */
function computedModelNotice(filters: ReadonlyArray<(typeof EXPERIMENTAL_ONLY_FILTERS)[number]>) {
  const many = filters.length > 1;
  const lacking = new Intl.ListFormat('en', { type: 'disjunction' }).format(
    filters.map(([, selects]) => selects),
  );
  const named = new Intl.ListFormat('en').format(filters.map(([name]) => name));
  return `No predicted models matched: computed models carry no ${lacking}, so ${named} ${many ? 'match' : 'matches'} nothing under content_type "predicted". Drop ${many ? 'them' : 'it'}, or set content_type to "experimental" or "all".`;
}

/**
 * Why a search matched nothing, and the next move: the computed-model advice
 * when experimental-only filters emptied a predicted search, otherwise the
 * scope's own advice, plus the one-word organism advice and the find_ligand
 * pointer when those filters were set.
 */
function zeroHitNotice(input: {
  content_type: keyof typeof ZERO_HIT_NOTICE;
  ligand?: string | undefined;
  max_resolution?: number | undefined;
  method?: string | undefined;
  organism?: string | undefined;
}): string {
  const experimentalOnly = EXPERIMENTAL_ONLY_FILTERS.filter(
    ([name]) => input[name] !== undefined && input[name] !== '',
  );
  if (input.content_type === 'predicted' && experimentalOnly.length > 0) {
    return computedModelNotice(experimentalOnly);
  }
  return [
    ZERO_HIT_NOTICE[input.content_type],
    input.organism ? oneWordOrganismNotice(input.organism) : undefined,
    input.ligand ? LIGAND_ZERO_HIT_NOTICE : undefined,
  ]
    .filter(Boolean)
    .join(' ');
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
    ? `${named}. protein_analyze_collection cannot reproduce a sequence search, so narrow this request instead: drop sequence, or add organism, method, max_resolution, ligand, or query filters to shrink the distribution before the cap.`
    : `${named}. Call protein_analyze_collection with ${dimensions.length > 1 ? 'each dimension' : 'that dimension'} in group_by and a bucket_limit above ${cap} (up to 500) to reach the long tail.`;
}

export const searchStructures = tool('protein_search_structures', {
  title: 'protein-mcp-server: search structures',
  description:
    'Search experimental (PDB) and predicted (computed-model) protein structures by free text, protein sequence (triggers an mmseqs2 similarity search), and/or organism, method, resolution, and bound-ligand filters. Returns ranked hits; the experimental page is enriched with title, method, resolution, and source organisms (for a sequence hit, those of the matched entity), and every sequence hit carries its identity, E-value, bit score, and aligned range against the query. Chain hit IDs into protein_get_structure. Optionally returns a facet breakdown (counts by method / organism / release year / …) alongside the hits in the same response. Facets count the filtered result set, so an active organism or method filter also constrains its own facet: the facet lists only the values found in the matching entries (other organisms in the same complexes, other methods deposited with the same entries), never the alternatives the filter excluded. Numeric histogram buckets (resolution, molecular weight) carry explicit rangeFrom/rangeTo bounds so a boundary label is unambiguous.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'invalid_sequence',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The RCSB protein sequence contains invalid residues or has fewer than 10 residues after whitespace removal.',
      recovery:
        'Supply at least 10 one-letter residues A–I or K–Z (J excluded); remove punctuation or other invalid characters. Whitespace and ASCII lowercase are accepted.',
      thrownBy: 'service',
    },
    {
      reason: 'no_criteria',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'No query, sequence, organism, method, maximum resolution, or ligand was provided — nothing to search on.',
      recovery:
        'Provide a free-text query, protein sequence, organism, experimental method, maximum resolution, or bound-ligand component ID.',
    },
    {
      reason: 'unknown_method',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'method is neither one of the 13 RCSB experimental methods nor an accepted alias, so it could only ever match nothing.',
      recovery:
        'Pass one of the experimental methods the error lists, in any letter case, or an alias such as cryo-EM, X-ray, or NMR; omit method to search every method.',
      thrownBy: 'service',
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
        'Protein sequence for RCSB mmseqs2: at least 10 residues in A–I or K–Z (J excluded; B/O/U/X/Z accepted). Whitespace is removed and ASCII lowercase normalized.',
      ),
    organism: z
      .string()
      .optional()
      .describe(
        'Filter by source organism: a scientific name ("Homo sapiens"), an NCBI common name ("human", "E. coli"), or an NCBI taxon ID ("9606"), in any letter case. Matches that taxon and every taxon under it (strains, subspecies); a multi-word name also matches scientific names that contain it, such as "Escherichia coli (strain K12)". A word fragment ("coli") matches nothing.',
      ),
    method: z
      .string()
      .optional()
      .describe(
        `Filter by experimental method: ${METHOD_VOCABULARY}. Any other value is rejected. Computed models carry no method, so under content_type "predicted" this filter matches nothing.`,
      ),
    max_resolution: z
      .number()
      .positive()
      .optional()
      .describe('Maximum resolution in Å (lower is sharper); applies to experimental structures.'),
    ligand: z
      .string()
      .optional()
      .describe(
        'Filter by bound ligand: an exact chemical component ID (e.g. "STI" for imatinib, "HEM"), in any letter case. Keeps structures holding the component as a bound (non-polymer) copy, not as a residue inside a polymer chain. Resolve a ligand name to its ID with protein_track_ligands mode "find_ligand". Computed models carry no ligands, so under content_type "predicted" this filter matches nothing.',
      ),
    min_identity: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        'Minimum sequence identity (0–1) for a sequence search. Requires sequence — supplying it without one is rejected, since the threshold filters only a sequence search. Default 0.',
      ),
    max_evalue: z
      .number()
      .positive()
      .optional()
      .describe(
        'Maximum E-value for a sequence search. Requires sequence — supplying it without one is rejected, since the threshold filters only a sequence search. Default 1.',
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
                'Matched polymer-entity ID for sequence hits (e.g. 4HHB_1, AF_AFP69905F1_1); id remains the chainable entry ID.',
              ),
            source: z
              .enum(['experimental', 'predicted'])
              .describe('Which universe the hit came from.'),
            score: z
              .number()
              .optional()
              .describe(
                "RCSB relevance score, relative to the other hits of this search rather than a similarity measure; a sequence hit's similarity is in identity, evalue, and bitscore.",
              ),
            identity: z
              .number()
              .optional()
              .describe(
                'Sequence identity 0–1 over the alignment, to 4 decimal places (sequence hits).',
              ),
            evalue: z.number().optional().describe('Alignment E-value (sequence hits).'),
            bitscore: z.number().optional().describe('Alignment bit score (sequence hits).'),
            alignmentLength: z
              .number()
              .optional()
              .describe('Alignment length in columns, gaps included (sequence hits).'),
            queryStart: z
              .number()
              .optional()
              .describe('First aligned residue of the query, 1-based, inclusive (sequence hits).'),
            queryEnd: z
              .number()
              .optional()
              .describe('Last aligned residue of the query, 1-based, inclusive (sequence hits).'),
            targetStart: z
              .number()
              .optional()
              .describe(
                "First aligned residue of the hit, 1-based, inclusive, in the matched entity's sequence — not author residue numbering (sequence hits).",
              ),
            targetEnd: z
              .number()
              .optional()
              .describe(
                'Last aligned residue of the hit, 1-based, inclusive, in the same entity sequence as targetStart (sequence hits).',
              ),
            targetLength: z
              .number()
              .optional()
              .describe(
                'Length in residues of the entity sequence that targetStart and targetEnd index into (sequence hits).',
              ),
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
            organisms: z
              .array(z.string())
              .optional()
              .describe(
                "Source organisms (enriched experimental hits): for a sequence hit, those of the matched entity (entityId); otherwise every distinct source organism of the entry, in entity-number order. Omitted when unknown, including a sequence hit whose matched entity the entry's metadata lacks.",
              ),
          })
          .describe('A ranked structure hit with optional enrichment metadata.'),
      )
      .describe('Ranked structure hits.'),
    queryLength: z
      .number()
      .optional()
      .describe(
        "Length in residues of the query sequence that every hit's queryStart and queryEnd index into (sequence searches whose hits carry an alignment).",
      ),
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
      typeof input.max_resolution !== 'number' &&
      !input.ligand
    ) {
      throw ctx.fail(
        'no_criteria',
        'Provide a query, sequence, organism, method, maximum resolution, or ligand to search on.',
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
      );
    const cfg = getServerConfig();
    const rcsb = getRcsbService();
    const facetSpecs = input.facets?.map((d) => buildFacetSpec(d));

    const result = await rcsb.search(
      {
        ...(input.query ? { text: input.query } : {}),
        ...(input.sequence ? { sequence: normalizeProteinSequence(input.sequence) } : {}),
        ...(input.organism ? { organism: input.organism } : {}),
        ...(input.method ? { method: input.method } : {}),
        ...(typeof input.max_resolution === 'number'
          ? { maxResolution: input.max_resolution }
          : {}),
        ...(input.ligand ? { ligand: input.ligand } : {}),
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
      ...new Set(result.hits.filter((h) => !isComputedModelId(h.id)).map((h) => entryIdOf(h.id))),
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
    // An empty page with a nonzero total is an offset past the end, not a query
    // that matched nothing — the two need opposite next moves.
    if (hits.length === 0)
      notices.push(
        result.total === 0
          ? zeroHitNotice(input)
          : `start ${input.start} is past the end of the ${result.total} matches. Re-call with a lower start to read a populated page.`,
      );
    if (facets) {
      const capped = facets.filter((f) => f.truncated).map((f) => f.dimension);
      if (capped.length > 0)
        notices.push(truncationNotice(capped, cfg.facetBucketCap, Boolean(input.sequence)));
      notices.push(...coverageNotices(facets, result.total));
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      hits,
      ...(result.queryLength !== undefined ? { queryLength: result.queryLength } : {}),
      ...(facets ? { facets } : {}),
    };
  },

  format: (result) => {
    const lines: string[] = [`## Structure search — ${result.hits.length} hits`];
    if (typeof result.queryLength === 'number') {
      lines.push(`**Query length:** ${result.queryLength}`);
    }
    for (const h of result.hits) {
      lines.push(`\n### ${h.id} _(${h.source})_`);
      if (h.title) lines.push(h.title);
      const meta = [
        h.entityId ? `**Entity:** ${h.entityId}` : null,
        h.method ? `**Method:** ${h.method}` : null,
        typeof h.resolution === 'number' ? `**Resolution:** ${h.resolution} Å` : null,
        h.organisms ? `**Organisms:** ${h.organisms.join(', ')}` : null,
        h.uniprotAccession ? `**UniProt:** ${h.uniprotAccession}` : null,
        typeof h.score === 'number' ? `**Score:** ${h.score.toFixed(3)}` : null,
        typeof h.identity === 'number' ? `**Identity:** ${h.identity}` : null,
        typeof h.evalue === 'number' ? `**E-value:** ${h.evalue}` : null,
        typeof h.bitscore === 'number' ? `**Bit score:** ${h.bitscore}` : null,
      ].filter(Boolean);
      if (meta.length > 0) lines.push(meta.join(' | '));
      const alignment = alignmentLine(h);
      if (alignment) lines.push(alignment);
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
  // A sequence hit's identity, E-value, bit score, and aligned range; the
  // service sets only the fields upstream sent, so the spread defaults nothing.
  const { id: hitId, score, ...alignment } = hit;
  // A sequence search returns polymer entities in both universes (4HHB_1,
  // AF_AFP69905F1_1); `id` is the chainable entry and `entityId` the matched entity.
  const entryId = entryIdOf(hitId);
  const identity = {
    id: sequenceSearch ? entryId : hitId,
    ...(sequenceSearch ? { entityId: hitId } : {}),
  };
  if (isComputedModelId(hitId)) {
    const accession = accessionFromCsm(identity.id);
    return {
      ...identity,
      source: 'predicted' as const,
      score,
      ...alignment,
      ...(accession ? { uniprotAccession: accession } : {}),
    };
  }
  const meta = metaById.get(entryId);
  // A sequence hit names the organisms of the entity it matched: the entry's
  // other entities can come from other species (an antibody bound to a viral protein).
  const organisms = meta && (sequenceSearch ? matchedEntityOrganisms(meta, hitId) : meta.organisms);
  return {
    ...identity,
    source: 'experimental' as const,
    score,
    ...alignment,
    ...(meta?.title ? { title: meta.title } : {}),
    ...(meta?.methods && meta.methods.length > 0 ? { method: meta.methods.join(', ') } : {}),
    ...(typeof meta?.resolution === 'number' ? { resolution: meta.resolution } : {}),
    ...(organisms && organisms.length > 0 ? { organisms } : {}),
  };
}
