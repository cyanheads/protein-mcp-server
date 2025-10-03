/**
 * @fileoverview Unit tests for the protein_search_structures tool.
 * @module tests/mcp-server/tools/definitions/protein-search-structures.test
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { container } from 'tsyringe';

import { ProteinService } from '@/container/tokens.js';
import { proteinSearchStructuresTool } from '@/mcp-server/tools/definitions/protein-search-structures.tool.js';
import type { ProteinService as ProteinServiceClass } from '@/services/protein/core/ProteinService.js';
import {
  ExperimentalMethod,
  type SearchStructuresResult,
} from '@/services/protein/types.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger } from '@/utils/index.js';

describe('protein_search_structures tool', () => {
  const context = {
    requestId: 'test-req-1',
    timestamp: new Date().toISOString(),
    operation: 'test',
  };

  const sdkContext = {
    elicitInput: vi.fn(),
    createMessage: vi.fn(),
    signal: new AbortController().signal,
    requestId: 'test-req-1',
    sendNotification: vi.fn(),
    sendRequest: vi.fn(),
  };

  let mockProteinService: Partial<ProteinServiceClass>;
  let loggerInfoSpy: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup logger spies
    loggerInfoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});

    // Create mock protein service
    mockProteinService = {
      searchStructures: vi.fn(),
    };

    // Mock the container
    vi.spyOn(container, 'resolve').mockImplementation((token) => {
      if (token === ProteinService) {
        return mockProteinService as ProteinServiceClass;
      }
      throw new Error(`Unexpected token: ${String(token)}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Tool Metadata', () => {
    it('should have correct tool name', () => {
      expect(proteinSearchStructuresTool.name).toBe(
        'protein_search_structures',
      );
    });

    it('should have correct annotations', () => {
      expect(proteinSearchStructuresTool.annotations).toEqual({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      });
    });

    it('should have input and output schemas defined', () => {
      expect(proteinSearchStructuresTool.inputSchema).toBeDefined();
      expect(proteinSearchStructuresTool.outputSchema).toBeDefined();
    });
  });

  describe('Input Validation', () => {
    it('should accept valid query input', async () => {
      const mockResult: SearchStructuresResult = {
        results: [],
        totalCount: 0,
        hasMore: false,
        limit: 25,
        offset: 0,
      };
      (mockProteinService.searchStructures as any).mockResolvedValue(
        mockResult,
      );

      const input = await proteinSearchStructuresTool.inputSchema.parseAsync({
        query: 'hemoglobin',
      });

      await expect(
        proteinSearchStructuresTool.logic(input, context, sdkContext as any),
      ).resolves.toEqual(mockResult);
    });

    it('should reject empty query', async () => {
      const input = { query: '' };

      await expect(
        proteinSearchStructuresTool.inputSchema.parseAsync(input),
      ).rejects.toThrow();
    });

    it('should reject query exceeding max length', async () => {
      const input = { query: 'a'.repeat(501) };

      await expect(
        proteinSearchStructuresTool.inputSchema.parseAsync(input),
      ).rejects.toThrow();
    });

    it('should accept valid organism filter', async () => {
      const mockResult: SearchStructuresResult = {
        results: [],
        totalCount: 0,
        hasMore: false,
        limit: 25,
        offset: 0,
      };
      (mockProteinService.searchStructures as any).mockResolvedValue(
        mockResult,
      );

      const input = await proteinSearchStructuresTool.inputSchema.parseAsync({
        query: 'kinase',
        organism: 'Homo sapiens',
      });

      await expect(
        proteinSearchStructuresTool.logic(input, context, sdkContext as any),
      ).resolves.toEqual(mockResult);
    });

    it('should accept valid experimental method filter', async () => {
      const mockResult: SearchStructuresResult = {
        results: [],
        totalCount: 0,
        hasMore: false,
        limit: 25,
        offset: 0,
      };
      (mockProteinService.searchStructures as any).mockResolvedValue(
        mockResult,
      );

      const input = await proteinSearchStructuresTool.inputSchema.parseAsync({
        query: 'protein',
        experimentalMethod: ExperimentalMethod.XRAY,
      });

      await expect(
        proteinSearchStructuresTool.logic(input, context, sdkContext as any),
      ).resolves.toEqual(mockResult);
    });

    it('should validate resolution range', async () => {
      const input = await proteinSearchStructuresTool.inputSchema.parseAsync({
        query: 'protein',
        minResolution: 3.0,
        maxResolution: 1.0,
      });

      await expect(
        proteinSearchStructuresTool.logic(input, context, sdkContext as any),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringContaining(
          'minResolution cannot be greater than maxResolution',
        ),
      });
    });

    it('should accept valid resolution range', async () => {
      const mockResult: SearchStructuresResult = {
        results: [],
        totalCount: 0,
        hasMore: false,
        limit: 25,
        offset: 0,
      };
      (mockProteinService.searchStructures as any).mockResolvedValue(
        mockResult,
      );

      const input = await proteinSearchStructuresTool.inputSchema.parseAsync({
        query: 'protein',
        minResolution: 1.0,
        maxResolution: 3.0,
      });

      await expect(
        proteinSearchStructuresTool.logic(input, context, sdkContext as any),
      ).resolves.toEqual(mockResult);
    });

    it('should validate pagination limit bounds', async () => {
      const invalidInputs = [
        { query: 'test', limit: 0 },
        { query: 'test', limit: 101 },
      ];

      for (const input of invalidInputs) {
        await expect(
          proteinSearchStructuresTool.inputSchema.parseAsync(input),
        ).rejects.toThrow();
      }
    });

    it('should validate pagination offset is non-negative', async () => {
      const input = { query: 'test', offset: -1 };

      await expect(
        proteinSearchStructuresTool.inputSchema.parseAsync(input),
      ).rejects.toThrow();
    });
  });

  describe('Search Logic', () => {
    it('should return search results successfully', async () => {
      const mockResult: SearchStructuresResult = {
        results: [
          {
            pdbId: '1ABC',
            title: 'Test Structure',
            organism: ['Homo sapiens'],
            experimentalMethod: 'X-RAY DIFFRACTION',
            resolution: 2.0,
            releaseDate: '2020-01-01',
            molecularWeight: 50000,
          },
        ],
        totalCount: 1,
        hasMore: false,
        limit: 25,
        offset: 0,
      };
      (mockProteinService.searchStructures as any).mockResolvedValue(
        mockResult,
      );

      const input = await proteinSearchStructuresTool.inputSchema.parseAsync({
        query: 'test',
      });
      const result = await proteinSearchStructuresTool.logic(
        input,
        context,
        sdkContext as any,
      );

      expect(result).toEqual(mockResult);
      expect(mockProteinService.searchStructures).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'test' }),
        context,
      );
    });

    it('should handle empty results', async () => {
      const mockResult: SearchStructuresResult = {
        results: [],
        totalCount: 0,
        hasMore: false,
        limit: 25,
        offset: 0,
      };
      (mockProteinService.searchStructures as any).mockResolvedValue(
        mockResult,
      );

      const input = await proteinSearchStructuresTool.inputSchema.parseAsync({
        query: 'nonexistent',
      });
      const result = await proteinSearchStructuresTool.logic(
        input,
        context,
        sdkContext as any,
      );

      expect(result.results).toHaveLength(0);
      expect(result.totalCount).toBe(0);
    });

    it('should handle pagination parameters', async () => {
      const mockResult: SearchStructuresResult = {
        results: Array(25)
          .fill(null)
          .map((_, i) => ({
            pdbId: `${i + 1}ABC`,
            title: `Structure ${i + 1}`,
            organism: ['Test organism'],
            experimentalMethod: 'X-RAY DIFFRACTION',
            releaseDate: '2020-01-01',
          })),
        totalCount: 100,
        hasMore: true,
        limit: 25,
        offset: 0,
      };
      (mockProteinService.searchStructures as any).mockResolvedValue(
        mockResult,
      );

      const input = await proteinSearchStructuresTool.inputSchema.parseAsync({
        query: 'test',
        limit: 25,
        offset: 0,
      });
      const result = await proteinSearchStructuresTool.logic(
        input,
        context,
        sdkContext as any,
      );

      expect(result.results).toHaveLength(25);
      expect(result.hasMore).toBe(true);
      expect(mockProteinService.searchStructures).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 25, offset: 0 }),
        context,
      );
    });

    it('should pass all filters to service', async () => {
      const mockResult: SearchStructuresResult = {
        results: [],
        totalCount: 0,
        hasMore: false,
        limit: 50,
        offset: 10,
      };
      (mockProteinService.searchStructures as any).mockResolvedValue(
        mockResult,
      );

      const input = await proteinSearchStructuresTool.inputSchema.parseAsync({
        query: 'kinase',
        organism: 'Homo sapiens',
        experimentalMethod: ExperimentalMethod.XRAY,
        minResolution: 1.0,
        maxResolution: 2.5,
        limit: 50,
        offset: 10,
      });

      await proteinSearchStructuresTool.logic(
        input,
        context,
        sdkContext as any,
      );

      expect(mockProteinService.searchStructures).toHaveBeenCalledWith(
        {
          query: 'kinase',
          organism: 'Homo sapiens',
          experimentalMethod: ExperimentalMethod.XRAY,
          minResolution: 1.0,
          maxResolution: 2.5,
          limit: 50,
          offset: 10,
        },
        context,
      );
    });

    it('should log search completion', async () => {
      const mockResult: SearchStructuresResult = {
        results: [
          {
            pdbId: '1ABC',
            title: 'Test',
            organism: ['Test organism'],
            experimentalMethod: 'X-RAY DIFFRACTION',
            releaseDate: '2020-01-01',
          },
        ],
        totalCount: 1,
        hasMore: false,
        limit: 25,
        offset: 0,
      };
      (mockProteinService.searchStructures as any).mockResolvedValue(
        mockResult,
      );

      const input = await proteinSearchStructuresTool.inputSchema.parseAsync({
        query: 'test',
      });

      await proteinSearchStructuresTool.logic(
        input,
        context,
        sdkContext as any,
      );

      expect(loggerInfoSpy).toHaveBeenCalledWith(
        'Protein search completed',
        expect.objectContaining({
          resultCount: 1,
          totalCount: 1,
        }),
      );
    });
  });

  describe('Response Formatting', () => {
    it('should format results with summary', () => {
      const result: SearchStructuresResult = {
        results: [
          {
            pdbId: '1ABC',
            title: 'Test Structure One',
            organism: ['Homo sapiens'],
            experimentalMethod: 'X-RAY DIFFRACTION',
            resolution: 2.0,
            releaseDate: '2020-01-01',
          },
        ],
        totalCount: 1,
        hasMore: false,
        limit: 25,
        offset: 0,
      };

      const formatted = proteinSearchStructuresTool.responseFormatter!(result);

      expect(formatted).toHaveLength(1);
      expect(formatted[0]?.type).toBe('text');
      expect(formatted[0]?.text).toContain('Found 1 structure');
      expect(formatted[0]?.text).toContain('1ABC');
    });

    it('should format empty results', () => {
      const result: SearchStructuresResult = {
        results: [],
        totalCount: 0,
        hasMore: false,
        limit: 25,
        offset: 0,
      };

      const formatted = proteinSearchStructuresTool.responseFormatter!(result);

      expect(formatted[0]?.text).toContain('Found 0 structure');
      expect(formatted[0]?.text).toContain('No structures found');
    });

    it('should indicate pagination when hasMore is true', () => {
      const result: SearchStructuresResult = {
        results: Array(25)
          .fill(null)
          .map((_, i) => ({
            pdbId: `${i + 1}ABC`,
            title: 'Test',
            organism: ['Test organism'],
            experimentalMethod: 'X-RAY DIFFRACTION',
            releaseDate: '2020-01-01',
          })),
        totalCount: 100,
        hasMore: true,
        limit: 25,
        offset: 0,
      };

      const formatted = proteinSearchStructuresTool.responseFormatter!(result);

      expect(formatted[0]?.text).toContain('showing 25');
    });

    it('should truncate preview to 10 results', () => {
      const result: SearchStructuresResult = {
        results: Array(15)
          .fill(null)
          .map((_, i) => ({
            pdbId: `${i + 1}ABC`,
            title: `Structure ${i + 1}`,
            organism: ['Test organism'],
            experimentalMethod: 'X-RAY DIFFRACTION',
            releaseDate: '2020-01-01',
          })),
        totalCount: 15,
        hasMore: false,
        limit: 25,
        offset: 0,
      };

      const formatted = proteinSearchStructuresTool.responseFormatter!(result);

      expect(formatted[0]?.text).toContain('... and 5 more');
    });
  });

  describe('Error Handling', () => {
    it('should propagate service errors', async () => {
      const serviceError = new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        'Service error',
      );
      (mockProteinService.searchStructures as any).mockRejectedValue(
        serviceError,
      );

      const input = await proteinSearchStructuresTool.inputSchema.parseAsync({
        query: 'test',
      });

      await expect(
        proteinSearchStructuresTool.logic(input, context, sdkContext as any),
      ).rejects.toThrow(serviceError);
    });

    it('should handle unexpected errors', async () => {
      const unexpectedError = new Error('Unexpected error');
      (mockProteinService.searchStructures as any).mockRejectedValue(
        unexpectedError,
      );

      const input = await proteinSearchStructuresTool.inputSchema.parseAsync({
        query: 'test',
      });

      await expect(
        proteinSearchStructuresTool.logic(input, context, sdkContext as any),
      ).rejects.toThrow('Unexpected error');
    });
  });
});
