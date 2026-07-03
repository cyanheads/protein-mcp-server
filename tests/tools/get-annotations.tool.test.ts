/**
 * @fileoverview Tests for protein_get_annotations: direct-accession vs. PDB→UniProt
 * resolution, deterministic multi-accession disambiguation (default lowest-chain
 * pick + ambiguity block, chain selection, unrecognized-chain error), the
 * no_uniprot_mapping failure (missing input, unresolvable PDB, malformed
 * accession), include-scope gating of features/variants/domains, per-response
 * attribution gating (UniProt / InterPro / GO), the resolvedFrom enrichment, and
 * format() rendering of ambiguity, features, variants, InterPro domains with GO
 * terms, and attribution. Services mocked.
 * @module tests/tools/get-annotations.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getEntry = vi.fn();
const getInterPro = vi.fn();
vi.mock('@/services/uniprot/uniprot-service.js', () => ({
  getUniProtService: () => ({ getEntry, getInterPro }),
}));

const resolveUniprotEntities = vi.fn();
vi.mock('@/services/rcsb/rcsb-service.js', () => ({
  getRcsbService: () => ({ resolveUniprotEntities }),
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

/** The real 4HHB polymer-entity xref shape: alpha (chains A/C) + beta (chains B/D). */
const xrefs4hhb = [
  { chains: ['A', 'C'], accession: 'P69905', proteinName: 'Hemoglobin subunit alpha' },
  { chains: ['B', 'D'], accession: 'P68871', proteinName: 'Hemoglobin subunit beta' },
];

const interProDomain = (goTerms: unknown[] = []) => ({
  accession: 'IPR009050',
  name: 'Globin-like superfamily',
  type: 'homologous_superfamily',
  memberDatabases: ['ssf'],
  goTerms,
});

/** N synthetic records of one category — mirrors a dense annotation class (e.g. HBA's 151 variants). */
const many = (category: 'feature' | 'variant', n: number) =>
  Array.from({ length: n }, (_, i) => ({
    category,
    type: category === 'variant' ? 'Natural variant' : 'Region',
    description: `${category} ${i + 1}`,
    start: i + 1,
    end: i + 1,
  }));

beforeEach(() => vi.clearAllMocks());

describe('protein_get_annotations', () => {
  it('fetches by a directly-supplied UniProt accession (include:all)', async () => {
    getEntry.mockResolvedValue(entry());
    getInterPro.mockResolvedValue([interProDomain()]);
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
    expect(out).not.toHaveProperty('ambiguity');
    expect(resolveUniprotEntities).not.toHaveBeenCalled();
  });

  it('resolves a single-mapping PDB ID to its UniProt accession and records resolvedFrom', async () => {
    resolveUniprotEntities.mockResolvedValue([
      { chains: ['A'], accession: 'P69905', proteinName: 'Hemoglobin subunit alpha' },
    ]);
    getEntry.mockResolvedValue(entry());
    getInterPro.mockResolvedValue([]);
    const c = ctx();
    const out = await getAnnotations.handler(getAnnotations.input.parse({ pdb_id: '4hhb' }), c);

    expect(resolveUniprotEntities).toHaveBeenCalledWith('4hhb', expect.anything());
    expect(out.accession).toBe('P69905');
    expect(out).not.toHaveProperty('ambiguity'); // one distinct accession → not ambiguous
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
    resolveUniprotEntities.mockResolvedValue([]); // nucleic-acid-only entry
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
});

describe('protein_get_annotations per-class limit', () => {
  it('caps a dense variant class to the limit and discloses it in one notice (151-variant shape)', async () => {
    getEntry.mockResolvedValue(entry({ features: many('variant', 151) }));
    const c = ctx();
    const out = await getAnnotations.handler(
      getAnnotations.input.parse({ uniprot: 'P69905', include: 'variants' }),
      c,
    );
    expect(out.variants).toHaveLength(50); // default per-class cap
    expect(getEntry).toHaveBeenCalledWith('P69905', 'variants', expect.anything());
    expect(getEnrichment(c).notice).toContain('Showing 50 of 151 variants');
    expect(getEnrichment(c).truncated).toBe(true);
  });

  it('caps features, variants, and domains independently, composing one notice per capped class', async () => {
    getEntry.mockResolvedValue(entry({ features: [...many('feature', 3), ...many('variant', 3)] }));
    getInterPro.mockResolvedValue([interProDomain(), interProDomain(), interProDomain()]);
    const c = ctx();
    const out = await getAnnotations.handler(
      getAnnotations.input.parse({ uniprot: 'P69905', include: 'all', limit: 2 }),
      c,
    );
    expect(out.features).toHaveLength(2);
    expect(out.variants).toHaveLength(2);
    expect(out.domains).toHaveLength(2);
    const notice = String(getEnrichment(c).notice);
    expect(notice).toContain('Showing 2 of 3 features');
    expect(notice).toContain('Showing 2 of 3 variants');
    expect(notice).toContain('Showing 2 of 3 domains');
    expect(getEnrichment(c).truncated).toBe(true);
  });

  it('leaves an under-limit class intact and composes a capped class and a no-data class into one notice', async () => {
    // features over the limit (capped), variants empty (no-data advisory), domains under the limit (intact).
    getEntry.mockResolvedValue(entry({ features: many('feature', 60) }));
    getInterPro.mockResolvedValue([interProDomain(), interProDomain()]);
    const c = ctx();
    const out = await getAnnotations.handler(
      getAnnotations.input.parse({ uniprot: 'P69905', include: 'all' }),
      c,
    );
    expect(out.features).toHaveLength(50); // capped at the default
    expect(out.variants).toEqual([]); // requested, none present
    expect(out.domains).toHaveLength(2); // under the limit — not truncated
    const notice = String(getEnrichment(c).notice);
    expect(notice).toContain('Showing 50 of 60 features'); // truncation fragment
    expect(notice).toContain('No variants present'); // no-data fragment, same single notice
    expect(getEnrichment(c).truncated).toBe(true);
  });

  it('sets a no-data notice without flagging truncation when a requested class is merely empty', async () => {
    getEntry.mockResolvedValue(entry()); // 1 feature + 1 variant, both under the limit
    getInterPro.mockResolvedValue([]); // domains requested but empty
    const c = ctx();
    await getAnnotations.handler(
      getAnnotations.input.parse({ uniprot: 'P69905', include: 'all' }),
      c,
    );
    expect(getEnrichment(c).notice).toContain('No domains present');
    expect(getEnrichment(c)?.truncated).toBeUndefined(); // no class was capped
  });

  it('emits no notice and no truncation flag when every requested class is present and under the limit', async () => {
    getEntry.mockResolvedValue(entry()); // 1 feature + 1 variant
    getInterPro.mockResolvedValue([interProDomain()]); // 1 domain
    const c = ctx();
    await getAnnotations.handler(getAnnotations.input.parse({ uniprot: 'P69905' }), c);
    expect(getEnrichment(c)?.notice).toBeUndefined();
    expect(getEnrichment(c)?.truncated).toBeUndefined();
  });
});

describe('protein_get_annotations multi-accession disambiguation', () => {
  it('unqualified PDB resolution returns the deterministic lowest-chain accession plus ambiguity', async () => {
    // Supplied beta-first to prove the pick does NOT follow upstream entity order.
    resolveUniprotEntities.mockResolvedValue([xrefs4hhb[1], xrefs4hhb[0]]);
    getEntry.mockImplementation((acc: string) => Promise.resolve(entry({ accession: acc })));
    getInterPro.mockResolvedValue([]);
    const out = await getAnnotations.handler(getAnnotations.input.parse({ pdb_id: '4HHB' }), ctx());

    // chain A < chain B, so alpha wins regardless of the beta-first input order.
    expect(out.accession).toBe('P69905');
    expect(getEntry).toHaveBeenCalledWith('P69905', 'all', expect.anything());
    expect(out.ambiguity?.accessions).toEqual([
      { chain: ['A', 'C'], accession: 'P69905', proteinName: 'Hemoglobin subunit alpha' },
      { chain: ['B', 'D'], accession: 'P68871', proteinName: 'Hemoglobin subunit beta' },
    ]);
    expect(out.ambiguity?.notice).toContain('P69905');
  });

  it('chain "A" selects the alpha accession with no ambiguity', async () => {
    resolveUniprotEntities.mockResolvedValue(xrefs4hhb);
    getEntry.mockImplementation((acc: string) => Promise.resolve(entry({ accession: acc })));
    getInterPro.mockResolvedValue([]);
    const out = await getAnnotations.handler(
      getAnnotations.input.parse({ pdb_id: '4HHB', chain: 'A' }),
      ctx(),
    );
    expect(getEntry).toHaveBeenCalledWith('P69905', 'all', expect.anything());
    expect(out.accession).toBe('P69905');
    expect(out).not.toHaveProperty('ambiguity');
  });

  it('chain "B" selects the beta accession with no ambiguity', async () => {
    resolveUniprotEntities.mockResolvedValue(xrefs4hhb);
    getEntry.mockImplementation((acc: string) => Promise.resolve(entry({ accession: acc })));
    getInterPro.mockResolvedValue([]);
    const out = await getAnnotations.handler(
      getAnnotations.input.parse({ pdb_id: '4HHB', chain: 'B' }),
      ctx(),
    );
    expect(getEntry).toHaveBeenCalledWith('P68871', 'all', expect.anything());
    expect(out.accession).toBe('P68871');
    expect(out).not.toHaveProperty('ambiguity');
  });

  it('throws chain_not_found for a chain absent from the entry, before fetching UniProt', async () => {
    resolveUniprotEntities.mockResolvedValue(xrefs4hhb);
    await expect(
      getAnnotations.handler(getAnnotations.input.parse({ pdb_id: '4HHB', chain: 'Z' }), ctx()),
    ).rejects.toMatchObject({
      data: {
        reason: 'chain_not_found',
        recovery: { hint: expect.stringContaining('Author chains in 4HHB') },
      },
    });
    expect(getEntry).not.toHaveBeenCalled();
  });

  it('ignores chain when a UniProt accession is supplied directly (no PDB resolution)', async () => {
    getEntry.mockResolvedValue(entry());
    getInterPro.mockResolvedValue([]);
    const out = await getAnnotations.handler(
      getAnnotations.input.parse({ uniprot: 'P69905', chain: 'Z' }),
      ctx(),
    );
    expect(out.accession).toBe('P69905');
    expect(resolveUniprotEntities).not.toHaveBeenCalled();
  });
});

describe('protein_get_annotations attribution', () => {
  it('include:features attributes UniProt only — no InterPro/GO even though the tool could fetch them', async () => {
    getEntry.mockResolvedValue(entry());
    const out = await getAnnotations.handler(
      getAnnotations.input.parse({ uniprot: 'P69905', include: 'features' }),
      ctx(),
    );
    expect(out.attribution.map((a) => a.source)).toEqual(['UniProt']);
    expect(getInterPro).not.toHaveBeenCalled();
  });

  it('adds InterPro (CC0) when domains are present but withholds GO when no domain carries GO terms', async () => {
    getEntry.mockResolvedValue(entry());
    getInterPro.mockResolvedValue([interProDomain([])]); // domain present, zero GO terms
    const out = await getAnnotations.handler(
      getAnnotations.input.parse({ uniprot: 'P69905', include: 'domains' }),
      ctx(),
    );
    expect(out.attribution.map((a) => a.source)).toEqual(['UniProt', 'InterPro']);
    expect(out.attribution.find((a) => a.source === 'InterPro')?.license).toBe('CC0 1.0 Universal');
    expect(out.attribution.find((a) => a.source === 'UniProt')?.license).toBe('CC BY 4.0');
  });

  it('adds GO (CC BY 4.0) independently when a returned InterPro entry carries GO terms', async () => {
    getEntry.mockResolvedValue(entry());
    getInterPro.mockResolvedValue([
      interProDomain([{ id: 'GO:0005344', name: 'oxygen carrier activity' }]),
    ]);
    const out = await getAnnotations.handler(
      getAnnotations.input.parse({ uniprot: 'P69905', include: 'all' }),
      ctx(),
    );
    expect(out.attribution.map((a) => a.source)).toEqual(['UniProt', 'InterPro', 'GO']);
    expect(out.attribution.find((a) => a.source === 'GO')?.license).toBe('CC BY 4.0');
  });
});

describe('protein_get_annotations format()', () => {
  it('renders the header, ambiguity, features, variants, domains with GO terms, and attribution', () => {
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
      ambiguity: {
        accessions: [
          { chain: ['A', 'C'], accession: 'P69905', proteinName: 'Hemoglobin subunit alpha' },
          { chain: ['B', 'D'], accession: 'P68871', proteinName: 'Hemoglobin subunit beta' },
        ],
        notice: '4HHB maps to 2 distinct UniProt accessions across its chains.',
      },
      attribution: [
        {
          source: 'UniProt',
          license: 'CC BY 4.0',
          citation: 'The UniProt Consortium, Nucleic Acids Research 53(D1):D609–D617 (2025).',
          homepage: 'https://www.uniprot.org/',
        },
      ],
    });
    const text = (blocks?.[0] as { text: string }).text;

    expect(text).toContain('P69905 — Hemoglobin subunit alpha');
    expect(text).toContain('**Genes:** HBA1');
    expect(text).toContain('**Function:** Oxygen transport');
    expect(text).toContain('Multiple UniProt mappings');
    expect(text).toContain('**P68871** — Hemoglobin subunit beta (chains B, D)');
    expect(text).toContain('**Domain** [1–141]: Globin');
    expect(text).toContain('Variants (1)');
    expect(text).toContain('**IPR009050** Globin-like superfamily');
    expect(text).toContain('GO:0005344 oxygen carrier activity [molecular_function]');
    expect(text).toContain('### Attribution');
    expect(text).toContain('**UniProt** (CC BY 4.0)');
    expect(text).toContain('https://www.uniprot.org/');
  });

  it('collapses a single-residue range to one position', () => {
    const blocks = getAnnotations.format?.({
      accession: 'P1',
      geneNames: [],
      features: [{ type: 'Binding site', start: 87 }],
      attribution: [],
    });
    const text = (blocks?.[0] as { text: string }).text;
    expect(text).toContain('**Binding site** [87]');
    expect(text).not.toContain('[87–87]');
  });
});
