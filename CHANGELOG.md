# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.8.3](changelog/0.8.x/0.8.3.md) — 2026-09-22

Fixes computed-model sequence-hit IDs, dead coordinate-file URLs, reversed alignment-resume labeling, and false zero-match notices past the last results page; tool/resource descriptions reworded to drop implementation leaks.

## [0.8.2](changelog/0.8.x/0.8.2.md) — 2026-09-21

Adopts mcp-ts-core 0.13.6: argument rejections carry recovery hints (0.13.3), tool arguments pass pre-validation aliasing (0.13.4), and tool-error text names its reason (0.13.5); server instructions rewritten for workflow chaining.

## [0.8.1](changelog/0.8.x/0.8.1.md) — 2026-09-16

Adopts @cyanheads/mcp-ts-core 0.13.2, declaring stateless HTTP session mode in source, plus dependency and skills-tree maintenance.

## [0.8.0](changelog/0.8.x/0.8.0.md) — 2026-09-09 · ⚠️ Breaking

protein_find_similar rejects fields the selected by mode can't consume and paginates completed structure searches with a re-usable ticket; protein_get_annotations reclassifies a missing or malformed identifier as InvalidParams; plus RCSB GraphQL, ligand-formula, and get_structure text-surface fixes.

## [0.7.0](changelog/0.7.x/0.7.0.md) — 2026-09-08 · ⚠️ Breaking

protein_get_structure exposes per-entity authAsymIds/labelAsymIds chain namespaces plus entry detail (ligands, molecular weight, release date), accumulates every advisory instead of overwriting, and gates the coordinate overflow budget on a single oversized file too; pdb://{entry_id}'s polymerEntities[].chains is renamed to authAsymIds.

## [0.6.0](changelog/0.6.x/0.6.0.md) — 2026-09-08 · ⚠️ Breaking

protein_analyze_collection's truncation notice covers nested cross-tab children and empty scopes, interval routes to whichever group_by dimension can consume it and is narrowed to RCSB's supported values, and protein_search_structures rejects sequence-only thresholds and surfaces capped-facet recovery guidance.

## [0.5.3](changelog/0.5.x/0.5.3.md) — 2026-08-30

RCSB-backed tools support offset pagination; structure searches accept method or resolution criteria alone, retain chainable sequence-hit IDs, and enrich every entry on a returned sequence page.

## [0.5.2](changelog/0.5.x/0.5.2.md) — 2026-08-25 · ⚠️ Breaking

Tool inputs are strict now — an unrecognized argument key is rejected instead of stripped — and cache hints let 2026-07-28 clients hold listings and resource reads for up to an hour; HTTP session mode is pinned to stateless.

## [0.5.1](changelog/0.5.x/0.5.1.md) — 2026-08-16

protein_analyze_collection reports the realized bucket total, and bucket_limit's per-dimension-level semantics are now stated explicitly everywhere it's described.

## [0.5.0](changelog/0.5.x/0.5.0.md) — 2026-08-16 · ⚠️ Breaking

protein_analyze_collection's nested facet child is now a single optional field instead of an array, and all three collection/comparison tools reject duplicate or ambiguous inputs with typed errors.

## [0.4.2](changelog/0.4.x/0.4.2.md) — 2026-08-16

protein_find_similar's Foldseek identity score now returns a 0–1 fraction as declared, protein_get_structure and af:// no longer lose a whole predicted-source batch to one malformed ID, and protein_compare_structures reports per-structure modeled-residue count and coverage.

## [0.4.1](changelog/0.4.x/0.4.1.md) — 2026-08-16

protein_search_structures' default content_type union now returns computed models, facet dimensions disclose coverage gaps and empty-dimension explanations, and protein_get_structure credits computed-model IDs to their modelling provider instead of the PDB.

## [0.4.0](changelog/0.4.x/0.4.0.md) — 2026-07-03

protein_get_annotations gains a per-class limit to cap features/variants/domains independently, and protein_compare_structures documents TM-score's length-normalization sensitivity to terminal length differences.

## [0.3.3](changelog/0.3.x/0.3.3.md) — 2026-07-03

protein_analyze_collection accepts stringified numeric inputs, protein_track_ligands find_ligand decouples its ranking pool from the display limit, and numeric facet histogram buckets carry explicit rangeFrom/rangeTo bounds.

## [0.3.2](changelog/0.3.x/0.3.2.md) — 2026-07-03

protein_track_ligands find_ligand now ranks by deposition frequency instead of name order; structures_with_ligand sorts by resolution instead of a constant score; protein_find_similar sequence hits emit a chainable entry id with the entity id preserved separately.

## [0.3.1](changelog/0.3.x/0.3.1.md) — 2026-07-03

best_available confidence scores are now scale-correct and self-describing instead of overloading meanPlddt; experimental best_available picks return the full cif/pdb/bcif coordinate set, matching source: experimental.

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-07-03

protein_get_annotations disambiguates multi-chain PDB entries via a new chain input; protein_get_structure and protein_get_annotations both carry upstream data-source attribution (license + citation).

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-07-03

Nested cross-tab facet children now carry a truncated flag; declared error recovery hints reach the wire; protein_track_ligands binding_site honors limit.

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-07-03 · 🛡️ Security

Resume protein_find_similar and protein_compare_structures jobs by ticket/UUID instead of resubmitting; compare_structures structures cap widened to the configured 2–25 range with a truncation notice; dependency refresh clears a moderate js-yaml advisory.

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-06-23

Narrow the public description and server instructions from 'structure & function' to 'structure & annotation'. No behavior changes.

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-06-20

Maintenance: mcp-ts-core ^0.10.6 → ^0.10.9, re-synced framework scripts/skills and devcheck guards. No behavior changes.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-06-18

Published metadata now advertises the public hosted Streamable HTTP endpoint at https://protein.caseyjhand.com/mcp.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-18

Zero-result RCSB searches return empty sets sub-second instead of a retried outage error; protein_track_ligands missing-param guards now classify as InvalidParams; protein_get_structure best_available surfaces the chosen pdbId.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-06-15

Initial release: federated protein structure & function across PDB, AlphaFold, UniProt, InterPro, and Foldseek — 7 tools, 2 resources.
