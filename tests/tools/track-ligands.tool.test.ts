/**
 * @fileoverview Tests for protein_track_ligands: the three modes (find_ligand,
 * structures_with_ligand, binding_site), the missing-param guards (InvalidParams),
 * the find_ligand / binding_site empty-result not_found branches,
 * structures_with_ligand's empty-result set + notice, the totalCount /
 * resolvedCompId enrichment, comp_id upper-casing, and format() rendering of
 * ligands, structure lists, and binding sites. RCSB service mocked.
 * @module tests/tools/track-ligands.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findChemComps = vi.fn();
const getChemComp = vi.fn();
const searchByLigand = vi.fn();
const getBindingSites = vi.fn();
vi.mock('@/services/rcsb/rcsb-service.js', () => ({
  getRcsbService: () => ({ findChemComps, getChemComp, searchByLigand, getBindingSites }),
}));

import { trackLigands } from '@/mcp-server/tools/definitions/track-ligands.tool.js';

const ctx = () => createMockContext({ errors: trackLigands.errors });

beforeEach(() => vi.clearAllMocks());

describe('protein_track_ligands — find_ligand', () => {
  it('resolves a name to chem-comp metadata', async () => {
    findChemComps.mockResolvedValue(['HEM']);
    getChemComp.mockResolvedValue({
      compId: 'HEM',
      name: 'PROTOPORPHYRIN IX CONTAINING FE',
      formula: 'C34 H32 Fe N4 O4',
      formulaWeight: 616.5,
    });
    const out = await trackLigands.handler(
      trackLigands.input.parse({ mode: 'find_ligand', query: 'heme' }),
      ctx(),
    );
    expect(out.mode).toBe('find_ligand');
    expect(out.ligands).toEqual([
      {
        compId: 'HEM',
        name: 'PROTOPORPHYRIN IX CONTAINING FE',
        formula: 'C34 H32 Fe N4 O4',
        formulaWeight: 616.5,
      },
    ]);
  });

  it('drops nulls from the per-id metadata fan-out', async () => {
    findChemComps.mockResolvedValue(['HEM', 'GONE']);
    getChemComp.mockImplementation(async (id: string) => (id === 'HEM' ? { compId: 'HEM' } : null));
    const out = await trackLigands.handler(
      trackLigands.input.parse({ mode: 'find_ligand', query: 'heme' }),
      ctx(),
    );
    expect(out.ligands).toEqual([{ compId: 'HEM' }]);
  });

  it('throws missing_param (InvalidParams) when query is missing', async () => {
    await expect(
      trackLigands.handler(trackLigands.input.parse({ mode: 'find_ligand' }), ctx()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'missing_param' },
    });
  });

  it('throws not_found when nothing resolves', async () => {
    findChemComps.mockResolvedValue([]);
    await expect(
      trackLigands.handler(trackLigands.input.parse({ mode: 'find_ligand', query: 'zzz' }), ctx()),
    ).rejects.toMatchObject({ data: { reason: 'not_found' } });
  });
});

describe('protein_track_ligands — structures_with_ligand', () => {
  it('returns matching structures and records the total + resolved comp id', async () => {
    searchByLigand.mockResolvedValue({
      total: 1200,
      hits: [
        { id: '4HHB', score: 1 },
        { id: '2HHB', score: 0.9 },
      ],
    });
    const c = ctx();
    const out = await trackLigands.handler(
      trackLigands.input.parse({ mode: 'structures_with_ligand', comp_id: 'hem' }),
      c,
    );
    expect(out.structures).toEqual([
      { id: '4HHB', score: 1 },
      { id: '2HHB', score: 0.9 },
    ]);
    // comp_id is upper-cased before the search.
    expect(searchByLigand).toHaveBeenCalledWith('HEM', { limit: 25 }, expect.anything());
    expect(getEnrichment(c)).toMatchObject({ totalCount: 1200, resolvedCompId: 'HEM' });
  });

  it('throws missing_param (InvalidParams) when comp_id is missing', async () => {
    await expect(
      trackLigands.handler(trackLigands.input.parse({ mode: 'structures_with_ligand' }), ctx()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'missing_param' },
    });
  });

  it('returns an empty structure set (with a notice) when no structures contain the ligand', async () => {
    searchByLigand.mockResolvedValue({ total: 0, hits: [] });
    const c = ctx();
    const out = await trackLigands.handler(
      trackLigands.input.parse({ mode: 'structures_with_ligand', comp_id: 'ZZZ' }),
      c,
    );
    expect(out.structures).toEqual([]);
    expect(getEnrichment(c)).toMatchObject({ totalCount: 0, resolvedCompId: 'ZZZ' });
    expect(String(getEnrichment(c).notice)).toMatch(/no pdb entries contain zzz/i);
  });
});

describe('protein_track_ligands — binding_site', () => {
  it('returns binding-site residues for a structure', async () => {
    getBindingSites.mockResolvedValue([
      {
        ligandCompId: 'HEM',
        ligandAsymId: 'A',
        residues: [{ residueCompId: 'HIS', asymId: 'A', seqId: 87, distance: 2.1 }],
      },
    ]);
    const out = await trackLigands.handler(
      trackLigands.input.parse({ mode: 'binding_site', pdb_id: '4HHB', comp_id: 'hem' }),
      ctx(),
    );
    expect(out.bindingSites?.[0]).toMatchObject({ ligandCompId: 'HEM', ligandAsymId: 'A' });
    expect(getBindingSites).toHaveBeenCalledWith('4HHB', 'HEM', expect.anything());
  });

  it('throws missing_param (InvalidParams) when pdb_id is missing', async () => {
    await expect(
      trackLigands.handler(
        trackLigands.input.parse({ mode: 'binding_site', comp_id: 'HEM' }),
        ctx(),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'missing_param' },
    });
  });

  it('throws not_found when no binding-site contacts are found', async () => {
    getBindingSites.mockResolvedValue([]);
    await expect(
      trackLigands.handler(
        trackLigands.input.parse({ mode: 'binding_site', pdb_id: '1ABC' }),
        ctx(),
      ),
    ).rejects.toMatchObject({ data: { reason: 'not_found' } });
  });
});

describe('protein_track_ligands — format', () => {
  it('renders ligand identifiers (SMILES/InChIKey), structure lists, and pocket residues', () => {
    const blocks = trackLigands.format?.({
      mode: 'find_ligand',
      ligands: [
        {
          compId: 'STI',
          name: 'IMATINIB',
          formula: 'C29 H31 N7 O',
          formulaWeight: 493.6,
          type: 'non-polymer',
          smiles: 'Cc1ccc(cc1)Nc1nccc(n1)-c1cccnc1',
          inchikey: 'KTUFNOKKBVMGRW-UHFFFAOYSA-N',
        },
      ],
    });
    const text = (blocks?.[0] as { text: string }).text;
    expect(text).toContain('### STI — IMATINIB');
    expect(text).toContain('**Formula:** C29 H31 N7 O');
    expect(text).toContain('**Weight:** 493.6 Da');
    expect(text).toContain('**SMILES:** Cc1ccc(cc1)Nc1nccc(n1)-c1cccnc1');
    expect(text).toContain('**InChIKey:** KTUFNOKKBVMGRW-UHFFFAOYSA-N');
  });

  it('renders binding-site residues with positions and distances', () => {
    const blocks = trackLigands.format?.({
      mode: 'binding_site',
      bindingSites: [
        {
          ligandCompId: 'HEM',
          ligandAsymId: 'A',
          residues: [
            { residueCompId: 'HIS', asymId: 'A', seqId: 87, distance: 2.1 },
            { residueCompId: 'PHE', asymId: 'A' },
          ],
        },
      ],
    });
    const text = (blocks?.[0] as { text: string }).text;
    expect(text).toContain('### Ligand HEM (chain A)');
    expect(text).toContain('- HIS87 (chain A) — 2.10 Å');
    expect(text).toContain('- PHE (chain A)'); // no seqId, no distance
  });

  it('renders a structures list with the comma-joined ids', () => {
    const blocks = trackLigands.format?.({
      mode: 'structures_with_ligand',
      structures: [{ id: '4HHB', score: 1 }, { id: '2HHB' }],
    });
    const text = (blocks?.[0] as { text: string }).text;
    expect(text).toContain('**2 structures:**');
    expect(text).toContain('4HHB, 2HHB');
    expect(text).toContain('- 4HHB (score 1.00)');
  });
});
