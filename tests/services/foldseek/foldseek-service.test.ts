/**
 * @fileoverview Tests for the Foldseek service: ticket submit → poll → result
 * flow, target-header parsing (AF-/PDB-/other), hit normalization across the real
 * nested results shape, the limit cap mid-database, the COMPLETE/ERROR/pending
 * status branches, and the never-throws degrade-to-failed contract. HTTP mocked.
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
  timeoutMs: 1000,
  ...over,
});

/** A real Foldseek result payload: per-DB groups, each an array of alignment arrays. */
const RESULT = {
  results: [
    {
      db: 'pdb100',
      alignments: [
        [
          { target: '2HHB-A', seqId: 0.99, alnLength: 141, prob: 1, eval: 1e-30, score: 800 },
          { target: '1A3N_B', seqId: 0.95, score: 750 },
        ],
      ],
    },
    {
      db: 'afdb50',
      alignments: [[{ target: 'AF-P69905-F1', prob: 0.98, eval: 1e-20 }]],
    },
  ],
};

beforeEach(() => vi.clearAllMocks());

describe('FoldseekService.search — complete flow', () => {
  it('submits, polls a COMPLETE ticket, and normalizes hits across databases', async () => {
    fetchJsonMock
      .mockResolvedValueOnce({ id: 'ticket-1' }) // submit
      .mockResolvedValueOnce({ status: 'COMPLETE' }) // poll
      .mockResolvedValueOnce(RESULT); // results

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
    expect(out.hits[1]).toMatchObject({ pdbId: '1A3N', chain: 'B', targetType: 'pdb' });
    expect(out.hits[1]).not.toHaveProperty('evalue');
    // AlphaFold target → uniprot accession
    expect(out.hits[2]).toMatchObject({
      target: 'AF-P69905-F1',
      database: 'afdb50',
      targetType: 'alphafold',
      uniprotAccession: 'P69905',
    });
  });

  it('caps hits at the limit, even mid-database', async () => {
    fetchJsonMock
      .mockResolvedValueOnce({ id: 't' })
      .mockResolvedValueOnce({ status: 'COMPLETE' })
      .mockResolvedValueOnce(RESULT);

    const out = await service().search(params({ limit: 1 }), createMockContext());
    if (out.status !== 'complete') throw new Error('expected complete');
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0]?.target).toBe('2HHB-A');
  });

  it('classifies a non-AF, non-PDB target header as "other"', async () => {
    fetchJsonMock
      .mockResolvedValueOnce({ id: 't' })
      .mockResolvedValueOnce({ status: 'COMPLETE' })
      .mockResolvedValueOnce({ results: [{ db: 'x', alignments: [[{ target: 'MGYP00123' }]] }] });

    const out = await service().search(params(), createMockContext());
    if (out.status !== 'complete') throw new Error('expected complete');
    expect(out.hits[0]).toMatchObject({ target: 'MGYP00123', targetType: 'other' });
    expect(out.hits[0]).not.toHaveProperty('pdbId');
    expect(out.hits[0]).not.toHaveProperty('uniprotAccession');
  });

  it('skips alignment rows with no target', async () => {
    fetchJsonMock
      .mockResolvedValueOnce({ id: 't' })
      .mockResolvedValueOnce({ status: 'COMPLETE' })
      .mockResolvedValueOnce({
        results: [{ db: 'pdb100', alignments: [[{ seqId: 0.5 }, { target: '4HHB_A' }]] }],
      });

    const out = await service().search(params(), createMockContext());
    if (out.status !== 'complete') throw new Error('expected complete');
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0]?.target).toBe('4HHB_A');
  });
});

describe('FoldseekService.search — async / failure branches', () => {
  it('returns computing with the ticket when the poll budget elapses before COMPLETE', async () => {
    fetchJsonMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/ticket') && !url.includes('/api/ticket/')) return { id: 'pending-7' };
      return { status: 'PENDING' }; // never completes
    });

    const out = await service().search(params({ timeoutMs: 30 }), createMockContext());
    expect(out).toEqual({ status: 'computing', ticketId: 'pending-7' });
  });

  it('degrades to failed when the ticket reports ERROR', async () => {
    fetchJsonMock.mockResolvedValueOnce({ id: 't' }).mockResolvedValueOnce({ status: 'ERROR' });

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
  const resumeParams = { ticketId: 'ticket-1', limit: 25, timeoutMs: 1000 };

  it('polls the given ticket (no submit) and returns complete hits', async () => {
    // Only the ticket-status poll + results fetch — never a submit POST.
    fetchJsonMock.mockResolvedValueOnce({ status: 'COMPLETE' }).mockResolvedValueOnce(RESULT);

    const out = await service().resume(resumeParams, createMockContext());

    expect(out).toMatchObject({ status: 'complete', ticketId: 'ticket-1' });
    if (out.status !== 'complete') throw new Error('expected complete');
    expect(out.hits).toHaveLength(3);
    // First upstream call is the ticket-status poll, not a /api/ticket submit.
    expect(fetchJsonMock.mock.calls[0]?.[0]).toContain('/api/ticket/ticket-1');
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
