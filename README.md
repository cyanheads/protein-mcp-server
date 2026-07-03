<div align="center">
  <h1>@cyanheads/protein-mcp-server</h1>
  <p><b>Federated protein structure & annotation across experimental (PDB) and predicted (AlphaFold) models via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.4.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/protein-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/protein-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/protein-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/protein-mcp-server/releases/latest/download/protein-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=protein-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvcHJvdGVpbi1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22protein-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fprotein-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://protein.caseyjhand.com/mcp](https://protein.caseyjhand.com/mcp)

</div>

---

## Tools

Seven tools spanning the structure-research arc — discover, fetch, find homologs, track ligands, compare, profile the corpus, and annotate — over experimental (PDB) and predicted (AlphaFold) structures from one surface:

| Tool | Description |
|:---|:---|
| `protein_search_structures` | Search experimental and predicted structures by free text, sequence, or organism/method/resolution filters, with optional facet breakdowns. |
| `protein_get_structure` | Fetch metadata and coordinate-file URLs by ID — experimental (PDB), predicted (AlphaFold), or best-available — with batch partial success and optional coordinate inlining. |
| `protein_find_similar` | Find sequence homologs (RCSB mmseqs2) or fold homologs (Foldseek) from a sequence, PDB ID, or UniProt accession. |
| `protein_track_ligands` | Resolve ligand names/formulas to component IDs, find structures containing a ligand, or map binding-site residues. |
| `protein_compare_structures` | Structurally align multiple structures (TM-align / jFATCAT) to a reference or as a full pairwise matrix. |
| `protein_analyze_collection` | Profile the PDB into distributions and trends with server-side facets — counts, histograms, timelines, and cross-tabs. |
| `protein_get_annotations` | Fetch UniProt features and natural variants plus InterPro domain/family memberships with GO terms. |

### `protein_search_structures`

Federated search across experimental (PDB) and predicted (computed-model) structures via RCSB Search v2.

- Free-text, protein-sequence (triggers an mmseqs2 similarity search), and organism / method / resolution filters
- `content_type` scopes the search to `experimental`, `predicted`, or `all`
- Experimental hits are enriched with title, method, resolution, and organism
- Optional `facets` return a method / organism / release-year breakdown alongside the hits at no extra call
- Chain hit IDs straight into `protein_get_structure`

---

### `protein_get_structure`

Fetch structures with metadata and coordinate-file URLs, resolving across providers by `source`.

- `source: experimental` takes PDB entry IDs, batched in one RCSB GraphQL call
- `source: predicted` takes UniProt accessions and returns the AlphaFold model with pLDDT/PAE confidence
- `source: best_available` takes UniProt accessions and returns the top federated model (experimental if one exists, else the best prediction)
- Per-ID partial success — unresolved IDs are listed in `failed[]`, not a batch-level error
- `include_coords` inlines coordinate content; when a batch overflows the response budget it returns a per-structure size outline, so you can re-call with `sections: [ids]` for specific structures
- Every response carries an `attribution` block naming the upstream data licenses and citations (see [Upstream data licensing](#upstream-data-licensing))

---

### `protein_find_similar`

Find structurally or evolutionarily related proteins, by sequence or by fold.

- `by: sequence` runs a synchronous RCSB mmseqs2 search; `by: structure` runs an asynchronous Foldseek search against experimental and predicted databases
- Query from a raw one-letter sequence, a PDB ID, or a UniProt accession
- Foldseek targets default to `pdb100` + `afdb50`; override via `databases` (e.g. `afdb-swissprot`, `BFVD`)
- Async jobs that exceed the poll budget return `status: computing` with a `ticketId` — re-call with `ticket_id` set to that value to poll the same job instead of resubmitting
- Each hit names the engine and source database it came from

---

### `protein_track_ligands`

Ligand discovery and binding-site analysis across the PDB.

- `mode: find_ligand` resolves a name or formula to chemical component IDs with formula, weight, SMILES, and InChIKey
- `mode: structures_with_ligand` returns PDB entries containing a ligand by exact component ID
- `mode: binding_site` returns the protein residues lining a ligand's pocket in a structure, with contact distances
- Binding sites are experimental-only — computed from deposited coordinates (predicted models carry no bound ligands)

---

### `protein_compare_structures`

Structural alignment of multiple structures (up to the configured `PROTEIN_MAX_COMPARE_STRUCTURES` cap) via the RCSB Structural Comparison service.

- Methods: `tm-align`, `fatcat-rigid`, `fatcat-flexible`
- `reference: first` aligns every structure to the first; `reference: all_pairs` computes the full pairwise matrix
- Optional per-structure `chain` restricts the alignment to a single chain
- Each pair is an independent async job, fanned out with a concurrency cap and per-pair partial success — a pair still computing when the budget elapses returns `status: computing` with its job `uuid`, and a failed pair degrades its row without sinking the others
- Re-call with a matching `{ a, b, uuid }` entry in `resume[]` (copied from a prior response's `pairs[]`) to poll a computing pair's job instead of resubmitting
- Returns TM-score, RMSD, and aligned-residue count per pair

---

### `protein_analyze_collection`

Profile the PDB into distributions and trends over an optional scoping query — backed by RCSB's server-side facet engine (one call, compact buckets, no row pull).

- Group by `method`, `organism`, `polymer_type`, `resolution`, `release_year`, or `molecular_weight`
- One `group_by` dimension for a breakdown, or two for a cross-tab (the first nests the second)
- `interval` sets the bin width for value histograms or the period for date histograms (`year` / `month` / `quarter`)
- Scope with a free-text `query`, `organism`, `method`, or `max_resolution`; `content_type` selects the structure universe
- `bucket_limit` caps buckets per dimension; truncation is flagged in the response

---

### `protein_get_annotations`

Sequence and functional annotation for a protein.

- UniProt features (domains, binding sites, PTMs) and natural sequence variants
- InterPro domain/family memberships (Pfam, PROSITE, …) with associated GO terms
- Provide a UniProt accession directly, or a PDB ID — resolved to a UniProt accession via the structure's sequence cross-reference
- A multi-chain PDB entry can map to several accessions; the default is the deterministic lowest-author-chain pick, with the alternatives listed under `ambiguity`. Pass `chain` (an author chain ID, e.g. `A`) to select a specific one
- `include` scopes which annotation classes are fetched: `features`, `domains`, `variants`, or `all`
- Every response carries an `attribution` block naming the upstream data licenses and citations (see [Upstream data licensing](#upstream-data-licensing))

## Resources

| Type | Name | Description |
|:---|:---|:---|
| Resource | `pdb://{entry_id}` | Experimental structure summary for a PDB entry — title, method, resolution, organism, chains, and bound ligands. |
| Resource | `af://{uniprot}` | Predicted-structure summary for a UniProt accession from AlphaFold DB — mean pLDDT, confidence-band fractions, model URLs, and version. |

All resource data is also reachable via tools — `pdb://{entry_id}` mirrors `protein_get_structure` for `source: experimental`, and `af://{uniprot}` mirrors it for `source: predicted`. Many MCP clients are tool-only and don't surface resources; the summaries remain reachable through the tools.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool and resource definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

Protein-specific:

- One federated surface over experimental (PDB) and predicted (AlphaFold / 3D-Beacons) structures — search, fetch, and compare treat both universes the same
- Keyless across every upstream — RCSB, AlphaFold DB, 3D-Beacons, UniProt, InterPro, and Foldseek, no API keys to provision
- Corpus analytics run server-side on RCSB's facet engine — distributions, histograms, and cross-tabs in one call, no row pull and no SQL workspace
- Async alignment and Foldseek jobs poll within a bounded budget and hand back a job ticket (`ticketId` / per-pair `uuid`) instead of blocking — re-call with `ticket_id` or a `resume[]` entry to poll the same job instead of resubmitting

Agent-friendly output:

- Provenance on every response — each hit carries a `source` (`experimental` / `predicted`), the engine and database that produced it, and effective-query / total-count echoes so agents can reason about coverage
- Graceful partial failure — batch fetches and pairwise comparisons return per-item rows (`failed[]`, per-pair `status`) instead of failing the whole request, each with actionable recovery text
- Discriminated output contracts — typed `source` and `status` unions, `computing` results with resume tickets, and budget-overflow outlines let callers branch on data, not string parsing

## Getting started

### Public Hosted Instance

A public instance is available at `https://protein.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "protein": {
      "type": "streamable-http",
      "url": "https://protein.caseyjhand.com/mcp"
    }
  }
}
```

### Self-hosted

Add the following to your MCP client configuration file. No API key is required — every upstream provider is keyless.

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

- [Bun v1.3.2](https://bun.sh/) or higher (or Node.js v24+).
- No accounts or API keys — RCSB, AlphaFold DB, 3D-Beacons, UniProt, InterPro, and Foldseek are all public and keyless.

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

## Configuration

All upstream providers are keyless, so the server runs out of the box with no configuration. Every variable below is optional.

| Variable | Description | Default |
|:---|:---|:---|
| `PROTEIN_ASYNC_POLL_TIMEOUT_MS` | Max wall-clock to poll an async job (alignment / Foldseek) before returning a `computing` result. | `30000` |
| `PROTEIN_MAX_BATCH_IDS` | Cap on IDs accepted by `protein_get_structure` in one batch (1–100). | `25` |
| `PROTEIN_MAX_COMPARE_STRUCTURES` | Cap on structures per `protein_compare_structures` call (2–25). | `10` |
| `PROTEIN_FACET_BUCKET_CAP` | Default cap on buckets per `protein_analyze_collection` dimension (1–500). | `50` |
| `PROTEIN_FANOUT_CONCURRENCY` | Max concurrent upstream requests for per-ID / per-pair fan-out (1–16). | `5` |
| `RCSB_SEARCH_BASE_URL` | Base URL for the RCSB Search API v2. | `https://search.rcsb.org` |
| `ALPHAFOLD_BASE_URL` | Base URL for the AlphaFold Protein Structure Database API. | `https://alphafold.ebi.ac.uk` |
| `FOLDSEEK_BASE_URL` | Base URL for the Foldseek structural-similarity search service. | `https://search.foldseek.com` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of provider base-URL overrides and tuning limits.

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
docker run --rm -e MCP_TRANSPORT_TYPE=http -p 3010:3010 protein-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/protein-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools/resources and inits the provider services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `src/services` | Provider service layer — RCSB, AlphaFold, 3D-Beacons, UniProt, InterPro, Foldseek, and shared HTTP/identifier helpers. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`/`AGENTS.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## Upstream data licensing

Structure and annotation data comes from public upstream databases, each under its own license. `protein_get_structure` and `protein_get_annotations` carry an `attribution` block on every response — the license, citation, and homepage for each source that contributed to that specific response — so the attribution obligation travels with the data to downstream consumers rather than living only here. CC BY / CC BY-SA sources require attribution on redistribution; CC0 sources are citation-only (attribution encouraged, not required).

| Source | Contributes to | License |
|:---|:---|:---|
| [RCSB PDB](https://www.rcsb.org/) | `protein_get_structure` — experimental records | CC0 1.0 Universal |
| [AlphaFold DB](https://alphafold.ebi.ac.uk/) | `protein_get_structure` — predicted models | CC BY 4.0 |
| [SWISS-MODEL](https://swissmodel.expasy.org/) | `protein_get_structure` — `best_available` models | CC BY-SA 4.0 |
| [BFVD](https://bfvd.steineggerlab.workers.dev/) | `protein_get_structure` — `best_available` models | CC BY 4.0 |
| [UniProt](https://www.uniprot.org/) | `protein_get_annotations` | CC BY 4.0 |
| [InterPro](https://www.ebi.ac.uk/interpro/) | `protein_get_annotations` — domain/family data | CC0 1.0 Universal |
| [GO](https://geneontology.org/) | `protein_get_annotations` — GO terms | CC BY 4.0 |

`best_available` federates predicted models through [3D-Beacons](https://3d-beacons.org/), so the `attribution` block credits the actual contributing provider (AlphaFold DB, SWISS-MODEL, BFVD, …); a provider without a curated license entry carries a `See provider terms` fallback pointing back to 3D-Beacons rather than a fabricated license. InterPro's own domain/family classifications are CC0; the GO terms carried alongside them are separately CC BY 4.0, so each is credited independently only when it actually contributes. Full citations for each source travel in the `attribution` block of the relevant tool responses. This covers upstream *data* licensing — the server's own code is licensed separately (see [License](#license)).

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
