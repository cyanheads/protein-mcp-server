/**
 * @fileoverview PDBe (European Bioinformatics Institute) provider implementation.
 * Serves as fallback provider for RCSB PDB with European mirror access.
 * @module src/services/protein/providers/pdbe
 */

import { injectable } from 'tsyringe';

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import {
  fetchWithTimeout,
  logger,
  type RequestContext,
} from '@/utils/index.js';
import type { IProteinProvider } from '../../core/IProteinProvider.js';
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
} from '../../types.js';
import { StructureFormat } from '../../types.js';
import { PDBE_API_URL, PDBE_BASE_URL, REQUEST_TIMEOUT } from './config.js';
import { fetchStructureFile } from './enrichment-service.js';
import * as searchClient from './search-client.js';
import type { PdbeEntrySummary } from './types.js';

/**
 * PDBe provider implementation.
 * Provides European mirror access with REST API.
 */
@injectable()
export class PdbeProteinProvider implements IProteinProvider {
  public readonly name = 'PDBe (EBI)';

  /**
   * Search structures using PDBe API
   */
  async searchStructures(
    params: SearchStructuresParams,
    context: RequestContext,
  ): Promise<SearchStructuresResult> {
    return searchClient.searchStructures(params, context);
  }

  /**
   * Get complete structure data
   */
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
        structureData = await fetchStructureFile(
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

  /**
   * Compare structures (not supported by PDBe)
   */
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

  /**
   * Find similar structures (not supported by PDBe)
   */
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

  /**
   * Track ligands in structures
   */
  async trackLigands(
    params: TrackLigandsParams,
    context: RequestContext,
  ): Promise<TrackLigandsResult> {
    return searchClient.trackLigands(params, context);
  }

  /**
   * Analyze collection (not supported by PDBe)
   */
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

  /**
   * Health check
   */
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
}
