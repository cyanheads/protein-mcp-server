/**
 * @fileoverview Tests for identifier shape detection — the routing primitive that
 * decides whether an ID flows to the experimental (PDB) or predicted (UniProt)
 * half of the federation.
 * @module tests/services/shared/identifiers.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  accessionOfAlphaFoldEntryId,
  canonicalAccessionOf,
  entryIdOf,
  isAlphaFoldEntryId,
  isPdbId,
  isPredictionAccession,
  isUniProtAccession,
  isUniProtEntryName,
  isUniProtIsoform,
} from '@/services/shared/identifiers.js';

describe('isUniProtEntryName', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    'HBA_HUMAN',
    'hba_human',
    ' HBA_HUMAN ',
    'P53_HUMAN',
    '1433B_HUMAN',
    'A0A023GPI8_CANAL',
    'POLG_9HIV1',
  ])('accepts the entry name %j', (name) => {
    expect(isUniProtEntryName(name)).toBe(true);
  });

  it.each([
    'P69905',
    'P04637-2',
    'AF-P69905-F1',
    'AF_AFP69905F1',
    'HBA_HUMANX1',
    'A0A023GPI8X_CANAL',
    'HBA__HUMAN',
    '_HUMAN',
    'HBA_',
    'HBA HUMAN',
    'HBA_HU-AN',
    'HBA_HUMAN\n_X',
    '',
  ])('rejects %j', (value) => {
    expect(isUniProtEntryName(value)).toBe(false);
  });

  it('is disjoint from canonical and isoform accessions (no value reads as both)', () => {
    for (const id of ['HBA_HUMAN', 'P69905', 'P04637-2', 'A0A023GPI8_CANAL', 'A0A023GPI8']) {
      expect(isUniProtEntryName(id) && isPredictionAccession(id)).toBe(false);
    }
  });

  it('rejects input longer than 16 characters before the pattern sees it', () => {
    const seen: string[] = [];
    const record = (arg: unknown) => {
      if (typeof arg === 'string') seen.push(arg);
    };
    const test = RegExp.prototype.test;
    const exec = RegExp.prototype.exec;
    vi.spyOn(RegExp.prototype, 'test').mockImplementation(function (this: RegExp, arg: string) {
      record(arg);
      return test.call(this, arg);
    });
    vi.spyOn(RegExp.prototype, 'exec').mockImplementation(function (this: RegExp, arg: string) {
      record(arg);
      return exec.call(this, arg);
    });

    // Control: a name within the bound reaches the pattern, so the spies observe it.
    expect(isUniProtEntryName('HBA_HUMAN')).toBe(true);
    expect(seen).toContain('HBA_HUMAN');

    seen.length = 0;
    const overLong = [
      'A0A023GPI8X_CANAL',
      'A'.repeat(80_000),
      `${'A'.repeat(80_000)}\n_`,
      '  \r\n'.repeat(20_000),
      `${' '.repeat(40_000)}HBA_HUMAN_TOO_LONG${' '.repeat(40_000)}`,
    ];
    for (const value of overLong) expect(isUniProtEntryName(value)).toBe(false);
    expect(Math.max(0, ...seen.map((s) => s.length))).toBeLessThanOrEqual(16);
  });

  it('measures the bound after trimming, so a padded entry name still passes', () => {
    expect(isUniProtEntryName(`${' '.repeat(20)}A0A023GPI8_CANAL${' '.repeat(20)}`)).toBe(true);
  });
});

describe('isUniProtIsoform (#91)', () => {
  it.each(['P04637-2', 'P04637-9', 'P04637-12', 'p04637-2', 'A0A1K0GXZ1-3', ' Q8WZ42-2 '])(
    'accepts the isoform accession %s',
    (id) => {
      expect(isUniProtIsoform(id)).toBe(true);
    },
  );

  it.each([
    'P04637',
    'P04637-0',
    'P04637-02',
    'P04637-',
    'P04637-2-F1',
    'AF-P04637-2-F1',
    'NOTANACC-2',
    '4HHB-2',
  ])('rejects %s', (id) => {
    expect(isUniProtIsoform(id)).toBe(false);
  });

  it('leaves isUniProtAccession canonical-only', () => {
    expect(isUniProtAccession('P04637-2')).toBe(false);
  });
});

describe('isPredictionAccession (#91)', () => {
  it.each(['P04637', 'P04637-2', 'A0A1K0GXZ1', 'A0A1K0GXZ1-3'])('accepts %s', (id) => {
    expect(isPredictionAccession(id)).toBe(true);
  });

  it.each(['P04637-0', 'P04637-02', 'P04637-2-F1', 'AF-P04637-F1', '4HHB', 'NOTANACC'])(
    'rejects %s',
    (id) => {
      expect(isPredictionAccession(id)).toBe(false);
    },
  );
});

describe('isAlphaFoldEntryId with isoforms (#91)', () => {
  it.each(['AF-P04637-2-F1', 'af-p04637-2-f1', 'AF-A0A1K0GXZ1-3-F2'])('accepts %s', (id) => {
    expect(isAlphaFoldEntryId(id)).toBe(true);
  });

  it.each(['AF-P04637-0-F1', 'AF-P04637-02-F1', 'AF-P04637-2', 'P04637-2-F1'])(
    'rejects %s',
    (id) => {
      expect(isAlphaFoldEntryId(id)).toBe(false);
    },
  );
});

describe('accessionOfAlphaFoldEntryId (#91)', () => {
  it.each([
    ['AF-P69905-F1', 'P69905'],
    ['AF-P04637-2-F1', 'P04637-2'],
    ['af-p04637-2-f1', 'P04637-2'],
    [' AF-A0A1K0GXZ1-F12 ', 'A0A1K0GXZ1'],
  ])('reduces %s to %s', (id, accession) => {
    expect(accessionOfAlphaFoldEntryId(id)).toBe(accession);
  });
});

describe('canonicalAccessionOf (#91)', () => {
  it.each([
    ['P04637-2', 'P04637'],
    ['p04637-1', 'P04637'],
    ['P04637', 'P04637'],
    [' A0A1K0GXZ1-3 ', 'A0A1K0GXZ1'],
  ])('maps %s to %s', (id, canonical) => {
    expect(canonicalAccessionOf(id)).toBe(canonical);
  });
});

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

describe('isAlphaFoldEntryId', () => {
  it.each(['AF-P69905-F1', 'AF-A0A1K0GXZ1-F1', 'AF-P69905-F12', 'af-p69905-f1'])(
    'accepts the AlphaFold DB entry ID %s',
    (id) => {
      expect(isAlphaFoldEntryId(id)).toBe(true);
    },
  );

  it.each(['P69905', 'AF-P69905', 'AF-NOTANACC-F1', 'AF-P69905-F', '4HHB', 'P0DOESNOT'])(
    'rejects %s',
    (id) => {
      expect(isAlphaFoldEntryId(id)).toBe(false);
    },
  );

  it('is disjoint from bare accessions (no value reads as both)', () => {
    for (const id of ['AF-P69905-F1', 'P69905', 'A0A1K0GXZ1']) {
      expect(isAlphaFoldEntryId(id) && isUniProtAccession(id)).toBe(false);
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

  it('strips only the trailing entity suffix from a computed-model entity ID (#60)', () => {
    expect(entryIdOf('AF_AFP69905F1_1')).toBe('AF_AFP69905F1');
    expect(entryIdOf('MA_MAASFVASFVG001_1')).toBe('MA_MAASFVASFVG001');
    expect(entryIdOf('af_afp69905f1_12')).toBe('AF_AFP69905F1');
  });

  it('passes a bare computed-model entry ID through unchanged (#60)', () => {
    expect(entryIdOf('AF_AFP69905F1')).toBe('AF_AFP69905F1');
    expect(entryIdOf('MA_MAASFVASFVG001')).toBe('MA_MAASFVASFVG001');
  });
});
