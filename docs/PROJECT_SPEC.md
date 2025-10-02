# Protein Structures MCP Server - Project Specification

**Version**: 1.0.0
**Status**: Planning
**Last Updated**: 2025-10-02

---

## Executive Summary

The Protein Structures MCP Server (`protein-mcp-server`) provides programmatic access to 3D structural data of proteins, nucleic acids, and complex assemblies through a standardized Model Context Protocol interface. It integrates data from the Protein Data Bank (RCSB PDB, PDBe) and UniProt to enable AI-assisted exploration of structural biology, drug discovery, and protein engineering.

---

## 1. Project Overview

### 1.1 Purpose

Enable language models and AI agents to:
- Search and retrieve protein structural data from authoritative databases
- Analyze and compare 3D protein structures
- Extract experimental metadata and quality metrics
- Support drug discovery workflows through ligand tracking
- Facilitate structural biology research and protein engineering

### 1.2 Package Name

**`protein-mcp-server`**

**Rationale**: Avoids acronym collision with:
- Program Database (PDB) files in Windows
- Python Debugger (pdb)
- Other technical "PDB" meanings

### 1.3 Target Audience

- **Primary**: Structural biologists, computational chemists, drug discovery researchers
- **Secondary**: Bioinformaticians, protein engineers, molecular biology educators
- **Tertiary**: AI/ML researchers working with protein data

---

## 2. Data Sources & APIs

### 2.1 Primary Data Sources

| Source | Purpose | API Documentation |
|--------|---------|-------------------|
| **RCSB PDB** | Primary structural database (US mirror) | [RCSB API Docs](https://www.rcsb.org/docs/programmatic-access) |
| **PDBe** | European Bioinformatics Institute mirror | [PDBe REST API](https://www.ebi.ac.uk/pdbe/api/doc/) |
| **UniProt** | Protein sequence and functional annotation | [UniProt API](https://www.uniprot.org/help/api) |

### 2.2 API Integration Strategy

- **RCSB PDB**: GraphQL API for complex queries, REST API for simple lookups
- **PDBe**: REST API for supplementary data and validation metrics
- **UniProt**: REST API for sequence data and functional annotations
- **Fallback**: Automatic failover between RCSB and PDBe for redundancy

### 2.3 Data Formats

- **PDB**: Legacy text format (backwards compatibility)
- **mmCIF**: Modern crystallographic information format (preferred)
- **PDBML**: XML-based format
- **JSON**: Parsed metadata and annotations

---

## 3. Tool Definitions

All tools follow the MCP `ToolDefinition` pattern with Zod schemas, pure logic functions, and authorization wrappers.

### 3.1 `protein_search_structures`

**Description**: Search protein structures by name, organism, experimental method, resolution, or keywords.

**Input Schema**:
```typescript
{
  query: string;                    // Protein name, PDB ID, or keyword
  organism?: string;                // Filter by source organism
  experimentalMethod?: enum;        // X-ray, NMR, Cryo-EM, etc.
  maxResolution?: number;           // Maximum resolution in Angstroms
  minResolution?: number;           // Minimum resolution in Angstroms
  releaseDate?: { from?: string, to?: string };
  limit?: number;                   // Default 25, max 100
  offset?: number;                  // Pagination
}
```

**Output Schema**:
```typescript
{
  results: Array<{
    pdbId: string;
    title: string;
    organism: string[];
    experimentalMethod: string;
    resolution?: number;
    releaseDate: string;
    molecularWeight?: number;
  }>;
  totalCount: number;
  hasMore: boolean;
}
```

**Authorization**: `['tool:protein:search']`

---

### 3.2 `protein_get_structure`

**Description**: Retrieve detailed 3D coordinates, topology, experimental data, and annotations for a specific structure.

**Input Schema**:
```typescript
{
  pdbId: string;                    // 4-character PDB identifier
  format?: enum;                    // 'pdb' | 'mmcif' | 'pdbml' | 'json'
  includeCoordinates?: boolean;     // Default true
  includeExperimentalData?: boolean; // Default true
  includeAnnotations?: boolean;     // Default true
}
```

**Output Schema**:
```typescript
{
  pdbId: string;
  title: string;
  structure: {
    format: string;
    data: string | object;          // Raw structure data or parsed JSON
    chains: Array<{
      id: string;
      type: 'protein' | 'dna' | 'rna' | 'ligand';
      sequence?: string;
      length: number;
    }>;
  };
  experimental: {
    method: string;
    resolution?: number;
    rFactor?: number;
    rFree?: number;
    spaceGroup?: string;
    unitCell?: object;
  };
  annotations: {
    function?: string;
    keywords: string[];
    citations: Array<{
      title: string;
      authors: string[];
      journal?: string;
      doi?: string;
    }>;
  };
}
```

**Authorization**: `['tool:protein:read']`

---

### 3.3 `protein_compare_structures`

**Description**: Perform structural alignment, calculate RMSD (Root Mean Square Deviation), and analyze conformational differences between structures.

**Input Schema**:
```typescript
{
  pdbIds: string[];                 // 2+ PDB IDs to compare
  alignmentMethod?: enum;           // 'cealign' | 'tmalign' | 'fatcat'
  chainSelections?: Array<{
    pdbId: string;
    chain: string;
  }>;
  includeVisualization?: boolean;   // Return alignment visualization data
}
```

**Output Schema**:
```typescript
{
  alignment: {
    method: string;
    rmsd: number;                   // Angstroms
    alignedResidues: number;
    sequenceIdentity: number;       // Percentage
    tmscore?: number;               // TM-score (0-1)
  };
  pairwiseComparisons: Array<{
    pdbId1: string;
    pdbId2: string;
    rmsd: number;
    alignedLength: number;
  }>;
  conformationalAnalysis?: {
    flexibleRegions: Array<{
      residueRange: [number, number];
      rmsd: number;
    }>;
    rigidCore: {
      residueCount: number;
      rmsd: number;
    };
  };
  visualization?: string;           // PyMOL or ChimeraX script
}
```

**Authorization**: `['tool:protein:analyze']`

---

### 3.4 `protein_analyze_collection`

**Description**: Statistical analysis of structure database by fold classification, function, organism, or custom criteria.

**Input Schema**:
```typescript
{
  analysisType: enum;               // 'fold' | 'function' | 'organism' | 'method'
  filters?: {
    organism?: string;
    experimentalMethod?: string;
    resolutionRange?: [number, number];
    releaseYearRange?: [number, number];
  };
  groupBy?: string;                 // Secondary grouping dimension
  limit?: number;                   // Top N results
}
```

**Output Schema**:
```typescript
{
  analysisType: string;
  totalStructures: number;
  statistics: Array<{
    category: string;
    count: number;
    percentage: number;
    examples: Array<{
      pdbId: string;
      title: string;
    }>;
  }>;
  trends?: Array<{
    year: number;
    count: number;
  }>;
}
```

**Authorization**: `['tool:protein:analyze']`

---

### 3.5 `protein_find_similar`

**Description**: Search by sequence similarity (BLAST) or structural similarity (DALI, FATCAT) to find related proteins.

**Input Schema**:
```typescript
{
  query: {
    type: 'pdbId' | 'sequence' | 'structure';
    value: string;                  // PDB ID, FASTA sequence, or structure data
  };
  similarityType: enum;             // 'sequence' | 'structure'
  threshold?: {
    sequenceIdentity?: number;      // Minimum % identity (for BLAST)
    eValue?: number;                // Maximum E-value (for BLAST)
    tmscore?: number;               // Minimum TM-score (for structural)
    rmsd?: number;                  // Maximum RMSD (for structural)
  };
  limit?: number;                   // Default 25, max 100
}
```

**Output Schema**:
```typescript
{
  query: {
    type: string;
    identifier: string;
  };
  similarityType: string;
  results: Array<{
    pdbId: string;
    title: string;
    organism: string[];
    similarity: {
      sequenceIdentity?: number;
      eValue?: number;
      tmscore?: number;
      rmsd?: number;
    };
    alignmentLength: number;
    coverage: number;               // % of query covered
  }>;
  totalCount: number;
}
```

**Authorization**: `['tool:protein:search']`

---

### 3.6 `protein_track_ligands`

**Description**: Find structures containing specific ligands, cofactors, drugs, or binding partners.

**Input Schema**:
```typescript
{
  ligandQuery: {
    type: 'name' | 'chemicalId' | 'smiles';
    value: string;                  // e.g., "ATP", "HEM", "CHEMBL123"
  };
  filters?: {
    proteinName?: string;
    organism?: string;
    experimentalMethod?: string;
    maxResolution?: number;
  };
  includeBindingSite?: boolean;     // Return binding site residues
  limit?: number;
}
```

**Output Schema**:
```typescript
{
  ligand: {
    name: string;
    chemicalId: string;             // e.g., "ATP", "HEM"
    formula?: string;
    molecularWeight?: number;
  };
  structures: Array<{
    pdbId: string;
    title: string;
    organism: string[];
    resolution?: number;
    ligandCount: number;            // Copies of ligand in structure
    bindingSites?: Array<{
      chain: string;
      residues: Array<{
        name: string;
            number: number;
        interactions: string[];     // H-bond, hydrophobic, etc.
      }>;
    }>;
  }>;
  totalCount: number;
}
```

**Authorization**: `['tool:protein:search']`

---

## 4. Resource Definitions

Resources provide read-only access to protein data via URI templates.

### 4.1 `protein://structure/{pdbId}`

**Description**: Access a protein structure by PDB ID.

**URI Template**: `protein://structure/{pdbId}`

**Params Schema**:
```typescript
{
  pdbId: string;                    // 4-character PDB ID
  format?: string;                  // Optional format parameter
}
```

**Output**: Returns structure data in requested format (default mmCIF).

**Authorization**: `['resource:protein:read']`

---

### 4.2 `protein://search/{query}`

**Description**: Search results as a resource.

**URI Template**: `protein://search/{query}`

**Params Schema**:
```typescript
{
  query: string;
}
```

**Output**: Returns search results as JSON.

**Authorization**: `['resource:protein:read']`

---

## 5. Service Architecture

### 5.1 Service Domain: Protein Data

Following the standard service pattern:

```
src/services/protein/
├── core/
│   ├── IProteinProvider.ts        # Provider interface
│   └── ProteinService.ts          # Multi-API orchestrator
├── providers/
│   ├── rcsb.provider.ts           # RCSB PDB implementation
│   ├── pdbe.provider.ts           # PDBe implementation
│   └── uniprot.provider.ts        # UniProt implementation
├── types.ts                       # Domain types and DTOs
└── index.ts                       # Barrel export
```

### 5.2 Provider Interface

```typescript
export interface IProteinProvider {
  searchStructures(params: SearchParams, context: RequestContext): Promise<SearchResult>;
  getStructure(pdbId: string, options: GetStructureOptions, context: RequestContext): Promise<StructureData>;
  findSimilar(query: SimilarityQuery, context: RequestContext): Promise<SimilarityResult>;
  trackLigands(query: LigandQuery, context: RequestContext): Promise<LigandResult>;
  healthCheck(): Promise<boolean>;
}
```

### 5.3 Service Orchestrator

The `ProteinService` class manages:
- Provider selection (RCSB primary, PDBe fallback)
- Response caching and deduplication
- Cross-API data enrichment (PDB + UniProt)
- Rate limiting and quota management

---

## 6. Technical Requirements

### 6.1 Dependencies

**Core**:
- `@modelcontextprotocol/sdk` - MCP protocol
- `zod` - Schema validation
- `tsyringe` - Dependency injection

**Data Processing**:
- `biotite` or `biopython` alternative for structure parsing (TBD - may use native parsing)
- `pako` - Gzip decompression for mmCIF files

**HTTP**:
- `hono` - Web framework
- Native `fetch` - HTTP requests

### 6.2 External API Requirements

- **Rate Limits**: RCSB allows ~10 req/sec, implement exponential backoff
- **Data Caching**: Cache structure files (large) with TTL of 24 hours
- **Failover**: Automatic switch to PDBe if RCSB unavailable

### 6.3 Performance Targets

- Structure search: < 2s response time
- Single structure fetch: < 3s (including download)
- Structure comparison (2 proteins): < 5s
- Similarity search: < 10s (external API dependent)

### 6.4 Storage Requirements

- **Cache**: Protein structures can be 100KB-50MB (mmCIF format)
- **Provider**: Use `cloudflare-r2` for Worker deployment, `filesystem` for local
- **Retention**: 24-hour TTL for structure data, 1-hour TTL for search results

---

## 7. Data Models

### 7.1 Core Types

```typescript
type PdbId = string;  // 4-character uppercase (e.g., "1ABC")

type ExperimentalMethod =
  | 'X-RAY DIFFRACTION'
  | 'SOLUTION NMR'
  | 'ELECTRON MICROSCOPY'
  | 'NEUTRON DIFFRACTION'
  | 'FIBER DIFFRACTION'
  | 'SOLID-STATE NMR'
  | 'THEORETICAL MODEL';

type ChainType = 'protein' | 'dna' | 'rna' | 'ligand' | 'water';

interface ProteinStructure {
  pdbId: PdbId;
  title: string;
  experimentalMethod: ExperimentalMethod;
  resolution?: number;
  releaseDate: string;
  chains: Chain[];
  ligands: Ligand[];
  metadata: StructureMetadata;
}

interface Chain {
  id: string;
  type: ChainType;
  sequence?: string;
  length: number;
  organism?: string;
}

interface Ligand {
  chemicalId: string;
  name: string;
  formula?: string;
  molecularWeight?: number;
  bindingSites: BindingSite[];
}

interface BindingSite {
  chain: string;
  residues: Residue[];
  interactions: Interaction[];
}
```

---

## 8. Use Cases & Examples

### 8.1 Drug Discovery

**Query**: "Find all human kinase structures with resolution better than 2.0 Å"

```typescript
await protein_search_structures({
  query: "kinase",
  organism: "Homo sapiens",
  maxResolution: 2.0,
  limit: 50
});
```

---

### 8.2 Structural Comparison

**Query**: "Compare the active site conformations of HIV protease in complex with different inhibitors"

```typescript
// Step 1: Find HIV protease structures with inhibitors
await protein_track_ligands({
  ligandQuery: { type: 'name', value: 'inhibitor' },
  filters: { proteinName: 'HIV protease' },
  includeBindingSite: true
});

// Step 2: Compare selected structures
await protein_compare_structures({
  pdbIds: ['1HVR', '1HVS', '1HVT'],
  chainSelections: [
    { pdbId: '1HVR', chain: 'A' },
    { pdbId: '1HVS', chain: 'A' },
    { pdbId: '1HVT', chain: 'A' }
  ],
  includeVisualization: true
});
```

---

### 8.3 Database Analysis

**Query**: "What are the common structural folds in membrane proteins?"

```typescript
await protein_analyze_collection({
  analysisType: 'fold',
  filters: {
    // Membrane proteins typically have specific keywords
    keywords: ['membrane', 'transmembrane']
  },
  groupBy: 'organism',
  limit: 20
});
```

---

### 8.4 Cryo-EM Structures

**Query**: "Show me all cryo-EM structures of SARS-CoV-2 spike protein"

```typescript
await protein_search_structures({
  query: "SARS-CoV-2 spike",
  experimentalMethod: 'ELECTRON MICROSCOPY',
  organism: "SARS-CoV-2"
});
```

---

### 8.5 Structural Similarity

**Query**: "Find proteins structurally similar to PDB ID 1ABC"

```typescript
await protein_find_similar({
  query: {
    type: 'pdbId',
    value: '1ABC'
  },
  similarityType: 'structure',
  threshold: {
    tmscore: 0.5,
    rmsd: 3.0
  },
  limit: 25
});
```

---

## 9. Security & Authorization

### 9.1 Scope Definitions

- `tool:protein:search` - Search and discovery operations
- `tool:protein:read` - Read structure data
- `tool:protein:analyze` - Compute-intensive operations (comparisons, analysis)
- `resource:protein:read` - Resource access

### 9.2 Rate Limiting

- **Per-client limits**: 100 requests/minute for search, 20 requests/minute for structure fetch
- **Global limits**: Respect upstream API limits (RCSB, PDBe)
- **Quota enforcement**: Via DI-injected `RateLimiter`

### 9.3 Data Privacy

- All data is publicly available (PDB is open-access)
- No PII or sensitive data concerns
- Attribution required per PDB terms of use

---

## 10. Testing Strategy

### 10.1 Unit Tests

- Tool input validation (Zod schemas)
- Provider interface implementations
- Response formatters
- Error handling paths

### 10.2 Integration Tests

- RCSB PDB API connectivity
- PDBe API fallback
- UniProt API integration
- Cache behavior

### 10.3 E2E Tests

- Full tool invocation workflows
- Multi-step use cases (search → fetch → compare)
- Authorization enforcement

### 10.4 Test Data

- Use fixed PDB IDs for reproducibility (e.g., "1ABC", "2GBP")
- Mock API responses for offline testing
- Snapshot testing for response formats

---

## 11. Documentation Requirements

### 11.1 User-Facing

- **README.md**: Quick start, installation, basic examples
- **TOOLS.md**: Complete tool reference with examples
- **RESOURCES.md**: Resource URI patterns and usage
- **USE_CASES.md**: Detailed scientific workflows

### 11.2 Developer-Facing

- **ARCHITECTURE.md**: Service design, provider pattern
- **API_INTEGRATION.md**: RCSB/PDBe/UniProt API details
- **CONTRIBUTING.md**: Development workflow, testing

### 11.3 API Documentation

- JSDoc for all exported functions
- Zod schemas serve as inline documentation
- OpenAPI/Swagger spec generation (future)

---

## 12. Deployment

### 12.1 Local Development

```bash
bun install
bun run dev:http          # HTTP transport on localhost:3000
bun run dev:stdio         # STDIO transport for direct integration
```

### 12.2 Production (Cloudflare Workers)

```bash
bun run build:worker
bunx wrangler deploy
```

**Worker Configuration**:
- R2 bucket for structure caching
- KV namespace for metadata/search results
- Durable Objects for rate limiting (future)

### 12.3 Environment Variables

```bash
# Required
STORAGE_PROVIDER_TYPE=cloudflare-r2
PROTEIN_CACHE_BUCKET=protein-structures

# Optional
RCSB_API_KEY=                     # If rate limits become an issue
PDBE_API_KEY=
UNIPROT_API_KEY=
PROTEIN_CACHE_TTL=86400           # 24 hours
```

---

## 13. Success Metrics

### 13.1 Technical Metrics

- API availability: > 99.5%
- P95 response time: < 5s
- Cache hit rate: > 60%
- Error rate: < 1%

### 13.2 Usage Metrics

- Daily active tools
- Most frequently queried proteins
- Average queries per user session

### 13.3 Scientific Impact

- Citations in research papers
- Integration with computational tools
- Community feedback and feature requests

---

## 14. Roadmap

### Phase 1: MVP (Weeks 1-2)
- [x] Project specification
- [ ] Core service architecture (`ProteinService`, RCSB provider)
- [ ] Basic tools: `protein_search_structures`, `protein_get_structure`
- [ ] HTTP transport with JWT auth
- [ ] Unit tests

### Phase 2: Enhanced Features (Weeks 3-4)
- [ ] Structure comparison tool (`protein_compare_structures`)
- [ ] Similarity search (`protein_find_similar`)
- [ ] Ligand tracking (`protein_track_ligands`)
- [ ] PDBe fallback provider
- [ ] Resource definitions

### Phase 3: Analysis & Scale (Weeks 5-6)
- [ ] Collection analysis (`protein_analyze_collection`)
- [ ] UniProt integration
- [ ] Cloudflare Worker deployment
- [ ] R2 caching layer
- [ ] Integration tests

### Phase 4: Polish & Release (Weeks 7-8)
- [ ] Comprehensive documentation
- [ ] Performance optimization
- [ ] E2E test suite
- [ ] Example notebooks/scripts
- [ ] Public release

---

## 15. Open Questions

1. **Structure Parsing**: Use native TypeScript parsing or wrap Python tools (Biopython/Biotite)?
2. **Comparison Algorithms**: Implement RMSD calculation in-house or proxy to external services?
3. **Visualization**: Return 3D structure viewers (Mol*, NGL) or scripts (PyMOL, ChimeraX)?
4. **Licensing**: Confirm attribution requirements for PDB data redistribution
5. **Quotas**: What are realistic per-user quotas for compute-intensive operations?

---

## 16. References

- [RCSB PDB Documentation](https://www.rcsb.org/docs/)
- [PDBe API Documentation](https://www.ebi.ac.uk/pdbe/api/doc/)
- [UniProt Programmatic Access](https://www.uniprot.org/help/programmatic_access)
- [mmCIF Format Specification](https://mmcif.wwpdb.org/)
- [MCP Protocol Specification](https://spec.modelcontextprotocol.io/)
- [CLAUDE.md - MCP TypeScript Template Architecture](../CLAUDE.md)

---

## 17. Contact & Governance

**Maintainer**: Casey Developer
**Repository**: `github.com/username/protein-mcp-server`
**License**: MIT (pending legal review)
**Issue Tracking**: GitHub Issues
**Discussions**: GitHub Discussions

---

**Document Status**: ✅ Complete - Ready for Implementation
