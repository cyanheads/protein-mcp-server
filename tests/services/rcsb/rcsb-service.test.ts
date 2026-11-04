/**
 * @fileoverview Tests for the RCSB query builders: the search-query node tree
 * (match-all, single terminal, AND group, sequence, resolution ceiling), the
 * organism node (taxon ID, exact name arms, the multi-word phrase arm), the
 * method node (vocabulary, aliases, `in` for NMR, the unknown_method rejection
 * before any request), the bound-ligand node shared with the ligand search, the
 * posted request bodies under both return types and their verbosity option, the
 * facet-spec translation to the RCSB request shape (terms vs. histogram,
 * nesting), and the entity-number comparator every GraphQL entity array is
 * ordered by.
 * @module tests/services/rcsb/rcsb-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildQuery,
  compareEntityIds,
  type FacetSpec,
  organismForm,
  RcsbService,
  toRcsbFacet,
} from '@/services/rcsb/rcsb-service.js';

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
      expect(result).toEqual({ total: 0, hits: [] });
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
