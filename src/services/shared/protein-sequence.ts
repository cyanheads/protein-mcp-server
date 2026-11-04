/**
 * @fileoverview RCSB protein sequence normalization and validation for both search paths.
 * @module services/shared/protein-sequence
 */
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';

/** Shortest protein sequence RCSB's mmseqs2 sequence search accepts. */
export const MIN_SEQUENCE_RESIDUES = 10;

/** Normalize whitespace and ASCII case, retaining RCSB's ambiguous and rare residues. */
export function normalizeProteinSequence(value: string): string {
  const sequence = value.replace(/\s/g, '').replace(/[a-z]/g, (letter) => letter.toUpperCase());
  const invalid = [...new Set(sequence.replace(/[A-IK-Z]/g, ''))];
  if (invalid.length > 0 || sequence.length < MIN_SEQUENCE_RESIDUES) {
    throw new McpError(
      JsonRpcErrorCode.InvalidParams,
      invalid.length > 0
        ? `Invalid protein sequence characters: ${invalid.map((c) => JSON.stringify(c)).join(', ')}. Normalized length: ${sequence.length}.`
        : `Protein sequence has normalized length ${sequence.length}; RCSB requires at least ${MIN_SEQUENCE_RESIDUES} residues.`,
      { reason: 'invalid_sequence' },
    );
  }
  return sequence;
}
