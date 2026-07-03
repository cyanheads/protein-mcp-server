/**
 * @fileoverview Tests for protein_search_structures: the no-criteria guard,
 * computed-model (AlphaFold) ID parsing into a UniProt accession, experimental
 * metadata enrichment, and the total/echo/empty-notice enrichment. RCSB mocked.
 * @module tests/tools/search-structures.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const search = vi.fn();
const getEntries = vi.fn();
vi.mock('@/services/rcsb/rcsb-service.js', () => ({
  getRcsbService: () => ({ search, getEntries }),
}));

import { getServerConfig } from '@/config/server-config.js';
import { searchStructures } from '@/mcp-server/tools/definitions/search-structures.tool.js';

const ctx = () => createMockContext({ errors: searchStructures.errors });
const FACET_CAP = getServerConfig().facetBucketCap;

beforeEach(() => vi.clearAllMocks());

describe('protein_search_structures', () => {
  it('throws no_criteria (with its declared recovery hint) when nothing to search on', async () => {
    const input = searchStructures.input.parse({});
    await expect(searchStructures.handler(input, ctx())).rejects.toMatchObject({
      data: {
        reason: 'no_criteria',
        recovery: { hint: expect.stringContaining('free-text query') },
      },
    });
  });

  it('marks nested cross-tab child dimensions as truncated in the shared facet projection (#13)', async () => {
    // Simulate a nested facet from upstream whose child list exceeds the bucket cap.
    const childBuckets = Array.from({ length: FACET_CAP + 3 }, (_, i) => ({
      label: String(2000 + i),
      count: FACET_CAP + 3 - i,
    }));
    search.mockResolvedValue({
      total: 500,
      hits: [],
      facets: [
        {
          dimension: 'method',
          attribute: 'exptl.method',
          buckets: [
            {
              label: 'X-RAY DIFFRACTION',
              count: 400,
              children: [
                {
                  dimension: 'release_year',
                  attribute: 'rcsb_accession_info.initial_release_date',
                  buckets: childBuckets,
                },
              ],
            },
          ],
        },
      ],
    });
    getEntries.mockResolvedValue([]);
    const out = await searchStructures.handler(
      searchStructures.input.parse({ query: 'hemoglobin', facets: ['method', 'release_year'] }),
      ctx(),
    );
    const child = out.facets?.[0]?.buckets[0]?.children?.[0];
    expect(child?.buckets).toHaveLength(FACET_CAP);
    expect(child?.truncated).toBe(true);
    // format() marks the nested truncation in the text surface too.
    const text = (searchStructures.format?.(out)?.[0] as { text: string }).text;
    expect(text).toContain('release_year →');
    expect(text).toContain('(truncated)');
  });

  it('parses a UniProt accession out of a predicted computed-model hit', async () => {
    search.mockResolvedValue({ total: 1, hits: [{ id: 'AF_AFP69905F1', score: 1 }] });
    getEntries.mockResolvedValue([]);
    const input = searchStructures.input.parse({ query: 'hemoglobin', content_type: 'predicted' });
    const out = await searchStructures.handler(input, ctx());

    expect(out.hits[0]).toMatchObject({
      id: 'AF_AFP69905F1',
      source: 'predicted',
      uniprotAccession: 'P69905',
    });
  });

  it('enriches experimental hits and records the total + echoed query', async () => {
    search.mockResolvedValue({ total: 9064, hits: [{ id: '4HHB', score: 1 }] });
    getEntries.mockResolvedValue([
      {
        id: '4HHB',
        title: 'Deoxyhaemoglobin',
        methods: ['X-RAY DIFFRACTION'],
        organisms: ['Homo sapiens'],
        resolution: 1.74,
        polymerEntities: [],
        ligands: [],
      },
    ]);
    const c = ctx();
    const out = await searchStructures.handler(
      searchStructures.input.parse({ query: 'hemoglobin' }),
      c,
    );

    expect(out.hits[0]).toMatchObject({
      id: '4HHB',
      source: 'experimental',
      title: 'Deoxyhaemoglobin',
      method: 'X-RAY DIFFRACTION',
      organism: 'Homo sapiens',
    });
    expect(getEnrichment(c)).toMatchObject({ totalCount: 9064, effectiveQuery: 'hemoglobin' });
  });

  it('notes an empty result set', async () => {
    search.mockResolvedValue({ total: 0, hits: [] });
    getEntries.mockResolvedValue([]);
    const c = ctx();
    const out = await searchStructures.handler(
      searchStructures.input.parse({ query: 'zzzznotathing' }),
      c,
    );

    expect(out.hits).toEqual([]);
    expect(String(getEnrichment(c).notice)).toMatch(/broaden|no structures/i);
  });
});
