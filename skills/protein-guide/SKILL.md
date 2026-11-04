---
name: protein-guide
description: Identifier chains and gates for the protein_* tools - which ID each tool takes (PDB entry, polymer entity, RCSB computed model, AlphaFold entry, UniProt accession or isoform, ligand component), author versus label chains, residue numbering, and reading homolog, ligand, best-available, and PDB-profile results. Use before passing one protein_* result into another call, or reporting scores, counts, chains, or residue numbers from them.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

Protein structure and function, keyless: search, metadata, coordinates, and corpus counts over experimental PDB entries and the computed models RCSB indexes; ligands and binding-site residues in experimental entries; AlphaFold DB and 3D-Beacons models by UniProt accession; Foldseek fold search; RCSB structural alignment; UniProt features and variants with InterPro memberships.

Not here: fetching a protein's sequence, resolving a gene or protein name to a UniProt accession, and binding affinities. Pair with a UniProt server for sequences and accessions, and a bioactivity server for affinities.

## Identifiers

| ID | Example | Comes from | Goes to |
|:--|:--|:--|:--|
| Polymer entity | `4HHB_1` | `entityId` on sequence hits; `polymerEntities[]`; `hostEntities[]`; `queryEntityId` | Not an input. The row's `id` is the entry; find the entity in that entry's `polymerEntities` for its chains |
| RCSB computed model | `AF_AFP69905F1`, `MA_…` | predicted hits from `protein_search_structures` | `protein_get_structure` with source `experimental`; it returns as `predicted`, with polymer entities. `protein_compare_structures` takes the `AF_` form as `pdb_id` |
| AlphaFold DB entry | `AF-P69905-F1`, `AF-P04637-2-F1` | `af://` `entryId` | `protein_get_structure` with source `predicted` or `best_available`; `af://` |
| UniProt accession | `P69905`; isoform `P04637-2` | `uniprotAccession` on AlphaFold search and Foldseek hits; `accession` from `protein_get_annotations` | `protein_get_structure` (`predicted`, `best_available`), `af://`, `protein_find_similar`; `protein_get_annotations` takes the canonical form only |
| UniProtKB entry name | `HBA_HUMAN` | a UniProt server | `protein_find_similar` only, which resolves it to its entry's accession; every other tool takes the accession |
| Picked PDB entry | `pdbId` | `best_available` records | `protein_get_structure` with source `experimental`, for entities, chains, and ligands |
| Chemical component | `STI`, `HEM` | `find_ligand` `compId`; `ligands[].compId` | `structures_with_ligand`, `binding_site`, the ligand filter of `protein_search_structures` |

`AF_` with an underscore is RCSB's computed-model ID; `AF-` with a hyphen is AlphaFold DB's entry ID. Each goes under the source its row names.

Chain IDs come in two namespaces, both case-sensitive:

| Namespace | Carried by | Taken by |
|:--|:--|:--|
| Author (`auth_asym_id`) | `polymerEntities[].authAsymIds`; binding-site `authAsymId` and `ligandAsymId`; `chain` on `pdb100` Foldseek hits | `chain` on `protein_get_annotations` and `protein_find_similar` (`by: sequence`) |
| Label (`label_asym_id`) | `polymerEntities[].labelAsymIds`; binding-site `asymId` | `chain` on `protein_compare_structures` |

## Gates

- **Never pair the two chain lists by position.** RCSB sorts `authAsymIds` and `labelAsymIds` independently: for 6QNR_9 the label chains are I, OB and the author chains 82, 8E, and label I is author 8E. To move between namespaces, pick the entity, then read the list you need from that entity.
- **Pin the protein in a multi-protein entry.** A PDB ID names an entry, which can hold several proteins plus DNA or RNA. `protein_get_annotations` defaults to the lowest author chain and lists the other accessions in `ambiguity`; `protein_find_similar` by sequence defaults to the lowest-numbered protein entity of at least 10 residues, never DNA or RNA, and names it in `queryEntityId`. Pass the author `chain` of the protein you mean (4HHB `B` reaches the beta chain, 4HHB_2; `chain` needs `pdb_id` and applies to `by: sequence` only), and check `accession` or `queryEntityId` before reporting.
- **`best_available` returns one pick.** It takes a PDB entry when one exists, ranked by coverage, then resolution; otherwise the most confident other model (pLDDT and QMEANDisCo compared on one scale, unscored models last), which can be a non-PDB experimental model such as SASBDB's. Read `coverage`, `uniprotStart`, and `uniprotEnd` before calling a pick full-length. Only a record with `pdbId` is a PDB entry, and its polymer entities, chains, and ligands come only from re-calling with that `pdbId` under source `experimental`.
- **Retired accessions.** A merged accession answers as its successor with a notice (Q1HDT5 answers as P69905): report the successor, the returned `accession`; `protein_find_similar` names it only in the notice. A demerged or deleted one fails `inactive_accession`, or lands in `failed[]` on `protein_get_structure`, with its `replacements`. A demerged accession lists several (P62988 has four): pick the one you mean, never the first by default.
- **Isoforms work everywhere but annotations.** `P04637-2` and `AF-P04637-2-F1` resolve on `protein_get_structure` (`predicted`, `best_available`) and `af://`, and `protein_find_similar` takes the canonical or isoform accession, or the entry name (`HBA_HUMAN`), in both modes (a malformed one fails `invalid_accession`). `protein_get_annotations` rejects an isoform and names the canonical accession; UniProt carries no features for the isoform itself. `P04637-1` is the canonical sequence: pass `P04637`.
- **An RCSB sequence hit's `score` is a rank.** RCSB rescales it between the best and worst hit of that one search (for P69905, 1.0 at the head of the list, 0.0 at the tail), so it compares nothing across searches. Report `identity`, `evalue`, and the aligned range, present whenever RCSB returns an alignment for the hit.
- **Not every Foldseek hit chains onward.** `pdb100`, `afdb50`, `afdb-swissprot`, `afdb-proteome`, and `cath50` hits carry an `id`: a PDB entry, or the accession of an AlphaFold model (`cath50` domains map to either). `bfvd_v3`, `mgnify_esm30`, `gmgcl_id`, and `bfmd` hits are predicted models with no `id`: cite `target`. A `bfvd_v3` hit keeps its `uniprotAccession`, but that accession is no reliable route back to the BFVD model itself.
- **Group Foldseek rows by entry before counting.** One entry fills several rows, one per matched chain or assembly (6KAI appears three times in 4HHB's top 100), so count distinct `id` values.
- **A Foldseek `query` is a file position, not a chain.** Query 0 is the first chain Foldseek read from the submitted file, query 1 the second; nothing maps a query to an author chain ID. A `pdb100` hit's `chain` is the target's author chain, and a `-N` suffix marks a symmetry copy: drop the suffix before passing it to `protein_get_annotations`.
- **Residue numbers carry their namespace.** Binding-site `seqId` is the position in the entity sequence; `authSeqId` is the depositor's numbering, used by literature and viewers; no fixed offset relates them (1IEP: label THR93 is author THR315). `protein_get_annotations` positions and InterPro fragments are UniProt numbering, and Foldseek spans count along the sequence Foldseek indexed. No tool maps residue numbers from one to another, so never match a pocket residue to a UniProt feature by number alone; report each number with its namespace.
- **Ligand counts are bound copies.** `structures_with_ligand`, `depositionCount`, and the ligand filter of `protein_search_structures` match entries with a non-polymer instance of the component. A component present only as a residue inside a polymer chain, or a sugar inside a branched glycan, is not counted: `MSE` matches about 20 entries, not the 10,000-plus that hold it in polymer chains.
- **Confirm the protein behind a ligand hit.** `query` is loose full text: ABL1 with ligand STI still returns every imatinib entry, while SYK with STI narrows to 1XBB. Check each entry's protein (`hostEntities`, or `polymerEntities`) before reporting "X bound to Y". `hostEntities` names the entities whose chains the depositor assigned the ligand to; a ligand at an interface lists one side only, so use `binding_site` for the residues that contact it.
- **Organism filter.** It matches the taxon and every taxon under it, by scientific name, NCBI common name, or taxon ID; word fragments (`sapiens`, `coli`) match nothing. `Homo sapiens`, `human`, and `9606` each return a slightly different set, so spell an organism one way across counts you compare.
- **Computed models carry no method, resolution, or ligands.** A `method`, `max_resolution`, or ligand filter keeps experimental entries only, and under content type `predicted` matches nothing.
- **Set `content_type` when comparing counts.** `protein_search_structures` defaults to `all` and `protein_analyze_collection` to `experimental`, so their totals for the same filters differ unless you set it.
- **Organism buckets overlap.** An entry with several source organisms counts in each of their buckets, so organism buckets can sum past `total`. Report bucket counts, never their sum, as entries.
- **A capped batch is partial.** Inputs past the server's batch cap return in `ignored`, never looked up, and unresolved IDs in `failed[]`. Resubmit `ignored` before reporting on the whole set; for `protein_compare_structures` with reference `first`, put the original reference ahead of them. On `protein_get_structure`, a `failed[]` row whose reason says an upstream lookup failed, or the time budget ran out, is not a missing structure: re-call with that ID (fewer IDs per call if the budget stopped it) before reporting it has none, and treat `upstream_unavailable` the same way for the whole call.

## Workflows

**One protein's structures.** With a UniProt accession: `protein_get_structure` with source `best_available` for one pick, `predicted` for the AlphaFold DB model. For the experimental entries of that protein, `protein_find_similar` by sequence from the accession with `min_identity` near 1, keeping hits whose `organisms` match; `queryStart` and `queryEnd` show how much of the protein each covers. For computed models in a sequence search, use `protein_search_structures` with the sequence and content type `predicted` or `all`.

**Homologs.** By sequence for identity and E-value; by structure (Foldseek) for fold similarity across PDB and predicted databases. A multichain entry runs one Foldseek query per chain and takes no `chain`: page its queries with the ticket, or search from the UniProt accession, which submits that protein's AlphaFold DB model.

**Ligand to pocket.** `find_ligand` resolves a name or formula to a component ID. Then `structures_with_ligand`, whose rows name `hostEntities`, or `protein_search_structures` with the ligand filter plus organism, method, resolution, or a sequence. `binding_site` with the entry and the component returns the pocket; `protein_get_annotations` with the entry and a pocket residue's `authAsymId` as the `chain` gives that protein's UniProt accession and features (numbering gate).

**Align specific chains.** `protein_get_structure` (source `experimental`) or `pdb://` for the entry; choose the entity by `entityId` or description, and pass one of its `labelAsymIds` as the `chain`. From a sequence hit, match its `entityId`; from a `pdb100` Foldseek hit, take the entity whose `authAsymIds` hold the hit's `chain` (suffix dropped).

**Coordinates.** Prefer `coordinateUrls`. Inline coordinates come one file at a time in 24,000-character windows: select one structure, then re-call with `coords_offset` set to `coordinatesNextOffset` until it is absent, and join the windows in order. 1CRN's mmCIF takes 3 windows; 4HHB's takes 33.

**Profile the PDB.** `protein_analyze_collection` returns counts, not entries; `protein_search_structures` with the same query, organism, method, resolution, and content type lists the entries in that scope.
