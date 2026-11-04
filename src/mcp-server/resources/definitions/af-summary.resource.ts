/**
 * @fileoverview af://{uniprot} — predicted-structure summary for a UniProt
 * accession, isoform accession, or AlphaFold DB entry ID (mean pLDDT,
 * confidence-band fractions, model URLs, version) from AlphaFold DB. After a
 * miss, UniProt decides: a merged accession answers with its successor's model
 * and a notice; a demerged or deleted one fails with its replacements. The
 * injectable-context twin of protein_get_structure for source: predicted.
 * @module mcp-server/resources/definitions/af-summary.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getAlphaFoldService } from '@/services/alphafold/alphafold-service.js';
import { withCallBudget } from '@/services/shared/call-budget.js';
import {
  canonicalAccessionOf,
  isAlphaFoldEntryId,
  isPredictionAccession,
} from '@/services/shared/identifiers.js';
import {
  inactiveAccessionError,
  mergedAccessionNotice,
} from '@/services/uniprot/uniprot-service.js';

export const afSummaryResource = resource('af://{uniprot}', {
  name: 'alphafold-structure-summary',
  title: 'AlphaFold structure summary',
  description:
    'Predicted-structure summary from AlphaFold DB for a UniProt accession, isoform accession, or AlphaFold DB entry ID: mean pLDDT, confidence-band fractions, model URLs, and version. A UniProt accession merged into another entry answers with the successor’s model and a notice; a demerged or deleted one fails with its replacements.',
  mimeType: 'application/json',
  errors: [
    {
      reason: 'invalid_accession',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The af:// segment is neither a UniProt accession (canonical or isoform) nor an AlphaFold DB entry ID.',
      recovery:
        'Read af:// with a UniProt accession (af://P69905), an isoform accession (af://P04637-2), or an AlphaFold DB entry ID (af://AF-P69905-F1).',
    },
    {
      reason: 'no_model',
      code: JsonRpcErrorCode.NotFound,
      when: 'AlphaFold DB has no model for an accession UniProt lists as active, or for the successor of a merged one.',
      recovery:
        'Call protein_get_structure with source "best_available" for models from other providers, or check that the accession is the intended one.',
    },
    {
      reason: 'accession_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Neither AlphaFold DB nor UniProtKB knows the accession: never assigned, or an isoform number the entry lacks.',
      recovery:
        'Check the accession for a typo; for an isoform number the entry lacks, read af:// with its canonical accession instead.',
    },
    {
      reason: 'inactive_accession',
      code: JsonRpcErrorCode.NotFound,
      when: 'UniProt lists the accession as inactive: demerged into several entries, or deleted.',
      recovery:
        'Read af:// with an accession from data.replacements; an empty list means UniProt deleted the entry without a replacement.',
      thrownBy: 'service',
    },
  ],
  params: z.object({
    uniprot: z
      .string()
      .describe(
        'UniProt accession (e.g. P69905), isoform accession (e.g. P04637-2), or AlphaFold DB entry ID (e.g. AF-P04637-2-F1).',
      ),
  }),
  output: z.object({
    uniprotAccession: z
      .string()
      .describe(
        'UniProt accession the model predicts — the successor when UniProt merged the requested accession.',
      ),
    entryId: z.string().optional().describe('AlphaFold model entry ID (e.g. AF-P69905-F1).'),
    meanPlddt: z.number().optional().describe('Mean pLDDT confidence (0–100).'),
    confidenceBuckets: z
      .object({
        veryLow: z.number().describe('Fraction with pLDDT < 50.'),
        low: z.number().describe('Fraction with pLDDT 50–70.'),
        confident: z.number().describe('Fraction with pLDDT 70–90.'),
        veryHigh: z.number().describe('Fraction with pLDDT > 90.'),
      })
      .optional()
      .describe('Residue fractions per confidence band.'),
    organism: z.string().optional().describe('Source organism.'),
    uniprotDescription: z.string().optional().describe('UniProt protein description.'),
    modelVersion: z.number().optional().describe('AlphaFold model version.'),
    cifUrl: z.string().optional().describe('mmCIF coordinate file URL.'),
    pdbUrl: z.string().optional().describe('PDB-format coordinate file URL.'),
    bcifUrl: z.string().optional().describe('Binary CIF coordinate file URL.'),
    paeDocUrl: z.string().optional().describe('Predicted Aligned Error documentation URL.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Present when UniProt merged the requested accession into another entry; names the merge.',
      ),
  }),

  async handler(params, ctx) {
    const id = params.uniprot;
    // AlphaFold answers a non-accession-shaped identifier with a 400 whose raw
    // response body would otherwise surface verbatim; reject the shape locally.
    // An AlphaFold DB entry ID resolves upstream too, and this resource emits one
    // as `entryId`, so accept the form it hands back.
    if (!isPredictionAccession(id) && !isAlphaFoldEntryId(id)) {
      throw ctx.fail(
        'invalid_accession',
        `"${id}" is not a UniProt accession — af:// is keyed by UniProt accession (e.g. af://P69905), isoform accession (e.g. af://P04637-2), or AlphaFold DB entry ID (e.g. af://AF-P69905-F1).`,
        { uniprot: id },
      );
    }
    const lookup = await withCallBudget(ctx, (call) =>
      getAlphaFoldService().findPrediction(id, call),
    );
    if (lookup.kind === 'missed') {
      const { uniprot } = lookup;
      switch (uniprot.kind) {
        case 'inactive':
          throw inactiveAccessionError(uniprot);
        case 'unknown':
          throw ctx.fail(
            'accession_not_found',
            `UniProtKB has no entry for ${uniprot.accession}, and AlphaFold DB has no model for it.`,
            { uniprot: id },
          );
        case 'merged':
          throw ctx.fail(
            'no_model',
            `${uniprot.accession} was merged into ${uniprot.successor} in UniProtKB, and AlphaFold DB has no model for ${uniprot.successor}.`,
            { uniprot: id },
          );
        case 'active':
          throw ctx.fail(
            'no_model',
            // AlphaFold DB keys the canonical sequence under the bare accession, never as isoform 1.
            /-1$/.test(uniprot.accession)
              ? `No AlphaFold model found for ${uniprot.accession}; AlphaFold DB keys the canonical sequence under the bare accession — read af://${canonicalAccessionOf(uniprot.accession)}.`
              : `No AlphaFold model found for ${uniprot.accession}.`,
            { uniprot: id },
          );
      }
    }
    const { model, mergedFrom } = lookup;
    return {
      uniprotAccession: model.uniprotAccession,
      ...(model.entryId ? { entryId: model.entryId } : {}),
      ...(typeof model.meanPlddt === 'number' ? { meanPlddt: model.meanPlddt } : {}),
      ...(model.confidenceBuckets ? { confidenceBuckets: model.confidenceBuckets } : {}),
      ...(model.organism ? { organism: model.organism } : {}),
      ...(model.uniprotDescription ? { uniprotDescription: model.uniprotDescription } : {}),
      ...(typeof model.modelVersion === 'number' ? { modelVersion: model.modelVersion } : {}),
      ...(model.cifUrl ? { cifUrl: model.cifUrl } : {}),
      ...(model.pdbUrl ? { pdbUrl: model.pdbUrl } : {}),
      ...(model.bcifUrl ? { bcifUrl: model.bcifUrl } : {}),
      ...(model.paeDocUrl ? { paeDocUrl: model.paeDocUrl } : {}),
      ...(mergedFrom ? { notice: mergedAccessionNotice(mergedFrom, model.uniprotAccession) } : {}),
    };
  },
});
