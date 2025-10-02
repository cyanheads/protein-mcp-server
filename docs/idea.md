---

### 6. Protein Structures MCP Server 🧬

**Package Name**: `protein-mcp-server` (avoids "PDB" acronym collision with Program Database files, Python Debugger, etc.)

**Data Sources**:
- [RCSB PDB API](https://www.rcsb.org/docs/programmatic-access) (Protein Data Bank)
- [PDBe REST API](https://www.ebi.ac.uk/pdbe/api/doc/)
- [UniProt API](https://www.uniprot.org/help/api) (for sequence data)

**Description**: 3D structural data of proteins, nucleic acids, and complex assemblies with experimental and computational annotations from the Protein Data Bank.

**Tools**:
- `protein_search_structures` - Search protein structures by name, organism, experimental method, resolution
- `protein_get_structure` - Retrieve 3D coordinates, topology, experimental data, annotations
- `protein_compare_structures` - Structural alignment, RMSD calculations, conformational analysis
- `protein_analyze_collection` - Statistical analysis of structure database by fold, function, organism
- `protein_find_similar` - Search by sequence similarity (BLAST) or structural similarity (DALI)
- `protein_track_ligands` - Find structures containing specific ligands, cofactors, or drugs

**Key Features**:
- Multi-format support (PDB, mmCIF, PDBML)
- Experimental method filtering (X-ray, NMR, Cryo-EM)
- Quality metrics (resolution, R-factor, validation scores)
- Functional annotation integration
- Drug target identification
- Evolution and homology mapping

**Use Cases**:
- "Find all human kinase structures with resolution better than 2.0 Å"
- "Compare the active site conformations of HIV protease in complex with different inhibitors"
- "What are the common structural folds in membrane proteins?"
- "Show me all cryo-EM structures of SARS-CoV-2 spike protein"
- "Find proteins structurally similar to PDB ID 1ABC"

**Value Proposition**: Rich scientific data with spatial/structural information, strong research applications in drug discovery, protein engineering, and structural biology.

---