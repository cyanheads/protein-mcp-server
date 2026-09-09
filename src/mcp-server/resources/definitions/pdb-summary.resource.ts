/**
 * @fileoverview pdb://{entry_id} — experimental structure summary (title, method,
 * resolution, organism, ligands, and per-entity chain IDs in both the author and
 * mmCIF label namespaces). The injectable-context twin of protein_get_structure
 * for source: experimental.
 * @module mcp-server/resources/definitions/pdb-summary.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { ligandSchema, polymerEntitySchema } from '@/mcp-server/tools/definitions/_schemas.js';
import { getRcsbService } from '@/services/rcsb/rcsb-service.js';

export const pdbSummaryResource = resource('pdb://{entry_id}', {
  name: 'pdb-structure-summary',
  title: 'PDB structure summary',
  description:
    'Experimental structure summary for a PDB entry: title, method, resolution, organism, bound ligands, and per-entity chain IDs in both the author (auth_asym_id) and mmCIF label (label_asym_id) namespaces.',
  mimeType: 'application/json',
  params: z.object({
    entry_id: z.string().describe('PDB entry ID (e.g. 4HHB).'),
  }),
  output: z.object({
    id: z.string().describe('PDB entry ID.'),
    title: z.string().optional().describe('Structure title.'),
    methods: z.array(z.string()).optional().describe('Experimental method(s).'),
    resolution: z.number().optional().describe('Resolution in Å.'),
    molecularWeight: z.number().optional().describe('Structure molecular weight (kDa).'),
    releaseDate: z.string().optional().describe('Initial release date (ISO 8601).'),
    organisms: z.array(z.string()).describe('Source organisms.'),
    polymerEntities: z
      .array(polymerEntitySchema)
      .describe(
        'Modeled polymer entities, each carrying both chain namespaces — authAsymIds for protein_get_annotations, labelAsymIds for protein_compare_structures.',
      ),
    ligands: z.array(ligandSchema).describe('Bound ligands.'),
  }),

  async handler(params, ctx) {
    const [meta] = await getRcsbService().getEntries([params.entry_id], ctx);
    if (!meta)
      throw notFound(`No PDB entry found for ${params.entry_id.toUpperCase()}`, {
        entryId: params.entry_id,
      });
    return {
      id: meta.id,
      ...(meta.title ? { title: meta.title } : {}),
      ...(meta.methods && meta.methods.length > 0 ? { methods: meta.methods } : {}),
      ...(typeof meta.resolution === 'number' ? { resolution: meta.resolution } : {}),
      ...(typeof meta.molecularWeight === 'number'
        ? { molecularWeight: meta.molecularWeight }
        : {}),
      ...(meta.releaseDate ? { releaseDate: meta.releaseDate } : {}),
      organisms: meta.organisms,
      polymerEntities: meta.polymerEntities,
      ligands: meta.ligands,
    };
  },
});
