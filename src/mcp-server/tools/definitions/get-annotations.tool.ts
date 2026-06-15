/**
 * @fileoverview protein_get_annotations — sequence & functional annotation for a
 * protein: UniProt features (domains, binding sites, PTMs, variants) and InterPro
 * domain/family memberships with GO terms. Keyed by UniProt accession; resolves a
 * PDB ID to its accession when needed.
 * @module mcp-server/tools/definitions/get-annotations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getRcsbService } from '@/services/rcsb/rcsb-service.js';
import { isUniProtAccession } from '@/services/shared/identifiers.js';
import type {
  AnnotationInclude,
  InterProEntry,
  SequenceFeature,
} from '@/services/uniprot/uniprot-service.js';
import { getUniProtService } from '@/services/uniprot/uniprot-service.js';

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

export const getAnnotations = tool('protein_get_annotations', {
  title: 'protein-mcp-server: get annotations',
  description:
    'Sequence and functional annotation for a protein: UniProt features (domains, binding sites, PTMs), ' +
    'natural variants, and InterPro domain/family memberships (Pfam, PROSITE, …) with GO terms. Provide a ' +
    "UniProt accession directly, or a PDB ID — it is resolved to its UniProt accession via the structure's " +
    'sequence cross-reference. Use the "include" parameter to scope which annotation classes are fetched.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'no_uniprot_mapping',
      code: JsonRpcErrorCode.NotFound,
      when: 'A PDB ID has no UniProt cross-reference (e.g. nucleic-acid-only entry), or neither uniprot nor pdb_id was provided.',
      recovery:
        'Pass a UniProt accession directly, or use protein_search_structures to find a structure with a modeled protein chain.',
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
    include: z
      .enum(['features', 'domains', 'variants', 'all'])
      .default('all')
      .describe(
        'Which annotation classes to fetch: features, domains (InterPro), variants, or all.',
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
  }),

  enrichment: {
    resolvedFrom: z
      .string()
      .optional()
      .describe('PDB ID the accession was resolved from, when applicable.'),
    notice: z.string().optional().describe('Advisory note (e.g. no variants present).'),
  },

  async handler(input, ctx) {
    const uniprot = getUniProtService();
    const rcsb = getRcsbService();

    let accession = input.uniprot?.toUpperCase();
    let resolvedFrom: string | undefined;
    if (!accession && input.pdb_id) {
      const accessions = await rcsb.resolveUniprot(input.pdb_id, ctx);
      accession = accessions[0];
      resolvedFrom = input.pdb_id.toUpperCase();
    }
    if (!accession) {
      throw ctx.fail(
        'no_uniprot_mapping',
        'Provide a UniProt accession, or a PDB ID with a modeled protein chain.',
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

    if (resolvedFrom) ctx.enrich({ resolvedFrom });

    return {
      accession: entry.accession,
      ...(entry.proteinName ? { proteinName: entry.proteinName } : {}),
      geneNames: entry.geneNames,
      ...(entry.organism ? { organism: entry.organism } : {}),
      ...(entry.function ? { function: entry.function } : {}),
      ...(typeof entry.sequenceLength === 'number' ? { sequenceLength: entry.sequenceLength } : {}),
      ...(wantFeatures ? { features: toFeatureOutput(features) } : {}),
      ...(wantVariants ? { variants: toFeatureOutput(variants) } : {}),
      ...(wantInterPro ? { domains: interpro } : {}),
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
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

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
