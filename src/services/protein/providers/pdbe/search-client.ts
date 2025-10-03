/**
 * @fileoverview Search client for PDBe API operations.
 * @module src/services/protein/providers/pdbe/search-client
 */

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import {
  fetchWithTimeout,
  logger,
  type RequestContext,
} from '@/utils/index.js';
import type {
  SearchStructuresParams,
  SearchStructuresResult,
  TrackLigandsParams,
  TrackLigandsResult,
} from '../../types.js';
import { PDBE_API_URL, REQUEST_TIMEOUT } from './config.js';
import type { PdbeEntrySummary } from './types.js';

/**
 * Search protein structures using PDBe API
 */
export async function searchStructures(
  params: SearchStructuresParams,
  context: RequestContext,
): Promise<SearchStructuresResult> {
  logger.debug('Searching protein structures via PDBe', {
    ...context,
    params,
  });

  // PDBe search API is more limited - use simple text search
  try {
    const searchUrl = `${PDBE_API_URL}/pdb/entry/summary/${params.query.toLowerCase()}`;

    logger.debug('Fetching from PDBe search API', {
      ...context,
      query: params.query,
      url: searchUrl,
    });

    const response = await fetchWithTimeout(searchUrl, {
      method: 'GET',
      timeout: REQUEST_TIMEOUT,
    });

    if (!response.ok) {
      // Return empty results for 404
      if (response.status === 404) {
        logger.debug('PDBe search returned 404, no results', {
          ...context,
          query: params.query,
        });
        return {
          results: [],
          totalCount: 0,
          hasMore: false,
          limit: params.limit ?? 25,
          offset: params.offset ?? 0,
        };
      }

      const errorBody = await response.text();
      logger.error('PDBe search API error', {
        ...context,
        status: response.status,
        url: searchUrl,
        responseBody: errorBody,
      });

      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `PDBe search failed: ${response.status}`,
        { requestId: context.requestId },
      );
    }

    const data = (await response.json()) as Record<string, PdbeEntrySummary>;

    logger.debug('PDBe search response received', {
      ...context,
      entryCount: Object.keys(data).length,
      rawResponse: JSON.stringify(data, null, 2),
    });
    const entries = Object.entries(data);

    const results = entries
      .slice(params.offset ?? 0, (params.offset ?? 0) + (params.limit ?? 25))
      .map(([pdbId, entry]) => ({
        pdbId: pdbId.toUpperCase(),
        title: entry.title ?? 'Unknown',
        organism:
          entry.source
            ?.map((s) => s.organism_scientific_name)
            .filter((name): name is string => Boolean(name)) ?? [],
        experimentalMethod: entry.experimental_method?.[0] ?? 'Unknown',
        resolution: entry.resolution,
        releaseDate: entry.release_date ?? '',
        molecularWeight: entry.molecular_weight,
      }));

    return {
      results,
      totalCount: entries.length,
      hasMore: entries.length > (params.offset ?? 0) + results.length,
      limit: params.limit ?? 25,
      offset: params.offset ?? 0,
    };
  } catch (error) {
    if (error instanceof McpError) throw error;

    throw new McpError(
      JsonRpcErrorCode.ServiceUnavailable,
      `PDBe search failed: ${error instanceof Error ? error.message : String(error)}`,
      { requestId: context.requestId },
    );
  }
}

/**
 * Track ligands in protein structures using PDBe API
 */
export async function trackLigands(
  params: TrackLigandsParams,
  context: RequestContext,
): Promise<TrackLigandsResult> {
  logger.debug('Tracking ligands via PDBe', {
    ...context,
    params,
  });

  try {
    // Use PDBe compound API
    const compoundId = params.ligandQuery.value.toUpperCase();
    const url = `${PDBE_API_URL}/pdb/compound/in_pdb/${compoundId}`;

    logger.debug('Fetching ligands from PDBe compound API', {
      ...context,
      compoundId,
      url,
    });

    const response = await fetchWithTimeout(url, {
      method: 'GET',
      timeout: REQUEST_TIMEOUT,
    });

    if (!response.ok) {
      if (response.status === 404) {
        logger.debug('PDBe ligand search returned 404, no structures found', {
          ...context,
          compoundId,
        });
        return {
          ligand: {
            name: params.ligandQuery.value,
            chemicalId: compoundId,
          },
          structures: [],
          totalCount: 0,
        };
      }

      const errorBody = await response.text();
      logger.error('PDBe ligand search API error', {
        ...context,
        status: response.status,
        url,
        responseBody: errorBody,
      });

      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `PDBe ligand search failed: ${response.status}`,
        { requestId: context.requestId },
      );
    }

    const data = (await response.json()) as Record<string, string[]>;

    logger.debug('PDBe ligand search response received', {
      ...context,
      compoundId,
      pdbIdCount: data[compoundId]?.length ?? 0,
      rawResponse: JSON.stringify(data, null, 2),
    });
    const pdbIds = data[compoundId] ?? [];

    // Fetch details for each structure (limited by params.limit)
    const limitedIds = pdbIds.slice(0, params.limit ?? 25);
    const structures = await Promise.all(
      limitedIds.map(async (id) => {
        try {
          const summaryUrl = `${PDBE_API_URL}/pdb/entry/summary/${id.toLowerCase()}`;
          const summaryResponse = await fetchWithTimeout(summaryUrl, {
            method: 'GET',
            timeout: 10000,
          });

          if (!summaryResponse.ok) {
            return null;
          }

          const summaryData = (await summaryResponse.json()) as Record<
            string,
            PdbeEntrySummary
          >;
          const entry = summaryData[id.toLowerCase()];

          return {
            pdbId: id.toUpperCase(),
            title: entry?.title ?? 'Unknown',
            organism:
              entry?.source
                ?.map((s) => s.organism_scientific_name)
                .filter((name): name is string => Boolean(name)) ?? [],
            resolution: entry?.resolution,
            ligandCount: 1,
            bindingSites: params.includeBindingSite ? [] : undefined,
          };
        } catch {
          return null;
        }
      }),
    );

    return {
      ligand: {
        name: params.ligandQuery.value,
        chemicalId: compoundId,
      },
      structures: structures.filter((s) => s !== null),
      totalCount: pdbIds.length,
    };
  } catch (error) {
    if (error instanceof McpError) throw error;

    throw new McpError(
      JsonRpcErrorCode.ServiceUnavailable,
      `PDBe ligand tracking failed: ${error instanceof Error ? error.message : String(error)}`,
      { requestId: context.requestId },
    );
  }
}
