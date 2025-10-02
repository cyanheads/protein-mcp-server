/**
 * @fileoverview Tool definition for comparing protein structures.
 * @module src/mcp-server/tools/definitions/protein-compare-structures.tool
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
  AlignmentMethod,
  type CompareStructuresParams,
  type CompareStructuresResult,
} from '@/services/protein/types.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { type RequestContext, logger } from '@/utils/index.js';

const TOOL_NAME = 'protein_compare_structures';
const TOOL_TITLE = 'Compare Protein Structures';
const TOOL_DESCRIPTION =
  'Compare multiple protein structures using structural alignment. Calculate RMSD, TM-score, and identify flexible/rigid regions. Useful for analyzing conformational changes and structural similarities.';

const TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

const InputSchema = z
  .object({
    pdbIds: z
      .array(
        z
          .string()
          .length(4)
          .regex(/^[0-9A-Z]{4}$/i),
      )
      .min(2, 'At least 2 structures required for comparison.')
      .max(10, 'Maximum 10 structures can be compared at once.')
      .describe('Array of PDB IDs to compare (2-10 structures).'),
    alignmentMethod: z
      .nativeEnum(AlignmentMethod)
      .default(AlignmentMethod.CEALIGN)
      .describe('Alignment algorithm to use.'),
    chainSelections: z
      .array(
        z.object({
          pdbId: z.string().describe('PDB ID.'),
          chain: z.string().describe('Chain identifier.'),
        }),
      )
      .optional()
      .describe(
        'Specific chain selections (default: auto-select first chain).',
      ),
    includeVisualization: z
      .boolean()
      .default(false)
      .describe('Include PyMOL/ChimeraX visualization script.'),
  })
  .describe('Parameters for structure comparison.');

const OutputSchema = z
  .object({
    alignment: z.object({
      method: z.string().describe('Alignment method used.'),
      rmsd: z.number().describe('Root Mean Square Deviation in Angstroms.'),
      alignedResidues: z.number().describe('Number of aligned residues.'),
      sequenceIdentity: z.number().describe('Sequence identity percentage.'),
      tmscore: z.number().optional().describe('TM-score (0-1, optional).'),
    }),
    pairwiseComparisons: z.array(
      z.object({
        pdbId1: z.string(),
        pdbId2: z.string(),
        rmsd: z.number(),
        alignedLength: z.number(),
      }),
    ),
    conformationalAnalysis: z
      .object({
        flexibleRegions: z.array(
          z.object({
            residueRange: z.tuple([z.number(), z.number()]),
            rmsd: z.number(),
          }),
        ),
        rigidCore: z.object({
          residueCount: z.number(),
          rmsd: z.number(),
        }),
      })
      .optional(),
    visualization: z.string().optional().describe('Visualization script.'),
  })
  .describe('Structure comparison results.');

type CompareInput = z.infer<typeof InputSchema>;
type CompareOutput = z.infer<typeof OutputSchema>;

@injectable()
class ProteinCompareLogic {
  constructor(
    @inject(ProteinService) private proteinService: ProteinServiceClass,
  ) {}

  async execute(
    input: CompareInput,
    appContext: RequestContext,
    _sdkContext: SdkContext,
  ): Promise<CompareOutput> {
    logger.debug('Comparing protein structures', {
      ...appContext,
      toolInput: input,
    });

    if (input.pdbIds.length < 2) {
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        'At least 2 structures required for comparison',
        { requestId: appContext.requestId },
      );
    }

    const params: CompareStructuresParams = {
      pdbIds: input.pdbIds.map((id) => id.toUpperCase()),
      alignmentMethod: input.alignmentMethod,
      chainSelections: input.chainSelections,
      includeVisualization: input.includeVisualization,
    };

    const result: CompareStructuresResult =
      await this.proteinService.compareStructures(params, appContext);

    logger.info('Structure comparison completed', {
      ...appContext,
      structureCount: input.pdbIds.length,
      rmsd: result.alignment.rmsd,
    });

    return result;
  }
}

function responseFormatter(result: CompareOutput): ContentBlock[] {
  const summary = [
    `Alignment: ${result.alignment.method}`,
    `RMSD: ${result.alignment.rmsd.toFixed(2)}Å`,
    `Aligned residues: ${result.alignment.alignedResidues}`,
    `Sequence identity: ${result.alignment.sequenceIdentity.toFixed(1)}%`,
    result.alignment.tmscore
      ? `TM-score: ${result.alignment.tmscore.toFixed(3)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const pairwise =
    result.pairwiseComparisons.length > 0
      ? result.pairwiseComparisons
          .slice(0, 5)
          .map((p) => `${p.pdbId1} vs ${p.pdbId2}: ${p.rmsd.toFixed(2)}Å`)
          .join('\n')
      : '';

  return [
    {
      type: 'text',
      text: `${summary}${pairwise ? `\n\nPairwise:\n${pairwise}` : ''}`,
    },
  ];
}

export const proteinCompareStructuresTool: ToolDefinition<
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
    ['tool:protein:analyze'],
    async (input, appContext, sdkContext) => {
      const logic = new ProteinCompareLogic(
        (
          globalThis as { container?: { resolve: (token: symbol) => unknown } }
        ).container?.resolve(ProteinService) as ProteinServiceClass,
      );
      return logic.execute(input, appContext, sdkContext);
    },
  ),
  responseFormatter,
};
