/**
 * @fileoverview UniProt provider for protein sequence and functional annotation data.
 * Supplements structural data with sequence information and GO annotations.
 * @module src/services/protein/providers/uniprot.provider
 */

import { injectable } from 'tsyringe';

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import {
  fetchWithTimeout,
  logger,
  type RequestContext,
} from '@/utils/index.js';

const UNIPROT_API_URL = 'https://rest.uniprot.org';
const REQUEST_TIMEOUT = 30000;

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
    logger.debug('Fetching protein sequence from UniProt', {
      ...context,
      accession,
    });

    try {
      const url = `${UNIPROT_API_URL}/uniprotkb/${accession}.fasta`;
      const response = await fetchWithTimeout(url, {
        method: 'GET',
        timeout: REQUEST_TIMEOUT,
      });

      if (!response.ok) {
        throw new McpError(
          JsonRpcErrorCode.NotFound,
          `UniProt entry ${accession} not found`,
          { requestId: context.requestId, accession },
        );
      }

      const fasta = await response.text();
      // Extract sequence (skip header line)
      const sequence = fasta.split('\n').slice(1).join('').replace(/\s/g, '');

      return sequence;
    } catch (error) {
      if (error instanceof McpError) throw error;

      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `Failed to fetch sequence from UniProt: ${error instanceof Error ? error.message : String(error)}`,
        { requestId: context.requestId, accession },
      );
    }
  }

  /**
   * Search UniProt by gene name or protein name
   */
  async searchProtein(
    query: string,
    context: RequestContext,
  ): Promise<UniProtSearchResult[]> {
    logger.debug('Searching UniProt', {
      ...context,
      query,
    });

    try {
      const url = `${UNIPROT_API_URL}/uniprotkb/search?query=${encodeURIComponent(query)}&format=json&size=25`;
      const response = await fetchWithTimeout(url, {
        method: 'GET',
        timeout: REQUEST_TIMEOUT,
      });

      if (!response.ok) {
        throw new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          `UniProt search failed: ${response.status}`,
          { requestId: context.requestId },
        );
      }

      const data = (await response.json()) as UniProtAPIResponse;

      return (
        data.results?.map((result) => ({
          accession: result.primaryAccession,
          id: result.uniProtkbId,
          proteinName:
            result.proteinDescription?.recommendedName?.fullName?.value ??
            'Unknown',
          geneName: result.genes?.[0]?.geneName?.value,
          organism: result.organism?.scientificName,
          sequence: result.sequence?.value,
          length: result.sequence?.length,
        })) ?? []
      );
    } catch (error) {
      if (error instanceof McpError) throw error;

      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `UniProt search failed: ${error instanceof Error ? error.message : String(error)}`,
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

// TypeScript interfaces for UniProt API

export interface UniProtSearchResult {
  accession: string;
  id: string;
  proteinName: string;
  geneName?: string | undefined;
  organism?: string | undefined;
  sequence?: string | undefined;
  length?: number | undefined;
}

interface UniProtAPIResponse {
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
