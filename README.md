<div align="center">
  <h1>@cyanheads/protein-mcp-server</h1>
  <p><b>Federated protein structure & annotation across experimental (PDB) and predicted (AlphaFold) models via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.8.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/protein-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/protein-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/protein-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

Experimental (PDB) and predicted (AlphaFold) protein structures, federated behind one surface. Search, fetch, align, compare, and annotate structures and their ligands across RCSB, AlphaFold DB, 3D-Beacons, UniProt, InterPro, and Foldseek — all keyless. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `protein_search_structures` | Search experimental and predicted structures by free text, sequence, or organism/method/resolution filters, with optional facet breakdowns. |
| `protein_get_structure` | Fetch metadata and coordinate-file URLs by ID — experimental (PDB), predicted (AlphaFold), or best-available — with batch partial success and optional coordinate inlining. |
| `protein_find_similar` | Find sequence homologs (RCSB mmseqs2) or fold homologs (Foldseek) from a sequence, PDB ID, or UniProt accession. |
| `protein_track_ligands` | Resolve ligand names/formulas to component IDs, find structures containing a ligand, or map binding-site residues. |
| `protein_compare_structures` | Structurally align multiple structures (TM-align / jFATCAT) to a reference or as a full pairwise matrix. |
| `protein_analyze_collection` | Profile the PDB into distributions and trends with server-side facets — counts, histograms, timelines, and cross-tabs. |
| `protein_get_annotations` | Fetch UniProt features and natural variants plus InterPro domain/family memberships with GO terms. |

### Resources

| Resource | Description |
|:---|:---|
| `pdb://{entry_id}` | Experimental structure summary for a PDB entry — title, method, resolution, organism, bound ligands, and per-entity chain IDs in both the author (`authAsymIds`) and mmCIF label (`labelAsymIds`) namespaces. |
| `af://{uniprot}` | Predicted-structure summary for a UniProt accession from AlphaFold DB — mean pLDDT, confidence-band fractions, model URLs, and version. |

All resource data is also reachable via tools — `pdb://{entry_id}` mirrors `protein_get_structure` for `source: experimental`, and `af://{uniprot}` mirrors it for `source: predicted`. Many MCP clients are tool-only and don't surface resources; the summaries remain reachable through the tools.

## Capability reference

### `protein_search_structures` <sub>tool</sub>

- Free-text, protein-sequence (triggers an mmseqs2 similarity search), and organism / method / resolution filters
- `content_type` scopes the search to `experimental`, `predicted`, or `all` (default) — `all` is a genuine union, so computed models appear alongside PDB entries
- Every hit names its `source`; experimental sequence hits expose a chainable PDB entry `id` plus the matched polymer `entityId`, with title, method, resolution, and organism enrichment; computed models retain their complete model ID and parsed UniProt accession
- `start` and `limit` page through ranked results; `nextStart` is returned while another page remains
- Optional `facets` return a method / organism / release-year breakdown alongside the hits — each dimension may be listed once and reports how many matches carry no value for it; a capped dimension is named in `notice`, with `protein_analyze_collection` (larger `bucket_limit`) as the route to the long tail
- Chain hit IDs straight into `protein_get_structure`

---

### `protein_get_structure` <sub>tool</sub>

- `source: experimental` batches PDB entry IDs (also resolving computed-model IDs like `AF_*`/`MA_*` from search, tagged `source: predicted` with their provider); `source: predicted` takes UniProt accessions for AlphaFold models with pLDDT/PAE; `source: best_available` takes UniProt accessions and returns the top federated model (highest-resolution experimental if one exists, else the best prediction)
- Per-ID partial success — unresolved IDs land in `failed[]`; `requested`/`processed` disclose IDs dropped beyond the batch cap, and every advisory (cap, failure, overflow) joins into one `notice`
- Records served by the RCSB entry endpoint also carry `polymerEntities` (both `authAsymIds` and `labelAsymIds`), `ligands`, `molecularWeight`, and `releaseDate`
- `include_coords` inlines coordinate content, subject to a response budget — an over-budget batch returns a per-structure size outline (re-call with `sections: [ids]`), and a single oversized file is withheld with a pointer to its `coordinateUrls`
- Every response carries an `attribution` block naming upstream data licenses and citations

---

### `protein_find_similar` <sub>tool</sub>

- `by: sequence` runs a synchronous RCSB mmseqs2 search; `by: structure` runs an asynchronous Foldseek search against experimental and predicted databases — query from a raw sequence, a PDB ID, or a UniProt accession
- Both modes accept `start`/`limit` and report `totalCount`, echoing `start` and returning `nextStart` while another page remains
- Foldseek targets default to `pdb100` + `afdb50`; override via `databases` (e.g. `afdb-swissprot`, `BFVD`)
- An async job that exceeds the poll budget returns `status: computing` with a `ticketId` — re-call with `ticket_id` to resume; a completed structure search returns the same ticket so a new `start` pages the finished job
- Each mode reads only its own controls (`sequence`, `max_evalue`, `min_identity` under `by: sequence`; `ticket_id`, `databases` under `by: structure`) — a field the selected mode can't consume is rejected, not ignored
- Each hit names the engine and source database it came from

---

### `protein_track_ligands` <sub>tool</sub>

- `mode: find_ligand` resolves a name or formula to chemical component IDs with formula, weight, SMILES, and InChIKey — ranked by deposition frequency, most-common match first
- A formula-shaped `query` matches on exact composition, spaced (`C29 H31 N7 O`) or unspaced; anything else (a component ID included) matches on name and synonyms
- `mode: structures_with_ligand` returns PDB entries containing a ligand by exact component ID, with `start`/`limit` paging and `nextStart` while another page remains
- `mode: binding_site` returns the protein residues lining a ligand's pocket in a structure, with contact distances
- Binding sites are experimental-only — computed from deposited coordinates; predicted models carry no bound ligands

---

### `protein_compare_structures` <sub>tool</sub>

- Aligns 2 to the configured cap (default 10, max 25) structures per call, via `tm-align`, `fatcat-rigid`, or `fatcat-flexible`; optional per-structure `chain` restricts the alignment to a single mmCIF label chain
- `reference: first` aligns every structure to the first; `reference: all_pairs` computes the full pairwise matrix; a structure repeated in `structures[]` is compared once
- Each pair is an independent async job with per-pair partial success — a pair still computing when the poll budget elapses returns `status: computing` with a job `uuid`; a failed pair degrades only its own row
- Re-call with a matching `{ a, b, uuid }` entry in `resume[]` to poll a computing pair instead of resubmitting
- Returns TM-score, RMSD, and aligned-residue count per pair, plus each structure's `modeledResidues` and 0–100 `coverage`

---

### `protein_analyze_collection` <sub>tool</sub>

- Group by `method`, `organism`, `polymer_type`, `resolution`, `release_year`, or `molecular_weight`
- One `group_by` dimension for a breakdown, or two distinct dimensions for a cross-tab (the first nests the second); a repeated dimension is rejected
- `interval` sets a histogram bin width (a number, for `resolution` or `molecular_weight`) or date-histogram period (`year`, the only one RCSB accepts) — applies to whichever requested dimension can consume that type; rejected when neither can
- Scope with a free-text `query`, `organism`, `method`, or `max_resolution`; `content_type` selects the structure universe
- `bucket_limit` caps buckets per dimension level, not per response — a cross-tab applies it separately to the parent and each nested child, up to `bucket_limit × (1 + bucket_limit)` buckets; `notice` names every capped position and `bucketsReturned` gives the realized total
- Every dimension reports `missingValueCount` — matches carrying no value for that attribute (e.g. a `resolution` breakdown excludes NMR entries; computed models have neither `method` nor `resolution`)

---

### `protein_get_annotations` <sub>tool</sub>

- UniProt features (domains, binding sites, PTMs) and natural variants, plus InterPro domain/family memberships (Pfam, PROSITE, …) with associated GO terms
- Provide a UniProt accession directly, or a PDB ID — resolved via the structure's sequence cross-reference
- A multi-chain PDB entry can map to several accessions; the default is the deterministic lowest-author-chain pick, with alternatives listed under `ambiguity` — pass `chain` (an author chain ID) to select a specific one
- `include` scopes which classes are fetched (`features`, `domains`, `variants`, `all`); `limit` caps each class independently (1–200, default 50), with a truncated class disclosed in `notice`
- Every response carries an `attribution` block naming the upstream data licenses and citations (see [Upstream data licensing](#upstream-data-licensing))

---

### `pdb://{entry_id}` <sub>resource</sub>

- Experimental structure summary as `application/json` — title, method, resolution, organism, bound ligands, and per-entity chain IDs in both the author (`authAsymIds`) and mmCIF label (`labelAsymIds`) namespaces
- Mirrors `protein_get_structure` for `source: experimental`; `entry_id` is a PDB entry ID (e.g. `4HHB`)

---

### `af://{uniprot}` <sub>resource</sub>

- Predicted-structure summary as `application/json` — mean pLDDT, confidence-band fractions, model URLs (`cif`/`pdb`/`bcif`), and AlphaFold model version
- `uniprot` accepts a UniProt accession or an AlphaFold DB entry ID (e.g. `AF-P69905-F1`); mirrors `protein_get_structure` for `source: predicted`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

PDB / AlphaFold-specific:

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

### Self-Hosted / Local

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

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
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
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. The server declares `stateless` in code; set this to override it. | `stateless` |
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
| `src/services` | Provider service layer — RCSB (search, data, facets), AlphaFold, 3D-Beacons (best-available), UniProt (incl. InterPro/GO), Structural Comparison alignment, Foldseek, and shared HTTP/identifier/concurrency helpers. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`/`AGENTS.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Upstream data licensing

Structure and annotation data comes from public upstream databases, each under its own license. `protein_get_structure` and `protein_get_annotations` carry an `attribution` block on every response — the license, citation, and homepage for each source that contributed to that specific response — so the attribution obligation travels with the data to downstream consumers rather than living only here. CC BY / CC BY-SA sources require attribution on redistribution; CC0 sources are citation-only (attribution encouraged, not required).

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

`best_available` federates predicted models through [3D-Beacons](https://3d-beacons.org/), so the `attribution` block credits the actual contributing provider (AlphaFold DB, SWISS-MODEL, BFVD, …); a provider without a curated license entry carries a `See provider terms` fallback pointing back to 3D-Beacons rather than a fabricated license. InterPro's own domain/family classifications are CC0; the GO terms carried alongside them are separately CC BY 4.0, so each is credited independently only when it actually contributes. Full citations for each source travel in the `attribution` block of the relevant tool responses. This covers upstream *data* licensing — the server's own code is licensed separately (see [License](#license)).

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
