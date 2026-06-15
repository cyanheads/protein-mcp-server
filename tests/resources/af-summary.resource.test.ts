/**
 * @fileoverview Tests for the af://{uniprot} resource: predicted-summary
 * projection from an AlphaFold model (confidence buckets, URLs, version), the
 * notFound branch when no model exists, and sparse-model tolerance. AlphaFold
 * service mocked.
 * @module tests/resources/af-summary.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getPrediction = vi.fn();
vi.mock('@/services/alphafold/alphafold-service.js', () => ({
  getAlphaFoldService: () => ({ getPrediction }),
}));

import { afSummaryResource } from '@/mcp-server/resources/definitions/af-summary.resource.js';

const at = (uniprot: string) => createMockContext({ uri: new URL(`af://${uniprot}`) });

beforeEach(() => vi.clearAllMocks());

describe('af://{uniprot}', () => {
  it('projects a full predicted-structure summary including confidence buckets', async () => {
    getPrediction.mockResolvedValue({
      uniprotAccession: 'P69905',
      entryId: 'AF-P69905-F1',
      meanPlddt: 96.78,
      confidenceBuckets: { veryLow: 0, low: 0.014, confident: 0.12, veryHigh: 0.866 },
      organism: 'Homo sapiens',
      uniprotDescription: 'Hemoglobin subunit alpha',
      modelVersion: 4,
      cifUrl: 'https://af/cif',
      pdbUrl: 'https://af/pdb',
      bcifUrl: 'https://af/bcif',
      paeDocUrl: 'https://af/pae',
    });
    const params = afSummaryResource.params.parse({ uniprot: 'p69905' });
    const out = await afSummaryResource.handler(params, at('p69905'));

    expect(out).toMatchObject({
      uniprotAccession: 'P69905',
      entryId: 'AF-P69905-F1',
      meanPlddt: 96.78,
      confidenceBuckets: { veryLow: 0, low: 0.014, confident: 0.12, veryHigh: 0.866 },
      modelVersion: 4,
    });
    expect(out).toEqual(expect.schemaMatching(afSummaryResource.output));
  });

  it('throws NotFound when no AlphaFold model exists', async () => {
    getPrediction.mockResolvedValue(null);
    const params = afSummaryResource.params.parse({ uniprot: 'P00000' });
    await expect(afSummaryResource.handler(params, at('P00000'))).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('tolerates a sparse model — only the accession survives', async () => {
    getPrediction.mockResolvedValue({ uniprotAccession: 'Q12345' });
    const params = afSummaryResource.params.parse({ uniprot: 'Q12345' });
    const out = await afSummaryResource.handler(params, at('Q12345'));

    expect(out).toEqual({ uniprotAccession: 'Q12345' });
    expect(out).not.toHaveProperty('confidenceBuckets');
    expect(out).toEqual(expect.schemaMatching(afSummaryResource.output));
  });
});
