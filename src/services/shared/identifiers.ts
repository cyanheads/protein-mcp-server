/**
 * @fileoverview Identifier shape detection for routing between the experimental
 * (PDB) and predicted (UniProt-keyed) halves of the federation. Pure, no I/O.
 * @module services/shared/identifiers
 */

/** UniProt accession body (6- or 10-character forms), unanchored. */
const UNIPROT_BODY = '(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})';

/** UniProt accession pattern (6- or 10-character forms). */
const UNIPROT_RE = new RegExp(`^${UNIPROT_BODY}$`, 'i');

/** AlphaFold DB entry ID pattern: `AF-<accession>-F<fragment>` (e.g. AF-P69905-F1). */
const AF_ENTRY_RE = new RegExp(`^AF-${UNIPROT_BODY}-F\\d+$`, 'i');

/** PDB entry ID pattern: 4 alphanumerics, first character a digit (e.g. 4HHB, 1IEP). */
const PDB_RE = /^[0-9][A-Za-z0-9]{3}$/;

/** True when `value` is a syntactically valid UniProt accession. */
export function isUniProtAccession(value: string): boolean {
  return UNIPROT_RE.test(value.trim());
}

/**
 * True when `value` is an AlphaFold DB entry ID (`AF-P69905-F1`). Both AlphaFold's
 * prediction endpoint and 3D-Beacons accept this form alongside the bare accession,
 * and the `af://` resource emits it as `entryId`, so a caller can hand it straight
 * back to a predicted-source lookup.
 */
export function isAlphaFoldEntryId(value: string): boolean {
  return AF_ENTRY_RE.test(value.trim());
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
