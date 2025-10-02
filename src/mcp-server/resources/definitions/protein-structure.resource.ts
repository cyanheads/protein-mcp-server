/**
 * @fileoverview Resource definition for accessing protein structures via URI.
 * @module src/mcp-server/resources/definitions/protein-structure.resource
 */
import { container } from 'tsyringe';
import { z } from 'zod';

import { ProteinService } from '@/container/tokens.js';
import type { ResourceDefinition } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { withResourceAuth } from '@/mcp-server/transports/auth/lib/withAuth.js';
import type { ProteinService as ProteinServiceClass } from '@/services/protein/core/ProteinService.js';
import { StructureFormat } from '@/services/protein/types.js';
import { type RequestContext, logger } from '@/utils/index.js';

const ParamsSchema = z
  .object({
    pdbId: z
      .string()
      .length(4)
      .regex(/^[0-9A-Z]{4}$/i)
      .describe('4-character PDB identifier from URI path.'),
    format: z
      .nativeEnum(StructureFormat)
      .optional()
      .describe('Optional structure format (default: mmcif).'),
  })
  .describe('Protein structure resource parameters.');

const OutputSchema = z
  .object({
    pdbId: z.string(),
    title: z.string(),
    experimentalMethod: z.string(),
    resolution: z.number().optional(),
    chains: z.array(
      z.object({
        id: z.string(),
        type: z.string(),
        length: z.number(),
      }),
    ),
    structureData: z.union([
      z.string(),
      z.record(z.unknown()),
      z.instanceof(ArrayBuffer),
    ]),
    requestUri: z.string().url(),
  })
  .describe('Protein structure resource response.');

type StructureParams = z.infer<typeof ParamsSchema>;
type StructureOutput = z.infer<typeof OutputSchema>;

class ProteinStructureResourceLogic {
  constructor(private proteinService: ProteinServiceClass) {}

  async execute(
    uri: URL,
    params: StructureParams,
    context: RequestContext,
  ): Promise<StructureOutput> {
    logger.debug('Processing protein structure resource', {
      ...context,
      resourceUri: uri.href,
      pdbId: params.pdbId,
    });

    const structure = await this.proteinService.getStructure(
      params.pdbId.toUpperCase(),
      {
        format: params.format ?? StructureFormat.MMCIF,
        includeCoordinates: true,
        includeExperimentalData: true,
        includeAnnotations: false, // Keep resource lightweight
      },
      context,
    );

    const output: StructureOutput = {
      pdbId: structure.pdbId,
      title: structure.title,
      experimentalMethod: structure.experimental.method,
      resolution: structure.experimental.resolution,
      chains: structure.structure.chains.map((c) => ({
        id: c.id,
        type: c.type,
        length: c.length,
      })),
      structureData: structure.structure.data,
      requestUri: uri.href,
    };

    logger.debug('Protein structure resource processed successfully', {
      ...context,
      pdbId: output.pdbId,
      chainCount: output.chains.length,
    });

    return output;
  }
}

export const proteinStructureResource: ResourceDefinition<
  typeof ParamsSchema,
  typeof OutputSchema
> = {
  name: 'protein-structure',
  title: 'Protein Structure Resource',
  description:
    'Access protein 3D structure data by PDB ID via protein://structure/{pdbId} URI.',
  uriTemplate: 'protein://structure/{pdbId}',
  paramsSchema: ParamsSchema,
  outputSchema: OutputSchema,
  mimeType: 'application/json',
  examples: [
    {
      name: 'Fetch structure 1ABC in default mmCIF format',
      uri: 'protein://structure/1ABC',
    },
    {
      name: 'Fetch structure 2GBP in legacy PDB format',
      uri: 'protein://structure/2GBP?format=pdb',
    },
  ],
  annotations: {
    readOnlyHint: true,
  },
  list: () => ({
    resources: [
      {
        uri: 'protein://structure/1ABC',
        name: 'Example: Crystal structure 1ABC',
        description: 'Sample protein structure resource',
        mimeType: 'application/json',
      },
    ],
  }),
  logic: withResourceAuth(
    ['resource:protein:read'],
    async (uri, params, context) => {
      const proteinService =
        container.resolve<ProteinServiceClass>(ProteinService);
      const logic = new ProteinStructureResourceLogic(proteinService);
      return logic.execute(uri, params, context);
    },
  ),
};
