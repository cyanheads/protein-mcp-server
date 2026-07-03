/**
 * @fileoverview Upstream data-source attribution — the license and citation each
 * contributing database asks to travel with its data. `protein_get_structure` and
 * `protein_get_annotations` project the sources that actually contributed to a
 * response into a deduped attribution array, so the obligation rides with the data
 * to every downstream consumer rather than living only in repo docs. Curated
 * strings are verified against each source's primary license/citation page.
 * `best_available` structures are federated through 3D-Beacons, an open set of
 * model providers (AlphaFold DB, SWISS-MODEL, BFVD, AlphaFill, …), so an uncurated
 * provider gets an honest fallback entry that asserts no license rather than a
 * fabricated one. Pure data + a projection helper; the Zod output schema and
 * renderer live in the tools' shared `_schemas.ts`.
 * @module services/shared/attribution
 */

/**
 * Curated data-source display names (verified license + citation), in canonical
 * render order. The structure sources come first (RCSB PDB, then the federated
 * predicted providers), followed by the annotation trio.
 */
export const CURATED_SOURCES = [
  'RCSB PDB',
  'AlphaFold DB',
  'SWISS-MODEL',
  'BFVD',
  'UniProt',
  'InterPro',
  'GO',
] as const;

/** A curated data-source display name with a verified license + citation. */
export type CuratedSource = (typeof CURATED_SOURCES)[number];

/** License, citation, and homepage for one contributing data source. */
export interface Attribution {
  /** Primary-literature citation the source asks consumers to cite. */
  citation: string;
  /** Source homepage. */
  homepage: string;
  /** License the source's data is released under (e.g. "CC BY 4.0"). */
  license: string;
  /** Data-source display name (a curated name, or a federated provider string). */
  source: string;
}

/**
 * Canonical license + citation strings, keyed by source. Verified against each
 * source's primary license/citation page. CC BY / CC BY-SA sources require
 * attribution to travel with redistributed data; CC0 sources are citation-only
 * (attribution encouraged, not required) but carried here so the obligation is
 * legible either way. InterPro's own domain/family data is CC0 — the CC BY 4.0 GO
 * terms carried alongside it are a separate, independently-gated source.
 */
const ATTRIBUTIONS: Record<CuratedSource, Attribution> = {
  'RCSB PDB': {
    source: 'RCSB PDB',
    license: 'CC0 1.0 Universal',
    citation:
      'H.M. Berman et al., "The Protein Data Bank," Nucleic Acids Research 28:235–242 (2000). DOI: 10.1093/nar/28.1.235',
    homepage: 'https://www.rcsb.org/',
  },
  'AlphaFold DB': {
    source: 'AlphaFold DB',
    license: 'CC BY 4.0',
    citation:
      'Jumper et al., "Highly accurate protein structure prediction with AlphaFold," Nature 596:583–589 (2021). DOI: 10.1038/s41586-021-03819-2; Bertoni et al., "AlphaFold Protein Structure Database 2025: a redesigned interface and updated structural coverage," Nucleic Acids Research 54(D1):D358–D362 (2025). DOI: 10.1093/nar/gkaf1226',
    homepage: 'https://alphafold.ebi.ac.uk/',
  },
  'SWISS-MODEL': {
    source: 'SWISS-MODEL',
    license: 'CC BY-SA 4.0',
    citation:
      'Waterhouse et al., "SWISS-MODEL: homology modelling of protein structures and complexes," Nucleic Acids Research 46(W1):W296–W303 (2018). DOI: 10.1093/nar/gky427; Bienert et al., "The SWISS-MODEL Repository—new features and functionality," Nucleic Acids Research 45(D1):D313–D319 (2017). DOI: 10.1093/nar/gkw1132',
    homepage: 'https://swissmodel.expasy.org/',
  },
  BFVD: {
    source: 'BFVD',
    license: 'CC BY 4.0',
    citation:
      'Kim et al., "BFVD—a large repository of predicted viral protein structures," Nucleic Acids Research 53(D1):D340–D347 (2025). DOI: 10.1093/nar/gkae1119',
    homepage: 'https://bfvd.steineggerlab.workers.dev/',
  },
  UniProt: {
    source: 'UniProt',
    license: 'CC BY 4.0',
    citation:
      'The UniProt Consortium, "UniProt: the Universal Protein Knowledgebase in 2025," Nucleic Acids Research 53(D1):D609–D617 (2025). DOI: 10.1093/nar/gkae1010',
    homepage: 'https://www.uniprot.org/',
  },
  InterPro: {
    source: 'InterPro',
    license: 'CC0 1.0 Universal',
    citation:
      'Blum et al., "InterPro: the protein sequence classification resource in 2025," Nucleic Acids Research 53(D1):D444–D456 (2025). DOI: 10.1093/nar/gkae1082',
    homepage: 'https://www.ebi.ac.uk/interpro/',
  },
  GO: {
    source: 'GO',
    license: 'CC BY 4.0',
    citation:
      'Ashburner et al., "Gene Ontology: tool for the unification of biology," Nature Genetics 25:25–29 (2000). DOI: 10.1038/75556; Gene Ontology Consortium, "The Gene Ontology knowledgebase in 2026," Nucleic Acids Research 54(D1):D1779–D1792 (2026). DOI: 10.1093/nar/gkaf1292',
    homepage: 'https://geneontology.org/',
  },
};

const CURATED_NAMES = new Set<string>(CURATED_SOURCES);

/**
 * Honest fallback for an uncurated federated provider (AlphaFill, or any 3D-Beacons
 * provider without a verified license entry). Asserts no license — better to point
 * the consumer at the provider's own terms than to fabricate one.
 */
function fallbackAttribution(source: string): Attribution {
  return {
    source,
    license: 'See provider terms',
    citation: 'Federated via 3D-Beacons — consult the provider for citation and license terms.',
    homepage: 'https://3d-beacons.org/',
  };
}

/**
 * Project the source names that contributed to a response into a deduped
 * attribution array. Curated names render first in {@link CURATED_SOURCES} order;
 * any uncurated provider follows, alphabetized, each with an honest fallback entry.
 * The ordering is caller-insertion-independent, so an identical contributing set
 * always renders identically.
 */
export function attributionsFor(sources: Iterable<string>): Attribution[] {
  const wanted = new Set(sources);
  const curated = CURATED_SOURCES.filter((s) => wanted.has(s)).map((s) => ATTRIBUTIONS[s]);
  const uncurated = [...wanted]
    .filter((s) => !CURATED_NAMES.has(s))
    .sort()
    .map(fallbackAttribution);
  return [...curated, ...uncurated];
}
