/**
 * @fileoverview TypeScript interfaces for UniProt API responses.
 * @module src/services/protein/providers/uniprot/types
 */

/**
 * UniProt search result entry
 */
export interface UniProtSearchResult {
  accession: string;
  id: string;
  proteinName: string;
  geneName?: string | undefined;
  organism?: string | undefined;
  sequence?: string | undefined;
  length?: number | undefined;
}

/**
 * UniProt API response structure
 */
export interface UniProtAPIResponse {
  results?: Array<{
    primaryAccession: string;
    uniProtkbId: string;
    proteinDescription?: {
      recommendedName?: {
        fullName?: {
          value: string;
        };
      };
    };
    genes?: Array<{
      geneName?: {
        value: string;
      };
    }>;
    organism?: {
      scientificName: string;
    };
    sequence?: {
      value: string;
      length: number;
    };
  }>;
}
