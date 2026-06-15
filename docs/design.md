# protein-mcp-server — Design

Protein structure & function research across **experimental (PDB)** and **predicted (AlphaFold and other 3D-Beacons providers)** structures, from one tool surface. Audience: structural-biology, drug-discovery, and bioinformatics agents.

All provider contracts below were verified against live APIs on 2026-06-15 (see [Provider Probes](#provider-probes-2026-06-15)).

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `protein_search_structures` | Search experimental + predicted structures by free text, sequence, or organism/method/resolution filters. Routes to RCSB Search v2, which indexes both the experimental PDB and computed models (`results_content_type`: `experimental` / `computational` / both) — predicted structures search through the same surface. Returns ranked, metadata-enriched hits — chain identifiers into `protein_get_structure`. Optionally returns a **facet breakdown** (counts by method / organism / release year) alongside the hits for instant corpus orientation at no extra upstream call. | `query` (text), `sequence` (1-letter AA, triggers mmseqs2), `organism`, `method`, `max_resolution`, `content_type` (`experimental`/`predicted`/`all`), `facets` (optional dimensions to summarize), `limit` | `readOnlyHint`, `openWorldHint` |
| `protein_get_structure` | Fetch structures with metadata and coordinate-file URLs. `source` selects experimental (PDB ID), predicted (UniProt accession), or `best_available` (federated pick via 3D-Beacons). Surfaces confidence (pLDDT / PAE) on predicted models. Accepts up to 25 IDs in one batched RCSB GraphQL call with **per-ID partial success** — resolved structures return alongside a `failed[]` list naming any IDs that missed and why. Large mmCIF returns an outline-on-overflow section index. | `ids` (1–25 PDB IDs or UniProt accessions), `source`, `include_coords` (bool), `sections` (outline re-call) | `readOnlyHint`, `openWorldHint` |
| `protein_find_similar` | Find structurally or evolutionarily related proteins. `by: sequence` → RCSB mmseqs2 sequence search; `by: structure` → Foldseek async search against PDB + AlphaFold/BFVD/ESM databases. Output names the engine and database it answered from. | `by` (`sequence`/`structure`), `pdb_id` or `uniprot` or raw `sequence`, `databases`, `max_evalue`, `min_identity`, `limit` | `readOnlyHint`, `openWorldHint` |
| `protein_track_ligands` | Ligand discovery and binding-site analysis. `mode: find_ligand` resolves a name/formula to chemical component IDs; `mode: structures_with_ligand` returns PDB entries bound to a given ligand (exact `comp_id`); `mode: binding_site` returns the **interacting protein residues** lining a ligand's pocket in a given structure (residue, position, chain, contact distance — via RCSB `rcsb_target_neighbors`). Returns chemical metadata (formula, weight, SMILES) on resolution. | `mode`, `query` (name/formula) or `comp_id`, `pdb_id` (for `binding_site`), `limit` | `readOnlyHint`, `openWorldHint` |
| `protein_compare_structures` | Structural alignment of **2–10 structures** via the RCSB Structural Comparison service (TM-align / jFATCAT). Aligns each structure to a reference (default: the first) or computes the full `all_pairs` matrix, fanning out pairwise jobs with a concurrency cap and **per-pair partial success**. Returns TM-score, RMSD, and aligned-residue count per pair. No in-process alignment — fully edge-deployable. | `structures` (2–10; each PDB ID + optional chain), `reference` (`first`/`all_pairs`), `method` (`tm-align`/`fatcat-rigid`/`fatcat-flexible`), `timeout_s` | `readOnlyHint`, `openWorldHint` |
| `protein_analyze_collection` | Profile the PDB into **distributions and trends** — counts by method / organism / polymer type, resolution histograms, release-year timelines, and multidimensional cross-tabs (e.g. method × year) — over an optional scoping query. Backed by RCSB's **server-side facet engine**: one call, compact buckets, no row pull, no SQL canvas. Fully portable (no DuckDB/Workers caveat). | `query` / `sequence` / scope filters (same shape as search), `group_by` (1–2 dimensions), `interval` (numeric bin width, or date `year`/`month`/`quarter`), `bucket_limit` | `readOnlyHint`, `openWorldHint` |
| `protein_get_annotations` | Sequence & functional annotation for a protein: UniProt features (domains, binding sites, PTMs, variants) + InterPro domain/family memberships (Pfam, PROSITE, …) with GO terms. Keyed by UniProt accession; resolves a PDB ID → accession via the RCSB entry's sequence cross-reference (`reference_sequence_identifiers`) when needed. | `uniprot` or `pdb_id`, `include` (`features`/`domains`/`variants`/`all`) | `readOnlyHint`, `openWorldHint` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `pdb://{entry_id}` | Experimental structure summary (title, method, resolution, organism, ligands, chains) — injectable context twin of `protein_get_structure` for `source: experimental`. | none (single entity) |
| `af://{uniprot}` | Predicted-structure summary for a UniProt accession (mean pLDDT, confidence buckets, model URLs, version) from AlphaFold DB. | none (single entity) |

Both resources mirror data already reachable via tools (tool-only clients lose nothing). No `list()` — the corpus is unbounded; discovery happens through `protein_search_structures`.

### Prompts

None at launch. The workflows are data/action-oriented; a structured "analyze this target" prompt is a candidate for a later minor if a recurring framing emerges.

## Overview

The headline shift from the archived v1 (experimental-only over ~230K PDB entries): predicted structures — AlphaFold's 200M+ and the wider 3D-Beacons federation — are now the larger half of the protein-structure universe. This rewrite treats experimental and predicted as **one federated surface**, with provenance always named in output. It modernizes the provider layer (Foldseek replaces the DALI-era structure-similarity path; the RCSB hosted alignment service replaces bundled in-process alignment) and adopts framework primitives that didn't exist on the old `mcp-ts-template`: outline-on-overflow for fat single records, typed error contracts, `ctx.enrich` truncation disclosure, and confidence-aware outputs.

Corpus analytics are served by **RCSB's own server-side facet aggregation** (terms / histogram / date-histogram / multidimensional) rather than a local SQL canvas — the upstream already aggregates, so the server stays stateless and every tool is fully edge-deployable. See [Design Decision 6](#design-decisions) for why DataCanvas was evaluated and dropped.

The server is a **multi-source aggregation** server (per the design skill's boundary table): one workflow — "research a protein's structure and function" — served by six upstreams behind one tool surface. Agents never see provider names in tool names; the handler routes to the best source and the output discloses which one answered.

## Requirements

- Read-only across all providers. No writes, no auth required against upstreams (all public APIs).
- Federate experimental + predicted structures; every structure-returning result carries a `provider` / `source` field and, for predicted models, a confidence score (pLDDT) and confidence-bucket fractions.
- Two async workflows (`protein_compare_structures`, `protein_find_similar by: structure`) submit a job, poll to completion within a bounded timeout, and surface a clear "still computing / try again" path on timeout rather than blocking indefinitely. They share one async-poll helper.
- Batch structure fetches (up to 25 IDs) collapse to a single RCSB GraphQL call — no N+1 — and report per-ID partial success.
- Multi-structure comparison (2–10) fans out pairwise alignment jobs with a concurrency cap and partial success; a slow/failed pair degrades that row, not the call.
- Large single mmCIF/coordinate payloads return an outline, never a silent truncation.
- Corpus analytics run **server-side** (RCSB facets) — no local compute, no canvas, fully portable including Cloudflare Workers.
- No documented hard rate limits on the RCSB / EBI / Foldseek public APIs; be polite (single batched calls, internal concurrency caps on fan-out). The async services (alignment, Foldseek) are the throughput constraint, handled by submit→poll with backoff.

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `rcsb-service` | RCSB **Search API v2** (`search.rcsb.org/rcsbsearch/v2/query`, POST — incl. faceted aggregation), **Data API** REST + **GraphQL** (`data.rcsb.org` — incl. `rcsb_target_neighbors`), file download (`files.rcsb.org`) | `search_structures`, `get_structure`, `find_similar` (sequence), `track_ligands`, `analyze_collection` |
| `beacons-service` | **3D-Beacons** federated API (`www.ebi.ac.uk/pdbe/pdbe-kb/3dbeacons/api`) | `get_structure` (`best_available`) |
| `alphafold-service` | **AlphaFold DB** (`alphafold.ebi.ac.uk/api/prediction/{acc}`) | `get_structure` (predicted), `af://` resource |
| `alignment-service` | **RCSB Structural Comparison API** (`alignment.rcsb.org/api/v1/structures/{submit,results}`, async) | `compare_structures` |
| `foldseek-service` | **Foldseek** ticket API (`search.foldseek.com/api/{ticket,result}`, async) | `find_similar` (structure) |
| `uniprot-service` | **UniProt** REST (`rest.uniprot.org/uniprotkb`) + **InterPro** REST (`www.ebi.ac.uk/interpro/api`) | `get_annotations` |

Each service owns its own retry/backoff calibration (see [Services & Resilience](#services--resilience)). Tools compose across services internally via fallback chains / fan-out; the service boundary is invisible to agents. A shared `withAsyncPoll` helper (submit → poll → bounded timeout) backs both async tools. No canvas/DataCanvas dependency — analytics are a stateless RCSB facet POST.

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `RCSB_SEARCH_BASE_URL` | No | Override RCSB Search v2 base (default `https://search.rcsb.org`). |
| `RCSB_DATA_BASE_URL` | No | Override RCSB Data API base (default `https://data.rcsb.org`). |
| `RCSB_ALIGNMENT_BASE_URL` | No | Override the Structural Comparison service base (default `https://alignment.rcsb.org`). |
| `BEACONS_BASE_URL` | No | Override 3D-Beacons base (default `https://www.ebi.ac.uk/pdbe/pdbe-kb/3dbeacons/api`). |
| `ALPHAFOLD_BASE_URL` | No | Override AlphaFold DB base (default `https://alphafold.ebi.ac.uk`). |
| `FOLDSEEK_BASE_URL` | No | Override Foldseek search base (default `https://search.foldseek.com`). |
| `UNIPROT_BASE_URL` | No | Override UniProt REST base (default `https://rest.uniprot.org`). |
| `INTERPRO_BASE_URL` | No | Override InterPro REST base (default `https://www.ebi.ac.uk/interpro/api`). |
| `PROTEIN_ASYNC_POLL_TIMEOUT_MS` | No | Max wall-clock to poll an async job (alignment / Foldseek) before returning a "still computing" result. Default `30000`. |
| `PROTEIN_MAX_BATCH_IDS` | No | Cap on `get_structure` batch size. Default `25`. |
| `PROTEIN_MAX_COMPARE_STRUCTURES` | No | Cap on structures per `compare_structures` call (bounds pairwise fan-out). Default `10`. |
| `PROTEIN_FACET_BUCKET_CAP` | No | Default cap on buckets returned per `analyze_collection` dimension (terms facets can be large — organism alone exceeds 1,000). Default `50`. |

No API keys — every upstream is keyless. There are no required env vars; the server runs out of the box against public endpoints, on Node/Bun **or** Cloudflare Workers.

## Implementation Order

1. Config (`src/config/server-config.ts`) and `createApp()` wiring (identity already set: `name`/`title` = `protein-mcp-server`).
2. Services: `rcsb-service` → `alphafold-service` → `beacons-service` → `uniprot-service` → `alignment-service` → `foldseek-service` (+ shared `withAsyncPoll`). Each independently testable against its live endpoint with a sparse-payload fixture.
3. Read-only single-call tools: `protein_search_structures` (+ optional facets), `protein_track_ligands` (`find_ligand` / `structures_with_ligand` / `binding_site`), `protein_get_annotations`, `protein_analyze_collection` (facet aggregation — single RCSB POST).
4. Composed / batch tool: `protein_get_structure` (federation + per-ID partial success + outline-on-overflow).
5. Async workflow tools: `protein_find_similar`, `protein_compare_structures` (multi-structure pairwise fan-out).
6. Resources: `pdb://{entry_id}`, `af://{uniprot}`.

Each step is independently testable; remove the `echo.*` scaffold definitions when the first real tool lands.

## Domain Mapping

| Noun | Operations | Backing call(s) |
|:-----|:-----------|:----------------|
| Structure | search (text/seq/facet), get (single/batch), get-coords, best-available | RCSB Search v2; RCSB GraphQL `entries(entry_ids:[...])`; 3D-Beacons summary; AlphaFold prediction |
| Sequence | similarity search | RCSB `service: sequence` (mmseqs2) |
| 3D shape | similarity search, pairwise/multi compare | Foldseek ticket API; RCSB alignment submit/results (fanned out for >2 structures) |
| Ligand | find by name/formula, structures-containing, binding-site residues | RCSB `service: text_chem` (`comp_id` exact); RCSB chemcomp Data API; RCSB GraphQL `rcsb_target_neighbors` |
| Annotation | features, domains, variants, GO | UniProt entry (`ft_*`, `cc_function`); InterPro `entry/interpro/protein/UniProt/{acc}` |
| Collection | aggregate corpus → distributions/trends | RCSB Search facets (terms / histogram / date_histogram / multidimensional), `paginate.rows:0` |

User goals these serve: *find structures of protein X (experimental or predicted)* · *pull a structure's metadata + coordinates + confidence* · *find proteins similar in sequence or fold* · *find structures bound to a given drug/ligand and the residues that bind it* · *quantify how alike a set of structures are* · *what does this protein do — domains, sites, variants* · *profile a slice of the PDB statistically*.

## Workflow Analysis

Two tools run async / fan out; their call flows drive service-method shape, retry boundaries, and timeout handling.

**`protein_compare_structures`** — RCSB Structural Comparison, multi-structure via pairwise fan-out:

| # | Call | Purpose |
|:--|:-----|:--------|
| 0 | build pairs | `reference: first` → (s₀,s₁)…(s₀,sₙ); `all_pairs` → every combination, capped at `PROTEIN_MAX_COMPARE_STRUCTURES` |
| 1…k | `POST /api/v1/structures/submit?query=<urlencoded JSON>` per pair (Content-Type `application/json`) | Submit each pairwise job, concurrency-capped; each returns a bare UUID string |
| poll | `GET /api/v1/structures/results?uuid=<uuid>` per job | `404 "No such UUID"` = not yet ready → shared `withAsyncPoll` backs off until `PROTEIN_ASYNC_POLL_TIMEOUT_MS` |
| merge | collect | Per-pair TM-score / RMSD / aligned-residues; pairs still computing return `status: computing`; failed pairs land in `failed[]` — partial success, never block past the budget |

Single-pair request body (verified): `{"context":{"mode":"pairwise","method":{"name":"tm-align"},"structures":[{"entry_id":"4HHB"},{"entry_id":"2HHB"}]}}`. The method schema is `additionalProperties:false` with only `name` — sending a `parameters` key (even `{}`) fails validation; `selection.asym_id` is an optional per-structure chain restriction (label_asym_id). Method names: `tm-align` / `fatcat-rigid` / `fatcat-flexible`.

**`protein_find_similar` (`by: structure`)** — Foldseek, async ticket flow:

| # | Call | Purpose |
|:--|:-----|:--------|
| 0 | resolve query to a coordinate file | PDB ID → `files.rcsb.org/download/{id}.pdb`; UniProt → AlphaFold `pdbUrl` |
| 1 | `POST /api/ticket` (multipart: `q=@file`, `database[]`, `mode`) | Submit; returns `{ id, status }` |
| 2 | `GET /api/ticket/{id}` | Poll until `status: COMPLETE` (or budget) — same `withAsyncPoll` helper as alignment |
| 3 | `GET /api/result/{id}/{db_index}` | Fetch alignments: per-target `seqId`, `alnLength`, `prob`, `eval`, `score`, `qAln`/`dbAln`; target headers like `AF-P01541-F1`. AlphaFold DB targets follow `AF-{UniProtAccession}-F{fragment}` — extract the accession (`P01541`) to chain into `protein_get_structure` or `protein_get_annotations`. PDB targets use `{PDBID}_{chain}` format. |

`by: sequence` is a single synchronous RCSB `service: sequence` POST — no polling.

**`protein_get_structure` (batch + best_available)** is multi-call but synchronous: one RCSB GraphQL `entries()` call for N experimental IDs (no N+1), or per-accession AlphaFold (predicted) / 3D-Beacons (`best_available`), fanned out with a concurrency cap; unresolved IDs collect into `failed[]`.

**`protein_analyze_collection`** is a single RCSB Search POST with `request_options.facets` and `paginate.rows:0` — no fan-out, no row pull. The `group_by` dimensions map to RCSB facet attributes server-side (see Decision 6).

## Design Decisions

The five open decisions from `idea.md`, resolved against live probes, plus the DataCanvas evaluation (Decision 6).

**1. 3D-Beacons as primary vs. direct RCSB + AlphaFold composition → hybrid: 3D-Beacons for the predicted/federated path, direct RCSB for the experimental search/analytics path.**

Live evidence settles this. A predicted-only accession (`A0A0C5B5G6`) returned **two models from different providers** through 3D-Beacons — AlphaFold DB (AB-INITIO) *and* AlphaFill (TEMPLATE-BASED) — that direct AlphaFold-only composition would miss entirely (the federation also fronts SWISS-MODEL, BFVD, PED, and others). So 3D-Beacons earns the **primary role for "give me models for this UniProt accession" and `best_available`**. But it is *not* a search engine: it's keyed by UniProt accession and returns a per-accession model list, with no full-text / facet / sequence search — and because it is UniProt-keyed, it can't map a PDB ID *to* an accession, so the PDB→UniProt resolve in `get_annotations` runs through the RCSB entry's `reference_sequence_identifiers`, and predicted-structure *search* runs through RCSB Search v2's `computational` content type, not Beacons. The PDB's rich query surface (full-text, mmseqs2 sequence, `text_chem` ligand, organism/method/resolution facets) lives only in RCSB Search v2. And corpus analytics need RCSB's faceted aggregation. So RCSB stays the **direct primary for search, batch metadata, ligands, and analytics**; 3D-Beacons is the federation layer for the predicted half. Neither alone covers the workflow — the hybrid is the honest minimum. AlphaFold DB is kept as a *direct* service too (not only via Beacons) because it carries confidence detail — `globalMetricValue` (mean pLDDT), the four `fractionPlddt*` buckets, and `paeDocUrl` — that the Beacons summary abbreviates, and it backs the `af://` resource.

**2. Add the function/annotation tool now or defer → add now (`protein_get_annotations`).**

UniProt and InterPro are already required (UniProt for accession resolution and sequences, InterPro for domain context), so the marginal cost is one tool over services that must exist anyway. The probes confirm both are clean, keyless, and richly structured (UniProt `ft_domain`/`ft_binding`/`cc_function`; InterPro `{count, results[]}` with Pfam/PROSITE member DBs, GO terms, and an `in_alphafold` flag per protein). Sequence/function is the natural adjacent workflow to structure and rounds the server from "structure viewer" to "protein research." Deferring would ship services with no tool surface — wasted capability.

**3. Foldseek access — public web API vs. self-host → public web API (`search.foldseek.com`), no self-host.**

The full async ticket flow was verified end-to-end: `POST /api/ticket` (multipart structure + `database[]` + `mode`) → poll `/api/ticket/{id}` → `GET /api/result/{id}/{db}` returns complete alignments (`seqId`, `prob`, `eval`, `score`, aligned sequences, Cα coords). `/api/databases` lists PDB, PDB100, AlphaFold UniProt50/Swiss-Prot/Proteome, BFVD, ESM30, CATH50 — covering both experimental and predicted targets. Self-hosting Foldseek means GB-scale target databases and a compute backend — disproportionate to the workflow and incompatible with the edge target (decision 4). The public API is the right dependency; the design's only obligation is honest async handling (submit→poll→timeout) and `openWorldHint` since results depend on a live service.

**4. Edge target (Cloudflare Workers) → keep Workers as a fully supported deployment. No tool degrades.**

The alignment probe settles the original worry. The RCSB Structural Comparison service is a **hosted async REST API** (`/api/v1/structures/submit` → `/results?uuid=`), and Foldseek is likewise hosted — so `protein_compare_structures` and `protein_find_similar` need **zero in-process alignment code**. The only Workers-incompatible piece would have been DuckDB/DataCanvas — and Decision 6 removes that entirely by serving analytics through RCSB's server-side facets instead. The result: **all 7 tools are Workers-portable** (outline-on-overflow is pure measurement + key-slicing; facet analytics is a stateless POST). The federated structure workflow — the headline value — is edge-native, and so is corpus analytics. No tradeoff sacrificed.

**5. Resources → ship `pdb://{entry_id}` and `af://{uniprot}`.**

Both are cheap (each is a single-entity GET already implemented for the tools), stable-URI addressable, and useful as injectable context for clients that support resources. They mirror tool-reachable data, so tool-only clients lose nothing. No `list()` — the PDB/UniProt corpora are unbounded; discovery is the search tool's job, not a resource dump. The split mirrors the federation: `pdb://` is the experimental twin, `af://` the predicted twin.

**6. Corpus analytics: RCSB server-side facets, not a DataCanvas SQL surface.**

DataCanvas was evaluated (the framework offers it) and **dropped** — it does not earn its keep here. The decision rule is *shape, not size*: a canvas earns its keep when an agent must pull row-level data and run local SQL because no server-side aggregation exists (the secedgar case — XBRL frames and 13F holdings have no aggregation API). RCSB is the inverse. Its Search v2 facet engine computes the canonical "profile the corpus" queries server-side in one call:

- **terms** — counts by category (`exptl.method`, `rcsb_entity_source_organism.ncbi_scientific_name`, polymer type)
- **histogram** — numeric distributions (`rcsb_entry_info.resolution_combined`, binned)
- **date_histogram** — timelines (`rcsb_accession_info.initial_release_date` by year/month/quarter)
- **multidimensional** — nested cross-tabs (e.g. method × year)

Probed live: a `"kinase"` query (71,772 entries) returned method counts (X-RAY 55,951 · EM 13,009 · …) and a 48-year histogram in one ~1 KB response; `"hemoglobin"` returned a 21-bin resolution histogram, 1,002 organism buckets, and a method×year cross-tab. Populating a canvas would instead require paging tens of thousands of identifiers, GraphQL-enriching every one, loading DuckDB, and re-aggregating what the facet API already returned — expensive, stateful, and Workers-incompatible, to recompute a result the upstream hands back for free. So `analyze_collection` is a thin facet wrapper: a friendly `group_by` dimension enum (`method`, `organism`, `polymer_type`, `resolution`, `release_year`, …) maps to RCSB attributes + the right aggregation type, with an optional second dimension for cross-tabs. No `query_collection`/SQL tool, no `CANVAS_PROVIDER_TYPE`. The rest of the surface was checked for a genuine canvas fit (`find_similar`, `track_ligands`, `get_annotations`) — all return bounded discovery or single-entity records, not SQL-shaped row sets. This server needs no DataCanvas.

**Capability restorations (from v1, grounded on probes).** Two v1 capabilities the first-pass rewrite had dropped are restored: **binding-site residues** (`track_ligands mode: binding_site`) via RCSB GraphQL `rcsb_target_neighbors` — verified on 1IEP (imatinib → 23 residue contacts with Å distances); PDBe's old `binding_sites` REST path is decommissioned (404), so RCSB is the live source and keeps it inside `rcsb-service`. And **multi-structure comparison** (`compare_structures`, 2–10) built as a concurrency-capped fan-out of the verified pairwise alignment job — no native multi-mode required, partial success per pair.

## Error Design

Typed contracts (`errors: [{ reason, code, when, recovery }]`) for the domain failures agents should plan around; baseline infra errors (5xx, timeout, validation) bubble.

| Tool | reason | code | when | recovery |
|:-----|:-------|:-----|:-----|:---------|
| `get_structure` | `not_found` | `NotFound` | Valid-format ID with no entry/model. RCSB Data API → `404 {status,message}`; AlphaFold bad-format → `400 {error}`. In a batch, a missed ID lands in `failed[]` (partial success), not a thrown error. | Verify the ID format (PDB IDs are 4-char alphanumeric; UniProt accessions match `[OPQ][0-9][A-Z0-9]{3}[0-9]` or `[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9]`). Use `protein_search_structures` to locate the correct identifier. |
| `get_structure` | `mixed_id_types` | `InvalidParams` | Batch mixes PDB IDs and UniProt accessions under a single `source` that can't serve both. | Split the call by source: one call for PDB IDs with `source: experimental`, another for UniProt accessions with `source: predicted`. |
| `search_structures` | `no_results` | (success, empty) | Empty `result_set`. Disclosed via `ctx.enrich` notice, not an error. | Broaden the query (fewer filters, shorter sequence), or switch `content_type` between `experimental`/`predicted`/`all`. |
| `find_similar` | `job_timeout` | (success, `status: computing`) | Async job exceeds `PROTEIN_ASYNC_POLL_TIMEOUT_MS`. Returns the ticket ID + status; not an error. | Re-call with the returned ticket ID (or simply re-submit) after a short wait. Increase `PROTEIN_ASYNC_POLL_TIMEOUT_MS` for large databases. |
| `compare_structures` | `job_timeout` | (success, per-pair `status: computing`) | One or more pairwise jobs exceed the budget; their rows carry the alignment UUID. Completed pairs still return. | Re-call after a short wait (cold RCSB alignment jobs typically finish within 30–60 s), or narrow `structures`. |
| `compare_structures` | `alignment_failed` | (success, per-pair in `failed[]`) | A pair's job errors (e.g., incompatible selections, chain not found). The pair lands in `failed[]`; other pairs are unaffected. | Verify chain IDs exist on both structures via `protein_get_structure`. Omit the chain selection to align the full entry. |
| `track_ligands` | `not_found` | `NotFound` | `comp_id` doesn't resolve in the chemical dictionary, or (`binding_site`) the `pdb_id` has no instance of the ligand. | Use `mode: find_ligand` first to resolve a name to a `comp_id`; confirm the ligand is present in the structure via `protein_get_structure`. |
| `get_annotations` | `no_uniprot_mapping` | `NotFound` | A PDB ID with no UniProt cross-reference (e.g., nucleic-acid-only entry or non-modeled entity). | Pass a `uniprot` accession directly instead of a PDB ID, or use `protein_search_structures` to find a structure with a modeled protein chain. |
| `analyze_collection` | `unknown_dimension` | `InvalidParams` | A `group_by` value outside the supported dimension enum. | Use a supported dimension (`method`, `organism`, `polymer_type`, `resolution`, `release_year`, …); see the tool's input schema. |

`async` timeouts and empty results are modeled as **success variants with a status field**, not thrown errors — the agent's next move (re-call / broaden) is data, not an exception. Batch and multi-pair tools model partial outcomes the same way: a `failed[]` / per-pair status array, never an all-or-nothing throw. This matches the framework's "server reports observable state, agent decides recovery" principle.

## Known Limitations

- **AlphaFold coverage is effectively total for UniProt.** Every well-formed accession probed (`P69905`, `P00520`, `A0A000`, `P99999`, `A8MT69`) returned a model; the only failure mode observed is a `400` on a malformed identifier. So `best_available` will almost never fall through to "no predicted model" for a real accession — the practical not-found case is a bad ID, not absent coverage. `idea.md`'s framing of "no predicted model" as a common branch overstates it; the design treats AFDB as a near-universal predicted fallback and reserves `not_found` for format errors and genuine PDB-entry misses.
- **RCSB search returns identifiers only** — every `return_type` (`entry`, `polymer_entity`, `mol_definition`) yields `{identifier, score}` with no metadata. Every search is inherently two-step (search → Data API / GraphQL enrich). The design absorbs this inside `search_structures` (enrich the top page via one GraphQL batch) so agents see metadata-bearing hits, not bare IDs.
- **Ligand full-text is noisy.** `service: full_text` for a ligand name returns loosely-matched components (querying "imatinib" surfaced amino acids). `track_ligands` uses `service: text_chem` with `comp_id` `exact_match` for structures-with-ligand, and routes name→comp_id resolution through the chemical-dictionary search, not free text.
- **Binding-site residues are experimental-only.** `rcsb_target_neighbors` is computed from deposited coordinates, so `mode: binding_site` works on PDB entries, not predicted (AlphaFold) models, which have no bound ligands. The `track_ligands` description states this.
- **Facet cardinality is capped.** Terms facets can be large (organism alone exceeds 1,000 buckets); `analyze_collection` caps buckets per dimension (`PROTEIN_FACET_BUCKET_CAP`, default 50) and discloses truncation via `ctx.enrich.truncated()`. For the long tail, scope the query tighter.
- **Multi-structure compare cost scales with pairs.** `reference: first` is N−1 jobs; `all_pairs` is N·(N−1)/2. Each is an independent async alignment; wall-clock is bounded by the poll budget, and unfinished pairs return `status: computing` for re-call rather than blocking.
- **Async services have no instant results.** Alignment and Foldseek are genuinely asynchronous; a cold job is not ready on first poll (verified: a fresh alignment UUID returns `404 "No such UUID"` until computed). The bounded-poll + `status: computing` return is the contract, not a workaround.
- **3D-Beacons 404 returns `{}`** (an empty object), not an error envelope — the service layer must treat an empty/`{}` body as "no models," distinct from a transport error.

## Provider Probes (2026-06-15)

Confirmed contracts (one list/search, one single-GET, one forced error per major provider, plus batch/async/facet/interaction paths):

| Provider | Endpoint | Verified |
|:---------|:---------|:---------|
| RCSB Search v2 | `POST search.rcsb.org/rcsbsearch/v2/query` | `{query_id, total_count, result_set:[{identifier, score}]}`; `full_text`/`sequence`(mmseqs2)/`text_chem` services; `return_type` entry/polymer_entity/mol_definition; `paginate{start,rows}`. |
| RCSB Search facets | `POST …/query` with `request_options.facets`, `paginate.rows:0` | Server-side aggregation in one call. **terms** (`exptl.method`, `rcsb_entity_source_organism.ncbi_scientific_name`), **histogram** (`rcsb_entry_info.resolution_combined`, `interval` numeric), **date_histogram** (`rcsb_accession_info.initial_release_date`, `interval:"year"`), and **multidimensional** (nested `facets[]` within a bucket) all confirmed. `"kinase"` → 71,772 entries, method (10 buckets) + year (48); `"hemoglobin"` → 9,064, resolution (21 bins, 0.5 Å) + organism (1,002) + method×year cross-tab (X-RAY → 49 year buckets). |
| RCSB Data API | `GET data.rcsb.org/rest/v1/core/entry/{id}`; `/chemcomp/{id}` | Rich nested JSON; 404 → `{status:404, message, link}`. |
| RCSB GraphQL | `POST data.rcsb.org/graphql` | `entries(entry_ids:[...])` batches N entries in one call (title, exptl method, resolution, MW) — the N+1 killer. `nonpolymer_entity_instances.rcsb_target_neighbors` → binding-site residues `{target_asym_id, target_comp_id, target_seq_id, distance}`. Verified: 1IEP (imatinib/STI) → 23 contacts (ILE138, ASP159, THR93 … with Å distances). Field is `rcsb_target_neighbors`, **not** `rcsb_ligand_neighbors` (undefined). |
| RCSB Alignment | `POST alignment.rcsb.org/api/v1/structures/submit?query=…` → `GET …/results?uuid=` | `RCSB STRUCTURAL COMPARISON API v1`. Submit → bare UUID; poll → `404 "No such UUID"` until ready. **Correct path is `/structures/submit`, not `/submit`.** Native mode is `pairwise`; >2 structures handled by fanning out pairs. |
| AlphaFold DB | `GET alphafold.ebi.ac.uk/api/prediction/{acc}` | JSON **array**; `globalMetricValue` (mean pLDDT), `fractionPlddt{VeryLow,Low,Confident,VeryHigh}`, `cifUrl`/`pdbUrl`/`bcifUrl`/`paeImageUrl`/`paeDocUrl`, `latestVersion`/`allVersions`. Bad-format → `400 {error}`. No 404/empty seen for well-formed accessions. |
| 3D-Beacons | `GET www.ebi.ac.uk/pdbe/pdbe-kb/3dbeacons/api/uniprot/summary/{acc}.json` | `{uniprot_entry, structures:[{summary:{model_identifier, model_category, provider, model_url, coverage, resolution?, experimental_method?, confidence_type?, confidence_avg_local_score?, entities[]}}]}`. `confidence_avg_local_score` is **conditional**: present on predicted AB-INITIO (AlphaFold DB, `pLDDT`) and some TEMPLATE-BASED (SWISS-MODEL, `QMEANDisCo`); absent/null on AlphaFill and all EXPERIMENTALLY DETERMINED entries. `resolution` absent on predicted-only entries. Federates PDBe + AlphaFold DB + AlphaFill + SWISS-MODEL + more. 404 → `{}`. |
| PDBe binding sites | `GET www.ebi.ac.uk/pdbe/api/pdb/entry/binding_sites/{id}` | **Decommissioned — 404 `{"detail":"Not Found"}`.** Binding-site residues sourced from RCSB GraphQL `rcsb_target_neighbors` instead (above), keeping it inside `rcsb-service`. |
| Foldseek | `POST search.foldseek.com/api/ticket` → `GET /api/ticket/{id}` → `GET /api/result/{id}/{db}` | `{id, status}`; results `{results:[{db, alignments:[[{target, seqId, alnLength, prob, eval, score, qAln, dbAln, tCa}]]}]}`. `/api/databases` paths (pass as `database[]`): `pdb_folddisco`, `pdb100`, `afdb50`, `afdb-swissprot`, `afdb-proteome`, `BFVD`, `esm30_folddisco`, `cath50`, `mgnify_esm30`, `gmgcl_id`, `bfmd`. |
| UniProt | `GET rest.uniprot.org/uniprotkb/{acc}?fields=…&format=json` | `{primaryAccession, proteinDescription, genes, organism, comments[](FUNCTION), features[](Domain/Binding/…)}`; field selection supported. Bad-format → `400`. |
| InterPro | `GET www.ebi.ac.uk/interpro/api/entry/interpro/protein/UniProt/{acc}/` | `{count, results:[{metadata:{accession, name, type, member_databases{pfam,profile,…}, go_terms[]}, proteins:[{in_alphafold, entry_protein_locations[]}]}]}`. |

## Services & Resilience

Per-service backoff calibrated to upstream behavior (`withRetry` from `/utils`, retry boundary wraps fetch + parse):

| Service | Base delay | Notes |
|:--------|:-----------|:------|
| `rcsb-service` | 300–500ms | Fast, unmetered public API; retry the GraphQL/Search POST and Data GET as units. Detect HTML error pages → transient, not `SerializationError`. Facet aggregation and `rcsb_target_neighbors` are ordinary Search/GraphQL POSTs — same boundary. |
| `alphafold-service` | 300ms | Static file-backed JSON; quick. Treat `400` as a client error (don't retry). |
| `beacons-service` | 500ms | Federated aggregator, occasionally slower under fan-out. Empty `{}` body = no models (not a retryable failure). |
| `alignment-service` | poll: 1–2s backoff, capped by `PROTEIN_ASYNC_POLL_TIMEOUT_MS` | Async. Submit is fast; results poll holds `404` until computed — don't classify that 404 as terminal during the poll window. Multi-structure compare fans out pairs through `withAsyncPoll` with a concurrency cap. |
| `foldseek-service` | poll: 1–2s backoff, same budget | Async ticket. `status` field drives completion, not HTTP code. Shares `withAsyncPoll` with alignment. |
| `uniprot-service` | 300–500ms | UniProt + InterPro both fast; `400` = bad accession (client error). |

API-efficiency choices baked into service methods: batch via RCSB GraphQL `entries()` for multi-ID fetch; UniProt `fields=` selection to trim payloads; enrich only the displayed search page (not the full result set) to bound cost; corpus analytics aggregate **server-side** via facets (no row pull); internal `Promise.allSettled` with a concurrency cap on any per-accession or per-pair fan-out (`best_available` over a list, multi-structure compare).
