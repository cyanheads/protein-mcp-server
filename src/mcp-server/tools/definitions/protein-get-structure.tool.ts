/**
 * @fileoverview Tool definition for retrieving detailed protein structure data.
 * @module src/mcp-server/tools/definitions/protein-get-structure.tool
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
  StructureFormat,
  type GetStructureOptions,
  type ProteinStructure,
} from '@/services/protein/types.js';
import { type RequestContext, logger } from '@/utils/index.js';

const TOOL_NAME = 'protein_get_structure';
const TOOL_TITLE = 'Get Protein Structure';
const TOOL_DESCRIPTION =
  'Retrieve complete 3D structure data for a specific PDB entry including coordinates, experimental metadata, and annotations. Use this after searching to get detailed structural information.';

const TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

const InputSchema = z
  .object({
    pdbId: z
      .string()
      .length(4, 'PDB ID must be exactly 4 characters.')
      .regex(/^[0-9A-Z]{4}$/i, 'PDB ID must be alphanumeric.')
      .describe('4-character PDB identifier (e.g., "1ABC", "2GBP").'),
    format: z
      .nativeEnum(StructureFormat)
      .default(StructureFormat.MMCIF)
      .describe(
        'Structure file format: mmcif (modern, recommended), bcif (binary, efficient), pdb (legacy), pdbml (XML), or json (metadata only).',
      ),
    includeCoordinates: z
      .boolean()
      .default(true)
      .describe(
        'Include 3D coordinate data (disable for metadata-only queries).',
      ),
    includeExperimentalData: z
      .boolean()
      .default(true)
      .describe(
        'Include experimental metadata (resolution, R-factors, unit cell).',
      ),
    includeAnnotations: z
      .boolean()
      .default(true)
      .describe('Include functional annotations and citations.'),
  })
  .describe('Parameters for retrieving a protein structure.');

const OutputSchema = z
  .object({
    pdbId: z.string().describe('4-character PDB identifier.'),
    title: z.string().describe('Structure title/description.'),
    structure: z
      .object({
        format: z.nativeEnum(StructureFormat).describe('Data format.'),
        data: z
          .union([z.string(), z.record(z.unknown()), z.instanceof(ArrayBuffer)])
          .describe(
            'Structure data (raw file, parsed JSON, or binary ArrayBuffer for BCIF).',
          ),
        chains: z
          .array(
            z.object({
              id: z.string().describe('Chain identifier.'),
              type: z
                .string()
                .describe('Chain type (protein, dna, rna, ligand).'),
              sequence: z.string().optional().describe('Amino acid sequence.'),
              length: z.number().describe('Chain length.'),
            }),
          )
          .describe('Molecular chains in the structure.'),
      })
      .describe('Structure coordinate and topology data.'),
    experimental: z
      .object({
        method: z.string().describe('Experimental method.'),
        resolution: z.number().optional().describe('Resolution in Angstroms.'),
        rFactor: z.number().optional().describe('R-factor.'),
        rFree: z.number().optional().describe('R-free.'),
        spaceGroup: z.string().optional().describe('Space group.'),
        unitCell: z
          .object({
            a: z.number(),
            b: z.number(),
            c: z.number(),
            alpha: z.number(),
            beta: z.number(),
            gamma: z.number(),
          })
          .optional()
          .describe('Unit cell parameters.'),
      })
      .describe('Experimental metadata.'),
    annotations: z
      .object({
        function: z.string().optional().describe('Functional description.'),
        keywords: z.array(z.string()).describe('Classification keywords.'),
        citations: z
          .array(
            z.object({
              title: z.string(),
              authors: z.array(z.string()),
              journal: z.string().optional(),
              doi: z.string().optional(),
              pubmedId: z.string().optional(),
              year: z.number().optional(),
            }),
          )
          .describe('Primary citations.'),
      })
      .describe('Functional annotations and literature references.'),
  })
  .describe('Complete protein structure data.');

type GetStructureInput = z.infer<typeof InputSchema>;
type GetStructureOutput = z.infer<typeof OutputSchema>;

async function proteinGetStructureLogic(
  input: GetStructureInput,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<GetStructureOutput> {
  logger.debug('Fetching protein structure', {
    ...appContext,
    toolInput: input,
  });

  const options: GetStructureOptions = {
    format: input.format,
    includeCoordinates: input.includeCoordinates,
    includeExperimentalData: input.includeExperimentalData,
    includeAnnotations: input.includeAnnotations,
  };

  const proteinService = container.resolve<ProteinServiceClass>(ProteinService);
  const result: ProteinStructure = await proteinService.getStructure(
    input.pdbId.toUpperCase(),
    options,
    appContext,
  );

  logger.info('Protein structure retrieved', {
    ...appContext,
    pdbId: result.pdbId,
    format: result.structure.format,
    chainCount: result.structure.chains.length,
  });

  return result;
}

function responseFormatter(result: GetStructureOutput): ContentBlock[] {
  const structureSize =
    typeof result.structure.data === 'string'
      ? result.structure.data.length
      : JSON.stringify(result.structure.data).length;

  const summary = [
    `${result.pdbId}: ${result.title}`,
    `Method: ${result.experimental.method}`,
    result.experimental.resolution
      ? `Resolution: ${result.experimental.resolution.toFixed(2)}Å`
      : '',
    `Chains: ${result.structure.chains.length}`,
    `Format: ${result.structure.format.toUpperCase()}`,
    `Size: ${(structureSize / 1024).toFixed(1)} KB`,
  ]
    .filter(Boolean)
    .join('\n');

  const chains = result.structure.chains
    .slice(0, 5)
    .map(
      (c) =>
        `• Chain ${c.id}: ${c.type}${c.length ? ` (${c.length} residues)` : ''}`,
    )
    .join('\n');

  return [
    {
      type: 'text',
      text: `${summary}\n\nChains:\n${chains}${result.structure.chains.length > 5 ? '\n... and more' : ''}`,
    },
  ];
}

export const proteinGetStructureTool: ToolDefinition<
  typeof InputSchema,
  typeof OutputSchema
> = {
  name: TOOL_NAME,
  title: TOOL_TITLE,
  description: TOOL_DESCRIPTION,
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  annotations: TOOL_ANNOTATIONS,
  logic: withToolAuth(['tool:protein:read'], proteinGetStructureLogic),
  responseFormatter,
};
