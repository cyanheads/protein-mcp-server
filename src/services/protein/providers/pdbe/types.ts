/**
 * @fileoverview TypeScript interfaces for PDBe API responses.
 * @module src/services/protein/providers/pdbe/types
 */

/**
 * PDBe entry summary data structure
 */
export interface PdbeEntrySummary {
  title?: string;
  experimental_method?: string[];
  resolution?: number;
  release_date?: string;
  molecular_weight?: number;
  source?: Array<{
    organism_scientific_name?: string;
  }>;
}
