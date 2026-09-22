/**
 * @fileoverview Hand-trimmed Foldseek result payloads captured from the live
 * `search.foldseek.com` API (pdb100 + afdb50, mode 3diaa). Each keeps the real
 * response shape — per-database blocks, each one sorted descending by `score`
 * upstream, in the order Foldseek returns them — with only the leading hits of
 * each block and the bulky per-hit fields (`qAln`, `dbAln`, `tCa`, `tSeq`)
 * dropped. Query headers and sequences are truncated.
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
            prob: 1,
            eval: 2.269e-16,
            score: 876,
          },
          {
            query: 'job_A',
            target: 'AF-A0A0K2BMD8-F1-model_v6 Mutant hemoglobin alpha 2 globin chain',
            seqId: 99.2,
            alnLength: 141,
            prob: 1,
            eval: 2.904e-16,
            score: 872,
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
              '1y45-assembly1.cif.gz_C T-To-T(high) quaternary transitions in human hemoglobin',
            seqId: 100,
            alnLength: 141,
            prob: 1,
            eval: 4.985e-18,
            score: 920,
          },
          {
            query: 'job_A',
            target: '1bab-assembly1.cif.gz_A HEMOGLOBIN THIONVILLE: AN ALPHA-CHAIN VARIANT',
            seqId: 100,
            alnLength: 140,
            prob: 1,
            eval: 7.399e-18,
            score: 913,
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
            prob: 1,
            eval: 2.168e-5,
            score: 250,
          },
          {
            query: 'job_A',
            target: 'AF-A0A1J3H3C1-F1-model_v6 Thionin (Fragment)',
            seqId: 55.5,
            alnLength: 45,
            prob: 1,
            eval: 1.471e-4,
            score: 222,
          },
          {
            query: 'job_A',
            target: 'AF-A0A7J6GU35-F1-model_v6 Uncharacterized protein',
            seqId: 43.1,
            alnLength: 44,
            prob: 1,
            eval: 9.981e-4,
            score: 188,
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
            target: '1crn-assembly1.cif.gz_A WATER STRUCTURE OF A HYDROPHOBIC PROTEIN',
            seqId: 100,
            alnLength: 46,
            prob: 1,
            eval: 3.458e-9,
            score: 357,
          },
          {
            query: 'job_A',
            target: '1ejg-assembly1.cif.gz_A CRAMBIN AT ULTRA-HIGH RESOLUTION',
            seqId: 97.8,
            alnLength: 46,
            prob: 1,
            eval: 4.93e-9,
            score: 352,
          },
          {
            query: 'job_A',
            target: '3nir-assembly1.cif.gz_A Crystal structure of small protein crambin',
            seqId: 97.8,
            alnLength: 46,
            prob: 1,
            eval: 5.292e-9,
            score: 351,
          },
        ],
      ],
    },
  ],
};
