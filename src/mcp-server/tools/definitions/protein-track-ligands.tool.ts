/**
 * @fileoverview Tool definition for tracking ligands in protein structures.
 * @module src/mcp-server/tools/definitions/protein-track-ligands.tool
 */
import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import { inject, injectable } from 'tsyringe';
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
        type: z.enum(['name', 'chemicalId', 'smiles']),
        value: z.string().min(1),
      })
      .describe('Ligand query: name (e.g., "ATP"), chemical ID, or SMILES.'),
    filters: z
      .object({
        proteinName: z.string().optional(),
        organism: z.string().optional(),
        experimentalMethod: z.string().optional(),
        maxResolution: z.number().positive().optional(),
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
      .describe('Max results.'),
  })
  .describe('Parameters for ligand tracking.');

const OutputSchema = z.object({
  ligand: z.object({
    name: z.string(),
    chemicalId: z.string(),
    formula: z.string().optional(),
    molecularWeight: z.number().optional(),
  }),
  structures: z.array(
    z.object({
      pdbId: z.string(),
      title: z.string(),
      organism: z.array(z.string()),
      resolution: z.number().optional(),
      ligandCount: z.number(),
      bindingSites: z
        .array(
          z.object({
            chain: z.string(),
            residues: z.array(
              z.object({
                name: z.string(),
                number: z.number(),
                interactions: z.array(z.string()),
              }),
            ),
          }),
        )
        .optional(),
    }),
  ),
  totalCount: z.number(),
});

type LigandInput = z.infer<typeof InputSchema>;
type LigandOutput = z.infer<typeof OutputSchema>;

@injectable()
class ProteinTrackLigandsLogic {
  constructor(
    @inject(ProteinService) private proteinService: ProteinServiceClass,
  ) {}

  async execute(
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

    const result: TrackLigandsResult = await this.proteinService.trackLigands(
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
}

function responseFormatter(result: LigandOutput): ContentBlock[] {
  const summary = [
    `Ligand: ${result.ligand.name} (${result.ligand.chemicalId})`,
    result.ligand.formula ? `Formula: ${result.ligand.formula}` : '',
    `Found in ${result.totalCount} structure(s)`,
  ]
    .filter(Boolean)
    .join('\n');

  const preview =
    result.structures.length > 0
      ? result.structures
          .slice(0, 5)
          .map(
            (s) =>
              `• ${s.pdbId}: ${s.title.slice(0, 50)}${s.resolution ? ` (${s.resolution.toFixed(2)}Å)` : ''} - ${s.ligandCount} ligand(s)`,
          )
          .join('\n')
      : 'No structures found.';

  return [
    {
      type: 'text',
      text: `${summary}\n\n${preview}`,
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
  logic: withToolAuth(
    ['tool:protein:search'],
    async (input, appContext, sdkContext) => {
      const logic = new ProteinTrackLigandsLogic(
        (
          globalThis as { container?: { resolve: (token: symbol) => unknown } }
        ).container?.resolve(ProteinService) as ProteinServiceClass,
      );
      return logic.execute(input, appContext, sdkContext);
    },
  ),
  responseFormatter,
};
