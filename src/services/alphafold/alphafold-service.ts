/**
 * @fileoverview AlphaFold service — wraps the AlphaFold Protein Structure
 * Database API (`/api/prediction/{accession}`). Kept as a direct provider (not
 * only via 3D-Beacons) because it carries confidence detail the Beacons summary
 * abbreviates: mean pLDDT, the four confidence-bucket fractions, and the PAE
 * documentation URL. Backs `protein_get_structure` (predicted) and the `af://`
 * resource.
 * @module services/alphafold/alphafold-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import type { ServerConfig } from '@/config/server-config.js';
import { fetchJson } from '../shared/http.js';

/** Fractions of residues in each pLDDT confidence band (0–1). */
export interface ConfidenceBuckets {
  confident: number;
  low: number;
  veryHigh: number;
  veryLow: number;
}

/** A normalized AlphaFold prediction. */
export interface AlphaFoldModel {
  bcifUrl?: string;
  /** Coordinate / metadata URLs. */
  cifUrl?: string;
  /** Residue fractions in each confidence band. */
  confidenceBuckets?: ConfidenceBuckets;
  /** AlphaFold model entry ID (e.g. `AF-P69905-F1`). */
  entryId?: string;
  /** Mean pLDDT across the model (0–100). */
  meanPlddt?: number;
  /** Model version (latest). */
  modelVersion?: number;
  /** Source organism scientific name. */
  organism?: string;
  paeDocUrl?: string;
  paeImageUrl?: string;
  pdbUrl?: string;
  /** Predicted sequence length. */
  sequenceLength?: number;
  /** UniProt accession the model predicts. */
  uniprotAccession: string;
  /** UniProt protein description. */
  uniprotDescription?: string;
}

interface RawPrediction {
  bcifUrl?: string;
  cifUrl?: string;
  entryId?: string;
  fractionPlddtConfident?: number;
  fractionPlddtLow?: number;
  fractionPlddtVeryHigh?: number;
  fractionPlddtVeryLow?: number;
  globalMetricValue?: number;
  latestVersion?: number;
  organismScientificName?: string;
  paeDocUrl?: string;
  paeImageUrl?: string;
  pdbUrl?: string;
  uniprotAccession?: string;
  uniprotDescription?: string;
  uniprotSequence?: string;
}

export class AlphaFoldService {
  private readonly baseUrl: string;

  constructor(_config: AppConfig, _storage: StorageService, serverConfig: ServerConfig) {
    this.baseUrl = serverConfig.alphafoldBaseUrl;
  }

  /**
   * Fetch the AlphaFold prediction for a UniProt accession. Returns `null` when
   * no model exists (404); a malformed accession (400) bubbles as `InvalidParams`.
   */
  async getPrediction(accession: string, ctx: Context): Promise<AlphaFoldModel | null> {
    const url = `${this.baseUrl}/api/prediction/${encodeURIComponent(accession.toUpperCase())}`;
    let raw: RawPrediction[];
    try {
      raw = await fetchJson<RawPrediction[]>(url, ctx, {
        operation: 'AlphaFoldService.getPrediction',
        label: 'AlphaFold DB',
        baseDelayMs: 300,
      });
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) return null;
      throw err;
    }
    const first = raw[0];
    if (!first) return null;
    return normalizePrediction(accession.toUpperCase(), first);
  }
}

function normalizePrediction(accession: string, raw: RawPrediction): AlphaFoldModel {
  const buckets = confidenceBuckets(raw);
  return {
    uniprotAccession: raw.uniprotAccession ?? accession,
    ...(raw.entryId ? { entryId: raw.entryId } : {}),
    ...(typeof raw.globalMetricValue === 'number' ? { meanPlddt: raw.globalMetricValue } : {}),
    ...(buckets ? { confidenceBuckets: buckets } : {}),
    ...(raw.cifUrl ? { cifUrl: raw.cifUrl } : {}),
    ...(raw.pdbUrl ? { pdbUrl: raw.pdbUrl } : {}),
    ...(raw.bcifUrl ? { bcifUrl: raw.bcifUrl } : {}),
    ...(raw.paeImageUrl ? { paeImageUrl: raw.paeImageUrl } : {}),
    ...(raw.paeDocUrl ? { paeDocUrl: raw.paeDocUrl } : {}),
    ...(typeof raw.latestVersion === 'number' ? { modelVersion: raw.latestVersion } : {}),
    ...(raw.organismScientificName ? { organism: raw.organismScientificName } : {}),
    ...(raw.uniprotDescription ? { uniprotDescription: raw.uniprotDescription } : {}),
    ...(raw.uniprotSequence ? { sequenceLength: raw.uniprotSequence.length } : {}),
  };
}

function confidenceBuckets(raw: RawPrediction): ConfidenceBuckets | undefined {
  const { fractionPlddtVeryLow, fractionPlddtLow, fractionPlddtConfident, fractionPlddtVeryHigh } =
    raw;
  if (
    typeof fractionPlddtVeryLow !== 'number' &&
    typeof fractionPlddtLow !== 'number' &&
    typeof fractionPlddtConfident !== 'number' &&
    typeof fractionPlddtVeryHigh !== 'number'
  ) {
    return;
  }
  return {
    veryLow: fractionPlddtVeryLow ?? 0,
    low: fractionPlddtLow ?? 0,
    confident: fractionPlddtConfident ?? 0,
    veryHigh: fractionPlddtVeryHigh ?? 0,
  };
}

let _service: AlphaFoldService | undefined;

export function initAlphaFoldService(
  config: AppConfig,
  storage: StorageService,
  serverConfig: ServerConfig,
): void {
  _service = new AlphaFoldService(config, storage, serverConfig);
}

export function getAlphaFoldService(): AlphaFoldService {
  if (!_service)
    throw new Error('AlphaFoldService not initialized — call initAlphaFoldService() in setup()');
  return _service;
}
