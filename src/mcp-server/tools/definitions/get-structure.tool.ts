/**
 * @fileoverview protein_get_structure — fetch experimental, predicted, or
 * best-available structures by ID. Batches up to N experimental IDs in one RCSB
 * GraphQL call with per-ID partial success (`failed[]`). Optionally inlines
 * coordinate-file content; when that overflows a byte budget the content is
 * withheld from both surfaces and a per-structure size outline is returned
 * instead of truncating. Every success-path advisory — batch cap, partial
 * failure, overflow, failed inlining — accumulates into one notice, since the
 * framework's `notice` field is last-write-wins. Carries upstream data
 * attribution (RCSB PDB / AlphaFold DB) per response.
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
import { attributionsFor } from '@/services/shared/attribution.js';
import { fetchText } from '@/services/shared/http.js';
import { isAlphaFoldEntryId, isPdbId, isUniProtAccession } from '@/services/shared/identifiers.js';
import {
  attributionSchema,
  ligandSchema,
  polymerEntitySchema,
  renderAttribution,
} from './_schemas.js';

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
    molecularWeight: z
      .number()
      .optional()
      .describe(
        'Deposited structure molecular weight in kDa, from the RCSB entry record. Omitted when the record does not report one.',
      ),
    releaseDate: z
      .string()
      .optional()
      .describe(
        'Initial release date (ISO 8601), from the RCSB entry record. Omitted when the record does not report one.',
      ),
    polymerEntities: z
      .array(polymerEntitySchema)
      .optional()
      .describe(
        'Modeled polymer entities, each with both chain namespaces — authAsymIds for protein_get_annotations.chain, labelAsymIds for protein_compare_structures.chain. Present for records served by the RCSB entry endpoint (source experimental, computed models included); omitted for predicted / best_available records and for entries with none.',
      ),
    ligands: z
      .array(ligandSchema)
      .optional()
      .describe(
        'Bound non-polymer components. Present for records served by the RCSB entry endpoint; omitted when the entry binds none or the record carries no ligand data.',
      ),
    provider: z.string().optional().describe('Model provider (predicted / best_available).'),
    confidence: z
      .number()
      .optional()
      .describe(
        'Model confidence on its native scale; confidenceType names the metric and range (e.g. pLDDT 0–100, QMEANDisCo 0–1). Present for predicted models that report a score.',
      ),
    confidenceType: z
      .string()
      .optional()
      .describe(
        'Name of the confidence metric carried in confidence (e.g. "pLDDT", "QMEANDisCo"). Providers score on different scales; this names the one in use.',
      ),
    meanPlddt: z
      .number()
      .optional()
      .describe(
        'Mean pLDDT confidence (0–100); present only for pLDDT-scored models. For other metrics read confidence + confidenceType.',
      ),
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
  description: `Fetch structures with metadata and coordinate-file URLs. source "experimental" takes PDB entry IDs (batched in one call), and also resolves the computed-model IDs protein_search_structures returns (AF_*/MA_*), which come back marked source "predicted" with their modelling provider; "predicted" takes UniProt accessions (AlphaFold, with pLDDT/PAE confidence); "best_available" takes UniProt accessions and returns the top federated model — the highest-resolution experimental structure if one exists (optimizing resolution, not biological representativeness, so it can return an engineered mutant over the wild-type entry), else the best prediction. Records served by the RCSB entry endpoint also carry polymer entities with both chain namespaces (labelAsymIds for protein_compare_structures, authAsymIds for protein_get_annotations), bound ligands, molecular weight, and release date. Resolves up to the configured batch cap per call with per-ID partial success — missed IDs are listed in failed[], and IDs beyond the cap are reported in the notice. Set include_coords to inline coordinate content; if the inlined bytes exceed the response budget the content is withheld and overflow lists each structure's size — re-call with sections:[ids] for specific structures, or for a single oversized file download it from that record's coordinateUrls.`,
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
        'PDB entry IDs or computed-model IDs such as AF_AFP69905F1 (source experimental), or UniProt accessions (predicted / best_available).',
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
    attribution: z
      .array(attributionSchema)
      .describe(
        'Upstream data-source licenses and citations for every source present in structures[] — RCSB PDB for experimental records, the modelling provider (AlphaFold DB, ModelArchive, SWISS-MODEL, …) for predicted ones. Always present — the attribution obligation travels with the data.',
      ),
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
    requested: z
      .number()
      .describe(
        'Number of IDs in the original request (input.ids.length), before the batch cap was applied.',
      ),
    processed: z
      .number()
      .describe(
        'Number of IDs actually processed after the batch cap. Lower than requested means the excess IDs were ignored and never looked up — re-submit them in a follow-up call.',
      ),
    resolved: z.number().describe('Number of processed IDs that resolved to a structure.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Every applicable advisory joined into one string: batch cap, partial failures, coordinate-budget overflow, and failed coordinate inlining.',
      ),
  },

  async handler(input, ctx) {
    const cfg = getServerConfig();
    const ids = input.ids.slice(0, cfg.maxBatchIds).map((s) => s.trim());
    // `ctx.enrich.notice` is last-write-wins, so a second call erases the first.
    // Every advisory this handler can raise accumulates here and is written once.
    const notices: string[] = [];
    if (input.ids.length > cfg.maxBatchIds) {
      notices.push(
        `Batch capped at ${cfg.maxBatchIds} IDs; ${input.ids.length - cfg.maxBatchIds} ignored.`,
      );
    }

    if (input.source === 'experimental') {
      if (ids.some((id) => isUniProtAccession(id) && !isPdbId(id))) {
        throw ctx.fail(
          'mixed_id_types',
          'source experimental expects PDB entry IDs, but UniProt accessions were present.',
          { ...ctx.recoveryFor('mixed_id_types') },
        );
      }
    } else if (ids.some((id) => isPdbId(id) && !isUniProtAccession(id))) {
      throw ctx.fail(
        'mixed_id_types',
        `source ${input.source} expects UniProt accessions, but PDB IDs were present.`,
        { ...ctx.recoveryFor('mixed_id_types') },
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
        { ...ctx.recoveryFor('all_failed') },
      );
    }

    if (failed.length > 0) {
      notices.push(
        `${failed.length} of ${ids.length} IDs did not resolve: ${failed.map((f) => f.id).join(', ')}.`,
      );
    }

    // Inline coordinates when requested (all, or only the re-called sections).
    const inlineSet = input.sections?.length
      ? new Set(input.sections.map((s) => s.toUpperCase()))
      : input.include_coords
        ? 'all'
        : null;
    if (inlineSet) {
      const inlineFailures = await inlineCoordinates(
        structures,
        inlineSet,
        cfg.fanoutConcurrency,
        ctx,
      );
      if (inlineFailures.length > 0) {
        notices.push(
          `Coordinate inlining failed for ${inlineFailures.join(', ')}; the metadata is complete but the coordinate content is missing — retry, or download the file from that structure's coordinateUrls.`,
        );
      }
    }

    // Overflow guard: one coordinate file can blow the response budget on its own
    // (4HHB.cif is ~30× it), so the budget applies to the inlined total however few
    // files it spans. Over budget the payload is withheld from both surfaces and
    // `overflow` carries the per-structure size index. A lone withheld file is
    // pointed at its own coordinateUrls — a `sections` re-call would return the
    // identical bytes — while a batch keeps the targeted re-call. A `sections`
    // re-call is not itself re-gated: the caller has already named the exact bytes.
    let overflow: { sections: Array<{ id: string; bytes: number }>; notice: string } | undefined;
    if (inlineSet === 'all') {
      const withCoords = structures.filter((s) => s.coordinates);
      const total = withCoords.reduce((n, s) => n + (s.coordinates?.length ?? 0), 0);
      if (total > DEFAULT_OUTLINE_BUDGET_BYTES) {
        const sections = withCoords.map((s) => ({ id: s.id, bytes: s.coordinates?.length ?? 0 }));
        for (const s of structures) {
          delete s.coordinates;
          delete s.coordinateFormat;
        }
        // One string for `overflow.notice` and the enrichment accumulator, so the
        // structured and text surfaces cannot describe the withheld state differently.
        const overflowNotice =
          sections.length === 1
            ? `Inlined coordinates for ${sections[0]?.id} (${total} bytes) exceeded the ${DEFAULT_OUTLINE_BUDGET_BYTES}-byte budget and were withheld. Download the file from that structure's coordinateUrls — re-calling for the lone section would return the same bytes.`
            : `Inlined coordinates (${total} bytes across ${sections.length} structures) exceeded the ${DEFAULT_OUTLINE_BUDGET_BYTES}-byte budget. Re-call with sections:["${sections[0]?.id}"] (add more IDs as needed) to inline specific structures.`;
        overflow = { sections, notice: overflowNotice };
        notices.push(overflowNotice);
      }
    }

    ctx.enrich({
      requested: input.ids.length,
      processed: ids.length,
      resolved: structures.length,
    });
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    // Attribution is a per-response union of the sources actually present, keyed
    // off each record's real provider. Experimental data is fetched from RCSB
    // regardless of the beacon's provider label. best_available federates predicted
    // models through 3D-Beacons (AlphaFold DB, SWISS-MODEL, BFVD, …), so a predicted
    // record's provider — not the binary source — determines the credit; an
    // uncurated provider falls back to an honest no-license entry. Crediting every
    // predicted model as AlphaFold would mis-attribute a SWISS-MODEL structure.
    const sources = new Set<string>();
    for (const s of structures) {
      sources.add(
        s.source === 'experimental'
          ? 'RCSB PDB'
          : (s.provider ?? '3D-Beacons (provider unspecified)'),
      );
    }

    return {
      structures,
      failed,
      attribution: attributionsFor(sources),
      ...(overflow ? { overflow } : {}),
    };
  },

  format: (result) => {
    // Structures whose payload the batch-overflow gate already purged from the
    // structured surface. Their `coordinates` is gone, so the per-structure
    // length check below reads 0 and cannot recognize them — this set is what
    // still earns them the withheld marker instead of silent omission.
    const withheld = new Set(result.overflow?.sections.map((s) => s.id) ?? []);
    const lines: string[] = [`## Structures (${result.structures.length})`];
    for (const s of result.structures) {
      lines.push(`\n### ${s.id} _(${s.source})_`);
      if (s.title) lines.push(s.title);
      const meta = [
        s.pdbId ? `**PDB:** ${s.pdbId}` : null,
        s.method ? `**Method:** ${s.method}` : null,
        typeof s.resolution === 'number' ? `**Resolution:** ${s.resolution} Å` : null,
        s.organism ? `**Organism:** ${s.organism}` : null,
        typeof s.molecularWeight === 'number' ? `**MW:** ${s.molecularWeight} kDa` : null,
        s.releaseDate ? `**Released:** ${s.releaseDate}` : null,
        s.provider ? `**Provider:** ${s.provider}` : null,
        typeof s.confidence === 'number'
          ? `**Confidence:** ${s.confidence}${s.confidenceType ? ` (${s.confidenceType})` : ''}`
          : null,
        typeof s.meanPlddt === 'number' ? `**Mean pLDDT:** ${s.meanPlddt.toFixed(1)}` : null,
      ].filter(Boolean);
      if (meta.length > 0) lines.push(meta.join(' | '));
      if (s.confidenceBuckets) {
        const b = s.confidenceBuckets;
        lines.push(
          `**Confidence:** veryHigh ${pct(b.veryHigh)} · confident ${pct(b.confident)} · low ${pct(b.low)} · veryLow ${pct(b.veryLow)}`,
        );
      }
      if (s.polymerEntities && s.polymerEntities.length > 0) {
        lines.push('**Polymer entities:**');
        for (const e of s.polymerEntities) {
          const parts = [
            e.description,
            e.organism,
            // Both namespaces are labelled, never merged — they are not interchangeable.
            e.authAsymIds ? `auth_asym_id: ${e.authAsymIds.join(', ')}` : null,
            e.labelAsymIds ? `label_asym_id: ${e.labelAsymIds.join(', ')}` : null,
            typeof e.sequenceLength === 'number' ? `${e.sequenceLength} residues` : null,
          ].filter(Boolean);
          lines.push(`- **${e.entityId}** — ${parts.join(' · ')}`);
        }
      }
      if (s.ligands && s.ligands.length > 0) {
        lines.push('**Ligands:**');
        for (const l of s.ligands) {
          const parts = [l.name, l.formula].filter(Boolean);
          lines.push(`- **${l.compId}**${parts.length > 0 ? ` — ${parts.join(' · ')}` : ''}`);
        }
      }
      const urls = [
        s.coordinateUrls.cif ? `[cif](${s.coordinateUrls.cif})` : null,
        s.coordinateUrls.pdb ? `[pdb](${s.coordinateUrls.pdb})` : null,
        s.coordinateUrls.bcif ? `[bcif](${s.coordinateUrls.bcif})` : null,
      ].filter(Boolean);
      if (urls.length > 0) lines.push(`**Coordinates:** ${urls.join(' · ')}`);
      if (s.paeDocUrl) lines.push(`**PAE:** ${s.paeDocUrl}`);
      // One length rule for every structure carrying coordinates, whether or not
      // the overflow index names it: whole under the budget, otherwise the
      // withheld marker plus the URL pointer above — never a truncated prefix.
      // A `sections` re-call is deliberately not re-gated on the structured
      // surface (the caller named the exact bytes), so this is the one path where
      // the two surfaces carry different payloads; they still agree on *state*,
      // because the token-bounded text surface discloses the omission and points
      // at a working retrieval route instead of silently cutting the content off.
      if (withheld.has(s.id) || (s.coordinates?.length ?? 0) > DEFAULT_OUTLINE_BUDGET_BYTES) {
        lines.push('**Coordinates withheld** — over the inline budget; see the URLs above.');
      } else if (s.coordinates) {
        lines.push(
          `**Inlined ${s.coordinateFormat ?? 'coordinates'} (${s.coordinates.length} bytes):**`,
        );
        lines.push('```', s.coordinates, '```');
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
    if (result.attribution.length > 0) {
      lines.push(`\n### Attribution`);
      lines.push(...renderAttribution(result.attribution));
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
    // RCSB serves computed structure models (AF_* / MA_*) from the same entry
    // endpoint as experimental entries, and protein_search_structures surfaces
    // their IDs under the default content_type. Read the provenance rather than
    // stamping every resolved ID experimental — that would both contradict the
    // record and credit an AlphaFold/ModelArchive model to the PDB's CC0.
    structures.push({
      id: meta.id,
      source: meta.computedModelProvider ? 'predicted' : 'experimental',
      ...(meta.computedModelProvider ? { provider: meta.computedModelProvider } : {}),
      ...(meta.title ? { title: meta.title } : {}),
      ...(meta.methods && meta.methods.length > 0 ? { method: meta.methods.join(', ') } : {}),
      ...(typeof meta.resolution === 'number' ? { resolution: meta.resolution } : {}),
      ...(typeof meta.molecularWeight === 'number'
        ? { molecularWeight: meta.molecularWeight }
        : {}),
      ...(meta.releaseDate ? { releaseDate: meta.releaseDate } : {}),
      ...(meta.organisms.length > 0 ? { organism: meta.organisms[0] } : {}),
      // Already on EntryMeta from the same getEntries() call — omitted rather than
      // emitted empty, so a sparse entry does not read as "this entry has none".
      ...(meta.polymerEntities.length > 0 ? { polymerEntities: meta.polymerEntities } : {}),
      ...(meta.ligands.length > 0 ? { ligands: meta.ligands } : {}),
      coordinateUrls: {
        cif: rcsb.coordinateFileUrl(meta.id, 'cif'),
        pdb: rcsb.coordinateFileUrl(meta.id, 'pdb'),
        bcif: rcsb.coordinateFileUrl(meta.id, 'bcif'),
      },
    });
  }
  return { structures, failed };
}

/**
 * Per-ID failure reason for an identifier that is not accession-shaped. Kept
 * distinct from the upstream-miss reason so a caller can tell a typo from an
 * accession the model providers simply do not cover.
 */
const MALFORMED_ACCESSION =
  'Not a UniProt accession — predicted and best_available are keyed by UniProt accession (e.g. P69905) or an AlphaFold DB entry ID (e.g. AF-P69905-F1).';

async function fetchPredictedOrBest(
  ids: string[],
  source: 'predicted' | 'best_available',
  concurrency: number,
  ctx: Context,
): Promise<Resolution> {
  const results = await mapWithConcurrency(ids, concurrency, async (id) => {
    // The handler's source guard only catches ID-*type* confusion (a PDB ID under
    // predicted). An ID that is neither PDB- nor UniProt-shaped passes it, and a
    // shape both upstreams reject answers with a 400, whose throw inside this
    // worker sinks every other ID in the batch. Shape-check per ID so a malformed
    // entry degrades only its own row, which is the "handle your own failures"
    // contract mapWithConcurrency states. AlphaFold and 3D-Beacons both resolve an
    // AlphaFold DB entry ID as well as a bare accession, so accept either.
    if (!isUniProtAccession(id) && !isAlphaFoldEntryId(id))
      return { failedId: id, reason: MALFORMED_ACCESSION };
    const record =
      source === 'predicted' ? await fetchPrediction(id, ctx) : await fetchBest(id, ctx);
    return record ?? { failedId: id, reason: 'No predicted model found for this accession.' };
  });
  const structures: StructureRecord[] = [];
  const failed: Resolution['failed'] = [];
  for (const r of results) {
    if ('failedId' in r) failed.push({ id: r.failedId, reason: r.reason });
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
  // explicitly so the agent can cite the structure, fetch its title for parity with
  // source "experimental", and emit the full cif/pdb/bcif set from RCSB (matching
  // fetchExperimental) instead of the single beacon modelUrl. The title is
  // best-effort — a failed lookup must not drop the structure the agent already has.
  const rcsb = getRcsbService();
  let pdbId: string | undefined;
  let title: string | undefined;
  if (isExperimental && best.modelIdentifier) {
    pdbId = best.modelIdentifier.toUpperCase();
    const entries = await rcsb.getEntries([pdbId], ctx).catch(() => []);
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
    ...(best.confidenceType ? { confidenceType: best.confidenceType } : {}),
    ...(typeof best.confidenceAvgLocalScore === 'number'
      ? { confidence: best.confidenceAvgLocalScore }
      : {}),
    // meanPlddt is pLDDT-only (0–100); never surface another provider's metric
    // (e.g. QMEANDisCo, 0–1) under it. Non-pLDDT scores stay in confidence.
    ...(typeof best.confidenceAvgLocalScore === 'number' &&
    best.confidenceType?.toLowerCase() === 'plddt'
      ? { meanPlddt: best.confidenceAvgLocalScore }
      : {}),
    coordinateUrls: pdbId
      ? {
          cif: rcsb.coordinateFileUrl(pdbId, 'cif'),
          pdb: rcsb.coordinateFileUrl(pdbId, 'pdb'),
          bcif: rcsb.coordinateFileUrl(pdbId, 'bcif'),
        }
      : best.modelUrl
        ? coordinateUrlFor(best.modelUrl)
        : {},
  };
}

/** Slot a single federated model URL into the right format key. */
function coordinateUrlFor(url: string): { cif?: string; pdb?: string; bcif?: string } {
  if (/\.bcif/i.test(url)) return { bcif: url };
  if (/\.pdb/i.test(url)) return { pdb: url };
  return { cif: url };
}

/**
 * Fetch and inline coordinate content for the requested structures. Returns the
 * IDs whose fetch failed — a record that silently lacks `coordinates` is
 * indistinguishable from one that was never asked to inline, so the caller needs
 * the failure named in the response rather than only in the log.
 */
async function inlineCoordinates(
  structures: StructureRecord[],
  inline: Set<string> | 'all',
  concurrency: number,
  ctx: Context,
): Promise<string[]> {
  const targets = structures.filter((s) => inline === 'all' || inline.has(s.id.toUpperCase()));
  const failures: string[] = [];
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
      failures.push(s.id);
    }
  });
  return failures;
}
