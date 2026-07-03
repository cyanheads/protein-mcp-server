/**
 * @fileoverview protein_track_ligands — ligand discovery and binding-site
 * analysis. Resolves a ligand name/formula to chemical component IDs, finds PDB
 * entries bound to a ligand, or returns the protein residues lining a ligand's
 * pocket in a structure (via RCSB `rcsb_target_neighbors`).
 * @module mcp-server/tools/definitions/track-ligands.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getRcsbService } from '@/services/rcsb/rcsb-service.js';
import type { ChemComp } from '@/services/rcsb/types.js';
import { mapWithConcurrency } from '@/services/shared/async.js';

const chemCompSchema = z
  .object({
    compId: z.string().describe('Chemical component ID (e.g. STI, HEM).'),
    name: z.string().optional().describe('Chemical name.'),
    formula: z.string().optional().describe('Molecular formula.'),
    formulaWeight: z.number().optional().describe('Formula weight in Da.'),
    smiles: z.string().optional().describe('Isomeric SMILES.'),
    inchikey: z.string().optional().describe('InChIKey.'),
    type: z.string().optional().describe('Component type (e.g. non-polymer).'),
  })
  .describe('A resolved chemical component (ligand) and its identifiers.');

const bindingSiteSchema = z
  .object({
    ligandCompId: z.string().describe('Bound ligand chemical component ID.'),
    ligandAsymId: z.string().optional().describe('Ligand instance chain (asym) ID.'),
    residues: z
      .array(
        z
          .object({
            residueCompId: z.string().describe('Interacting residue type (e.g. ASP).'),
            asymId: z.string().describe('Chain ID the residue belongs to.'),
            seqId: z.number().optional().describe('Residue sequence position.'),
            distance: z.number().optional().describe('Contact distance to the ligand in Å.'),
          })
          .describe('A pocket residue in contact with the ligand.'),
      )
      .describe('Protein residues lining the pocket, nearest first.'),
  })
  .describe('A ligand instance and the protein residues lining its pocket.');

export const trackLigands = tool('protein_track_ligands', {
  title: 'protein-mcp-server: track ligands',
  description:
    'Ligand discovery and binding-site analysis across the PDB. mode "find_ligand" resolves a name or ' +
    'formula to chemical component IDs with metadata (formula, weight, SMILES). mode ' +
    '"structures_with_ligand" returns PDB entries containing a ligand (by exact component ID — get the ' +
    'ID from find_ligand first). mode "binding_site" returns the protein residues lining a ligand\'s ' +
    'pocket in a given structure, with contact distances. Binding sites are experimental-only ' +
    '(computed from deposited coordinates; predicted models carry no bound ligands).',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'missing_param',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The mode-specific required input is absent: query (find_ligand), comp_id (structures_with_ligand), or pdb_id (binding_site).',
      recovery:
        'Provide the parameter the selected mode requires: query for find_ligand, comp_id for structures_with_ligand, or pdb_id for binding_site.',
    },
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No chemical component matched the name/formula, or the structure has no instance of the ligand.',
      recovery:
        'Use mode "find_ligand" to resolve a name to a component ID first, then confirm the ligand is present in the structure via protein_get_structure.',
    },
  ],

  input: z.object({
    mode: z
      .enum(['find_ligand', 'structures_with_ligand', 'binding_site'])
      .describe(
        'Operation: resolve a ligand, find structures containing it, or analyze its binding site.',
      ),
    query: z.string().optional().describe('Ligand name or formula (mode find_ligand).'),
    comp_id: z
      .string()
      .optional()
      .describe('Exact chemical component ID (modes structures_with_ligand and binding_site).'),
    pdb_id: z.string().optional().describe('PDB entry ID (mode binding_site).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe('Maximum results to return (1–100).'),
  }),

  output: z.object({
    mode: z
      .enum(['find_ligand', 'structures_with_ligand', 'binding_site'])
      .describe('Echoed mode.'),
    ligands: z
      .array(chemCompSchema)
      .optional()
      .describe('Resolved chemical components (find_ligand).'),
    structures: z
      .array(
        z
          .object({
            id: z.string().describe('PDB entry ID containing the ligand.'),
            score: z.number().optional().describe('RCSB relevance score.'),
          })
          .describe('A PDB entry containing the ligand.'),
      )
      .optional()
      .describe('PDB entries containing the ligand (structures_with_ligand).'),
    bindingSites: z
      .array(bindingSiteSchema)
      .optional()
      .describe('Binding-site residues (binding_site).'),
  }),

  enrichment: {
    totalCount: z
      .number()
      .optional()
      .describe('Total upstream matches before pagination (structures_with_ligand).'),
    resolvedCompId: z.string().optional().describe('The chemical component ID used to query.'),
    notice: z
      .string()
      .optional()
      .describe('Advisory note when a mode-specific input is missing or absent.'),
  },

  async handler(input, ctx) {
    const rcsb = getRcsbService();
    const cfg = getServerConfig();

    if (input.mode === 'find_ligand') {
      if (!input.query)
        throw ctx.fail('missing_param', 'mode find_ligand requires a name or formula in "query".', {
          ...ctx.recoveryFor('missing_param'),
        });
      const ids = await rcsb.findChemComps(input.query, input.limit, ctx);
      const ligands = (
        await mapWithConcurrency(ids, cfg.fanoutConcurrency, (id) => rcsb.getChemComp(id, ctx))
      ).filter((c): c is ChemComp => c != null);
      if (ligands.length === 0) {
        throw ctx.fail('not_found', `No chemical component matched "${input.query}".`, {
          recovery: {
            hint: `No ligand matched "${input.query}". Try the exact name, a synonym, or a formula.`,
          },
        });
      }
      return { mode: input.mode, ligands };
    }

    if (input.mode === 'structures_with_ligand') {
      const compId = input.comp_id?.toUpperCase();
      if (!compId)
        throw ctx.fail('missing_param', 'mode structures_with_ligand requires a "comp_id".', {
          ...ctx.recoveryFor('missing_param'),
        });
      const result = await rcsb.searchByLigand(compId, { limit: input.limit }, ctx);
      ctx.enrich.total(result.total);
      ctx.enrich({ resolvedCompId: compId });
      // A valid component with zero containing structures is an empty result set,
      // not a not-found — mirrors protein_search_structures' empty-hits behavior.
      if (result.hits.length === 0) {
        ctx.enrich.notice(
          `No PDB entries contain ${compId}. Verify the component ID via mode find_ligand.`,
        );
      }
      return {
        mode: input.mode,
        structures: result.hits.map((h) => ({ id: h.id, score: h.score })),
      };
    }

    // binding_site
    const compId = input.comp_id?.toUpperCase();
    if (!input.pdb_id)
      throw ctx.fail('missing_param', 'mode binding_site requires a "pdb_id".', {
        ...ctx.recoveryFor('missing_param'),
      });
    const sites = await rcsb.getBindingSites(input.pdb_id, compId, ctx);
    if (sites.length === 0) {
      throw ctx.fail(
        'not_found',
        `No binding-site contacts found in ${input.pdb_id.toUpperCase()}${compId ? ` for ligand ${compId}` : ''}.`,
        {
          recovery: {
            hint: `Confirm ${input.pdb_id.toUpperCase()} contains${compId ? ` ${compId}` : ' a ligand'} via protein_get_structure; binding sites are experimental-only.`,
          },
        },
      );
    }
    // Cap binding-site INSTANCES to the shared limit (mode-consistent top-N; the
    // other two modes already bound their results). Disclose the drop via notice.
    const bindingSites = sites.slice(0, input.limit);
    if (sites.length > input.limit) {
      ctx.enrich.notice(
        `Showing ${input.limit} of ${sites.length} binding-site instances in ${input.pdb_id.toUpperCase()}${compId ? ` for ${compId}` : ''}; raise limit to see more.`,
      );
    }
    if (compId) ctx.enrich({ resolvedCompId: compId });
    return { mode: input.mode, bindingSites };
  },

  format: (result) => {
    const lines: string[] = [`## protein_track_ligands — ${result.mode}`];
    for (const l of result.ligands ?? []) {
      lines.push(`\n### ${l.compId}${l.name ? ` — ${l.name}` : ''}`);
      const parts = [
        l.formula ? `**Formula:** ${l.formula}` : null,
        typeof l.formulaWeight === 'number' ? `**Weight:** ${l.formulaWeight} Da` : null,
        l.type ? `**Type:** ${l.type}` : null,
      ].filter(Boolean);
      if (parts.length > 0) lines.push(parts.join(' | '));
      if (l.smiles) lines.push(`**SMILES:** ${l.smiles}`);
      if (l.inchikey) lines.push(`**InChIKey:** ${l.inchikey}`);
    }
    if (result.structures) {
      lines.push(`\n**${result.structures.length} structures:**`);
      lines.push(result.structures.map((s) => s.id).join(', '));
      for (const s of result.structures) {
        if (typeof s.score === 'number') lines.push(`- ${s.id} (score ${s.score.toFixed(2)})`);
      }
    }
    for (const site of result.bindingSites ?? []) {
      lines.push(
        `\n### Ligand ${site.ligandCompId}${site.ligandAsymId ? ` (chain ${site.ligandAsymId})` : ''}`,
      );
      for (const r of site.residues) {
        const pos = r.seqId != null ? `${r.residueCompId}${r.seqId}` : r.residueCompId;
        const dist = r.distance != null ? ` — ${r.distance.toFixed(2)} Å` : '';
        lines.push(`- ${pos} (chain ${r.asymId})${dist}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
