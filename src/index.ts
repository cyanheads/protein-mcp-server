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
    'protein-mcp-server — federated protein structure & function research over experimental (PDB) and ' +
    'predicted (AlphaFold) structures. No API keys required.\n' +
    '- protein_search_structures: find structures by text, sequence, or organism/method/resolution; optional facet breakdown\n' +
    '- protein_get_structure: fetch metadata + coordinate URLs for PDB IDs or UniProt accessions (batch, partial success)\n' +
    '- protein_find_similar: sequence (mmseqs2) or structure (Foldseek) similarity search\n' +
    '- protein_track_ligands: resolve ligands, find structures containing them, or map binding-site residues\n' +
    '- protein_compare_structures: pairwise TM-align / jFATCAT over 2–10 structures\n' +
    '- protein_analyze_collection: server-side facet distributions and trends over the PDB\n' +
    '- protein_get_annotations: UniProt features + InterPro domains/GO terms',
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
