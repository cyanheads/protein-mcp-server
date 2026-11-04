/**
 * @fileoverview protein_get_structure — fetch experimental, predicted, or
 * best-available structures by ID. Batches up to N experimental IDs in one RCSB
 * GraphQL call with per-ID partial success (`failed[]`). Optionally inlines
 * coordinate text under one character budget for both surfaces: a lone selected
 * file pages in fixed windows, several files inline whole only when they fit
 * together, and otherwise a per-structure size outline replaces them. Coordinate
 * files are streamed and cancelled once the response holds what it needs, since
 * the file hosts ignore `Range` and send no length. best_available picks a PDB
 * entry from PDBe's models by coverage, then resolution, confirming with a
 * PDBe-only request when the federated summary lacks them, and otherwise ranks
 * the remaining models on one lDDT-scale confidence. predicted and
 * best_available take canonical and isoform accessions and AlphaFold DB entry
 * IDs; after a model provider misses, UniProt decides what the accession is now
 * (a merge resolves to the successor with a notice, a demerged or deleted
 * accession fails its row). IDs are trimmed and de-duplicated before the batch
 * cap, and the cap's remainder is returned as `ignored`. Every upstream request
 * a call chains shares one time budget; under predicted and best_available, an
 * ID it stops, or whose upstream lookup fails, lands in `failed[]`. A call that
 * resolves nothing because lookups failed or the budget stopped them fails as
 * an outage, `upstream_unavailable`, not as missing entries.
 * Every success-path advisory — repeats, batch cap, partial failure, paging,
 * overflow, failed inlining — accumulates into one notice, since the
 * framework's `notice` field is last-write-wins. Carries upstream data
 * attribution per response.
 * @module mcp-server/tools/definitions/get-structure.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  DEFAULT_OUTLINE_BUDGET_BYTES,
  escapeMarkdownInline,
  markdown,
} from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import {
  type AlphaFoldModel,
  getAlphaFoldService,
} from '@/services/alphafold/alphafold-service.js';
import { type BeaconModel, getBeaconsService } from '@/services/beacons/beacons-service.js';
import { getRcsbService } from '@/services/rcsb/rcsb-service.js';
import type { CoordinateUrls, EntryMeta } from '@/services/rcsb/types.js';
import { mapWithConcurrency } from '@/services/shared/async.js';
import { attributionsFor } from '@/services/shared/attribution.js';
import { withCallBudget } from '@/services/shared/call-budget.js';
import {
  type FetchOptions,
  fetchTextWindow,
  streamText,
  type TextWindow,
} from '@/services/shared/http.js';
import {
  accessionOfAlphaFoldEntryId,
  canonicalAccessionOf,
  isAlphaFoldEntryId,
  isPdbId,
  isPredictionAccession,
  isUniProtAccession,
} from '@/services/shared/identifiers.js';
import { TextBudget } from '@/services/shared/text-budget.js';
import {
  type AccessionStatus,
  getUniProtService,
  inactiveAccessionMessage,
  mergedAccessionNotice,
} from '@/services/uniprot/uniprot-service.js';
import {
  attributionSchema,
  ligandSchema,
  polymerEntitySchema,
  renderAttribution,
} from './_schemas.js';

/**
 * Characters of coordinate text one response carries: one window of a lone
 * selected file, or several whole files that fit together. The framework's
 * outline budget, so a window and the overflow outline share one limit.
 */
const COORDS_WINDOW = DEFAULT_OUTLINE_BUDGET_BYTES;

const confidenceBucketsSchema = z.object({
  veryLow: z.number().describe('Fraction of residues with pLDDT < 50.'),
  low: z.number().describe('Fraction with pLDDT 50–70.'),
  confident: z.number().describe('Fraction with pLDDT 70–90.'),
  veryHigh: z.number().describe('Fraction with pLDDT > 90.'),
});

const structureRecordSchema = z
  .object({
    id: z
      .string()
      .describe(
        'Structure identifier: the PDB entry ID, or the UniProt accession the model belongs to — isoform suffix kept, the accession an AlphaFold DB entry ID names, or the successor when UniProt merged the requested accession (the notice names the merge).',
      ),
    source: z
      .enum(['experimental', 'predicted'])
      .describe('Whether the structure is experimental or predicted.'),
    pdbId: z
      .string()
      .optional()
      .describe(
        'Chosen PDB entry ID when a best_available query resolved to a PDB entry (id stays the queried UniProt accession), so the structure can be cited without parsing the coordinate URL. Absent for any other pick, including an experimental model outside the PDB such as a SASBDB fit.',
      ),
    title: z.string().optional().describe('Structure / protein title.'),
    method: z.string().optional().describe('Experimental method(s).'),
    resolution: z.number().optional().describe('Resolution in Å (experimental).'),
    organisms: z
      .array(z.string())
      .optional()
      .describe(
        "Source organisms: under source experimental, every distinct source organism of the entry, in entity-number order; under source predicted, the AlphaFold DB model's organism. Omitted when upstream names none, and on best_available records.",
      ),
    molecularWeight: z
      .number()
      .optional()
      .describe(
        'Deposited structure molecular weight in kDa. Present only when the call used source experimental; omitted when the record does not report one.',
      ),
    releaseDate: z
      .string()
      .optional()
      .describe(
        'Initial release date (ISO 8601). Present only when the call used source experimental; omitted when the record does not report one.',
      ),
    polymerEntities: z
      .array(polymerEntitySchema)
      .optional()
      .describe(
        'Modeled polymer entities, each with both chain namespaces — authAsymIds for protein_get_annotations.chain, labelAsymIds for protein_compare_structures.chain. Present when the call used source experimental (computed-model IDs included); omitted under source predicted or best_available and for entries with none.',
      ),
    ligands: z
      .array(ligandSchema)
      .optional()
      .describe(
        'Bound non-polymer components. Present when the call used source experimental; omitted under source predicted or best_available, when the entry binds none, or when the record carries no ligand data.',
      ),
    provider: z
      .string()
      .optional()
      .describe(
        'Model provider: the modelling provider of a predicted record, or the federated provider of a best_available pick (PDBe for a PDB entry).',
      ),
    coverage: z
      .number()
      .optional()
      .describe(
        "Fraction (0–1) of the UniProt sequence the best_available pick's mapped span covers — the span between uniprotStart and uniprotEnd, which can include residues the model leaves unmodeled. Present only under source best_available.",
      ),
    uniprotStart: z
      .number()
      .optional()
      .describe(
        "First UniProt residue of the best_available pick's mapped span. Present only under source best_available.",
      ),
    uniprotEnd: z
      .number()
      .optional()
      .describe(
        "Last UniProt residue of the best_available pick's mapped span. Present only under source best_available.",
      ),
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
      .describe(
        'Coordinate file download URLs. A format with no published file is omitted — e.g. pdb for large entries archived as mmCIF only.',
      ),
    coordinateFormat: z
      .enum(['cif', 'pdb', 'bcif'])
      .optional()
      .describe('Format of inlined coordinates, when present.'),
    coordinates: z
      .string()
      .optional()
      .describe(
        `Inlined coordinate text: characters [coordinatesOffset, coordinatesOffset + its length) of the file coordinateFormat names. A lone selected file arrives in windows of up to ${COORDS_WINDOW} characters; several selected files arrive whole only when they total ${COORDS_WINDOW} characters or fewer.`,
      ),
    coordinatesOffset: z
      .number()
      .optional()
      .describe(
        'Character offset in the coordinate file where coordinates begins. Present whenever coordinates is.',
      ),
    coordinatesNextOffset: z
      .number()
      .optional()
      .describe(
        'Offset of the next window when the file continues past coordinates — pass it as coords_offset with sections naming this structure. Absent when coordinates reaches the end of the file.',
      ),
  })
  .describe('A resolved structure with metadata and coordinate-file URLs.');

type StructureRecord = z.infer<typeof structureRecordSchema>;

export const getStructure = tool('protein_get_structure', {
  title: 'protein-mcp-server: get structure',
  description: `Fetch structures with metadata and coordinate-file URLs. source "experimental" takes PDB entry IDs, and also resolves the computed-model IDs protein_search_structures returns (AF_*/MA_*), which come back marked source "predicted" with their modelling provider; "predicted" takes UniProt accessions, isoform accessions (P04637-2), or AlphaFold DB entry IDs (AF-P04637-2-F1) (AlphaFold, with pLDDT/PAE confidence); "best_available" takes the same identifiers, an entry ID reduced to its accession, and returns the top federated model — the PDB entry with the widest UniProt coverage, ties going to the finest resolution (coverage measures the mapped span, so the pick can be an engineered mutant over the wild-type entry), else the model with the highest confidence on the lDDT scale (pLDDT/100 or QMEANDisCo), unscored models last, which can include an experimental model outside the PDB such as a SASBDB fit; best_available records carry coverage and the UniProt span. Under predicted and best_available, a UniProt accession merged into another entry resolves to its successor's model with a notice naming the merge, and a demerged or deleted accession lands in failed[] with its replacements. Records fetched under source "experimental", computed models included, also carry polymer entities with both chain namespaces (labelAsymIds for protein_compare_structures, authAsymIds for protein_get_annotations), bound ligands, molecular weight, and release date. Resolves up to the configured batch cap per call with per-ID partial success: IDs are trimmed and repeats looked up once, missed IDs are listed in failed[] with their reasons, and IDs beyond the cap are listed in ignored, never looked up. Upstream lookups share one time budget per call; under predicted and best_available, an ID not finished within it, or whose upstream lookup failed, lands in failed[] with a reason to re-call it. Set include_coords to inline coordinate text, held to ${COORDS_WINDOW} characters per response on both surfaces: a lone selected file arrives in ${COORDS_WINDOW}-character windows, each giving coordinatesNextOffset to pass back as coords_offset; several selected files inline whole when they total ${COORDS_WINDOW} characters or fewer, and otherwise overflow lists each file's length — re-call with sections naming one structure to page through its file. coordinateUrls always link the complete files.`,
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
      when: 'No processed ID resolved to a structure, and at least one has none: no record, a malformed ID, or an inactive or unknown accession. data.failed carries each ID with its reason.',
      recovery:
        'Verify ID formats against the per-ID reasons in data.failed (PDB IDs are 4 characters; UniProt accessions match the standard pattern, with an optional isoform suffix such as -2), retry an inactive accession with a replacement its reason names, or locate IDs via protein_search_structures.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: "Under predicted or best_available, no processed ID resolved and none is known to lack a structure: each ID's upstream lookup failed (an error status, an HTML page, a network failure, or a request timeout) or ran out of the call's time budget. data.failed carries each ID with its reason.",
      recovery:
        'Wait a few seconds, then re-call with the IDs in data.failed, fewer per call if the time budget stopped them.',
      retryable: true,
    },
    {
      reason: 'coords_offset_needs_one_structure',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'coords_offset is above 0 while the call selects no structure, or several, for inlined coordinates.',
      recovery:
        'Select exactly one structure: pass sections with that one structure ID (or include_coords on a call with one ID), and set coords_offset to the coordinatesNextOffset its previous window returned.',
    },
  ],

  input: z.object({
    ids: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        'PDB entry IDs or computed-model IDs such as AF_AFP69905F1 (source experimental); UniProt accessions, isoform accessions such as P04637-2, or AlphaFold DB entry IDs such as AF-P04637-2-F1 (predicted / best_available). Trimmed, and a repeat (case-insensitive) is looked up once.',
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
      .describe(
        `Inline coordinate text for every resolved structure — mmCIF, or PDB format when no mmCIF URL is available; coordinateFormat names which. A lone file arrives in ${COORDS_WINDOW}-character windows. Off by default — URLs are always returned.`,
      ),
    sections: z
      .array(z.string())
      .optional()
      .describe(
        'Structure IDs to inline coordinates for, in place of include_coords — from an overflow outline, or one ID to page through its file with coords_offset. Each must match the id of a structure this call resolves.',
      ),
    coords_offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        `Character offset of the window to return when exactly one structure is selected (sections naming one ID, or include_coords on a one-ID call): the window is characters [coords_offset, coords_offset + ${COORDS_WINDOW}). Pass the coordinatesNextOffset a previous window returned.`,
      ),
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
        'Upstream data-source licenses and citations for every source present in structures[] — RCSB PDB for PDB entries, the providing database (AlphaFold DB, ModelArchive, SWISS-MODEL, SASBDB, …) for any other model. Always present — the attribution obligation travels with the data.',
      ),
    overflow: z
      .object({
        sections: z
          .array(
            z
              .object({
                id: z.string().describe('Structure ID whose coordinates were withheld.'),
                bytes: z
                  .number()
                  .describe(
                    "Length of the structure's coordinate file in characters, the unit coords_offset counts.",
                  ),
              })
              .describe('A withheld structure and its coordinate file length.'),
          )
          .describe('Per-structure coordinate file lengths, for a targeted re-call.'),
        notice: z
          .string()
          .describe(
            "How to page through one structure's coordinates with sections and coords_offset.",
          ),
      })
      .optional()
      .describe(
        `Present only when two or more selected coordinate files together exceed ${COORDS_WINDOW} characters, the budget for one response; their coordinates are then withheld from both surfaces.`,
      ),
  }),

  enrichment: {
    requested: z
      .number()
      .describe(
        'Number of IDs in the original request, repeats included, before de-duplication and the batch cap.',
      ),
    processed: z
      .number()
      .describe(
        'Number of distinct IDs looked up: a repeated ID counts once, and IDs past the batch cap are listed in ignored instead.',
      ),
    resolved: z.number().describe('Number of processed IDs that resolved to a structure.'),
    ignored: z
      .array(z.string())
      .optional()
      .describe(
        'IDs past the batch cap, never looked up — trimmed, repeats dropped, in input order. Pass them as ids in a follow-up call with the same source. Absent when the cap dropped nothing.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Every applicable advisory joined into one string: repeated IDs counted once, batch cap, partial failures, a UniProt merge that resolved an accession to its successor, an unavailable PDB check behind a best_available pick, a computed model whose provider coordinate lookup failed (only its BinaryCIF URL listed), the re-call for the next coordinate window, a coords_offset past the end of the file, a sections entry that matched no structure, coordinate-budget overflow, and failed coordinate inlining.',
      ),
  },

  enrichmentTrailer: {
    ignored: {
      render: (ignored) =>
        markdown().bold('ignored:').text(' ').inlineCode(JSON.stringify(ignored)).build(),
    },
  },

  async handler(input, ctx) {
    const cfg = getServerConfig();
    const { unique, repeated } = dedupeIds(input.ids);
    const ids = unique.slice(0, cfg.maxBatchIds);
    const ignored = unique.slice(cfg.maxBatchIds);
    // `ctx.enrich.notice` is last-write-wins, so a second call erases the first.
    // Every advisory this handler can raise accumulates here and is written once.
    const notices: string[] = [];
    if (repeated.length > 0) {
      notices.push(
        `Repeated in ids, counted once: ${repeated.map(escapeMarkdownInline).join(', ')}.`,
      );
    }
    if (ignored.length > 0) {
      notices.push(
        `Batch capped at ${cfg.maxBatchIds} IDs; ${ignored.length} ignored — resubmit the IDs in ignored.`,
      );
    }

    if (input.source === 'experimental') {
      if (ids.some((id) => isPredictionAccession(id) && !isPdbId(id))) {
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

    // One time budget across every upstream request the call chains — model
    // lookups, UniProt checks, title lookups, coordinate reads — so the call
    // settles before the client's request timeout. `call` carries the budget;
    // `ctx` stays the caller's for failures and enrichment.
    const { structures, failed, inlined } = await withCallBudget(ctx, async (call) => {
      const resolution =
        input.source === 'experimental'
          ? await fetchExperimental(ids, cfg.fanoutConcurrency, call)
          : await fetchPredictedOrBest(ids, input.source, cfg.fanoutConcurrency, call);

      if (resolution.structures.length === 0) {
        const rows = resolution.failed.map((f) => `${f.id}: ${f.reason}`).join(' ');
        // An outage is not a set of missing entries: say so, retryably.
        if (resolution.outage) {
          throw ctx.fail(
            'upstream_unavailable',
            `None of the ${ids.length} IDs looked up resolved, and none is known to lack a structure: upstream lookups failed or ran out of time. ${rows}`,
            { failed: resolution.failed },
          );
        }
        throw ctx.fail(
          'all_failed',
          `None of the ${ids.length} IDs looked up resolved to a structure. ${rows}`,
          { failed: resolution.failed },
        );
      }

      if (resolution.failed.length > 0) {
        notices.push(
          `${resolution.failed.length} of ${ids.length} IDs did not resolve: ${resolution.failed.map((f) => escapeMarkdownInline(f.id)).join(', ')}.`,
        );
      }
      notices.push(...resolution.notices);

      // Coordinates, under one budget for both surfaces: a lone selected structure
      // pages through its file in fixed windows; several inline whole only when they
      // fit together, and otherwise `overflow` carries each file's length instead.
      const { targets, unmatched } = selectForInlining(
        resolution.structures,
        input.sections,
        input.include_coords,
      );
      const unmatchedList = unmatched.map(escapeMarkdownInline).join(', ');
      if (input.coords_offset > 0 && targets.length !== 1) {
        throw ctx.fail(
          'coords_offset_needs_one_structure',
          `coords_offset pages one structure's coordinate file, but this call selects ${targets.length} structures for inlining${unmatched.length > 0 ? ` (no structure in the call matches sections entry ${unmatchedList})` : ''}.`,
        );
      }
      if (unmatched.length > 0) {
        notices.push(
          `No structure in this call matches sections entry ${unmatchedList}; sections selects among the structures the call's ids resolve to.`,
        );
      }
      const [lone, ...rest] = targets;
      const inlined: InlineResult = !lone
        ? { failures: [] }
        : rest.length === 0
          ? await inlineWindow(lone, input.coords_offset, call)
          : await inlineBatch(targets, cfg.fanoutConcurrency, call);
      return { ...resolution, inlined };
    });
    if (inlined.failures.length > 0) {
      notices.push(
        `Coordinate inlining failed for ${inlined.failures.join(', ')}; the metadata is complete but the coordinate content is missing — retry, or download the file from that structure's coordinateUrls.`,
      );
    }
    if (inlined.notice) notices.push(inlined.notice);

    ctx.enrich({
      requested: input.ids.length,
      processed: ids.length,
      resolved: structures.length,
      ...(ignored.length > 0 ? { ignored } : {}),
    });
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    // Attribution is a per-response union of the sources actually present, keyed
    // off each record's real provider. A PDB entry's data is fetched from RCSB
    // whatever the beacon's provider label. best_available federates other models
    // through 3D-Beacons (AlphaFold DB, SWISS-MODEL, SASBDB, …), so their provider
    // — not the experimental/predicted split — determines the credit; an uncurated
    // provider falls back to an honest no-license entry. Crediting a SASBDB fit to
    // the PDB, or a SWISS-MODEL structure to AlphaFold, would mis-attribute it.
    const sources = new Set(structures.map(attributionSource));

    return {
      structures,
      failed,
      attribution: attributionsFor(sources),
      ...(inlined.overflow ? { overflow: inlined.overflow } : {}),
    };
  },

  format: (result) => {
    // Structures whose coordinates the batch budget withheld from both surfaces:
    // they carry no `coordinates`, so this set is what earns them the withheld
    // marker instead of silent omission.
    const withheld = new Set(result.overflow?.sections.map((s) => s.id) ?? []);
    const lines: string[] = [`## Structures (${result.structures.length})`];
    for (const s of result.structures) {
      lines.push(`\n### ${s.id} _(${s.source})_`);
      if (s.title) lines.push(s.title);
      const meta = [
        s.pdbId ? `**PDB:** ${s.pdbId}` : null,
        s.method ? `**Method:** ${s.method}` : null,
        typeof s.resolution === 'number' ? `**Resolution:** ${s.resolution} Å` : null,
        s.organisms && s.organisms.length > 0 ? `**Organisms:** ${s.organisms.join(', ')}` : null,
        typeof s.molecularWeight === 'number' ? `**MW:** ${s.molecularWeight} kDa` : null,
        s.releaseDate ? `**Released:** ${s.releaseDate}` : null,
        s.provider ? `**Provider:** ${s.provider}` : null,
        typeof s.coverage === 'number' ? `**Coverage:** ${s.coverage}` : null,
        s.uniprotStart !== undefined || s.uniprotEnd !== undefined
          ? `**UniProt span:** ${s.uniprotStart ?? '?'}–${s.uniprotEnd ?? '?'}`
          : null,
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
            e.organisms && e.organisms.length > 0 ? e.organisms.join(', ') : null,
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
      // The handler holds coordinates to the budget, so the text surface renders
      // exactly what the structured surface carries: a fence sized past any
      // backtick run, the text verbatim, and one line ending before it closes.
      if (s.coordinates !== undefined) {
        const from =
          typeof s.coordinatesOffset === 'number' ? ` from offset ${s.coordinatesOffset}` : '';
        const next =
          typeof s.coordinatesNextOffset === 'number'
            ? `, next coords_offset: ${s.coordinatesNextOffset}`
            : '';
        lines.push(
          `**Inlined ${s.coordinateFormat ?? 'coordinates'} (${s.coordinates.length} characters${from}${next}):**`,
        );
        lines.push(markdown().codeBlock(s.coordinates, s.coordinateFormat).build());
      } else if (withheld.has(s.id)) {
        lines.push(
          '**Coordinates withheld** — the selected files exceed the inline budget together; see the outline below and the URLs above.',
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
      for (const s of result.overflow.sections) lines.push(`- ${s.id}: ${s.bytes} characters`);
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
  /** Advisories about records that resolved with degraded detail or under another accession. */
  notices: string[];
  /**
   * Some IDs failed and none of them is a missing entry: each upstream lookup
   * failed or ran out of time budget. With nothing resolved, the call reports
   * an outage rather than IDs without structures.
   */
  outage: boolean;
  structures: StructureRecord[];
}

/**
 * Trim each ID and drop repeats, keyed case-insensitively (PDB IDs and UniProt
 * accessions both are), keeping the first occurrence in input order.
 * `repeated` names each repeated ID once, as its first occurrence reads.
 */
function dedupeIds(raw: readonly string[]): { repeated: string[]; unique: string[] } {
  const first = new Map<string, string>();
  const repeated = new Set<string>();
  for (const value of raw) {
    const id = value.trim();
    const seen = first.get(id.toUpperCase());
    if (seen === undefined) first.set(id.toUpperCase(), id);
    else repeated.add(seen);
  }
  return { unique: [...first.values()], repeated: [...repeated] };
}

/**
 * True when `withCallBudget` stopped the call's requests: its signal aborts with
 * a `TimeoutError` reason, while a caller's cancellation carries the caller's
 * own reason and must stay a cancellation.
 */
function budgetSpent(ctx: Context): boolean {
  const reason: unknown = ctx.signal.reason;
  return ctx.signal.aborted && reason instanceof DOMException && reason.name === 'TimeoutError';
}

async function fetchExperimental(
  ids: string[],
  concurrency: number,
  ctx: Context,
): Promise<Resolution> {
  const rcsb = getRcsbService();
  const entries = await rcsb.getEntries(ids, ctx);
  const byId = new Map(entries.map((e) => [e.id.toUpperCase(), e]));
  const structures: StructureRecord[] = [];
  const failed: Resolution['failed'] = [];
  const csms: Array<{ meta: EntryMeta; record: StructureRecord }> = [];
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
    const record: StructureRecord = {
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
      ...(meta.organisms.length > 0 ? { organisms: meta.organisms } : {}),
      // Already on EntryMeta from the same getEntries() call — omitted rather than
      // emitted empty, so a sparse entry does not read as "this entry has none".
      ...(meta.polymerEntities.length > 0 ? { polymerEntities: meta.polymerEntities } : {}),
      ...(meta.ligands.length > 0 ? { ligands: meta.ligands } : {}),
      coordinateUrls: rcsb.coordinateUrls(meta),
    };
    structures.push(record);
    if (meta.computedModelProvider) csms.push({ meta, record });
  }

  // RCSB publishes only BinaryCIF for a computed model; its provider publishes the
  // text formats. Each lookup degrades to the RCSB BinaryCIF URL on its own row.
  const notices: string[] = [];
  await mapWithConcurrency(csms, concurrency, async ({ meta, record }) => {
    const provider = await providerCoordinateUrls(meta, ctx);
    if (provider === 'unresolved') {
      notices.push(
        `AlphaFold DB coordinate lookup did not resolve for ${meta.id}; only its RCSB BinaryCIF URL is listed — fetch the model by UniProt accession with source "predicted" for mmCIF and PDB files.`,
      );
      return;
    }
    record.coordinateUrls = { ...record.coordinateUrls, ...provider };
  });
  return { structures, failed, notices, outage: false };
}

/**
 * Text-format coordinate URLs from a computed model's own provider, keyed on the
 * provider entry ID RCSB records. AlphaFold DB file names carry a model version,
 * so they come from its prediction record — the same URLs `source: "predicted"`
 * returns. A ModelArchive download is addressed by entry ID alone. `'unresolved'`
 * marks an AlphaFold model whose lookup failed or found nothing; any other
 * provider has no known download route and contributes nothing.
 */
async function providerCoordinateUrls(
  meta: EntryMeta,
  ctx: Context,
): Promise<CoordinateUrls | 'unresolved'> {
  const entryId = meta.computedModelEntryId;
  if (meta.computedModelProvider === 'ModelArchive' && entryId) {
    return {
      cif: `${getServerConfig().modelArchiveBaseUrl}/api/projects/${encodeURIComponent(entryId)}?type=basic__model_file_name`,
    };
  }
  if (meta.computedModelProvider !== 'AlphaFold DB') return {};
  if (!entryId) return 'unresolved';
  const model = await getAlphaFoldService()
    .getPrediction(entryId, ctx)
    .catch((err: unknown) => {
      // A lookup the call's budget stopped degrades like a failed one; a
      // caller's cancellation stays cancelled.
      if (ctx.signal.aborted && !budgetSpent(ctx)) throw err;
      ctx.log.warning('AlphaFold coordinate lookup failed', {
        id: meta.id,
        error: err instanceof Error ? err.message : err,
      });
      return null;
    });
  return model ? alphaFoldCoordinateUrls(model) : 'unresolved';
}

/** The coordinate URLs an AlphaFold DB prediction record publishes. */
function alphaFoldCoordinateUrls(model: AlphaFoldModel): CoordinateUrls {
  return {
    ...(model.cifUrl ? { cif: model.cifUrl } : {}),
    ...(model.pdbUrl ? { pdb: model.pdbUrl } : {}),
    ...(model.bcifUrl ? { bcif: model.bcifUrl } : {}),
  };
}

/**
 * Per-ID failure reason for an identifier that is not accession-shaped. Kept
 * distinct from the upstream-miss reason so a caller can tell a typo from an
 * accession the model providers simply do not cover.
 */
const MALFORMED_ACCESSION =
  'Not a UniProt accession — predicted and best_available are keyed by UniProt accession (e.g. P69905), isoform accession (e.g. P04637-2), or AlphaFold DB entry ID (e.g. AF-P69905-F1).';

/** Per-ID failure reason for an ID the call's time budget stopped before it resolved. */
const BUDGET_STOPPED =
  "Not finished within this call's upstream time budget — re-call with this ID.";

/** Per-ID failure reason for an ID whose upstream lookup failed: an outage, not a missing entry. */
const UPSTREAM_FAILED =
  'An upstream lookup for this ID failed, so it is not known to lack a structure — re-call with this ID.';

/**
 * Why an ID missed: `not_found` — no structure for it (no model, an inactive or
 * unknown accession, a malformed ID); `budget` — the call's time budget stopped
 * it; `upstream` — a provider lookup failed (an error status, an HTML page, a
 * network failure, a per-request timeout).
 */
type MissCause = 'budget' | 'not_found' | 'upstream';

/** One predicted / best_available ID's outcome: a record with its advisories, or why it missed. */
type IdOutcome =
  | { kind: 'missed'; cause: MissCause; reason: string }
  | { kind: 'resolved'; notices: string[]; record: StructureRecord };

const missed = (reason: string, cause: MissCause = 'not_found'): IdOutcome => ({
  kind: 'missed',
  cause,
  reason,
});

async function fetchPredictedOrBest(
  ids: string[],
  source: 'predicted' | 'best_available',
  concurrency: number,
  ctx: Context,
): Promise<Resolution> {
  const outcomes = await mapWithConcurrency(ids, concurrency, async (id): Promise<IdOutcome> => {
    // The handler's source guard only catches ID-*type* confusion (a PDB ID under
    // predicted). An ID that is neither PDB- nor UniProt-shaped passes it, and a
    // shape both upstreams reject answers with a 400, whose throw inside this
    // worker sinks every other ID in the batch. Shape-check per ID so a malformed
    // entry degrades only its own row, which is the "handle your own failures"
    // contract mapWithConcurrency states. Canonical and isoform accessions and
    // AlphaFold DB entry IDs all key a model.
    if (!isPredictionAccession(id) && !isAlphaFoldEntryId(id)) return missed(MALFORMED_ACCESSION);
    try {
      return source === 'predicted' ? await fetchPrediction(id, ctx) : await fetchBest(id, ctx);
    } catch (err) {
      // A caller's cancellation stays a cancellation. Anything else — the budget
      // stopping this ID, or a provider lookup failing with any error (3D-Beacons
      // throws a plain Error, a refused connection a TypeError) — fails only this
      // ID's row, so the IDs already resolved still return.
      if (ctx.signal.aborted && !budgetSpent(ctx)) throw err;
      if (budgetSpent(ctx)) return missed(BUDGET_STOPPED, 'budget');
      ctx.log.warning('Upstream lookup failed for an ID', {
        id,
        error: err instanceof Error ? err.message : err,
      });
      return missed(UPSTREAM_FAILED, 'upstream');
    }
  });
  const structures: StructureRecord[] = [];
  const failed: Resolution['failed'] = [];
  const notices: string[] = [];
  const causes = new Set<MissCause>();
  outcomes.forEach((outcome, i) => {
    if (outcome.kind === 'missed') {
      failed.push({ id: ids[i] as string, reason: outcome.reason });
      causes.add(outcome.cause);
    } else {
      structures.push(outcome.record);
      notices.push(...outcome.notices);
    }
  });
  return { structures, failed, notices, outage: causes.size > 0 && !causes.has('not_found') };
}

/**
 * The AlphaFold DB model for an ID. AlphaFold DB is asked first; UniProt only
 * after it misses, to follow a merge to the successor's model or to say why
 * there is none.
 */
async function fetchPrediction(id: string, ctx: Context): Promise<IdOutcome> {
  const lookup = await getAlphaFoldService().findPrediction(id, ctx);
  if (lookup.kind === 'missed') return missed(missReason(lookup.uniprot, 'AlphaFold DB'));
  const { model, mergedFrom } = lookup;
  return {
    kind: 'resolved',
    notices: mergedFrom ? [mergedAccessionNotice(mergedFrom, model.uniprotAccession)] : [],
    record: {
      id: model.uniprotAccession,
      source: 'predicted',
      ...(model.uniprotDescription ? { title: model.uniprotDescription } : {}),
      ...(model.organism ? { organisms: [model.organism] } : {}),
      provider: 'AlphaFold DB',
      ...(typeof model.meanPlddt === 'number' ? { meanPlddt: model.meanPlddt } : {}),
      ...(model.confidenceBuckets ? { confidenceBuckets: model.confidenceBuckets } : {}),
      ...(model.paeDocUrl ? { paeDocUrl: model.paeDocUrl } : {}),
      coordinateUrls: alphaFoldCoordinateUrls(model),
    },
  };
}

/**
 * Why an accession has no model, from UniProt's verdict after the model provider
 * missed. An inactive accession names its replacements; a merged one, the
 * successor that has no model either.
 */
function missReason(status: AccessionStatus, provider: 'AlphaFold DB' | '3D-Beacons'): string {
  switch (status.kind) {
    case 'inactive':
      return inactiveAccessionMessage(status);
    case 'unknown':
      return `UniProtKB has no entry for ${status.accession}, and ${provider} has no model for it.`;
    case 'merged':
      return `${status.accession} was merged into ${status.successor} in UniProtKB, and ${provider} has no model for ${status.successor}.`;
    case 'active':
      return `${provider} has no model for ${status.accession}.${isoformOneHint(status.accession)}`;
  }
}

/**
 * Model providers key the canonical sequence under the bare accession, never as
 * isoform 1 (AlphaFold DB answers `P04637-1` with a 404), so a `-1` miss names
 * the bare accession to request instead.
 */
function isoformOneHint(accession: string): string {
  return /-1$/.test(accession)
    ? ` ${accession} names isoform 1, which model providers key under the bare accession — request ${canonicalAccessionOf(accession)}.`
    : '';
}

/**
 * The best_available pick for an ID. 3D-Beacons is keyed by accession, so an
 * AlphaFold DB entry ID is reduced to the accession it names first — 3D-Beacons
 * reads the entry ID itself as a different key. When 3D-Beacons misses, or
 * answers for an accession other than the one requested (a demerged
 * accession's successor, say), UniProt decides: a merge is followed to the
 * successor's pick with a notice, an inactive or unknown accession fails its
 * row, and no record is ever keyed to an accession the caller did not ask for
 * without that notice.
 */
async function fetchBest(id: string, ctx: Context): Promise<IdOutcome> {
  const accession = isAlphaFoldEntryId(id) ? accessionOfAlphaFoldEntryId(id) : id.toUpperCase();
  const beacons = getBeaconsService();
  const summary = await beacons.getSummary(accession, ctx);
  const keyedElsewhere = summary.found && summary.accession.toUpperCase() !== accession;
  if (summary.found && !keyedElsewhere) {
    return settle(await federatedPick(accession, summary.models, ctx), {
      miss: `3D-Beacons has no model for ${accession}.`,
    });
  }
  const status = await getUniProtService().resolveAccession(accession, ctx);
  switch (status.kind) {
    case 'merged': {
      const successor = await beacons.getSummary(status.successor, ctx);
      if (successor.found && successor.accession.toUpperCase() !== status.successor) {
        return missed(missReason(status, '3D-Beacons'));
      }
      return settle(await federatedPick(status.successor, successor.models, ctx), {
        miss: missReason(status, '3D-Beacons'),
        notice: mergedAccessionNotice(accession, status.successor),
      });
    }
    case 'active':
      if (keyedElsewhere) {
        return missed(
          `3D-Beacons answered ${accession} with models for ${summary.accession}, none keyed to ${accession}.${isoformOneHint(accession)}`,
        );
      }
      // No federated summary at all; PDBe may still hold an entry.
      return settle(await federatedPick(accession, [], ctx), {
        miss: missReason(status, '3D-Beacons'),
      });
    default:
      return missed(missReason(status, '3D-Beacons'));
  }
}

/** What {@link federatedPick} found, and the advisories it raised on the way. */
interface FederatedPick {
  notices: string[];
  record?: StructureRecord;
}

/** A federated pick as a per-ID outcome: `notice` leads its advisories; with no record, `miss` leads the reason. */
function settle(found: FederatedPick, opts: { miss: string; notice?: string }): IdOutcome {
  if (!found.record) return missed([opts.miss, ...found.notices].join(' '));
  return {
    kind: 'resolved',
    notices: opts.notice ? [opts.notice, ...found.notices] : found.notices,
    record: found.record,
  };
}

/**
 * The pick among `models`, 3D-Beacons' answer for `accession`. PDB entries come
 * only from PDBe's models, ranked by UniProt coverage, then resolution, then
 * model ID — the order PDBe's own best-structures mapping uses. A federated
 * summary can arrive without PDBe's models, so when it carries none a PDBe-only
 * request confirms; 3D-Beacons answers that request with a 404 when PDBe holds
 * no entry. The confirm corrects an answer already in hand, so when it fails
 * the federated ranking stands, with a notice; a cancelled or out-of-budget
 * call stays stopped. With no PDB entry, every other model — predicted, or
 * experimental but outside the PDB (a SASBDB fit) — ranks by confidence.
 */
async function federatedPick(
  accession: string,
  models: BeaconModel[],
  ctx: Context,
): Promise<FederatedPick> {
  const notices: string[] = [];
  let pdbModels = models.filter(isPdbeModel);
  if (pdbModels.length === 0) {
    try {
      const confirmed = await getBeaconsService().getSummary(accession, ctx, 'pdbe');
      pdbModels = confirmed.models.filter(isPdbeModel);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log.warning('PDBe-only 3D-Beacons check failed', {
        accession,
        error: err instanceof Error ? err.message : err,
      });
      notices.push(
        `The PDB check for ${accession} was unavailable, so its pick ranks the federated models alone and may pass over a PDB entry — re-call for the PDB-first pick.`,
      );
    }
  }
  const [pdbPick] = pdbModels.toSorted(byCoverageThenResolution);
  if (pdbPick) return { record: await pdbEntryRecord(accession, pdbPick, ctx), notices };
  const [otherPick] = models.filter((m) => !isPdbeModel(m)).toSorted(byConfidence);
  return otherPick ? { record: federatedModelRecord(accession, otherPick), notices } : { notices };
}

/** A PDBe model: the only federated model that is a PDB entry, served by RCSB. */
function isPdbeModel(m: BeaconModel): boolean {
  return m.provider?.toLowerCase() === 'pdbe';
}

/** Order by `value`, ascending (`1`) or descending (`-1`), an absent value after any present one. */
function compareMissingLast(
  a: number | undefined,
  b: number | undefined,
  direction: 1 | -1,
): number {
  if (a === undefined || b === undefined)
    return (a === undefined ? 1 : 0) - (b === undefined ? 1 : 0);
  return (a - b) * direction;
}

/** Final tie-break, so the pick never depends on upstream list order. */
function compareModelIds(a: BeaconModel, b: BeaconModel): number {
  return a.modelIdentifier < b.modelIdentifier ? -1 : a.modelIdentifier > b.modelIdentifier ? 1 : 0;
}

function byCoverageThenResolution(a: BeaconModel, b: BeaconModel): number {
  return (
    compareMissingLast(a.coverage, b.coverage, -1) ||
    compareMissingLast(a.resolution, b.resolution, 1) ||
    compareModelIds(a, b)
  );
}

/**
 * A model's confidence on the lDDT scale (0–1). pLDDT (0–100) and QMEANDisCo
 * (0–1) both estimate lDDT, so they compare once pLDDT is divided by 100. Any
 * other metric (ipTM+pTM scores interface accuracy) or no score at all has no
 * place on that scale and ranks after every scored model.
 */
function lddtConfidence(m: BeaconModel): number | undefined {
  if (m.confidenceAvgLocalScore === undefined) return undefined;
  switch (m.confidenceType?.toLowerCase()) {
    case 'plddt':
      return m.confidenceAvgLocalScore / 100;
    case 'qmeandisco':
      return m.confidenceAvgLocalScore;
    default:
      return undefined;
  }
}

function byConfidence(a: BeaconModel, b: BeaconModel): number {
  return (
    compareMissingLast(lddtConfidence(a), lddtConfidence(b), -1) ||
    compareMissingLast(a.coverage, b.coverage, -1) ||
    compareModelIds(a, b)
  );
}

/** The mapped UniProt span a best_available record carries. */
function spanFields(
  m: BeaconModel,
): Pick<StructureRecord, 'coverage' | 'uniprotEnd' | 'uniprotStart'> {
  return {
    ...(typeof m.coverage === 'number' ? { coverage: m.coverage } : {}),
    ...(typeof m.uniprotStart === 'number' ? { uniprotStart: m.uniprotStart } : {}),
    ...(typeof m.uniprotEnd === 'number' ? { uniprotEnd: m.uniprotEnd } : {}),
  };
}

/**
 * A PDBe pick as the PDB entry it names: pdbId for citation, the entry's title,
 * and the full cif/pdb/bcif set from RCSB, matching source experimental rather
 * than the single beacon model URL. The title lookup is best-effort — a failed
 * lookup keeps the structure the caller already has — but a cancelled call stays
 * cancelled.
 */
async function pdbEntryRecord(
  accession: string,
  model: BeaconModel,
  ctx: Context,
): Promise<StructureRecord> {
  const rcsb = getRcsbService();
  const pdbId = model.modelIdentifier.toUpperCase();
  const [entry] = await rcsb.getEntries([pdbId], ctx).catch((err: unknown): EntryMeta[] => {
    if (ctx.signal.aborted) throw err;
    return [];
  });
  return {
    id: accession,
    source: 'experimental',
    pdbId,
    ...(entry?.title ? { title: entry.title } : {}),
    ...(model.provider ? { provider: model.provider } : {}),
    ...(typeof model.resolution === 'number' ? { resolution: model.resolution } : {}),
    ...(model.experimentalMethod ? { method: model.experimentalMethod } : {}),
    ...spanFields(model),
    // The entry record (when the lookup succeeded) says whether a PDB-format file
    // exists; without it the URL set matches an unreported entry.
    coordinateUrls: rcsb.coordinateUrls(entry ?? { id: pdbId }),
  };
}

/**
 * Any pick that is not a PDB entry — a prediction, or an experimental model
 * outside the PDB — with its provider's own model URL and no pdbId.
 */
function federatedModelRecord(accession: string, model: BeaconModel): StructureRecord {
  return {
    id: accession,
    source: /experimentally/i.test(model.modelCategory ?? '') ? 'experimental' : 'predicted',
    ...(model.provider ? { provider: model.provider } : {}),
    ...(typeof model.resolution === 'number' ? { resolution: model.resolution } : {}),
    ...(model.experimentalMethod ? { method: model.experimentalMethod } : {}),
    ...(model.confidenceType ? { confidenceType: model.confidenceType } : {}),
    ...(typeof model.confidenceAvgLocalScore === 'number'
      ? { confidence: model.confidenceAvgLocalScore }
      : {}),
    // meanPlddt is pLDDT-only (0–100); never surface another provider's metric
    // (e.g. QMEANDisCo, 0–1) under it. Non-pLDDT scores stay in confidence.
    ...(typeof model.confidenceAvgLocalScore === 'number' &&
    model.confidenceType?.toLowerCase() === 'plddt'
      ? { meanPlddt: model.confidenceAvgLocalScore }
      : {}),
    ...spanFields(model),
    coordinateUrls: model.modelUrl ? coordinateUrlFor(model.modelUrl) : {},
  };
}

/**
 * The data source a record credits. A PDB entry — fetched from RCSB, whether
 * named under source experimental (no provider) or picked by best_available
 * (pdbId) — credits RCSB PDB; any other model credits its own provider.
 */
function attributionSource(s: StructureRecord): string {
  if (s.source === 'experimental' && (s.pdbId !== undefined || s.provider === undefined)) {
    return 'RCSB PDB';
  }
  return s.provider ?? '3D-Beacons (provider unspecified)';
}

/** Slot a single federated model URL into the right format key. */
function coordinateUrlFor(url: string): CoordinateUrls {
  if (/\.bcif/i.test(url)) return { bcif: url };
  if (/\.pdb/i.test(url)) return { pdb: url };
  return { cif: url };
}

/**
 * The structures whose coordinates to inline: those `sections` names, else every
 * resolved structure under include_coords — one record per structure ID, since
 * two requested IDs can resolve to the same model (an accession and its
 * AlphaFold DB entry ID, a merged accession and its successor), and selecting
 * both would page or outline one file twice. Blank entries (form clients) are
 * ignored; an entry that names no structure in the call is returned as written
 * so the response can name it.
 */
function selectForInlining(
  structures: StructureRecord[],
  sections: string[] | undefined,
  includeCoords: boolean,
): { targets: StructureRecord[]; unmatched: string[] } {
  const byId = new Map<string, StructureRecord>();
  for (const s of structures) {
    if (!byId.has(s.id.toUpperCase())) byId.set(s.id.toUpperCase(), s);
  }
  const named = (sections ?? []).map((s) => s.trim()).filter(Boolean);
  if (named.length === 0)
    return { targets: includeCoords ? [...byId.values()] : [], unmatched: [] };
  const wanted = new Set(named.map((s) => s.toUpperCase()));
  return {
    targets: [...byId.values()].filter((s) => wanted.has(s.id.toUpperCase())),
    unmatched: [...new Set(named)].filter((s) => !byId.has(s.toUpperCase())),
  };
}

/**
 * What inlining adds to the response. `failures` names each structure whose file
 * could not be read — a record that silently lacks `coordinates` is
 * indistinguishable from one never asked to inline.
 */
interface InlineResult {
  failures: string[];
  /** The advisory to raise: the next window's re-call, a past-the-end offset, or the overflow. */
  notice?: string;
  overflow?: { notice: string; sections: Array<{ bytes: number; id: string }> };
}

/** Coordinate-file reads: one retry, since the files are static. */
const COORDINATE_FETCH = {
  operation: 'getStructure.inlineCoordinates',
  label: 'Coordinate file',
  baseDelayMs: 400,
  maxRetries: 1,
} satisfies FetchOptions;

/** A structure's text coordinate file — mmCIF first. BinaryCIF is binary, so a record with only that has none. */
function textCoordinateFile(s: StructureRecord): { format: 'cif' | 'pdb'; url: string } | null {
  if (s.coordinateUrls.cif) return { format: 'cif', url: s.coordinateUrls.cif };
  if (s.coordinateUrls.pdb) return { format: 'pdb', url: s.coordinateUrls.pdb };
  return null;
}

/**
 * Log a failed coordinate read. A read the call's budget stopped is a failed
 * file like any other; a caller's cancellation is rethrown, never reported as one.
 */
function onReadFailure(s: StructureRecord, err: unknown, ctx: Context): void {
  if (ctx.signal.aborted && !budgetSpent(ctx)) throw err;
  ctx.log.warning('Failed to inline coordinates', {
    id: s.id,
    error: err instanceof Error ? err.message : err,
  });
}

/**
 * Inline characters [offset, offset + COORDS_WINDOW) of a lone selected
 * structure's file. The read stops one character past the window, so it
 * downloads no further than the window's end whatever the file's size.
 */
async function inlineWindow(
  s: StructureRecord,
  offset: number,
  ctx: Context,
): Promise<InlineResult> {
  const file = textCoordinateFile(s);
  if (!file) return { failures: [s.id] };
  let window: TextWindow;
  try {
    window = await fetchTextWindow(file.url, ctx, {
      ...COORDINATE_FETCH,
      offset,
      length: COORDS_WINDOW,
    });
  } catch (err) {
    onReadFailure(s, err, ctx);
    return { failures: [s.id] };
  }
  if (!window.more && window.text.length === 0) {
    return {
      failures: [],
      notice: `coords_offset ${offset} is at or past the end of ${s.id}'s ${file.format} file (${window.totalLength} characters); no coordinates returned.`,
    };
  }
  s.coordinates = window.text;
  s.coordinateFormat = file.format;
  s.coordinatesOffset = offset;
  if (!window.more) return { failures: [] };
  const next = offset + window.text.length;
  s.coordinatesNextOffset = next;
  return {
    failures: [],
    notice: `Coordinates for ${s.id} are characters ${offset}–${next - 1} of its ${file.format} file, one ${COORDS_WINDOW}-character window. For the next window re-call with the same ids and source plus sections: ${JSON.stringify([s.id])}, coords_offset: ${next}, or download the whole file from coordinateUrls.`,
  };
}

/**
 * Inline several selected structures' files whole when they total COORDS_WINDOW
 * characters or fewer; otherwise withhold them all and outline each file's
 * length. Every chunk goes through one {@link TextBudget}, which holds text
 * only while the running total fits and afterwards only counts, so the batch
 * never holds more than COORDS_WINDOW characters of file text while still
 * measuring every file for the outline. Targets carry distinct IDs
 * ({@link selectForInlining}), so each keys its own read.
 */
async function inlineBatch(
  targets: StructureRecord[],
  concurrency: number,
  ctx: Context,
): Promise<InlineResult> {
  const budget = new TextBudget(COORDS_WINDOW);
  const formats = await mapWithConcurrency(targets, concurrency, async (s) => {
    const file = textCoordinateFile(s);
    if (!file) return null;
    try {
      await streamText(file.url, ctx, COORDINATE_FETCH, (chunk) => {
        budget.add(s.id, chunk);
        return true;
      });
    } catch (err) {
      onReadFailure(s, err, ctx);
      budget.release(s.id);
      return null;
    }
    return file.format;
  });

  const failures = targets.filter((_, i) => !formats[i]).map((s) => s.id);
  if (!budget.overBudget) {
    targets.forEach((s, i) => {
      const format = formats[i];
      if (!format) return;
      s.coordinates = budget.text(s.id);
      s.coordinateFormat = format;
      s.coordinatesOffset = 0;
    });
    return { failures };
  }
  const sections = targets.flatMap((s, i) =>
    formats[i] ? [{ id: s.id, bytes: budget.length(s.id) }] : [],
  );
  const [first] = sections;
  if (!first) return { failures };
  const total = sections.reduce((n, x) => n + x.bytes, 0);
  // One string for `overflow.notice` and the enrichment accumulator, so the two
  // surfaces cannot describe the withheld state differently.
  const notice = `Coordinates for ${sections.length} structure${sections.length === 1 ? '' : 's'} (${total} characters) exceeded the ${COORDS_WINDOW}-character budget for one response, so none were inlined. Re-call with the same ids and source plus sections: ${JSON.stringify([first.id])} to page through one structure's file in ${COORDS_WINDOW}-character windows, or download each file from that structure's coordinateUrls.`;
  return { failures, notice, overflow: { sections, notice } };
}
