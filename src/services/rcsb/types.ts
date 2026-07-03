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

/** One facet bucket; `children` present only for multidimensional (nested) facets. */
export interface FacetBucket {
  /** Nested sub-facets for multidimensional cross-tabs. */
  children?: FacetDimension[];
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
  /** Author-assigned chain IDs for this entity. */
  chains?: string[];
  /** Free-text description (e.g. "Hemoglobin subunit alpha"). */
  description?: string;
  /** Entity identifier (e.g. `4HHB_1`). */
  entityId: string;
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
  /** Modeled polymer entities. */
  polymerEntities: PolymerEntityMeta[];
  /** Initial release date (ISO 8601). */
  releaseDate?: string;
  /** Best resolution in Å when applicable. */
  resolution?: number;
  /** Structure title. */
  title?: string;
}

/** One protein residue lining a ligand's binding pocket. */
export interface BindingResidue {
  /** Author/asym chain ID the residue belongs to. */
  asymId: string;
  /** Contact distance to the ligand in Å. */
  distance?: number;
  /** Residue chemical component ID (e.g. `ASP`). */
  residueCompId: string;
  /** Sequence position of the residue. */
  seqId?: number;
}

/** A ligand instance and the residues lining its pocket. */
export interface BindingSite {
  /** Ligand instance chain (asym) ID. */
  ligandAsymId?: string;
  /** Ligand chemical component ID. */
  ligandCompId: string;
  /** Interacting protein residues, nearest first. */
  residues: BindingResidue[];
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

/** Content-type scope for a search. */
export type ContentType = 'experimental' | 'computational';

/** Inputs to a structure search (shared by search + analyze tools). */
export interface StructureSearchParams {
  /** Result content scope. */
  contentType?: ContentType;
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
