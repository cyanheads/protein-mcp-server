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
  instructions:
    'protein-mcp-server federates experimental (PDB) and predicted (AlphaFold) protein structures: search structures by text, sequence, or organism/method/resolution (protein_search_structures); fetch metadata and coordinate URLs for PDB IDs or UniProt accessions (protein_get_structure); find sequence or fold homologs via mmseqs2 or Foldseek (protein_find_similar); resolve ligands and map binding-site residues (protein_track_ligands); align 2–10 structures with TM-align or jFATCAT (protein_compare_structures); profile the PDB with server-side facet distributions and trends (protein_analyze_collection); and pull UniProt features plus InterPro domains and GO terms (protein_get_annotations).',
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
