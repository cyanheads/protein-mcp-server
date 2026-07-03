/**
 * @fileoverview Tests for protein_find_similar: the by:sequence path (direct
 * sequence, PDB-derived, UniProt-derived; metadata enrichment; empty-result
 * notice; no_sequence failure), the by:structure path (Foldseek complete /
 * computing / failed, predicted-source mapping), the missing_query guard, and
 * format(). Services and the coordinate-file fetch are mocked.
 * @module tests/tools/find-similar.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const searchSequence = vi.fn();
const getEntries = vi.fn();
const getSequence = vi.fn();
const coordinateFileUrl = vi.fn((id: string, fmt: string) => `https://files/${id}.${fmt}`);
vi.mock('@/services/rcsb/rcsb-service.js', () => ({
  getRcsbService: () => ({ searchSequence, getEntries, getSequence, coordinateFileUrl }),
}));

const foldseekSearch = vi.fn();
const foldseekResume = vi.fn();
vi.mock('@/services/foldseek/foldseek-service.js', () => ({
  getFoldseekService: () => ({ search: foldseekSearch, resume: foldseekResume }),
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
  return { ...actual, fetchText: vi.fn() };
});

import { findSimilar } from '@/mcp-server/tools/definitions/find-similar.tool.js';
import { fetchText } from '@/services/shared/http.js';
import { entryIdOf } from '@/services/shared/identifiers.js';

const fetchTextMock = vi.mocked(fetchText);
const ctx = () => createMockContext({ errors: findSimilar.errors });

beforeEach(() => vi.clearAllMocks());

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

  it('derives the query sequence from a PDB ID', async () => {
    getSequence.mockResolvedValue({ entityId: '4HHB_1', sequence: 'MVLSPADK' });
    searchSequence.mockResolvedValue({ total: 1, hits: [] });
    getEntries.mockResolvedValue([]);
    await findSimilar.handler(findSimilar.input.parse({ by: 'sequence', pdb_id: '4hhb' }), ctx());
    expect(getSequence).toHaveBeenCalledWith('4hhb', expect.anything());
    expect(searchSequence.mock.calls[0]?.[0]).toBe('MVLSPADK');
  });

  it('derives the query sequence from a UniProt accession', async () => {
    getUniProtSequence.mockResolvedValue('MKTAYIAK');
    searchSequence.mockResolvedValue({ total: 1, hits: [] });
    getEntries.mockResolvedValue([]);
    await findSimilar.handler(
      findSimilar.input.parse({ by: 'sequence', uniprot: 'P69905' }),
      ctx(),
    );
    expect(searchSequence.mock.calls[0]?.[0]).toBe('MKTAYIAK');
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
  it('runs a Foldseek search from a PDB coordinate file and maps hits by source', async () => {
    fetchTextMock.mockResolvedValue('ATOM ...');
    foldseekSearch.mockResolvedValue({
      status: 'complete',
      ticketId: 't1',
      hits: [
        {
          target: '2HHB-A',
          database: 'pdb100',
          targetType: 'pdb',
          pdbId: '2HHB',
          chain: 'A',
          score: 800,
          evalue: 1e-30,
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
    expect(out.hits[0]).toMatchObject({
      id: '2HHB',
      source: 'experimental',
      score: 800,
      evalue: 1e-30,
    });
    expect(out.hits[1]).toMatchObject({
      id: 'P69905',
      source: 'predicted',
      uniprotAccession: 'P69905',
    });
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

  it('derives coordinates from an AlphaFold model when given a UniProt accession', async () => {
    getPrediction.mockResolvedValue({
      uniprotAccession: 'P69905',
      pdbUrl: 'https://af/P69905.pdb',
    });
    fetchTextMock.mockResolvedValue('ATOM ...');
    foldseekSearch.mockResolvedValue({ status: 'complete', ticketId: 't', hits: [] });
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
    await expect(
      findSimilar.handler(findSimilar.input.parse({ by: 'structure', sequence: 'MVLS' }), ctx()),
    ).rejects.toMatchObject({ data: { reason: 'missing_query' } });
  });

  it('passes custom databases through to Foldseek', async () => {
    fetchTextMock.mockResolvedValue('ATOM ...');
    foldseekSearch.mockResolvedValue({ status: 'complete', ticketId: 't', hits: [] });
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

describe('protein_find_similar — format', () => {
  it('renders the engine header, ticket line, and per-hit scores', () => {
    const blocks = findSimilar.format?.({
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
    const text = (blocks?.[0] as { text: string }).text;
    expect(text).toContain('## Foldseek (by:structure) — computing');
    expect(text).toContain('**Ticket:** tkt-1');
    expect(text).toContain('### 2HHB _(experimental)_');
    expect(text).toContain('**Entity:** 2HHB_1');
    expect(text).toContain('Deoxyhaemoglobin');
    expect(text).toContain('**DB:** pdb100');
  });
});
