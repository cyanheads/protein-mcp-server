/**
 * @fileoverview TypeScript interfaces for RCSB PDB API responses.
 * @module src/services/protein/providers/rcsb/types
 */

/**
 * RCSB search query structure (recursive)
 */
export interface RcsbSearchQuery {
  type: 'terminal' | 'group';
  service?: string;
  parameters?: Record<string, unknown>;
  logical_operator?: 'and' | 'or';
  nodes?: RcsbSearchQuery[];
}

/**
 * RCSB search API response
 */
export interface RcsbSearchResponse {
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

/**
 * RCSB GraphQL API response structure
 */
export interface RcsbGraphQLResponse {
  errors?: Array<{
    message: string;
    path?: string[];
    locations?: Array<{ line: number; column: number }>;
  }>;
  data?: {
    entry?: RcsbGraphQLEntry;
    entries?: RcsbGraphQLEntry[];
    chem_comp?: {
      chem_comp?: {
        id: string;
        name: string;
        formula?: string;
        formula_weight?: number;
      };
    };
  };
}

/**
 * RCSB GraphQL entry data structure
 */
export interface RcsbGraphQLEntry {
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
    rcsb_entity_source_organism?: Array<{
      ncbi_scientific_name: string;
    }>;
  }>;
  polymer_entity_instances?: Array<{
    rcsb_polymer_entity_instance_container_identifiers?: {
      asym_id: string[];
    };
    rcsb_ligand_neighbors?: Array<{
      ligand_comp_id: string;
      ligand_asym_id: string;
      target_asym_id: string;
      distance: number;
    }>;
  }>;
}
