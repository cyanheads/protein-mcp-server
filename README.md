<div align="center">
  <h1>@cyanheads/protein-mcp-server</h1>
  <p><b>Federated protein structure & annotation across experimental (PDB) and predicted (AlphaFold) models via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.9.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/protein-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/protein-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/protein-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

Experimental (PDB) and predicted (AlphaFold) protein structures behind one surface. Search, fetch, align, and annotate structures and their ligands across RCSB, AlphaFold DB, 3D-Beacons, UniProt, InterPro, and Foldseek. No API key required.

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

### Skills

| Skill | Description |
|:---|:---|
| `protein-guide` | Identifier forms each tool takes, author vs label chains, residue numbering, and the gates for `best_available` picks, sequence and Foldseek hits, ligand counts, and PDB profiles |

Served over MCP as `skill://protein-guide/SKILL.md`; it also ships in plugin installs, the `.mcpb` bundle, the npm package, and the Docker image.

## Capability reference

### `protein_search_structures` <sub>tool</sub>

- At least one of `query`, `sequence` (an mmseqs2 search; `min_identity` / `max_evalue` apply only with it), `organism`, `method`, `max_resolution`, or `ligand` (an exact component ID held as a bound copy); `content_type` is `experimental`, `predicted`, or `all` (default); up to 100 hits per page (default 25) via `limit` / `start`
- `organism` takes a scientific name, an NCBI common name, or a taxon ID, and matches that taxon plus every taxon under it; a word fragment matches nothing. `method` takes one of the 13 RCSB experimental methods in any letter case, or an alias (`cryo-EM`, `cryoEM`, `EM`, `X-ray`, `xray`, `NMR` for both NMR methods); anything else fails as `unknown_method`
- A `sequence` needs at least 10 residues; whitespace is stripped and case normalized, and an invalid one fails as `invalid_sequence`. Each hit names its `source` and an entry `id` you can pass to other tools, and carries `organisms` (a sequence hit's are the matched entity's). Sequence hits add `identity`, `evalue`, `bitscore`, and the aligned ranges, with `queryLength` at the response level
- Optional `facets` (`method`, `organism`, `polymer_type`, `resolution`, `release_year`, `molecular_weight`) add a breakdown capped at `PROTEIN_FACET_BUCKET_CAP` buckets per dimension; facets count the filtered set, so an active organism or method filter constrains its own facet

---

### `protein_get_structure` <sub>tool</sub>

- `source: experimental` (default) takes PDB entry IDs and the `AF_*` / `MA_*` computed-model IDs search returns (these come back as `source: predicted`); `predicted` takes UniProt accessions, isoform accessions (`P04637-2`), or AlphaFold DB entry IDs (`AF-P04637-2-F1`) for AlphaFold models with pLDDT/PAE; `best_available` takes the same identifiers (an entry ID reduces to its accession) and returns the PDB entry with the widest UniProt `coverage` (ties to the finest resolution), else the model with the highest confidence on the lDDT scale. Best-available records carry `coverage`, `uniprotStart`, and `uniprotEnd`; a pick can come from a non-PDB provider, and only a record with `pdbId` is a PDB entry. If the PDB check is unavailable, the pick ranks the federated models alone and `notice` says so
- A UniProt accession merged into another entry resolves to its successor's model with a `notice`; a demerged or deleted one lands in `failed[]` with its replacements
- IDs are trimmed and de-duplicated (case-insensitive); up to `PROTEIN_MAX_BATCH_IDS` are looked up per call (default 25) and the remainder comes back in `ignored`. One 50 s budget covers all upstream lookups in a call; under `predicted` and `best_available`, an ID it stops, or whose upstream lookup fails (an error status, an HTML page, a network failure), lands in `failed[]` with a reason to re-call it
- Unresolved IDs land in `failed[]`; when nothing resolves the call fails as `upstream_unavailable` (retryable, with `data.failed`) if every ID's lookup failed upstream or ran out of the 50 s budget, so none is known to lack a structure, and otherwise as `all_failed` (with `data.failed`); it fails `mixed_id_types` when the IDs don't fit `source`. Records include `coordinateUrls` for the files that exist, and `organisms` under `experimental` and `predicted`
- `include_coords` inlines coordinate text in 24,000-character windows: a single selected structure pages with `coords_offset`, passing back `coordinatesNextOffset` until it is absent; several selected files inline whole only when together they fit one window, otherwise an `overflow` outline lists each file's length to re-call with `sections: [id]`. `coords_offset` above 0 needs exactly one selected structure (`coords_offset_needs_one_structure`)

---

### `protein_find_similar` <sub>tool</sub>

- `by: sequence` runs a synchronous RCSB mmseqs2 search over experimental PDB entries only (`protein_search_structures` with a `sequence` also reaches computed models) from `sequence`, `pdb_id`, or `uniprot`, filtered by `max_evalue` / `min_identity`; `by: structure` runs an async Foldseek search from `pdb_id` (its mmCIF file) or `uniprot` (its AlphaFold DB model) against `pdb100` + `afdb50` unless `databases` says otherwise. `uniprot` takes a canonical or isoform accession, or a UniProtKB entry name such as `HBA_HUMAN` (resolved to its entry's accession), in both modes and is shape-checked before any request (`invalid_accession`). `databases` takes exactly these case-sensitive names: `pdb100`, `afdb50`, `afdb-swissprot`, `afdb-proteome`, `bfvd_v3`, `cath50`, `mgnify_esm30`, `gmgcl_id`, `bfmd`; any other fails schema validation (-32602), and a name Foldseek itself refuses fails as `databases_rejected`. A field only the other mode reads fails as `mode_mismatched_field`; up to 100 hits per page (default 25)
- Sequences follow the same rules as `protein_search_structures`, and a direct `sequence` wins over identifiers. A `pdb_id` sequence query searches one protein entity: the one holding `chain` (author chain, case-sensitive, `by: sequence` only, requires `pdb_id`), else the lowest-numbered protein entity of at least 10 residues; DNA and RNA entities are never searched. The response names it in `queryEntityId`, and a notice lists the entry's other protein entities. An unmatched `chain` fails as `chain_not_found`, and `chain` without `pdb_id` as `chain_without_pdb_id`
- Hits name their `source` (and `database` for structure hits), ranked by `score`; sequence hits add `identity`, `evalue`, `bitscore`, and the aligned ranges. Responses report `totalCount`, `nextStart`, and `queryLength`
- A merged `uniprot` accession answers for its successor with a notice; a demerged or deleted one fails as `inactive_accession` with its replacements. A `by: structure` coordinate file is limited to 16,000,000 characters, and a larger one fails as `structure_too_large`
- A structure hit carries Foldseek's `target` name and an `id` only when the target resolves to a PDB entry or UniProt accession; `bfvd_v3`, `mgnify_esm30`, `gmgcl_id`, and `bfmd` hits have none. Other structure-hit fields: `chain` (a `-N` suffix marks a symmetry copy), `title`, `probability`, `organisms` / `taxId` (the target's, where Foldseek classifies it), and the aligned spans `queryStart`, `queryEnd`, `targetStart`, `targetEnd`, `targetLength`. A sequence hit's `organisms` are the matched entity's
- A structure job still running at the poll budget returns `status: computing` with a `ticketId`; re-call with `ticket_id` to resume it. A job Foldseek accepted before the call's 50 s budget ran out comes back the same way. For a new search the poll window starts when the call does, so identifier lookups and the coordinate download come out of it. A multichain structure is searched one chain at a time via `query` (0-based, default 0) out of `queryCount`

---

### `protein_track_ligands` <sub>tool</sub>

- `mode` is `find_ligand` (`query`: a name or formula), `structures_with_ligand` (`comp_id`), or `binding_site` (`pdb_id`, optional `comp_id`); a missing mode input fails as `missing_param`. `limit` is 1–100 (default 25), and `start` pages the last two modes
- `find_ligand` returns component IDs with formula, weight, SMILES, and InChIKey, ranked by `depositionCount`, with `totalCount` and `candidatesConsidered` showing when the candidate pool was cut short; `structures_with_ligand` lists entries highest resolution first, each with `title`, `method`, and `hostEntities` (the polymer entities whose chains the depositor assigned the ligand to)
- Matching counts bound non-polymer copies only, not a residue inside a polymer chain or a sugar inside a branched glycan; `depositionCount` equals the `totalCount` of `structures_with_ligand` for the same component
- `binding_site` returns pocket residues with contact distances, numbered in both label (`asymId`, `seqId`) and author (`authAsymId`, `authSeqId`) namespaces, for ligand instances in a fixed order (ligand entity number, author chain, author residue number) so `start` / `limit` pages read each once; it works on experimental structures only

---

### `protein_compare_structures` <sub>tool</sub>

- 2 structures up to `PROTEIN_MAX_COMPARE_STRUCTURES` (default 10, max 25), each a `pdb_id` with an optional label-namespace `chain`; `method` is `tm-align` (default), `fatcat-rigid`, or `fatcat-flexible`; `reference` is `first` (default) or `all_pairs`; `timeout_s` (5–120) sets the per-pair poll budget
- Each pair row has a `status` (`complete`, `computing`, `failed`), `tmScore`, `rmsd`, `alignedResidues`, `modeledResidues`, and `coverage`; TM-score is normalized by `a`'s length, so reversing a pair changes it. `similarityScore` and `sequenceSimilarity` appear when the upstream supplies them
- Structures past the cap return in `ignored` as `{ pdb_id, chain? }`, not compared. A computing pair returns its job `uuid`; re-call with `{ a, b, uuid }` in `resume[]` to poll it instead of resubmitting. A mismatched `method` or pair fails as `resume_method_mismatch` or `resume_job_mismatch`

---

### `protein_analyze_collection` <sub>tool</sub>

- `group_by` takes one of `method`, `organism`, `polymer_type`, `resolution`, `release_year`, `molecular_weight`, or two distinct ones for a cross-tab; scope with `query`, `organism`, `method`, `max_resolution`, and `content_type` (default `experimental`); `organism` and `method` take the same forms as in `protein_search_structures`, and an unknown `method` fails as `unknown_method`. `interval` sets a numeric bin width for `resolution` / `molecular_weight` or `"year"` for `release_year`
- Returns `total` and `bucketsReturned`; buckets carry `label` and `count` (numeric bins add `rangeFrom` / `rangeTo`), and every dimension reports `missingValueCount`
- `bucket_limit` (1–500, default `PROTEIN_FACET_BUCKET_CAP`) caps each dimension separately; `truncated` and `notice` say where results were cut

---

### `protein_get_annotations` <sub>tool</sub>

- A canonical `uniprot` accession, or a `pdb_id` resolved through its UniProt cross-reference (author `chain` picks one accession); `include` is `features`, `domains`, `variants`, or `all` (default); `limit` pages each class separately (1–200, default 50), with independent zero-based `features_offset`, `variants_offset`, and `domains_offset` (default 0)
- Returns UniProt features (domains, binding and active sites, PTMs, topology, processing products such as chains and signal peptides, mutagenesis, and more) and natural variants plus InterPro domains with GO terms; a PDB entry mapping to several accessions uses the lowest author chain and lists the rest in `ambiguity`
- An isoform accession fails as `invalid_accession`, naming the canonical one. An accession UniProt merged into another entry answers as its successor, with the merge named first in `notice`; a demerged or deleted one fails as `inactive_accession` with its `replacements`
- Each requested class carries `featuresTotal`, `variantsTotal`, or `domainsTotal` (InterPro's own membership count); a page with more records sets `truncated` and names the next offset in `notice`, and an InterPro walk that stops short of its count sets `truncated` and says how many memberships `domains_offset` can reach. One 50 s budget covers every upstream request in a call
- Failures are typed as `missing_identifier`, `invalid_accession`, `accession_not_found`, `inactive_accession`, `no_uniprot_mapping`, or `chain_not_found`

---

### `pdb://{entry_id}` <sub>resource</sub>

- `entry_id` is a PDB entry ID (e.g. `4HHB`); returns `application/json` with title, methods, resolution, organisms, ligands, and `polymerEntities` carrying both `authAsymIds` and `labelAsymIds`
- Same data as `protein_get_structure` with `source: experimental`

---

### `af://{uniprot}` <sub>resource</sub>

- `uniprot` is a UniProt accession, an isoform accession (e.g. `P04637-2`), or an AlphaFold DB entry ID (e.g. `AF-P69905-F1`); returns `application/json` with `meanPlddt`, `confidenceBuckets`, `cifUrl` / `pdbUrl` / `bcifUrl`, and `modelVersion`, plus a `notice` when UniProt merged the accession into another entry (the successor's model answers)
- Failures are typed as `invalid_accession`, `no_model`, `accession_not_found`, or `inactive_accession` (with its replacements)
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
| `PROTEIN_ASYNC_POLL_TIMEOUT_MS` | Poll budget for an async alignment or Foldseek job before it returns `computing` (min 1000). For `protein_find_similar` keep it at or below 45000: the call's 50 s upstream budget ends a longer poll. | `30000` |
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
| `src/index.ts` | `createApp()` entry point: registers tools and resources, serves `skills/`, inits the provider services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) and shared schemas (`_schemas.ts`). |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `src/services` | Upstream clients: `rcsb/` (search, data, facets), `alphafold/`, `beacons/` (3D-Beacons), `uniprot/` (UniProt, InterPro, GO), `alignment/` (RCSB Structural Comparison), `foldseek/`, and `shared/` HTTP, concurrency, identifier, and attribution helpers. |
| `skills/` | The published `protein-guide` agent skill, served over MCP and shipped in plugin installs, the `.mcpb` bundle, the npm package, and the Docker image. |
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
