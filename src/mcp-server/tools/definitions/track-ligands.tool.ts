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
import type { ChemComp, EntryMeta } from '@/services/rcsb/types.js';
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
    depositionCount: z
      .number()
      .describe(
        'Number of PDB entries containing this component (deposition frequency). Candidates are ranked by this value, most-deposited first.',
      ),
  })
  .describe('A resolved chemical component (ligand) and its identifiers.');

const bindingSiteSchema = z
  .object({
    ligandCompId: z.string().describe('Bound ligand chemical component ID.'),
    ligandAsymId: z
      .string()
      .optional()
      .describe(
        'Author chain ID (auth_asym_id) of the ligand instance — the author namespace, unlike residues[].asymId.',
      ),
    ligandAuthSeqId: z
      .number()
      .optional()
      .describe('Author residue number (auth_seq_id) of the ligand instance.'),
    residues: z
      .array(
        z
          .object({
            residueCompId: z.string().describe('Interacting residue type (e.g. ASP).'),
            asymId: z
              .string()
              .describe(
                "mmCIF label_asym_id of the residue's chain (label namespace, paired with seqId). Can differ from authAsymId.",
              ),
            seqId: z
              .number()
              .optional()
              .describe(
                'mmCIF label_seq_id: position in the entity sequence (label namespace). Not the deposited residue number; see authSeqId.',
              ),
            authAsymId: z
              .string()
              .optional()
              .describe(
                "Author chain ID (auth_asym_id) of the residue's chain, as deposited and as most structure viewers label it.",
              ),
            authSeqId: z
              .number()
              .optional()
              .describe(
                'Author residue number (auth_seq_id), as deposited and as most literature and viewers number it. Related to seqId by no fixed offset; insertion codes are not reported.',
              ),
            distance: z.number().optional().describe('Contact distance to the ligand in Å.'),
          })
          .describe('A pocket residue in contact with the ligand, in both numbering namespaces.'),
      )
      .describe('Protein residues lining the pocket, nearest first.'),
  })
  .describe('A ligand instance and the protein residues lining its pocket.');

export const trackLigands = tool('protein_track_ligands', {
  title: 'protein-mcp-server: track ligands',
  description: `Ligand discovery and binding-site analysis across the PDB. mode "find_ligand" resolves a name or formula to chemical component IDs with metadata (formula, weight, SMILES), ranked by deposition frequency — most-deposited component first, so the top hit is the most common match for the name, not necessarily an exact name-string match. The ranking covers a bounded candidate pool; totalCount and candidatesConsidered report how many components matched and how many were ranked. mode "structures_with_ligand" returns PDB entries containing a ligand (by exact component ID — get the ID from find_ligand first), highest-resolution first, each with its resolution in Å. mode "binding_site" returns the protein residues lining a ligand's pocket in a given structure, with contact distances, each numbered in both the mmCIF label namespace (asymId, seqId) and the author namespace (authAsymId, authSeqId) used by deposited coordinates and most literature. Binding sites are experimental-only (computed from deposited coordinates; predicted models carry no bound ligands).`,
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
    start: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based result offset (modes structures_with_ligand and binding_site; binding_site pages ligand instances).',
      ),
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
            resolution: z
              .number()
              .optional()
              .describe(
                'Best reported resolution in Å (absent for methods without one, e.g. NMR).',
              ),
          })
          .describe('A PDB entry containing the ligand, with its resolution.'),
      )
      .optional()
      .describe(
        'PDB entries containing the ligand, highest-resolution first (structures_with_ligand).',
      ),
    bindingSites: z
      .array(bindingSiteSchema)
      .optional()
      .describe('Binding-site residues (binding_site).'),
  }),

  enrichment: {
    totalCount: z
      .number()
      .optional()
      .describe(
        'Total upstream matches before any local narrowing: PDB entries containing the component (structures_with_ligand), chemical components matching the query (find_ligand), or ligand instances with pocket contacts (binding_site).',
      ),
    candidatesConsidered: z
      .number()
      .optional()
      .describe(
        'Chemical components pulled into the deposition-frequency ranking (find_ligand). Below totalCount when the candidate pool was truncated; the ranking then covers only these candidates.',
      ),
    start: z
      .number()
      .optional()
      .describe('Zero-based offset of the structures_with_ligand or binding_site result page.'),
    nextStart: z
      .number()
      .optional()
      .describe(
        'Offset for the next structures_with_ligand or binding_site page; absent on the final or past-end page.',
      ),
    resolvedCompId: z.string().optional().describe('The chemical component ID used to query.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Advisory note: a find_ligand candidate pool smaller than the upstream match count, a structures_with_ligand page that is empty because no entry contains the component or because start is past the end, or a binding_site page that leaves instances for a later start or starts past the last instance.',
      ),
  },

  async handler(input, ctx) {
    const rcsb = getRcsbService();
    const cfg = getServerConfig();

    if (input.mode === 'find_ligand') {
      if (!input.query)
        throw ctx.fail('missing_param', 'mode find_ligand requires a name or formula in "query".', {
          ...ctx.recoveryFor('missing_param'),
        });
      // Over-fetch a candidate pool larger than the display limit, then re-rank by
      // deposition frequency and slice to the limit. The canonical component (e.g.
      // HEM for "heme") is the most-deposited but RCSB name-ranks it low, so a small
      // `limit` would never fetch it — the count re-rank can only reorder what it
      // pulls. Re-rank, never filter. Specific names match a handful of components
      // ("ATP": 7), which a pool of ~25 covers cheaply; broad words match far more
      // ("iron": 119), so the pool can truncate.
      const candidatePool = Math.max(input.limit, 25);
      const { ids, total } = await rcsb.findChemComps(input.query, candidatePool, ctx);
      // A name with more matches than the pool holds ranks only the pool, so a
      // more-deposited match beyond it can be missing — disclose that.
      ctx.enrich.total(total);
      ctx.enrich({ candidatesConsidered: ids.length });
      if (ids.length < total) {
        ctx.enrich.notice(
          `${ids.length} of ${total} components matching "${input.query}" were ranked by deposition frequency; the ranking covers only those ${ids.length}, so a more-deposited match can be missing. Narrow the query (a more specific name, a synonym, or a formula) to rank the full match set.`,
        );
      }
      const resolved = await mapWithConcurrency(ids, cfg.fanoutConcurrency, async (id) => {
        const [chem, depositionCount] = await Promise.all([
          rcsb.getChemComp(id, ctx),
          rcsb.countEntriesWithLigand(id, ctx),
        ]);
        return chem ? { ...chem, depositionCount } : null;
      });
      const ligands = resolved
        .filter((c): c is ChemComp & { depositionCount: number } => c != null)
        .sort((a, b) => b.depositionCount - a.depositionCount)
        .slice(0, input.limit);
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
      const result = await rcsb.searchByLigand(
        compId,
        { limit: input.limit, start: input.start },
        ctx,
      );
      ctx.enrich.total(result.total);
      const nextStart = input.start + result.hits.length;
      ctx.enrich({
        resolvedCompId: compId,
        start: input.start,
        ...(nextStart < result.total ? { nextStart } : {}),
      });
      // A valid component with zero containing structures is an empty result set,
      // not a not-found — mirrors protein_search_structures' empty-hits behavior.
      // An empty page over a nonzero total is an offset past the end instead.
      if (result.hits.length === 0) {
        ctx.enrich.notice(
          result.total === 0
            ? `No PDB entries contain ${compId}. Verify the component ID via mode find_ligand.`
            : `start ${input.start} is past the end of the ${result.total} PDB entries containing ${compId}. Re-call with a lower start to read a populated page.`,
        );
      }
      // Replace RCSB's uniform containment score (noise for a boolean filter) with
      // each entry's resolution, enriched via the same batched entry-metadata path
      // the other tools use. The search is resolution-sorted server-side; sort
      // again by the enriched value since getEntries does not preserve input order.
      const ids = result.hits.map((h) => h.id);
      const metaById = new Map<string, EntryMeta>();
      if (ids.length > 0) {
        for (const meta of await rcsb.getEntries(ids, ctx)) metaById.set(meta.id, meta);
      }
      const structures = ids
        .map((id) => {
          const resolution = metaById.get(id.toUpperCase())?.resolution;
          return { id, ...(typeof resolution === 'number' ? { resolution } : {}) };
        })
        .sort((a, b) => (a.resolution ?? Infinity) - (b.resolution ?? Infinity));
      return { mode: input.mode, structures };
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
    // Page binding-site INSTANCES with the shared start/limit. An entry can hold
    // more instances of one ligand than the limit ceiling (6QNR: 994 MG), so start
    // is the only way to reach the tail.
    const bindingSites = sites.slice(input.start, input.start + input.limit);
    const nextStart = input.start + bindingSites.length;
    const where = `${input.pdb_id.toUpperCase()}${compId ? ` for ${compId}` : ''}`;
    ctx.enrich.total(sites.length);
    ctx.enrich({
      start: input.start,
      ...(nextStart < sites.length ? { nextStart } : {}),
      ...(compId ? { resolvedCompId: compId } : {}),
    });
    if (bindingSites.length === 0) {
      ctx.enrich.notice(
        `start ${input.start} is past the end of the ${sites.length} binding-site instances in ${where}. Re-call with a lower start to read a populated page.`,
      );
    } else if (nextStart < sites.length) {
      ctx.enrich.notice(
        `Showing ${bindingSites.length} of ${sites.length} binding-site instances in ${where}; re-call with start ${nextStart} for the next page.`,
      );
    }
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
        typeof l.depositionCount === 'number' ? `**PDB entries:** ${l.depositionCount}` : null,
      ].filter(Boolean);
      if (parts.length > 0) lines.push(parts.join(' | '));
      if (l.smiles) lines.push(`**SMILES:** ${l.smiles}`);
      if (l.inchikey) lines.push(`**InChIKey:** ${l.inchikey}`);
    }
    if (result.structures) {
      lines.push(`\n**${result.structures.length} structures:**`);
      lines.push(result.structures.map((s) => s.id).join(', '));
      for (const s of result.structures) {
        if (typeof s.resolution === 'number')
          lines.push(`- ${s.id} — ${s.resolution.toFixed(2)} Å`);
      }
    }
    if (result.bindingSites?.length) {
      lines.push(
        '\nResidues are numbered as label_seq_id (chain = label_asym_id); the author numbering follows as auth_seq_id (chain = auth_asym_id) where reported.',
      );
    }
    for (const site of result.bindingSites ?? []) {
      const ligandIds = [
        site.ligandAsymId ? `author chain ${site.ligandAsymId}` : null,
        site.ligandAuthSeqId != null ? `residue ${site.ligandAuthSeqId}` : null,
      ].filter(Boolean);
      lines.push(
        `\n### Ligand ${site.ligandCompId}${ligandIds.length > 0 ? ` (${ligandIds.join(', ')})` : ''}`,
      );
      for (const r of site.residues) {
        const pos = r.seqId != null ? `${r.residueCompId}${r.seqId}` : r.residueCompId;
        const author = [
          r.authSeqId != null ? `author ${r.residueCompId}${r.authSeqId}` : null,
          r.authAsymId ? `${r.authSeqId != null ? '' : 'author '}chain ${r.authAsymId}` : null,
        ].filter(Boolean);
        const dist = r.distance != null ? ` — ${r.distance.toFixed(2)} Å` : '';
        lines.push(
          `- ${pos} (chain ${r.asymId}${author.length > 0 ? `; ${author.join(', ')}` : ''})${dist}`,
        );
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
