/**
 * @fileoverview Tests for the RCSB query builders: the search-query node tree
 * (match-all, single terminal, AND group, sequence, resolution ceiling), the
 * organism node (taxon ID, exact name arms, the multi-word phrase arm), the
 * method node (vocabulary, aliases, `in` for NMR, the unknown_method rejection
 * before any request), the bound-ligand node shared with the ligand search, the
 * posted request bodies under both return types and their verbosity option, the
 * facet-spec translation to the RCSB request shape (terms vs. histogram,
 * nesting), the entity-number comparator every GraphQL entity array is ordered
 * by, and the sequence search over both content universes: one request per
 * universe, sent concurrently, merged by bit score, paged, totalled, its facets
 * summed, a failed universe left out unless the failure ends the call, and the
 * deadline that leaves out a universe still searching at 35 s.
 * @module tests/services/rcsb/rcsb-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildQuery,
  compareEntityIds,
  type FacetSpec,
  organismForm,
  RcsbService,
  toRcsbFacet,
} from '@/services/rcsb/rcsb-service.js';
import type { ContentType } from '@/services/rcsb/types.js';

describe('compareEntityIds (#85)', () => {
  it('orders by the integer after the last underscore, so _10 follows _9', () => {
    const ids = ['6M0J_10', '6M0J_2', '6M0J_9', '6M0J_1'];
    expect(ids.toSorted(compareEntityIds)).toEqual(['6M0J_1', '6M0J_2', '6M0J_9', '6M0J_10']);
    expect(ids.toReversed().toSorted(compareEntityIds)).toEqual([
      '6M0J_1',
      '6M0J_2',
      '6M0J_9',
      '6M0J_10',
    ]);
  });

  it('reads the entity number of a computed-model entity ID after its last underscore', () => {
    expect(['AF_AFP69905F1_10', 'AF_AFP69905F1_2'].toSorted(compareEntityIds)).toEqual([
      'AF_AFP69905F1_2',
      'AF_AFP69905F1_10',
    ]);
  });

  it('sorts an ID without a numeric suffix after every numbered one, without throwing', () => {
    for (const unnumbered of ['4HHB', '4HHB_', '4HHB_A', 'AF_AFP69905F1', undefined]) {
      expect(compareEntityIds(unnumbered, '4HHB_999')).toBeGreaterThan(0);
      expect(compareEntityIds('4HHB_1', unnumbered)).toBeLessThan(0);
    }
  });

  it('orders two unnumbered IDs by code unit, so the result never depends on input order', () => {
    expect(['4HHB_B', '4HHB_A'].toSorted(compareEntityIds)).toEqual(['4HHB_A', '4HHB_B']);
    expect(compareEntityIds(undefined, undefined)).toBe(0);
    expect(compareEntityIds('4HHB_1', '4HHB_1')).toBe(0);
  });
});

describe('buildQuery', () => {
  it('returns a match-all terminal when no constraints are given', () => {
    expect(buildQuery({})).toMatchObject({
      type: 'terminal',
      service: 'text',
      parameters: { attribute: 'rcsb_accession_info.initial_release_date', operator: 'exists' },
    });
  });

  it('builds a single full-text terminal for a text query', () => {
    expect(buildQuery({ text: 'kinase' })).toMatchObject({
      type: 'terminal',
      service: 'full_text',
      parameters: { value: 'kinase' },
    });
  });

  it('groups multiple constraints under a logical AND', () => {
    const q = buildQuery({ text: 'kinase', organism: 'Homo sapiens' }) as {
      type: string;
      logical_operator: string;
      nodes: unknown[];
    };
    expect(q.type).toBe('group');
    expect(q.logical_operator).toBe('and');
    expect(q.nodes).toHaveLength(2);
  });

  it('emits a sequence terminal with identity and e-value cutoffs', () => {
    expect(buildQuery({ sequence: 'MVLSPADKTN', minIdentity: 0.5, maxEvalue: 0.01 })).toMatchObject(
      {
        type: 'terminal',
        service: 'sequence',
        parameters: {
          identity_cutoff: 0.5,
          evalue_cutoff: 0.01,
          sequence_type: 'protein',
          value: 'MVLSPADKTN',
        },
      },
    );
  });

  it('adds a resolution ceiling as a less_or_equal text node', () => {
    const q = buildQuery({ text: 'x', maxResolution: 2.5 }) as { nodes: unknown[] };
    expect(q.nodes).toContainEqual(
      expect.objectContaining({
        parameters: expect.objectContaining({
          attribute: 'rcsb_entry_info.resolution_combined',
          operator: 'less_or_equal',
          value: 2.5,
        }),
      }),
    );
  });

  it('builds standalone method and resolution terminals', () => {
    expect(buildQuery({ method: 'ELECTRON MICROSCOPY' })).toMatchObject({
      type: 'terminal',
      service: 'text',
      parameters: { attribute: 'exptl.method', operator: 'exact_match' },
    });
    expect(buildQuery({ maxResolution: 2.5 })).toMatchObject({
      type: 'terminal',
      service: 'text',
      parameters: {
        attribute: 'rcsb_entry_info.resolution_combined',
        operator: 'less_or_equal',
        value: 2.5,
      },
    });
  });

  it('combines method and resolution terminals with logical AND', () => {
    const query = buildQuery({ method: 'ELECTRON MICROSCOPY', maxResolution: 3 }) as {
      logical_operator: string;
      nodes: unknown[];
    };
    expect(query.logical_operator).toBe('and');
    expect(query.nodes).toHaveLength(2);
  });
});

const ORGANISM = 'rcsb_entity_source_organism.';
const LIGAND_ATTRIBUTE = 'rcsb_nonpolymer_entity_container_identifiers.nonpolymer_comp_id';

/** A `text`-service terminal as RCSB receives it. */
const textTerm = (attribute: string, operator: string, value: unknown) => ({
  type: 'terminal',
  service: 'text',
  parameters: { attribute, operator, value },
});

/** The name arms every non-numeric organism value gets: lineage name and scientific name, exact. */
const exactNameArms = (name: string) => [
  textTerm(`${ORGANISM}taxonomy_lineage.name`, 'exact_match', name),
  textTerm(`${ORGANISM}ncbi_scientific_name`, 'exact_match', name),
];

describe('buildQuery organism node (#86)', () => {
  it.each(['human', 'Human', 'HUMAN', 'mouse', 'HIV-1', 'sapiens', 'coli'])(
    'matches the one-word value %j exactly on lineage and scientific name, never as a phrase',
    (name) => {
      expect(buildQuery({ organism: name })).toEqual({
        type: 'group',
        logical_operator: 'or',
        nodes: exactNameArms(name),
      });
    },
  );

  it.each(['Homo sapiens', 'Escherichia coli', 'E. coli', 'Escherichia coli K-12', 'house mouse'])(
    'keeps the scientific-name phrase arm for the multi-word value %j',
    (name) => {
      expect(buildQuery({ organism: name })).toEqual({
        type: 'group',
        logical_operator: 'or',
        nodes: [
          ...exactNameArms(name),
          textTerm(`${ORGANISM}ncbi_scientific_name`, 'contains_phrase', name),
        ],
      });
    },
  );

  it.each(['9606', '562', '4932', '83333'])(
    'matches the all-digit value %j as an NCBI taxon ID on the lineage, so descendants match too',
    (taxonId) => {
      expect(buildQuery({ organism: taxonId })).toEqual(
        textTerm(`${ORGANISM}taxonomy_lineage.id`, 'exact_match', taxonId),
      );
    },
  );

  it('reads a value through surrounding and repeated whitespace', () => {
    expect(buildQuery({ organism: ' 9606\n' })).toEqual(
      textTerm(`${ORGANISM}taxonomy_lineage.id`, 'exact_match', '9606'),
    );
    expect(buildQuery({ organism: '  human ' })).toEqual({
      type: 'group',
      logical_operator: 'or',
      nodes: exactNameArms('human'),
    });
    expect(buildQuery({ organism: ' Homo \t sapiens ' })).toEqual({
      type: 'group',
      logical_operator: 'or',
      nodes: [
        ...exactNameArms('Homo sapiens'),
        textTerm(`${ORGANISM}ncbi_scientific_name`, 'contains_phrase', 'Homo sapiens'),
      ],
    });
  });

  it('treats a value mixing digits and letters as a name, not a taxon ID', () => {
    expect(buildQuery({ organism: '9606a' })).toEqual({
      type: 'group',
      logical_operator: 'or',
      nodes: exactNameArms('9606a'),
    });
  });

  it.each([
    ['9606', 'taxon_id'],
    [' 562\n', 'taxon_id'],
    ['Zika', 'one_word'],
    ['  human ', 'one_word'],
    ['HIV-1', 'one_word'],
    ['9606a', 'one_word'],
    ['Zika virus', 'multi_word'],
    [' Homo \t sapiens ', 'multi_word'],
    ['E. coli', 'multi_word'],
  ] as const)('classifies the organism value %j as %s, the form its node takes', (value, form) => {
    expect(organismForm(value)).toBe(form);
  });
});

/** The 13 values RCSB's `exptl.method` takes (search schema enum, identical to the live facet). */
const EXPTL_METHOD_VALUES = [
  'X-RAY DIFFRACTION',
  'ELECTRON MICROSCOPY',
  'SOLUTION NMR',
  'SOLID-STATE NMR',
  'ELECTRON CRYSTALLOGRAPHY',
  'NEUTRON DIFFRACTION',
  'FIBER DIFFRACTION',
  'POWDER DIFFRACTION',
  'SOLUTION SCATTERING',
  'EPR',
  'FLUORESCENCE TRANSFER',
  'INFRARED SPECTROSCOPY',
  'THEORETICAL MODEL',
];

describe('buildQuery method node (#86)', () => {
  it.each(EXPTL_METHOD_VALUES)('matches %j in any letter case on its RCSB spelling', (method) => {
    const titled = method.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
    for (const spelling of [method, method.toLowerCase(), titled]) {
      expect(buildQuery({ method: spelling })).toEqual(
        textTerm('exptl.method', 'exact_match', method),
      );
    }
  });

  it.each([
    ['cryo-EM', 'ELECTRON MICROSCOPY'],
    ['Cryo-EM', 'ELECTRON MICROSCOPY'],
    ['cryoEM', 'ELECTRON MICROSCOPY'],
    ['EM', 'ELECTRON MICROSCOPY'],
    ['electron microscopy', 'ELECTRON MICROSCOPY'],
    ['X-ray', 'X-RAY DIFFRACTION'],
    ['xray', 'X-RAY DIFFRACTION'],
    [' x-ray  diffraction ', 'X-RAY DIFFRACTION'],
  ])('resolves %j to %j', (spelling, method) => {
    expect(buildQuery({ method: spelling })).toEqual(
      textTerm('exptl.method', 'exact_match', method),
    );
  });

  it('resolves NMR to both NMR methods through the in operator', () => {
    for (const spelling of ['NMR', 'nmr', 'Nmr']) {
      expect(buildQuery({ method: spelling })).toEqual(
        textTerm('exptl.method', 'in', ['SOLUTION NMR', 'SOLID-STATE NMR']),
      );
    }
  });

  it.each(['cryo-ET', 'crystallography', 'X-RAY DIFFRACTION, NMR', 'MICROSCOPY'])(
    'rejects %j as unknown_method, listing the vocabulary and the aliases',
    (method) => {
      let thrown: unknown;
      try {
        buildQuery({ text: 'hemoglobin', method });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toMatchObject({ code: -32602, data: { reason: 'unknown_method' } });
      const message = (thrown as Error).message;
      expect(message).toContain(JSON.stringify(method.trim()));
      for (const value of EXPTL_METHOD_VALUES) expect(message).toContain(value);
      for (const alias of ['cryo-EM', 'X-ray', 'NMR']) expect(message).toContain(alias);
    },
  );
});

describe('buildQuery ligand node (#95)', () => {
  it.each(['STI', 'sti', 'Sti'])(
    'matches %j as a bound non-polymer component, upper-cased',
    (compId) => {
      expect(buildQuery({ ligand: compId })).toEqual(
        textTerm(LIGAND_ATTRIBUTE, 'exact_match', 'STI'),
      );
    },
  );

  it.each([' sti ', '\tSTI\n', '  Sti'])(
    'matches %j on the component ID without its surrounding whitespace',
    (compId) => {
      expect(buildQuery({ ligand: compId })).toEqual(
        textTerm(LIGAND_ATTRIBUTE, 'exact_match', 'STI'),
      );
    },
  );
});

/** Every request the stub served, parsed back to the posted JSON body. */
const postedBodies = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit | undefined)?.body)));

/**
 * Serve the RCSB search host a 204 (no matches); any other host is an unmocked
 * call and rejects, so a stray request fails the test instead of passing silently.
 */
const stubSearchHost = () =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== 'search.test') throw new Error(`unmocked fetch: ${url.href}`);
    return new Response(null, { status: 204 });
  });

describe('RcsbService search request bodies (#86, #89, #95)', () => {
  afterEach(() => vi.restoreAllMocks());

  const service = () =>
    new RcsbService(
      {} as never,
      {} as never,
      {
        rcsbSearchBaseUrl: 'https://search.test',
        rcsbDataBaseUrl: 'https://data.test',
        rcsbFilesBaseUrl: 'https://files.test',
      } as never,
    );

  const SEQUENCE = 'MVLSPADKTNVKAAWGKVGA';
  const sequenceTerminal = {
    type: 'terminal',
    service: 'sequence',
    parameters: { evalue_cutoff: 1, identity_cutoff: 0, sequence_type: 'protein', value: SEQUENCE },
  };

  it('nests the organism, method, and ligand nodes in the AND group under the entry return type', async () => {
    const spy = stubSearchHost();
    await service().search(
      { text: 'hemoglobin', organism: 'human', method: 'nmr', maxResolution: 2, ligand: 'hem' },
      createMockContext(),
    );
    const [body] = postedBodies(spy);
    expect(body.return_type).toBe('entry');
    expect(body.query).toEqual({
      type: 'group',
      logical_operator: 'and',
      nodes: [
        { type: 'terminal', service: 'full_text', parameters: { value: 'hemoglobin' } },
        { type: 'group', logical_operator: 'or', nodes: exactNameArms('human') },
        textTerm('exptl.method', 'in', ['SOLUTION NMR', 'SOLID-STATE NMR']),
        textTerm('rcsb_entry_info.resolution_combined', 'less_or_equal', 2),
        textTerm(LIGAND_ATTRIBUTE, 'exact_match', 'HEM'),
      ],
    });
  });

  it('nests the same nodes beside the sequence terminal under the polymer_entity return type', async () => {
    const spy = stubSearchHost();
    await service().search(
      { sequence: SEQUENCE, organism: '9606', method: 'x-ray', ligand: 'HEM' },
      createMockContext(),
    );
    const [body] = postedBodies(spy);
    expect(body.return_type).toBe('polymer_entity');
    expect(body.query).toEqual({
      type: 'group',
      logical_operator: 'and',
      nodes: [
        sequenceTerminal,
        textTerm(`${ORGANISM}taxonomy_lineage.id`, 'exact_match', '9606'),
        textTerm('exptl.method', 'exact_match', 'X-RAY DIFFRACTION'),
        textTerm(LIGAND_ATTRIBUTE, 'exact_match', 'HEM'),
      ],
    });
  });

  it('accepts a ligand as the only criterion', async () => {
    const spy = stubSearchHost();
    await service().search({ ligand: 'sti' }, createMockContext());
    expect(postedBodies(spy)[0].query).toEqual(textTerm(LIGAND_ATTRIBUTE, 'exact_match', 'STI'));
  });

  it('sends the ligand search and the ligand filter the same bound-ligand node', async () => {
    const spy = stubSearchHost();
    await service().searchByLigand('mse', {}, createMockContext());
    await service().countEntriesWithLigand('mse', createMockContext());
    await service().search({ ligand: 'mse' }, createMockContext());
    const bound = textTerm(LIGAND_ATTRIBUTE, 'exact_match', 'MSE');
    expect(postedBodies(spy).map((b) => b.query)).toEqual([bound, bound, bound]);
  });

  it('rejects an unknown method on the search and the facet paths before any request', async () => {
    const spy = stubSearchHost();
    await expect(
      service().search({ text: 'hemoglobin', method: 'cryo-ET' }, createMockContext()),
    ).rejects.toMatchObject({ code: -32602, data: { reason: 'unknown_method' } });
    await expect(
      service().analyzeFacets(
        { method: 'cryo-ET' },
        [{ dimension: 'method', attribute: 'exptl.method', aggregation: 'terms' }],
        createMockContext(),
      ),
    ).rejects.toMatchObject({ code: -32602, data: { reason: 'unknown_method' } });
    expect(spy).not.toHaveBeenCalled();
  });

  it('sends no verbosity option on a search without a sequence', async () => {
    const spy = stubSearchHost();
    await service().search({ text: 'hemoglobin', organism: 'human' }, createMockContext());
    await service().analyzeFacets(
      { text: 'hemoglobin' },
      [{ dimension: 'method', attribute: 'exptl.method', aggregation: 'terms' }],
      createMockContext(),
    );
    await service().searchByLigand('HEM', {}, createMockContext());
    for (const body of postedBodies(spy)) {
      expect(body.request_options).not.toHaveProperty('results_verbosity');
    }
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('asks for verbose results on a combined search that carries a sequence (#89)', async () => {
    const spy = stubSearchHost();
    await service().search({ sequence: SEQUENCE, text: 'hemoglobin' }, createMockContext());
    expect(postedBodies(spy)[0].request_options).toMatchObject({
      results_verbosity: 'verbose',
      scoring_strategy: 'combined',
    });
  });

  it('asks for verbose results on every sequence-only search (#89)', async () => {
    const spy = stubSearchHost();
    await service().searchSequence(SEQUENCE, {}, createMockContext());
    expect(postedBodies(spy)[0].request_options).toMatchObject({
      results_verbosity: 'verbose',
      scoring_strategy: 'sequence',
    });
  });

  /** The raw posted body of every request, as the bytes RCSB receives. */
  const rawBodies = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map((call) => String((call[1] as RequestInit | undefined)?.body));

  const methodFacet: FacetSpec = {
    dimension: 'method',
    attribute: 'exptl.method',
    aggregation: 'terms',
  };
  const rcsbMethodFacet = {
    name: 'method',
    aggregation_type: 'terms',
    attribute: 'exptl.method',
    min_interval_population: 1,
  };

  it.each([
    [
      'a text search over both universes',
      { text: 'hemoglobin', contentType: ['experimental', 'computational'], start: 5, limit: 10 },
      {
        query: { type: 'terminal', service: 'full_text', parameters: { value: 'hemoglobin' } },
        return_type: 'entry',
        request_options: {
          results_content_type: ['experimental', 'computational'],
          paginate: { start: 5, rows: 10 },
          facets: [rcsbMethodFacet],
          scoring_strategy: 'combined',
        },
      },
    ],
    [
      'an experimental sequence search',
      { sequence: SEQUENCE, contentType: ['experimental'], start: 3, limit: 7 },
      {
        query: sequenceTerminal,
        return_type: 'polymer_entity',
        request_options: {
          results_content_type: ['experimental'],
          paginate: { start: 3, rows: 7 },
          facets: [rcsbMethodFacet],
          scoring_strategy: 'combined',
          results_verbosity: 'verbose',
        },
      },
    ],
    [
      'a predicted sequence search',
      { sequence: SEQUENCE, contentType: ['computational'], start: 0, limit: 25 },
      {
        query: sequenceTerminal,
        return_type: 'polymer_entity',
        request_options: {
          results_content_type: ['computational'],
          paginate: { start: 0, rows: 25 },
          facets: [rcsbMethodFacet],
          scoring_strategy: 'combined',
          results_verbosity: 'verbose',
        },
      },
    ],
    [
      'a sequence search with no content scope',
      { sequence: SEQUENCE },
      {
        query: sequenceTerminal,
        return_type: 'polymer_entity',
        request_options: {
          paginate: { start: 0, rows: 25 },
          facets: [rcsbMethodFacet],
          scoring_strategy: 'combined',
          results_verbosity: 'verbose',
        },
      },
    ],
  ] as const)(
    'sends %s as one request with an unchanged body (#96)',
    async (_, params, expected) => {
      const spy = stubSearchHost();
      await service().search(params as Parameters<RcsbService['search']>[0], createMockContext(), [
        methodFacet,
      ]);
      expect(rawBodies(spy)).toEqual([JSON.stringify(expected)]);
    },
  );
});

describe('toRcsbFacet', () => {
  it('maps a terms facet without an interval', () => {
    const spec: FacetSpec = {
      dimension: 'method',
      attribute: 'exptl.method',
      aggregation: 'terms',
    };
    expect(toRcsbFacet(spec)).toEqual({
      name: 'method',
      aggregation_type: 'terms',
      attribute: 'exptl.method',
      min_interval_population: 1,
    });
  });

  it('includes the interval for a histogram facet', () => {
    const spec: FacetSpec = {
      dimension: 'resolution',
      attribute: 'rcsb_entry_info.resolution_combined',
      aggregation: 'histogram',
      interval: 0.5,
    };
    expect(toRcsbFacet(spec)).toMatchObject({ aggregation_type: 'histogram', interval: 0.5 });
  });

  it('nests a child facet recursively', () => {
    const spec: FacetSpec = {
      dimension: 'method',
      attribute: 'exptl.method',
      aggregation: 'terms',
      child: {
        dimension: 'release_year',
        attribute: 'rcsb_accession_info.initial_release_date',
        aggregation: 'date_histogram',
        interval: 'year',
      },
    };
    const out = toRcsbFacet(spec) as { facets: Array<Record<string, unknown>> };
    expect(out.facets).toHaveLength(1);
    expect(out.facets[0]).toMatchObject({ name: 'release_year', interval: 'year' });
  });
});

describe('RcsbService search — 204 / empty body (issue #4 regression)', () => {
  afterEach(() => vi.restoreAllMocks());

  const service = () =>
    new RcsbService(
      {} as never,
      {} as never,
      {
        rcsbSearchBaseUrl: 'https://search.test',
        rcsbDataBaseUrl: 'https://data.test',
        rcsbFilesBaseUrl: 'https://files.test',
      } as never,
    );

  it('returns an empty result set without retrying when RCSB answers 204', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    const out = await service().search({ text: 'zzzznotathing' }, createMockContext());
    expect(out).toEqual({ total: 0, hits: [] });
    // A zero-result 204 must not burn the retry budget.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each(['combined', 'sequence'])(
    'normalizes the %s RCSB sequence path and retains empty successes (#77)',
    async (strategy) => {
      const spy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(null, { status: 204 }));
      const svc = service();
      const result =
        strategy === 'combined'
          ? await svc.search(
              { sequence: ' a b o u x z c d e f \n', start: 9, limit: 2 },
              createMockContext(),
            )
          : await svc.searchSequence(
              ' a b o u x z c d e f \n',
              { start: 9, limit: 2 },
              createMockContext(),
            );
      expect(result).toEqual({
        total: 0,
        hits: [],
        // search() reports the universe it searched (#96); searchSequence() does not.
        ...(strategy === 'combined'
          ? { universes: [{ contentType: 'experimental', status: 'answered', total: 0 }] }
          : {}),
      });
      const request = JSON.parse(String(spy.mock.calls[0]?.[1]?.body));
      expect(request.query.parameters.value).toBe('ABOUXZCDEF');
      expect(request.request_options.paginate).toEqual({ start: 9, rows: 2 });
      expect(spy).toHaveBeenCalledTimes(1);
    },
  );

  it.each([' ', 'ACDEFGHIK', 'ACDEFGHIKJ', 'ACDEFGHIK*', 'ACDEFGHIKL'])(
    'rejects invalid sequence %j before either upstream request (#77)',
    async (sequence) => {
      const spy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(null, { status: 204 }));
      await expect(service().search({ sequence }, createMockContext())).rejects.toMatchObject({
        code: -32602,
        data: { reason: 'invalid_sequence' },
      });
      await expect(
        service().searchSequence(sequence, {}, createMockContext()),
      ).rejects.toMatchObject({ code: -32602, data: { reason: 'invalid_sequence' } });
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it('returns total 0 with empty buckets for a faceted zero-result query', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const out = await service().analyzeFacets(
      { text: 'zzzznotathing' },
      [{ dimension: 'method', attribute: 'exptl.method', aggregation: 'terms' }],
      createMockContext(),
    );
    expect(out.total).toBe(0);
    expect(out.facets).toEqual([{ dimension: 'method', attribute: 'exptl.method', buckets: [] }]);
  });
});

describe('RcsbService.search — a sequence search over both universes (#96)', () => {
  afterEach(() => vi.restoreAllMocks());

  const service = () =>
    new RcsbService(
      {} as never,
      {} as never,
      {
        rcsbSearchBaseUrl: 'https://search.test',
        rcsbDataBaseUrl: 'https://data.test',
        rcsbFilesBaseUrl: 'https://files.test',
      } as never,
    );

  const SEQUENCE = 'MVLSPADKTNVKAAWGKVGA';
  const BOTH: ContentType[] = ['experimental', 'computational'];

  type FakeHit = { id: string; bitscore?: number; evalue?: number };
  /** One universe's own search: its hits in upstream order, or a failure status. */
  type FakeUniverse =
    | { hits: FakeHit[]; total?: number; facets?: unknown[] }
    | { status: number; message?: string };

  /** A verbose sequence row; only the context fields the hit carries are sent. */
  const toRow = (hit: FakeHit, index: number) => ({
    identifier: hit.id,
    score: 1 / (index + 1),
    services: [
      {
        service_type: 'sequence',
        nodes: [
          {
            match_context: [
              {
                query_length: 142,
                ...(hit.bitscore !== undefined ? { bitscore: hit.bitscore } : {}),
                ...(hit.evalue !== undefined ? { evalue: hit.evalue } : {}),
              },
            ],
          },
        ],
      },
    ],
  });

  /** The RCSB request options a posted body carries. */
  type PostedOptions = {
    paginate: { start: number; rows: number };
    results_content_type?: ContentType[];
  };
  const optionsOf = (init: RequestInit | undefined): PostedOptions =>
    JSON.parse(String(init?.body)).request_options;

  /**
   * Answer each universe's own search from `universes`, honoring the request's
   * paginate window. A request scoped to both universes — one combined search —
   * gets a 204, so code still sending one reads as an empty result.
   */
  const serveUniverses = (universes: Record<ContentType, FakeUniverse>) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== 'search.test') throw new Error(`unmocked fetch: ${url.href}`);
      const options = optionsOf(init);
      const [contentType, ...rest] = options.results_content_type ?? [];
      if (!contentType || rest.length > 0) return new Response(null, { status: 204 });
      const universe = universes[contentType];
      if ('status' in universe) {
        // Retry-After 0 lets the retry loop run its attempts without a real wait.
        return Response.json(
          { status: universe.status, message: universe.message ?? 'upstream failure' },
          { status: universe.status, headers: { 'Retry-After': '0' } },
        );
      }
      const { start, rows } = options.paginate;
      return Response.json({
        total_count: universe.total ?? universe.hits.length,
        result_set: universe.hits.slice(start, start + rows).map((h, i) => toRow(h, start + i)),
        ...(universe.facets ? { facets: universe.facets } : {}),
      });
    });

  const searchBoth = (
    page: { start?: number; limit?: number },
    ctx = createMockContext(),
    facets?: FacetSpec[],
  ) => service().search({ sequence: SEQUENCE, contentType: BOTH, ...page }, ctx, facets);

  const ids = (result: { hits: Array<{ id: string }> }) => result.hits.map((h) => h.id);

  /** Exercises every merge rule: interleaving, a tie, and hits with no bit score. */
  const MIXED: Record<ContentType, FakeUniverse> = {
    experimental: {
      hits: [
        { id: 'E1_1', bitscore: 300, evalue: 1e-90 },
        { id: 'E2_1', bitscore: 200, evalue: 1e-50 },
        { id: 'E3_1', bitscore: 200, evalue: 2e-50 },
        { id: 'E4_1' },
      ],
    },
    computational: {
      hits: [
        { id: 'AF_AFC1F1_1', bitscore: 250, evalue: 3e-70 },
        { id: 'AF_AFC2F1_1', bitscore: 200, evalue: 4e-49 },
        { id: 'AF_AFC3F1_1' },
      ],
    },
  };
  const MIXED_ORDER = ['E1_1', 'AF_AFC1F1_1', 'E2_1', 'E3_1', 'AF_AFC2F1_1', 'E4_1', 'AF_AFC3F1_1'];

  it('sends one query per universe, each paged from 0 to start + limit, the rest unchanged', async () => {
    const spy = serveUniverses(MIXED);
    await searchBoth({ start: 2, limit: 3 }, createMockContext(), [
      { dimension: 'method', attribute: 'exptl.method', aggregation: 'terms' },
    ]);
    const half = (contentType: ContentType) =>
      JSON.stringify({
        query: {
          type: 'terminal',
          service: 'sequence',
          parameters: {
            evalue_cutoff: 1,
            identity_cutoff: 0,
            sequence_type: 'protein',
            value: SEQUENCE,
          },
        },
        return_type: 'polymer_entity',
        request_options: {
          results_content_type: [contentType],
          paginate: { start: 0, rows: 5 },
          facets: [
            {
              name: 'method',
              aggregation_type: 'terms',
              attribute: 'exptl.method',
              min_interval_population: 1,
            },
          ],
          scoring_strategy: 'combined',
          results_verbosity: 'verbose',
        },
      });
    const bodies = spy.mock.calls.map((call) => String(call[1]?.body));
    expect(bodies.toSorted()).toEqual([half('computational'), half('experimental')]);
  });

  it('sends the two universe searches concurrently', async () => {
    let inFlight = 0;
    let peak = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Hold the answer past every queued microtask: a second search sent only
      // after the first settles cannot have started by then.
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return Response.json({ total_count: 0, result_set: [] });
    });
    await searchBoth({});
    expect(peak).toBe(2);
  });

  it('merges by bit score: interleaved, experimental on a tie, a hit without one after every hit with one', async () => {
    serveUniverses(MIXED);
    const result = await searchBoth({});
    expect(ids(result)).toEqual(MIXED_ORDER);
    // Each hit keeps the E-value its own universe's search reported.
    expect(result.hits.find((h) => h.id === 'AF_AFC2F1_1')).toMatchObject({
      bitscore: 200,
      evalue: 4e-49,
    });
  });

  it('never re-sorts a half: one out of bit-score order merges in the order it arrived', async () => {
    serveUniverses({
      experimental: {
        hits: [
          { id: 'E1_1', bitscore: 100 },
          { id: 'E2_1', bitscore: 200 },
        ],
      },
      computational: { hits: [{ id: 'AF_AFC1F1_1', bitscore: 150 }] },
    });
    expect(ids(await searchBoth({}))).toEqual(['AF_AFC1F1_1', 'E1_1', 'E2_1']);
  });

  it('returns the merged rows [start, start + limit) for a page spanning both halves', async () => {
    serveUniverses(MIXED);
    const result = await searchBoth({ start: 2, limit: 3 });
    expect(ids(result)).toEqual(['E2_1', 'E3_1', 'AF_AFC2F1_1']);
    expect(result.total).toBe(7);
  });

  it('pages from 0 through every hit of both universes exactly once, one half running out first', async () => {
    const universes: Record<ContentType, FakeUniverse> = {
      experimental: {
        hits: [
          { id: 'E1_1', bitscore: 400 },
          { id: 'E2_1', bitscore: 90 },
        ],
      },
      computational: {
        hits: [
          { id: 'AF_AFC1F1_1', bitscore: 300 },
          { id: 'AF_AFC2F1_1', bitscore: 200 },
          { id: 'AF_AFC3F1_1', bitscore: 100 },
          { id: 'AF_AFC4F1_1', bitscore: 90 },
          { id: 'AF_AFC5F1_1', bitscore: 80 },
        ],
      },
    };
    serveUniverses(universes);
    const seen: string[] = [];
    for (let start = 0, pages = 0; pages < 10; pages += 1) {
      const page = await searchBoth({ start, limit: 2 });
      expect(page.total).toBe(7);
      if (page.hits.length === 0) break;
      seen.push(...ids(page));
      start += page.hits.length;
    }
    expect(seen).toEqual([
      'E1_1',
      'AF_AFC1F1_1',
      'AF_AFC2F1_1',
      'AF_AFC3F1_1',
      'E2_1',
      'AF_AFC4F1_1',
      'AF_AFC5F1_1',
    ]);
    const pastEnd = await searchBoth({ start: 7, limit: 2 });
    expect(pastEnd).toMatchObject({ total: 7, hits: [] });
  });

  it("sums the totals, reports each universe's own, and reads the query length", async () => {
    serveUniverses({
      experimental: { hits: [{ id: 'E1_1', bitscore: 300 }], total: 1383 },
      computational: { hits: [{ id: 'AF_AFC1F1_1', bitscore: 250 }], total: 925 },
    });
    const result = await searchBoth({ limit: 1 });
    expect(result).toMatchObject({ total: 2308, queryLength: 142 });
    expect(result.universes).toEqual([
      { contentType: 'experimental', status: 'answered', total: 1383 },
      { contentType: 'computational', status: 'answered', total: 925 },
    ]);
  });

  it("caps each half's rows at RCSB's 10,000-row request maximum", async () => {
    const spy = serveUniverses(MIXED);
    const result = await searchBoth({ start: 9990, limit: 25 });
    expect(spy.mock.calls.map((call) => optionsOf(call[1]).paginate)).toEqual([
      { start: 0, rows: 10_000 },
      { start: 0, rows: 10_000 },
    ]);
    expect(result).toMatchObject({ total: 7, hits: [] });
  });

  it('sums facet buckets per label before any cap, nested cross-tabs included', async () => {
    const year = (label: string, population: number) => ({ label, population });
    serveUniverses({
      experimental: {
        hits: [],
        facets: [
          {
            name: 'organism',
            buckets: [year('Homo sapiens', 3), year('Mus musculus', 1), year('Bos taurus', 1)],
          },
          { name: 'resolution', buckets: [year('2.0', 3), year('10.0', 1)] },
          {
            name: 'method',
            buckets: [
              {
                label: 'X-RAY DIFFRACTION',
                population: 3,
                facets: [{ name: 'release_year', buckets: [year('2001', 1), year('2010', 2)] }],
              },
              {
                label: 'ELECTRON MICROSCOPY',
                population: 1,
                facets: [{ name: 'release_year', buckets: [year('2020', 1)] }],
              },
            ],
          },
        ],
      },
      computational: {
        hits: [],
        facets: [
          {
            name: 'organism',
            buckets: [year('Mus musculus', 4), year('Danio rerio', 2), year('Homo sapiens', 1)],
          },
          { name: 'resolution', buckets: [year('5.0', 2), year('2.0', 1)] },
          {
            name: 'method',
            buckets: [
              {
                label: 'X-RAY DIFFRACTION',
                population: 2,
                facets: [{ name: 'release_year', buckets: [year('1999', 1), year('2010', 1)] }],
              },
            ],
          },
        ],
      },
    });
    const result = await searchBoth({}, createMockContext(), [
      {
        dimension: 'organism',
        attribute: 'rcsb_entity_source_organism.ncbi_scientific_name',
        aggregation: 'terms',
      },
      {
        dimension: 'resolution',
        attribute: 'rcsb_entry_info.resolution_combined',
        aggregation: 'histogram',
        interval: 0.5,
      },
      {
        dimension: 'method',
        attribute: 'exptl.method',
        aggregation: 'terms',
        child: {
          dimension: 'release_year',
          attribute: 'rcsb_accession_info.initial_release_date',
          aggregation: 'date_histogram',
          interval: 'year',
        },
      },
    ]);
    const [organism, resolution, method] = result.facets ?? [];
    // Terms re-rank by the summed count.
    expect(organism?.buckets).toEqual([
      { label: 'Mus musculus', count: 5 },
      { label: 'Homo sapiens', count: 4 },
      { label: 'Danio rerio', count: 2 },
      { label: 'Bos taurus', count: 1 },
    ]);
    // Histogram bins stay in value order — numeric, so 10.0 follows 5.0.
    expect(resolution?.buckets).toEqual([
      { label: '2.0', count: 4, rangeFrom: 2, rangeTo: 2.5 },
      { label: '5.0', count: 2, rangeFrom: 5, rangeTo: 5.5 },
      { label: '10.0', count: 1, rangeFrom: 10, rangeTo: 10.5 },
    ]);
    const releaseYear = (buckets: Array<{ label: string; count: number }>) => ({
      dimension: 'release_year',
      attribute: 'rcsb_accession_info.initial_release_date',
      buckets,
    });
    expect(method?.buckets).toEqual([
      {
        label: 'X-RAY DIFFRACTION',
        count: 5,
        child: releaseYear([
          { label: '1999', count: 1 },
          { label: '2001', count: 1 },
          { label: '2010', count: 3 },
        ]),
      },
      {
        label: 'ELECTRON MICROSCOPY',
        count: 1,
        child: releaseYear([{ label: '2020', count: 1 }]),
      },
    ]);
  });

  it("returns the other universe's hits when one universe's search fails, marking it failed", async () => {
    const spy = serveUniverses({
      experimental: MIXED.experimental,
      computational: {
        status: 500,
        message: 'Server http://production-rcsb-seqsearch-a returned unexpected status: UNKNOWN',
      },
    });
    const result = await searchBoth({ limit: 2 });
    expect(ids(result)).toEqual(['E1_1', 'E2_1']);
    expect(result.total).toBe(4);
    expect(result.universes).toEqual([
      { contentType: 'experimental', status: 'answered', total: 4 },
      { contentType: 'computational', status: 'failed' },
    ]);
    // The failed half ran its retries first: one experimental request, four computational.
    expect(spy).toHaveBeenCalledTimes(5);
  });

  it("returns the computed models when the experimental universe's search fails", async () => {
    serveUniverses({ experimental: { status: 400 }, computational: MIXED.computational });
    const result = await searchBoth({});
    expect(ids(result)).toEqual(['AF_AFC1F1_1', 'AF_AFC2F1_1', 'AF_AFC3F1_1']);
    expect(result.universes).toEqual([
      { contentType: 'experimental', status: 'failed' },
      { contentType: 'computational', status: 'answered', total: 3 },
    ]);
  });

  it('fails the search when both universes fail', async () => {
    serveUniverses({ experimental: { status: 500 }, computational: { status: 400 } });
    await expect(searchBoth({})).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });

  it("fails the search on a rate limit, even with the other universe's hits in hand", async () => {
    serveUniverses({ experimental: MIXED.experimental, computational: { status: 429 } });
    await expect(searchBoth({})).rejects.toMatchObject({ code: JsonRpcErrorCode.RateLimited });
  });

  /**
   * Answer the experimental search, then — once the computational one is in
   * flight — abort `controller` with `reason` and reject that request the way
   * fetch does.
   */
  const abortDuringComputational = (controller: AbortController, reason?: unknown) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const [contentType] = optionsOf(init).results_content_type ?? [];
      if (contentType === 'experimental') {
        return Response.json({
          total_count: 1,
          result_set: [toRow({ id: 'E1_1', bitscore: 300 }, 0)],
        });
      }
      controller.abort(reason);
      const signal = init?.signal;
      throw signal?.reason ?? new DOMException('aborted', 'AbortError');
    });

  it("rethrows the caller's cancellation rather than returning the half that answered", async () => {
    const controller = new AbortController();
    abortDuringComputational(controller);
    const outcome = searchBoth({}, createMockContext({ signal: controller.signal }));
    await expect(outcome).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    await expect(outcome).rejects.toThrow(/aborted/);
  });

  it("keeps the half that answered when the call's time budget stops the other", async () => {
    const controller = new AbortController();
    abortDuringComputational(
      controller,
      new DOMException('Upstream requests for this call ran past the budget.', 'TimeoutError'),
    );
    const result = await searchBoth({}, createMockContext({ signal: controller.signal }));
    expect(ids(result)).toEqual(['E1_1']);
    expect(result.universes).toEqual([
      { contentType: 'experimental', status: 'answered', total: 1 },
      { contentType: 'computational', status: 'failed' },
    ]);
  });

  it('reports one universe on a single-universe sequence search, and none without a sequence', async () => {
    serveUniverses(MIXED);
    const predicted = await service().search(
      { sequence: SEQUENCE, contentType: ['computational'] },
      createMockContext(),
    );
    expect(predicted.universes).toEqual([
      { contentType: 'computational', status: 'answered', total: 3 },
    ]);
    const unscoped = await service().search({ sequence: SEQUENCE }, createMockContext());
    // RCSB's default scope, with the option omitted, is experimental.
    expect(unscoped.universes).toEqual([
      { contentType: 'experimental', status: 'answered', total: 0 },
    ]);
    const text = await service().search(
      { text: 'hemoglobin', contentType: ['experimental'] },
      createMockContext(),
    );
    expect(text).not.toHaveProperty('universes');
  });

  describe('the deadline on the two universe searches', () => {
    const DEADLINE_MS = 35_000;
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    /** A universe's search under fake time: never answering, or answering after `afterMs`, as a failure when `status` is set. */
    type Timed = { hang: true } | { afterMs: number; status?: number };

    /**
     * Serve each universe by its plan, counting requests. Every request settles
     * early only when an abort reaches it, rejecting with the signal's reason as
     * fetch does. An answer is MIXED's hits for that universe.
     */
    const serveTimed = (plans: Record<ContentType, Timed>) => {
      const requests: Record<ContentType, number> = { experimental: 0, computational: 0 };
      vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
        const [contentType = 'experimental'] = optionsOf(init).results_content_type ?? [];
        requests[contentType] += 1;
        const plan = plans[contentType];
        const universe = MIXED[contentType];
        const hits = 'hits' in universe ? universe.hits : [];
        return new Promise<Response>((resolve, reject) => {
          const answer =
            'afterMs' in plan
              ? setTimeout(
                  () =>
                    resolve(
                      plan.status
                        ? Response.json(
                            { status: plan.status, message: 'upstream failure' },
                            { status: plan.status },
                          )
                        : Response.json({
                            total_count: hits.length,
                            result_set: hits.map((h, i) => toRow(h, i)),
                          }),
                    ),
                  plan.afterMs,
                )
              : undefined;
          init?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(answer);
              reject(init.signal?.reason);
            },
            { once: true },
          );
        });
      });
      return requests;
    };

    /** Whether `promise` has settled, read without awaiting it. */
    const watch = (promise: Promise<unknown>) => {
      const state = { settled: false };
      const settle = () => {
        state.settled = true;
      };
      promise.then(settle, settle);
      return state;
    };

    it('leaves out a universe still searching at the deadline, settling then and not before', async () => {
      serveTimed({ experimental: { afterMs: 100 }, computational: { hang: true } });
      const outcome = searchBoth({});
      const state = watch(outcome);
      await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
      expect(state.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(state.settled).toBe(true);
      const result = await outcome;
      expect(ids(result)).toEqual(['E1_1', 'E2_1', 'E3_1', 'E4_1']);
      expect(result.total).toBe(4);
      expect(result.universes).toEqual([
        { contentType: 'experimental', status: 'answered', total: 4 },
        { contentType: 'computational', status: 'failed' },
      ]);
    });

    it('keeps a universe whose search answers late but inside the deadline', async () => {
      // Inside the HTTP layer's 30 s attempt timeout, so the first attempt answers.
      serveTimed({ experimental: { afterMs: 100 }, computational: { afterMs: 29_000 } });
      const outcome = searchBoth({});
      await vi.advanceTimersByTimeAsync(29_000);
      const result = await outcome;
      expect(ids(result)).toEqual(MIXED_ORDER);
      expect(result.universes).toEqual([
        { contentType: 'experimental', status: 'answered', total: 4 },
        { contentType: 'computational', status: 'answered', total: 3 },
      ]);
    });

    it('leaves out a universe whose search keeps failing slowly, its retry cut at the deadline', async () => {
      const requests = serveTimed({
        experimental: { afterMs: 100 },
        computational: { afterMs: 25_000, status: 500 },
      });
      const outcome = searchBoth({});
      const state = watch(outcome);
      await vi.advanceTimersByTimeAsync(DEADLINE_MS);
      expect(state.settled).toBe(true);
      const result = await outcome;
      // The first slow 500 was retried; the deadline stopped the retry.
      expect(requests.computational).toBe(2);
      expect(ids(result)).toEqual(['E1_1', 'E2_1', 'E3_1', 'E4_1']);
      expect(result.universes?.[1]).toEqual({ contentType: 'computational', status: 'failed' });
    });

    it('fails the search with a Timeout when both universes are still searching at the deadline', async () => {
      serveTimed({ experimental: { hang: true }, computational: { hang: true } });
      const outcome = searchBoth({});
      const state = watch(outcome);
      await vi.advanceTimersByTimeAsync(DEADLINE_MS);
      expect(state.settled).toBe(true);
      await expect(outcome).rejects.toMatchObject({ code: JsonRpcErrorCode.Timeout });
    });

    it('clears the deadline once both universes answer, leaving no timer behind', async () => {
      serveUniverses(MIXED);
      await searchBoth({});
      expect(vi.getTimerCount()).toBe(0);
    });

    it('holds a single-universe sequence search to the caller’s clock alone', async () => {
      serveTimed({ experimental: { afterMs: 100 }, computational: { hang: true } });
      const caller = new AbortController();
      const outcome = service().search(
        { sequence: SEQUENCE, contentType: ['computational'] },
        createMockContext({ signal: caller.signal }),
      );
      const state = watch(outcome);
      await vi.advanceTimersByTimeAsync(DEADLINE_MS + 10_000);
      expect(state.settled).toBe(false);
      caller.abort();
      await expect(outcome).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    });
  });
});
