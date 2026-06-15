/**
 * @fileoverview Tests for the pdb://{entry_id} resource: entry-summary projection
 * from RCSB metadata, the notFound branch when the entry doesn't resolve, and
 * sparse-payload tolerance (optional fields omitted, required arrays preserved).
 * RCSB service mocked.
 * @module tests/resources/pdb-summary.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getEntries = vi.fn();
vi.mock('@/services/rcsb/rcsb-service.js', () => ({
  getRcsbService: () => ({ getEntries }),
}));

import { pdbSummaryResource } from '@/mcp-server/resources/definitions/pdb-summary.resource.js';

beforeEach(() => vi.clearAllMocks());

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
          { entityId: '4HHB_1', description: 'Hemoglobin subunit alpha', chains: ['A'] },
        ],
        ligands: [{ compId: 'HEM', name: 'PROTOPORPHYRIN IX CONTAINING FE' }],
      },
    ]);
    const params = pdbSummaryResource.params.parse({ entry_id: '4hhb' });
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

  it('throws NotFound when the entry does not resolve', async () => {
    getEntries.mockResolvedValue([]);
    const params = pdbSummaryResource.params.parse({ entry_id: '9ZZZ' });
    await expect(
      pdbSummaryResource.handler(params, createMockContext({ uri: new URL('pdb://9zzz') })),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
  });

  it('tolerates a sparse entry — omits unknown optionals, keeps required arrays', async () => {
    getEntries.mockResolvedValue([{ id: '1ABC', organisms: [], polymerEntities: [], ligands: [] }]);
    const params = pdbSummaryResource.params.parse({ entry_id: '1ABC' });
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
