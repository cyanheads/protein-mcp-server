/**
 * @fileoverview Tests for identifier shape detection — the routing primitive that
 * decides whether an ID flows to the experimental (PDB) or predicted (UniProt)
 * half of the federation.
 * @module tests/services/shared/identifiers.test
 */

import { describe, expect, it } from 'vitest';
import { entryIdOf, isPdbId, isUniProtAccession } from '@/services/shared/identifiers.js';

describe('isPdbId', () => {
  it.each(['4HHB', '1IEP', '2W72', '4hhb'])('accepts the PDB ID %s', (id) => {
    expect(isPdbId(id)).toBe(true);
  });

  it.each(['P69905', 'HHHH', '4HH', '4HHBB', 'AF_AFP69905F1'])('rejects %s', (id) => {
    expect(isPdbId(id)).toBe(false);
  });

  it('trims surrounding whitespace', () => {
    expect(isPdbId(' 4HHB ')).toBe(true);
  });
});

describe('isUniProtAccession', () => {
  it.each(['P69905', 'Q9Y6K9', 'O95786', 'A0A1K0GXZ1'])('accepts the accession %s', (acc) => {
    expect(isUniProtAccession(acc)).toBe(true);
  });

  it.each(['4HHB', '1IEP', 'XYZ', 'P6990'])('rejects %s', (acc) => {
    expect(isUniProtAccession(acc)).toBe(false);
  });

  it('is disjoint from PDB IDs (no value reads as both)', () => {
    for (const id of ['4HHB', 'P69905', '2W72', 'A0A1K0GXZ1']) {
      expect(isPdbId(id) && isUniProtAccession(id)).toBe(false);
    }
  });
});

describe('entryIdOf', () => {
  it('strips a polymer-entity suffix', () => {
    expect(entryIdOf('4HHB_1')).toBe('4HHB');
  });

  it('strips a chain suffix and upper-cases', () => {
    expect(entryIdOf('4hhb.A')).toBe('4HHB');
  });

  it('passes a bare entry ID through, upper-cased', () => {
    expect(entryIdOf('1iep')).toBe('1IEP');
  });
});
