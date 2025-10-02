/**
 * @fileoverview PDBe (European Bioinformatics Institute) provider implementation.
 * Serves as fallback provider for RCSB PDB with European mirror access.
 * @module src/services/protein/providers/pdbe.provider
 */

import { injectable } from 'tsyringe';

import type { IProteinProvider } from '../core/IProteinProvider.js';
import type {
  AnalyzeCollectionParams,
  AnalyzeCollectionResult,
  CompareStructuresParams,
  CompareStructuresResult,
  FindSimilarParams,
  FindSimilarResult,
  GetStructureOptions,
  ProteinStructure,
  SearchStructuresParams,
  SearchStructuresResult,
  TrackLigandsParams,
  TrackLigandsResult,
} from '../types.js';
import { StructureFormat } from '../types.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import {
  fetchWithTimeout,
  logger,
  type RequestContext,
} from '@/utils/index.js';

/**
 * PDBe API configuration
 */
const PDBE_BASE_URL = 'https://www.ebi.ac.uk/pdbe';
const PDBE_API_URL = 'https://www.ebi.ac.uk/pdbe/api';
const PDBE_FILES_URL = 'https://www.ebi.ac.uk/pdbe/entry-files/download';
const REQUEST_TIMEOUT = 30000;

/**
 * PDBe provider implementation.
 * Provides European mirror access with REST API.
 */
@injectable()
export class PdbeProteinProvider implements IProteinProvider {
  public readonly name = 'PDBe (EBI)';

  async searchStructures(
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

  async getStructure(
    pdbId: string,
    options: GetStructureOptions,
    context: RequestContext,
  ): Promise<ProteinStructure> {
    logger.debug('Fetching protein structure from PDBe', {
      ...context,
      pdbId,
      options,
    });

    const normalizedId = pdbId.toLowerCase();

    try {
      // Fetch summary data
      const summaryUrl = `${PDBE_API_URL}/pdb/entry/summary/${normalizedId}`;
      const summaryResponse = await fetchWithTimeout(summaryUrl, {
        method: 'GET',
        timeout: REQUEST_TIMEOUT,
      });

      if (!summaryResponse.ok) {
        throw new McpError(
          JsonRpcErrorCode.NotFound,
          `Structure ${pdbId} not found in PDBe`,
          { requestId: context.requestId, pdbId },
        );
      }

      const summaryData = (await summaryResponse.json()) as Record<
        string,
        PdbeEntrySummary
      >;
      const entry = summaryData[normalizedId];

      if (!entry) {
        throw new McpError(
          JsonRpcErrorCode.NotFound,
          `Structure ${pdbId} not found in PDBe`,
          { requestId: context.requestId, pdbId },
        );
      }

      // Fetch structure file if coordinates requested
      let structureData: ProteinStructure['structure'] | undefined;
      if (options.includeCoordinates !== false) {
        structureData = await this.fetchStructureFile(
          normalizedId,
          options.format ?? StructureFormat.MMCIF,
          context,
        );
      }

      return {
        pdbId: pdbId.toUpperCase(),
        title: entry.title ?? 'Unknown',
        structure: structureData ?? {
          format: StructureFormat.JSON,
          data: {},
          chains: [],
        },
        experimental: {
          method: entry.experimental_method?.[0] ?? 'Unknown',
          resolution: entry.resolution,
        },
        annotations: {
          keywords: [],
          citations: [],
        },
      };
    } catch (error) {
      if (error instanceof McpError) throw error;

      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `Failed to fetch structure from PDBe: ${error instanceof Error ? error.message : String(error)}`,
        { requestId: context.requestId, pdbId },
      );
    }
  }

  async compareStructures(
    _params: CompareStructuresParams,
    context: RequestContext,
  ): Promise<CompareStructuresResult> {
    // PDBe doesn't provide comparison API - delegate to RCSB or return error
    return Promise.reject(
      new McpError(
        JsonRpcErrorCode.MethodNotFound,
        'Structure comparison not available via PDBe provider',
        { requestId: context.requestId },
      ),
    );
  }

  async findSimilar(
    _params: FindSimilarParams,
    context: RequestContext,
  ): Promise<FindSimilarResult> {
    // PDBe doesn't provide similarity search - delegate to RCSB
    return Promise.reject(
      new McpError(
        JsonRpcErrorCode.MethodNotFound,
        'Similarity search not available via PDBe provider',
        { requestId: context.requestId },
      ),
    );
  }

  async trackLigands(
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

  async analyzeCollection(
    _params: AnalyzeCollectionParams,
    context: RequestContext,
  ): Promise<AnalyzeCollectionResult> {
    // PDBe doesn't provide aggregation API - delegate to RCSB
    return Promise.reject(
      new McpError(
        JsonRpcErrorCode.MethodNotFound,
        'Collection analysis not available via PDBe provider',
        { requestId: context.requestId },
      ),
    );
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetchWithTimeout(
        `${PDBE_BASE_URL}/api/pdb/entry/status`,
        {
          method: 'GET',
          timeout: 5000,
        },
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  // Private helper methods

  private async fetchStructureFile(
    pdbId: string,
    format: StructureFormat,
    context: RequestContext,
  ): Promise<ProteinStructure['structure']> {
    const extension = format === StructureFormat.MMCIF ? 'cif' : format;
    const url = `${PDBE_FILES_URL}/${pdbId}.${extension}`;

    const response = await fetchWithTimeout(url, {
      method: 'GET',
      timeout: REQUEST_TIMEOUT,
    });

    if (!response.ok) {
      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `Failed to download structure file from PDBe: ${response.status}`,
        { requestId: context.requestId, pdbId, format },
      );
    }

    const data = await response.text();

    return {
      format,
      data,
      chains: [],
    };
  }
}

// TypeScript interfaces for PDBe API responses

interface PdbeEntrySummary {
  title?: string;
  experimental_method?: string[];
  resolution?: number;
  release_date?: string;
  molecular_weight?: number;
  source?: Array<{
    organism_scientific_name?: string;
  }>;
}
