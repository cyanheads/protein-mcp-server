/**
 * @fileoverview protein_get_annotations — sequence & functional annotation for a
 * protein: UniProt features (domains, binding sites, PTMs, variants) and InterPro
 * domain/family memberships with GO terms. Keyed by UniProt accession; resolves a
 * PDB ID to its accession when needed — deterministically by default, by author
 * chain when a multi-chain entry is ambiguous. Carries upstream data attribution.
 * @module mcp-server/tools/definitions/get-annotations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getRcsbService } from '@/services/rcsb/rcsb-service.js';
import type { UniProtXref } from '@/services/rcsb/types.js';
import { attributionsFor, type CuratedSource } from '@/services/shared/attribution.js';
import { isUniProtAccession } from '@/services/shared/identifiers.js';
import type {
  AnnotationInclude,
  InterProEntry,
  SequenceFeature,
} from '@/services/uniprot/uniprot-service.js';
import { getUniProtService } from '@/services/uniprot/uniprot-service.js';
import { attributionSchema, renderAttribution } from './_schemas.js';

const featureSchema = z
  .object({
    type: z.string().describe('Feature type (e.g. Domain, Binding site, Modified residue).'),
    description: z.string().optional().describe('Feature description.'),
    start: z.number().optional().describe('Start residue (1-based).'),
    end: z.number().optional().describe('End residue (1-based).'),
  })
  .describe('A sequence feature or natural variant over a residue range.');

const domainSchema = z
  .object({
    accession: z.string().describe('InterPro accession (e.g. IPR000001).'),
    name: z.string().describe('Domain/family name.'),
    type: z.string().describe('Entry type (e.g. domain, family, homologous_superfamily).'),
    memberDatabases: z
      .array(z.string())
      .describe('Contributing member databases (e.g. pfam, profile).'),
    goTerms: z
      .array(
        z
          .object({
            id: z.string().describe('GO term ID (e.g. GO:0005515).'),
            name: z.string().describe('GO term name.'),
            category: z
              .string()
              .optional()
              .describe('GO aspect (molecular_function, biological_process, …).'),
          })
          .describe('An associated Gene Ontology term.'),
      )
      .describe('Associated GO terms.'),
  })
  .describe('An InterPro domain/family membership with GO terms.');

const ambiguitySchema = z
  .object({
    accessions: z
      .array(
        z
          .object({
            chain: z
              .array(z.string())
              .describe('Author chain IDs (auth_asym_id) this entity covers (e.g. ["A", "C"]).'),
            accession: z.string().describe('UniProt accession the chains map to.'),
            proteinName: z.string().optional().describe('Polymer entity description.'),
          })
          .describe('One chain-group → UniProt accession mapping within the entry.'),
      )
      .describe('Every distinct UniProt mapping for the entry, lowest-chain first.'),
    notice: z
      .string()
      .describe('Why multiple mappings exist and how to select one via the chain input.'),
  })
  .describe(
    'Present only when a PDB ID mapped to more than one distinct UniProt accession and no chain was supplied. The returned accession is the deterministic lowest-chain pick — re-call with chain set to a specific author chain ID to select another.',
  );

type AnnotationAmbiguity = z.infer<typeof ambiguitySchema>;

export const getAnnotations = tool('protein_get_annotations', {
  title: 'protein-mcp-server: get annotations',
  description:
    'Sequence and functional annotation for a protein: UniProt features (domains, binding sites, PTMs), ' +
    'natural variants, and InterPro domain/family memberships (Pfam, PROSITE, …) with GO terms. Provide a ' +
    "UniProt accession directly, or a PDB ID — it is resolved to its UniProt accession via the structure's " +
    'sequence cross-reference. A multi-chain PDB entry can map to several accessions; the default pick is ' +
    'deterministic (lowest author chain ID) and the alternatives are listed in "ambiguity" — pass "chain" to ' +
    'select a specific one. Use "include" to scope which annotation classes are fetched. Every response carries ' +
    'an "attribution" block with the upstream data licenses and citations.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'no_uniprot_mapping',
      code: JsonRpcErrorCode.NotFound,
      when: 'A PDB ID has no UniProt cross-reference (e.g. nucleic-acid-only entry), or neither uniprot nor pdb_id was provided.',
      recovery:
        'Pass a UniProt accession directly, or use protein_search_structures to find a structure with a modeled protein chain.',
    },
    {
      reason: 'chain_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'A supplied chain matches no UniProt-mapped polymer entity in the resolved PDB entry.',
      recovery:
        'Omit chain for the deterministic default mapping, or pass an author chain ID the entry exposes (see polymerEntities[].chains in the pdb://{entry_id} resource).',
    },
  ],

  input: z.object({
    uniprot: z
      .string()
      .optional()
      .describe('UniProt accession (e.g. P69905). Takes precedence over pdb_id.'),
    pdb_id: z
      .string()
      .optional()
      .describe('PDB entry ID; resolved to a UniProt accession via cross-reference.'),
    chain: z
      .string()
      .optional()
      .describe(
        'Author chain ID (auth_asym_id, e.g. "A") that disambiguates a multi-chain PDB entry to a specific UniProt accession. Case-sensitive — must match the author chain ID exactly (large structures can carry distinct "A" and "a" chains). Only applies with pdb_id; ignored when uniprot is supplied directly. See polymerEntities[].chains in the pdb://{entry_id} resource for an entry\'s author chain IDs.',
      ),
    include: z
      .enum(['features', 'domains', 'variants', 'all'])
      .default('all')
      .describe(
        'Which annotation classes to fetch: features, domains (InterPro), variants, or all.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe(
        'Per-class cap (1–200): features, natural variants, and InterPro domains are each independently ' +
          'truncated to at most this many records. The default keeps a typical annotation set intact while ' +
          'bounding a densely-annotated protein (a well-studied protein can carry 150+ natural variants); a ' +
          'truncated class is disclosed in the response notice — raise it to retrieve more.',
      ),
  }),

  output: z.object({
    accession: z.string().describe('UniProt accession the annotations describe.'),
    proteinName: z.string().optional().describe('Recommended protein name.'),
    geneNames: z.array(z.string()).describe('Gene names.'),
    organism: z.string().optional().describe('Source organism scientific name.'),
    function: z.string().optional().describe('UniProt function summary.'),
    sequenceLength: z.number().optional().describe('Sequence length in residues.'),
    features: z.array(featureSchema).optional().describe('Structural/functional features.'),
    variants: z.array(featureSchema).optional().describe('Natural sequence variants.'),
    domains: z.array(domainSchema).optional().describe('InterPro domain/family memberships.'),
    ambiguity: ambiguitySchema
      .optional()
      .describe(
        'Alternative UniProt mappings when a PDB ID resolved ambiguously (no chain given).',
      ),
    attribution: z
      .array(attributionSchema)
      .describe(
        'Upstream data-source licenses and citations for every source that contributed to this response. Always present — the attribution obligation travels with the data.',
      ),
  }),

  enrichment: {
    resolvedFrom: z
      .string()
      .optional()
      .describe('PDB ID the accession was resolved from, when applicable.'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when at least one annotation class hit the per-class limit and was capped; the notice names each capped class with its pre-cap count.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Advisory note: a per-class "showing N of M" line for each capped class and a no-data note for any requested-but-empty class.',
      ),
  },

  async handler(input, ctx) {
    const uniprot = getUniProtService();
    const rcsb = getRcsbService();

    let accession = input.uniprot?.toUpperCase();
    let resolvedFrom: string | undefined;
    let ambiguity: AnnotationAmbiguity | undefined;

    if (!accession && input.pdb_id) {
      const entities = await rcsb.resolveUniprotEntities(input.pdb_id, ctx);
      resolvedFrom = input.pdb_id.toUpperCase();
      const chain = input.chain?.trim();
      if (chain) {
        const match = entities.find((e) => e.chains.includes(chain));
        if (!match) {
          const available = entities.flatMap((e) => e.chains);
          throw ctx.fail(
            'chain_not_found',
            `Chain "${chain}" matches no UniProt-mapped polymer entity in ${resolvedFrom}.`,
            {
              recovery: {
                hint: available.length
                  ? `Author chains in ${resolvedFrom}: ${available.join(', ')}. Pass one of these, or omit chain for the deterministic default mapping.`
                  : `${resolvedFrom} exposes no UniProt-mapped protein chains. Pass a UniProt accession directly.`,
              },
            },
          );
        }
        accession = match.accession;
      } else {
        // Deterministic default: order entities by their lowest author chain ID and
        // take the first, so the same entry always yields the same accession
        // regardless of upstream GraphQL entity ordering. When more than one distinct
        // accession exists, surface the alternatives so the caller can pick a chain.
        const ordered = orderByLowestChain(entities);
        accession = ordered[0]?.accession;
        const distinct = new Set(entities.map((e) => e.accession));
        if (accession && distinct.size > 1) {
          ambiguity = buildAmbiguity(resolvedFrom, accession, ordered, distinct.size);
        }
      }
    }

    if (!accession) {
      throw ctx.fail(
        'no_uniprot_mapping',
        'Provide a UniProt accession, or a PDB ID with a modeled protein chain.',
        { ...ctx.recoveryFor('no_uniprot_mapping') },
      );
    }
    if (!isUniProtAccession(accession)) {
      throw ctx.fail('no_uniprot_mapping', `"${accession}" is not a valid UniProt accession.`, {
        ...ctx.recoveryFor('no_uniprot_mapping'),
      });
    }

    const include = input.include as AnnotationInclude;
    const wantInterPro = include === 'domains' || include === 'all';
    const [entry, interpro] = await Promise.all([
      uniprot.getEntry(accession, include, ctx),
      wantInterPro ? uniprot.getInterPro(accession, ctx) : Promise.resolve<InterProEntry[]>([]),
    ]);

    const features = entry.features.filter((f) => f.category === 'feature');
    const variants = entry.features.filter((f) => f.category === 'variant');
    const wantFeatures = include === 'features' || include === 'all';
    const wantVariants = include === 'variants' || include === 'all';

    // Cap each annotation class independently to the per-class limit, so one dense
    // class (e.g. a protein's 150+ natural variants) can't dominate the payload.
    // Collect every advisory fragment — a "showing N of M" line per truncated class
    // plus a "no <class> present" note per requested-but-empty class — and emit them
    // as ONE notice: ctx.enrich.notice is last-wins, so a second call would silently
    // drop the first fragment.
    const { limit } = input;
    const notices: string[] = [];
    let truncated = false;
    for (const cls of [
      { want: wantFeatures, count: features.length, label: 'features' },
      { want: wantVariants, count: variants.length, label: 'variants' },
      { want: wantInterPro, count: interpro.length, label: 'domains' },
    ]) {
      if (!cls.want) continue;
      if (cls.count > limit) {
        truncated = true;
        notices.push(`Showing ${limit} of ${cls.count} ${cls.label}; raise limit to see more.`);
      } else if (cls.count === 0) {
        notices.push(`No ${cls.label} present.`);
      }
    }

    // Attribution rides with the data. UniProt always contributes on success;
    // InterPro only when it returned entries; GO only when a returned entry carries
    // GO terms. InterPro (CC0) and GO (CC BY 4.0) are gated independently — an
    // InterPro entry can exist with zero GO terms.
    const sources = new Set<CuratedSource>(['UniProt']);
    if (interpro.length > 0) sources.add('InterPro');
    if (interpro.some((d) => d.goTerms.length > 0)) sources.add('GO');

    if (resolvedFrom) ctx.enrich({ resolvedFrom });
    if (truncated) ctx.enrich({ truncated: true });
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      accession: entry.accession,
      ...(entry.proteinName ? { proteinName: entry.proteinName } : {}),
      geneNames: entry.geneNames,
      ...(entry.organism ? { organism: entry.organism } : {}),
      ...(entry.function ? { function: entry.function } : {}),
      ...(typeof entry.sequenceLength === 'number' ? { sequenceLength: entry.sequenceLength } : {}),
      ...(wantFeatures ? { features: toFeatureOutput(features.slice(0, limit)) } : {}),
      ...(wantVariants ? { variants: toFeatureOutput(variants.slice(0, limit)) } : {}),
      ...(wantInterPro ? { domains: interpro.slice(0, limit) } : {}),
      ...(ambiguity ? { ambiguity } : {}),
      attribution: attributionsFor(sources),
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## ${result.accession}${result.proteinName ? ` — ${result.proteinName}` : ''}`,
    ];
    const head = [
      result.geneNames.length > 0 ? `**Genes:** ${result.geneNames.join(', ')}` : null,
      result.organism ? `**Organism:** ${result.organism}` : null,
      typeof result.sequenceLength === 'number' ? `**Length:** ${result.sequenceLength} aa` : null,
    ].filter(Boolean);
    if (head.length > 0) lines.push(head.join(' | '));
    if (result.function) lines.push(`\n**Function:** ${result.function}`);

    if (result.ambiguity) {
      lines.push(`\n### Multiple UniProt mappings`);
      lines.push(result.ambiguity.notice);
      for (const m of result.ambiguity.accessions) {
        lines.push(
          `- **${m.accession}**${m.proteinName ? ` — ${m.proteinName}` : ''} (chains ${m.chain.join(', ') || 'none'})`,
        );
      }
    }

    if (result.features && result.features.length > 0) {
      lines.push(`\n### Features (${result.features.length})`);
      for (const f of result.features) lines.push(`- ${renderFeature(f)}`);
    }
    if (result.variants && result.variants.length > 0) {
      lines.push(`\n### Variants (${result.variants.length})`);
      for (const v of result.variants) lines.push(`- ${renderFeature(v)}`);
    }
    if (result.domains && result.domains.length > 0) {
      lines.push(`\n### InterPro domains (${result.domains.length})`);
      for (const d of result.domains) {
        lines.push(
          `- **${d.accession}** ${d.name} _(${d.type})_ — ${d.memberDatabases.join(', ') || 'no member DBs'}`,
        );
        for (const g of d.goTerms)
          lines.push(`  - ${g.id} ${g.name}${g.category ? ` [${g.category}]` : ''}`);
      }
    }
    if (result.attribution.length > 0) {
      lines.push(`\n### Attribution`);
      lines.push(...renderAttribution(result.attribution));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/** Lowest author chain ID for an entity (code-unit order); '' when it has none. */
function lowestChain(entity: UniProtXref): string {
  return [...entity.chains].sort()[0] ?? '';
}

/** Order UniProt xrefs by their lowest author chain ID — the deterministic default pick. */
function orderByLowestChain(entities: UniProtXref[]): UniProtXref[] {
  return [...entities].sort((a, b) => lowestChain(a).localeCompare(lowestChain(b)));
}

/** Assemble the ambiguity block: every distinct mapping, lowest-chain first, with a notice. */
function buildAmbiguity(
  entryId: string,
  chosen: string,
  ordered: UniProtXref[],
  distinctCount: number,
): AnnotationAmbiguity {
  return {
    accessions: ordered.map((e) => ({
      chain: e.chains,
      accession: e.accession,
      ...(e.proteinName ? { proteinName: e.proteinName } : {}),
    })),
    notice:
      `${entryId} maps to ${distinctCount} distinct UniProt accessions across its chains. ` +
      `Returning ${chosen}, the deterministic lowest-chain pick. ` +
      'Re-call with chain set to a specific author chain ID to select another.',
  };
}

function toFeatureOutput(features: SequenceFeature[]) {
  return features.map((f) => ({
    type: f.type,
    ...(f.description ? { description: f.description } : {}),
    ...(typeof f.start === 'number' ? { start: f.start } : {}),
    ...(typeof f.end === 'number' ? { end: f.end } : {}),
  }));
}

function renderFeature(f: {
  type: string;
  description?: string | undefined;
  start?: number | undefined;
  end?: number | undefined;
}): string {
  const range =
    f.start != null
      ? f.end != null && f.end !== f.start
        ? `${f.start}–${f.end}`
        : `${f.start}`
      : '';
  return `**${f.type}**${range ? ` [${range}]` : ''}${f.description ? `: ${f.description}` : ''}`;
}
