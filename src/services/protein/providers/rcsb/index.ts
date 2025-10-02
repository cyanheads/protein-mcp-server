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
} from '../../types.js';
import { StructureFormat } from '../../types.js';
import { RCSB_BASE_URL } from './config.js';
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
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        `Invalid PDB ID format: ${pdbId}. Must be 4 alphanumeric characters.`,
        { requestId: context.requestId, pdbId },
      );
    }

    try {
      // Fetch metadata via GraphQL
      const metadata = await fetchStructureMetadata(normalizedId, context);

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
        pdbId: normalizedId,
        title: metadata.title,
        structure: structureData ?? {
          format: StructureFormat.JSON,
          data: {},
          chains: [],
        },
        experimental: metadata.experimental,
        annotations: metadata.annotations,
      };
    } catch (error) {
      if (error instanceof McpError) throw error;

      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `Failed to fetch structure ${pdbId}: ${error instanceof Error ? error.message : String(error)}`,
        { requestId: context.requestId, pdbId },
      );
    }
  }

  /**
   * Compare multiple structures
   * Note: RCSB doesn't provide direct comparison API, so this is a simplified implementation
   */
  async compareStructures(
    params: CompareStructuresParams,
    context: RequestContext,
  ): Promise<CompareStructuresResult> {
    logger.debug('Comparing protein structures', {
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

    // For MVP, return mock comparison data
    // In production, this would call external alignment services or implement algorithms
    logger.notice(
      'Structure comparison returning mock data (MVP implementation)',
      {
        ...context,
      },
    );

    // Simulate async operation
    await new Promise((resolve) => setTimeout(resolve, 100));

    const pairwise: CompareStructuresResult['pairwiseComparisons'] = [];
    for (let i = 0; i < params.pdbIds.length - 1; i++) {
      for (let j = i + 1; j < params.pdbIds.length; j++) {
        const id1 = params.pdbIds[i];
        const id2 = params.pdbIds[j];
        if (!id1 || !id2) continue;
        pairwise.push({
          pdbId1: id1,
          pdbId2: id2,
          rmsd: Math.random() * 3, // Mock RMSD
          alignedLength: Math.floor(Math.random() * 200) + 100,
        });
      }
    }

    return {
      alignment: {
        method: params.alignmentMethod ?? 'cealign',
        rmsd: pairwise[0]?.rmsd ?? 0,
        alignedResidues: pairwise[0]?.alignedLength ?? 0,
        sequenceIdentity: Math.random() * 100,
        tmscore: Math.random() * 0.5 + 0.5,
      },
      pairwiseComparisons: pairwise,
      conformationalAnalysis: params.includeVisualization
        ? {
            flexibleRegions: [
              {
                residueRange: [10, 25],
                rmsd: 2.5,
              },
            ],
            rigidCore: {
              residueCount: 150,
              rmsd: 0.8,
            },
          }
        : undefined,
      visualization: params.includeVisualization
        ? '# PyMOL alignment script\nload structure1.pdb\nload structure2.pdb\nalign structure1, structure2'
        : undefined,
    };
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
