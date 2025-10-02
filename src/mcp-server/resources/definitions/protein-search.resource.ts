/**
 * @fileoverview Resource definition for accessing protein search results via URI.
 * @module src/mcp-server/resources/definitions/protein-search.resource
 */
import { inject, injectable } from 'tsyringe';
import { z } from 'zod';

import { ProteinService } from '@/container/tokens.js';
import type { ResourceDefinition } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { withResourceAuth } from '@/mcp-server/transports/auth/lib/withAuth.js';
import type { ProteinService as ProteinServiceClass } from '@/services/protein/core/ProteinService.js';
import { type RequestContext, logger } from '@/utils/index.js';

const ParamsSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .describe('Search query from URI path (protein name, keyword, etc).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Optional limit for number of results.'),
  })
  .describe('Protein search resource parameters.');

const OutputSchema = z
  .object({
    query: z.string(),
    results: z.array(
      z.object({
        pdbId: z.string(),
        title: z.string(),
        organism: z.array(z.string()),
        experimentalMethod: z.string(),
        resolution: z.number().optional(),
      }),
    ),
    totalCount: z.number(),
    requestUri: z.string().url(),
  })
  .describe('Protein search resource response.');

type SearchParams = z.infer<typeof ParamsSchema>;
type SearchOutput = z.infer<typeof OutputSchema>;

@injectable()
class ProteinSearchResourceLogic {
  constructor(
    @inject(ProteinService) private proteinService: ProteinServiceClass,
  ) {}

  async execute(
    uri: URL,
    params: SearchParams,
    context: RequestContext,
  ): Promise<SearchOutput> {
    logger.debug('Processing protein search resource', {
      ...context,
      resourceUri: uri.href,
      query: params.query,
    });

    const searchResults = await this.proteinService.searchStructures(
      {
        query: params.query,
        limit: params.limit ?? 25,
        offset: 0,
      },
      context,
    );

    const output: SearchOutput = {
      query: params.query,
      results: searchResults.results.map((r) => ({
        pdbId: r.pdbId,
        title: r.title,
        organism: r.organism,
        experimentalMethod: r.experimentalMethod,
        resolution: r.resolution,
      })),
      totalCount: searchResults.totalCount,
      requestUri: uri.href,
    };

    logger.debug('Protein search resource processed successfully', {
      ...context,
      query: params.query,
      resultCount: output.results.length,
    });

    return output;
  }
}

export const proteinSearchResource: ResourceDefinition<
  typeof ParamsSchema,
  typeof OutputSchema
> = {
  name: 'protein-search',
  title: 'Protein Search Resource',
  description:
    'Search protein structures via protein://search/{query} URI and get results as a resource.',
  uriTemplate: 'protein://search/{query}',
  paramsSchema: ParamsSchema,
  outputSchema: OutputSchema,
  mimeType: 'application/json',
  examples: [
    {
      name: 'Search for kinase structures',
      uri: 'protein://search/kinase',
    },
    {
      name: 'Search for hemoglobin with result limit',
      uri: 'protein://search/hemoglobin?limit=10',
    },
  ],
  annotations: {
    readOnlyHint: true,
  },
  list: () => ({
    resources: [
      {
        uri: 'protein://search/kinase',
        name: 'Example: Search for kinases',
        description: 'Sample protein search resource',
        mimeType: 'application/json',
      },
    ],
  }),
  logic: withResourceAuth(
    ['resource:protein:read'],
    async (uri, params, context) => {
      const logic = new ProteinSearchResourceLogic(
        (
          globalThis as { container?: { resolve: (token: symbol) => unknown } }
        ).container?.resolve(ProteinService) as ProteinServiceClass,
      );
      return logic.execute(uri, params, context);
    },
  ),
};
