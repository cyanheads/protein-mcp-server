# protein-mcp-server — Idea

> **Status:** superseded by [`design.md`](./design.md) (the source of truth). After
> live-probing the providers, three things changed from the sketch below: corpus
> analytics ship via **RCSB server-side facets**, not DataCanvas — so all 7 tools
> are edge-native; `protein_track_ligands` gains binding-site residues; and
> `protein_compare_structures` does 2–10 structures, not just pairwise.

Rewrite of the archived v1.0.x server (`../protein-mcp-server-archive`) onto
**mcp-ts-core@0.10.6**. Keep the proven structure-research tool surface; modernize
the provider layer and adopt framework primitives that didn't exist on the old
`mcp-ts-template`.

## What it is

An MCP server for **protein structure & function research**: discover → fetch →
compare → find homologs → track ligands → profile the corpus, across
**experimental (PDB)** *and* **predicted (AlphaFold)** structures from one tool
surface. Audience: structural-biology, drug-discovery, and bioinformatics agents.

The headline shift from the original: the old server was experimental-only
(RCSB / PDBe / UniProt over ~230K PDB entries). Predicted structures (AlphaFold's
200M+) are now the larger half of the protein-structure universe — the rewrite
treats experimental and predicted as one federated surface.

## Tool surface (carried forward, evolved)

| Tool | Old status | Evolution on the rewrite |
|---|---|---|
| `protein_search_structures` | shipping | RCSB Search API v2; extend coverage to predicted models via AlphaFold / 3D-Beacons |
| `protein_get_structure` | shipping | `source: experimental \| predicted \| best_available`; outline-on-overflow for large mmCIF; surface confidence (pLDDT/PAE) on predicted models |
| `protein_find_similar` | shipping | sequence → RCSB sequence search; structure → **Foldseek** (fast; replaces the DALI-era framing) |
| `protein_track_ligands` | shipping | scope unchanged; RCSB chemical/ligand search |
| `protein_compare_structures` | in-dev | ship via the **RCSB Pairwise Structure Alignment** service (TM-align / jFATCAT) instead of bundling alignment code in-process — keeps it edge-deployable |
| `protein_analyze_collection` | in-dev | aggregate the PDB via **RCSB server-side facets** (terms / histogram / date-histogram / cross-tabs) — one call, no canvas (see [design.md](./design.md) Decision 6) |

**Expansion candidate** (design call): a function/annotation tool
(`protein_get_annotations`-style) over UniProt features, InterPro domains, and
variants/PTMs. The original was structure-only; sequence/function is the natural
adjacent workflow now that UniProt is already in the provider mix.

## Advancements to fold in

**Data sources**

- **AlphaFold DB** — predicted structures at near-proteome scale; the coverage
  expansion that most changes the server's value vs. the original.
- **3D-Beacons** (EMBL-EBI) — federated API serving experimental + predicted
  models from many providers behind one interface. Candidate *primary* provider
  that collapses most of the multi-source layer into one upstream.
- **Foldseek** — fast structural-similarity search; modern replacement for the
  DALI-era structure path.
- **RCSB** — Search API v2 + GraphQL Data API; the hosted Pairwise Structure
  Alignment service for comparison.
- **UniProt / InterPro / PDBe-KB** — sequence + functional annotation (enables the
  expansion tool).

**Framework primitives (mcp-ts-core 0.10.6)**

- **Server-side facet aggregation** (RCSB Search v2) → makes `analyze_collection`
  shippable with no local SQL/canvas; DataCanvas was evaluated and dropped (see
  [design.md](./design.md) Decision 6).
- **outline-on-overflow** for single large records (full mmCIF / coordinate dumps)
  instead of truncating.
- **Multi-source fallback / fan-out** with provenance — one tool, server routes to
  the best provider, output names the source it answered from.
- **Typed error contracts** (`ctx.fail`), `ctx.enrich` truncation/total
  disclosure, **elicitation** for missing input.
- **Confidence-aware outputs** — carry pLDDT / PAE so agents weight predicted vs.
  experimental correctly.

## Open decisions (resolve in design.md)

1. **3D-Beacons as primary** vs. direct RCSB + AlphaFold composition — federation
   simplicity against control and coverage edge-cases.
2. Add the **function/annotation** tool now or defer to a later minor.
3. **Foldseek** access — public web API vs. self-host — for the structure-similarity path.
4. **Edge target** — keep Cloudflare Workers support? It rules out in-process
   alignment and DuckDB, pushing compute to hosted APIs (RCSB alignment) and making
   DataCanvas a node-only feature.
5. Resources: `pdb://{id}`, `af://{uniprot}` for injectable context.

## Next step

Run the `design-mcp-server` skill → `docs/design.md` (live-probe each provider to
confirm response shapes), then scaffold the tools.
