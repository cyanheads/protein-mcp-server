/**
 * @fileoverview Tests for the RCSB service GraphQL/REST methods exercised through
 * realistic upstream payloads (HTTP mocked): entry-metadata normalization, UniProt
 * xref resolution, sequence extraction, binding-site assembly with distance sort
 * and label/author residue numbering (per-instance chain pairing),
 * chem-comp normalization (SMILES/InChIKey fallback chain) with the 404 → null
 * branch, sequence/ligand/chem-comp search hit normalization (each sequence
 * hit's verbose match context and the query length, read from the sequence
 * service entry wherever it sits), the
 * `results_content_type` scope emitted on every search path, and the GraphQL
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

import { type FacetSpec, RcsbService } from '@/services/rcsb/rcsb-service.js';
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
      rcsbModelsBaseUrl: 'https://models.test',
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
        rcsb_polymer_entity_container_identifiers: {
          auth_asym_ids: ['A', 'C'],
          asym_ids: ['A', 'C'],
        },
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
      organisms: ['Homo sapiens'],
      authAsymIds: ['A', 'C'],
      labelAsymIds: ['A', 'C'],
      sequenceLength: 141,
    });
    expect(meta?.polymerEntities[0]).not.toHaveProperty('organism');
    expect(meta?.ligands).toEqual([
      { compId: 'HEM', name: 'PROTOPORPHYRIN IX CONTAINING FE', formula: 'C34 H32 Fe N4 O4' },
    ]);
  });

  it('leaves computedModelProvider unset for an experimental entry', async () => {
    fetchJsonMock.mockResolvedValue(gql({ entries: [ENTRY_4HHB] }));
    const [meta] = await service().getEntries(['4HHB'], createMockContext());
    expect(meta).not.toHaveProperty('computedModelProvider');
  });

  it('reads the modelling provider off a computed structure model', async () => {
    // RCSB serves AF_* / MA_* models from the same entry endpoint as PDB entries;
    // rcsb_comp_model_provenance is the only thing separating them.
    for (const [sourceDb, expected] of [
      ['AlphaFoldDB', 'AlphaFold DB'],
      ['ModelArchive', 'ModelArchive'],
      // An unrecognized provider is credited by its own name rather than dropped
      // (which would silently attribute the model to the PDB).
      ['SomeFutureModelDB', 'SomeFutureModelDB'],
    ] as const) {
      fetchJsonMock.mockResolvedValue(
        gql({
          entries: [
            {
              rcsb_id: 'AF_AFQ9Z1K5F1',
              struct: { title: 'Computed structure model of E3 ubiquitin-protein ligase ARIH1' },
              rcsb_comp_model_provenance: { source_db: sourceDb },
            },
          ],
        }),
      );
      const [meta] = await service().getEntries(['AF_AFQ9Z1K5F1'], createMockContext());
      expect(meta?.computedModelProvider).toBe(expected);
      // A computed model carries no experimental provenance to normalize.
      expect(meta?.methods).toBeUndefined();
      expect(meta?.resolution).toBeUndefined();
    }
  });

  it('keeps the two chain namespaces apart when they differ (6QNR_9)', async () => {
    // Live RCSB shape: no transformation relates label_asym_id to auth_asym_id,
    // so collapsing them to one field leaves a per-chain alignment unsetupable.
    fetchJsonMock.mockResolvedValue(
      gql({
        entries: [
          {
            rcsb_id: '6QNR',
            polymer_entities: [
              {
                rcsb_id: '6QNR_9',
                rcsb_polymer_entity_container_identifiers: {
                  auth_asym_ids: ['82', '8E'],
                  asym_ids: ['I', 'OB'],
                },
              },
            ],
          },
        ],
      }),
    );
    const [meta] = await service().getEntries(['6QNR'], createMockContext());
    expect(meta?.polymerEntities[0]).toEqual({
      entityId: '6QNR_9',
      authAsymIds: ['82', '8E'],
      labelAsymIds: ['I', 'OB'],
    });
  });

  it('omits both chain namespaces for an entity with no container identifiers', async () => {
    fetchJsonMock.mockResolvedValue(gql({ entries: [ENTRY_4HHB] }));
    const [meta] = await service().getEntries(['4HHB'], createMockContext());
    // 4HHB_2 in the fixture carries no container block — unknown data is omitted,
    // never emitted as an empty array.
    expect(meta?.polymerEntities[1]).not.toHaveProperty('authAsymIds');
    expect(meta?.polymerEntities[1]).not.toHaveProperty('labelAsymIds');
  });

  it('selects both chain-identifier fields in the entries query', async () => {
    fetchJsonMock.mockResolvedValue(gql({ entries: [] }));
    await service().getEntries(['4HHB'], createMockContext());
    const opts = fetchJsonMock.mock.calls[0]?.[2] as unknown as { body: string };
    const query = JSON.parse(opts.body).query as string;
    expect(query).toContain('auth_asym_ids');
    expect(query).toContain('asym_ids');
  });

  it('requests the computed-model provenance field', async () => {
    fetchJsonMock.mockResolvedValue(gql({ entries: [] }));
    await service().getEntries(['4HHB'], createMockContext());
    const opts = fetchJsonMock.mock.calls[0]?.[2] as unknown as { body: string };
    expect(JSON.parse(opts.body).query).toContain('rcsb_comp_model_provenance');
  });

  it('reads legacy-PDB-format compatibility and the provider entry ID (#61)', async () => {
    fetchJsonMock.mockResolvedValue(
      gql({
        entries: [
          { ...ENTRY_4HHB, pdbx_database_status: { pdb_format_compatible: 'Y' } },
          { rcsb_id: '4V6X', pdbx_database_status: { pdb_format_compatible: 'N' } },
          {
            rcsb_id: 'AF_AFP69905F1',
            pdbx_database_status: { pdb_format_compatible: null },
            rcsb_comp_model_provenance: { source_db: 'AlphaFoldDB', entry_id: 'AF-P69905-F1' },
          },
          {
            rcsb_id: 'MA_MAASFVASFVG001',
            pdbx_database_status: null,
            rcsb_comp_model_provenance: {
              source_db: 'ModelArchive',
              entry_id: 'ma-asfv-asfvg-001',
            },
          },
        ],
      }),
    );
    const [hhb, ribosome, af, ma] = await service().getEntries(
      ['4HHB', '4V6X', 'AF_AFP69905F1', 'MA_MAASFVASFVG001'],
      createMockContext(),
    );

    expect(hhb?.pdbFormatCompatible).toBe(true);
    expect(hhb).not.toHaveProperty('computedModelEntryId');
    expect(ribosome?.pdbFormatCompatible).toBe(false);
    // Computed models report no compatibility value — unknown stays absent.
    expect(af).not.toHaveProperty('pdbFormatCompatible');
    expect(af).toMatchObject({
      computedModelProvider: 'AlphaFold DB',
      computedModelEntryId: 'AF-P69905-F1',
    });
    expect(ma).not.toHaveProperty('pdbFormatCompatible');
    expect(ma).toMatchObject({
      computedModelProvider: 'ModelArchive',
      computedModelEntryId: 'ma-asfv-asfvg-001',
    });
  });

  it('requests the format-compatibility flag and provenance entry ID (#61)', async () => {
    fetchJsonMock.mockResolvedValue(gql({ entries: [] }));
    await service().getEntries(['4HHB'], createMockContext());
    const opts = fetchJsonMock.mock.calls[0]?.[2] as unknown as { body: string };
    const query = JSON.parse(opts.body).query as string;
    expect(query).toContain('pdbx_database_status { pdb_format_compatible }');
    expect(query).toContain('rcsb_comp_model_provenance { source_db entry_id }');
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
      data: { retryable: false },
    });
  });

  it('throws when GraphQL returns partial data alongside a non-empty errors array (#48)', async () => {
    // A field-level upstream failure leaves `data` populated but incomplete.
    // Returning it would be indistinguishable from a genuinely sparse record.
    fetchJsonMock.mockResolvedValue({
      data: { entries: [{ rcsb_id: '4HHB' }] },
      errors: [{ message: 'upstream field failed' }],
    });
    await expect(service().getEntries(['4HHB'], createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: expect.stringContaining('upstream field failed'),
      data: { retryable: false },
    });
  });

  it('resolves normally when an empty errors array accompanies data (#48)', async () => {
    fetchJsonMock.mockResolvedValue({ data: { entries: [ENTRY_4HHB] }, errors: [] });
    const [meta] = await service().getEntries(['4HHB'], createMockContext());
    expect(meta).toMatchObject({ id: '4HHB', resolution: 1.74 });
  });

  /**
   * Live 6M0J (SARS-CoV-2 RBD bound to ACE2), trimmed to the queried fields, in
   * entity-number order. RCSB returns its entity arrays in an order fixed per
   * upstream connection and varying between connections, so the reversed copy
   * below is a shape the live API really serves.
   */
  const ENTRY_6M0J = {
    rcsb_id: '6M0J',
    struct: {
      title: 'Crystal structure of SARS-CoV-2 spike receptor-binding domain bound with ACE2',
    },
    exptl: [{ method: 'X-RAY DIFFRACTION' }],
    rcsb_entry_info: { resolution_combined: [2.45], molecular_weight: 97.14 },
    polymer_entities: [
      {
        rcsb_id: '6M0J_1',
        rcsb_polymer_entity: { pdbx_description: 'Angiotensin-converting enzyme 2' },
        rcsb_polymer_entity_container_identifiers: { auth_asym_ids: ['A'], asym_ids: ['A'] },
        rcsb_entity_source_organism: [{ ncbi_scientific_name: 'Homo sapiens' }],
      },
      {
        rcsb_id: '6M0J_2',
        rcsb_polymer_entity: { pdbx_description: 'Spike protein S1' },
        rcsb_polymer_entity_container_identifiers: { auth_asym_ids: ['E'], asym_ids: ['B'] },
        rcsb_entity_source_organism: [
          { ncbi_scientific_name: 'Severe acute respiratory syndrome coronavirus 2' },
        ],
      },
    ],
    nonpolymer_entities: [
      {
        rcsb_id: '6M0J_3',
        rcsb_nonpolymer_entity_container_identifiers: {
          nonpolymer_comp_id: 'ZN',
          auth_asym_ids: ['A'],
        },
        nonpolymer_comp: { chem_comp: { name: 'ZINC ION', formula: 'Zn' } },
      },
      {
        rcsb_id: '6M0J_4',
        rcsb_nonpolymer_entity_container_identifiers: {
          nonpolymer_comp_id: 'CL',
          auth_asym_ids: ['A'],
        },
        nonpolymer_comp: { chem_comp: { name: 'CHLORIDE ION', formula: 'Cl' } },
      },
      {
        rcsb_id: '6M0J_5',
        rcsb_nonpolymer_entity_container_identifiers: {
          nonpolymer_comp_id: 'NAG',
          auth_asym_ids: ['A', 'E'],
        },
        nonpolymer_comp: {
          chem_comp: { name: '2-acetamido-2-deoxy-beta-D-glucopyranose', formula: 'C8 H15 N O6' },
        },
      },
    ],
  };

  const reversedEntities = (entry: typeof ENTRY_6M0J) => ({
    ...entry,
    polymer_entities: entry.polymer_entities.toReversed(),
    nonpolymer_entities: entry.nonpolymer_entities.toReversed(),
  });

  it('orders polymer entities and ligands by entity number whatever order upstream serves (6M0J, #85)', async () => {
    fetchJsonMock.mockResolvedValueOnce(gql({ entries: [ENTRY_6M0J] }));
    fetchJsonMock.mockResolvedValueOnce(gql({ entries: [reversedEntities(ENTRY_6M0J)] }));
    const forward = await service().getEntries(['6M0J'], createMockContext());
    const reversed = await service().getEntries(['6M0J'], createMockContext());

    expect(reversed).toEqual(forward);
    const [meta] = reversed;
    expect(meta?.polymerEntities.map((e) => e.entityId)).toEqual(['6M0J_1', '6M0J_2']);
    expect(meta?.ligands.map((l) => l.compId)).toEqual(['ZN', 'CL', 'NAG']);
    expect(meta?.organisms).toEqual([
      'Homo sapiens',
      'Severe acute respiratory syndrome coronavirus 2',
    ]);
    expect(meta?.polymerEntities[1]?.organisms).toEqual([
      'Severe acute respiratory syndrome coronavirus 2',
    ]);
  });

  it('puts entity _10 after _9 and an unnumbered entity last, without throwing (#85)', async () => {
    fetchJsonMock.mockResolvedValue(
      gql({
        entries: [
          {
            rcsb_id: '1ABC',
            polymer_entities: [
              { rcsb_id: '1ABC_10', rcsb_polymer_entity: { pdbx_description: 'ten' } },
              { rcsb_polymer_entity: { pdbx_description: 'unnumbered' } },
              { rcsb_id: '1ABC_9', rcsb_polymer_entity: { pdbx_description: 'nine' } },
              { rcsb_id: '1ABC_2', rcsb_polymer_entity: { pdbx_description: 'two' } },
            ],
            nonpolymer_entities: [
              {
                rcsb_id: '1ABC_12',
                rcsb_nonpolymer_entity_container_identifiers: { nonpolymer_comp_id: 'SO4' },
              },
              { rcsb_nonpolymer_entity_container_identifiers: { nonpolymer_comp_id: 'GOL' } },
              {
                rcsb_id: '1ABC_11',
                rcsb_nonpolymer_entity_container_identifiers: { nonpolymer_comp_id: 'HEM' },
              },
            ],
          },
        ],
      }),
    );
    const [meta] = await service().getEntries(['1ABC'], createMockContext());
    expect(meta?.polymerEntities.map((e) => e.description)).toEqual([
      'two',
      'nine',
      'ten',
      'unnumbered',
    ]);
    expect(meta?.ligands.map((l) => l.compId)).toEqual(['HEM', 'SO4', 'GOL']);
  });

  it('keeps every distinct source organism of a chimeric entity (2RH1, #85)', async () => {
    // Live 2RH1_1, the beta-2 adrenergic receptor with T4 lysozyme fused into a
    // loop: three source segments, two of them human.
    fetchJsonMock.mockResolvedValue(
      gql({
        entries: [
          {
            rcsb_id: '2RH1',
            polymer_entities: [
              {
                rcsb_id: '2RH1_1',
                rcsb_polymer_entity: {
                  pdbx_description: 'beta-2-adrenergic receptor/T4-lysozyme chimera',
                },
                rcsb_entity_source_organism: [
                  { ncbi_scientific_name: 'Homo sapiens' },
                  { ncbi_scientific_name: 'Homo sapiens' },
                  { ncbi_scientific_name: 'Tequatrovirus T4' },
                  {}, // an unnamed source contributes nothing
                ],
              },
            ],
          },
        ],
      }),
    );
    const [meta] = await service().getEntries(['2RH1'], createMockContext());
    expect(meta?.polymerEntities[0]?.organisms).toEqual(['Homo sapiens', 'Tequatrovirus T4']);
    expect(meta?.organisms).toEqual(['Homo sapiens', 'Tequatrovirus T4']);
  });

  it('collects entry organisms across entities in entity-number order, deduped (#85)', async () => {
    fetchJsonMock.mockResolvedValue(
      gql({
        entries: [
          {
            rcsb_id: '7BZ5',
            polymer_entities: [
              {
                rcsb_id: '7BZ5_3',
                rcsb_entity_source_organism: [{ ncbi_scientific_name: 'Homo sapiens' }],
              },
              {
                rcsb_id: '7BZ5_2',
                rcsb_entity_source_organism: [{ ncbi_scientific_name: 'Homo sapiens' }],
              },
              {
                rcsb_id: '7BZ5_1',
                rcsb_entity_source_organism: [
                  { ncbi_scientific_name: 'Severe acute respiratory syndrome coronavirus 2' },
                ],
              },
            ],
          },
        ],
      }),
    );
    const [meta] = await service().getEntries(['7BZ5'], createMockContext());
    expect(meta?.organisms).toEqual([
      'Severe acute respiratory syndrome coronavirus 2',
      'Homo sapiens',
    ]);
  });

  it('omits organisms on an entity whose sources name none (#85)', async () => {
    fetchJsonMock.mockResolvedValue(
      gql({
        entries: [
          {
            rcsb_id: '1AOI',
            polymer_entities: [{ rcsb_id: '1AOI_1', rcsb_entity_source_organism: [] }],
          },
        ],
      }),
    );
    const [meta] = await service().getEntries(['1AOI'], createMockContext());
    expect(meta?.polymerEntities[0]).toEqual({ entityId: '1AOI_1' });
    expect(meta?.organisms).toEqual([]);
  });

  it("carries each ligand's author chains when upstream reports them (#92)", async () => {
    fetchJsonMock.mockResolvedValue(gql({ entries: [ENTRY_6M0J, ENTRY_4HHB] }));
    const [m6, m4] = await service().getEntries(['6M0J', '4HHB'], createMockContext());
    expect(m6?.ligands.find((l) => l.compId === 'NAG')?.authAsymIds).toEqual(['A', 'E']);
    // 4HHB's HEM fixture carries no author chains: unknown stays absent.
    expect(m4?.ligands[0]).not.toHaveProperty('authAsymIds');
  });

  it('selects entity numbers on both entity arrays and ligand author chains (#85, #92)', async () => {
    fetchJsonMock.mockResolvedValue(gql({ entries: [] }));
    await service().getEntries(['6M0J'], createMockContext());
    const opts = fetchJsonMock.mock.calls[0]?.[2] as unknown as { body: string };
    const query = JSON.parse(opts.body).query as string;
    expect(query).toMatch(/(?<!non)polymer_entities\s*\{\s*rcsb_id\b/);
    expect(query).toMatch(/nonpolymer_entities\s*\{\s*rcsb_id\b/);
    expect(query).toContain(
      'rcsb_nonpolymer_entity_container_identifiers { nonpolymer_comp_id auth_asym_ids }',
    );
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

  /** Live 1AOI (nucleosome core particle) xref shape: a DNA entity, then four histones. */
  const XREF_1AOI = [
    { rcsb_id: '1AOI_1', chains: ['I', 'J'], accession: undefined },
    { rcsb_id: '1AOI_2', chains: ['A', 'E'], accession: 'P84233' },
    { rcsb_id: '1AOI_3', chains: ['B', 'F'], accession: 'P62799' },
    { rcsb_id: '1AOI_4', chains: ['C', 'G'], accession: 'P06897' },
    { rcsb_id: '1AOI_5', chains: ['D', 'H'], accession: 'P02281' },
  ].map(({ rcsb_id, chains, accession }) => ({
    rcsb_id,
    rcsb_polymer_entity_container_identifiers: {
      auth_asym_ids: chains,
      reference_sequence_identifiers: accession
        ? [{ database_name: 'UniProt', database_accession: accession }]
        : [],
    },
  }));

  it('returns entities in entity-number order whatever order upstream serves (1AOI, #85)', async () => {
    // Upstream served 1AOI as 5,4,3,2,1 on four of six fresh connections.
    for (const polymer_entities of [XREF_1AOI, XREF_1AOI.toReversed()]) {
      fetchJsonMock.mockResolvedValueOnce(gql({ entry: { polymer_entities } }));
      const out = await service().resolveUniprotEntities('1AOI', createMockContext());
      expect(out.map((e) => e.accession)).toEqual(['P84233', 'P62799', 'P06897', 'P02281']);
      expect(out.flatMap((e) => e.chains)).toEqual(['A', 'E', 'B', 'F', 'C', 'G', 'D', 'H']);
    }
  });

  it('selects the entity number in the xref query (#85)', async () => {
    fetchJsonMock.mockResolvedValue(gql({ entry: null }));
    await service().resolveUniprotEntities('1AOI', createMockContext());
    const opts = fetchJsonMock.mock.calls[0]?.[2] as unknown as { body: string };
    expect(JSON.parse(opts.body).query).toMatch(/polymer_entities\s*\{\s*rcsb_id\b/);
  });

  it('fails rather than reporting a partial xref set when errors accompany data (#48)', async () => {
    // The same precedence fix covers every consumer of the shared GraphQL helper:
    // a dropped sub-selection must not read as "this entry has no UniProt xref".
    fetchJsonMock.mockResolvedValue({
      data: { entry: { polymer_entities: [] } },
      errors: [{ message: 'reference_sequence_identifiers unavailable' }],
    });
    await expect(
      service().resolveUniprotEntities('4HHB', createMockContext()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: expect.stringContaining('reference_sequence_identifiers unavailable'),
    });
  });
});

describe('RcsbService.getSequence', () => {
  /** One polymer entity as the Sequence query selects it. */
  const poly = (rcsb_id: string, type: string, chains: string[], sequence: string) => ({
    rcsb_id,
    entity_poly: { rcsb_entity_polymer_type: type, pdbx_seq_one_letter_code_can: sequence },
    rcsb_polymer_entity_container_identifiers: { auth_asym_ids: chains },
  });

  /** Real polymer entities (2026-11-03), in the order one upstream connection served them. */
  const ENTRIES: Record<string, ReturnType<typeof poly>[]> = {
    '1AOI': [
      poly(
        '1AOI_1',
        'DNA',
        ['I', 'J'],
        'ATCAATATCCACCTGCAGATTCTACCAAAAGTGTATTTGGAAACTGCTCCATCAAAAGGCATGTTCAGCTGAATTCAGCTGAACATGCCTTTTGATGGAGCAGTTTCCAAATACACTTTTGGTAGAATCTGCAGGTGGATATTGAT',
      ),
      poly(
        '1AOI_2',
        'Protein',
        ['A', 'E'],
        'LATKAARKSAPATGGVKKPHRYRPGTVALREIRRYQKSTELLIRKLPFQRLVREIAQDFKTDLRFQSSAVMALQEASEAYLVALFEDTNLCAIHAKRVTIMPKDIQLARRIRGERA',
      ),
      poly(
        '1AOI_3',
        'Protein',
        ['B', 'F'],
        'KRHRKVLRDNIQGITKPAIRRLARRGGVKRISGLIYEETRGVLKVFLENVIRDAVTYTEHAKRKTVTAMDVVYALKRQGRTLYGFGG',
      ),
      poly(
        '1AOI_4',
        'Protein',
        ['C', 'G'],
        'GKQGGKTRAKAKTRSSRAGLQFPVGRVHRLLRKGNYAERVGAGAPVYLAAVLEYLTAEILELAGNAARDNKKTRIIPRHLQLAVRNDEELNKLLGRVTIAQGGVLPNIQSVLLPKK',
      ),
      poly(
        '1AOI_5',
        'Protein',
        ['D', 'H'],
        'KKRRKTRKESYAIYVYKVLKQVHPDTGISSKAMSIMNSFVNDVFERIAGEASRLAHYNKRSTITSREIQTAVRLLLPGELAKHAVSEGTKAVTKYTSAK',
      ),
    ],
    '1TSR': [
      poly(
        '1TSR_3',
        'Protein',
        ['A', 'B', 'C'],
        'SSSVPSQKTYQGSYGFRLGFLHSGTAKSVTCTYSPALNKMFCQLAKTCPVQLWVDSTPPPGTRVRAMAIYKQSQHMTEVVRRCPHHERCSDSDGLAPPQHLIRVEGNLRVEYLDDRNTFRHSVVVPYEPPEVGSDCTTIHYNYMCNSSCMGGMNRRPILTIITLEDSSGNLLGRNSFEVRVCACPGRDRRTEEENLRKKGEPHHELPPGSTKRALPNNT',
      ),
      poly('1TSR_2', 'DNA', ['F'], 'ATAATTGGGCAAGTCTAGGAA'),
      poly('1TSR_1', 'DNA', ['E'], 'TTTCCTAGACTTGCCCAATTA'),
    ],
    '1CDW': [
      poly(
        '1CDW_3',
        'Protein',
        ['A'],
        'SGIVPQLQNIVSTVNLGCKLDLKTIALRARNAEYNPKRFAAVIMRIREPRTTALIFSSGKMVCTGAKSEENSRLAARKYARVVQKLGFPAKFLDFKIQNMVGSCDVKFPIRLEGLVLTHQQFSSYEPELFPGLIYRMIKPRIVLLIFVSGKVVLTGAKVRAEIYEAFENIYPILKGFRK',
      ),
      poly('1CDW_2', 'DNA', ['C'], 'CAGCCTTTTATAGCAG'),
      poly('1CDW_1', 'DNA', ['B'], 'CTGCTATAAAAGGCTG'),
    ],
    '1BNA': [poly('1BNA_1', 'DNA', ['A', 'B'], 'CGCGAATTCGCG')],
    '4HHB': [
      poly(
        '4HHB_2',
        'Protein',
        ['B', 'D'],
        'VHLTPEEKSAVTALWGKVNVDEVGGEALGRLLVVYPWTQRFFESFGDLSTPDAVMGNPKVKAHGKKVLGAFSDGLAHLDNLKGTFATLSELHCDKLHVDPENFRLLGNVLVCVLAHHFGKEFTPPVQAAYQKVVAGVANALAHKYH',
      ),
      poly(
        '4HHB_1',
        'Protein',
        ['A', 'C'],
        'VLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTTKTYFPHFDLSHGSAQVKGHGKKVADALTNAVAHVDDMPNALSALSDLHAHKLRVDPVNFKLLSHCLLVTLAAHLPAEFTPAVHASLDKFLASVSTVLTSKYR',
      ),
    ],
    // 8AVR_2 is a polypeptide(D), which RCSB types as Protein too.
    '8AVR': [
      poly('8AVR_2', 'Protein', ['B', 'D'], 'MSWLNFLKYIAKYGKKAVSAAWKYKGKVLEWLNVGPTLEWVWQKLKKIAGL'),
      poly('8AVR_1', 'Protein', ['A', 'C'], 'MSWLNFLKYIAKYGKKAVSAAWKYKGKVLEWLNVGPTLEWVWQKLKKIAGL'),
    ],
    '1A5H': [
      poly(
        '1A5H_2',
        'Protein',
        ['A', 'B'],
        'IKGGLFADIASHPWQAAIFAKHRRSPGERFLCGGILISSCWILSAAHCFQERFPPHHLTVILGRTYRVVPGEEEQKFEVEKYIVHKEFDDDTYDNDIALLQLKSDSSRCAQESSVVRTVCLPPADLQLPDWTECELSGYGKHEALSPFYSERLKEAHVRLYPSSRCTSQHLLNRTVTDNMLCAGDTRSGGPQANLHDACQGDSGGPLVCLNDGRMTLVGIISWGLGCGQKDVPGVYTKVTNYLDWIRDNMRP',
      ),
      poly('1A5H_1', 'Protein', ['C', 'D'], 'TCGLRQY'),
    ],
    '1A3I': [
      poly('1A3I_2', 'Protein', ['B', 'C'], 'PPGPPG'),
      poly('1A3I_1', 'Protein', ['A'], 'PPGPPGPPG'),
    ],
  };

  const sequenceOf = (entityId: string) =>
    Object.values(ENTRIES)
      .flat()
      .find((e) => e.rcsb_id === entityId)?.entity_poly.pdbx_seq_one_letter_code_can;

  /** Look an entry up once with its entities in the captured order and once reversed. */
  const bothOrders = async (pdbId: string, chain?: string) => {
    const results = [];
    for (const polymer_entities of [ENTRIES[pdbId], ENTRIES[pdbId]?.toReversed()]) {
      fetchJsonMock.mockResolvedValueOnce(gql({ entry: { polymer_entities } }));
      results.push(await service().getSequence(pdbId, chain, createMockContext()));
    }
    const [first, second] = results;
    if (!first) throw new Error(`no lookup result for ${pdbId}`);
    expect(second).toEqual(first);
    return first;
  };

  it.each([
    [
      '1AOI',
      { entityId: '1AOI_2', chains: ['A', 'E'], length: 116 },
      [
        { entityId: '1AOI_3', chains: ['B', 'F'], length: 87 },
        { entityId: '1AOI_4', chains: ['C', 'G'], length: 116 },
        { entityId: '1AOI_5', chains: ['D', 'H'], length: 99 },
      ],
    ],
    ['1TSR', { entityId: '1TSR_3', chains: ['A', 'B', 'C'], length: 219 }, []],
    ['1CDW', { entityId: '1CDW_3', chains: ['A'], length: 179 }, []],
    [
      '4HHB',
      { entityId: '4HHB_1', chains: ['A', 'C'], length: 141 },
      [{ entityId: '4HHB_2', chains: ['B', 'D'], length: 146 }],
    ],
  ])(
    'searches %s’s lowest-numbered protein entity, never a DNA one, whatever the upstream order (#84)',
    async (pdbId, entity, otherEntities) => {
      expect(await bothOrders(pdbId)).toEqual({
        kind: 'found',
        entity,
        sequence: sequenceOf(entity.entityId),
        otherEntities,
      });
    },
  );

  it('skips a sub-10-residue protein entity by default (#84)', async () => {
    expect(await bothOrders('1A5H')).toEqual({
      kind: 'found',
      entity: { entityId: '1A5H_2', chains: ['A', 'B'], length: 252 },
      sequence: sequenceOf('1A5H_2'),
      otherEntities: [{ entityId: '1A5H_1', chains: ['C', 'D'], length: 7 }],
    });
  });

  it('falls back to the lowest-numbered protein entity when every one is under 10 residues (#84)', async () => {
    expect(await bothOrders('1A3I')).toEqual({
      kind: 'found',
      entity: { entityId: '1A3I_1', chains: ['A'], length: 9 },
      sequence: 'PPGPPGPPG',
      otherEntities: [{ entityId: '1A3I_2', chains: ['B', 'C'], length: 6 }],
    });
  });

  it('takes a protein entity of exactly 10 residues by default, RCSB’s sequence-search minimum (#84)', async () => {
    const tenMer = poly('9TEN_1', 'Protein', ['P'], 'ACDEFGHIKL');
    const longer = poly('9TEN_2', 'Protein', ['A'], 'MVLSPADKTNVKAAWGKVGAHAGEYG');
    for (const polymer_entities of [
      [tenMer, longer],
      [longer, tenMer],
    ]) {
      fetchJsonMock.mockResolvedValueOnce(gql({ entry: { polymer_entities } }));
      expect(await service().getSequence('9TEN', undefined, createMockContext())).toMatchObject({
        kind: 'found',
        entity: { entityId: '9TEN_1', chains: ['P'], length: 10 },
        sequence: 'ACDEFGHIKL',
      });
    }
  });

  it.each([
    ['4HHB', 'A', '4HHB_1'],
    ['4HHB', 'B', '4HHB_2'],
    ['4HHB', 'D', '4HHB_2'],
    ['8AVR', 'B', '8AVR_2'],
    ['1A5H', 'C', '1A5H_1'],
  ])(
    'selects the protein entity of %s covering author chain %s (#84)',
    async (pdbId, chain, entityId) => {
      const out = await bothOrders(pdbId, chain);
      expect(out).toMatchObject({
        kind: 'found',
        entity: { entityId },
        sequence: sequenceOf(entityId),
      });
      // Every other protein entity is listed, the selected one never.
      const others = out.kind === 'found' ? out.otherEntities.map((e) => e.entityId) : [];
      expect(others).toHaveLength((ENTRIES[pdbId] ?? []).length - 1);
      expect(others).not.toContain(entityId);
    },
  );

  it.each([
    [
      '4HHB',
      'b',
      [
        { entityId: '4HHB_1', chains: ['A', 'C'], length: 141 },
        { entityId: '4HHB_2', chains: ['B', 'D'], length: 146 },
      ],
    ],
    // E is one of 1TSR's DNA strands.
    ['1TSR', 'E', [{ entityId: '1TSR_3', chains: ['A', 'B', 'C'], length: 219 }]],
    ['1TSR', 'Z', [{ entityId: '1TSR_3', chains: ['A', 'B', 'C'], length: 219 }]],
  ])(
    'reports chain_not_found for %s chain %j, listing the protein entities in entity order (#84)',
    async (pdbId, chain, proteinEntities) => {
      expect(await bothOrders(pdbId, chain)).toEqual({ kind: 'chain_not_found', proteinEntities });
    },
  );

  it('reports no_protein for an entry of nucleic-acid entities only, with or without a chain (#84)', async () => {
    expect(await bothOrders('1BNA')).toEqual({ kind: 'no_protein' });
    expect(await bothOrders('1BNA', 'A')).toEqual({ kind: 'no_protein' });
  });

  it('treats a protein entity without a canonical sequence as absent', async () => {
    fetchJsonMock.mockResolvedValue(
      gql({
        entry: {
          polymer_entities: [
            { rcsb_id: '9XYZ_1', entity_poly: { rcsb_entity_polymer_type: 'Protein' } },
          ],
        },
      }),
    );
    expect(await service().getSequence('9XYZ', undefined, createMockContext())).toEqual({
      kind: 'no_protein',
    });
  });

  it('reports entry_not_found when RCSB has no such entry', async () => {
    fetchJsonMock.mockResolvedValue(gql({ entry: null }));
    expect(await service().getSequence('9ZZZ', undefined, createMockContext())).toEqual({
      kind: 'entry_not_found',
    });
  });

  it('strips whitespace from the canonical sequence and counts residues after it', async () => {
    fetchJsonMock.mockResolvedValue(
      gql({ entry: { polymer_entities: [poly('4HHB_1', 'Protein', ['A'], 'VLS\nPAD KTNV')] } }),
    );
    expect(await service().getSequence('4HHB', undefined, createMockContext())).toEqual({
      kind: 'found',
      entity: { entityId: '4HHB_1', chains: ['A'], length: 10 },
      sequence: 'VLSPADKTNV',
      otherEntities: [],
    });
  });

  it('asks GraphQL for each entity’s polymer type and author chains under the upper-cased ID (#84)', async () => {
    fetchJsonMock.mockResolvedValue(gql({ entry: { polymer_entities: ENTRIES['4HHB'] } }));
    await service().getSequence('4hhb', undefined, createMockContext());
    const body = JSON.parse(String(fetchJsonMock.mock.calls[0]?.[2]?.body)) as {
      query: string;
      variables: unknown;
    };
    expect(body.variables).toEqual({ id: '4HHB' });
    expect(body.query).toContain('rcsb_entity_polymer_type');
    expect(body.query).toContain('auth_asym_ids');
    expect(body.query).toContain('pdbx_seq_one_letter_code_can');
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

  /**
   * Live 1IEP binding-site payload, trimmed to the STI instance in chain A and
   * three of its 23 contacts. Label and author chain IDs coincide here; the
   * residue numbering does not (label THR93 is author THR315).
   */
  const BINDING_1IEP = {
    entry: {
      polymer_entities: [
        {
          polymer_entity_instances: [
            {
              rcsb_polymer_entity_instance_container_identifiers: {
                asym_id: 'A',
                auth_asym_id: 'A',
              },
            },
            {
              rcsb_polymer_entity_instance_container_identifiers: {
                asym_id: 'B',
                auth_asym_id: 'B',
              },
            },
          ],
        },
      ],
      nonpolymer_entities: [
        {
          rcsb_nonpolymer_entity_container_identifiers: { nonpolymer_comp_id: 'STI' },
          nonpolymer_entity_instances: [
            {
              rcsb_nonpolymer_entity_instance_container_identifiers: {
                asym_id: 'G',
                auth_asym_id: 'A',
                auth_seq_id: '201',
              },
              rcsb_target_neighbors: [
                {
                  target_asym_id: 'A',
                  target_comp_id: 'THR',
                  target_seq_id: 93,
                  target_auth_seq_id: 315,
                  distance: 2.883,
                },
                {
                  target_asym_id: 'A',
                  target_comp_id: 'ILE',
                  target_seq_id: 138,
                  target_auth_seq_id: 360,
                  distance: 2.668,
                },
                {
                  target_asym_id: 'A',
                  target_comp_id: 'MET',
                  target_seq_id: 96,
                  target_auth_seq_id: 318,
                  distance: 2.899,
                },
              ],
            },
          ],
        },
      ],
    },
  };

  it('carries author residue numbering beside the label numbering (1IEP STI, #69)', async () => {
    fetchJsonMock.mockResolvedValue(gql(BINDING_1IEP));
    const [site] = await service().getBindingSites('1IEP', 'STI', createMockContext());

    expect(site).toMatchObject({ ligandCompId: 'STI', ligandAsymId: 'A', ligandAuthSeqId: 201 });
    expect(site?.residues).toEqual([
      {
        residueCompId: 'ILE',
        asymId: 'A',
        seqId: 138,
        authAsymId: 'A',
        authSeqId: 360,
        distance: 2.668,
      },
      {
        residueCompId: 'THR',
        asymId: 'A',
        seqId: 93,
        authAsymId: 'A',
        authSeqId: 315,
        distance: 2.883,
      },
      {
        residueCompId: 'MET',
        asymId: 'A',
        seqId: 96,
        authAsymId: 'A',
        authSeqId: 318,
        distance: 2.899,
      },
    ]);
  });

  it('maps a divergent label chain to its author chain per instance, not by container-array index (6QNR, #69)', async () => {
    // Live 6QNR: entity 9's container arrays are each sorted on their own —
    // asym_ids ["I","OB"], auth_asym_ids ["82","8E"] — so pairing them by index
    // would map label I to author 82. The per-instance identifiers say I is 8E.
    fetchJsonMock.mockResolvedValue(
      gql({
        entry: {
          polymer_entities: [
            {
              rcsb_polymer_entity_container_identifiers: {
                asym_ids: ['I', 'OB'],
                auth_asym_ids: ['82', '8E'],
              },
              polymer_entity_instances: [
                {
                  rcsb_polymer_entity_instance_container_identifiers: {
                    asym_id: 'I',
                    auth_asym_id: '8E',
                  },
                },
                {
                  rcsb_polymer_entity_instance_container_identifiers: {
                    asym_id: 'OB',
                    auth_asym_id: '82',
                  },
                },
              ],
            },
            {
              polymer_entity_instances: [
                {
                  rcsb_polymer_entity_instance_container_identifiers: {
                    asym_id: 'A',
                    auth_asym_id: '13',
                  },
                },
                {
                  rcsb_polymer_entity_instance_container_identifiers: {
                    asym_id: 'GB',
                    auth_asym_id: '1G',
                  },
                },
              ],
            },
          ],
          nonpolymer_entities: [
            {
              rcsb_nonpolymer_entity_container_identifiers: { nonpolymer_comp_id: 'MG' },
              nonpolymer_entity_instances: [
                {
                  rcsb_nonpolymer_entity_instance_container_identifiers: {
                    asym_id: 'SG',
                    auth_asym_id: '13',
                    auth_seq_id: '1687',
                  },
                  rcsb_target_neighbors: [
                    {
                      target_asym_id: 'A',
                      target_comp_id: 'G',
                      target_seq_id: 1353,
                      target_auth_seq_id: 1370,
                      distance: 2.627,
                    },
                    {
                      target_asym_id: 'I',
                      target_comp_id: 'VAL',
                      target_seq_id: 109,
                      target_auth_seq_id: 109,
                      distance: 4.124,
                    },
                  ],
                },
              ],
            },
          ],
        },
      }),
    );
    const [site] = await service().getBindingSites('6QNR', 'MG', createMockContext());

    expect(site).toMatchObject({ ligandAsymId: '13', ligandAuthSeqId: 1687 });
    expect(site?.residues).toEqual([
      {
        residueCompId: 'G',
        asymId: 'A',
        seqId: 1353,
        authAsymId: '13',
        authSeqId: 1370,
        distance: 2.627,
      },
      {
        residueCompId: 'VAL',
        asymId: 'I',
        seqId: 109,
        authAsymId: '8E',
        authSeqId: 109,
        distance: 4.124,
      },
    ]);
  });

  it('omits author identifiers upstream does not report instead of guessing them (#69)', async () => {
    fetchJsonMock.mockResolvedValue(
      gql({
        entry: {
          polymer_entities: [
            {
              polymer_entity_instances: [
                {
                  rcsb_polymer_entity_instance_container_identifiers: {
                    asym_id: 'A',
                    auth_asym_id: 'A',
                  },
                },
              ],
            },
          ],
          nonpolymer_entities: [
            {
              rcsb_nonpolymer_entity_container_identifiers: { nonpolymer_comp_id: 'HEM' },
              nonpolymer_entity_instances: [
                {
                  rcsb_nonpolymer_entity_instance_container_identifiers: { auth_asym_id: 'A' },
                  rcsb_target_neighbors: [
                    // Label chain Z has no polymer instance in the payload; no author seq either.
                    {
                      target_asym_id: 'Z',
                      target_comp_id: 'HIS',
                      target_seq_id: 87,
                      distance: 2.1,
                    },
                  ],
                },
              ],
            },
          ],
        },
      }),
    );
    const [site] = await service().getBindingSites('4HHB', undefined, createMockContext());
    expect(site).not.toHaveProperty('ligandAuthSeqId');
    expect(site?.residues[0]).toEqual({
      residueCompId: 'HIS',
      asymId: 'Z',
      seqId: 87,
      distance: 2.1,
    });
  });

  it('selects the author numbering and per-instance chain pairs in the binding-site query (#69)', async () => {
    fetchJsonMock.mockResolvedValue(gql({ entry: null }));
    await service().getBindingSites('1IEP', undefined, createMockContext());
    const opts = fetchJsonMock.mock.calls[0]?.[2] as unknown as { body: string };
    const query = JSON.parse(opts.body).query as string;
    expect(query).toContain('target_auth_seq_id');
    expect(query).toContain('auth_seq_id');
    expect(query).toMatch(
      /polymer_entity_instances\s*\{\s*rcsb_polymer_entity_instance_container_identifiers\s*\{\s*asym_id\s+auth_asym_id\s*\}/,
    );
  });

  it('selects the ligand entity number in the binding-site query (#85)', async () => {
    fetchJsonMock.mockResolvedValue(gql({ entry: null }));
    await service().getBindingSites('6M0J', undefined, createMockContext());
    const opts = fetchJsonMock.mock.calls[0]?.[2] as unknown as { body: string };
    expect(JSON.parse(opts.body).query).toMatch(/nonpolymer_entities\s*\{\s*rcsb_id\b/);
  });

  /** One ligand instance with a single pocket contact, as the 6M0J payload carries them. */
  const instance = (chain: string, seq: string) => ({
    rcsb_nonpolymer_entity_instance_container_identifiers: {
      auth_asym_id: chain,
      auth_seq_id: seq,
    },
    rcsb_target_neighbors: [{ target_comp_id: 'ASN', target_asym_id: chain, distance: 1.4 }],
  });

  /**
   * Live 6M0J binding-site shape: three ligand entities (ZN 6M0J_3, CL 6M0J_4,
   * NAG 6M0J_5) holding seven instances. Upstream served the entities as
   * ZN,CL,NAG or CL,NAG,ZN and NAG's instances by chain A,A,A,A,E or A,A,E,A,A.
   */
  const NONPOLY_6M0J = [
    {
      rcsb_id: '6M0J_3',
      rcsb_nonpolymer_entity_container_identifiers: { nonpolymer_comp_id: 'ZN' },
      nonpolymer_entity_instances: [instance('A', '901')],
    },
    {
      rcsb_id: '6M0J_4',
      rcsb_nonpolymer_entity_container_identifiers: { nonpolymer_comp_id: 'CL' },
      nonpolymer_entity_instances: [instance('A', '902')],
    },
    {
      rcsb_id: '6M0J_5',
      rcsb_nonpolymer_entity_container_identifiers: { nonpolymer_comp_id: 'NAG' },
      nonpolymer_entity_instances: [
        instance('A', '903'),
        instance('A', '904'),
        instance('A', '905'),
        instance('A', '906'),
        instance('E', '601'),
      ],
    },
  ];

  const sitesFor = async (nonpolymer_entities: unknown[]) => {
    fetchJsonMock.mockResolvedValueOnce(gql({ entry: { nonpolymer_entities } }));
    return service().getBindingSites('6M0J', undefined, createMockContext());
  };

  it('orders sites by ligand entity number, then author chain and residue, whatever order upstream serves (6M0J, #85)', async () => {
    const forward = await sitesFor(NONPOLY_6M0J);
    const reversed = await sitesFor(
      NONPOLY_6M0J.toReversed().map((e) => ({
        ...e,
        nonpolymer_entity_instances: e.nonpolymer_entity_instances.toReversed(),
      })),
    );
    const [zn, cl, nag] = NONPOLY_6M0J;
    const shuffled = await sitesFor([
      cl,
      {
        ...nag,
        nonpolymer_entity_instances: [
          instance('A', '905'),
          instance('A', '906'),
          instance('E', '601'),
          instance('A', '903'),
          instance('A', '904'),
        ],
      },
      zn,
    ]);

    const order = [
      'ZN A901',
      'CL A902',
      'NAG A903',
      'NAG A904',
      'NAG A905',
      'NAG A906',
      'NAG E601',
    ];
    const label = (s: { ligandCompId: string; ligandAsymId?: string; ligandAuthSeqId?: number }) =>
      `${s.ligandCompId} ${s.ligandAsymId}${s.ligandAuthSeqId}`;
    expect(forward.map(label)).toEqual(order);
    expect(reversed).toEqual(forward);
    expect(shuffled).toEqual(forward);

    // start 0, 3, 6 at limit 3 — the slice binding_site pages with — reads each
    // instance exactly once, and the same pages from any upstream order.
    for (const sites of [forward, reversed, shuffled]) {
      const pages = [0, 3, 6].map((start) => sites.slice(start, start + 3).map(label));
      expect(pages).toEqual([order.slice(0, 3), order.slice(3, 6), order.slice(6)]);
    }
  });

  it('orders author residue numbers numerically and puts instances without author IDs last (#85)', async () => {
    const sites = await sitesFor([
      {
        rcsb_id: '1ABC_2',
        rcsb_nonpolymer_entity_container_identifiers: { nonpolymer_comp_id: 'SO4' },
        nonpolymer_entity_instances: [
          {
            rcsb_target_neighbors: [{ target_comp_id: 'ARG', target_asym_id: 'B', distance: 3 }],
          },
          instance('B', '10'),
          {
            ...instance('A', '9'),
            rcsb_nonpolymer_entity_instance_container_identifiers: { auth_asym_id: 'A' },
          },
          instance('A', '10'),
          instance('A', '9'),
        ],
      },
    ]);
    expect(sites.map((s) => [s.ligandAsymId, s.ligandAuthSeqId])).toEqual([
      ['A', 9],
      ['A', 10],
      ['A', undefined],
      ['B', 10],
      [undefined, undefined],
    ]);
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
    const out = await service().searchSequence('MVLSPADKTN', { limit: 5 }, createMockContext());
    expect(out.total).toBe(12);
    expect(out.hits).toEqual([
      { id: '4HHB_1', score: 1 },
      { id: '2HHB_1', score: 0.9 },
    ]);
  });

  /** One verbose `sequence` service entry, its aligned strings cut (live P69905 captures). */
  const sequenceService = (context: Record<string, unknown> | null) => ({
    service_type: 'sequence',
    nodes: [
      {
        node_id: 27204,
        original_score: 289,
        norm_score: 0.99,
        match_context: context === null ? null : [context],
      },
    ],
  });

  /** 2MGE_1 at start 1357 of the P69905 sequence-only search: score 0, the tail of 1,382. */
  const CONTEXT_2MGE_1 = {
    sequence_identity: 0.25,
    evalue: 0.0006589,
    bitscore: 42,
    alignment_length: 148,
    mismatches: 105,
    gaps_opened: 1,
    query_beg: 1,
    query_end: 142,
    subject_beg: 1,
    subject_end: 148,
    query_length: 142,
    subject_length: 154,
    query_aligned_seq: 'MVLSPADKTNVK…',
    subject_aligned_seq: 'MVLSEGEWQLVL…',
  };

  /** 3LQD_1: identity served with float noise (0.829 as 0.8290000000000001). */
  const CONTEXT_3LQD_1 = {
    sequence_identity: 0.8290000000000001,
    evalue: 2.304e-76,
    bitscore: 252,
    alignment_length: 141,
    mismatches: 24,
    gaps_opened: 0,
    query_beg: 2,
    query_end: 142,
    subject_beg: 1,
    subject_end: 141,
    query_length: 142,
    subject_length: 141,
    query_aligned_seq: 'VLSPADKTNVKA…',
    subject_aligned_seq: 'VLSPADKTNIKT…',
  };

  it('searchSequence maps each hit’s match context and reports the query length once (#89)', async () => {
    fetchJsonMock.mockResolvedValue({
      total_count: 1382,
      result_set: [
        { identifier: '2MGE_1', score: 0, services: [sequenceService(CONTEXT_2MGE_1)] },
        { identifier: '3LQD_1', score: 0.8434, services: [sequenceService(CONTEXT_3LQD_1)] },
      ],
    });
    const out = await service().searchSequence('MVLSPADKTN', { start: 1357 }, createMockContext());
    expect(out).toEqual({
      total: 1382,
      queryLength: 142,
      hits: [
        {
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
        },
        {
          id: '3LQD_1',
          score: 0.8434,
          identity: 0.829,
          evalue: 2.304e-76,
          bitscore: 252,
          alignmentLength: 141,
          queryStart: 2,
          queryEnd: 142,
          targetStart: 1,
          targetEnd: 141,
          targetLength: 141,
        },
      ],
    });
  });

  /**
   * hemoglobin ∧ P69905 ∧ Homo sapiens, polymer_entity, verbose: RCSB lists the
   * sequence entry after the full_text and text entries (1O1P_1, 1O1N_1).
   */
  const combinedRows = () => [
    {
      identifier: '1O1P_1',
      score: 1.0150708526770136,
      services: [
        { service_type: 'full_text', nodes: [{ node_id: 24873, original_score: 9.94 }] },
        { service_type: 'text', nodes: [{ node_id: 30039, original_score: 5.39 }] },
        sequenceService({
          sequence_identity: 1.0,
          evalue: 7.748e-89,
          bitscore: 289,
          alignment_length: 141,
          query_beg: 2,
          query_end: 142,
          subject_beg: 143,
          subject_end: 283,
          query_length: 142,
          subject_length: 283,
        }),
      ],
    },
    {
      identifier: '1O1N_1',
      score: 1.0130332805392315,
      services: [
        { service_type: 'full_text', nodes: [{ node_id: 24873, original_score: 9.87 }] },
        { service_type: 'text', nodes: [{ node_id: 30039, original_score: 5.39 }] },
        sequenceService({
          sequence_identity: 0.992,
          evalue: 5.151e-88,
          bitscore: 287,
          alignment_length: 141,
          query_beg: 2,
          query_end: 142,
          subject_beg: 145,
          subject_end: 285,
          query_length: 142,
          subject_length: 285,
        }),
      ],
    },
  ];

  const COMBINED_HITS = [
    {
      id: '1O1P_1',
      score: 1.0150708526770136,
      identity: 1,
      evalue: 7.748e-89,
      bitscore: 289,
      alignmentLength: 141,
      queryStart: 2,
      queryEnd: 142,
      targetStart: 143,
      targetEnd: 283,
      targetLength: 283,
    },
    {
      id: '1O1N_1',
      score: 1.0130332805392315,
      identity: 0.992,
      evalue: 5.151e-88,
      bitscore: 287,
      alignmentLength: 141,
      queryStart: 2,
      queryEnd: 142,
      targetStart: 145,
      targetEnd: 285,
      targetLength: 285,
    },
  ];

  it('search reads the context from the sequence entry behind the other services (#89)', async () => {
    fetchJsonMock.mockResolvedValue({ total_count: 739, result_set: combinedRows() });
    const out = await service().search(
      { text: 'hemoglobin', sequence: 'MVLSPADKTN', organism: 'Homo sapiens' },
      createMockContext(),
    );
    expect(out).toEqual({ total: 739, queryLength: 142, hits: COMBINED_HITS });
  });

  it('selects the sequence entry by service type, whatever position it holds (#89)', async () => {
    const reversed = combinedRows().map((row) => ({
      ...row,
      services: row.services.toReversed(),
    }));
    fetchJsonMock.mockResolvedValue({ total_count: 739, result_set: reversed });
    const out = await service().search(
      { text: 'hemoglobin', sequence: 'MVLSPADKTN' },
      createMockContext(),
    );
    expect(out).toEqual({ total: 739, queryLength: 142, hits: COMBINED_HITS });
  });

  it('adds no alignment field a hit’s sequence entry did not carry (#89)', async () => {
    fetchJsonMock.mockResolvedValue({
      total_count: 6,
      result_set: [
        { identifier: 'A_1', score: 0.6 },
        { identifier: 'B_1', score: 0.5, services: [] },
        { identifier: 'C_1', score: 0.4, services: [sequenceService(null)] },
        { identifier: 'D_1', score: 0.3, services: [{ service_type: 'sequence', nodes: [] }] },
        {
          identifier: 'E_1',
          score: 0.2,
          services: [
            { service_type: 'text', nodes: [{ node_id: 1, match_context: [CONTEXT_2MGE_1] }] },
          ],
        },
        {
          identifier: 'F_1',
          score: 0.1,
          services: [sequenceService({ sequence_identity: 0.5, evalue: 'n/a', query_beg: null })],
        },
      ],
    });
    const out = await service().searchSequence('MVLSPADKTN', {}, createMockContext());
    expect(out).toEqual({
      total: 6,
      hits: [
        { id: 'A_1', score: 0.6 },
        { id: 'B_1', score: 0.5 },
        { id: 'C_1', score: 0.4 },
        { id: 'D_1', score: 0.3 },
        { id: 'E_1', score: 0.2 },
        { id: 'F_1', score: 0.1, identity: 0.5 },
      ],
    });
  });

  it('takes the query length from the first hit that reports one (#89)', async () => {
    fetchJsonMock.mockResolvedValue({
      total_count: 2,
      result_set: [
        { identifier: 'A_1', score: 1, services: [sequenceService(null)] },
        { identifier: '2MGE_1', score: 0, services: [sequenceService(CONTEXT_2MGE_1)] },
      ],
    });
    const out = await service().searchSequence('MVLSPADKTN', {}, createMockContext());
    expect(out.queryLength).toBe(142);
    expect(out.hits[0]).toEqual({ id: 'A_1', score: 1 });
  });

  it('forwards explicit and default offsets through every paged search helper', async () => {
    fetchJsonMock.mockResolvedValue({ total_count: 0, result_set: [] });

    await service().search({ text: 'kinase', start: 7, limit: 3 }, createMockContext());
    await service().searchSequence('MVLSPADKTN', { start: 8, limit: 4 }, createMockContext());
    await service().searchByLigand('HEM', { start: 9, limit: 5 }, createMockContext());
    await service().searchSequence('MVLSPADKTN', {}, createMockContext());
    await service().searchByLigand('HEM', {}, createMockContext());

    const pages = fetchJsonMock.mock.calls.map((call) => {
      const opts = call[2] as unknown as { body: string };
      return JSON.parse(opts.body).request_options.paginate;
    });
    expect(pages).toEqual([
      { start: 7, rows: 3 },
      { start: 8, rows: 4 },
      { start: 9, rows: 5 },
      { start: 0, rows: 25 },
      { start: 0, rows: 25 },
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

  it('matches bound (non-polymer) copies only, on both the ligand search and the deposition count (#92)', async () => {
    // MSE as a selenomethionine residue inside a chain, or NAG inside a branched
    // glycan, is not a bound ligand: binding_site reads non-polymer entities only.
    fetchJsonMock.mockResolvedValue({ total_count: 20, result_set: [] });
    await service().searchByLigand('mse', { limit: 5 }, createMockContext());
    await service().countEntriesWithLigand('mse', createMockContext());
    const queries = fetchJsonMock.mock.calls.map(
      (call) => JSON.parse((call[2] as unknown as { body: string }).body).query,
    );
    const bound = {
      type: 'terminal',
      service: 'text',
      parameters: {
        attribute: 'rcsb_nonpolymer_entity_container_identifiers.nonpolymer_comp_id',
        operator: 'exact_match',
        value: 'MSE',
      },
    };
    expect(queries).toEqual([bound, bound]);
  });

  it('findChemComps returns the hit identifiers with the upstream total (#67)', async () => {
    // Live "ATP" name/synonym search: seven components, all within one page.
    fetchJsonMock.mockResolvedValue({
      result_type: 'mol_definition',
      total_count: 7,
      result_set: [
        { identifier: 'PRT', score: 1 },
        { identifier: 'JSQ', score: 0.936 },
        { identifier: 'AGS', score: 0.509 },
        { identifier: 'ATP', score: 0.345 },
        { identifier: 'DDS', score: 0.338 },
        { identifier: 'APC', score: 0.287 },
        { identifier: 'A1L15', score: 0.185 },
      ],
    });
    const out = await service().findChemComps('ATP', 25, createMockContext());
    expect(out).toEqual({
      ids: ['PRT', 'JSQ', 'AGS', 'ATP', 'DDS', 'APC', 'A1L15'],
      total: 7,
    });
  });

  it('findChemComps keeps an upstream total larger than the page it pulled (#67)', async () => {
    // "iron" matches 119 components upstream; a two-row page still reports all 119.
    fetchJsonMock.mockResolvedValue({
      total_count: 119,
      result_set: [
        { identifier: 'FE', score: 1 },
        { identifier: 'FE2', score: 0.9 },
      ],
    });
    const out = await service().findChemComps('iron', 2, createMockContext());
    expect(out).toEqual({ ids: ['FE', 'FE2'], total: 119 });
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
    expect(out.facets[0]?.buckets[0]?.child).toMatchObject({
      dimension: 'release_year',
      buckets: [
        { label: '2020', count: 100 },
        { label: '2021', count: 120 },
      ],
    });
  });

  it('projects an empty child when the requested cross-tab facet is absent upstream (#31)', async () => {
    // group_by ["organism", "method"] under predicted content: computed models
    // carry no experimental method, so RCSB omits the nested facet key entirely
    // rather than returning it with an empty bucket list.
    fetchJsonMock.mockResolvedValue({
      total_count: 1062058,
      facets: [
        {
          name: 'organism',
          attribute: 'rcsb_entity_source_organism.ncbi_scientific_name',
          buckets: [
            { label: 'Glycine max', population: 55796 },
            { label: 'Mus musculus', population: 36 },
          ],
        },
      ],
    });
    const spec: FacetSpec = {
      dimension: 'organism',
      attribute: 'rcsb_entity_source_organism.ncbi_scientific_name',
      aggregation: 'terms',
      child: { dimension: 'method', attribute: 'exptl.method', aggregation: 'terms' },
    };
    const out = await service().analyzeFacets({}, [spec], createMockContext());

    // The requested dimension is present with an empty bucket list — "it
    // aggregated to nothing", distinct from a bucket that asked for no cross-tab.
    expect(out.facets[0]?.buckets).toHaveLength(2);
    for (const bucket of out.facets[0]?.buckets ?? []) {
      expect(bucket.child).toEqual({
        dimension: 'method',
        attribute: 'exptl.method',
        buckets: [],
      });
    }
  });

  it('leaves the child unset when no cross-tab dimension was requested (#31)', async () => {
    fetchJsonMock.mockResolvedValue({
      total_count: 100,
      facets: [
        {
          name: 'organism',
          attribute: 'rcsb_entity_source_organism.ncbi_scientific_name',
          buckets: [{ label: 'Homo sapiens', population: 100 }],
        },
      ],
    });
    const spec: FacetSpec = {
      dimension: 'organism',
      attribute: 'rcsb_entity_source_organism.ncbi_scientific_name',
      aggregation: 'terms',
    };
    const out = await service().analyzeFacets({}, [spec], createMockContext());
    expect(out.facets[0]?.buckets[0]).not.toHaveProperty('child');
  });

  it('adds a [label, label+interval) range to numeric histogram buckets from the fixed bin width', async () => {
    // A real sparse resolution tail: 16.0 then 17.0 (no 16.5) — the histogram omits
    // empty bins, so the returned labels jump by 1.0 even though the bin width is 0.5.
    fetchJsonMock.mockResolvedValue({
      total_count: 100,
      facets: [
        {
          name: 'resolution',
          attribute: 'rcsb_entry_info.resolution_combined',
          buckets: [
            { label: '0.5', population: 1249 },
            { label: '16.0', population: 26 },
            { label: '17.0', population: 30 },
          ],
        },
      ],
    });
    const spec = {
      dimension: 'resolution',
      attribute: 'rcsb_entry_info.resolution_combined',
      aggregation: 'histogram' as const,
      interval: 0.5,
    };
    const out = await service().analyzeFacets({}, [spec], createMockContext());
    // rangeTo is label + interval (16.0 → 16.5), NOT the next returned label (17.0).
    expect(out.facets[0]?.buckets).toEqual([
      { label: '0.5', count: 1249, rangeFrom: 0.5, rangeTo: 1.0 },
      { label: '16.0', count: 26, rangeFrom: 16.0, rangeTo: 16.5 },
      { label: '17.0', count: 30, rangeFrom: 17.0, rangeTo: 17.5 },
    ]);
  });

  it('omits the numeric range for term and date-period facets (the label is the value)', async () => {
    fetchJsonMock.mockResolvedValue({
      total_count: 100,
      facets: [
        {
          name: 'organism',
          attribute: 'rcsb_entity_source_organism.ncbi_scientific_name',
          buckets: [{ label: 'Homo sapiens', population: 81957 }],
        },
        {
          name: 'release_year',
          attribute: 'rcsb_accession_info.initial_release_date',
          buckets: [{ label: '1976', population: 13 }],
        },
      ],
    });
    const specs = [
      {
        dimension: 'organism',
        attribute: 'rcsb_entity_source_organism.ncbi_scientific_name',
        aggregation: 'terms' as const,
      },
      {
        dimension: 'release_year',
        attribute: 'rcsb_accession_info.initial_release_date',
        aggregation: 'date_histogram' as const,
        interval: 'year',
      },
    ];
    const out = await service().analyzeFacets({}, specs, createMockContext());
    // A date interval is a period word, not a numeric bin width — no numeric range.
    expect(out.facets[0]?.buckets[0]).toEqual({ label: 'Homo sapiens', count: 81957 });
    expect(out.facets[1]?.buckets[0]).toEqual({ label: '1976', count: 13 });
  });
});

describe('RcsbService.findChemComps — formula vs name routing (#50)', () => {
  /** The `query` node of the single search body posted by the call under test. */
  const postedQuery = (): {
    type: string;
    service?: string;
    parameters?: Record<string, unknown>;
    nodes?: Array<{ parameters?: Record<string, unknown>; service?: string }>;
  } => {
    const opts = fetchJsonMock.mock.calls[0]?.[2] as unknown as { body: string };
    return JSON.parse(opts.body).query;
  };

  beforeEach(() =>
    fetchJsonMock.mockResolvedValue({
      total_count: 1,
      result_set: [{ identifier: 'STI', score: 1 }],
    }),
  );

  it('routes a spaced Hill-notation formula to the chemical/formula terminal', async () => {
    const out = await service().findChemComps('C29 H31 N7 O', 25, createMockContext());
    expect(out).toEqual({ ids: ['STI'], total: 1 });
    expect(postedQuery()).toEqual({
      type: 'terminal',
      service: 'chemical',
      parameters: { type: 'formula', value: 'C29 H31 N7 O' },
    });
    // match_subset stays unset — exact composition, one canonical hit.
    expect(postedQuery().parameters).not.toHaveProperty('match_subset');
  });

  it('routes an unspaced formula to the same terminal without client-side normalization', async () => {
    const out = await service().findChemComps('C29H31N7O', 25, createMockContext());
    expect(out).toEqual({ ids: ['STI'], total: 1 });
    expect(postedQuery()).toMatchObject({
      service: 'chemical',
      parameters: { type: 'formula', value: 'C29H31N7O' },
    });
  });

  it.each(['STI', 'HEM', 'heme', 'imatinib', 'VITAMIN B12', '1PE'])(
    'keeps %s on the name/synonym text_chem path',
    async (query) => {
      await service().findChemComps(query, 25, createMockContext());
      const q = postedQuery();
      expect(q.type).toBe('group');
      expect(q.nodes?.map((n) => n.parameters?.attribute)).toEqual([
        'chem_comp.name',
        'rcsb_chem_comp_synonyms.name',
      ]);
      expect(q.nodes?.every((n) => n.service === 'text_chem')).toBe(true);
    },
  );

  it('returns [] for a formula with no upstream match (204 empty body)', async () => {
    // postSearch's onEmptyBody already turns RCSB's 204 into an empty result set;
    // the tool's existing not_found branch takes it from there.
    fetchJsonMock.mockResolvedValue({ total_count: 0, result_set: [], facets: [] });
    expect(await service().findChemComps('C99 H99 N99 O99', 25, createMockContext())).toEqual({
      ids: [],
      total: 0,
    });
  });

  it.each(['SF4', 'H4B', 'BU1'])(
    'falls back to the name/synonym search when the formula terminal misses on %s',
    async (query) => {
      // A component ID built only from single-letter element symbols plus a digit
      // satisfies every formula-shape rule, so detection claims it. An empty
      // formula match must not end the resolution — the name path still owns it.
      fetchJsonMock
        .mockResolvedValueOnce({ total_count: 0, result_set: [] })
        .mockResolvedValueOnce({ total_count: 1, result_set: [{ identifier: '6ML', score: 1 }] });

      expect(await service().findChemComps(query, 25, createMockContext())).toEqual({
        ids: ['6ML'],
        total: 1,
      });
      expect(fetchJsonMock).toHaveBeenCalledTimes(2);
      const queries = fetchJsonMock.mock.calls.map((call) => {
        const opts = call[2] as unknown as { body: string };
        return JSON.parse(opts.body).query;
      });
      expect(queries[0]).toMatchObject({ service: 'chemical' });
      expect(queries[1]).toMatchObject({ type: 'group' });
    },
  );

  it('does not re-query the name path when the formula terminal matched', async () => {
    await service().findChemComps('C29 H31 N7 O', 25, createMockContext());
    expect(fetchJsonMock).toHaveBeenCalledTimes(1);
  });

  it('paginates the formula path with the same row cap as the name path', async () => {
    await service().findChemComps('C29 H31 N7 O', 7, createMockContext());
    const opts = fetchJsonMock.mock.calls[0]?.[2] as unknown as { body: string };
    const body = JSON.parse(opts.body);
    expect(body.return_type).toBe('mol_definition');
    expect(body.request_options.paginate).toEqual({ start: 0, rows: 7 });
  });
});

describe('RcsbService results_content_type emission (#29)', () => {
  /** The `request_options` of the single search body posted by the call under test. */
  const requestOptions = (): { results_content_type?: string[] } => {
    const opts = fetchJsonMock.mock.calls[0]?.[2] as unknown as { body: string };
    return (JSON.parse(opts.body) as { request_options: { results_content_type?: string[] } })
      .request_options;
  };

  const methodSpec: FacetSpec = {
    dimension: 'method',
    attribute: 'exptl.method',
    aggregation: 'terms',
  };

  beforeEach(() => fetchJsonMock.mockResolvedValue({ total_count: 0, result_set: [] }));

  it('emits both universes for a union scope', async () => {
    await service().search(
      { text: 'hemoglobin', contentType: ['experimental', 'computational'] },
      createMockContext(),
    );
    expect(requestOptions().results_content_type).toEqual(['experimental', 'computational']);
  });

  it('emits a single-member scope verbatim', async () => {
    await service().search(
      { text: 'hemoglobin', contentType: ['computational'] },
      createMockContext(),
    );
    expect(requestOptions().results_content_type).toEqual(['computational']);
  });

  it('omits the option entirely when no scope is given', async () => {
    await service().search({ text: 'hemoglobin' }, createMockContext());
    expect(requestOptions()).not.toHaveProperty('results_content_type');
  });

  it('omits the option for an empty scope array', async () => {
    await service().search({ text: 'hemoglobin', contentType: [] }, createMockContext());
    expect(requestOptions()).not.toHaveProperty('results_content_type');
  });

  it('carries a union scope through the facet-only aggregation path', async () => {
    await service().analyzeFacets(
      { text: 'hemoglobin', contentType: ['experimental', 'computational'] },
      [methodSpec],
      createMockContext(),
    );
    expect(requestOptions().results_content_type).toEqual(['experimental', 'computational']);
  });

  it('scopes a sequence search to the requested universes', async () => {
    await service().searchSequence(
      'MVLSPADKTN',
      { contentType: ['experimental', 'computational'] },
      createMockContext(),
    );
    expect(requestOptions().results_content_type).toEqual(['experimental', 'computational']);
  });

  it('keeps the explicit experimental default on the ligand-containment search', async () => {
    await service().searchByLigand('HEM', {}, createMockContext());
    expect(requestOptions().results_content_type).toEqual(['experimental']);
  });

  it('keeps the explicit experimental default on the ligand deposition count', async () => {
    await service().countEntriesWithLigand('HEM', createMockContext());
    expect(requestOptions().results_content_type).toEqual(['experimental']);
  });

  it('lets an explicit ligand scope override the experimental default', async () => {
    await service().searchByLigand(
      'HEM',
      { contentType: ['experimental', 'computational'] },
      createMockContext(),
    );
    expect(requestOptions().results_content_type).toEqual(['experimental', 'computational']);
  });
});

describe('RcsbService.coordinateUrls (#61)', () => {
  it('serves mmCIF and PDB from the file host and BinaryCIF from the model host', () => {
    expect(service().coordinateUrls({ id: '4hhb', pdbFormatCompatible: true })).toEqual({
      cif: 'https://files.test/download/4HHB.cif',
      pdb: 'https://files.test/download/4HHB.pdb',
      bcif: 'https://models.test/4HHB.bcif',
    });
  });

  it('keeps the PDB-format URL when an experimental entry reports no compatibility value', () => {
    expect(service().coordinateUrls({ id: '1ABC' })).toEqual({
      cif: 'https://files.test/download/1ABC.cif',
      pdb: 'https://files.test/download/1ABC.pdb',
      bcif: 'https://models.test/1ABC.bcif',
    });
  });

  it('omits the PDB-format URL for an mmCIF-only entry', () => {
    const urls = service().coordinateUrls({ id: '4V6X', pdbFormatCompatible: false });
    expect(urls).toEqual({
      cif: 'https://files.test/download/4V6X.cif',
      bcif: 'https://models.test/4V6X.bcif',
    });
    expect(urls).not.toHaveProperty('pdb');
  });

  it('lists only BinaryCIF for a computed model, which the file host does not serve', () => {
    for (const [id, provider] of [
      ['AF_AFP69905F1', 'AlphaFold DB'],
      ['MA_MAASFVASFVG001', 'ModelArchive'],
    ] as const) {
      expect(service().coordinateUrls({ id, computedModelProvider: provider })).toEqual({
        bcif: `https://models.test/${id}.bcif`,
      });
    }
  });
});
