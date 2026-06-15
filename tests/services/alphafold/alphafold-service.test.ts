/**
 * @fileoverview Tests for the AlphaFold service: prediction normalization against
 * the real API shape (globalMetricValue → meanPlddt, fraction* → confidence
 * buckets, uniprotSequence length), the 404 → null and empty-array → null
 * branches, and sparse-payload preservation (no fabricated buckets). HTTP mocked.
 * @module tests/services/alphafold/alphafold-service.test
 */

import { JsonRpcErrorCode, notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/shared/http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/shared/http.js')>();
  return { ...actual, fetchJson: vi.fn() };
});

import { AlphaFoldService } from '@/services/alphafold/alphafold-service.js';
import { fetchJson } from '@/services/shared/http.js';

const fetchJsonMock = vi.mocked(fetchJson);

const service = () =>
  new AlphaFoldService(
    {} as never,
    {} as never,
    {
      alphafoldBaseUrl: 'https://alphafold.test',
    } as never,
  );

/** A real AlphaFold `/api/prediction/{acc}` element captured from a live P69905 call. */
const FULL_PREDICTION = {
  entryId: 'AF-P69905-F1',
  uniprotAccession: 'P69905',
  uniprotDescription: 'Hemoglobin subunit alpha',
  organismScientificName: 'Homo sapiens',
  globalMetricValue: 96.78,
  fractionPlddtVeryLow: 0.0,
  fractionPlddtLow: 0.014,
  fractionPlddtConfident: 0.12,
  fractionPlddtVeryHigh: 0.866,
  latestVersion: 4,
  cifUrl: 'https://alphafold.test/files/AF-P69905-F1-model_v4.cif',
  pdbUrl: 'https://alphafold.test/files/AF-P69905-F1-model_v4.pdb',
  bcifUrl: 'https://alphafold.test/files/AF-P69905-F1-model_v4.bcif',
  paeImageUrl: 'https://alphafold.test/files/AF-P69905-F1-predicted_aligned_error_v4.png',
  paeDocUrl: 'https://alphafold.test/api/prediction/P69905',
  uniprotSequence: 'MVLSPADKTNVKAAW',
};

beforeEach(() => vi.clearAllMocks());

describe('AlphaFoldService.getPrediction', () => {
  it('normalizes a full prediction (metric→meanPlddt, fractions→buckets, sequence→length)', async () => {
    fetchJsonMock.mockResolvedValue([FULL_PREDICTION]);
    const out = await service().getPrediction('p69905', createMockContext());

    expect(out).toMatchObject({
      uniprotAccession: 'P69905',
      entryId: 'AF-P69905-F1',
      meanPlddt: 96.78,
      modelVersion: 4,
      organism: 'Homo sapiens',
      uniprotDescription: 'Hemoglobin subunit alpha',
      sequenceLength: 15,
      confidenceBuckets: { veryLow: 0, low: 0.014, confident: 0.12, veryHigh: 0.866 },
    });
  });

  it('upper-cases the accession in the request URL', async () => {
    fetchJsonMock.mockResolvedValue([FULL_PREDICTION]);
    await service().getPrediction('p69905', createMockContext());
    expect(fetchJsonMock.mock.calls[0]?.[0]).toContain('/api/prediction/P69905');
  });

  it('returns null when AlphaFold 404s (no model for the accession)', async () => {
    fetchJsonMock.mockRejectedValue(notFound('not found'));
    expect(await service().getPrediction('P00000', createMockContext())).toBeNull();
  });

  it('returns null when the array is empty', async () => {
    fetchJsonMock.mockResolvedValue([]);
    expect(await service().getPrediction('P69905', createMockContext())).toBeNull();
  });

  it('rethrows non-404 errors (does not swallow a transport failure)', async () => {
    fetchJsonMock.mockRejectedValue(serviceUnavailable('AlphaFold DB down'));
    await expect(service().getPrediction('P69905', createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });

  it('preserves missing fields as unknown — no fabricated buckets or URLs on a sparse model', async () => {
    fetchJsonMock.mockResolvedValue([{ uniprotAccession: 'Q12345' }]);
    const out = await service().getPrediction('Q12345', createMockContext());

    expect(out).toEqual({ uniprotAccession: 'Q12345' });
    expect(out).not.toHaveProperty('confidenceBuckets');
    expect(out).not.toHaveProperty('meanPlddt');
    expect(out).not.toHaveProperty('cifUrl');
  });

  it('builds a confidence bucket from a single present fraction, zero-filling the rest', async () => {
    fetchJsonMock.mockResolvedValue([{ uniprotAccession: 'Q1', fractionPlddtVeryHigh: 0.9 }]);
    const out = await service().getPrediction('Q1', createMockContext());
    expect(out?.confidenceBuckets).toEqual({ veryLow: 0, low: 0, confident: 0, veryHigh: 0.9 });
  });

  it('falls back to the requested accession when upstream omits uniprotAccession', async () => {
    fetchJsonMock.mockResolvedValue([{ globalMetricValue: 80 }]);
    const out = await service().getPrediction('p12345', createMockContext());
    expect(out?.uniprotAccession).toBe('P12345');
  });
});
