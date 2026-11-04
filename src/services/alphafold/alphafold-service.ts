/**
 * @fileoverview AlphaFold service — wraps the AlphaFold Protein Structure
 * Database API (`/api/prediction/{accession}`). Kept as a direct provider (not
 * only via 3D-Beacons) because it carries confidence detail the Beacons summary
 * abbreviates: mean pLDDT, the four confidence-bucket fractions, and the PAE
 * documentation URL. Serves canonical and isoform models. Backs
 * `protein_get_structure` (predicted, and the coordinate URLs of an AlphaFold
 * computed model under experimental), `protein_find_similar` (`by: structure`,
 * through `findPrediction`), and the `af://` resource; `findPrediction` adds
 * UniProt's accession verdict after a miss.
 * @module services/alphafold/alphafold-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import type { ServerConfig } from '@/config/server-config.js';
import { fetchJson } from '../shared/http.js';
import { accessionOfAlphaFoldEntryId, isAlphaFoldEntryId } from '../shared/identifiers.js';
import { type AccessionStatus, getUniProtService } from '../uniprot/uniprot-service.js';

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
   * Fetch the AlphaFold prediction for a UniProt accession (canonical or
   * isoform) or an AlphaFold DB entry ID. Returns the record keyed to the
   * request — by `uniprotAccession`, or by `entryId` for an entry-ID request —
   * because a canonical lookup also lists every isoform model, in an order
   * AlphaFold DB does not document. `null` when no model exists (404) or no
   * record matches; a malformed identifier (400) bubbles as `InvalidParams`.
   */
  async getPrediction(id: string, ctx: Context): Promise<AlphaFoldModel | null> {
    const requested = id.toUpperCase();
    const url = `${this.baseUrl}/api/prediction/${encodeURIComponent(requested)}`;
    let raw: RawPrediction[];
    try {
      raw = await fetchJson<RawPrediction[]>(url, ctx, {
        operation: 'AlphaFoldService.getPrediction',
        label: 'AlphaFold DB',
        baseDelayMs: 300,
        expectedStatuses: [404],
      });
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) return null;
      throw err;
    }
    const byEntryId = isAlphaFoldEntryId(requested);
    const match = raw.find(
      (r) => (byEntryId ? r.entryId : r.uniprotAccession)?.toUpperCase() === requested,
    );
    if (!match) return null;
    return normalizePrediction(
      byEntryId ? accessionOfAlphaFoldEntryId(requested) : requested,
      match,
    );
  }

  /**
   * The prediction for a UniProt accession or AlphaFold DB entry ID, asking
   * UniProt (through `getUniProtService()`) only after AlphaFold DB has no model
   * for it: a merged accession is followed to its successor's model, and any
   * other verdict comes back as `missed` for the caller to report — a per-ID row,
   * or a typed failure via `inactiveAccessionError`. A model AlphaFold DB holds
   * under the requested key costs no UniProt request.
   */
  async findPrediction(id: string, ctx: Context): Promise<PredictionLookup> {
    const model = await this.getPrediction(id, ctx);
    if (model) return { kind: 'found', model };
    const accession = isAlphaFoldEntryId(id) ? accessionOfAlphaFoldEntryId(id) : id.toUpperCase();
    const uniprot = await getUniProtService().resolveAccession(accession, ctx);
    if (uniprot.kind !== 'merged') return { kind: 'missed', uniprot };
    const successorModel = await this.getPrediction(uniprot.successor, ctx);
    return successorModel
      ? { kind: 'found', model: successorModel, mergedFrom: accession }
      : { kind: 'missed', uniprot };
  }
}

/**
 * What a predicted-model lookup found:
 * - `found` — the model; `mergedFrom` is the requested accession when UniProt
 *   merged it into the accession the model predicts;
 * - `missed` — no model, with UniProt's verdict on the accession (`active` with
 *   no model, `merged` whose successor has none either, `inactive`, `unknown`).
 */
export type PredictionLookup =
  | { kind: 'found'; model: AlphaFoldModel; mergedFrom?: string }
  | { kind: 'missed'; uniprot: AccessionStatus };

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
