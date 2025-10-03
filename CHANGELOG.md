# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- **Comprehensive Unit Tests**: Introduced a full suite of unit tests for the core protein tools (`protein_search_structures`, `protein_get_structure`, `protein_find_similar`, `protein_track_ligands`), adding test coverage to ensure stability and correctness.
- **Ligand Chemical Properties**: `protein_track_ligands` now fetches and displays chemical properties like molecular weight and formula using a new `getLigandChemicalProperties` function.

### Changed

- **Upgraded Structural Similarity Search**: The `protein_find_similar` tool's structural search now performs pairwise alignments on candidate structures, providing accurate TM-scores and RMSD values instead of relying solely on shape similarity.
- **Refactored GraphQL Client**: Replaced the manual `fetch` implementation for the RCSB GraphQL API with the official `@rcsb/rcsb-api-tools` library for improved reliability and maintainability.
- **Intelligent Data Merging**: `protein_get_structure` now intelligently merges metadata (like organism names) with data from coordinate files (like sequences) to provide a more complete model of each chain.

### Fixed

- **Alignment Service Stability**: Corrected the request format for the RCSB Alignment service and improved handling of optional chain IDs to prevent failures.
- **Robust Error Handling**: `fetchWithTimeout` now correctly throws an `McpError` on non-2xx HTTP responses, ensuring upstream services handle failures gracefully.
- **Data Nullability**: Improved type definitions to handle nullable fields from external APIs, preventing runtime errors.
- **`protein_track_ligands`**: Now correctly displays molecular weight, formula, and enhanced chemical properties for ligands.

### Technical

- **Enhanced Tool Outputs**: Significantly improved the `responseFormatter` for all stable tools to provide richer, more informative output:
  - **`protein_search_structures`**:
    - Now shows all organisms (up to 3) instead of truncating to first one
    - Added pagination indicators (e.g., "page 1 of 4")
    - Abbreviated experimental methods for cleaner display (X-RAY, EM, NMR)
    - Better handling of multi-organism structures
  - **`protein_get_structure`**:
    - Added R-factor and R-free values to experimental data display
    - Included primary citation information with authors, journal, year, and DOI
    - Display functional keywords when available
    - Show chain organism information
    - Enhanced chain details formatting
  - **`protein_find_similar`**:
    - Added ranking indicators (Rank #1, #2, etc.)
    - Always display coverage percentage when available
    - Prioritize shape similarity score for structure searches
    - Include organism names (up to 2) for each result
    - Added quality indicators (⭐ High quality) for strong matches
    - Multi-line format with better metric organization
  - **`protein_track_ligands`**:
    - Display molecular weight alongside formula
    - Show organism names for each structure
    - Better ligand count formatting (instances/instance)
    - Include binding site statistics when requested
    - More prominent display of chemical properties

## [1.0.3] - 2025-10-02

### Changed

- **Comprehensive Logging**: Integrated structured, context-aware logging (`pino`) across all protein services (`rcsb`, `pdbe`, `uniprot`) and the core `ProteinService` orchestrator. Every external API request, response, and error is now logged with detailed context (including request bodies and error messages) to significantly improve debuggability and observability.
- **Find Similar Tool**:
  - Added a `chainId` parameter to the `protein_find_similar` tool to allow for more specific structural similarity searches.
  - Improved the `responseFormatter` to include more detailed metrics like `ShapeSimilarity` and `E-value`, and to provide a clearer summary of the query and results.
- **Search Structures Tool**: Overhauled the `responseFormatter` for `protein_search_structures` to present a clean, human-readable summary of search results instead of raw JSON.
- **README Update**: Updated the status of `protein_compare_structures` and `protein_analyze_collection` to "Failure" in the `README.md` to accurately reflect their current state. Also added notes about the low sequence identity values in `protein_find_similar`.
- **AGENTS.md**: Updated the "Known Issues" section in `AGENTS.md` with more precise debugging summaries and next steps for the failing `protein_compare_structures` and `protein_analyze_collection` tools.
- **Dependencies**: Removed the unused `dev` script from `package.json`.

## [1.0.2] - 2025-10-02

### Feature

- **Structural Alignment Service**: Implemented a new `alignment-service.ts` that integrates with the RCSB Alignment API (`https://alignment.rcsb.org`). This service submits pairwise alignment jobs, polls for completion, and processes the results.
- **Ligand and Binding Site Analysis**: Significantly enhanced the `trackLigands` tool. It now supports chemical similarity searches via SMILES and InChI strings, name-based searching, and includes a `getBindingSiteInfo` function to retrieve binding site residues and interactions from the RCSB GraphQL API.
- **BinaryCIF Support**: Added support for the `bcif` (BinaryCIF) format in `protein_get_structure` and the `protein://structure/{pdbId}` resource. This provides a more efficient, compressed binary alternative to mmCIF.

### Fixed

- **Structure Comparison (`protein_compare_structures`)**: Replaced the previous mock implementation with a fully functional one that uses the new `alignment-service.ts`. The tool now performs live structural alignments using the RCSB Alignment API.
- **Collection Analysis (`protein_analyze_collection`)**: Corrected the query logic in `query-builder.ts` and added robust error logging in `search-client.ts` to address the "Collection analysis failed: 400" error. The tool now correctly constructs and sends facet queries.
- **Data Parsing & Enrichment**:
  - Implemented a robust `parseChainsFromCif` function in `enrichment-service.ts` to correctly parse chain ID, type, and sequence from complex mmCIF files, including those with multi-line sequences.
  - Fixed organism name extraction in `graphql-client.ts` by correctly traversing the nested `polymer_entities` structure.
  - Corrected `rFree`, `rFactor`, and `pubmedId` fields in `fetchStructureMetadata` to handle cases where they are `undefined` or need string conversion.
- **RCSB Search Queries**: Broadened the text search in `query-builder.ts` to look for matches in entry ID, structure title, and macromolecular name, improving search accuracy.

### Changed

- **Dependencies**: Updated `@modelcontextprotocol/sdk`, `openai`, `repomix`, and other development dependencies in `bun.lock`.
- **Project Identity**: Updated `mcpName` in `package.json` and `server.json` to `io.github.cyanheads/protein-mcp-server` for better namespacing.
- **Schema Descriptions**: Added detailed `.describe()` calls to all Zod input and output schemas across all protein tools, improving discoverability and clarity for LLM agents.
- **Known Issues Documentation**: Documented the solved `protein_compare_structures` and `protein_analyze_collection` issues in `AGENTS.md` for historical reference.

## [1.0.1] - 2025-10-02

### Refactor

- **Protein Service Modularity**: Restructured the protein service layer (`src/services/protein/`) by breaking down monolithic provider files into a domain-driven directory structure. Each provider (`rcsb`, `pdbe`, `uniprot`) now contains its own modules for clients, configuration, and types, improving separation of concerns and maintainability.
- **Tool Definition Simplification**: Refactored all protein tool definitions (`src/mcp-server/tools/definitions/`) to remove injectable logic classes. The `ProteinService` is now resolved directly from the `tsyringe` dependency injection container within the tool's logic function, simplifying the code and reducing boilerplate.

### Changed

- **Dependencies & Versioning**: Bumped the package version to `1.0.1` in `package.json`.
- **DI Registration**: Made `ProteinService` a singleton in `src/container/registrations/core.ts` to ensure a single instance is shared across the application.

### Docs

- **README Update**: Updated `README.md` table formatting and content for clarity.
- **Directory Tree**: Regenerated `docs/tree.md` to reflect the new modular service architecture.

## [1.0.0] - 2025-10-02

### Feature

- **Initial Release: Protein MCP Server**: Complete architectural refactor from a generic template to a specialized Model Context Protocol server for protein structure data. This foundational release introduces a comprehensive service layer for accessing and analyzing data from RCSB PDB, PDBe, and UniProt.

### Added

- **Protein Service Layer**: Implemented a multi-provider service architecture in `src/services/protein/` with a `ProteinService` orchestrator and providers for RCSB PDB, PDBe, and UniProt.
- **Protein Data Tools**:
  - `protein_search_structures`: Search for protein structures by various criteria.
  - `protein_get_structure`: Retrieve detailed 3D structure data for a PDB entry.
  - `protein_compare_structures`: Perform structural alignment and comparison.
  - `protein_find_similar`: Find similar proteins by sequence or structure.
  - `protein_track_ligands`: Identify structures containing specific ligands.
  - `protein_analyze_collection`: Perform statistical analysis on the PDB.
- **Protein Data Resources**:
  - `protein://structure/{pdbId}`: Access protein structures directly via URI.
  - `protein://search/{query}`: Access search results as a resource.
- **Configuration**: Added extensive protein service configuration options to `.env.example` and `src/config/index.ts`.
- **Project Documentation**: Added `docs/PROJECT_SPEC.md` and `docs/idea.md` outlining the server's purpose and design.

### Removed

- **Template Code**: Deleted all template tools, resources, and associated tests (`template-echo-message`, `template-cat-fact`, etc.) to focus exclusively on protein data functionality.

### Changed

- **Project Identity**: Updated `package.json` to reflect the new `protein-mcp-server` name, description, keywords, and version `1.0.0`.
- **Dependencies**: Updated `bun.lock` with necessary changes for the new functionality.
- **Directory Structure**: Updated `docs/tree.md` to reflect the new project structure.
