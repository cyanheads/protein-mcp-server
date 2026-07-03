/**
 * @fileoverview Tests for the RCSB service GraphQL/REST methods exercised through
 * realistic upstream payloads (HTTP mocked): entry-metadata normalization, UniProt
 * xref resolution, sequence extraction, binding-site assembly with distance sort,
 * chem-comp normalization (SMILES/InChIKey fallback chain) with the 404 → null
 * branch, sequence/ligand/chem-comp search hit normalization, and the GraphQL
 * errors → throw path.
 * @module tests/services/rcsb/rcsb-normalizers.test
 */

import { JsonRpcErrorCode, notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/shared/http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/shared/http.js')>();
  return { ...actual, fetchJson: vi.fn() };
});

import { RcsbService } from '@/services/rcsb/rcsb-service.js';
import { fetchJson } from '@/services/shared/http.js';

const fetchJsonMock = vi.mocked(fetchJson);

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

const gql = <T>(data: T) => ({ data });

beforeEach(() => vi.clearAllMocks());

describe('RcsbService.getEntries', () => {
  /** A real GraphQL entries payload for 4HHB, trimmed to the queried fields. */
  const ENTRY_4HHB = {
    rcsb_id: '4HHB',
    struct: { title: 'THE CRYSTAL STRUCTURE OF HUMAN DEOXYHAEMOGLOBIN' },
    exptl: [{ method: 'X-RAY DIFFRACTION' }],
    rcsb_entry_info: { resolution_combined: [1.74], molecular_weight: 64.74 },
    rcsb_accession_info: { initial_release_date: '1984-07-17T00:00:00Z' },
    polymer_entities: [
      {
        rcsb_id: '4HHB_1',
        rcsb_polymer_entity: { pdbx_description: 'Hemoglobin subunit alpha' },
        rcsb_polymer_entity_container_identifiers: { auth_asym_ids: ['A', 'C'] },
        entity_poly: { rcsb_sample_sequence_length: 141 },
        rcsb_entity_source_organism: [{ ncbi_scientific_name: 'Homo sapiens' }],
      },
      {
        rcsb_id: '4HHB_2',
        rcsb_polymer_entity: { pdbx_description: 'Hemoglobin subunit beta' },
        rcsb_entity_source_organism: [{ ncbi_scientific_name: 'Homo sapiens' }],
      },
    ],
    nonpolymer_entities: [
      {
        rcsb_nonpolymer_entity_container_identifiers: { nonpolymer_comp_id: 'HEM' },
        nonpolymer_comp: {
          chem_comp: { name: 'PROTOPORPHYRIN IX CONTAINING FE', formula: 'C34 H32 Fe N4 O4' },
        },
      },
    ],
  };

  it('returns [] for an empty id list without calling upstream', async () => {
    expect(await service().getEntries([], createMockContext())).toEqual([]);
    expect(fetchJsonMock).not.toHaveBeenCalled();
  });

  it('normalizes entry metadata, dedupes organisms, and keeps ligands', async () => {
    fetchJsonMock.mockResolvedValue(gql({ entries: [ENTRY_4HHB] }));
    const [meta] = await service().getEntries(['4hhb'], createMockContext());

    expect(meta).toMatchObject({
      id: '4HHB',
      title: 'THE CRYSTAL STRUCTURE OF HUMAN DEOXYHAEMOGLOBIN',
      methods: ['X-RAY DIFFRACTION'],
      resolution: 1.74,
      molecularWeight: 64.74,
      releaseDate: '1984-07-17T00:00:00Z',
      organisms: ['Homo sapiens'], // deduped across both entities
    });
    expect(meta?.polymerEntities[0]).toMatchObject({
      entityId: '4HHB_1',
      description: 'Hemoglobin subunit alpha',
      organism: 'Homo sapiens',
      chains: ['A', 'C'],
      sequenceLength: 141,
    });
    expect(meta?.ligands).toEqual([
      { compId: 'HEM', name: 'PROTOPORPHYRIN IX CONTAINING FE', formula: 'C34 H32 Fe N4 O4' },
    ]);
  });

  it('upper-cases ids in the GraphQL variables', async () => {
    fetchJsonMock.mockResolvedValue(gql({ entries: [] }));
    await service().getEntries(['4hhb', '2hhb'], createMockContext());
    // fetchJson(url, ctx, opts) — the serialized GraphQL body lives on opts.body.
    const opts = fetchJsonMock.mock.calls[0]?.[2] as unknown as { body: string };
    expect(JSON.parse(opts.body).variables.ids).toEqual(['4HHB', '2HHB']);
  });

  it('filters out null entries (unresolved ids return null in the array)', async () => {
    fetchJsonMock.mockResolvedValue(gql({ entries: [null, ENTRY_4HHB, null] }));
    const out = await service().getEntries(['4HHB', '9ZZZ'], createMockContext());
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe('4HHB');
  });

  it('tolerates a fully sparse entry (only rcsb_id) without fabricating fields', async () => {
    fetchJsonMock.mockResolvedValue(gql({ entries: [{ rcsb_id: '1ABC' }] }));
    const [meta] = await service().getEntries(['1ABC'], createMockContext());
    expect(meta).toEqual({ id: '1ABC', organisms: [], polymerEntities: [], ligands: [] });
  });

  it('throws when GraphQL returns an errors array and no data', async () => {
    fetchJsonMock.mockResolvedValue({ errors: [{ message: 'field "bogus" not found' }] });
    await expect(service().getEntries(['4HHB'], createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: expect.stringContaining('field "bogus" not found'),
    });
  });
});

describe('RcsbService.resolveUniprotEntities', () => {
  it('returns one entry per UniProt-mapped polymer entity with its chains, accession, and description', async () => {
    fetchJsonMock.mockResolvedValue(
      gql({
        entry: {
          // Real 4HHB shape: two protein entities, alpha (chains A/C) and beta (B/D).
          polymer_entities: [
            {
              rcsb_polymer_entity: { pdbx_description: 'Hemoglobin subunit alpha' },
              rcsb_polymer_entity_container_identifiers: {
                auth_asym_ids: ['A', 'C'],
                reference_sequence_identifiers: [
                  { database_name: 'UniProt', database_accession: 'p69905' }, // case-folded
                  { database_name: 'GenBank', database_accession: 'X00001' }, // non-UniProt, skipped
                ],
              },
            },
            {
              rcsb_polymer_entity: { pdbx_description: 'Hemoglobin subunit beta' },
              rcsb_polymer_entity_container_identifiers: {
                auth_asym_ids: ['B', 'D'],
                reference_sequence_identifiers: [
                  { database_name: 'UniProtKB', database_accession: 'P68871' },
                ],
              },
            },
          ],
        },
      }),
    );
    const out = await service().resolveUniprotEntities('4hhb', createMockContext());
    expect(out).toEqual([
      { chains: ['A', 'C'], accession: 'P69905', proteinName: 'Hemoglobin subunit alpha' },
      { chains: ['B', 'D'], accession: 'P68871', proteinName: 'Hemoglobin subunit beta' },
    ]);
  });

  it('skips entities with no UniProt xref and tolerates missing chains/description', async () => {
    fetchJsonMock.mockResolvedValue(
      gql({
        entry: {
          polymer_entities: [
            {
              // no chains, no description — still maps
              rcsb_polymer_entity_container_identifiers: {
                reference_sequence_identifiers: [
                  { database_name: 'UniProt', database_accession: 'P0DTD1' },
                ],
              },
            },
            {
              // GenBank only → not UniProt-mapped → skipped
              rcsb_polymer_entity_container_identifiers: {
                auth_asym_ids: ['X'],
                reference_sequence_identifiers: [
                  { database_name: 'GenBank', database_accession: 'X1' },
                ],
              },
            },
          ],
        },
      }),
    );
    const out = await service().resolveUniprotEntities('1abc', createMockContext());
    expect(out).toEqual([{ chains: [], accession: 'P0DTD1' }]);
  });

  it('returns [] when the entry has no polymer entities', async () => {
    fetchJsonMock.mockResolvedValue(gql({ entry: { polymer_entities: [] } }));
    expect(await service().resolveUniprotEntities('1ABC', createMockContext())).toEqual([]);
  });
});

describe('RcsbService.getSequence', () => {
  it('returns the first entity carrying a canonical sequence, whitespace-stripped', async () => {
    fetchJsonMock.mockResolvedValue(
      gql({
        entry: {
          polymer_entities: [
            { rcsb_id: '4HHB_0', entity_poly: {} }, // no sequence → skipped
            { rcsb_id: '4HHB_1', entity_poly: { pdbx_seq_one_letter_code_can: 'MVL\nSPA DK' } },
          ],
        },
      }),
    );
    const out = await service().getSequence('4HHB', createMockContext());
    expect(out).toEqual({ entityId: '4HHB_1', sequence: 'MVLSPADK' });
  });

  it('returns null when no entity carries a sequence', async () => {
    fetchJsonMock.mockResolvedValue(gql({ entry: { polymer_entities: [{ rcsb_id: 'x' }] } }));
    expect(await service().getSequence('1ABC', createMockContext())).toBeNull();
  });
});

describe('RcsbService.getBindingSites', () => {
  /** A real binding-site payload: one HEM ligand instance with two contact residues. */
  const BINDING = {
    entry: {
      nonpolymer_entities: [
        {
          rcsb_nonpolymer_entity_container_identifiers: { nonpolymer_comp_id: 'HEM' },
          nonpolymer_entity_instances: [
            {
              rcsb_nonpolymer_entity_instance_container_identifiers: { auth_asym_id: 'A' },
              rcsb_target_neighbors: [
                { target_comp_id: 'HIS', target_asym_id: 'A', target_seq_id: 87, distance: 2.1 },
                { target_comp_id: 'PHE', target_asym_id: 'A', target_seq_id: 43, distance: 1.4 },
                { target_asym_id: 'A' }, // no comp_id → dropped
              ],
            },
          ],
        },
        {
          rcsb_nonpolymer_entity_container_identifiers: { nonpolymer_comp_id: 'PO4' },
          nonpolymer_entity_instances: [
            {
              rcsb_target_neighbors: [{ target_comp_id: 'ARG', target_asym_id: 'B', distance: 3 }],
            },
          ],
        },
      ],
    },
  };

  it('assembles sites and sorts residues nearest-first', async () => {
    fetchJsonMock.mockResolvedValue(gql(BINDING));
    const sites = await service().getBindingSites('4HHB', undefined, createMockContext());

    expect(sites).toHaveLength(2);
    const hem = sites.find((s) => s.ligandCompId === 'HEM');
    expect(hem).toMatchObject({ ligandCompId: 'HEM', ligandAsymId: 'A' });
    // PHE (1.4 Å) sorts before HIS (2.1 Å); the comp_id-less neighbor is dropped.
    expect(hem?.residues.map((r) => r.residueCompId)).toEqual(['PHE', 'HIS']);
    expect(hem?.residues[0]).toMatchObject({ residueCompId: 'PHE', seqId: 43, distance: 1.4 });
  });

  it('filters to a single ligand when compId is given', async () => {
    fetchJsonMock.mockResolvedValue(gql(BINDING));
    const sites = await service().getBindingSites('4HHB', 'po4', createMockContext());
    expect(sites).toHaveLength(1);
    expect(sites[0]?.ligandCompId).toBe('PO4');
  });

  it('returns [] when no instance has target neighbors', async () => {
    fetchJsonMock.mockResolvedValue(
      gql({
        entry: {
          nonpolymer_entities: [
            {
              rcsb_nonpolymer_entity_container_identifiers: { nonpolymer_comp_id: 'HEM' },
              nonpolymer_entity_instances: [{ rcsb_target_neighbors: [] }],
            },
          ],
        },
      }),
    );
    expect(await service().getBindingSites('4HHB', undefined, createMockContext())).toEqual([]);
  });
});

describe('RcsbService.getChemComp', () => {
  it('normalizes chem-comp metadata, preferring stereo SMILES and top-level InChIKey', async () => {
    fetchJsonMock.mockResolvedValue({
      chem_comp: {
        name: 'IMATINIB',
        formula: 'C29 H31 N7 O',
        formula_weight: 493.6,
        type: 'non-polymer',
      },
      rcsb_chem_comp_descriptor: {
        SMILES_stereo: 'Cc1ccc(...)cc1',
        SMILES: 'Cc1ccc...',
        InChIKey: 'KTUFNOKKBVMGRW-UHFFFAOYSA-N',
      },
    });
    const out = await service().getChemComp('sti', createMockContext());
    expect(out).toEqual({
      compId: 'STI',
      name: 'IMATINIB',
      formula: 'C29 H31 N7 O',
      formulaWeight: 493.6,
      type: 'non-polymer',
      smiles: 'Cc1ccc(...)cc1',
      inchikey: 'KTUFNOKKBVMGRW-UHFFFAOYSA-N',
    });
  });

  it('falls back to the pdbx descriptor list for SMILES/InChIKey when the rcsb block is absent', async () => {
    fetchJsonMock.mockResolvedValue({
      chem_comp: { name: 'WATER', formula: 'H2 O' },
      pdbx_chem_comp_descriptor: [
        { type: 'SMILES_CANONICAL', descriptor: 'O' },
        { type: 'InChIKey', descriptor: 'XLYOFNOQVPJJNP-UHFFFAOYSA-N' },
      ],
    });
    const out = await service().getChemComp('HOH', createMockContext());
    expect(out).toMatchObject({
      compId: 'HOH',
      smiles: 'O',
      inchikey: 'XLYOFNOQVPJJNP-UHFFFAOYSA-N',
    });
  });

  it('returns null on a 404 (unknown component)', async () => {
    fetchJsonMock.mockRejectedValue(notFound('not found'));
    expect(await service().getChemComp('ZZZ', createMockContext())).toBeNull();
  });

  it('rethrows a non-404 failure', async () => {
    fetchJsonMock.mockRejectedValue(serviceUnavailable('data API down'));
    await expect(service().getChemComp('HEM', createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });
});

describe('RcsbService search helpers', () => {
  it('searchSequence normalizes polymer-entity hits and totals', async () => {
    fetchJsonMock.mockResolvedValue({
      total_count: 12,
      result_set: [
        { identifier: '4HHB_1', score: 1 },
        { identifier: '2HHB_1', score: 0.9 },
      ],
    });
    const out = await service().searchSequence('MVLS', { limit: 5 }, createMockContext());
    expect(out.total).toBe(12);
    expect(out.hits).toEqual([
      { id: '4HHB_1', score: 1 },
      { id: '2HHB_1', score: 0.9 },
    ]);
  });

  it('searchByLigand upper-cases the component id and sorts by resolution (best first)', async () => {
    fetchJsonMock.mockResolvedValue({
      total_count: 3,
      result_set: [{ identifier: '4HHB', score: 1 }],
    });
    await service().searchByLigand('hem', { limit: 10 }, createMockContext());
    const opts = fetchJsonMock.mock.calls[0]?.[2] as unknown as { body: string };
    const body = JSON.parse(opts.body);
    expect(body.query.parameters.value).toBe('HEM');
    // Containment score is uniform, so a server-side resolution sort supplies the real order.
    expect(body.request_options.sort).toEqual([
      { sort_by: 'rcsb_entry_info.resolution_combined', direction: 'asc' },
    ]);
    expect(body.request_options.paginate.rows).toBe(10);
  });

  it('countEntriesWithLigand returns the deposition total from a count-only (rows 0, unsorted) query', async () => {
    fetchJsonMock.mockResolvedValue({ total_count: 6475, result_set: [] });
    const n = await service().countEntriesWithLigand('hem', createMockContext());
    expect(n).toBe(6475);
    const opts = fetchJsonMock.mock.calls[0]?.[2] as unknown as { body: string };
    const body = JSON.parse(opts.body);
    expect(body.query.parameters.value).toBe('HEM');
    expect(body.request_options.paginate.rows).toBe(0);
    expect(body.request_options.sort).toBeUndefined();
  });

  it('findChemComps returns only the hit identifiers', async () => {
    fetchJsonMock.mockResolvedValue({
      result_set: [
        { identifier: 'HEM', score: 1 },
        { identifier: 'HEC', score: 0.8 },
      ],
    });
    const out = await service().findChemComps('heme', 25, createMockContext());
    expect(out).toEqual(['HEM', 'HEC']);
  });

  it('search returns total 0 and [] hits when upstream omits counts', async () => {
    fetchJsonMock.mockResolvedValue({});
    const out = await service().search({ text: 'zzz' }, createMockContext());
    expect(out).toEqual({ total: 0, hits: [] });
  });

  it('analyzeFacets normalizes nested buckets (population over count) for a cross-tab', async () => {
    fetchJsonMock.mockResolvedValue({
      total_count: 1000,
      facets: [
        {
          name: 'method',
          attribute: 'exptl.method',
          buckets: [
            {
              label: 'X-RAY DIFFRACTION',
              population: 800,
              facets: [
                {
                  name: 'release_year',
                  attribute: 'rcsb_accession_info.initial_release_date',
                  buckets: [
                    { label: '2020', population: 100 },
                    { label: '2021', population: 120 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const spec = {
      dimension: 'method',
      attribute: 'exptl.method',
      aggregation: 'terms' as const,
      child: {
        dimension: 'release_year',
        attribute: 'rcsb_accession_info.initial_release_date',
        aggregation: 'date_histogram' as const,
        interval: 'year',
      },
    };
    const out = await service().analyzeFacets({}, [spec], createMockContext());

    expect(out.total).toBe(1000);
    expect(out.facets[0]?.buckets[0]).toMatchObject({ label: 'X-RAY DIFFRACTION', count: 800 });
    expect(out.facets[0]?.buckets[0]?.children?.[0]).toMatchObject({
      dimension: 'release_year',
      buckets: [
        { label: '2020', count: 100 },
        { label: '2021', count: 120 },
      ],
    });
  });
});

describe('RcsbService.coordinateFileUrl', () => {
  it('builds an upper-cased download URL for the requested format', () => {
    expect(service().coordinateFileUrl('4hhb', 'cif')).toBe('https://files.test/download/4HHB.cif');
    expect(service().coordinateFileUrl('4hhb', 'bcif')).toBe(
      'https://files.test/download/4HHB.bcif',
    );
  });
});
