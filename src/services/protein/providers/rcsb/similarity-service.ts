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
import type { FindSimilarParams, FindSimilarResult } from '../../types.js';
import { SimilarityType } from '../../types.js';
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
  const query = {
    type: 'terminal',
    service: 'sequence',
    parameters: {
      evalue_cutoff: params.threshold?.eValue ?? 0.001,
      identity_cutoff: (params.threshold?.sequenceIdentity ?? 30) / 100,
      target: 'pdb_protein_sequence',
      value:
        params.query.type === 'sequence'
          ? params.query.value
          : await getSequenceForPdbId(params.query.value, context),
    },
  };

  try {
    const response = await fetchWithTimeout(RCSB_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
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
      }),
      timeout: REQUEST_TIMEOUT,
    });

    if (!response.ok) {
      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `Sequence search failed: ${response.status}`,
        { requestId: context.requestId },
      );
    }

    const data = (await response.json()) as RcsbSearchResponse;

    // Create a map of PDB ID to score for quick lookup
    const scoreMap = new Map(
      data.result_set?.map((r) => [r.identifier, r.score]) ?? [],
    );

    const enriched = await enrichSearchResults(
      data.result_set?.map((r) => r.identifier) ?? [],
      context,
    );

    return {
      query: {
        type: params.query.type,
        identifier: params.query.value,
      },
      similarityType: 'sequence',
      results: enriched.map((e) => {
        const score = scoreMap.get(e.pdbId) ?? 0;
        // RCSB returns sequence identity as score (0-100)
        // E-value would require detailed alignment data not available in search results
        return {
          pdbId: e.pdbId,
          title: e.title,
          organism: e.organism,
          similarity: {
            sequenceIdentity: score,
            // eValue, alignmentLength, coverage not available from search API
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
 * Find structure-similar structures using RCSB structure motif search
 */
export async function findStructureSimilar(
  params: FindSimilarParams,
  context: RequestContext,
): Promise<FindSimilarResult> {
  // Structural similarity search using RCSB structure motif
  const query = {
    type: 'terminal',
    service: 'structure',
    parameters: {
      value: {
        entry_id: params.query.value,
        asym_id: params.chainId || 'A', // Allow chain selection, default to 'A'
      },
      operator: 'strict_shape_match',
    },
  };

  try {
    const response = await fetchWithTimeout(RCSB_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        return_type: 'entry',
        request_options: {
          paginate: {
            start: 0,
            rows: params.limit ?? 25,
          },
        },
      }),
      timeout: REQUEST_TIMEOUT,
    });

    if (!response.ok) {
      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `Structure search failed: ${response.status}`,
        { requestId: context.requestId },
      );
    }

    const data = (await response.json()) as RcsbSearchResponse;

    // Create a map of PDB ID to score for quick lookup
    const scoreMap = new Map(
      data.result_set?.map((r) => [r.identifier, r.score]) ?? [],
    );

    const enriched = await enrichSearchResults(
      data.result_set?.map((r) => r.identifier) ?? [],
      context,
    );

    return {
      query: {
        type: params.query.type,
        identifier: params.query.value,
      },
      similarityType: 'structure',
      results: enriched.map((e) => {
        const score = scoreMap.get(e.pdbId);
        // RCSB structure search uses BioZernike 3D shape descriptors
        // The score is a relevance/similarity score, NOT a TM-score from alignment
        // TM-scores require explicit structural alignment (e.g., via RCSB Alignment API)
        const result: {
          pdbId: string;
          title: string;
          organism: string[];
          similarity: { shapeSimilarity?: number };
        } = {
          pdbId: e.pdbId,
          title: e.title,
          organism: e.organism,
          similarity: {},
        };
        if (score !== undefined) {
          // Store raw BioZernike shape similarity score (no normalization)
          result.similarity.shapeSimilarity = score;
        }
        return result;
      }),
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
