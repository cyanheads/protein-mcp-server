# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

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
