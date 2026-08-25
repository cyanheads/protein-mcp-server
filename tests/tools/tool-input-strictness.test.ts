/**
 * @fileoverview Surface-wide invariant: every tool input object is strict, so an
 * undeclared root-level argument key is rejected by name instead of silently
 * stripped. Covers the emitted JSON Schema (`additionalProperties: false`, drawn
 * against 2020-12) alongside the parse behavior, and pins the root-level-only
 * scope — a nested object inside an input still strips.
 * @module tests/tools/tool-input-strictness.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { compareStructures } from '@/mcp-server/tools/definitions/compare-structures.tool.js';
import * as toolDefinitions from '@/mcp-server/tools/definitions/index.js';

const tools = Object.values(toolDefinitions);

describe('tool input strictness', () => {
  it('covers every registered tool', () => {
    expect(tools).toHaveLength(7);
  });

  it.each(tools.map((t) => [t.name, t] as const))(
    '%s rejects an undeclared root key by name',
    (_name, definition) => {
      const result = definition.input.safeParse({ notAToolArgument: 'x' });
      expect(result.success).toBe(false);
      if (result.success) return;
      const unrecognized = result.error.issues.find((i) => i.code === 'unrecognized_keys');
      expect(unrecognized).toBeDefined();
      expect(JSON.stringify(unrecognized)).toContain('notAToolArgument');
    },
  );

  it.each(tools.map((t) => [t.name, t] as const))(
    '%s advertises additionalProperties:false under 2020-12',
    (_name, definition) => {
      const schema = z.toJSONSchema(definition.input, { io: 'input' }) as {
        $schema?: string;
        additionalProperties?: unknown;
      };
      expect(schema.additionalProperties).toBe(false);
      expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    },
  );

  it('still strips an undeclared key nested inside an input object', () => {
    const parsed = compareStructures.input.safeParse({
      structures: [{ pdb_id: '1A00', notAStructureField: 'x' }, { pdb_id: '2HHB' }],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.structures[0]).toEqual({ pdb_id: '1A00' });
  });
});
