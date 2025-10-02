/**
 * @fileoverview Structure file fetching and enrichment service.
 * @module src/services/protein/providers/rcsb/enrichment-service
 */

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { fetchWithTimeout, type RequestContext } from '@/utils/index.js';
import type { ProteinStructure } from '../../types.js';
import { StructureFormat } from '../../types.js';
import { RCSB_FILES_URL, REQUEST_TIMEOUT } from './config.js';

/**
 * Fetch structure file from RCSB in specified format
 */
export async function fetchStructureFile(
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
