/**
 * @fileoverview UniProt search and sequence client.
 * @module src/services/protein/providers/uniprot/search-client
 */

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import {
  fetchWithTimeout,
  logger,
  type RequestContext,
} from '@/utils/index.js';
import { REQUEST_TIMEOUT, UNIPROT_API_URL } from './config.js';
import type { UniProtAPIResponse, UniProtSearchResult } from './types.js';

/**
 * Fetch protein sequence by UniProt accession
 */
export async function getProteinSequence(
  accession: string,
  context: RequestContext,
): Promise<string> {
  logger.debug('Fetching protein sequence from UniProt', {
    ...context,
    accession,
  });

  try {
    const url = `${UNIPROT_API_URL}/uniprotkb/${accession}.fasta`;

    logger.debug('Fetching protein sequence from UniProt', {
      ...context,
      accession,
      url,
    });

    const response = await fetchWithTimeout(url, {
      method: 'GET',
      timeout: REQUEST_TIMEOUT,
    });

    if (!response.ok) {
      logger.error('UniProt sequence fetch failed', {
        ...context,
        accession,
        url,
        status: response.status,
        statusText: response.statusText,
      });
      throw new McpError(
        JsonRpcErrorCode.NotFound,
        `UniProt entry ${accession} not found`,
        { requestId: context.requestId, accession },
      );
    }

    const fasta = await response.text();
    // Extract sequence (skip header line)
    const sequence = fasta.split('\n').slice(1).join('').replace(/\s/g, '');

    logger.debug('UniProt sequence retrieved', {
      ...context,
      accession,
      sequenceLength: sequence.length,
      sequencePreview: sequence.substring(0, 50),
    });

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
export async function searchProtein(
  query: string,
  context: RequestContext,
): Promise<UniProtSearchResult[]> {
  logger.debug('Searching UniProt', {
    ...context,
    query,
  });

  try {
    const url = `${UNIPROT_API_URL}/uniprotkb/search?query=${encodeURIComponent(query)}&format=json&size=25`;

    logger.debug('Searching UniProt', {
      ...context,
      query,
      url,
    });

    const response = await fetchWithTimeout(url, {
      method: 'GET',
      timeout: REQUEST_TIMEOUT,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error('UniProt search API error', {
        ...context,
        query,
        url,
        status: response.status,
        statusText: response.statusText,
        responseBody: errorBody,
      });
      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `UniProt search failed: ${response.status}`,
        { requestId: context.requestId },
      );
    }

    const data = (await response.json()) as UniProtAPIResponse;

    logger.debug('UniProt search response received', {
      ...context,
      query,
      resultCount: data.results?.length ?? 0,
      rawResponse: JSON.stringify(data, null, 2),
    });

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
