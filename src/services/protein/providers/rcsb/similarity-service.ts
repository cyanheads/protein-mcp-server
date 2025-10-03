/**
 * @fileoverview Similarity search service for sequence and structural similarity.
 * @module src/services/protein/providers/rcsb/similarity-service
 */

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import {
  fetchWithTimeout,
  logger,
  type RequestContext,
} from '@/utils/index.js';
import type {
  FindSimilarParams,
  FindSimilarResult,
  SimilarityResultEntry,
} from '../../types.js';
import { SimilarityType } from '../../types.js';
import { alignPairwise } from './alignment-service.js';
import { RCSB_SEARCH_URL, REQUEST_TIMEOUT } from './config.js';
import { enrichSearchResults, getSequenceForPdbId } from './graphql-client.js';
import type { RcsbSearchResponse } from './types.js';

/**
 * Find similar structures (dispatcher)
 */
export async function findSimilar(
  params: FindSimilarParams,
  context: RequestContext,
): Promise<FindSimilarResult> {
  logger.debug('Finding similar structures', {
    ...context,
    params,
  });

  if (params.similarityType === SimilarityType.SEQUENCE) {
    return findSequenceSimilar(params, context);
  } else {
    return findStructureSimilar(params, context);
  }
}

/**
 * Find sequence-similar structures using RCSB sequence search
 */
export async function findSequenceSimilar(
  params: FindSimilarParams,
  context: RequestContext,
): Promise<FindSimilarResult> {
  // Sequence similarity search using RCSB sequence search
  const sequenceValue =
    params.query.type === 'sequence'
      ? params.query.value
      : await getSequenceForPdbId(params.query.value, context);

  logger.debug('Resolved sequence for similarity search', {
    ...context,
    queryType: params.query.type,
    sequenceLength: sequenceValue.length,
    sequencePreview: sequenceValue.substring(0, 50),
  });

  const query = {
    type: 'terminal',
    service: 'sequence',
    parameters: {
      evalue_cutoff: params.threshold?.eValue ?? 0.001,
      identity_cutoff: (params.threshold?.sequenceIdentity ?? 30) / 100,
      target: 'pdb_protein_sequence',
      value: sequenceValue,
    },
  };

  const requestBody = {
    query,
    return_type: 'entry',
    request_options: {
      paginate: {
        start: 0,
        rows: params.limit ?? 25,
      },
      scoring_strategy: 'sequence',
      sort: [
        {
          sort_by: 'score',
          direction: 'desc',
        },
      ],
    },
  };

  logger.debug('Built RCSB sequence similarity request', {
    ...context,
    requestBody: JSON.stringify(requestBody, null, 2),
    url: RCSB_SEARCH_URL,
  });

  try {
    const response = await fetchWithTimeout(RCSB_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      timeout: REQUEST_TIMEOUT,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error('RCSB sequence similarity search failed', {
        ...context,
        status: response.status,
        requestBody: JSON.stringify(requestBody, null, 2),
        responseBody: errorBody,
      });
      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `Sequence search failed: ${response.status}`,
        { requestId: context.requestId },
      );
    }

    const data = (await response.json()) as RcsbSearchResponse;

    logger.debug('RCSB sequence similarity response received', {
      ...context,
      totalCount: data.total_count,
      resultCount: data.result_set?.length ?? 0,
      rawResponse: JSON.stringify(data, null, 2),
    });

    // Create a map of PDB ID to score for quick lookup
    const scoreMap = new Map(
      data.result_set?.map((r) => [r.identifier, r.score]) ?? [],
    );

    const enriched = await enrichSearchResults(
      data.result_set?.map((r) => r.identifier) ?? [],
      context,
    );

    logger.info('Sequence similarity search completed', {
      ...context,
      totalCount: data.total_count ?? 0,
      enrichedCount: enriched.length,
    });

    return {
      query: {
        type: params.query.type,
        identifier: params.query.value,
      },
      similarityType: 'sequence',
      results: enriched.map((e) => {
        const score = scoreMap.get(e.pdbId) ?? 0;
        return {
          pdbId: e.pdbId,
          title: e.title,
          organism: e.organism,
          similarity: {
            sequenceIdentity: score,
          },
        };
      }),
      totalCount: data.total_count ?? 0,
    };
  } catch (error) {
    if (error instanceof McpError) throw error;

    throw new McpError(
      JsonRpcErrorCode.ServiceUnavailable,
      `Sequence similarity search failed: ${error instanceof Error ? error.message : String(error)}`,
      { requestId: context.requestId },
    );
  }
}

/**
 * Find structure-similar structures using RCSB structure motif search and pairwise alignment
 */
export async function findStructureSimilar(
  params: FindSimilarParams,
  context: RequestContext,
): Promise<FindSimilarResult> {
  const query = {
    type: 'terminal',
    service: 'structure',
    parameters: {
      value: {
        entry_id: params.query.value,
        asym_id: params.chainId || 'A',
      },
      operator: 'strict_shape_match',
    },
  };

  const requestBody = {
    query,
    return_type: 'entry',
    request_options: {
      paginate: {
        start: 0,
        rows: params.limit ?? 25,
      },
      scoring_strategy: 'structure',
    },
  };

  logger.debug('Built RCSB structural similarity request', {
    ...context,
    pdbId: params.query.value,
    chainId: params.chainId || 'A',
    requestBody: JSON.stringify(requestBody, null, 2),
    url: RCSB_SEARCH_URL,
  });

  try {
    const response = await fetchWithTimeout(RCSB_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      timeout: REQUEST_TIMEOUT,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error('RCSB structural similarity search failed', {
        ...context,
        status: response.status,
        requestBody: JSON.stringify(requestBody, null, 2),
        responseBody: errorBody,
      });
      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `Structure search failed: ${response.status}`,
        { requestId: context.requestId },
      );
    }

    const data = (await response.json()) as RcsbSearchResponse;

    logger.debug('RCSB structural similarity response received', {
      ...context,
      totalCount: data.total_count,
      resultCount: data.result_set?.length ?? 0,
    });

    if (!data.result_set) {
      return {
        query: {
          type: params.query.type,
          identifier: params.query.value,
        },
        similarityType: 'structure',
        results: [],
        totalCount: 0,
      };
    }

    const candidateIds = data.result_set.map((r) => r.identifier);

    // Limit the number of structures to align to avoid timeouts
    const maxAlignments = Math.min(candidateIds.length, params.limit ?? 25, 10);
    const limitedCandidateIds = candidateIds.slice(0, maxAlignments);

    logger.debug('Starting pairwise alignments for structural similarity', {
      ...context,
      totalCandidates: candidateIds.length,
      alignmentLimit: limitedCandidateIds.length,
      queryId: params.query.value,
    });

    // Perform pairwise alignments in parallel, but rate-limited.
    // Use Promise.allSettled to ensure all alignments complete, even if some fail.
    const alignmentPromises = limitedCandidateIds.map((id) => {
      logger.debug(`Queueing alignment of ${params.query.value} with ${id}`, {
        ...context,
      });
      const queryChain = params.chainId || 'A';
      const candidateChain = 'A';
      return alignPairwise(
        params.query.value,
        id,
        queryChain,
        candidateChain,
        'jce', // Default algorithm
        context,
      )
        .then((alignment) => ({
          pdbId: id,
          alignment,
          status: 'fulfilled' as const,
        }))
        .catch((error: unknown) => ({
          pdbId: id,
          error: error instanceof Error ? error : new Error(String(error)),
          status: 'rejected' as const,
        }));
    });

    const alignmentResults = await Promise.allSettled(alignmentPromises);

    const successfulAlignments = alignmentResults
      .filter(
        (result) =>
          result.status === 'fulfilled' && result.value.status === 'fulfilled',
      )
      .map(
        (result) =>
          (
            result as PromiseFulfilledResult<{
              pdbId: string;
              alignment: Awaited<ReturnType<typeof alignPairwise>>;
            }>
          ).value,
      );

    alignmentResults.forEach((result) => {
      if (
        result.status === 'rejected' ||
        (result.status === 'fulfilled' && result.value.status === 'rejected')
      ) {
        const rejectedResult = (
          result.status === 'fulfilled' ? result.value : result
        ) as { pdbId: string; error: Error };
        logger.warning(
          `Failed to align ${params.query.value} with ${rejectedResult.pdbId}`,
          {
            ...context,
            error: rejectedResult.error,
          },
        );
      }
    });

    if (successfulAlignments.length === 0) {
      return {
        query: { type: params.query.type, identifier: params.query.value },
        similarityType: 'structure',
        results: [],
        totalCount: data.total_count ?? 0,
      };
    }

    const enriched = await enrichSearchResults(
      successfulAlignments.map((ar) => ar.pdbId),
      context,
    );
    const enrichedMap = new Map(enriched.map((e) => [e.pdbId, e]));

    const results: SimilarityResultEntry[] = successfulAlignments
      .map((ar) => {
        if (!ar.alignment) return null;

        const enrichedEntry = enrichedMap.get(ar.pdbId);
        if (!enrichedEntry) return null;

        const alignmentLength = ar.alignment['aligned-residues'] ?? 0;
        const queryLength = ar.alignment.query_length ?? 0;

        return {
          pdbId: ar.pdbId,
          title: enrichedEntry.title,
          organism: enrichedEntry.organism,
          similarity: {
            tmscore: ar.alignment.tm_score,
            rmsd: ar.alignment.rmsd,
            sequenceIdentity: ar.alignment.sequence_identity,
          },
          alignmentLength: alignmentLength,
          coverage:
            queryLength > 0 && alignmentLength > 0
              ? (alignmentLength / queryLength) * 100
              : 0,
        } as SimilarityResultEntry;
      })
      .filter((r): r is SimilarityResultEntry => r !== null)
      .sort(
        (a, b) => (b.similarity.tmscore ?? 0) - (a.similarity.tmscore ?? 0),
      );

    logger.info('Structural similarity search completed with alignments', {
      ...context,
      totalCount: data.total_count ?? 0,
      resultCount: results.length,
    });

    return {
      query: {
        type: params.query.type,
        identifier: params.query.value,
      },
      similarityType: 'structure',
      results,
      totalCount: data.total_count ?? 0,
    };
  } catch (error) {
    if (error instanceof McpError) throw error;

    throw new McpError(
      JsonRpcErrorCode.ServiceUnavailable,
      `Structure similarity search failed: ${error instanceof Error ? error.message : String(error)}`,
      { requestId: context.requestId },
    );
  }
}
