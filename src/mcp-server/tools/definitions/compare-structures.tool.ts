/**
 * @fileoverview protein_compare_structures — structural alignment of 2–10
 * structures via the RCSB Structural Comparison service. Aligns each structure to
 * a reference (default the first) or computes the full all-pairs matrix, fanning
 * out pairwise async jobs with a concurrency cap and per-pair partial success.
 * @module mcp-server/tools/definitions/compare-structures.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import type { AlignmentMethod, CompareStructure } from '@/services/alignment/alignment-service.js';
import { getAlignmentService } from '@/services/alignment/alignment-service.js';
import { mapWithConcurrency } from '@/services/shared/async.js';

const inputSchema = z.object({
  structures: z
    .array(
      z
        .object({
          pdb_id: z.string().min(1).describe('PDB entry ID.'),
          chain: z
            .string()
            .optional()
            .describe('Chain (label_asym_id) to restrict the alignment to a single chain.'),
        })
        .describe('A structure to align, by PDB entry ID with optional chain.'),
    )
    .min(2)
    .max(25)
    .describe(
      'The structures to compare, up to the configured batch cap (excess is dropped with a notice).',
    ),
  reference: z
    .enum(['first', 'all_pairs'])
    .default('first')
    .describe('Align all to the first structure, or compute the full pairwise matrix.'),
  method: z
    .enum(['tm-align', 'fatcat-rigid', 'fatcat-flexible'])
    .default('tm-align')
    .describe('Alignment algorithm: tm-align, fatcat-rigid, or fatcat-flexible.'),
  timeout_s: z
    .number()
    .int()
    .min(5)
    .max(120)
    .optional()
    .describe(
      'Poll budget per pair in seconds before returning "computing". Defaults to the server setting.',
    ),
  resume: z
    .array(
      z
        .object({
          a: z
            .string()
            .min(1)
            .describe(
              'First structure label (entry or entry.chain) of a pair from a prior response.',
            ),
          b: z
            .string()
            .min(1)
            .describe(
              'Second structure label (entry or entry.chain) of a pair from a prior response.',
            ),
          uuid: z
            .string()
            .min(1)
            .describe('Alignment job UUID returned for that pair by a prior call.'),
        })
        .describe('A prior pair to resume by UUID instead of resubmitting.'),
    )
    .optional()
    .describe(
      "Resume tickets from a prior call: for each pair whose labels match an entry here, poll the existing UUID instead of submitting a new alignment job. Copy a, b, and uuid verbatim from a prior response's pairs[]; keep structures and reference unchanged.",
    ),
});

const outputSchema = z.object({
  method: z.string().describe('Alignment method used.'),
  reference: z.enum(['first', 'all_pairs']).describe('Comparison mode used.'),
  pairs: z
    .array(
      z
        .object({
          a: z.string().describe('First structure of the pair (entry[.chain]).'),
          b: z.string().describe('Second structure of the pair (entry[.chain]).'),
          status: z.enum(['complete', 'computing', 'failed']).describe('Outcome for this pair.'),
          tmScore: z
            .number()
            .optional()
            .describe(
              'TM-score (0–1; higher is more similar). Length-normalized, so it can be sensitive to ' +
                'terminal length differences between the two structures — a one-residue overhang can flip ' +
                'the greedy superposition into a worse local optimum, dropping the score sharply. Cross-check ' +
                'rmsd and alignedResidues to spot such cases.',
            ),
          rmsd: z.number().optional().describe('RMSD in Å over aligned residues.'),
          alignedResidues: z.number().optional().describe('Number of aligned residue pairs.'),
          uuid: z
            .string()
            .optional()
            .describe('Alignment job UUID (present for computing/complete pairs).'),
          error: z.string().optional().describe('Failure detail (failed pairs).'),
        })
        .describe('Alignment outcome for one structure pair.'),
    )
    .describe('One row per aligned pair.'),
});

type StructInput = z.infer<typeof inputSchema>['structures'][number];

export const compareStructures = tool('protein_compare_structures', {
  title: 'protein-mcp-server: compare structures',
  description:
    'Structurally align multiple structures (up to the configured batch cap) via the RCSB Structural ' +
    'Comparison service (TM-align / jFATCAT). reference:"first" aligns every structure to the first; ' +
    'reference:"all_pairs" computes the full pairwise matrix. Each pair is an independent async alignment ' +
    'job, fanned out with a concurrency cap and per-pair partial success — a pair still computing when the ' +
    'budget elapses returns status "computing" with its job UUID, and a failed pair degrades its row without ' +
    "sinking the others. Re-call with a matching entry in resume[] to poll a computing pair's UUID instead " +
    'of resubmitting. Returns TM-score, RMSD, and aligned-residue count per pair. TM-score is ' +
    'length-normalized and can shift sharply between structures that differ only by a terminal residue or ' +
    'two — the greedy superposition can settle into a worse local optimum — so read tmScore alongside rmsd ' +
    'and alignedResidues, the columns that make such cases diagnosable.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'resume_pair_unmatched',
      code: JsonRpcErrorCode.InvalidParams,
      when: "A resume entry's a/b labels don't match any pair generated from structures + reference.",
      recovery:
        "Copy each resume entry's a, b, and uuid verbatim from a prior response's pairs[], and keep structures and reference unchanged between calls.",
    },
  ],

  input: inputSchema,
  output: outputSchema,

  enrichment: {
    pairsTotal: z.number().describe('Number of pairs compared.'),
    computing: z.number().describe('Number of pairs still computing.'),
    notice: z.string().optional().describe('Advisory note (pending pairs, failures).'),
  },

  async handler(input, ctx) {
    const cfg = getServerConfig();
    const structures = input.structures.slice(0, cfg.maxCompareStructures);
    const notices: string[] = [];
    if (input.structures.length > cfg.maxCompareStructures) {
      notices.push(
        `Capped at ${cfg.maxCompareStructures} structures; ${input.structures.length - cfg.maxCompareStructures} ignored.`,
      );
    }
    const timeoutMs = input.timeout_s ? input.timeout_s * 1000 : cfg.asyncPollTimeoutMs;
    const method = input.method as AlignmentMethod;

    const pairs = buildPairs(structures, input.reference);

    // Map each supplied resume ticket to a pair. A ticket that matches no pair in
    // the current structures/reference set is a client error — fail loudly rather
    // than silently resubmit and burn a fresh alignment job.
    const resumeByPair = new Map<string, string>();
    if (input.resume?.length) {
      const validKeys = new Set(pairs.map(([a, b]) => pairKey(label(a), label(b))));
      for (const r of input.resume) {
        const key = pairKey(r.a, r.b);
        if (!validKeys.has(key)) {
          throw ctx.fail(
            'resume_pair_unmatched',
            `Resume entry ${r.a} ↔ ${r.b} matches no pair in the current structures/reference set.`,
            { ...ctx.recoveryFor('resume_pair_unmatched') },
          );
        }
        resumeByPair.set(key, r.uuid);
      }
    }

    const alignment = getAlignmentService();
    const rows = await mapWithConcurrency(pairs, cfg.fanoutConcurrency, async ([a, b]) => {
      const resumeUuid = resumeByPair.get(pairKey(label(a), label(b)));
      const outcome = resumeUuid
        ? await alignment.resumePair(resumeUuid, timeoutMs, ctx)
        : await alignment.comparePair(toCompare(a), toCompare(b), method, timeoutMs, ctx);
      const base = { a: label(a), b: label(b) };
      if (outcome.status === 'complete') {
        return {
          ...base,
          status: 'complete' as const,
          uuid: outcome.uuid,
          ...(typeof outcome.scores.tmScore === 'number'
            ? { tmScore: outcome.scores.tmScore }
            : {}),
          ...(typeof outcome.scores.rmsd === 'number' ? { rmsd: outcome.scores.rmsd } : {}),
          ...(typeof outcome.scores.alignedResidues === 'number'
            ? { alignedResidues: outcome.scores.alignedResidues }
            : {}),
        };
      }
      if (outcome.status === 'computing') {
        return { ...base, status: 'computing' as const, uuid: outcome.uuid };
      }
      return { ...base, status: 'failed' as const, error: outcome.error };
    });

    const computing = rows.filter((r) => r.status === 'computing').length;
    const failed = rows.filter((r) => r.status === 'failed').length;
    ctx.enrich({ pairsTotal: rows.length, computing });
    if (computing > 0 || failed > 0) {
      notices.push(
        `${computing} pair(s) still computing${failed > 0 ? `, ${failed} failed` : ''}. ` +
          `Re-call with a resume entry per pair (copy a, b, uuid from the pairs above) to poll existing jobs — cold alignment jobs typically finish within 30–60 s.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return { method, reference: input.reference, pairs: rows };
  },

  format: (result) => {
    const lines: string[] = [`## Structure comparison (${result.method}, ${result.reference})`];
    lines.push('\n| Pair | Status | TM-score | RMSD (Å) | Aligned |');
    lines.push('|---|---|---|---|---|');
    for (const p of result.pairs) {
      const tm = typeof p.tmScore === 'number' ? p.tmScore.toFixed(3) : '—';
      const rmsd = typeof p.rmsd === 'number' ? p.rmsd.toFixed(2) : '—';
      const aligned = typeof p.alignedResidues === 'number' ? String(p.alignedResidues) : '—';
      lines.push(`| ${p.a} ↔ ${p.b} | ${p.status} | ${tm} | ${rmsd} | ${aligned} |`);
    }
    const notes = result.pairs.filter((p) => p.error || p.uuid);
    if (notes.length > 0) {
      lines.push('');
      for (const p of notes) {
        if (p.error) lines.push(`- ${p.a} ↔ ${p.b}: ${p.error}`);
        if (p.uuid)
          lines.push(
            `- ${p.a} ↔ ${p.b}: job ${p.uuid}${p.status === 'computing' ? ' (computing)' : ''}`,
          );
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

function buildPairs(
  structures: StructInput[],
  reference: 'first' | 'all_pairs',
): Array<[StructInput, StructInput]> {
  const pairs: Array<[StructInput, StructInput]> = [];
  if (reference === 'first') {
    const [ref, ...rest] = structures;
    if (ref) for (const s of rest) pairs.push([ref, s]);
  } else {
    for (let i = 0; i < structures.length; i++) {
      const a = structures[i];
      if (!a) continue;
      for (let j = i + 1; j < structures.length; j++) {
        const b = structures[j];
        if (b) pairs.push([a, b]);
      }
    }
  }
  return pairs;
}

function toCompare(s: StructInput): CompareStructure {
  return { entryId: s.pdb_id, ...(s.chain ? { asymId: s.chain } : {}) };
}

function label(s: StructInput): string {
  return s.chain ? `${s.pdb_id.toUpperCase()}.${s.chain}` : s.pdb_id.toUpperCase();
}

/**
 * Canonical, order- and case-insensitive key for a pair of structure labels, so a
 * resume entry matches its pair regardless of which side the client copied first.
 */
function pairKey(a: string, b: string): string {
  return [a.toUpperCase(), b.toUpperCase()].sort().join(' ');
}
