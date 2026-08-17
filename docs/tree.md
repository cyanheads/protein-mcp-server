# protein-mcp-server - Directory Structure

Generated on: 2026-08-17 02:04:40

```text
protein-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.2.x/
│   ├── 0.3.x/
│   ├── 0.4.x/
│   ├── 0.5.x/
│   └── template.md
├── docs/
│   ├── design.md
│   └── idea.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   └── tree.ts
├── skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── af-summary.resource.ts
│   │   │       ├── index.ts
│   │   │       └── pdb-summary.resource.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── _schemas.ts
│   │           ├── analyze-collection.tool.ts
│   │           ├── compare-structures.tool.ts
│   │           ├── find-similar.tool.ts
│   │           ├── get-annotations.tool.ts
│   │           ├── get-structure.tool.ts
│   │           ├── index.ts
│   │           ├── search-structures.tool.ts
│   │           └── track-ligands.tool.ts
│   ├── services/
│   │   ├── alignment/
│   │   │   └── alignment-service.ts
│   │   ├── alphafold/
│   │   │   └── alphafold-service.ts
│   │   ├── beacons/
│   │   │   └── beacons-service.ts
│   │   ├── foldseek/
│   │   │   └── foldseek-service.ts
│   │   ├── rcsb/
│   │   │   ├── facets.ts
│   │   │   ├── rcsb-service.ts
│   │   │   └── types.ts
│   │   ├── shared/
│   │   │   ├── async.ts
│   │   │   ├── attribution.ts
│   │   │   ├── http.ts
│   │   │   └── identifiers.ts
│   │   └── uniprot/
│   │       └── uniprot-service.ts
│   └── index.ts
├── tests/
│   ├── config/
│   │   └── server-config.test.ts
│   ├── resources/
│   │   ├── af-summary.resource.test.ts
│   │   └── pdb-summary.resource.test.ts
│   ├── services/
│   │   ├── alignment/
│   │   │   └── alignment-service.test.ts
│   │   ├── alphafold/
│   │   │   └── alphafold-service.test.ts
│   │   ├── beacons/
│   │   │   └── beacons-service.test.ts
│   │   ├── foldseek/
│   │   │   └── foldseek-service.test.ts
│   │   ├── rcsb/
│   │   │   ├── facets.test.ts
│   │   │   ├── rcsb-normalizers.test.ts
│   │   │   └── rcsb-service.test.ts
│   │   ├── shared/
│   │   │   ├── async.test.ts
│   │   │   ├── http.test.ts
│   │   │   └── identifiers.test.ts
│   │   └── uniprot/
│   │       └── uniprot-service.test.ts
│   └── tools/
│       ├── _schemas.test.ts
│       ├── analyze-collection.tool.test.ts
│       ├── compare-structures.tool.test.ts
│       ├── find-similar.tool.test.ts
│       ├── get-annotations.tool.test.ts
│       ├── get-structure.tool.test.ts
│       ├── search-structures.tool.test.ts
│       └── track-ligands.tool.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
