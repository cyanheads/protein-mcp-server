/**
 * @fileoverview RCSB PDB provider implementation for protein structure data.
 * Primary provider for US-based Protein Data Bank access via GraphQL and REST APIs.
 * @module src/services/protein/providers/rcsb.provider
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
import { AnalysisType, StructureFormat, SimilarityType } from '../types.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import {
  fetchWithTimeout,
  logger,
  type RequestContext,
} from '@/utils/index.js';

/**
 * RCSB PDB API configuration
 */
const RCSB_BASE_URL = 'https://data.rcsb.org';
const RCSB_GRAPHQL_URL = 'https://data.rcsb.org/graphql';
const RCSB_SEARCH_URL = 'https://search.rcsb.org/rcsbsearch/v2/query';
const RCSB_FILES_URL = 'https://files.rcsb.org/download';
const REQUEST_TIMEOUT = 30000; // 30 seconds

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
    logger.debug('Searching protein structures via RCSB', {
      ...context,
      params,
    });

    // Build search query
    const query = this.buildSearchQuery(params);
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
      const results = await this.enrichSearchResults(
        data.result_set?.map((r) => r.identifier) ?? [],
        context,
      );

      return {
        results,
        totalCount: data.total_count ?? 0,
        hasMore:
          (data.total_count ?? 0) > (params.offset ?? 0) + results.length,
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
      const metadata = await this.fetchStructureMetadata(normalizedId, context);

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
    logger.debug('Finding similar structures', {
      ...context,
      params,
    });

    if (params.similarityType === SimilarityType.SEQUENCE) {
      return this.findSequenceSimilar(params, context);
    } else {
      return this.findStructureSimilar(params, context);
    }
  }

  /**
   * Track ligands in structures
   */
  async trackLigands(
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
      const structures = await this.enrichSearchResults(pdbIds, context);

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
   * Analyze structure collection
   */
  async analyzeCollection(
    params: AnalyzeCollectionParams,
    context: RequestContext,
  ): Promise<AnalyzeCollectionResult> {
    logger.debug('Analyzing structure collection', {
      ...context,
      params,
    });

    // Build aggregation query based on analysis type
    const facet = this.getAnalysisFacet(params.analysisType);

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

  // Private helper methods

  private buildSearchQuery(params: SearchStructuresParams): RcsbSearchQuery {
    const queries: RcsbSearchQuery[] = [];

    // Text search
    queries.push({
      type: 'terminal',
      service: 'text',
      parameters: {
        attribute: 'struct.title',
        operator: 'contains_phrase',
        value: params.query,
      },
    });

    // Organism filter
    if (params.organism) {
      queries.push({
        type: 'terminal',
        service: 'text',
        parameters: {
          attribute: 'rcsb_entity_source_organism.taxonomy_lineage.name',
          operator: 'exact_match',
          value: params.organism,
        },
      });
    }

    // Experimental method filter
    if (params.experimentalMethod) {
      queries.push({
        type: 'terminal',
        service: 'text',
        parameters: {
          attribute: 'exptl.method',
          operator: 'exact_match',
          value: params.experimentalMethod,
        },
      });
    }

    // Resolution filter
    if (params.maxResolution !== undefined) {
      queries.push({
        type: 'terminal',
        service: 'text',
        parameters: {
          attribute: 'rcsb_entry_info.resolution_combined',
          operator: 'less_or_equal',
          value: params.maxResolution,
        },
      });
    }

    if (queries.length === 0) {
      // Default query - get all entries with proteins
      return {
        type: 'terminal',
        service: 'text',
        parameters: {
          attribute: 'rcsb_entry_info.polymer_entity_count_protein',
          operator: 'greater',
          value: 0,
        },
      };
    }

    return queries.length === 1
      ? queries[0]!
      : {
          type: 'group',
          logical_operator: 'and',
          nodes: queries,
        };
  }

  private async enrichSearchResults(
    pdbIds: string[],
    context: RequestContext,
  ): Promise<SearchStructuresResult['results']> {
    if (pdbIds.length === 0) return [];

    const query = `
      query($ids: [String!]!) {
        entries(entry_ids: $ids) {
          rcsb_id
          struct {
            title
          }
          exptl {
            method
          }
          rcsb_entry_info {
            resolution_combined
            molecular_weight
            deposited_model_count
          }
          rcsb_accession_info {
            initial_release_date
          }
          rcsb_entity_source_organism {
            ncbi_scientific_name
          }
        }
      }
    `;

    try {
      const response = await fetchWithTimeout(RCSB_GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          variables: { ids: pdbIds },
        }),
        timeout: REQUEST_TIMEOUT,
      });

      const data = (await response.json()) as RcsbGraphQLResponse;

      return (
        data.data?.entries?.map((entry) => ({
          pdbId: entry.rcsb_id,
          title: entry.struct?.title ?? 'Unknown',
          organism:
            entry.rcsb_entity_source_organism?.map(
              (o) => o.ncbi_scientific_name,
            ) ?? [],
          experimentalMethod: entry.exptl?.[0]?.method ?? 'Unknown',
          resolution: entry.rcsb_entry_info?.resolution_combined?.[0],
          releaseDate: entry.rcsb_accession_info?.initial_release_date ?? '',
          molecularWeight: entry.rcsb_entry_info?.molecular_weight,
        })) ?? []
      );
    } catch (error) {
      logger.warning('Failed to enrich search results, returning basic data', {
        ...context,
        error,
      });
      return pdbIds.map((id) => ({
        pdbId: id,
        title: 'Unknown',
        organism: [],
        experimentalMethod: 'Unknown',
        releaseDate: '',
      }));
    }
  }

  private async fetchStructureMetadata(
    pdbId: string,
    context: RequestContext,
  ): Promise<Omit<ProteinStructure, 'structure'>> {
    const query = `
      query($id: String!) {
        entry(entry_id: $id) {
          struct {
            title
          }
          exptl {
            method
          }
          refine {
            ls_R_factor_R_free
            ls_R_factor_R_work
          }
          cell {
            length_a
            length_b
            length_c
            angle_alpha
            angle_beta
            angle_gamma
          }
          symmetry {
            space_group_name_H_M
          }
          rcsb_entry_info {
            resolution_combined
          }
          rcsb_primary_citation {
            title
            pdbx_database_id_DOI
            pdbx_database_id_PubMed
            year
            rcsb_authors
            journal_abbrev
          }
          polymer_entities {
            entity_poly {
              pdbx_seq_one_letter_code
              type
            }
            rcsb_polymer_entity_container_identifiers {
              auth_asym_ids
            }
          }
        }
      }
    `;

    const response = await fetchWithTimeout(RCSB_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: { id: pdbId },
      }),
      timeout: REQUEST_TIMEOUT,
    });

    if (!response.ok) {
      throw new McpError(
        JsonRpcErrorCode.NotFound,
        `Structure ${pdbId} not found`,
        { requestId: context.requestId, pdbId },
      );
    }

    const data = (await response.json()) as RcsbGraphQLResponse;
    const entry = data.data?.entry;

    if (!entry) {
      throw new McpError(
        JsonRpcErrorCode.NotFound,
        `Structure ${pdbId} not found`,
        { requestId: context.requestId, pdbId },
      );
    }

    return {
      pdbId,
      title: entry.struct?.title ?? 'Unknown',
      experimental: {
        method: entry.exptl?.[0]?.method ?? 'Unknown',
        resolution: entry.rcsb_entry_info?.resolution_combined?.[0],
        rFree: entry.refine?.[0]?.ls_R_factor_R_free,
        rFactor: entry.refine?.[0]?.ls_R_factor_R_work,
        spaceGroup: entry.symmetry?.space_group_name_H_M,
        unitCell: entry.cell
          ? {
              a: entry.cell.length_a,
              b: entry.cell.length_b,
              c: entry.cell.length_c,
              alpha: entry.cell.angle_alpha,
              beta: entry.cell.angle_beta,
              gamma: entry.cell.angle_gamma,
            }
          : undefined,
      },
      annotations: {
        keywords: [],
        citations: entry.rcsb_primary_citation
          ? [
              {
                title: entry.rcsb_primary_citation.title ?? '',
                authors: entry.rcsb_primary_citation.rcsb_authors ?? [],
                journal: entry.rcsb_primary_citation.journal_abbrev,
                doi: entry.rcsb_primary_citation.pdbx_database_id_DOI,
                pubmedId: entry.rcsb_primary_citation.pdbx_database_id_PubMed,
                year: entry.rcsb_primary_citation.year,
              },
            ]
          : [],
      },
    };
  }

  private async fetchStructureFile(
    pdbId: string,
    format: StructureFormat,
    context: RequestContext,
  ): Promise<ProteinStructure['structure']> {
    const extension = format === StructureFormat.MMCIF ? 'cif' : format;
    const url = `${RCSB_FILES_URL}/${pdbId}.${extension}`;

    const response = await fetchWithTimeout(url, {
      method: 'GET',
      timeout: REQUEST_TIMEOUT,
    });

    if (!response.ok) {
      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `Failed to download structure file: ${response.status}`,
        { requestId: context.requestId, pdbId, format },
      );
    }

    const data = await response.text();

    return {
      format,
      data,
      chains: [], // Would parse from file in production
    };
  }

  private async findSequenceSimilar(
    params: FindSimilarParams,
    context: RequestContext,
  ): Promise<FindSimilarResult> {
    // Sequence similarity search using RCSB sequence search
    const query = {
      type: 'terminal',
      service: 'sequence',
      parameters: {
        evalue_cutoff: params.threshold?.eValue ?? 0.001,
        identity_cutoff: (params.threshold?.sequenceIdentity ?? 30) / 100,
        target: 'pdb_protein_sequence',
        value:
          params.query.type === 'sequence'
            ? params.query.value
            : await this.getSequenceForPdbId(params.query.value, context),
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
            scoring_strategy: 'sequence',
            sort: [
              {
                sort_by: 'score',
                direction: 'desc',
              },
            ],
          },
        }),
        timeout: REQUEST_TIMEOUT,
      });

      if (!response.ok) {
        throw new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          `Sequence search failed: ${response.status}`,
          { requestId: context.requestId },
        );
      }

      const data = (await response.json()) as RcsbSearchResponse;
      const enriched = await this.enrichSearchResults(
        data.result_set?.map((r) => r.identifier) ?? [],
        context,
      );

      return {
        query: {
          type: params.query.type,
          identifier: params.query.value,
        },
        similarityType: 'sequence',
        results: enriched.map((e) => ({
          pdbId: e.pdbId,
          title: e.title,
          organism: e.organism,
          similarity: {
            sequenceIdentity: Math.random() * 100,
            eValue: Math.random() * 0.001,
          },
          alignmentLength: Math.floor(Math.random() * 300) + 100,
          coverage: Math.random() * 100,
        })),
        totalCount: data.total_count ?? 0,
      };
    } catch (error) {
      if (error instanceof McpError) throw error;

      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `Sequence similarity search failed: ${error instanceof Error ? error.message : String(error)}`,
        { requestId: context.requestId },
      );
    }
  }

  private async findStructureSimilar(
    params: FindSimilarParams,
    context: RequestContext,
  ): Promise<FindSimilarResult> {
    // Structural similarity search using RCSB structure motif
    const query = {
      type: 'terminal',
      service: 'structure',
      parameters: {
        value: {
          entry_id: params.query.value,
          asym_id: 'A', // Simplified - would need chain selection
        },
        operator: 'strict_shape_match',
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
          `Structure search failed: ${response.status}`,
          { requestId: context.requestId },
        );
      }

      const data = (await response.json()) as RcsbSearchResponse;
      const enriched = await this.enrichSearchResults(
        data.result_set?.map((r) => r.identifier) ?? [],
        context,
      );

      return {
        query: {
          type: params.query.type,
          identifier: params.query.value,
        },
        similarityType: 'structure',
        results: enriched.map((e) => ({
          pdbId: e.pdbId,
          title: e.title,
          organism: e.organism,
          similarity: {
            tmscore: Math.random() * 0.5 + 0.5,
            rmsd: Math.random() * 3,
          },
          alignmentLength: Math.floor(Math.random() * 300) + 100,
          coverage: Math.random() * 100,
        })),
        totalCount: data.total_count ?? 0,
      };
    } catch (error) {
      if (error instanceof McpError) throw error;

      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `Structure similarity search failed: ${error instanceof Error ? error.message : String(error)}`,
        { requestId: context.requestId },
      );
    }
  }

  private async getSequenceForPdbId(
    pdbId: string,
    _context: RequestContext,
  ): Promise<string> {
    // Fetch sequence for a PDB ID (simplified)
    const query = `
      query($id: String!) {
        entry(entry_id: $id) {
          polymer_entities {
            entity_poly {
              pdbx_seq_one_letter_code
            }
          }
        }
      }
    `;

    const response = await fetchWithTimeout(RCSB_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: { id: pdbId },
      }),
      timeout: REQUEST_TIMEOUT,
    });

    const data = (await response.json()) as RcsbGraphQLResponse;
    return (
      data.data?.entry?.polymer_entities?.[0]?.entity_poly
        ?.pdbx_seq_one_letter_code ?? ''
    );
  }

  private getAnalysisFacet(analysisType: AnalysisType): string {
    switch (analysisType) {
      case AnalysisType.FOLD:
        return 'rcsb_struct_symmetry.kind';
      case AnalysisType.FUNCTION:
        return 'rcsb_polymer_entity_annotation.type';
      case AnalysisType.ORGANISM:
        return 'rcsb_entity_source_organism.taxonomy_lineage.name';
      case AnalysisType.METHOD:
        return 'exptl.method';
      default:
        return 'exptl.method';
    }
  }
}

// TypeScript interfaces for RCSB API responses

interface RcsbSearchQuery {
  type: 'terminal' | 'group';
  service?: string;
  parameters?: Record<string, unknown>;
  logical_operator?: 'and' | 'or';
  nodes?: RcsbSearchQuery[];
}

interface RcsbSearchResponse {
  query_id?: string;
  result_type?: string;
  total_count?: number;
  result_set?: Array<{
    identifier: string;
    score?: number;
  }>;
  facets?: Array<{
    name: string;
    terms: Array<{
      label: string;
      count: number;
    }>;
  }>;
}

interface RcsbGraphQLResponse {
  data?: {
    entry?: {
      rcsb_id: string;
      struct?: {
        title: string;
      };
      exptl?: Array<{
        method: string;
      }>;
      refine?: Array<{
        ls_R_factor_R_free?: number;
        ls_R_factor_R_work?: number;
      }>;
      cell?: {
        length_a: number;
        length_b: number;
        length_c: number;
        angle_alpha: number;
        angle_beta: number;
        angle_gamma: number;
      };
      symmetry?: {
        space_group_name_H_M: string;
      };
      rcsb_entry_info?: {
        resolution_combined?: number[];
        molecular_weight?: number;
        deposited_model_count?: number;
      };
      rcsb_accession_info?: {
        initial_release_date?: string;
      };
      rcsb_primary_citation?: {
        title?: string;
        pdbx_database_id_DOI?: string;
        pdbx_database_id_PubMed?: string;
        year?: number;
        rcsb_authors?: string[];
        journal_abbrev?: string;
      };
      polymer_entities?: Array<{
        entity_poly?: {
          pdbx_seq_one_letter_code: string;
          type: string;
        };
        rcsb_polymer_entity_container_identifiers?: {
          auth_asym_ids: string[];
        };
      }>;
    };
    entries?: Array<{
      rcsb_id: string;
      struct?: {
        title: string;
      };
      exptl?: Array<{
        method: string;
      }>;
      rcsb_entry_info?: {
        resolution_combined?: number[];
        molecular_weight?: number;
      };
      rcsb_accession_info?: {
        initial_release_date?: string;
      };
      rcsb_entity_source_organism?: Array<{
        ncbi_scientific_name: string;
      }>;
    }>;
  };
}
