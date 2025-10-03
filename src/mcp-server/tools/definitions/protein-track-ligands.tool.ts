/**
 * @fileoverview Tool definition for tracking ligands in protein structures.
 * @module src/mcp-server/tools/definitions/protein-track-ligands.tool
 */
import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import { container } from 'tsyringe';
import { z } from 'zod';

import { ProteinService } from '@/container/tokens.js';
import type {
  SdkContext,
  ToolAnnotations,
  ToolDefinition,
} from '@/mcp-server/tools/utils/toolDefinition.js';
import { withToolAuth } from '@/mcp-server/transports/auth/lib/withAuth.js';
import type { ProteinService as ProteinServiceClass } from '@/services/protein/core/ProteinService.js';
import {
  type TrackLigandsParams,
  type TrackLigandsResult,
} from '@/services/protein/types.js';
import { type RequestContext, logger } from '@/utils/index.js';

const TOOL_NAME = 'protein_track_ligands';
const TOOL_TITLE = 'Track Protein Ligands';
const TOOL_DESCRIPTION =
  'Find protein structures containing specific ligands, cofactors, drugs, or binding partners. Includes binding site details for drug discovery and molecular docking.';

const TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

const InputSchema = z
  .object({
    ligandQuery: z
      .object({
        type: z
          .enum(['name', 'chemicalId', 'smiles', 'inchi'])
          .describe(
            'Ligand query type: name (common/IUPAC), chemicalId (PDB CCD ID), smiles (SMILES string), or inchi (InChI string).',
          ),
        value: z
          .string()
          .min(1)
          .describe('Ligand identifier value corresponding to the type.'),
        matchType: z
          .enum(['strict', 'relaxed', 'relaxed-stereo', 'fingerprint'])
          .optional()
          .describe(
            'Match type for SMILES/InChI: strict (exact match), relaxed (relaxed graph matching), relaxed-stereo (with stereoisomers), fingerprint (Tanimoto similarity). Default: relaxed.',
          ),
      })
      .describe(
        'Ligand query: name (e.g., "ATP"), chemical ID, SMILES, or InChI.',
      ),
    filters: z
      .object({
        proteinName: z
          .string()
          .optional()
          .describe('Filter by protein name or keyword.'),
        organism: z
          .string()
          .optional()
          .describe('Filter by source organism scientific name.'),
        experimentalMethod: z
          .string()
          .optional()
          .describe(
            'Filter by experimental method (e.g., "X-RAY DIFFRACTION").',
          ),
        maxResolution: z
          .number()
          .positive()
          .optional()
          .describe('Maximum resolution in Angstroms.'),
      })
      .optional()
      .describe('Additional filters for protein selection.'),
    includeBindingSite: z
      .boolean()
      .default(false)
      .describe('Include binding site residue details.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe('Maximum number of results to return (1-100).'),
  })
  .describe('Parameters for ligand tracking.');

const OutputSchema = z
  .object({
    ligand: z
      .object({
        name: z.string().describe('Common or IUPAC name of the ligand.'),
        chemicalId: z
          .string()
          .describe('PDB Chemical Component Dictionary ID.'),
        formula: z.string().optional().describe('Molecular formula.'),
        molecularWeight: z
          .number()
          .optional()
          .describe('Molecular weight in Daltons.'),
      })
      .describe('Ligand identification and properties.'),
    structures: z
      .array(
        z.object({
          pdbId: z.string().describe('4-character PDB identifier.'),
          title: z.string().describe('Structure title/description.'),
          organism: z
            .array(z.string())
            .describe('Source organism(s) scientific names.'),
          resolution: z
            .number()
            .optional()
            .describe('Resolution in Angstroms (if applicable).'),
          ligandCount: z
            .number()
            .describe('Number of ligand instances in this structure.'),
          bindingSites: z
            .array(
              z.object({
                chain: z
                  .string()
                  .describe('Chain identifier containing the binding site.'),
                residues: z
                  .array(
                    z.object({
                      name: z
                        .string()
                        .describe('Three-letter residue name (e.g., "LEU").'),
                      number: z.number().describe('Residue sequence number.'),
                      interactions: z
                        .array(z.string())
                        .describe(
                          'Types of interactions (e.g., "hydrogen-bond", "hydrophobic").',
                        ),
                    }),
                  )
                  .describe('Residues involved in binding.'),
              }),
            )
            .optional()
            .describe('Binding site details (if requested).'),
        }),
      )
      .describe('Protein structures containing the ligand.'),
    totalCount: z
      .number()
      .describe('Total number of structures containing the ligand.'),
  })
  .describe('Ligand tracking results.');

type LigandInput = z.infer<typeof InputSchema>;
type LigandOutput = z.infer<typeof OutputSchema>;

async function proteinTrackLigandsLogic(
  input: LigandInput,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<LigandOutput> {
  logger.debug('Tracking ligands in structures', {
    ...appContext,
    toolInput: input,
  });

  const params: TrackLigandsParams = {
    ligandQuery: input.ligandQuery,
    filters: input.filters,
    includeBindingSite: input.includeBindingSite,
    limit: input.limit,
  };

  const proteinService = container.resolve<ProteinServiceClass>(ProteinService);
  const result: TrackLigandsResult = await proteinService.trackLigands(
    params,
    appContext,
  );

  logger.info('Ligand tracking completed', {
    ...appContext,
    ligand: result.ligand.chemicalId,
    structureCount: result.structures.length,
  });

  return result;
}

function responseFormatter(result: LigandOutput): ContentBlock[] {
  const chemicalProperties = [
    result.ligand.formula ? `Formula: ${result.ligand.formula}` : '',
    result.ligand.molecularWeight
      ? `MW: ${result.ligand.molecularWeight.toFixed(2)} Da`
      : '',
  ]
    .filter(Boolean)
    .join(' | ');

  const summary = `Ligand: ${result.ligand.name} (${result.ligand.chemicalId})${chemicalProperties ? `\n${chemicalProperties}` : ''}\nFound in ${result.totalCount} structure(s)`;

  const preview =
    result.structures.length > 0
      ? result.structures
          .slice(0, 5)
          .map((s) => {
            const organismStr =
              s.organism.length > 0
                ? `\n  Organism: ${s.organism.slice(0, 2).join(', ')}`
                : '';
            const instanceStr = `${s.ligandCount} instance${s.ligandCount !== 1 ? 's' : ''}`;
            const resolutionStr = s.resolution
              ? ` | ${s.resolution.toFixed(2)}Å`
              : '';

            let bindingSiteInfo = '';
            if (s.bindingSites && s.bindingSites.length > 0) {
              const totalResidues = s.bindingSites.reduce(
                (sum, site) => sum + site.residues.length,
                0,
              );
              const chains = [
                ...new Set(s.bindingSites.map((site) => site.chain)),
              ].join(', ');
              bindingSiteInfo = `\n  Binding Site: ${s.bindingSites.length} sites on chain(s) ${chains} (${totalResidues} residues)`;
            }

            return `• ${s.pdbId}: ${s.title.slice(0, 45)} (${instanceStr}${resolutionStr})${organismStr}${bindingSiteInfo}`;
          })
          .join('\n\n')
      : 'No structures found.';

  return [
    {
      type: 'text',
      text: `${summary}\n\n${preview}${result.structures.length > 5 ? `\n\n... and ${result.totalCount - 5} more structures` : ''}`,
    },
  ];
}

export const proteinTrackLigandsTool: ToolDefinition<
  typeof InputSchema,
  typeof OutputSchema
> = {
  name: TOOL_NAME,
  title: TOOL_TITLE,
  description: TOOL_DESCRIPTION,
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  annotations: TOOL_ANNOTATIONS,
  logic: withToolAuth(['tool:protein:search'], proteinTrackLigandsLogic),
  responseFormatter,
};
