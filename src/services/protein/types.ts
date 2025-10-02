/**
 * @fileoverview Type definitions for the protein service domain.
 * Defines all DTOs, enums, and interfaces used across protein data providers.
 * @module src/services/protein/types
 */

/**
 * 4-character PDB identifier (e.g., "1ABC")
 */
export type PdbId = string;

/**
 * Experimental methods used to determine protein structures
 */
export enum ExperimentalMethod {
  XRAY = 'X-RAY DIFFRACTION',
  NMR_SOLUTION = 'SOLUTION NMR',
  ELECTRON_MICROSCOPY = 'ELECTRON MICROSCOPY',
  NEUTRON = 'NEUTRON DIFFRACTION',
  FIBER = 'FIBER DIFFRACTION',
  NMR_SOLID = 'SOLID-STATE NMR',
  MODEL = 'THEORETICAL MODEL',
}

/**
 * Types of molecular chains in protein structures
 */
export enum ChainType {
  PROTEIN = 'protein',
  DNA = 'dna',
  RNA = 'rna',
  LIGAND = 'ligand',
  WATER = 'water',
}

/**
 * Supported structure file formats
 */
export enum StructureFormat {
  PDB = 'pdb',
  MMCIF = 'mmcif',
  PDBML = 'pdbml',
  JSON = 'json',
}

/**
 * Alignment methods for structural comparison
 */
export enum AlignmentMethod {
  CEALIGN = 'cealign',
  TMALIGN = 'tmalign',
  FATCAT = 'fatcat',
}

/**
 * Types of similarity searches
 */
export enum SimilarityType {
  SEQUENCE = 'sequence',
  STRUCTURE = 'structure',
}

/**
 * Analysis types for collection statistics
 */
export enum AnalysisType {
  FOLD = 'fold',
  FUNCTION = 'function',
  ORGANISM = 'organism',
  METHOD = 'method',
}

/**
 * Date range filter
 */
export interface DateRange {
  from?: string;
  to?: string;
}

/**
 * Resolution range filter (in Angstroms)
 */
export interface ResolutionRange {
  min?: number | undefined;
  max?: number | undefined;
}

/**
 * Parameters for searching protein structures
 */
export interface SearchStructuresParams {
  query: string;
  organism?: string | undefined;
  experimentalMethod?: ExperimentalMethod | undefined;
  maxResolution?: number | undefined;
  minResolution?: number | undefined;
  releaseDate?: DateRange | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/**
 * Individual search result entry
 */
export interface SearchResultEntry {
  pdbId: PdbId;
  title: string;
  organism: string[];
  experimentalMethod: string;
  resolution?: number | undefined;
  releaseDate: string;
  molecularWeight?: number | undefined;
}

/**
 * Complete search results with pagination
 */
export interface SearchStructuresResult {
  results: SearchResultEntry[];
  totalCount: number;
  hasMore: boolean;
}

/**
 * Molecular chain information
 */
export interface Chain {
  id: string;
  type: ChainType;
  sequence?: string;
  length: number;
  organism?: string;
}

/**
 * Structure coordinates and topology data
 */
export interface StructureData {
  format: StructureFormat;
  data: string | Record<string, unknown>;
  chains: Chain[];
}

/**
 * Experimental metadata
 */
export interface ExperimentalData {
  method: string;
  resolution?: number | undefined;
  rFactor?: number | undefined;
  rFree?: number | undefined;
  spaceGroup?: string | undefined;
  unitCell?:
    | {
        a: number;
        b: number;
        c: number;
        alpha: number;
        beta: number;
        gamma: number;
      }
    | undefined;
}

/**
 * Citation information
 */
export interface Citation {
  title: string;
  authors: string[];
  journal?: string | undefined;
  doi?: string | undefined;
  pubmedId?: string | undefined;
  year?: number | undefined;
}

/**
 * Functional annotations
 */
export interface Annotations {
  function?: string;
  keywords: string[];
  citations: Citation[];
}

/**
 * Options for retrieving structure data
 */
export interface GetStructureOptions {
  format?: StructureFormat;
  includeCoordinates?: boolean;
  includeExperimentalData?: boolean;
  includeAnnotations?: boolean;
}

/**
 * Complete protein structure information
 */
export interface ProteinStructure {
  pdbId: PdbId;
  title: string;
  structure: StructureData;
  experimental: ExperimentalData;
  annotations: Annotations;
}

/**
 * Chain selection for structural alignment
 */
export interface ChainSelection {
  pdbId: PdbId;
  chain: string;
}

/**
 * Structural alignment result
 */
export interface AlignmentResult {
  method: string;
  rmsd: number;
  alignedResidues: number;
  sequenceIdentity: number;
  tmscore?: number;
}

/**
 * Pairwise structure comparison
 */
export interface PairwiseComparison {
  pdbId1: PdbId;
  pdbId2: PdbId;
  rmsd: number;
  alignedLength: number;
}

/**
 * Flexible region in conformational analysis
 */
export interface FlexibleRegion {
  residueRange: [number, number];
  rmsd: number;
}

/**
 * Conformational analysis results
 */
export interface ConformationalAnalysis {
  flexibleRegions: FlexibleRegion[];
  rigidCore: {
    residueCount: number;
    rmsd: number;
  };
}

/**
 * Parameters for structure comparison
 */
export interface CompareStructuresParams {
  pdbIds: PdbId[];
  alignmentMethod?: AlignmentMethod | undefined;
  chainSelections?: ChainSelection[] | undefined;
  includeVisualization?: boolean | undefined;
}

/**
 * Complete structure comparison result
 */
export interface CompareStructuresResult {
  alignment: AlignmentResult;
  pairwiseComparisons: PairwiseComparison[];
  conformationalAnalysis?: ConformationalAnalysis | undefined;
  visualization?: string | undefined;
}

/**
 * Query types for similarity search
 */
export interface SimilarityQuery {
  type: 'pdbId' | 'sequence' | 'structure';
  value: string;
}

/**
 * Thresholds for similarity filtering
 */
export interface SimilarityThreshold {
  sequenceIdentity?: number | undefined;
  eValue?: number | undefined;
  tmscore?: number | undefined;
  rmsd?: number | undefined;
}

/**
 * Similarity metrics
 */
export interface SimilarityMetrics {
  sequenceIdentity?: number;
  eValue?: number;
  tmscore?: number;
  rmsd?: number;
}

/**
 * Individual similarity search result
 */
export interface SimilarityResultEntry {
  pdbId: PdbId;
  title: string;
  organism: string[];
  similarity: SimilarityMetrics;
  alignmentLength?: number;
  coverage?: number;
}

/**
 * Parameters for similarity search
 */
export interface FindSimilarParams {
  query: SimilarityQuery;
  similarityType: SimilarityType;
  threshold?: SimilarityThreshold | undefined;
  limit?: number | undefined;
}

/**
 * Complete similarity search results
 */
export interface FindSimilarResult {
  query: {
    type: string;
    identifier: string;
  };
  similarityType: string;
  results: SimilarityResultEntry[];
  totalCount: number;
}

/**
 * Ligand query types
 */
export interface LigandQuery {
  type: 'name' | 'chemicalId' | 'smiles';
  value: string;
}

/**
 * Filters for ligand search
 */
export interface LigandSearchFilters {
  proteinName?: string | undefined;
  organism?: string | undefined;
  experimentalMethod?: string | undefined;
  maxResolution?: number | undefined;
}

/**
 * Amino acid residue information
 */
export interface Residue {
  name: string;
  number: number;
  interactions: string[];
}

/**
 * Binding site information
 */
export interface BindingSite {
  chain: string;
  residues: Residue[];
}

/**
 * Ligand molecule information
 */
export interface Ligand {
  name: string;
  chemicalId: string;
  formula?: string;
  molecularWeight?: number;
}

/**
 * Structure containing ligand
 */
export interface LigandStructureEntry {
  pdbId: PdbId;
  title: string;
  organism: string[];
  resolution?: number | undefined;
  ligandCount: number;
  bindingSites?: BindingSite[] | undefined;
}

/**
 * Parameters for ligand tracking
 */
export interface TrackLigandsParams {
  ligandQuery: LigandQuery;
  filters?: LigandSearchFilters | undefined;
  includeBindingSite?: boolean | undefined;
  limit?: number | undefined;
}

/**
 * Complete ligand tracking results
 */
export interface TrackLigandsResult {
  ligand: Ligand;
  structures: LigandStructureEntry[];
  totalCount: number;
}

/**
 * Filters for collection analysis
 */
export interface AnalysisFilters {
  organism?: string | undefined;
  experimentalMethod?: string | undefined;
  resolutionRange?: ResolutionRange | undefined;
  releaseYearRange?: [number, number] | undefined;
}

/**
 * Example structure in analysis category
 */
export interface AnalysisExample {
  pdbId: PdbId;
  title: string;
}

/**
 * Statistical category in analysis
 */
export interface AnalysisCategory {
  category: string;
  count: number;
  percentage: number;
  examples: AnalysisExample[];
}

/**
 * Trend data point
 */
export interface TrendDataPoint {
  year: number;
  count: number;
}

/**
 * Parameters for collection analysis
 */
export interface AnalyzeCollectionParams {
  analysisType: AnalysisType;
  filters?: AnalysisFilters | undefined;
  groupBy?: string | undefined;
  limit?: number | undefined;
}

/**
 * Complete collection analysis results
 */
export interface AnalyzeCollectionResult {
  analysisType: string;
  totalStructures: number;
  statistics: AnalysisCategory[];
  trends?: TrendDataPoint[];
}
