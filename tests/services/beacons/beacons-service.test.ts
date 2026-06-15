/**
 * @fileoverview Tests for the 3D-Beacons service: federated model normalization
 * against the real summary shape, the 404 → { found:false } branch (distinct from
 * a transport error), the non-404 throw, the model_identifier filter (drops
 * entries with no ID), and the found = (models.length > 0) rule. HTTP mocked.
 * @module tests/services/beacons/beacons-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/shared/http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/shared/http.js')>();
  return { ...actual, fetchResponse: vi.fn() };
});

import { BeaconsService } from '@/services/beacons/beacons-service.js';
import { fetchResponse } from '@/services/shared/http.js';

const fetchResponseMock = vi.mocked(fetchResponse);

const service = () =>
  new BeaconsService(
    {} as never,
    {} as never,
    {
      beaconsBaseUrl: 'https://beacons.test',
    } as never,
  );

const okResponse = (body: unknown) =>
  ({ status: 200, ok: true, text: async () => JSON.stringify(body) }) as Response;

/** A real 3D-Beacons `/uniprot/summary/{acc}.json` payload (experimental + predicted). */
const SUMMARY = {
  uniprot_entry: { ac: 'P69905' },
  structures: [
    {
      summary: {
        model_identifier: '4HHB',
        model_category: 'EXPERIMENTALLY DETERMINED',
        provider: 'PDBe',
        model_url: 'https://files.test/4hhb.cif',
        coverage: 0.98,
        resolution: 1.74,
        experimental_method: 'X-RAY DIFFRACTION',
      },
    },
    {
      summary: {
        model_identifier: 'AF-P69905-F1',
        model_category: 'AB-INITIO',
        provider: 'AlphaFold DB',
        model_url: 'https://alphafold.test/af.cif',
        coverage: 1,
        confidence_type: 'pLDDT',
        confidence_avg_local_score: 96.7,
      },
    },
  ],
};

beforeEach(() => vi.clearAllMocks());

describe('BeaconsService.getSummary', () => {
  it('normalizes experimental and predicted models with provider-specific fields', async () => {
    fetchResponseMock.mockResolvedValue(okResponse(SUMMARY));
    const out = await service().getSummary('p69905', createMockContext());

    expect(out.accession).toBe('P69905');
    expect(out.found).toBe(true);
    expect(out.models).toHaveLength(2);
    expect(out.models[0]).toEqual({
      modelIdentifier: '4HHB',
      modelCategory: 'EXPERIMENTALLY DETERMINED',
      provider: 'PDBe',
      modelUrl: 'https://files.test/4hhb.cif',
      coverage: 0.98,
      resolution: 1.74,
      experimentalMethod: 'X-RAY DIFFRACTION',
    });
    expect(out.models[1]).toMatchObject({
      modelIdentifier: 'AF-P69905-F1',
      confidenceType: 'pLDDT',
      confidenceAvgLocalScore: 96.7,
    });
  });

  it('returns found:false with no models on a 404 (no transport error thrown)', async () => {
    fetchResponseMock.mockResolvedValue({
      status: 404,
      ok: false,
      text: async () => '',
    } as Response);
    const out = await service().getSummary('P00000', createMockContext());
    expect(out).toEqual({ accession: 'P00000', found: false, models: [] });
  });

  it('throws on a non-404 HTTP failure', async () => {
    fetchResponseMock.mockResolvedValue({
      status: 500,
      ok: false,
      text: async () => '',
    } as Response);
    await expect(service().getSummary('P69905', createMockContext())).rejects.toThrow(/HTTP 500/);
  });

  it('drops structures whose summary has no model_identifier', async () => {
    fetchResponseMock.mockResolvedValue(
      okResponse({
        uniprot_entry: { ac: 'P1' },
        structures: [
          { summary: { provider: 'PDBe' } }, // no model_identifier → dropped
          { summary: { model_identifier: 'X1', provider: 'PDBe' } },
          { summary: undefined }, // no summary → dropped
        ],
      }),
    );
    const out = await service().getSummary('P1', createMockContext());
    expect(out.models.map((m) => m.modelIdentifier)).toEqual(['X1']);
  });

  it('reports found:false when the entry exists but yields zero usable models', async () => {
    fetchResponseMock.mockResolvedValue(
      okResponse({ uniprot_entry: { ac: 'P2' }, structures: [] }),
    );
    const out = await service().getSummary('P2', createMockContext());
    expect(out).toMatchObject({ accession: 'P2', found: false, models: [] });
  });

  it('falls back to the requested accession when uniprot_entry.ac is absent', async () => {
    fetchResponseMock.mockResolvedValue(
      okResponse({ structures: [{ summary: { model_identifier: 'X1' } }] }),
    );
    const out = await service().getSummary('p9', createMockContext());
    expect(out.accession).toBe('P9');
  });
});
