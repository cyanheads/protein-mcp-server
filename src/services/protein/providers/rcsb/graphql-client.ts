/**
 * @fileoverview GraphQL client for RCSB PDB data access.
 * @module src/services/protein/providers/rcsb/graphql-client
 */

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import {
  fetchWithTimeout,
  logger,
  type RequestContext,
} from '@/utils/index.js';
import type { ProteinStructure, SearchStructuresResult } from '../../types.js';
import { RCSB_GRAPHQL_URL, REQUEST_TIMEOUT } from './config.js';
import type { RcsbGraphQLResponse } from './types.js';

/**
 * Enrich search results with detailed metadata from GraphQL
 */
export async function enrichSearchResults(
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
        }
        rcsb_accession_info {
          initial_release_date
        }
        polymer_entities {
          rcsb_entity_source_organism {
            ncbi_scientific_name
          }
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

    if (data.errors && data.errors.length > 0) {
      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `RCSB GraphQL enrichment failed: ${data.errors.map((e) => e.message).join('; ')}`,
        { requestId: context.requestId, errors: data.errors },
      );
    }

    return (
      data.data?.entries?.map((entry) => {
        // Correctly extract organism names from the nested structure
        const organismNames =
          entry.polymer_entities?.flatMap(
            (pe) =>
              pe.rcsb_entity_source_organism?.map(
                (org) => org.ncbi_scientific_name,
              ) ?? [],
          ) ?? [];
        const uniqueOrganismNames = [...new Set(organismNames)];

        return {
          pdbId: entry.rcsb_id,
          title: entry.struct?.title ?? 'Unknown',
          organism: uniqueOrganismNames,
          experimentalMethod: entry.exptl?.[0]?.method ?? 'Unknown',
          resolution:
            entry.rcsb_entry_info?.resolution_combined?.find(
              (r) => r !== null,
            ) ?? undefined,
          releaseDate: entry.rcsb_accession_info?.initial_release_date ?? '',
          molecularWeight: entry.rcsb_entry_info?.molecular_weight,
        };
      }) ?? []
    );
  } catch (error) {
    logger.error('Failed to enrich search results', { ...context, error });
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(
      JsonRpcErrorCode.InternalError,
      `An unexpected error occurred during search result enrichment: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Fetch complete structure metadata via GraphQL
 */
export async function fetchStructureMetadata(
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
      resolution:
        entry.rcsb_entry_info?.resolution_combined &&
        entry.rcsb_entry_info.resolution_combined.length > 0
          ? entry.rcsb_entry_info.resolution_combined[0]
          : undefined,
      rFree: entry.refine?.[0]?.ls_R_factor_R_free ?? undefined,
      rFactor: entry.refine?.[0]?.ls_R_factor_R_work ?? undefined,
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
              pubmedId: String(
                entry.rcsb_primary_citation.pdbx_database_id_PubMed,
              ),
              year: entry.rcsb_primary_citation.year,
            },
          ]
        : [],
    },
  };
}

/**
 * Get protein sequence for a PDB ID
 */
export async function getSequenceForPdbId(
  pdbId: string,
  _context: RequestContext,
): Promise<string> {
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

/**
 * Get binding site information for a ligand in a structure
 */
export async function getBindingSiteInfo(
  pdbId: string,
  ligandId: string,
  context: RequestContext,
): Promise<
  Array<{
    chain: string;
    residues: Array<{ name: string; number: number; interactions: string[] }>;
  }>
> {
  const query = `
    query($id: String!) {
      entry(entry_id: $id) {
        polymer_entity_instances {
          rcsb_polymer_entity_instance_container_identifiers {
            asym_id
          }
          rcsb_ligand_neighbors {
            ligand_comp_id
            ligand_asym_id
            target_asym_id
            distance
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
    logger.warning('Failed to fetch binding site info', {
      ...context,
      pdbId,
      ligandId,
      status: response.status,
    });
    return [];
  }

  const data = (await response.json()) as RcsbGraphQLResponse;
  const instances = data.data?.entry?.polymer_entity_instances || [];

  // Group interactions by chain
  const bindingSites = new Map<string, Set<string>>();

  for (const instance of instances) {
    const chainId =
      instance.rcsb_polymer_entity_instance_container_identifiers?.asym_id?.[0];
    if (!chainId) continue;

    const neighbors = instance.rcsb_ligand_neighbors || [];
    for (const neighbor of neighbors) {
      if (neighbor.ligand_comp_id === ligandId.toUpperCase()) {
        const targetChain = neighbor.target_asym_id;
        if (targetChain) {
          if (!bindingSites.has(targetChain)) {
            bindingSites.set(targetChain, new Set());
          }
          // Store interaction info (simplified - would parse residue details in production)
          bindingSites.get(targetChain)?.add(`${neighbor.distance}Å`);
        }
      }
    }
  }

  // Convert to array format
  return Array.from(bindingSites.entries()).map(([chain, _interactions]) => ({
    chain,
    residues: [], // Would need additional query for residue-level details
  }));
}
