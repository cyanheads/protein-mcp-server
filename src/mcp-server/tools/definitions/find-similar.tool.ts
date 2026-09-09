/**
 * @fileoverview protein_find_similar — find structurally or evolutionarily related
 * proteins. by:sequence runs a synchronous RCSB mmseqs2 search; by:structure runs
 * an async Foldseek search against experimental + predicted databases (submit →
 * poll → bounded timeout, returning "still computing" rather than blocking).
 * Both modes page their results the same way (totalCount / start / nextStart),
 * and a completed structure job returns its ticket so it can be re-paged instead
 * of resubmitted. Fields the selected mode cannot consume are rejected, not
 * ignored.
 * @module mcp-server/tools/definitions/find-similar.tool
 */

import { type HandlerContext, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getAlphaFoldService } from '@/services/alphafold/alphafold-service.js';
import { type FoldseekOutcome, getFoldseekService } from '@/services/foldseek/foldseek-service.js';
import { getRcsbService } from '@/services/rcsb/rcsb-service.js';
import type { EntryMeta } from '@/services/rcsb/types.js';
import { fetchText } from '@/services/shared/http.js';
import { entryIdOf, isPdbId, isUniProtAccession } from '@/services/shared/identifiers.js';
import { getUniProtService } from '@/services/uniprot/uniprot-service.js';

const DEFAULT_FOLDSEEK_DBS = ['pdb100', 'afdb50'];
const FOLDSEEK_MODE = '3diaa';

const inputSchema = z.object({
  by: z
    .enum(['sequence', 'structure'])
    .describe('Similarity axis: sequence (mmseqs2) or structure (Foldseek).'),
  sequence: z
    .string()
    .optional()
    .describe('One-letter amino-acid sequence to search from (by:sequence).'),
  pdb_id: z.string().optional().describe('PDB entry ID to derive the query from.'),
  uniprot: z.string().optional().describe('UniProt accession to derive the query from.'),
  ticket_id: z
    .string()
    .optional()
    .describe(
      'Foldseek ticket ID from a prior by:structure response whose status was "computing". When set, polls that existing job instead of submitting a new search (by:structure only) — pdb_id/uniprot/databases are ignored.',
    ),
  databases: z
    .array(z.string())
    .optional()
    .describe(
      'Foldseek target databases (by:structure). Default pdb100 + afdb50. e.g. afdb-swissprot, BFVD.',
    ),
  max_evalue: z
    .number()
    .positive()
    .optional()
    .describe('Maximum E-value (by:sequence). Default 1.'),
  min_identity: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Minimum sequence identity 0–1 (by:sequence). Default 0.'),
  limit: z.number().int().min(1).max(100).default(25).describe('Maximum hits to return (1–100).'),
  start: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      'Zero-based result offset. Pages a by:sequence search, and a completed by:structure job when re-called with its ticket_id.',
    ),
});

const outputSchema = z.object({
  by: z.enum(['sequence', 'structure']).describe('Echoed similarity axis.'),
  engine: z.string().describe('The engine that answered (e.g. "RCSB mmseqs2", "Foldseek").'),
  status: z
    .enum(['complete', 'computing'])
    .describe('complete with hits, or computing (async — re-call with ticket_id to resume).'),
  ticketId: z
    .string()
    .optional()
    .describe(
      'Async job ticket ID (by:structure). Present while status is computing, and also on a complete response — re-call with ticket_id plus a different start/limit to page the same finished job instead of resubmitting.',
    ),
  hits: z
    .array(
      z
        .object({
          id: z
            .string()
            .describe(
              'Hit identifier that chains directly into protein_get_structure: a bare PDB entry ID (e.g. 1A00), or a UniProt accession for predicted hits.',
            ),
          entityId: z
            .string()
            .optional()
            .describe(
              'Matched polymer-entity ID (e.g. 1A00_1) for sequence hits; the chainable entry ID is in `id`.',
            ),
          source: z
            .enum(['experimental', 'predicted'])
            .describe('Whether the hit is an experimental or predicted structure.'),
          score: z.number().optional().describe('Relevance / alignment score.'),
          evalue: z.number().optional().describe('Alignment E-value (structure hits).'),
          identity: z
            .number()
            .optional()
            .describe('Sequence identity 0–1 over the alignment (structure hits).'),
          database: z
            .string()
            .optional()
            .describe('Source database the hit came from (structure hits).'),
          title: z.string().optional().describe('Structure title (enriched sequence hits).'),
          organism: z.string().optional().describe('Source organism (enriched sequence hits).'),
          uniprotAccession: z
            .string()
            .optional()
            .describe('UniProt accession (predicted structure hits).'),
        })
        .describe('A similar protein, with alignment scores when available.'),
    )
    .describe('Similar proteins, best first.'),
});

const enrichmentShape = {
  totalCount: z.number().optional().describe('Total upstream matches before pagination.'),
  start: z.number().optional().describe('Zero-based offset of the returned result page.'),
  nextStart: z
    .number()
    .optional()
    .describe('Offset for the next result page; absent on the final or past-end page.'),
  notice: z.string().optional().describe('Advisory note (still computing, empty results).'),
};

type FindSimilarInput = z.infer<typeof inputSchema>;
type FindSimilarOutput = z.infer<typeof outputSchema>;
type Ctx = HandlerContext<
  'missing_query' | 'mode_mismatched_field' | 'no_sequence' | 'search_failed' | 'ticket_not_found',
  typeof enrichmentShape
>;

export const findSimilar = tool('protein_find_similar', {
  title: 'protein-mcp-server: find similar',
  description: `Find structurally or evolutionarily related proteins. by:"sequence" runs an RCSB mmseqs2 sequence-similarity search (synchronous) over a sequence — supplied directly, or pulled from a PDB ID or UniProt accession. by:"structure" runs a Foldseek fold-similarity search (asynchronous) against experimental and predicted databases; if the job is still computing when the poll budget elapses, the response reports status "computing" with a ticket — re-call with ticket_id set to that value to resume the same job instead of resubmitting, and a complete response carries the same ticket so a finished job can be re-paged with a different start. Each mode reads only its own controls: sequence, max_evalue and min_identity belong to by:"sequence"; ticket_id and databases belong to by:"structure"; pdb_id, uniprot, start and limit are shared. A field the selected mode cannot consume is rejected rather than silently ignored. Output names the engine and database each hit came from.`,
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'missing_query',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'None of sequence, pdb_id, or uniprot was provided.',
      recovery: 'Provide a raw sequence, a PDB entry ID, or a UniProt accession to search from.',
    },
    {
      reason: 'mode_mismatched_field',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'An input field only the other by mode consumes was supplied: sequence, max_evalue or min_identity under by:"structure"; ticket_id or a non-empty databases list under by:"sequence".',
      recovery:
        'Drop the field, or switch by to the mode that reads it — sequence, max_evalue and min_identity apply to by:"sequence"; ticket_id and databases apply to by:"structure".',
    },
    {
      reason: 'no_sequence',
      code: JsonRpcErrorCode.NotFound,
      when: 'A sequence could not be resolved from the given PDB ID or UniProt accession.',
      recovery:
        'Verify the identifier, or pass a raw one-letter sequence directly via the sequence parameter.',
    },
    {
      reason: 'search_failed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The Foldseek search service rejected or failed the structure job.',
      retryable: true,
      recovery:
        'Retry shortly; if it persists, verify the source structure has coordinates via protein_get_structure.',
    },
    {
      reason: 'ticket_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The supplied ticket_id was rejected by Foldseek as an invalid or expired ticket.',
      recovery:
        'Tickets expire once results age out; drop ticket_id and re-run the by:structure search from pdb_id or uniprot to get a fresh one.',
    },
  ],

  input: inputSchema,
  output: outputSchema,
  enrichment: enrichmentShape,

  // `async` so the pre-dispatch guard rejects rather than throwing synchronously
  // out of the call itself — every failure on this tool reaches the caller the
  // same way.
  async handler(input, ctx): Promise<FindSimilarOutput> {
    const cfg = getServerConfig();
    rejectModeMismatchedFields(input, ctx);
    return input.by === 'sequence'
      ? await runSequence(input, ctx)
      : await runStructure(input, cfg.asyncPollTimeoutMs, ctx);
  },

  format: (result) => {
    const lines: string[] = [`## ${result.engine} (by:${result.by}) — ${result.status}`];
    if (result.ticketId)
      lines.push(
        `**Ticket:** ${result.ticketId} — re-call with ticket_id to resume or re-page this job.`,
      );
    for (const h of result.hits) {
      lines.push(`\n### ${h.id} _(${h.source})_`);
      if (h.title) lines.push(h.title);
      const parts = [
        h.entityId ? `**Entity:** ${h.entityId}` : null,
        typeof h.score === 'number' ? `**Score:** ${h.score}` : null,
        typeof h.evalue === 'number' ? `**E-value:** ${h.evalue}` : null,
        typeof h.identity === 'number' ? `**Identity:** ${h.identity}` : null,
        h.database ? `**DB:** ${h.database}` : null,
        h.organism ? `**Organism:** ${h.organism}` : null,
        h.uniprotAccession ? `**UniProt:** ${h.uniprotAccession}` : null,
      ].filter(Boolean);
      if (parts.length > 0) lines.push(parts.join(' | '));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

async function runSequence(input: FindSimilarInput, ctx: Ctx): Promise<FindSimilarOutput> {
  const rcsb = getRcsbService();
  const sequence = await resolveSequence(input, ctx);

  const result = await rcsb.searchSequence(
    sequence,
    {
      ...(typeof input.max_evalue === 'number' ? { maxEvalue: input.max_evalue } : {}),
      ...(typeof input.min_identity === 'number' ? { minIdentity: input.min_identity } : {}),
      limit: input.limit,
      start: input.start,
    },
    ctx,
  );

  const entryIds = [...new Set(result.hits.map((h) => entryIdOf(h.id)))];
  const metaById = new Map<string, EntryMeta>();
  if (entryIds.length > 0) {
    for (const meta of await rcsb.getEntries(entryIds, ctx)) metaById.set(meta.id, meta);
  }

  ctx.enrich.total(result.total);
  const nextStart = input.start + result.hits.length;
  ctx.enrich({
    start: input.start,
    ...(nextStart < result.total ? { nextStart } : {}),
  });
  if (result.hits.length === 0)
    ctx.enrich.notice('No sequence-similar entries found. Lower min_identity or raise max_evalue.');

  return {
    by: 'sequence',
    engine: 'RCSB mmseqs2',
    status: 'complete',
    hits: result.hits.map((h) => {
      // mmseqs2 emits polymer-entity IDs (1A00_1); expose the bare entry ID as
      // `id` so it chains uniformly into protein_get_structure like the other
      // tools, and keep the raw entity ID as `entityId` for the matched entity.
      const entryId = entryIdOf(h.id);
      const meta = metaById.get(entryId);
      return {
        id: entryId,
        entityId: h.id,
        source: 'experimental' as const,
        score: h.score,
        ...(meta?.title ? { title: meta.title } : {}),
        ...(meta?.organisms[0] ? { organism: meta.organisms[0] } : {}),
      };
    }),
  };
}

async function runStructure(
  input: FindSimilarInput,
  timeoutMs: number,
  ctx: Ctx,
): Promise<FindSimilarOutput> {
  const foldseek = getFoldseekService();
  let outcome: FoldseekOutcome;
  if (input.ticket_id) {
    // Resume path: poll the existing ticket, skipping coordinate resolution +
    // submit. A completed ticket is idempotent upstream, so a re-call with a new
    // start/limit pages the same finished job instead of running a second search.
    outcome = await foldseek.resume(
      { ticketId: input.ticket_id, limit: input.limit, start: input.start, timeoutMs },
      ctx,
    );
  } else {
    const { content, fileName } = await resolveCoordinateFile(input, ctx);
    outcome = await foldseek.search(
      {
        fileContent: content,
        fileName,
        databases:
          input.databases && input.databases.length > 0 ? input.databases : DEFAULT_FOLDSEEK_DBS,
        mode: FOLDSEEK_MODE,
        limit: input.limit,
        start: input.start,
        timeoutMs,
      },
      ctx,
    );
  }

  if (outcome.status === 'not_found') {
    throw ctx.fail(
      'ticket_not_found',
      `Foldseek ticket ${outcome.ticketId} is invalid or expired.`,
      { ...ctx.recoveryFor('ticket_not_found') },
    );
  }
  if (outcome.status === 'failed') {
    throw ctx.fail('search_failed', `Foldseek search failed: ${outcome.error}`, {
      recovery: {
        hint: 'Retry shortly; if it persists, confirm the source structure has coordinates.',
      },
    });
  }
  if (outcome.status === 'computing') {
    ctx.enrich.notice(
      `Foldseek job still computing (ticket ${outcome.ticketId}). Re-call protein_find_similar with ticket_id set to "${outcome.ticketId}" to resume.`,
    );
    return {
      by: 'structure',
      engine: 'Foldseek',
      status: 'computing',
      ticketId: outcome.ticketId,
      hits: [],
    };
  }

  // Same paging contract the sequence branch emits: the completed job's full hit
  // count plus the offsets needed to walk it, computed from the hit array the
  // service already parsed — no extra upstream call.
  ctx.enrich.total(outcome.total);
  const nextStart = input.start + outcome.hits.length;
  ctx.enrich({
    start: input.start,
    ...(nextStart < outcome.total ? { nextStart } : {}),
  });
  // An empty page has two unrelated causes now that `start` pages a completed
  // job, and they need opposite next moves: no hits at all means widen the
  // databases, while a start past the end means ask for a lower offset.
  if (outcome.hits.length === 0) {
    ctx.enrich.notice(
      outcome.total === 0
        ? 'Foldseek returned no fold-similar hits in the selected databases.'
        : `start ${input.start} is past the end of this job's ${outcome.total} hits. Re-call with a lower start to read a populated page.`,
    );
  }
  return {
    by: 'structure',
    engine: 'Foldseek',
    status: 'complete',
    ticketId: outcome.ticketId,
    hits: outcome.hits.map((h) => ({
      id: h.pdbId ?? h.uniprotAccession ?? h.target,
      source: h.targetType === 'alphafold' ? ('predicted' as const) : ('experimental' as const),
      ...(typeof h.score === 'number' ? { score: h.score } : {}),
      ...(typeof h.evalue === 'number' ? { evalue: h.evalue } : {}),
      ...(typeof h.sequenceIdentity === 'number' ? { identity: h.sequenceIdentity } : {}),
      database: h.database,
      ...(h.uniprotAccession ? { uniprotAccession: h.uniprotAccession } : {}),
    })),
  };
}

/**
 * Reject an input field the selected `by` mode cannot consume. Each branch reads
 * only its own subset — `runSequence` alone reads sequence/max_evalue/
 * min_identity, `runStructure` alone reads ticket_id/databases — so a field
 * supplied for the other mode would be dropped silently, making an unfiltered
 * search look filtered or an unscoped one look scoped. Guarded here rather than
 * by a Zod refine so the rejection carries `data.reason` and a recovery hint
 * naming the mode that accepts the field. `start` and `limit` are shared by both
 * modes and are never read here; an empty `databases` array matches
 * `runStructure`'s own fallback and is treated as omitted.
 */
function rejectModeMismatchedFields(input: FindSimilarInput, ctx: Ctx): void {
  const offenders = (
    input.by === 'structure'
      ? [
          input.sequence ? 'sequence' : null,
          typeof input.max_evalue === 'number' ? 'max_evalue' : null,
          typeof input.min_identity === 'number' ? 'min_identity' : null,
        ]
      : [
          typeof input.ticket_id === 'string' ? 'ticket_id' : null,
          input.databases && input.databases.length > 0 ? 'databases' : null,
        ]
  ).filter((field): field is string => field !== null);
  if (offenders.length === 0) return;

  const accepting = input.by === 'structure' ? 'sequence' : 'structure';
  const plural = offenders.length > 1;
  throw ctx.fail(
    'mode_mismatched_field',
    `by:"${input.by}" does not consume ${offenders.join(', ')}.`,
    {
      recovery: {
        hint: `${offenders.join(', ')} ${plural ? 'are' : 'is'} only read under by:"${accepting}". Drop ${plural ? 'them' : 'it'}, or set by:"${accepting}" to apply ${plural ? 'them' : 'it'}.`,
      },
    },
  );
}

/** Resolve a query sequence from a direct sequence, PDB ID, or UniProt accession. */
async function resolveSequence(input: FindSimilarInput, ctx: Ctx): Promise<string> {
  if (input.sequence) return input.sequence.replace(/\s+/g, '');
  if (input.pdb_id) {
    const seq = await getRcsbService().getSequence(input.pdb_id, ctx);
    if (!seq)
      throw ctx.fail(
        'no_sequence',
        `No protein sequence found for PDB entry ${input.pdb_id.toUpperCase()}.`,
        { ...ctx.recoveryFor('no_sequence') },
      );
    return seq.sequence;
  }
  if (input.uniprot) {
    const seq = await getUniProtService().getSequence(input.uniprot, ctx);
    if (!seq)
      throw ctx.fail(
        'no_sequence',
        `No sequence found for UniProt accession ${input.uniprot.toUpperCase()}.`,
        { ...ctx.recoveryFor('no_sequence') },
      );
    return seq;
  }
  throw ctx.fail('missing_query', 'Provide a sequence, pdb_id, or uniprot to search from.', {
    ...ctx.recoveryFor('missing_query'),
  });
}

/** Resolve a query coordinate file (PDB-format text) from a PDB ID or UniProt accession. */
async function resolveCoordinateFile(
  input: FindSimilarInput,
  ctx: Ctx,
): Promise<{ content: string; fileName: string }> {
  const rcsb = getRcsbService();
  if (input.pdb_id && isPdbId(input.pdb_id)) {
    const id = input.pdb_id.toUpperCase();
    const content = await fetchCoordinateText(rcsb.coordinateFileUrl(id, 'pdb'), ctx);
    return { content, fileName: `${id}.pdb` };
  }
  if (input.uniprot && isUniProtAccession(input.uniprot)) {
    const model = await getAlphaFoldService().getPrediction(input.uniprot, ctx);
    if (!model?.pdbUrl) {
      throw ctx.fail(
        'no_sequence',
        `No predicted model with coordinates found for ${input.uniprot.toUpperCase()}.`,
        { ...ctx.recoveryFor('no_sequence') },
      );
    }
    return {
      content: await fetchCoordinateText(model.pdbUrl, ctx),
      fileName: `${input.uniprot.toUpperCase()}.pdb`,
    };
  }
  // The declared recovery hint offers a raw sequence, which by:"structure"
  // rejects outright — this branch names only the two identifiers that mode can
  // actually derive coordinates from.
  throw ctx.fail(
    'missing_query',
    'by:structure requires a pdb_id or uniprot accession to derive coordinates.',
    {
      recovery: {
        hint: 'Provide pdb_id (e.g. 1CRN) or uniprot (e.g. P69905); by:"structure" derives coordinates from an identifier, never from a raw sequence.',
      },
    },
  );
}

function fetchCoordinateText(url: string, ctx: Ctx): Promise<string> {
  return fetchText(url, ctx, {
    operation: 'findSimilar.fetchCoordinates',
    label: 'Coordinate file',
    baseDelayMs: 400,
    maxRetries: 1,
  });
}
