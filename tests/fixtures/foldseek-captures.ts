/**
 * @fileoverview Hand-trimmed Foldseek result payloads captured from the live
 * `search.foldseek.com` API (mode 3diaa). Each keeps the real response shape —
 * per-database blocks, each one sorted descending by `score` upstream, in the
 * order Foldseek returns them — with only selected hits of each block and the
 * bulky per-hit fields (`qAln`, `dbAln`, `tCa`, `tSeq`) dropped. Every other
 * per-alignment key is kept as captured (taxonomy, aligned positions, lengths),
 * except in `RESULT_4HHB_Q1`, whose rows carry the scoring keys only — the
 * sparse case. Query headers and sequences are truncated.
 * @module tests/fixtures/foldseek-captures
 */

/**
 * `/api/result/queries/{ticket}/{limit}/{offset}` for a 4HHB submission: one
 * query per chain of the α2β2 tetramer, labelled by Foldseek in file order.
 */
export const QUERIES_4HHB = {
  lookup: [
    { id: 0, name: 'job_A', set: 0 },
    { id: 1, name: 'job_B', set: 0 },
    { id: 2, name: 'job_C', set: 0 },
    { id: 3, name: 'job_D', set: 0 },
  ],
  hasNext: false,
  groupBySet: false,
};

/** `/api/result/queries/…` for a single-chain submission (1CRN). */
export const QUERIES_1CRN = {
  lookup: [{ id: 0, name: 'job_A', set: 0 }],
  hasNext: false,
  groupBySet: false,
};

/** `/api/result/{ticket}/0` for 4HHB — query 0, an alpha chain. */
export const RESULT_4HHB_Q0 = {
  mode: '3diaa',
  type: 'structuresearch',
  queries: [
    { header: 'job_A THE CRYSTAL STRUCTURE OF HUMAN DEO', sequence: 'VLSPADKTNVKAAWGKVGAH' },
  ],
  results: [
    {
      db: 'afdb50',
      alignments: [
        [
          {
            query: 'job_A',
            target: 'AF-A0A1K0GXZ1-F1-model_v6 Globin C1',
            seqId: 100,
            alnLength: 141,
            missmatches: 0,
            gapsopened: 0,
            qStartPos: 1,
            qEndPos: 141,
            dbStartPos: 37,
            dbEndPos: 177,
            prob: 1,
            eval: 2.269e-16,
            score: 876,
            qLen: 141,
            dbLen: 177,
            taxId: 9606,
            taxName: 'Homo sapiens',
          },
          {
            query: 'job_A',
            target: 'AF-A0A0K2BMD8-F1-model_v6 Mutant hemoglobin alpha 2 globin chain',
            seqId: 99.2,
            alnLength: 141,
            missmatches: 1,
            gapsopened: 0,
            qStartPos: 1,
            qEndPos: 141,
            dbStartPos: 2,
            dbEndPos: 142,
            prob: 1,
            eval: 2.904e-16,
            score: 872,
            qLen: 141,
            dbLen: 142,
            taxId: 9606,
            taxName: 'Homo sapiens',
          },
        ],
      ],
    },
    {
      db: 'pdb100',
      alignments: [
        [
          {
            query: 'job_A',
            target:
              '1y45-assembly1.cif.gz_C T-To-T(high) quaternary transitions in human hemoglobin: betaP36A deoxy low-salt (10 test sets)',
            seqId: 100,
            alnLength: 141,
            missmatches: 0,
            gapsopened: 0,
            qStartPos: 1,
            qEndPos: 141,
            dbStartPos: 1,
            dbEndPos: 141,
            prob: 1,
            eval: 4.985e-18,
            score: 920,
            qLen: 141,
            dbLen: 141,
            taxId: 9606,
            taxName: 'Homo sapiens',
          },
          {
            query: 'job_A',
            target:
              '1bab-assembly1.cif.gz_A HEMOGLOBIN THIONVILLE: AN ALPHA-CHAIN VARIANT WITH A SUBSTITUTION OF A GLUTAMATE FOR VALINE AT NA-1 AND HAVING AN ACETYLATED METHIONINE NH2 TERMINUS',
            seqId: 100,
            alnLength: 140,
            missmatches: 0,
            gapsopened: 0,
            qStartPos: 2,
            qEndPos: 141,
            dbStartPos: 3,
            dbEndPos: 142,
            prob: 1,
            eval: 7.399e-18,
            score: 913,
            qLen: 141,
            dbLen: 142,
            taxId: 9606,
            taxName: 'Homo sapiens',
          },
        ],
      ],
    },
  ],
};

/**
 * Selected pdb100 rows from the same 4HHB query-0 result: 6KAI's three chains
 * (one entry on three rows), a symmetry copy (`1ibe…_A-2`), 7VLF's two copies
 * of chain G (`G-2`, `G-3`), and a two-character author chain (`7vea…_dM`).
 * Upstream order kept.
 */
export const RESULT_4HHB_Q0_CHAINS = {
  results: [
    {
      db: 'pdb100',
      alignments: [
        [
          {
            query: 'job_A',
            target:
              '6kai-assembly2.cif.gz_E Crosslinked alpha(Ni)-beta(Fe) human hemoglobin A in the T quaternary structure at 95 K: Light',
            seqId: 100,
            alnLength: 141,
            missmatches: 0,
            gapsopened: 0,
            qStartPos: 1,
            qEndPos: 141,
            dbStartPos: 1,
            dbEndPos: 141,
            prob: 1,
            eval: 8.167e-18,
            score: 906,
            qLen: 141,
            dbLen: 141,
            taxId: 9606,
            taxName: 'Homo sapiens',
          },
          {
            query: 'job_A',
            target:
              '6kai-assembly1.cif.gz_A Crosslinked alpha(Ni)-beta(Fe) human hemoglobin A in the T quaternary structure at 95 K: Light',
            seqId: 100,
            alnLength: 141,
            missmatches: 0,
            gapsopened: 0,
            qStartPos: 1,
            qEndPos: 141,
            dbStartPos: 1,
            dbEndPos: 141,
            prob: 1,
            eval: 1.799e-17,
            score: 887,
            qLen: 141,
            dbLen: 141,
            taxId: 9606,
            taxName: 'Homo sapiens',
          },
          {
            query: 'job_A',
            target:
              '6kai-assembly2.cif.gz_G Crosslinked alpha(Ni)-beta(Fe) human hemoglobin A in the T quaternary structure at 95 K: Light',
            seqId: 100,
            alnLength: 141,
            missmatches: 0,
            gapsopened: 0,
            qStartPos: 1,
            qEndPos: 141,
            dbStartPos: 1,
            dbEndPos: 141,
            prob: 1,
            eval: 2.303e-17,
            score: 887,
            qLen: 141,
            dbLen: 141,
            taxId: 9606,
            taxName: 'Homo sapiens',
          },
          {
            query: 'job_A',
            target:
              '1ibe-assembly1.cif.gz_A-2 DEOXY-HAEMOGLOBIN TRAPPED IN THE HIGH-AFFINITY (R) STATE',
            seqId: 86.5,
            alnLength: 141,
            missmatches: 19,
            gapsopened: 0,
            qStartPos: 1,
            qEndPos: 141,
            dbStartPos: 1,
            dbEndPos: 141,
            prob: 1,
            eval: 1.386e-15,
            score: 786,
            qLen: 141,
            dbLen: 141,
            taxId: 9796,
            taxName: 'Equus caballus',
          },
          {
            query: 'job_A',
            target:
              '7vlf-assembly1.cif.gz_G-2 Oxy-deoxy intermediate of V2 hemoglobin at 26% oxygen saturation',
            seqId: 16,
            alnLength: 143,
            missmatches: 110,
            gapsopened: 4,
            qStartPos: 1,
            qEndPos: 134,
            dbStartPos: 4,
            dbEndPos: 145,
            prob: 1,
            eval: 0.006823,
            score: 156,
            qLen: 141,
            dbLen: 150,
            taxId: 104711,
            taxName: 'Lamellibrachia satsuma',
          },
          {
            query: 'job_A',
            target:
              '7vlf-assembly1.cif.gz_G-3 Oxy-deoxy intermediate of V2 hemoglobin at 26% oxygen saturation',
            seqId: 16,
            alnLength: 143,
            missmatches: 110,
            gapsopened: 4,
            qStartPos: 1,
            qEndPos: 134,
            dbStartPos: 4,
            dbEndPos: 145,
            prob: 1,
            eval: 0.006823,
            score: 156,
            qLen: 141,
            dbLen: 150,
            taxId: 104711,
            taxName: 'Lamellibrachia satsuma',
          },
          {
            query: 'job_A',
            target:
              '7vea-assembly1.cif.gz_dM Pentacylindrical allophycocyanin core from Thermosynechococcus vulcanus',
            seqId: 9.5,
            alnLength: 146,
            missmatches: 102,
            gapsopened: 7,
            qStartPos: 3,
            qEndPos: 141,
            dbStartPos: 48,
            dbEndPos: 170,
            prob: 0.569,
            eval: 1.897,
            score: 53,
            qLen: 141,
            dbLen: 1020,
            taxId: 197221,
            taxName: 'Thermosynechococcus vestitus BP-1',
          },
        ],
      ],
    },
  ],
};

/** `/api/result/{ticket}/1` for 4HHB — query 1, a beta chain with its own hit set. */
export const RESULT_4HHB_Q1 = {
  mode: '3diaa',
  type: 'structuresearch',
  queries: [
    { header: 'job_B THE CRYSTAL STRUCTURE OF HUMAN DEO', sequence: 'VHLTPEEKSAVTALWGKVNV' },
  ],
  results: [
    {
      db: 'afdb50',
      alignments: [
        [
          {
            query: 'job_B',
            target: 'AF-A0A8D8CFN8-F1-model_v6 Hemoglobin subunit beta (Fragment)',
            seqId: 97.2,
            alnLength: 144,
            prob: 1,
            eval: 3.218e-16,
            score: 849,
          },
          {
            query: 'job_B',
            target: 'AF-A0A1K0GGI2-F1-model_v6 Globin A2',
            seqId: 88.2,
            alnLength: 145,
            prob: 1,
            eval: 7.747e-15,
            score: 781,
          },
        ],
      ],
    },
    {
      db: 'pdb100',
      alignments: [
        [
          {
            query: 'job_B',
            target: '1o1k-assembly1.cif.gz_D Deoxy hemoglobin (A,C:V1M; B,D:V1M,V67W)',
            seqId: 98.6,
            alnLength: 146,
            prob: 1,
            eval: 1.734e-18,
            score: 931,
          },
          {
            query: 'job_B',
            target:
              '2dn2-assembly1.cif.gz_B 1.25A resolution crystal structure of human hemoglobin',
            seqId: 100,
            alnLength: 146,
            prob: 1,
            eval: 2.851e-18,
            score: 926,
          },
        ],
      ],
    },
  ],
};

/**
 * `/api/result/{ticket}/4` for 4HHB — one past the last query. Foldseek answers
 * an out-of-range query index with HTTP 200 and empty blocks, not an error.
 */
export const RESULT_EMPTY_QUERY = {
  queries: [{ header: '', sequence: '' }],
  results: [
    { db: 'afdb50', alignments: [] },
    { db: 'pdb100', alignments: [] },
  ],
};

/**
 * `/api/result/{ticket}/0` for 1CRN. The afdb50 block arrives first, but its
 * best hit (score 250) is weaker than every pdb100 hit shown — including the
 * exact self-match 1CRN (score 357).
 */
export const RESULT_1CRN_Q0 = {
  mode: '3diaa',
  type: 'structuresearch',
  queries: [
    { header: 'job_A WATER STRUCTURE OF A HYDROPHOBIC P', sequence: 'TTCCPSIVARSNFNVCRLPG' },
  ],
  results: [
    {
      db: 'afdb50',
      alignments: [
        [
          {
            query: 'job_A',
            target: 'AF-P01541-F1-model_v6 Denclatoxin-B',
            seqId: 50,
            alnLength: 46,
            missmatches: 23,
            gapsopened: 0,
            qStartPos: 1,
            qEndPos: 46,
            dbStartPos: 1,
            dbEndPos: 46,
            prob: 1,
            eval: 2.168e-5,
            score: 250,
            qLen: 46,
            dbLen: 46,
            taxId: 3965,
            taxName: 'Dendrophthora clavata',
          },
          {
            query: 'job_A',
            target: 'AF-A0A1J3H3C1-F1-model_v6 Thionin (Fragment)',
            seqId: 55.5,
            alnLength: 45,
            missmatches: 20,
            gapsopened: 0,
            qStartPos: 2,
            qEndPos: 46,
            dbStartPos: 43,
            dbEndPos: 87,
            prob: 1,
            eval: 1.471e-4,
            score: 222,
            qLen: 46,
            dbLen: 150,
            taxId: 107243,
            taxName: 'Noccaea caerulescens',
          },
          {
            query: 'job_A',
            target: 'AF-A0A7J6GU35-F1-model_v6 Uncharacterized protein',
            seqId: 43.1,
            alnLength: 44,
            missmatches: 25,
            gapsopened: 0,
            qStartPos: 1,
            qEndPos: 44,
            dbStartPos: 51,
            dbEndPos: 94,
            prob: 1,
            eval: 9.981e-4,
            score: 188,
            qLen: 46,
            dbLen: 104,
            taxId: 3483,
            taxName: 'Cannabis sativa',
          },
        ],
      ],
    },
    {
      db: 'pdb100',
      alignments: [
        [
          {
            query: 'job_A',
            target:
              '1crn-assembly1.cif.gz_A WATER STRUCTURE OF A HYDROPHOBIC PROTEIN AT ATOMIC RESOLUTION. PENTAGON RINGS OF WATER MOLECULES IN CRYSTALS OF CRAMBIN',
            seqId: 100,
            alnLength: 46,
            missmatches: 0,
            gapsopened: 0,
            qStartPos: 1,
            qEndPos: 46,
            dbStartPos: 1,
            dbEndPos: 46,
            prob: 1,
            eval: 3.458e-9,
            score: 357,
            qLen: 46,
            dbLen: 46,
            taxId: 3721,
            taxName: 'Crambe hispanica subsp. abyssinica',
          },
          {
            query: 'job_A',
            target:
              '1ejg-assembly1.cif.gz_A CRAMBIN AT ULTRA-HIGH RESOLUTION: VALENCE ELECTRON DENSITY.',
            seqId: 97.8,
            alnLength: 46,
            missmatches: 1,
            gapsopened: 0,
            qStartPos: 1,
            qEndPos: 46,
            dbStartPos: 1,
            dbEndPos: 46,
            prob: 1,
            eval: 4.93e-9,
            score: 352,
            qLen: 46,
            dbLen: 46,
            taxId: 3721,
            taxName: 'Crambe hispanica subsp. abyssinica',
          },
          {
            query: 'job_A',
            target:
              '3nir-assembly1.cif.gz_A Crystal structure of small protein crambin at 0.48 A resolution',
            seqId: 97.8,
            alnLength: 46,
            missmatches: 1,
            gapsopened: 0,
            qStartPos: 1,
            qEndPos: 46,
            dbStartPos: 1,
            dbEndPos: 46,
            prob: 1,
            eval: 5.292e-9,
            score: 351,
            qLen: 46,
            dbLen: 46,
            taxId: 3721,
            taxName: 'Crambe hispanica subsp. abyssinica',
          },
        ],
      ],
    },
  ],
};

/**
 * `/api/result/{ticket}/0` for 1CRN against the nine monomer databases
 * `protein_find_similar` accepts: one alignment per database, both cath50 target
 * forms (a PDB chain domain and an AlphaFold model domain), and pdb100's
 * `taxId: 0` / `unclassified` row (2FD7, chemically synthesized crambin).
 * mgnify_esm30 and gmgcl_id rows carry no taxonomy keys, as upstream sends them.
 * Upstream block order kept.
 */
export const RESULT_1CRN_PER_DB = {
  results: [
    {
      db: 'afdb-proteome',
      alignments: [
        [
          {
            query: 'job_A',
            target: 'AF-Q9C8D6-F1-model_v6 Probable thionin-2.4',
            seqId: 37.7,
            alnLength: 45,
            missmatches: 28,
            gapsopened: 0,
            qStartPos: 2,
            qEndPos: 46,
            dbStartPos: 26,
            dbEndPos: 70,
            prob: 1,
            eval: 0.002154,
            score: 153,
            qLen: 46,
            dbLen: 134,
            taxId: 3702,
            taxName: 'Arabidopsis thaliana',
          },
        ],
      ],
    },
    {
      db: 'afdb-swissprot',
      alignments: [
        [
          {
            query: 'job_A',
            target: 'AF-P01542-F1-model_v6 Crambin',
            seqId: 97.8,
            alnLength: 46,
            missmatches: 1,
            gapsopened: 0,
            qStartPos: 1,
            qEndPos: 46,
            dbStartPos: 1,
            dbEndPos: 46,
            prob: 1,
            eval: 8.928e-9,
            score: 341,
            qLen: 46,
            dbLen: 46,
            taxId: 3721,
            taxName: 'Crambe hispanica subsp. abyssinica',
          },
        ],
      ],
    },
    {
      db: 'afdb50',
      alignments: [
        [
          {
            query: 'job_A',
            target: 'AF-P01541-F1-model_v6 Denclatoxin-B',
            seqId: 50,
            alnLength: 46,
            missmatches: 23,
            gapsopened: 0,
            qStartPos: 1,
            qEndPos: 46,
            dbStartPos: 1,
            dbEndPos: 46,
            prob: 1,
            eval: 0.00002168,
            score: 250,
            qLen: 46,
            dbLen: 46,
            taxId: 3965,
            taxName: 'Dendrophthora clavata',
          },
        ],
      ],
    },
    {
      db: 'bfmd',
      alignments: [
        [
          {
            query: 'job_A',
            target: 'LevyLab_Q8U2A3_V1_4_relaxed_B',
            seqId: 17.3,
            alnLength: 23,
            missmatches: 19,
            gapsopened: 0,
            qStartPos: 8,
            qEndPos: 30,
            dbStartPos: 209,
            dbEndPos: 231,
            prob: 0.126,
            eval: 6.981,
            score: 34,
            qLen: 46,
            dbLen: 332,
            taxId: 9606,
            taxName: 'Homo sapiens',
          },
        ],
      ],
    },
    {
      db: 'bfvd_v3',
      alignments: [
        [
          {
            query: 'job_A',
            target: 'U5P0K0 Uncharacterized protein',
            seqId: 14.8,
            alnLength: 27,
            missmatches: 23,
            gapsopened: 0,
            qStartPos: 5,
            qEndPos: 31,
            dbStartPos: 19,
            dbEndPos: 45,
            prob: 0.326,
            eval: 8.777,
            score: 45,
            qLen: 46,
            dbLen: 62,
            taxId: 1354510,
            taxName: 'Mycobacterium phage Fredward',
          },
        ],
      ],
    },
    {
      db: 'cath50',
      alignments: [
        [
          {
            query: 'job_A',
            target: '1cbnA00',
            seqId: 95.8,
            alnLength: 48,
            missmatches: 0,
            gapsopened: 2,
            qStartPos: 1,
            qEndPos: 46,
            dbStartPos: 1,
            dbEndPos: 48,
            prob: 1,
            eval: 2.134e-8,
            score: 328,
            qLen: 46,
            dbLen: 48,
            taxId: 3721,
            taxName: 'Crambe hispanica subsp. abyssinica',
          },
          {
            query: 'job_A',
            target: 'af_Q8VZK8_26_71_3.30.1350.10',
            seqId: 30.4,
            alnLength: 46,
            missmatches: 32,
            gapsopened: 0,
            qStartPos: 1,
            qEndPos: 46,
            dbStartPos: 1,
            dbEndPos: 46,
            prob: 1,
            eval: 0.0004075,
            score: 174,
            qLen: 46,
            dbLen: 46,
            taxId: 3702,
            taxName: 'Arabidopsis thaliana',
          },
        ],
      ],
    },
    {
      db: 'gmgcl_id',
      alignments: [
        [
          {
            query: 'job_A',
            target: 'GMGC10.211_012_347.UNKNOWN_trun_1.pdb',
            seqId: 32,
            alnLength: 25,
            missmatches: 17,
            gapsopened: 0,
            qStartPos: 7,
            qEndPos: 31,
            dbStartPos: 224,
            dbEndPos: 248,
            prob: 0.505,
            eval: 5.235,
            score: 51,
            qLen: 46,
            dbLen: 253,
          },
        ],
      ],
    },
    {
      db: 'mgnify_esm30',
      alignments: [
        [
          {
            query: 'job_A',
            target: 'MGYP001043648370.pdb.gz',
            seqId: 35.4,
            alnLength: 48,
            missmatches: 29,
            gapsopened: 1,
            qStartPos: 1,
            qEndPos: 46,
            dbStartPos: 16,
            dbEndPos: 63,
            prob: 1,
            eval: 0.01581,
            score: 143,
            qLen: 46,
            dbLen: 73,
          },
        ],
      ],
    },
    {
      db: 'pdb100',
      alignments: [
        [
          {
            query: 'job_A',
            target:
              '1crn-assembly1.cif.gz_A WATER STRUCTURE OF A HYDROPHOBIC PROTEIN AT ATOMIC RESOLUTION. PENTAGON RINGS OF WATER MOLECULES IN CRYSTALS OF CRAMBIN',
            seqId: 100,
            alnLength: 46,
            missmatches: 0,
            gapsopened: 0,
            qStartPos: 1,
            qEndPos: 46,
            dbStartPos: 1,
            dbEndPos: 46,
            prob: 1,
            eval: 3.458e-9,
            score: 357,
            qLen: 46,
            dbLen: 46,
            taxId: 3721,
            taxName: 'Crambe hispanica subsp. abyssinica',
          },
          {
            query: 'job_A',
            target:
              '2fd7-assembly1.cif.gz_A X-ray Crystal Structure of Chemically Synthesized Crambin',
            seqId: 97.8,
            alnLength: 46,
            missmatches: 1,
            gapsopened: 0,
            qStartPos: 1,
            qEndPos: 46,
            dbStartPos: 1,
            dbEndPos: 46,
            prob: 1,
            eval: 6.547e-9,
            score: 341,
            qLen: 46,
            dbLen: 46,
            taxId: 0,
            taxName: 'unclassified',
          },
        ],
      ],
    },
  ],
};
