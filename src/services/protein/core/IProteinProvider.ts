/**
 * @fileoverview Provider interface for protein structure data sources.
 * All concrete providers (RCSB, PDBe, UniProt) must implement this contract.
 * @module src/services/protein/core/IProteinProvider
 */

import type { RequestContext } from '@/utils/index.js';
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

/**
 * Standard interface for protein data providers.
 * Implements the Strategy pattern for multi-provider support.
 */
export interface IProteinProvider {
  /**
   * Human-readable provider name
   */
  readonly name: string;

  /**
   * Search for protein structures matching criteria
   * @param params - Search parameters (query, filters, pagination)
   * @param context - Request context for tracing and logging
   * @returns Search results with pagination info
   * @throws {McpError} with ValidationError or ServiceError codes
   */
  searchStructures(
    params: SearchStructuresParams,
    context: RequestContext,
  ): Promise<SearchStructuresResult>;

  /**
   * Retrieve complete structure data for a specific PDB entry
   * @param pdbId - 4-character PDB identifier
   * @param options - Format and inclusion options
   * @param context - Request context for tracing and logging
   * @returns Complete protein structure with metadata
   * @throws {McpError} with NotFoundError if PDB ID invalid, ServiceError on API failure
   */
  getStructure(
    pdbId: string,
    options: GetStructureOptions,
    context: RequestContext,
  ): Promise<ProteinStructure>;

  /**
   * Compare multiple protein structures and calculate alignment metrics
   * @param params - Comparison parameters (PDB IDs, method, chain selections)
   * @param context - Request context for tracing and logging
   * @returns Alignment results with RMSD, TM-score, and conformational analysis
   * @throws {McpError} with ValidationError if < 2 structures, ServiceError on failure
   */
  compareStructures(
    params: CompareStructuresParams,
    context: RequestContext,
  ): Promise<CompareStructuresResult>;

  /**
   * Find structures similar by sequence or structural alignment
   * @param params - Query (PDB ID, sequence, or structure) and similarity type
   * @param context - Request context for tracing and logging
   * @returns Ranked list of similar structures with metrics
   * @throws {McpError} with ValidationError or ServiceError codes
   */
  findSimilar(
    params: FindSimilarParams,
    context: RequestContext,
  ): Promise<FindSimilarResult>;

  /**
   * Track structures containing specific ligands, cofactors, or drugs
   * @param params - Ligand query and optional filters
   * @param context - Request context for tracing and logging
   * @returns Structures with ligand and optional binding site details
   * @throws {McpError} with NotFoundError if ligand unknown, ServiceError on failure
   */
  trackLigands(
    params: TrackLigandsParams,
    context: RequestContext,
  ): Promise<TrackLigandsResult>;

  /**
   * Statistical analysis of structure database by category
   * @param params - Analysis type, filters, and grouping options
   * @param context - Request context for tracing and logging
   * @returns Aggregate statistics and trends
   * @throws {McpError} with ValidationError or ServiceError codes
   */
  analyzeCollection(
    params: AnalyzeCollectionParams,
    context: RequestContext,
  ): Promise<AnalyzeCollectionResult>;

  /**
   * Health check to verify provider connectivity and API availability
   * @returns true if provider is healthy, false otherwise
   */
  healthCheck(): Promise<boolean>;
}
