/**
 * @fileoverview Tests for protein_get_structure: source/ID-type guarding, batched
 * partial success (failed[]), the predicted (AlphaFold) path, the best_available
 * federated pick (experimental pdbId + title promotion, full cif/pdb/bcif parity
 * with source experimental, scale-correct confidence that keeps a non-pLDDT metric
 * out of meanPlddt), the coordinate overflow → section-outline collapse, and the
 * per-response attribution union (RCSB PDB / AlphaFold DB, derived from
 * structures[]). Services and the HTTP layer are mocked.
 * @module tests/tools/get-structure.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getEntries = vi.fn();
const coordinateFileUrl = vi.fn((id: string, fmt: string) => `https://files/${id}.${fmt}`);
vi.mock('@/services/rcsb/rcsb-service.js', () => ({
  getRcsbService: () => ({ getEntries, coordinateFileUrl }),
}));

const getPrediction = vi.fn();
vi.mock('@/services/alphafold/alphafold-service.js', () => ({
  getAlphaFoldService: () => ({ getPrediction }),
}));

const getSummary = vi.fn();
vi.mock('@/services/beacons/beacons-service.js', () => ({
  getBeaconsService: () => ({ getSummary }),
}));

vi.mock('@/services/shared/http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/shared/http.js')>();
  return { ...actual, fetchText: vi.fn() };
});

import { getStructure } from '@/mcp-server/tools/definitions/get-structure.tool.js';
import { fetchText } from '@/services/shared/http.js';

const fetchTextMock = vi.mocked(fetchText);

const ctx = () => createMockContext({ errors: getStructure.errors });
const experimentalMeta = (id: string) => ({
  id,
  title: `${id} structure`,
  methods: ['X-RAY DIFFRACTION'],
  organisms: ['Homo sapiens'],
  resolution: 1.74,
  polymerEntities: [],
  ligands: [],
});

beforeEach(() => vi.clearAllMocks());

describe('protein_get_structure', () => {
  it('rejects a UniProt accession under source experimental (mixed_id_types)', async () => {
    const input = getStructure.input.parse({ ids: ['P69905'], source: 'experimental' });
    await expect(getStructure.handler(input, ctx())).rejects.toMatchObject({
      data: { reason: 'mixed_id_types' },
    });
  });

  it('throws all_failed (with its declared recovery hint) when no experimental ID resolves', async () => {
    getEntries.mockResolvedValue([]);
    const input = getStructure.input.parse({ ids: ['4HHB'], source: 'experimental' });
    await expect(getStructure.handler(input, ctx())).rejects.toMatchObject({
      data: {
        reason: 'all_failed',
        recovery: { hint: expect.stringContaining('Verify ID formats') },
      },
    });
  });

  it('resolves found entries and lists unresolved IDs in failed[]', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB')]);
    const input = getStructure.input.parse({ ids: ['4HHB', '9ZZZ'], source: 'experimental' });
    const c = ctx();
    const out = await getStructure.handler(input, c);

    expect(out.structures).toHaveLength(1);
    expect(out.structures[0]).toMatchObject({
      id: '4HHB',
      source: 'experimental',
      method: 'X-RAY DIFFRACTION',
      organism: 'Homo sapiens',
    });
    expect(out.failed).toEqual([{ id: '9ZZZ', reason: expect.any(String) }]);
    expect(getEnrichment(c)).toMatchObject({ requested: 2, resolved: 1 });
  });

  it('fetches a predicted model by UniProt accession', async () => {
    getPrediction.mockResolvedValue({
      uniprotAccession: 'P69905',
      uniprotDescription: 'Hemoglobin subunit alpha',
      organism: 'Homo sapiens',
      meanPlddt: 98,
      confidenceBuckets: { veryLow: 0, low: 0, confident: 0, veryHigh: 1 },
      cifUrl: 'https://af/cif',
      pdbUrl: 'https://af/pdb',
    });
    const input = getStructure.input.parse({ ids: ['P69905'], source: 'predicted' });
    const out = await getStructure.handler(input, ctx());

    expect(out.structures[0]).toMatchObject({
      id: 'P69905',
      source: 'predicted',
      provider: 'AlphaFold DB',
      meanPlddt: 98,
    });
  });

  it('collapses over-budget inlined coordinates into an overflow outline', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB'), experimentalMeta('2HHB')]);
    fetchTextMock.mockResolvedValue('A'.repeat(20_000)); // 2 × 20k = 40k > 24k budget
    const input = getStructure.input.parse({
      ids: ['4HHB', '2HHB'],
      source: 'experimental',
      include_coords: true,
    });
    const out = await getStructure.handler(input, ctx());

    expect(out.overflow).toBeDefined();
    expect(out.overflow?.sections).toHaveLength(2);
    expect(out.structures.every((s) => s.coordinates === undefined)).toBe(true);
  });

  it('best_available promotes the chosen experimental PDB id and title (parity with experimental)', async () => {
    getSummary.mockResolvedValue({
      accession: 'P69905',
      found: true,
      models: [
        {
          modelIdentifier: '2W72',
          modelCategory: 'EXPERIMENTALLY DETERMINED',
          provider: 'PDBe',
          modelUrl: 'https://www.ebi.ac.uk/pdbe/static/entry/2w72_updated.cif',
          resolution: 1.07,
          experimentalMethod: 'X-RAY DIFFRACTION',
        },
      ],
    });
    getEntries.mockResolvedValue([experimentalMeta('2W72')]);
    const input = getStructure.input.parse({ ids: ['P69905'], source: 'best_available' });
    const out = await getStructure.handler(input, ctx());

    expect(out.structures[0]).toMatchObject({
      id: 'P69905',
      source: 'experimental',
      pdbId: '2W72',
      title: '2W72 structure',
      resolution: 1.07,
    });
    // The chosen entry's title is fetched to match the source "experimental" shape.
    expect(getEntries).toHaveBeenCalledWith(['2W72'], expect.anything());
    const text = (getStructure.format?.(out)?.[0] as { text: string }).text;
    expect(text).toContain('**PDB:** 2W72');
  });

  it('best_available leaves pdbId unset for a predicted pick, and a pLDDT score populates meanPlddt + confidence', async () => {
    getSummary.mockResolvedValue({
      accession: 'P00001',
      found: true,
      models: [
        {
          modelIdentifier: 'AF-P00001-F1',
          modelCategory: 'AB-INITIO',
          provider: 'AlphaFold DB',
          modelUrl: 'https://alphafold.test/af.cif',
          confidenceType: 'pLDDT',
          confidenceAvgLocalScore: 92.5,
        },
      ],
    });
    const input = getStructure.input.parse({ ids: ['P00001'], source: 'best_available' });
    const out = await getStructure.handler(input, ctx());

    // pLDDT keeps the 0–100 meanPlddt convenience field, and also carries the
    // self-describing confidence + confidenceType pair.
    expect(out.structures[0]).toMatchObject({
      id: 'P00001',
      source: 'predicted',
      meanPlddt: 92.5,
      confidence: 92.5,
      confidenceType: 'pLDDT',
    });
    expect(out.structures[0]?.pdbId).toBeUndefined();
    // Predicted pick keeps the single provider modelUrl — no RCSB entry fetch.
    expect(out.structures[0]?.coordinateUrls).toEqual({ cif: 'https://alphafold.test/af.cif' });
    expect(getEntries).not.toHaveBeenCalled();
  });

  it('best_available surfaces a non-pLDDT score under confidence + confidenceType, never meanPlddt (#14)', async () => {
    // Live 3D-Beacons shape for Q6ZS81: a SWISS-MODEL QMEANDisCo model on the 0–1 scale.
    getSummary.mockResolvedValue({
      accession: 'Q6ZS81',
      found: true,
      models: [
        {
          modelIdentifier: 'Q6ZS81_2390-2821:1t77.1.A',
          modelCategory: 'TEMPLATE-BASED',
          provider: 'SWISS-MODEL',
          modelUrl:
            'https://swissmodel.expasy.org/3d-beacons/uniprot/Q6ZS81.cif?range=2390-2821&template=1t77.1.A&provider=swissmodel',
          confidenceType: 'QMEANDisCo',
          confidenceAvgLocalScore: 0.63,
        },
      ],
    });
    const input = getStructure.input.parse({ ids: ['Q6ZS81'], source: 'best_available' });
    const out = await getStructure.handler(input, ctx());

    const rec = out.structures[0];
    expect(rec).toMatchObject({
      id: 'Q6ZS81',
      source: 'predicted',
      provider: 'SWISS-MODEL',
      confidence: 0.63,
      confidenceType: 'QMEANDisCo',
    });
    // A 0–1 QMEANDisCo score must not masquerade as pLDDT 0–100.
    expect(rec?.meanPlddt).toBeUndefined();
    // Predicted pick keeps the single provider cif URL — no RCSB entry fetch.
    expect(rec?.coordinateUrls).toEqual({ cif: expect.stringContaining('swissmodel.expasy.org') });
    expect(getEntries).not.toHaveBeenCalled();

    const text = (getStructure.format?.(out)?.[0] as { text: string }).text;
    expect(text).toContain('**Confidence:** 0.63 (QMEANDisCo)');
    expect(text).not.toContain('Mean pLDDT');
  });

  it('best_available emits all three coordinate URLs for an experimental pick, matching source experimental (#16)', async () => {
    // Live 3D-Beacons shape for P69905: the top experimental model is 2W72 @ 1.07 Å,
    // whose beacon modelUrl is a single PDBe cif. best_available must instead emit the
    // full cif/pdb/bcif set from RCSB, identical to source: experimental.
    getSummary.mockResolvedValue({
      accession: 'P69905',
      found: true,
      models: [
        {
          modelIdentifier: '2w72',
          modelCategory: 'EXPERIMENTALLY DETERMINED',
          provider: 'PDBe',
          modelUrl: 'https://www.ebi.ac.uk/pdbe/static/entry/2w72_updated.cif',
          resolution: 1.07,
          experimentalMethod: 'X-RAY DIFFRACTION',
        },
      ],
    });
    getEntries.mockResolvedValue([experimentalMeta('2W72')]);
    const input = getStructure.input.parse({ ids: ['P69905'], source: 'best_available' });
    const out = await getStructure.handler(input, ctx());

    const rec = out.structures[0];
    expect(rec?.pdbId).toBe('2W72');
    // Full three-format set built from the chosen pdbId via the same RCSB URL builder
    // fetchExperimental uses — not the single beacon modelUrl.
    expect(rec?.coordinateUrls).toEqual({
      cif: 'https://files/2W72.cif',
      pdb: 'https://files/2W72.pdb',
      bcif: 'https://files/2W72.bcif',
    });
    expect(coordinateFileUrl).toHaveBeenCalledWith('2W72', 'cif');
    expect(coordinateFileUrl).toHaveBeenCalledWith('2W72', 'pdb');
    expect(coordinateFileUrl).toHaveBeenCalledWith('2W72', 'bcif');
    // Experimental pick reports no predicted-confidence fields.
    expect(rec?.meanPlddt).toBeUndefined();
    expect(rec?.confidence).toBeUndefined();
  });
});

describe('protein_get_structure attribution', () => {
  it('experimental results attribute RCSB PDB only — no AlphaFold entry', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB')]);
    const input = getStructure.input.parse({ ids: ['4HHB'], source: 'experimental' });
    const out = await getStructure.handler(input, ctx());
    expect(out.attribution.map((a) => a.source)).toEqual(['RCSB PDB']);
    expect(out.attribution[0]?.license).toBe('CC0 1.0 Universal');
  });

  it('predicted results attribute AlphaFold DB only — no RCSB entry', async () => {
    getPrediction.mockResolvedValue({
      uniprotAccession: 'P69905',
      meanPlddt: 98,
      cifUrl: 'https://af/cif',
    });
    const input = getStructure.input.parse({ ids: ['P69905'], source: 'predicted' });
    const out = await getStructure.handler(input, ctx());
    expect(out.attribution.map((a) => a.source)).toEqual(['AlphaFold DB']);
    expect(out.attribution[0]?.license).toBe('CC BY 4.0');
  });

  it('best_available unions both sources when a batch mixes an experimental and a predicted pick', async () => {
    getSummary.mockImplementation((acc: string) =>
      acc === 'P69905'
        ? Promise.resolve({
            accession: 'P69905',
            found: true,
            models: [
              {
                modelIdentifier: '2W72',
                modelCategory: 'EXPERIMENTALLY DETERMINED',
                provider: 'PDBe',
                modelUrl: 'https://www.ebi.ac.uk/pdbe/static/entry/2w72_updated.cif',
                resolution: 1.07,
                experimentalMethod: 'X-RAY DIFFRACTION',
              },
            ],
          })
        : Promise.resolve({
            accession: 'P00001',
            found: true,
            models: [
              {
                modelIdentifier: 'AF-P00001-F1',
                modelCategory: 'AB-INITIO',
                provider: 'AlphaFold DB',
                modelUrl: 'https://alphafold.test/af.cif',
                confidenceAvgLocalScore: 92.5,
              },
            ],
          }),
    );
    getEntries.mockResolvedValue([experimentalMeta('2W72')]); // title fetch for the experimental pick
    const input = getStructure.input.parse({
      ids: ['P69905', 'P00001'],
      source: 'best_available',
    });
    const out = await getStructure.handler(input, ctx());

    // Per-response union, canonical order: RCSB PDB (experimental pick) then AlphaFold DB (predicted).
    expect(out.attribution.map((a) => a.source)).toEqual(['RCSB PDB', 'AlphaFold DB']);
    const text = (getStructure.format?.(out)?.[0] as { text: string }).text;
    expect(text).toContain('### Attribution');
    expect(text).toContain('**RCSB PDB** (CC0 1.0 Universal)');
    expect(text).toContain('**AlphaFold DB** (CC BY 4.0)');
  });

  it('best_available credits the real federated provider (SWISS-MODEL, CC BY-SA 4.0), not AlphaFold', async () => {
    getSummary.mockResolvedValue({
      accession: 'Q6ZS81',
      found: true,
      models: [
        {
          modelIdentifier: 'model-1',
          modelCategory: 'TEMPLATE-BASED',
          provider: 'SWISS-MODEL',
          modelUrl: 'https://swissmodel.expasy.org/repository/model.pdb',
          confidenceAvgLocalScore: 0.82,
        },
      ],
    });
    const input = getStructure.input.parse({ ids: ['Q6ZS81'], source: 'best_available' });
    const out = await getStructure.handler(input, ctx());

    expect(out.structures[0]).toMatchObject({ source: 'predicted', provider: 'SWISS-MODEL' });
    const swiss = out.attribution.find((a) => a.source === 'SWISS-MODEL');
    expect(swiss?.license).toBe('CC BY-SA 4.0'); // ShareAlike, distinct from AlphaFold's CC BY 4.0
    expect(out.attribution.some((a) => a.source === 'AlphaFold DB')).toBe(false);
    const text = (getStructure.format?.(out)?.[0] as { text: string }).text;
    expect(text).toContain('**SWISS-MODEL** (CC BY-SA 4.0)');
  });

  it('best_available gives an uncurated provider an honest no-license fallback', async () => {
    getSummary.mockResolvedValue({
      accession: 'P00002',
      found: true,
      models: [
        {
          modelIdentifier: 'af-1',
          modelCategory: 'DEEP-LEARNING',
          provider: 'AlphaFill',
          modelUrl: 'https://alphafill.eu/model.cif',
          confidenceAvgLocalScore: 0.7,
        },
      ],
    });
    const input = getStructure.input.parse({ ids: ['P00002'], source: 'best_available' });
    const out = await getStructure.handler(input, ctx());

    expect(out.attribution.find((a) => a.source === 'AlphaFill')).toMatchObject({
      source: 'AlphaFill',
      license: 'See provider terms',
      homepage: 'https://3d-beacons.org/',
    });
    // never fabricate an AlphaFold credit for a non-AlphaFold provider
    expect(out.attribution.some((a) => a.source === 'AlphaFold DB')).toBe(false);
  });

  it('best_available uses a stable placeholder when a predicted pick carries no provider', async () => {
    getSummary.mockResolvedValue({
      accession: 'P00003',
      found: true,
      models: [
        {
          modelIdentifier: 'x',
          modelCategory: 'AB-INITIO',
          modelUrl: 'https://x.test/model.cif',
          confidenceAvgLocalScore: 0.5,
        },
      ],
    });
    const input = getStructure.input.parse({ ids: ['P00003'], source: 'best_available' });
    const out = await getStructure.handler(input, ctx());

    expect(out.structures[0]?.provider).toBeUndefined();
    expect(
      out.attribution.find((a) => a.source === '3D-Beacons (provider unspecified)'),
    ).toMatchObject({ license: 'See provider terms' });
  });
});
