/**
 * @fileoverview Tests for protein_get_structure: source/ID-type guarding, batched
 * partial success (failed[]), the predicted (AlphaFold) path, the best_available
 * federated pick (PDB entries only from PDBe, ranked by coverage then resolution,
 * with a PDBe-only confirmation when the federated summary lacks them; other
 * models ranked on one lDDT-scale confidence; pdbId + title promotion, full
 * cif/pdb/bcif parity with source experimental, a non-pLDDT metric kept out of
 * meanPlddt), coordinate paging (24,000-character windows for one selected file,
 * a whole-file batch under the budget, a size outline over it, bounded
 * downloads), failed coordinate inlining, the advisory accumulator that keeps
 * batch-cap / partial-failure / overflow notices from overwriting each other,
 * the entry detail carried on experimental records (polymer entities with both
 * chain namespaces, ligands, molecular weight, release date), and the
 * per-response attribution union derived from structures[]. The provider
 * services are mocked; coordinate files are served through a strict fetch stub,
 * so the real HTTP streaming path runs.
 * @module tests/tools/get-structure.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { timeout } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { httpErrorFromResponse } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getEntries = vi.fn();
// Only the upstream call is faked; coordinate-URL construction runs the real
// service code so the host/format routing under test is exercised here too.
vi.mock('@/services/rcsb/rcsb-service.js', async (importOriginal) => {
  const { RcsbService } = await importOriginal<typeof import('@/services/rcsb/rcsb-service.js')>();
  const real = new RcsbService(
    {} as never,
    {} as never,
    { rcsbFilesBaseUrl: 'https://files', rcsbModelsBaseUrl: 'https://models' } as never,
  );
  return {
    getRcsbService: () => ({ getEntries, coordinateUrls: real.coordinateUrls.bind(real) }),
  };
});

const getPrediction = vi.fn();
// Only AlphaFold DB's answer is faked: the real findPrediction runs on top of it,
// so the "ask UniProt only after a miss, follow a merge" path is exercised here.
vi.mock('@/services/alphafold/alphafold-service.js', async (importOriginal) => {
  const { AlphaFoldService } =
    await importOriginal<typeof import('@/services/alphafold/alphafold-service.js')>();
  const service = { getPrediction: (...args: unknown[]) => getPrediction(...args) };
  return {
    getAlphaFoldService: () => ({
      getPrediction,
      findPrediction: (id: string, c: unknown) =>
        AlphaFoldService.prototype.findPrediction.call(service as never, id, c as never),
    }),
  };
});

const getSummary = vi.fn();
vi.mock('@/services/beacons/beacons-service.js', () => ({
  getBeaconsService: () => ({ getSummary }),
}));

// UniProt's verdict is faked; the message and notice builders stay real.
const resolveAccession = vi.fn();
vi.mock('@/services/uniprot/uniprot-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/uniprot/uniprot-service.js')>()),
  getUniProtService: () => ({ resolveAccession }),
}));

import { getServerConfig } from '@/config/server-config.js';
import { pdbSummaryResource } from '@/mcp-server/resources/definitions/pdb-summary.resource.js';
import { compareStructures } from '@/mcp-server/tools/definitions/compare-structures.tool.js';
import { getAnnotations } from '@/mcp-server/tools/definitions/get-annotations.tool.js';
import { getStructure } from '@/mcp-server/tools/definitions/get-structure.tool.js';
import { parseJson } from '@/services/shared/http.js';
import { TextBudget } from '@/services/shared/text-budget.js';

const ctx = () => createMockContext({ errors: getStructure.errors });

/** Coordinate-file hosts. Strict: a request no route answers fails the test. */
const files = createFetchMock();

/** Answer each coordinate URL with its body, or with an HTTP status that fails the read. */
function serveFiles(bodies: Record<string, string | number>): void {
  files.route({
    match: (req) => Object.hasOwn(bodies, req.url),
    respond: (req) => {
      const body = bodies[req.url];
      return typeof body === 'number' ? new Response('', { status: body }) : new Response(body);
    },
  });
}

/** Answer every request to the RCSB file host (`https://files`) with the same body. */
function serveAllFiles(body: string): void {
  files.route({
    match: (req) => new URL(req.url).hostname === 'files',
    respond: () => new Response(body),
  });
}

/** Coordinate URLs requested, in call order. */
const fetchedUrls = () => files.calls.map((c) => c.request.url);

/**
 * A body served in fixed-size chunks with no read-ahead, recording how many
 * characters the reader pulled and whether it cancelled the rest.
 */
function trackedBody(text: string, chunkSize = 1_000) {
  const state = { pulled: 0, cancelled: false };
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.pulled >= text.length) {
          controller.close();
          return;
        }
        const chunk = text.slice(state.pulled, state.pulled + chunkSize);
        state.pulled += chunk.length;
        controller.enqueue(encoder.encode(chunk));
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

/**
 * Synthetic coordinate-like text: 80-character records, then a remainder line,
 * cut to exactly `length` characters (ending in a line break unless `trailingNewline` is false).
 */
function coordinateText(length: number, trailingNewline = true): string {
  const line = (i: number) =>
    `ATOM  ${String(i).padStart(5)}  CA  ALA A${String(i % 9999).padStart(4)}`.padEnd(79, ' ');
  let text = '';
  for (let i = 1; text.length < length; i++) text += `${line(i)}\n`;
  text = text.slice(0, length);
  if (trailingNewline) return `${text.slice(0, -1)}\n`;
  return text.endsWith('\n') ? `${text.slice(0, -1)}X` : text;
}

/** A `runToolContract` failure — the envelope that carries the declared recovery fill. */
type ContractError = {
  isError?: boolean;
  structuredContent: {
    error: { code: number; data: { reason: string; recovery?: { hint: string } } };
  };
};

const experimentalMeta = (id: string) => ({
  id,
  title: `${id} structure`,
  methods: ['X-RAY DIFFRACTION'],
  organisms: ['Homo sapiens'],
  resolution: 1.74,
  polymerEntities: [],
  ligands: [],
});

/** Run `fn` with the configured batch cap set to `cap`, restoring it after. */
async function withBatchCap<T>(cap: number, fn: () => T): Promise<Awaited<T>> {
  const cfg = getServerConfig();
  const configured = cfg.maxBatchIds;
  cfg.maxBatchIds = cap;
  try {
    return await fn();
  } finally {
    cfg.maxBatchIds = configured;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  // UniProt lists every accession as active unless a test says otherwise.
  resolveAccession.mockImplementation(async (acc: string) => ({
    kind: 'active',
    accession: acc.toUpperCase(),
  }));
  files.reset();
  files.install();
});
afterEach(() => files.restore());

describe('protein_get_structure', () => {
  it('rejects a UniProt accession under source experimental (mixed_id_types)', async () => {
    const input = getStructure.input.parse({ ids: ['P69905'], source: 'experimental' });
    await expect(getStructure.handler(input, ctx())).rejects.toMatchObject({
      data: { reason: 'mixed_id_types' },
    });
  });

  it('throws all_failed (with its declared recovery hint) when no experimental ID resolves', async () => {
    getEntries.mockResolvedValue([]);
    const result = (await runToolContract(getStructure, {
      ids: ['4HHB'],
      source: 'experimental',
    })) as ContractError;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({
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
      organisms: ['Homo sapiens'],
    });
    expect(out.structures[0]).not.toHaveProperty('organism');
    expect(out.failed).toEqual([{ id: '9ZZZ', reason: expect.any(String) }]);
    expect(getEnrichment(c)).toMatchObject({ requested: 2, resolved: 1 });
  });

  it('escapes the unresolved IDs it echoes in the partial-failure notice', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB')]);
    const c = ctx();
    const out = await getStructure.handler(
      getStructure.input.parse({ ids: ['4HHB', '9Z*Z', '[x](y)'], source: 'experimental' }),
      c,
    );
    expect(String(getEnrichment(c).notice)).toContain(
      '2 of 3 IDs did not resolve: 9Z\\*Z, \\[x\\](y).',
    );
    // structuredContent keeps each ID as written.
    expect(out.failed.map((f) => f.id)).toEqual(['9Z*Z', '[x](y)']);
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
      organisms: ['Homo sapiens'],
    });
    expect(out.structures[0]).not.toHaveProperty('organism');
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
    expect(out.failed[0]?.reason).not.toMatch(/has no model for/);
    expect(out.failed[0]?.reason).toMatch(/UniProt accession/i);
    // Only the well-formed accession was worth a round trip.
    expect(getPrediction).toHaveBeenCalledTimes(1);
    expect(getPrediction).toHaveBeenCalledWith('P69905', expect.anything());
    expect(getEnrichment(c)).toMatchObject({ requested: 2, resolved: 1 });
  });

  it('a well-formed but unknown accession still reports the upstream-miss reason', async () => {
    // A9ZZZ9 is shape-valid: it reaches AlphaFold, 404s, and degrades per-ID.
    getPrediction.mockResolvedValue(null);
    const result = (await runToolContract(getStructure, {
      ids: ['A9ZZZ9'],
      source: 'predicted',
    })) as ContractError;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({
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
    // The malformed ID never reaches 3D-Beacons; only the accession is looked up.
    expect(getSummary).toHaveBeenCalled();
    expect(getSummary.mock.calls.every(([acc]) => acc === 'P69905')).toBe(true);
  });

  it('collapses over-budget inlined coordinates into an overflow outline', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB'), experimentalMeta('2HHB')]);
    serveAllFiles('A'.repeat(20_000)); // 2 × 20k = 40k > 24k budget
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
      cif: 'https://files/download/2W72.cif',
      pdb: 'https://files/download/2W72.pdb',
      bcif: 'https://models/2W72.bcif',
    });
    const experimental = await getStructure.handler(
      getStructure.input.parse({ ids: ['2W72'], source: 'experimental' }),
      ctx(),
    );
    expect(rec?.coordinateUrls).toEqual(experimental.structures[0]?.coordinateUrls);
    // Experimental pick reports no predicted-confidence fields.
    expect(rec?.meanPlddt).toBeUndefined();
    expect(rec?.confidence).toBeUndefined();
  });
});

/** AlphaFold DB's P69905 record, trimmed to what the tool reads. */
const AF_P69905 = {
  uniprotAccession: 'P69905',
  entryId: 'AF-P69905-F1',
  meanPlddt: 98.1,
  cifUrl: 'https://alphafold.ebi.ac.uk/files/AF-P69905-F1-model_v6.cif',
};

/** A PDBe model as the 3D-Beacons service normalizes it. */
const pdbeModel = (id: string) => ({
  modelIdentifier: id,
  modelCategory: 'EXPERIMENTALLY DETERMINED',
  provider: 'PDBe',
  modelUrl: `https://www.ebi.ac.uk/pdbe/static/entry/${id}_updated.cif`,
  coverage: 0.993,
  uniprotStart: 2,
  uniprotEnd: 142,
  resolution: 1.07,
  experimentalMethod: 'X-RAY DIFFRACTION',
});

/** A SWISS-MODEL model as the 3D-Beacons service normalizes it. */
const swissModel = (id: string) => ({
  modelIdentifier: id,
  modelCategory: 'TEMPLATE-BASED',
  provider: 'SWISS-MODEL',
  modelUrl: `https://swissmodel.test/${id}.cif`,
  coverage: 1,
  confidenceType: 'QMEANDisCo',
  confidenceAvgLocalScore: 0.65,
});

/**
 * Answer the federated summary per requested accession (`[answeredFor, models]`,
 * `null` for 3D-Beacons' 404), and the PDBe-only confirm with a 404.
 */
function serveFederated(byAccession: Record<string, [string, unknown[]] | null>): void {
  getSummary.mockImplementation(async (acc: string, _ctx: unknown, provider?: string) => {
    const entry = provider === 'pdbe' ? null : (byAccession[acc] ?? null);
    return entry
      ? { accession: entry[0], found: entry[1].length > 0, models: entry[1] }
      : { accession: acc, found: false, models: [] };
  });
}

describe('protein_get_structure isoform accessions (#91)', () => {
  /** AlphaFold DB's record for p53 isoform 2, as both of its keys return it. */
  const AF_P04637_2 = {
    uniprotAccession: 'P04637-2',
    entryId: 'AF-P04637-2-F1',
    meanPlddt: 76.94,
    cifUrl: 'https://alphafold.ebi.ac.uk/files/AF-P04637-2-F1-model_v6.cif',
    pdbUrl: 'https://alphafold.ebi.ac.uk/files/AF-P04637-2-F1-model_v6.pdb',
  };
  /** 3D-Beacons' isoform models for P04637-2: AlphaFold DB, and an unscored isoform.io model. */
  const ISOFORM_MODELS = [
    {
      modelIdentifier: 'CHS.21217.7',
      modelCategory: 'AB-INITIO',
      provider: 'isoform.io',
      modelUrl: 'https://isoform.test/CHS.21217.7.pdb',
      coverage: 1,
    },
    {
      modelIdentifier: 'AF-P04637-2-F1',
      modelCategory: 'AB-INITIO',
      provider: 'AlphaFold DB',
      modelUrl: AF_P04637_2.cifUrl,
      coverage: 1,
      confidenceType: 'pLDDT',
      confidenceAvgLocalScore: 76.94,
    },
  ];

  it('resolves an isoform accession and an isoform entry ID under predicted to the isoform model', async () => {
    getPrediction.mockImplementation(async (id: string) =>
      ['P04637-2', 'AF-P04637-2-F1'].includes(id.toUpperCase()) ? AF_P04637_2 : null,
    );
    const out = await getStructure.handler(
      getStructure.input.parse({ ids: ['P04637-2', 'AF-P04637-2-F1'], source: 'predicted' }),
      ctx(),
    );

    expect(out.failed).toEqual([]);
    expect(out.structures).toHaveLength(2);
    for (const rec of out.structures) {
      expect(rec).toMatchObject({
        id: 'P04637-2',
        source: 'predicted',
        meanPlddt: 76.94,
        coordinateUrls: { cif: AF_P04637_2.cifUrl },
      });
    }
    expect(getPrediction.mock.calls.map(([id]) => id)).toEqual(['P04637-2', 'AF-P04637-2-F1']);
    // AlphaFold DB answered under the requested key, so UniProt is never asked.
    expect(resolveAccession).not.toHaveBeenCalled();
  });

  it.each([['P04637-2'], ['AF-P04637-2-F1']])(
    'best_available queries 3D-Beacons as P04637-2 for %s and picks AF-P04637-2-F1',
    async (id) => {
      serveFederated({ 'P04637-2': ['P04637-2', ISOFORM_MODELS] });
      const out = await getStructure.handler(
        getStructure.input.parse({ ids: [id], source: 'best_available' }),
        ctx(),
      );

      expect(out.failed).toEqual([]);
      expect(out.structures[0]).toMatchObject({
        id: 'P04637-2',
        source: 'predicted',
        provider: 'AlphaFold DB',
        coordinateUrls: { cif: AF_P04637_2.cifUrl },
      });
      expect(getSummary.mock.calls.length).toBeGreaterThan(0);
      expect(getSummary.mock.calls.every(([acc]) => acc === 'P04637-2')).toBe(true);
    },
  );

  it('best_available answers an AlphaFold DB entry ID with the same pick as its accession', async () => {
    // 3D-Beacons reads AF-P69905-F1 as its own key and returns only an AlphaFill model.
    serveFederated({
      P69905: ['P69905', [pdbeModel('2w72')]],
      'AF-P69905-F1': [
        'P69905',
        [
          {
            modelIdentifier: 'P69905',
            modelCategory: 'TEMPLATE-BASED',
            provider: 'AlphaFill',
            modelUrl: 'https://alphafill.eu/v1/aff/P69905',
            coverage: 1,
          },
        ],
      ],
    });
    getEntries.mockResolvedValue([experimentalMeta('2W72')]);
    const run = async (id: string) =>
      getStructure.handler(
        getStructure.input.parse({ ids: [id], source: 'best_available' }),
        ctx(),
      );

    const viaEntryId = await run('AF-P69905-F1');
    const viaAccession = await run('P69905');
    expect(viaEntryId.structures[0]).toMatchObject({
      id: 'P69905',
      pdbId: '2W72',
      provider: 'PDBe',
    });
    expect(viaEntryId).toEqual(viaAccession);
    expect(getSummary.mock.calls.some(([acc]) => acc === 'AF-P69905-F1')).toBe(false);
  });

  it.each(['predicted', 'best_available'] as const)(
    'fails malformed isoform forms per ID under %s with no upstream call',
    async (source) => {
      getPrediction.mockResolvedValue(AF_P69905);
      serveFederated({ P69905: ['P69905', [pdbeModel('2w72')]] });
      getEntries.mockResolvedValue([experimentalMeta('2W72')]);
      const out = await getStructure.handler(
        getStructure.input.parse({
          ids: ['P69905', 'P04637-0', 'P04637-02', 'P04637-2-F1'],
          source,
        }),
        ctx(),
      );

      expect(out.structures.map((s) => s.id)).toEqual(['P69905']);
      expect(out.failed.map((f) => f.id)).toEqual(['P04637-0', 'P04637-02', 'P04637-2-F1']);
      for (const f of out.failed) expect(f.reason).toMatch(/^Not a UniProt accession/);
      const upstreamKeys = [...getPrediction.mock.calls, ...getSummary.mock.calls].map(([k]) => k);
      expect(upstreamKeys.length).toBeGreaterThan(0);
      expect(upstreamKeys.every((k) => k === 'P69905')).toBe(true);
      expect(resolveAccession).not.toHaveBeenCalled();
    },
  );

  it('fails well-formed isoforms with no model per ID, naming the bare accession for isoform 1', async () => {
    getPrediction.mockImplementation(async (id: string) => (id === 'P69905' ? AF_P69905 : null));
    // UniProt knows Q8WZ42-2 and P04637-1, but not P04637-99 or P69905-2.
    resolveAccession.mockImplementation(async (acc: string) =>
      ['P04637-99', 'P69905-2'].includes(acc)
        ? { kind: 'unknown', accession: acc }
        : { kind: 'active', accession: acc },
    );
    const out = await getStructure.handler(
      getStructure.input.parse({
        ids: ['P69905', 'Q8WZ42-2', 'P04637-99', 'P69905-2', 'P04637-1'],
        source: 'predicted',
      }),
      ctx(),
    );

    expect(out.structures.map((s) => s.id)).toEqual(['P69905']);
    expect(out.failed).toEqual([
      { id: 'Q8WZ42-2', reason: 'AlphaFold DB has no model for Q8WZ42-2.' },
      {
        id: 'P04637-99',
        reason: 'UniProtKB has no entry for P04637-99, and AlphaFold DB has no model for it.',
      },
      {
        id: 'P69905-2',
        reason: 'UniProtKB has no entry for P69905-2, and AlphaFold DB has no model for it.',
      },
      { id: 'P04637-1', reason: expect.stringContaining('request P04637.') },
    ]);
    expect(out.failed[3]?.reason).toMatch(/^AlphaFold DB has no model for P04637-1\./);
  });

  it('rejects an isoform accession under source experimental with mixed_id_types', async () => {
    getEntries.mockResolvedValue([]);
    await expect(
      getStructure.handler(
        getStructure.input.parse({ ids: ['P04637-2'], source: 'experimental' }),
        ctx(),
      ),
    ).rejects.toMatchObject({ data: { reason: 'mixed_id_types' } });
    expect(getEntries).not.toHaveBeenCalled();
  });

  it('names isoform accessions and entry IDs in the ids description and the tool description', () => {
    expect(getStructure.input.shape.ids.description).toContain('P04637-2');
    expect(getStructure.input.shape.ids.description).toContain('AF-P04637-2-F1');
    expect(getStructure.description).toContain('isoform accessions (P04637-2)');
  });
});

describe('protein_get_structure inactive accessions (#83)', () => {
  const BATCH = ['P69905', 'P62988', 'Q1HDT5', 'A0A008APQ8'];
  const DEMERGED_INTO = ['P0CG47', 'P0CG48', 'P62979', 'P62987'];
  /** UniProt's verdicts: P62988 demerged, Q1HDT5 merged into P69905, A0A008APQ8 deleted. */
  const STATUS: Record<string, unknown> = {
    P62988: {
      kind: 'inactive',
      accession: 'P62988',
      inactiveReason: 'DEMERGED',
      replacements: DEMERGED_INTO,
    },
    Q1HDT5: { kind: 'merged', accession: 'Q1HDT5', successor: 'P69905' },
    A0A008APQ8: {
      kind: 'inactive',
      accession: 'A0A008APQ8',
      inactiveReason: 'DELETED',
      deletedReason: 'Not part of a reference proteome',
      replacements: [],
    },
  };
  const MERGE_NOTICE = 'Q1HDT5 was merged into P69905 in UniProtKB; this answer is for P69905.';
  const noticeOf = (c: ReturnType<typeof ctx>) => String(getEnrichment(c).notice ?? '');
  const resolvedFor = () => resolveAccession.mock.calls.map(([acc]) => acc).toSorted();

  beforeEach(() => {
    resolveAccession.mockImplementation(
      async (acc: string) => STATUS[acc] ?? { kind: 'active', accession: acc },
    );
  });

  /** The failed[] rows the inactive accessions in BATCH produce, on either source. */
  const expectInactiveRows = (failed: Array<{ id: string; reason: string }>) => {
    expect(failed.map((f) => f.id)).toEqual(['P62988', 'A0A008APQ8']);
    expect(failed[0]?.reason).toContain('DEMERGED');
    expect(failed[0]?.reason).toContain(DEMERGED_INTO.join(', '));
    expect(failed[1]?.reason).toContain('DELETED');
    expect(failed[1]?.reason).toContain('Not part of a reference proteome');
    expect(failed[1]?.reason).toContain('no replacement');
  };

  it('predicted: follows a merge to the successor with a notice, and fails inactive accessions per ID', async () => {
    getPrediction.mockImplementation(async (id: string) => (id === 'P69905' ? AF_P69905 : null));
    const c = ctx();
    const out = await getStructure.handler(
      getStructure.input.parse({ ids: BATCH, source: 'predicted' }),
      c,
    );

    expect(out.structures.map((s) => s.id)).toEqual(['P69905', 'P69905']);
    expect(out.structures[1]).toMatchObject({ coordinateUrls: { cif: AF_P69905.cifUrl } });
    expectInactiveRows(out.failed);
    expect(noticeOf(c)).toContain(MERGE_NOTICE);
    // P69905 answered under its own key, so only the misses reach UniProt.
    expect(resolvedFor()).toEqual(['A0A008APQ8', 'P62988', 'Q1HDT5']);
  });

  it('best_available: never keys a record to an accession the caller did not ask for', async () => {
    serveFederated({
      P69905: ['P69905', [pdbeModel('2w72')]],
      // 3D-Beacons answers the demerged accession for one of its replacements…
      P62988: ['P62987', [swissModel('P62987_1')]],
      // …and the merged one for its successor, with a lesser model than P69905's own.
      Q1HDT5: ['P69905', [swissModel('P69905_1')]],
      A0A008APQ8: null,
    });
    getEntries.mockResolvedValue([experimentalMeta('2W72')]);
    const c = ctx();
    const out = await getStructure.handler(
      getStructure.input.parse({ ids: BATCH, source: 'best_available' }),
      c,
    );

    expect(out.structures.map((s) => s.id)).toEqual(['P69905', 'P69905']);
    // The merged accession gets the successor's own pick, not the SWISS-MODEL answer.
    for (const rec of out.structures)
      expect(rec).toMatchObject({ pdbId: '2W72', provider: 'PDBe' });
    expect(out.structures.some((s) => s.id === 'P62987')).toBe(false);
    expectInactiveRows(out.failed);
    expect(noticeOf(c)).toContain(MERGE_NOTICE);
    expect(resolvedFor()).toEqual(['A0A008APQ8', 'P62988', 'Q1HDT5']);
    // An inactive accession is settled by UniProt; no PDBe confirm is spent on it.
    expect(getSummary.mock.calls.some(([acc, , p]) => acc === 'A0A008APQ8' && p === 'pdbe')).toBe(
      false,
    );
  });

  it('keeps a lone inactive accession’s replacements in all_failed data.failed', async () => {
    serveFederated({ P62988: ['P62987', [swissModel('P62987_1')]] });
    const result = (await runToolContract(getStructure, {
      ids: ['P62988'],
      source: 'best_available',
    })) as {
      isError?: boolean;
      structuredContent: {
        error: {
          message: string;
          data: { reason: string; failed?: Array<{ id: string; reason: string }> };
        };
      };
    };

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent;
    expect(error.data).toMatchObject({ reason: 'all_failed', failed: [{ id: 'P62988' }] });
    expect(error.data.failed?.[0]?.reason).toContain(DEMERGED_INTO.join(', '));
    expect(error.message).toContain(DEMERGED_INTO.join(', '));
  });

  it('fails an active accession whose 3D-Beacons answer is keyed to another accession', async () => {
    serveFederated({
      P69905: ['P69905', [pdbeModel('2w72')]],
      P12345: ['P99999', [swissModel('P99999_1')]],
    });
    getEntries.mockResolvedValue([experimentalMeta('2W72')]);
    const out = await getStructure.handler(
      getStructure.input.parse({ ids: ['P69905', 'P12345'], source: 'best_available' }),
      ctx(),
    );

    expect(out.structures.map((s) => s.id)).toEqual(['P69905']);
    expect(out.failed).toEqual([
      {
        id: 'P12345',
        reason: '3D-Beacons answered P12345 with models for P99999, none keyed to P12345.',
      },
    ]);
  });
});

describe('protein_get_structure best_available selection (#90)', () => {
  /** A PDBe model as the 3D-Beacons service normalizes it; no resolution reads as NMR. */
  const pdbe = (
    id: string,
    coverage: number,
    resolution: number | undefined,
    span: [number, number],
  ) => ({
    modelIdentifier: id,
    modelCategory: 'EXPERIMENTALLY DETERMINED',
    provider: 'PDBe',
    modelUrl: `https://www.ebi.ac.uk/pdbe/static/entry/${id}_updated.cif`,
    coverage,
    uniprotStart: span[0],
    uniprotEnd: span[1],
    ...(resolution === undefined
      ? { experimentalMethod: 'SOLUTION NMR' }
      : { resolution, experimentalMethod: 'X-RAY DIFFRACTION' }),
  });
  /** SASBDB 4545: a SAXS fit of the P0DTC2 RBD, numeric ID that is PDB-ID shaped. */
  const SASBDB_4545 = {
    modelIdentifier: '4545',
    modelCategory: 'EXPERIMENTALLY DETERMINED',
    provider: 'SASBDB',
    modelUrl: 'https://www.sasbdb.org/media/pdb_file/SASDJG4_fit1_model1.pdb',
    coverage: 0.95,
    uniprotStart: 319,
    uniprotEnd: 566,
  };
  const predicted = (
    id: string,
    provider: string,
    confidenceType: string | undefined,
    score: number | undefined,
  ) => ({
    modelIdentifier: id,
    modelCategory: provider === 'SWISS-MODEL' ? 'TEMPLATE-BASED' : 'AB-INITIO',
    provider,
    modelUrl: `https://${provider.toLowerCase().replace(/\W/g, '')}.test/${id}.cif`,
    coverage: 1,
    uniprotStart: 1,
    uniprotEnd: 100,
    ...(confidenceType ? { confidenceType } : {}),
    ...(score === undefined ? {} : { confidenceAvgLocalScore: score }),
  });
  type Model = ReturnType<typeof pdbe> | typeof SASBDB_4545 | ReturnType<typeof predicted>;

  /**
   * Serve the federated summary, and the PDBe-only summary (`provider` 'pdbe'):
   * `null` there is 3D-Beacons' 404 for an accession PDBe holds nothing for.
   */
  function serveSummaries(accession: string, federated: Model[], pdbeOnly: Model[] | null = null) {
    getSummary.mockImplementation(async (_acc: string, _ctx: unknown, provider?: string) => {
      if (provider === 'pdbe') {
        return pdbeOnly
          ? { accession, found: true, models: pdbeOnly }
          : { accession, found: false, models: [] };
      }
      return { accession, found: federated.length > 0, models: federated };
    });
  }

  const pick = async (accession: string) =>
    (
      await getStructure.handler(
        getStructure.input.parse({ ids: [accession], source: 'best_available' }),
        ctx(),
      )
    ).structures[0];

  /** PDBe models as 3D-Beacons lists them (resolution ascending), trimmed from 2026-11-03 summaries. */
  const LIVE: Array<[string, Model[], string]> = [
    [
      'P04637',
      [
        pdbe('9c5s', 0.036, 1.01, [17, 30]),
        pdbe('9r2q', 1, 3.2, [1, 393]),
        pdbe('9u4d', 1, 3.39, [1, 393]),
        predicted('AF-P04637-F1', 'AlphaFold DB', 'pLDDT', 75.06),
      ],
      '9R2Q',
    ],
    [
      'P0DTC2',
      [
        pdbe('7z8o', 0.155, 0.96, [333, 527]),
        pdbe('8cxq', 1, 2.3, [1, 1273]),
        pdbe('7czt', 1, 2.7, [1, 1273]),
      ],
      '8CXQ',
    ],
    [
      'P69905',
      [
        pdbe('2w72', 0.993, 1.07, [2, 142]),
        pdbe('1bab', 1, 1.5, [1, 142]),
        pdbe('1bz1', 1, 1.59, [1, 142]),
      ],
      '1BAB',
    ],
    ['P00698', [pdbe('2vb1', 1, 0.65, [19, 147]), pdbe('8zst', 1, 0.8, [19, 147])], '2VB1'],
  ];

  it.each(LIVE)(
    '%s picks the widest-coverage PDB entry, then the finest resolution',
    async (acc, models, expected) => {
      for (const order of [models, [...models].reverse()]) {
        getEntries.mockResolvedValue([experimentalMeta(expected)]);
        serveSummaries(acc, order);
        const rec = await pick(acc);
        expect(rec).toMatchObject({
          id: acc,
          source: 'experimental',
          pdbId: expected,
          provider: 'PDBe',
        });
      }
    },
  );

  it('ranks equal coverage by resolution, and a model without one (NMR) after any with one', async () => {
    getEntries.mockResolvedValue([]);
    const models = [
      pdbe('2nmr', 1, undefined, [1, 100]),
      pdbe('3abc', 1, 2.0, [1, 100]),
      pdbe('1xyz', 1, 1.5, [1, 100]),
    ];
    for (const order of [models, [...models].reverse()]) {
      serveSummaries('P11111', order);
      expect((await pick('P11111'))?.pdbId).toBe('1XYZ');
    }
    // With only the NMR entry and one resolved entry left, the resolved one still wins.
    for (const order of [models.slice(0, 2), models.slice(0, 2).reverse()]) {
      serveSummaries('P11111', order);
      expect((await pick('P11111'))?.pdbId).toBe('3ABC');
    }
  });

  it('breaks a full coverage-and-resolution tie on the model identifier', async () => {
    getEntries.mockResolvedValue([]);
    const models = [pdbe('5bbb', 1, 2, [1, 100]), pdbe('5aaa', 1, 2, [1, 100])];
    for (const order of [models, [...models].reverse()]) {
      serveSummaries('P11111', order);
      expect((await pick('P11111'))?.pdbId).toBe('5AAA');
    }
  });

  it('makes no PDBe-only request when the federated summary carries a PDBe model', async () => {
    serveSummaries('P69905', [pdbe('1bab', 1, 1.5, [1, 142])]);
    getEntries.mockResolvedValue([experimentalMeta('1BAB')]);
    await pick('P69905');

    expect(getSummary).toHaveBeenCalledTimes(1);
    expect(getSummary.mock.calls[0]?.[2]).toBeUndefined();
  });

  it('confirms with a PDBe-only request when the federated summary has no PDBe model, and picks from it', async () => {
    // A federated response that arrived without PDBe's models (live P0DTC2 shape).
    serveSummaries(
      'P0DTC2',
      [predicted('P0DTC2_14-1147:7mjm.1.C', 'SWISS-MODEL', 'QMEANDisCo', 0.772), SASBDB_4545],
      [pdbe('7z8o', 0.155, 0.96, [333, 527]), pdbe('8cxq', 1, 2.3, [1, 1273])],
    );
    getEntries.mockResolvedValue([experimentalMeta('8CXQ')]);
    const rec = await pick('P0DTC2');

    expect(getSummary).toHaveBeenCalledTimes(2);
    expect(getSummary.mock.calls[1]?.[2]).toBe('pdbe');
    expect(rec).toMatchObject({ source: 'experimental', pdbId: '8CXQ', provider: 'PDBe' });
  });

  it('keeps the federated ranking with a notice when the PDBe-only confirm fails', async () => {
    const federated = [
      predicted('P0DTC2_14-1147:7mjm.1.C', 'SWISS-MODEL', 'QMEANDisCo', 0.772),
      SASBDB_4545,
    ];
    getSummary.mockImplementation(async (_acc: string, _ctx: unknown, provider?: string) => {
      if (provider === 'pdbe') throw new Error('3D-Beacons returned HTTP 503 for P0DTC2');
      return { accession: 'P0DTC2', found: true, models: federated };
    });
    const result = (await runToolContract(getStructure, {
      ids: ['P0DTC2'],
      source: 'best_available',
    })) as {
      isError?: boolean;
      structuredContent: { structures: Array<Record<string, unknown>>; notice?: string };
      content: Array<{ text: string }>;
    };

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.structures[0]).toMatchObject({
      id: 'P0DTC2',
      provider: 'SWISS-MODEL',
    });
    const unavailable = 'The PDB check for P0DTC2 was unavailable';
    expect(result.structuredContent.notice).toContain(unavailable);
    expect(result.content.map((b) => b.text).join('\n')).toContain(unavailable);
  });

  it('stays cancelled when the caller cancels during the PDBe-only confirm', async () => {
    const caller = new AbortController();
    getSummary.mockImplementation(async (_acc: string, _ctx: unknown, provider?: string) => {
      if (provider !== 'pdbe') {
        return { accession: 'P0DTC2', found: true, models: [SASBDB_4545] };
      }
      caller.abort(new DOMException('cancelled', 'AbortError'));
      throw caller.signal.reason;
    });

    await expect(
      getStructure.handler(
        getStructure.input.parse({ ids: ['P0DTC2'], source: 'best_available' }),
        createMockContext({ errors: getStructure.errors, signal: caller.signal }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('picks a SASBDB model as a non-PDB experimental record when PDBe holds nothing', async () => {
    serveSummaries('P0DTC2', [SASBDB_4545], null);
    const result = (await runToolContract(getStructure, {
      ids: ['P0DTC2'],
      source: 'best_available',
    })) as {
      structuredContent: {
        structures: Array<Record<string, unknown>>;
        attribution: Array<{ source: string }>;
      };
      content: Array<{ text: string }>;
    };

    const rec = result.structuredContent.structures[0];
    expect(rec).toMatchObject({ id: 'P0DTC2', source: 'experimental', provider: 'SASBDB' });
    expect(rec).not.toHaveProperty('pdbId');
    expect(rec?.coordinateUrls).toEqual({ pdb: SASBDB_4545.modelUrl });
    const credited = result.structuredContent.attribution.map((a) => a.source);
    expect(credited).toContain('SASBDB');
    expect(credited).not.toContain('RCSB PDB');
    // No RCSB lookup for an ID that is not a PDB entry.
    expect(getEntries).not.toHaveBeenCalled();
    const text = result.content.map((b) => b.text).join('\n');
    expect(text).not.toContain('**PDB:**');
    expect(text).toContain('**SASBDB**');
  });

  it('prefers a scored prediction over an unscored SASBDB model when PDBe holds nothing', async () => {
    const models = [SASBDB_4545, predicted('AF-0000000365840314', 'AlphaFold DB', 'pLDDT', 67.14)];
    for (const order of [models, [...models].reverse()]) {
      serveSummaries('P0DTC2', order, null);
      expect(await pick('P0DTC2')).toMatchObject({
        source: 'predicted',
        provider: 'AlphaFold DB',
      });
    }
  });

  it('ranks predictions on one lDDT scale: pLDDT/100 against QMEANDisCo, unscored last', async () => {
    const swiss = predicted('sm-1', 'SWISS-MODEL', 'QMEANDisCo', 0.85);
    const unscored = predicted('fill-1', 'AlphaFill', undefined, undefined);
    const cases: Array<[Model[], string]> = [
      [[unscored, predicted('af-70', 'AlphaFold DB', 'pLDDT', 70), swiss], 'sm-1'],
      [[unscored, swiss, predicted('af-90', 'AlphaFold DB', 'pLDDT', 90)], 'af-90'],
    ];
    for (const [models, expected] of cases) {
      for (const order of [models, [...models].reverse()]) {
        serveSummaries('P22222', order, null);
        const rec = await pick('P22222');
        expect(rec?.coordinateUrls).toEqual({ cif: expect.stringContaining(`/${expected}.cif`) });
      }
    }
    // The record keeps the native value and names its metric.
    serveSummaries(
      'P22222',
      [unscored, swiss, predicted('af-70', 'AlphaFold DB', 'pLDDT', 70)],
      null,
    );
    expect(await pick('P22222')).toMatchObject({ confidence: 0.85, confidenceType: 'QMEANDisCo' });
    // An unscored model is still picked when nothing else is offered.
    serveSummaries('P22222', [unscored], null);
    expect(await pick('P22222')).toMatchObject({ provider: 'AlphaFill' });
  });

  it('carries coverage, uniprotStart, and uniprotEnd on both surfaces for experimental and predicted picks', async () => {
    getEntries.mockResolvedValue([experimentalMeta('9R2Q')]);
    getSummary.mockImplementation(async (acc: string, _ctx: unknown, provider?: string) =>
      acc === 'P04637'
        ? { accession: 'P04637', found: true, models: [pdbe('9r2q', 1, 3.2, [1, 393])] }
        : provider === 'pdbe'
          ? { accession: acc, found: false, models: [] }
          : {
              accession: acc,
              found: true,
              models: [
                {
                  ...predicted('sm-1', 'SWISS-MODEL', 'QMEANDisCo', 0.63),
                  coverage: 0.144,
                  uniprotStart: 2390,
                  uniprotEnd: 2821,
                },
              ],
            },
    );
    const result = (await runToolContract(getStructure, {
      ids: ['P04637', 'Q6ZS81'],
      source: 'best_available',
    })) as {
      structuredContent: { structures: Array<Record<string, unknown>> };
      content: Array<{ text: string }>;
    };

    const [exp, pred] = result.structuredContent.structures;
    expect(exp).toMatchObject({
      source: 'experimental',
      coverage: 1,
      uniprotStart: 1,
      uniprotEnd: 393,
    });
    expect(pred).toMatchObject({
      source: 'predicted',
      coverage: 0.144,
      uniprotStart: 2390,
      uniprotEnd: 2821,
    });
    const text = result.content.map((b) => b.text).join('\n');
    expect(text).toContain('**Coverage:** 1');
    expect(text).toContain('**UniProt span:** 1–393');
    expect(text).toContain('**Coverage:** 0.144');
    expect(text).toContain('**UniProt span:** 2390–2821');
  });

  it('leaves coverage and the UniProt span off source experimental and predicted records', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB')]);
    getPrediction.mockResolvedValue({
      uniprotAccession: 'P69905',
      meanPlddt: 98,
      cifUrl: 'https://af/cif',
    });
    const experimental = await getStructure.handler(
      getStructure.input.parse({ ids: ['4HHB'], source: 'experimental' }),
      ctx(),
    );
    const prediction = await getStructure.handler(
      getStructure.input.parse({ ids: ['P69905'], source: 'predicted' }),
      ctx(),
    );
    for (const rec of [experimental.structures[0], prediction.structures[0]]) {
      expect(rec).not.toHaveProperty('coverage');
      expect(rec).not.toHaveProperty('uniprotStart');
      expect(rec).not.toHaveProperty('uniprotEnd');
    }
  });
});

/** The failed[] reason for an ID whose upstream lookup failed (not a missing entry). */
const UPSTREAM_REASON =
  'An upstream lookup for this ID failed, so it is not known to lack a structure — re-call with this ID.';

/** The error a provider read fails with for an HTTP status, as the shared HTTP layer builds it. */
const statusError = (status: number, service: string) =>
  httpErrorFromResponse(new Response(`HTTP ${status} from ${service}`, { status }), { service });

describe('protein_get_structure call budget', () => {
  /** The call budget `withCallBudget` holds every call to. */
  const BUDGET_MS = 50_000;
  const BUDGET_REASON =
    "Not finished within this call's upstream time budget — re-call with this ID.";

  /** A request that never answers: it rejects only once its signal aborts. */
  const untilAborted = (c: { signal: AbortSignal }) =>
    new Promise<never>((_, reject) => {
      c.signal.addEventListener('abort', () => reject(c.signal.reason), { once: true });
    });

  /** Start a handler call and expose whether it has settled. */
  function track<T>(running: T) {
    const state = { settled: false };
    const done = Promise.resolve(running).finally(() => {
      state.settled = true;
    });
    // The settled promise is awaited by each test; this guard only keeps an
    // early rejection from surfacing as unhandled before that.
    done.catch(() => undefined);
    return { state, done };
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('settles at the budget with the finished IDs, listing the stopped ones in failed[]', async () => {
    getSummary.mockImplementation(async (acc: string, c: { signal: AbortSignal }) =>
      acc === 'P69905'
        ? { accession: 'P69905', found: true, models: [pdbeModel('2w72')] }
        : untilAborted(c),
    );
    getEntries.mockResolvedValue([experimentalMeta('2W72')]);
    const c = ctx();
    const call = track(
      getStructure.handler(
        getStructure.input.parse({ ids: ['P69905', 'P04637', 'P38398'], source: 'best_available' }),
        c,
      ),
    );

    await vi.advanceTimersByTimeAsync(BUDGET_MS - 1);
    expect(call.state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.state.settled).toBe(true);

    const out = await call.done;
    expect(out.structures.map((s) => s.id)).toEqual(['P69905']);
    expect(out.failed).toEqual([
      { id: 'P04637', reason: BUDGET_REASON },
      { id: 'P38398', reason: BUDGET_REASON },
    ]);
    expect(String(getEnrichment(c).notice)).toContain(
      '2 of 3 IDs did not resolve: P04637, P38398.',
    );
  });

  it('fails upstream_unavailable (retryable) with the stopped IDs in data.failed when none finished, on both surfaces', async () => {
    getPrediction.mockImplementation(async (_id: string, c: { signal: AbortSignal }) =>
      untilAborted(c),
    );
    const call = track(runToolContract(getStructure, { ids: ['P69905'], source: 'predicted' }));

    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    expect(call.state.settled).toBe(true);
    const result = (await call.done) as {
      isError?: boolean;
      structuredContent: {
        error: {
          code: number;
          data: {
            reason: string;
            retryable?: boolean;
            failed?: Array<{ id: string; reason: string }>;
            recovery?: { hint: string };
          };
        };
      };
      content: Array<{ type: string; text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({
      code: -32000,
      data: {
        reason: 'upstream_unavailable',
        retryable: true,
        failed: [{ id: 'P69905', reason: BUDGET_REASON }],
        recovery: { hint: expect.stringContaining('fewer per call') },
      },
    });
    const text = result.content.map((b) => b.text).join('\n');
    expect(text).toContain(`P69905: ${BUDGET_REASON}`);
    expect(text).toContain('(reason upstream_unavailable · retryable');
  });

  it('fails all_failed when one ID has no model and the budget stopped the rest', async () => {
    getPrediction.mockImplementation(async (id: string, c: { signal: AbortSignal }) =>
      id === 'P04637' ? null : untilAborted(c),
    );
    const call = track(
      getStructure.handler(
        getStructure.input.parse({ ids: ['P04637', 'P38398'], source: 'predicted' }),
        ctx(),
      ),
    );

    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    expect(call.state.settled).toBe(true);
    await expect(call.done).rejects.toMatchObject({
      code: -32001,
      data: {
        reason: 'all_failed',
        failed: [
          { id: 'P04637', reason: 'AlphaFold DB has no model for P04637.' },
          { id: 'P38398', reason: BUDGET_REASON },
        ],
      },
    });
  });

  it('fails upstream_unavailable when the IDs that did not fail upstream were stopped by the budget', async () => {
    getPrediction.mockImplementation(async (id: string, c: { signal: AbortSignal }) => {
      if (id === 'P04637') throw await statusError(503, 'AlphaFold DB');
      return untilAborted(c);
    });
    const call = track(
      getStructure.handler(
        getStructure.input.parse({ ids: ['P04637', 'P38398'], source: 'predicted' }),
        ctx(),
      ),
    );

    await vi.advanceTimersByTimeAsync(BUDGET_MS - 1);
    expect(call.state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.state.settled).toBe(true);
    await expect(call.done).rejects.toMatchObject({
      code: -32000,
      data: {
        reason: 'upstream_unavailable',
        retryable: true,
        failed: [
          { id: 'P04637', reason: UPSTREAM_REASON },
          { id: 'P38398', reason: BUDGET_REASON },
        ],
      },
    });
  });

  it('stays cancelled when the caller cancels after another ID failed upstream', async () => {
    const caller = new AbortController();
    getPrediction.mockResolvedValue(null);
    resolveAccession.mockImplementation(async (acc: string, c: { signal: AbortSignal }) => {
      if (acc === 'P04637') throw await statusError(503, 'UniProt');
      return untilAborted(c);
    });
    const call = track(
      getStructure.handler(
        getStructure.input.parse({ ids: ['P04637', 'P38398'], source: 'predicted' }),
        createMockContext({ errors: getStructure.errors, signal: caller.signal }),
      ),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(call.state.settled).toBe(false);
    caller.abort(new DOMException('cancelled', 'AbortError'));
    await expect(call.done).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('stays cancelled when the caller cancels before the budget', async () => {
    const caller = new AbortController();
    getSummary.mockImplementation(async (_acc: string, c: { signal: AbortSignal }) =>
      untilAborted(c),
    );
    const call = track(
      getStructure.handler(
        getStructure.input.parse({ ids: ['P69905'], source: 'best_available' }),
        createMockContext({ errors: getStructure.errors, signal: caller.signal }),
      ),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    caller.abort(new DOMException('cancelled', 'AbortError'));
    await expect(call.done).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('degrades a computed model’s provider lookup the budget stopped, but rethrows a caller’s cancellation', async () => {
    const afCsm = {
      id: 'AF_AFP69905F1',
      computedModelProvider: 'AlphaFold DB',
      computedModelEntryId: 'AF-P69905-F1',
      organisms: [],
      polymerEntities: [],
      ligands: [],
    };
    getEntries.mockResolvedValue([afCsm]);
    getPrediction.mockImplementation(async (_id: string, c: { signal: AbortSignal }) =>
      untilAborted(c),
    );
    const input = getStructure.input.parse({ ids: ['AF_AFP69905F1'], source: 'experimental' });

    const c = ctx();
    const stopped = track(getStructure.handler(input, c));
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    const out = await stopped.done;
    expect(out.structures[0]?.coordinateUrls).toEqual({
      bcif: expect.stringContaining('AF_AFP69905F1'),
    });
    expect(String(getEnrichment(c).notice)).toContain(
      'AlphaFold DB coordinate lookup did not resolve for AF_AFP69905F1',
    );

    const caller = new AbortController();
    const cancelled = track(
      getStructure.handler(
        input,
        createMockContext({ errors: getStructure.errors, signal: caller.signal }),
      ),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    caller.abort(new DOMException('cancelled', 'AbortError'));
    await expect(cancelled.done).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('protein_get_structure upstream lookup failures', () => {
  type Out = Awaited<ReturnType<typeof getStructure.handler>>;
  type ContractFailure = {
    isError?: boolean;
    structuredContent: {
      error: {
        code: number;
        message: string;
        data: {
          reason: string;
          retryable?: boolean;
          failed?: Array<{ id: string; reason: string }>;
          recovery?: { hint: string };
        };
      };
    };
    content: Array<{ type: string; text: string }>;
  };
  const textOf = (out: Out) => (getStructure.format!(out)[0] as { text: string }).text;

  /** The error the JSON layer raises for an HTML page served in place of JSON. */
  function htmlPageError(label: string): unknown {
    try {
      parseJson('<!DOCTYPE html><html><body>Service Unavailable</body></html>', label);
    } catch (err) {
      return err;
    }
    throw new Error('parseJson accepted an HTML page');
  }

  /** A UniProt read failing for a reason other than a cancellation or the call's budget. */
  const UNIPROT_FAILURES: Array<[string, () => Promise<unknown>]> = [
    ['answers 503', () => statusError(503, 'UniProt')],
    ['answers 429', () => statusError(429, 'UniProt')],
    ['answers 403', () => statusError(403, 'UniProt')],
    ['serves an HTML error page', async () => htmlPageError('UniProt')],
    ['times out one request', async () => timeout('UniProt request timed out after 30000ms.')],
  ];

  /** The 3D-Beacons summary: P69905's PDBe entry, a failure for `failFor`, and a 404 for anything else. */
  function summaryFailingFor(failFor: string, failure: () => Promise<unknown>): void {
    getSummary.mockImplementation(async (acc: string, _c: unknown, provider?: string) => {
      if (acc === failFor) throw await failure();
      return acc === 'P69905' && provider !== 'pdbe'
        ? { accession: 'P69905', found: true, models: [pdbeModel('2w72')] }
        : { accession: acc, found: false, models: [] };
    });
  }

  describe.each(['predicted', 'best_available'] as const)('under %s', (source) => {
    beforeEach(() => {
      // P69905 resolves from the model provider; P04637 misses it, so UniProt is asked.
      getPrediction.mockImplementation(async (id: string) => (id === 'P69905' ? AF_P69905 : null));
      serveFederated({ P69905: ['P69905', [pdbeModel('2w72')]] });
      getEntries.mockResolvedValue([experimentalMeta('2W72')]);
    });

    it.each(UNIPROT_FAILURES)(
      'keeps the batch when UniProt %s for one ID, failing only that row on both surfaces',
      async (_label, failure) => {
        resolveAccession.mockImplementation(async (acc: string) => {
          if (acc === 'P04637') throw await failure();
          return { kind: 'active', accession: acc };
        });
        const c = ctx();
        const out = await getStructure.handler(
          getStructure.input.parse({ ids: ['P69905', 'P04637'], source }),
          c,
        );

        expect(out.structures.map((s) => s.id)).toEqual(['P69905']);
        expect(out.failed).toEqual([{ id: 'P04637', reason: UPSTREAM_REASON }]);
        expect(String(getEnrichment(c).notice)).toContain('1 of 2 IDs did not resolve: P04637.');
        expect(textOf(out)).toContain(`- P04637: ${UPSTREAM_REASON}`);
      },
    );
  });

  it.each([
    [
      'AlphaFold DB fails the model lookup (503)',
      'predicted',
      () => {
        getPrediction.mockImplementation(async (id: string) => {
          if (id === 'P04637') throw await statusError(503, 'AlphaFold DB');
          return AF_P69905;
        });
      },
    ],
    [
      'AlphaFold DB fails the successor lookup after a merge',
      'predicted',
      () => {
        resolveAccession.mockImplementation(async (acc: string) =>
          acc === 'P04637'
            ? { kind: 'merged', accession: 'P04637', successor: 'P99999' }
            : { kind: 'active', accession: acc },
        );
        getPrediction.mockImplementation(async (id: string) => {
          if (id === 'P99999') throw await statusError(502, 'AlphaFold DB');
          return id === 'P69905' ? AF_P69905 : null;
        });
      },
    ],
    [
      '3D-Beacons answers a non-404 status (a plain Error)',
      'best_available',
      () =>
        summaryFailingFor(
          'P04637',
          async () => new Error('3D-Beacons returned HTTP 500 for P04637'),
        ),
    ],
    [
      '3D-Beacons is unreachable (a network TypeError)',
      'best_available',
      () => summaryFailingFor('P04637', async () => new TypeError('fetch failed')),
    ],
    [
      '3D-Beacons fails the successor summary after a merge',
      'best_available',
      () => {
        resolveAccession.mockImplementation(async (acc: string) =>
          acc === 'P04637'
            ? { kind: 'merged', accession: 'P04637', successor: 'P99999' }
            : { kind: 'active', accession: acc },
        );
        summaryFailingFor(
          'P99999',
          async () => new Error('3D-Beacons returned HTTP 502 for P99999'),
        );
      },
    ],
  ] as const)('fails only the row when %s', async (_label, source, arrange) => {
    getEntries.mockResolvedValue([experimentalMeta('2W72')]);
    arrange();
    const c = ctx();
    const out = await getStructure.handler(
      getStructure.input.parse({ ids: ['P69905', 'P04637'], source }),
      c,
    );

    expect(out.structures.map((s) => s.id)).toEqual(['P69905']);
    expect(out.failed).toEqual([{ id: 'P04637', reason: UPSTREAM_REASON }]);
    expect(textOf(out)).toContain(`- P04637: ${UPSTREAM_REASON}`);
  });

  it('fails upstream_unavailable (retryable) with every row in data.failed when each ID failed upstream, on both surfaces', async () => {
    getPrediction.mockImplementation(async () => {
      throw await statusError(503, 'AlphaFold DB');
    });
    const result = (await runToolContract(getStructure, {
      ids: ['P69905', 'P04637'],
      source: 'predicted',
    })) as ContractFailure;

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent;
    expect(error).toMatchObject({
      code: -32000,
      data: {
        reason: 'upstream_unavailable',
        retryable: true,
        failed: [
          { id: 'P69905', reason: UPSTREAM_REASON },
          { id: 'P04637', reason: UPSTREAM_REASON },
        ],
        recovery: { hint: expect.stringContaining('data.failed') },
      },
    });
    expect(error.message).toContain(`P04637: ${UPSTREAM_REASON}`);
    const text = result.content.map((b) => b.text).join('\n');
    expect(text).toContain(`P69905: ${UPSTREAM_REASON}`);
    expect(text).toContain(`P04637: ${UPSTREAM_REASON}`);
    expect(text).toContain('(reason upstream_unavailable · retryable');
  });

  it.each([
    ['an ID with no model', 'P38398'],
    ['a malformed ID', 'P0DOESNOT'],
  ])(
    'fails all_failed, not upstream_unavailable, when %s missed beside an upstream failure',
    async (_label, other) => {
      getPrediction.mockResolvedValue(null);
      resolveAccession.mockImplementation(async (acc: string) => {
        if (acc === 'P04637') throw await statusError(503, 'UniProt');
        return { kind: 'active', accession: acc };
      });
      const result = (await runToolContract(getStructure, {
        ids: ['P04637', other],
        source: 'predicted',
      })) as ContractFailure;

      expect(result.structuredContent.error).toMatchObject({
        code: -32001,
        data: {
          reason: 'all_failed',
          failed: [{ id: 'P04637', reason: UPSTREAM_REASON }, { id: other }],
        },
      });
      expect(result.structuredContent.error.data.failed?.[1]?.reason).not.toBe(UPSTREAM_REASON);
    },
  );
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

describe('protein_get_structure coordinate URL routing (#61)', () => {
  /** The live AlphaFold DB prediction for P69905, trimmed to what the tool reads. */
  const AF_P69905 = {
    uniprotAccession: 'P69905',
    entryId: 'AF-P69905-F1',
    meanPlddt: 98.1,
    cifUrl: 'https://alphafold.ebi.ac.uk/files/AF-P69905-F1-model_v6.cif',
    pdbUrl: 'https://alphafold.ebi.ac.uk/files/AF-P69905-F1-model_v6.pdb',
    bcifUrl: 'https://alphafold.ebi.ac.uk/files/AF-P69905-F1-model_v6.bcif',
  };
  const afCsm = {
    id: 'AF_AFP69905F1',
    computedModelProvider: 'AlphaFold DB',
    computedModelEntryId: 'AF-P69905-F1',
    title: 'Computed structure model of Hemoglobin subunit alpha',
    organisms: ['Homo sapiens'],
    polymerEntities: [],
    ligands: [],
  };
  const maCsm = {
    id: 'MA_MAASFVASFVG001',
    computedModelProvider: 'ModelArchive',
    computedModelEntryId: 'ma-asfv-asfvg-001',
    organisms: [],
    polymerEntities: [],
    ligands: [],
  };
  const noticeOf = (c: ReturnType<typeof ctx>) => String(getEnrichment(c).notice ?? '');

  it('routes BinaryCIF through the model host for an experimental entry', async () => {
    getEntries.mockResolvedValue([{ ...experimentalMeta('4HHB'), pdbFormatCompatible: true }]);
    const out = await getStructure.handler(
      getStructure.input.parse({ ids: ['4HHB'], source: 'experimental' }),
      ctx(),
    );
    expect(out.structures[0]?.coordinateUrls).toEqual({
      cif: 'https://files/download/4HHB.cif',
      pdb: 'https://files/download/4HHB.pdb',
      bcif: 'https://models/4HHB.bcif',
    });
    expect(getPrediction).not.toHaveBeenCalled();
  });

  it('omits the PDB-format URL for an mmCIF-only entry on both surfaces', async () => {
    getEntries.mockResolvedValue([{ ...experimentalMeta('4V6X'), pdbFormatCompatible: false }]);
    const result = (await runToolContract(getStructure, {
      ids: ['4V6X'],
      source: 'experimental',
    })) as {
      structuredContent: { structures: Array<{ coordinateUrls: Record<string, string> }> };
      content: Array<{ text: string }>;
    };
    expect(result.structuredContent.structures[0]?.coordinateUrls).toEqual({
      cif: 'https://files/download/4V6X.cif',
      bcif: 'https://models/4V6X.bcif',
    });
    const text = result.content.map((b) => b.text).join('\n');
    expect(text).toContain(
      '**Coordinates:** [cif](https://files/download/4V6X.cif) · [bcif](https://models/4V6X.bcif)',
    );
    expect(text).not.toContain('[pdb]');
  });

  it('resolves an AlphaFold computed model to the same URLs source predicted returns', async () => {
    getEntries.mockResolvedValue([afCsm]);
    getPrediction.mockResolvedValue(AF_P69905);
    const c = ctx();
    const viaExperimental = await getStructure.handler(
      getStructure.input.parse({ ids: ['AF_AFP69905F1'], source: 'experimental' }),
      c,
    );
    // Keyed on the provider's own entry ID, so a non-F1 fragment resolves to itself.
    expect(getPrediction).toHaveBeenCalledWith('AF-P69905-F1', expect.anything());
    expect(noticeOf(c)).toBe('');

    const viaPredicted = await getStructure.handler(
      getStructure.input.parse({ ids: ['P69905'], source: 'predicted' }),
      ctx(),
    );
    expect(viaExperimental.structures[0]?.coordinateUrls).toEqual({
      cif: AF_P69905.cifUrl,
      pdb: AF_P69905.pdbUrl,
      bcif: AF_P69905.bcifUrl,
    });
    expect(viaExperimental.structures[0]?.coordinateUrls).toEqual(
      viaPredicted.structures[0]?.coordinateUrls,
    );
    // Still the RCSB record: its id, provenance, and credit are unchanged.
    expect(viaExperimental.structures[0]).toMatchObject({
      id: 'AF_AFP69905F1',
      source: 'predicted',
      provider: 'AlphaFold DB',
    });
  });

  it.each([
    [
      'the AlphaFold lookup fails',
      () => getPrediction.mockRejectedValue(new Error('upstream 503')),
    ],
    ['AlphaFold DB has no model', () => getPrediction.mockResolvedValue(null)],
  ])('falls back to the RCSB BinaryCIF URL and discloses it when %s', async (_label, arrange) => {
    getEntries.mockResolvedValue([
      afCsm,
      { ...experimentalMeta('4HHB'), pdbFormatCompatible: true },
    ]);
    arrange();
    const c = ctx();
    const out = await getStructure.handler(
      getStructure.input.parse({ ids: ['AF_AFP69905F1', '4HHB'], source: 'experimental' }),
      c,
    );
    // A failed best-effort lookup never costs the record or its batch-mates.
    expect(out.structures.map((s) => s.id)).toEqual(['AF_AFP69905F1', '4HHB']);
    expect(out.failed).toEqual([]);
    expect(out.structures[0]?.coordinateUrls).toEqual({
      bcif: 'https://models/AF_AFP69905F1.bcif',
    });
    expect(out.structures[1]?.coordinateUrls.pdb).toBe('https://files/download/4HHB.pdb');
    expect(noticeOf(c)).toContain('AF_AFP69905F1');
    expect(noticeOf(c)).toMatch(/AlphaFold DB/);
    expect(noticeOf(c)).toMatch(/BinaryCIF/);
  });

  it('carries the AlphaFold fallback disclosure on both consumption surfaces', async () => {
    getEntries.mockResolvedValue([afCsm]);
    getPrediction.mockResolvedValue(null);
    const result = (await runToolContract(getStructure, {
      ids: ['AF_AFP69905F1'],
      source: 'experimental',
    })) as {
      structuredContent: { notice?: string };
      content: Array<{ type: string; text: string }>;
    };
    const disclosure = 'AlphaFold DB coordinate lookup did not resolve for AF_AFP69905F1';
    expect(result.structuredContent.notice).toContain(disclosure);
    expect(result.content.map((b) => b.text).join('\n')).toContain(disclosure);
  });

  it('derives ModelArchive mmCIF from the provider entry ID, with no extra lookup', async () => {
    getEntries.mockResolvedValue([maCsm]);
    const c = ctx();
    const out = await getStructure.handler(
      getStructure.input.parse({ ids: ['MA_MAASFVASFVG001'], source: 'experimental' }),
      c,
    );
    expect(out.structures[0]?.coordinateUrls).toEqual({
      cif: 'https://modelarchive.org/api/projects/ma-asfv-asfvg-001?type=basic__model_file_name',
      bcif: 'https://models/MA_MAASFVASFVG001.bcif',
    });
    expect(getPrediction).not.toHaveBeenCalled();
    expect(noticeOf(c)).toBe('');
  });

  it('lists only the RCSB BinaryCIF URL for a provider it cannot resolve', async () => {
    getEntries.mockResolvedValue([
      {
        ...maCsm,
        id: 'XX_MODEL1',
        computedModelProvider: 'SomeFutureModelDB',
        computedModelEntryId: 'm-1',
      },
    ]);
    const out = await getStructure.handler(
      getStructure.input.parse({ ids: ['XX_MODEL1'], source: 'experimental' }),
      ctx(),
    );
    expect(out.structures[0]?.coordinateUrls).toEqual({ bcif: 'https://models/XX_MODEL1.bcif' });
    expect(getPrediction).not.toHaveBeenCalled();
  });

  it('inlines an AlphaFold computed model from its resolved mmCIF URL', async () => {
    getEntries.mockResolvedValue([afCsm]);
    getPrediction.mockResolvedValue(AF_P69905);
    serveFiles({ [AF_P69905.cifUrl]: 'data_AF-P69905-F1' });
    const c = ctx();
    const out = await getStructure.handler(
      getStructure.input.parse({
        ids: ['AF_AFP69905F1'],
        source: 'experimental',
        include_coords: true,
      }),
      c,
    );
    expect(fetchedUrls()).toEqual([AF_P69905.cifUrl]);
    expect(out.structures[0]).toMatchObject({
      coordinateFormat: 'cif',
      coordinates: 'data_AF-P69905-F1',
    });
    expect(noticeOf(c)).toBe('');
  });

  it('inlines an mmCIF-only entry from its mmCIF URL, never the absent PDB file', async () => {
    getEntries.mockResolvedValue([{ ...experimentalMeta('4V6X'), pdbFormatCompatible: false }]);
    serveAllFiles('data_4V6X');
    const out = await getStructure.handler(
      getStructure.input.parse({ ids: ['4V6X'], source: 'experimental', include_coords: true }),
      ctx(),
    );
    expect(fetchedUrls()).toEqual(['https://files/download/4V6X.cif']);
    expect(out.structures[0]?.coordinateFormat).toBe('cif');
  });

  it('names a record with no text coordinate format in the inline-failure notice', async () => {
    // BinaryCIF is binary; a record left with only that URL cannot be inlined, and
    // silently skipping it would read as "never asked to inline".
    getEntries.mockResolvedValue([afCsm]);
    getPrediction.mockResolvedValue(null);
    const c = ctx();
    const out = await getStructure.handler(
      getStructure.input.parse({
        ids: ['AF_AFP69905F1'],
        source: 'experimental',
        include_coords: true,
      }),
      c,
    );
    expect(files.calls).toHaveLength(0);
    expect(out.structures[0]?.coordinates).toBeUndefined();
    expect(noticeOf(c)).toContain('Coordinate inlining failed for AF_AFP69905F1');
  });

  it('keeps best_available on the same routing for an mmCIF-only experimental pick', async () => {
    getSummary.mockResolvedValue({
      accession: 'P0DOX5',
      found: true,
      models: [
        {
          modelIdentifier: '4v6x',
          modelCategory: 'EXPERIMENTALLY DETERMINED',
          provider: 'PDBe',
          modelUrl: 'https://www.ebi.ac.uk/pdbe/static/entry/4v6x_updated.cif',
          resolution: 5,
        },
      ],
    });
    getEntries.mockResolvedValue([{ ...experimentalMeta('4V6X'), pdbFormatCompatible: false }]);
    const out = await getStructure.handler(
      getStructure.input.parse({ ids: ['P0DOX5'], source: 'best_available' }),
      ctx(),
    );
    expect(out.structures[0]?.coordinateUrls).toEqual({
      cif: 'https://files/download/4V6X.cif',
      bcif: 'https://models/4V6X.bcif',
    });
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

  /** The cap advisory for `n` dropped IDs. */
  const capNotice = (n: number) =>
    `Batch capped at ${CAP} IDs; ${n} ignored — resubmit the IDs in ignored.`;

  /** Serve an experimental entry for every requested ID, keyed as RCSB keys it (upper case). */
  const serveEveryEntry = () =>
    getEntries.mockImplementation(async (requested: string[]) =>
      requested.map((id) => experimentalMeta(id.toUpperCase())),
    );

  type CapResult = {
    structuredContent: {
      requested: number;
      processed: number;
      ignored?: string[];
      notice?: string;
    };
    content: Array<{ type: string; text: string }>;
  };

  it('emits no notice and no ignored key for a clean in-cap call, on either surface', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB')]);
    const c = ctx();
    await getStructure.handler(
      getStructure.input.parse({ ids: ['4HHB'], source: 'experimental' }),
      c,
    );
    expect(getEnrichment(c)).toMatchObject({ requested: 1, processed: 1, resolved: 1 });
    expect(getEnrichment(c).notice).toBeUndefined();

    const result = (await runToolContract(getStructure, {
      ids: ['4HHB'],
      source: 'experimental',
    })) as CapResult;
    expect(result.structuredContent).toMatchObject({ requested: 1, processed: 1 });
    expect(result.structuredContent).not.toHaveProperty('ignored');
    expect(result.content.map((b) => b.text).join('\n')).not.toContain('ignored');
  });

  it('cap only: reports the original request length, the processed count, and the ignored IDs', async () => {
    const ids = pdbIds(CAP + 1);
    getEntries.mockResolvedValue(ids.slice(0, CAP).map(experimentalMeta));
    const c = ctx();
    const out = await getStructure.handler(
      getStructure.input.parse({ ids, source: 'experimental' }),
      c,
    );

    expect(out.structures).toHaveLength(CAP);
    // `requested` is the caller's own array length, not the post-cap slice.
    expect(getEnrichment(c)).toMatchObject({
      requested: CAP + 1,
      processed: CAP,
      resolved: CAP,
      ignored: [ids[CAP]],
    });
    expect(noticeOf(c)).toContain(capNotice(1));
  });

  it('trims and de-duplicates before the cap, then names the remainder in ignored (#93)', async () => {
    serveEveryEntry();
    const c = ctx();
    const out = await withBatchCap(3, () =>
      getStructure.handler(
        getStructure.input.parse({
          ids: ['4HHB', ' 1CRN', '4HHB', '1UBQ', '2HHB', '1A0F'],
          source: 'experimental',
        }),
        c,
      ),
    );

    // The repeat no longer consumes a cap slot or yields a second 4HHB record.
    expect(getEntries).toHaveBeenCalledWith(['4HHB', '1CRN', '1UBQ'], expect.anything());
    expect(out.structures.map((s) => s.id)).toEqual(['4HHB', '1CRN', '1UBQ']);
    expect(getEnrichment(c)).toMatchObject({
      requested: 6,
      processed: 3,
      resolved: 3,
      ignored: ['2HHB', '1A0F'],
    });
    const notice = noticeOf(c);
    expect(notice).toContain('Repeated in ids, counted once: 4HHB.');
    expect(notice).toContain('Batch capped at 3 IDs; 2 ignored — resubmit the IDs in ignored.');
    // The list lives in ignored; the notice carries the count only.
    expect(notice).not.toContain('2HHB');
  });

  it('keys repeats case-insensitively and names each repeated ID once', async () => {
    serveEveryEntry();
    const c = ctx();
    const out = await getStructure.handler(
      getStructure.input.parse({
        ids: ['4hhb', '4HHB ', '4Hhb', '1CRN', '1crn'],
        source: 'experimental',
      }),
      c,
    );

    // One lookup per distinct ID, as first written; the records carry RCSB's IDs.
    expect(getEntries).toHaveBeenCalledWith(['4hhb', '1CRN'], expect.anything());
    expect(out.structures.map((s) => s.id)).toEqual(['4HHB', '1CRN']);
    expect(getEnrichment(c)).toMatchObject({ requested: 5, processed: 2 });
    expect(getEnrichment(c)).not.toHaveProperty('ignored');
    expect(noticeOf(c)).toContain('Repeated in ids, counted once: 4hhb, 1CRN.');
  });

  it('processes exactly the ignored IDs when they are passed back as ids', async () => {
    serveEveryEntry();
    const first = ctx();
    await withBatchCap(3, () =>
      getStructure.handler(
        getStructure.input.parse({
          ids: ['4HHB', ' 1CRN', '4HHB', '1UBQ', '2HHB', '1A0F'],
          source: 'experimental',
        }),
        first,
      ),
    );
    const ignored = getEnrichment(first).ignored as string[];
    expect(ignored).toEqual(['2HHB', '1A0F']);

    getEntries.mockClear();
    const second = ctx();
    const out = await withBatchCap(3, () =>
      getStructure.handler(
        getStructure.input.parse({ ids: ignored, source: 'experimental' }),
        second,
      ),
    );
    expect(getEntries).toHaveBeenCalledWith(['2HHB', '1A0F'], expect.anything());
    expect(out.structures.map((s) => s.id)).toEqual(['2HHB', '1A0F']);
    expect(getEnrichment(second)).not.toHaveProperty('ignored');
    expect(noticeOf(second)).toBe('');
  });

  it('carries the same ignored entries on both surfaces', async () => {
    serveEveryEntry();
    const ids = pdbIds(CAP + 2);
    const result = (await runToolContract(getStructure, {
      ids,
      source: 'experimental',
    })) as CapResult;

    expect(result.structuredContent.ignored).toEqual(ids.slice(CAP));
    const text = result.content.map((b) => b.text).join('\n');
    expect(text).toContain(`**ignored:** \`${JSON.stringify(ids.slice(CAP))}\``);
  });

  it('carries each ID and its reason in all_failed data.failed, and names the reasons in the message', async () => {
    getPrediction.mockResolvedValue(null);
    const result = (await runToolContract(getStructure, {
      ids: ['P0DOESNOT', 'A9ZZZ9'],
      source: 'predicted',
    })) as {
      isError?: boolean;
      structuredContent: {
        error: {
          message: string;
          data: { reason: string; failed?: Array<{ id: string; reason: string }> };
        };
      };
    };

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent;
    expect(error.data.reason).toBe('all_failed');
    expect(error.data.failed).toEqual([
      { id: 'P0DOESNOT', reason: expect.stringMatching(/^Not a UniProt accession/) },
      { id: 'A9ZZZ9', reason: 'AlphaFold DB has no model for A9ZZZ9.' },
    ]);
    for (const f of error.data.failed ?? [])
      expect(error.message).toContain(`${f.id}: ${f.reason}`);
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
    serveAllFiles('A'.repeat(20_000));
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
    expect(noticeOf(c)).toContain(capNotice(1));
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
    serveAllFiles('A'.repeat(2_000)); // 25 × 2k = 50k > 24k budget
    const c = ctx();
    const out = await getStructure.handler(
      getStructure.input.parse({ ids, source: 'experimental', include_coords: true }),
      c,
    );

    expect(out.overflow?.sections).toHaveLength(CAP);
    expect(noticeOf(c)).toContain(capNotice(1));
    expect(noticeOf(c)).toContain('exceeded the');
  });

  it('failure + overflow: both advisories survive in one response', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB'), experimentalMeta('2HHB')]);
    serveAllFiles('A'.repeat(20_000));
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
    serveAllFiles('A'.repeat(2_000)); // 24 × 2k = 48k > 24k budget
    const c = ctx();
    const out = await getStructure.handler(
      getStructure.input.parse({ ids, source: 'experimental', include_coords: true }),
      c,
    );

    expect(out.overflow?.sections).toHaveLength(CAP - 1);
    const notice = noticeOf(c);
    expect(notice).toContain(capNotice(1));
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

describe('protein_get_structure coordinate paging (#94)', () => {
  const OVER_BUDGET = 'A'.repeat(30_000); // > DEFAULT_OUTLINE_BUDGET_BYTES (24_000)
  /** One window — DEFAULT_OUTLINE_BUDGET_BYTES characters. */
  const WINDOW = 24_000;
  const CIF_1CRN = 'https://files/download/1CRN.cif';
  const CIF_4HHB = 'https://files/download/4HHB.cif';
  /** A 3-window file the size of 1CRN.cif, ending in a line break. */
  const THREE_WINDOWS = coordinateText(69_506);
  /** A 4-window file the size of AF-P69905-F1-model_v6.pdb, with no final line break. */
  const FOUR_WINDOWS_NO_EOL = coordinateText(92_096, false);

  type PagedRecord = {
    id: string;
    coordinates?: string;
    coordinateFormat?: string;
    coordinatesOffset?: number;
    coordinatesNextOffset?: number;
  };
  type Contract = {
    isError?: boolean;
    structuredContent: {
      structures: PagedRecord[];
      overflow?: { sections: Array<{ id: string; bytes: number }>; notice: string };
      notice?: string;
      error?: { code: number; data: { reason: string; recovery?: { hint: string } } };
    };
    content: Array<{ type: string; text: string }>;
  };
  const call = async (args: z.input<typeof getStructure.input>) =>
    (await runToolContract(getStructure, args)) as Contract;
  const textOf = (r: Contract) => r.content.map((b) => b.text).join('\n');

  it('returns a lone over-budget file as its first 24,000-character window, never an overflow', async () => {
    getEntries.mockResolvedValue([experimentalMeta('1CRN')]);
    serveFiles({ [CIF_1CRN]: THREE_WINDOWS });
    const result = await call({ ids: ['1CRN'], source: 'experimental', include_coords: true });

    const rec = result.structuredContent.structures[0];
    expect(rec?.coordinates).toBe(THREE_WINDOWS.slice(0, WINDOW));
    expect(rec).toMatchObject({
      coordinateFormat: 'cif',
      coordinatesOffset: 0,
      coordinatesNextOffset: WINDOW,
    });
    expect(result.structuredContent.overflow).toBeUndefined();
    const notice = String(result.structuredContent.notice);
    expect(notice).toContain('sections: ["1CRN"]');
    expect(notice).toContain('coords_offset: 24000');
    expect(notice).toContain('coordinateUrls');
    // The text surface carries the same window, fenced, with its range and next offset.
    const text = textOf(result);
    expect(text).toContain(`\`\`\`cif\n${THREE_WINDOWS.slice(0, WINDOW)}\n\`\`\``);
    expect(text).toContain('24000 characters from offset 0');
    expect(text).toContain('next coords_offset: 24000');
    expect(text).not.toContain('Coordinates withheld');
  });

  it('returns the final window at coords_offset 48000 with no next offset', async () => {
    getEntries.mockResolvedValue([experimentalMeta('1CRN')]);
    serveFiles({ [CIF_1CRN]: THREE_WINDOWS });
    const result = await call({
      ids: ['1CRN'],
      source: 'experimental',
      sections: ['1CRN'],
      coords_offset: 48_000,
    });

    const rec = result.structuredContent.structures[0];
    expect(rec?.coordinates).toBe(THREE_WINDOWS.slice(48_000));
    expect(rec?.coordinates).toHaveLength(21_506);
    expect(rec?.coordinatesOffset).toBe(48_000);
    expect(rec).not.toHaveProperty('coordinatesNextOffset');
    expect(textOf(result)).toContain('21506 characters from offset 48000');
  });

  it('pages one file when two IDs resolve to the same structure', async () => {
    const cif = 'https://files/AF-P69905-F1-model_v6.cif';
    getPrediction.mockResolvedValue({
      uniprotAccession: 'P69905',
      entryId: 'AF-P69905-F1',
      cifUrl: cif,
    });
    serveFiles({ [cif]: THREE_WINDOWS });
    const ids = ['P69905', 'AF-P69905-F1'];

    // The window the overflow notice's re-call (sections naming the one ID) leads to.
    const paged = await call({
      ids,
      source: 'predicted',
      sections: ['P69905'],
      coords_offset: 24_000,
    });
    expect(paged.isError).toBeFalsy();
    const [first, second] = paged.structuredContent.structures;
    expect(first).toMatchObject({ id: 'P69905', coordinatesOffset: 24_000 });
    expect(first?.coordinates).toBe(THREE_WINDOWS.slice(24_000, 48_000));
    expect(second).toMatchObject({ id: 'P69905' });
    expect(second).not.toHaveProperty('coordinates');

    // include_coords selects the one file too: a window, never an outline of the same file twice.
    const inlined = await call({ ids, source: 'predicted', include_coords: true });
    expect(inlined.structuredContent.overflow).toBeUndefined();
    expect(inlined.structuredContent.structures[0]?.coordinates).toBe(
      THREE_WINDOWS.slice(0, 24_000),
    );
  });

  it.each([
    ['ending in a line break', THREE_WINDOWS, 3],
    ['with no final line break', FOUR_WINDOWS_NO_EOL, 4],
  ])('reproduces a file %s byte for byte from its concatenated windows', async (_l, body, n) => {
    getEntries.mockResolvedValue([experimentalMeta('1CRN')]);
    serveFiles({ [CIF_1CRN]: body });
    const windows: string[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const result = await call({
        ids: ['1CRN'],
        source: 'experimental',
        sections: ['1CRN'],
        coords_offset: offset,
      });
      const rec = result.structuredContent.structures[0];
      expect(rec?.coordinatesOffset).toBe(offset);
      // Each window rides the text surface verbatim, inside its fence.
      expect(textOf(result)).toContain(`\`\`\`cif\n${rec?.coordinates}\n\`\`\``);
      windows.push(rec?.coordinates ?? '');
      offset = rec?.coordinatesNextOffset;
    }
    expect(windows).toHaveLength(n);
    expect(windows.join('')).toBe(body);
  });

  it('pages a sections re-call naming one structure of a batch, never the whole file', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB'), experimentalMeta('1CRN')]);
    serveFiles({ [CIF_4HHB]: coordinateText(100_000), [CIF_1CRN]: THREE_WINDOWS });
    const result = await call({
      ids: ['4HHB', '1CRN'],
      source: 'experimental',
      sections: ['4HHB'],
    });

    const [four, crn] = result.structuredContent.structures;
    expect(four?.coordinates).toHaveLength(WINDOW);
    expect(four?.coordinatesNextOffset).toBe(WINDOW);
    expect(crn).not.toHaveProperty('coordinates');
    expect(fetchedUrls()).toEqual([CIF_4HHB]);
  });

  it.each([
    ['include_coords', { include_coords: true }],
    ['sections naming both', { sections: ['4HHB', '1CRN'] }],
  ])('returns the size outline for a batch over the budget via %s', async (_l, args) => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB'), experimentalMeta('1CRN')]);
    serveFiles({ [CIF_4HHB]: coordinateText(100_000), [CIF_1CRN]: THREE_WINDOWS });
    const result = await call({ ids: ['4HHB', '1CRN'], source: 'experimental', ...args });

    expect(result.structuredContent.structures.every((s) => s.coordinates === undefined)).toBe(
      true,
    );
    expect(result.structuredContent.overflow?.sections).toEqual([
      { id: '4HHB', bytes: 100_000 },
      { id: '1CRN', bytes: 69_506 },
    ]);
    expect(result.structuredContent.overflow?.notice).toContain('sections: ["4HHB"]');
    const text = textOf(result);
    expect(text).toContain('- 4HHB: 100000 characters');
    expect(text).toContain('- 1CRN: 69506 characters');
    expect(text).not.toContain('```cif');
  });

  it('inlines two files that fit the budget together whole, on both surfaces', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB'), experimentalMeta('1CRN')]);
    const a = coordinateText(12_000);
    const b = coordinateText(11_000);
    serveFiles({ [CIF_4HHB]: a, [CIF_1CRN]: b });
    const result = await call({
      ids: ['4HHB', '1CRN'],
      source: 'experimental',
      include_coords: true,
    });

    const [four, crn] = result.structuredContent.structures;
    expect(four).toMatchObject({ coordinates: a, coordinatesOffset: 0 });
    expect(crn).toMatchObject({ coordinates: b, coordinatesOffset: 0 });
    expect(four).not.toHaveProperty('coordinatesNextOffset');
    expect(result.structuredContent.overflow).toBeUndefined();
    const text = textOf(result);
    expect(text).toContain(`\`\`\`cif\n${a}\n\`\`\``);
    expect(text).toContain(`\`\`\`cif\n${b}\n\`\`\``);
  });

  it('inlines the files that read whole when a failed read passed the budget before failing', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB'), experimentalMeta('1CRN')]);
    const crnText = coordinateText(11_000);
    // 4HHB streams 30,000 characters, past one window, then the connection drops.
    const encoder = new TextEncoder();
    const droppedBody = () => {
      let sent = 0;
      return new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (sent >= 30_000) {
              controller.error(new TypeError('connection reset'));
              return;
            }
            sent += 1_000;
            controller.enqueue(encoder.encode('A'.repeat(1_000)));
          },
        },
        { highWaterMark: 0 },
      );
    };
    files.route(
      { match: (req) => req.url === CIF_4HHB, respond: () => new Response(droppedBody()) },
      { match: (req) => req.url === CIF_1CRN, respond: () => new Response(crnText) },
    );
    const result = await call({
      ids: ['4HHB', '1CRN'],
      source: 'experimental',
      include_coords: true,
    });

    const [four, crn] = result.structuredContent.structures;
    expect(four).not.toHaveProperty('coordinates');
    expect(crn).toMatchObject({ coordinates: crnText, coordinatesOffset: 0 });
    expect(result.structuredContent.overflow).toBeUndefined();
    expect(String(result.structuredContent.notice)).toContain(
      'Coordinate inlining failed for 4HHB',
    );
    expect(textOf(result)).toContain(`\`\`\`cif\n${crnText}\n\`\`\``);
  });

  it.each([
    ['no structure selected', { include_coords: false }],
    ['two structures selected', { include_coords: true }],
    ['a sections entry that matches nothing', { sections: ['9ZZZ'] }],
  ])('rejects coords_offset with %s (InvalidParams, declared recovery)', async (_l, args) => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB'), experimentalMeta('1CRN')]);
    const result = await call({
      ids: ['4HHB', '1CRN'],
      source: 'experimental',
      coords_offset: 24_000,
      ...args,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({
      code: -32602,
      data: {
        reason: 'coords_offset_needs_one_structure',
        recovery: { hint: expect.stringContaining('sections') },
      },
    });
    expect(files.calls).toHaveLength(0);
  });

  it('rejects a negative or fractional coords_offset at the schema', () => {
    for (const coords_offset of [-1, 1.5]) {
      expect(
        getStructure.input.safeParse({ ids: ['1CRN'], sections: ['1CRN'], coords_offset }).success,
      ).toBe(false);
    }
  });

  it('returns no coordinates at or past the end of the file, and names its length', async () => {
    getEntries.mockResolvedValue([experimentalMeta('1CRN')]);
    serveFiles({ [CIF_1CRN]: THREE_WINDOWS });
    for (const offset of [69_506, 90_000]) {
      const result = await call({
        ids: ['1CRN'],
        source: 'experimental',
        sections: ['1CRN'],
        coords_offset: offset,
      });
      const rec = result.structuredContent.structures[0];
      expect(rec).not.toHaveProperty('coordinates');
      expect(rec).not.toHaveProperty('coordinatesOffset');
      expect(String(result.structuredContent.notice)).toContain('69506 characters');
      expect(textOf(result)).toContain('69506 characters');
    }
  });

  it('names a sections entry that matches no structure in the call', async () => {
    getEntries.mockResolvedValue([experimentalMeta('1CRN')]);
    serveFiles({ [CIF_1CRN]: 'data_1CRN\n' });
    const result = await call({
      ids: ['1CRN'],
      source: 'experimental',
      sections: ['1CRN', '9ZZZ'],
    });

    expect(result.structuredContent.structures[0]?.coordinates).toBe('data_1CRN\n');
    expect(String(result.structuredContent.notice)).toContain('9ZZZ');
    expect(textOf(result)).toContain('9ZZZ');
  });

  it('stops downloading a window read once it holds the window plus one character', async () => {
    getEntries.mockResolvedValue([experimentalMeta('1CRN')]);
    const body = trackedBody(coordinateText(1_000_000));
    files.route({
      match: (req) => req.url === CIF_1CRN,
      respond: () => new Response(body.stream),
    });
    const out = await getStructure.handler(
      getStructure.input.parse({
        ids: ['1CRN'],
        source: 'experimental',
        sections: ['1CRN'],
        coords_offset: 48_000,
      }),
      ctx(),
    );

    expect(out.structures[0]?.coordinates).toHaveLength(WINDOW);
    expect(body.state.cancelled).toBe(true);
    // The read ends at the chunk holding character 48,000 + 24,001; the HTTP
    // layer's pass-through may have one more chunk in flight.
    expect(body.state.pulled).toBeGreaterThanOrEqual(48_000 + WINDOW + 1);
    expect(body.state.pulled).toBeLessThanOrEqual(48_000 + WINDOW + 1 + 2 * 1_000);
  });

  it('measures every file of an over-budget batch to its end without inlining any', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB'), experimentalMeta('1CRN')]);
    const big = trackedBody(coordinateText(250_000));
    const small = trackedBody(coordinateText(30_000));
    files.route(
      { match: (req) => req.url === CIF_4HHB, respond: () => new Response(big.stream) },
      { match: (req) => req.url === CIF_1CRN, respond: () => new Response(small.stream) },
    );
    const out = await getStructure.handler(
      getStructure.input.parse({
        ids: ['4HHB', '1CRN'],
        source: 'experimental',
        include_coords: true,
      }),
      ctx(),
    );

    expect(out.overflow?.sections).toEqual([
      { id: '4HHB', bytes: 250_000 },
      { id: '1CRN', bytes: 30_000 },
    ]);
    expect(big.state.pulled).toBe(250_000);
    expect(small.state.pulled).toBe(30_000);
    expect(out.structures.every((s) => s.coordinates === undefined)).toBe(true);
  });

  it('holds at most one window of file text while measuring an over-budget batch', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB'), experimentalMeta('1CRN')]);
    // 250 + 30 chunks of 1,000 characters.
    const big = trackedBody(coordinateText(250_000));
    const small = trackedBody(coordinateText(30_000));
    files.route(
      { match: (req) => req.url === CIF_4HHB, respond: () => new Response(big.stream) },
      { match: (req) => req.url === CIF_1CRN, respond: () => new Response(small.stream) },
    );
    const add = TextBudget.prototype.add;
    let maxHeld = 0;
    const spy = vi.spyOn(TextBudget.prototype, 'add').mockImplementation(function (
      this: TextBudget,
      key: string,
      chunk: string,
    ) {
      add.call(this, key, chunk);
      maxHeld = Math.max(maxHeld, this.heldChars);
    });
    let adds = 0;
    let out: Awaited<ReturnType<typeof getStructure.handler>>;
    try {
      out = await getStructure.handler(
        getStructure.input.parse({
          ids: ['4HHB', '1CRN'],
          source: 'experimental',
          include_coords: true,
        }),
        ctx(),
      );
      adds = spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }

    // Every streamed chunk passes through the shared budget, which fills to the
    // window and never past it.
    expect(adds).toBe(280);
    expect(maxHeld).toBeGreaterThan(WINDOW - 1_000);
    expect(maxHeld).toBeLessThanOrEqual(WINDOW);
    expect(out.overflow?.sections).toEqual([
      { id: '4HHB', bytes: 250_000 },
      { id: '1CRN', bytes: 30_000 },
    ]);
  });

  it('still inlines a single under-budget coordinate file on both surfaces', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB')]);
    serveAllFiles('B'.repeat(1_000));
    const c = ctx();
    const out = await getStructure.handler(
      getStructure.input.parse({ ids: ['4HHB'], source: 'experimental', include_coords: true }),
      c,
    );

    expect(out.overflow).toBeUndefined();
    expect(out.structures[0]?.coordinates).toHaveLength(1_000);
    expect(out.structures[0]).toMatchObject({ coordinateFormat: 'cif', coordinatesOffset: 0 });
    expect(out.structures[0]).not.toHaveProperty('coordinatesNextOffset');
    expect(getEnrichment(c).notice).toBeUndefined();
    const text = (getStructure.format!(out)[0] as { text: string }).text;
    expect(text).toContain('**Inlined cif (1000 characters from offset 0):**');
  });

  it('keeps the sections re-call guidance for a batch overflow', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB'), experimentalMeta('2HHB')]);
    serveAllFiles('A'.repeat(20_000));
    const out = await getStructure.handler(
      getStructure.input.parse({
        ids: ['4HHB', '2HHB'],
        source: 'experimental',
        include_coords: true,
      }),
      ctx(),
    );

    expect(out.overflow?.sections).toHaveLength(2);
    expect(out.overflow?.notice).toContain('sections: ["4HHB"]');
  });

  it('names the structure whose coordinate fetch failed, distinct from failed[] (#42)', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB')]);
    serveFiles({ [CIF_4HHB]: 404 });
    const c = ctx();
    const out = await getStructure.handler(
      getStructure.input.parse({ ids: ['4HHB'], source: 'experimental', include_coords: true }),
      c,
    );

    // The ID resolved — it is not a failed[] row; only its coordinate content is missing.
    expect(out.failed).toHaveLength(0);
    expect(out.structures[0]?.coordinates).toBeUndefined();
    expect(out.structures[0]?.coordinateUrls.cif).toBe('https://files/download/4HHB.cif');
    expect(String(getEnrichment(c).notice)).toContain('Coordinate inlining failed for 4HHB');
    expect(out.overflow).toBeUndefined();
  });

  it('carries an inline failure alongside an overflow advisory in one response', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB'), experimentalMeta('2HHB')]);
    serveFiles({ [CIF_4HHB]: OVER_BUDGET, 'https://files/download/2HHB.cif': 404 });
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

  it('a batch over the budget withholds coordinates from both surfaces, with the outline on each', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB'), experimentalMeta('2HHB')]);
    serveAllFiles(OVER_BUDGET);
    const result = await call({
      ids: ['4HHB', '2HHB'],
      source: 'experimental',
      include_coords: true,
    });

    expect(result.structuredContent.structures.every((s) => s.coordinates === undefined)).toBe(
      true,
    );
    expect(result.structuredContent.overflow?.sections).toEqual([
      { id: '4HHB', bytes: 30_000 },
      { id: '2HHB', bytes: 30_000 },
    ]);
    const text = textOf(result);
    expect(text).toContain('Coordinates withheld');
    expect(text).toContain('coordinateUrls');
    expect(text).not.toContain('A'.repeat(500));
  });

  it('renders the withheld marker for a structure the overflow outline names', () => {
    const withheld = {
      structures: [
        {
          id: '4HHB',
          source: 'experimental' as const,
          coordinateUrls: { cif: 'https://files/4HHB.cif' },
        },
      ],
      failed: [],
      attribution: [],
      overflow: { sections: [{ id: '4HHB', bytes: 30_000 }], notice: 'over budget' },
    };
    const text = (getStructure.format!(withheld)[0] as { text: string }).text;
    expect(text).toContain('**Coordinates withheld**');
    expect(text).toContain('- 4HHB: 30000 characters');
  });
});

describe('protein_get_structure format() coordinate state parity (#59, #94)', () => {
  /** Between a short file and DEFAULT_OUTLINE_BUDGET_BYTES. */
  const MID_RANGE = 'C'.repeat(5_000);
  /** Over DEFAULT_OUTLINE_BUDGET_BYTES (24,000). */
  const OVER_BUDGET = 'A'.repeat(30_000);

  it('renders an under-budget include_coords payload whole on both surfaces', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB')]);
    serveAllFiles(MID_RANGE);
    const result = (await runToolContract(getStructure, {
      ids: ['4HHB'],
      source: 'experimental',
      include_coords: true,
    })) as {
      structuredContent: { structures: Array<{ coordinates?: string }> };
      content: Array<{ text: string }>;
    };

    // Under the total budget, so the structured surface keeps it — and the text
    // surface must carry the same characters.
    expect(result.structuredContent.structures[0]?.coordinates).toHaveLength(5_000);
    const text = result.content.map((b) => b.text).join('\n');
    expect(text).toContain('**Inlined cif (5000 characters from offset 0):**');
    expect(text).toContain(MID_RANGE);
    expect(text).not.toContain('truncated in text view');
  });

  it('pages an over-budget sections re-call identically on both surfaces', async () => {
    // The budget gates sections: the named file arrives as one window, and
    // content[] carries exactly the characters structuredContent does.
    getEntries.mockResolvedValue([experimentalMeta('4HHB'), experimentalMeta('2HHB')]);
    serveAllFiles(OVER_BUDGET);
    const result = (await runToolContract(getStructure, {
      ids: ['4HHB', '2HHB'],
      source: 'experimental',
      sections: ['4HHB'],
    })) as {
      structuredContent: {
        structures: Array<{ id: string; coordinates?: string; coordinatesNextOffset?: number }>;
        overflow?: unknown;
      };
      content: Array<{ text: string }>;
    };

    const four = result.structuredContent.structures.find((s) => s.id === '4HHB');
    expect(four?.coordinates).toBe('A'.repeat(24_000));
    expect(four?.coordinatesNextOffset).toBe(24_000);
    expect(result.structuredContent.overflow).toBeUndefined();
    const text = result.content.map((b) => b.text).join('\n');
    expect(text).toContain(`\`\`\`cif\n${'A'.repeat(24_000)}\n\`\`\``);
    expect(text).not.toContain('A'.repeat(24_001));
    expect(text).not.toContain('Coordinates withheld');
  });

  it('renders an under-budget sections re-call whole on both surfaces', async () => {
    getEntries.mockResolvedValue([experimentalMeta('4HHB')]);
    serveAllFiles(MID_RANGE);
    const out = await getStructure.handler(
      getStructure.input.parse({ ids: ['4HHB'], source: 'experimental', sections: ['4HHB'] }),
      ctx(),
    );

    expect(out.structures[0]?.coordinates).toHaveLength(5_000);
    const text = (getStructure.format!(out)[0] as { text: string }).text;
    expect(text).toContain(MID_RANGE);
    expect(text).toContain('**Inlined cif (5000 characters from offset 0):**');
  });

  /** A record carrying `coordinates` for format() to render. */
  const rendered = (coordinates: string, extra: object = {}) =>
    (
      getStructure.format!({
        structures: [
          {
            id: '4HHB',
            source: 'experimental' as const,
            coordinateUrls: { cif: 'https://files/4HHB.cif' },
            coordinateFormat: 'cif' as const,
            coordinates,
            coordinatesOffset: 0,
            ...extra,
          },
        ],
        failed: [],
        attribution: [],
      })[0] as { text: string }
    ).text;

  it('renders the coordinates the record carries, verbatim, with no length rule of its own', () => {
    // The budget is the handler's; format() renders the structured value as-is.
    expect(rendered(OVER_BUDGET)).toContain(`\`\`\`cif\n${OVER_BUDGET}\n\`\`\``);
    expect(rendered(OVER_BUDGET)).not.toContain('Coordinates withheld');
  });

  it.each([
    ['ending mid-line', 'ATOM      1  N   MET A   1      27.340  24.430   2.614\nATOM   '],
    ['ending in a line break', 'HETATM  5  O   HOH A 101       1.000   2.000   3.000\n'],
    ['with no final line break at the end of the file', 'END'],
  ])('fences a window %s so the fence adds exactly one line ending before it closes', (_l, w) => {
    const text = rendered(w);
    // Opening fence + info string, the window verbatim, one line feed, closing fence.
    expect(text).toContain(`\n\`\`\`cif\n${w}\n\`\`\``);
  });

  it('sizes the fence past the longest backtick run inside the window', () => {
    const w = 'data_x\n````\n_loop';
    const text = rendered(w);
    expect(text).toContain(`\`\`\`\`\`cif\n${w}\n\`\`\`\`\``);
  });

  it('renders the range and next offset beside the window', () => {
    const text = rendered('B'.repeat(10), {
      coordinatesOffset: 24_000,
      coordinatesNextOffset: 24_010,
    });
    expect(text).toContain(
      '**Inlined cif (10 characters from offset 24000, next coords_offset: 24010):**',
    );
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
        organisms: ['Homo sapiens'],
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
    expect(rec).not.toHaveProperty('organisms');
  });

  it('carries every source organism on the record and each polymer entity, on both surfaces (#85)', async () => {
    // EntryMeta arrives in entity-number order (the service sorts); the record
    // passes the whole list through rather than its first member.
    getEntries.mockResolvedValue([
      {
        id: '6M0J',
        organisms: ['Homo sapiens', 'Severe acute respiratory syndrome coronavirus 2'],
        polymerEntities: [
          { entityId: '6M0J_1', organisms: ['Homo sapiens'] },
          { entityId: '6M0J_2', organisms: ['Severe acute respiratory syndrome coronavirus 2'] },
        ],
        ligands: [],
      },
      {
        id: '2RH1',
        organisms: ['Homo sapiens', 'Tequatrovirus T4'],
        polymerEntities: [{ entityId: '2RH1_1', organisms: ['Homo sapiens', 'Tequatrovirus T4'] }],
        ligands: [],
      },
    ]);
    const result = (await runToolContract(getStructure, {
      ids: ['6M0J', '2RH1'],
      source: 'experimental',
    })) as {
      structuredContent: {
        structures: Array<{
          organisms?: string[];
          polymerEntities?: Array<{ entityId: string; organisms?: string[] }>;
        }>;
      };
      content: Array<{ type: string; text: string }>;
    };

    const [m0j, rh1] = result.structuredContent.structures;
    expect(m0j?.organisms).toEqual([
      'Homo sapiens',
      'Severe acute respiratory syndrome coronavirus 2',
    ]);
    expect(m0j?.polymerEntities?.map((e) => e.organisms)).toEqual([
      ['Homo sapiens'],
      ['Severe acute respiratory syndrome coronavirus 2'],
    ]);
    expect(rh1?.polymerEntities?.[0]?.organisms).toEqual(['Homo sapiens', 'Tequatrovirus T4']);
    const text = result.content.map((b) => b.text).join('\n');
    expect(text).toContain(
      '**Organisms:** Homo sapiens, Severe acute respiratory syndrome coronavirus 2',
    );
    expect(text).toContain('**6M0J_2** — Severe acute respiratory syndrome coronavirus 2');
    expect(text).toContain('**2RH1_1** — Homo sapiens, Tequatrovirus T4');
  });

  it('gives a predicted record its AlphaFold organism as a list, and best_available records none (#85)', async () => {
    getPrediction.mockResolvedValue({
      uniprotAccession: 'P69905',
      organism: 'Homo sapiens',
      meanPlddt: 98,
      cifUrl: 'https://af/cif',
    });
    const predicted = (await runToolContract(getStructure, {
      ids: ['P69905'],
      source: 'predicted',
    })) as {
      structuredContent: { structures: Array<{ organisms?: string[] }> };
      content: Array<{ text: string }>;
    };
    expect(predicted.structuredContent.structures[0]?.organisms).toEqual(['Homo sapiens']);
    expect(predicted.content.map((b) => b.text).join('\n')).toContain(
      '**Organisms:** Homo sapiens',
    );

    getPrediction.mockResolvedValue({ uniprotAccession: 'P69905', cifUrl: 'https://af/cif' });
    const unnamed = await getStructure.handler(
      getStructure.input.parse({ ids: ['P69905'], source: 'predicted' }),
      ctx(),
    );
    expect(unnamed.structures[0]).not.toHaveProperty('organisms');

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
    const best = await getStructure.handler(
      getStructure.input.parse({ ids: ['P69905'], source: 'best_available' }),
      ctx(),
    );
    expect(best.structures[0]).not.toHaveProperty('organisms');
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
