/**
 * @fileoverview protein_find_similar — find structurally or evolutionarily related
 * proteins. by:sequence runs a synchronous RCSB mmseqs2 search; by:structure runs
 * an async Foldseek search against experimental + predicted databases (submit →
 * poll → bounded timeout, returning "still computing" rather than blocking).
 * Both modes page their results the same way (totalCount / start / nextStart),
 * and a completed structure job returns its ticket so it can be re-paged instead
 * of resubmitted. A structure response covers one Foldseek query (one chain of a
 * multichain file), selected by `query` and disclosed with `queryCount`. A
 * sequence query taken from a PDB entry is one protein entity, picked by `chain`
 * or by default and named as `queryEntityId`. Every request a call chains shares
 * one call budget. Fields the selected mode cannot consume are rejected, not ignored.
 * @module mcp-server/tools/definitions/find-similar.tool
 */

import { type HandlerContext, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, type McpError, timeout } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getAlphaFoldService } from '@/services/alphafold/alphafold-service.js';
import {
  FOLDSEEK_DATABASES,
  type FoldseekDatabase,
  type FoldseekOutcome,
  getFoldseekService,
} from '@/services/foldseek/foldseek-service.js';
import { getRcsbService } from '@/services/rcsb/rcsb-service.js';
import type { EntryMeta, ProteinEntitySummary } from '@/services/rcsb/types.js';
import { withCallBudget } from '@/services/shared/call-budget.js';
import { fetchTextWindow } from '@/services/shared/http.js';
import {
  canonicalAccessionOf,
  entryIdOf,
  isPdbId,
  isPredictionAccession,
  isUniProtEntryName,
} from '@/services/shared/identifiers.js';
import { normalizeProteinSequence } from '@/services/shared/protein-sequence.js';
import {
  type AccessionStatus,
  getUniProtService,
  inactiveAccessionError,
  mergedAccessionNotice,
} from '@/services/uniprot/uniprot-service.js';
import { alignmentLine, matchedEntityOrganisms } from './_schemas.js';

const DEFAULT_FOLDSEEK_DBS: readonly FoldseekDatabase[] = ['pdb100', 'afdb50'];
const FOLDSEEK_MODE = '3diaa';

/**
 * Most characters of a coordinate file this tool downloads and uploads as a
 * Foldseek query. Sized to hold the mmCIF file of any entry small enough for the
 * legacy PDB format, with headroom for metadata-heavy files; every AlphaFold DB
 * model is far smaller.
 */
const COORDINATE_CHAR_LIMIT = 16_000_000;
const COORDINATE_LIMIT_TEXT = `${COORDINATE_CHAR_LIMIT.toLocaleString('en-US')} characters`;

/**
 * Recovery for a by:"structure" UniProt accession without a usable AlphaFold DB
 * model. The declared no_sequence recovery offers a raw sequence, which this
 * mode rejects, so this names only the identifiers by:"structure" reads.
 */
const NO_MODEL_RECOVERY = {
  recovery: {
    hint: 'Pass pdb_id for an experimental structure of the protein instead (protein_search_structures finds entries by protein or gene name), or check the accession.',
  },
};

const inputSchema = z.object({
  by: z
    .enum(['sequence', 'structure'])
    .describe('Similarity axis: sequence (mmseqs2) or structure (Foldseek).'),
  sequence: z
    .string()
    .optional()
    .describe(
      'Protein sequence for by:sequence: at least 10 residues in A–I or K–Z (J excluded; B/O/U/X/Z accepted). Whitespace is removed and ASCII lowercase normalized.',
    ),
  pdb_id: z
    .string()
    .optional()
    .describe(
      `PDB entry ID to derive the query from. by:"sequence" searches one of its protein entities (see chain); by:"structure" uploads its mmCIF file, up to ${COORDINATE_LIMIT_TEXT}.`,
    ),
  chain: z
    .string()
    .optional()
    .describe(
      'Author chain ID (auth_asym_id, case-sensitive) of pdb_id selecting the protein entity whose sequence by:"sequence" searches, e.g. "B" for the beta chain of 4HHB. Requires pdb_id. Default: the lowest-numbered protein entity of at least 10 residues; DNA and RNA chains never qualify.',
    ),
  uniprot: z
    .string()
    .optional()
    .describe(
      'UniProt identifier to derive the query from: a canonical accession (e.g. P69905), an isoform accession (e.g. P04637-2), or a UniProtKB entry name (e.g. HBA_HUMAN), which resolves to its entry’s accession. by:"sequence" searches its UniProt sequence, by:"structure" its AlphaFold DB model. A merged accession answers for its successor, with a notice.',
    ),
  ticket_id: z
    .string()
    .optional()
    .describe(
      'Foldseek ticket ID from a prior by:structure response whose status was "computing". When set, polls that existing job instead of submitting a new search (by:structure only) — pdb_id/uniprot/databases are ignored.',
    ),
  databases: z
    .array(z.enum(FOLDSEEK_DATABASES))
    .optional()
    .describe(
      'Foldseek target databases (by:structure), by exact name. Default pdb100 + afdb50. pdb100: experimental PDB entries; afdb50, afdb-swissprot, afdb-proteome: AlphaFold DB models; cath50: CATH domains of PDB chains and AlphaFold models; bfvd_v3: predicted viral proteins; mgnify_esm30, gmgcl_id: predicted metagenomic proteins; bfmd: predicted complexes.',
    ),
  query: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Zero-based Foldseek query index (by:structure). Default 0. Foldseek splits a multichain structure into one query per chain, in file order; queryCount in the response says how many the job holds. Pass the same value with ticket_id to resume or re-page that query.',
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
  query: z
    .number()
    .optional()
    .describe('Zero-based Foldseek query index the hits belong to (by:structure).'),
  queryCount: z
    .number()
    .optional()
    .describe(
      'Number of queries the Foldseek job holds, one per chain of the submitted structure (by:structure, complete). Valid query values run from 0 to queryCount - 1.',
    ),
  queryLength: z
    .number()
    .optional()
    .describe(
      'Length in residues of the query sequence that queryStart and queryEnd index into on every hit (complete responses whose hits carry aligned ranges; for by:structure, the chain of the selected query).',
    ),
  queryEntityId: z
    .string()
    .optional()
    .describe(
      'Polymer entity of pdb_id whose sequence by:"sequence" searched (e.g. 4HHB_1). Present only when the query came from pdb_id.',
    ),
  hits: z
    .array(
      z
        .object({
          id: z
            .string()
            .optional()
            .describe(
              'Hit identifier that chains directly into protein_get_structure: a bare PDB entry ID (e.g. 1A00), or a UniProt accession for a predicted model. Absent on a structure hit whose target names neither (bfvd_v3, mgnify_esm30, gmgcl_id, bfmd) — read target and database instead.',
            ),
          target: z
            .string()
            .optional()
            .describe(
              'Foldseek target name (structure hits): the header text before the first space, as Foldseek returns it — e.g. 1crn-assembly1.cif.gz_A (pdb100), AF-P01542-F1-model_v6 (AlphaFold DB), 1cbnA00 (a cath50 domain), MGYP001043648370.pdb.gz (mgnify_esm30). Read it with database; the only handle on a hit with no id.',
            ),
          entityId: z
            .string()
            .optional()
            .describe(
              'Matched polymer-entity ID (e.g. 1A00_1) for sequence hits; the chainable entry ID is in `id`.',
            ),
          source: z
            .enum(['experimental', 'predicted'])
            .describe(
              'Whether the hit is an experimental or predicted structure. Structure hits are experimental for pdb100 entries and cath50 domains of PDB chains, and predicted for every other database, cath50 domains of AlphaFold models included.',
            ),
          chain: z
            .string()
            .optional()
            .describe(
              'Matched chain of the PDB entry in id (structure hits). pdb100: the author chain ID (auth_asym_id) in the assembly file Foldseek indexed, with a -N suffix marking a symmetry copy (A-2) — drop the suffix before passing it as chain to protein_get_annotations. cath50: the chain of the domain, absent when CATH recorded none.',
            ),
          score: z
            .number()
            .optional()
            .describe(
              'Ranking score. by:"sequence": the RCSB relevance rank within the result set, bit scores rescaled from 1 (best hit) to 0 (worst) — a rank, not a similarity measure; read identity, evalue, and bitscore for that. by:"structure": the Foldseek alignment bit score.',
            ),
          evalue: z.number().optional().describe('Alignment E-value.'),
          bitscore: z
            .number()
            .optional()
            .describe(
              'Alignment bit score from mmseqs2 (sequence hits); a structure hit carries its bit score as score.',
            ),
          probability: z
            .number()
            .optional()
            .describe(
              'Estimated probability (0–1), from Foldseek, that the query and hit are homologous (structure hits).',
            ),
          identity: z
            .number()
            .optional()
            .describe('Sequence identity 0–1 over the alignment, to 4 decimal places.'),
          alignmentLength: z
            .number()
            .optional()
            .describe('Alignment length in columns, gaps included.'),
          queryStart: z
            .number()
            .optional()
            .describe('First aligned residue of the query, 1-based, inclusive.'),
          queryEnd: z
            .number()
            .optional()
            .describe('Last aligned residue of the query, 1-based, inclusive.'),
          targetStart: z
            .number()
            .optional()
            .describe(
              'First aligned residue of the hit, 1-based, inclusive, in the sequence the search indexed for that hit — not author residue numbering. For a sequence hit that sequence is the matched polymer entity (entityId); for a structure hit, the indexed chain, model, or CATH domain.',
            ),
          targetEnd: z
            .number()
            .optional()
            .describe(
              'Last aligned residue of the hit, 1-based, inclusive, in the same indexed sequence as targetStart.',
            ),
          targetLength: z
            .number()
            .optional()
            .describe(
              'Length in residues of the hit sequence that targetStart and targetEnd index into.',
            ),
          database: z
            .string()
            .optional()
            .describe('Source database the hit came from (structure hits).'),
          title: z
            .string()
            .optional()
            .describe(
              'Title: the entry title (sequence hits and pdb100 structure hits), or the name of the modeled protein (AlphaFold DB and bfvd_v3 structure hits).',
            ),
          organisms: z
            .array(z.string())
            .optional()
            .describe(
              'Source organisms. Sequence hits: those of the matched polymer entity (entityId), not the whole entry, absent when the entry metadata names none for it. Structure hits: the organism of the target from the Foldseek taxonomy, one element — absent for mgnify_esm30 and gmgcl_id, which carry no taxonomy, and for unclassified targets.',
            ),
          taxId: z
            .number()
            .optional()
            .describe(
              'NCBI taxonomy ID of the organism in organisms (structure hits; present exactly when a structure hit carries organisms).',
            ),
          uniprotAccession: z
            .string()
            .optional()
            .describe(
              'UniProt accession of the modeled protein (structure hits from AlphaFold DB, bfvd_v3, and cath50 domains of AlphaFold models). A bfvd_v3 hit carries it without an id; pass it to protein_get_annotations.',
            ),
        })
        .describe('A similar protein, with alignment scores when available.'),
    )
    .describe(
      'Similar proteins, best first. Structure hits are ranked by score across all searched databases (hits without a score last, ties by database then target).',
    ),
});

const enrichmentShape = {
  totalCount: z.number().optional().describe('Total upstream matches before pagination.'),
  start: z.number().optional().describe('Zero-based offset of the returned result page.'),
  nextStart: z
    .number()
    .optional()
    .describe('Offset for the next result page; absent on the final or past-end page.'),
  notice: z
    .string()
    .optional()
    .describe(
      'Advisory note: a structure job still computing, or one the call’s time budget cut off after submitting (with how to resume it), no matches, a start past the end of the results, other queries in a multichain structure job, the default protein entity a pdb_id sequence query searched alongside the entry’s other protein entities, or a merged UniProt accession answered for its successor.',
    ),
};

type FindSimilarInput = z.infer<typeof inputSchema>;
type FindSimilarOutput = z.infer<typeof outputSchema>;
type Ctx = HandlerContext<
  | 'chain_not_found'
  | 'chain_without_pdb_id'
  | 'databases_rejected'
  | 'invalid_accession'
  | 'missing_query'
  | 'mode_mismatched_field'
  | 'no_sequence'
  | 'query_out_of_range'
  | 'search_failed'
  | 'structure_too_large'
  | 'ticket_not_found',
  typeof enrichmentShape
>;

export const findSimilar = tool('protein_find_similar', {
  title: 'protein-mcp-server: find similar',
  description: `Find structurally or evolutionarily related proteins. by:"sequence" runs an RCSB mmseqs2 sequence-similarity search (synchronous; experimental PDB entries only — protein_search_structures with a sequence also reaches computed models) over a sequence — supplied directly, taken from one protein entity of a PDB entry (chain picks it; by default the lowest-numbered protein entity of at least 10 residues; queryEntityId names it), or pulled from a UniProt accession (isoforms included) or entry name (HBA_HUMAN); each hit carries its identity, E-value, bit score, and aligned range. by:"structure" runs a Foldseek fold-similarity search (asynchronous) against experimental and predicted databases, uploading the PDB entry's mmCIF file or the accession's AlphaFold DB model, up to ${COORDINATE_LIMIT_TEXT}; if the job is still computing when the poll budget elapses, or the call's 50 s budget runs out after Foldseek accepted the job, the response reports status "computing" with a ticket — re-call with ticket_id set to that value to resume the same job instead of resubmitting, and a complete response carries the same ticket so a finished job can be re-paged with a different start. Foldseek searches each chain of a multichain structure as its own query: a response covers one query (query, default 0), reports queryCount, and ranks that query's hits by score across all searched databases. Each mode reads only its own controls: sequence, chain, max_evalue and min_identity belong to by:"sequence"; ticket_id, databases and query belong to by:"structure"; pdb_id, uniprot, start and limit are shared. A field the selected mode cannot consume is rejected rather than silently ignored. A UniProt accession merged into another entry answers for its successor with a notice; a demerged or deleted one fails with its replacements. Output names the engine and database each hit came from; a structure hit also carries its Foldseek target name, and an id only where that name maps to a PDB entry or UniProt accession that protein_get_structure resolves.`,
  annotations: { readOnlyHint: true, openWorldHint: true },

  // Every reason is thrown by a helper below the handler, hence thrownBy on each entry.
  errors: [
    {
      reason: 'chain_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'chain names no protein polymer entity of the pdb_id entry: no such author chain, a DNA or RNA chain, or a case mismatch.',
      recovery:
        'Pass a protein author chain ID listed in the error, matching its case, or omit chain to search the default protein entity.',
      thrownBy: 'service',
    },
    {
      reason: 'chain_without_pdb_id',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'chain was supplied under by:"sequence" without pdb_id.',
      recovery: 'Add the pdb_id whose author chain to search, or drop chain.',
      thrownBy: 'service',
    },
    {
      reason: 'databases_rejected',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Foldseek refused the structure job submission with HTTP 400: it no longer accepts a requested database name.',
      recovery:
        'Re-call with fewer databases to isolate the one Foldseek no longer accepts, or omit databases to search the default pdb100 and afdb50.',
      thrownBy: 'service',
    },
    {
      reason: 'inactive_accession',
      code: JsonRpcErrorCode.NotFound,
      when: 'UniProt lists the uniprot accession as inactive: demerged into several entries, or deleted.',
      recovery:
        'Re-call with an accession from data.replacements; an empty list means UniProt deleted the entry without a replacement, so search from a pdb_id instead.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_accession',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'uniprot is shaped like none of a canonical accession (P69905), an isoform accession (P04637-2), or a UniProtKB entry name (HBA_HUMAN).',
      recovery:
        'Pass a canonical UniProt accession such as P69905, an isoform accession such as P04637-2, or an entry name such as HBA_HUMAN, or search from pdb_id instead.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_sequence',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A raw or identifier-resolved RCSB protein sequence contains invalid residues or has fewer than 10 residues after whitespace removal, a pdb_id protein entity picked by chain or by default included.',
      recovery:
        'Supply at least 10 one-letter residues A–I or K–Z (J excluded); remove punctuation or other invalid characters. Whitespace and ASCII lowercase are accepted. For a pdb_id query, pass the chain of a protein entity of at least 10 residues.',
      thrownBy: 'service',
    },
    {
      reason: 'missing_query',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'None of sequence, pdb_id, or uniprot was provided.',
      recovery: 'Provide a raw sequence, a PDB entry ID, or a UniProt accession to search from.',
      thrownBy: 'service',
    },
    {
      reason: 'mode_mismatched_field',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'An input field only the other by mode consumes was supplied: sequence, chain, max_evalue or min_identity under by:"structure"; ticket_id, query or a non-empty databases list under by:"sequence".',
      recovery:
        'Drop the field, or switch by to the mode that reads it — sequence, chain, max_evalue and min_identity apply to by:"sequence"; ticket_id, databases and query apply to by:"structure".',
      thrownBy: 'service',
    },
    {
      reason: 'no_sequence',
      code: JsonRpcErrorCode.NotFound,
      when: 'No query could be derived from the identifier: by:"sequence" found no such PDB entry, no protein polymer entity in it, or no UniProt sequence for the accession or entry name; by:"structure" found no UniProt entry for the entry name, or no AlphaFold DB model with a PDB-format file for the accession.',
      recovery:
        'Verify the identifier, or pass a raw one-letter sequence directly via the sequence parameter.',
      thrownBy: 'service',
    },
    {
      reason: 'query_out_of_range',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The requested query index is not below the number of queries the completed Foldseek job holds.',
      recovery:
        'Re-call with the ticket_id from the error and a query index below the reported query count; the job is already complete.',
      thrownBy: 'service',
    },
    {
      reason: 'search_failed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The Foldseek search service rejected or failed the structure job.',
      retryable: true,
      recovery:
        'Retry shortly; if it persists, verify the source structure has coordinates via protein_get_structure.',
      thrownBy: 'service',
    },
    {
      reason: 'structure_too_large',
      code: JsonRpcErrorCode.InvalidParams,
      when: `The query structure's coordinate file is longer than ${COORDINATE_LIMIT_TEXT}, the most this tool uploads to Foldseek.`,
      recovery:
        'Pass uniprot to search the AlphaFold DB model of the protein instead, or the pdb_id of a smaller entry holding the same protein (protein_search_structures finds one by protein name).',
      thrownBy: 'service',
    },
    {
      reason: 'ticket_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The supplied ticket_id was rejected by Foldseek as an invalid or expired ticket.',
      recovery:
        'Tickets expire once results age out; drop ticket_id and re-run the by:structure search from pdb_id or uniprot to get a fresh one.',
      thrownBy: 'service',
    },
  ],

  input: inputSchema,
  output: outputSchema,
  enrichment: enrichmentShape,

  // `async` so the pre-dispatch guard rejects rather than throwing synchronously
  // out of the call itself — every failure on this tool reaches the caller the
  // same way.
  async handler(input, ctx): Promise<FindSimilarOutput> {
    rejectModeMismatchedFields(input, ctx);
    const { asyncPollTimeoutMs } = getServerConfig();
    // One budget across every request the call chains: identifier lookups, the
    // coordinate download, the search, hit enrichment, and Foldseek's poll.
    return await withCallBudget(ctx, (call) => {
      const budgeted: Ctx = { ...ctx, signal: call.signal };
      return input.by === 'sequence'
        ? runSequence(input, budgeted)
        : runStructure(input, asyncPollTimeoutMs, budgeted);
    });
  },

  format: (result) => {
    const lines: string[] = [`## ${result.engine} (by:${result.by}) — ${result.status}`];
    if (result.ticketId) {
      const withQuery = result.query ? ` and query ${result.query}` : '';
      lines.push(
        `**Ticket:** ${result.ticketId} — re-call with ticket_id${withQuery} to resume or re-page this job.`,
      );
    }
    if (typeof result.queryCount === 'number')
      lines.push(`**Query:** ${result.query ?? 0} of ${result.queryCount} (0-based)`);
    if (result.queryEntityId) lines.push(`**Query entity:** ${result.queryEntityId}`);
    if (typeof result.queryLength === 'number')
      lines.push(`**Query length:** ${result.queryLength}`);
    for (const h of result.hits) {
      // A structure hit with no chainable id is headed by its Foldseek target name.
      lines.push(`\n### ${h.id ?? h.target} _(${h.source})_`);
      if (h.title) lines.push(h.title);
      const parts = [
        h.id && h.target ? `**Target:** ${h.target}` : null,
        h.chain ? `**Chain:** ${h.chain}` : null,
        h.entityId ? `**Entity:** ${h.entityId}` : null,
        typeof h.score === 'number' ? `**Score:** ${h.score}` : null,
        typeof h.evalue === 'number' ? `**E-value:** ${h.evalue}` : null,
        typeof h.bitscore === 'number' ? `**Bit score:** ${h.bitscore}` : null,
        typeof h.probability === 'number' ? `**Probability:** ${h.probability}` : null,
        typeof h.identity === 'number' ? `**Identity:** ${h.identity}` : null,
        h.database ? `**DB:** ${h.database}` : null,
        h.organisms?.length ? `**Organisms:** ${h.organisms.join(', ')}` : null,
        typeof h.taxId === 'number' ? `**Tax ID:** ${h.taxId}` : null,
        h.uniprotAccession ? `**UniProt:** ${h.uniprotAccession}` : null,
      ].filter(Boolean);
      if (parts.length > 0) lines.push(parts.join(' | '));
      const alignment = alignmentLine(h);
      if (alignment) lines.push(alignment);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

async function runSequence(input: FindSimilarInput, ctx: Ctx): Promise<FindSimilarOutput> {
  const rcsb = getRcsbService();
  const query = await resolveSequence(input, ctx);

  const result = await rcsb.searchSequence(
    normalizeProteinSequence(query.sequence),
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
  // Same two empty-page causes runStructure separates: nothing matched, or an
  // offset past the end of a populated result set. `notice` is last-wins, so the
  // page note and the query's provenance note are joined into one string.
  const notes: string[] = [];
  if (result.hits.length === 0)
    notes.push(
      result.total === 0
        ? 'No sequence-similar entries found. Lower min_identity or raise max_evalue.'
        : `start ${input.start} is past the end of the ${result.total} matches. Re-call with a lower start to read a populated page.`,
    );
  if (query.notice) notes.push(query.notice);
  if (notes.length > 0) ctx.enrich.notice(notes.join(' '));

  return {
    by: 'sequence',
    engine: 'RCSB mmseqs2',
    status: 'complete',
    ...(typeof result.queryLength === 'number' ? { queryLength: result.queryLength } : {}),
    ...(query.entityId ? { queryEntityId: query.entityId } : {}),
    // The service sets each alignment field only where the hit's match context
    // carried it, under its output name.
    hits: result.hits.map(({ id, score, ...alignment }) => {
      // mmseqs2 emits polymer-entity IDs (1A00_1); expose the bare entry ID as
      // `id` so it chains uniformly into protein_get_structure like the other
      // tools, and keep the raw entity ID as `entityId` for the matched entity.
      const entryId = entryIdOf(id);
      const meta = metaById.get(entryId);
      const organisms = meta && matchedEntityOrganisms(meta, id);
      return {
        id: entryId,
        entityId: id,
        source: 'experimental' as const,
        score,
        ...alignment,
        ...(meta?.title ? { title: meta.title } : {}),
        ...(organisms && organisms.length > 0 ? { organisms } : {}),
      };
    }),
  };
}

async function runStructure(
  input: FindSimilarInput,
  pollTimeoutMs: number,
  ctx: Ctx,
): Promise<FindSimilarOutput> {
  const startedAt = Date.now();
  const foldseek = getFoldseekService();
  const query = input.query ?? 0;
  // Where the query came from (a UniProt merge), appended after the job's own notes.
  const provenance: string[] = [];
  let outcome: FoldseekOutcome;
  if (input.ticket_id) {
    // Resume path: poll the existing ticket, skipping coordinate resolution +
    // submit. A completed ticket is idempotent upstream, so a re-call with a new
    // start/limit/query pages the same finished job instead of running a second search.
    outcome = await foldseek.resume(
      {
        ticketId: input.ticket_id,
        query,
        limit: input.limit,
        start: input.start,
        timeoutMs: pollTimeoutMs,
      },
      ctx,
    );
  } else {
    const file = await resolveCoordinateFile(input, ctx);
    if (file.notice) provenance.push(file.notice);
    const databases =
      input.databases && input.databases.length > 0 ? input.databases : DEFAULT_FOLDSEEK_DBS;
    const submitted = await foldseek.search(
      {
        fileContent: file.content,
        fileName: file.fileName,
        databases,
        mode: FOLDSEEK_MODE,
        query,
        limit: input.limit,
        start: input.start,
        // The lookups and download come out of the poll window, so a slow download
        // still leaves the call budget room to return the job's ticket.
        timeoutMs: Math.max(0, pollTimeoutMs - (Date.now() - startedAt)),
      },
      ctx,
    );
    // Only a fresh submit can be refused; a resumed ticket was accepted already.
    if (submitted.status === 'rejected') {
      throw ctx.fail(
        'databases_rejected',
        `Foldseek refused the structure job for databases ${databases.join(', ')} with HTTP 400.`,
        {
          databases,
          ...(submitted.upstreamMessage ? { upstreamMessage: submitted.upstreamMessage } : {}),
        },
      );
    }
    outcome = submitted;
  }

  if (outcome.status === 'query_out_of_range') {
    const { ticketId, queryCount } = outcome;
    throw ctx.fail(
      'query_out_of_range',
      `query ${query} is out of range: Foldseek ticket ${ticketId} holds ${queryCount} ${queryCount === 1 ? 'query' : 'queries'}.`,
      {
        recovery: {
          hint:
            queryCount > 0
              ? `Re-call with ticket_id "${ticketId}" and query between 0 and ${queryCount - 1}; the job is already complete, so nothing is resubmitted.`
              : 'Foldseek read no chains from the submitted structure; confirm it has protein coordinates via protein_get_structure.',
        },
      },
    );
  }
  if (outcome.status === 'not_found') {
    throw ctx.fail(
      'ticket_not_found',
      `Foldseek ticket ${outcome.ticketId} is invalid or expired.`,
    );
  }
  if (outcome.status === 'failed') {
    // The service folds every submit and poll failure into `failed`; one the call
    // budget caused is reported as the timeout it is, or — once Foldseek holds the
    // job — as a job to resume by its ticket. Upstream's own text stays in the
    // log, out of the error.
    const exhausted = budgetExhaustion(ctx);
    if (exhausted && outcome.ticketId) {
      return computing(
        outcome.ticketId,
        query,
        `${exhausted.message} Foldseek had accepted the job as ticket ${outcome.ticketId}.`,
        provenance,
        ctx,
      );
    }
    if (exhausted) throw timeout(exhausted.message);
    ctx.log.warning('Foldseek structure search failed', { error: outcome.error });
    throw ctx.fail('search_failed', 'Foldseek did not complete the structure search.');
  }
  if (outcome.status === 'computing') {
    return computing(
      outcome.ticketId,
      query,
      `Foldseek job still computing (ticket ${outcome.ticketId}).`,
      provenance,
      ctx,
    );
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
  // databases, while a start past the end means ask for a lower offset. A
  // multichain job adds a third note — this page covers one query of several.
  // `notice` is last-wins, so the applicable notes are joined into one string.
  const notes: string[] = [];
  if (outcome.hits.length === 0) {
    notes.push(
      outcome.total === 0
        ? 'Foldseek returned no fold-similar hits in the selected databases.'
        : `start ${input.start} is past the end of this job's ${outcome.total} hits. Re-call with a lower start to read a populated page.`,
    );
  }
  if (outcome.queryCount > 1) {
    notes.push(
      `This job holds ${outcome.queryCount} queries, one per chain Foldseek read from the submitted structure in file order; these hits are for query ${outcome.query}. Re-call with ticket_id "${outcome.ticketId}" and a different query (0–${outcome.queryCount - 1}) to read another chain's hits.`,
    );
  }
  notes.push(...provenance);
  if (notes.length > 0) ctx.enrich.notice(notes.join(' '));
  return {
    by: 'structure',
    engine: 'Foldseek',
    status: 'complete',
    ticketId: outcome.ticketId,
    query: outcome.query,
    queryCount: outcome.queryCount,
    ...(typeof outcome.queryLength === 'number' ? { queryLength: outcome.queryLength } : {}),
    // The service sets only the fields upstream sent, under their output names,
    // except the two renamed here.
    hits: outcome.hits.map(({ sequenceIdentity, taxName, ...hit }) => ({
      ...hit,
      ...(typeof sequenceIdentity === 'number' ? { identity: sequenceIdentity } : {}),
      ...(taxName ? { organisms: [taxName] } : {}),
    })),
  };
}

/**
 * The `status: "computing"` answer for a Foldseek job this call leaves unread:
 * no hits, the ticket, and a notice that opens with `lead`, says how to resume,
 * and closes with where the query came from.
 */
function computing(
  ticketId: string,
  query: number,
  lead: string,
  provenance: readonly string[],
  ctx: Ctx,
): FindSimilarOutput {
  const withQuery = query > 0 ? ` and query ${query}` : '';
  ctx.enrich.notice(
    [
      `${lead} Re-call protein_find_similar with ticket_id set to "${ticketId}"${withQuery} to resume.`,
      ...provenance,
    ].join(' '),
  );
  return { by: 'structure', engine: 'Foldseek', status: 'computing', ticketId, query, hits: [] };
}

/**
 * The reason `withCallBudget` aborted the call's requests with once its budget
 * ran out (a `TimeoutError`); undefined while it runs and after a caller's
 * cancellation, which keeps the caller's reason.
 */
function budgetExhaustion(ctx: Ctx): DOMException | undefined {
  const reason: unknown = ctx.signal.reason;
  return ctx.signal.aborted && reason instanceof DOMException && reason.name === 'TimeoutError'
    ? reason
    : undefined;
}

/**
 * Reject an input field the selected `by` mode cannot consume. Each branch reads
 * only its own subset — `runSequence` alone reads sequence/chain/max_evalue/
 * min_identity, `runStructure` alone reads ticket_id/databases/query — so a field
 * supplied for the other mode would be dropped silently, making an unfiltered
 * search look filtered or an unscoped one look scoped. Guarded here rather than
 * by a Zod refine so the rejection carries `data.reason` and a recovery hint
 * naming the mode that accepts the field. `start` and `limit` are shared by both
 * modes and are never read here; an empty `databases` array matches
 * `runStructure`'s own fallback and is treated as omitted, as is a blank chain.
 */
function rejectModeMismatchedFields(input: FindSimilarInput, ctx: Ctx): void {
  const offenders = (
    input.by === 'structure'
      ? [
          input.sequence ? 'sequence' : null,
          input.chain?.trim() ? 'chain' : null,
          typeof input.max_evalue === 'number' ? 'max_evalue' : null,
          typeof input.min_identity === 'number' ? 'min_identity' : null,
        ]
      : [
          typeof input.ticket_id === 'string' ? 'ticket_id' : null,
          input.databases && input.databases.length > 0 ? 'databases' : null,
          typeof input.query === 'number' ? 'query' : null,
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

/** A sequence-search query and where it came from. */
interface SequenceQuery {
  /** Polymer entity of pdb_id the sequence was taken from. */
  entityId?: string;
  /** Provenance for the caller: the entry's other protein entities, or a UniProt merge. */
  notice?: string;
  sequence: string;
}

/**
 * Resolve the query sequence: a direct sequence first, then one protein entity of
 * pdb_id, then a UniProt accession. `chain` selects the entity and needs pdb_id,
 * checked before any request.
 */
async function resolveSequence(input: FindSimilarInput, ctx: Ctx): Promise<SequenceQuery> {
  const chain = input.chain?.trim() || undefined;
  if (chain && !input.pdb_id) {
    throw ctx.fail(
      'chain_without_pdb_id',
      `chain "${chain}" names an author chain of a PDB entry, but no pdb_id was given.`,
    );
  }
  if (input.sequence) return { sequence: input.sequence };
  if (input.pdb_id) return await sequenceFromEntry(input.pdb_id.trim(), chain, ctx);
  if (input.uniprot) {
    const id = checkedUniProtId(input.uniprot, ctx);
    // The service resolves an entry name to its entry in the same request, and
    // throws inactive_accession for a demerged or deleted accession.
    const found = await getUniProtService().getSequence(id, ctx);
    if (!found) {
      throw ctx.fail('no_sequence', `UniProtKB has no entry with a sequence for ${id}.`);
    }
    return {
      sequence: found.sequence,
      ...(found.mergedFrom
        ? { notice: mergedAccessionNotice(found.mergedFrom, found.accession) }
        : {}),
    };
  }
  throw ctx.fail('missing_query', 'Provide a sequence, pdb_id, or uniprot to search from.');
}

/** The query one protein entity of a PDB entry yields, picked by `chain` or by default. */
async function sequenceFromEntry(
  pdbId: string,
  chain: string | undefined,
  ctx: Ctx,
): Promise<SequenceQuery> {
  const id = pdbId.toUpperCase();
  const lookup = await getRcsbService().getSequence(pdbId, chain, ctx);
  switch (lookup.kind) {
    case 'entry_not_found':
      throw ctx.fail('no_sequence', `RCSB has no PDB entry ${id}.`);
    case 'no_protein':
      throw ctx.fail(
        'no_sequence',
        `PDB entry ${id} has no protein polymer entity with a sequence to search.`,
      );
    case 'chain_not_found': {
      const chains = lookup.proteinEntities.flatMap((e) => e.chains);
      throw ctx.fail(
        'chain_not_found',
        `Chain "${chain}" is not an author chain of a protein entity in ${id}.`,
        {
          recovery: {
            hint:
              chains.length > 0
                ? `Protein author chains in ${id}, in entity order: ${chains.join(', ')}. Pass one of these, matching its case, or omit chain to search the default protein entity.`
                : `The protein entities of ${id} list no author chains; omit chain to search the default protein entity.`,
          },
        },
      );
    }
    case 'found':
      return {
        sequence: lookup.sequence,
        entityId: lookup.entity.entityId,
        // Name the default pick and the alternatives, so `chain` is discoverable.
        ...(!chain && lookup.otherEntities.length > 0
          ? { notice: entityNotice(id, lookup.entity, lookup.otherEntities) }
          : {}),
      };
  }
}

/** The notice naming the default protein entity searched and the entry's other protein entities. */
function entityNotice(
  pdbId: string,
  searched: ProteinEntitySummary,
  others: ProteinEntitySummary[],
): string {
  const searchedChains = chainList(searched.chains);
  const listed = others.map(
    (e) =>
      `${e.entityId} (${[chainList(e.chains), `${e.length} residues`].filter(Boolean).join('; ')})`,
  );
  return `Searched ${searched.entityId}${searchedChains ? ` (${searchedChains})` : ''}, the lowest-numbered protein entity in ${pdbId} long enough to search. Other protein entities in ${pdbId}: ${listed.join(', ')}. Pass chain with one of their author chain IDs to search another.`;
}

/** `chain A` or `chains A, C`; empty when upstream lists none. */
function chainList(chains: string[]): string {
  if (chains.length === 0) return '';
  return `${chains.length === 1 ? 'chain' : 'chains'} ${chains.join(', ')}`;
}

/**
 * The `uniprot` input trimmed and upper-cased, after checking — before any
 * request — that it is shaped like a canonical or isoform UniProt accession or
 * a UniProtKB entry name.
 */
function checkedUniProtId(value: string, ctx: Ctx): string {
  const id = value.trim().toUpperCase();
  if (!isPredictionAccession(id) && !isUniProtEntryName(id)) {
    throw ctx.fail(
      'invalid_accession',
      `"${value}" is not a UniProt identifier: expected a canonical accession (e.g. P69905), an isoform accession (e.g. P04637-2), or an entry name (e.g. HBA_HUMAN).`,
      { uniprot: value },
    );
  }
  return id;
}

/**
 * The accession a UniProtKB entry name belongs to, for the AlphaFold DB lookup,
 * which is keyed by accession. Resolving a name is not a merge, so no notice
 * names it.
 */
async function accessionOfEntryName(name: string, ctx: Ctx): Promise<string> {
  const status = await getUniProtService().resolveAccession(name, ctx);
  switch (status.kind) {
    case 'active':
      return status.accession;
    case 'merged':
      return status.successor;
    case 'inactive':
      throw inactiveAccessionError(status);
    case 'unknown':
      throw ctx.fail('no_sequence', `UniProtKB has no entry named ${name}.`, NO_MODEL_RECOVERY);
  }
}

/** A query coordinate file, with any provenance notice it carries. */
interface CoordinateFile {
  content: string;
  fileName: string;
  notice?: string;
}

/** Resolve a query coordinate file (mmCIF or PDB-format text) from a PDB ID or UniProt accession. */
async function resolveCoordinateFile(input: FindSimilarInput, ctx: Ctx): Promise<CoordinateFile> {
  if (input.pdb_id && isPdbId(input.pdb_id)) {
    // mmCIF, not PDB format: every entry has an mmCIF file, while large entries
    // are archived without a PDB-format one, and Foldseek reads either.
    const id = input.pdb_id.trim().toUpperCase();
    const fileName = `${id}.cif`;
    return {
      content: await fetchCoordinateText(getRcsbService().mmcifUrl(id), fileName, ctx),
      fileName,
    };
  }
  if (input.uniprot) {
    const id = checkedUniProtId(input.uniprot, ctx);
    const accession = isUniProtEntryName(id) ? await accessionOfEntryName(id, ctx) : id;
    // AlphaFold DB first; UniProt is asked only when it holds no model under the accession.
    const lookup = await getAlphaFoldService().findPrediction(accession, ctx);
    if (lookup.kind === 'missed') throw noPredictedModel(lookup.uniprot, ctx);
    const { model, mergedFrom } = lookup;
    if (!model.pdbUrl) {
      throw ctx.fail(
        'no_sequence',
        `AlphaFold DB lists no PDB-format coordinate file for ${model.uniprotAccession}.`,
        NO_MODEL_RECOVERY,
      );
    }
    const fileName = `${model.uniprotAccession}.pdb`;
    return {
      content: await fetchCoordinateText(model.pdbUrl, fileName, ctx),
      fileName,
      ...(mergedFrom ? { notice: mergedAccessionNotice(mergedFrom, model.uniprotAccession) } : {}),
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

/** The failure for an accession AlphaFold DB has no model for, from UniProt's verdict on it. */
function noPredictedModel(uniprot: AccessionStatus, ctx: Ctx): McpError {
  switch (uniprot.kind) {
    case 'inactive':
      return inactiveAccessionError(uniprot);
    case 'unknown':
      return ctx.fail(
        'no_sequence',
        `UniProtKB has no entry for ${uniprot.accession}, and AlphaFold DB has no model for it.`,
        NO_MODEL_RECOVERY,
      );
    case 'merged':
      return ctx.fail(
        'no_sequence',
        `${uniprot.accession} was merged into ${uniprot.successor} in UniProtKB, and AlphaFold DB has no model for ${uniprot.successor}.`,
        NO_MODEL_RECOVERY,
      );
    case 'active':
      return ctx.fail(
        'no_sequence',
        // AlphaFold DB keys the canonical sequence under the bare accession, never as isoform 1.
        /-1$/.test(uniprot.accession)
          ? `AlphaFold DB has no model for ${uniprot.accession}; it keys the canonical sequence under the bare accession — pass uniprot "${canonicalAccessionOf(uniprot.accession)}".`
          : `AlphaFold DB has no model for ${uniprot.accession}.`,
        NO_MODEL_RECOVERY,
      );
  }
}

/**
 * Download a query coordinate file, reading at most {@link COORDINATE_CHAR_LIMIT}
 * characters: a longer file fails structure_too_large, and the rest of it is never
 * downloaded.
 */
async function fetchCoordinateText(url: string, fileName: string, ctx: Ctx): Promise<string> {
  const file = await fetchTextWindow(url, ctx, {
    operation: 'findSimilar.fetchCoordinates',
    label: 'Coordinate file',
    baseDelayMs: 400,
    maxRetries: 1,
    offset: 0,
    length: COORDINATE_CHAR_LIMIT,
  });
  if (file.more) {
    throw ctx.fail(
      'structure_too_large',
      `${fileName} is longer than ${COORDINATE_LIMIT_TEXT}, the most protein_find_similar uploads as a Foldseek query.`,
    );
  }
  return file.text;
}
