/**
 * @fileoverview PDBe service — wraps PDBe's SIFTS best-structures mapping
 * (`/mappings/best_structures/{accession}`), which lists every PDB chain SIFTS
 * maps to a UniProt accession with its coverage, resolution, and UniProt span.
 * Backs the PDB check behind `best_available` in `protein_get_structure` when the
 * 3D-Beacons federated summary carries no PDBe model. A 404 means PDBe maps no
 * PDB entry to the accession, distinct from a transport error.
 * @module services/pdbe/pdbe-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { serializationError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { httpErrorFromResponse } from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';
import type { BeaconModel } from '../beacons/beacons-service.js';
import { fetchResponse, parseJson } from '../shared/http.js';

/**
 * One attempt, bounded at 15 s including the body read. The check corrects a
 * pick already in hand, so a hung request must give that pick back with its
 * notice while the call budget still has room, not run the budget out. SIFTS
 * answered 14 accessions in 0.6–6.8 s, the slowest P0DTD1's 1.29 MB, so 15 s
 * leaves twice the slowest. There is no retry: `fetchResponse` retries its own
 * timeout along with network errors, so one would double a hang to ~30 s on top
 * of the 3D-Beacons requests made before the check.
 */
const CHECK_TIMEOUT_MS = 15_000;

/** One SIFTS chain mapping. `resolution` is `null` for an NMR entry. */
interface RawMapping {
  coverage?: number;
  experimental_method?: string;
  pdb_id?: string;
  resolution?: number | null;
  unp_end?: number;
  unp_start?: number;
}

export class PdbeService {
  private readonly baseUrl: string;

  constructor(_config: AppConfig, _storage: StorageService, serverConfig: ServerConfig) {
    this.baseUrl = serverConfig.pdbeApiBaseUrl;
  }

  /**
   * The PDB chains SIFTS maps to `accession`, as PDBe models in the shape
   * best_available ranks: one per chain row, the experimental method uppercased
   * to the RCSB vocabulary (`X-RAY DIFFRACTION`). Empty on a 404, PDBe's answer
   * for an accession it maps no PDB entry to. Throws on any other non-2xx, an
   * HTML or empty body, unparseable JSON, a body without the accession's rows,
   * a network failure, or a `TimeoutError` once {@link CHECK_TIMEOUT_MS} passes;
   * none of them is retried.
   */
  async getBestStructures(accession: string, ctx: Context): Promise<BeaconModel[]> {
    const acc = accession.toUpperCase();
    const res = await fetchResponse(
      `${this.baseUrl}/mappings/best_structures/${encodeURIComponent(acc)}`,
      ctx,
      { operation: 'PdbeService.getBestStructures', timeoutMs: CHECK_TIMEOUT_MS, maxRetries: 0 },
    );
    if (res.status === 404) return [];
    if (!res.ok) throw await httpErrorFromResponse(res, { service: 'PDBe' });
    const raw = parseJson<Record<string, RawMapping[] | undefined>>(await res.text(), 'PDBe');
    const rows = raw[acc];
    if (!Array.isArray(rows)) {
      throw serializationError(`PDBe's best_structures answer for ${acc} carries no mapping list.`);
    }
    return rows.filter((r): r is RawMapping & { pdb_id: string } => !!r.pdb_id).map(toPdbeModel);
  }
}

function toPdbeModel(raw: RawMapping & { pdb_id: string }): BeaconModel {
  return {
    modelIdentifier: raw.pdb_id,
    provider: 'PDBe',
    ...(typeof raw.coverage === 'number' ? { coverage: raw.coverage } : {}),
    ...(typeof raw.unp_start === 'number' ? { uniprotStart: raw.unp_start } : {}),
    ...(typeof raw.unp_end === 'number' ? { uniprotEnd: raw.unp_end } : {}),
    ...(typeof raw.resolution === 'number' ? { resolution: raw.resolution } : {}),
    ...(raw.experimental_method
      ? { experimentalMethod: raw.experimental_method.toUpperCase() }
      : {}),
  };
}

let _service: PdbeService | undefined;

export function initPdbeService(
  config: AppConfig,
  storage: StorageService,
  serverConfig: ServerConfig,
): void {
  _service = new PdbeService(config, storage, serverConfig);
}

export function getPdbeService(): PdbeService {
  if (!_service) throw new Error('PdbeService not initialized — call initPdbeService() in setup()');
  return _service;
}
