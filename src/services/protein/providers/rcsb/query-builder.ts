/**
 * @fileoverview Query builder for RCSB search API.
 * @module src/services/protein/providers/rcsb/query-builder
 */

import type { SearchStructuresParams } from '../../types.js';
import { AnalysisType } from '../../types.js';
import type { RcsbSearchQuery } from './types.js';

/**
 * Build RCSB search query from search parameters
 */
export function buildSearchQuery(
  params: SearchStructuresParams,
): RcsbSearchQuery {
  const queries: RcsbSearchQuery[] = [];

  // Text search
  if (params.query) {
    queries.push({
      type: 'terminal',
      service: 'text',
      parameters: {
        attribute: 'struct.title',
        operator: 'contains_phrase',
        value: params.query,
      },
    });
  }

  // Organism filter
  if (params.organism) {
    queries.push({
      type: 'terminal',
      service: 'text',
      parameters: {
        attribute: 'rcsb_entity_source_organism.taxonomy_lineage.name',
        operator: 'exact_match',
        value: params.organism,
      },
    });
  }

  // Experimental method filter
  if (params.experimentalMethod) {
    queries.push({
      type: 'terminal',
      service: 'text',
      parameters: {
        attribute: 'exptl.method',
        operator: 'exact_match',
        value: params.experimentalMethod,
      },
    });
  }

  // Resolution filter
  if (params.maxResolution !== undefined) {
    queries.push({
      type: 'terminal',
      service: 'text',
      parameters: {
        attribute: 'rcsb_entry_info.resolution_combined',
        operator: 'less_or_equal',
        value: params.maxResolution,
      },
    });
  }

  // If no filters, search for all protein structures
  if (queries.length === 0) {
    queries.push({
      type: 'terminal',
      service: 'text',
      parameters: {
        attribute: 'rcsb_entry_info.polymer_entity_count_protein',
        operator: 'greater',
        value: 0,
      },
    });
  }

  return {
    type: 'group',
    logical_operator: 'and',
    nodes: queries,
  };
}

/**
 * Map analysis type to RCSB facet attribute
 */
export function getAnalysisFacet(analysisType: AnalysisType): string {
  switch (analysisType) {
    case AnalysisType.FOLD:
      return 'rcsb_struct_symmetry.kind';
    case AnalysisType.FUNCTION:
      return 'rcsb_polymer_entity_annotation.type';
    case AnalysisType.ORGANISM:
      return 'rcsb_entity_source_organism.taxonomy_lineage.name';
    case AnalysisType.METHOD:
      return 'exptl.method';
    default:
      return 'exptl.method';
  }
}
