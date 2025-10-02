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
import { enrichSearchResults, getBindingSiteInfo } from './graphql-client.js';
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
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('RCSB search request failed', {
      ...context,
      error: errorMessage,
    });
    if (error instanceof McpError) throw error;

    throw new McpError(
      JsonRpcErrorCode.ServiceUnavailable,
      `RCSB search request failed: ${errorMessage}`,
      { requestId: context.requestId, originalError: errorMessage },
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

  // Build ligand search query based on type
  let query;

  if (
    params.ligandQuery.type === 'smiles' ||
    params.ligandQuery.type === 'inchi'
  ) {
    // Chemical similarity search using SMILES or InChI
    const descriptorType =
      params.ligandQuery.type === 'smiles' ? 'SMILES' : 'InChI';
    const matchType =
      params.ligandQuery.matchType === 'strict'
        ? 'graph-strict'
        : params.ligandQuery.matchType === 'relaxed-stereo'
          ? 'graph-relaxed-stereo'
          : params.ligandQuery.matchType === 'fingerprint'
            ? 'fingerprint-similarity'
            : 'graph-relaxed'; // default

    query = {
      type: 'terminal',
      service: 'chemical',
      parameters: {
        descriptor: params.ligandQuery.value,
        descriptor_type: descriptorType,
        match_type: matchType,
      },
    };
  } else if (params.ligandQuery.type === 'name') {
    // Name-based search using text search
    query = {
      type: 'terminal',
      service: 'text',
      parameters: {
        attribute: 'rcsb_chem_comp_descriptor.comp_id',
        operator: 'contains_words',
        value: params.ligandQuery.value,
      },
    };
  } else {
    // Chemical ID exact match (default)
    query = {
      type: 'terminal',
      service: 'text',
      parameters: {
        attribute: 'rcsb_chem_comp_container_identifiers.comp_id',
        operator: 'exact_match',
        value: params.ligandQuery.value.toUpperCase(),
      },
    };
  }

  // For chemical searches, we need to return structures that contain the ligand
  // Chemical service returns non_polymer_entity, which we then map to entry
  const returnType =
    params.ligandQuery.type === 'smiles' || params.ligandQuery.type === 'inchi'
      ? 'entry'
      : 'entry';

  try {
    const response = await fetchWithTimeout(RCSB_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        return_type: returnType,
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

    // Fetch binding site info if requested
    const ligandIdForBinding =
      params.ligandQuery.type === 'chemicalId'
        ? params.ligandQuery.value.toUpperCase()
        : '';

    const structuresWithBindingSites: TrackLigandsResult['structures'] =
      await Promise.all(
        structures.map(async (s) => {
          let bindingSites:
            | Array<{
                chain: string;
                residues: Array<{
                  name: string;
                  number: number;
                  interactions: string[];
                }>;
              }>
            | undefined;
          if (params.includeBindingSite && ligandIdForBinding) {
            try {
              bindingSites = await getBindingSiteInfo(
                s.pdbId,
                ligandIdForBinding,
                context,
              );
            } catch (error) {
              logger.warning('Failed to get binding site info', {
                ...context,
                pdbId: s.pdbId,
                error,
              });
              bindingSites = [];
            }
          }

          return {
            pdbId: s.pdbId,
            title: s.title,
            organism: s.organism,
            resolution: s.resolution,
            ligandCount: 1, // Simplified
            bindingSites: params.includeBindingSite ? bindingSites : undefined,
          };
        }),
      );

    return {
      ligand: {
        name: params.ligandQuery.value,
        chemicalId:
          params.ligandQuery.type === 'chemicalId'
            ? params.ligandQuery.value.toUpperCase()
            : '',
      },
      structures: structuresWithBindingSites,
      totalCount: data.total_count ?? 0,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Ligand tracking failed', { ...context, error: errorMessage });
    if (error instanceof McpError) throw error;

    throw new McpError(
      JsonRpcErrorCode.ServiceUnavailable,
      `Ligand tracking failed: ${errorMessage}`,
      { requestId: context.requestId, originalError: errorMessage },
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

  const facet = getAnalysisFacet(params.analysisType);
  const requestBody = {
    query: {
      type: 'group',
      logical_operator: 'and',
      nodes: [
        {
          type: 'terminal',
          service: 'text',
          parameters: {
            attribute: 'rcsb_entry_info.polymer_entity_count_protein',
            operator: 'greater',
            value: 0,
          },
        },
      ],
    },
    return_type: 'entry',
    request_options: {
      paginate: {
        start: 0,
        rows: 0,
      },
      facets: [
        {
          name: 'analysis_facet',
          attribute: facet,
          min_count: 1,
          max_count: params.limit ?? 20,
        },
      ],
    },
  };

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
      logger.error('Collection analysis failed', {
        ...context,
        status: response.status,
        requestBody: JSON.stringify(requestBody, null, 2),
        responseBody: errorBody,
      });
      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `Collection analysis failed: ${response.status}`,
        { requestId: context.requestId },
      );
    }

    const data = (await response.json()) as RcsbSearchResponse;
    const facetData = data.facets?.find((f) => f.name === 'analysis_facet');

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
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Collection analysis failed', {
      ...context,
      error: errorMessage,
    });
    if (error instanceof McpError) throw error;

    throw new McpError(
      JsonRpcErrorCode.ServiceUnavailable,
      `Collection analysis failed: ${errorMessage}`,
      { requestId: context.requestId, originalError: errorMessage },
    );
  }
}
