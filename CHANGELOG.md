# Changelog

All notable changes to this project will be documented in this file.

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
