/**
 * @fileoverview Tests for the 3D-Beacons service: federated model normalization
 * against the real summary shape (UniProt span included), the un-narrowed
 * summary request, the 404 → { found:false } branch (distinct from a transport
 * error), the non-404 throw as a status-classified error, the model_identifier
 * filter (drops entries with no ID), the found = (models.length > 0) rule, and
 * under fake timers a stalled error body cut at the attempt deadline and a 404
 * that leaves no timer. Run over a strict fetch stub, so the shared HTTP layer
 * runs too.
 * @module tests/services/beacons/beacons-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeaconsService } from '@/services/beacons/beacons-service.js';

const BASE = 'https://beacons.test';

const service = () =>
  new BeaconsService({} as never, {} as never, { beaconsBaseUrl: BASE } as never);

const http = createFetchMock();

/** Answer every 3D-Beacons request with `respond`. */
function serve(respond: (req: Request) => Response): void {
  http.route({ match: (req) => req.url.startsWith(`${BASE}/`), respond });
}

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
        uniprot_start: 2,
        uniprot_end: 142,
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
        uniprot_start: 1,
        uniprot_end: 142,
        confidence_type: 'pLDDT',
        confidence_avg_local_score: 96.7,
      },
    },
  ],
};

beforeEach(() => {
  http.reset();
  http.install();
});
afterEach(() => http.restore());

describe('BeaconsService.getSummary', () => {
  it('normalizes experimental and predicted models with provider-specific fields', async () => {
    serve(() => Response.json(SUMMARY));
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
      uniprotStart: 2,
      uniprotEnd: 142,
      resolution: 1.74,
      experimentalMethod: 'X-RAY DIFFRACTION',
    });
    expect(out.models[1]).toMatchObject({
      modelIdentifier: 'AF-P69905-F1',
      confidenceType: 'pLDDT',
      confidenceAvgLocalScore: 96.7,
      uniprotStart: 1,
      uniprotEnd: 142,
    });
    // The federated request carries no provider filter.
    expect(http.calls.map((c) => c.request.url)).toEqual([`${BASE}/uniprot/summary/P69905.json`]);
  });

  it('omits the UniProt span when the summary lacks it, rather than inventing one', async () => {
    serve(() =>
      Response.json({ structures: [{ summary: { model_identifier: 'X1', provider: 'PDBe' } }] }),
    );
    const [model] = (await service().getSummary('P1', createMockContext())).models;
    expect(model).toEqual({ modelIdentifier: 'X1', provider: 'PDBe' });
  });

  it('returns found:false with no models on a 404, in one request (no error thrown)', async () => {
    serve(() => Response.json({}, { status: 404 }));
    const out = await service().getSummary('P00000', createMockContext());
    expect(out).toEqual({ accession: 'P00000', found: false, models: [] });
    expect(http.calls).toHaveLength(1);
  });

  it.each([
    [503, 'Service Unavailable', JsonRpcErrorCode.ServiceUnavailable],
    [500, 'Internal Server Error', JsonRpcErrorCode.ServiceUnavailable],
    [429, 'Too Many Requests', JsonRpcErrorCode.RateLimited],
    [400, 'Bad Request', JsonRpcErrorCode.InvalidParams],
  ])(
    'throws a status-classified error on HTTP %i, in one request',
    async (status, statusText, code) => {
      serve(() => new Response('upstream detail', { status, statusText }));
      await expect(service().getSummary('P69905', createMockContext())).rejects.toMatchObject({
        code,
        message: `3D-Beacons returned HTTP ${status} ${statusText}.`,
        data: { status },
      });
      expect(http.calls).toHaveLength(1);
    },
  );

  it('drops structures whose summary has no model_identifier', async () => {
    serve(() =>
      Response.json({
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
    serve(() => Response.json({ uniprot_entry: { ac: 'P2' }, structures: [] }));
    const out = await service().getSummary('P2', createMockContext());
    expect(out).toMatchObject({ accession: 'P2', found: false, models: [] });
  });

  it('falls back to the requested accession when uniprot_entry.ac is absent', async () => {
    serve(() => Response.json({ structures: [{ summary: { model_identifier: 'X1' } }] }));
    const out = await service().getSummary('p9', createMockContext());
    expect(out.accession).toBe('P9');
  });
});

describe('BeaconsService.getSummary error-body deadline (fake timers)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** The HTTP layer's per-attempt deadline, which 3D-Beacons requests keep. */
  const ATTEMPT_MS = 30_000;

  it('throws a 5xx whose body stalls as its status error at the attempt deadline, in one request', async () => {
    serve(
      (req) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('<html>'));
              // Like fetch's body, it errors once the request's signal aborts.
              req.signal.addEventListener('abort', () => controller.error(req.signal.reason), {
                once: true,
              });
            },
          }),
          { status: 503, statusText: 'Service Unavailable' },
        ),
    );
    const state: { settled: boolean; error?: unknown } = { settled: false };
    service()
      .getSummary('P69905', createMockContext())
      .then(
        () => {
          state.settled = true;
        },
        (error: unknown) => {
          state.settled = true;
          state.error = error;
        },
      );

    await vi.advanceTimersByTimeAsync(ATTEMPT_MS - 1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // The same error a prompt 503 draws, never a retry of the status.
    expect(state.error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: '3D-Beacons returned HTTP 503 Service Unavailable.',
      data: { status: 503 },
    });
    expect(http.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer behind on a 404 whose body it never reads', async () => {
    serve(() => Response.json({}, { status: 404 }));
    const out = await service().getSummary('P00000', createMockContext());
    expect(out).toEqual({ accession: 'P00000', found: false, models: [] });
    expect(vi.getTimerCount()).toBe(0);
  });
});
