/**
 * @fileoverview Barrel export for protein service domain.
 * @module src/services/protein/index
 */

// Core
export type { IProteinProvider } from './core/IProteinProvider.js';
export { ProteinService } from './core/ProteinService.js';

// Providers
export { RcsbProteinProvider } from './providers/rcsb/index.js';
export { PdbeProteinProvider } from './providers/pdbe/index.js';
export { UniProtProvider } from './providers/uniprot/index.js';

// Types
export type * from './types.js';
