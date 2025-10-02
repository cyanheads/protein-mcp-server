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
  idempotentHint: true,
  openWorldHint: false,
};

const InputSchema = z
  .object({
    query: z
      .object({
        type: z
          .enum(['pdbId', 'sequence', 'structure'])
          .describe(
            'Query type: pdbId (4-char PDB code), sequence (FASTA), or structure (PDB/mmCIF data).',
          ),
        value: z
          .string()
          .min(1)
          .describe('Query value corresponding to the specified type.'),
      })
      .describe('Query: PDB ID, FASTA sequence, or structure data.'),
    similarityType: z
      .nativeEnum(SimilarityType)
      .describe('Type of similarity search: sequence or structure.'),
    threshold: z
      .object({
        sequenceIdentity: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe('Minimum sequence identity percentage (0-100).'),
        eValue: z
          .number()
          .positive()
          .optional()
          .describe('Maximum E-value for sequence similarity.'),
        tmscore: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('Minimum TM-score for structural similarity (0-1).'),
        rmsd: z
          .number()
          .positive()
          .optional()
          .describe('Maximum RMSD for structural similarity in Angstroms.'),
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
    chainId: z
      .string()
      .optional()
      .describe(
        'Specific chain ID for structural similarity (default: auto-select first chain "A").',
      ),
  })
  .describe('Parameters for similarity search.');

const OutputSchema = z
  .object({
    query: z
      .object({
        type: z.string().describe('Query type that was used.'),
        identifier: z.string().describe('Query identifier or value used.'),
      })
      .describe('Information about the search query.'),
    similarityType: z.string().describe('Type of similarity search performed.'),
    results: z
      .array(
        z.object({
          pdbId: z.string().describe('4-character PDB identifier.'),
          title: z.string().describe('Structure title/description.'),
          organism: z
            .array(z.string())
            .describe('Source organism(s) scientific names.'),
          similarity: z
            .object({
              sequenceIdentity: z
                .number()
                .optional()
                .describe('Sequence identity percentage.'),
              eValue: z.number().optional().describe('E-value for the match.'),
              tmscore: z
                .number()
                .optional()
                .describe('TM-score (0-1) for structural similarity.'),
              rmsd: z
                .number()
                .optional()
                .describe('RMSD in Angstroms for structural alignment.'),
              shapeSimilarity: z
                .number()
                .optional()
                .describe(
                  'BioZernike 3D shape similarity score for structural search.',
                ),
            })
            .describe('Similarity metrics for this match.'),
          alignmentLength: z
            .number()
            .optional()
            .describe('Length of the alignment in residues.'),
          coverage: z
            .number()
            .optional()
            .describe('Percentage of query covered by alignment (0-100).'),
        }),
      )
      .describe('Array of similar structures found.'),
    totalCount: z.number().describe('Total number of results found.'),
  })
  .describe('Similarity search results.');

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
    chainId: input.chainId,
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
  const summary = `Found ${result.totalCount} similar structure(s) using ${result.similarityType} search\nQuery: ${result.query.type} = ${result.query.identifier.substring(0, 50)}`;

  const preview =
    result.results.length > 0
      ? result.results
          .slice(0, 5)
          .map((r) => {
            const metrics = [];
            if (r.similarity.sequenceIdentity !== undefined)
              metrics.push(`${r.similarity.sequenceIdentity.toFixed(1)}% ID`);
            if (r.similarity.tmscore !== undefined)
              metrics.push(`TM=${r.similarity.tmscore.toFixed(2)}`);
            if (r.similarity.rmsd !== undefined)
              metrics.push(`RMSD=${r.similarity.rmsd.toFixed(2)}Å`);
            if (r.similarity.shapeSimilarity !== undefined)
              metrics.push(`Shape=${r.similarity.shapeSimilarity.toFixed(2)}`);
            if (r.similarity.eValue !== undefined)
              metrics.push(`E=${r.similarity.eValue.toExponential(1)}`);
            return `• ${r.pdbId}: ${r.title.slice(0, 50)} ${metrics.length > 0 ? `(${metrics.join(', ')})` : ''}`;
          })
          .join('\n')
      : 'No similar structures found.';

  return [
    {
      type: 'text',
      text: `${summary}\n\n${preview}${result.results.length > 5 ? `\n... and ${result.totalCount - 5} more` : ''}`,
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
