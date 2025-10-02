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
    const response = await fetchWithTimeout(searchUrl, {
      method: 'GET',
      timeout: REQUEST_TIMEOUT,
    });

    if (!response.ok) {
      // Return empty results for 404
      if (response.status === 404) {
        return {
          results: [],
          totalCount: 0,
          hasMore: false,
        };
      }

      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `PDBe search failed: ${response.status}`,
        { requestId: context.requestId },
      );
    }

    const data = (await response.json()) as Record<string, PdbeEntrySummary>;
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

    const response = await fetchWithTimeout(url, {
      method: 'GET',
      timeout: REQUEST_TIMEOUT,
    });

    if (!response.ok) {
      if (response.status === 404) {
        return {
          ligand: {
            name: params.ligandQuery.value,
            chemicalId: compoundId,
          },
          structures: [],
          totalCount: 0,
        };
      }

      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `PDBe ligand search failed: ${response.status}`,
        { requestId: context.requestId },
      );
    }

    const data = (await response.json()) as Record<string, string[]>;
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
