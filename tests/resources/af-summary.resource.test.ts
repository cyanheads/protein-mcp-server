/**
 * @fileoverview Tests for the af://{uniprot} resource: predicted-summary
 * projection from an AlphaFold model (confidence buckets, URLs, version), the
 * merge notice when UniProt merged the requested accession, the typed failures
 * after a miss (no_model, accession_not_found, inactive_accession), the local
 * shape guard (canonical and isoform accessions and entry IDs accepted, other
 * shapes rejected before any request), sparse-model tolerance, and the call
 * budget. AlphaFold service mocked.
 * @module tests/resources/af-summary.resource.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const findPrediction = vi.fn();
vi.mock('@/services/alphafold/alphafold-service.js', () => ({
  getAlphaFoldService: () => ({ findPrediction }),
}));

import { afSummaryResource } from '@/mcp-server/resources/definitions/af-summary.resource.js';

const at = (uniprot: string, signal?: AbortSignal) =>
  createMockContext({
    uri: new URL(`af://${uniprot}`),
    errors: afSummaryResource.errors,
    ...(signal ? { signal } : {}),
  });

const read = (uniprot: string, signal?: AbortSignal) =>
  Promise.resolve(
    afSummaryResource.handler(afSummaryResource.params!.parse({ uniprot }), at(uniprot, signal)),
  );

const failure = (uniprot: string): Promise<McpError> =>
  read(uniprot).then(
    () => {
      throw new Error(`af://${uniprot} resolved; expected a failure`);
    },
    (e: unknown) => e as McpError,
  );

const found = (model: Record<string, unknown>, mergedFrom?: string) => ({
  kind: 'found',
  model,
  ...(mergedFrom ? { mergedFrom } : {}),
});

const missed = (uniprot: Record<string, unknown>) => ({ kind: 'missed', uniprot });

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe('af://{uniprot}', () => {
  it('projects a full predicted-structure summary including confidence buckets', async () => {
    findPrediction.mockResolvedValue(
      found({
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
      }),
    );
    const out = await read('p69905');

    expect(out).toMatchObject({
      uniprotAccession: 'P69905',
      entryId: 'AF-P69905-F1',
      meanPlddt: 96.78,
      confidenceBuckets: { veryLow: 0, low: 0.014, confident: 0.12, veryHigh: 0.866 },
      modelVersion: 4,
    });
    expect(out).not.toHaveProperty('notice');
    expect(out).toEqual(expect.schemaMatching(afSummaryResource.output));
  });

  it("answers a merged accession with the successor's model and a notice naming the merge (#83)", async () => {
    findPrediction.mockResolvedValue(
      found({ uniprotAccession: 'P69905', entryId: 'AF-P69905-F1', meanPlddt: 96.78 }, 'Q1HDT5'),
    );
    const out = await read('Q1HDT5');

    // The framework parses a resource result against `output` before serving it.
    const served = afSummaryResource.output!.parse(out);
    expect(served).toMatchObject({ uniprotAccession: 'P69905', entryId: 'AF-P69905-F1' });
    expect(served.notice).toBe(
      'Q1HDT5 was merged into P69905 in UniProtKB; this answer is for P69905.',
    );
  });

  it('fails no_model (NotFound) when AlphaFold DB has no model for an active accession', async () => {
    findPrediction.mockResolvedValue(missed({ kind: 'active', accession: 'Q8WZ42-2' }));
    const err = await failure('Q8WZ42-2');
    expect(err).toBeInstanceOf(McpError);
    expect(err).toMatchObject({ code: JsonRpcErrorCode.NotFound, data: { reason: 'no_model' } });
    expect(err.message).toContain('Q8WZ42-2');
  });

  it('names the bare accession for a -1 isoform, which AlphaFold DB keys without the suffix (#91)', async () => {
    findPrediction.mockResolvedValue(missed({ kind: 'active', accession: 'P04637-1' }));
    const err = await failure('P04637-1');
    expect(err).toMatchObject({ data: { reason: 'no_model' } });
    expect(err.message).toContain('af://P04637');
  });

  it('fails no_model naming the merge when the successor has no model either (#83)', async () => {
    findPrediction.mockResolvedValue(
      missed({ kind: 'merged', accession: 'Q1HDT5', successor: 'P69905' }),
    );
    const err = await failure('Q1HDT5');
    expect(err).toMatchObject({ code: JsonRpcErrorCode.NotFound, data: { reason: 'no_model' } });
    expect(err.message).toContain('merged into P69905');
  });

  it('fails accession_not_found (NotFound) when UniProtKB has no entry either (#83)', async () => {
    findPrediction.mockResolvedValue(missed({ kind: 'unknown', accession: 'A0A9Z9Z9Z9' }));
    const err = await failure('A0A9Z9Z9Z9');
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'accession_not_found' },
    });
    expect(err.message).toContain('A0A9Z9Z9Z9');
    expect(err.message).not.toMatch(/Status: 404|rest\.uniprot\.org/);
  });

  it('fails inactive_accession with the demerge replacements (#83)', async () => {
    findPrediction.mockResolvedValue(
      missed({
        kind: 'inactive',
        accession: 'P62988',
        inactiveReason: 'DEMERGED',
        replacements: ['P0CG47', 'P0CG48', 'P62979', 'P62987'],
      }),
    );
    const err = await failure('P62988');
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'inactive_accession',
        accession: 'P62988',
        inactiveReason: 'DEMERGED',
        replacements: ['P0CG47', 'P0CG48', 'P62979', 'P62987'],
      },
    });
    expect(err.message).toContain('P0CG47, P0CG48, P62979, P62987');
  });

  it('fails inactive_accession for a deleted accession, stating there is no replacement (#83)', async () => {
    findPrediction.mockResolvedValue(
      missed({
        kind: 'inactive',
        accession: 'A0A008APQ8',
        inactiveReason: 'DELETED',
        deletedReason: 'Not part of a reference proteome',
        replacements: [],
      }),
    );
    const err = await failure('A0A008APQ8');
    expect(err).toMatchObject({
      data: { reason: 'inactive_accession', inactiveReason: 'DELETED', replacements: [] },
    });
    expect(err.message).toMatch(/no replacement/i);
  });

  it.each([
    ['AF-P69905-F1', 'P69905', 'AF-P69905-F1'],
    ['P04637-2', 'P04637-2', 'AF-P04637-2-F1'],
    ['AF-P04637-2-F1', 'P04637-2', 'AF-P04637-2-F1'],
  ])('accepts %s and keeps the model keyed to it (#91)', async (id, accession, entryId) => {
    findPrediction.mockResolvedValue(
      found({ uniprotAccession: accession, entryId, meanPlddt: 76.94 }),
    );
    const out = await read(id);
    expect(out).toMatchObject({ uniprotAccession: accession, entryId });
    expect(findPrediction).toHaveBeenCalledWith(id, expect.anything());
  });

  it.each(['P0DOESNOT', 'P04637-0', 'P04637-02', 'P04637-2-F1'])(
    'rejects the malformed %s as invalid_accession without an upstream call (#91)',
    async (id) => {
      // AlphaFold answers a non-accession-shaped identifier with a 400 whose raw
      // body used to reach the client verbatim; the shape check keeps it local.
      const err = await failure(id);
      expect(err).toBeInstanceOf(McpError);
      expect(err).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_accession' },
      });
      expect(err.message).toMatch(/not a UniProt accession/i);
      expect(err.message).not.toMatch(/responseBody|FetchHttpError|Status: 400/i);
      expect(findPrediction).not.toHaveBeenCalled();
    },
  );

  it('tolerates a sparse model — only the accession survives', async () => {
    findPrediction.mockResolvedValue(found({ uniprotAccession: 'Q12345' }));
    const out = await read('Q12345');

    expect(out).toEqual({ uniprotAccession: 'Q12345' });
    expect(out).not.toHaveProperty('confidenceBuckets');
    expect(out).toEqual(expect.schemaMatching(afSummaryResource.output));
  });

  it("bounds the lookup's requests by one 50 s budget (#83)", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    findPrediction.mockImplementation(
      (_id: string, ctx: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          signal = ctx.signal;
          ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
        }),
    );
    const caller = new AbortController();
    const reading = read('Q1HDT5', caller.signal).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(50_000);

    expect(signal).not.toBe(caller.signal);
    expect(caller.signal.aborted).toBe(false);
    expect(await reading).toMatchObject({ name: 'TimeoutError' });
  });

  it('declares every failure it raises, with inactive_accession built in the UniProt service', () => {
    expect(afSummaryResource.errors?.map((e) => e.reason)).toEqual([
      'invalid_accession',
      'no_model',
      'accession_not_found',
      'inactive_accession',
    ]);
    expect(afSummaryResource.errors?.find((e) => e.reason === 'inactive_accession')).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      thrownBy: 'service',
    });
  });
});
