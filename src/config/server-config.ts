/**
 * @fileoverview Server-specific configuration parsed from environment variables.
 * Every value is optional with a public-endpoint default — the server runs out
 * of the box with no env file. No API keys: all upstreams are keyless.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  rcsbSearchBaseUrl: z
    .string()
    .url()
    .default('https://search.rcsb.org')
    .describe('Base URL for the RCSB Search API v2.'),
  rcsbDataBaseUrl: z
    .string()
    .url()
    .default('https://data.rcsb.org')
    .describe('Base URL for the RCSB Data API (REST + GraphQL).'),
  rcsbFilesBaseUrl: z
    .string()
    .url()
    .default('https://files.rcsb.org')
    .describe('Base URL for RCSB coordinate-file downloads.'),
  rcsbAlignmentBaseUrl: z
    .string()
    .url()
    .default('https://alignment.rcsb.org')
    .describe('Base URL for the RCSB Structural Comparison (alignment) service.'),
  beaconsBaseUrl: z
    .string()
    .url()
    .default('https://www.ebi.ac.uk/pdbe/pdbe-kb/3dbeacons/api')
    .describe('Base URL for the 3D-Beacons federated structure API.'),
  alphafoldBaseUrl: z
    .string()
    .url()
    .default('https://alphafold.ebi.ac.uk')
    .describe('Base URL for the AlphaFold Protein Structure Database API.'),
  foldseekBaseUrl: z
    .string()
    .url()
    .default('https://search.foldseek.com')
    .describe('Base URL for the Foldseek structural-similarity search service.'),
  uniprotBaseUrl: z
    .string()
    .url()
    .default('https://rest.uniprot.org')
    .describe('Base URL for the UniProt REST API.'),
  interproBaseUrl: z
    .string()
    .url()
    .default('https://www.ebi.ac.uk/interpro/api')
    .describe('Base URL for the InterPro REST API.'),
  asyncPollTimeoutMs: z.coerce
    .number()
    .int()
    .min(1000)
    .default(30_000)
    .describe(
      'Max wall-clock to poll an async job (alignment / Foldseek) before returning a "still computing" result.',
    ),
  maxBatchIds: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(25)
    .describe('Cap on the number of IDs accepted by protein_get_structure in one batch.'),
  maxCompareStructures: z.coerce
    .number()
    .int()
    .min(2)
    .max(25)
    .default(10)
    .describe('Cap on structures per protein_compare_structures call (bounds pairwise fan-out).'),
  facetBucketCap: z.coerce
    .number()
    .int()
    .min(1)
    .max(500)
    .default(50)
    .describe('Default cap on buckets returned per protein_analyze_collection dimension.'),
  fanoutConcurrency: z.coerce
    .number()
    .int()
    .min(1)
    .max(16)
    .default(5)
    .describe('Max concurrent upstream requests for per-ID / per-pair fan-out.'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    rcsbSearchBaseUrl: 'RCSB_SEARCH_BASE_URL',
    rcsbDataBaseUrl: 'RCSB_DATA_BASE_URL',
    rcsbFilesBaseUrl: 'RCSB_FILES_BASE_URL',
    rcsbAlignmentBaseUrl: 'RCSB_ALIGNMENT_BASE_URL',
    beaconsBaseUrl: 'BEACONS_BASE_URL',
    alphafoldBaseUrl: 'ALPHAFOLD_BASE_URL',
    foldseekBaseUrl: 'FOLDSEEK_BASE_URL',
    uniprotBaseUrl: 'UNIPROT_BASE_URL',
    interproBaseUrl: 'INTERPRO_BASE_URL',
    asyncPollTimeoutMs: 'PROTEIN_ASYNC_POLL_TIMEOUT_MS',
    maxBatchIds: 'PROTEIN_MAX_BATCH_IDS',
    maxCompareStructures: 'PROTEIN_MAX_COMPARE_STRUCTURES',
    facetBucketCap: 'PROTEIN_FACET_BUCKET_CAP',
    fanoutConcurrency: 'PROTEIN_FANOUT_CONCURRENCY',
  });
  return _config;
}
