/**
 * @fileoverview Tests for the server config schema: out-of-the-box public-endpoint
 * defaults, env-var overrides mapped to the documented names, numeric coercion +
 * bounds, and URL validation. Each case re-imports the module after resetModules()
 * so the memoized singleton doesn't leak across cases.
 * @module tests/config/server-config.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Fresh import so the module-level `_config ??=` memo doesn't carry across cases. */
async function loadConfig() {
  vi.resetModules();
  const mod = await import('@/config/server-config.js');
  return mod.getServerConfig();
}

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

describe('getServerConfig — defaults', () => {
  it('runs with no env file: public-endpoint defaults for every upstream', async () => {
    const cfg = await loadConfig();
    expect(cfg).toMatchObject({
      rcsbSearchBaseUrl: 'https://search.rcsb.org',
      rcsbDataBaseUrl: 'https://data.rcsb.org',
      rcsbFilesBaseUrl: 'https://files.rcsb.org',
      rcsbAlignmentBaseUrl: 'https://alignment.rcsb.org',
      beaconsBaseUrl: 'https://www.ebi.ac.uk/pdbe/pdbe-kb/3dbeacons/api',
      alphafoldBaseUrl: 'https://alphafold.ebi.ac.uk',
      foldseekBaseUrl: 'https://search.foldseek.com',
      uniprotBaseUrl: 'https://rest.uniprot.org',
      interproBaseUrl: 'https://www.ebi.ac.uk/interpro/api',
    });
  });

  it('applies the documented numeric defaults and caps', async () => {
    const cfg = await loadConfig();
    expect(cfg).toMatchObject({
      asyncPollTimeoutMs: 30_000,
      maxBatchIds: 25,
      maxCompareStructures: 10,
      facetBucketCap: 50,
      fanoutConcurrency: 5,
    });
  });

  it('memoizes — repeated calls return the same instance', async () => {
    vi.resetModules();
    const mod = await import('@/config/server-config.js');
    expect(mod.getServerConfig()).toBe(mod.getServerConfig());
  });
});

describe('getServerConfig — overrides', () => {
  it('honors a base-URL override via its mapped env var', async () => {
    vi.stubEnv('RCSB_SEARCH_BASE_URL', 'https://search.mirror.internal');
    const cfg = await loadConfig();
    expect(cfg.rcsbSearchBaseUrl).toBe('https://search.mirror.internal');
    // Unset vars keep their defaults.
    expect(cfg.alphafoldBaseUrl).toBe('https://alphafold.ebi.ac.uk');
  });

  it('coerces numeric env strings to numbers', async () => {
    vi.stubEnv('PROTEIN_MAX_BATCH_IDS', '50');
    vi.stubEnv('PROTEIN_ASYNC_POLL_TIMEOUT_MS', '60000');
    const cfg = await loadConfig();
    expect(cfg.maxBatchIds).toBe(50);
    expect(cfg.asyncPollTimeoutMs).toBe(60_000);
  });
});

describe('getServerConfig — validation', () => {
  it('rejects a non-URL base URL, naming the env var', async () => {
    vi.stubEnv('UNIPROT_BASE_URL', 'not-a-url');
    await expect(loadConfig()).rejects.toThrow(/UNIPROT_BASE_URL/);
  });

  it('rejects a batch cap above the max bound', async () => {
    vi.stubEnv('PROTEIN_MAX_BATCH_IDS', '500'); // schema max is 100
    await expect(loadConfig()).rejects.toThrow(/PROTEIN_MAX_BATCH_IDS/);
  });

  it('rejects a sub-minimum compare cap', async () => {
    vi.stubEnv('PROTEIN_MAX_COMPARE_STRUCTURES', '1'); // schema min is 2
    await expect(loadConfig()).rejects.toThrow(/PROTEIN_MAX_COMPARE_STRUCTURES/);
  });
});
