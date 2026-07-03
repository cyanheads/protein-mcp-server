/**
 * @fileoverview Tests for protein_get_annotations: direct-accession vs. PDB→UniProt
 * resolution, the no_uniprot_mapping failure (missing input, unresolvable PDB,
 * malformed accession), include-scope gating of features/variants/domains, the
 * resolvedFrom enrichment, and format() rendering of features, variants, and
 * InterPro domains with GO terms. Services mocked.
 * @module tests/tools/get-annotations.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getEntry = vi.fn();
const getInterPro = vi.fn();
vi.mock('@/services/uniprot/uniprot-service.js', () => ({
  getUniProtService: () => ({ getEntry, getInterPro }),
}));

const resolveUniprot = vi.fn();
vi.mock('@/services/rcsb/rcsb-service.js', () => ({
  getRcsbService: () => ({ resolveUniprot }),
}));

import { getAnnotations } from '@/mcp-server/tools/definitions/get-annotations.tool.js';

const ctx = () => createMockContext({ errors: getAnnotations.errors });

const entry = (over: Record<string, unknown> = {}) => ({
  accession: 'P69905',
  proteinName: 'Hemoglobin subunit alpha',
  geneNames: ['HBA1'],
  organism: 'Homo sapiens',
  function: 'Oxygen transport',
  sequenceLength: 142,
  features: [
    { category: 'feature', type: 'Domain', description: 'Globin', start: 1, end: 141 },
    { category: 'variant', type: 'Natural variant', description: 'in dbSNP', start: 6, end: 6 },
  ],
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('protein_get_annotations', () => {
  it('fetches by a directly-supplied UniProt accession (include:all)', async () => {
    getEntry.mockResolvedValue(entry());
    getInterPro.mockResolvedValue([
      {
        accession: 'IPR009050',
        name: 'Globin-like',
        type: 'homologous_superfamily',
        memberDatabases: ['ssf'],
        goTerms: [],
      },
    ]);
    const out = await getAnnotations.handler(
      getAnnotations.input.parse({ uniprot: 'p69905' }),
      ctx(),
    );

    expect(out).toMatchObject({
      accession: 'P69905',
      proteinName: 'Hemoglobin subunit alpha',
      geneNames: ['HBA1'],
    });
    expect(out.features).toEqual([{ type: 'Domain', description: 'Globin', start: 1, end: 141 }]);
    expect(out.variants).toEqual([
      { type: 'Natural variant', description: 'in dbSNP', start: 6, end: 6 },
    ]);
    expect(out.domains?.[0]).toMatchObject({ accession: 'IPR009050' });
    expect(resolveUniprot).not.toHaveBeenCalled();
  });

  it('resolves a PDB ID to its UniProt accession and records resolvedFrom', async () => {
    resolveUniprot.mockResolvedValue(['P69905']);
    getEntry.mockResolvedValue(entry());
    getInterPro.mockResolvedValue([]);
    const c = ctx();
    const out = await getAnnotations.handler(getAnnotations.input.parse({ pdb_id: '4hhb' }), c);

    expect(resolveUniprot).toHaveBeenCalledWith('4hhb', expect.anything());
    expect(out.accession).toBe('P69905');
    expect(getEnrichment(c)).toMatchObject({ resolvedFrom: '4HHB' });
  });

  it('throws no_uniprot_mapping (with its declared recovery hint) when neither uniprot nor pdb_id is given', async () => {
    await expect(
      getAnnotations.handler(getAnnotations.input.parse({}), ctx()),
    ).rejects.toMatchObject({
      data: {
        reason: 'no_uniprot_mapping',
        recovery: { hint: expect.stringContaining('Pass a UniProt accession directly') },
      },
    });
  });

  it('throws no_uniprot_mapping when the PDB entry has no UniProt cross-reference', async () => {
    resolveUniprot.mockResolvedValue([]); // nucleic-acid-only entry
    await expect(
      getAnnotations.handler(getAnnotations.input.parse({ pdb_id: '1ABC' }), ctx()),
    ).rejects.toMatchObject({ data: { reason: 'no_uniprot_mapping' } });
    expect(getEntry).not.toHaveBeenCalled();
  });

  it('throws no_uniprot_mapping when the resolved accession is malformed', async () => {
    await expect(
      getAnnotations.handler(getAnnotations.input.parse({ uniprot: 'NOTANACC' }), ctx()),
    ).rejects.toMatchObject({ data: { reason: 'no_uniprot_mapping' } });
  });

  it('include:features omits domains and skips the InterPro call', async () => {
    getEntry.mockResolvedValue(entry());
    const out = await getAnnotations.handler(
      getAnnotations.input.parse({ uniprot: 'P69905', include: 'features' }),
      ctx(),
    );
    expect(out.features).toBeDefined();
    expect(out).not.toHaveProperty('domains');
    expect(out).not.toHaveProperty('variants');
    expect(getInterPro).not.toHaveBeenCalled();
  });

  it('include:domains omits features/variants but fetches InterPro', async () => {
    getEntry.mockResolvedValue(entry());
    getInterPro.mockResolvedValue([]);
    const out = await getAnnotations.handler(
      getAnnotations.input.parse({ uniprot: 'P69905', include: 'domains' }),
      ctx(),
    );
    expect(out.domains).toEqual([]);
    expect(out).not.toHaveProperty('features');
    expect(out).not.toHaveProperty('variants');
    expect(getInterPro).toHaveBeenCalledOnce();
  });

  it('output conforms to the declared schema', async () => {
    getEntry.mockResolvedValue(entry());
    getInterPro.mockResolvedValue([]);
    const out = await getAnnotations.handler(
      getAnnotations.input.parse({ uniprot: 'P69905' }),
      ctx(),
    );
    expect(out).toEqual(expect.schemaMatching(getAnnotations.output));
  });

  it('format() renders the header, features, variants, and domains with GO terms', () => {
    const blocks = getAnnotations.format?.({
      accession: 'P69905',
      proteinName: 'Hemoglobin subunit alpha',
      geneNames: ['HBA1'],
      organism: 'Homo sapiens',
      sequenceLength: 142,
      function: 'Oxygen transport',
      features: [{ type: 'Domain', description: 'Globin', start: 1, end: 141 }],
      variants: [{ type: 'Natural variant', start: 6, end: 6 }],
      domains: [
        {
          accession: 'IPR009050',
          name: 'Globin-like superfamily',
          type: 'homologous_superfamily',
          memberDatabases: ['ssf', 'cdd'],
          goTerms: [
            { id: 'GO:0005344', name: 'oxygen carrier activity', category: 'molecular_function' },
          ],
        },
      ],
    });
    const text = (blocks?.[0] as { text: string }).text;

    expect(text).toContain('P69905 — Hemoglobin subunit alpha');
    expect(text).toContain('**Genes:** HBA1');
    expect(text).toContain('**Function:** Oxygen transport');
    expect(text).toContain('**Domain** [1–141]: Globin');
    expect(text).toContain('Variants (1)');
    expect(text).toContain('**IPR009050** Globin-like superfamily');
    expect(text).toContain('GO:0005344 oxygen carrier activity [molecular_function]');
  });

  it('format() collapses a single-residue range to one position', () => {
    const blocks = getAnnotations.format?.({
      accession: 'P1',
      geneNames: [],
      features: [{ type: 'Binding site', start: 87 }],
    });
    const text = (blocks?.[0] as { text: string }).text;
    expect(text).toContain('**Binding site** [87]');
    expect(text).not.toContain('[87–87]');
  });
});
