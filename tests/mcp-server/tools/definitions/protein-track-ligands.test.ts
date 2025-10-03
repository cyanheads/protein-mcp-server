/**
 * @fileoverview Unit tests for the protein_track_ligands tool.
 * @module tests/mcp-server/tools/definitions/protein-track-ligands.test
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
import { proteinTrackLigandsTool } from '@/mcp-server/tools/definitions/protein-track-ligands.tool.js';
import type { ProteinService as ProteinServiceClass } from '@/services/protein/core/ProteinService.js';
import type { Ligand, TrackLigandsResult } from '@/services/protein/types.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger } from '@/utils/index.js';

describe('protein_track_ligands tool', () => {
  const context = {
    requestId: 'test-req-1',
    timestamp: new Date().toISOString(),
    operation: 'test',
  };

  const sdkContext = {
    signal: new AbortController().signal,
    requestId: 'test-req-1',
    elicitInput: vi.fn(),
    createMessage: vi.fn(),
    sendNotification: vi.fn(),
    sendRequest: vi.fn(),
  };

  let mockProteinService: Partial<ProteinServiceClass>;
  let loggerInfoSpy: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();

    loggerInfoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});

    mockProteinService = {
      trackLigands: vi.fn(),
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
      expect(proteinTrackLigandsTool.name).toBe('protein_track_ligands');
    });

    it('should have correct annotations', () => {
      expect(proteinTrackLigandsTool.annotations).toEqual({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      });
    });

    it('should have input and output schemas defined', () => {
      expect(proteinTrackLigandsTool.inputSchema).toBeDefined();
      expect(proteinTrackLigandsTool.outputSchema).toBeDefined();
    });
  });

  describe('Input Validation', () => {
    it('should accept ligand query by name', async () => {
      const mockResult = createMockLigandResult('ATP');
      (mockProteinService.trackLigands as any).mockResolvedValue(mockResult);

      const input = await proteinTrackLigandsTool.inputSchema.parseAsync({
        ligandQuery: { type: 'name' as const, value: 'ATP' },
      });

      await expect(
        proteinTrackLigandsTool.logic(input, context, sdkContext as any),
      ).resolves.toEqual(mockResult);
    });

    it('should accept ligand query by chemical ID', async () => {
      const mockResult = createMockLigandResult('ATP');
      (mockProteinService.trackLigands as any).mockResolvedValue(mockResult);

      const input = await proteinTrackLigandsTool.inputSchema.parseAsync({
        ligandQuery: { type: 'chemicalId' as const, value: 'ATP' },
      });

      await expect(
        proteinTrackLigandsTool.logic(input, context, sdkContext as any),
      ).resolves.toEqual(mockResult);
    });

    it('should accept ligand query by SMILES', async () => {
      const mockResult = createMockLigandResult('Custom');
      (mockProteinService.trackLigands as any).mockResolvedValue(mockResult);

      const input = await proteinTrackLigandsTool.inputSchema.parseAsync({
        ligandQuery: {
          type: 'smiles' as const,
          value: 'CC(C)CC1=CC=C(C=C1)C(C)C(=O)O',
        },
      });

      await expect(
        proteinTrackLigandsTool.logic(input, context, sdkContext as any),
      ).resolves.toEqual(mockResult);
    });

    it('should accept ligand query by InChI', async () => {
      const mockResult = createMockLigandResult('Custom');
      (mockProteinService.trackLigands as any).mockResolvedValue(mockResult);

      const input = await proteinTrackLigandsTool.inputSchema.parseAsync({
        ligandQuery: {
          type: 'inchi' as const,
          value:
            'InChI=1S/C10H12O2/c1-7(2)6-8-3-5-9(10(11)12)4-8/h3-5,7H,6H2,1-2H3,(H,11,12)',
        },
      });

      await expect(
        proteinTrackLigandsTool.logic(input, context, sdkContext as any),
      ).resolves.toEqual(mockResult);
    });

    it('should accept match type for chemical queries', async () => {
      const mockResult = createMockLigandResult('Custom');
      (mockProteinService.trackLigands as any).mockResolvedValue(mockResult);

      const matchTypes: Array<
        'strict' | 'relaxed' | 'relaxed-stereo' | 'fingerprint'
      > = ['strict', 'relaxed', 'relaxed-stereo', 'fingerprint'];

      for (const matchType of matchTypes) {
        const input = await proteinTrackLigandsTool.inputSchema.parseAsync({
          ligandQuery: {
            type: 'smiles' as const,
            value: 'CC(=O)O',
            matchType,
          },
        });

        await expect(
          proteinTrackLigandsTool.logic(input, context, sdkContext as any),
        ).resolves.toBeDefined();
      }
    });

    it('should reject empty ligand value', async () => {
      const input = {
        ligandQuery: { type: 'name' as const, value: '' },
      };

      await expect(
        proteinTrackLigandsTool.inputSchema.parseAsync(input),
      ).rejects.toThrow();
    });

    it('should accept optional filters', async () => {
      const mockResult = createMockLigandResult('ATP');
      (mockProteinService.trackLigands as any).mockResolvedValue(mockResult);

      const input = await proteinTrackLigandsTool.inputSchema.parseAsync({
        ligandQuery: { type: 'name' as const, value: 'ATP' },
        filters: {
          proteinName: 'kinase',
          organism: 'Homo sapiens',
          experimentalMethod: 'X-RAY DIFFRACTION',
          maxResolution: 2.5,
        },
      });

      await expect(
        proteinTrackLigandsTool.logic(input, context, sdkContext as any),
      ).resolves.toEqual(mockResult);

      expect(mockProteinService.trackLigands).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: {
            proteinName: 'kinase',
            organism: 'Homo sapiens',
            experimentalMethod: 'X-RAY DIFFRACTION',
            maxResolution: 2.5,
          },
        }),
        context,
      );
    });

    it('should apply default values for optional parameters', async () => {
      const input = {
        ligandQuery: { type: 'name' as const, value: 'ATP' },
      };

      const parsed =
        await proteinTrackLigandsTool.inputSchema.parseAsync(input);

      expect(parsed.includeBindingSite).toBe(false);
      expect(parsed.limit).toBe(25);
    });

    it('should validate limit bounds', async () => {
      const invalidInputs = [
        {
          ligandQuery: { type: 'name' as const, value: 'ATP' },
          limit: 0,
        },
        {
          ligandQuery: { type: 'name' as const, value: 'ATP' },
          limit: 101,
        },
      ];

      for (const input of invalidInputs) {
        await expect(
          proteinTrackLigandsTool.inputSchema.parseAsync(input),
        ).rejects.toThrow();
      }
    });
  });

  describe('Ligand Tracking Logic', () => {
    it('should track ligands successfully', async () => {
      const mockResult = createMockLigandResult('ATP');
      (mockProteinService.trackLigands as any).mockResolvedValue(mockResult);

      const input = await proteinTrackLigandsTool.inputSchema.parseAsync({
        ligandQuery: { type: 'name' as const, value: 'ATP' },
      });

      const result = await proteinTrackLigandsTool.logic(
        input,
        context,
        sdkContext as any,
      );

      expect(result).toEqual(mockResult);
      expect(mockProteinService.trackLigands).toHaveBeenCalledWith(
        expect.objectContaining({
          ligandQuery: { type: 'name', value: 'ATP' },
        }),
        context,
      );
    });

    it('should pass all parameters to service', async () => {
      const mockResult = createMockLigandResult('ATP');
      (mockProteinService.trackLigands as any).mockResolvedValue(mockResult);

      const input = await proteinTrackLigandsTool.inputSchema.parseAsync({
        ligandQuery: { type: 'name' as const, value: 'ATP' },
        filters: {
          proteinName: 'kinase',
          organism: 'Homo sapiens',
        },
        includeBindingSite: true,
        limit: 50,
      });

      await proteinTrackLigandsTool.logic(input, context, sdkContext as any);

      expect(mockProteinService.trackLigands).toHaveBeenCalledWith(
        {
          ligandQuery: { type: 'name', value: 'ATP' },
          filters: {
            proteinName: 'kinase',
            organism: 'Homo sapiens',
          },
          includeBindingSite: true,
          limit: 50,
        },
        context,
      );
    });

    it('should handle empty results', async () => {
      const emptyResult: TrackLigandsResult = {
        ligand: {
          name: 'Unknown',
          chemicalId: 'XXX',
        },
        structures: [],
        totalCount: 0,
      };
      (mockProteinService.trackLigands as any).mockResolvedValue(emptyResult);

      const input = await proteinTrackLigandsTool.inputSchema.parseAsync({
        ligandQuery: { type: 'name' as const, value: 'Unknown' },
      });

      const result = await proteinTrackLigandsTool.logic(
        input,
        context,
        sdkContext as any,
      );

      expect(result.structures).toHaveLength(0);
      expect(result.totalCount).toBe(0);
    });

    it('should include binding site data when requested', async () => {
      const mockResult = createMockLigandResult('ATP', true);
      (mockProteinService.trackLigands as any).mockResolvedValue(mockResult);

      const input = await proteinTrackLigandsTool.inputSchema.parseAsync({
        ligandQuery: { type: 'name' as const, value: 'ATP' },
        includeBindingSite: true,
      });

      const result = await proteinTrackLigandsTool.logic(
        input,
        context,
        sdkContext as any,
      );

      expect(result.structures[0]?.bindingSites).toBeDefined();
      expect(result.structures[0]?.bindingSites).toHaveLength(1);
    });

    it('should log tracking completion', async () => {
      const mockResult = createMockLigandResult('ATP');
      (mockProteinService.trackLigands as any).mockResolvedValue(mockResult);

      const input = await proteinTrackLigandsTool.inputSchema.parseAsync({
        ligandQuery: { type: 'name' as const, value: 'ATP' },
      });

      await proteinTrackLigandsTool.logic(input, context, sdkContext as any);

      expect(loggerInfoSpy).toHaveBeenCalledWith(
        'Ligand tracking completed',
        expect.objectContaining({
          ligand: 'ATP',
          structureCount: 2,
        }),
      );
    });
  });

  describe('Response Formatting', () => {
    it('should format results with ligand info', () => {
      const result = createMockLigandResult('ATP');
      const formatted = proteinTrackLigandsTool.responseFormatter!(result);

      expect(formatted).toHaveLength(1);
      expect(formatted[0]?.type).toBe('text');
      expect(formatted[0]?.text).toContain(
        'Ligand: Adenosine triphosphate (ATP)',
      );
      expect(formatted[0]?.text).toContain('C10H16N5O13P3');
      expect(formatted[0]?.text).toContain('Found in 2 structure');
    });

    it('should format results without formula', () => {
      const result: TrackLigandsResult = {
        ligand: {
          name: 'Test Ligand',
          chemicalId: 'TST',
        },
        structures: [],
        totalCount: 0,
      };

      const formatted = proteinTrackLigandsTool.responseFormatter!(result);

      expect(formatted[0]?.text).not.toContain('Formula:');
      expect(formatted[0]?.text).toContain('Test Ligand (TST)');
    });

    it('should format structure previews', () => {
      const result = createMockLigandResult('ATP');
      const formatted = proteinTrackLigandsTool.responseFormatter!(result);

      expect(formatted[0]?.text).toContain('1ABC');
      expect(formatted[0]?.text).toContain('Test Protein with ATP');
      expect(formatted[0]?.text).toContain('2.00Å');
      expect(formatted[0]?.text).toContain('instances');
    });

    it('should format empty results', () => {
      const result: TrackLigandsResult = {
        ligand: {
          name: 'Unknown',
          chemicalId: 'XXX',
        },
        structures: [],
        totalCount: 0,
      };

      const formatted = proteinTrackLigandsTool.responseFormatter!(result);

      expect(formatted[0]?.text).toContain('Found in 0 structure');
      expect(formatted[0]?.text).toContain('No structures found');
    });

    it('should truncate preview to 5 structures', () => {
      const result = createMockLigandResult('ATP', false, 10);
      const formatted = proteinTrackLigandsTool.responseFormatter!(result);

      const firstBlock = formatted[0];
      expect(firstBlock?.type).toBe('text');
      const previewText = firstBlock?.type === 'text' ? firstBlock.text : '';
      const structureMatches = previewText.match(/•/g);
      expect(structureMatches).toHaveLength(5);
    });

    it('should handle structures without resolution', () => {
      const result: TrackLigandsResult = {
        ligand: {
          name: 'ATP',
          chemicalId: 'ATP',
        },
        structures: [
          {
            pdbId: '1NMR',
            title: 'NMR Structure',
            organism: ['Homo sapiens'],
            ligandCount: 1,
          },
        ],
        totalCount: 1,
      };

      const formatted = proteinTrackLigandsTool.responseFormatter!(result);

      expect(formatted[0]?.text).toContain('1NMR');
      expect(formatted[0]?.text).not.toContain('Å');
    });
  });

  describe('Error Handling', () => {
    it('should propagate service errors', async () => {
      const serviceError = new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        'Ligand tracking service error',
      );
      (mockProteinService.trackLigands as any).mockRejectedValue(serviceError);

      await expect(
        proteinTrackLigandsTool.logic(
          {
            ligandQuery: { type: 'name' as const, value: 'ATP' },
            limit: 25,
            includeBindingSite: false,
          },
          context,
          sdkContext,
        ),
      ).rejects.toThrow(serviceError);
    });

    it('should handle not found errors', async () => {
      const notFoundError = new McpError(
        JsonRpcErrorCode.NotFound,
        'Ligand not found',
      );
      (mockProteinService.trackLigands as any).mockRejectedValue(notFoundError);

      await expect(
        proteinTrackLigandsTool.logic(
          {
            ligandQuery: { type: 'name' as const, value: 'UNKNOWN' },
            limit: 25,
            includeBindingSite: false,
          },
          context,
          sdkContext,
        ),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
      });
    });

    it('should handle unexpected errors', async () => {
      const unexpectedError = new Error('Unexpected error');
      (mockProteinService.trackLigands as any).mockRejectedValue(
        unexpectedError,
      );

      await expect(
        proteinTrackLigandsTool.logic(
          {
            ligandQuery: { type: 'name' as const, value: 'ATP' },
            limit: 25,
            includeBindingSite: false,
          },
          context,
          sdkContext,
        ),
      ).rejects.toThrow('Unexpected error');
    });
  });
});

/**
 * Helper function to create mock ligand tracking result
 */
function createMockLigandResult(
  ligandId: string,
  includeBindingSites: boolean = false,
  structureCount: number = 2,
): TrackLigandsResult {
  const structures = Array.from({ length: structureCount }, (_, i) => ({
    pdbId: `${i + 1}ABC`,
    title: `Test Protein with ${ligandId} ${i + 1}`,
    organism: ['Homo sapiens'],
    resolution: 2.0 + i * 0.5,
    ligandCount: 2 - i,
    ...(includeBindingSites && {
      bindingSites: [
        {
          chain: 'A',
          residues: [
            {
              name: 'LEU',
              number: 42,
              interactions: ['hydrogen-bond'],
            },
            {
              name: 'VAL',
              number: 43,
              interactions: ['hydrophobic'],
            },
          ],
        },
      ],
    }),
  }));

  const ligand: Ligand = {
    name: ligandId === 'ATP' ? 'Adenosine triphosphate' : ligandId,
    chemicalId: ligandId,
    ...(ligandId === 'ATP' && {
      formula: 'C10H16N5O13P3',
      molecularWeight: 507.18,
    }),
  };

  return {
    ligand,
    structures,
    totalCount: structureCount,
  };
}
