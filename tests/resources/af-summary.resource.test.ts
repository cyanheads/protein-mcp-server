/**
 * @fileoverview Tests for the af://{uniprot} resource: predicted-summary
 * projection from an AlphaFold model (confidence buckets, URLs, version), the
 * notFound branch when no model exists, the local shape guard on a malformed
 * accession, and sparse-model tolerance. AlphaFold service mocked.
 * @module tests/resources/af-summary.resource.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
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
    const params = afSummaryResource.params!.parse({ uniprot: 'p69905' });
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
    const params = afSummaryResource.params!.parse({ uniprot: 'P00000' });
    await expect(afSummaryResource.handler(params, at('P00000'))).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('accepts an AlphaFold DB entry ID, the form it emits as entryId', async () => {
    // af:// hands back `entryId: AF-P69905-F1`; AlphaFold resolves that form, so
    // the malformed-shape guard must not reject the resource's own output.
    getPrediction.mockResolvedValue({
      uniprotAccession: 'P69905',
      meanPlddt: 98,
      cifUrl: 'https://af/cif',
    });
    const params = afSummaryResource.params!.parse({ uniprot: 'AF-P69905-F1' });
    await expect(afSummaryResource.handler(params, at('AF-P69905-F1'))).resolves.toBeDefined();
    expect(getPrediction).toHaveBeenCalledWith('AF-P69905-F1', expect.anything());
  });

  it('rejects a malformed accession locally, without an upstream call', async () => {
    // AlphaFold answers a non-accession-shaped identifier with a 400 whose raw
    // body used to reach the client verbatim; the shape check keeps it local.
    const params = afSummaryResource.params!.parse({ uniprot: 'P0DOESNOT' });
    const err = await Promise.resolve(afSummaryResource.handler(params, at('P0DOESNOT'))).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect((err as McpError).message).toMatch(/not a UniProt accession/i);
    expect((err as McpError).message).not.toMatch(/responseBody|FetchHttpError|Status: 400/i);
    expect(getPrediction).not.toHaveBeenCalled();
  });

  it('tolerates a sparse model — only the accession survives', async () => {
    getPrediction.mockResolvedValue({ uniprotAccession: 'Q12345' });
    const params = afSummaryResource.params!.parse({ uniprot: 'Q12345' });
    const out = await afSummaryResource.handler(params, at('Q12345'));

    expect(out).toEqual({ uniprotAccession: 'Q12345' });
    expect(out).not.toHaveProperty('confidenceBuckets');
    expect(out).toEqual(expect.schemaMatching(afSummaryResource.output));
  });
});
