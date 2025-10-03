/**
 * @fileoverview GraphQL client for RCSB PDB data access using official @rcsb/rcsb-api-tools.
 * @module src/services/protein/providers/rcsb/graphql-client
 */

import { GraphQLRequest } from '@rcsb/rcsb-api-tools';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger, type RequestContext } from '@/utils/index.js';
import {
  StructureFormat,
  type ChainType,
  type ProteinStructure,
  type SearchStructuresResult,
} from '../../types.js';
import { REQUEST_TIMEOUT } from './config.js';
import type { RcsbGraphQLResponse } from './types.js';

/**
 * Singleton GraphQL client instance
 * @rcsb/rcsb-api-tools has poor TypeScript types, so we suppress eslint warnings
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
const graphqlClient = new GraphQLRequest('data-api', {
  timeout: REQUEST_TIMEOUT,
});

/**
 * Type-safe wrapper around GraphQL client request
 * Suppresses eslint warnings for third-party library with poor types
 */
function graphqlRequest<T>(
  variables: Record<string, unknown>,
  query: string,
): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  return graphqlClient.request(variables, query) as Promise<T>;
}

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

  const variables = { ids: pdbIds };

  logger.debug('Enriching search results via GraphQL', {
    ...context,
    pdbIdCount: pdbIds.length,
    pdbIds,
    variables,
  });

  try {
    const data = await graphqlRequest<RcsbGraphQLResponse>(variables, query);

    logger.debug('GraphQL enrichment response received', {
      ...context,
      entryCount: data.data?.entries?.length ?? 0,
      hasErrors: !!data.errors,
      errorCount: data.errors?.length ?? 0,
    });

    if (data.errors && data.errors.length > 0) {
      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `RCSB GraphQL enrichment failed: ${data.errors.map((e: { message: string }) => e.message).join('; ')}`,
        { requestId: context.requestId, errors: data.errors },
      );
    }

    return (
      data.data?.entries?.map((entry: (typeof data.data.entries)[number]) => {
        // Correctly extract organism names from the nested structure
        const organismNames =
          entry.polymer_entities?.flatMap(
            (pe: NonNullable<typeof entry.polymer_entities>[number]) =>
              pe.rcsb_entity_source_organism?.map(
                (
                  org: NonNullable<
                    typeof pe.rcsb_entity_source_organism
                  >[number],
                ) => org.ncbi_scientific_name,
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
              (r: number | null) => r !== null,
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
): Promise<
  Omit<ProteinStructure, 'structure'> & {
    structure: Partial<ProteinStructure['structure']>;
  }
> {
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
          rcsb_entity_source_organism {
            ncbi_scientific_name
          }
        }
      }
    }
  `;

  const variables = { id: pdbId };

  logger.debug('Fetching structure metadata via GraphQL', {
    ...context,
    pdbId,
    variables,
  });

  const data = await graphqlRequest<RcsbGraphQLResponse>(variables, query);

  logger.debug('Structure metadata response received', {
    ...context,
    pdbId,
    hasEntry: !!data.data?.entry,
  });

  const entry = data.data?.entry;

  if (!entry) {
    logger.warning('Structure metadata returned empty entry', {
      ...context,
      pdbId,
    });
    throw new McpError(
      JsonRpcErrorCode.NotFound,
      `Structure ${pdbId} not found`,
      { requestId: context.requestId, pdbId },
    );
  }

  const chainOrganisms: Record<string, string> = {};
  if (entry.polymer_entities) {
    for (const entity of entry.polymer_entities) {
      if (
        entity.rcsb_polymer_entity_container_identifiers?.auth_asym_ids &&
        entity.rcsb_entity_source_organism?.length
      ) {
        const organismName =
          entity.rcsb_entity_source_organism[0]?.ncbi_scientific_name;
        if (organismName) {
          for (const chainId of entity.rcsb_polymer_entity_container_identifiers
            .auth_asym_ids) {
            chainOrganisms[chainId] = organismName;
          }
        }
      }
    }
  }

  const chains =
    entry.polymer_entities?.flatMap(
      (pe: NonNullable<typeof entry.polymer_entities>[number]) =>
        pe.rcsb_polymer_entity_container_identifiers?.auth_asym_ids.map(
          (id: string) => ({
            id,
            type:
              (pe.entity_poly?.type?.toLowerCase() as ChainType) || 'protein',
            length: pe.entity_poly?.pdbx_seq_one_letter_code?.length ?? 0,
            organism: chainOrganisms[id] ?? 'Unknown',
          }),
        ) ?? [],
    ) ?? [];

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
      keywords: [], // Placeholder, keywords are typically broader and not in this query
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
    structure: {
      format: StructureFormat.JSON,
      data: {},
      chains,
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

  const variables = { id: pdbId };

  const data = await graphqlRequest<RcsbGraphQLResponse>(variables, query);

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

  const variables = { id: pdbId };

  logger.debug('Fetching binding site info via GraphQL', {
    ...context,
    pdbId,
    ligandId,
    variables,
  });

  try {
    const data = await graphqlRequest<RcsbGraphQLResponse>(variables, query);

    logger.debug('Binding site info response received', {
      ...context,
      pdbId,
      ligandId,
      instanceCount: data.data?.entry?.polymer_entity_instances?.length ?? 0,
    });

    const instances = data.data?.entry?.polymer_entity_instances || [];

    // Group interactions by chain
    const bindingSites = new Map<string, Set<string>>();

    for (const instance of instances) {
      const chainId =
        instance.rcsb_polymer_entity_instance_container_identifiers
          ?.asym_id?.[0];
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
  } catch (error) {
    logger.warning('Failed to fetch binding site info', {
      ...context,
      pdbId,
      ligandId,
      error,
    });
    return [];
  }
}

/**
 * Get chemical properties for a ligand
 */
export async function getLigandChemicalProperties(
  ligandId: string,
  context: RequestContext,
): Promise<{
  name: string;
  chemicalId: string;
  formula?: string;
  molecularWeight?: number;
}> {
  const query = `
    query($chemId: String!) {
      chem_comp(comp_id: $chemId) {
        chem_comp {
          id
          name
          formula
          formula_weight
        }
      }
    }
  `;

  const variables = { chemId: ligandId.toUpperCase() };

  logger.debug('Fetching ligand chemical properties', {
    ...context,
    ligandId,
    variables,
  });

  try {
    const data = await graphqlRequest<RcsbGraphQLResponse>(variables, query);

    const chemComp = data.data?.chem_comp?.chem_comp;

    logger.debug('Ligand chemical properties received', {
      ...context,
      ligandId,
      hasData: !!chemComp,
    });

    const result: {
      name: string;
      chemicalId: string;
      formula?: string;
      molecularWeight?: number;
    } = {
      name: chemComp?.name || ligandId,
      chemicalId: chemComp?.id || ligandId.toUpperCase(),
    };

    if (chemComp?.formula) {
      result.formula = chemComp.formula;
    }
    if (chemComp?.formula_weight) {
      result.molecularWeight = chemComp.formula_weight;
    }

    return result;
  } catch (error) {
    logger.warning('Failed to fetch ligand chemical properties', {
      ...context,
      ligandId,
      error,
    });
    // Return minimal info if GraphQL fails
    return {
      name: ligandId,
      chemicalId: ligandId.toUpperCase(),
    };
  }
}
