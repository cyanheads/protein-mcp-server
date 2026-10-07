<div align="center">
  <h1>@cyanheads/protein-mcp-server</h1>
  <p><b>Federated protein structure & annotation across experimental (PDB) and predicted (AlphaFold) models via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.8.5-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/protein-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.2.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/protein-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/protein-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/protein-mcp-server/releases/latest/download/protein-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=protein-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvcHJvdGVpbi1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22protein-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fprotein-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://protein.caseyjhand.com/mcp](https://protein.caseyjhand.com/mcp)

</div>

---

## Overview

Experimental (PDB) and predicted (AlphaFold) protein structures behind one surface. Search, fetch, align, and annotate structures and their ligands across RCSB, AlphaFold DB, 3D-Beacons, UniProt, InterPro, and Foldseek, all keyless. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `protein_search_structures` | Search experimental and predicted structures by text, sequence, or organism/method/resolution, with optional facets |
| `protein_get_structure` | Fetch metadata and coordinate URLs for experimental, predicted, or best-available structures |
| `protein_find_similar` | Find sequence homologs (RCSB mmseqs2) or fold homologs (Foldseek) |
| `protein_track_ligands` | Resolve ligands to component IDs, find structures containing one, or map its binding site |
| `protein_compare_structures` | Align structures with TM-align or jFATCAT, against a reference or all pairs |
| `protein_analyze_collection` | Profile the PDB as counts, histograms, timelines, and cross-tabs |
| `protein_get_annotations` | Fetch UniProt features and variants plus InterPro domains with GO terms |

### Resources

| Resource | Description |
|:---|:---|
| `pdb://{entry_id}` | Experimental structure summary for a PDB entry |
| `af://{uniprot}` | AlphaFold DB predicted-structure summary for a UniProt accession |

Both resources are also reachable through `protein_get_structure`, for clients that don't surface resources.

## Capability reference

### `protein_search_structures` <sub>tool</sub>

- At least one of `query`, `sequence` (an mmseqs2 search; `min_identity` / `max_evalue` apply only with it), `organism`, `method`, or `max_resolution`; `content_type` is `experimental`, `predicted`, or `all` (default); up to 100 hits per page (default 25) via `limit` / `start`
- Each hit names its `source` and a chainable entry `id` (sequence hits add `entityId`); experimental hits carry title, method, resolution, and organism, AlphaFold models their `uniprotAccession`
- Optional `facets` (`method`, `organism`, `polymer_type`, `resolution`, `release_year`, `molecular_weight`) add a flat breakdown capped at `PROTEIN_FACET_BUCKET_CAP` buckets per dimension; for non-sequence searches, `protein_analyze_collection` reaches the long tail

---

### `protein_get_structure` <sub>tool</sub>

- `source: experimental` (default) takes PDB entry IDs and the `AF_*` / `MA_*` computed-model IDs search returns (these come back as `source: predicted`); `predicted` takes UniProt accessions for AlphaFold models with pLDDT/PAE; `best_available` takes UniProt accessions and returns the highest-resolution experimental structure, else the best prediction. Up to `PROTEIN_MAX_BATCH_IDS` IDs per call (default 25)
- Unresolved IDs land in `failed[]`, and `requested` / `processed` show IDs dropped past the cap; the call fails as `all_failed` when nothing resolves and `mixed_id_types` when the IDs don't fit `source`. Experimental-source records add `polymerEntities`, `ligands`, `molecularWeight`, and `releaseDate`, and `coordinateUrls` lists only files that exist
- `include_coords` inlines coordinate text within a response budget; an over-budget batch returns an `overflow` size outline to re-call with `sections: [ids]`, and a lone oversized file is withheld in favor of its `coordinateUrls`

---

### `protein_find_similar` <sub>tool</sub>

- `by: sequence` runs a synchronous RCSB mmseqs2 search from `sequence`, `pdb_id`, or `uniprot`, filtered by `max_evalue` / `min_identity`; `by: structure` runs an async Foldseek search from `pdb_id` or `uniprot` against `pdb100` + `afdb50` unless `databases` says otherwise. A field only the other mode reads fails as `mode_mismatched_field`; up to 100 hits per page (default 25)
- Hits name their `source` and, for structure hits, the `database`, ranked by `score` across all searched databases; responses report `totalCount` and `nextStart`
- A structure job still running at the poll budget returns `status: computing` with a `ticketId`; re-call with `ticket_id` to resume it or re-page a finished job. A multichain structure is one query per chain: each response covers `query` (0-based, default 0) out of `queryCount`

---

### `protein_track_ligands` <sub>tool</sub>

- `mode` is `find_ligand` (`query`: a name or formula), `structures_with_ligand` (`comp_id`), or `binding_site` (`pdb_id`, optional `comp_id`); a missing mode input fails as `missing_param`. `limit` is 1–100 (default 25), and `start` pages the last two modes
- `find_ligand` returns component IDs with formula, weight, SMILES, and InChIKey, ranked by `depositionCount`, with `totalCount` and `candidatesConsidered` showing when the candidate pool was cut short; `structures_with_ligand` lists entries highest resolution first
- `binding_site` returns pocket residues with contact distances, numbered in both label (`asymId`, `seqId`) and author (`authAsymId`, `authSeqId`) namespaces; it works on experimental structures only

---

### `protein_compare_structures` <sub>tool</sub>

- 2 structures up to `PROTEIN_MAX_COMPARE_STRUCTURES` (default 10, max 25), each a `pdb_id` with an optional label-namespace `chain`; `method` is `tm-align` (default), `fatcat-rigid`, or `fatcat-flexible`; `reference` is `first` (default) or `all_pairs`; `timeout_s` (5–120) sets the per-pair poll budget
- Each pair row has a `status` (`complete`, `computing`, `failed`), `tmScore`, `rmsd`, `alignedResidues`, and `[a, b]`-ordered `modeledResidues` and `coverage`; TM-score is normalized by `a`'s length, so reversing a pair changes it
- A computing pair returns its job `uuid`; re-call with `{ a, b, uuid }` in `resume[]` to poll it instead of resubmitting. A resume under a different `method` or for another pair fails as `resume_method_mismatch` or `resume_job_mismatch`

---

### `protein_analyze_collection` <sub>tool</sub>

- `group_by` takes one of `method`, `organism`, `polymer_type`, `resolution`, `release_year`, `molecular_weight`, or two distinct ones for a cross-tab; scope with `query`, `organism`, `method`, `max_resolution`, and `content_type` (default `experimental`). `interval` sets a numeric bin width for `resolution` / `molecular_weight` or `"year"` for `release_year`
- Returns `total` and `bucketsReturned`; buckets carry `label` and `count` (numeric bins add `rangeFrom` / `rangeTo`), and every dimension reports `missingValueCount`
- `bucket_limit` (1–500, default `PROTEIN_FACET_BUCKET_CAP`) caps each dimension level separately, so a cross-tab can return `bucket_limit × (1 + bucket_limit)` buckets; `truncated` and `notice` name the capped positions

---

### `protein_get_annotations` <sub>tool</sub>

- A `uniprot` accession, or a `pdb_id` resolved through its UniProt cross-reference (author `chain` picks one accession); `include` is `features`, `domains`, `variants`, or `all` (default); `limit` caps each class separately (1–200, default 50)
- Returns UniProt features and natural variants plus InterPro domains with GO terms; a PDB entry mapping to several accessions defaults to the lowest author chain and lists the rest in `ambiguity`
- Capped classes set `truncated` and are named in `notice`; failures are typed as `missing_identifier`, `invalid_accession`, `no_uniprot_mapping`, or `chain_not_found`

---

### `pdb://{entry_id}` <sub>resource</sub>

- `entry_id` is a PDB entry ID (e.g. `4HHB`); returns `application/json` with title, methods, resolution, organisms, ligands, and `polymerEntities` carrying both `authAsymIds` and `labelAsymIds`
- Same data as `protein_get_structure` with `source: experimental`

---

### `af://{uniprot}` <sub>resource</sub>

- `uniprot` is a UniProt accession or an AlphaFold DB entry ID (e.g. `AF-P69905-F1`); returns `application/json` with `meanPlddt`, `confidenceBuckets`, `cifUrl` / `pdbUrl` / `bcifUrl`, and `modelVersion`
- Same data as `protein_get_structure` with `source: predicted`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

PDB / AlphaFold-specific:

- Search, fetch, and comparison treat experimental (PDB) and predicted (AlphaFold DB, ModelArchive, 3D-Beacons providers) structures the same way
- Keyless across RCSB, AlphaFold DB, 3D-Beacons, UniProt, InterPro, and Foldseek
- Collection analytics run on RCSB's facet engine and return bucket counts, not matching entries
- Foldseek and alignment jobs poll for up to `PROTEIN_ASYNC_POLL_TIMEOUT_MS` (default 30 s), then hand back a resume handle (`ticketId`, per-pair `uuid`) instead of blocking
- Chain namespaces stay separate: `authAsymIds` feed `protein_get_annotations` `chain`, `labelAsymIds` feed `protein_compare_structures` `chain`

Agent-friendly output:

- Provenance: every hit names its `source` (`experimental` / `predicted`) and the engine or database behind it, and `protein_get_structure` and `protein_get_annotations` carry an `attribution` block (see [Upstream data licensing](#upstream-data-licensing))
- Graceful partial failure: `failed[]` rows and per-pair `status` keep one bad ID or pair from failing the request
- Paging and advisories: paged tools return `totalCount` and `nextStart`, a `start` past the end is flagged in `notice` separately from zero matches, and every advisory joins into that one `notice`

## Getting started

### Public Hosted Instance

A public instance is available at `https://protein.caseyjhand.com/mcp`, no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "protein-mcp-server": {
      "type": "streamable-http",
      "url": "https://protein.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file. No API key is needed.

```json
{
  "mcpServers": {
    "protein-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/protein-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "protein-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/protein-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "protein-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/protein-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No accounts or API keys: every upstream is public.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/protein-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd protein-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment (optional):**

```sh
cp .env.example .env
# every variable has a working default
```

## Configuration

Every variable is optional.

| Variable | Description | Default |
|:---|:---|:---|
| `PROTEIN_ASYNC_POLL_TIMEOUT_MS` | Poll budget for an async alignment or Foldseek job before it returns `computing` (min 1000). | `30000` |
| `PROTEIN_MAX_BATCH_IDS` | Max IDs per `protein_get_structure` call (1–100). | `25` |
| `PROTEIN_MAX_COMPARE_STRUCTURES` | Max structures per `protein_compare_structures` call (2–25). | `10` |
| `PROTEIN_FACET_BUCKET_CAP` | Buckets per dimension for `protein_search_structures` facets, and the `protein_analyze_collection` default (1–500). | `50` |
| `PROTEIN_FANOUT_CONCURRENCY` | Max concurrent upstream requests for per-ID and per-pair fan-out (1–16). | `5` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. Overrides the `stateless` mode the server declares in code. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

Each upstream's base URL can also be pointed at a mirror: `RCSB_SEARCH_BASE_URL`, `RCSB_DATA_BASE_URL`, `RCSB_FILES_BASE_URL`, `RCSB_MODELS_BASE_URL`, `RCSB_ALIGNMENT_BASE_URL`, `BEACONS_BASE_URL`, `ALPHAFOLD_BASE_URL`, `MODELARCHIVE_BASE_URL`, `FOLDSEEK_BASE_URL`, `UNIPROT_BASE_URL`, `INTERPRO_BASE_URL`. See [`.env.example`](./.env.example) for their defaults and the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t protein-mcp-server .
docker run --rm -p 3010:3010 protein-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/protein-mcp-server`. OpenTelemetry peer dependencies are installed by default; build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point: registers tools and resources, inits the provider services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) and shared schemas (`_schemas.ts`). |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `src/services` | Upstream clients: `rcsb/` (search, data, facets), `alphafold/`, `beacons/` (3D-Beacons), `uniprot/` (UniProt, InterPro, GO), `alignment/` (RCSB Structural Comparison), `foldseek/`, and `shared/` HTTP, concurrency, identifier, and attribution helpers. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`/`AGENTS.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Export new definitions from the barrels in `src/mcp-server/*/definitions/index.ts` and register them in the `createApp()` arrays in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Upstream data licensing

Structure and annotation data comes from public databases, each under its own license. `protein_get_structure` and `protein_get_annotations` return an `attribution` block with the license, citation, and homepage of every source that contributed to that response. CC BY and CC BY-SA sources require attribution on redistribution; CC0 sources ask only for citation.

| Source | Contributes to | License |
|:---|:---|:---|
| [RCSB PDB](https://www.rcsb.org/) | `protein_get_structure` — experimental records | CC0 1.0 Universal |
| [AlphaFold DB](https://alphafold.ebi.ac.uk/) | `protein_get_structure` — predicted models | CC BY 4.0 |
| [ModelArchive](https://www.modelarchive.org/) | `protein_get_structure` — `MA_*` computed models | CC BY 4.0 |
| [SWISS-MODEL](https://swissmodel.expasy.org/) | `protein_get_structure` — `best_available` models | CC BY-SA 4.0 |
| [BFVD](https://bfvd.steineggerlab.workers.dev/) | `protein_get_structure` — `best_available` models | CC BY 4.0 |
| [UniProt](https://www.uniprot.org/) | `protein_get_annotations` | CC BY 4.0 |
| [InterPro](https://www.ebi.ac.uk/interpro/) | `protein_get_annotations` — domain/family data | CC0 1.0 Universal |
| [GO](https://geneontology.org/) | `protein_get_annotations` — GO terms | CC BY 4.0 |

`best_available` models arrive through [3D-Beacons](https://3d-beacons.org/), so the block credits the provider that actually supplied the model; a provider with no curated entry gets a `See provider terms` fallback instead of a guessed license. InterPro and GO are credited separately, each only when it contributes. This table covers upstream data; the server's own code is licensed separately (see [License](#license)).

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
