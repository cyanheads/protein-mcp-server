#!/usr/bin/env node
/**
 * @fileoverview protein-mcp-server MCP server entry point. Federates experimental
 * (PDB) and predicted (AlphaFold / 3D-Beacons) protein structures behind one tool
 * surface; initializes the six upstream services in setup().
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { afSummaryResource, pdbSummaryResource } from './mcp-server/resources/definitions/index.js';
import {
  analyzeCollection,
  compareStructures,
  findSimilar,
  getAnnotations,
  getStructure,
  searchStructures,
  trackLigands,
} from './mcp-server/tools/definitions/index.js';
import { initAlignmentService } from './services/alignment/alignment-service.js';
import { initAlphaFoldService } from './services/alphafold/alphafold-service.js';
import { initBeaconsService } from './services/beacons/beacons-service.js';
import { initFoldseekService } from './services/foldseek/foldseek-service.js';
import { initRcsbService } from './services/rcsb/rcsb-service.js';
import { initUniProtService } from './services/uniprot/uniprot-service.js';

await createApp({
  name: 'protein-mcp-server',
  title: 'protein-mcp-server',
  tools: [
    searchStructures,
    getStructure,
    findSimilar,
    trackLigands,
    compareStructures,
    analyzeCollection,
    getAnnotations,
  ],
  resources: [pdbSummaryResource, afSummaryResource],
  prompts: [],
  // Public, keyless data server — serve the full inventory to unauthenticated callers.
  landing: { requireAuth: false },
  // No tool gates on ctx.requestInput, so HTTP serving needs no live session.
  sessionMode: 'stateless',
  /**
   * Cache hints for protocol revision 2026-07-28. Every listing is static per
   * build and identical for every caller — no auth-gated definitions, no
   * per-tenant filtering — so a shared cache may hold them. `resources/read`
   * serves PDB and AlphaFold summaries, whose upstreams publish on a weekly
   * (PDB) and per-release (AlphaFold) cadence; an hour of staleness sits well
   * inside both. 2025-era responses are unaffected either way.
   */
  cacheHints: {
    'tools/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'resources/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'resources/templates/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'server/discover': { ttlMs: 3_600_000, cacheScope: 'public' },
    'resources/read': { ttlMs: 3_600_000, cacheScope: 'public' },
  },
  instructions:
    'Find structures with protein_search_structures, then pass the returned IDs to protein_get_structure for metadata and coordinate URLs, or pass UniProt accessions there for AlphaFold predictions and the best available model. A PDB ID also chains into protein_get_annotations, protein_track_ligands, protein_find_similar, and protein_compare_structures for annotations, binding sites, homologs, and structural alignment, while protein_analyze_collection profiles the whole PDB without pulling rows. A Foldseek search or structural alignment still running when the poll budget elapses returns status "computing" with a ticket (protein_find_similar) or a job UUID (protein_compare_structures); re-call with it to resume that job rather than resubmitting.',
  setup(core) {
    const serverConfig = getServerConfig();
    initRcsbService(core.config, core.storage, serverConfig);
    initAlphaFoldService(core.config, core.storage, serverConfig);
    initBeaconsService(core.config, core.storage, serverConfig);
    initUniProtService(core.config, core.storage, serverConfig);
    initAlignmentService(core.config, core.storage, serverConfig);
    initFoldseekService(core.config, core.storage, serverConfig);
  },
});
