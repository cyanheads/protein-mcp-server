/**
 * @fileoverview Unit tests for the protein_find_similar tool.
 * @module tests/mcp-server/tools/definitions/protein-find-similar.test
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
import { proteinFindSimilarTool } from '@/mcp-server/tools/definitions/protein-find-similar.tool.js';
import type { ProteinService as ProteinServiceClass } from '@/services/protein/core/ProteinService.js';
import {
  SimilarityType,
  type FindSimilarResult,
} from '@/services/protein/types.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger } from '@/utils/index.js';

describe('protein_find_similar tool', () => {
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

    vi.spyOn(logger, 'debug').mockImplementation(() => {});
    loggerInfoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});

    mockProteinService = {
      findSimilar: vi.fn(),
    };

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
      expect(proteinFindSimilarTool.name).toBe('protein_find_similar');
    });

    it('should have correct annotations', () => {
      expect(proteinFindSimilarTool.annotations).toEqual({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      });
    });

    it('should have input and output schemas defined', () => {
      expect(proteinFindSimilarTool.inputSchema).toBeDefined();
      expect(proteinFindSimilarTool.outputSchema).toBeDefined();
    });
  });

  describe('Input Validation', () => {
    it('should accept PDB ID query for sequence similarity', async () => {
      const mockResult = createMockSimilarityResult('sequence');
      (mockProteinService.findSimilar as any).mockResolvedValue(mockResult);

      const input = await proteinFindSimilarTool.inputSchema.parseAsync({
        query: { type: 'pdbId' as const, value: '1ABC' },
        similarityType: SimilarityType.SEQUENCE,
      });

      await expect(
        proteinFindSimilarTool.logic(input, context, sdkContext as any),
      ).resolves.toEqual(mockResult);
    });

    it('should accept FASTA sequence query', async () => {
      const mockResult = createMockSimilarityResult('sequence');
      (mockProteinService.findSimilar as any).mockResolvedValue(mockResult);

      const input = await proteinFindSimilarTool.inputSchema.parseAsync({
        query: { type: 'sequence' as const, value: 'MKTAYIAKQRQIS' },
        similarityType: SimilarityType.SEQUENCE,
      });

      await expect(
        proteinFindSimilarTool.logic(input, context, sdkContext as any),
      ).resolves.toEqual(mockResult);
    });

    it('should accept structure data query', async () => {
      const mockResult = createMockSimilarityResult('structure');
      (mockProteinService.findSimilar as any).mockResolvedValue(mockResult);

      const input = await proteinFindSimilarTool.inputSchema.parseAsync({
        query: { type: 'structure' as const, value: 'ATOM...' },
        similarityType: SimilarityType.STRUCTURE,
      });

      await expect(
        proteinFindSimilarTool.logic(input, context, sdkContext as any),
      ).resolves.toEqual(mockResult);
    });

    it('should reject empty query value', async () => {
      const input = {
        query: { type: 'pdbId' as const, value: '' },
        similarityType: SimilarityType.SEQUENCE,
      };

      await expect(
        proteinFindSimilarTool.inputSchema.parseAsync(input),
      ).rejects.toThrow();
    });

    it('should accept valid thresholds', async () => {
      const mockResult = createMockSimilarityResult('sequence');
      (mockProteinService.findSimilar as any).mockResolvedValue(mockResult);

      const input = await proteinFindSimilarTool.inputSchema.parseAsync({
        query: { type: 'pdbId' as const, value: '1ABC' },
        similarityType: SimilarityType.SEQUENCE,
        threshold: {
          sequenceIdentity: 90,
          eValue: 0.001,
        },
      });

      await expect(
        proteinFindSimilarTool.logic(input, context, sdkContext as any),
      ).resolves.toEqual(mockResult);
    });

    it('should validate sequence identity range', async () => {
      const invalidInputs = [
        {
          query: { type: 'pdbId' as const, value: '1ABC' },
          similarityType: SimilarityType.SEQUENCE,
          threshold: { sequenceIdentity: -1 },
        },
        {
          query: { type: 'pdbId' as const, value: '1ABC' },
          similarityType: SimilarityType.SEQUENCE,
          threshold: { sequenceIdentity: 101 },
        },
      ];

      for (const input of invalidInputs) {
        await expect(
          proteinFindSimilarTool.inputSchema.parseAsync(input),
        ).rejects.toThrow();
      }
    });

    it('should validate TM-score range', async () => {
      const invalidInputs = [
        {
          query: { type: 'pdbId' as const, value: '1ABC' },
          similarityType: SimilarityType.STRUCTURE,
          threshold: { tmscore: -0.1 },
        },
        {
          query: { type: 'pdbId' as const, value: '1ABC' },
          similarityType: SimilarityType.STRUCTURE,
          threshold: { tmscore: 1.1 },
        },
      ];

      for (const input of invalidInputs) {
        await expect(
          proteinFindSimilarTool.inputSchema.parseAsync(input),
        ).rejects.toThrow();
      }
    });

    it('should validate limit bounds', async () => {
      const invalidInputs = [
        {
          query: { type: 'pdbId' as const, value: '1ABC' },
          similarityType: SimilarityType.SEQUENCE,
          limit: 0,
        },
        {
          query: { type: 'pdbId' as const, value: '1ABC' },
          similarityType: SimilarityType.SEQUENCE,
          limit: 101,
        },
      ];

      for (const input of invalidInputs) {
        await expect(
          proteinFindSimilarTool.inputSchema.parseAsync(input),
        ).rejects.toThrow();
      }
    });

    it('should apply default limit value', async () => {
      const input = {
        query: { type: 'pdbId' as const, value: '1ABC' },
        similarityType: SimilarityType.SEQUENCE,
      };

      const parsed = await proteinFindSimilarTool.inputSchema.parseAsync(input);
      expect(parsed.limit).toBe(25);
    });

    it('should accept optional chain ID', async () => {
      const mockResult = createMockSimilarityResult('structure');
      (mockProteinService.findSimilar as any).mockResolvedValue(mockResult);

      const input = await proteinFindSimilarTool.inputSchema.parseAsync({
        query: { type: 'pdbId' as const, value: '1ABC' },
        similarityType: SimilarityType.STRUCTURE,
        chainId: 'B',
      });

      await expect(
        proteinFindSimilarTool.logic(input, context, sdkContext as any),
      ).resolves.toEqual(mockResult);

      expect(mockProteinService.findSimilar).toHaveBeenCalledWith(
        expect.objectContaining({ chainId: 'B' }),
        context,
      );
    });
  });

  describe('Similarity Search Logic', () => {
    it('should perform sequence similarity search', async () => {
      const mockResult = createMockSimilarityResult('sequence');
      (mockProteinService.findSimilar as any).mockResolvedValue(mockResult);

      const input = await proteinFindSimilarTool.inputSchema.parseAsync({
        query: { type: 'pdbId' as const, value: '1ABC' },
        similarityType: SimilarityType.SEQUENCE,
      });

      const result = await proteinFindSimilarTool.logic(
        input,
        context,
        sdkContext as any,
      );

      expect(result).toEqual(mockResult);
      expect(mockProteinService.findSimilar).toHaveBeenCalledWith(
        expect.objectContaining({
          query: { type: 'pdbId', value: '1ABC' },
          similarityType: SimilarityType.SEQUENCE,
        }),
        context,
      );
    });

    it('should perform structure similarity search', async () => {
      const mockResult = createMockSimilarityResult('structure');
      (mockProteinService.findSimilar as any).mockResolvedValue(mockResult);

      const input = await proteinFindSimilarTool.inputSchema.parseAsync({
        query: { type: 'pdbId' as const, value: '1ABC' },
        similarityType: SimilarityType.STRUCTURE,
      });

      const result = await proteinFindSimilarTool.logic(
        input,
        context,
        sdkContext as any,
      );

      expect(result.similarityType).toBe('structure');
      expect(mockProteinService.findSimilar).toHaveBeenCalledWith(
        expect.objectContaining({
          similarityType: SimilarityType.STRUCTURE,
        }),
        context,
      );
    });

    it('should pass all parameters to service', async () => {
      const mockResult = createMockSimilarityResult('sequence');
      (mockProteinService.findSimilar as any).mockResolvedValue(mockResult);

      const input = {
        query: { type: 'pdbId' as const, value: '1ABC' },
        similarityType: SimilarityType.SEQUENCE,
        threshold: {
          sequenceIdentity: 80,
          eValue: 0.01,
        },
        limit: 50,
        chainId: 'A',
      };

      await proteinFindSimilarTool.logic(input, context, sdkContext);

      expect(mockProteinService.findSimilar).toHaveBeenCalledWith(
        {
          query: { type: 'pdbId', value: '1ABC' },
          similarityType: SimilarityType.SEQUENCE,
          threshold: {
            sequenceIdentity: 80,
            eValue: 0.01,
          },
          limit: 50,
          chainId: 'A',
        },
        context,
      );
    });

    it('should handle empty results', async () => {
      const emptyResult: FindSimilarResult = {
        query: { type: 'pdbId', identifier: '1ABC' },
        similarityType: 'sequence',
        results: [],
        totalCount: 0,
      };
      (mockProteinService.findSimilar as any).mockResolvedValue(emptyResult);

      const input = await proteinFindSimilarTool.inputSchema.parseAsync({
        query: { type: 'pdbId' as const, value: '1ABC' },
        similarityType: SimilarityType.SEQUENCE,
      });

      const result = await proteinFindSimilarTool.logic(
        input,
        context,
        sdkContext as any,
      );

      expect(result.results).toHaveLength(0);
      expect(result.totalCount).toBe(0);
    });

    it('should log search completion', async () => {
      const mockResult = createMockSimilarityResult('sequence', 3);
      (mockProteinService.findSimilar as any).mockResolvedValue(mockResult);

      const input = await proteinFindSimilarTool.inputSchema.parseAsync({
        query: { type: 'pdbId' as const, value: '1ABC' },
        similarityType: SimilarityType.SEQUENCE,
      });

      await proteinFindSimilarTool.logic(input, context, sdkContext as any);

      expect(loggerInfoSpy).toHaveBeenCalledWith(
        'Similarity search completed',
        expect.objectContaining({
          resultCount: 3,
        }),
      );
    });
  });

  describe('Response Formatting', () => {
    it('should format sequence similarity results', () => {
      const result = createMockSimilarityResult('sequence', 2);
      const formatted = proteinFindSimilarTool.responseFormatter!(result);

      expect(formatted).toHaveLength(1);
      expect(formatted[0]?.type).toBe('text');
      expect(formatted[0]?.text).toContain('Found 2 similar structure');
      expect(formatted[0]?.text).toContain('sequence search');
      expect(formatted[0]?.text).toContain('% ID');
    });

    it('should format structure similarity results', () => {
      const result = createMockSimilarityResult('structure', 2);
      const formatted = proteinFindSimilarTool.responseFormatter!(result);

      expect(formatted[0]?.text).toContain('structure search');
      expect(formatted[0]?.text).toContain('TM=');
      expect(formatted[0]?.text).toContain('RMSD=');
    });

    it('should format empty results', () => {
      const result: FindSimilarResult = {
        query: { type: 'pdbId', identifier: '1ABC' },
        similarityType: 'sequence',
        results: [],
        totalCount: 0,
      };

      const formatted = proteinFindSimilarTool.responseFormatter!(result);

      expect(formatted[0]?.text).toContain('Found 0 similar structure');
      expect(formatted[0]?.text).toContain('No similar structures found');
    });

    it('should truncate results preview to 5', () => {
      const result = createMockSimilarityResult('sequence', 10);
      const formatted = proteinFindSimilarTool.responseFormatter!(result);

      expect(formatted[0]?.text).toMatch(/\.\.\. and \d+ more/);
    });

    it('should include shape similarity for structure search', () => {
      const result: FindSimilarResult = {
        query: { type: 'pdbId', identifier: '1ABC' },
        similarityType: 'structure',
        results: [
          {
            pdbId: '2DEF',
            title: 'Similar Structure',
            organism: ['Test organism'],
            similarity: {
              shapeSimilarity: 0.85,
              tmscore: 0.9,
            },
          },
        ],
        totalCount: 1,
      };

      const formatted = proteinFindSimilarTool.responseFormatter!(result);

      expect(formatted[0]?.text).toContain('Shape=0.85');
    });

    it('should include E-value for sequence search', () => {
      const result: FindSimilarResult = {
        query: { type: 'pdbId', identifier: '1ABC' },
        similarityType: 'sequence',
        results: [
          {
            pdbId: '2DEF',
            title: 'Similar Sequence',
            organism: ['Test organism'],
            similarity: {
              sequenceIdentity: 95.5,
              eValue: 1e-50,
            },
          },
        ],
        totalCount: 1,
      };

      const formatted = proteinFindSimilarTool.responseFormatter!(result);

      expect(formatted[0]?.text).toMatch(/E=.*e-50/);
    });
  });

  describe('Error Handling', () => {
    it('should propagate service errors', async () => {
      const serviceError = new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        'Search service error',
      );
      (mockProteinService.findSimilar as any).mockRejectedValue(serviceError);

      const input = await proteinFindSimilarTool.inputSchema.parseAsync({
        query: { type: 'pdbId' as const, value: '1ABC' },
        similarityType: SimilarityType.SEQUENCE,
      });

      await expect(
        proteinFindSimilarTool.logic(input, context, sdkContext as any),
      ).rejects.toThrow(serviceError);
    });

    it('should handle unexpected errors', async () => {
      const unexpectedError = new Error('Unexpected error');
      (mockProteinService.findSimilar as any).mockRejectedValue(
        unexpectedError,
      );

      const input = await proteinFindSimilarTool.inputSchema.parseAsync({
        query: { type: 'pdbId' as const, value: '1ABC' },
        similarityType: SimilarityType.SEQUENCE,
      });

      await expect(
        proteinFindSimilarTool.logic(input, context, sdkContext as any),
      ).rejects.toThrow('Unexpected error');
    });
  });
});

/**
 * Helper function to create mock similarity search result
 */
function createMockSimilarityResult(
  type: 'sequence' | 'structure',
  count: number = 2,
): FindSimilarResult {
  const results = Array.from({ length: count }, (_, i) => ({
    pdbId: `${i + 2}ABC`,
    title: `Similar Structure ${i + 1}`,
    organism: ['Homo sapiens', 'Mus musculus'],
    similarity:
      type === 'sequence'
        ? {
            sequenceIdentity: 90 - i * 5,
            eValue: Math.pow(10, -(40 - i * 10)),
          }
        : {
            tmscore: 0.9 - i * 0.1,
            rmsd: 1.0 + i * 0.5,
            shapeSimilarity: 0.85 - i * 0.05,
          },
    alignmentLength: 250,
    coverage: 95 - i * 2,
  }));

  return {
    query: { type: 'pdbId', identifier: '1ABC' },
    similarityType: type,
    results,
    totalCount: count,
  };
}
