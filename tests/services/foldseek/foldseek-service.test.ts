/**
 * @fileoverview Tests for the Foldseek service: ticket submit → poll → result
 * flow, target-header parsing (AF-/PDB-/other), hit normalization across the real
 * nested results shape (including the percentage-scale `seqId` → 0–1
 * `sequenceIdentity` conversion), the `{ total, hits }` paging contract (limit cap,
 * start slicing, past-end and zero-hit pages, re-paging a completed ticket),
 * query selection on multichain tickets (default query 0, explicit query,
 * `queryCount`, out-of-range rejection), the combined score ordering across
 * databases, the COMPLETE/ERROR/pending status branches, and the never-throws
 * degrade-to-failed contract. HTTP mocked, routed by URL.
 * @module tests/services/foldseek/foldseek-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/shared/http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/shared/http.js')>();
  return { ...actual, fetchJson: vi.fn() };
});

import { FoldseekService } from '@/services/foldseek/foldseek-service.js';
import { fetchJson } from '@/services/shared/http.js';
import {
  QUERIES_1CRN,
  QUERIES_4HHB,
  RESULT_1CRN_Q0,
  RESULT_4HHB_Q0,
  RESULT_4HHB_Q1,
  RESULT_EMPTY_QUERY,
} from '../../fixtures/foldseek-captures.js';

const fetchJsonMock = vi.mocked(fetchJson);

const service = () =>
  new FoldseekService(
    {} as never,
    {} as never,
    {
      foldseekBaseUrl: 'https://foldseek.test',
    } as never,
  );

const params = (over: Partial<Parameters<FoldseekService['search']>[0]> = {}) => ({
  fileContent: 'ATOM ...',
  fileName: '4HHB.pdb',
  databases: ['pdb100', 'afdb50'],
  mode: '3diaa',
  limit: 25,
  start: 0,
  timeoutMs: 1000,
  ...over,
});

/**
 * A small synthetic payload in the real shape: per-DB groups, each an array of
 * alignment arrays. `seqId` is percentage-scale upstream (MMseqs2-App emits 0–100
 * for structure search).
 */
const RESULT = {
  results: [
    {
      db: 'pdb100',
      alignments: [
        [
          { target: '2HHB-A', seqId: 99, alnLength: 141, prob: 1, eval: 1e-30, score: 800 },
          { target: '1A3N_B', seqId: 95, score: 750 },
        ],
      ],
    },
    {
      db: 'afdb50',
      alignments: [[{ target: 'AF-P69905-F1', prob: 0.98, eval: 1e-20 }]],
    },
  ],
};

/**
 * Route every mocked Foldseek call by URL: submit, ticket poll, the query list,
 * and per-query results. A query index with no entry in `results` answers the way
 * Foldseek does for an out-of-range index — HTTP 200 with empty blocks.
 */
function routeFoldseek(opts: {
  queries?: unknown;
  results: Record<number, unknown>;
  status?: string;
  ticketId?: string;
}): void {
  fetchJsonMock.mockImplementation(async (url: string) => {
    if (url === 'https://foldseek.test/api/ticket') return { id: opts.ticketId ?? 't' };
    if (url.includes('/api/ticket/')) return { status: opts.status ?? 'COMPLETE' };
    if (url.includes('/api/result/queries/')) return opts.queries ?? QUERIES_1CRN;
    const perQuery = /\/api\/result\/[^/]+\/(\d+)$/.exec(url);
    if (perQuery) return opts.results[Number(perQuery[1])] ?? RESULT_EMPTY_QUERY;
    throw new Error(`unexpected Foldseek URL ${url}`);
  });
}

/** URLs of every per-query result fetch made so far. */
const resultUrls = () =>
  fetchJsonMock.mock.calls
    .map((call) => call[0])
    .filter((url) => /\/api\/result\/(?!queries\/)[^/]+\/\d+$/.test(url));

beforeEach(() => vi.resetAllMocks());

describe('FoldseekService.search — complete flow', () => {
  it('submits, polls a COMPLETE ticket, and normalizes hits across databases', async () => {
    routeFoldseek({ ticketId: 'ticket-1', results: { 0: RESULT } });

    const out = await service().search(params(), createMockContext());

    expect(out).toMatchObject({ status: 'complete', ticketId: 'ticket-1' });
    if (out.status !== 'complete') throw new Error('expected complete');
    expect(out.hits).toHaveLength(3);

    // PDB target with full scores
    expect(out.hits[0]).toMatchObject({
      target: '2HHB-A',
      database: 'pdb100',
      targetType: 'pdb',
      pdbId: '2HHB',
      chain: 'A',
      sequenceIdentity: 0.99,
      alignmentLength: 141,
      probability: 1,
      evalue: 1e-30,
      score: 800,
    });
    // PDB target with underscore separator, sparse scores (omitted, not zeroed)
    expect(out.hits[1]).toMatchObject({
      pdbId: '1A3N',
      chain: 'B',
      targetType: 'pdb',
      sequenceIdentity: 0.95,
    });
    expect(out.hits[1]).not.toHaveProperty('evalue');
    // AlphaFold target → uniprot accession
    expect(out.hits[2]).toMatchObject({
      target: 'AF-P69905-F1',
      database: 'afdb50',
      targetType: 'alphafold',
      uniprotAccession: 'P69905',
    });
  });

  it('normalizes live-shaped target headers from a captured 4HHB result (characterization)', async () => {
    routeFoldseek({ queries: QUERIES_4HHB, results: { 0: RESULT_4HHB_Q0 } });

    const out = await service().search(params(), createMockContext());
    if (out.status !== 'complete') throw new Error('expected complete');
    // Headers carry a title after the identifier; PDB targets arrive as assembly files.
    const byTarget = new Map(out.hits.map((h) => [h.target.split(' ')[0], h]));
    expect(byTarget.get('AF-A0A1K0GXZ1-F1-model_v6')).toMatchObject({
      targetType: 'alphafold',
      uniprotAccession: 'A0A1K0GXZ1',
      database: 'afdb50',
      sequenceIdentity: 1,
      score: 876,
    });
    expect(byTarget.get('1y45-assembly1.cif.gz_C')).toMatchObject({
      targetType: 'pdb',
      pdbId: '1Y45',
      database: 'pdb100',
      evalue: 4.985e-18,
      score: 920,
    });
    expect(out.total).toBe(4);
    expect(byTarget.get('1bab-assembly1.cif.gz_A')).toMatchObject({ pdbId: '1BAB', chain: 'A' });
    expect(byTarget.get('1y45-assembly1.cif.gz_C')?.chain).toBe('C');
    // With no query requested, the ticket's first query is the one read.
    expect(resultUrls()).toEqual(['https://foldseek.test/api/result/t/0']);
  });

  it('normalizes percentage-scale seqId to a 0–1 sequenceIdentity at the boundaries', async () => {
    routeFoldseek({
      results: {
        0: {
          results: [
            {
              db: 'pdb100',
              alignments: [
                [
                  { target: '1AAA_A', seqId: 100 },
                  { target: '1BBB_A', seqId: 0 },
                  { target: '1CCC_A', seqId: 81.4 },
                ],
              ],
            },
          ],
        },
      },
    });

    const out = await service().search(params(), createMockContext());
    if (out.status !== 'complete') throw new Error('expected complete');
    const identity = (target: string) =>
      out.hits.find((h) => h.target === target)?.sequenceIdentity;
    expect(identity('1AAA_A')).toBe(1);
    expect(identity('1BBB_A')).toBe(0);
    expect(identity('1CCC_A')).toBeCloseTo(0.814, 10);
  });

  it('leaves sequenceIdentity absent when the alignment carries no seqId', async () => {
    routeFoldseek({
      results: {
        0: { results: [{ db: 'pdb100', alignments: [[{ target: '1DDD_A', score: 100 }]] }] },
      },
    });

    const out = await service().search(params(), createMockContext());
    if (out.status !== 'complete') throw new Error('expected complete');
    // Sparse upstream field stays undefined — never 0, never NaN.
    expect(out.hits[0]).not.toHaveProperty('sequenceIdentity');
  });

  it('caps hits at the limit and reports the full total (#53)', async () => {
    routeFoldseek({ results: { 0: RESULT } });

    const out = await service().search(params({ limit: 1 }), createMockContext());
    if (out.status !== 'complete') throw new Error('expected complete');
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0]?.target).toBe('2HHB-A');
    // The whole parsed set is counted before slicing, so a capped page still
    // discloses how many hits the completed job actually holds.
    expect(out.total).toBe(3);
  });

  it('slices a completed result set from start (#53)', async () => {
    routeFoldseek({ results: { 0: RESULT } });

    const out = await service().search(params({ start: 1, limit: 1 }), createMockContext());
    if (out.status !== 'complete') throw new Error('expected complete');
    expect(out.hits.map((h) => h.target)).toEqual(['1A3N_B']);
    expect(out.total).toBe(3);
  });

  it('returns an empty page with the total intact for a start past the end (#53)', async () => {
    routeFoldseek({ results: { 0: RESULT } });

    const out = await service().search(params({ start: 99, limit: 5 }), createMockContext());
    if (out.status !== 'complete') throw new Error('expected complete');
    expect(out.hits).toEqual([]);
    expect(out.total).toBe(3);
  });

  it('reports total 0 for a completed job with no hits (#53)', async () => {
    routeFoldseek({ results: { 0: { results: [] } } });

    const out = await service().search(params(), createMockContext());
    if (out.status !== 'complete') throw new Error('expected complete');
    expect(out).toMatchObject({ hits: [], total: 0 });
  });

  it('classifies a non-AF, non-PDB target header as "other"', async () => {
    routeFoldseek({
      results: { 0: { results: [{ db: 'x', alignments: [[{ target: 'MGYP00123' }]] }] } },
    });

    const out = await service().search(params(), createMockContext());
    if (out.status !== 'complete') throw new Error('expected complete');
    expect(out.hits[0]).toMatchObject({ target: 'MGYP00123', targetType: 'other' });
    expect(out.hits[0]).not.toHaveProperty('pdbId');
    expect(out.hits[0]).not.toHaveProperty('uniprotAccession');
  });

  it('skips alignment rows with no target', async () => {
    routeFoldseek({
      results: {
        0: { results: [{ db: 'pdb100', alignments: [[{ seqId: 0.5 }, { target: '4HHB_A' }]] }] },
      },
    });

    const out = await service().search(params(), createMockContext());
    if (out.status !== 'complete') throw new Error('expected complete');
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0]?.target).toBe('4HHB_A');
  });
});

describe('FoldseekService — query selection on multichain tickets (#63)', () => {
  it('reads query 0 by default and reports the ticket query count', async () => {
    routeFoldseek({ queries: QUERIES_4HHB, results: { 0: RESULT_4HHB_Q0, 1: RESULT_4HHB_Q1 } });

    const out = await service().search(params(), createMockContext());

    expect(out).toMatchObject({ status: 'complete', query: 0, queryCount: 4, total: 4 });
    if (out.status !== 'complete') throw new Error('expected complete');
    expect(out.hits.map((h) => h.target.split(' ')[0])).toContain('1y45-assembly1.cif.gz_C');
    expect(resultUrls()).toEqual(['https://foldseek.test/api/result/t/0']);
  });

  it('reads an explicit query index and returns that query’s own hit set', async () => {
    routeFoldseek({ queries: QUERIES_4HHB, results: { 0: RESULT_4HHB_Q0, 1: RESULT_4HHB_Q1 } });

    const out = await service().search(params({ query: 1 }), createMockContext());

    expect(out).toMatchObject({ status: 'complete', query: 1, queryCount: 4, total: 4 });
    if (out.status !== 'complete') throw new Error('expected complete');
    const targets = out.hits.map((h) => h.target.split(' ')[0]);
    expect(targets).toEqual([
      '1o1k-assembly1.cif.gz_D',
      '2dn2-assembly1.cif.gz_B',
      'AF-A0A8D8CFN8-F1-model_v6',
      'AF-A0A1K0GGI2-F1-model_v6',
    ]);
    // Nothing from query 0 leaks in — ordering never spans queries.
    expect(targets).not.toContain('1y45-assembly1.cif.gz_C');
    expect(resultUrls()).toEqual(['https://foldseek.test/api/result/t/1']);
  });

  it('reports queryCount 1 for a single-chain ticket', async () => {
    routeFoldseek({ queries: QUERIES_1CRN, results: { 0: RESULT_1CRN_Q0 } });
    const out = await service().search(params(), createMockContext());
    expect(out).toMatchObject({ status: 'complete', query: 0, queryCount: 1 });
  });

  it.each([4, 50])(
    'rejects out-of-range query %i instead of answering with empty hits',
    async (query) => {
      routeFoldseek({ queries: QUERIES_4HHB, results: { 0: RESULT_4HHB_Q0 } });

      const out = await service().search(params({ query }), createMockContext());

      expect(out).toEqual({ status: 'query_out_of_range', ticketId: 't', query, queryCount: 4 });
      // Validated against the query list before any result fetch — Foldseek itself
      // answers an out-of-range index with HTTP 200 and no hits.
      expect(resultUrls()).toEqual([]);
    },
  );

  it('accepts the last valid index (queryCount - 1)', async () => {
    routeFoldseek({ queries: QUERIES_4HHB, results: { 3: RESULT_4HHB_Q1 } });
    const out = await service().search(params({ query: 3 }), createMockContext());
    expect(out).toMatchObject({ status: 'complete', query: 3, queryCount: 4, total: 4 });
  });

  it('keeps the selected query across a resume at a different start', async () => {
    routeFoldseek({
      ticketId: 'multi',
      queries: QUERIES_4HHB,
      results: { 0: RESULT_4HHB_Q0, 1: RESULT_4HHB_Q1 },
    });

    const out = await service().resume(
      { ticketId: 'multi', query: 1, start: 2, limit: 2, timeoutMs: 1000 },
      createMockContext(),
    );

    expect(out).toMatchObject({ status: 'complete', query: 1, queryCount: 4, total: 4 });
    if (out.status !== 'complete') throw new Error('expected complete');
    expect(out.hits.map((h) => h.target.split(' ')[0])).toEqual([
      'AF-A0A8D8CFN8-F1-model_v6',
      'AF-A0A1K0GGI2-F1-model_v6',
    ]);
    expect(resultUrls()).toEqual(['https://foldseek.test/api/result/multi/1']);
  });

  it('rejects an out-of-range query on resume too', async () => {
    routeFoldseek({ ticketId: 'multi', queries: QUERIES_4HHB, results: {} });
    const out = await service().resume(
      { ticketId: 'multi', query: 7, start: 0, limit: 5, timeoutMs: 1000 },
      createMockContext(),
    );
    expect(out).toEqual({
      status: 'query_out_of_range',
      ticketId: 'multi',
      query: 7,
      queryCount: 4,
    });
  });
});

describe('FoldseekService — combined score ordering across databases (#64)', () => {
  const CRN_ORDER = [
    '1crn-assembly1.cif.gz_A',
    '1ejg-assembly1.cif.gz_A',
    '3nir-assembly1.cif.gz_A',
    'AF-P01541-F1-model_v6',
    'AF-A0A1J3H3C1-F1-model_v6',
    'AF-A0A7J6GU35-F1-model_v6',
  ];

  it('ranks a later database’s stronger hits above an earlier database’s weaker ones', async () => {
    // The afdb50 block arrives first but tops out at 250; pdb100's self-match is 357.
    routeFoldseek({ results: { 0: RESULT_1CRN_Q0 } });

    const out = await service().search(params({ limit: 2 }), createMockContext());

    if (out.status !== 'complete') throw new Error('expected complete');
    expect(out.hits.map((h) => h.target.split(' ')[0])).toEqual(CRN_ORDER.slice(0, 2));
    expect(out.hits.map((h) => h.score)).toEqual([357, 352]);
    expect(out.total).toBe(6);
  });

  it('orders before slicing, so consecutive pages walk one ranking without repeats', async () => {
    routeFoldseek({ results: { 0: RESULT_1CRN_Q0 } });
    const seen: string[] = [];
    for (const start of [0, 2, 4, 6]) {
      const out = await service().resume(
        { ticketId: 't', query: 0, start, limit: 2, timeoutMs: 1000 },
        createMockContext(),
      );
      if (out.status !== 'complete') throw new Error('expected complete');
      seen.push(...out.hits.map((h) => h.target.split(' ')[0] as string));
    }
    expect(seen).toEqual(CRN_ORDER);
    const scores = [357, 352, 351, 250, 222, 188];
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('sorts hits with no score last and breaks score ties by database, then target', async () => {
    routeFoldseek({
      results: {
        0: {
          results: [
            {
              db: 'pdb100',
              alignments: [
                [
                  { target: '9ZZZ_A' }, // no score
                  { target: '2BBB_A', score: 300 },
                  { target: '1AAA_A', score: 300 },
                ],
              ],
            },
            {
              db: 'afdb50',
              alignments: [
                [
                  { target: 'AF-Q00001-F1', score: 300 },
                  { target: 'AF-Q00002-F1' }, // no score
                  { target: 'AF-Q00003-F1', score: 500 },
                ],
              ],
            },
          ],
        },
      },
    });

    const out = await service().search(params(), createMockContext());

    if (out.status !== 'complete') throw new Error('expected complete');
    expect(out.hits.map((h) => `${h.database}:${h.target}`)).toEqual([
      'afdb50:AF-Q00003-F1',
      'afdb50:AF-Q00001-F1',
      'pdb100:1AAA_A',
      'pdb100:2BBB_A',
      'afdb50:AF-Q00002-F1',
      'pdb100:9ZZZ_A',
    ]);
    expect(out.total).toBe(6);
  });
});

describe('FoldseekService.search — async / failure branches', () => {
  it('returns computing with the ticket when the poll budget elapses before COMPLETE', async () => {
    routeFoldseek({ ticketId: 'pending-7', status: 'PENDING', results: {} });

    const out = await service().search(params({ timeoutMs: 30 }), createMockContext());
    expect(out).toEqual({ status: 'computing', ticketId: 'pending-7' });
  });

  it('degrades to failed when the ticket reports ERROR', async () => {
    routeFoldseek({ status: 'ERROR', results: {} });

    const out = await service().search(params(), createMockContext());
    expect(out).toMatchObject({ status: 'failed' });
    if (out.status !== 'failed') throw new Error('expected failed');
    expect(out.error).toMatch(/error/i);
  });

  it('degrades to failed when submit returns no ticket id', async () => {
    fetchJsonMock.mockResolvedValueOnce({ status: 'PENDING' }); // submit, no id
    const out = await service().search(params(), createMockContext());
    expect(out).toMatchObject({ status: 'failed', error: expect.stringMatching(/ticket id/i) });
  });

  it('degrades to failed (never throws) when submit rejects', async () => {
    fetchJsonMock.mockRejectedValueOnce(new Error('submit boom'));
    const out = await service().search(params(), createMockContext());
    expect(out).toEqual({ status: 'failed', error: 'submit boom' });
  });
});

describe('FoldseekService.resume — poll an existing ticket without resubmitting', () => {
  const resumeParams = { ticketId: 'ticket-1', query: 0, limit: 25, start: 0, timeoutMs: 1000 };

  it('polls the given ticket (no submit) and returns complete hits', async () => {
    routeFoldseek({ ticketId: 'ticket-1', results: { 0: RESULT } });

    const out = await service().resume(resumeParams, createMockContext());

    expect(out).toMatchObject({ status: 'complete', ticketId: 'ticket-1' });
    if (out.status !== 'complete') throw new Error('expected complete');
    expect(out.hits).toHaveLength(3);
    expect(out.total).toBe(3);
    // First upstream call is the ticket-status poll, not a /api/ticket submit.
    expect(fetchJsonMock.mock.calls[0]?.[0]).toContain('/api/ticket/ticket-1');
  });

  it('re-pages the same completed ticket from a different start (#53)', async () => {
    routeFoldseek({ ticketId: 'ticket-1', results: { 0: RESULT } });

    const out = await service().resume(
      { ...resumeParams, start: 2, limit: 1 },
      createMockContext(),
    );

    if (out.status !== 'complete') throw new Error('expected complete');
    expect(out.hits.map((h) => h.target)).toEqual(['AF-P69905-F1']);
    expect(out.total).toBe(3);
    // Still no submit — a completed ticket is re-read, never resubmitted.
    expect(fetchJsonMock.mock.calls[0]?.[0]).toContain('/api/ticket/ticket-1');
    expect(fetchJsonMock.mock.calls.map((call) => call[0])).not.toContain(
      'https://foldseek.test/api/ticket',
    );
  });

  it('returns computing with the same ticket when the budget elapses', async () => {
    fetchJsonMock.mockResolvedValue({ status: 'PENDING' });
    const out = await service().resume({ ...resumeParams, timeoutMs: 30 }, createMockContext());
    expect(out).toEqual({ status: 'computing', ticketId: 'ticket-1' });
  });

  it('returns not_found when the ticket is a 400 "invalid ID" (bogus/expired)', async () => {
    // fetchWithTimeout maps a 400 to McpError(InvalidParams); the resume method
    // keys the not-found branch off that code.
    fetchJsonMock.mockRejectedValue(new McpError(JsonRpcErrorCode.InvalidParams, 'invalid ID'));
    const out = await service().resume(resumeParams, createMockContext());
    expect(out).toEqual({ status: 'not_found', ticketId: 'ticket-1' });
  });

  it('degrades to failed when the resumed ticket reports ERROR', async () => {
    fetchJsonMock.mockResolvedValueOnce({ status: 'ERROR' });
    const out = await service().resume(resumeParams, createMockContext());
    expect(out).toMatchObject({ status: 'failed' });
    if (out.status !== 'failed') throw new Error('expected failed');
    expect(out.error).toMatch(/error/i);
  });

  it('degrades to failed (not not_found) on a non-400 upstream error', async () => {
    fetchJsonMock.mockRejectedValue(new Error('network boom'));
    const out = await service().resume(resumeParams, createMockContext());
    expect(out).toEqual({ status: 'failed', error: 'network boom' });
  });
});
