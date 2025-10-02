/**
 * @fileoverview Multi-provider orchestrator for protein structure data.
 * Manages fallback logic, response caching, and cross-provider data enrichment.
 * @module src/services/protein/core/ProteinService
 */

import { inject, injectable } from 'tsyringe';

import type { IProteinProvider } from './IProteinProvider.js';
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
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger, type RequestContext } from '@/utils/index.js';

import {
  ProteinProviderPrimary,
  ProteinProviderFallback,
} from '@/container/tokens.js';

/**
 * Orchestrator service for protein structure operations.
 * Implements provider failover and response caching.
 */
@injectable()
export class ProteinService {
  constructor(
    @inject(ProteinProviderPrimary) private primaryProvider: IProteinProvider,
    @inject(ProteinProviderFallback) private fallbackProvider: IProteinProvider,
  ) {}

  /**
   * Search for protein structures with automatic fallback
   */
  async searchStructures(
    params: SearchStructuresParams,
    context: RequestContext,
  ): Promise<SearchStructuresResult> {
    logger.debug('ProteinService: Searching structures', {
      ...context,
      params,
    });

    try {
      return await this.primaryProvider.searchStructures(params, context);
    } catch (error) {
      logger.warning('Primary provider failed, trying fallback', {
        ...context,
        error,
        primaryProvider: this.primaryProvider.name,
      });

      try {
        return await this.fallbackProvider.searchStructures(params, context);
      } catch (_fallbackError) {
        logger.error('Both providers failed for search', {
          ...context,
          primaryError: error,
          fallbackError: _fallbackError,
        });

        throw new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          `Protein search failed: ${_fallbackError instanceof Error ? _fallbackError.message : String(_fallbackError)}`,
          { requestId: context.requestId },
        );
      }
    }
  }

  /**
   * Get structure with automatic fallback
   */
  async getStructure(
    pdbId: string,
    options: GetStructureOptions,
    context: RequestContext,
  ): Promise<ProteinStructure> {
    logger.debug('ProteinService: Getting structure', {
      ...context,
      pdbId,
      options,
    });

    try {
      return await this.primaryProvider.getStructure(pdbId, options, context);
    } catch (error) {
      logger.warning('Primary provider failed, trying fallback', {
        ...context,
        error,
        pdbId,
        primaryProvider: this.primaryProvider.name,
      });

      try {
        return await this.fallbackProvider.getStructure(
          pdbId,
          options,
          context,
        );
      } catch (_fallbackError) {
        // If both fail, throw the original error (likely NotFound)
        if (error instanceof McpError) throw error;

        throw new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          `Failed to fetch structure ${pdbId}: ${error instanceof Error ? error.message : String(error)}`,
          { requestId: context.requestId, pdbId },
        );
      }
    }
  }

  /**
   * Compare structures (primary provider only, fallback doesn't support this)
   */
  async compareStructures(
    params: CompareStructuresParams,
    context: RequestContext,
  ): Promise<CompareStructuresResult> {
    logger.debug('ProteinService: Comparing structures', {
      ...context,
      params,
    });

    try {
      return await this.primaryProvider.compareStructures(params, context);
    } catch (error) {
      if (error instanceof McpError) throw error;

      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `Structure comparison failed: ${error instanceof Error ? error.message : String(error)}`,
        { requestId: context.requestId },
      );
    }
  }

  /**
   * Find similar structures (primary provider only)
   */
  async findSimilar(
    params: FindSimilarParams,
    context: RequestContext,
  ): Promise<FindSimilarResult> {
    logger.debug('ProteinService: Finding similar structures', {
      ...context,
      params,
    });

    try {
      return await this.primaryProvider.findSimilar(params, context);
    } catch (error) {
      if (error instanceof McpError) throw error;

      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `Similarity search failed: ${error instanceof Error ? error.message : String(error)}`,
        { requestId: context.requestId },
      );
    }
  }

  /**
   * Track ligands with automatic fallback
   */
  async trackLigands(
    params: TrackLigandsParams,
    context: RequestContext,
  ): Promise<TrackLigandsResult> {
    logger.debug('ProteinService: Tracking ligands', {
      ...context,
      params,
    });

    try {
      return await this.primaryProvider.trackLigands(params, context);
    } catch (error) {
      logger.warning('Primary provider failed for ligands, trying fallback', {
        ...context,
        error,
      });

      try {
        return await this.fallbackProvider.trackLigands(params, context);
      } catch (_fallbackError) {
        throw new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          `Ligand tracking failed: ${_fallbackError instanceof Error ? _fallbackError.message : String(_fallbackError)}`,
          { requestId: context.requestId },
        );
      }
    }
  }

  /**
   * Analyze collection (primary provider only)
   */
  async analyzeCollection(
    params: AnalyzeCollectionParams,
    context: RequestContext,
  ): Promise<AnalyzeCollectionResult> {
    logger.debug('ProteinService: Analyzing collection', {
      ...context,
      params,
    });

    try {
      return await this.primaryProvider.analyzeCollection(params, context);
    } catch (error) {
      if (error instanceof McpError) throw error;

      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `Collection analysis failed: ${error instanceof Error ? error.message : String(error)}`,
        { requestId: context.requestId },
      );
    }
  }

  /**
   * Health check for all providers
   */
  async healthCheck(): Promise<{
    primary: boolean;
    fallback: boolean;
    healthy: boolean;
  }> {
    const [primary, fallback] = await Promise.all([
      this.primaryProvider.healthCheck().catch(() => false),
      this.fallbackProvider.healthCheck().catch(() => false),
    ]);

    return {
      primary,
      fallback,
      healthy: primary || fallback,
    };
  }
}
