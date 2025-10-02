/**
 * @fileoverview Structure file fetching and enrichment service.
 * @module src/services/protein/providers/rcsb/enrichment-service
 */

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import {
  fetchWithTimeout,
  logger,
  type RequestContext,
} from '@/utils/index.js';
import type { ProteinStructure } from '../../types.js';
import { ChainType, StructureFormat } from '../../types.js';
import { RCSB_FILES_URL, REQUEST_TIMEOUT } from './config.js';

/**
 * RCSB BinaryCIF model server URL
 */
const RCSB_BCIF_URL = 'https://models.rcsb.org';

/**
 * Maps a string from an mmCIF file to a ChainType enum.
 * @param typeString The string type from the mmCIF file.
 * @returns The corresponding ChainType.
 */
function mapCifTypeToChainType(typeString: string): ChainType {
  const lowerType = typeString.toLowerCase();
  if (lowerType.includes('polypeptide')) {
    return ChainType.PROTEIN;
  }
  if (lowerType.includes('polydeoxyribonucleotide')) {
    return ChainType.DNA;
  }
  if (lowerType.includes('polyribonucleotide')) {
    return ChainType.RNA;
  }
  return ChainType.LIGAND; // Default for non-polymeric entities
}

/**
 * A robust parser for mmCIF files to extract chain information from the _entity_poly loop.
 */
function parseChainsFromCif(
  cifData: string,
): ProteinStructure['structure']['chains'] {
  const chains: ProteinStructure['structure']['chains'] = [];
  const lines = cifData.split('\n');
  let inTargetLoop = false;
  const columns: string[] = [];
  let dataStartIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;

    if (line.startsWith('loop_')) {
      let nextLineIndex = i + 1;
      let isEntityPolyLoop = false;
      const tempColumns = [];
      while (lines[nextLineIndex]?.trim().startsWith('_entity_poly.')) {
        isEntityPolyLoop = true;
        tempColumns.push(lines[nextLineIndex]?.trim() ?? '');
        nextLineIndex++;
      }

      if (isEntityPolyLoop) {
        inTargetLoop = true;
        columns.push(...tempColumns);
        dataStartIndex = nextLineIndex;
        break;
      }
    }
  }

  if (!inTargetLoop || dataStartIndex === -1) return [];

  const idIndex = columns.indexOf('_entity_poly.pdbx_strand_id');
  const typeIndex = columns.indexOf('_entity_poly.type');
  const seqIndex = columns.indexOf('_entity_poly.pdbx_seq_one_letter_code');

  if (idIndex === -1 || typeIndex === -1) return [];

  const rowData: string[] = [];
  for (let i = dataStartIndex; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (
      !line ||
      line.startsWith('#') ||
      line.startsWith('loop_') ||
      line.startsWith('_')
    ) {
      if (rowData.length > 0) processRow();
      break;
    }

    if (line.startsWith(';')) {
      let sequence = line.slice(1);
      i++;
      while (i < lines.length && !lines[i]?.startsWith(';')) {
        const currentLine = lines[i];
        if (currentLine !== undefined) {
          sequence += currentLine.trim();
        }
        i++;
      }
      if (i < lines.length) {
        sequence += lines[i]?.slice(0, -1).trimEnd();
      }
      rowData.push(sequence);
    } else {
      rowData.push(...(line.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []));
    }

    if (rowData.length >= columns.length) {
      processRow();
    }
  }
  if (rowData.length >= columns.length) processRow();

  function processRow() {
    const row = rowData.splice(0, columns.length);
    const ids = (row[idIndex] ?? '').replace(/['"]/g, '').split(',');
    const type = (row[typeIndex] ?? '').replace(/['"]/g, '');
    let sequence = '';
    if (seqIndex > -1 && row[seqIndex]) {
      sequence = (row[seqIndex] ?? '').replace(/[;'"\s]/g, '');
    }

    for (const id of ids) {
      if (id && type) {
        chains.push({
          id,
          type: mapCifTypeToChainType(type),
          sequence,
          length: sequence.length,
        });
      }
    }
  }

  return chains;
}

/**
 * Fetch structure file from RCSB in specified format
 */
export async function fetchStructureFile(
  pdbId: string,
  format: StructureFormat,
  context: RequestContext,
): Promise<ProteinStructure['structure']> {
  // BinaryCIF uses a different URL
  let url: string;
  if (format === StructureFormat.BCIF) {
    url = `${RCSB_BCIF_URL}/${pdbId}.bcif`;
  } else {
    const extension = format === StructureFormat.MMCIF ? 'cif' : format;
    url = `${RCSB_FILES_URL}/${pdbId}.${extension}`;
  }

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

  // BinaryCIF is binary data, others are text
  const data =
    format === StructureFormat.BCIF
      ? await response.arrayBuffer()
      : await response.text();

  let chains: ProteinStructure['structure']['chains'] = [];
  if (format === StructureFormat.MMCIF && typeof data === 'string') {
    try {
      chains = parseChainsFromCif(data);
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      logger.error('Failed to parse CIF file', {
        ...context,
        pdbId,
        error: errorMessage,
      });
    }
  }

  return {
    format,
    data,
    chains,
  };
}
