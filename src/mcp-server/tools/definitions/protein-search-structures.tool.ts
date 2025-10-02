/**
 * @fileoverview Tool definition for searching protein structures.
 * @module src/mcp-server/tools/definitions/protein-search-structures.tool
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
  ExperimentalMethod,
  type SearchStructuresParams,
  type SearchStructuresResult,
} from '@/services/protein/types.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { type RequestContext, logger } from '@/utils/index.js';

const TOOL_NAME = 'protein_search_structures';
const TOOL_TITLE = 'Search Protein Structures';
const TOOL_DESCRIPTION =
  'Search protein structures from the Protein Data Bank by name, organism, experimental method, or resolution. Returns a paginated list of matching structures with metadata. Use this to discover proteins of interest before fetching detailed structure data.';

const TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

const InputSchema = z
  .object({
    query: z
      .string()
      .min(1, 'Query cannot be empty.')
      .max(500, 'Query cannot exceed 500 characters.')
      .describe(
        'Search query for protein name, PDB ID, keyword, or description (e.g., "kinase", "hemoglobin", "1ABC").',
      ),
    organism: z
      .string()
      .optional()
      .describe(
        'Filter by source organism scientific name (e.g., "Homo sapiens", "Escherichia coli").',
      ),
    experimentalMethod: z
      .nativeEnum(ExperimentalMethod)
      .optional()
      .describe(
        'Filter by experimental method used to determine the structure.',
      ),
    maxResolution: z
      .number()
      .positive()
      .optional()
      .describe(
        'Maximum resolution in Angstroms (e.g., 2.0 for high-resolution structures).',
      ),
    minResolution: z
      .number()
      .positive()
      .optional()
      .describe('Minimum resolution in Angstroms.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe('Maximum number of results to return (1-100, default 25).'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Offset for pagination (default 0).'),
  })
  .describe('Search parameters for protein structures.');

const OutputSchema = z
  .object({
    results: z
      .array(
        z.object({
          pdbId: z.string().describe('4-character PDB identifier.'),
          title: z.string().describe('Structure title/description.'),
          organism: z
            .array(z.string())
            .describe('Source organism(s) scientific names.'),
          experimentalMethod: z
            .string()
            .describe('Method used to determine structure.'),
          resolution: z
            .number()
            .optional()
            .describe('Resolution in Angstroms (if applicable).'),
          releaseDate: z
            .string()
            .describe('Structure release date (ISO 8601).'),
          molecularWeight: z
            .number()
            .optional()
            .describe('Molecular weight in Daltons.'),
        }),
      )
      .describe('Array of matching protein structures.'),
    totalCount: z
      .number()
      .int()
      .describe('Total number of matching structures.'),
    hasMore: z
      .boolean()
      .describe('Whether more results are available for pagination.'),
  })
  .describe('Protein structure search results.');

type SearchInput = z.infer<typeof InputSchema>;
type SearchOutput = z.infer<typeof OutputSchema>;

@injectable()
class ProteinSearchLogic {
  constructor(
    @inject(ProteinService) private proteinService: ProteinServiceClass,
  ) {}

  async execute(
    input: SearchInput,
    appContext: RequestContext,
    _sdkContext: SdkContext,
  ): Promise<SearchOutput> {
    logger.debug('Searching protein structures', {
      ...appContext,
      toolInput: input,
    });

    // Validate resolution range if both provided
    if (
      input.minResolution !== undefined &&
      input.maxResolution !== undefined &&
      input.minResolution > input.maxResolution
    ) {
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        'minResolution cannot be greater than maxResolution',
        { requestId: appContext.requestId },
      );
    }

    const params: SearchStructuresParams = {
      query: input.query,
      organism: input.organism,
      experimentalMethod: input.experimentalMethod,
      maxResolution: input.maxResolution,
      minResolution: input.minResolution,
      limit: input.limit,
      offset: input.offset,
    };

    const result: SearchStructuresResult =
      await this.proteinService.searchStructures(params, appContext);

    logger.info('Protein search completed', {
      ...appContext,
      resultCount: result.results.length,
      totalCount: result.totalCount,
    });

    return result;
  }
}

function responseFormatter(result: SearchOutput): ContentBlock[] {
  const summary = [
    `Found ${result.totalCount} matching structure(s)`,
    `Showing ${result.results.length} result(s)`,
    result.hasMore ? '(more available)' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const preview =
    result.results.length > 0
      ? result.results
          .slice(0, 5)
          .map(
            (r) =>
              `• ${r.pdbId}: ${r.title}${r.resolution ? ` (${r.resolution.toFixed(2)}Å)` : ''}`,
          )
          .join('\n')
      : 'No results found.';

  return [
    {
      type: 'text',
      text: `${summary}\n\n${preview}${result.results.length > 5 ? '\n... and more' : ''}`,
    },
  ];
}

export const proteinSearchStructuresTool: ToolDefinition<
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
      const logic = new ProteinSearchLogic(
        (
          globalThis as { container?: { resolve: (token: symbol) => unknown } }
        ).container?.resolve(ProteinService) as ProteinServiceClass,
      );
      return logic.execute(input, appContext, sdkContext);
    },
  ),
  responseFormatter,
};
