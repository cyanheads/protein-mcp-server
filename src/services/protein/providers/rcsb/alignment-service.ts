/**
 * @fileoverview RCSB Structural Alignment API integration for structure comparison.
 * @module src/services/protein/providers/rcsb/alignment-service
 */

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import {
  fetchWithTimeout,
  logger,
  type RequestContext,
} from '@/utils/index.js';
import {
  AlignmentMethod,
  type CompareStructuresParams,
  type CompareStructuresResult,
} from '../../types.js';
import { REQUEST_TIMEOUT } from './config.js';

const RCSB_ALIGNMENT_API_URL = 'https://alignment.rcsb.org/api/v1/structures';

interface AlignmentTicket {
  query_id: string;
}

interface RcsbScore {
  type: string;
  value: number;
}

interface RcsbAlignmentSummary {
  scores: RcsbScore[];
  n_aln_residue_pairs: number;
  query_len: number;
}

interface RcsbAlignmentResultData {
  summary: RcsbAlignmentSummary;
}

interface AlignmentStatus {
  info: {
    uuid: string;
    status: 'RUNNING' | 'COMPLETE' | 'ERROR';
    message?: string;
  };
  results?: RcsbAlignmentResultData[];
}

interface RcsbAlignmentResponse {
  sequence_identity: number;
  rmsd: number;
  tm_score: number;
  'aligned-residues': number;
  query_length: number;
}

function mapAlignmentMethod(method: AlignmentMethod): string {
  const mapping: Record<AlignmentMethod, string> = {
    [AlignmentMethod.CEALIGN]: 'jce',
    [AlignmentMethod.TMALIGN]: 'tm-align',
    [AlignmentMethod.FATCAT]: 'jfatcat-rigid',
  };
  return mapping[method] ?? 'jce';
}

async function submitAlignmentJob(
  pdbId1: string,
  pdbId2: string,
  chainId1: string | undefined,
  chainId2: string | undefined,
  algorithm: string,
  context: RequestContext,
): Promise<string> {
  const structure1: { entry_id: string; selection?: { asym_id: string } } = {
    entry_id: pdbId1,
  };
  if (chainId1) {
    structure1.selection = { asym_id: chainId1 };
  }

  const structure2: { entry_id: string; selection?: { asym_id: string } } = {
    entry_id: pdbId2,
  };
  if (chainId2) {
    structure2.selection = { asym_id: chainId2 };
  }

  const query = {
    context: {
      mode: 'pairwise' as const,
      method: { name: algorithm },
      structures: [structure1, structure2],
    },
  };

  const formData = new URLSearchParams();
  const queryString = JSON.stringify(query);
  formData.append('query', queryString);

  logger.debug('Submitting alignment job as x-www-form-urlencoded', {
    ...context,
    pdbId1,
    pdbId2,
    algorithm,
    query: queryString,
    url: `${RCSB_ALIGNMENT_API_URL}/submit`,
  });

  try {
    const response = await fetchWithTimeout(
      `${RCSB_ALIGNMENT_API_URL}/submit`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString(),
        timeout: REQUEST_TIMEOUT,
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error('RCSB Alignment job submission failed', {
        ...context,
        pdbId1,
        pdbId2,
        algorithm,
        status: response.status,
        statusText: response.statusText,
        requestBody: queryString,
        responseBody: errorBody,
      });
      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `RCSB Alignment job submission failed: ${response.status} ${response.statusText}`,
        { responseBody: errorBody },
      );
    }
    const ticket = (await response.json()) as AlignmentTicket;

    logger.debug('Alignment job submitted successfully', {
      ...context,
      pdbId1,
      pdbId2,
      ticketId: ticket.query_id,
    });

    return ticket.query_id;
  } catch (error) {
    logger.error('Error during alignment job submission', {
      ...context,
      error,
    });
    if (error instanceof McpError) {
      throw error;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new McpError(
      JsonRpcErrorCode.ServiceUnavailable,
      `Alignment job submission network error: ${errorMessage}`,
      { originalError: error },
    );
  }
}

async function getAlignmentResults(
  ticket: string,
  context: RequestContext,
): Promise<RcsbAlignmentResponse> {
  const pollInterval = 2000; // 2 seconds
  const maxAttempts = 15; // 30 seconds total

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    const response = await fetchWithTimeout(
      `${RCSB_ALIGNMENT_API_URL}/results/${ticket}`,
      {
        method: 'GET',
        timeout: REQUEST_TIMEOUT,
      },
    );

    if (!response.ok) continue;

    const status = (await response.json()) as AlignmentStatus;
    logger.debug('Polling alignment status', {
      ...context,
      ticket,
      attempt: i + 1,
      status: status.info,
    });

    if (
      status.info.status === 'COMPLETE' &&
      status.results &&
      status.results.length > 0
    ) {
      const alignmentData = status.results[0];
      if (!alignmentData)
        throw new McpError(
          JsonRpcErrorCode.InternalError,
          'Invalid alignment data',
          { requestId: context.requestId },
        );

      const scores = alignmentData.summary.scores.reduce(
        (acc: Record<string, number>, score: RcsbScore) => {
          acc[score.type.replace(/-/g, '_')] = score.value;
          return acc;
        },
        {},
      );

      const alignmentResponse = {
        ...scores,
        'aligned-residues': alignmentData.summary.n_aln_residue_pairs,
        query_length: alignmentData.summary.query_len,
      } as RcsbAlignmentResponse;

      logger.debug('Alignment results retrieved', {
        ...context,
        ticket,
        alignmentResponse: JSON.stringify(alignmentResponse, null, 2),
        rawStatus: JSON.stringify(status, null, 2),
      });

      return alignmentResponse;
    } else if (status.info.status === 'ERROR') {
      logger.error('Alignment job failed on RCSB side', {
        ...context,
        ticket,
        statusInfo: status.info,
      });
      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `Alignment failed: ${status.info.message}`,
      );
    }
  }

  logger.error('Alignment job timed out after all attempts', {
    ...context,
    ticket,
    maxAttempts,
  });
  throw new McpError(
    JsonRpcErrorCode.ServiceUnavailable,
    'Alignment job timed out.',
  );
}

export async function alignPairwise(
  pdbId1: string,
  pdbId2: string,
  chainId1: string | undefined,
  chainId2: string | undefined,
  algorithm: string,
  context: RequestContext,
): Promise<RcsbAlignmentResponse> {
  const ticket = await submitAlignmentJob(
    pdbId1,
    pdbId2,
    chainId1,
    chainId2,
    algorithm,
    context,
  );
  return getAlignmentResults(ticket, context);
}

export async function compareStructures(
  params: CompareStructuresParams,
  context: RequestContext,
): Promise<CompareStructuresResult> {
  logger.debug('Comparing protein structures via RCSB Alignment API', {
    ...context,
    params,
  });

  if (params.pdbIds.length < 2) {
    throw new McpError(
      JsonRpcErrorCode.ValidationError,
      'At least 2 structures required for comparison',
      { requestId: context.requestId },
    );
  }

  const algorithm = mapAlignmentMethod(
    params.alignmentMethod || AlignmentMethod.CEALIGN,
  );
  const getChainForIndex = (index: number): string | undefined =>
    params.chainSelections?.[index]?.chain;

  const pairwiseComparisons: CompareStructuresResult['pairwiseComparisons'] =
    [];
  const alignmentResults: RcsbAlignmentResponse[] = [];

  for (let i = 0; i < params.pdbIds.length - 1; i++) {
    for (let j = i + 1; j < params.pdbIds.length; j++) {
      const id1 = params.pdbIds[i];
      const id2 = params.pdbIds[j];
      if (!id1 || !id2) continue;

      try {
        const alignment = await alignPairwise(
          id1,
          id2,
          getChainForIndex(i),
          getChainForIndex(j),
          algorithm,
          context,
        );
        alignmentResults.push(alignment);
        pairwiseComparisons.push({
          pdbId1: id1,
          pdbId2: id2,
          rmsd: alignment.rmsd,
          alignedLength: alignment['aligned-residues'],
        });
      } catch (error) {
        logger.warning('Pairwise alignment failed, skipping', {
          ...context,
          id1,
          id2,
          error,
        });
      }
    }
  }

  if (alignmentResults.length === 0) {
    throw new McpError(
      JsonRpcErrorCode.ServiceUnavailable,
      'All pairwise alignments failed',
      { requestId: context.requestId },
    );
  }

  const firstAlignment = alignmentResults[0];
  if (!firstAlignment) {
    throw new McpError(
      JsonRpcErrorCode.InternalError,
      'No alignment results available',
      { requestId: context.requestId },
    );
  }

  const avgRmsd =
    pairwiseComparisons.reduce((sum, p) => sum + p.rmsd, 0) /
    pairwiseComparisons.length;
  const avgAlignedResidues =
    pairwiseComparisons.reduce((sum, p) => sum + p.alignedLength, 0) /
    pairwiseComparisons.length;

  let visualization: string | undefined;
  if (params.includeVisualization) {
    visualization = generateVisualizationScript(params.pdbIds);
  }

  logger.info('Structure comparison completed', {
    ...context,
    structureCount: params.pdbIds.length,
    avgRmsd,
    pairwiseCount: pairwiseComparisons.length,
  });

  return {
    alignment: {
      method: algorithm,
      rmsd: avgRmsd,
      alignedResidues: Math.round(avgAlignedResidues),
      sequenceIdentity: firstAlignment.sequence_identity,
      tmscore: firstAlignment['tm_score'],
      queryLength: firstAlignment.query_length,
    },
    pairwiseComparisons,
    conformationalAnalysis: undefined,
    visualization,
  };
}

function generateVisualizationScript(pdbIds: string[]): string {
  const scripts: string[] = [
    '# PyMOL Structural Alignment Visualization Script',
    '# Generated by protein-mcp-server',
    '',
    '# Load structures',
  ];

  pdbIds.forEach((id) => {
    scripts.push(`fetch ${id}, async=0`);
  });

  scripts.push('');
  scripts.push('# Align structures');

  if (pdbIds.length >= 2) {
    const first = pdbIds[0];
    for (let i = 1; i < pdbIds.length; i++) {
      const second = pdbIds[i];
      if (first && second) scripts.push(`align ${second}, ${first}`);
    }
  }

  scripts.push('');
  scripts.push('# Color structures');
  const colors = ['cyan', 'magenta', 'yellow', 'orange', 'green', 'blue'];
  pdbIds.forEach((id, index) => {
    const color = colors[index % colors.length];
    if (color && id) scripts.push(`color ${color}, ${id}`);
  });

  scripts.push('');
  scripts.push('# Representation');
  scripts.push('hide everything');
  scripts.push('show cartoon');
  scripts.push('');
  scripts.push('# Center and zoom');
  scripts.push('zoom');
  scripts.push('center');
  scripts.push('');
  scripts.push('# Run this script in PyMOL: File > Run Script...');

  return scripts.join('\n');
}
