/**
 * @fileoverview Identifier shape detection for routing between the experimental
 * (PDB) and predicted (UniProt-keyed) halves of the federation. Pure, no I/O.
 * @module services/shared/identifiers
 */

/** UniProt accession body (6- or 10-character forms), unanchored. */
const UNIPROT_BODY = '(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})';

/** UniProt isoform suffix: `-<n>`, a positive integer without leading zeros (`P04637-2`). */
const ISOFORM_SUFFIX = '-[1-9][0-9]*';

/** UniProt accession pattern (6- or 10-character forms). */
const UNIPROT_RE = new RegExp(`^${UNIPROT_BODY}$`, 'i');

/** UniProt isoform accession pattern: `<accession>-<n>` (e.g. P04637-2). */
const ISOFORM_RE = new RegExp(`^${UNIPROT_BODY}${ISOFORM_SUFFIX}$`, 'i');

/**
 * AlphaFold DB entry ID pattern: `AF-<accession>[-<isoform>]-F<fragment>`
 * (e.g. AF-P69905-F1, AF-P04637-2-F1). Capture group 1 is the accession,
 * isoform suffix included.
 */
const AF_ENTRY_RE = new RegExp(`^AF-(${UNIPROT_BODY}(?:${ISOFORM_SUFFIX})?)-F\\d+$`, 'i');

/**
 * UniProtKB entry name pattern: `<mnemonic or accession>_<species code>` (HBA_HUMAN,
 * A0A023GPI8_CANAL). Applied only after {@link isUniProtEntryName}'s length check.
 */
const ENTRY_NAME_RE = /^[A-Z0-9]{1,10}_[A-Z0-9]{1,5}$/i;

/** Longest UniProtKB entry name: a 10-character accession, `_`, a 5-character species code. */
const MAX_ENTRY_NAME_LENGTH = 16;

/** PDB entry ID pattern: 4 alphanumerics, first character a digit (e.g. 4HHB, 1IEP). */
const PDB_RE = /^[0-9][A-Za-z0-9]{3}$/;

/** True when `value` is a syntactically valid canonical UniProt accession (no isoform suffix). */
export function isUniProtAccession(value: string): boolean {
  return UNIPROT_RE.test(value.trim());
}

/**
 * True when `value` is a UniProt isoform accession (`P04637-2`). AlphaFold DB and
 * 3D-Beacons serve isoform models under this form; UniProt annotations and
 * InterPro do not.
 */
export function isUniProtIsoform(value: string): boolean {
  return ISOFORM_RE.test(value.trim());
}

/** True when `value` is a canonical or isoform UniProt accession — the keys a predicted-model lookup takes. */
export function isPredictionAccession(value: string): boolean {
  return isUniProtAccession(value) || isUniProtIsoform(value);
}

/**
 * True when `value` is shaped like a UniProtKB entry name (`HBA_HUMAN`), which
 * UniProt resolves to its entry's accession. Input longer than an entry name can
 * be is rejected before the pattern runs, so the pattern only sees short text.
 */
export function isUniProtEntryName(value: string): boolean {
  const name = value.trim();
  return name.length <= MAX_ENTRY_NAME_LENGTH && ENTRY_NAME_RE.test(name);
}

/**
 * True when `value` is an AlphaFold DB entry ID (`AF-P69905-F1`, or an isoform
 * model's `AF-P04637-2-F1`). AlphaFold's prediction endpoint accepts this form
 * alongside the bare accession, and the `af://` resource emits it as `entryId`,
 * so a caller can hand it straight back to a predicted-source lookup.
 */
export function isAlphaFoldEntryId(value: string): boolean {
  return AF_ENTRY_RE.test(value.trim());
}

/**
 * The accession an AlphaFold DB entry ID models, upper-cased with any isoform
 * suffix kept (`AF-P04637-2-F1` → `P04637-2`). Precondition: `isAlphaFoldEntryId(value)`.
 */
export function accessionOfAlphaFoldEntryId(value: string): string {
  const match = AF_ENTRY_RE.exec(value.trim());
  if (!match?.[1]) throw new Error(`Not an AlphaFold DB entry ID: ${value}`);
  return match[1].toUpperCase();
}

/** The canonical accession of a canonical or isoform accession, upper-cased (`P04637-2` → `P04637`). */
export function canonicalAccessionOf(value: string): string {
  return value
    .trim()
    .replace(/-[0-9]+$/, '')
    .toUpperCase();
}

/** True when `value` is a syntactically valid PDB entry ID. */
export function isPdbId(value: string): boolean {
  return PDB_RE.test(value.trim());
}

/** True when `value` is an RCSB computed-model ID (`AF_*` AlphaFold / `MA_*` ModelArchive). */
export function isComputedModelId(value: string): boolean {
  return /^(AF|MA)_/i.test(value);
}

/**
 * Extract the entry ID from a polymer-entity ID (`4HHB_1` → `4HHB`). A
 * computed-model ID carries its own underscore after the `AF_`/`MA_` prefix, so
 * only its trailing `_<entity number>` is stripped (`AF_AFP69905F1_1` →
 * `AF_AFP69905F1`); a bare computed-model entry ID passes through.
 */
export function entryIdOf(identifier: string): string {
  if (isComputedModelId(identifier)) return identifier.replace(/_\d+$/, '').toUpperCase();
  const base = identifier.split(/[_.]/)[0] ?? identifier;
  return base.toUpperCase();
}
