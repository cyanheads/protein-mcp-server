/**
 * @fileoverview protein_get_structure — fetch experimental, predicted, or
 * best-available structures by ID. Batches up to N experimental IDs in one RCSB
 * GraphQL call with per-ID partial success (`failed[]`). Optionally inlines
 * coordinate-file content; when that overflows a byte budget it returns a
 * per-structure section outline for targeted re-call instead of truncating.
 * @module mcp-server/tools/definitions/get-structure.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { DEFAULT_OUTLINE_BUDGET_BYTES } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { getAlphaFoldService } from '@/services/alphafold/alphafold-service.js';
import { getBeaconsService } from '@/services/beacons/beacons-service.js';
import { getRcsbService } from '@/services/rcsb/rcsb-service.js';
import { mapWithConcurrency } from '@/services/shared/async.js';
import { fetchText } from '@/services/shared/http.js';
import { isPdbId, isUniProtAccession } from '@/services/shared/identifiers.js';

const confidenceBucketsSchema = z.object({
  veryLow: z.number().describe('Fraction of residues with pLDDT < 50.'),
  low: z.number().describe('Fraction with pLDDT 50–70.'),
  confident: z.number().describe('Fraction with pLDDT 70–90.'),
  veryHigh: z.number().describe('Fraction with pLDDT > 90.'),
});

const structureRecordSchema = z
  .object({
    id: z.string().describe('Structure identifier (PDB entry ID or UniProt accession).'),
    source: z
      .enum(['experimental', 'predicted'])
      .describe('Whether the structure is experimental or predicted.'),
    pdbId: z
      .string()
      .optional()
      .describe(
        'Chosen PDB entry ID when a best_available query resolved to an experimental structure (id stays the queried UniProt accession). Lets an agent cite the structure without parsing the coordinate URL.',
      ),
    title: z.string().optional().describe('Structure / protein title.'),
    method: z.string().optional().describe('Experimental method(s).'),
    resolution: z.number().optional().describe('Resolution in Å (experimental).'),
    organism: z.string().optional().describe('Source organism.'),
    provider: z.string().optional().describe('Model provider (predicted / best_available).'),
    meanPlddt: z.number().optional().describe('Mean pLDDT confidence 0–100 (predicted).'),
    confidenceBuckets: confidenceBucketsSchema
      .optional()
      .describe('pLDDT confidence-band fractions (predicted).'),
    paeDocUrl: z
      .string()
      .optional()
      .describe('Predicted Aligned Error documentation URL (predicted).'),
    coordinateUrls: z
      .object({
        cif: z.string().optional().describe('mmCIF coordinate file URL.'),
        pdb: z.string().optional().describe('PDB-format coordinate file URL.'),
        bcif: z.string().optional().describe('Binary CIF coordinate file URL.'),
      })
      .describe('Coordinate file download URLs.'),
    coordinateFormat: z
      .enum(['cif', 'pdb', 'bcif'])
      .optional()
      .describe('Format of inlined coordinates, when present.'),
    coordinates: z
      .string()
      .optional()
      .describe('Inlined coordinate-file content (only when include_coords).'),
  })
  .describe('A resolved structure with metadata and coordinate-file URLs.');

type StructureRecord = z.infer<typeof structureRecordSchema>;

export const getStructure = tool('protein_get_structure', {
  title: 'protein-mcp-server: get structure',
  description:
    'Fetch structures with metadata and coordinate-file URLs. source "experimental" takes PDB entry IDs ' +
    '(batched in one call); "predicted" takes UniProt accessions (AlphaFold, with pLDDT/PAE confidence); ' +
    '"best_available" takes UniProt accessions and returns the top federated model (experimental if one ' +
    'exists, else the best prediction). Resolves up to the configured batch cap per call with per-ID partial ' +
    'success — missed IDs are listed in failed[]. Set include_coords to inline coordinate content; if that ' +
    'overflows, a section outline is returned — re-call with sections:[ids] to inline specific structures.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'mixed_id_types',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The batch mixes PDB IDs and UniProt accessions under a single source that cannot serve both.',
      recovery:
        'Split the call by source: PDB IDs with source experimental, UniProt accessions with source predicted or best_available.',
    },
    {
      reason: 'all_failed',
      code: JsonRpcErrorCode.NotFound,
      when: 'No requested ID resolved to a structure.',
      recovery:
        'Verify ID formats (PDB IDs are 4 chars; UniProt accessions match the standard pattern) or locate IDs via protein_search_structures.',
    },
  ],

  input: z.object({
    ids: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        'PDB entry IDs (source experimental) or UniProt accessions (predicted / best_available).',
      ),
    source: z
      .enum(['experimental', 'predicted', 'best_available'])
      .default('experimental')
      .describe(
        'Where to fetch: experimental (PDB), predicted (AlphaFold), or best_available (federated pick).',
      ),
    include_coords: z
      .boolean()
      .default(false)
      .describe('Inline coordinate-file content (cif). Off by default — URLs are always returned.'),
    sections: z
      .array(z.string())
      .optional()
      .describe('Structure IDs to inline coordinates for, from a prior overflow outline.'),
  }),

  output: z.object({
    structures: z
      .array(structureRecordSchema)
      .describe('Resolved structures (metadata always present).'),
    failed: z
      .array(
        z
          .object({
            id: z.string().describe('Requested ID that failed.'),
            reason: z.string().describe('Why it failed.'),
          })
          .describe('A requested ID that did not resolve, with the reason.'),
      )
      .describe('IDs that could not be resolved (partial success).'),
    overflow: z
      .object({
        sections: z
          .array(
            z
              .object({
                id: z.string().describe('Structure ID whose coordinates were withheld.'),
                bytes: z.number().describe('Serialized size of the withheld coordinate content.'),
              })
              .describe('A withheld structure and its coordinate byte size.'),
          )
          .describe('Per-structure coordinate sizes available for targeted re-call.'),
        notice: z
          .string()
          .describe('How to retrieve specific coordinates via the sections parameter.'),
      })
      .optional()
      .describe(
        'Present only when inlined coordinates across the batch exceeded the response budget.',
      ),
  }),

  enrichment: {
    requested: z.number().describe('Number of IDs requested.'),
    resolved: z.number().describe('Number of IDs resolved.'),
    notice: z.string().optional().describe('Advisory note (partial failures, overflow guidance).'),
  },

  async handler(input, ctx) {
    const cfg = getServerConfig();
    const ids = input.ids.slice(0, cfg.maxBatchIds).map((s) => s.trim());
    if (input.ids.length > cfg.maxBatchIds) {
      ctx.enrich.notice(
        `Batch capped at ${cfg.maxBatchIds} IDs; ${input.ids.length - cfg.maxBatchIds} ignored.`,
      );
    }

    if (input.source === 'experimental') {
      if (ids.some((id) => isUniProtAccession(id) && !isPdbId(id))) {
        throw ctx.fail(
          'mixed_id_types',
          'source experimental expects PDB entry IDs, but UniProt accessions were present.',
        );
      }
    } else if (ids.some((id) => isPdbId(id) && !isUniProtAccession(id))) {
      throw ctx.fail(
        'mixed_id_types',
        `source ${input.source} expects UniProt accessions, but PDB IDs were present.`,
      );
    }

    const { structures, failed } =
      input.source === 'experimental'
        ? await fetchExperimental(ids, ctx)
        : await fetchPredictedOrBest(ids, input.source, cfg.fanoutConcurrency, ctx);

    if (structures.length === 0) {
      throw ctx.fail(
        'all_failed',
        `None of the ${ids.length} requested IDs resolved to a structure.`,
      );
    }

    // Inline coordinates when requested (all, or only the re-called sections).
    const inlineSet = input.sections?.length
      ? new Set(input.sections.map((s) => s.toUpperCase()))
      : input.include_coords
        ? 'all'
        : null;
    if (inlineSet) {
      await inlineCoordinates(structures, inlineSet, cfg.fanoutConcurrency, ctx);
    }

    // Overflow guard: inlining several coordinate files at once can blow the
    // response budget. A single structure always inlines (re-calling for the lone
    // section would return the same bytes); 2+ over budget collapse to a size index.
    let overflow: { sections: Array<{ id: string; bytes: number }>; notice: string } | undefined;
    if (inlineSet === 'all') {
      const withCoords = structures.filter((s) => s.coordinates);
      const total = withCoords.reduce((n, s) => n + (s.coordinates?.length ?? 0), 0);
      if (withCoords.length > 1 && total > DEFAULT_OUTLINE_BUDGET_BYTES) {
        const sections = withCoords.map((s) => ({ id: s.id, bytes: s.coordinates?.length ?? 0 }));
        for (const s of structures) {
          delete s.coordinates;
          delete s.coordinateFormat;
        }
        overflow = {
          sections,
          notice:
            `Inlined coordinates (${total} bytes across ${sections.length} structures) exceeded the ` +
            `${DEFAULT_OUTLINE_BUDGET_BYTES}-byte budget. Re-call with sections:["${sections[0]?.id}"] ` +
            `(add more IDs as needed) to inline specific structures.`,
        };
        ctx.enrich.notice(
          'Coordinates exceeded the inline budget; re-call with sections for specific structures.',
        );
      }
    }

    ctx.enrich({ requested: ids.length, resolved: structures.length });
    if (failed.length > 0) {
      ctx.enrich.notice(
        `${failed.length} of ${ids.length} IDs did not resolve: ${failed.map((f) => f.id).join(', ')}.`,
      );
    }

    return { structures, failed, ...(overflow ? { overflow } : {}) };
  },

  format: (result) => {
    const lines: string[] = [`## Structures (${result.structures.length})`];
    for (const s of result.structures) {
      lines.push(`\n### ${s.id} _(${s.source})_`);
      if (s.title) lines.push(s.title);
      const meta = [
        s.pdbId ? `**PDB:** ${s.pdbId}` : null,
        s.method ? `**Method:** ${s.method}` : null,
        typeof s.resolution === 'number' ? `**Resolution:** ${s.resolution} Å` : null,
        s.organism ? `**Organism:** ${s.organism}` : null,
        s.provider ? `**Provider:** ${s.provider}` : null,
        typeof s.meanPlddt === 'number' ? `**Mean pLDDT:** ${s.meanPlddt.toFixed(1)}` : null,
      ].filter(Boolean);
      if (meta.length > 0) lines.push(meta.join(' | '));
      if (s.confidenceBuckets) {
        const b = s.confidenceBuckets;
        lines.push(
          `**Confidence:** veryHigh ${pct(b.veryHigh)} · confident ${pct(b.confident)} · low ${pct(b.low)} · veryLow ${pct(b.veryLow)}`,
        );
      }
      const urls = [
        s.coordinateUrls.cif ? `[cif](${s.coordinateUrls.cif})` : null,
        s.coordinateUrls.pdb ? `[pdb](${s.coordinateUrls.pdb})` : null,
        s.coordinateUrls.bcif ? `[bcif](${s.coordinateUrls.bcif})` : null,
      ].filter(Boolean);
      if (urls.length > 0) lines.push(`**Coordinates:** ${urls.join(' · ')}`);
      if (s.paeDocUrl) lines.push(`**PAE:** ${s.paeDocUrl}`);
      if (s.coordinates) {
        lines.push(
          `**Inlined ${s.coordinateFormat ?? 'coordinates'} (${s.coordinates.length} bytes):**`,
        );
        lines.push(
          '```',
          s.coordinates.slice(0, 2000),
          s.coordinates.length > 2000 ? '… (truncated in text view)' : '',
          '```',
        );
      }
    }
    if (result.failed.length > 0) {
      lines.push(`\n### Failed (${result.failed.length})`);
      for (const f of result.failed) lines.push(`- ${f.id}: ${f.reason}`);
    }
    if (result.overflow) {
      lines.push(`\n### Coordinates withheld (over budget)`);
      lines.push(result.overflow.notice);
      for (const s of result.overflow.sections) lines.push(`- ${s.id}: ${s.bytes} bytes`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

interface Resolution {
  failed: Array<{ id: string; reason: string }>;
  structures: StructureRecord[];
}

async function fetchExperimental(ids: string[], ctx: Context): Promise<Resolution> {
  const rcsb = getRcsbService();
  const entries = await rcsb.getEntries(ids, ctx);
  const byId = new Map(entries.map((e) => [e.id.toUpperCase(), e]));
  const structures: StructureRecord[] = [];
  const failed: Resolution['failed'] = [];
  for (const id of ids) {
    const meta = byId.get(id.toUpperCase());
    if (!meta) {
      failed.push({ id, reason: 'No PDB entry found for this ID.' });
      continue;
    }
    structures.push({
      id: meta.id,
      source: 'experimental',
      ...(meta.title ? { title: meta.title } : {}),
      ...(meta.methods && meta.methods.length > 0 ? { method: meta.methods.join(', ') } : {}),
      ...(typeof meta.resolution === 'number' ? { resolution: meta.resolution } : {}),
      ...(meta.organisms.length > 0 ? { organism: meta.organisms[0] } : {}),
      coordinateUrls: {
        cif: rcsb.coordinateFileUrl(meta.id, 'cif'),
        pdb: rcsb.coordinateFileUrl(meta.id, 'pdb'),
        bcif: rcsb.coordinateFileUrl(meta.id, 'bcif'),
      },
    });
  }
  return { structures, failed };
}

async function fetchPredictedOrBest(
  ids: string[],
  source: 'predicted' | 'best_available',
  concurrency: number,
  ctx: Context,
): Promise<Resolution> {
  const results = await mapWithConcurrency(ids, concurrency, async (id) => {
    const record =
      source === 'predicted' ? await fetchPrediction(id, ctx) : await fetchBest(id, ctx);
    return record ?? { failedId: id };
  });
  const structures: StructureRecord[] = [];
  const failed: Resolution['failed'] = [];
  for (const r of results) {
    if ('failedId' in r)
      failed.push({ id: r.failedId, reason: 'No predicted model found for this accession.' });
    else structures.push(r);
  }
  return { structures, failed };
}

async function fetchPrediction(accession: string, ctx: Context): Promise<StructureRecord | null> {
  const model = await getAlphaFoldService().getPrediction(accession, ctx);
  if (!model) return null;
  return {
    id: model.uniprotAccession,
    source: 'predicted',
    ...(model.uniprotDescription ? { title: model.uniprotDescription } : {}),
    ...(model.organism ? { organism: model.organism } : {}),
    provider: 'AlphaFold DB',
    ...(typeof model.meanPlddt === 'number' ? { meanPlddt: model.meanPlddt } : {}),
    ...(model.confidenceBuckets ? { confidenceBuckets: model.confidenceBuckets } : {}),
    ...(model.paeDocUrl ? { paeDocUrl: model.paeDocUrl } : {}),
    coordinateUrls: {
      ...(model.cifUrl ? { cif: model.cifUrl } : {}),
      ...(model.pdbUrl ? { pdb: model.pdbUrl } : {}),
      ...(model.bcifUrl ? { bcif: model.bcifUrl } : {}),
    },
  };
}

async function fetchBest(accession: string, ctx: Context): Promise<StructureRecord | null> {
  const summary = await getBeaconsService().getSummary(accession, ctx);
  if (!summary.found || summary.models.length === 0) return null;
  // Prefer an experimental model; otherwise the highest-confidence prediction.
  const experimental = summary.models.find((m) => /experimentally/i.test(m.modelCategory ?? ''));
  const best =
    experimental ??
    [...summary.models].sort(
      (a, b) => (b.confidenceAvgLocalScore ?? 0) - (a.confidenceAvgLocalScore ?? 0),
    )[0];
  if (!best) return null;
  const isExperimental = /experimentally/i.test(best.modelCategory ?? '');

  // For an experimental pick the federated id is the chosen PDB entry; surface it
  // explicitly so the agent can cite the structure, and fetch its title for parity
  // with source "experimental". The title is best-effort — a failed lookup must
  // not drop the structure the agent already has.
  let pdbId: string | undefined;
  let title: string | undefined;
  if (isExperimental && best.modelIdentifier) {
    pdbId = best.modelIdentifier.toUpperCase();
    const entries = await getRcsbService()
      .getEntries([pdbId], ctx)
      .catch(() => []);
    title = entries[0]?.title;
  }

  return {
    id: summary.accession,
    source: isExperimental ? 'experimental' : 'predicted',
    ...(pdbId ? { pdbId } : {}),
    ...(title ? { title } : {}),
    ...(best.provider ? { provider: best.provider } : {}),
    ...(typeof best.resolution === 'number' ? { resolution: best.resolution } : {}),
    ...(best.experimentalMethod ? { method: best.experimentalMethod } : {}),
    ...(typeof best.confidenceAvgLocalScore === 'number'
      ? { meanPlddt: best.confidenceAvgLocalScore }
      : {}),
    coordinateUrls: best.modelUrl ? coordinateUrlFor(best.modelUrl) : {},
  };
}

/** Slot a single federated model URL into the right format key. */
function coordinateUrlFor(url: string): { cif?: string; pdb?: string; bcif?: string } {
  if (/\.bcif/i.test(url)) return { bcif: url };
  if (/\.pdb/i.test(url)) return { pdb: url };
  return { cif: url };
}

/** Fetch and inline coordinate content for the requested structures. */
async function inlineCoordinates(
  structures: StructureRecord[],
  inline: Set<string> | 'all',
  concurrency: number,
  ctx: Context,
): Promise<void> {
  const targets = structures.filter((s) => inline === 'all' || inline.has(s.id.toUpperCase()));
  await mapWithConcurrency(targets, concurrency, async (s) => {
    const pick = s.coordinateUrls.cif
      ? (['cif', s.coordinateUrls.cif] as const)
      : s.coordinateUrls.pdb
        ? (['pdb', s.coordinateUrls.pdb] as const)
        : null;
    if (!pick) return;
    try {
      s.coordinates = await fetchText(pick[1], ctx, {
        operation: 'getStructure.inlineCoordinates',
        label: 'Coordinate file',
        baseDelayMs: 400,
        maxRetries: 1,
      });
      s.coordinateFormat = pick[0];
    } catch (err) {
      ctx.log.warning('Failed to inline coordinates', {
        id: s.id,
        error: err instanceof Error ? err.message : err,
      });
    }
  });
}
