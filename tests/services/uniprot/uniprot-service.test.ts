/**
 * @fileoverview Tests for the UniProt service: entry normalization (recommended
 * name, gene names, FUNCTION comment join, feature vs. variant categorization),
 * include-scoped field selection in the request URL, getSequence, and InterPro
 * normalization with the 404 → [] branch. HTTP mocked.
 * @module tests/services/uniprot/uniprot-service.test
 */

import { JsonRpcErrorCode, notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/shared/http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/shared/http.js')>();
  return { ...actual, fetchJson: vi.fn() };
});

import { fetchJson } from '@/services/shared/http.js';
import { UniProtService } from '@/services/uniprot/uniprot-service.js';

const fetchJsonMock = vi.mocked(fetchJson);

const service = () =>
  new UniProtService(
    {} as never,
    {} as never,
    {
      uniprotBaseUrl: 'https://uniprot.test',
      interproBaseUrl: 'https://interpro.test',
    } as never,
  );

/** A real UniProtKB JSON entry (trimmed to the selected fields) for P69905. */
const ENTRY = {
  primaryAccession: 'P69905',
  proteinDescription: { recommendedName: { fullName: { value: 'Hemoglobin subunit alpha' } } },
  genes: [{ geneName: { value: 'HBA1' } }, { geneName: { value: 'HBA2' } }, { geneName: {} }],
  organism: { scientificName: 'Homo sapiens', taxonId: 9606 },
  comments: [
    {
      commentType: 'FUNCTION',
      texts: [{ value: 'Involved in oxygen transport' }, { value: 'from the lung' }],
    },
    { commentType: 'SUBUNIT', texts: [{ value: 'Heterotetramer' }] },
  ],
  sequence: { length: 142, value: 'MVLSPADKTNVKAAW' },
  features: [
    {
      type: 'Domain',
      description: 'Globin',
      location: { start: { value: 1 }, end: { value: 141 } },
    },
    {
      type: 'Natural variant',
      description: 'in dbSNP',
      location: { start: { value: 6 }, end: { value: 6 } },
    },
    { type: 'Binding site', location: { start: { value: 87 } } },
  ],
};

beforeEach(() => vi.clearAllMocks());

describe('UniProtService.getEntry', () => {
  it('normalizes name, gene names, joined FUNCTION text, organism, and length', async () => {
    fetchJsonMock.mockResolvedValue(ENTRY);
    const out = await service().getEntry('p69905', 'all', createMockContext());

    expect(out).toMatchObject({
      accession: 'P69905',
      proteinName: 'Hemoglobin subunit alpha',
      geneNames: ['HBA1', 'HBA2'], // the empty geneName is dropped
      organism: 'Homo sapiens',
      taxonId: 9606,
      function: 'Involved in oxygen transport from the lung',
      sequenceLength: 142,
    });
  });

  it('categorizes features vs. variants and carries residue ranges', async () => {
    fetchJsonMock.mockResolvedValue(ENTRY);
    const out = await service().getEntry('P69905', 'all', createMockContext());

    const domain = out.features.find((f) => f.type === 'Domain');
    expect(domain).toMatchObject({ category: 'feature', start: 1, end: 141 });
    const variant = out.features.find((f) => f.type === 'Natural variant');
    expect(variant).toMatchObject({ category: 'variant', start: 6, end: 6 });
    const binding = out.features.find((f) => f.type === 'Binding site');
    expect(binding).toMatchObject({ category: 'feature', start: 87 });
    expect(binding).not.toHaveProperty('end'); // location.end absent → omitted
  });

  it('requests base fields only for include:domains (no ft_* feature/variant fields)', async () => {
    fetchJsonMock.mockResolvedValue(ENTRY);
    await service().getEntry('P69905', 'domains', createMockContext());
    const url = fetchJsonMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('fields=accession');
    expect(url).not.toContain('ft_domain');
    expect(url).not.toContain('ft_variant');
  });

  it('adds feature fields for include:features and variant fields for include:variants', async () => {
    fetchJsonMock.mockResolvedValue(ENTRY);
    await service().getEntry('P69905', 'features', createMockContext());
    expect(fetchJsonMock.mock.calls[0]?.[0]).toContain('ft_domain');
    expect(fetchJsonMock.mock.calls[0]?.[0]).not.toContain('ft_variant');

    fetchJsonMock.mockClear();
    await service().getEntry('P69905', 'variants', createMockContext());
    expect(fetchJsonMock.mock.calls[0]?.[0]).toContain('ft_variant');
    expect(fetchJsonMock.mock.calls[0]?.[0]).not.toContain('ft_domain');
  });

  it('preserves missing upstream fields as unknown (sparse entry)', async () => {
    fetchJsonMock.mockResolvedValue({ primaryAccession: 'Q9' });
    const out = await service().getEntry('Q9', 'all', createMockContext());
    expect(out).toEqual({ accession: 'Q9', geneNames: [], features: [] });
  });
});

describe('UniProtService.getSequence', () => {
  it('returns the one-letter sequence value', async () => {
    fetchJsonMock.mockResolvedValue({ sequence: { value: 'MVLSPADK' } });
    expect(await service().getSequence('P69905', createMockContext())).toBe('MVLSPADK');
  });

  it('returns null when no sequence is present', async () => {
    fetchJsonMock.mockResolvedValue({});
    expect(await service().getSequence('P69905', createMockContext())).toBeNull();
  });
});

describe('UniProtService.getInterPro', () => {
  it('normalizes member databases and GO terms, dropping incomplete GO entries', async () => {
    fetchJsonMock.mockResolvedValue({
      results: [
        {
          metadata: {
            accession: 'IPR009050',
            name: 'Globin-like superfamily',
            type: 'homologous_superfamily',
            member_databases: { ssf: {}, cdd: {} },
            go_terms: [
              {
                identifier: 'GO:0005344',
                name: 'oxygen carrier activity',
                category: { name: 'molecular_function' },
              },
              { identifier: 'GO:0000000' }, // no name → dropped
            ],
          },
        },
        { metadata: undefined }, // dropped
        { metadata: { name: 'no accession' } }, // no accession → dropped
      ],
    });
    const out = await service().getInterPro('P69905', createMockContext());

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      accession: 'IPR009050',
      name: 'Globin-like superfamily',
      type: 'homologous_superfamily',
      memberDatabases: ['ssf', 'cdd'],
    });
    expect(out[0]?.goTerms).toEqual([
      { id: 'GO:0005344', name: 'oxygen carrier activity', category: 'molecular_function' },
    ]);
  });

  it('returns [] when InterPro 404s (no domains is not a failure)', async () => {
    fetchJsonMock.mockRejectedValue(notFound('no entries'));
    expect(await service().getInterPro('P00000', createMockContext())).toEqual([]);
  });

  it('rethrows a non-404 InterPro failure', async () => {
    fetchJsonMock.mockRejectedValue(serviceUnavailable('InterPro down'));
    await expect(service().getInterPro('P69905', createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });

  it('queries the InterPro base URL, not the UniProt base', async () => {
    fetchJsonMock.mockResolvedValue({ results: [] });
    await service().getInterPro('p69905', createMockContext());
    expect(fetchJsonMock.mock.calls[0]?.[0]).toContain('https://interpro.test');
    expect(fetchJsonMock.mock.calls[0]?.[0]).toContain('/UniProt/P69905/');
  });
});
