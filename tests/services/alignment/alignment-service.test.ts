/**
 * @fileoverview Tests for the RCSB alignment service: submit-UUID unwrapping, the
 * heterogeneous result `scores` normalization (against the real API shape), the
 * per-structure modeled-residue / coverage tuples and their arity guard, the
 * echoed job record (submitted pair order and method), and the complete /
 * computing / failed outcome branches — with the HTTP helpers mocked — then, on
 * the real HTTP layer over a fake upstream, how a budget stop, a caller's
 * cancellation, and a failed poll settle a pair. Polls run on fake timers.
 * @module tests/services/alignment/alignment-service.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  type FetchMockHarness,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/shared/http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/shared/http.js')>();
  return { ...actual, fetchText: vi.fn(), fetchResponse: vi.fn() };
});

import { AlignmentService } from '@/services/alignment/alignment-service.js';
import { withCallBudget } from '@/services/shared/call-budget.js';
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('AlignmentService.comparePair', () => {
  it.each(['fatcat-rigid', 'fatcat-flexible'] as const)(
    'relays optional %s scores by source type, preserving zero and sparse values (#72)',
    async (method) => {
      fetchTextMock.mockResolvedValue('"scores-job"');
      for (const scores of [
        [
          { type: 'sequence-similarity', value: 0.27 },
          { type: 'RMSD', value: 3.2 },
          { type: 'similarity-score', value: 52.17 },
        ],
        [{ type: 'similarity-score', value: 0 }],
        [{ type: 'sequence-similarity', value: 0 }],
        [],
      ]) {
        fetchResponseMock.mockResolvedValue(
          new Response(JSON.stringify({ results: [{ summary: { scores } }] })),
        );
        const out = await service().comparePair(
          { entryId: '4HHB' },
          { entryId: '1CRN' },
          method,
          1000,
          createMockContext(),
        );
        expect(out.status).toBe('complete');
        if (out.status !== 'complete') throw new Error('expected complete');
        for (const [raw, key] of [
          ['similarity-score', 'similarityScore'],
          ['sequence-similarity', 'sequenceSimilarity'],
        ] as const) {
          const source = scores.find((s) => s.type === raw);
          if (source) expect(out.scores[key]).toBe(source.value);
          else expect(out.scores).not.toHaveProperty(key);
        }
      }
    },
  );
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
    // READY_PAYLOAD carries no n_modeled_residues / aln_coverage — the parser
    // omits them rather than throwing or fabricating a tuple.
    if (out.status !== 'complete') throw new Error('expected complete');
    expect(out.scores).not.toHaveProperty('modeledResidues');
    expect(out.scores).not.toHaveProperty('coverage');
  });

  it('polls every 1.5 s, backing off to 2.5 s, and returns computing when a 404-ing window ends', async () => {
    fetchTextMock.mockResolvedValue('"pending-1"');
    fetchResponseMock.mockResolvedValue({
      status: 404,
      ok: false,
      text: async () => '',
    } as Response);

    let settled: unknown;
    const run = service()
      .comparePair({ entryId: '4HHB' }, { entryId: '2HHB' }, 'tm-align', 6000, createMockContext())
      .then((out) => {
        settled = out;
      });

    await vi.advanceTimersByTimeAsync(5999);
    expect(settled).toBeUndefined();
    // Polls at 0, 1500, 3750 (×1.5), and 6000 (the 2500 cap clamped to the window).
    expect(fetchResponseMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(settled).toEqual({ status: 'computing', uuid: 'pending-1' });
    expect(fetchResponseMock).toHaveBeenCalledTimes(4);
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

  it('parses per-structure modeled-residue counts and alignment coverage, ordered [a, b]', async () => {
    // Live tm-align shape for 2HHB.A (141 modeled) ↔ 1MBN.A (153 modeled) with 141
    // aligned pairs: coverage is a percentage of each structure's OWN modeled
    // length — 141/141 = 100 and 141/153 ≈ 92 — not of the shorter of the pair.
    fetchTextMock.mockResolvedValue('"u"');
    fetchResponseMock.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () =>
        JSON.stringify({
          results: [
            {
              summary: {
                scores: [{ type: 'TM-score', value: 0.71 }],
                n_aln_residue_pairs: 141,
                n_modeled_residues: [141, 153],
                aln_coverage: [100, 92],
              },
            },
          ],
        }),
    } as Response);

    const out = await service().comparePair(
      { entryId: '2HHB', asymId: 'A' },
      { entryId: '1MBN', asymId: 'A' },
      'tm-align',
      1000,
      createMockContext(),
    );

    expect(out).toMatchObject({
      status: 'complete',
      scores: {
        tmScore: 0.71,
        alignedResidues: 141,
        modeledResidues: [141, 153],
        coverage: [100, 92],
      },
    });
  });

  it('ignores a modeled-residue or coverage field that is not a two-number tuple', async () => {
    fetchTextMock.mockResolvedValue('"u"');
    fetchResponseMock.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () =>
        JSON.stringify({
          results: [
            {
              summary: {
                scores: [{ type: 'TM-score', value: 0.9 }],
                n_modeled_residues: [141], // wrong arity
                aln_coverage: ['100', '92'], // wrong element type
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

    // A malformed summary field degrades itself, never the row.
    expect(out).toEqual({ status: 'complete', uuid: 'u', scores: { tmScore: 0.9 } });
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

    const run = service().comparePair(
      { entryId: '4HHB' },
      { entryId: '2HHB' },
      'tm-align',
      1500,
      createMockContext(),
    );
    await vi.advanceTimersByTimeAsync(1500);

    expect(await run).toEqual({ status: 'computing', uuid: 'u' });
    expect(fetchResponseMock).toHaveBeenCalledTimes(2);
  });

  it('degrades to failed, keeping the submitted job UUID, when the results poll returns a non-404 HTTP error', async () => {
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

    expect(out).toEqual({
      status: 'failed',
      uuid: 'u',
      error: expect.stringMatching(/HTTP 500/),
    });
  });

  it('upper-cases entry IDs and adds an asym selection in the submit query', async () => {
    fetchTextMock.mockResolvedValue('"u"');
    fetchResponseMock.mockResolvedValue({
      status: 404,
      ok: false,
      text: async () => '',
    } as Response);

    const run = service().comparePair(
      { entryId: '4hhb', asymId: 'A' },
      { entryId: '2hhb' },
      'tm-align',
      1500,
      createMockContext(),
    );
    await vi.advanceTimersByTimeAsync(1500);
    await run;

    const submitUrl = fetchTextMock.mock.calls[0]?.[0] as string;
    const query = JSON.parse(decodeURIComponent(submitUrl.split('query=')[1] as string));
    expect(query.context.structures[0]).toEqual({ entry_id: '4HHB', selection: { asym_id: 'A' } });
    expect(query.context.structures[1]).toEqual({ entry_id: '2HHB' });
    expect(query.context.method).toEqual({ name: 'tm-align' });
  });
});

describe('AlignmentService.resumePair — poll an existing UUID without resubmitting', () => {
  it('polls the given UUID (no submit) and returns a completed result', async () => {
    fetchResponseMock.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => READY_PAYLOAD,
    } as Response);

    const out = await service().resumePair('abc-123', 1000, createMockContext());

    expect(out).toEqual({
      status: 'complete',
      uuid: 'abc-123',
      scores: { tmScore: 0.98, rmsd: 0.42, sequenceIdentity: 1, alignedResidues: 141 },
    });
    // No submit — the resume path never calls fetchText (the submit helper).
    expect(fetchTextMock).not.toHaveBeenCalled();
    // The poll URL carries the resumed UUID.
    expect(fetchResponseMock.mock.calls[0]?.[0]).toContain('uuid=abc-123');
  });

  it('stays computing on a 404 — an expired UUID is indistinguishable from a running job, so it is never falsely failed', async () => {
    fetchResponseMock.mockResolvedValue({
      status: 404,
      ok: false,
      text: async () =>
        '{"status":404,"message":"No such UUID: 00000000-0000-4000-8000-000000000000"}',
    } as Response);

    const run = service().resumePair(
      '00000000-0000-4000-8000-000000000000',
      1500,
      createMockContext(),
    );
    await vi.advanceTimersByTimeAsync(1500);

    // The RCSB API returns the same 404 for "still computing" and "unknown UUID";
    // resume must report computing, never a false not-found/failed.
    expect(await run).toEqual({
      status: 'computing',
      uuid: '00000000-0000-4000-8000-000000000000',
    });
  });

  it('degrades to failed, keeping the UUID to resume, when the results poll returns a non-404 HTTP error', async () => {
    fetchResponseMock.mockResolvedValue({
      status: 500,
      ok: false,
      text: async () => '',
    } as Response);

    const out = await service().resumePair('u', 1000, createMockContext());
    expect(out).toEqual({ status: 'failed', uuid: 'u', error: expect.stringMatching(/HTTP 500/) });
  });
});

/**
 * The live RCSB shape for a completed 4HHB.A → 1CRN.A tm-align job: the poll
 * echoes the submitted pair in `results[0].structures[]` (a chainless structure
 * carries no `selection`) and the method in `meta.alignment_method`. Every
 * per-structure tuple is ordered as submitted — 141 vs 46 modeled residues.
 */
const ECHO_PAYLOAD = JSON.stringify({
  info: { uuid: 'job-1', status: 'COMPLETE' },
  meta: { alignment_mode: 'pairwise', alignment_method: 'tm-align' },
  results: [
    {
      structures: [{ entry_id: '4HHB', selection: { asym_id: 'A' } }, { entry_id: '1CRN' }],
      summary: {
        scores: [
          { value: 0.03, type: 'sequence-identity' },
          { value: 0.17, type: 'TM-score' },
          { value: 3.18, type: 'RMSD' },
        ],
        n_aln_residue_pairs: 27,
        n_modeled_residues: [141, 46],
        seq_aln_len: 156,
        aln_coverage: [19, 59],
      },
    },
  ],
});

describe('AlignmentService — the job record echoed by the results poll', () => {
  it.each([
    ['resumePair', () => service().resumePair('job-1', 1000, createMockContext())],
    [
      'comparePair',
      () =>
        service().comparePair(
          { entryId: '4HHB', asymId: 'A' },
          { entryId: '1CRN' },
          'tm-align',
          1000,
          createMockContext(),
        ),
    ],
  ] as const)('%s surfaces the submitted pair order and method', async (_name, run) => {
    fetchTextMock.mockResolvedValue('"job-1"');
    fetchResponseMock.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => ECHO_PAYLOAD,
    } as Response);

    const out = await run();

    expect(out).toEqual({
      status: 'complete',
      uuid: 'job-1',
      scores: {
        tmScore: 0.17,
        rmsd: 3.18,
        sequenceIdentity: 0.03,
        alignedResidues: 27,
        modeledResidues: [141, 46],
        coverage: [19, 59],
      },
      job: {
        method: 'tm-align',
        structures: [{ entryId: '4HHB', asymId: 'A' }, { entryId: '1CRN' }],
      },
    });
  });

  it('omits the job record when the payload carries neither echo (older API shape)', async () => {
    fetchResponseMock.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => READY_PAYLOAD,
    } as Response);

    const out = await service().resumePair('abc-123', 1000, createMockContext());

    expect(out).not.toHaveProperty('job');
  });

  it('drops a malformed echo field without degrading the other or the scores', async () => {
    fetchResponseMock.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () =>
        JSON.stringify({
          meta: { alignment_method: 'fatcat-rigid' },
          results: [
            {
              structures: [{ entry_id: '4HHB' }], // one structure, not a pair
              summary: { scores: [{ type: 'TM-score', value: 0.9 }] },
            },
          ],
        }),
    } as Response);

    const out = await service().resumePair('u', 1000, createMockContext());

    expect(out).toEqual({
      status: 'complete',
      uuid: 'u',
      scores: { tmScore: 0.9 },
      job: { method: 'fatcat-rigid' },
    });
  });

  it('ignores a structure entry with no string entry_id', async () => {
    fetchResponseMock.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () =>
        JSON.stringify({
          results: [
            {
              structures: [{ entry_id: '4HHB' }, { selection: { asym_id: 'A' } }],
              summary: { scores: [{ type: 'TM-score', value: 0.9 }] },
            },
          ],
        }),
    } as Response);

    const out = await service().resumePair('u', 1000, createMockContext());

    expect(out).not.toHaveProperty('job');
  });
});

describe('AlignmentService on the real HTTP layer — budget stops, cancellation, failed polls (#101)', () => {
  const ORIGIN = 'https://alignment.test';
  type Responder = (req: Request) => Promise<Response> | Response;
  /** The upstream requests that actually went out, in order. */
  const sent: string[] = [];
  let http: FetchMockHarness | undefined;

  const at = (path: string) => (req: Request) => {
    const url = new URL(req.url);
    return url.origin === ORIGIN && url.pathname === path;
  };
  /** A real fetch sends nothing once its signal has aborted; everything else is logged and answered. */
  const upstream =
    (name: string, respond: Responder): Responder =>
    (req) => {
      if (req.signal.aborted) return Promise.reject(req.signal.reason);
      sent.push(name);
      return respond(req);
    };
  /** An upstream that never answers: settles only when the request's signal aborts. */
  const hang = (req: Request) =>
    new Promise<Response>((_, reject) =>
      req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true }),
    );
  const serve = (submit: Responder, results: Responder) => {
    http = createFetchMock([
      {
        method: 'POST',
        match: at('/api/v1/structures/submit'),
        respond: upstream('submit', submit),
      },
      {
        method: 'GET',
        match: at('/api/v1/structures/results'),
        respond: upstream('poll', results),
      },
    ]);
    http.install();
  };
  const accepted = () => new Response('"job-1"');
  const notReady = () => new Response('', { status: 404 });
  const networkDown = () => Promise.reject(new TypeError('fetch failed'));
  const budgetReason = () =>
    new DOMException('Upstream requests for this call ran past the 50 s budget.', 'TimeoutError');
  const pair = (ctx: Context, timeoutMs = 120_000) =>
    service().comparePair({ entryId: '4HHB' }, { entryId: '2HHB' }, 'tm-align', timeoutMs, ctx);

  beforeEach(async () => {
    sent.length = 0;
    const actual = await vi.importActual<typeof import('@/services/shared/http.js')>(
      '@/services/shared/http.js',
    );
    fetchTextMock.mockImplementation(actual.fetchText);
    fetchResponseMock.mockImplementation(actual.fetchResponse);
  });
  afterEach(() => {
    http?.restore();
    http = undefined;
    fetchTextMock.mockReset();
    fetchResponseMock.mockReset();
  });

  it('retries a submit the upstream refused with 503 or 429, then polls the job it accepts', async () => {
    const refusals = [new Response('', { status: 503 }), new Response('', { status: 429 })];
    serve(
      () => refusals.shift() ?? accepted(),
      () => new Response(READY_PAYLOAD),
    );
    const run = pair(createMockContext(), 1000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await run).toMatchObject({ status: 'complete', uuid: 'job-1' });
    expect(sent).toEqual(['submit', 'submit', 'submit', 'poll']);
  });

  it('retries a submit whose connection failed, then polls the job it accepts', async () => {
    let failures = 1;
    serve(
      () => (failures-- > 0 ? networkDown() : accepted()),
      () => new Response(READY_PAYLOAD),
    );
    const run = pair(createMockContext(), 1000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await run).toMatchObject({ status: 'complete', uuid: 'job-1' });
    expect(sent).toEqual(['submit', 'submit', 'poll']);
  });

  it('never re-sends a submit whose attempt timed out, since the job may already exist', async () => {
    serve(hang, notReady);
    let settled: unknown;
    const run = pair(createMockContext()).then((out) => {
      settled = out;
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(settled).toEqual({ status: 'failed', error: expect.stringContaining('timed out') });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toEqual(['submit']);
  });

  it.each([500, 502, 504])(
    'never re-sends a submit the upstream answered with %i',
    async (status) => {
      serve(() => new Response('', { status }), notReady);
      const run = pair(createMockContext());
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await run).toMatchObject({ status: 'failed' });
      expect(sent).toEqual(['submit']);
    },
  );

  it('returns computing with the job UUID when the 50 s budget stops a poll request in flight', async () => {
    // Polls answer 404 until 40 s; the one sent at 41.25 s hangs, and the budget
    // cuts it before its own 15 s attempt timeout would.
    const start = Date.now();
    serve(accepted, (req) => (Date.now() - start < 40_000 ? notReady() : hang(req)));
    let settled: unknown;
    const run = withCallBudget(createMockContext(), (call) => pair(call)).then((out) => {
      settled = out;
    });
    await vi.advanceTimersByTimeAsync(49_999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(settled).toEqual({ status: 'computing', uuid: 'job-1' });
    expect(sent.at(-1)).toBe('poll');
  });

  it('fails with the job UUID when every attempt of a poll hangs, at its third 15 s timeout, inside the budget', async () => {
    serve(accepted, hang);
    let settled: unknown;
    const run = withCallBudget(createMockContext(), (call) => pair(call)).then((out) => {
      settled = out;
    });
    // Three 15 s attempts plus two backoffs (300–500 ms, then 600–1000 ms).
    await vi.advanceTimersByTimeAsync(45_899);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(47_000 - 45_899);
    await run;
    expect(settled).toEqual({
      status: 'failed',
      uuid: 'job-1',
      error: expect.stringContaining('failed after 3 attempts'),
    });
    expect(sent).toEqual(['submit', 'poll', 'poll', 'poll']);
  });

  it('returns computing with the job UUID when the 50 s budget lands in the sleep between polls', async () => {
    // Polls answer at once, so the clock sits in a sleep (48.75 s → 51.25 s) when the budget fires.
    serve(accepted, notReady);
    const run = withCallBudget(createMockContext(), (call) => pair(call));
    await vi.advanceTimersByTimeAsync(50_000);
    expect(await run).toEqual({ status: 'computing', uuid: 'job-1' });
  });

  it('returns computing with the job UUID when the budget lands in a poll retry backoff', async () => {
    const budget = new AbortController();
    serve(accepted, () => {
      // The first poll attempt fails; its retry backoff is at least 300 ms.
      setTimeout(() => budget.abort(budgetReason()), 100);
      return networkDown();
    });
    const run = pair(createMockContext({ signal: budget.signal }));
    await vi.advanceTimersByTimeAsync(100);
    expect(await run).toEqual({ status: 'computing', uuid: 'job-1' });
    expect(sent).toEqual(['submit', 'poll']);
  });

  it('keeps the job UUID on a failed row when the poll fails for another reason', async () => {
    serve(accepted, networkDown);
    const run = pair(createMockContext());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await run).toEqual({
      status: 'failed',
      uuid: 'job-1',
      error: expect.stringContaining('fetch failed'),
    });
    expect(sent).toEqual(['submit', 'poll', 'poll', 'poll']);
  });

  it('fails a pair the budget stops before a UUID came back, saying to submit it without a resume entry', async () => {
    const budget = new AbortController();
    serve((req) => {
      queueMicrotask(() => budget.abort(budgetReason()));
      return hang(req);
    }, notReady);
    const out = await pair(createMockContext({ signal: budget.signal }));
    expect(out).toEqual({ status: 'failed', error: expect.any(String) });
    if (out.status !== 'failed') throw new Error('expected failed');
    expect(out.error).toContain('50 s budget');
    expect(out.error).toContain('no job UUID');
    expect(out.error).toContain('without a resume entry');
    expect(sent).toEqual(['submit']);
  });

  it("rejects with the caller's cancellation from a poll in flight, never a row", async () => {
    const caller = new AbortController();
    serve(accepted, (req) => {
      queueMicrotask(() => caller.abort('client went away'));
      return hang(req);
    });
    await expect(pair(createMockContext({ signal: caller.signal }))).rejects.toBe(
      'client went away',
    );
    expect(sent).toEqual(['submit', 'poll']);
  });

  it("rejects with the caller's cancellation from a submit in flight and polls nothing", async () => {
    const caller = new AbortController();
    serve((req) => {
      queueMicrotask(() => caller.abort('client went away'));
      return hang(req);
    }, notReady);
    await expect(pair(createMockContext({ signal: caller.signal }))).rejects.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
    });
    expect(sent).toEqual(['submit']);
  });

  it("rejects with the caller's cancellation on a resume, never a row", async () => {
    const caller = new AbortController();
    serve(accepted, (req) => {
      queueMicrotask(() => caller.abort('client went away'));
      return hang(req);
    });
    await expect(
      service().resumePair('job-1', 120_000, createMockContext({ signal: caller.signal })),
    ).rejects.toBe('client went away');
    expect(sent).toEqual(['poll']);
  });
});
