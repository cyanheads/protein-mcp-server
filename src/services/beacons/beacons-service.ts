/**
 * @fileoverview 3D-Beacons service — wraps the EMBL-EBI federated structure API
 * (`/uniprot/summary/{accession}.json`), which fronts experimental (PDBe) and
 * predicted (AlphaFold DB, AlphaFill, SWISS-MODEL, BFVD, …) models behind one
 * UniProt-keyed interface. Backs the predicted half of `protein_search_structures`
 * and `best_available` resolution in `protein_get_structure`. A 404 returns an
 * empty object upstream — treated as "no models", distinct from a transport error.
 * @module services/beacons/beacons-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import type { ServerConfig } from '@/config/server-config.js';
import { fetchResponse, parseJson } from '../shared/http.js';

/** A single federated model summary. */
export interface BeaconModel {
  /** Average local confidence score (predicted models only). */
  confidenceAvgLocalScore?: number;
  /** Confidence metric type (e.g. "pLDDT", "QMEANDisCo") when present. */
  confidenceType?: string;
  /** UniProt residue coverage fraction (0–1) the model spans. */
  coverage?: number;
  /** Experimental method (experimental models only). */
  experimentalMethod?: string;
  /** `EXPERIMENTALLY DETERMINED`, `AB-INITIO`, `TEMPLATE-BASED`, … */
  modelCategory?: string;
  /** Provider model identifier. */
  modelIdentifier: string;
  /** Coordinate file URL. */
  modelUrl?: string;
  /** Originating provider (e.g. "AlphaFold DB", "PDBe", "SWISS-MODEL"). */
  provider?: string;
  /** Resolution in Å (experimental models only). */
  resolution?: number;
}

/** A UniProt accession's federated model set. */
export interface BeaconSummary {
  /** The queried UniProt accession. */
  accession: string;
  /** Whether the upstream returned any entry at all. */
  found: boolean;
  /** Federated models, experimental and predicted. */
  models: BeaconModel[];
}

interface RawSummary {
  structures?: Array<{ summary?: RawModelSummary }>;
  uniprot_entry?: { ac?: string };
}

interface RawModelSummary {
  confidence_avg_local_score?: number;
  confidence_type?: string;
  coverage?: number;
  experimental_method?: string;
  model_category?: string;
  model_identifier?: string;
  model_url?: string;
  provider?: string;
  resolution?: number;
}

export class BeaconsService {
  private readonly baseUrl: string;

  constructor(_config: AppConfig, _storage: StorageService, serverConfig: ServerConfig) {
    this.baseUrl = serverConfig.beaconsBaseUrl;
  }

  /** Fetch the federated model summary for a UniProt accession. */
  async getSummary(accession: string, ctx: Context): Promise<BeaconSummary> {
    const acc = accession.toUpperCase();
    const url = `${this.baseUrl}/uniprot/summary/${encodeURIComponent(acc)}.json`;
    const res = await fetchResponse(url, ctx, {
      operation: 'BeaconsService.getSummary',
      baseDelayMs: 500,
    });
    if (res.status === 404) return { accession: acc, found: false, models: [] };
    if (!res.ok) {
      // Surface non-404 failures via the framework's status mapping by re-reading the body.
      throw new Error(`3D-Beacons returned HTTP ${res.status} for ${acc}`);
    }
    const text = await res.text();
    const raw = parseJson<RawSummary>(text, '3D-Beacons');
    const models = (raw.structures ?? [])
      .map((s) => s.summary)
      .filter((s): s is RawModelSummary => s != null && !!s.model_identifier)
      .map(normalizeModel);
    return { accession: raw.uniprot_entry?.ac ?? acc, found: models.length > 0, models };
  }
}

function normalizeModel(raw: RawModelSummary): BeaconModel {
  return {
    modelIdentifier: raw.model_identifier as string,
    ...(raw.model_category ? { modelCategory: raw.model_category } : {}),
    ...(raw.provider ? { provider: raw.provider } : {}),
    ...(raw.model_url ? { modelUrl: raw.model_url } : {}),
    ...(typeof raw.coverage === 'number' ? { coverage: raw.coverage } : {}),
    ...(typeof raw.resolution === 'number' ? { resolution: raw.resolution } : {}),
    ...(raw.experimental_method ? { experimentalMethod: raw.experimental_method } : {}),
    ...(raw.confidence_type ? { confidenceType: raw.confidence_type } : {}),
    ...(typeof raw.confidence_avg_local_score === 'number'
      ? { confidenceAvgLocalScore: raw.confidence_avg_local_score }
      : {}),
  };
}

let _service: BeaconsService | undefined;

export function initBeaconsService(
  config: AppConfig,
  storage: StorageService,
  serverConfig: ServerConfig,
): void {
  _service = new BeaconsService(config, storage, serverConfig);
}

export function getBeaconsService(): BeaconsService {
  if (!_service)
    throw new Error('BeaconsService not initialized — call initBeaconsService() in setup()');
  return _service;
}
