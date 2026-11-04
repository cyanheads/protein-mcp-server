/**
 * @fileoverview Tests for the AlphaFold service: prediction normalization against
 * the real API shape (globalMetricValue → meanPlddt, fraction* → confidence
 * buckets, uniprotSequence length), record selection by the requested accession
 * or entry ID when the canonical lookup also lists isoform models, the 404 →
 * null and no-match → null branches, sparse-payload preservation, and
 * findPrediction's UniProt fallback (consulted only after a miss; a merge is
 * followed to the successor's model). HTTP and UniProt mocked.
 * @module tests/services/alphafold/alphafold-service.test
 */

import { JsonRpcErrorCode, notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/shared/http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/shared/http.js')>();
  return { ...actual, fetchJson: vi.fn() };
});

const resolveAccession = vi.fn();
vi.mock('@/services/uniprot/uniprot-service.js', () => ({
  getUniProtService: () => ({ resolveAccession }),
}));

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

/** p53 records as AlphaFold DB returns them (live capture, model v6). */
const p53 = (isoform: number | undefined, plddt: number) => {
  const accession = isoform ? `P04637-${isoform}` : 'P04637';
  return {
    entryId: `AF-${accession}-F1`,
    uniprotAccession: accession,
    globalMetricValue: plddt,
    latestVersion: 6,
    cifUrl: `https://alphafold.test/files/AF-${accession}-F1-model_v6.cif`,
  };
};
/** The canonical lookup's array: the canonical model plus eight isoform models. */
const P04637_LOOKUP = [
  p53(undefined, 75.06),
  ...[9, 8, 7, 6, 5, 4, 3, 2].map((n) => p53(n, n === 2 || n === 3 ? 76.94 : 80)),
];

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

  it('returns no model for a record that omits uniprotAccession — nothing ties it to the request (#91)', async () => {
    fetchJsonMock.mockResolvedValue([{ globalMetricValue: 80 }]);
    expect(await service().getPrediction('p12345', createMockContext())).toBeNull();
  });

  it.each([
    ['as served', P04637_LOOKUP],
    ['reversed', [...P04637_LOOKUP].reverse()],
  ])(
    'returns the canonical model for a canonical accession whatever the array order (%s) (#91)',
    async (_, lookup) => {
      fetchJsonMock.mockResolvedValue(lookup);
      const out = await service().getPrediction('P04637', createMockContext());
      expect(out).toMatchObject({
        uniprotAccession: 'P04637',
        entryId: 'AF-P04637-F1',
        meanPlddt: 75.06,
      });
    },
  );

  it.each([
    ['P04637-2', [p53(2, 76.94)]],
    ['p04637-2', [p53(2, 76.94)]],
    ['AF-P04637-2-F1', [p53(2, 76.94)]],
    ['P04637-2', [...P04637_LOOKUP].reverse()],
  ])(
    'returns the isoform model for %s, the record keyed to the request (#91)',
    async (id, lookup) => {
      fetchJsonMock.mockResolvedValue(lookup);
      const out = await service().getPrediction(id, createMockContext());
      expect(out).toMatchObject({
        uniprotAccession: 'P04637-2',
        entryId: 'AF-P04637-2-F1',
        meanPlddt: 76.94,
        cifUrl: 'https://alphafold.test/files/AF-P04637-2-F1-model_v6.cif',
      });
    },
  );

  it('selects an entry-ID request by entryId, even when isoform records precede it (#91)', async () => {
    fetchJsonMock.mockResolvedValue([...P04637_LOOKUP].reverse());
    const out = await service().getPrediction('af-p04637-f1', createMockContext());
    expect(out?.entryId).toBe('AF-P04637-F1');
    expect(out?.uniprotAccession).toBe('P04637');
  });

  it("keys an entry-ID match without uniprotAccession to the entry's accession (#91)", async () => {
    fetchJsonMock.mockResolvedValue([{ entryId: 'AF-P04637-2-F1', globalMetricValue: 76.94 }]);
    const out = await service().getPrediction('AF-P04637-2-F1', createMockContext());
    expect(out?.uniprotAccession).toBe('P04637-2');
  });

  it('returns null when every record belongs to another accession (#91)', async () => {
    fetchJsonMock.mockResolvedValue(P04637_LOOKUP.slice(1)); // isoforms only
    expect(await service().getPrediction('P04637', createMockContext())).toBeNull();
  });
});

describe('AlphaFoldService.findPrediction', () => {
  it('answers from AlphaFold DB alone when it holds the requested model — no UniProt request (#83)', async () => {
    fetchJsonMock.mockResolvedValue([FULL_PREDICTION]);
    const out = await service().findPrediction('P69905', createMockContext());
    expect(out).toMatchObject({ kind: 'found', model: { entryId: 'AF-P69905-F1' } });
    expect(out).not.toHaveProperty('mergedFrom');
    expect(resolveAccession).not.toHaveBeenCalled();
  });

  it("follows a merged accession to the successor's model after a miss (#83)", async () => {
    fetchJsonMock
      .mockRejectedValueOnce(notFound('no model for Q1HDT5'))
      .mockResolvedValueOnce([FULL_PREDICTION]);
    resolveAccession.mockResolvedValue({
      kind: 'merged',
      accession: 'Q1HDT5',
      successor: 'P69905',
    });
    const out = await service().findPrediction('q1hdt5', createMockContext());

    expect(out).toMatchObject({
      kind: 'found',
      mergedFrom: 'Q1HDT5',
      model: { uniprotAccession: 'P69905' },
    });
    expect(resolveAccession).toHaveBeenCalledWith('Q1HDT5', expect.anything());
    expect(fetchJsonMock.mock.calls.map((c) => c[0])).toEqual([
      'https://alphafold.test/api/prediction/Q1HDT5',
      'https://alphafold.test/api/prediction/P69905',
    ]);
  });

  it('reports the merge when the successor has no model either (#83)', async () => {
    fetchJsonMock.mockRejectedValue(notFound('no model'));
    const merged = { kind: 'merged', accession: 'Q1HDT5', successor: 'P69905' };
    resolveAccession.mockResolvedValue(merged);
    expect(await service().findPrediction('Q1HDT5', createMockContext())).toEqual({
      kind: 'missed',
      uniprot: merged,
    });
    expect(fetchJsonMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'inactive',
      {
        kind: 'inactive',
        accession: 'P62988',
        inactiveReason: 'DEMERGED',
        replacements: ['P0CG47', 'P0CG48', 'P62979', 'P62987'],
      },
    ],
    ['unknown', { kind: 'unknown', accession: 'P62988' }],
    ['active', { kind: 'active', accession: 'P62988' }],
  ])(
    "hands back UniProt's %s verdict on a miss, asking AlphaFold DB once (#83)",
    async (_, status) => {
      fetchJsonMock.mockRejectedValue(notFound('no model'));
      resolveAccession.mockResolvedValue(status);
      expect(await service().findPrediction('P62988', createMockContext())).toEqual({
        kind: 'missed',
        uniprot: status,
      });
      expect(fetchJsonMock).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ['AF-Q1HDT5-F1', 'Q1HDT5'],
    ['AF-P04637-2-F1', 'P04637-2'],
    ['P04637-99', 'P04637-99'],
  ])("asks UniProt about %s's accession after a miss (#83, #91)", async (id, accession) => {
    fetchJsonMock.mockResolvedValue([]);
    resolveAccession.mockResolvedValue({ kind: 'unknown', accession });
    await service().findPrediction(id, createMockContext());
    expect(resolveAccession).toHaveBeenCalledWith(accession, expect.anything());
  });
});
