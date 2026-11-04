/**
 * @fileoverview Tests for the UniProt service: entry normalization (recommended
 * name, gene names, FUNCTION comment join, feature vs. variant categorization),
 * include-scoped field selection in the request URL, accession status (active,
 * merged and followed to its successor, demerged or deleted, never assigned)
 * across getEntry / getSequence / resolveAccession, entry names resolved to
 * their entry's accession, and InterPro memberships: the protein-record count
 * gate and its failed reads (429, 403, HTML pages), the paged entries walk with
 * its stop guards, and normalization. Normalization tests stub `fetchJson`; status and paging
 * tests run the real HTTP layer against a fetch fake.
 * @module tests/services/uniprot/uniprot-service.test
 */

import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/shared/http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/shared/http.js')>();
  // The real fetchJson by default; normalization tests replace it per test.
  return { ...actual, fetchJson: vi.fn(actual.fetchJson) };
});

import { fetchJson } from '@/services/shared/http.js';
import {
  inactiveAccessionError,
  mergedAccessionNotice,
  UniProtService,
} from '@/services/uniprot/uniprot-service.js';

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

/** The 11 feature fields 0.8.7 requests. */
const ORIGINAL_FEATURE_FIELDS = [
  'ft_domain',
  'ft_binding',
  'ft_act_site',
  'ft_site',
  'ft_mod_res',
  'ft_carbohyd',
  'ft_disulfid',
  'ft_signal',
  'ft_transmem',
  'ft_motif',
  'ft_region',
];

/** The 16 positional feature fields #82 adds. */
const ADDED_FEATURE_FIELDS = [
  'ft_crosslnk',
  'ft_lipid',
  'ft_dna_bind',
  'ft_zn_fing',
  'ft_topo_dom',
  'ft_intramem',
  'ft_repeat',
  'ft_coiled',
  'ft_compbias',
  'ft_mutagen',
  'ft_non_std',
  'ft_chain',
  'ft_init_met',
  'ft_peptide',
  'ft_propep',
  'ft_transit',
];

/** Feature fields kept out on purpose: secondary structure, isoform sequences, sequence-record notes. */
const EXCLUDED_FEATURE_FIELDS = [
  'ft_helix',
  'ft_strand',
  'ft_turn',
  'ft_var_seq',
  'ft_conflict',
  'ft_unsure',
  'ft_non_cons',
  'ft_non_ter',
];

/** The `fields` query parameter of a request URL, split. */
const fieldsOf = (url: string) => new URL(url).searchParams.get('fields')?.split(',') ?? [];

/** UniProt's 200 answer for a demerged accession (live capture, UniProt 2026_03). */
const DEMERGED_P62988 = {
  entryType: 'Inactive',
  primaryAccession: 'P62988',
  inactiveReason: {
    inactiveReasonType: 'DEMERGED',
    mergeDemergeTo: ['P0CG47', 'P0CG48', 'P62979', 'P62987'],
  },
  extraAttributes: { uniParcId: 'UPI00000006C4' },
};

/** UniProt's 200 answer for a deleted accession (live capture, UniProt 2026_03). */
const DELETED_A0A008APQ8 = {
  entryType: 'Inactive',
  primaryAccession: 'A0A008APQ8',
  inactiveReason: {
    inactiveReasonType: 'DELETED',
    deletedReason: 'Not part of a reference proteome',
  },
  extraAttributes: { uniParcId: 'UPI0000054276' },
};

/**
 * What fetch hands back for merged Q1HDT5: UniProt answers 303 to P69905 and the
 * redirect drops `fields`, so the successor arrives whole — secondary structure
 * included (live capture: 63 features with Helix and Turn, against 43 asked for).
 */
const FOLLOWED_Q1HDT5 = {
  entryType: 'UniProtKB reviewed (Swiss-Prot)',
  primaryAccession: 'P69905',
  secondaryAccessions: ['P01922', 'Q1HDT5'],
  sequence: { length: 142, value: 'MVLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTTKTYFPHF' },
  features: [
    { type: 'Helix', location: { start: { value: 4 }, end: { value: 17 } } },
    {
      type: 'Domain',
      description: 'Globin',
      location: { start: { value: 2 }, end: { value: 142 } },
    },
  ],
};

/** P69905 requested by its own accession with the call's fields. */
const P69905_WITH_FIELDS = {
  entryType: 'UniProtKB reviewed (Swiss-Prot)',
  primaryAccession: 'P69905',
  sequence: { length: 142, value: 'MVLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTTKTYFPHF' },
  features: [
    {
      type: 'Domain',
      description: 'Globin',
      location: { start: { value: 2 }, end: { value: 142 } },
    },
  ],
};

/** UniProt's 404 for an accession it never assigned (live capture). */
const NOT_FOUND = () =>
  new Response(
    JSON.stringify({
      url: 'http://rest.uniprot.org/uniprotkb/A0A9Z9Z9Z9',
      messages: ['Resource not found'],
    }),
    { status: 404, headers: { 'content-type': 'application/json' } },
  );

/** A route on one test host, matched by hostname and path — never by substring. */
const on = (host: 'uniprot.test' | 'interpro.test', path: string) => (req: Request) => {
  const url = new URL(req.url);
  return url.hostname === host && url.pathname === path;
};

let http: ReturnType<typeof createFetchMock>;

beforeEach(() => {
  vi.resetAllMocks();
  http = createFetchMock();
  http.install();
});

afterEach(() => http.restore());

describe('UniProtService.getEntry', () => {
  it('retains present variant IDs and changes, including empty values, without inventing missing fields (#68)', async () => {
    fetchJsonMock.mockResolvedValue({
      features: [
        {
          type: 'Natural variant',
          featureId: 'VAR_002856',
          alternativeSequence: { originalSequence: 'V', alternativeSequences: ['A', 'G'] },
        },
        {
          type: 'Natural variant',
          featureId: '',
          alternativeSequence: { originalSequence: '', alternativeSequences: [] },
        },
        { type: 'Natural variant', alternativeSequence: {} },
        { type: 'Natural variant' },
      ],
    });
    expect((await service().getEntry('P68871', 'variants', createMockContext()))?.features).toEqual(
      [
        {
          category: 'variant',
          type: 'Natural variant',
          featureId: 'VAR_002856',
          originalSequence: 'V',
          alternativeSequences: ['A', 'G'],
        },
        {
          category: 'variant',
          type: 'Natural variant',
          featureId: '',
          originalSequence: '',
          alternativeSequences: [],
        },
        { category: 'variant', type: 'Natural variant' },
        { category: 'variant', type: 'Natural variant' },
      ],
    );
  });
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
    expect(out).not.toHaveProperty('mergedFrom');
  });

  it('categorizes features vs. variants and carries residue ranges', async () => {
    fetchJsonMock.mockResolvedValue(ENTRY);
    const out = await service().getEntry('P69905', 'all', createMockContext());

    const domain = out?.features.find((f) => f.type === 'Domain');
    expect(domain).toMatchObject({ category: 'feature', start: 1, end: 141 });
    const variant = out?.features.find((f) => f.type === 'Natural variant');
    expect(variant).toMatchObject({ category: 'variant', start: 6, end: 6 });
    const binding = out?.features.find((f) => f.type === 'Binding site');
    expect(binding).toMatchObject({ category: 'feature', start: 87 });
    expect(binding).not.toHaveProperty('end'); // location.end absent → omitted
  });

  it('requests base fields only for include:domains (no ft_* feature/variant fields)', async () => {
    fetchJsonMock.mockResolvedValue(ENTRY);
    await service().getEntry('P69905', 'domains', createMockContext());
    const fields = fieldsOf(fetchJsonMock.mock.calls[0]?.[0] as string);
    expect(fields).toContain('accession');
    expect(fields.filter((f) => f.startsWith('ft_'))).toEqual([]);
  });

  it('adds feature fields for include:features and only ft_variant for include:variants', async () => {
    fetchJsonMock.mockResolvedValue(ENTRY);
    await service().getEntry('P69905', 'features', createMockContext());
    const featureFields = fieldsOf(fetchJsonMock.mock.calls[0]?.[0] as string);
    expect(featureFields).toEqual(expect.arrayContaining(ORIGINAL_FEATURE_FIELDS));
    expect(featureFields).not.toContain('ft_variant');

    fetchJsonMock.mockClear();
    await service().getEntry('P69905', 'variants', createMockContext());
    const variantFields = fieldsOf(fetchJsonMock.mock.calls[0]?.[0] as string);
    expect(variantFields.filter((f) => f.startsWith('ft_'))).toEqual(['ft_variant']);
  });

  it('requests the 16 added positional feature fields and none of the excluded ones (#82)', async () => {
    fetchJsonMock.mockResolvedValue(ENTRY);
    await service().getEntry('P04637', 'features', createMockContext());
    const fields = fieldsOf(fetchJsonMock.mock.calls[0]?.[0] as string);
    expect(fields.filter((f) => f.startsWith('ft_')).sort()).toEqual(
      [...ORIGINAL_FEATURE_FIELDS, ...ADDED_FEATURE_FIELDS].sort(),
    );
    for (const excluded of EXCLUDED_FEATURE_FIELDS) expect(fields).not.toContain(excluded);

    // include:all carries the same feature set plus ft_variant.
    fetchJsonMock.mockClear();
    await service().getEntry('P04637', 'all', createMockContext());
    const all = fieldsOf(fetchJsonMock.mock.calls[0]?.[0] as string);
    expect(all.filter((f) => f.startsWith('ft_')).sort()).toEqual(
      [...ORIGINAL_FEATURE_FIELDS, ...ADDED_FEATURE_FIELDS, 'ft_variant'].sort(),
    );
  });

  it('files every added feature type under features, never variants, with mutagenesis changes intact (#82)', async () => {
    // UniProt type labels for the added fields (P04637 / P00533 / P07203, UniProt 2026_03).
    const types = [
      'Chain',
      'Initiator methionine',
      'Peptide',
      'Propeptide',
      'Transit peptide',
      'Cross-link',
      'Lipidation',
      'DNA binding',
      'Zinc finger',
      'Topological domain',
      'Intramembrane',
      'Repeat',
      'Coiled coil',
      'Compositional bias',
      'Non-standard residue',
    ];
    fetchJsonMock.mockResolvedValue({
      primaryAccession: 'P04637',
      features: [
        ...types.map((type) => ({ type, location: { start: { value: 1 }, end: { value: 2 } } })),
        {
          type: 'Mutagenesis',
          description: 'Loss of interaction with PPP2R5C.',
          location: { start: { value: 15 }, end: { value: 15 } },
          alternativeSequence: { originalSequence: 'S', alternativeSequences: ['A'] },
        },
      ],
    });
    const out = await service().getEntry('P04637', 'all', createMockContext());
    expect(out?.features.map((f) => f.type)).toEqual([...types, 'Mutagenesis']);
    expect(out?.features.length).toBe(16);
    expect(out?.features.every((f) => f.category === 'feature')).toBe(true);
    expect(out?.features.at(-1)).toMatchObject({
      start: 15,
      originalSequence: 'S',
      alternativeSequences: ['A'],
    });
  });

  it('preserves missing upstream fields as unknown (sparse entry)', async () => {
    fetchJsonMock.mockResolvedValue({ primaryAccession: 'Q9' });
    const out = await service().getEntry('Q9', 'all', createMockContext());
    expect(out).toEqual({ accession: 'Q9', geneNames: [], features: [] });
  });

  it('answers an active accession with one request and no merge (#83 control)', async () => {
    http.route({ match: on('uniprot.test', '/uniprotkb/P69905'), respond: Response.json(ENTRY) });
    const out = await service().getEntry('P69905', 'features', createMockContext());
    expect(out?.accession).toBe('P69905');
    expect(out).not.toHaveProperty('mergedFrom');
    expect(http.calls).toHaveLength(1);
  });

  it("follows a merged accession to its successor and re-requests it with the call's fields (#83)", async () => {
    http.route(
      { match: on('uniprot.test', '/uniprotkb/Q1HDT5'), respond: Response.json(FOLLOWED_Q1HDT5) },
      {
        match: on('uniprot.test', '/uniprotkb/P69905'),
        respond: Response.json(P69905_WITH_FIELDS),
      },
    );
    const out = await service().getEntry('q1hdt5', 'features', createMockContext());

    expect(out).toMatchObject({ accession: 'P69905', mergedFrom: 'Q1HDT5' });
    // The successor's own field-selected record, not the redirect's whole entry.
    expect(out?.features.map((f) => f.type)).toEqual(['Domain']);
    expect(http.calls.map((c) => new URL(c.request.url).pathname)).toEqual([
      '/uniprotkb/Q1HDT5',
      '/uniprotkb/P69905',
    ]);
    const [first, second] = http.calls.map((c) => fieldsOf(c.request.url));
    expect(second).toEqual(first);
    expect(second).toEqual(expect.arrayContaining(ADDED_FEATURE_FIELDS));
  });

  it('throws inactive_accession for a demerged accession, naming every replacement (#83)', async () => {
    http.route({
      match: on('uniprot.test', '/uniprotkb/P62988'),
      respond: Response.json(DEMERGED_P62988),
    });
    const err = await service()
      .getEntry('P62988', 'all', createMockContext())
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpError);
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'inactive_accession',
        accession: 'P62988',
        inactiveReason: 'DEMERGED',
        replacements: ['P0CG47', 'P0CG48', 'P62979', 'P62987'],
        recovery: { hint: expect.stringContaining('P0CG47, P0CG48, P62979, P62987') },
      },
    });
    expect((err as McpError).message).toContain('P0CG47, P0CG48, P62979, P62987');
    expect(http.calls).toHaveLength(1);
  });

  it('throws inactive_accession for a deleted accession, stating there is no replacement (#83)', async () => {
    http.route({
      match: on('uniprot.test', '/uniprotkb/A0A008APQ8'),
      respond: Response.json(DELETED_A0A008APQ8),
    });
    const err = await service()
      .getEntry('A0A008APQ8', 'features', createMockContext())
      .catch((e: unknown) => e);

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'inactive_accession',
        accession: 'A0A008APQ8',
        inactiveReason: 'DELETED',
        replacements: [],
      },
    });
    expect((err as McpError).message).toMatch(/no replacement/i);
    expect((err as McpError).message).toContain('Not part of a reference proteome');
    // No dynamic hint: the declared recovery covers the deleted case.
    expect((err as McpError).data).not.toHaveProperty('recovery');
  });

  it('returns null for an accession UniProt never assigned (404), never the upstream error (#83)', async () => {
    http.route({ match: on('uniprot.test', '/uniprotkb/A0A9Z9Z9Z9'), respond: NOT_FOUND });
    await expect(
      service().getEntry('A0A9Z9Z9Z9', 'features', createMockContext()),
    ).resolves.toBeNull();
    expect(http.calls).toHaveLength(1); // a 404 is an answer, not retried
  });
});

describe('UniProtService.getSequence', () => {
  it('returns the one-letter sequence keyed to the accession', async () => {
    fetchJsonMock.mockResolvedValue({ sequence: { value: 'MVLSPADK' } });
    expect(await service().getSequence('P69905', createMockContext())).toEqual({
      accession: 'P69905',
      sequence: 'MVLSPADK',
    });
  });

  it('returns null when no sequence is present', async () => {
    fetchJsonMock.mockResolvedValue({});
    expect(await service().getSequence('P69905', createMockContext())).toBeNull();
  });

  it("returns an isoform's own sequence, which UniProt keys by the isoform accession (#91)", async () => {
    http.route({
      match: on('uniprot.test', '/uniprotkb/P04637-2'),
      respond: Response.json({ primaryAccession: 'P04637-2', sequence: { value: 'MEEPQSD' } }),
    });
    expect(await service().getSequence('P04637-2', createMockContext())).toEqual({
      accession: 'P04637-2',
      sequence: 'MEEPQSD',
    });
    expect(http.calls).toHaveLength(1);
  });

  it("follows a merged accession to its successor's sequence and reports the merge (#83)", async () => {
    http.route(
      { match: on('uniprot.test', '/uniprotkb/Q1HDT5'), respond: Response.json(FOLLOWED_Q1HDT5) },
      {
        match: on('uniprot.test', '/uniprotkb/P69905'),
        respond: Response.json(P69905_WITH_FIELDS),
      },
    );
    expect(await service().getSequence('Q1HDT5', createMockContext())).toEqual({
      accession: 'P69905',
      sequence: P69905_WITH_FIELDS.sequence.value,
      mergedFrom: 'Q1HDT5',
    });
    expect(fieldsOf(http.calls[1]?.request.url ?? '')).toEqual(['sequence']);
  });

  it('throws inactive_accession for a demerged accession (#83)', async () => {
    http.route({
      match: on('uniprot.test', '/uniprotkb/P62988'),
      respond: Response.json(DEMERGED_P62988),
    });
    await expect(service().getSequence('P62988', createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'inactive_accession', inactiveReason: 'DEMERGED' },
    });
  });

  it('returns null for a never-assigned accession or a missing isoform number (404) (#83)', async () => {
    http.route({
      match: (req) => new URL(req.url).hostname === 'uniprot.test',
      respond: NOT_FOUND,
    });
    await expect(service().getSequence('A0A9Z9Z9Z9', createMockContext())).resolves.toBeNull();
    await expect(service().getSequence('P04637-99', createMockContext())).resolves.toBeNull();
  });

  it("returns an entry name's sequence under its entry's accession from one request, with no merge", async () => {
    http.route({
      match: on('uniprot.test', '/uniprotkb/HBA_HUMAN'),
      respond: Response.json(P69905_WITH_FIELDS),
    });
    expect(await service().getSequence('hba_human', createMockContext())).toEqual({
      accession: 'P69905',
      sequence: P69905_WITH_FIELDS.sequence.value,
    });
    expect(http.calls).toHaveLength(1);
    expect(fieldsOf(http.calls[0]?.request.url ?? '')).toEqual(['sequence']);
  });
});

describe('UniProtService.resolveAccession', () => {
  it.each([
    ['P69905', ENTRY, { kind: 'active', accession: 'P69905' }],
    ['P04637-2', { primaryAccession: 'P04637-2' }, { kind: 'active', accession: 'P04637-2' }],
    ['Q1HDT5', FOLLOWED_Q1HDT5, { kind: 'merged', accession: 'Q1HDT5', successor: 'P69905' }],
    [
      'P62988',
      DEMERGED_P62988,
      {
        kind: 'inactive',
        accession: 'P62988',
        inactiveReason: 'DEMERGED',
        replacements: ['P0CG47', 'P0CG48', 'P62979', 'P62987'],
      },
    ],
    [
      'A0A008APQ8',
      DELETED_A0A008APQ8,
      {
        kind: 'inactive',
        accession: 'A0A008APQ8',
        inactiveReason: 'DELETED',
        deletedReason: 'Not part of a reference proteome',
        replacements: [],
      },
    ],
  ])('classifies %s from one accession-only request (#83)', async (accession, body, expected) => {
    http.route({
      match: on('uniprot.test', `/uniprotkb/${accession}`),
      respond: Response.json(body),
    });
    expect(await service().resolveAccession(accession, createMockContext())).toEqual(expected);
    expect(http.calls).toHaveLength(1);
    expect(fieldsOf(http.calls[0]?.request.url ?? '')).toEqual(['accession']);
  });

  it("resolves an entry name to its entry's accession as active, never as a merge", async () => {
    http.route({
      match: on('uniprot.test', '/uniprotkb/HBA_HUMAN'),
      respond: Response.json({ primaryAccession: 'P69905' }),
    });
    expect(await service().resolveAccession('HBA_HUMAN', createMockContext())).toEqual({
      kind: 'active',
      accession: 'P69905',
    });
    expect(http.calls).toHaveLength(1);
    expect(fieldsOf(http.calls[0]?.request.url ?? '')).toEqual(['accession']);
  });

  it('classifies an entry name UniProt does not know as unknown, under the name as sent', async () => {
    http.route({ match: on('uniprot.test', '/uniprotkb/NOSUCH_HUMAN'), respond: NOT_FOUND });
    expect(await service().resolveAccession('nosuch_human', createMockContext())).toEqual({
      kind: 'unknown',
      accession: 'NOSUCH_HUMAN',
    });
  });

  it('classifies a never-assigned accession as unknown (#83)', async () => {
    http.route({ match: on('uniprot.test', '/uniprotkb/A0A9Z9Z9Z9'), respond: NOT_FOUND });
    expect(await service().resolveAccession('a0a9z9z9z9', createMockContext())).toEqual({
      kind: 'unknown',
      accession: 'A0A9Z9Z9Z9',
    });
  });

  it('rethrows an upstream outage rather than classifying it', async () => {
    fetchJsonMock.mockRejectedValue(serviceUnavailable('UniProt down'));
    await expect(service().resolveAccession('P69905', createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });
});

describe('inactive-accession and merge wording', () => {
  it('builds the same error the service throws, for consumers that hold a status', () => {
    const err = inactiveAccessionError({
      accession: 'P62988',
      inactiveReason: 'DEMERGED',
      replacements: ['P0CG47', 'P62987'],
    });
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.message).toBe(
      'P62988 is inactive in UniProtKB (DEMERGED); replaced by P0CG47, P62987.',
    );
    expect(err.data).toEqual({
      reason: 'inactive_accession',
      accession: 'P62988',
      inactiveReason: 'DEMERGED',
      replacements: ['P0CG47', 'P62987'],
      recovery: { hint: 'Retry with a replacement accession: P0CG47, P62987.' },
    });
  });

  it('names the merge in one sentence', () => {
    expect(mergedAccessionNotice('Q1HDT5', 'P69905')).toBe(
      'Q1HDT5 was merged into P69905 in UniProtKB; this answer is for P69905.',
    );
  });
});

/** InterPro's protein record carrying a membership count (live P69905 / P84996 shapes, InterPro 110.0). */
const proteinRecord = (interpro: number | undefined) =>
  Response.json({
    metadata: {
      accession: 'P98161',
      counters: {
        entries: interpro ?? 0,
        // InterPro omits a zero counter: P84996 answers `dbEntries: {}`.
        dbEntries: interpro === undefined ? {} : { pfam: 1, interpro },
      },
    },
  });

/** One InterPro membership page holding the given accessions. */
const page = (count: number, accessions: string[], next: string | null) =>
  Response.json({
    count,
    next,
    previous: null,
    results: accessions.map((accession) => ({
      metadata: { accession, name: `${accession} name`, type: 'domain', member_databases: {} },
      proteins: [{ accession: 'p98161', entry_protein_locations: [] }],
    })),
  });

const ENTRIES_PATH = '/entry/interpro/protein/UniProt/P98161/';
const RECORD_PATH = '/protein/UniProt/P98161/';
const nextUrl = (cursor: string) =>
  `https://interpro.test${ENTRIES_PATH}?cursor=${cursor}&page_size=200`;
const cursorOf = (req: Request) =>
  on('interpro.test', ENTRIES_PATH)(req) ? new URL(req.url).searchParams.get('cursor') : undefined;
const ipr = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => `IPR${String(from + i).padStart(6, '0')}`);

describe('UniProtService.getInterPro', () => {
  it('preserves only the requested protein locations, all fragment boundaries and sparse fields (#68)', async () => {
    const locations = [
      {
        fragments: [
          { start: 2, end: 9, 'dc-status': 'N_TERMINAL_DISC' },
          { start: 20, end: 30, 'dc-status': '' },
        ],
      },
      { fragments: [] },
      {},
      { fragments: [{ end: 42 }] },
    ];
    // A protein record without counters gives no count, so the entries walk runs.
    fetchJsonMock.mockResolvedValueOnce({ metadata: {} }).mockResolvedValueOnce({
      results: [
        {
          metadata: { accession: 'IPR000033' },
          proteins: [
            { accession: 'OTHER', entry_protein_locations: [{ fragments: [{ start: 999 }] }] },
            { accession: 'q07954', entry_protein_locations: locations },
          ],
        },
        {
          metadata: { accession: 'IPR000034' },
          proteins: [{ accession: 'Q07954', entry_protein_locations: [] }],
        },
        {
          metadata: { accession: 'IPR000035' },
          proteins: [{ accession: 'OTHER', entry_protein_locations: [] }],
        },
      ],
    });
    const out = await service().getInterPro('Q07954', createMockContext());
    expect(out.entries[0]?.locations).toEqual([
      {
        fragments: [
          { start: 2, end: 9, dcStatus: 'N_TERMINAL_DISC' },
          { start: 20, end: 30, dcStatus: '' },
        ],
      },
      { fragments: [] },
      {},
      { fragments: [{ end: 42 }] },
    ]);
    expect(out.entries[1]?.locations).toEqual([]);
    expect(out.entries[2]).not.toHaveProperty('locations');
  });

  it('normalizes member databases and GO terms, dropping incomplete GO entries', async () => {
    fetchJsonMock
      .mockResolvedValueOnce({ metadata: { counters: { dbEntries: { interpro: 1 } } } })
      .mockResolvedValueOnce({
        count: 1,
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

    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({
      accession: 'IPR009050',
      name: 'Globin-like superfamily',
      type: 'homologous_superfamily',
      memberDatabases: ['ssf', 'cdd'],
    });
    expect(out.entries[0]?.goTerms).toEqual([
      { id: 'GO:0005344', name: 'oxygen carrier activity', category: 'molecular_function' },
    ]);
  });

  it('reads zero memberships when the protein record 404s (no domains is not a failure)', async () => {
    fetchJsonMock.mockRejectedValue(notFound('no entries'));
    expect(await service().getInterPro('P00000', createMockContext())).toEqual({
      entries: [],
      total: 0,
    });
    expect(fetchJsonMock).toHaveBeenCalledOnce();
  });

  it('rethrows a non-404 InterPro failure', async () => {
    fetchJsonMock.mockRejectedValue(serviceUnavailable('InterPro down'));
    await expect(service().getInterPro('P69905', createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });

  it('reads the count, then the entries, from the InterPro base — never the UniProt base', async () => {
    http.route(
      { match: on('interpro.test', '/protein/UniProt/P69905/'), respond: proteinRecord(1) },
      {
        match: on('interpro.test', '/entry/interpro/protein/UniProt/P69905/'),
        respond: page(1, ['IPR009050'], null),
      },
    );
    await service().getInterPro('p69905', createMockContext());
    expect(http.calls.map((c) => c.request.url)).toEqual([
      'https://interpro.test/protein/UniProt/P69905/',
      'https://interpro.test/entry/interpro/protein/UniProt/P69905/?page_size=200',
    ]);
  });

  it('skips the entries request when the protein record counts no memberships (#83)', async () => {
    http.route({ match: on('interpro.test', RECORD_PATH), respond: proteinRecord(undefined) });
    expect(await service().getInterPro('P98161', createMockContext())).toEqual({
      entries: [],
      total: 0,
    });
    // Only the protein record: the entries endpoint answers a protein with no
    // memberships with a 204 that Node's HTTP/2 fetch rejects, so it is never asked.
    expect(http.calls).toHaveLength(1);
  });

  it('reads a 204 from either InterPro endpoint as no memberships, without retrying (#83)', async () => {
    http.route({
      match: on('interpro.test', RECORD_PATH),
      respond: new Response(null, { status: 204 }),
    });
    expect(await service().getInterPro('P98161', createMockContext())).toEqual({
      entries: [],
      total: 0,
    });
    expect(http.calls).toHaveLength(1);

    http.reset();
    http.route(
      { match: on('interpro.test', RECORD_PATH), respond: proteinRecord(24) },
      { match: on('interpro.test', ENTRIES_PATH), respond: new Response(null, { status: 204 }) },
    );
    expect(await service().getInterPro('P98161', createMockContext())).toEqual({
      entries: [],
      total: 0,
    });
    expect(http.calls).toHaveLength(2);
  });

  it("requests 200 per page and follows next until it is null, totalling InterPro's count (#81)", async () => {
    http.route(
      { match: on('interpro.test', RECORD_PATH), respond: proteinRecord(24) },
      { match: (req) => cursorOf(req) === null, respond: page(24, ipr(1, 20), nextUrl('c2')) },
      { match: (req) => cursorOf(req) === 'c2', respond: page(24, ipr(21, 4), null) },
    );
    const out = await service().getInterPro('P98161', createMockContext());

    expect(out.total).toBe(24);
    expect(out.entries.map((e) => e.accession)).toEqual(ipr(1, 24));
    const urls = http.calls.map((c) => c.request.url);
    expect(new URL(urls[1] ?? '').searchParams.get('page_size')).toBe('200');
    expect(urls[2]).toBe(nextUrl('c2')); // the next URL, verbatim
    expect(urls).toHaveLength(3);
  });

  it("stops after five entries pages while next is still set, keeping InterPro's count (#81)", async () => {
    let served = 0;
    http.route(
      { match: on('interpro.test', RECORD_PATH), respond: proteinRecord(1234) },
      {
        match: on('interpro.test', ENTRIES_PATH),
        respond: () => {
          served += 1;
          return page(1234, ipr(served * 10, 10), nextUrl(`c${served + 1}`));
        },
      },
    );
    const out = await service().getInterPro('P98161', createMockContext());

    expect(served).toBe(5);
    expect(out.entries).toHaveLength(50);
    expect(out.total).toBe(1234);
  });

  it('stops when the upstream ignores paging and serves page one again (#81)', async () => {
    // Every request returns page one, under a fresh cursor each time.
    let served = 0;
    http.route(
      { match: on('interpro.test', RECORD_PATH), respond: proteinRecord(24) },
      {
        match: on('interpro.test', ENTRIES_PATH),
        respond: () => {
          served += 1;
          return page(24, ipr(1, 20), nextUrl(`c${served + 1}`));
        },
      },
    );
    const out = await service().getInterPro('P98161', createMockContext());

    expect(out.entries.map((e) => e.accession)).toEqual(ipr(1, 20)); // no duplicates
    expect(out.total).toBe(24);
    // Page one, then the repeat that added nothing — not five copies of it.
    expect(served).toBe(2);
  });

  it('never requests the same next URL twice (#81)', async () => {
    http.route(
      { match: on('interpro.test', RECORD_PATH), respond: proteinRecord(30) },
      { match: (req) => cursorOf(req) === null, respond: page(30, ipr(1, 10), nextUrl('c2')) },
      // A new page whose next names itself.
      { match: (req) => cursorOf(req) === 'c2', respond: page(30, ipr(11, 10), nextUrl('c2')) },
    );
    const out = await service().getInterPro('P98161', createMockContext());
    expect(out.entries).toHaveLength(20);
    expect(http.calls.filter((c) => c.request.url === nextUrl('c2'))).toHaveLength(1);
  });

  it('stops on an empty page that still carries next (#81)', async () => {
    http.route(
      { match: on('interpro.test', RECORD_PATH), respond: proteinRecord(24) },
      { match: (req) => cursorOf(req) === null, respond: page(24, ipr(1, 20), nextUrl('c2')) },
      { match: (req) => cursorOf(req) === 'c2', respond: page(24, [], nextUrl('c3')) },
    );
    const out = await service().getInterPro('P98161', createMockContext());
    expect(out.total).toBe(24);
    expect(out.entries).toHaveLength(20);
    expect(http.calls).toHaveLength(3); // record, page one, the empty page — never c3
  });

  describe('a failed membership-count read', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const htmlPage = (status: number) => () =>
      new Response('<!DOCTYPE html><html><body><h1>Service unavailable</h1></body></html>', {
        status,
        headers: { 'content-type': 'text/html' },
      });

    it.each([
      [
        'a 429',
        () =>
          new Response(JSON.stringify({ detail: 'Request was throttled.' }), {
            status: 429,
            headers: { 'content-type': 'application/json' },
          }),
        JsonRpcErrorCode.RateLimited,
        4,
      ],
      ['a 403', () => new Response('Forbidden', { status: 403 }), JsonRpcErrorCode.Forbidden, 1],
      ['an HTML page served as 200', htmlPage(200), JsonRpcErrorCode.ServiceUnavailable, 4],
      ['an HTML page served as 502', htmlPage(502), JsonRpcErrorCode.ServiceUnavailable, 4],
    ])(
      'surfaces %s from the protein record as an error, never as zero memberships',
      async (_case, respond, code, attempts) => {
        vi.useFakeTimers();
        http.route({ match: on('interpro.test', RECORD_PATH), respond });
        const settled = service()
          .getInterPro('P98161', createMockContext())
          .then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
        await vi.runAllTimersAsync();
        const out = await settled;

        expect(out).not.toHaveProperty('value');
        expect(out).toMatchObject({ error: { code } });
        // Retried only where the status is transient; the entries walk never starts.
        expect(http.calls).toHaveLength(attempts);
        expect(http.calls.every((c) => on('interpro.test', RECORD_PATH)(c.request))).toBe(true);
      },
    );
  });

  it("stops the walk at the call's deadline, requesting nothing further (#81)", async () => {
    const controller = new AbortController();
    http.route(
      { match: on('interpro.test', RECORD_PATH), respond: proteinRecord(24) },
      { match: (req) => cursorOf(req) === null, respond: page(24, ipr(1, 20), nextUrl('c2')) },
      {
        // The call's budget runs out while page two is in flight.
        match: (req) => cursorOf(req) === 'c2',
        respond: () => {
          controller.abort(new DOMException('Call budget spent.', 'TimeoutError'));
          return Promise.reject(controller.signal.reason);
        },
      },
    );
    await expect(
      service().getInterPro('P98161', createMockContext({ signal: controller.signal })),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.Timeout });
    expect(http.calls).toHaveLength(3);
  });
});
