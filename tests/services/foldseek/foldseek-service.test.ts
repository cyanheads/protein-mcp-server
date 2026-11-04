/**
 * @fileoverview Tests for the Foldseek service: ticket submit → poll → result
 * flow, per-database target classification (source, id, chain, accession) over
 * one real hit per registered database, hit normalization across the real
 * nested results shape (title, taxonomy, aligned span, query length, and the
 * percentage-scale `seqId` → 0–1 `sequenceIdentity` conversion), the
 * `{ total, hits }` paging contract (limit cap, start slicing, past-end and
 * zero-hit pages, re-paging a completed ticket), query selection on multichain
 * tickets (default query 0, explicit query, `queryCount`, out-of-range
 * rejection), the combined score ordering across databases, the
 * COMPLETE/ERROR/pending status branches, a submit refused with HTTP 400, and
 * the never-throws degrade-to-failed contract (carrying the ticket once
 * Foldseek accepted the job). HTTP mocked, routed by URL; the
 * refused-submit case runs the real HTTP helper over a fetch fake.
 * @module tests/services/foldseek/foldseek-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/shared/http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/shared/http.js')>();
  return { ...actual, fetchJson: vi.fn() };
});

import { FoldseekService } from '@/services/foldseek/foldseek-service.js';
import { fetchJson } from '@/services/shared/http.js';
import { isPdbId, isUniProtAccession } from '@/services/shared/identifiers.js';
import {
  QUERIES_1CRN,
  QUERIES_4HHB,
  RESULT_1CRN_PER_DB,
  RESULT_1CRN_Q0,
  RESULT_4HHB_Q0,
  RESULT_4HHB_Q0_CHAINS,
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

type SearchParams = Parameters<FoldseekService['search']>[0];

const params = (over: Partial<SearchParams> = {}): SearchParams => ({
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
          {
            target: '2hhb-assembly1.cif.gz_A',
            seqId: 99,
            alnLength: 141,
            prob: 1,
            eval: 1e-30,
            score: 800,
          },
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

    // PDB assembly-file target with full scores
    expect(out.hits[0]).toMatchObject({
      target: '2hhb-assembly1.cif.gz_A',
      database: 'pdb100',
      source: 'experimental',
      id: '2HHB',
      chain: 'A',
      sequenceIdentity: 0.99,
      alignmentLength: 141,
      probability: 1,
      evalue: 1e-30,
      score: 800,
    });
    // Bare PDB target, sparse scores (omitted, not zeroed)
    expect(out.hits[1]).toMatchObject({
      id: '1A3N',
      chain: 'B',
      source: 'experimental',
      sequenceIdentity: 0.95,
    });
    expect(out.hits[1]).not.toHaveProperty('evalue');
    // AlphaFold target → uniprot accession, which is also the chainable id
    expect(out.hits[2]).toMatchObject({
      target: 'AF-P69905-F1',
      database: 'afdb50',
      source: 'predicted',
      id: 'P69905',
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
      source: 'predicted',
      id: 'A0A1K0GXZ1',
      uniprotAccession: 'A0A1K0GXZ1',
      database: 'afdb50',
      sequenceIdentity: 1,
      score: 876,
    });
    expect(byTarget.get('1y45-assembly1.cif.gz_C')).toMatchObject({
      source: 'experimental',
      id: '1Y45',
      database: 'pdb100',
      evalue: 4.985e-18,
      score: 920,
    });
    expect(out.total).toBe(4);
    expect(byTarget.get('1bab-assembly1.cif.gz_A')).toMatchObject({ id: '1BAB', chain: 'A' });
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
    expect(out.hits[0]?.target).toBe('2hhb-assembly1.cif.gz_A');
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

  it('labels a non-AF, non-PDB target from an unregistered database predicted, with no id (#87)', async () => {
    routeFoldseek({
      results: { 0: { results: [{ db: 'x', alignments: [[{ target: 'MGYP00123' }]] }] } },
    });

    const out = await service().search(params(), createMockContext());
    if (out.status !== 'complete') throw new Error('expected complete');
    expect(out.hits[0]).toMatchObject({ target: 'MGYP00123', source: 'predicted' });
    expect(out.hits[0]).not.toHaveProperty('id');
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

describe('FoldseekService — per-database target classification (#87)', () => {
  /** A completed 1CRN search over the nine databases, every hit on one page. */
  const searchAllDatabases = async () => {
    routeFoldseek({ results: { 0: RESULT_1CRN_PER_DB } });
    const out = await service().search(params({ limit: 100 }), createMockContext());
    if (out.status !== 'complete') throw new Error('expected complete');
    return out;
  };
  /** The identity fields a target name resolves to, absent keys left absent. */
  const identityOf = (hit: object) =>
    Object.fromEntries(
      Object.entries(hit).filter(([key]) =>
        ['source', 'id', 'uniprotAccession', 'chain', 'title'].includes(key),
      ),
    );

  it.each([
    [
      'afdb-proteome',
      'AF-Q9C8D6-F1-model_v6',
      {
        source: 'predicted',
        id: 'Q9C8D6',
        uniprotAccession: 'Q9C8D6',
        title: 'Probable thionin-2.4',
      },
    ],
    [
      'afdb-swissprot',
      'AF-P01542-F1-model_v6',
      { source: 'predicted', id: 'P01542', uniprotAccession: 'P01542', title: 'Crambin' },
    ],
    [
      'afdb50',
      'AF-P01541-F1-model_v6',
      { source: 'predicted', id: 'P01541', uniprotAccession: 'P01541', title: 'Denclatoxin-B' },
    ],
    ['bfmd', 'LevyLab_Q8U2A3_V1_4_relaxed_B', { source: 'predicted' }],
    [
      'bfvd_v3',
      'U5P0K0',
      { source: 'predicted', uniprotAccession: 'U5P0K0', title: 'Uncharacterized protein' },
    ],
    ['cath50', '1cbnA00', { source: 'experimental', id: '1CBN', chain: 'A' }],
    [
      'cath50',
      'af_Q8VZK8_26_71_3.30.1350.10',
      { source: 'predicted', id: 'Q8VZK8', uniprotAccession: 'Q8VZK8' },
    ],
    ['gmgcl_id', 'GMGC10.211_012_347.UNKNOWN_trun_1.pdb', { source: 'predicted' }],
    ['mgnify_esm30', 'MGYP001043648370.pdb.gz', { source: 'predicted' }],
    [
      'pdb100',
      '1crn-assembly1.cif.gz_A',
      {
        source: 'experimental',
        id: '1CRN',
        chain: 'A',
        title:
          'WATER STRUCTURE OF A HYDROPHOBIC PROTEIN AT ATOMIC RESOLUTION. PENTAGON RINGS OF WATER MOLECULES IN CRYSTALS OF CRAMBIN',
      },
    ],
  ])('classifies a %s hit (%s) from its target name', async (database, target, expected) => {
    const out = await searchAllDatabases();
    const hit = out.hits.find((h) => h.target === target);
    expect(hit?.database).toBe(database);
    expect(identityOf(hit ?? {})).toEqual(expected);
  });

  it('emits only ids protein_get_structure resolves, and a target on every hit', async () => {
    const out = await searchAllDatabases();
    expect(out.hits).toHaveLength(11);
    const ids = out.hits.flatMap((h) => (h.id ? [h.id] : []));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(isPdbId(id) || isUniProtAccession(id)).toBe(true);
      expect(id).not.toMatch(/\s|\.(pdb|cif|gz)/);
    }
    for (const hit of out.hits) expect(hit.target).toMatch(/^\S+$/);
  });

  it('reads a CATH domain whose chain character is 0 as an entry with no chain', async () => {
    routeFoldseek({
      results: {
        0: {
          results: [
            {
              db: 'cath50',
              alignments: [
                [
                  { target: '2hsf000', score: 90 },
                  { target: '1abca01', score: 80 },
                ],
              ],
            },
          ],
        },
      },
    });

    const out = await service().search(params(), createMockContext());

    if (out.status !== 'complete') throw new Error('expected complete');
    expect(identityOf(out.hits[0] ?? {})).toEqual({ source: 'experimental', id: '2HSF' });
    // A lowercase chain character is a real chain ID, kept as written.
    expect(identityOf(out.hits[1] ?? {})).toEqual({
      source: 'experimental',
      id: '1ABC',
      chain: 'a',
    });
  });

  it('classifies hits from a database outside the registry by target grammar alone', async () => {
    // Reachable only by resuming a ticket submitted elsewhere with another database.
    routeFoldseek({
      results: {
        0: {
          results: [
            {
              db: 'pdb_interface',
              alignments: [
                [
                  { target: '3zpl-assembly2_E_F_F', score: 30 },
                  { target: 'AF-P69905-F1-model_v6', score: 20 },
                  { target: 'Predictome_123_A_B', score: 10 },
                ],
              ],
            },
          ],
        },
      },
    });

    const out = await service().search(params(), createMockContext());

    if (out.status !== 'complete') throw new Error('expected complete');
    expect(out.hits.map(identityOf)).toEqual([
      { source: 'experimental', id: '3ZPL' },
      { source: 'predicted', id: 'P69905', uniprotAccession: 'P69905' },
      { source: 'predicted' },
    ]);
  });
});

describe('FoldseekService — per-hit chain, title, taxonomy, and aligned span (#88)', () => {
  it('keeps the whole pdb100 chain label, so every row of one entry stays distinct', async () => {
    routeFoldseek({ queries: QUERIES_4HHB, results: { 0: RESULT_4HHB_Q0_CHAINS } });

    const out = await service().search(params(), createMockContext());

    if (out.status !== 'complete') throw new Error('expected complete');
    expect(out.hits.map((h) => [h.target, h.id, h.chain])).toEqual([
      ['6kai-assembly2.cif.gz_E', '6KAI', 'E'],
      ['6kai-assembly1.cif.gz_A', '6KAI', 'A'],
      ['6kai-assembly2.cif.gz_G', '6KAI', 'G'],
      ['1ibe-assembly1.cif.gz_A-2', '1IBE', 'A-2'],
      ['7vlf-assembly1.cif.gz_G-2', '7VLF', 'G-2'],
      ['7vlf-assembly1.cif.gz_G-3', '7VLF', 'G-3'],
      ['7vea-assembly1.cif.gz_dM', '7VEA', 'dM'],
    ]);
    const rows = out.hits.map((h) => `${h.id}:${h.chain}`);
    expect(new Set(rows).size).toBe(rows.length);
    expect(out.hits[0]?.title).toBe(
      'Crosslinked alpha(Ni)-beta(Fe) human hemoglobin A in the T quaternary structure at 95 K: Light',
    );
  });

  it('carries probability and the aligned span from each alignment, and qLen once per query', async () => {
    routeFoldseek({ results: { 0: RESULT_1CRN_PER_DB } });

    const out = await service().search(params({ limit: 100 }), createMockContext());

    if (out.status !== 'complete') throw new Error('expected complete');
    const raw = RESULT_1CRN_PER_DB.results.flatMap((block) => block.alignments.flat());
    expect(out.hits).toHaveLength(raw.length);
    for (const aln of raw) {
      const hit = out.hits.find((h) => h.target === aln.target.split(' ')[0]);
      expect(hit).toMatchObject({
        probability: aln.prob,
        alignmentLength: aln.alnLength,
        queryStart: aln.qStartPos,
        queryEnd: aln.qEndPos,
        targetStart: aln.dbStartPos,
        targetEnd: aln.dbEndPos,
        targetLength: aln.dbLen,
      });
    }
    expect(out.queryLength).toBe(46);
  });

  it('keeps queryLength on a page past the end of the hits', async () => {
    routeFoldseek({ results: { 0: RESULT_1CRN_PER_DB } });
    const out = await service().search(params({ start: 99, limit: 5 }), createMockContext());
    expect(out).toMatchObject({ status: 'complete', hits: [], total: 11, queryLength: 46 });
  });

  it('omits the span fields and queryLength when upstream sends none', async () => {
    routeFoldseek({ queries: QUERIES_4HHB, results: { 1: RESULT_4HHB_Q1 } });

    const out = await service().search(params({ query: 1 }), createMockContext());

    if (out.status !== 'complete') throw new Error('expected complete');
    expect(out.hits).toHaveLength(4);
    for (const hit of out.hits) {
      for (const key of ['queryStart', 'queryEnd', 'targetStart', 'targetEnd', 'targetLength']) {
        expect(hit).not.toHaveProperty(key);
      }
    }
    expect(out).not.toHaveProperty('queryLength');
  });

  it('reads taxonomy where upstream has it, and drops the unclassified placeholder', async () => {
    routeFoldseek({ results: { 0: RESULT_1CRN_PER_DB } });

    const out = await service().search(params({ limit: 100 }), createMockContext());

    if (out.status !== 'complete') throw new Error('expected complete');
    const byTarget = new Map(out.hits.map((h) => [h.target, h]));
    expect(byTarget.get('1crn-assembly1.cif.gz_A')).toMatchObject({
      taxId: 3721,
      taxName: 'Crambe hispanica subsp. abyssinica',
    });
    expect(byTarget.get('U5P0K0')).toMatchObject({
      taxId: 1354510,
      taxName: 'Mycobacterium phage Fredward',
    });
    for (const target of [
      '2fd7-assembly1.cif.gz_A', // taxId 0, taxName "unclassified"
      'MGYP001043648370.pdb.gz', // database without taxonomy
      'GMGC10.211_012_347.UNKNOWN_trun_1.pdb',
    ]) {
      expect(byTarget.get(target)).not.toHaveProperty('taxId');
      expect(byTarget.get(target)).not.toHaveProperty('taxName');
    }
  });

  it('has no title on targets whose header carries none', async () => {
    routeFoldseek({ results: { 0: RESULT_1CRN_PER_DB } });

    const out = await service().search(params({ limit: 100 }), createMockContext());

    if (out.status !== 'complete') throw new Error('expected complete');
    const untitled = out.hits.filter((h) => !h.title).map((h) => h.database);
    expect(untitled.sort()).toEqual(['bfmd', 'cath50', 'cath50', 'gmgcl_id', 'mgnify_esm30']);
  });

  it.each([
    [42.2, 0.422],
    [37.7, 0.377],
    [99.2, 0.992],
    [81.4, 0.814],
  ])('rounds seqId %s to identity %s, with no float noise', async (seqId, identity) => {
    routeFoldseek({
      results: { 0: { results: [{ db: 'pdb100', alignments: [[{ target: '1AAA_A', seqId }]] }] } },
    });

    const out = await service().search(params(), createMockContext());

    if (out.status !== 'complete') throw new Error('expected complete');
    expect(out.hits[0]?.sequenceIdentity).toBe(identity);
  });
});

describe('FoldseekService.search — a refused submit (#87)', () => {
  const isSubmit = (req: Request) => {
    const url = new URL(req.url);
    return url.hostname === 'foldseek.test' && url.pathname === '/api/ticket';
  };

  it('reports an HTTP 400 on submit as rejected, without retrying or polling', async () => {
    // Run the real HTTP helper so the 400 → InvalidParams mapping and the retry
    // predicate are part of what this test exercises.
    const actual = await vi.importActual<typeof import('@/services/shared/http.js')>(
      '@/services/shared/http.js',
    );
    fetchJsonMock.mockImplementation(actual.fetchJson);
    const http = createFetchMock([
      {
        method: 'POST',
        match: isSubmit,
        respond: new Response('selected databases are not valid\n', {
          status: 400,
          statusText: 'Bad Request',
        }),
      },
    ]);
    http.install();
    try {
      const out = await service().search(params(), createMockContext());
      expect(out).toEqual({
        status: 'rejected',
        upstreamMessage: 'selected databases are not valid',
      });
      expect(http.calls).toHaveLength(1);
    } finally {
      http.restore();
    }
  });

  it('keeps any other submit failure as failed', async () => {
    fetchJsonMock.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Foldseek returned HTTP 503.'),
    );
    const out = await service().search(params(), createMockContext());
    expect(out).toEqual({ status: 'failed', error: 'Foldseek returned HTTP 503.' });
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

  it('degrades to failed when the ticket reports ERROR, keeping the ticket it submitted', async () => {
    routeFoldseek({ ticketId: 'tkt-err', status: 'ERROR', results: {} });

    const out = await service().search(params(), createMockContext());
    expect(out).toMatchObject({ status: 'failed', ticketId: 'tkt-err' });
    if (out.status !== 'failed') throw new Error('expected failed');
    expect(out.error).toMatch(/error/i);
  });

  it('keeps the ticket when the call’s deadline stops the poll after a successful submit', async () => {
    const controller = new AbortController();
    fetchJsonMock.mockImplementation(async (url: string) => {
      if (url === 'https://foldseek.test/api/ticket') return { id: 'tkt-late' };
      // The call's budget runs out while the ticket poll is in flight.
      controller.abort(new DOMException('Call budget spent.', 'TimeoutError'));
      throw controller.signal.reason;
    });
    const out = await service().search(
      params({ timeoutMs: 30_000 }),
      createMockContext({ signal: controller.signal }),
    );

    expect(out).toMatchObject({ status: 'failed', ticketId: 'tkt-late' });
    // Submitted once, polled once: the stopped poll is not retried into a second job.
    expect(fetchJsonMock.mock.calls.map((call) => call[0])).toEqual([
      'https://foldseek.test/api/ticket',
      'https://foldseek.test/api/ticket/tkt-late',
    ]);
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

  it('degrades to failed (not not_found) on a non-400 upstream error, keeping the ticket', async () => {
    fetchJsonMock.mockRejectedValue(new Error('network boom'));
    const out = await service().resume(resumeParams, createMockContext());
    expect(out).toEqual({ status: 'failed', ticketId: 'ticket-1', error: 'network boom' });
  });
});
