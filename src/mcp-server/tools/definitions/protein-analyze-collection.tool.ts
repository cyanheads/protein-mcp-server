/**
 * @fileoverview Tool definition for analyzing protein structure collections.
 * @module src/mcp-server/tools/definitions/protein-analyze-collection.tool
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
  AnalysisType,
  type AnalyzeCollectionParams,
  type AnalyzeCollectionResult,
} from '@/services/protein/types.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { type RequestContext, logger } from '@/utils/index.js';
import { type DependencyContainer } from 'tsyringe';

const TOOL_NAME = 'protein_analyze_collection';
const TOOL_TITLE = 'Analyze Protein Collection';
const TOOL_DESCRIPTION =
  'Perform statistical analysis of protein structure database by fold classification, function, organism, or experimental method. Useful for understanding structural biology trends and dataset composition.';

const TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

const InputSchema = z
  .object({
    analysisType: z
      .nativeEnum(AnalysisType)
      .describe(
        'Type of analysis: fold (structural classification), function, organism, or method.',
      ),
    filters: z
      .object({
        organism: z
          .string()
          .optional()
          .describe(
            'Filter by source organism scientific name (e.g., "Homo sapiens").',
          ),
        experimentalMethod: z
          .string()
          .optional()
          .describe(
            'Filter by experimental method (e.g., "X-RAY DIFFRACTION").',
          ),
        resolutionRange: z
          .object({
            min: z
              .number()
              .optional()
              .describe('Minimum resolution in Angstroms.'),
            max: z
              .number()
              .optional()
              .describe('Maximum resolution in Angstroms.'),
          })
          .optional()
          .describe('Filter by a range of resolution values in Angstroms.'),
        releaseYearRange: z
          .tuple([z.number(), z.number()])
          .optional()
          .describe('Filter by a range of release years (e.g., [2020, 2023]).'),
      })
      .optional()
      .describe('Filters to narrow analysis scope.'),
    groupBy: z
      .string()
      .optional()
      .describe('Secondary grouping dimension (e.g., year for trends).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe('Number of top categories to return.'),
  })
  .describe(
    'Parameters for performing statistical analysis on protein collections.',
  );

const OutputSchema = z.object({
  analysisType: z.string().describe('The type of analysis that was performed.'),
  totalStructures: z
    .number()
    .describe('Total number of structures matching the query.'),
  statistics: z
    .array(
      z.object({
        category: z
          .string()
          .describe('The category name (e.g., a specific organism or fold).'),
        count: z
          .number()
          .describe('The number of structures in this category.'),
        percentage: z
          .number()
          .describe(
            'The percentage of total structures this category represents.',
          ),
        examples: z
          .array(
            z.object({
              pdbId: z.string().describe('PDB ID of the example structure.'),
              title: z.string().describe('Title of the example structure.'),
            }),
          )
          .describe('A few example structures from this category.'),
      }),
    )
    .describe('An array of statistical results for the top categories.'),
  trends: z
    .array(
      z.object({
        year: z.number().describe('The year for the data point.'),
        count: z.number().describe('The number of structures for that year.'),
      }),
    )
    .optional()
    .describe('Optional array of trend data, present if `groupBy` was used.'),
});

type AnalysisInput = z.infer<typeof InputSchema>;
type AnalysisOutput = z.infer<typeof OutputSchema>;

@injectable()
class ProteinAnalyzeCollectionLogic {
  constructor(
    @inject(ProteinService) private proteinService: ProteinServiceClass,
  ) {}

  async execute(
    input: AnalysisInput,
    appContext: RequestContext,
    _sdkContext: SdkContext,
  ): Promise<AnalysisOutput> {
    logger.debug('Analyzing protein collection', {
      ...appContext,
      toolInput: input,
    });

    const params: AnalyzeCollectionParams = {
      analysisType: input.analysisType,
      filters: input.filters,
      groupBy: input.groupBy,
      limit: input.limit,
    };

    const result: AnalyzeCollectionResult =
      await this.proteinService.analyzeCollection(params, appContext);

    logger.info('Collection analysis completed', {
      ...appContext,
      totalStructures: result.totalStructures,
      categoryCount: result.statistics.length,
    });

    return result;
  }
}

function responseFormatter(result: AnalysisOutput): ContentBlock[] {
  const summary = `Analysis: ${result.analysisType}\nTotal structures: ${result.totalStructures.toLocaleString()}`;

  const topCategories = result.statistics
    .slice(0, 10)
    .map(
      (s) =>
        `• ${s.category}: ${s.count.toLocaleString()} (${s.percentage.toFixed(1)}%)`,
    )
    .join('\n');

  const trends = result.trends
    ? `\n\nTrends:\n${result.trends
        .slice(0, 5)
        .map((t) => `${t.year}: ${t.count.toLocaleString()}`)
        .join('\n')}`
    : '';

  return [
    {
      type: 'text',
      text: `${summary}\n\nTop Categories:\n${topCategories}${trends}`,
    },
  ];
}

export const proteinAnalyzeCollectionTool: ToolDefinition<
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
      const { container } = globalThis as {
        container?: DependencyContainer;
      };
      if (!container) {
        throw new McpError(
          JsonRpcErrorCode.InternalError,
          'DI container not available',
        );
      }
      const logic = container.resolve(ProteinAnalyzeCollectionLogic);
      return logic.execute(input, appContext, sdkContext);
    },
  ),
  responseFormatter,
};
