/**
 * @fileoverview Identifier shape detection for routing between the experimental
 * (PDB) and predicted (UniProt-keyed) halves of the federation. Pure, no I/O.
 * @module services/shared/identifiers
 */

/** UniProt accession pattern (6- or 10-character forms). */
const UNIPROT_RE = /^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})$/i;

/** PDB entry ID pattern: 4 alphanumerics, first character a digit (e.g. 4HHB, 1IEP). */
const PDB_RE = /^[0-9][A-Za-z0-9]{3}$/;

/** True when `value` is a syntactically valid UniProt accession. */
export function isUniProtAccession(value: string): boolean {
  return UNIPROT_RE.test(value.trim());
}

/** True when `value` is a syntactically valid PDB entry ID. */
export function isPdbId(value: string): boolean {
  return PDB_RE.test(value.trim());
}

/** Extract the PDB entry ID from a polymer-entity ID (`4HHB_1` → `4HHB`). */
export function entryIdOf(identifier: string): string {
  const base = identifier.split(/[_.]/)[0] ?? identifier;
  return base.toUpperCase();
}
