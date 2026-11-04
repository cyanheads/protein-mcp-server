/**
 * @fileoverview Tests for protein_find_similar: the by:sequence path (direct
 * sequence, PDB-derived, UniProt-derived; metadata enrichment; empty-result
 * notice; no_sequence failure), the by:structure path (Foldseek complete /
 * computing / failed, predicted-source mapping, completed-job paging via
 * totalCount / start / nextStart and a re-usable ticketId), query selection on
 * multichain jobs (query / queryCount, the multi-query notice, out-of-range
 * rejection), the combined cross-database ranking run through the real Foldseek
 * service over captured payloads, the `databases` enum and a refused submit
 * (databases_rejected), structure hit fields (target, chain, title, organisms,
 * taxId, probability, aligned span, queryLength) through the real service, the
 * matched entity's organisms on sequence hits, the missing_query guard, the per-mode field
 * rejection, UniProtKB entry names on `uniprot` in both modes, the call budget
 * (a stalled chain, and a job Foldseek accepted before the budget ran out
 * returned as computing with its ticket), the error envelope each declared
 * reason produces on both client surfaces, and format(). Services, HTTP, and the
 * coordinate-file fetch are mocked.
 * @module tests/tools/find-similar.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
const resolveAccession = vi.fn();
const fakeUniProt = { getSequence: getUniProtSequence, resolveAccession };
/** Swapped for a real UniProtService where a test exercises how the service classifies an entry name. */
let uniprotImpl: object = fakeUniProt;
// The inactive-accession error and merge notice are the real helpers; only the lookup is faked.
vi.mock('@/services/uniprot/uniprot-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/uniprot/uniprot-service.js')>()),
  getUniProtService: () => uniprotImpl,
}));

const findPrediction = vi.fn();
vi.mock('@/services/alphafold/alphafold-service.js', () => ({
  getAlphaFoldService: () => ({ findPrediction }),
}));

vi.mock('@/services/shared/http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/shared/http.js')>();
  return { ...actual, fetchJson: vi.fn(), fetchTextWindow: vi.fn() };
});

import { getServerConfig } from '@/config/server-config.js';
import { findSimilar } from '@/mcp-server/tools/definitions/find-similar.tool.js';
import { FoldseekService } from '@/services/foldseek/foldseek-service.js';
import { fetchJson, fetchTextWindow } from '@/services/shared/http.js';
import { entryIdOf } from '@/services/shared/identifiers.js';
import { inactiveAccessionError, UniProtService } from '@/services/uniprot/uniprot-service.js';
import {
  QUERIES_1CRN,
  QUERIES_4HHB,
  RESULT_1CRN_PER_DB,
  RESULT_1CRN_Q0,
  RESULT_4HHB_Q0,
  RESULT_4HHB_Q0_CHAINS,
  RESULT_4HHB_Q1,
  RESULT_EMPTY_QUERY,
} from '../fixtures/foldseek-captures.js';

const fetchJsonMock = vi.mocked(fetchJson);
const fetchTextWindowMock = vi.mocked(fetchTextWindow);
const ctx = () => createMockContext({ errors: findSimilar.errors });

/** Serve a whole coordinate file through the bounded read: the body ended inside the window. */
const serveCoordinates = (text: string) =>
  fetchTextWindowMock.mockResolvedValue({ more: false, text, totalLength: text.length });

/** The RCSB entry lookup selecting one protein entity, with the entry's other protein entities. */
const foundEntity = (
  entityId: string,
  sequence: string,
  chains: string[] = ['A'],
  otherEntities: Array<{ entityId: string; chains: string[]; length: number }> = [],
) => ({
  kind: 'found',
  entity: { entityId, chains, length: sequence.length },
  sequence,
  otherEntities,
});

/** The nine per-hit alignment fields a verbose RCSB sequence search reports. */
const ALIGNMENT_FIELDS = [
  'identity',
  'evalue',
  'bitscore',
  'alignmentLength',
  'queryStart',
  'queryEnd',
  'targetStart',
  'targetEnd',
  'targetLength',
] as const;

/** The AlphaFold lookup finding a model for `uniprotAccession`. */
const foundModel = (uniprotAccession: string, pdbUrl: string, mergedFrom?: string) => ({
  kind: 'found',
  model: { uniprotAccession, pdbUrl },
  ...(mergedFrom ? { mergedFrom } : {}),
});

/** The `databases` input as a caller sends it. */
type FoldseekDatabaseInput = NonNullable<z.input<typeof findSimilar.input>['databases']>;

/** One normalized Foldseek PDB hit, as the service hands it to the tool. */
const PDB_HIT = {
  target: '2hhb-assembly1.cif.gz_A',
  database: 'pdb100',
  source: 'experimental' as const,
  id: '2HHB',
  chain: 'A',
  score: 800,
};

beforeEach(() => {
  vi.clearAllMocks();
  foldseekImpl = fakeFoldseek;
  uniprotImpl = fakeUniProt;
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
  it.each(['direct', 'pdb', 'uniprot'])(
    'normalizes the %s sequence source and preserves precedence/fallback (#77)',
    async (source) => {
      searchSequence.mockResolvedValue({ total: 0, hits: [] });
      getSequence.mockResolvedValue(foundEntity('4HHB_1', ' abou xzcdef\n'));
      getUniProtSequence.mockResolvedValue({ accession: 'P69905', sequence: ' abou xzcdef\n' });
      const input =
        source === 'direct'
          ? { sequence: ' abou xzcdef\n', pdb_id: '4HHB', uniprot: 'P69905' }
          : source === 'pdb'
            ? { sequence: '', pdb_id: '4HHB', uniprot: 'P69905' }
            : { uniprot: 'P69905' };
      const result = await runToolContract(findSimilar, { by: 'sequence', ...input });
      expect(result.isError).not.toBe(true);
      expect(searchSequence.mock.calls[0]?.[0]).toBe('ABOUXZCDEF');
      if (source === 'direct') expect(getSequence).not.toHaveBeenCalled();
      if (source !== 'uniprot') expect(getUniProtSequence).not.toHaveBeenCalled();
      expect(result.structuredContent).toMatchObject({ hits: [], status: 'complete' });
      expect(JSON.stringify(result.content)).toContain('No sequence-similar entries found');
    },
  );

  it.each([' ', 'ACDEFGHIK', 'ACDEFGHIKJ', 'ACDEFGHIK*'])(
    'declares actionable invalid-sequence errors on both surfaces for %j (#77)',
    async (sequence) => {
      const result = await runToolContract(findSimilar, { by: 'sequence', sequence });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: -32602,
          data: {
            reason: 'invalid_sequence',
            recovery: { hint: expect.stringContaining('at least 10') },
          },
        },
      });
      expect(JSON.stringify(result.content)).toContain('invalid_sequence');
      expect(JSON.stringify(result.content)).toMatch(/normalized length/i);
      expect(searchSequence).not.toHaveBeenCalled();
    },
  );
  it('searches a directly-supplied sequence and enriches hits with entry metadata', async () => {
    searchSequence.mockResolvedValue({ total: 42, hits: [{ id: '4HHB_1', score: 1 }] });
    getEntries.mockResolvedValue([
      {
        id: '4HHB',
        title: 'Deoxyhaemoglobin',
        organisms: ['Homo sapiens'],
        polymerEntities: [{ entityId: '4HHB_1', organisms: ['Homo sapiens'] }],
        ligands: [],
      },
    ]);
    const c = ctx();
    const out = await findSimilar.handler(
      findSimilar.input.parse({ by: 'sequence', sequence: 'MVL SPA DKTN' }),
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
      organisms: ['Homo sapiens'],
    });
    // This hit's sequence entry carried no match context, so it gets none of the
    // alignment fields and the response no queryLength — nothing is defaulted.
    for (const field of ALIGNMENT_FIELDS) expect(out.hits[0]).not.toHaveProperty(field);
    expect(out).not.toHaveProperty('queryLength');
    // Whitespace is stripped before the sequence search.
    expect(searchSequence.mock.calls[0]?.[0]).toBe('MVLSPADKTN');
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
      findSimilar.input.parse({ by: 'sequence', sequence: 'MVLSPADKTN' }),
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
      findSimilar.input.parse({ by: 'sequence', sequence: 'MVLSPADKTN' }),
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
        polymerEntities: [{ entityId: `${id}_1`, organisms: ['Test organism'] }],
        ligands: [],
      })),
    );

    const out = await findSimilar.handler(
      findSimilar.input.parse({ by: 'sequence', sequence: 'MVLSPADKTN', limit: count }),
      ctx(),
    );

    expect(getEntries.mock.calls[0]?.[0]).toHaveLength(count);
    expect(out.hits[count - 1]).toMatchObject({
      title: `Title ${String(count - 1).padStart(3, '0')}A`,
      organisms: ['Test organism'],
    });
  });

  it('reports the matched entity’s organisms, not the entry’s, on both surfaces (#85)', async () => {
    // 7BZ5_1 is the SARS-CoV-2 spike; the entry's antibody chains are human.
    searchSequence.mockResolvedValue({ total: 1, hits: [{ id: '7BZ5_1', score: 1 }] });
    getEntries.mockResolvedValue([
      {
        id: '7BZ5',
        title: 'COVID-19 spike receptor-binding domain complexed with a neutralizing antibody',
        organisms: ['Severe acute respiratory syndrome coronavirus 2', 'Homo sapiens'],
        polymerEntities: [
          { entityId: '7BZ5_1', organisms: ['Severe acute respiratory syndrome coronavirus 2'] },
          { entityId: '7BZ5_2', organisms: ['Homo sapiens'] },
          { entityId: '7BZ5_3', organisms: ['Homo sapiens'] },
        ],
        ligands: [],
      },
    ]);

    const result = (await runToolContract(findSimilar, {
      by: 'sequence',
      sequence: 'MVLSPADKTN',
    })) as {
      structuredContent: { hits: Array<Record<string, unknown>> };
      content: Array<{ text: string }>;
    };

    expect(result.structuredContent.hits[0]).toMatchObject({
      id: '7BZ5',
      entityId: '7BZ5_1',
      organisms: ['Severe acute respiratory syndrome coronavirus 2'],
    });
    expect(result.structuredContent.hits[0]).not.toHaveProperty('organism');
    const text = result.content.map((block) => block.text).join('\n');
    expect(text).toContain('**Organisms:** Severe acute respiratory syndrome coronavirus 2');
    expect(text).not.toContain('Homo sapiens');
  });

  it('omits organisms when the matched entity is missing from the entry metadata (#85)', async () => {
    searchSequence.mockResolvedValue({ total: 1, hits: [{ id: '7BZ5_4', score: 1 }] });
    getEntries.mockResolvedValue([
      {
        id: '7BZ5',
        title: 'COVID-19 spike receptor-binding domain complexed with a neutralizing antibody',
        organisms: ['Severe acute respiratory syndrome coronavirus 2', 'Homo sapiens'],
        polymerEntities: [
          { entityId: '7BZ5_1', organisms: ['Severe acute respiratory syndrome coronavirus 2'] },
        ],
        ligands: [],
      },
    ]);

    const result = (await runToolContract(findSimilar, {
      by: 'sequence',
      sequence: 'MVLSPADKTN',
    })) as {
      structuredContent: { hits: Array<Record<string, unknown>> };
      content: Array<{ text: string }>;
    };

    expect(result.structuredContent.hits[0]).toMatchObject({ id: '7BZ5', entityId: '7BZ5_4' });
    expect(result.structuredContent.hits[0]).not.toHaveProperty('organisms');
    expect(result.content.map((block) => block.text).join('\n')).not.toContain('**Organisms:**');
  });

  it('preserves sparse metadata and fails the whole call when metadata enrichment fails', async () => {
    searchSequence.mockResolvedValue({ total: 1, hits: [{ id: '1A00_1', score: 1 }] });
    getEntries.mockResolvedValue([{ id: '1A00', organisms: [], polymerEntities: [], ligands: [] }]);
    const sparse = await findSimilar.handler(
      findSimilar.input.parse({ by: 'sequence', sequence: 'MVLSPADKTN' }),
      ctx(),
    );
    expect(sparse.hits[0]).not.toHaveProperty('title');
    expect(sparse.hits[0]).not.toHaveProperty('organisms');

    getEntries.mockRejectedValue(new Error('metadata unavailable'));
    await expect(
      findSimilar.handler(
        findSimilar.input.parse({ by: 'sequence', sequence: 'MVLSPADKTN' }),
        ctx(),
      ),
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
      sequence: 'MVLSPADKTN',
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
        findSimilar.input.parse({ by: 'sequence', sequence: 'MVLSPADKTN', start, limit: 5 }),
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
    getSequence.mockResolvedValue(foundEntity('4HHB_1', 'MVLSPADKTN'));
    // An empty first page means the search matched nothing, so the upstream total is 0.
    searchSequence.mockResolvedValue({ total: 0, hits: [] });
    getEntries.mockResolvedValue([]);
    const c = ctx();
    await findSimilar.handler(findSimilar.input.parse({ by: 'sequence', pdb_id: '4hhb' }), c);
    expect(getSequence).toHaveBeenCalledWith('4hhb', undefined, expect.anything());
    expect(searchSequence.mock.calls[0]?.[0]).toBe('MVLSPADKTN');
    expect(String(getEnrichment(c).notice)).toMatch(/^No sequence-similar entries found/);
  });

  it('derives the query sequence from a UniProt accession', async () => {
    getUniProtSequence.mockResolvedValue({ accession: 'P69905', sequence: 'MKTAYIAKQR' });
    searchSequence.mockResolvedValue({ total: 0, hits: [] });
    getEntries.mockResolvedValue([]);
    const c = ctx();
    await findSimilar.handler(findSimilar.input.parse({ by: 'sequence', uniprot: 'P69905' }), c);
    expect(searchSequence.mock.calls[0]?.[0]).toBe('MKTAYIAKQR');
    expect(String(getEnrichment(c).notice)).toMatch(/^No sequence-similar entries found/);
  });

  it('notes an empty result set', async () => {
    searchSequence.mockResolvedValue({ total: 0, hits: [] });
    getEntries.mockResolvedValue([]);
    const c = ctx();
    const out = await findSimilar.handler(
      findSimilar.input.parse({ by: 'sequence', sequence: 'XXXXXXXXXX' }),
      c,
    );
    expect(out.hits).toEqual([]);
    expect(String(getEnrichment(c).notice)).toMatch(/min_identity|max_evalue|No sequence-similar/i);
  });

  it('names the offset on a past-end sequence page instead of claiming no matches, on both surfaces (#66)', async () => {
    getUniProtSequence.mockResolvedValue({ accession: 'P69905', sequence: 'MVLSPADKTN' });
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
      findSimilar.input.parse({ by: 'sequence', sequence: 'XXXXXXXXXX', start: 40 }),
      c,
    );
    expect(String(getEnrichment(c).notice)).toBe(
      'No sequence-similar entries found. Lower min_identity or raise max_evalue.',
    );
  });

  it.each([
    ['holds no protein entity', { kind: 'no_protein' }, /1BNA has no protein polymer entity/],
    ['does not exist', { kind: 'entry_not_found' }, /RCSB has no PDB entry 1BNA/],
  ])(
    'throws no_sequence before any search request when the PDB entry %s (#84)',
    async (_case, lookup, message) => {
      getSequence.mockResolvedValue(lookup);
      await expect(
        findSimilar.handler(findSimilar.input.parse({ by: 'sequence', pdb_id: '1bna' }), ctx()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'no_sequence' },
        message: expect.stringMatching(message),
      });
      expect(searchSequence).not.toHaveBeenCalled();
    },
  );

  it('throws missing_query (with its declared recovery hint) when no sequence source is provided', async () => {
    const result = (await runToolContract(findSimilar, { by: 'sequence' })) as {
      isError?: boolean;
      structuredContent: { error: { data: { reason: string; recovery?: { hint: string } } } };
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({
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
        sequence: 'MVLSPADKTN',
        max_evalue: 0.001,
        min_identity: 0.6,
      }),
      ctx(),
    );
    expect(searchSequence.mock.calls[0]?.[1]).toMatchObject({ maxEvalue: 0.001, minIdentity: 0.6 });
  });
});

/** A tool result as runToolContract returns it, success or error. */
type ContractResult = {
  isError?: boolean;
  structuredContent: Record<string, unknown> & {
    error?: {
      code: number;
      message: string;
      data: Record<string, unknown> & { reason: string; recovery?: { hint: string } };
    };
    hits?: Array<Record<string, unknown>>;
    notice?: string;
  };
  content: Array<{ text: string }>;
};

const run = async (input: z.input<typeof findSimilar.input>) =>
  (await runToolContract(findSimilar, input)) as ContractResult;

const textOf = (result: ContractResult) => result.content.map((block) => block.text).join('\n');

describe('protein_find_similar — the protein entity a PDB-derived query comes from (#84)', () => {
  const ALPHA = 'VLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTTKTYFPHFDLS';
  const BETA = 'VHLTPEEKSAVTALWGKVNVDEVGGEALGRLLVVYPWTQRFFESFGDLS';

  beforeEach(() => {
    searchSequence.mockResolvedValue({ total: 1, hits: [{ id: '2DN2_1', score: 1 }] });
    getEntries.mockResolvedValue([]);
  });

  it('searches the selected entity’s sequence and names it as queryEntityId on both surfaces', async () => {
    getSequence.mockResolvedValue(foundEntity('1TSR_3', ALPHA, ['A', 'B', 'C']));
    const result = await run({ by: 'sequence', pdb_id: '1TSR' });

    expect(result.isError).not.toBe(true);
    expect(searchSequence.mock.calls[0]?.[0]).toBe(ALPHA);
    expect(result.structuredContent.queryEntityId).toBe('1TSR_3');
    expect(textOf(result)).toContain('**Query entity:** 1TSR_3');
    // One protein entity: there is no other to point the caller at.
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('passes chain to the entry lookup trimmed, with its case kept', async () => {
    getSequence.mockResolvedValue(foundEntity('4HHB_2', BETA, ['B', 'D']));
    const result = await run({ by: 'sequence', pdb_id: '4HHB', chain: ' B ' });

    expect(getSequence).toHaveBeenCalledWith('4HHB', 'B', expect.anything());
    expect(result.structuredContent.queryEntityId).toBe('4HHB_2');
  });

  it('notes the searched entity and the other protein entities’ chains when chain is omitted', async () => {
    getSequence.mockResolvedValue(
      foundEntity(
        '1A5H_2',
        ALPHA,
        ['A', 'B'],
        [{ entityId: '1A5H_1', chains: ['C', 'D'], length: 7 }],
      ),
    );
    const result = await run({ by: 'sequence', pdb_id: '1A5H' });

    const notice = String(result.structuredContent.notice);
    expect(notice).toContain('Searched 1A5H_2 (chains A, B)');
    expect(notice).toContain('1A5H_1 (chains C, D; 7 residues)');
    expect(notice).toContain('Pass chain');
    expect(textOf(result)).toContain('1A5H_1 (chains C, D; 7 residues)');
  });

  it('joins the entity notice with the empty-page notice', async () => {
    searchSequence.mockResolvedValue({ total: 0, hits: [] });
    getSequence.mockResolvedValue(
      foundEntity(
        '4HHB_1',
        ALPHA,
        ['A', 'C'],
        [{ entityId: '4HHB_2', chains: ['B', 'D'], length: 146 }],
      ),
    );
    const notice = String((await run({ by: 'sequence', pdb_id: '4HHB' })).structuredContent.notice);

    expect(notice).toContain('No sequence-similar entries found.');
    expect(notice).toContain('Searched 4HHB_1 (chains A, C)');
    expect(notice).toContain('4HHB_2 (chains B, D; 146 residues)');
  });

  it('adds no entity notice when chain is given, even with other protein entities', async () => {
    getSequence.mockResolvedValue(
      foundEntity(
        '4HHB_2',
        BETA,
        ['B', 'D'],
        [{ entityId: '4HHB_1', chains: ['A', 'C'], length: 141 }],
      ),
    );
    const result = await run({ by: 'sequence', pdb_id: '4HHB', chain: 'D' });

    expect(result.structuredContent.queryEntityId).toBe('4HHB_2');
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('fails chain_not_found listing the protein author chains in entity order, before any search', async () => {
    getSequence.mockResolvedValue({
      kind: 'chain_not_found',
      proteinEntities: [
        { entityId: '4HHB_1', chains: ['A', 'C'], length: 141 },
        { entityId: '4HHB_2', chains: ['B', 'D'], length: 146 },
      ],
    });
    const result = await run({ by: 'sequence', pdb_id: '4HHB', chain: 'b' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: expect.stringContaining('"b"'),
      data: {
        reason: 'chain_not_found',
        recovery: { hint: expect.stringContaining('A, C, B, D') },
      },
    });
    expect(textOf(result)).toContain('A, C, B, D');
    expect(searchSequence).not.toHaveBeenCalled();
  });

  it.each([
    ['a raw sequence', { sequence: 'MVLSPADKTN' }],
    ['a UniProt accession', { uniprot: 'P69905' }],
    ['no other source', {}],
  ])(
    'fails chain_without_pdb_id for chain alongside %s, before any request',
    async (_case, source) => {
      const result = await run({ by: 'sequence', chain: 'A', ...source });

      expect(result.structuredContent.error).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'chain_without_pdb_id' },
      });
      expect(getSequence).not.toHaveBeenCalled();
      expect(getUniProtSequence).not.toHaveBeenCalled();
      expect(searchSequence).not.toHaveBeenCalled();
    },
  );

  it('treats a blank chain as omitted', async () => {
    const result = await run({ by: 'sequence', sequence: 'MVLSPADKTN', chain: '  ' });
    expect(result.isError).not.toBe(true);
    expect(searchSequence).toHaveBeenCalledTimes(1);
  });

  it('searches a direct sequence as given alongside pdb_id and chain, with no entity lookup', async () => {
    const result = await run({
      by: 'sequence',
      sequence: 'MVLSPADKTN',
      pdb_id: '4HHB',
      chain: 'B',
    });

    expect(getSequence).not.toHaveBeenCalled();
    expect(searchSequence.mock.calls[0]?.[0]).toBe('MVLSPADKTN');
    expect(result.structuredContent).not.toHaveProperty('queryEntityId');
    expect(textOf(result)).not.toContain('**Query entity:**');
  });

  it('carries no queryEntityId on a UniProt-sourced search', async () => {
    getUniProtSequence.mockResolvedValue({ accession: 'P69905', sequence: ALPHA });
    const result = await run({ by: 'sequence', uniprot: 'P69905' });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).not.toHaveProperty('queryEntityId');
  });

  it.each([
    ['chain naming a 7-residue peptide', 'C', foundEntity('1A5H_1', 'TCGLRQY', ['C', 'D'])],
    ['every protein entity under 10 residues', undefined, foundEntity('1A3I_1', 'PPGPPGPPG')],
  ])('fails invalid_sequence for %s, before any search', async (_case, chain, lookup) => {
    getSequence.mockResolvedValue(lookup);
    const result = await run({ by: 'sequence', pdb_id: '1A5H', ...(chain ? { chain } : {}) });

    expect(result.structuredContent.error).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_sequence' },
    });
    expect(searchSequence).not.toHaveBeenCalled();
  });
});

describe('protein_find_similar — UniProt accessions under by:"sequence" (#83, #91)', () => {
  beforeEach(() => {
    searchSequence.mockResolvedValue({ total: 1, hits: [{ id: '2DN2_1', score: 1 }] });
    getEntries.mockResolvedValue([]);
  });

  it('searches the successor of a merged accession and names the merge on both surfaces', async () => {
    getUniProtSequence.mockResolvedValue({
      accession: 'P69905',
      sequence: 'MVLSPADKTNVKAAWG',
      mergedFrom: 'Q1HDT5',
    });
    const result = await run({ by: 'sequence', uniprot: 'Q1HDT5' });

    expect(getUniProtSequence).toHaveBeenCalledWith('Q1HDT5', expect.anything());
    expect(searchSequence.mock.calls[0]?.[0]).toBe('MVLSPADKTNVKAAWG');
    expect(result.structuredContent.notice).toContain('Q1HDT5 was merged into P69905');
    expect(textOf(result)).toContain('Q1HDT5 was merged into P69905');
  });

  it('fails inactive_accession with the replacements for a demerged accession, before any search', async () => {
    getUniProtSequence.mockRejectedValue(
      inactiveAccessionError({
        accession: 'P62988',
        inactiveReason: 'DEMERGED',
        replacements: ['P0CG47', 'P0CG48', 'P62979', 'P62987'],
      }),
    );
    const result = await run({ by: 'sequence', uniprot: 'P62988' });

    expect(result.structuredContent.error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: expect.stringContaining('P0CG47, P0CG48, P62979, P62987'),
      data: {
        reason: 'inactive_accession',
        inactiveReason: 'DEMERGED',
        replacements: ['P0CG47', 'P0CG48', 'P62979', 'P62987'],
      },
    });
    expect(textOf(result)).toContain('(reason inactive_accession');
    expect(searchSequence).not.toHaveBeenCalled();
  });

  it.each(['A0A9Z9Z9Z9', 'P04637-99', 'NOSUCH_HUMAN'])(
    'fails no_sequence naming %s when UniProt has no entry for it',
    async (accession) => {
      getUniProtSequence.mockResolvedValue(null);
      const result = await run({ by: 'sequence', uniprot: accession });

      expect(result.structuredContent.error).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        message: expect.stringContaining(accession),
        data: { reason: 'no_sequence' },
      });
      expect(textOf(result)).not.toContain('https://');
      expect(searchSequence).not.toHaveBeenCalled();
    },
  );

  it.each(['NOTANACC', 'P04637-0', '4HHB', 'HBA_HUMANXX', `${'A'.repeat(20)}_HUMAN`])(
    'fails invalid_accession for %j under both modes before any request',
    async (uniprot) => {
      for (const by of ['sequence', 'structure'] as const) {
        const result = await run({ by, uniprot });
        expect(result.structuredContent.error).toMatchObject({
          code: JsonRpcErrorCode.InvalidParams,
          message: expect.stringContaining(uniprot),
          data: { reason: 'invalid_accession' },
        });
        // The message names every form the field takes, the entry name included.
        expect(result.structuredContent.error?.message).toContain('HBA_HUMAN');
      }
      expect(getUniProtSequence).not.toHaveBeenCalled();
      expect(resolveAccession).not.toHaveBeenCalled();
      expect(findPrediction).not.toHaveBeenCalled();
      expect(fetchJsonMock).not.toHaveBeenCalled();
    },
  );

  it('searches an isoform’s own sequence (#91)', async () => {
    const isoform = 'MDDLMLSPDDIEQWFTEDPGPDEAPRMPEAAPPVAPAPAAPTPAAPAPAPSWPLSSSVPSQKTYQGSYGF';
    getUniProtSequence.mockResolvedValue({ accession: 'P04637-2', sequence: isoform });
    await run({ by: 'sequence', uniprot: 'p04637-2' });

    expect(getUniProtSequence).toHaveBeenCalledWith('P04637-2', expect.anything());
    expect(searchSequence.mock.calls[0]?.[0]).toBe(isoform);
  });
});

describe('protein_find_similar — UniProtKB entry names on uniprot', () => {
  const HBA = 'MVLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTTKTYFPHF';

  /** The real UniProtService, whose upstream reads go through the fetchJson mock. */
  const realUniProt = () =>
    new UniProtService(
      {} as never,
      {} as never,
      {
        uniprotBaseUrl: 'https://uniprot.test',
      } as never,
    );

  /** Answer the one UniProtKB path; any other upstream request fails the test. */
  const serveUniProt = (path: string, body: unknown) =>
    fetchJsonMock.mockImplementation(async (url: string) => {
      if (new URL(url).pathname === path) return body;
      throw new Error(`unexpected upstream request ${url}`);
    });

  /** The `fields` the one UniProt request selected. */
  const requestedFields = () =>
    new URL(String(fetchJsonMock.mock.calls[0]?.[0])).searchParams.get('fields');

  beforeEach(() => {
    searchSequence.mockResolvedValue({ total: 1, hits: [{ id: '2DN2_1', score: 1 }] });
    getEntries.mockResolvedValue([]);
    foldseekSearch.mockResolvedValue({ status: 'complete', ticketId: 't', total: 0, hits: [] });
  });

  it('states the entry-name form where the caller reads the field', () => {
    expect(findSimilar.input.shape.uniprot.description).toContain('HBA_HUMAN');
    const entry = findSimilar.errors?.find((e) => e.reason === 'invalid_accession');
    expect(entry?.when).toContain('HBA_HUMAN');
    expect(entry?.recovery).toContain('HBA_HUMAN');
  });

  it('by:"sequence" searches the sequence of the entry an entry name names, from one request, with no merge notice', async () => {
    uniprotImpl = realUniProt();
    serveUniProt('/uniprotkb/HBA_HUMAN', {
      entryType: 'UniProtKB reviewed (Swiss-Prot)',
      primaryAccession: 'P69905',
      sequence: { length: HBA.length, value: HBA },
    });
    const result = await run({ by: 'sequence', uniprot: ' hba_human ' });

    expect(result.isError).not.toBe(true);
    expect(searchSequence.mock.calls[0]?.[0]).toBe(HBA);
    expect(fetchJsonMock).toHaveBeenCalledOnce();
    expect(requestedFields()).toBe('sequence');
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(textOf(result)).not.toMatch(/merged/i);
    expect(result.structuredContent.hits).toMatchObject([{ id: '2DN2' }]);
    expect(textOf(result)).toContain('### 2DN2');
  });

  it('by:"structure" resolves an entry name to its accession before the AlphaFold DB lookup, with no merge notice', async () => {
    uniprotImpl = realUniProt();
    serveUniProt('/uniprotkb/HBA_HUMAN', { primaryAccession: 'P69905' });
    findPrediction.mockResolvedValue(foundModel('P69905', 'https://af/P69905.pdb'));
    serveCoordinates('ATOM ...');
    const result = await run({ by: 'structure', uniprot: 'HBA_HUMAN' });

    expect(result.isError).not.toBe(true);
    expect(fetchJsonMock).toHaveBeenCalledOnce();
    expect(requestedFields()).toBe('accession');
    expect(findPrediction).toHaveBeenCalledExactlyOnceWith('P69905', expect.anything());
    expect(fetchTextWindowMock.mock.calls[0]?.[0]).toBe('https://af/P69905.pdb');
    expect(foldseekSearch.mock.calls[0]?.[0]).toMatchObject({ fileName: 'P69905.pdb' });
    // Only the empty-result note; nothing reads the entry name as a merge.
    expect(result.structuredContent.notice).toBe(
      'Foldseek returned no fold-similar hits in the selected databases.',
    );
    expect(textOf(result)).not.toMatch(/merged/i);
  });

  it('by:"structure" follows a merged verdict to the successor’s model, with no merge notice', async () => {
    resolveAccession.mockResolvedValue({
      kind: 'merged',
      accession: 'HBA_HUMAN',
      successor: 'P69905',
    });
    findPrediction.mockResolvedValue(foundModel('P69905', 'https://af/P69905.pdb'));
    serveCoordinates('ATOM ...');
    const result = await run({ by: 'structure', uniprot: 'HBA_HUMAN' });

    expect(findPrediction).toHaveBeenCalledExactlyOnceWith('P69905', expect.anything());
    expect(String(result.structuredContent.notice)).not.toMatch(/merged/i);
  });

  it('by:"structure" fails inactive_accession with the replacements for an inactive entry name, before any model lookup', async () => {
    resolveAccession.mockResolvedValue({
      kind: 'inactive',
      accession: 'OLD_HUMAN',
      inactiveReason: 'DEMERGED',
      replacements: ['P0CG47', 'P0CG48'],
    });
    const result = await run({ by: 'structure', uniprot: 'OLD_HUMAN' });

    expect(result.structuredContent.error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'inactive_accession', replacements: ['P0CG47', 'P0CG48'] },
    });
    expect(textOf(result)).toContain('P0CG47, P0CG48');
    expect(findPrediction).not.toHaveBeenCalled();
    expect(fetchTextWindowMock).not.toHaveBeenCalled();
  });

  it('by:"structure" fails no_sequence naming an entry name UniProt does not know, with by:"structure" levers only', async () => {
    resolveAccession.mockResolvedValue({ kind: 'unknown', accession: 'NOSUCH_HUMAN' });
    const result = await run({ by: 'structure', uniprot: 'nosuch_human' });

    expect(resolveAccession).toHaveBeenCalledWith('NOSUCH_HUMAN', expect.anything());
    expect(result.structuredContent.error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: expect.stringContaining('NOSUCH_HUMAN'),
      data: { reason: 'no_sequence' },
    });
    const hint = String(result.structuredContent.error?.data.recovery?.hint);
    expect(hint).toContain('pdb_id');
    expect(hint).not.toMatch(/sequence parameter|raw .*sequence/);
    expect(textOf(result)).toContain(`Recovery: ${hint}`);
    expect(findPrediction).not.toHaveBeenCalled();
  });

  it('by:"structure" asks UniProt nothing for an accession, which goes straight to AlphaFold DB', async () => {
    findPrediction.mockResolvedValue(foundModel('P69905', 'https://af/P69905.pdb'));
    serveCoordinates('ATOM ...');
    await run({ by: 'structure', uniprot: 'P69905' });

    expect(resolveAccession).not.toHaveBeenCalled();
    expect(findPrediction).toHaveBeenCalledExactlyOnceWith('P69905', expect.anything());
  });
});

describe('protein_find_similar — sequence hit alignment (#89)', () => {
  /** The tail hit of the P69905 search (start 1357), as RCSB's verbose response reports it. */
  const TAIL_HIT = {
    id: '2MGE_1',
    score: 0,
    identity: 0.25,
    evalue: 0.0006589,
    bitscore: 42,
    alignmentLength: 148,
    queryStart: 1,
    queryEnd: 142,
    targetStart: 1,
    targetEnd: 148,
    targetLength: 154,
  };

  it('carries the nine alignment fields per hit and queryLength once, on both surfaces', async () => {
    getUniProtSequence.mockResolvedValue({ accession: 'P69905', sequence: 'MVLSPADKTNVKAAWG' });
    searchSequence.mockResolvedValue({ total: 1382, queryLength: 142, hits: [TAIL_HIT] });
    getEntries.mockResolvedValue([]);
    const result = await run({ by: 'sequence', uniprot: 'P69905', start: 1357, limit: 1 });

    const { id: _entityId, ...alignment } = TAIL_HIT;
    expect(result.structuredContent.hits?.[0]).toEqual({
      id: '2MGE',
      entityId: '2MGE_1',
      source: 'experimental',
      ...alignment,
    });
    expect(result.structuredContent.queryLength).toBe(142);
    const text = textOf(result);
    expect(text).toContain('**Query length:** 142');
    expect(text).toContain('**Score:** 0');
    expect(text).toContain('**E-value:** 0.0006589');
    expect(text).toContain('**Bit score:** 42');
    expect(text).toContain('**Identity:** 0.25');
    expect(text).toContain(
      '**Alignment:** length 148 · query 1–142 · target 1–148 · target length 154',
    );
  });

  it('sets only the fields a hit’s match context carried, never defaulting the rest', async () => {
    searchSequence.mockResolvedValue({
      total: 2,
      queryLength: 142,
      hits: [TAIL_HIT, { id: '1A00_1', score: 1, evalue: 1e-50 }],
    });
    getEntries.mockResolvedValue([]);
    const result = await run({ by: 'sequence', sequence: 'MVLSPADKTN' });

    const sparse = result.structuredContent.hits?.[1];
    expect(sparse).toMatchObject({ entityId: '1A00_1', score: 1, evalue: 1e-50 });
    for (const field of ALIGNMENT_FIELDS.filter((f) => f !== 'evalue')) {
      expect(sparse).not.toHaveProperty(field);
    }
  });
});

describe('protein_find_similar — by:structure', () => {
  it('forwards start and reports paging state on a completed structure search (#53)', async () => {
    serveCoordinates('ATOM ...');
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
      serveCoordinates('ATOM ...');
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
    serveCoordinates('ATOM ...');
    foldseekSearch.mockResolvedValue({ status: 'complete', ticketId: 't', total: 179, hits: [] });
    const pastEnd = ctx();
    await findSimilar.handler(
      findSimilar.input.parse({ by: 'structure', pdb_id: '4HHB', start: 500 }),
      pastEnd,
    );
    expect(getEnrichment(pastEnd).notice).toMatch(/start 500 is past the end/);
    expect(getEnrichment(pastEnd).notice).not.toMatch(/selected databases/);

    vi.clearAllMocks();
    serveCoordinates('ATOM ...');
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
          target: 'AF-P69905-F1-model_v6',
          database: 'afdb50',
          source: 'predicted',
          id: 'P69905',
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
    expect(fetchTextWindowMock).not.toHaveBeenCalled();
  });

  it('runs a Foldseek search from a PDB coordinate file and maps hits by source', async () => {
    serveCoordinates('ATOM ...');
    foldseekSearch.mockResolvedValue({
      status: 'complete',
      ticketId: 't1',
      total: 2,
      hits: [
        {
          target: '2hhb-assembly1.cif.gz_A',
          database: 'pdb100',
          source: 'experimental',
          id: '2HHB',
          chain: 'A',
          score: 800,
          evalue: 1e-30,
          sequenceIdentity: 0.87,
        },
        {
          target: 'AF-P69905-F1-model_v6',
          database: 'afdb50',
          source: 'predicted',
          id: 'P69905',
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
    serveCoordinates('ATOM ...');
    foldseekSearch.mockResolvedValue({
      status: 'complete',
      ticketId: 't1',
      total: 2,
      hits: [
        {
          target: '1y45-assembly1.cif.gz_A',
          database: 'pdb100',
          source: 'experimental',
          id: '1Y45',
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
    serveCoordinates('ATOM ...');
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
    serveCoordinates('ATOM ...');
    foldseekSearch.mockResolvedValue({ status: 'failed', error: 'bad coordinates' });
    await expect(
      findSimilar.handler(findSimilar.input.parse({ by: 'structure', pdb_id: '4HHB' }), ctx()),
    ).rejects.toMatchObject({ data: { reason: 'search_failed' } });
  });

  it('keeps the upstream failure text out of the search_failed error on both surfaces', async () => {
    serveCoordinates('ATOM ...');
    const upstream =
      'Fetch failed for https://search.foldseek.test/api/ticket. Status: 502 <html>Bad Gateway</html>';
    foldseekSearch.mockResolvedValue({ status: 'failed', error: upstream });
    const result = await run({ by: 'structure', pdb_id: '4HHB' });

    expect(result.structuredContent.error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'search_failed' },
    });
    const surfaces = JSON.stringify(result.structuredContent) + textOf(result);
    for (const fragment of ['https://', 'Status: 502', 'Bad Gateway']) {
      expect(surfaces).not.toContain(fragment);
    }
  });

  it('uploads the mmCIF file for a PDB ID, which every entry has, including mmCIF-only ones (#61)', async () => {
    serveCoordinates('data_1ABC');
    foldseekSearch.mockResolvedValue({ status: 'complete', ticketId: 't', total: 0, hits: [] });
    await findSimilar.handler(findSimilar.input.parse({ by: 'structure', pdb_id: '1abc' }), ctx());
    expect(fetchTextWindowMock).toHaveBeenCalledTimes(1);
    expect(fetchTextWindowMock.mock.calls[0]?.[0]).toBe('https://files/download/1ABC.cif');
    expect(foldseekSearch.mock.calls[0]?.[0]).toMatchObject({
      fileContent: 'data_1ABC',
      fileName: '1ABC.cif',
    });
    // No metadata lookup is needed to choose the format.
    expect(getEntries).not.toHaveBeenCalled();
  });

  it('derives coordinates from an AlphaFold model when given a UniProt accession', async () => {
    findPrediction.mockResolvedValue(foundModel('P69905', 'https://af/P69905.pdb'));
    serveCoordinates('ATOM ...');
    foldseekSearch.mockResolvedValue({ status: 'complete', ticketId: 't', total: 0, hits: [] });
    const result = await run({ by: 'structure', uniprot: 'P69905' });

    expect(findPrediction).toHaveBeenCalledWith('P69905', expect.anything());
    expect(fetchTextWindowMock.mock.calls[0]?.[0]).toBe('https://af/P69905.pdb');
    expect(foldseekSearch.mock.calls[0]?.[0]).toMatchObject({ fileName: 'P69905.pdb' });
    // An active accession AlphaFold DB answers for adds no notice.
    expect(String(result.structuredContent.notice)).not.toContain('merged');
  });

  it('submits the isoform model’s PDB-format file for an isoform accession (#91)', async () => {
    const url = 'https://alphafold.test/files/AF-P04637-2-F1-model_v6.pdb';
    findPrediction.mockResolvedValue(foundModel('P04637-2', url));
    serveCoordinates('ATOM ...');
    foldseekSearch.mockResolvedValue({ status: 'complete', ticketId: 't', total: 0, hits: [] });
    const result = await run({ by: 'structure', uniprot: 'P04637-2' });

    expect(result.isError).not.toBe(true);
    expect(findPrediction).toHaveBeenCalledWith('P04637-2', expect.anything());
    expect(fetchTextWindowMock.mock.calls[0]?.[0]).toBe(url);
    expect(foldseekSearch.mock.calls[0]?.[0]).toMatchObject({ fileName: 'P04637-2.pdb' });
  });

  it('searches the successor’s model for a merged accession and names the merge on both surfaces (#83)', async () => {
    findPrediction.mockResolvedValue(foundModel('P69905', 'https://af/P69905.pdb', 'Q1HDT5'));
    serveCoordinates('ATOM ...');
    foldseekSearch.mockResolvedValue({ status: 'complete', ticketId: 't', total: 0, hits: [] });
    const result = await run({ by: 'structure', uniprot: 'Q1HDT5' });

    expect(foldseekSearch.mock.calls[0]?.[0]).toMatchObject({ fileName: 'P69905.pdb' });
    const notice = String(result.structuredContent.notice);
    expect(notice).toContain('Q1HDT5 was merged into P69905');
    // Joined with the empty-result note, not replacing it.
    expect(notice).toContain('no fold-similar hits');
    expect(textOf(result)).toContain('Q1HDT5 was merged into P69905');
  });

  it('keeps the merge notice while the job is still computing (#83)', async () => {
    findPrediction.mockResolvedValue(foundModel('P69905', 'https://af/P69905.pdb', 'Q1HDT5'));
    serveCoordinates('ATOM ...');
    foldseekSearch.mockResolvedValue({ status: 'computing', ticketId: 'pending-1' });
    const notice = String(
      (await run({ by: 'structure', uniprot: 'Q1HDT5' })).structuredContent.notice,
    );

    expect(notice).toContain('ticket_id set to "pending-1"');
    expect(notice).toContain('Q1HDT5 was merged into P69905');
  });

  it('fails inactive_accession for a demerged accession AlphaFold DB has no model for (#83)', async () => {
    findPrediction.mockResolvedValue({
      kind: 'missed',
      uniprot: {
        kind: 'inactive',
        accession: 'P62988',
        inactiveReason: 'DEMERGED',
        replacements: ['P0CG47', 'P0CG48', 'P62979', 'P62987'],
      },
    });
    const result = await run({ by: 'structure', uniprot: 'P62988' });

    expect(result.structuredContent.error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'inactive_accession',
        inactiveReason: 'DEMERGED',
        replacements: ['P0CG47', 'P0CG48', 'P62979', 'P62987'],
      },
    });
    expect(fetchTextWindowMock).not.toHaveBeenCalled();
    expect(foldseekSearch).not.toHaveBeenCalled();
  });

  it.each([
    [
      'UniProt has no entry',
      { kind: 'unknown', accession: 'P04637-99' },
      'P04637-99',
      /UniProtKB has no entry for P04637-99/,
    ],
    [
      'the accession is active',
      { kind: 'active', accession: 'P00000' },
      'P00000',
      /AlphaFold DB has no model for P00000/,
    ],
    [
      'the successor has no model',
      { kind: 'merged', accession: 'Q1HDT5', successor: 'P69905' },
      'Q1HDT5',
      /Q1HDT5 was merged into P69905 .*no model for P69905/,
    ],
    [
      'the canonical isoform is named',
      { kind: 'active', accession: 'P04637-1' },
      'P04637-1',
      /uniprot "P04637"/,
    ],
  ])(
    'fails no_sequence with a hint naming only by:"structure" levers when %s (#83)',
    async (_case, verdict, uniprot, message) => {
      findPrediction.mockResolvedValue({ kind: 'missed', uniprot: verdict });
      const result = await run({ by: 'structure', uniprot });

      expect(result.structuredContent.error).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        message: expect.stringMatching(message),
        data: { reason: 'no_sequence' },
      });
      const hint = String(result.structuredContent.error?.data.recovery?.hint);
      expect(hint).toContain('pdb_id');
      // by:"structure" rejects the sequence parameter, so the hint never offers it.
      expect(hint).not.toMatch(/sequence parameter|raw .*sequence/);
      expect(textOf(result)).toContain(`Recovery: ${hint}`);
      expect(fetchTextWindowMock).not.toHaveBeenCalled();
    },
  );

  it('fails no_sequence when the model lists no PDB-format file', async () => {
    findPrediction.mockResolvedValue({ kind: 'found', model: { uniprotAccession: 'P69905' } });
    const result = await run({ by: 'structure', uniprot: 'P69905' });

    expect(result.structuredContent.error).toMatchObject({ data: { reason: 'no_sequence' } });
    expect(String(result.structuredContent.error?.data.recovery?.hint)).toContain('pdb_id');
    expect(fetchTextWindowMock).not.toHaveBeenCalled();
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
    serveCoordinates('ATOM ...');
    foldseekSearch.mockResolvedValue({ status: 'complete', ticketId: 't', total: 0, hits: [] });
    await findSimilar.handler(
      findSimilar.input.parse({ by: 'structure', pdb_id: '4HHB', databases: ['afdb-swissprot'] }),
      ctx(),
    );
    expect(foldseekSearch.mock.calls[0]?.[0]).toMatchObject({ databases: ['afdb-swissprot'] });
  });

  it('accepts all nine registered databases and searches pdb100 + afdb50 when omitted (#87)', async () => {
    serveCoordinates('ATOM ...');
    foldseekSearch.mockResolvedValue({ status: 'complete', ticketId: 't', total: 0, hits: [] });
    const all: FoldseekDatabaseInput = [
      'afdb50',
      'afdb-swissprot',
      'afdb-proteome',
      'bfvd_v3',
      'cath50',
      'mgnify_esm30',
      'pdb100',
      'gmgcl_id',
      'bfmd',
    ];
    const accepted = await runToolContract(findSimilar, {
      by: 'structure',
      pdb_id: '1CRN',
      databases: all,
    });
    expect(accepted.isError).not.toBe(true);
    expect(foldseekSearch.mock.calls[0]?.[0]).toMatchObject({ databases: all });

    await runToolContract(findSimilar, { by: 'structure', pdb_id: '1CRN' });
    expect(foldseekSearch.mock.calls[1]?.[0]).toMatchObject({ databases: ['pdb100', 'afdb50'] });
  });

  it.each(['BFVD', 'PDB100', 'pdb_folddisco', 'rnadb', 'pdb_interface'])(
    'rejects databases [%j] with -32602 naming the valid names, before any upstream request (#87)',
    async (name) => {
      const result = (await runToolContract(findSimilar, {
        by: 'structure',
        pdb_id: '1CRN',
        // A name outside the enum, sent the way a client would.
        databases: [name] as never,
      })) as {
        isError?: boolean;
        structuredContent: { error: { code: number; message: string; data: { reason: string } } };
      };

      expect(result.isError).toBe(true);
      expect(result.structuredContent.error).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_arguments' },
      });
      for (const valid of ['afdb50', 'afdb-swissprot', 'bfvd_v3', 'cath50', 'pdb100', 'bfmd']) {
        expect(result.structuredContent.error.message).toContain(`"${valid}"`);
      }
      expect(fetchTextWindowMock).not.toHaveBeenCalled();
      expect(foldseekSearch).not.toHaveBeenCalled();
    },
  );

  it('fails a submit Foldseek refuses as non-retryable databases_rejected, naming what was sent (#87)', async () => {
    serveCoordinates('data_1CRN');
    foldseekSearch.mockResolvedValue({
      status: 'rejected',
      upstreamMessage: 'selected databases are not valid',
    });

    const result = (await runToolContract(findSimilar, {
      by: 'structure',
      pdb_id: '1CRN',
      databases: ['pdb100', 'cath50'],
    })) as {
      isError?: boolean;
      structuredContent: {
        error: {
          code: number;
          message: string;
          data: Record<string, unknown> & { recovery: { hint: string } };
        };
      };
      content: Array<{ text: string }>;
    };

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent;
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: {
        reason: 'databases_rejected',
        databases: ['pdb100', 'cath50'],
        upstreamMessage: 'selected databases are not valid',
      },
    });
    expect(error.message).toContain('pdb100, cath50');
    expect(error.data.retryable).not.toBe(true);
    expect(error.data.recovery.hint).toContain('databases');
    expect(error.data.recovery.hint).not.toMatch(/retry shortly/i);
    const text = result.content.map((block) => block.text).join('\n');
    expect(text).toContain('(reason databases_rejected');
    expect(text).not.toContain('retryable');
  });

  it('resumes an existing ticket (polls, no resubmit, no coordinate fetch) when ticket_id is set', async () => {
    foldseekResume.mockResolvedValue({
      status: 'complete',
      ticketId: 'resume-me',
      total: 1,
      hits: [
        {
          target: '2hhb-assembly1.cif.gz_A',
          database: 'pdb100',
          source: 'experimental',
          id: '2HHB',
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
    expect(fetchTextWindowMock).not.toHaveBeenCalled();
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
    serveCoordinates('data_4HHB');
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
    serveCoordinates('data_4HHB');
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
    serveCoordinates('data_1CRN');
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
    serveCoordinates('data_4HHB');
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
    serveCoordinates('data_4HHB');
    foldseekSearch.mockResolvedValue(multichain({ total: 0, hits: [] }));
    const c = ctx();
    await findSimilar.handler(findSimilar.input.parse({ by: 'structure', pdb_id: '4HHB' }), c);
    const notice = String(getEnrichment(c).notice);
    expect(notice).toContain('no fold-similar hits in the selected databases');
    expect(notice).toContain('This job holds 4 queries');
  });

  it('names the query in the resume instruction while a non-zero-query job is computing', async () => {
    serveCoordinates('data_4HHB');
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
    serveCoordinates('data_4HHB');
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
    serveCoordinates('data_1CRN');
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
    const ids: Array<string | undefined> = [];
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

describe('protein_find_similar — structure hit fields through the real Foldseek service (#87, #88)', () => {
  type HitResult = {
    structuredContent: { hits: Array<Record<string, unknown>>; queryLength?: number };
    content: Array<{ text: string }>;
  };

  beforeEach(() => {
    foldseekImpl = new FoldseekService(
      {} as never,
      {} as never,
      { foldseekBaseUrl: 'https://foldseek.test' } as never,
    );
    serveCoordinates('data_1CRN');
  });

  /** Answer the real service's upstream calls with one completed result for query 0. */
  const completeWith = (queries: unknown, result: unknown) =>
    fetchJsonMock.mockImplementation(async (url: string) => {
      if (url === 'https://foldseek.test/api/ticket') return { id: 'live-shaped' };
      if (url.includes('/api/ticket/')) return { status: 'COMPLETE' };
      if (url.includes('/api/result/queries/')) return queries;
      if (/\/api\/result\/[^/]+\/0$/.test(url)) return result;
      throw new Error(`unexpected Foldseek URL ${url}`);
    });

  /** The content[] block one hit renders under its `### ` heading. */
  const hitBlock = (text: string, heading: string) => {
    const start = text.indexOf(`### ${heading} `);
    expect(start).toBeGreaterThan(-1);
    const end = text.indexOf('\n### ', start + 1);
    return text.slice(start, end === -1 ? undefined : end);
  };

  const search = async (databases: FoldseekDatabaseInput) =>
    (await runToolContract(findSimilar, {
      by: 'structure',
      pdb_id: '1CRN',
      databases,
      limit: 100,
    })) as HitResult;

  it('carries the target, chain, title, taxonomy, probability, and aligned span of a pdb100 hit on both surfaces', async () => {
    completeWith(QUERIES_1CRN, RESULT_1CRN_PER_DB);

    const result = await search(['pdb100', 'cath50']);

    const hit = result.structuredContent.hits.find((h) => h.id === '1CRN');
    expect(hit).toEqual({
      id: '1CRN',
      target: '1crn-assembly1.cif.gz_A',
      source: 'experimental',
      chain: 'A',
      title:
        'WATER STRUCTURE OF A HYDROPHOBIC PROTEIN AT ATOMIC RESOLUTION. PENTAGON RINGS OF WATER MOLECULES IN CRYSTALS OF CRAMBIN',
      score: 357,
      evalue: 3.458e-9,
      probability: 1,
      identity: 1,
      alignmentLength: 46,
      queryStart: 1,
      queryEnd: 46,
      targetStart: 1,
      targetEnd: 46,
      targetLength: 46,
      database: 'pdb100',
      organisms: ['Crambe hispanica subsp. abyssinica'],
      taxId: 3721,
    });
    expect(result.structuredContent.queryLength).toBe(46);

    const text = result.content.map((block) => block.text).join('\n');
    expect(text).toContain('**Query length:** 46');
    const block = hitBlock(text, '1CRN');
    for (const rendered of [
      '### 1CRN _(experimental)_',
      'WATER STRUCTURE OF A HYDROPHOBIC PROTEIN AT ATOMIC RESOLUTION.',
      '**Target:** 1crn-assembly1.cif.gz_A',
      '**Chain:** A',
      '**Probability:** 1',
      '**Identity:** 1',
      '**Organisms:** Crambe hispanica subsp. abyssinica',
      '**Tax ID:** 3721',
      '**Alignment:** length 46 · query 1–46 · target 1–46 · target length 46',
    ]) {
      expect(block).toContain(rendered);
    }
  });

  it('renders an id-less hit under its target name and keeps a bfvd_v3 accession without an id', async () => {
    completeWith(QUERIES_1CRN, RESULT_1CRN_PER_DB);

    const result = await search(['mgnify_esm30', 'bfvd_v3']);

    const byTarget = new Map(result.structuredContent.hits.map((h) => [h.target, h]));
    const esm = byTarget.get('MGYP001043648370.pdb.gz');
    expect(esm).toMatchObject({ source: 'predicted', database: 'mgnify_esm30' });
    for (const key of ['id', 'chain', 'title', 'organisms', 'taxId', 'uniprotAccession']) {
      expect(esm).not.toHaveProperty(key);
    }
    expect(byTarget.get('U5P0K0')).toMatchObject({
      source: 'predicted',
      uniprotAccession: 'U5P0K0',
      title: 'Uncharacterized protein',
      organisms: ['Mycobacterium phage Fredward'],
    });
    expect(byTarget.get('U5P0K0')).not.toHaveProperty('id');

    const text = result.content.map((block) => block.text).join('\n');
    expect(text).not.toContain('undefined');
    const esmBlock = hitBlock(text, 'MGYP001043648370.pdb.gz');
    expect(esmBlock).toContain('### MGYP001043648370.pdb.gz _(predicted)_');
    expect(esmBlock).toContain('**Alignment:** length 48 · query 1–46 · target 16–63');
    expect(esmBlock).not.toContain('**Organisms:**');
    expect(hitBlock(text, 'U5P0K0')).toContain('**UniProt:** U5P0K0');
  });

  it('omits organisms and taxId for an unclassified pdb100 target on both surfaces', async () => {
    completeWith(QUERIES_1CRN, RESULT_1CRN_PER_DB);

    const result = await search(['pdb100']);

    const unclassified = result.structuredContent.hits.find((h) => h.id === '2FD7');
    expect(unclassified).toMatchObject({ target: '2fd7-assembly1.cif.gz_A', chain: 'A' });
    expect(unclassified).not.toHaveProperty('organisms');
    expect(unclassified).not.toHaveProperty('taxId');
    const block = hitBlock(result.content.map((b) => b.text).join('\n'), '2FD7');
    expect(block).not.toContain('**Organisms:**');
    expect(block).not.toContain('unclassified');
  });

  it('tells one entry’s rows apart by chain on both surfaces (6KAI, 1IBE, 7VLF)', async () => {
    completeWith(QUERIES_4HHB, RESULT_4HHB_Q0_CHAINS);

    const result = (await runToolContract(findSimilar, {
      by: 'structure',
      pdb_id: '4HHB',
    })) as HitResult;

    expect(result.structuredContent.hits.map((h) => [h.id, h.chain])).toEqual([
      ['6KAI', 'E'],
      ['6KAI', 'A'],
      ['6KAI', 'G'],
      ['1IBE', 'A-2'],
      ['7VLF', 'G-2'],
      ['7VLF', 'G-3'],
      ['7VEA', 'dM'],
    ]);
    expect(result.structuredContent.queryLength).toBe(141);
    const text = result.content.map((block) => block.text).join('\n');
    const chains = [...text.matchAll(/\*\*Chain:\*\* (\S+)/g)].map((match) => match[1]);
    expect(chains).toEqual(['E', 'A', 'G', 'A-2', 'G-2', 'G-3', 'dM']);
  });
});

describe('protein_find_similar — per-mode field rejection (#57)', () => {
  it.each([
    ['sequence', { sequence: 'MVLS' }],
    ['max_evalue', { max_evalue: 0.001 }],
    ['min_identity', { min_identity: 0.9 }],
    ['chain (#84)', { chain: 'B' }],
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
    expect(fetchTextWindowMock).not.toHaveBeenCalled();
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
      findSimilar.input.parse({ by: 'sequence', sequence: 'MVLSPADKTN', databases: [] }),
      ctx(),
    );
    expect(searchSequence).toHaveBeenCalled();

    serveCoordinates('ATOM ...');
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
      findSimilar.input.parse({ by: 'sequence', sequence: 'MVLSPADKTN', start: 50 }),
      ctx(),
    );
    expect(searchSequence.mock.calls[0]?.[1]).toMatchObject({ start: 50 });

    serveCoordinates('ATOM ...');
    foldseekSearch.mockResolvedValue({ status: 'complete', ticketId: 't', total: 0, hits: [] });
    await findSimilar.handler(
      findSimilar.input.parse({ by: 'structure', pdb_id: '4HHB', start: 50 }),
      ctx(),
    );
    expect(foldseekSearch.mock.calls[0]?.[0]).toMatchObject({ start: 50 });
  });

  it('leaves the shared pdb_id / uniprot / limit fields unaffected in both modes', async () => {
    getSequence.mockResolvedValue(foundEntity('4HHB_1', 'MVLSPADKTN'));
    searchSequence.mockResolvedValue({ total: 0, hits: [] });
    getEntries.mockResolvedValue([]);
    await findSimilar.handler(
      findSimilar.input.parse({ by: 'sequence', pdb_id: '4HHB', limit: 7 }),
      ctx(),
    );
    expect(searchSequence.mock.calls[0]?.[1]).toMatchObject({ limit: 7 });

    findPrediction.mockResolvedValue(foundModel('P69905', 'https://af/x.pdb'));
    serveCoordinates('ATOM ...');
    foldseekSearch.mockResolvedValue({ status: 'complete', ticketId: 't', total: 0, hits: [] });
    await findSimilar.handler(
      findSimilar.input.parse({ by: 'structure', uniprot: 'P69905', limit: 7 }),
      ctx(),
    );
    expect(foldseekSearch.mock.calls[0]?.[0]).toMatchObject({ limit: 7 });
  });
});

describe('protein_find_similar — error envelope on both client surfaces', () => {
  /** The contract's declared recovery for a reason — what the framework fills on the envelope. */
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
      setup: () => getSequence.mockResolvedValue({ kind: 'no_protein' }),
      code: JsonRpcErrorCode.NotFound,
      reason: 'no_sequence',
      hint: declaredRecovery('no_sequence'),
      terms: '(reason no_sequence)',
    },
    {
      name: 'no_sequence (by:structure, no predicted model)',
      input: { by: 'structure', uniprot: 'P00000' },
      setup: () =>
        findPrediction.mockResolvedValue({
          kind: 'missed',
          uniprot: { kind: 'active', accession: 'P00000' },
        }),
      code: JsonRpcErrorCode.NotFound,
      reason: 'no_sequence',
      hint: expect.stringContaining('pdb_id'),
      terms: '(reason no_sequence)',
    },
    {
      name: 'chain_not_found',
      input: { by: 'sequence', pdb_id: '1TSR', chain: 'E' },
      setup: () =>
        getSequence.mockResolvedValue({
          kind: 'chain_not_found',
          proteinEntities: [{ entityId: '1TSR_3', chains: ['A', 'B', 'C'], length: 219 }],
        }),
      code: JsonRpcErrorCode.NotFound,
      reason: 'chain_not_found',
      hint: expect.stringContaining('A, B, C'),
      terms: '(reason chain_not_found)',
    },
    {
      name: 'chain_without_pdb_id',
      input: { by: 'sequence', sequence: 'MVLSPADKTN', chain: 'A' },
      code: JsonRpcErrorCode.InvalidParams,
      reason: 'chain_without_pdb_id',
      hint: declaredRecovery('chain_without_pdb_id'),
      terms: '(reason chain_without_pdb_id)',
    },
    {
      name: 'invalid_accession',
      input: { by: 'sequence', uniprot: 'NOTANACC' },
      code: JsonRpcErrorCode.InvalidParams,
      reason: 'invalid_accession',
      hint: declaredRecovery('invalid_accession'),
      terms: '(reason invalid_accession)',
    },
    {
      name: 'inactive_accession (deleted, no replacement)',
      input: { by: 'sequence', uniprot: 'A0A008APQ8' },
      setup: () =>
        getUniProtSequence.mockRejectedValue(
          inactiveAccessionError({
            accession: 'A0A008APQ8',
            inactiveReason: 'DELETED',
            deletedReason: 'Deleted from sequence source (EMBL)',
            replacements: [],
          }),
        ),
      code: JsonRpcErrorCode.NotFound,
      reason: 'inactive_accession',
      hint: declaredRecovery('inactive_accession'),
      terms: '(reason inactive_accession)',
    },
    {
      name: 'structure_too_large',
      input: { by: 'structure', pdb_id: '1ABC' },
      setup: () => fetchTextWindowMock.mockResolvedValue({ more: true, text: 'data_1ABC' }),
      code: JsonRpcErrorCode.InvalidParams,
      reason: 'structure_too_large',
      hint: declaredRecovery('structure_too_large'),
      terms: '(reason structure_too_large)',
    },
    {
      name: 'search_failed',
      input: { by: 'structure', pdb_id: '4HHB' },
      setup: () => {
        serveCoordinates('ATOM ...');
        foldseekSearch.mockResolvedValue({ status: 'failed', error: 'bad coordinates' });
      },
      code: JsonRpcErrorCode.ServiceUnavailable,
      reason: 'search_failed',
      hint: expect.stringContaining('Retry shortly'),
      terms: '(reason search_failed · retryable)',
    },
    {
      name: 'databases_rejected',
      input: { by: 'structure', pdb_id: '4HHB' },
      setup: () => {
        serveCoordinates('ATOM ...');
        foldseekSearch.mockResolvedValue({ status: 'rejected' });
      },
      code: JsonRpcErrorCode.InvalidParams,
      reason: 'databases_rejected',
      hint: declaredRecovery('databases_rejected'),
      terms: '(reason databases_rejected)',
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

  it('heads an id-less hit by its target and marks an aligned bound upstream did not send', () => {
    const blocks = findSimilar.format!({
      by: 'structure',
      engine: 'Foldseek',
      status: 'complete',
      hits: [
        {
          target: 'LevyLab_Q8U2A3_V1_4_relaxed_B',
          source: 'predicted',
          database: 'bfmd',
          queryStart: 8,
          targetLength: 332,
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('### LevyLab_Q8U2A3_V1_4_relaxed_B _(predicted)_');
    // The heading already names the target, so no separate Target field repeats it.
    expect(text).not.toContain('**Target:**');
    expect(text).toContain('**Alignment:** query 8–? · target length 332');
    expect(text).not.toContain('undefined');
  });

  it('renders the query entity and a sequence hit’s bit score, and neither when absent', () => {
    const text = (result: Parameters<NonNullable<typeof findSimilar.format>>[0]) =>
      (findSimilar.format!(result)[0] as { text: string }).text;
    const withBoth = text({
      by: 'sequence',
      engine: 'RCSB mmseqs2',
      status: 'complete',
      queryEntityId: '4HHB_2',
      hits: [{ id: '1A00', entityId: '1A00_1', source: 'experimental', score: 1, bitscore: 290 }],
    });
    expect(withBoth).toContain('**Query entity:** 4HHB_2');
    expect(withBoth).toContain('**Bit score:** 290');

    const withNeither = text({
      by: 'sequence',
      engine: 'RCSB mmseqs2',
      status: 'complete',
      hits: [{ id: '1A00', entityId: '1A00_1', source: 'experimental', score: 1 }],
    });
    expect(withNeither).not.toContain('**Query entity:**');
    expect(withNeither).not.toContain('**Bit score:**');
  });
});

describe('protein_find_similar — coordinate file ceiling', () => {
  const CEILING = 16_000_000;

  beforeEach(() => {
    foldseekSearch.mockResolvedValue({ status: 'complete', ticketId: 't', total: 0, hits: [] });
  });

  it.each([
    ['a PDB entry’s mmCIF file', { pdb_id: '1ABC' }, 'https://files/download/1ABC.cif'],
    ['an AlphaFold DB model', { uniprot: 'P69905' }, 'https://af/P69905.pdb'],
  ])('reads %s through the bounded window, from the start', async (_case, source, url) => {
    findPrediction.mockResolvedValue(foundModel('P69905', 'https://af/P69905.pdb'));
    serveCoordinates('data_1ABC');
    await run({ by: 'structure', ...source });

    expect(fetchTextWindowMock).toHaveBeenCalledTimes(1);
    expect(fetchTextWindowMock.mock.calls[0]?.[0]).toBe(url);
    expect(fetchTextWindowMock.mock.calls[0]?.[2]).toMatchObject({ offset: 0, length: CEILING });
    expect(foldseekSearch.mock.calls[0]?.[0]).toMatchObject({ fileContent: 'data_1ABC' });
  });

  it('fails structure_too_large past the ceiling, stating it, without submitting a job', async () => {
    fetchTextWindowMock.mockResolvedValue({ more: true, text: 'data_1ABC' });
    const result = await run({ by: 'structure', pdb_id: '1ABC' });

    expect(result.structuredContent.error).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      message: expect.stringContaining('16,000,000 characters'),
      data: {
        reason: 'structure_too_large',
        recovery: { hint: expect.stringContaining('uniprot') },
      },
    });
    expect(foldseekSearch).not.toHaveBeenCalled();
  });

  it('states the ceiling where the caller reads it', () => {
    const entry = findSimilar.errors?.find((e) => e.reason === 'structure_too_large');
    expect(entry?.when).toContain('16,000,000 characters');
    expect(findSimilar.description).toContain('16,000,000 characters');
    expect(findSimilar.input.shape.pdb_id.description).toContain('16,000,000 characters');
  });

  it('stops reading a coordinate file at the ceiling through the real bounded read', async () => {
    const actual = await vi.importActual<typeof import('@/services/shared/http.js')>(
      '@/services/shared/http.js',
    );
    fetchTextWindowMock.mockImplementation(actual.fetchTextWindow);
    const chunk = new TextEncoder().encode('A'.repeat(1 << 20));
    const state = { pulled: 0, cancelled: false };
    // A body twice the ceiling, produced on demand.
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (state.pulled >= 2 * CEILING) return controller.close();
          state.pulled += chunk.length;
          controller.enqueue(chunk);
        },
        cancel() {
          state.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== 'files') throw new Error(`Unrouted request: ${url.href}`);
      return new Response(body, { status: 200 });
    });
    try {
      const result = await run({ by: 'structure', pdb_id: '1ABC' });

      expect(result.structuredContent.error).toMatchObject({
        data: { reason: 'structure_too_large' },
      });
      expect(state.cancelled).toBe(true);
      expect(state.pulled).toBeGreaterThan(CEILING);
      expect(state.pulled).toBeLessThanOrEqual(CEILING + 2 * chunk.length);
      expect(foldseekSearch).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('protein_find_similar — one call budget across chained requests', () => {
  /** A fake upstream call that settles only when the call's signal aborts. */
  const untilAborted =
    <T>(settle: (signal: AbortSignal) => T) =>
    (...args: unknown[]) => {
      const { signal } = args.at(-1) as { signal: AbortSignal };
      return new Promise<T>((resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            try {
              resolve(settle(signal));
            } catch (err) {
              reject(err);
            }
          },
          { once: true },
        );
      });
    };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops a stalled by:"sequence" chain at the 50 s budget with a timeout reason', async () => {
    vi.useFakeTimers();
    searchSequence.mockImplementation(
      untilAborted((signal) => {
        throw signal.reason;
      }),
    );
    const settled = vi.fn();
    const pending = Promise.resolve(
      findSimilar.handler(
        findSimilar.input.parse({ by: 'sequence', sequence: 'MVLSPADKTN' }),
        ctx(),
      ),
    ).then(settled, settled);

    await vi.advanceTimersByTimeAsync(49_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ name: 'TimeoutError' }));
  });

  it('reports a Foldseek search the budget stopped as a timeout, not search_failed', async () => {
    vi.useFakeTimers();
    serveCoordinates('data_1ABC');
    foldseekSearch.mockImplementation(
      untilAborted(() => ({ status: 'failed', error: 'This operation was aborted' })),
    );
    const pending = findSimilar.handler(
      findSimilar.input.parse({ by: 'structure', pdb_id: '1ABC' }),
      ctx(),
    );
    const outcome = expect(pending).rejects.toMatchObject({ code: JsonRpcErrorCode.Timeout });
    await vi.advanceTimersByTimeAsync(50_000);
    await outcome;
  });

  describe('when the budget ends after Foldseek accepted the job', () => {
    /** The real service: Foldseek accepts the job, then the status poll stalls. */
    const stallAfterSubmit = (ticketId: string, onPoll?: () => void) => {
      foldseekImpl = new FoldseekService(
        {} as never,
        {} as never,
        { foldseekBaseUrl: 'https://foldseek.test' } as never,
      );
      fetchJsonMock.mockImplementation((url: string, call: { signal: AbortSignal }) => {
        if (url === 'https://foldseek.test/api/ticket') return Promise.resolve({ id: ticketId });
        onPoll?.();
        return new Promise((_resolve, reject) => {
          if (call.signal.aborted) return reject(call.signal.reason);
          call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true });
        });
      });
    };

    it('returns status computing with the ticket on both surfaces, never resubmitting', async () => {
      vi.useFakeTimers();
      serveCoordinates('data_1ABC');
      stallAfterSubmit('tkt-late');
      const settled = vi.fn();
      const pending = runToolContract(findSimilar, { by: 'structure', pdb_id: '1ABC' });
      void pending.then(settled, settled);

      await vi.advanceTimersByTimeAsync(49_999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const result = (await pending) as ContractResult;

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        by: 'structure',
        status: 'computing',
        ticketId: 'tkt-late',
        query: 0,
        hits: [],
      });
      const notice = String(result.structuredContent.notice);
      expect(notice).toContain('ticket_id set to "tkt-late"');
      expect(notice).toContain('50 s');
      const text = textOf(result);
      expect(text).toContain('## Foldseek (by:structure) — computing');
      expect(text).toContain('**Ticket:** tkt-late');
      expect(text).toContain(notice);
      const submits = fetchJsonMock.mock.calls.filter(
        (call) => call[0] === 'https://foldseek.test/api/ticket',
      );
      expect(submits).toHaveLength(1);
    });

    it('keeps a merge notice beside the resume instruction', async () => {
      vi.useFakeTimers();
      findPrediction.mockResolvedValue(foundModel('P69905', 'https://af/P69905.pdb', 'Q1HDT5'));
      serveCoordinates('ATOM ...');
      stallAfterSubmit('tkt-merged');
      const pending = runToolContract(findSimilar, { by: 'structure', uniprot: 'Q1HDT5' });
      await vi.advanceTimersByTimeAsync(50_000);
      const notice = String(((await pending) as ContractResult).structuredContent.notice);

      expect(notice).toContain('ticket_id set to "tkt-merged"');
      expect(notice).toContain('Q1HDT5 was merged into P69905');
    });

    it('returns the same ticket as computing when the budget ends a resumed poll', async () => {
      vi.useFakeTimers();
      foldseekResume.mockImplementation(
        untilAborted(() => ({ status: 'failed', ticketId: 'tkt-4hhb', error: 'aborted' })),
      );
      const pending = findSimilar.handler(
        findSimilar.input.parse({ by: 'structure', ticket_id: 'tkt-4hhb', query: 2 }),
        ctx(),
      );
      await vi.advanceTimersByTimeAsync(50_000);

      expect(await pending).toMatchObject({
        status: 'computing',
        ticketId: 'tkt-4hhb',
        query: 2,
        hits: [],
      });
    });

    it('still throws when the caller cancels after the submit, never returning computing', async () => {
      const caller = new AbortController();
      serveCoordinates('data_1ABC');
      stallAfterSubmit('tkt-cancelled', () => caller.abort());
      const outcome = findSimilar.handler(
        findSimilar.input.parse({ by: 'structure', pdb_id: '1ABC' }),
        createMockContext({ errors: findSimilar.errors, signal: caller.signal }),
      );

      await expect(outcome).rejects.toBeInstanceOf(Error);
      expect(caller.signal.aborted).toBe(true);
    });
  });

  it('shortens the Foldseek poll by the time the call spent before submitting', async () => {
    vi.useFakeTimers();
    const { asyncPollTimeoutMs } = getServerConfig();
    fetchTextWindowMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      return { more: false, text: 'data_1ABC', totalLength: 9 };
    });
    foldseekSearch.mockResolvedValue({ status: 'complete', ticketId: 't', total: 0, hits: [] });
    const pending = findSimilar.handler(
      findSimilar.input.parse({ by: 'structure', pdb_id: '1ABC' }),
      ctx(),
    );
    await vi.advanceTimersByTimeAsync(12_000);
    await pending;

    expect(foldseekSearch.mock.calls[0]?.[0]).toMatchObject({
      timeoutMs: Math.max(0, asyncPollTimeoutMs - 12_000),
    });
  });
});
