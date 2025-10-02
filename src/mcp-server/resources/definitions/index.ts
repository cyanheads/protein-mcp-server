/**
 * @fileoverview Barrel file for all resource definitions.
 * Re-exports all resource definitions and provides an array for easy iteration.
 * @module src/mcp-server/resources/definitions
 */

import { proteinSearchResource } from './protein-search.resource.js';
import { proteinStructureResource } from './protein-structure.resource.js';

/**
 * An array containing all resource definitions for easy iteration.
 * This is used by the registration system to automatically discover and register
 * all available resources.
 */
export const allResourceDefinitions = [
  // Protein resources
  proteinStructureResource,
  proteinSearchResource,
];
