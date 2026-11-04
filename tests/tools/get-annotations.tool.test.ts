/**
 * @fileoverview Tests for protein_get_annotations: direct-accession vs. PDB→UniProt
 * resolution, deterministic multi-accession disambiguation (default lowest-chain
 * pick + ambiguity block, chain selection, unrecognized-chain error), the
 * missing_identifier / invalid_accession input rejections (isoforms named to
 * their canonical accession), the no_uniprot_mapping failure (unresolvable PDB,
 * upstream-malformed accession), include-scope gating of features/variants/
 * domains, per-class paging over InterPro's own membership count with the
 * early-stop notice, per-response attribution gating (UniProt / InterPro / GO),
 * the resolvedFrom enrichment, the one call budget across RCSB, UniProt, and
 * InterPro, and format() rendering. Service-level mocks cover the wiring; the
 * accession-status block runs the real UniProt service against a fetch fake to
 * pin the merge, inactive, never-assigned, and zero-membership paths and the
 * speculative InterPro request each one aborts or keeps.
 * @module tests/tools/get-annotations.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getEntry = vi.fn();
const getInterPro = vi.fn();
vi.mock('@/services/uniprot/uniprot-service.js', async (importOriginal) => ({
  // The real module (UniProtService, error and notice builders) with the singleton swapped.
  ...(await importOriginal<typeof import('@/services/uniprot/uniprot-service.js')>()),
  getUniProtService: () => ({ getEntry, getInterPro }),
}));

const resolveUniprotEntities = vi.fn();
vi.mock('@/services/rcsb/rcsb-service.js', () => ({
  getRcsbService: () => ({ resolveUniprotEntities }),
}));

import { getAnnotations } from '@/mcp-server/tools/definitions/get-annotations.tool.js';
import { type AnnotationInclude, UniProtService } from '@/services/uniprot/uniprot-service.js';

const ctx = () => createMockContext({ errors: getAnnotations.errors });

/** What `UniProtService.getInterPro` resolves to: the retrieved memberships beside InterPro's count. */
const memberships = (entries: unknown[], total = entries.length) => ({ entries, total });

/** The text of every content[] text block, joined. */
const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

/** A `runToolContract` failure — the envelope that carries the declared recovery fill. */
type ContractError = {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent: {
    error: {
      code: number;
      data: { reason: string; recovery?: { hint: string } } & Record<string, unknown>;
    };
  };
};

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
    getInterPro.mockResolvedValue(memberships([interProDomain()]));
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
    getInterPro.mockResolvedValue(memberships([]));
    const c = ctx();
    const out = await getAnnotations.handler(getAnnotations.input.parse({ pdb_id: '4hhb' }), c);

    expect(resolveUniprotEntities).toHaveBeenCalledWith('4hhb', expect.anything());
    expect(out.accession).toBe('P69905');
    expect(out).not.toHaveProperty('ambiguity'); // one distinct accession → not ambiguous
    expect(getEnrichment(c)).toMatchObject({ resolvedFrom: '4HHB' });
  });

  it('throws missing_identifier (InvalidParams) naming both parameters when neither is given (#46)', async () => {
    const result = (await runToolContract(getAnnotations, {})) as ContractError;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: {
        reason: 'missing_identifier',
        recovery: { hint: expect.stringMatching(/uniprot[\s\S]*pdb_id/i) },
      },
    });
    // Rejected handler-side before any upstream call — an absent parameter is not
    // a lookup that found nothing.
    expect(resolveUniprotEntities).not.toHaveBeenCalled();
    expect(getEntry).not.toHaveBeenCalled();
  });

  it('throws no_uniprot_mapping when the PDB entry has no UniProt cross-reference', async () => {
    resolveUniprotEntities.mockResolvedValue([]); // nucleic-acid-only entry
    await expect(
      getAnnotations.handler(getAnnotations.input.parse({ pdb_id: '1ABC' }), ctx()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_uniprot_mapping' },
    });
    expect(getEntry).not.toHaveBeenCalled();
  });

  it('throws invalid_accession (InvalidParams) describing the format for a malformed uniprot (#46)', async () => {
    const result = (await runToolContract(getAnnotations, {
      uniprot: 'NOTANACC',
    })) as ContractError;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: {
        reason: 'invalid_accession',
        recovery: { hint: expect.stringContaining('P69905') },
      },
    });
    expect(resolveUniprotEntities).not.toHaveBeenCalled();
    expect(getEntry).not.toHaveBeenCalled();
  });

  it.each([
    ['P04637-2', 'P04637'],
    ['p04637-2', 'P04637'],
    ['P04637-1', 'P04637'],
    ['P04637-99', 'P04637'],
    ['A0A024R161-3', 'A0A024R161'],
  ])(
    'rejects the isoform %s as invalid_accession, naming its canonical accession %s, before any request (#91)',
    async (uniprot, canonical) => {
      const result = (await runToolContract(getAnnotations, { uniprot })) as ContractError;
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_accession' },
      });
      expect(textOf(result)).toContain(
        `"${uniprot}" is an isoform of ${canonical}; UniProt annotates the canonical entry, so pass ${canonical}.`,
      );
      expect(getEntry).not.toHaveBeenCalled();
      expect(getInterPro).not.toHaveBeenCalled();
    },
  );

  it('keeps the plain malformed-accession message for a suffix that is no isoform (#91)', async () => {
    const result = (await runToolContract(getAnnotations, {
      uniprot: 'P04637-0',
    })) as ContractError;
    expect(result.structuredContent.error.data.reason).toBe('invalid_accession');
    expect(textOf(result)).toContain('"P04637-0" is not a valid UniProt accession.');
    expect(textOf(result)).not.toContain('isoform of');
    expect(getEntry).not.toHaveBeenCalled();
  });

  it('fails accession_not_found naming the accession when UniProt has no entry (#83)', async () => {
    getEntry.mockResolvedValue(null);
    getInterPro.mockResolvedValue(memberships([]));
    const result = (await runToolContract(getAnnotations, {
      uniprot: 'A0A9Z9Z9Z9',
    })) as ContractError;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'accession_not_found', recovery: { hint: expect.any(String) } },
    });
    expect(textOf(result)).toContain('A0A9Z9Z9Z9');
  });

  it('keeps no_uniprot_mapping when a pdb_id resolves to a malformed accession (#46)', async () => {
    // An upstream-data problem, not caller input — this branch stays NotFound.
    resolveUniprotEntities.mockResolvedValue([{ chains: ['A'], accession: 'NOTANACC' }]);
    await expect(
      getAnnotations.handler(getAnnotations.input.parse({ pdb_id: '1ABC' }), ctx()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_uniprot_mapping' },
    });
    expect(getEntry).not.toHaveBeenCalled();
  });

  it('leaves a valid uniprot and a resolving pdb_id unaffected (#46)', async () => {
    getEntry.mockResolvedValue(entry());
    getInterPro.mockResolvedValue(memberships([]));
    const direct = await getAnnotations.handler(
      getAnnotations.input.parse({ uniprot: 'p69905' }),
      ctx(),
    );
    expect(direct.accession).toBe('P69905');

    resolveUniprotEntities.mockResolvedValue([{ chains: ['A'], accession: 'P69905' }]);
    const resolved = await getAnnotations.handler(
      getAnnotations.input.parse({ pdb_id: '4HHB' }),
      ctx(),
    );
    expect(resolved.accession).toBe('P69905');
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
    getInterPro.mockResolvedValue(memberships([]));
    const out = await getAnnotations.handler(
      getAnnotations.input.parse({ uniprot: 'P69905', include: 'domains' }),
      ctx(),
    );
    expect(out.domains).toEqual([]);
    expect(out).not.toHaveProperty('features');
    expect(out).not.toHaveProperty('variants');
    expect(getInterPro).toHaveBeenCalledOnce();
  });

  it('requests InterPro while the entry is still loading, not after it', async () => {
    let resolveEntry: (value: unknown) => void = () => {};
    getEntry.mockReturnValue(
      new Promise((resolve) => {
        resolveEntry = resolve;
      }),
    );
    getInterPro.mockResolvedValue(memberships([interProDomain()]));
    const running = getAnnotations.handler(
      getAnnotations.input.parse({ uniprot: 'P69905' }),
      ctx(),
    );
    await vi.waitFor(() => expect(getEntry).toHaveBeenCalledOnce());
    // The entry has not answered yet, and InterPro is already on its way.
    expect(getInterPro).toHaveBeenCalledWith('P69905', expect.anything());
    resolveEntry(entry());
    expect((await running).domains).toHaveLength(1);
  });

  it('output conforms to the declared schema', async () => {
    getEntry.mockResolvedValue(entry());
    getInterPro.mockResolvedValue(memberships([]));
    const out = await getAnnotations.handler(
      getAnnotations.input.parse({ uniprot: 'P69905' }),
      ctx(),
    );
    expect(out).toEqual(expect.schemaMatching(getAnnotations.output));
  });
});

describe('protein_get_annotations per-class limit', () => {
  it('walks each class without overlaps, stops on final pages, and reports empty totals (#65)', async () => {
    getEntry.mockResolvedValue(entry({ features: [...many('feature', 5), ...many('variant', 3)] }));
    getInterPro.mockResolvedValue(memberships([]));
    const starts: number[] = [];
    for (const features_offset of [0, 2, 4]) {
      const result = await runToolContract(getAnnotations, {
        uniprot: 'P69905',
        include: 'features',
        limit: 2,
        features_offset,
      });
      const output = result.structuredContent as {
        features: Array<{ start: number }>;
        truncated?: boolean;
      };
      starts.push(...output.features.map((f) => f.start));
      expect(output.truncated).toBe(features_offset === 4 ? undefined : true);
      if (features_offset === 4)
        expect(JSON.stringify(result.content)).not.toContain('continue with');
    }
    expect(starts).toEqual([1, 2, 3, 4, 5]);
    const empty = await runToolContract(getAnnotations, {
      uniprot: 'P69905',
      include: 'domains',
      domains_offset: 9,
    });
    expect(empty.structuredContent).toMatchObject({ domains: [], domainsTotal: 0 });
    expect(JSON.stringify(empty.content)).toContain('No domains present.');
    for (const key of ['features_offset', 'variants_offset', 'domains_offset']) {
      for (const value of [-1, 0.5])
        expect(getAnnotations.input.safeParse({ uniprot: 'P69905', [key]: value }).success).toBe(
          false,
        );
    }
    expect(getAnnotations.input.safeParse({ limit: 201 }).success).toBe(false);
  });

  it('carries variant changes and separate domain fragments through both response surfaces (#68)', async () => {
    getEntry.mockResolvedValue(
      entry({
        features: [
          {
            category: 'variant',
            type: 'Natural variant',
            featureId: 'VAR_002856',
            start: 2,
            originalSequence: 'V',
            alternativeSequences: ['A', 'G'],
          },
          {
            category: 'variant',
            type: 'Natural variant',
            originalSequence: '',
            alternativeSequences: [],
          },
          { category: 'variant', type: 'Natural variant' },
        ],
      }),
    );
    const domain = {
      ...interProDomain(),
      locations: [
        {
          fragments: [
            { start: 2, end: 9, dcStatus: 'N_TERMINAL_DISC' },
            { start: 20, end: 30, dcStatus: '' },
          ],
        },
        { fragments: [] },
        {},
      ],
    };
    getInterPro.mockResolvedValue(memberships([domain]));
    const result = await runToolContract(getAnnotations, { uniprot: 'P68871' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      variants: [
        {
          type: 'Natural variant',
          featureId: 'VAR_002856',
          start: 2,
          originalSequence: 'V',
          alternativeSequences: ['A', 'G'],
        },
        { type: 'Natural variant', originalSequence: '', alternativeSequences: [] },
        { type: 'Natural variant' },
      ],
      domains: [domain],
    });
    const text = result.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    expect(text).toContain('ID "VAR_002856" ("V" → ["A","G"])');
    expect(text).toContain('("" → [])');
    expect(text).toContain('Location 1: 2–9 ["N_TERMINAL_DISC"], 20–30 [""]');
    expect(text).toContain('Location 2: no fragments');
    expect(text).toContain('Location 3: fragments unknown');
    expect(text).not.toContain('deletion');
  });
  it('continues independent annotation pages with totals and executable recovery (#65)', async () => {
    getEntry.mockResolvedValue(entry({ features: [...many('feature', 5), ...many('variant', 4)] }));
    getInterPro.mockResolvedValue(
      memberships([interProDomain(), { ...interProDomain(), accession: 'IPR000002' }]),
    );
    const result = await runToolContract(getAnnotations, {
      uniprot: 'P69905',
      limit: 2,
      features_offset: 2,
      variants_offset: 3,
      domains_offset: 1,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      features: [{ start: 3 }, { start: 4 }],
      variants: [{ start: 4 }],
      domains: [{ accession: 'IPR000002' }],
      featuresTotal: 5,
      variantsTotal: 4,
      domainsTotal: 2,
    });
    expect(JSON.stringify(result.content)).toContain('features_offset: 4');
    expect(JSON.stringify(result.content)).toContain('Features (2 of 5)');
  });

  it.each([4, 9])(
    'distinguishes exhausted variants at offset %i from absent classes (#65)',
    async (variants_offset) => {
      getEntry.mockResolvedValue(entry({ features: many('variant', 4) }));
      const result = await runToolContract(getAnnotations, {
        uniprot: 'P69905',
        include: 'variants',
        variants_offset,
        limit: 2,
      });
      expect(result.structuredContent).toMatchObject({ variants: [], variantsTotal: 4 });
      expect(result.structuredContent).not.toHaveProperty('featuresTotal');
      expect(result.structuredContent).not.toHaveProperty('truncated');
      const text = JSON.stringify(result.content);
      expect(text).toContain(`offset ${variants_offset}`);
      expect(text).toContain('total 4');
      expect(text).toContain('lower variants_offset');
      expect(text).not.toContain('No variants present');
    },
  );
  it('preserves explicit first-page contents and independent caps', async () => {
    getEntry.mockResolvedValue(entry({ features: [...many('feature', 3), ...many('variant', 4)] }));
    getInterPro.mockResolvedValue(memberships([interProDomain()]));
    const out = await getAnnotations.handler(
      getAnnotations.input.parse({ uniprot: 'P69905', limit: 2 }),
      ctx(),
    );
    expect(out.features?.map((f) => f.start)).toEqual([1, 2]);
    expect(out.variants?.map((f) => f.start)).toEqual([1, 2]);
    expect(out.domains).toHaveLength(1);
  });
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
    getInterPro.mockResolvedValue(
      memberships([interProDomain(), interProDomain(), interProDomain()]),
    );
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
    getInterPro.mockResolvedValue(memberships([interProDomain(), interProDomain()]));
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
    getInterPro.mockResolvedValue(memberships([])); // domains requested but empty
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
    getInterPro.mockResolvedValue(memberships([interProDomain()])); // 1 domain
    const c = ctx();
    await getAnnotations.handler(getAnnotations.input.parse({ uniprot: 'P69905' }), c);
    expect(getEnrichment(c)?.notice).toBeUndefined();
    expect(getEnrichment(c)?.truncated).toBeUndefined();
  });

  it("reports InterPro's count as domainsTotal, names an early stop, and pages over what was retrieved (#81)", async () => {
    getEntry.mockResolvedValue(entry());
    const retrieved = ['IPR000001', 'IPR000002', 'IPR000003'].map((accession) => ({
      ...interProDomain(),
      accession,
    }));
    getInterPro.mockResolvedValue(memberships(retrieved, 1234));
    const page = (domains_offset: number) =>
      runToolContract(getAnnotations, {
        uniprot: 'P69905',
        include: 'domains',
        limit: 2,
        domains_offset,
      });
    const stopped =
      'Retrieved 3 of 1234 domains; paging stopped early, so domains_offset reaches only those 3.';

    const first = await page(0);
    expect(first.structuredContent).toMatchObject({
      domains: [{ accession: 'IPR000001' }, { accession: 'IPR000002' }],
      domainsTotal: 1234,
      truncated: true,
      notice: `${stopped} Showing 2 of 3 retrieved domains at offset 0; continue with domains_offset: 2.`,
    });
    expect(textOf(first)).toContain('InterPro domains (2 of 1234)');
    expect(textOf(first)).toContain(stopped);

    // The last retrieved page: nothing further to offer, yet the set is still short of the count.
    const last = await page(2);
    expect(last.structuredContent).toMatchObject({
      domains: [{ accession: 'IPR000003' }],
      domainsTotal: 1234,
      truncated: true,
      notice: stopped,
    });
    expect(textOf(last)).not.toContain('continue with');

    const past = await page(3);
    expect(past.structuredContent).toMatchObject({ domains: [], domainsTotal: 1234 });
    expect((past.structuredContent as { notice: string }).notice).toContain(
      'No domains at offset 3 (3 retrieved of 1234); use a lower domains_offset, such as 0.',
    );
  });

  it('puts the merge notice first, re-reads InterPro for the successor, and aborts the speculative read (#83)', async () => {
    getEntry.mockResolvedValue(
      entry({ mergedFrom: 'Q1HDT5', features: many('feature', 3), accession: 'P69905' }),
    );
    const signals: AbortSignal[] = [];
    getInterPro.mockImplementation((accession: string, c: { signal: AbortSignal }) => {
      signals.push(c.signal);
      return Promise.resolve(
        accession === 'P69905' ? memberships([interProDomain()]) : memberships([]),
      );
    });
    const result = await runToolContract(getAnnotations, { uniprot: 'Q1HDT5', limit: 2 });
    expect(result.isError).not.toBe(true);

    expect(getInterPro.mock.calls.map(([accession]) => accession)).toEqual(['Q1HDT5', 'P69905']);
    expect(signals.map((s) => s.aborted)).toEqual([true, false]);
    const merged = 'Q1HDT5 was merged into P69905 in UniProtKB; this answer is for P69905.';
    expect(result.structuredContent).toMatchObject({
      accession: 'P69905',
      domains: [{ accession: 'IPR009050' }],
      domainsTotal: 1,
      notice: `${merged} Showing 2 of 3 features at offset 0; continue with features_offset: 2. No variants present.`,
    });
    expect(textOf(result)).toContain(merged);
  });
});

describe('protein_get_annotations multi-accession disambiguation', () => {
  it('unqualified PDB resolution returns the deterministic lowest-chain accession plus ambiguity', async () => {
    // Supplied beta-first to prove the pick does NOT follow upstream entity order.
    resolveUniprotEntities.mockResolvedValue([xrefs4hhb[1], xrefs4hhb[0]]);
    getEntry.mockImplementation((acc: string) => Promise.resolve(entry({ accession: acc })));
    getInterPro.mockResolvedValue(memberships([]));
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
    getInterPro.mockResolvedValue(memberships([]));
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
    getInterPro.mockResolvedValue(memberships([]));
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
        // Entity order (alpha A, C; then beta B, D), not alphabetical (#85).
        recovery: { hint: expect.stringContaining('Author chains in 4HHB: A, C, B, D.') },
      },
    });
    expect(getEntry).not.toHaveBeenCalled();
  });

  it('ignores chain when a UniProt accession is supplied directly (no PDB resolution)', async () => {
    getEntry.mockResolvedValue(entry());
    getInterPro.mockResolvedValue(memberships([]));
    const out = await getAnnotations.handler(
      getAnnotations.input.parse({ uniprot: 'P69905', chain: 'Z' }),
      ctx(),
    );
    expect(out.accession).toBe('P69905');
    expect(resolveUniprotEntities).not.toHaveBeenCalled();
  });
});

describe('protein_get_annotations call budget (#83)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A service call that holds until its signal aborts, then fails with the signal's reason. */
  const untilAborted = (signal: AbortSignal) =>
    new Promise<never>((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );

  it('bounds the PDB lookup, the entry, and InterPro by one 50 s budget, leaving the caller signal alone', async () => {
    const seen: Record<'rcsb' | 'entry' | 'interpro', AbortSignal | undefined> = {
      rcsb: undefined,
      entry: undefined,
      interpro: undefined,
    };
    // The PDB lookup spends 30 s of the budget before the UniProt and InterPro reads start.
    resolveUniprotEntities.mockImplementation((_id: string, c: { signal: AbortSignal }) => {
      seen.rcsb = c.signal;
      return new Promise((resolve) =>
        setTimeout(() => resolve([{ chains: ['A'], accession: 'P69905' }]), 30_000),
      );
    });
    getEntry.mockImplementation((_acc: string, _inc: string, c: { signal: AbortSignal }) => {
      seen.entry = c.signal;
      return untilAborted(c.signal);
    });
    getInterPro.mockImplementation((_acc: string, c: { signal: AbortSignal }) => {
      seen.interpro = c.signal;
      return untilAborted(c.signal);
    });
    const caller = new AbortController();
    const running = Promise.resolve(
      getAnnotations.handler(
        getAnnotations.input.parse({ pdb_id: '4HHB' }),
        createMockContext({ errors: getAnnotations.errors, signal: caller.signal }),
      ),
    ).catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(getEntry).toHaveBeenCalledOnce();
    expect(getInterPro).toHaveBeenCalledOnce();
    const aborted = () => [seen.rcsb, seen.entry, seen.interpro].map((s) => s?.aborted);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(aborted()).toEqual([false, false, false]);
    await vi.advanceTimersByTimeAsync(1);
    expect(aborted()).toEqual([true, true, true]);
    expect(seen.interpro?.reason).toMatchObject({ name: 'TimeoutError' });
    expect(caller.signal.aborted).toBe(false);

    expect(await running).toMatchObject({ name: 'TimeoutError' });
    expect(vi.getTimerCount()).toBe(0); // no clock outlives the call
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
    getInterPro.mockResolvedValue(memberships([interProDomain([])])); // domain present, zero GO terms
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
    getInterPro.mockResolvedValue(
      memberships([interProDomain([{ id: 'GO:0005344', name: 'oxygen carrier activity' }])]),
    );
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
    const blocks = getAnnotations.format!({
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
    const text = (blocks[0] as { text: string }).text;

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
    const blocks = getAnnotations.format!({
      accession: 'P1',
      geneNames: [],
      features: [{ type: 'Binding site', start: 87 }],
      attribution: [],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Binding site** [87]');
    expect(text).not.toContain('[87–87]');
  });
});

/** A route on one test host, matched by hostname and path — never by substring. */
const on = (host: 'uniprot.test' | 'interpro.test', path: string) => (req: Request) => {
  const url = new URL(req.url);
  return url.hostname === host && url.pathname === path;
};

/** A field-selected UniProtKB entry for P69905, trimmed (shape of a live capture, UniProt 2026_03). */
const P69905_ENTRY = {
  entryType: 'UniProtKB reviewed (Swiss-Prot)',
  primaryAccession: 'P69905',
  proteinDescription: { recommendedName: { fullName: { value: 'Hemoglobin subunit alpha' } } },
  genes: [{ geneName: { value: 'HBA1' } }],
  organism: { scientificName: 'Homo sapiens', taxonId: 9606 },
  sequence: { length: 142, value: 'MVLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTTKTYFPHF' },
  features: [
    {
      type: 'Chain',
      description: 'Hemoglobin subunit alpha',
      location: { start: { value: 2 }, end: { value: 142 } },
    },
    {
      type: 'Domain',
      description: 'Globin',
      location: { start: { value: 2 }, end: { value: 142 } },
    },
  ],
};

/**
 * What fetch hands back for merged Q1HDT5: UniProt answers 303 to P69905 and the
 * redirect drops `fields`, so the successor arrives whole, secondary structure included.
 */
const FOLLOWED_Q1HDT5 = {
  ...P69905_ENTRY,
  secondaryAccessions: ['P01922', 'Q1HDT5'],
  features: [
    { type: 'Helix', location: { start: { value: 4 }, end: { value: 17 } } },
    { type: 'Turn', location: { start: { value: 51 }, end: { value: 53 } } },
    ...P69905_ENTRY.features,
  ],
};

/** UniProt's 200 answers for a demerged and a deleted accession (live captures, UniProt 2026_03). */
const DEMERGED_P62988 = {
  entryType: 'Inactive',
  primaryAccession: 'P62988',
  inactiveReason: {
    inactiveReasonType: 'DEMERGED',
    mergeDemergeTo: ['P0CG47', 'P0CG48', 'P62979', 'P62987'],
  },
};
const DELETED_A0A008APQ8 = {
  entryType: 'Inactive',
  primaryAccession: 'A0A008APQ8',
  inactiveReason: {
    inactiveReasonType: 'DELETED',
    deletedReason: 'Not part of a reference proteome',
  },
};

/** InterPro's protein record; a zero counter is omitted, as InterPro omits it (P84996 answers `dbEntries: {}`). */
const proteinRecord = (interpro?: number) =>
  Response.json({
    metadata: { counters: { dbEntries: interpro === undefined ? {} : { pfam: 1, interpro } } },
  });

/** One complete InterPro membership page for `protein`. */
const entriesPage = (protein: string, accessions: string[]) =>
  Response.json({
    count: accessions.length,
    next: null,
    previous: null,
    results: accessions.map((accession) => ({
      metadata: { accession, name: `${accession} name`, type: 'family', member_databases: {} },
      proteins: [{ accession: protein.toLowerCase(), entry_protein_locations: [] }],
    })),
  });

describe('protein_get_annotations accession status through the UniProt service (#83)', () => {
  let http: ReturnType<typeof createFetchMock>;
  /** Every getInterPro call the handler makes, and whether its promise has settled. */
  let interproCalls: Array<{ accession: string; settled: boolean }>;
  /** Paths of InterPro requests that were aborted while held open. */
  let abortedPaths: string[];

  /**
   * An InterPro request that never answers: it waits for its abort, then fails one
   * macrotask later — so only a handler that awaits the aborted read sees it settle
   * before returning.
   */
  const heldOpen = (req: Request) =>
    new Promise<Response>((_, reject) => {
      const fail = () => {
        abortedPaths.push(new URL(req.url).pathname);
        setTimeout(() => reject(req.signal.reason), 0);
      };
      if (req.signal.aborted) fail();
      else req.signal.addEventListener('abort', fail, { once: true });
    });

  const interproRequests = () =>
    http.calls.filter((c) => new URL(c.request.url).hostname === 'interpro.test');

  beforeEach(() => {
    const real = new UniProtService(
      {} as never,
      {} as never,
      { uniprotBaseUrl: 'https://uniprot.test', interproBaseUrl: 'https://interpro.test' } as never,
    );
    interproCalls = [];
    abortedPaths = [];
    getEntry.mockImplementation((accession: string, include: AnnotationInclude, c: Context) =>
      real.getEntry(accession, include, c),
    );
    getInterPro.mockImplementation((accession: string, c: Context) => {
      const call = { accession, settled: false };
      interproCalls.push(call);
      return real.getInterPro(accession, c).finally(() => {
        call.settled = true;
      });
    });
    http = createFetchMock();
    http.install();
  });

  afterEach(() => {
    http.restore();
    getEntry.mockReset();
    getInterPro.mockReset();
  });

  it("answers a merged accession for its successor: the successor's own fields, its InterPro, the merge notice first", async () => {
    http.route(
      { match: on('uniprot.test', '/uniprotkb/Q1HDT5'), respond: Response.json(FOLLOWED_Q1HDT5) },
      { match: on('uniprot.test', '/uniprotkb/P69905'), respond: Response.json(P69905_ENTRY) },
      { match: on('interpro.test', '/protein/UniProt/Q1HDT5/'), respond: heldOpen },
      { match: on('interpro.test', '/protein/UniProt/P69905/'), respond: proteinRecord(1) },
      {
        match: on('interpro.test', '/entry/interpro/protein/UniProt/P69905/'),
        respond: entriesPage('P69905', ['IPR002338']),
      },
    );
    const result = await runToolContract(getAnnotations, { uniprot: 'Q1HDT5' });
    expect(result.isError).not.toBe(true);

    const merged = 'Q1HDT5 was merged into P69905 in UniProtKB; this answer is for P69905.';
    const out = result.structuredContent as {
      accession: string;
      features: Array<{ type: string }>;
      notice: string;
    };
    expect(out).toMatchObject({
      accession: 'P69905',
      featuresTotal: 2,
      domains: [{ accession: 'IPR002338' }],
      domainsTotal: 1,
    });
    // The field-selected successor record, not the redirect's whole entry.
    expect(out.features.map((f) => f.type)).toEqual(['Chain', 'Domain']);
    expect(out.notice.startsWith(merged)).toBe(true);
    expect(textOf(result)).toContain(merged);

    // The speculative read for Q1HDT5 was aborted, never retried, and settled before the call returned.
    expect(abortedPaths).toEqual(['/protein/UniProt/Q1HDT5/']);
    expect(interproCalls).toEqual([
      { accession: 'Q1HDT5', settled: true },
      { accession: 'P69905', settled: true },
    ]);
    expect(interproRequests().map((c) => new URL(c.request.url).pathname)).toEqual([
      '/protein/UniProt/Q1HDT5/',
      '/protein/UniProt/P69905/',
      '/entry/interpro/protein/UniProt/P69905/',
    ]);
  });

  it("answers a merged accession under include:features with the successor's field-selected features and no InterPro read", async () => {
    http.route(
      { match: on('uniprot.test', '/uniprotkb/Q1HDT5'), respond: Response.json(FOLLOWED_Q1HDT5) },
      { match: on('uniprot.test', '/uniprotkb/P69905'), respond: Response.json(P69905_ENTRY) },
    );
    const result = await runToolContract(getAnnotations, {
      uniprot: 'Q1HDT5',
      include: 'features',
    });
    expect(result.structuredContent).toMatchObject({
      accession: 'P69905',
      features: [{ type: 'Chain' }, { type: 'Domain' }],
      featuresTotal: 2,
      notice: 'Q1HDT5 was merged into P69905 in UniProtKB; this answer is for P69905.',
    });
    expect(textOf(result)).not.toMatch(/Helix|Turn/);
    expect(interproRequests()).toEqual([]);
  });

  it.each(['features', 'variants', 'domains', 'all'] as const)(
    'fails a demerged accession as inactive_accession with its replacements under include:%s, leaving no InterPro read running',
    async (include) => {
      http.route(
        {
          match: on('uniprot.test', '/uniprotkb/P62988'),
          respond: Response.json(DEMERGED_P62988),
        },
        { match: on('interpro.test', '/protein/UniProt/P62988/'), respond: heldOpen },
      );
      const result = (await runToolContract(getAnnotations, {
        uniprot: 'P62988',
        include,
      })) as ContractError;

      expect(result.isError).toBe(true);
      expect(result.structuredContent.error).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'inactive_accession',
          accession: 'P62988',
          inactiveReason: 'DEMERGED',
          replacements: ['P0CG47', 'P0CG48', 'P62979', 'P62987'],
          recovery: { hint: 'Retry with a replacement accession: P0CG47, P0CG48, P62979, P62987.' },
        },
      });
      expect(textOf(result)).toContain(
        'P62988 is inactive in UniProtKB (DEMERGED); replaced by P0CG47, P0CG48, P62979, P62987.',
      );
      if (include === 'domains' || include === 'all') {
        expect(abortedPaths).toEqual(['/protein/UniProt/P62988/']);
        expect(interproCalls).toEqual([{ accession: 'P62988', settled: true }]);
        expect(interproRequests()).toHaveLength(1); // aborted, never retried
      } else {
        expect(interproRequests()).toEqual([]);
      }
    },
  );

  it('fails a deleted accession as inactive_accession with no replacements and the declared recovery', async () => {
    http.route({
      match: on('uniprot.test', '/uniprotkb/A0A008APQ8'),
      respond: Response.json(DELETED_A0A008APQ8),
    });
    const result = (await runToolContract(getAnnotations, {
      uniprot: 'A0A008APQ8',
      include: 'features',
    })) as ContractError;

    const declared = getAnnotations.errors?.find((e) => e.reason === 'inactive_accession');
    expect(declared?.recovery).toBeDefined();
    expect(result.structuredContent.error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'inactive_accession',
        accession: 'A0A008APQ8',
        inactiveReason: 'DELETED',
        replacements: [],
        recovery: { hint: declared?.recovery },
      },
    });
    expect(textOf(result)).toMatch(/no replacement/i);
    expect(textOf(result)).toContain('Not part of a reference proteome');
  });

  it('fails a never-assigned accession as accession_not_found, without the upstream URL or a retry', async () => {
    http.route(
      {
        match: on('uniprot.test', '/uniprotkb/A0A9Z9Z9Z9'),
        respond: () =>
          new Response(
            JSON.stringify({
              url: 'http://rest.uniprot.org/uniprotkb/A0A9Z9Z9Z9',
              messages: ['Resource not found'],
            }),
            { status: 404, headers: { 'content-type': 'application/json' } },
          ),
      },
      { match: on('interpro.test', '/protein/UniProt/A0A9Z9Z9Z9/'), respond: heldOpen },
    );
    const result = (await runToolContract(getAnnotations, {
      uniprot: 'A0A9Z9Z9Z9',
    })) as ContractError;

    const declared = getAnnotations.errors?.find((e) => e.reason === 'accession_not_found');
    expect(result.structuredContent.error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'accession_not_found', recovery: { hint: declared?.recovery } },
    });
    const text = textOf(result);
    expect(text).toContain('A0A9Z9Z9Z9');
    expect(text).not.toMatch(/uniprot\.test|rest\.uniprot\.org|Status: 404|Resource not found/);
    expect(
      http.calls.filter((c) => new URL(c.request.url).hostname === 'uniprot.test'),
    ).toHaveLength(1);
    expect(abortedPaths).toEqual(['/protein/UniProt/A0A9Z9Z9Z9/']);
    expect(interproCalls).toEqual([{ accession: 'A0A9Z9Z9Z9', settled: true }]);
  });

  it('answers an active accession without InterPro memberships with domainsTotal 0, reading only the protein record', async () => {
    http.route(
      {
        match: on('uniprot.test', '/uniprotkb/P84996'),
        respond: Response.json({ ...P69905_ENTRY, primaryAccession: 'P84996', features: [] }),
      },
      { match: on('interpro.test', '/protein/UniProt/P84996/'), respond: proteinRecord() },
    );
    const result = await runToolContract(getAnnotations, { uniprot: 'P84996' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      accession: 'P84996',
      domains: [],
      domainsTotal: 0,
      attribution: [{ source: 'UniProt' }],
    });
    expect((result.structuredContent as { attribution: unknown[] }).attribution).toHaveLength(1);
    expect(textOf(result)).toContain('No domains present.');
    // The record's zero count ends it: no entries request, no retry.
    expect(interproRequests().map((c) => new URL(c.request.url).pathname)).toEqual([
      '/protein/UniProt/P84996/',
    ]);
  });
});
