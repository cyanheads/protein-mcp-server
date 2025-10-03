/**
 * @fileoverview RCSB PDB provider implementation for protein structure data.
 * Primary provider for US-based Protein Data Bank access via GraphQL and REST APIs.
 * @module src/services/protein/providers/rcsb
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
  Chain,
  ChainType,
} from '../../types.js';
import { StructureFormat } from '../../types.js';
import { RCSB_BASE_URL } from './config.js';
import * as alignmentService from './alignment-service.js';
import { fetchStructureFile } from './enrichment-service.js';
import { fetchStructureMetadata } from './graphql-client.js';
import * as searchClient from './search-client.js';
import * as similarityService from './similarity-service.js';

/**
 * RCSB PDB provider implementation.
 * Uses GraphQL for complex queries and REST for file downloads.
 */
@injectable()
export class RcsbProteinProvider implements IProteinProvider {
  public readonly name = 'RCSB PDB';

  /**
   * Search structures using RCSB Search API
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
    logger.debug('Fetching protein structure from RCSB', {
      ...context,
      pdbId,
      options,
    });

    const normalizedId = pdbId.toUpperCase();

    // Validate PDB ID format (4 alphanumeric characters)
    if (!/^[0-9A-Z]{4}$/i.test(normalizedId)) {
      logger.error('Invalid PDB ID format', {
        ...context,
        pdbId,
        normalizedId,
      });
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        `Invalid PDB ID format: ${pdbId}. Must be 4 alphanumeric characters.`,
        { requestId: context.requestId, pdbId },
      );
    }

    try {
      // Fetch metadata via GraphQL
      logger.debug('Fetching metadata for structure', {
        ...context,
        normalizedId,
      });
      const metadata = await fetchStructureMetadata(normalizedId, context);

      // Fetch structure file if coordinates requested
      let fileData: ProteinStructure['structure'] | undefined;
      if (options.includeCoordinates !== false) {
        logger.debug('Fetching coordinate data for structure', {
          ...context,
          normalizedId,
          format: options.format ?? StructureFormat.MMCIF,
        });
        fileData = await fetchStructureFile(
          normalizedId,
          options.format ?? StructureFormat.MMCIF,
          context,
        );
      }

      // Merge metadata chains with file-derived chains
      const mergedChains = new Map<string, Partial<Chain>>();

      // Start with metadata chains (has organism info)
      if (metadata.structure?.chains) {
        for (const chain of metadata.structure.chains) {
          mergedChains.set(chain.id, { ...chain });
        }
      }

      // Merge in file data (has sequence, more accurate length)
      if (fileData?.chains) {
        for (const chain of fileData.chains) {
          const existing = mergedChains.get(chain.id) || {};
          mergedChains.set(chain.id, { ...existing, ...chain });
        }
      }

      const finalChains: Chain[] = Array.from(mergedChains.values()).map(
        (c, index) => {
          const chain: Chain = {
            id: c.id ?? `chain_${index}`,
            type: (c.type ?? 'protein') as ChainType,
            length: c.length ?? 0,
          };
          if (c.sequence) {
            chain.sequence = c.sequence;
          }
          if (c.organism) {
            chain.organism = c.organism;
          }
          return chain;
        },
      );

      const finalStructureData = {
        format: fileData?.format ?? StructureFormat.JSON,
        data: fileData?.data ?? {},
        chains: finalChains,
      };

      logger.info('Successfully retrieved and merged protein structure data', {
        ...context,
        normalizedId,
        hasCoordinates: !!fileData,
        chainCount: finalChains.length,
      });

      return {
        pdbId: normalizedId,
        title: metadata.title,
        structure: finalStructureData,
        experimental: metadata.experimental,
        annotations: metadata.annotations,
      };
    } catch (error) {
      logger.error('Failed to fetch structure', {
        ...context,
        pdbId,
        normalizedId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof McpError) throw error;

      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `Failed to fetch structure ${pdbId}: ${error instanceof Error ? error.message : String(error)}`,
        { requestId: context.requestId, pdbId },
      );
    }
  }

  /**
   * Compare multiple structures using RCSB Alignment API
   */
  async compareStructures(
    params: CompareStructuresParams,
    context: RequestContext,
  ): Promise<CompareStructuresResult> {
    return alignmentService.compareStructures(params, context);
  }

  /**
   * Find similar structures
   */
  async findSimilar(
    params: FindSimilarParams,
    context: RequestContext,
  ): Promise<FindSimilarResult> {
    return similarityService.findSimilar(params, context);
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
   * Analyze structure collection
   */
  async analyzeCollection(
    params: AnalyzeCollectionParams,
    context: RequestContext,
  ): Promise<AnalyzeCollectionResult> {
    return searchClient.analyzeCollection(params, context);
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetchWithTimeout(
        `${RCSB_BASE_URL}/rest/v1/status`,
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
