/**
 * @fileoverview af://{uniprot} — predicted-structure summary for a UniProt
 * accession (mean pLDDT, confidence-band fractions, model URLs, version) from the
 * AlphaFold DB. The injectable-context twin of protein_get_structure for
 * source: predicted.
 * @module mcp-server/resources/definitions/af-summary.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { invalidParams, notFound } from '@cyanheads/mcp-ts-core/errors';
import { getAlphaFoldService } from '@/services/alphafold/alphafold-service.js';
import { isAlphaFoldEntryId, isUniProtAccession } from '@/services/shared/identifiers.js';

export const afSummaryResource = resource('af://{uniprot}', {
  name: 'alphafold-structure-summary',
  title: 'AlphaFold structure summary',
  description:
    'Predicted-structure summary for a UniProt accession from AlphaFold DB: mean pLDDT, confidence-band fractions, model URLs, and version.',
  mimeType: 'application/json',
  params: z.object({
    uniprot: z.string().describe('UniProt accession (e.g. P69905).'),
  }),
  output: z.object({
    uniprotAccession: z.string().describe('UniProt accession.'),
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
  }),

  async handler(params, ctx) {
    // AlphaFold answers a non-accession-shaped identifier with a 400 whose raw
    // response body would otherwise surface verbatim; reject the shape locally.
    // An AlphaFold DB entry ID resolves upstream too, and this resource emits one
    // as `entryId`, so accept the form it hands back.
    if (!isUniProtAccession(params.uniprot) && !isAlphaFoldEntryId(params.uniprot))
      throw invalidParams(
        `"${params.uniprot}" is not a UniProt accession — af:// is keyed by UniProt accession (e.g. af://P69905) or an AlphaFold DB entry ID (e.g. af://AF-P69905-F1).`,
        { uniprot: params.uniprot },
      );
    const model = await getAlphaFoldService().getPrediction(params.uniprot, ctx);
    if (!model)
      throw notFound(`No AlphaFold model found for ${params.uniprot.toUpperCase()}`, {
        uniprot: params.uniprot,
      });
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
    };
  },
});
