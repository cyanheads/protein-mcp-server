/**
 * @fileoverview protein_get_annotations — sequence & functional annotation for a
 * protein: UniProt positional features (domains, sites, PTMs, topology,
 * processing, mutagenesis), natural variants, and InterPro domain/family
 * memberships with GO terms. Keyed by canonical UniProt accession; resolves a PDB
 * ID to its accession when needed — deterministically by default, by author chain
 * when a multi-chain entry is ambiguous. A merged accession answers for its
 * successor with a notice; a demerged or deleted one fails with its replacements.
 * Every upstream request shares one call budget. Carries upstream data attribution.
 * @module mcp-server/tools/definitions/get-annotations.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getRcsbService } from '@/services/rcsb/rcsb-service.js';
import type { UniProtXref } from '@/services/rcsb/types.js';
import { attributionsFor, type CuratedSource } from '@/services/shared/attribution.js';
import { withCallBudget } from '@/services/shared/call-budget.js';
import {
  canonicalAccessionOf,
  isUniProtAccession,
  isUniProtIsoform,
} from '@/services/shared/identifiers.js';
import type {
  AnnotationInclude,
  InterProMemberships,
  SequenceFeature,
  UniProtEntry,
} from '@/services/uniprot/uniprot-service.js';
import { getUniProtService, mergedAccessionNotice } from '@/services/uniprot/uniprot-service.js';
import { attributionSchema, renderAttribution } from './_schemas.js';

const featureSchema = z
  .object({
    type: z
      .string()
      .describe(
        'Feature type as UniProt names it (e.g. Domain, Binding site, Modified residue, Cross-link, Lipidation, Topological domain, Chain, Mutagenesis, Non-standard residue).',
      ),
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
  description: `Sequence and functional annotation for a protein: UniProt positional features (domains, binding and active sites, PTMs including cross-links and lipidation, topology, DNA binding, processing products such as chains and signal peptides, mutagenesis), natural variants, and InterPro domain/family memberships (Pfam, PROSITE, …) with GO terms. Provide a canonical UniProt accession directly, or a PDB ID — it is resolved to its UniProt accession via the structure's sequence cross-reference. A multi-chain PDB entry can map to several accessions; the default pick is deterministic (lowest author chain ID) and the alternatives are listed in "ambiguity" — pass "chain" to select a specific one. An accession UniProt merged into another entry answers for that successor with a notice; a demerged or deleted one fails with its replacement accessions. Use "include" to scope which annotation classes are fetched. Every response carries an "attribution" block with the upstream data licenses and citations.`,
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
      when: 'The supplied uniprot value is not a canonical UniProt accession: malformed, or an isoform accession (e.g. P04637-2), which UniProt does not annotate apart from its canonical entry.',
      recovery:
        'Pass a canonical UniProt accession in its 6- or 10-character form (e.g. P69905, A0A024R161) — for an isoform, the accession before its dash — or supply pdb_id instead.',
    },
    {
      reason: 'accession_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'UniProtKB has no entry for a well-formed accession: it was never assigned.',
      recovery:
        'Check the accession for a typo, or supply pdb_id for a structure of the protein instead.',
    },
    {
      reason: 'inactive_accession',
      code: JsonRpcErrorCode.NotFound,
      when: 'UniProt lists the accession as inactive: demerged into several entries, or deleted.',
      recovery:
        'Retry uniprot with an accession from data.replacements; an empty list means UniProt deleted the entry without a replacement.',
      thrownBy: 'service',
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
      .describe(
        'Canonical UniProt accession (e.g. P69905). Isoform accessions (e.g. P04637-2) are rejected; UniProt annotates the canonical entry. Takes precedence over pdb_id.',
      ),
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
    accession: z
      .string()
      .describe(
        'UniProt accession the annotations describe — the successor when UniProt merged the requested accession, which the notice names.',
      ),
    proteinName: z.string().optional().describe('Recommended protein name.'),
    geneNames: z.array(z.string()).describe('Gene names.'),
    organism: z.string().optional().describe('Source organism scientific name.'),
    function: z.string().optional().describe('UniProt function summary.'),
    sequenceLength: z.number().optional().describe('Sequence length in residues.'),
    features: z
      .array(featureSchema)
      .optional()
      .describe(
        'Positional features other than natural variants, in UniProt order (grouped by type). Secondary structure, isoform sequences, and sequence-record notes are not included.',
      ),
    variants: z.array(featureSchema).optional().describe('Natural sequence variants.'),
    domains: z.array(domainSchema).optional().describe('InterPro domain/family memberships.'),
    featuresTotal: z
      .number()
      .optional()
      .describe('Total positional features in the entry; present only when requested.'),
    variantsTotal: z
      .number()
      .optional()
      .describe('Total natural variants in the entry; present only when requested.'),
    domainsTotal: z
      .number()
      .optional()
      .describe(
        "InterPro's membership count for the protein; present only when requested. When InterPro paging stopped short of it, the notice names how many memberships domains_offset can reach.",
      ),
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
        'True when at least one requested class has records past its returned page (the notice gives the next offset), or InterPro paging stopped before retrieving every membership.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'The merge when UniProt merged the requested accession into another entry, first; then per class: the next offset, advice to lower an exhausted offset, an empty class, or an InterPro walk that stopped short of its count.',
      ),
  },

  async handler(input, ctx) {
    // Reject unusable input up front, before any upstream call: a caller that
    // omitted both parameters or mistyped an accession has an input problem, not a
    // lookup that found nothing, and the two are different next moves. Guarded
    // here rather than by a Zod refine so the rejection carries `data.reason` and
    // the declared recovery hint.
    if (!input.uniprot && !input.pdb_id) {
      throw ctx.fail('missing_identifier', 'Provide uniprot (e.g. P69905) or pdb_id (e.g. 4HHB).');
    }
    const requested = input.uniprot?.trim();
    if (requested && isUniProtIsoform(requested)) {
      // UniProt carries no features for an isoform accession and InterPro no memberships.
      const canonical = canonicalAccessionOf(requested);
      throw ctx.fail(
        'invalid_accession',
        `"${requested}" is an isoform of ${canonical}; UniProt annotates the canonical entry, so pass ${canonical}.`,
      );
    }
    if (requested && !isUniProtAccession(requested)) {
      throw ctx.fail('invalid_accession', `"${requested}" is not a valid UniProt accession.`);
    }

    const include = input.include as AnnotationInclude;
    const wantFeatures = include === 'features' || include === 'all';
    const wantVariants = include === 'variants' || include === 'all';
    const wantInterPro = include === 'domains' || include === 'all';

    // One budget across the PDB lookup, the UniProt entry, and every InterPro page.
    const { entry, memberships, resolvedFrom, ambiguity } = await withCallBudget(
      ctx,
      async (call) => {
        let accession = requested?.toUpperCase();
        let resolvedFrom: string | undefined;
        let ambiguity: AnnotationAmbiguity | undefined;

        if (!accession && input.pdb_id) {
          const entities = await getRcsbService().resolveUniprotEntities(input.pdb_id, call);
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

        const fetched = await fetchAnnotations(accession, include, wantInterPro, call);
        if (!fetched) {
          throw ctx.fail(
            'accession_not_found',
            `UniProtKB has no entry for ${accession}${resolvedFrom ? ` (mapped from ${resolvedFrom})` : ''}.`,
            { accession },
          );
        }
        return { ...fetched, resolvedFrom, ambiguity };
      },
    );

    const features = entry.features.filter((f) => f.category === 'feature');
    const variants = entry.features.filter((f) => f.category === 'variant');
    const domains = memberships?.entries ?? [];

    /**
     * Each class pages independently over what was retrieved. Only InterPro can
     * hold back records (`total` past what its walk retrieved). Compose once
     * because enrichment notices are last-wins; the merge notice leads.
     */
    const { limit } = input;
    const notices = entry.mergedFrom
      ? [mergedAccessionNotice(entry.mergedFrom, entry.accession)]
      : [];
    let truncated = false;
    for (const { want, count, total, label, offset } of [
      {
        want: wantFeatures,
        count: features.length,
        total: features.length,
        label: 'features',
        offset: input.features_offset,
      },
      {
        want: wantVariants,
        count: variants.length,
        total: variants.length,
        label: 'variants',
        offset: input.variants_offset,
      },
      {
        want: wantInterPro,
        count: domains.length,
        total: memberships?.total ?? 0,
        label: 'domains',
        offset: input.domains_offset,
      },
    ]) {
      if (!want) continue;
      const short = count < total;
      if (short) {
        truncated = true;
        notices.push(
          `Retrieved ${count} of ${total} ${label}; paging stopped early, so ${label}_offset reaches only those ${count}.`,
        );
      }
      if (count === 0) {
        if (!short) notices.push(`No ${label} present.`);
      } else if (offset >= count) {
        notices.push(
          `No ${label} at offset ${offset} (${short ? `${count} retrieved of ${total}` : `total ${count}`}); use a lower ${label}_offset, such as 0.`,
        );
      } else if (offset + limit < count) {
        truncated = true;
        notices.push(
          `Showing ${limit} of ${count}${short ? ' retrieved' : ''} ${label} at offset ${offset}; continue with ${label}_offset: ${offset + limit}.`,
        );
      }
    }

    // Attribution rides with the data. UniProt always contributes on success;
    // InterPro only when it returned entries; GO only when a returned entry carries
    // GO terms. InterPro (CC0) and GO (CC BY 4.0) are gated independently — an
    // InterPro entry can exist with zero GO terms.
    const sources = new Set<CuratedSource>(['UniProt']);
    if (domains.length > 0) sources.add('InterPro');
    if (domains.some((d) => d.goTerms.length > 0)) sources.add('GO');

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
      ...(memberships
        ? {
            domains: domains.slice(input.domains_offset, input.domains_offset + limit),
            domainsTotal: memberships.total,
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

/**
 * The UniProt entry and, when `wantInterPro`, its InterPro memberships. InterPro
 * starts beside the entry request under its own abort controller, so an active
 * accession pays no extra latency. Its answer is kept only when the entry is
 * live under the requested accession; otherwise the read is aborted and awaited
 * before anything returns or throws, so no InterPro request outlives the call,
 * and a merged accession then reads InterPro for its successor. `null` when
 * UniProt has no entry; the service throws `inactive_accession` for a demerged or
 * deleted accession.
 */
async function fetchAnnotations(
  accession: string,
  include: AnnotationInclude,
  wantInterPro: boolean,
  ctx: Context,
): Promise<{ entry: UniProtEntry; memberships?: InterProMemberships } | null> {
  const uniprot = getUniProtService();
  if (!wantInterPro) {
    const entry = await uniprot.getEntry(accession, include, ctx);
    return entry && { entry };
  }

  const speculation = new AbortController();
  // allSettled: an InterPro failure waits for the entry's verdict instead of rejecting unhandled.
  const speculative = Promise.allSettled([
    uniprot.getInterPro(accession, {
      ...ctx,
      signal: AbortSignal.any([ctx.signal, speculation.signal]),
    }),
  ]).then(([settled]) => settled);
  const discardSpeculation = async () => {
    speculation.abort();
    await speculative;
  };

  let entry: UniProtEntry | null;
  try {
    entry = await uniprot.getEntry(accession, include, ctx);
  } catch (err) {
    await discardSpeculation();
    throw err;
  }
  if (!entry) {
    await discardSpeculation();
    return null;
  }
  if (entry.mergedFrom) {
    await discardSpeculation();
    return { entry, memberships: await uniprot.getInterPro(entry.accession, ctx) };
  }
  const settled = await speculative;
  if (settled.status === 'rejected') throw settled.reason;
  return { entry, memberships: settled.value };
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
