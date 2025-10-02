/**
 * @fileoverview Barrel export for protein service domain.
 * @module src/services/protein/index
 */

// Core
export type { IProteinProvider } from './core/IProteinProvider.js';
export {
  ProteinService,
  ProteinProviderPrimary,
  ProteinProviderFallback,
} from './core/ProteinService.js';

// Providers
export { RcsbProteinProvider } from './providers/rcsb.provider.js';
export { PdbeProteinProvider } from './providers/pdbe.provider.js';
export { UniProtProvider } from './providers/uniprot.provider.js';

// Types
export type * from './types.js';
