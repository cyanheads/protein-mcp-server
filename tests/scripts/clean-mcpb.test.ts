/**
 * @fileoverview Agent-doc selector shared by `scripts/clean-mcpb.ts` (the
 * bundle strip step) and `scripts/lint-packaging.ts` (check 8). Asserts the MCP
 * SDK's Skills extension runtime, as installed, survives both, while
 * package-root agent docs are still selected (mcp-ts-core #794).
 * @module tests/scripts/clean-mcpb.test
 */

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY, filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

/**
 * `lint-packaging.ts` falls back to a repository-only `import()` the server's
 * `tsc` program cannot resolve (mcp-ts-core #797), so it loads by URL at run
 * time and stays out of the typecheck.
 */
const lintPackaging: {
  AGENT_DOC_ENTRY: RegExp;
  checkBundleEntries(entries: string[], bundleLabel: string): string[];
} = await import(new URL('../../scripts/lint-packaging.ts', import.meta.url).href);

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Every file under an installed `node_modules/` directory, as bundle entry paths. */
function installedEntries(dir: string): string[] {
  return readdirSync(`${repoRoot}${dir}`, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `${entry.parentPath.slice(repoRoot.length)}/${entry.name}`);
}

const sdkSkillsRuntime = [
  ...installedEntries('node_modules/@modelcontextprotocol/server/dist/ext/skills'),
  ...installedEntries('node_modules/@modelcontextprotocol/core/dist/ext/skills'),
];

describe('AGENT_DOC_ENTRY', () => {
  it('is the same selector in clean-mcpb.ts and lint-packaging.ts', () => {
    expect(lintPackaging.AGENT_DOC_ENTRY.source).toBe(AGENT_DOC_ENTRY.source);
    expect(lintPackaging.AGENT_DOC_ENTRY.flags).toBe(AGENT_DOC_ENTRY.flags);
  });

  it('keeps the installed MCP SDK Skills extension runtime', () => {
    expect(sdkSkillsRuntime).toContain(
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    );
    expect(sdkSkillsRuntime).toContain(
      'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
    );
    expect(filterAgentDocEntries(sdkSkillsRuntime)).toEqual([]);
    expect(lintPackaging.checkBundleEntries(sdkSkillsRuntime, 'test.mcpb')).toEqual([]);
  });

  it('keeps runtime skills/ paths below a package root, scoped or nested', () => {
    const runtime = [
      'node_modules/some-pkg/dist/skills/index.js',
      'node_modules/@scope/pkg/lib/.claude/loader.js',
      'node_modules/outer/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
      'node_modules/@scope/skills/index.js',
      'node_modules/@scope/skills/dist/index.js',
    ];
    expect(filterAgentDocEntries(runtime)).toEqual([]);
  });

  it('selects agent docs at a package root, scoped or nested, and stray SKILL.md files', () => {
    const docs = [
      'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
      'node_modules/dotenv/skills/dotenv/SKILL.md',
      'node_modules/some-pkg/skills/guide/references/notes.md',
      'node_modules/some-pkg/.claude/settings.json',
      'node_modules/@scope/pkg/.agents/skills/x/SKILL.md',
      'node_modules/outer/node_modules/inner/skills/a/SKILL.md',
      'node_modules/outer/node_modules/@scope/inner/framework-skills/a/SKILL.md',
      'node_modules/some-pkg/docs/SKILL.md',
    ];
    expect(filterAgentDocEntries(docs)).toEqual(docs);
    expect(lintPackaging.checkBundleEntries(docs, 'test.mcpb')).toHaveLength(1);
  });

  it('never selects the bundle root', () => {
    expect(
      filterAgentDocEntries([
        'skills/protein-guide/SKILL.md',
        'framework-skills/add-tool/SKILL.md',
      ]),
    ).toEqual([]);
  });
});
