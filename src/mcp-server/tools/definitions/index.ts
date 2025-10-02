/**
 * @fileoverview Barrel file for all tool definitions.
 * This file re-exports all tool definitions for easy import and registration.
 * It also exports an array of all definitions for automated registration.
 * @module src/mcp-server/tools/definitions
 */

import { proteinAnalyzeCollectionTool } from './protein-analyze-collection.tool.js';
import { proteinCompareStructuresTool } from './protein-compare-structures.tool.js';
import { proteinFindSimilarTool } from './protein-find-similar.tool.js';
import { proteinGetStructureTool } from './protein-get-structure.tool.js';
import { proteinSearchStructuresTool } from './protein-search-structures.tool.js';
import { proteinTrackLigandsTool } from './protein-track-ligands.tool.js';

/**
 * An array containing all tool definitions for easy iteration.
 */
export const allToolDefinitions = [
  // Protein structure tools
  proteinSearchStructuresTool,
  proteinGetStructureTool,
  proteinCompareStructuresTool,
  proteinFindSimilarTool,
  proteinTrackLigandsTool,
  proteinAnalyzeCollectionTool,
];
