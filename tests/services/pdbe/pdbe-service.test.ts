/**
 * @fileoverview Tests for the PDBe service's SIFTS best-structures lookup, run
 * over a strict fetch stub so the shared HTTP layer's retry and body checks run
 * too: chain rows normalized to PDBe models (method uppercased, an NMR entry's
 * null resolution omitted, sparse rows kept sparse), the 404 → no-rows branch,
 * every other failure thrown rather than read as "no PDB entry", the one-attempt
 * 15 s bound under fake timers (a stalled error body included, with no timer
 * left after a 404), and a caller's cancellation left uncaught.
 * @module tests/services/pdbe/pdbe-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PdbeService } from '@/services/pdbe/pdbe-service.js';

const BASE = 'https://pdbe.test/api';
const urlFor = (acc: string) => `${BASE}/mappings/best_structures/${acc}`;

const service = () => new PdbeService({} as never, {} as never, { pdbeApiBaseUrl: BASE } as never);

const http = createFetchMock();

/** Answer every SIFTS request with `respond`. */
function serve(respond: (req: Request) => Response | Promise<Response>): void {
  http.route({ match: (req) => req.url.startsWith(`${BASE}/`), respond });
}

/** Rows trimmed from PDBe's live P0DTC2 answer (5,457 chain rows), plus one NMR row. */
const P0DTC2_ROWS = [
  {
    pdb_id: '8cxq',
    chain_id: 'A',
    experimental_method: 'Electron Microscopy',
    resolution: 2.3,
    tax_id: 2697049,
    unp_start: 1,
    unp_end: 1273,
    start: 1,
    end: 1273,
    coverage: 1.0,
  },
  {
    pdb_id: '7z8o',
    chain_id: 'A',
    experimental_method: 'X-ray diffraction',
    resolution: 0.96,
    tax_id: 2697049,
    unp_start: 333,
    unp_end: 527,
    start: 1,
    end: 195,
    coverage: 0.155,
  },
  {
    pdb_id: '2mxx',
    chain_id: 'A',
    experimental_method: 'Solution NMR',
    resolution: null,
    tax_id: 2697049,
    unp_start: 816,
    unp_end: 855,
    start: 1,
    end: 40,
    coverage: 0.031,
  },
];

/** PDBe's 404 body for an accession it maps no PDB entry to. */
const NO_DATA = { message: 'Requested endpoint does not contain any data' };

beforeEach(() => {
  http.reset();
  http.install();
});
afterEach(() => {
  http.restore();
  vi.useRealTimers();
});

describe('PdbeService.getBestStructures', () => {
  it('normalizes SIFTS chain rows to PDBe models with the method in RCSB casing', async () => {
    serve(() => Response.json({ P0DTC2: P0DTC2_ROWS }));
    const models = await service().getBestStructures('p0dtc2', createMockContext());

    expect(models).toEqual([
      {
        modelIdentifier: '8cxq',
        provider: 'PDBe',
        coverage: 1,
        uniprotStart: 1,
        uniprotEnd: 1273,
        resolution: 2.3,
        experimentalMethod: 'ELECTRON MICROSCOPY',
      },
      {
        modelIdentifier: '7z8o',
        provider: 'PDBe',
        coverage: 0.155,
        uniprotStart: 333,
        uniprotEnd: 527,
        resolution: 0.96,
        experimentalMethod: 'X-RAY DIFFRACTION',
      },
      // An NMR entry's null resolution is left out, not read as 0.
      {
        modelIdentifier: '2mxx',
        provider: 'PDBe',
        coverage: 0.031,
        uniprotStart: 816,
        uniprotEnd: 855,
        experimentalMethod: 'SOLUTION NMR',
      },
    ]);
    expect(http.calls.map((c) => c.request.url)).toEqual([urlFor('P0DTC2')]);
    expect(http.calls[0]?.request.headers.get('user-agent')).toMatch(/^protein-mcp-server /);
  });

  it('keeps a sparse row sparse and drops a row with no PDB ID', async () => {
    serve(() => Response.json({ P11111: [{ chain_id: 'A', coverage: 1 }, { pdb_id: '1abc' }] }));
    expect(await service().getBestStructures('P11111', createMockContext())).toEqual([
      { modelIdentifier: '1abc', provider: 'PDBe' },
    ]);
  });

  it('reads a 404 as PDBe mapping no PDB entry to the accession, in one request', async () => {
    serve(() => Response.json(NO_DATA, { status: 404 }));
    expect(await service().getBestStructures('A0PK11', createMockContext())).toEqual([]);
    expect(http.calls).toHaveLength(1);
  });

  it.each([
    ['answers 503', () => new Response('Service Unavailable', { status: 503 })],
    ['answers 500', () => new Response('', { status: 500 })],
    ['answers 429', () => new Response('', { status: 429 })],
    [
      'serves an HTML page with 200',
      () => new Response('<!DOCTYPE html><html><body>Maintenance</body></html>', { status: 200 }),
    ],
    ['serves an empty body with 200', () => new Response('', { status: 200 })],
    ['serves unparseable JSON with 200', () => new Response('{"P0DTC2": [', { status: 200 })],
    ['answers 200 without the accession’s rows', () => Response.json({ P99999: P0DTC2_ROWS })],
  ])('throws, never reading it as no PDB entry, when PDBe %s', async (_label, respond) => {
    serve(respond);
    await expect(service().getBestStructures('P0DTC2', createMockContext())).rejects.toThrow();
    expect(http.calls).toHaveLength(1);
  });

  it('maps a non-404 status to a typed, status-classified error', async () => {
    serve(() => new Response('upstream detail', { status: 503 }));
    await expect(service().getBestStructures('P0DTC2', createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: expect.stringContaining('PDBe returned HTTP 503'),
    });
  });
});

/** A request that answers only by rejecting once its signal aborts. */
const pendingUntilAborted = (req: Request) =>
  new Promise<Response>((_, reject) => {
    if (req.signal.aborted) reject(req.signal.reason);
    req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true });
  });

/** An error body that sends its first bytes, then stalls until the request's signal aborts, as fetch's does. */
const stalledBody = (signal: AbortSignal) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"error":'));
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  });

/** A lookup's outcome, readable while fake time is still advancing. */
function track(lookup: Promise<unknown>) {
  const state: { settled: boolean; error?: unknown } = { settled: false };
  lookup.then(
    () => {
      state.settled = true;
    },
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    },
  );
  return state;
}

describe('PdbeService.getBestStructures time bound', () => {
  beforeEach(() => vi.useFakeTimers());

  it('abandons a request that hangs at 15 s, in one attempt', async () => {
    serve(pendingUntilAborted);
    const lookup = track(service().getBestStructures('P0DTC2', createMockContext()));

    await vi.advanceTimersByTimeAsync(14_999);
    expect(lookup.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(lookup.error).toMatchObject({
      name: 'TimeoutError',
      message: expect.stringContaining('timed out after 15000 ms'),
    });
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.request.signal.aborted).toBe(true);
  });

  it.each([
    ['a hung request', pendingUntilAborted],
    [
      'a network failure',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
    [
      'a per-request timeout',
      () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      },
    ],
  ])(
    'makes no second attempt after %s, so a 200 behind it is never asked for',
    async (_label, first) => {
      let attempts = 0;
      serve((req) => {
        attempts += 1;
        return attempts === 1 ? first(req) : Response.json({ P0DTC2: P0DTC2_ROWS });
      });
      const lookup = track(service().getBestStructures('P0DTC2', createMockContext()));
      // Past the bound and past any backoff a retry would wait out.
      await vi.advanceTimersByTimeAsync(40_000);

      expect(lookup.error).toBeInstanceOf(Error);
      expect(http.calls).toHaveLength(1);
    },
  );

  it('throws a 5xx whose body stalls as its status error at 15 s, in one request, leaving no timer', async () => {
    serve(
      (req) =>
        new Response(stalledBody(req.signal), { status: 503, statusText: 'Service Unavailable' }),
    );
    const lookup = track(service().getBestStructures('P0DTC2', createMockContext()));

    await vi.advanceTimersByTimeAsync(14_999);
    expect(lookup.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // The same error a prompt 503 draws: the body that never finished is left out.
    expect(lookup.error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'PDBe returned HTTP 503 Service Unavailable.',
      data: { status: 503 },
    });
    expect(http.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer behind on a 404 whose body it never reads', async () => {
    serve(() => Response.json(NO_DATA, { status: 404 }));
    expect(await service().getBestStructures('A0PK11', createMockContext())).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with the caller’s reason, not the timeout, when the caller cancels a hung request', async () => {
    const caller = new AbortController();
    serve((req) => {
      caller.abort(new DOMException('cancelled', 'AbortError'));
      return pendingUntilAborted(req);
    });

    // Settles with the clock still at zero, and the attempt's timer goes with it.
    await expect(
      service().getBestStructures('P0DTC2', createMockContext({ signal: caller.signal })),
    ).rejects.toMatchObject({ name: 'AbortError', message: 'cancelled' });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(http.calls).toHaveLength(1);
  });
});
