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
    featureId: z.string().optional().describe('Stable UniProt feature identifier when supplied.'),
    originalSequence: z
      .string()
      .optional()
      .describe(
        'Source-provided original amino-acid sequence; empty and absent values remain distinct.',
      ),
    alternativeSequences: z
      .array(z.string())
      .optional()
      .describe(
        'Source-provided alternatives, preserving order and empty values; absence does not assert a deletion.',
      ),
  })
  .describe('A sequence feature or natural variant over a residue range.');

const domainSchema = z
  .object({
    accession: z.string().describe('InterPro accession (e.g. IPR000001).'),
    name: z.string().describe('Domain/family name.'),
    type: z.string().describe('Entry type (e.g. domain, family, homologous_superfamily).'),
    locations: z
      .array(
        z
          .object({
            fragments: z
              .array(
                z
                  .object({
                    start: z
                      .number()
                      .optional()
                      .describe('Fragment start residue (1-based, UniProt numbering).'),
                    end: z
                      .number()
                      .optional()
                      .describe('Fragment end residue (1-based, UniProt numbering).'),
                    dcStatus: z
                      .string()
                      .optional()
                      .describe('InterPro discontinuity qualifier, as supplied.'),
                  })
                  .describe(
                    'One domain fragment; gaps between fragments are not part of the domain.',
                  ),
              )
              .optional()
              .describe('Ordered fragments within this location, when supplied.'),
          })
          .describe('One InterPro location on the requested protein.'),
      )
      .optional()
      .describe('Separate locations for this membership on the requested UniProt protein.'),
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
  description: `Sequence and functional annotation for a protein: UniProt features (domains, binding sites, PTMs), natural variants, and InterPro domain/family memberships (Pfam, PROSITE, …) with GO terms. Provide a UniProt accession directly, or a PDB ID — it is resolved to its UniProt accession via the structure's sequence cross-reference. A multi-chain PDB entry can map to several accessions; the default pick is deterministic (lowest author chain ID) and the alternatives are listed in "ambiguity" — pass "chain" to select a specific one. Use "include" to scope which annotation classes are fetched. Every response carries an "attribution" block with the upstream data licenses and citations.`,
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'missing_identifier',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Neither uniprot nor pdb_id was supplied, so there is no protein to look up.',
      recovery:
        'Provide uniprot (e.g. P69905) or pdb_id (e.g. 4HHB) — either one identifies the protein.',
    },
    {
      reason: 'invalid_accession',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The supplied uniprot value is not a syntactically valid UniProt accession.',
      recovery:
        'Pass a UniProt accession in its 6- or 10-character form (e.g. P69905, A0A024R161), or supply pdb_id instead.',
    },
    {
      reason: 'no_uniprot_mapping',
      code: JsonRpcErrorCode.NotFound,
      when: 'A supplied PDB ID resolved to no usable UniProt cross-reference (e.g. a nucleic-acid-only entry).',
      recovery:
        'Pass a UniProt accession directly, or use protein_search_structures to find a structure with a modeled protein chain.',
    },
    {
      reason: 'chain_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'A supplied chain matches no UniProt-mapped polymer entity in the resolved PDB entry.',
      recovery:
        'Omit chain for the deterministic default mapping, or pass an author chain ID the entry exposes (see polymerEntities[].authAsymIds in the pdb://{entry_id} resource).',
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
        'Author chain ID (auth_asym_id, e.g. "A") that disambiguates a multi-chain PDB entry to a specific UniProt accession. Case-sensitive — must match the author chain ID exactly (large structures can carry distinct "A" and "a" chains). Only applies with pdb_id; ignored when uniprot is supplied directly. See polymerEntities[].authAsymIds in the pdb://{entry_id} resource for an entry\'s author chain IDs.',
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
        'Per-class page size (1–200, default 50). Continue each class independently with features_offset, variants_offset, or domains_offset; the notice gives the next offset.',
      ),
    features_offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Zero-based offset into functional features; independent of variants and domains.'),
    variants_offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Zero-based offset into natural variants; independent of features and domains.'),
    domains_offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based offset into InterPro memberships; independent of features and variants.',
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
    featuresTotal: z
      .number()
      .optional()
      .describe('Total fetched functional features; present only when requested.'),
    variantsTotal: z
      .number()
      .optional()
      .describe('Total fetched natural variants; present only when requested.'),
    domainsTotal: z
      .number()
      .optional()
      .describe('Total fetched InterPro memberships; present only when requested.'),
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
        'True when at least one requested class has records after its returned page; the notice gives its next offset.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Per-class totals and next offsets, or advice to lower an exhausted offset; genuine absence is reported separately.',
      ),
  },

  async handler(input, ctx) {
    const uniprot = getUniProtService();
    const rcsb = getRcsbService();

    // Reject unusable input up front, before any upstream call: a caller that
    // omitted both parameters or mistyped an accession has an input problem, not a
    // lookup that found nothing, and the two are different next moves. Guarded
    // here rather than by a Zod refine so the rejection carries `data.reason` and
    // the declared recovery hint.
    if (!input.uniprot && !input.pdb_id) {
      throw ctx.fail('missing_identifier', 'Provide uniprot (e.g. P69905) or pdb_id (e.g. 4HHB).');
    }
    if (input.uniprot && !isUniProtAccession(input.uniprot)) {
      throw ctx.fail('invalid_accession', `"${input.uniprot}" is not a valid UniProt accession.`);
    }

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

    // Both checks below are upstream-resolution outcomes now: an absent or
    // malformed `uniprot` input was rejected before any lookup ran, so reaching
    // either means a supplied pdb_id resolved to nothing usable.
    if (!accession) {
      throw ctx.fail(
        'no_uniprot_mapping',
        'The supplied PDB ID carries no UniProt-mapped protein chain.',
      );
    }
    if (!isUniProtAccession(accession)) {
      throw ctx.fail('no_uniprot_mapping', `"${accession}" is not a valid UniProt accession.`);
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

    /** Each class pages independently. Compose once because enrichment notices are last-wins. */
    const { limit } = input;
    const notices: string[] = [];
    let truncated = false;
    for (const cls of [
      {
        want: wantFeatures,
        count: features.length,
        label: 'features',
        offset: input.features_offset,
      },
      {
        want: wantVariants,
        count: variants.length,
        label: 'variants',
        offset: input.variants_offset,
      },
      {
        want: wantInterPro,
        count: interpro.length,
        label: 'domains',
        offset: input.domains_offset,
      },
    ]) {
      if (!cls.want) continue;
      if (cls.count === 0) {
        notices.push(`No ${cls.label} present.`);
      } else if (cls.offset >= cls.count) {
        notices.push(
          `No ${cls.label} at offset ${cls.offset} (total ${cls.count}); use a lower ${cls.label}_offset, such as 0.`,
        );
      } else if (cls.offset + limit < cls.count) {
        truncated = true;
        notices.push(
          `Showing ${limit} of ${cls.count} ${cls.label} at offset ${cls.offset}; continue with ${cls.label}_offset: ${cls.offset + limit}.`,
        );
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
      ...(wantFeatures
        ? {
            features: toFeatureOutput(
              features.slice(input.features_offset, input.features_offset + limit),
            ),
            featuresTotal: features.length,
          }
        : {}),
      ...(wantVariants
        ? {
            variants: toFeatureOutput(
              variants.slice(input.variants_offset, input.variants_offset + limit),
            ),
            variantsTotal: variants.length,
          }
        : {}),
      ...(wantInterPro
        ? {
            domains: interpro.slice(input.domains_offset, input.domains_offset + limit),
            domainsTotal: interpro.length,
          }
        : {}),
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

    if (result.features) {
      lines.push(
        `\n### Features (${result.features.length}${result.featuresTotal !== undefined ? ` of ${result.featuresTotal}` : ''})`,
      );
      for (const f of result.features) lines.push(`- ${renderFeature(f)}`);
    }
    if (result.variants) {
      lines.push(
        `\n### Variants (${result.variants.length}${result.variantsTotal !== undefined ? ` of ${result.variantsTotal}` : ''})`,
      );
      for (const v of result.variants) lines.push(`- ${renderFeature(v)}`);
    }
    if (result.domains) {
      lines.push(
        `\n### InterPro domains (${result.domains.length}${result.domainsTotal !== undefined ? ` of ${result.domainsTotal}` : ''})`,
      );
      for (const d of result.domains) {
        lines.push(
          `- **${d.accession}** ${d.name} _(${d.type})_ — ${d.memberDatabases.join(', ') || 'no member DBs'}`,
        );
        for (const g of d.goTerms)
          lines.push(`  - ${g.id} ${g.name}${g.category ? ` [${g.category}]` : ''}`);
        if (d.locations !== undefined) {
          lines.push(`  - Locations: ${d.locations.length}`);
          for (const [index, location] of d.locations.entries()) {
            lines.push(
              `    - Location ${index + 1}: ${location.fragments === undefined ? 'fragments unknown' : location.fragments.length === 0 ? 'no fragments' : location.fragments.map((f) => `${f.start ?? '?'}–${f.end ?? '?'}${f.dcStatus !== undefined ? ` [${JSON.stringify(f.dcStatus)}]` : ''}`).join(', ')}`,
            );
          }
        }
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
    ...(f.featureId !== undefined ? { featureId: f.featureId } : {}),
    ...(f.originalSequence !== undefined ? { originalSequence: f.originalSequence } : {}),
    ...(f.alternativeSequences !== undefined
      ? { alternativeSequences: f.alternativeSequences }
      : {}),
  }));
}

function renderFeature(f: {
  type: string;
  description?: string | undefined;
  start?: number | undefined;
  end?: number | undefined;
  featureId?: string | undefined;
  originalSequence?: string | undefined;
  alternativeSequences?: string[] | undefined;
}): string {
  const range =
    f.start != null
      ? f.end != null && f.end !== f.start
        ? `${f.start}–${f.end}`
        : `${f.start}`
      : '';
  const change =
    f.originalSequence !== undefined || f.alternativeSequences !== undefined
      ? ` (${f.originalSequence === undefined ? '?' : JSON.stringify(f.originalSequence)} → ${f.alternativeSequences === undefined ? '?' : JSON.stringify(f.alternativeSequences)})`
      : '';
  return `**${f.type}**${range ? ` [${range}]` : ''}${f.featureId !== undefined ? ` ID ${JSON.stringify(f.featureId)}` : ''}${change}${f.description ? `: ${f.description}` : ''}`;
}
