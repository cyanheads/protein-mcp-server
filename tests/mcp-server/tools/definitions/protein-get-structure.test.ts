/**
 * @fileoverview Unit tests for the protein_get_structure tool.
 * @module tests/mcp-server/tools/definitions/protein-get-structure.test
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
import { proteinGetStructureTool } from '@/mcp-server/tools/definitions/protein-get-structure.tool.js';
import type { ProteinService as ProteinServiceClass } from '@/services/protein/core/ProteinService.js';
import {
  ChainType,
  StructureFormat,
  type ProteinStructure,
} from '@/services/protein/types.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger } from '@/utils/index.js';

describe('protein_get_structure tool', () => {
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

    loggerInfoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});

    mockProteinService = {
      getStructure: vi.fn(),
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
      expect(proteinGetStructureTool.name).toBe('protein_get_structure');
    });

    it('should have correct annotations', () => {
      expect(proteinGetStructureTool.annotations).toEqual({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      });
    });

    it('should have input and output schemas defined', () => {
      expect(proteinGetStructureTool.inputSchema).toBeDefined();
      expect(proteinGetStructureTool.outputSchema).toBeDefined();
    });
  });

  describe('Input Validation', () => {
    it('should accept valid PDB ID', async () => {
      const mockStructure: ProteinStructure = createMockStructure('1ABC');
      (mockProteinService.getStructure as any).mockResolvedValue(mockStructure);

      const input = await proteinGetStructureTool.inputSchema.parseAsync({
        pdbId: '1ABC',
      });

      await expect(
        proteinGetStructureTool.logic(input, context, sdkContext as any),
      ).resolves.toEqual(mockStructure);
    });

    it('should reject PDB ID with invalid length', async () => {
      const invalidInputs = [{ pdbId: '1A' }, { pdbId: '1ABCD' }];

      for (const input of invalidInputs) {
        await expect(
          proteinGetStructureTool.inputSchema.parseAsync(input),
        ).rejects.toThrow();
      }
    });

    it('should reject PDB ID with invalid characters', async () => {
      const input = { pdbId: '1AB@' };

      await expect(
        proteinGetStructureTool.inputSchema.parseAsync(input),
      ).rejects.toThrow();
    });

    it('should accept all valid structure formats', async () => {
      const mockStructure: ProteinStructure = createMockStructure('1ABC');
      (mockProteinService.getStructure as any).mockResolvedValue(mockStructure);

      const formats = [
        StructureFormat.MMCIF,
        StructureFormat.PDB,
        StructureFormat.PDBML,
        StructureFormat.JSON,
        StructureFormat.BCIF,
      ];

      for (const format of formats) {
        const input = await proteinGetStructureTool.inputSchema.parseAsync({
          pdbId: '1ABC',
          format,
        });
        await expect(
          proteinGetStructureTool.logic(input, context, sdkContext as any),
        ).resolves.toBeDefined();
      }
    });

    it('should apply default values for optional parameters', async () => {
      const input = { pdbId: '1ABC' };
      const parsed =
        await proteinGetStructureTool.inputSchema.parseAsync(input);

      expect(parsed.format).toBe(StructureFormat.MMCIF);
      expect(parsed.includeCoordinates).toBe(true);
      expect(parsed.includeExperimentalData).toBe(true);
      expect(parsed.includeAnnotations).toBe(true);
    });

    it('should accept custom boolean flags', async () => {
      const mockStructure: ProteinStructure = createMockStructure('1ABC');
      (mockProteinService.getStructure as any).mockResolvedValue(mockStructure);

      const input = await proteinGetStructureTool.inputSchema.parseAsync({
        pdbId: '1ABC',
        includeCoordinates: false,
        includeExperimentalData: false,
        includeAnnotations: false,
      });

      await expect(
        proteinGetStructureTool.logic(input, context, sdkContext as any),
      ).resolves.toBeDefined();

      expect(mockProteinService.getStructure).toHaveBeenCalledWith(
        '1ABC',
        expect.objectContaining({
          includeCoordinates: false,
          includeExperimentalData: false,
          includeAnnotations: false,
        }),
        context,
      );
    });
  });

  describe('Structure Retrieval Logic', () => {
    it('should retrieve structure successfully', async () => {
      const mockStructure: ProteinStructure = createMockStructure('1ABC');
      (mockProteinService.getStructure as any).mockResolvedValue(mockStructure);

      const input = await proteinGetStructureTool.inputSchema.parseAsync({
        pdbId: '1ABC',
      });
      const result = await proteinGetStructureTool.logic(
        input,
        context,
        sdkContext as any,
      );

      expect(result).toEqual(mockStructure);
      expect(mockProteinService.getStructure).toHaveBeenCalledWith(
        '1ABC',
        expect.any(Object),
        context,
      );
    });

    it('should convert PDB ID to uppercase', async () => {
      const mockStructure: ProteinStructure = createMockStructure('1ABC');
      (mockProteinService.getStructure as any).mockResolvedValue(mockStructure);

      const input = await proteinGetStructureTool.inputSchema.parseAsync({
        pdbId: '1abc',
      });
      await proteinGetStructureTool.logic(input, context, sdkContext as any);

      expect(mockProteinService.getStructure).toHaveBeenCalledWith(
        '1ABC',
        expect.any(Object),
        context,
      );
    });

    it('should pass all options to service', async () => {
      const mockStructure: ProteinStructure = createMockStructure('1ABC');
      (mockProteinService.getStructure as any).mockResolvedValue(mockStructure);

      const input = {
        pdbId: '1ABC',
        format: StructureFormat.PDB,
        includeCoordinates: false,
        includeExperimentalData: true,
        includeAnnotations: false,
      };

      await proteinGetStructureTool.logic(input, context, sdkContext);

      expect(mockProteinService.getStructure).toHaveBeenCalledWith(
        '1ABC',
        {
          format: StructureFormat.PDB,
          includeCoordinates: false,
          includeExperimentalData: true,
          includeAnnotations: false,
        },
        context,
      );
    });

    it('should log structure retrieval', async () => {
      const mockStructure: ProteinStructure = createMockStructure('1ABC', 3);
      (mockProteinService.getStructure as any).mockResolvedValue(mockStructure);

      await proteinGetStructureTool.logic(
        {
          pdbId: '1ABC',
          format: StructureFormat.MMCIF,
          includeCoordinates: true,
          includeExperimentalData: true,
          includeAnnotations: true,
        },
        context,
        sdkContext,
      );

      expect(loggerInfoSpy).toHaveBeenCalledWith(
        'Protein structure retrieved',
        expect.objectContaining({
          pdbId: '1ABC',
          format: StructureFormat.MMCIF,
          chainCount: 3,
        }),
      );
    });
  });

  describe('Response Formatting', () => {
    it('should format structure with complete metadata', () => {
      const structure: ProteinStructure = createMockStructure('1ABC', 2);
      const formatted = proteinGetStructureTool.responseFormatter!(structure);

      expect(formatted).toHaveLength(1);
      expect(formatted[0]?.type).toBe('text');
      expect(formatted[0]?.text).toContain('1ABC');
      expect(formatted[0]?.text).toContain('Test Structure');
      expect(formatted[0]?.text).toContain('X-RAY DIFFRACTION');
      expect(formatted[0]?.text).toContain('2.00Å');
      expect(formatted[0]?.text).toContain('Chains: 2');
    });

    it('should format structure without resolution', () => {
      const structure: ProteinStructure = {
        ...createMockStructure('1NMR'),
        experimental: {
          method: 'SOLUTION NMR',
        },
      };

      const formatted = proteinGetStructureTool.responseFormatter!(structure);

      expect(formatted[0]?.text).not.toContain('Resolution');
      expect(formatted[0]?.text).toContain('SOLUTION NMR');
    });

    it('should show chain details', () => {
      const structure: ProteinStructure = createMockStructure('1ABC', 3);
      const formatted = proteinGetStructureTool.responseFormatter!(structure);

      expect(formatted[0]?.text).toContain('Chain A: protein (100 residues)');
      expect(formatted[0]?.text).toContain('Chain B: protein (100 residues)');
      expect(formatted[0]?.text).toContain('Chain C: protein (100 residues)');
    });

    it('should truncate chain list when more than 5 chains', () => {
      const structure: ProteinStructure = createMockStructure('1ABC', 8);
      const formatted = proteinGetStructureTool.responseFormatter!(structure);

      expect(formatted[0]?.text).toContain('... and more');
    });

    it('should show structure size in KB', () => {
      const structure: ProteinStructure = createMockStructure('1ABC');
      const formatted = proteinGetStructureTool.responseFormatter!(structure);

      expect(formatted[0]?.text).toMatch(/Size: \d+\.\d+ KB/);
    });

    it('should handle different format types', () => {
      const structure: ProteinStructure = {
        ...createMockStructure('1ABC'),
        structure: {
          format: StructureFormat.JSON,
          data: { test: 'data' },
          chains: [],
        },
      };

      const formatted = proteinGetStructureTool.responseFormatter!(structure);

      expect(formatted[0]?.text).toContain('Format: JSON');
    });
  });

  describe('Error Handling', () => {
    it('should propagate service errors', async () => {
      const serviceError = new McpError(
        JsonRpcErrorCode.NotFound,
        'Structure not found',
      );
      (mockProteinService.getStructure as any).mockRejectedValue(serviceError);

      await expect(
        proteinGetStructureTool.logic(
          {
            pdbId: '9999',
            format: StructureFormat.MMCIF,
            includeCoordinates: true,
            includeExperimentalData: true,
            includeAnnotations: true,
          },
          context,
          sdkContext,
        ),
      ).rejects.toThrow(serviceError);
    });

    it('should handle unexpected errors', async () => {
      const unexpectedError = new Error('Network error');
      (mockProteinService.getStructure as any).mockRejectedValue(
        unexpectedError,
      );

      await expect(
        proteinGetStructureTool.logic(
          {
            pdbId: '1ABC',
            format: StructureFormat.MMCIF,
            includeCoordinates: true,
            includeExperimentalData: true,
            includeAnnotations: true,
          },
          context,
          sdkContext,
        ),
      ).rejects.toThrow('Network error');
    });

    it('should handle service unavailable errors', async () => {
      const serviceError = new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        'RCSB service is down',
      );
      (mockProteinService.getStructure as any).mockRejectedValue(serviceError);

      await expect(
        proteinGetStructureTool.logic(
          {
            pdbId: '1ABC',
            format: StructureFormat.MMCIF,
            includeCoordinates: true,
            includeExperimentalData: true,
            includeAnnotations: true,
          },
          context,
          sdkContext,
        ),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
      });
    });
  });
});

/**
 * Helper function to create mock protein structure
 */
function createMockStructure(
  pdbId: string,
  chainCount: number = 2,
): ProteinStructure {
  const chains = Array.from({ length: chainCount }, (_, i) => ({
    id: String.fromCharCode(65 + i), // A, B, C, ...
    type: ChainType.PROTEIN,
    sequence: 'M'.repeat(100),
    length: 100,
  }));

  return {
    pdbId,
    title: 'Test Structure',
    structure: {
      format: StructureFormat.MMCIF,
      data: 'mock structure data'.repeat(100),
      chains,
    },
    experimental: {
      method: 'X-RAY DIFFRACTION',
      resolution: 2.0,
      rFactor: 0.18,
      rFree: 0.22,
      spaceGroup: 'P 21 21 21',
      unitCell: {
        a: 50.0,
        b: 60.0,
        c: 70.0,
        alpha: 90.0,
        beta: 90.0,
        gamma: 90.0,
      },
    },
    annotations: {
      keywords: ['TRANSFERASE', 'KINASE'],
      citations: [
        {
          title: 'Test Publication',
          authors: ['Smith, J.', 'Doe, J.'],
          journal: 'Nature',
          doi: '10.1038/test',
          pubmedId: '12345678',
          year: 2020,
        },
      ],
    },
  };
}
