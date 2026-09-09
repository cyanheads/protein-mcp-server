/**
 * @fileoverview Tests for protein_get_structure: source/ID-type guarding, batched
 * partial success (failed[]), the predicted (AlphaFold) path, the best_available
 * federated pick (experimental pdbId + title promotion, full cif/pdb/bcif parity
 * with source experimental, scale-correct confidence that keeps a non-pLDDT metric
 * out of meanPlddt), the coordinate overflow → section-outline collapse for both
 * a batch and a lone over-budget file, failed coordinate inlining, the advisory
 * accumulator that keeps batch-cap / partial-failure / overflow notices from
 * overwriting each other, the entry detail carried on experimental records
 * (polymer entities with both chain namespaces, ligands, molecular weight,
 * release date), and the per-response attribution union (RCSB PDB / AlphaFold DB,
 * derived from structures[]). Services and the HTTP layer are mocked.
 * @module tests/tools/get-structure.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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

import { pdbSummaryResource } from '@/mcp-server/resources/definitions/pdb-summary.resource.js';
import { compareStructures } from '@/mcp-server/tools/definitions/compare-structures.tool.js';
import { getAnnotations } from '@/mcp-server/tools/definitions/get-annotations.tool.js';
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

  it('routes a malformed predicted ID through the declared all_failed path, never a raw upstream error', async () => {
    // "P0DOESNOT" is neither PDB- nor UniProt-shaped, so it used to reach AlphaFold
    // and come back a 400 that escaped the tool's typed error contract entirely.
    const input = getStructure.input.parse({ ids: ['P0DOESNOT'], source: 'predicted' });
    await expect(getStructure.handler(input, ctx())).rejects.toMatchObject({
      data: { reason: 'all_failed' },
    });
    expect(getPrediction).not.toHaveBeenCalled();
  });

  it('resolves an AlphaFold DB entry ID under predicted, not just a bare accession', async () => {
    // Both AlphaFold and 3D-Beacons answer AF-P69905-F1 with a 200, and the af://
    // resource emits exactly this form as `entryId` — so the shape guard added for
    // the malformed-ID fix must not turn a working round-trip into a failed[] row.
    getPrediction.mockResolvedValue({
      uniprotAccession: 'P69905',
      meanPlddt: 98,
      cifUrl: 'https://af/cif',
    });
    const input = getStructure.input.parse({ ids: ['AF-P69905-F1'], source: 'predicted' });
    const out = await getStructure.handler(input, ctx());

    expect(out.failed).toHaveLength(0);
    expect(out.structures).toHaveLength(1);
    expect(out.structures[0]).toMatchObject({ source: 'predicted' });
    expect(getPrediction).toHaveBeenCalledWith('AF-P69905-F1', expect.anything());
  });

  it('keeps a mixed valid+malformed predicted batch a partial success', async () => {
    getPrediction.mockResolvedValue({
      uniprotAccession: 'P69905',
      meanPlddt: 98,
      cifUrl: 'https://af/cif',
    });
    const input = getStructure.input.parse({
      ids: ['P69905', 'P0DOESNOT'],
      source: 'predicted',
    });
    const c = ctx();
    const out = await getStructure.handler(input, c);

    expect(out.structures).toHaveLength(1);
    expect(out.structures[0]).toMatchObject({ id: 'P69905', source: 'predicted' });
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0]?.id).toBe('P0DOESNOT');
    // A malformed accession must not read as "upstream has no model for it".
    expect(out.failed[0]?.reason).not.toBe('No predicted model found for this accession.');
    expect(out.failed[0]?.reason).toMatch(/UniProt accession/i);
    // Only the well-formed accession was worth a round trip.
    expect(getPrediction).toHaveBeenCalledTimes(1);
    expect(getPrediction).toHaveBeenCalledWith('P69905', expect.anything());
    expect(getEnrichment(c)).toMatchObject({ requested: 2, resolved: 1 });
  });

  it('a well-formed but unknown accession still reports the upstream-miss reason', async () => {
    // A9ZZZ9 is shape-valid: it reaches AlphaFold, 404s, and degrades per-ID.
    getPrediction.mockResolvedValue(null);
    const input = getStructure.input.parse({ ids: ['A9ZZZ9'], source: 'predicted' });
    await expect(getStructure.handler(input, ctx())).rejects.toMatchObject({
      data: {
        reason: 'all_failed',
        recovery: { hint: expect.stringContaining('Verify ID formats') },
      },
    });
    expect(getPrediction).toHaveBeenCalledWith('A9ZZZ9', expect.anything());
  });

  it('still rejects a PDB ID under source predicted with mixed_id_types', async () => {
    const input = getStructure.input.parse({ ids: ['4HHB'], source: 'predicted' });
    await expect(getStructure.handler(input, ctx())).rejects.toMatchObject({
      data: { reason: 'mixed_id_types' },
    });
    expect(getPrediction).not.toHaveBeenCalled();
  });

  it('applies the same per-ID guard under source best_available', async () => {
    getSummary.mockResolvedValue({
      accession: 'P69905',
      found: true,
      models: [
        {
          modelIdentifier: 'AF-P69905-F1',
          modelCategory: 'AB-INITIO',
          provider: 'AlphaFold DB',
          modelUrl: 'https://alphafold.test/af.cif',
          confidenceType: 'pLDDT',
          confidenceAvgLocalScore: 96.8,
        },
      ],
    });
    const input = getStructure.input.parse({
      ids: ['P69905', 'P0DOESNOT'],
      source: 'best_available',
    });
    const out = await getStructure.handler(input, ctx());

    expect(out.structures.map((s) => s.id)).toEqual(['P69905']);
    expect(out.failed[0]).toMatchObject({
      id: 'P0DOESNOT',
      reason: expect.stringMatching(/UniProt accession/i),
    });
    expect(getSummary).toHaveBeenCalledTimes(1);
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
    const text = (getStructure.format!(out)[0] as { text: string }).text;
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

    const text = (getStructure.format!(out)[0] as { text: string }).text;
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

describe('protein_get_structure computed structure models', () => {
  /**
   * What RCSB's entry endpoint returns for a computed-model ID: no method, no
   * resolution, and a modelling provider in place of experimental provenance.
   */
  const csmMeta = (id: string, computedModelProvider: string) => ({
    id,
    computedModelProvider,
    title: `Computed structure model of ${id}`,
    organisms: ['Mus musculus'],
    polymerEntities: [],
    ligands: [],
  });

  it('marks an RCSB-served computed model predicted, not experimental', async () => {
    getEntries.mockResolvedValue([csmMeta('AF_AFQ9Z1K5F1', 'AlphaFold DB')]);
    const input = getStructure.input.parse({
      ids: ['AF_AFQ9Z1K5F1'],
      source: 'experimental',
    });
    const out = await getStructure.handler(input, ctx());

    // The ID arrives here straight from protein_search_structures under the
    // default content_type, so stamping it experimental contradicts the record.
    expect(out.structures[0]).toMatchObject({
      id: 'AF_AFQ9Z1K5F1',
      source: 'predicted',
      provider: 'AlphaFold DB',
    });
    const text = (getStructure.format!(out)[0] as { text: string }).text;
    expect(text).toContain('AF_AFQ9Z1K5F1 _(predicted)_');
    expect(text).not.toContain('AF_AFQ9Z1K5F1 _(experimental)_');
  });

  it('credits the modelling provider, not the PDB, for a computed model', async () => {
    getEntries.mockResolvedValue([csmMeta('AF_AFQ9Z1K5F1', 'AlphaFold DB')]);
    const out = await getStructure.handler(
      getStructure.input.parse({ ids: ['AF_AFQ9Z1K5F1'], source: 'experimental' }),
      ctx(),
    );
    // AlphaFold data is CC BY 4.0 with an attribution obligation; crediting it to
    // the PDB's CC0 would understate the license the consumer inherits.
    expect(out.attribution.map((a) => a.source)).toEqual(['AlphaFold DB']);
    expect(out.attribution[0]?.license).toBe('CC BY 4.0');
    expect(out.attribution.some((a) => a.source === 'RCSB PDB')).toBe(false);
  });

  it('credits ModelArchive for an MA_* model', async () => {
    getEntries.mockResolvedValue([csmMeta('MA_MAT3VR3570', 'ModelArchive')]);
    const out = await getStructure.handler(
      getStructure.input.parse({ ids: ['MA_MAT3VR3570'], source: 'experimental' }),
      ctx(),
    );
    expect(out.structures[0]).toMatchObject({ source: 'predicted', provider: 'ModelArchive' });
    expect(out.attribution.map((a) => a.source)).toEqual(['ModelArchive']);
    expect(out.attribution[0]?.license).toBe('CC BY 4.0');
  });

  it('unions both credits when a batch mixes a PDB entry and a computed model', async () => {
    getEntries.mockResolvedValue([
      experimentalMeta('6LOH'),
      csmMeta('AF_AFQ9Z1K5F1', 'AlphaFold DB'),
    ]);
    const out = await getStructure.handler(
      getStructure.input.parse({ ids: ['6LOH', 'AF_AFQ9Z1K5F1'], source: 'experimental' }),
      ctx(),
    );
    expect(out.structures.map((s) => s.source)).toEqual(['experimental', 'predicted']);
    expect(out.attribution.map((a) => a.source)).toEqual(['RCSB PDB', 'AlphaFold DB']);
  });

  it('leaves a genuine PDB entry experimental and PDB-credited', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB')]);
    const out = await getStructure.handler(
      getStructure.input.parse({ ids: ['4HHB'], source: 'experimental' }),
      ctx(),
    );
    expect(out.structures[0]).toMatchObject({ source: 'experimental' });
    expect(out.structures[0]).not.toHaveProperty('provider');
    expect(out.attribution.map((a) => a.source)).toEqual(['RCSB PDB']);
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
    const text = (getStructure.format!(out)[0] as { text: string }).text;
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
    const text = (getStructure.format!(out)[0] as { text: string }).text;
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

describe('protein_get_structure advisory accumulation', () => {
  /** `PROTEIN_MAX_BATCH_IDS` default — the cap the handler applies. */
  const CAP = 25;

  /** `n` distinct PDB-shaped IDs (`10HB`, `11HB`, …) for exercising the batch cap. */
  const pdbIds = (n: number) => Array.from({ length: n }, (_, i) => `${10 + i}HB`);

  /** The single joined advisory string the handler writes once. */
  const noticeOf = (c: ReturnType<typeof ctx>) => String(getEnrichment(c).notice ?? '');

  it('emits no notice for a clean in-cap call, and requested equals processed', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB')]);
    const c = ctx();
    await getStructure.handler(
      getStructure.input.parse({ ids: ['4HHB'], source: 'experimental' }),
      c,
    );
    expect(getEnrichment(c)).toMatchObject({ requested: 1, processed: 1, resolved: 1 });
    expect(getEnrichment(c).notice).toBeUndefined();
  });

  it('cap only: reports the original request length, the processed count, and the ignored count', async () => {
    const ids = pdbIds(CAP + 1);
    getEntries.mockResolvedValue(ids.slice(0, CAP).map(experimentalMeta));
    const c = ctx();
    const out = await getStructure.handler(
      getStructure.input.parse({ ids, source: 'experimental' }),
      c,
    );

    expect(out.structures).toHaveLength(CAP);
    // `requested` is the caller's own array length, not the post-cap slice.
    expect(getEnrichment(c)).toMatchObject({ requested: CAP + 1, processed: CAP, resolved: CAP });
    expect(noticeOf(c)).toContain(`Batch capped at ${CAP} IDs; 1 ignored.`);
  });

  it('failure only: keeps the partial-failure text, resolved count, and failed[] entries', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB')]);
    const c = ctx();
    const out = await getStructure.handler(
      getStructure.input.parse({ ids: ['4HHB', '9ZZZ'], source: 'experimental' }),
      c,
    );

    expect(out.failed).toEqual([{ id: '9ZZZ', reason: expect.any(String) }]);
    expect(getEnrichment(c)).toMatchObject({ requested: 2, processed: 2, resolved: 1 });
    expect(noticeOf(c)).toContain('1 of 2 IDs did not resolve: 9ZZZ.');
    expect(noticeOf(c)).not.toContain('Batch capped');
  });

  it('overflow only: reports the coordinate budget advisory and nothing about a cap', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB'), experimentalMeta('2HHB')]);
    fetchTextMock.mockResolvedValue('A'.repeat(20_000));
    const c = ctx();
    const out = await getStructure.handler(
      getStructure.input.parse({
        ids: ['4HHB', '2HHB'],
        source: 'experimental',
        include_coords: true,
      }),
      c,
    );

    expect(out.overflow).toBeDefined();
    expect(noticeOf(c)).toContain('exceeded the');
    expect(noticeOf(c)).not.toContain('Batch capped');
    expect(noticeOf(c)).not.toContain('did not resolve');
  });

  it('cap + failure: both advisories survive in one response', async () => {
    const ids = pdbIds(CAP + 1);
    // One processed ID misses upstream; the 26th was never processed at all.
    getEntries.mockResolvedValue(ids.slice(0, CAP - 1).map(experimentalMeta));
    const c = ctx();
    const out = await getStructure.handler(
      getStructure.input.parse({ ids, source: 'experimental' }),
      c,
    );

    expect(out.failed.map((f) => f.id)).toEqual([ids[CAP - 1]]);
    expect(noticeOf(c)).toContain(`Batch capped at ${CAP} IDs; 1 ignored.`);
    expect(noticeOf(c)).toContain(`1 of ${CAP} IDs did not resolve`);
    expect(getEnrichment(c)).toMatchObject({
      requested: CAP + 1,
      processed: CAP,
      resolved: CAP - 1,
    });
  });

  it('cap + overflow: both advisories survive in one response', async () => {
    const ids = pdbIds(CAP + 1);
    getEntries.mockResolvedValue(ids.slice(0, CAP).map(experimentalMeta));
    fetchTextMock.mockResolvedValue('A'.repeat(2_000)); // 25 × 2k = 50k > 24k budget
    const c = ctx();
    const out = await getStructure.handler(
      getStructure.input.parse({ ids, source: 'experimental', include_coords: true }),
      c,
    );

    expect(out.overflow?.sections).toHaveLength(CAP);
    expect(noticeOf(c)).toContain(`Batch capped at ${CAP} IDs; 1 ignored.`);
    expect(noticeOf(c)).toContain('exceeded the');
  });

  it('failure + overflow: both advisories survive in one response', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB'), experimentalMeta('2HHB')]);
    fetchTextMock.mockResolvedValue('A'.repeat(20_000));
    const c = ctx();
    await getStructure.handler(
      getStructure.input.parse({
        ids: ['4HHB', '2HHB', '9ZZZ'],
        source: 'experimental',
        include_coords: true,
      }),
      c,
    );

    expect(noticeOf(c)).toContain('1 of 3 IDs did not resolve: 9ZZZ.');
    expect(noticeOf(c)).toContain('exceeded the');
  });

  it('cap + failure + overflow: all three advisories survive in one response', async () => {
    const ids = pdbIds(CAP + 1);
    getEntries.mockResolvedValue(ids.slice(0, CAP - 1).map(experimentalMeta));
    fetchTextMock.mockResolvedValue('A'.repeat(2_000)); // 24 × 2k = 48k > 24k budget
    const c = ctx();
    const out = await getStructure.handler(
      getStructure.input.parse({ ids, source: 'experimental', include_coords: true }),
      c,
    );

    expect(out.overflow?.sections).toHaveLength(CAP - 1);
    const notice = noticeOf(c);
    expect(notice).toContain(`Batch capped at ${CAP} IDs; 1 ignored.`);
    expect(notice).toContain(`1 of ${CAP} IDs did not resolve`);
    expect(notice).toContain('exceeded the');
  });

  it('carries the cap disclosure on both consumption surfaces', async () => {
    const ids = pdbIds(CAP + 1);
    getEntries.mockResolvedValue(ids.slice(0, CAP).map(experimentalMeta));
    const result = (await runToolContract(getStructure, { ids, source: 'experimental' })) as {
      structuredContent: { requested: number; processed: number; notice?: string };
      content: Array<{ type: string; text: string }>;
    };

    expect(result.structuredContent).toMatchObject({ requested: CAP + 1, processed: CAP });
    expect(result.structuredContent.notice).toContain('1 ignored');
    const text = result.content.map((b) => b.text).join('\n');
    expect(text).toContain('1 ignored');
    expect(text).toContain(String(CAP + 1));
  });
});

describe('protein_get_structure coordinate inlining budget', () => {
  const OVER_BUDGET = 'A'.repeat(30_000); // > DEFAULT_OUTLINE_BUDGET_BYTES (24_000)

  it('withholds a single over-budget coordinate file instead of inlining it whole', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB')]);
    fetchTextMock.mockResolvedValue(OVER_BUDGET);
    const c = ctx();
    const out = await getStructure.handler(
      getStructure.input.parse({ ids: ['4HHB'], source: 'experimental', include_coords: true }),
      c,
    );

    expect(out.structures[0]?.coordinates).toBeUndefined();
    expect(out.structures[0]?.coordinateFormat).toBeUndefined();
    expect(out.overflow?.sections).toEqual([{ id: '4HHB', bytes: 30_000 }]);
    // The retrieval path for a lone withheld file is its own URL set, never a
    // sections re-call that would return the identical bytes.
    expect(out.overflow?.notice).toContain('coordinateUrls');
    expect(out.overflow?.notice).not.toContain('sections:[');
    expect(out.structures[0]?.coordinateUrls).toEqual({
      cif: 'https://files/4HHB.cif',
      pdb: 'https://files/4HHB.pdb',
      bcif: 'https://files/4HHB.bcif',
    });
    expect(String(getEnrichment(c).notice)).toContain('coordinateUrls');
  });

  it('still inlines a single under-budget coordinate file on both surfaces', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB')]);
    fetchTextMock.mockResolvedValue('B'.repeat(1_000));
    const c = ctx();
    const out = await getStructure.handler(
      getStructure.input.parse({ ids: ['4HHB'], source: 'experimental', include_coords: true }),
      c,
    );

    expect(out.overflow).toBeUndefined();
    expect(out.structures[0]?.coordinates).toHaveLength(1_000);
    expect(out.structures[0]?.coordinateFormat).toBe('cif');
    expect(getEnrichment(c).notice).toBeUndefined();
    const text = (getStructure.format!(out)[0] as { text: string }).text;
    expect(text).toContain('**Inlined cif (1000 bytes):**');
  });

  it('keeps the multi-file sections re-call guidance for a batch overflow', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB'), experimentalMeta('2HHB')]);
    fetchTextMock.mockResolvedValue('A'.repeat(20_000));
    const out = await getStructure.handler(
      getStructure.input.parse({
        ids: ['4HHB', '2HHB'],
        source: 'experimental',
        include_coords: true,
      }),
      ctx(),
    );

    expect(out.overflow?.sections).toHaveLength(2);
    expect(out.overflow?.notice).toContain('sections:["4HHB"]');
  });

  it('names the structure whose coordinate fetch failed, distinct from failed[]', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB')]);
    fetchTextMock.mockRejectedValue(new Error('upstream 503'));
    const c = ctx();
    const out = await getStructure.handler(
      getStructure.input.parse({ ids: ['4HHB'], source: 'experimental', include_coords: true }),
      c,
    );

    // The ID resolved — it is not a failed[] row; only its coordinate content is missing.
    expect(out.failed).toHaveLength(0);
    expect(out.structures[0]?.coordinates).toBeUndefined();
    expect(out.structures[0]?.coordinateUrls.cif).toBe('https://files/4HHB.cif');
    expect(String(getEnrichment(c).notice)).toContain('Coordinate inlining failed for 4HHB');
    expect(out.overflow).toBeUndefined();
  });

  it('carries an inline failure alongside an overflow advisory in one response', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB'), experimentalMeta('2HHB')]);
    fetchTextMock.mockImplementation(async (url: string) =>
      url.includes('2HHB') ? Promise.reject(new Error('upstream 503')) : OVER_BUDGET,
    );
    const c = ctx();
    const out = await getStructure.handler(
      getStructure.input.parse({
        ids: ['4HHB', '2HHB'],
        source: 'experimental',
        include_coords: true,
      }),
      c,
    );

    expect(out.overflow?.sections).toEqual([{ id: '4HHB', bytes: 30_000 }]);
    const notice = String(getEnrichment(c).notice);
    expect(notice).toContain('Coordinate inlining failed for 2HHB');
    expect(notice).toContain('coordinateUrls');
  });

  it('withholds the payload on the text surface too, never a silent prefix', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB')]);
    fetchTextMock.mockResolvedValue(OVER_BUDGET);
    const result = (await runToolContract(getStructure, {
      ids: ['4HHB'],
      source: 'experimental',
      include_coords: true,
    })) as {
      structuredContent: {
        structures: Array<{ coordinates?: string }>;
        overflow?: { sections: Array<{ id: string; bytes: number }>; notice: string };
      };
      content: Array<{ type: string; text: string }>;
    };

    expect(result.structuredContent.structures[0]?.coordinates).toBeUndefined();
    expect(result.structuredContent.overflow?.sections).toEqual([{ id: '4HHB', bytes: 30_000 }]);
    const text = result.content.map((b) => b.text).join('\n');
    expect(text).toContain('Coordinates withheld');
    expect(text).toContain('coordinateUrls');
    expect(text).not.toContain('A'.repeat(500));
  });

  it('renders the withheld state rather than an inline prefix when overflow names the structure', async () => {
    // format() is total over the output schema: a value carrying both `coordinates`
    // and an `overflow` entry for that same structure must render the withheld
    // notice, never 2,000 characters of a payload the structured surface dropped.
    const withheld = {
      structures: [
        {
          id: '4HHB',
          source: 'experimental' as const,
          coordinateUrls: { cif: 'https://files/4HHB.cif' },
          coordinateFormat: 'cif' as const,
          coordinates: OVER_BUDGET,
        },
      ],
      failed: [],
      attribution: [],
      overflow: { sections: [{ id: '4HHB', bytes: 30_000 }], notice: 'over budget' },
    };
    const text = (getStructure.format!(withheld)[0] as { text: string }).text;
    expect(text).not.toContain('A'.repeat(500));
    expect(text).toContain('Coordinates withheld');
  });
});

describe('protein_get_structure experimental entry detail', () => {
  /** The full 4HHB entry shape `RcsbService.getEntries()` already returns. */
  const fullMeta = {
    id: '4HHB',
    title: 'THE CRYSTAL STRUCTURE OF HUMAN DEOXYHAEMOGLOBIN',
    methods: ['X-RAY DIFFRACTION'],
    resolution: 1.74,
    molecularWeight: 64.74,
    releaseDate: '1984-07-17T00:00:00Z',
    organisms: ['Homo sapiens'],
    polymerEntities: [
      {
        entityId: '4HHB_1',
        description: 'Hemoglobin subunit alpha',
        organism: 'Homo sapiens',
        authAsymIds: ['A', 'C'],
        labelAsymIds: ['A', 'C'],
        sequenceLength: 141,
      },
    ],
    ligands: [
      { compId: 'HEM', name: 'PROTOPORPHYRIN IX CONTAINING FE', formula: 'C34 H32 Fe N4 O4' },
    ],
  };

  it('returns the entry detail already fetched onto EntryMeta', async () => {
    getEntries.mockResolvedValue([fullMeta]);
    const out = await getStructure.handler(
      getStructure.input.parse({ ids: ['4HHB'], source: 'experimental' }),
      ctx(),
    );

    expect(out.structures[0]).toMatchObject({
      molecularWeight: 64.74,
      releaseDate: '1984-07-17T00:00:00Z',
      ligands: [expect.objectContaining({ compId: 'HEM' })],
      polymerEntities: [expect.objectContaining({ entityId: '4HHB_1', authAsymIds: ['A', 'C'] })],
    });
  });

  it('exposes both chain namespaces per polymer entity when they differ (6QNR)', async () => {
    getEntries.mockResolvedValue([
      {
        id: '6QNR',
        organisms: [],
        polymerEntities: [
          { entityId: '6QNR_9', authAsymIds: ['82', '8E'], labelAsymIds: ['I', 'OB'] },
        ],
        ligands: [],
      },
    ]);
    const out = await getStructure.handler(
      getStructure.input.parse({ ids: ['6QNR'], source: 'experimental' }),
      ctx(),
    );

    expect(out.structures[0]?.polymerEntities).toEqual([
      { entityId: '6QNR_9', authAsymIds: ['82', '8E'], labelAsymIds: ['I', 'OB'] },
    ]);
    // Both namespaces reach the text surface, each labelled by namespace.
    const text = (getStructure.format!(out)[0] as { text: string }).text;
    expect(text).toContain('82, 8E');
    expect(text).toContain('I, OB');
  });

  it('matches pdb://{entry_id} on the per-entity chain data for the same entry', async () => {
    getEntries.mockResolvedValue([fullMeta]);
    const out = await getStructure.handler(
      getStructure.input.parse({ ids: ['4HHB'], source: 'experimental' }),
      ctx(),
    );
    const resourceOut = await pdbSummaryResource.handler(
      pdbSummaryResource.params!.parse({ entry_id: '4HHB' }),
      createMockContext({ uri: new URL('pdb://4hhb') }),
    );

    expect(out.structures[0]?.polymerEntities).toEqual(resourceOut.polymerEntities);
    expect(out.structures[0]?.ligands).toEqual(resourceOut.ligands);
    expect(out.structures[0]?.molecularWeight).toBe(resourceOut.molecularWeight);
    expect(out.structures[0]?.releaseDate).toBe(resourceOut.releaseDate);
  });

  it('omits the entry-detail fields for a sparse entry rather than emitting empty arrays', async () => {
    getEntries.mockResolvedValue([{ id: '1ABC', organisms: [], polymerEntities: [], ligands: [] }]);
    const out = await getStructure.handler(
      getStructure.input.parse({ ids: ['1ABC'], source: 'experimental' }),
      ctx(),
    );

    const rec = out.structures[0];
    expect(rec).not.toHaveProperty('polymerEntities');
    expect(rec).not.toHaveProperty('ligands');
    expect(rec).not.toHaveProperty('molecularWeight');
    expect(rec).not.toHaveProperty('releaseDate');
  });

  it('leaves a computed model marked predicted while carrying its entity detail', async () => {
    getEntries.mockResolvedValue([
      {
        id: 'AF_AFQ9Z1K5F1',
        computedModelProvider: 'AlphaFold DB',
        title: 'Computed structure model',
        organisms: ['Mus musculus'],
        polymerEntities: [{ entityId: 'AF_AFQ9Z1K5F1_1', authAsymIds: ['A'], labelAsymIds: ['A'] }],
        ligands: [],
      },
    ]);
    const out = await getStructure.handler(
      getStructure.input.parse({ ids: ['AF_AFQ9Z1K5F1'], source: 'experimental' }),
      ctx(),
    );

    expect(out.structures[0]).toMatchObject({ source: 'predicted', provider: 'AlphaFold DB' });
    expect(out.structures[0]?.polymerEntities).toHaveLength(1);
    expect(out.attribution.map((a) => a.source)).toEqual(['AlphaFold DB']);
  });

  it('leaves predicted and best_available records without entry-detail fields', async () => {
    getPrediction.mockResolvedValue({
      uniprotAccession: 'P69905',
      meanPlddt: 98,
      cifUrl: 'https://af/cif',
    });
    const out = await getStructure.handler(
      getStructure.input.parse({ ids: ['P69905'], source: 'predicted' }),
      ctx(),
    );

    expect(out.structures[0]).not.toHaveProperty('polymerEntities');
    expect(out.structures[0]).not.toHaveProperty('ligands');
  });

  it('carries the entity detail on both consumption surfaces', async () => {
    getEntries.mockResolvedValue([fullMeta]);
    const result = (await runToolContract(getStructure, {
      ids: ['4HHB'],
      source: 'experimental',
    })) as {
      structuredContent: {
        structures: Array<{ polymerEntities?: Array<{ labelAsymIds?: string[] }> }>;
      };
      content: Array<{ type: string; text: string }>;
    };

    expect(result.structuredContent.structures[0]?.polymerEntities?.[0]?.labelAsymIds).toEqual([
      'A',
      'C',
    ]);
    const text = result.content.map((b) => b.text).join('\n');
    expect(text).toContain('4HHB_1');
    expect(text).toContain('HEM');
    expect(text).toContain('64.74');
    expect(text).toContain('1984-07-17T00:00:00Z');
  });
});

describe('chain-namespace descriptions across the surface', () => {
  it('protein_compare_structures names label_asym_id and the field that supplies it', () => {
    const shape = compareStructures.input.shape.structures.element.shape.chain;
    const description = String(shape.description);
    expect(description).toContain('label_asym_id');
    expect(description).toContain('labelAsymIds');
  });

  it('protein_get_annotations points its chain parameter at authAsymIds', () => {
    expect(String(getAnnotations.input.shape.chain.description)).toContain(
      'polymerEntities[].authAsymIds',
    );
    const chainNotFound = getAnnotations.errors?.find((e) => e.reason === 'chain_not_found');
    expect(chainNotFound?.recovery).toContain('polymerEntities[].authAsymIds');
  });
});
