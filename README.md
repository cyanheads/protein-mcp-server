<div align="center">
  <h1>protein-mcp-server</h1>
  <p><b>A powerful Model Context Protocol server providing programmatic access to 3D protein structural data from RCSB PDB, PDBe, and UniProt. Features multi-provider orchestration, comprehensive structural analysis tools, and full observability. Built for performance and scalability, with native support for serverless deployment (Cloudflare Workers).</b></p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-1.0.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![MCP Spec](https://img.shields.io/badge/MCP%20Spec-2025--06--18-8A2BE2.svg?style=flat-square)](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-06-18/changelog.mdx) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.19.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Status](https://img.shields.io/badge/Status-Development-orange.svg?style=flat-square)](https://github.com/cyanheads/protein-mcp-server/issues) [![TypeScript](https://img.shields.io/badge/TypeScript-^5.9.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.2.23-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

---

## 🛠️ Tools Overview & Roadmap

This server provides a powerful suite of tools for accessing and analyzing protein structure data.

| Tool Name                    | Status                | Description                                                                                               |
| :--------------------------- | :-------------------- | :-------------------------------------------------------------------------------------------------------- |
| `protein_search_structures`  | ✅ **Stable**         | Searches for protein structures using keywords, filters, pagination, and sorting.                         |
| `protein_get_structure`      | ✅ **Stable**         | Fetches one or more protein structures by their PDB IDs, returning either full data or concise summaries. |
| `protein_find_similar`       | ✅ **Stable**         | Finds proteins with similar sequence or structure.                                                        |
| `protein_track_ligands`      | ✅ **Stable**         | Finds protein structures containing specific ligands, cofactors, or drugs.                                |
| `protein_compare_structures` | 🟡 **In Development** | Performs a detailed side-by-side comparison of 2-10 protein structures.                                   |
| `protein_analyze_collection` | 🟡 **In Development** | Performs statistical analysis on the protein structure database.                                          |

### `protein_search_structures`

**Search and discover protein structures** from the Protein Data Bank (PDB) using a wide range of criteria.

**Key Features:**

- Free-text search for protein names, keywords, or PDB IDs.
- Filter by source organism, experimental method, and resolution.
- Pagination support for navigating large result sets.
- Returns rich metadata including title, organism, method, and resolution.

**Example Use Cases:**

- "Find all human kinase structures with resolution better than 2.0 Å"
- "Show me all cryo-EM structures of the SARS-CoV-2 spike protein"
- "List structures of hemoglobin from _Escherichia coli_"

---

### `protein_get_structure`

**Retrieve detailed information** for specific protein structures by their PDB ID.

**Key Features:**

- Fetch single or multiple structures by their 4-character PDB ID.
- Choose between different data formats: `mmCIF` (default), `PDB`, `PDBML`, or `JSON`.
- Selectively include or exclude 3D coordinates, experimental data, and functional annotations.
- Provides access to atomic coordinates, chain information, and experimental details like R-factors and unit cell parameters.

**Example Use Cases:**

- "Get the full structure data for PDB ID 1ABC in mmCIF format"
- "Show me the metadata and chain information for 2GBP, but exclude the coordinates"
- "What were the experimental method and resolution for structure 6M0J?"

---

### `protein_compare_structures`

**Compare and contrast multiple protein structures** to analyze conformational changes and structural relationships.

**Key Features:**

- Side-by-side comparison of 2 to 10 structures.
- Utilizes standard alignment algorithms like `CEAlign` and `TM-Align`.
- Calculates key metrics including RMSD, TM-score, and sequence identity.
- Can optionally generate a visualization script for PyMOL or ChimeraX.

**Example Use Cases:**

- "Compare the active site conformations of HIV protease in structures 1HVR and 1HVS"
- "Align structures 2GBP and 3AXO and report the RMSD"
- "Analyze the conformational differences between the open and closed states of a protein"

---

### `protein_find_similar`

**Discover structurally or sequentially related proteins** based on a query.

**Key Features:**

- Similarity search by `sequence` (like BLAST) or `structure` (like DALI).
- Use a PDB ID, a FASTA sequence, or raw structure data as the query.
- Set thresholds for sequence identity, E-value, TM-score, or RMSD to refine results.
- Identifies homologous proteins, recognizes structural folds, and supports evolutionary analysis.

**Example Use Cases:**

- "Find proteins structurally similar to PDB ID 1ABC"
- "What proteins have a sequence identity greater than 90% to this FASTA sequence?"
- "Discover other proteins with a similar fold to my query structure"

---

### `protein_track_ligands`

**Identify protein structures that bind to specific small molecules**, such as drugs, inhibitors, or cofactors.

**Key Features:**

- Search for ligands by common name, chemical ID, or SMILES string.
- Filter results by the bound protein's name, organism, or experimental method.
- Optionally include details of the binding site, including interacting residues.
- Essential for drug discovery, pharmacology, and molecular docking workflows.

**Example Use Cases:**

- "Find all human protein structures that bind to ATP"
- "Show me structures of Cyclin-dependent kinase 2 in complex with an inhibitor"
- "What are the binding site residues for glucose in hexokinase?"

---

### `protein_analyze_collection`

**Perform statistical analysis** on the entire Protein Data Bank to uncover trends and distributions.

**Key Features:**

- Aggregate data based on `fold` classification, `function`, `organism`, or experimental `method`.
- Apply filters to narrow the analysis to specific subsets of the database.
- Group results by a secondary dimension (e.g., year) to visualize trends over time.

**Example Use Cases:**

- "What are the most common structural folds found in membrane proteins?"
- "Show a yearly trend of the number of structures determined by cryo-EM"
- "Which organisms are most represented in the PDB for the years 2020-2023?"

## ✨ Features

This server is built on the [`mcp-ts-template`](https://github.com/cyanheads/mcp-ts-template) and inherits its rich feature set:

- **Declarative Tools**: Define agent capabilities in single, self-contained files. The framework handles registration, validation, and execution.
- **Robust Error Handling**: A unified `McpError` system ensures consistent, structured error responses.
- **Pluggable Authentication**: Secure your server with zero-fuss support for `none`, `jwt`, or `oauth` modes.
- **Abstracted Storage**: Swap storage backends (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2`) without changing business logic.
- **Full-Stack Observability**: Deep insights with structured logging (Pino) and optional, auto-instrumented OpenTelemetry for traces and metrics.
- **Dependency Injection**: Built with `tsyringe` for a clean, decoupled, and testable architecture.
- **Edge-Ready**: Write code once and run it seamlessly on your local machine or at the edge on Cloudflare Workers.

## 🚀 Getting Started

### MCP Client Settings/Configuration

Add the following to your MCP Client configuration file (e.g., `cline_mcp_settings.json`).

```json
{
  "mcpServers": {
    "protein-mcp-server": {
      "command": "bunx",
      "args": ["protein-mcp-server@latest"],
      "env": {
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

### Prerequisites

- [Bun v1.2.0](https://bun.sh/) or higher.

### Installation

1.  **Clone the repository:**

```sh
git clone https://github.com/cyanheads/protein-mcp-server.git
```

2.  **Navigate into the directory:**

```sh
cd protein-mcp-server
```

3.  **Install dependencies:**

```sh
bun install
```

## ⚙️ Configuration

All configuration is centralized and validated at startup in `src/config/index.ts`. Key environment variables in your `.env` file include:

| Variable                   | Description                                                                    | Default     |
| :------------------------- | :----------------------------------------------------------------------------- | :---------- |
| `MCP_TRANSPORT_TYPE`       | The transport to use: `stdio` or `http`.                                       | `http`      |
| `MCP_HTTP_PORT`            | The port for the HTTP server.                                                  | `3010`      |
| `MCP_AUTH_MODE`            | Authentication mode: `none`, `jwt`, or `oauth`.                                | `none`      |
| `STORAGE_PROVIDER_TYPE`    | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv`, `r2`. | `in-memory` |
| `PROTEIN_PRIMARY_PROVIDER` | The primary data source for protein data.                                      | `rcsb`      |
| `OTEL_ENABLED`             | Set to `true` to enable OpenTelemetry.                                         | `false`     |
| `LOG_LEVEL`                | The minimum level for logging.                                                 | `info`      |

## ▶️ Running the Server

### Local Development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun rebuild

  # Run the built server
  bun start:http
  # or
  bun start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun devcheck # Lints, formats, type-checks, and more
  bun test # Runs the test suite
  ```

### Cloudflare Workers

1.  **Build the Worker bundle**:

```sh
bun build:worker
```

2.  **Run locally with Wrangler**:

```sh
bun deploy:dev
```

3.  **Deploy to Cloudflare**:
    `sh
bun deploy:prod
` > **Note**: The `wrangler.toml` file is pre-configured to enable `nodejs_compat` for best results.

## 📂 Project Structure

| Directory                              | Purpose & Contents                                                                   |
| :------------------------------------- | :----------------------------------------------------------------------------------- |
| `src/mcp-server/tools/definitions`     | Your tool definitions (`*.tool.ts`). This is where you add new capabilities.         |
| `src/mcp-server/resources/definitions` | Your resource definitions (`*.resource.ts`). This is where you add new data sources. |
| `src/services/protein`                 | Orchestration and provider logic for protein data sources (RCSB, PDBe).              |
| `src/storage`                          | The `StorageService` abstraction and all storage provider implementations.           |
| `src/container`                        | Dependency injection container registrations and tokens.                             |
| `src/utils`                            | Core utilities for logging, error handling, performance, security, and telemetry.    |
| `src/config`                           | Environment variable parsing and validation with Zod.                                |
| `tests/`                               | Unit and integration tests, mirroring the `src/` directory structure.                |

## 🧑‍💻 Agent Development Guide

For a strict set of rules when using this template with an AI agent, please refer to **`AGENTS.md`**. Key principles include:

- **Logic Throws, Handlers Catch**: Never use `try/catch` in your tool/resource `logic`. Throw an `McpError` instead.
- **Use Elicitation for Missing Input**: If a tool requires user input that wasn't provided, use the `elicitInput` function from the `SdkContext` to ask the user for it.
- **Pass the Context**: Always pass the `RequestContext` object through your call stack.
- **Use the Barrel Exports**: Register new tools and resources only in the `index.ts` barrel files.

## 🤝 Contributing

Issues and pull requests are welcome! If you plan to contribute, please run the local checks and tests before submitting your PR.

```sh
bun run devcheck
bun test
```

## 📜 License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
