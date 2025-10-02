/**
 * @fileoverview Search client for RCSB Search API operations.
 * @module src/services/protein/providers/rcsb/search-client
 */

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import {
  fetchWithTimeout,
  logger,
  type RequestContext,
} from '@/utils/index.js';
import type {
  AnalyzeCollectionParams,
  AnalyzeCollectionResult,
  SearchStructuresParams,
  SearchStructuresResult,
  TrackLigandsParams,
  TrackLigandsResult,
} from '../../types.js';
import { RCSB_SEARCH_URL, REQUEST_TIMEOUT } from './config.js';
import { enrichSearchResults } from './graphql-client.js';
import { buildSearchQuery, getAnalysisFacet } from './query-builder.js';
import type { RcsbSearchResponse } from './types.js';

/**
 * Search protein structures using RCSB Search API
 */
export async function searchStructures(
  params: SearchStructuresParams,
  context: RequestContext,
): Promise<SearchStructuresResult> {
  logger.debug('Searching protein structures via RCSB', {
    ...context,
    params,
  });

  // Build search query
  const query = buildSearchQuery(params);
  const requestOptions = {
    query,
    request_options: {
      paginate: {
        start: params.offset ?? 0,
        rows: params.limit ?? 25,
      },
      scoring_strategy: 'combined',
      sort: [
        {
          sort_by: 'score',
          direction: 'desc',
        },
      ],
    },
    return_type: 'entry',
  };

  try {
    const response = await fetchWithTimeout(RCSB_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestOptions),
      timeout: REQUEST_TIMEOUT,
    });

    if (!response.ok) {
      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `RCSB search failed: ${response.status} ${response.statusText}`,
        { requestId: context.requestId },
      );
    }

    const data = (await response.json()) as RcsbSearchResponse;

    // Fetch details for each result
    const results = await enrichSearchResults(
      data.result_set?.map((r) => r.identifier) ?? [],
      context,
    );

    return {
      results,
      totalCount: data.total_count ?? 0,
      hasMore: (data.total_count ?? 0) > (params.offset ?? 0) + results.length,
    };
  } catch (error) {
    if (error instanceof McpError) throw error;

    throw new McpError(
      JsonRpcErrorCode.ServiceUnavailable,
      `RCSB search request failed: ${error instanceof Error ? error.message : String(error)}`,
      { requestId: context.requestId },
    );
  }
}

/**
 * Track ligands in protein structures
 */
export async function trackLigands(
  params: TrackLigandsParams,
  context: RequestContext,
): Promise<TrackLigandsResult> {
  logger.debug('Tracking ligands in structures', {
    ...context,
    params,
  });

  // Build ligand search query
  const query = {
    type: 'terminal',
    service: 'text_chem',
    parameters: {
      attribute: 'rcsb_chem_comp_container_identifiers.comp_id',
      operator: 'exact_match',
      value: params.ligandQuery.value.toUpperCase(),
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
        `Ligand search failed: ${response.status}`,
        { requestId: context.requestId },
      );
    }

    const data = (await response.json()) as RcsbSearchResponse;
    const pdbIds = data.result_set?.map((r) => r.identifier) ?? [];

    // Enrich with structure details
    const structures = await enrichSearchResults(pdbIds, context);

    return {
      ligand: {
        name: params.ligandQuery.value,
        chemicalId: params.ligandQuery.value.toUpperCase(),
      },
      structures: structures.map((s) => ({
        pdbId: s.pdbId,
        title: s.title,
        organism: s.organism,
        resolution: s.resolution,
        ligandCount: 1, // Simplified
        bindingSites: params.includeBindingSite ? [] : undefined,
      })),
      totalCount: data.total_count ?? 0,
    };
  } catch (error) {
    if (error instanceof McpError) throw error;

    throw new McpError(
      JsonRpcErrorCode.ServiceUnavailable,
      `Ligand tracking failed: ${error instanceof Error ? error.message : String(error)}`,
      { requestId: context.requestId },
    );
  }
}

/**
 * Analyze structure collection with aggregation
 */
export async function analyzeCollection(
  params: AnalyzeCollectionParams,
  context: RequestContext,
): Promise<AnalyzeCollectionResult> {
  logger.debug('Analyzing structure collection', {
    ...context,
    params,
  });

  // Build aggregation query based on analysis type
  const facet = getAnalysisFacet(params.analysisType);

  try {
    const response = await fetchWithTimeout(RCSB_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: {
          type: 'terminal',
          service: 'text',
          parameters: {
            attribute: 'rcsb_entry_info.polymer_entity_count_protein',
            operator: 'greater',
            value: 0,
          },
        },
        return_type: 'entry',
        request_options: {
          return_facets: true,
          facets: [facet],
        },
      }),
      timeout: REQUEST_TIMEOUT,
    });

    if (!response.ok) {
      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `Collection analysis failed: ${response.status}`,
        { requestId: context.requestId },
      );
    }

    const data = (await response.json()) as RcsbSearchResponse;
    const facetData = data.facets?.find((f) => f.name === facet);

    const statistics =
      facetData?.terms?.slice(0, params.limit ?? 20).map((term) => ({
        category: term.label,
        count: term.count,
        percentage: (term.count / (data.total_count ?? 1)) * 100,
        examples: [],
      })) ?? [];

    return {
      analysisType: params.analysisType,
      totalStructures: data.total_count ?? 0,
      statistics,
    };
  } catch (error) {
    if (error instanceof McpError) throw error;

    throw new McpError(
      JsonRpcErrorCode.ServiceUnavailable,
      `Collection analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      { requestId: context.requestId },
    );
  }
}
