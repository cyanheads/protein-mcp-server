/**
 * @fileoverview protein_track_ligands — ligand discovery and binding-site
 * analysis. Resolves a ligand name/formula to chemical component IDs, finds PDB
 * entries holding a bound copy of a ligand (each named by title, method, and the
 * polymer entities whose chains carry it), or returns the polymer residues
 * (amino acids or nucleotides) lining a ligand's pocket in a structure (via
 * RCSB `rcsb_target_neighbors`).
 * @module mcp-server/tools/definitions/track-ligands.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { getRcsbService, type RcsbService } from '@/services/rcsb/rcsb-service.js';
import type {
  ChemComp,
  EntryBindingSites,
  EntryMeta,
  PolymerLigand,
} from '@/services/rcsb/types.js';
import { mapWithConcurrency } from '@/services/shared/async.js';
import { cancelledByCaller, withCallBudget } from '@/services/shared/call-budget.js';
import { isComputedModelId } from '@/services/shared/identifiers.js';

/**
 * The polymer entities whose author chains carry an instance of `compId`, in
 * the entity-number order `getEntries` returns them. The chain assignment is the
 * depositor's, so a ligand at a subunit interface names only its assigned
 * chain's entity, not every entity it contacts.
 */
function hostEntities(meta: EntryMeta, compId: string) {
  const ligandChains = new Set(
    meta.ligands
      .filter((l) => l.compId.toUpperCase() === compId)
      .flatMap((l) => l.authAsymIds ?? []),
  );
  return meta.polymerEntities
    .filter((e) => e.authAsymIds?.some((chain) => ligandChains.has(chain)))
    .map((e) => ({
      entityId: e.entityId,
      ...(e.description ? { description: e.description } : {}),
      ...(e.organisms ? { organisms: e.organisms } : {}),
    }));
}

/**
 * The structures_with_ligand notice for a component no entry holds a bound
 * copy of, telling an ID the Chemical Component Dictionary lacks (ZZZZZ) from a
 * real component with no bound copy (000). One lookup, made on this path only.
 * A lookup that fails or that the call budget stopped is disclosed as
 * unchecked; a caller's cancellation stays a cancellation.
 */
async function zeroHitNotice(rcsb: RcsbService, compId: string, ctx: Context): Promise<string> {
  const named = escapeMarkdownInline(compId);
  const chem = await rcsb.getChemComp(compId, ctx).catch((err: unknown) => {
    if (cancelledByCaller(ctx)) throw err;
    ctx.log.warning('Chemical component lookup failed', {
      compId,
      error: err instanceof Error ? err.message : err,
    });
    return 'unchecked' as const;
  });
  if (chem === 'unchecked') {
    return `No PDB entry holds a bound (non-polymer) copy of ${named}. The Chemical Component Dictionary lookup that tells an unknown ID from a component with no bound copy failed; verify the ID via mode find_ligand.`;
  }
  if (!chem) {
    return `${named} is not a chemical component ID: the Chemical Component Dictionary has no entry for it, so no PDB entry contains it. Resolve a ligand name or formula to its ID via mode find_ligand.`;
  }
  const name = chem.name ? ` (${escapeMarkdownInline(chem.name)})` : '';
  return `No PDB entry holds a bound (non-polymer) copy of ${named}${name}, a chemical component the Chemical Component Dictionary defines; a copy found only inside a polymer chain or a branched glycan is not counted.`;
}

/** A polymer-chain ligand as a binding_site miss names it: `1CWA_2 (CYCLOSPORIN A; BIRD PRD_000142; chain C)`. */
function describePolymerLigand(ligand: PolymerLigand): string {
  const chains = ligand.authAsymIds
    ? `chain${ligand.authAsymIds.length > 1 ? 's' : ''} ${ligand.authAsymIds.join(', ')}`
    : undefined;
  const details = [ligand.description, `BIRD ${ligand.prdId}`, chains].filter(Boolean);
  return `${ligand.entityId} (${details.join('; ')})`;
}

/**
 * The binding_site miss for an entry with no pocket contacts to return, built
 * from the one response that found none. The message names every component and
 * polymer-chain ligand `data` lists, since content[] renders only the message
 * and the hint.
 */
function bindingSiteMiss(
  pdbId: string,
  compId: string | undefined,
  result: Exclude<EntryBindingSites, { kind: 'found' }>,
): {
  data?: { heldComponents: string[]; polymerLigands: PolymerLigand[] };
  hint: string;
  message: string;
} {
  if (result.kind === 'entry_not_found') {
    return {
      message: isComputedModelId(pdbId)
        ? `RCSB has no computed model ${pdbId}.`
        : `RCSB has no current PDB entry ${pdbId} (obsoleted, unreleased, or never assigned).`,
      hint: 'Check the ID for a typo, or find a current entry with protein_search_structures.',
    };
  }
  const { heldComponents: held, polymerLigands } = result;
  if (isComputedModelId(pdbId) && held.length === 0 && polymerLigands.length === 0) {
    return {
      message: `${pdbId} is a computed model, and computed models carry no bound ligands.`,
      hint: 'Binding sites are experimental-only: pass an experimental PDB entry, which protein_search_structures finds.',
    };
  }

  let message: string;
  if (held.length === 0) {
    message = `${pdbId} holds no bound non-polymer component${compId ? `, so it holds no ${compId}` : ''}.`;
  } else {
    const outcome = !compId
      ? ', none with pocket contacts'
      : held.includes(compId)
        ? `; RCSB reports no pocket contacts for ${compId}`
        : `; none is ${compId}`;
    message = `${pdbId} holds bound ${held.join(', ')}${outcome}.`;
  }
  if (polymerLigands.length > 0) {
    message += ` Polymer-chain ligands: ${polymerLigands.map(describePolymerLigand).join('; ')}.`;
  }

  const hints: string[] = [];
  const others = compId ? held.filter((c) => c !== compId) : [];
  if (others.length > 0) {
    const choice = others.length === 1 ? others[0] : `one of ${others.join(', ')}`;
    hints.push(
      `Pass ${choice} as comp_id, or omit comp_id to list every ligand with pocket contacts.`,
    );
  }
  if (polymerLigands.length > 0) {
    hints.push(
      `binding_site covers non-polymer ligands only, so a ligand deposited as a polymer chain (${polymerLigands.map((p) => p.entityId).join(', ')}) has no pocket contacts to report.`,
    );
  }
  if (hints.length === 0) {
    hints.push(
      'Mode structures_with_ligand lists the PDB entries holding a bound copy of a given component.',
    );
  }
  return { message, hint: hints.join(' '), data: { heldComponents: held, polymerLigands } };
}

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
        'Number of PDB entries holding a bound (non-polymer) copy of this component — the totalCount structures_with_ligand reports for it. Entries where it occurs only as a residue inside a polymer chain or a sugar inside a branched glycan are not counted. Candidates are ranked by this value, most-deposited first.',
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
            residueCompId: z
              .string()
              .describe(
                'Interacting residue type: an amino acid (e.g. ASP) or a nucleotide (e.g. DA).',
              ),
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
      .describe(
        'Polymer residues lining the pocket, nearest first: amino acids, or nucleotides where the ligand binds DNA or RNA.',
      ),
  })
  .describe('A ligand instance and the polymer residues lining its pocket.');

export const trackLigands = tool('protein_track_ligands', {
  title: 'protein-mcp-server: track ligands',
  description: `Ligand discovery and binding-site analysis across the PDB. mode "find_ligand" resolves a name or formula to chemical component IDs with metadata (formula, weight, SMILES), ranked by deposition frequency — most-deposited component first, so the top hit is the most common match for the name, not necessarily an exact name-string match. The ranking runs in blocks of max(limit, 25) candidates in RCSB's name-match order: start pages through the ranked blocks (keep limit fixed while paging), and totalCount and candidatesConsidered report how many components matched and how many the page ranked. mode "structures_with_ligand" returns PDB entries holding a bound copy of a ligand (by exact component ID — get the ID from find_ligand first), highest-resolution first, each with its resolution in Å, title, method, and the polymer entities whose chains carry the ligand. This mode and find_ligand's depositionCount count bound copies only: a component present only as a residue inside a polymer chain (e.g. MSE in a selenomethionine protein) or a sugar inside a branched glycan is not counted. mode "binding_site" returns the polymer residues lining a ligand's pocket in a given structure — amino acids, or nucleotides where the ligand binds DNA or RNA — with contact distances, each numbered in both the mmCIF label namespace (asymId, seqId) and the author namespace (authAsymId, authSeqId) used by deposited coordinates and most literature. Binding sites are experimental-only (computed from deposited coordinates; predicted models carry no bound ligands) and cover non-polymer ligands only: a peptide-like ligand deposited as a polymer chain (a BIRD molecule such as cyclosporin A in 1CWA) has none, and a miss names the components and polymer-chain ligands the entry does hold.`,
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
      when: 'No chemical component matched the find_ligand query; or, in binding_site, no ligand instance has pocket contacts: RCSB has no current entry under pdb_id, the entry is a computed model, or it holds no bound copy of comp_id with contacts.',
      recovery:
        'Use mode "find_ligand" to resolve a name to a component ID; for binding_site, pass a component the entry holds as comp_id, since a ligand deposited as a polymer chain has no pocket contacts.',
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
        'Zero-based result offset: find_ligand pages its ranked candidates, structures_with_ligand its entries, binding_site its ligand instances.',
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
            id: z.string().describe('PDB entry ID holding a bound copy of the ligand.'),
            resolution: z
              .number()
              .optional()
              .describe(
                'Best reported resolution in Å (absent for methods without one, e.g. NMR).',
              ),
            title: z.string().optional().describe('Structure title. Omitted when unreported.'),
            method: z
              .string()
              .optional()
              .describe('Experimental method(s), comma-joined. Omitted when unreported.'),
            hostEntities: z
              .array(
                z
                  .object({
                    entityId: z.string().describe('Polymer entity ID (e.g. 3K5V_1).'),
                    description: z
                      .string()
                      .optional()
                      .describe('Entity description (e.g. Tyrosine-protein kinase ABL1).'),
                    organisms: z
                      .array(z.string())
                      .optional()
                      .describe(
                        'Distinct source organisms of the entity. Omitted when upstream names none.',
                      ),
                  })
                  .describe('A polymer entity carrying an instance of the ligand.'),
              )
              .optional()
              .describe(
                "Polymer entities whose author chains carry an instance of the ligand, in entity-number order. The chain assignment is the depositor's, so a ligand at a subunit interface lists only its assigned chain's entity — use mode binding_site for the residues it contacts. Omitted when no polymer chain carries an instance.",
              ),
          })
          .describe(
            'A PDB entry holding a bound copy of the ligand: its resolution, title, method, and host entities.',
          ),
      )
      .optional()
      .describe(
        'PDB entries holding a bound (non-polymer) copy of the ligand, highest-resolution first (structures_with_ligand).',
      ),
    bindingSites: z
      .array(bindingSiteSchema)
      .optional()
      .describe(
        'Ligand instances and their pocket residues (binding_site), in a fixed order — ligands by entity number, then the instances of each ligand by author chain and author residue number — so start/limit pages read every instance exactly once.',
      ),
  }),

  enrichment: {
    totalCount: z
      .number()
      .optional()
      .describe(
        'Total upstream matches before any local narrowing: PDB entries holding a bound (non-polymer) copy of the component (structures_with_ligand), chemical components matching the query (find_ligand), or ligand instances with pocket contacts (binding_site).',
      ),
    candidatesConsidered: z
      .number()
      .optional()
      .describe(
        'Chemical components the find_ligand page ranked by deposition frequency: the one or two blocks of max(limit, 25) name matches holding the page. Below totalCount when the matches run past those blocks; the ranking then covers only these candidates.',
      ),
    start: z.number().optional().describe('Zero-based offset of the result page.'),
    nextStart: z
      .number()
      .optional()
      .describe('Offset for the next page; absent on the final or past-end page.'),
    resolvedCompId: z.string().optional().describe('The chemical component ID used to query.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Advisory note: a find_ligand page whose ranked blocks hold fewer candidates than the upstream match count, or whose start is past the end; a structures_with_ligand page that is empty because no entry holds a bound copy of the component (saying whether the ID is a chemical component at all) or because start is past the end; or a binding_site page that leaves instances for a later start or starts past the last instance.',
      ),
  },

  async handler(input, ctx) {
    const rcsb = getRcsbService();
    const cfg = getServerConfig();

    if (input.mode === 'find_ligand') {
      const { query } = input;
      if (!query)
        throw ctx.fail('missing_param', 'mode find_ligand requires a name or formula in "query".');
      // Re-rank by deposition frequency, never filter: the canonical component
      // (HEM for "heme") is the most-deposited, but RCSB name-ranks it low, so
      // ranking only the displayed rows would never surface it. Ranking a whole
      // match set costs two requests per component ("acid": 12,412), so candidates
      // are ranked in fixed blocks of max(limit, 25) in RCSB's name-match order,
      // which is stable across calls, and start pages the ranked blocks. Every
      // page reads at most two blocks, and a walk reads each candidate once. A
      // pool that re-ranked the first start + limit matches would repeat and skip
      // candidates between pages instead (live "iron": page 2 repeated 11 of page
      // 1 and never showed FE, SF4, or FE2, the three most deposited).
      const block = Math.max(input.limit, 25);
      const from = Math.floor(input.start / block) * block;
      const to = Math.ceil((input.start + input.limit) / block) * block;
      // The name search and the two requests per candidate share one budget.
      const { ids, total, resolved } = await withCallBudget(ctx, async (call) => {
        const matches = await rcsb.findChemComps(query, { start: from, limit: to - from }, call);
        if (input.start >= matches.total) return { ...matches, resolved: [] };
        const resolved = await mapWithConcurrency(
          matches.ids,
          cfg.fanoutConcurrency,
          async (id) => {
            const [chem, depositionCount] = await Promise.all([
              rcsb.getChemComp(id, call),
              rcsb.countEntriesWithLigand(id, call),
            ]);
            return chem ? { ...chem, depositionCount } : null;
          },
        );
        return { ...matches, resolved };
      });
      const noMatch = () =>
        ctx.fail('not_found', `No chemical component matched "${query}".`, {
          recovery: {
            hint: `No ligand matched "${query}". Try the exact name, a synonym, or a formula.`,
          },
        });
      if (total === 0) throw noMatch();
      const named = escapeMarkdownInline(query);
      const nextStart = input.start + input.limit;
      ctx.enrich.total(total);
      ctx.enrich({ start: input.start, ...(nextStart < total ? { nextStart } : {}) });
      if (input.start >= total) {
        ctx.enrich.notice(
          `start ${input.start} is past the end of the ${total} components matching "${named}". Re-call with a lower start to read a populated page.`,
        );
        return { mode: input.mode, ligands: [] };
      }
      // Blocks short of the whole match set rank only what they hold, so a
      // more-deposited match in another block can be missing — disclose that.
      ctx.enrich({ candidatesConsidered: ids.length });
      if (ids.length < total) {
        const next =
          nextStart < total
            ? `Re-call with start ${nextStart} for the next page, or narrow`
            : 'Narrow';
        ctx.enrich.notice(
          `${ids.length} of ${total} components matching "${named}" were ranked by deposition frequency (name matches ${from + 1}–${from + ids.length}, in blocks of ${block}); the ranking covers only those ${ids.length}, so a more-deposited match can sit in another block. ${next} the query (a more specific name, a synonym, or a formula) to rank the full match set.`,
        );
      }
      // Each block ranks on its own: resolved components most-deposited first
      // (ties keep name order), then the IDs that resolved to nothing, so a
      // position holds the same candidate whichever page reads it.
      type Ranked = ChemComp & { depositionCount: number };
      const ranked: Array<Ranked | null> = [];
      for (let i = 0; i < resolved.length; i += block) {
        const part = resolved.slice(i, i + block);
        ranked.push(
          ...part
            .filter((c): c is Ranked => c != null)
            .sort((a, b) => b.depositionCount - a.depositionCount),
          ...part.filter((c) => c == null),
        );
      }
      const offset = input.start - from;
      const ligands = ranked
        .slice(offset, offset + input.limit)
        .filter((c): c is Ranked => c != null);
      if (ligands.length === 0 && input.start === 0) throw noMatch();
      return { mode: input.mode, ligands };
    }

    if (input.mode === 'structures_with_ligand') {
      const compId = input.comp_id?.trim().toUpperCase();
      if (!compId)
        throw ctx.fail('missing_param', 'mode structures_with_ligand requires a "comp_id".');
      // The search and the request after it (entry metadata, or the zero-hit
      // component lookup) share one budget.
      const structures = await withCallBudget(ctx, async (call) => {
        const result = await rcsb.searchByLigand(
          compId,
          { limit: input.limit, start: input.start },
          call,
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
              ? await zeroHitNotice(rcsb, compId, call)
              : `start ${input.start} is past the end of the ${result.total} PDB entries containing ${escapeMarkdownInline(compId)}. Re-call with a lower start to read a populated page.`,
          );
          return [];
        }
        // Replace RCSB's uniform containment score (noise for a boolean filter) with
        // each entry's resolution, title, method, and host entities, all read from
        // the one batched entry-metadata call. The search is resolution-sorted
        // server-side; sort again by the enriched value since getEntries does not
        // preserve input order.
        const ids = result.hits.map((h) => h.id);
        const metaById = new Map<string, EntryMeta>();
        for (const meta of await rcsb.getEntries(ids, call)) metaById.set(meta.id, meta);
        return ids
          .map((id) => {
            const meta = metaById.get(id.toUpperCase());
            const hosts = meta ? hostEntities(meta, compId) : [];
            return {
              id,
              ...(typeof meta?.resolution === 'number' ? { resolution: meta.resolution } : {}),
              ...(meta?.title ? { title: meta.title } : {}),
              ...(meta?.methods && meta.methods.length > 0
                ? { method: meta.methods.join(', ') }
                : {}),
              ...(hosts.length > 0 ? { hostEntities: hosts } : {}),
            };
          })
          .sort((a, b) => (a.resolution ?? Infinity) - (b.resolution ?? Infinity));
      });
      return { mode: input.mode, structures };
    }

    // binding_site
    const compId = input.comp_id?.trim().toUpperCase();
    const pdbId = input.pdb_id?.trim();
    if (!pdbId) throw ctx.fail('missing_param', 'mode binding_site requires a "pdb_id".');
    // One request, but its retries (4 attempts × 30 s) could outlast a client's 60 s timeout.
    const result = await withCallBudget(ctx, (call) => rcsb.getBindingSites(pdbId, compId, call));
    if (result.kind !== 'found') {
      const miss = bindingSiteMiss(pdbId.toUpperCase(), compId, result);
      throw ctx.fail('not_found', miss.message, { ...miss.data, recovery: { hint: miss.hint } });
    }
    const { sites } = result;
    // Page binding-site INSTANCES with the shared start/limit. An entry can hold
    // more instances of one ligand than the limit ceiling (6QNR: 994 MG), so start
    // is the only way to reach the tail.
    const bindingSites = sites.slice(input.start, input.start + input.limit);
    const nextStart = input.start + bindingSites.length;
    const where = `${pdbId.toUpperCase()}${compId ? ` for ${compId}` : ''}`;
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
        const details = [
          typeof s.resolution === 'number' ? `${s.resolution.toFixed(2)} Å` : null,
          s.method ?? null,
          s.title ?? null,
        ].filter(Boolean);
        // A row with nothing past its ID is already in the list above.
        if (details.length === 0 && !s.hostEntities) continue;
        lines.push([`- ${s.id}`, ...details].join(' — '));
        for (const h of s.hostEntities ?? []) {
          lines.push(
            `  - host entity ${h.entityId}${h.description ? `: ${h.description}` : ''}${h.organisms ? ` (${h.organisms.join(', ')})` : ''}`,
          );
        }
      }
    }
    if (result.bindingSites?.length) {
      lines.push(
        '\nPocket residues are the polymer residues (amino acids or nucleotides) in contact with each ligand, numbered as label_seq_id (chain = label_asym_id); the author numbering follows as auth_seq_id (chain = auth_asym_id) where reported.',
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
