/**
 * @fileoverview UniProt provider for protein sequence and functional annotation data.
 * Supplements structural data with sequence information and GO annotations.
 * @module src/services/protein/providers/uniprot
 */

import { injectable } from 'tsyringe';

import { fetchWithTimeout, type RequestContext } from '@/utils/index.js';
import { UNIPROT_API_URL } from './config.js';
import * as searchClient from './search-client.js';
import type { UniProtSearchResult } from './types.js';

/**
 * Simplified UniProt provider for sequence data enrichment.
 * Note: This is not a full IProteinProvider implementation as UniProt
 * complements rather than replaces structural databases.
 */
@injectable()
export class UniProtProvider {
  public readonly name = 'UniProt';

  /**
   * Fetch protein sequence by UniProt accession
   */
  async getProteinSequence(
    accession: string,
    context: RequestContext,
  ): Promise<string> {
    return searchClient.getProteinSequence(accession, context);
  }

  /**
   * Search UniProt by gene name or protein name
   */
  async searchProtein(
    query: string,
    context: RequestContext,
  ): Promise<UniProtSearchResult[]> {
    return searchClient.searchProtein(query, context);
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetchWithTimeout(
        `${UNIPROT_API_URL}/uniprotkb/search?query=P12345&size=1`,
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

// Re-export types for convenience
export type { UniProtSearchResult } from './types.js';
