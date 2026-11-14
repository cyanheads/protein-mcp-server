/**
 * @fileoverview Tests for the pdb://{entry_id} resource: entry-summary projection
 * from RCSB metadata, the notFound branch when the entry doesn't resolve, and
 * sparse-payload tolerance (optional fields omitted, required arrays preserved).
 * RCSB service mocked.
 * @module tests/resources/pdb-summary.resource.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getEntries = vi.fn();
vi.mock('@/services/rcsb/rcsb-service.js', () => ({
  getRcsbService: () => ({ getEntries }),
}));

import { pdbSummaryResource } from '@/mcp-server/resources/definitions/pdb-summary.resource.js';

beforeEach(() => vi.clearAllMocks());

/** RCSB's GraphQL host under a stubbed base URL. Strict: any other request fails the test. */
const rcsb = createFetchMock();

describe('pdb://{entry_id} call budget', () => {
  /** The real RCSB metadata request, sent through the shared HTTP layer to the stub. */
  beforeEach(async () => {
    const { RcsbService } = await vi.importActual<typeof import('@/services/rcsb/rcsb-service.js')>(
      '@/services/rcsb/rcsb-service.js',
    );
    const real = new RcsbService(
      {} as never,
      {} as never,
      { rcsbSearchBaseUrl: 'https://search', rcsbDataBaseUrl: 'https://data' } as never,
    );
    getEntries.mockImplementation((ids: string[], c: never) => real.getEntries(ids, c));
    rcsb.reset();
    rcsb.install();
  });
  afterEach(() => {
    rcsb.restore();
    vi.useRealTimers();
  });

  /** A GraphQL answer that never comes: it rejects only once its request aborts. */
  const hang = (req: Request) =>
    new Promise<Response>((_, reject) => {
      if (req.signal.aborted) reject(req.signal.reason);
      req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true });
    });

  const read = (signal?: AbortSignal) =>
    Promise.resolve(
      pdbSummaryResource.handler(
        pdbSummaryResource.params!.parse({ entry_id: '36ZA' }),
        createMockContext({ uri: new URL('pdb://36za'), ...(signal ? { signal } : {}) }),
      ),
    );

  it('settles a hung metadata request at the 50 s budget as a Timeout, across its retries', async () => {
    vi.useFakeTimers();
    rcsb.route({ match: 'https://data/graphql', respond: hang });
    const state = { settled: false };
    const reading = read()
      .catch((e: unknown) => e)
      .finally(() => {
        state.settled = true;
      });

    // A lone request's own 30 s timeout fires first; the retry it earns is still
    // in flight when the call budget runs out.
    await vi.advanceTimersByTimeAsync(49_999);
    expect(state.settled).toBe(false);
    expect(rcsb.calls.length).toBeGreaterThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled).toBe(true);

    const err = await reading;
    expect(err).toBeInstanceOf(McpError);
    expect(err).toMatchObject({ code: JsonRpcErrorCode.Timeout });
    expect((err as McpError).message).toContain("timed out on the caller's signal");
  });

  it('rejects as cancelled, not as a budget Timeout, when the caller cancels mid-request', async () => {
    const caller = new AbortController();
    rcsb.route({
      match: 'https://data/graphql',
      respond: (req) => {
        caller.abort();
        return hang(req);
      },
    });

    const err = await read(caller.signal).catch((e: unknown) => e);
    expect(rcsb.calls).toHaveLength(1);
    expect(err).toBeInstanceOf(McpError);
    expect(err).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect((err as McpError).message).toContain('was aborted');
  });
});

describe('pdb://{entry_id}', () => {
  it('projects a full entry summary', async () => {
    getEntries.mockResolvedValue([
      {
        id: '4HHB',
        title: 'Deoxyhaemoglobin',
        methods: ['X-RAY DIFFRACTION'],
        resolution: 1.74,
        molecularWeight: 64.74,
        releaseDate: '1984-07-17T00:00:00Z',
        organisms: ['Homo sapiens'],
        polymerEntities: [
          {
            entityId: '4HHB_1',
            description: 'Hemoglobin subunit alpha',
            authAsymIds: ['A'],
            labelAsymIds: ['A'],
          },
        ],
        ligands: [{ compId: 'HEM', name: 'PROTOPORPHYRIN IX CONTAINING FE' }],
      },
    ]);
    const params = pdbSummaryResource.params!.parse({ entry_id: '4hhb' });
    const out = await pdbSummaryResource.handler(
      params,
      createMockContext({ uri: new URL('pdb://4hhb') }),
    );

    expect(out).toMatchObject({
      id: '4HHB',
      title: 'Deoxyhaemoglobin',
      methods: ['X-RAY DIFFRACTION'],
      resolution: 1.74,
      organisms: ['Homo sapiens'],
    });
    expect(out).toEqual(expect.schemaMatching(pdbSummaryResource.output));
  });

  it('exposes both chain namespaces per polymer entity when they differ (6QNR)', async () => {
    getEntries.mockResolvedValue([
      {
        id: '6QNR',
        organisms: [],
        polymerEntities: [
          { entityId: '6QNR_9', authAsymIds: ['82', '8E'], labelAsymIds: ['I', 'OB'] },
        ],
        ligands: [],
      },
    ]);
    const params = pdbSummaryResource.params!.parse({ entry_id: '6QNR' });
    const out = await pdbSummaryResource.handler(
      params,
      createMockContext({ uri: new URL('pdb://6qnr') }),
    );

    expect(out.polymerEntities).toEqual([
      { entityId: '6QNR_9', authAsymIds: ['82', '8E'], labelAsymIds: ['I', 'OB'], chainCount: 2 },
    ]);
    expect(out).toEqual(expect.schemaMatching(pdbSummaryResource.output));
  });

  it('lists every chain of an entity past 100 chains, with chainCount (#102)', async () => {
    const ids = (ns: string) => Array.from({ length: 1615 }, (_, i) => `${ns}${i}`);
    getEntries.mockResolvedValue([
      {
        id: '36ZA',
        organisms: [],
        polymerEntities: [
          { entityId: '36ZA_7', authAsymIds: ids('a'), labelAsymIds: ids('l') },
          { entityId: '36ZA_8', authAsymIds: ['x'], labelAsymIds: ['y'] },
        ],
        ligands: [],
      },
    ]);
    const params = pdbSummaryResource.params!.parse({ entry_id: '36ZA' });
    const out = await pdbSummaryResource.handler(
      params,
      createMockContext({ uri: new URL('pdb://36za') }),
    );

    // The framework parses a resource result against `output` before serving it.
    expect(pdbSummaryResource.output!.parse(out).polymerEntities).toEqual([
      { entityId: '36ZA_7', authAsymIds: ids('a'), labelAsymIds: ids('l'), chainCount: 1615 },
      { entityId: '36ZA_8', authAsymIds: ['x'], labelAsymIds: ['y'], chainCount: 1 },
    ]);
  });

  it('omits an entity chain namespace the upstream did not supply', async () => {
    getEntries.mockResolvedValue([
      { id: '1ABC', organisms: [], polymerEntities: [{ entityId: '1ABC_1' }], ligands: [] },
    ]);
    const params = pdbSummaryResource.params!.parse({ entry_id: '1ABC' });
    const out = await pdbSummaryResource.handler(
      params,
      createMockContext({ uri: new URL('pdb://1abc') }),
    );

    expect(out.polymerEntities).toEqual([{ entityId: '1ABC_1' }]);
    expect(out).toEqual(expect.schemaMatching(pdbSummaryResource.output));
  });

  it('carries every source organism, per entity and entry-wide, through the output parse (2RH1, #85)', async () => {
    // getEntries' normalized 2RH1: the beta-2 adrenergic receptor/T4 lysozyme chimera.
    getEntries.mockResolvedValue([
      {
        id: '2RH1',
        organisms: ['Homo sapiens', 'Tequatrovirus T4'],
        polymerEntities: [
          {
            entityId: '2RH1_1',
            description: 'beta-2-adrenergic receptor/T4-lysozyme chimera',
            organisms: ['Homo sapiens', 'Tequatrovirus T4'],
            authAsymIds: ['A'],
          },
        ],
        ligands: [{ compId: 'CAU', authAsymIds: ['A'] }],
      },
    ]);
    const params = pdbSummaryResource.params!.parse({ entry_id: '2rh1' });
    const out = await pdbSummaryResource.handler(
      params,
      createMockContext({ uri: new URL('pdb://2rh1') }),
    );

    // The framework parses a resource result against `output` before serving it.
    const served = pdbSummaryResource.output!.parse(out);
    expect(served.organisms).toEqual(['Homo sapiens', 'Tequatrovirus T4']);
    expect(served.polymerEntities[0]?.organisms).toEqual(['Homo sapiens', 'Tequatrovirus T4']);
    expect(served.polymerEntities[0]).not.toHaveProperty('organism');
    // The ligand's author chains are internal to structures_with_ligand.
    expect(served.ligands).toEqual([{ compId: 'CAU' }]);
  });

  it('throws NotFound when the entry does not resolve', async () => {
    getEntries.mockResolvedValue([]);
    const params = pdbSummaryResource.params!.parse({ entry_id: '9ZZZ' });
    await expect(
      pdbSummaryResource.handler(params, createMockContext({ uri: new URL('pdb://9zzz') })),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
  });

  it('tolerates a sparse entry — omits unknown optionals, keeps required arrays', async () => {
    getEntries.mockResolvedValue([{ id: '1ABC', organisms: [], polymerEntities: [], ligands: [] }]);
    const params = pdbSummaryResource.params!.parse({ entry_id: '1ABC' });
    const out = await pdbSummaryResource.handler(
      params,
      createMockContext({ uri: new URL('pdb://1abc') }),
    );

    expect(out).toEqual({ id: '1ABC', organisms: [], polymerEntities: [], ligands: [] });
    expect(out).not.toHaveProperty('title');
    expect(out).not.toHaveProperty('resolution');
    expect(out).toEqual(expect.schemaMatching(pdbSummaryResource.output));
  });
});
