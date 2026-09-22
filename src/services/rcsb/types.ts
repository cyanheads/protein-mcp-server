/**
 * @fileoverview Domain types for the RCSB service — normalized shapes the tools
 * consume, decoupled from the raw Search/GraphQL payloads. Optional fields mirror
 * real upstream sparsity (missing = unknown, never fabricated).
 * @module services/rcsb/types
 */

/** A single search hit before metadata enrichment. */
export interface SearchHit {
  /** Identifier (PDB entry ID, polymer-entity ID, or chem-comp ID per return type). */
  id: string;
  /** RCSB relevance score. */
  score: number;
}

/** One facet bucket; `child` present only for multidimensional (nested) facets. */
export interface FacetBucket {
  /**
   * The single nested sub-facet for a multidimensional cross-tab. A facet spec
   * carries at most one child and the request builder sends exactly one nested
   * facet, so a bucket is never cross-tabbed by more than one dimension. Present
   * whenever a child dimension was requested — with an empty bucket list when the
   * scope carries no value for it (computed models have no experimental method),
   * so the shape reflects what was asked for rather than dropping the dimension.
   */
  child?: FacetDimension;
  /** Count of entries in the bucket. */
  count: number;
  /** Bucket label (category value, numeric bin start, or period). */
  label: string;
  /**
   * Inclusive lower bound of a numeric histogram bin (= `Number(label)`). Present
   * only for numeric histogram facets (resolution, molecular_weight); absent for
   * term and date-period facets.
   */
  rangeFrom?: number;
  /**
   * Exclusive upper bound of a numeric histogram bin (`rangeFrom + bin interval`).
   * Uses the facet's fixed bin width, not the next bucket's label — the histogram
   * omits empty bins, so consecutive labels are not necessarily one interval apart.
   */
  rangeTo?: number;
}

/** A facet dimension and its buckets. */
export interface FacetDimension {
  /** RCSB attribute path the dimension aggregates on. */
  attribute: string;
  /** Aggregation buckets, count-descending for terms / order-preserving for histograms. */
  buckets: FacetBucket[];
  /** Friendly dimension name (e.g. `method`, `organism`, `release_year`). */
  dimension: string;
  /** True when buckets were capped by the per-dimension limit. */
  truncated?: boolean;
}

/** Result of a structure search. */
export interface SearchResult {
  /** Optional facet breakdown when requested. */
  facets?: FacetDimension[];
  /** The current page of hits. */
  hits: SearchHit[];
  /** Total matches upstream (before pagination). */
  total: number;
}

/** A modeled polymer (protein/nucleic) entity within an entry. */
export interface PolymerEntityMeta {
  /**
   * Author-assigned chain IDs (`auth_asym_id`) for this entity — the namespace
   * `protein_get_annotations.chain` consumes. Absent when upstream omits it.
   */
  authAsymIds?: string[];
  /** Free-text description (e.g. "Hemoglobin subunit alpha"). */
  description?: string;
  /** Entity identifier (e.g. `4HHB_1`). */
  entityId: string;
  /**
   * mmCIF `label_asym_id` chain IDs for this entity — the namespace
   * `protein_compare_structures.chain` consumes. Unrelated to `authAsymIds` by any
   * transformation, though the two coincide for many entries.
   */
  labelAsymIds?: string[];
  /** Source organism scientific name. */
  organism?: string;
  /** One-letter canonical sequence (present only when explicitly requested). */
  sequence?: string;
  /** Residue count of the sample sequence. */
  sequenceLength?: number;
}

/** One polymer entity's UniProt cross-reference: the chains it covers and the mapped accession. */
export interface UniProtXref {
  /** UniProt accession this entity maps to. */
  accession: string;
  /** Author chain IDs (auth_asym_id) this entity covers (e.g. ["A", "C"]). */
  chains: string[];
  /** Polymer entity description (e.g. "Hemoglobin subunit alpha"). */
  proteinName?: string;
}

/** A bound non-polymer (ligand) component within an entry. */
export interface LigandMeta {
  /** Chemical component ID (e.g. `HEM`, `STI`). */
  compId: string;
  /** Molecular formula when available. */
  formula?: string;
  /** Chemical name when available. */
  name?: string;
}

/** Normalized entry-level metadata from the GraphQL batch. */
export interface EntryMeta {
  /**
   * The modelling provider's own ID for a computed model (e.g. `AF-P69905-F1`,
   * `ma-asfv-asfvg-001`) — the key its coordinate files are published under.
   * Absent for experimental entries.
   */
  computedModelEntryId?: string;
  /**
   * Modelling provider display name when this ID is a computed structure model
   * (`AF_*` / `MA_*`) rather than an experimental entry — e.g. "AlphaFold DB",
   * "ModelArchive". Absent for experimental entries. RCSB serves both universes
   * through the same entry endpoint, so this is what separates them.
   */
  computedModelProvider?: string;
  /** PDB entry ID. */
  id: string;
  /** Bound ligands (non-polymer entities). */
  ligands: LigandMeta[];
  /** Experimental method(s) (e.g. ["X-RAY DIFFRACTION"]). */
  methods?: string[];
  /** Deposited structure molecular weight (kDa). */
  molecularWeight?: number;
  /** Distinct source organisms across polymer entities. */
  organisms: string[];
  /**
   * Whether the archive publishes a legacy PDB-format file for this entry —
   * `false` for large entries archived as mmCIF only. Absent when the record
   * reports no value (computed models).
   */
  pdbFormatCompatible?: boolean;
  /** Modeled polymer entities. */
  polymerEntities: PolymerEntityMeta[];
  /** Initial release date (ISO 8601). */
  releaseDate?: string;
  /** Best resolution in Å when applicable. */
  resolution?: number;
  /** Structure title. */
  title?: string;
}

/** Coordinate-file download URLs by format; a format with no working file is absent. */
export interface CoordinateUrls {
  /** Binary CIF. */
  bcif?: string;
  /** mmCIF. */
  cif?: string;
  /** Legacy PDB format. */
  pdb?: string;
}

/**
 * One protein residue lining a ligand's binding pocket, in both numbering
 * namespaces. `asymId`/`seqId` are mmCIF label identifiers; `authAsymId`/
 * `authSeqId` are the depositor's (author) identifiers. The two are related by
 * no fixed offset — 1IEP label THR93 is author THR315.
 */
export interface BindingResidue {
  /** mmCIF `label_asym_id` of the residue's chain. */
  asymId: string;
  /** Author chain ID (`auth_asym_id`), from the entry's per-instance chain pairs. */
  authAsymId?: string;
  /** Author residue number (`auth_seq_id`). */
  authSeqId?: number;
  /** Contact distance to the ligand in Å. */
  distance?: number;
  /** Residue chemical component ID (e.g. `ASP`). */
  residueCompId: string;
  /** mmCIF `label_seq_id` — position in the entity sequence. */
  seqId?: number;
}

/** A ligand instance and the residues lining its pocket. */
export interface BindingSite {
  /** Ligand instance author chain ID (`auth_asym_id`). */
  ligandAsymId?: string;
  /** Ligand instance author residue number (`auth_seq_id`). */
  ligandAuthSeqId?: number;
  /** Ligand chemical component ID. */
  ligandCompId: string;
  /** Interacting protein residues, nearest first. */
  residues: BindingResidue[];
}

/** Candidate chemical components for a name or formula search. */
export interface ChemCompMatches {
  /** Candidate component IDs pulled from the search, in upstream order. */
  ids: string[];
  /** Total components upstream matched, which can exceed `ids.length`. */
  total: number;
}

/** Chemical-component metadata for a ligand. */
export interface ChemComp {
  /** Component ID (e.g. `STI`). */
  compId: string;
  /** Molecular formula. */
  formula?: string;
  /** Formula weight (Da). */
  formulaWeight?: number;
  /** InChIKey when available. */
  inchikey?: string;
  /** Chemical name. */
  name?: string;
  /** Isomeric SMILES when available. */
  smiles?: string;
  /** Component type (e.g. "non-polymer"). */
  type?: string;
}

/** One structure universe RCSB can scope results to. */
export type ContentType = 'experimental' | 'computational';

/** Inputs to a structure search (shared by search + analyze tools). */
export interface StructureSearchParams {
  /**
   * Result content universes, sent as `results_content_type`. Pass both members
   * for a union — omitting the field is NOT a union upstream, it is RCSB's
   * experimental-only default, which drops every computed model.
   */
  contentType?: ContentType[];
  /** Page size. */
  limit?: number;
  /** Max E-value for a sequence query. */
  maxEvalue?: number;
  /** Maximum resolution in Å. */
  maxResolution?: number;
  /** Experimental method filter (e.g. "X-RAY DIFFRACTION"). */
  method?: string;
  /** Minimum sequence identity (0–1) for a sequence query. */
  minIdentity?: number;
  /** Source organism filter (scientific name). */
  organism?: string;
  /** Protein sequence (one-letter) for an mmseqs2 search. */
  sequence?: string;
  /** Page offset. */
  start?: number;
  /** Free-text query. */
  text?: string;
}
