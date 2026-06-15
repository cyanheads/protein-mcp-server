/**
 * @fileoverview Tests for the RCSB alignment service: submit-UUID unwrapping, the
 * heterogeneous result `scores` normalization (against the real API shape), and
 * the complete / computing / failed outcome branches — with the HTTP layer mocked.
 * @module tests/services/alignment/alignment-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/shared/http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/shared/http.js')>();
  return { ...actual, fetchText: vi.fn(), fetchResponse: vi.fn() };
});

import { AlignmentService } from '@/services/alignment/alignment-service.js';
import { fetchResponse, fetchText } from '@/services/shared/http.js';

const fetchTextMock = vi.mocked(fetchText);
const fetchResponseMock = vi.mocked(fetchResponse);

/** The real RCSB alignment result shape captured from a live 4HHB↔2HHB job. */
const READY_PAYLOAD = JSON.stringify({
  info: { status: 'COMPLETE' },
  results: [
    {
      summary: {
        scores: [
          { type: 'sequence-identity', value: 1 },
          { type: 'RMSD', value: 0.42 },
          { type: 'TM-score', value: 0.98 },
        ],
        n_aln_residue_pairs: 141,
      },
    },
  ],
});

const service = () =>
  new AlignmentService(
    {} as never,
    {} as never,
    {
      rcsbAlignmentBaseUrl: 'https://alignment.test',
    } as never,
  );

beforeEach(() => vi.clearAllMocks());

describe('AlignmentService.comparePair', () => {
  it('unwraps the submit UUID and normalizes a completed result', async () => {
    fetchTextMock.mockResolvedValue('"abc-123"\n');
    fetchResponseMock.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => READY_PAYLOAD,
    } as Response);

    const out = await service().comparePair(
      { entryId: '4HHB' },
      { entryId: '2HHB' },
      'tm-align',
      1000,
      createMockContext(),
    );

    expect(out).toEqual({
      status: 'complete',
      uuid: 'abc-123',
      scores: { tmScore: 0.98, rmsd: 0.42, sequenceIdentity: 1, alignedResidues: 141 },
    });
  });

  it('returns computing while the result poll keeps 404-ing within the budget', async () => {
    fetchTextMock.mockResolvedValue('"pending-1"');
    fetchResponseMock.mockResolvedValue({
      status: 404,
      ok: false,
      text: async () => '',
    } as Response);

    const out = await service().comparePair(
      { entryId: '4HHB' },
      { entryId: '2HHB' },
      'tm-align',
      30,
      createMockContext(),
    );

    expect(out).toEqual({ status: 'computing', uuid: 'pending-1' });
  });

  it('degrades to failed (never throws) when submit errors', async () => {
    fetchTextMock.mockRejectedValue(new Error('submit boom'));

    const out = await service().comparePair(
      { entryId: '4HHB' },
      { entryId: '2HHB' },
      'tm-align',
      1000,
      createMockContext(),
    );

    expect(out).toEqual({ status: 'failed', error: 'submit boom' });
  });

  it('matches scores by type-name regardless of array order or casing', async () => {
    fetchTextMock.mockResolvedValue('"u"');
    fetchResponseMock.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () =>
        JSON.stringify({
          results: [
            {
              summary: {
                scores: [
                  { type: 'RMSD', value: 1.23 },
                  { type: 'TM_score', value: 0.77 }, // underscore variant
                  { type: 'sequence_identity', value: 0.4 },
                ],
                n_aligned_residues: 88, // fallback field, not n_aln_residue_pairs
              },
            },
          ],
        }),
    } as Response);

    const out = await service().comparePair(
      { entryId: '4HHB' },
      { entryId: '2HHB' },
      'tm-align',
      1000,
      createMockContext(),
    );

    expect(out).toMatchObject({
      status: 'complete',
      scores: { tmScore: 0.77, rmsd: 1.23, sequenceIdentity: 0.4, alignedResidues: 88 },
    });
  });

  it('emits only the metrics present — a missing score degrades its field, not the row', async () => {
    fetchTextMock.mockResolvedValue('"u"');
    fetchResponseMock.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () =>
        JSON.stringify({ results: [{ summary: { scores: [{ type: 'TM-score', value: 0.9 }] } }] }),
    } as Response);

    const out = await service().comparePair(
      { entryId: '4HHB' },
      { entryId: '2HHB' },
      'tm-align',
      1000,
      createMockContext(),
    );

    expect(out).toEqual({ status: 'complete', uuid: 'u', scores: { tmScore: 0.9 } });
  });

  it('stays computing when the results body carries no result rows yet', async () => {
    fetchTextMock.mockResolvedValue('"u"');
    fetchResponseMock.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ info: { status: 'RUNNING' }, results: [] }),
    } as Response);

    const out = await service().comparePair(
      { entryId: '4HHB' },
      { entryId: '2HHB' },
      'tm-align',
      30,
      createMockContext(),
    );

    expect(out).toEqual({ status: 'computing', uuid: 'u' });
  });

  it('degrades to failed when the results poll returns a non-404 HTTP error', async () => {
    fetchTextMock.mockResolvedValue('"u"');
    fetchResponseMock.mockResolvedValue({
      status: 500,
      ok: false,
      text: async () => '',
    } as Response);

    const out = await service().comparePair(
      { entryId: '4HHB' },
      { entryId: '2HHB' },
      'tm-align',
      1000,
      createMockContext(),
    );

    expect(out).toMatchObject({ status: 'failed', error: expect.stringMatching(/HTTP 500/) });
  });

  it('upper-cases entry IDs and adds an asym selection in the submit query', async () => {
    fetchTextMock.mockResolvedValue('"u"');
    fetchResponseMock.mockResolvedValue({
      status: 404,
      ok: false,
      text: async () => '',
    } as Response);

    await service().comparePair(
      { entryId: '4hhb', asymId: 'A' },
      { entryId: '2hhb' },
      'tm-align',
      30,
      createMockContext(),
    );

    const submitUrl = fetchTextMock.mock.calls[0]?.[0] as string;
    const query = JSON.parse(decodeURIComponent(submitUrl.split('query=')[1] as string));
    expect(query.context.structures[0]).toEqual({ entry_id: '4HHB', selection: { asym_id: 'A' } });
    expect(query.context.structures[1]).toEqual({ entry_id: '2HHB' });
    expect(query.context.method).toEqual({ name: 'tm-align' });
  });
});
