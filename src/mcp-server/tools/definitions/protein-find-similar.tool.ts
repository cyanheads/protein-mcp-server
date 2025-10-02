/**
 * @fileoverview Tool definition for finding similar protein structures.
 * @module src/mcp-server/tools/definitions/protein-find-similar.tool
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
  SimilarityType,
  type FindSimilarParams,
  type FindSimilarResult,
} from '@/services/protein/types.js';
import { type RequestContext, logger } from '@/utils/index.js';

const TOOL_NAME = 'protein_find_similar';
const TOOL_TITLE = 'Find Similar Proteins';
const TOOL_DESCRIPTION =
  'Find proteins similar to a query by sequence (BLAST) or structure (DALI, FATCAT). Use for homology searches, fold recognition, and evolutionary analysis.';

const TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

const InputSchema = z
  .object({
    query: z
      .object({
        type: z.enum(['pdbId', 'sequence', 'structure']),
        value: z.string().min(1),
      })
      .describe('Query: PDB ID, FASTA sequence, or structure data.'),
    similarityType: z
      .nativeEnum(SimilarityType)
      .describe('Type of similarity search: sequence or structure.'),
    threshold: z
      .object({
        sequenceIdentity: z.number().min(0).max(100).optional(),
        eValue: z.number().positive().optional(),
        tmscore: z.number().min(0).max(1).optional(),
        rmsd: z.number().positive().optional(),
      })
      .optional()
      .describe('Similarity thresholds for filtering results.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe('Maximum number of results.'),
  })
  .describe('Parameters for similarity search.');

const OutputSchema = z.object({
  query: z.object({
    type: z.string(),
    identifier: z.string(),
  }),
  similarityType: z.string(),
  results: z.array(
    z.object({
      pdbId: z.string(),
      title: z.string(),
      organism: z.array(z.string()),
      similarity: z.object({
        sequenceIdentity: z.number().optional(),
        eValue: z.number().optional(),
        tmscore: z.number().optional(),
        rmsd: z.number().optional(),
      }),
      alignmentLength: z.number().optional(),
      coverage: z.number().optional(),
    }),
  ),
  totalCount: z.number(),
});

type SimilarInput = z.infer<typeof InputSchema>;
type SimilarOutput = z.infer<typeof OutputSchema>;

async function proteinFindSimilarLogic(
  input: SimilarInput,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<SimilarOutput> {
  logger.debug('Finding similar proteins', {
    ...appContext,
    toolInput: input,
  });

  const params: FindSimilarParams = {
    query: input.query,
    similarityType: input.similarityType,
    threshold: input.threshold,
    limit: input.limit,
  };

  const proteinService = container.resolve<ProteinServiceClass>(ProteinService);
  const result: FindSimilarResult = await proteinService.findSimilar(
    params,
    appContext,
  );

  logger.info('Similarity search completed', {
    ...appContext,
    resultCount: result.results.length,
  });

  return result;
}

function responseFormatter(result: SimilarOutput): ContentBlock[] {
  const summary = `Found ${result.totalCount} similar structure(s) using ${result.similarityType} search`;

  const preview =
    result.results.length > 0
      ? result.results
          .slice(0, 5)
          .map((r) => {
            const metrics = [];
            if (r.similarity.sequenceIdentity)
              metrics.push(`${r.similarity.sequenceIdentity.toFixed(1)}% ID`);
            if (r.similarity.tmscore)
              metrics.push(`TM=${r.similarity.tmscore.toFixed(2)}`);
            if (r.similarity.rmsd)
              metrics.push(`RMSD=${r.similarity.rmsd.toFixed(2)}Å`);
            return `• ${r.pdbId}: ${r.title.slice(0, 60)} (${metrics.join(', ')})`;
          })
          .join('\n')
      : 'No similar structures found.';

  return [
    {
      type: 'text',
      text: `${summary}\n\n${preview}`,
    },
  ];
}

export const proteinFindSimilarTool: ToolDefinition<
  typeof InputSchema,
  typeof OutputSchema
> = {
  name: TOOL_NAME,
  title: TOOL_TITLE,
  description: TOOL_DESCRIPTION,
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  annotations: TOOL_ANNOTATIONS,
  logic: withToolAuth(['tool:protein:search'], proteinFindSimilarLogic),
  responseFormatter,
};
