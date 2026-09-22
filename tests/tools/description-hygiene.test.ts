/**
 * @fileoverview Surface-wide invariant: every description a client renders from
 * `tools/list` and the resource listings states the caller-facing contract. No
 * tool or resource description, input/output/enrichment `.describe()` (at any
 * nesting depth), or resource param/output `.describe()` may name its reader,
 * leak how the server is wired, or coach the reader on using the output.
 * @module tests/tools/description-hygiene.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import * as resourceDefinitions from '@/mcp-server/resources/definitions/index.js';
import * as toolDefinitions from '@/mcp-server/tools/definitions/index.js';

/**
 * Full phrases, matched case-insensitively. Bare "agent" or "model" would
 * collide with the domain ("AlphaFold model"), so each entry is a phrase that
 * only ever reads as a leak.
 */
const BANNED_TERMS = [
  // reader-specific phrasing — the description shouldn't name who's reading it
  'an agent',
  'the agent',
  'the llm',
  'claude',
  // implementation/routing detail — how the server is wired, not what it returns
  'one call',
  'no row pull',
  'no sql',
  'at no extra call',
  'batched in one call',
  'entry endpoint',
  'concurrency cap',
  'fanned out',
  // meta-coaching — directives about how to use the output
  'treat this as',
  'treat it as',
  'callers should',
  'the caller should',
  'the reader should',
];

type Surface = 'description' | 'input' | 'output' | 'enrichment' | 'params';

interface Probe {
  owner: string;
  path: string;
  surface: Surface;
  text: string;
}

/** Every `description` string in a JSON Schema tree, at any depth. */
function* descriptionsIn(node: unknown, path: string): Generator<[string, string]> {
  if (Array.isArray(node)) {
    for (const [i, child] of node.entries()) yield* descriptionsIn(child, `${path}[${i}]`);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'description' && typeof value === 'string') yield [path, value];
    else yield* descriptionsIn(value, `${path}.${key}`);
  }
}

function* schemaProbes(
  owner: string,
  surface: Surface,
  schema: z.ZodType | undefined,
): Generator<Probe> {
  if (!schema) return;
  for (const [path, text] of descriptionsIn(z.toJSONSchema(schema), surface)) {
    yield { owner, surface, path, text };
  }
}

interface DescribedDefinition {
  description?: string;
  enrichment?: z.ZodRawShape;
  input?: z.ZodType;
  output?: z.ZodType;
  params?: z.ZodType;
  title?: string;
}

function* definitionProbes(owner: string, def: DescribedDefinition): Generator<Probe> {
  for (const [path, text] of [
    ['title', def.title],
    ['description', def.description],
  ] as const) {
    if (typeof text === 'string') yield { owner, surface: 'description', path, text };
  }
  yield* schemaProbes(owner, 'input', def.input);
  yield* schemaProbes(owner, 'params', def.params);
  yield* schemaProbes(owner, 'output', def.output);
  yield* schemaProbes(owner, 'enrichment', def.enrichment && z.object(def.enrichment));
}

/** Collect every emitted description across the given tool and resource definitions. */
function collectProbes(
  tools: Record<string, { name: string } & DescribedDefinition>,
  resources: Record<string, { name?: string } & DescribedDefinition>,
): Probe[] {
  return [
    ...Object.values(tools).flatMap((t) => [...definitionProbes(t.name, t)]),
    ...Object.entries(resources).flatMap(([key, r]) => [...definitionProbes(r.name ?? key, r)]),
  ];
}

function leaks(probe: Probe): string[] {
  const text = probe.text.toLowerCase();
  return BANNED_TERMS.filter((term) => text.includes(term));
}

const tools = toolDefinitions as unknown as Record<string, { name: string } & DescribedDefinition>;
const resources = resourceDefinitions as unknown as Record<
  string,
  { name?: string } & DescribedDefinition
>;
const probes = collectProbes(tools, resources);

describe('description hygiene', () => {
  it('covers all 7 tools and both resources', () => {
    expect(Object.keys(tools)).toHaveLength(7);
    expect(Object.keys(resources)).toHaveLength(2);
    const owners = new Set(probes.map((p) => p.owner));
    expect(owners.size).toBe(9);
  });

  it('reaches every emitted surface — a surface yielding no probes would pass vacuously', () => {
    const count = (surface: Surface, owner?: string) =>
      probes.filter((p) => p.surface === surface && (!owner || p.owner === owner)).length;

    for (const tool of Object.values(tools)) {
      expect(count('description', tool.name), `${tool.name} description`).toBe(2);
      expect(count('input', tool.name), `${tool.name} input`).toBeGreaterThan(0);
      expect(count('output', tool.name), `${tool.name} output`).toBeGreaterThan(0);
      if (tool.enrichment) {
        expect(count('enrichment', tool.name), `${tool.name} enrichment`).toBeGreaterThan(0);
      }
    }
    for (const [key, resource] of Object.entries(resources)) {
      const owner = resource.name ?? key;
      expect(count('description', owner), `${owner} description`).toBe(2);
      expect(count('params', owner), `${owner} params`).toBeGreaterThan(0);
      expect(count('output', owner), `${owner} output`).toBeGreaterThan(0);
    }
    // Nesting depth: array items inside array items (analyze_collection's cross-tab
    // child buckets) and object-in-array-in-object paths are walked, not just the root.
    expect(
      probes.some((p) => p.path.includes('child.properties.buckets.items.properties.rangeTo')),
    ).toBe(true);
    // Union members (analyze_collection interval anyOf) are walked too.
    expect(probes.some((p) => p.path.includes('anyOf[1]'))).toBe(true);
  });

  it('flags a banned phrase at any depth of a planted definition', () => {
    const planted = collectProbes(
      {
        t: {
          name: 'planted_tool',
          description: 'Fine.',
          input: z.object({
            deep: z.array(z.object({ x: z.string().describe('Served by the entry endpoint.') })),
          }),
          output: z.object({ ok: z.string().describe('Fine.') }),
          enrichment: { notice: z.string().describe('Callers should retry.') },
        },
      },
      {
        r: {
          name: 'planted_resource',
          description: 'Lets an agent cite it.',
          params: z.object({ id: z.string().describe('Fine.') }),
          output: z.object({ ok: z.string().describe('Aggregated in one call.') }),
        },
      },
    );
    const flagged = planted
      .filter((p) => leaks(p).length > 0)
      .map((p) => `${p.owner}:${p.surface}`);
    expect(flagged.sort()).toEqual([
      'planted_resource:description',
      'planted_resource:output',
      'planted_tool:enrichment',
      'planted_tool:input',
    ]);
  });

  it.each(probes.map((p) => [`${p.owner} ${p.path}`, p] as const))(
    '%s names no reader, wiring detail, or coaching',
    (_label, probe) => {
      expect(leaks(probe), probe.text).toEqual([]);
    },
  );
});
