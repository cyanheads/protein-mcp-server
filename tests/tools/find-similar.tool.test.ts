/**
 * @fileoverview Tests for protein_find_similar: the by:sequence path (direct
 * sequence, PDB-derived, UniProt-derived; metadata enrichment; empty-result
 * notice; no_sequence failure), the by:structure path (Foldseek complete /
 * computing / failed, predicted-source mapping, completed-job paging via
 * totalCount / start / nextStart and a re-usable ticketId), query selection on
 * multichain jobs (query / queryCount, the multi-query notice, out-of-range
 * rejection), the combined cross-database ranking run through the real Foldseek
 * service over captured payloads, the missing_query guard, the per-mode field
 * rejection, the error envelope each declared reason produces on both client
 * surfaces, and format(). Services, HTTP, and the coordinate-file fetch are
 * mocked.
 * @module tests/tools/find-similar.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const searchSequence = vi.fn();
const getEntries = vi.fn();
const getSequence = vi.fn();
// Coordinate-URL construction runs the real service code; only upstream calls are faked.
vi.mock('@/services/rcsb/rcsb-service.js', async (importOriginal) => {
  const { RcsbService } = await importOriginal<typeof import('@/services/rcsb/rcsb-service.js')>();
  const real = new RcsbService(
    {} as never,
    {} as never,
    { rcsbFilesBaseUrl: 'https://files', rcsbModelsBaseUrl: 'https://models' } as never,
  );
  return {
    getRcsbService: () => ({
      searchSequence,
      getEntries,
      getSequence,
      mmcifUrl: real.mmcifUrl.bind(real),
    }),
  };
});

const foldseekSearch = vi.fn();
const foldseekResume = vi.fn();
const fakeFoldseek = { search: foldseekSearch, resume: foldseekResume };
/** Swapped for a real FoldseekService where a test exercises the service's own ranking and paging. */
let foldseekImpl: object = fakeFoldseek;
vi.mock('@/services/foldseek/foldseek-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/foldseek/foldseek-service.js')>()),
  getFoldseekService: () => foldseekImpl,
}));

const getUniProtSequence = vi.fn();
vi.mock('@/services/uniprot/uniprot-service.js', () => ({
  getUniProtService: () => ({ getSequence: getUniProtSequence }),
}));

const getPrediction = vi.fn();
vi.mock('@/services/alphafold/alphafold-service.js', () => ({
  getAlphaFoldService: () => ({ getPrediction }),
}));

vi.mock('@/services/shared/http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/shared/http.js')>();
  return { ...actual, fetchJson: vi.fn(), fetchText: vi.fn() };
});

import { findSimilar } from '@/mcp-server/tools/definitions/find-similar.tool.js';
import { FoldseekService } from '@/services/foldseek/foldseek-service.js';
import { fetchJson, fetchText } from '@/services/shared/http.js';
import { entryIdOf } from '@/services/shared/identifiers.js';
import {
  QUERIES_1CRN,
  QUERIES_4HHB,
  RESULT_1CRN_Q0,
  RESULT_4HHB_Q0,
  RESULT_4HHB_Q1,
  RESULT_EMPTY_QUERY,
} from '../fixtures/foldseek-captures.js';

const fetchJsonMock = vi.mocked(fetchJson);
const fetchTextMock = vi.mocked(fetchText);
const ctx = () => createMockContext({ errors: findSimilar.errors });

/** One normalized Foldseek PDB hit, as the service hands it to the tool. */
const PDB_HIT = {
  target: '2HHB-A',
  database: 'pdb100',
  targetType: 'pdb' as const,
  pdbId: '2HHB',
  chain: 'A',
  score: 800,
};

beforeEach(() => {
  vi.clearAllMocks();
  foldseekImpl = fakeFoldseek;
});

/** A completed multichain (4HHB-shaped) outcome as the service hands it to the tool. */
const multichain = (over: Record<string, unknown> = {}) => ({
  status: 'complete',
  ticketId: 'tkt-4hhb',
  query: 0,
  queryCount: 4,
  total: 1914,
  hits: [PDB_HIT],
  ...over,
});

type StructureResult = {
  structuredContent: {
    hits: Array<{ id: string; score?: number; database?: string }>;
    nextStart?: number;
    notice?: string;
    query?: number;
    queryCount?: number;
    start: number;
    ticketId?: string;
    totalCount: number;
  };
  content: Array<{ text: string }>;
};

const renderedText = (result: StructureResult) =>
  result.content.map((block) => block.text).join('\n');

describe('protein_find_similar — by:sequence', () => {
  it('searches a directly-supplied sequence and enriches hits with entry metadata', async () => {
    searchSequence.mockResolvedValue({ total: 42, hits: [{ id: '4HHB_1', score: 1 }] });
    getEntries.mockResolvedValue([
      {
        id: '4HHB',
        title: 'Deoxyhaemoglobin',
        organisms: ['Homo sapiens'],
        polymerEntities: [],
        ligands: [],
      },
    ]);
    const c = ctx();
    const out = await findSimilar.handler(
      findSimilar.input.parse({ by: 'sequence', sequence: 'MVL SPA DK' }),
      c,
    );

    expect(out).toMatchObject({ by: 'sequence', engine: 'RCSB mmseqs2', status: 'complete' });
    // The bare entry ID chains into protein_get_structure; the raw polymer-entity
    // ID is preserved as entityId. Metadata enrichment keys off the entry ID.
    expect(out.hits[0]).toMatchObject({
      id: '4HHB',
      entityId: '4HHB_1',
      source: 'experimental',
      title: 'Deoxyhaemoglobin',
      organism: 'Homo sapiens',
    });
    // The RCSB mmseqs2 path emits no identity field at all — min_identity is an
    // input filter there, not a per-hit score.
    expect(out.hits[0]).not.toHaveProperty('identity');
    // Whitespace is stripped before the sequence search.
    expect(searchSequence.mock.calls[0]?.[0]).toBe('MVLSPADK');
    expect(getEnrichment(c)).toMatchObject({ totalCount: 42 });
  });

  it('emits a bare, chainable entry ID plus the raw entityId for each hit (#18)', async () => {
    searchSequence.mockResolvedValue({
      total: 2,
      hits: [
        { id: '1A00_1', score: 1 },
        { id: '1A01_1', score: 0.98 },
      ],
    });
    getEntries.mockResolvedValue([]);
    const out = await findSimilar.handler(
      findSimilar.input.parse({ by: 'sequence', sequence: 'MVLSPADK' }),
      ctx(),
    );
    // id is exactly what entryIdOf produces from the polymer-entity ID; entityId keeps the raw form.
    expect(out.hits[0]).toMatchObject({ id: '1A00', entityId: '1A00_1' });
    expect(out.hits[0]?.id).toBe(entryIdOf('1A00_1'));
    expect(out.hits.map((h) => h.id)).toEqual(['1A00', '1A01']);
  });

  it('deduplicates repeated entry IDs in the metadata batch and enriches every matching entity', async () => {
    searchSequence.mockResolvedValue({
      total: 2,
      hits: [
        { id: '1A00_1', score: 1 },
        { id: '1A00_2', score: 0.99 },
      ],
    });
    getEntries.mockResolvedValue([
      {
        id: '1A00',
        title: 'Hemoglobin entry',
        organisms: ['Homo sapiens'],
        polymerEntities: [],
        ligands: [],
      },
    ]);

    const out = await findSimilar.handler(
      findSimilar.input.parse({ by: 'sequence', sequence: 'MVLSPADK' }),
      ctx(),
    );

    expect(getEntries).toHaveBeenCalledWith(['1A00'], expect.anything());
    expect(out.hits.map((hit) => hit.title)).toEqual(['Hemoglobin entry', 'Hemoglobin entry']);
  });

  it.each([49, 50, 51])('enriches every distinct entry in a %i-entry page', async (count) => {
    const hits = Array.from({ length: count }, (_, index) => ({
      id: `${String(index).padStart(3, '0')}A_1`,
      score: 1 - index / 100,
    }));
    searchSequence.mockResolvedValue({ total: count, hits });
    getEntries.mockImplementation(async (ids: string[]) =>
      ids.map((id) => ({
        id,
        title: `Title ${id}`,
        organisms: ['Test organism'],
        polymerEntities: [],
        ligands: [],
      })),
    );

    const out = await findSimilar.handler(
      findSimilar.input.parse({ by: 'sequence', sequence: 'MVLSPADK', limit: count }),
      ctx(),
    );

    expect(getEntries.mock.calls[0]?.[0]).toHaveLength(count);
    expect(out.hits[count - 1]).toMatchObject({
      title: `Title ${String(count - 1).padStart(3, '0')}A`,
      organism: 'Test organism',
    });
  });

  it('preserves sparse metadata and fails the whole call when metadata enrichment fails', async () => {
    searchSequence.mockResolvedValue({ total: 1, hits: [{ id: '1A00_1', score: 1 }] });
    getEntries.mockResolvedValue([{ id: '1A00', organisms: [], polymerEntities: [], ligands: [] }]);
    const sparse = await findSimilar.handler(
      findSimilar.input.parse({ by: 'sequence', sequence: 'MVLSPADK' }),
      ctx(),
    );
    expect(sparse.hits[0]).not.toHaveProperty('title');
    expect(sparse.hits[0]).not.toHaveProperty('organism');

    getEntries.mockRejectedValue(new Error('metadata unavailable'));
    await expect(
      findSimilar.handler(findSimilar.input.parse({ by: 'sequence', sequence: 'MVLSPADK' }), ctx()),
    ).rejects.toThrow('metadata unavailable');
  });

  it('exposes sequence offsets and nextStart on both consumption surfaces', async () => {
    searchSequence.mockResolvedValue({
      total: 30,
      hits: [
        { id: '1A00_1', score: 1 },
        { id: '1A01_1', score: 0.9 },
      ],
    });
    getEntries.mockResolvedValue([]);

    const result = (await runToolContract(findSimilar, {
      by: 'sequence',
      sequence: 'MVLSPADK',
      start: 25,
      limit: 2,
    })) as {
      structuredContent: { totalCount: number; start: number; nextStart?: number };
      content: Array<{ text: string }>;
    };

    expect(searchSequence.mock.calls[0]?.[1]).toMatchObject({ start: 25, limit: 2 });
    expect(result.structuredContent).toMatchObject({ totalCount: 30, start: 25, nextStart: 27 });
    const rendered = result.content.map((block) => block.text).join('\n');
    expect(rendered).toContain('**start:** 25');
    expect(rendered).toContain('**nextStart:** 27');
  });

  it('omits nextStart on final, past-end, and zero-match sequence pages', async () => {
    for (const [start, total, hits] of [
      [29, 30, [{ id: '1A00_1', score: 1 }]],
      [40, 30, []],
      [0, 0, []],
    ] as const) {
      searchSequence.mockResolvedValue({ total, hits });
      getEntries.mockResolvedValue([]);
      const c = ctx();
      await findSimilar.handler(
        findSimilar.input.parse({ by: 'sequence', sequence: 'MVLSPADK', start, limit: 5 }),
        c,
      );
      expect(getEnrichment(c)).toMatchObject({ totalCount: total, start });
      expect(getEnrichment(c)).not.toHaveProperty('nextStart');
    }
  });

  it('rejects negative or fractional sequence offsets', () => {
    expect(
      findSimilar.input.safeParse({ by: 'sequence', sequence: 'MVLS', start: -1 }).success,
    ).toBe(false);
    expect(
      findSimilar.input.safeParse({ by: 'sequence', sequence: 'MVLS', start: 1.5 }).success,
    ).toBe(false);
  });

  it('derives the query sequence from a PDB ID', async () => {
    getSequence.mockResolvedValue({ entityId: '4HHB_1', sequence: 'MVLSPADK' });
    // An empty first page means the search matched nothing, so the upstream total is 0.
    searchSequence.mockResolvedValue({ total: 0, hits: [] });
    getEntries.mockResolvedValue([]);
    const c = ctx();
    await findSimilar.handler(findSimilar.input.parse({ by: 'sequence', pdb_id: '4hhb' }), c);
    expect(getSequence).toHaveBeenCalledWith('4hhb', expect.anything());
    expect(searchSequence.mock.calls[0]?.[0]).toBe('MVLSPADK');
    expect(String(getEnrichment(c).notice)).toMatch(/^No sequence-similar entries found/);
  });

  it('derives the query sequence from a UniProt accession', async () => {
    getUniProtSequence.mockResolvedValue('MKTAYIAK');
    searchSequence.mockResolvedValue({ total: 0, hits: [] });
    getEntries.mockResolvedValue([]);
    const c = ctx();
    await findSimilar.handler(findSimilar.input.parse({ by: 'sequence', uniprot: 'P69905' }), c);
    expect(searchSequence.mock.calls[0]?.[0]).toBe('MKTAYIAK');
    expect(String(getEnrichment(c).notice)).toMatch(/^No sequence-similar entries found/);
  });

  it('notes an empty result set', async () => {
    searchSequence.mockResolvedValue({ total: 0, hits: [] });
    getEntries.mockResolvedValue([]);
    const c = ctx();
    const out = await findSimilar.handler(
      findSimilar.input.parse({ by: 'sequence', sequence: 'XXXX' }),
      c,
    );
    expect(out.hits).toEqual([]);
    expect(String(getEnrichment(c).notice)).toMatch(/min_identity|max_evalue|No sequence-similar/i);
  });

  it('names the offset on a past-end sequence page instead of claiming no matches, on both surfaces (#66)', async () => {
    getUniProtSequence.mockResolvedValue('MVLSPADK');
    searchSequence.mockResolvedValue({ total: 1376, hits: [] });
    getEntries.mockResolvedValue([]);

    const result = (await runToolContract(findSimilar, {
      by: 'sequence',
      uniprot: 'P69905',
      start: 2000,
      limit: 1,
    })) as {
      structuredContent: {
        hits: unknown[];
        totalCount: number;
        nextStart?: number;
        notice?: string;
      };
      content: Array<{ text: string }>;
    };

    expect(result.structuredContent.hits).toEqual([]);
    expect(result.structuredContent.totalCount).toBe(1376);
    expect(result.structuredContent).not.toHaveProperty('nextStart');
    const notice = String(result.structuredContent.notice);
    expect(notice).toContain('start 2000 is past the end of the 1376 matches');
    expect(notice).not.toMatch(/No sequence-similar entries found/);
    const rendered = result.content.map((block) => block.text).join('\n');
    expect(rendered).toContain('start 2000 is past the end of the 1376 matches');
    expect(rendered).not.toMatch(/No sequence-similar entries found/);
  });

  it('keeps the zero-match advice when the sequence search matched nothing at any offset (#66)', async () => {
    searchSequence.mockResolvedValue({ total: 0, hits: [] });
    getEntries.mockResolvedValue([]);
    const c = ctx();
    await findSimilar.handler(
      findSimilar.input.parse({ by: 'sequence', sequence: 'XXXX', start: 40 }),
      c,
    );
    expect(String(getEnrichment(c).notice)).toBe(
      'No sequence-similar entries found. Lower min_identity or raise max_evalue.',
    );
  });

  it('throws no_sequence when the PDB entry yields no protein sequence', async () => {
    getSequence.mockResolvedValue(null);
    await expect(
      findSimilar.handler(findSimilar.input.parse({ by: 'sequence', pdb_id: '1ABC' }), ctx()),
    ).rejects.toMatchObject({ data: { reason: 'no_sequence' } });
  });

  it('throws missing_query (with its declared recovery hint) when no sequence source is provided', async () => {
    await expect(
      findSimilar.handler(findSimilar.input.parse({ by: 'sequence' }), ctx()),
    ).rejects.toMatchObject({
      data: {
        reason: 'missing_query',
        recovery: { hint: expect.stringContaining('raw sequence') },
      },
    });
  });

  it('forwards max_evalue and min_identity to the sequence search', async () => {
    searchSequence.mockResolvedValue({ total: 0, hits: [] });
    getEntries.mockResolvedValue([]);
    await findSimilar.handler(
      findSimilar.input.parse({
        by: 'sequence',
        sequence: 'MVLS',
        max_evalue: 0.001,
        min_identity: 0.6,
      }),
      ctx(),
    );
    expect(searchSequence.mock.calls[0]?.[1]).toMatchObject({ maxEvalue: 0.001, minIdentity: 0.6 });
  });
});

describe('protein_find_similar — by:structure', () => {
  it('forwards start and reports paging state on a completed structure search (#53)', async () => {
    fetchTextMock.mockResolvedValue('ATOM ...');
    foldseekSearch.mockResolvedValue({
      status: 'complete',
      ticketId: 'tkt-9',
      total: 179,
      hits: [PDB_HIT],
    });

    const result = (await runToolContract(findSimilar, {
      by: 'structure',
      pdb_id: '4HHB',
      start: 25,
      limit: 1,
    })) as {
      structuredContent: {
        ticketId?: string;
        totalCount: number;
        start: number;
        nextStart?: number;
      };
      content: Array<{ text: string }>;
    };

    expect(foldseekSearch.mock.calls[0]?.[0]).toMatchObject({ start: 25, limit: 1 });
    // A completed job carries its ticket so the same result set can be re-paged
    // instead of resubmitting the structure.
    expect(result.structuredContent).toMatchObject({
      ticketId: 'tkt-9',
      totalCount: 179,
      start: 25,
      nextStart: 26,
    });
    const rendered = result.content.map((block) => block.text).join('\n');
    expect(rendered).toContain('**Ticket:** tkt-9');
    expect(rendered).toContain('**start:** 25');
    expect(rendered).toContain('**nextStart:** 26');
  });

  it('omits nextStart on final, past-end, and zero-hit structure pages (#53)', async () => {
    for (const [start, total, hits] of [
      [178, 179, [PDB_HIT]],
      [500, 179, []],
      [0, 0, []],
    ] as const) {
      vi.clearAllMocks();
      fetchTextMock.mockResolvedValue('ATOM ...');
      foldseekSearch.mockResolvedValue({ status: 'complete', ticketId: 't', total, hits });
      const c = ctx();
      await findSimilar.handler(
        findSimilar.input.parse({ by: 'structure', pdb_id: '4HHB', start, limit: 5 }),
        c,
      );
      expect(getEnrichment(c)).toMatchObject({ totalCount: total, start });
      expect(getEnrichment(c)).not.toHaveProperty('nextStart');
    }
  });

  it('distinguishes a past-end page from a job with no hits in its notice (#53)', async () => {
    // Paging made the empty page reachable two ways, and they need opposite next
    // moves: lower the offset vs. widen the databases.
    fetchTextMock.mockResolvedValue('ATOM ...');
    foldseekSearch.mockResolvedValue({ status: 'complete', ticketId: 't', total: 179, hits: [] });
    const pastEnd = ctx();
    await findSimilar.handler(
      findSimilar.input.parse({ by: 'structure', pdb_id: '4HHB', start: 500 }),
      pastEnd,
    );
    expect(getEnrichment(pastEnd).notice).toMatch(/start 500 is past the end/);
    expect(getEnrichment(pastEnd).notice).not.toMatch(/selected databases/);

    vi.clearAllMocks();
    fetchTextMock.mockResolvedValue('ATOM ...');
    foldseekSearch.mockResolvedValue({ status: 'complete', ticketId: 't', total: 0, hits: [] });
    const noHits = ctx();
    await findSimilar.handler(findSimilar.input.parse({ by: 'structure', pdb_id: '4HHB' }), noHits);
    expect(getEnrichment(noHits).notice).toMatch(/no fold-similar hits in the selected databases/);
  });

  it('re-pages a completed ticket at a new start without resubmitting (#53)', async () => {
    foldseekResume.mockResolvedValue({
      status: 'complete',
      ticketId: 'resume-me',
      total: 179,
      hits: [
        {
          target: 'AF-P69905-F1',
          database: 'afdb50',
          targetType: 'alphafold',
          uniprotAccession: 'P69905',
        },
      ],
    });
    const c = ctx();
    const out = await findSimilar.handler(
      findSimilar.input.parse({ by: 'structure', ticket_id: 'resume-me', start: 40, limit: 1 }),
      c,
    );

    expect(foldseekResume.mock.calls[0]?.[0]).toMatchObject({
      ticketId: 'resume-me',
      start: 40,
      limit: 1,
    });
    expect(out.hits.map((h) => h.id)).toEqual(['P69905']);
    expect(getEnrichment(c)).toMatchObject({ totalCount: 179, start: 40, nextStart: 41 });
    // No new job and no coordinate download — the completed ticket is re-read.
    expect(foldseekSearch).not.toHaveBeenCalled();
    expect(fetchTextMock).not.toHaveBeenCalled();
  });

  it('runs a Foldseek search from a PDB coordinate file and maps hits by source', async () => {
    fetchTextMock.mockResolvedValue('ATOM ...');
    foldseekSearch.mockResolvedValue({
      status: 'complete',
      ticketId: 't1',
      total: 2,
      hits: [
        {
          target: '2HHB-A',
          database: 'pdb100',
          targetType: 'pdb',
          pdbId: '2HHB',
          chain: 'A',
          score: 800,
          evalue: 1e-30,
          sequenceIdentity: 0.87,
        },
        {
          target: 'AF-P69905-F1',
          database: 'afdb50',
          targetType: 'alphafold',
          uniprotAccession: 'P69905',
          score: 700,
        },
      ],
    });
    const out = await findSimilar.handler(
      findSimilar.input.parse({ by: 'structure', pdb_id: '4HHB' }),
      ctx(),
    );

    expect(out).toMatchObject({ by: 'structure', engine: 'Foldseek', status: 'complete' });
    // identity passes the service's already-normalized 0–1 value straight through.
    expect(out.hits[0]).toMatchObject({
      id: '2HHB',
      source: 'experimental',
      score: 800,
      evalue: 1e-30,
      identity: 0.87,
    });
    expect(out.hits[1]).toMatchObject({
      id: 'P69905',
      source: 'predicted',
      uniprotAccession: 'P69905',
    });
    // A hit whose alignment carried no seqId reports no identity at all.
    expect(out.hits[1]).not.toHaveProperty('identity');
  });

  it('reports identity in 0–1 for a self-identical structural match, never 100', async () => {
    // The live Foldseek path returns seqId: 100 for a near-identical fold; the
    // service normalizes it, so the tool's declared 0–1 identity contract holds.
    fetchTextMock.mockResolvedValue('ATOM ...');
    foldseekSearch.mockResolvedValue({
      status: 'complete',
      ticketId: 't1',
      total: 2,
      hits: [
        {
          target: '1Y45-A',
          database: 'pdb100',
          targetType: 'pdb',
          pdbId: '1Y45',
          chain: 'A',
          score: 920,
          sequenceIdentity: 1,
        },
      ],
    });
    const out = await findSimilar.handler(
      findSimilar.input.parse({ by: 'structure', pdb_id: '4HHB' }),
      ctx(),
    );
    expect(out.hits[0]?.identity).toBe(1);
    expect(out.hits[0]?.identity).toBeLessThanOrEqual(1);
  });

  it('returns status:computing with the ticket when the job is still running', async () => {
    fetchTextMock.mockResolvedValue('ATOM ...');
    foldseekSearch.mockResolvedValue({ status: 'computing', ticketId: 'pending-9' });
    const c = ctx();
    const out = await findSimilar.handler(
      findSimilar.input.parse({ by: 'structure', pdb_id: '4HHB' }),
      c,
    );
    expect(out).toMatchObject({ status: 'computing', ticketId: 'pending-9', hits: [] });
    expect(String(getEnrichment(c).notice)).toMatch(/computing/i);
  });

  it('throws search_failed (ServiceUnavailable) when Foldseek fails the job', async () => {
    fetchTextMock.mockResolvedValue('ATOM ...');
    foldseekSearch.mockResolvedValue({ status: 'failed', error: 'bad coordinates' });
    await expect(
      findSimilar.handler(findSimilar.input.parse({ by: 'structure', pdb_id: '4HHB' }), ctx()),
    ).rejects.toMatchObject({ data: { reason: 'search_failed' } });
  });

  it('uploads the mmCIF file for a PDB ID, which every entry has, including mmCIF-only ones (#61)', async () => {
    fetchTextMock.mockResolvedValue('data_4V6X');
    foldseekSearch.mockResolvedValue({ status: 'complete', ticketId: 't', total: 0, hits: [] });
    await findSimilar.handler(findSimilar.input.parse({ by: 'structure', pdb_id: '4v6x' }), ctx());
    expect(fetchTextMock).toHaveBeenCalledTimes(1);
    expect(fetchTextMock.mock.calls[0]?.[0]).toBe('https://files/download/4V6X.cif');
    expect(foldseekSearch.mock.calls[0]?.[0]).toMatchObject({
      fileContent: 'data_4V6X',
      fileName: '4V6X.cif',
    });
    // No metadata lookup is needed to choose the format.
    expect(getEntries).not.toHaveBeenCalled();
  });

  it('derives coordinates from an AlphaFold model when given a UniProt accession', async () => {
    getPrediction.mockResolvedValue({
      uniprotAccession: 'P69905',
      pdbUrl: 'https://af/P69905.pdb',
    });
    fetchTextMock.mockResolvedValue('ATOM ...');
    foldseekSearch.mockResolvedValue({ status: 'complete', ticketId: 't', total: 0, hits: [] });
    await findSimilar.handler(
      findSimilar.input.parse({ by: 'structure', uniprot: 'P69905' }),
      ctx(),
    );
    expect(fetchTextMock.mock.calls[0]?.[0]).toBe('https://af/P69905.pdb');
    expect(foldseekSearch.mock.calls[0]?.[0]).toMatchObject({ fileName: 'P69905.pdb' });
  });

  it('throws no_sequence when the UniProt accession has no predicted model with coordinates', async () => {
    getPrediction.mockResolvedValue(null);
    await expect(
      findSimilar.handler(findSimilar.input.parse({ by: 'structure', uniprot: 'P00000' }), ctx()),
    ).rejects.toMatchObject({ data: { reason: 'no_sequence' } });
  });

  it('throws missing_query when by:structure has no pdb_id or uniprot', async () => {
    // No `sequence` here: under by:"structure" it now trips the per-mode field
    // guard (#57) before coordinate resolution, so this case is exercised alone.
    await expect(
      findSimilar.handler(findSimilar.input.parse({ by: 'structure' }), ctx()),
    ).rejects.toMatchObject({ data: { reason: 'missing_query' } });
  });

  it('offers only identifiers in the by:structure missing_query hint (#57)', async () => {
    // The declared hint offers a raw sequence, which the per-mode guard rejects
    // under by:"structure" — this branch must not send the caller into it.
    await expect(
      findSimilar.handler(findSimilar.input.parse({ by: 'structure' }), ctx()),
    ).rejects.toMatchObject({
      data: {
        reason: 'missing_query',
        recovery: {
          hint: expect.stringMatching(/pdb_id[\s\S]*uniprot/) as unknown as string,
        },
      },
    });
    await expect(
      findSimilar.handler(findSimilar.input.parse({ by: 'structure' }), ctx()),
    ).rejects.toMatchObject({
      data: {
        recovery: {
          hint: expect.not.stringContaining('Provide a raw sequence,') as unknown as string,
        },
      },
    });
  });

  it('passes custom databases through to Foldseek', async () => {
    fetchTextMock.mockResolvedValue('ATOM ...');
    foldseekSearch.mockResolvedValue({ status: 'complete', ticketId: 't', total: 0, hits: [] });
    await findSimilar.handler(
      findSimilar.input.parse({ by: 'structure', pdb_id: '4HHB', databases: ['afdb-swissprot'] }),
      ctx(),
    );
    expect(foldseekSearch.mock.calls[0]?.[0]).toMatchObject({ databases: ['afdb-swissprot'] });
  });

  it('resumes an existing ticket (polls, no resubmit, no coordinate fetch) when ticket_id is set', async () => {
    foldseekResume.mockResolvedValue({
      status: 'complete',
      ticketId: 'resume-me',
      total: 1,
      hits: [
        {
          target: '2HHB-A',
          database: 'pdb100',
          targetType: 'pdb',
          pdbId: '2HHB',
          chain: 'A',
          score: 800,
        },
      ],
    });
    const out = await findSimilar.handler(
      findSimilar.input.parse({ by: 'structure', ticket_id: 'resume-me' }),
      ctx(),
    );

    expect(out).toMatchObject({ by: 'structure', engine: 'Foldseek', status: 'complete' });
    expect(out.hits[0]).toMatchObject({ id: '2HHB', source: 'experimental' });
    // Polled the given ticket — never submitted a fresh search or fetched coordinates.
    expect(foldseekResume.mock.calls[0]?.[0]).toMatchObject({ ticketId: 'resume-me' });
    expect(foldseekSearch).not.toHaveBeenCalled();
    expect(fetchTextMock).not.toHaveBeenCalled();
  });

  it('re-reports computing with the same ticket when a resumed job is still running', async () => {
    foldseekResume.mockResolvedValue({ status: 'computing', ticketId: 'resume-me' });
    const c = ctx();
    const out = await findSimilar.handler(
      findSimilar.input.parse({ by: 'structure', ticket_id: 'resume-me' }),
      c,
    );
    expect(out).toMatchObject({ status: 'computing', ticketId: 'resume-me', hits: [] });
    expect(String(getEnrichment(c).notice)).toMatch(/ticket_id/i);
  });

  it('throws ticket_not_found when the resumed ticket is invalid or expired', async () => {
    foldseekResume.mockResolvedValue({ status: 'not_found', ticketId: 'bogus' });
    await expect(
      findSimilar.handler(findSimilar.input.parse({ by: 'structure', ticket_id: 'bogus' }), ctx()),
    ).rejects.toMatchObject({ data: { reason: 'ticket_not_found' } });
    expect(foldseekSearch).not.toHaveBeenCalled();
  });
});

describe('protein_find_similar — query selection on multichain jobs (#63)', () => {
  it('reads query 0 by default and discloses the other queries on both surfaces', async () => {
    fetchTextMock.mockResolvedValue('data_4HHB');
    foldseekSearch.mockResolvedValue(multichain());

    const result = (await runToolContract(findSimilar, {
      by: 'structure',
      pdb_id: '4HHB',
      limit: 1,
    })) as StructureResult;

    expect(foldseekSearch.mock.calls[0]?.[0]).toMatchObject({ query: 0 });
    expect(result.structuredContent).toMatchObject({
      query: 0,
      queryCount: 4,
      ticketId: 'tkt-4hhb',
      totalCount: 1914,
    });
    const notice = String(result.structuredContent.notice);
    expect(notice).toContain('This job holds 4 queries');
    expect(notice).toContain('these hits are for query 0');
    expect(notice).toContain('ticket_id "tkt-4hhb" and a different query (0–3)');
    const text = renderedText(result);
    expect(text).toContain('**Query:** 0 of 4 (0-based)');
    expect(text).toContain('This job holds 4 queries');
  });

  it('forwards an explicit query and echoes it', async () => {
    fetchTextMock.mockResolvedValue('data_4HHB');
    foldseekSearch.mockResolvedValue(multichain({ query: 2 }));

    const result = (await runToolContract(findSimilar, {
      by: 'structure',
      pdb_id: '4HHB',
      query: 2,
    })) as StructureResult;

    expect(foldseekSearch.mock.calls[0]?.[0]).toMatchObject({ query: 2 });
    expect(result.structuredContent).toMatchObject({ query: 2, queryCount: 4 });
    expect(String(result.structuredContent.notice)).toContain('these hits are for query 2');
    const text = renderedText(result);
    expect(text).toContain('**Query:** 2 of 4 (0-based)');
    expect(text).toContain('re-call with ticket_id and query 2 to resume or re-page');
  });

  it('keeps the query across a ticket_id resume at a different start', async () => {
    foldseekResume.mockResolvedValue(multichain({ query: 1, total: 1863 }));
    const c = ctx();

    const out = await findSimilar.handler(
      findSimilar.input.parse({
        by: 'structure',
        ticket_id: 'tkt-4hhb',
        query: 1,
        start: 25,
        limit: 5,
      }),
      c,
    );

    expect(foldseekResume.mock.calls[0]?.[0]).toMatchObject({
      ticketId: 'tkt-4hhb',
      query: 1,
      start: 25,
      limit: 5,
    });
    expect(out).toMatchObject({ query: 1, queryCount: 4, ticketId: 'tkt-4hhb' });
    expect(getEnrichment(c)).toMatchObject({ totalCount: 1863, start: 25, nextStart: 26 });
    expect(foldseekSearch).not.toHaveBeenCalled();
  });

  it('adds no multi-query notice for a single-query job', async () => {
    fetchTextMock.mockResolvedValue('data_1CRN');
    foldseekSearch.mockResolvedValue(multichain({ queryCount: 1, total: 179 }));

    const result = (await runToolContract(findSimilar, {
      by: 'structure',
      pdb_id: '1CRN',
    })) as StructureResult;

    expect(result.structuredContent).toMatchObject({ query: 0, queryCount: 1 });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(renderedText(result)).toContain('**Query:** 0 of 1 (0-based)');
  });

  it('keeps the past-end and multi-query notices together on an empty page', async () => {
    fetchTextMock.mockResolvedValue('data_4HHB');
    foldseekSearch.mockResolvedValue(multichain({ hits: [] }));

    const result = (await runToolContract(findSimilar, {
      by: 'structure',
      pdb_id: '4HHB',
      start: 5000,
    })) as StructureResult;

    const notice = String(result.structuredContent.notice);
    expect(notice).toContain("start 5000 is past the end of this job's 1914 hits");
    expect(notice).toContain('This job holds 4 queries');
  });

  it('keeps the no-hits and multi-query notices together when the selected query matched nothing', async () => {
    fetchTextMock.mockResolvedValue('data_4HHB');
    foldseekSearch.mockResolvedValue(multichain({ total: 0, hits: [] }));
    const c = ctx();
    await findSimilar.handler(findSimilar.input.parse({ by: 'structure', pdb_id: '4HHB' }), c);
    const notice = String(getEnrichment(c).notice);
    expect(notice).toContain('no fold-similar hits in the selected databases');
    expect(notice).toContain('This job holds 4 queries');
  });

  it('names the query in the resume instruction while a non-zero-query job is computing', async () => {
    fetchTextMock.mockResolvedValue('data_4HHB');
    foldseekSearch.mockResolvedValue({ status: 'computing', ticketId: 'slow' });
    const c = ctx();
    const out = await findSimilar.handler(
      findSimilar.input.parse({ by: 'structure', pdb_id: '4HHB', query: 2 }),
      c,
    );
    expect(out).toMatchObject({ status: 'computing', ticketId: 'slow', query: 2 });
    expect(String(getEnrichment(c).notice)).toContain('ticket_id set to "slow" and query 2');
  });

  it('rejects a negative or fractional query at the schema', () => {
    for (const query of [-1, 1.5]) {
      expect(findSimilar.input.safeParse({ by: 'structure', pdb_id: '4HHB', query }).success).toBe(
        false,
      );
    }
  });

  it('throws query_out_of_range with the ticket and valid range when the index is past the last query', async () => {
    fetchTextMock.mockResolvedValue('data_4HHB');
    foldseekSearch.mockResolvedValue({
      status: 'query_out_of_range',
      ticketId: 'tkt-4hhb',
      query: 4,
      queryCount: 4,
    });

    await expect(
      findSimilar.handler(
        findSimilar.input.parse({ by: 'structure', pdb_id: '4HHB', query: 4 }),
        ctx(),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      message: expect.stringContaining('query 4 is out of range'),
      data: {
        reason: 'query_out_of_range',
        recovery: {
          hint: expect.stringContaining('ticket_id "tkt-4hhb" and query between 0 and 3'),
        },
      },
    });
  });
});

describe('protein_find_similar — combined ranking through the real Foldseek service (#64)', () => {
  /** Route the real service's upstream calls by URL; unknown query indices answer empty. */
  const routeFoldseek = (queries: unknown, results: Record<number, unknown>) =>
    fetchJsonMock.mockImplementation(async (url: string) => {
      if (url === 'https://foldseek.test/api/ticket') return { id: 'live-shaped' };
      if (url.includes('/api/ticket/')) return { status: 'COMPLETE' };
      if (url.includes('/api/result/queries/')) return queries;
      const perQuery = /\/api\/result\/[^/]+\/(\d+)$/.exec(url);
      if (perQuery) return results[Number(perQuery[1])] ?? RESULT_EMPTY_QUERY;
      throw new Error(`unexpected Foldseek URL ${url}`);
    });

  beforeEach(() => {
    foldseekImpl = new FoldseekService(
      {} as never,
      {} as never,
      { foldseekBaseUrl: 'https://foldseek.test' } as never,
    );
    fetchTextMock.mockResolvedValue('data_1CRN');
  });

  it('returns the two globally highest-scoring hits for limit 2, regardless of database', async () => {
    routeFoldseek(QUERIES_1CRN, { 0: RESULT_1CRN_Q0 });

    const result = (await runToolContract(findSimilar, {
      by: 'structure',
      pdb_id: '1CRN',
      limit: 2,
    })) as StructureResult;

    expect(result.structuredContent.hits).toMatchObject([
      { id: '1CRN', score: 357, database: 'pdb100' },
      { id: '1EJG', score: 352, database: 'pdb100' },
    ]);
    expect(result.structuredContent).toMatchObject({
      totalCount: 6,
      start: 0,
      nextStart: 2,
      query: 0,
      queryCount: 1,
    });
    const text = renderedText(result);
    expect(text.indexOf('### 1CRN')).toBeGreaterThan(-1);
    expect(text.indexOf('### 1CRN')).toBeLessThan(text.indexOf('### 1EJG'));
    expect(text).not.toContain('P01541');
  });

  it('never repeats a hit across pages of the same ticket', async () => {
    routeFoldseek(QUERIES_1CRN, { 0: RESULT_1CRN_Q0 });
    const ids: string[] = [];
    for (const start of [0, 2, 4]) {
      const out = await findSimilar.handler(
        findSimilar.input.parse({ by: 'structure', ticket_id: 'live-shaped', start, limit: 2 }),
        ctx(),
      );
      ids.push(...out.hits.map((h) => h.id));
    }
    expect(ids).toEqual(['1CRN', '1EJG', '3NIR', 'P01541', 'A0A1J3H3C1', 'A0A7J6GU35']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ranks within the selected query only and reports the ticket query count', async () => {
    routeFoldseek(QUERIES_4HHB, { 0: RESULT_4HHB_Q0, 1: RESULT_4HHB_Q1 });

    const result = (await runToolContract(findSimilar, {
      by: 'structure',
      pdb_id: '4HHB',
      query: 1,
    })) as StructureResult;

    expect(result.structuredContent.hits.map((h) => h.id)).toEqual([
      '1O1K',
      '2DN2',
      'A0A8D8CFN8',
      'A0A1K0GGI2',
    ]);
    expect(result.structuredContent).toMatchObject({ query: 1, queryCount: 4, totalCount: 4 });
  });

  it('surfaces an out-of-range query as a typed error instead of an empty result', async () => {
    routeFoldseek(QUERIES_4HHB, { 0: RESULT_4HHB_Q0 });

    const result = (await runToolContract(findSimilar, {
      by: 'structure',
      pdb_id: '4HHB',
      query: 4,
    })) as {
      isError?: boolean;
      structuredContent: { error: { code: number; data: { reason: string } } };
    };

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'query_out_of_range' },
    });
  });
});

describe('protein_find_similar — per-mode field rejection (#57)', () => {
  it.each([
    ['sequence', { sequence: 'MVLS' }],
    ['max_evalue', { max_evalue: 0.001 }],
    ['min_identity', { min_identity: 0.9 }],
  ])('rejects %s under by:"structure", naming the accepting mode', async (_field, extra) => {
    await expect(
      findSimilar.handler(
        findSimilar.input.parse({ by: 'structure', pdb_id: '4HHB', ...extra }),
        ctx(),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: {
        reason: 'mode_mismatched_field',
        recovery: { hint: expect.stringContaining('by:"sequence"') },
      },
    });
    // Rejected before mode dispatch — no coordinate fetch, no Foldseek job.
    expect(fetchTextMock).not.toHaveBeenCalled();
    expect(foldseekSearch).not.toHaveBeenCalled();
  });

  it.each([
    ['ticket_id', { ticket_id: 'tkt-1' }],
    ['databases', { databases: ['afdb-swissprot'] }],
    ['query', { query: 1 }],
    ['query (zero)', { query: 0 }],
  ])('rejects %s under by:"sequence", naming the accepting mode', async (_field, extra) => {
    await expect(
      findSimilar.handler(
        findSimilar.input.parse({ by: 'sequence', sequence: 'MVLS', ...extra }),
        ctx(),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: {
        reason: 'mode_mismatched_field',
        recovery: { hint: expect.stringContaining('by:"structure"') },
      },
    });
    expect(searchSequence).not.toHaveBeenCalled();
  });

  it('names every offending field in one rejection', async () => {
    await expect(
      findSimilar.handler(
        findSimilar.input.parse({
          by: 'structure',
          pdb_id: '4HHB',
          sequence: 'MVLS',
          max_evalue: 0.01,
          min_identity: 0.5,
        }),
        ctx(),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('sequence, max_evalue, min_identity'),
    });
  });

  it('treats an empty databases array as omitted under either mode', async () => {
    searchSequence.mockResolvedValue({ total: 0, hits: [] });
    getEntries.mockResolvedValue([]);
    await findSimilar.handler(
      findSimilar.input.parse({ by: 'sequence', sequence: 'MVLS', databases: [] }),
      ctx(),
    );
    expect(searchSequence).toHaveBeenCalled();

    fetchTextMock.mockResolvedValue('ATOM ...');
    foldseekSearch.mockResolvedValue({ status: 'complete', ticketId: 't', total: 0, hits: [] });
    await findSimilar.handler(
      findSimilar.input.parse({ by: 'structure', pdb_id: '4HHB', databases: [] }),
      ctx(),
    );
    // runStructure's own empty-array fallback still supplies the defaults.
    expect(foldseekSearch.mock.calls[0]?.[0]).toMatchObject({
      databases: ['pdb100', 'afdb50'],
    });
  });

  it('never reads start — any offset passes the guard in both modes', async () => {
    searchSequence.mockResolvedValue({ total: 0, hits: [] });
    getEntries.mockResolvedValue([]);
    await findSimilar.handler(
      findSimilar.input.parse({ by: 'sequence', sequence: 'MVLS', start: 50 }),
      ctx(),
    );
    expect(searchSequence.mock.calls[0]?.[1]).toMatchObject({ start: 50 });

    fetchTextMock.mockResolvedValue('ATOM ...');
    foldseekSearch.mockResolvedValue({ status: 'complete', ticketId: 't', total: 0, hits: [] });
    await findSimilar.handler(
      findSimilar.input.parse({ by: 'structure', pdb_id: '4HHB', start: 50 }),
      ctx(),
    );
    expect(foldseekSearch.mock.calls[0]?.[0]).toMatchObject({ start: 50 });
  });

  it('leaves the shared pdb_id / uniprot / limit fields unaffected in both modes', async () => {
    getSequence.mockResolvedValue({ entityId: '4HHB_1', sequence: 'MVLSPADK' });
    searchSequence.mockResolvedValue({ total: 0, hits: [] });
    getEntries.mockResolvedValue([]);
    await findSimilar.handler(
      findSimilar.input.parse({ by: 'sequence', pdb_id: '4HHB', limit: 7 }),
      ctx(),
    );
    expect(searchSequence.mock.calls[0]?.[1]).toMatchObject({ limit: 7 });

    getPrediction.mockResolvedValue({ uniprotAccession: 'P69905', pdbUrl: 'https://af/x.pdb' });
    fetchTextMock.mockResolvedValue('ATOM ...');
    foldseekSearch.mockResolvedValue({ status: 'complete', ticketId: 't', total: 0, hits: [] });
    await findSimilar.handler(
      findSimilar.input.parse({ by: 'structure', uniprot: 'P69905', limit: 7 }),
      ctx(),
    );
    expect(foldseekSearch.mock.calls[0]?.[0]).toMatchObject({ limit: 7 });
  });
});

describe('protein_find_similar — error envelope on both client surfaces', () => {
  /** The contract's declared recovery for a reason — what `ctx.recoveryFor` forwards. */
  const declaredRecovery = (reason: string) =>
    findSimilar.errors?.find((e) => e.reason === reason)?.recovery;

  type ErrorResult = {
    isError?: boolean;
    structuredContent: {
      error: { code: number; data: { reason: string; recovery: { hint: string } } };
    };
    content: Array<{ text: string }>;
  };

  interface ErrorCase {
    code: JsonRpcErrorCode;
    /** Declared recovery text, or an asymmetric matcher for a runtime-built hint. */
    hint: unknown;
    input: z.input<typeof findSimilar.input>;
    name: string;
    reason: string;
    setup?: () => void;
    /** The closing reason/retryable term line of the content[] text. */
    terms: string;
  }

  it.each<ErrorCase>([
    {
      name: 'missing_query (by:sequence, no source)',
      input: { by: 'sequence' },
      code: JsonRpcErrorCode.InvalidParams,
      reason: 'missing_query',
      hint: declaredRecovery('missing_query'),
      terms: '(reason missing_query)',
    },
    {
      name: 'missing_query (by:structure, no identifier)',
      input: { by: 'structure' },
      code: JsonRpcErrorCode.InvalidParams,
      reason: 'missing_query',
      hint: expect.stringContaining('Provide pdb_id (e.g. 1CRN) or uniprot'),
      terms: '(reason missing_query)',
    },
    {
      name: 'mode_mismatched_field',
      input: { by: 'structure', pdb_id: '4HHB', sequence: 'MVLS' },
      code: JsonRpcErrorCode.InvalidParams,
      reason: 'mode_mismatched_field',
      hint: expect.stringContaining('only read under by:"sequence"'),
      terms: '(reason mode_mismatched_field)',
    },
    {
      name: 'no_sequence',
      input: { by: 'sequence', pdb_id: '1ABC' },
      setup: () => getSequence.mockResolvedValue(null),
      code: JsonRpcErrorCode.NotFound,
      reason: 'no_sequence',
      hint: declaredRecovery('no_sequence'),
      terms: '(reason no_sequence)',
    },
    {
      name: 'search_failed',
      input: { by: 'structure', pdb_id: '4HHB' },
      setup: () => {
        fetchTextMock.mockResolvedValue('ATOM ...');
        foldseekSearch.mockResolvedValue({ status: 'failed', error: 'bad coordinates' });
      },
      code: JsonRpcErrorCode.ServiceUnavailable,
      reason: 'search_failed',
      hint: expect.stringContaining('Retry shortly'),
      terms: '(reason search_failed · retryable)',
    },
    {
      name: 'ticket_not_found',
      input: { by: 'structure', ticket_id: 'bogus' },
      setup: () => foldseekResume.mockResolvedValue({ status: 'not_found', ticketId: 'bogus' }),
      code: JsonRpcErrorCode.NotFound,
      reason: 'ticket_not_found',
      hint: declaredRecovery('ticket_not_found'),
      terms: '(reason ticket_not_found)',
    },
    {
      name: 'query_out_of_range',
      input: { by: 'structure', ticket_id: 'tkt-4hhb', query: 9 },
      setup: () =>
        foldseekResume.mockResolvedValue({
          status: 'query_out_of_range',
          ticketId: 'tkt-4hhb',
          query: 9,
          queryCount: 4,
        }),
      code: JsonRpcErrorCode.InvalidParams,
      reason: 'query_out_of_range',
      hint: expect.stringContaining('query between 0 and 3'),
      terms: '(reason query_out_of_range)',
    },
  ])('$name carries reason and recovery hint on structuredContent and content[]', async (c) => {
    c.setup?.();
    const result = (await runToolContract(findSimilar, c.input)) as ErrorResult;

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({
      code: c.code,
      data: { reason: c.reason, recovery: { hint: c.hint } },
    });
    const hint = result.structuredContent.error.data.recovery.hint;
    expect(hint).toBeTruthy();
    const text = result.content.map((block) => block.text).join('\n');
    expect(text).toContain(`Recovery: ${hint}`);
    expect(text).toContain(c.terms);
  });
});

describe('protein_find_similar — format', () => {
  it('renders the engine header, ticket line, and per-hit scores', () => {
    const blocks = findSimilar.format!({
      by: 'structure',
      engine: 'Foldseek',
      status: 'computing',
      ticketId: 'tkt-1',
      hits: [
        {
          id: '2HHB',
          entityId: '2HHB_1',
          source: 'experimental',
          score: 800,
          evalue: 1e-30,
          database: 'pdb100',
          title: 'Deoxyhaemoglobin',
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('## Foldseek (by:structure) — computing');
    expect(text).toContain('**Ticket:** tkt-1');
    expect(text).toContain('### 2HHB _(experimental)_');
    expect(text).toContain('**Entity:** 2HHB_1');
    expect(text).toContain('Deoxyhaemoglobin');
    expect(text).toContain('**DB:** pdb100');
  });
});
