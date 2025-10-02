/**
 * @fileoverview RCSB PDB API configuration constants.
 * @module src/services/protein/providers/rcsb/config
 */

/**
 * RCSB PDB API base URL
 */
export const RCSB_BASE_URL = 'https://data.rcsb.org';

/**
 * RCSB GraphQL API endpoint
 */
export const RCSB_GRAPHQL_URL = 'https://data.rcsb.org/graphql';

/**
 * RCSB Search API endpoint
 */
export const RCSB_SEARCH_URL = 'https://search.rcsb.org/rcsbsearch/v2/query';

/**
 * RCSB Files download URL
 */
export const RCSB_FILES_URL = 'https://files.rcsb.org/download';

/**
 * Default request timeout in milliseconds
 */
export const REQUEST_TIMEOUT = 30000; // 30 seconds
