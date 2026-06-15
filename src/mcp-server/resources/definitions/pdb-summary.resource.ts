/**
 * @fileoverview pdb://{entry_id} — experimental structure summary (title, method,
 * resolution, organism, ligands, chains). The injectable-context twin of
 * protein_get_structure for source: experimental.
 * @module mcp-server/resources/definitions/pdb-summary.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { getRcsbService } from '@/services/rcsb/rcsb-service.js';

export const pdbSummaryResource = resource('pdb://{entry_id}', {
  name: 'pdb-structure-summary',
  title: 'PDB structure summary',
  description:
    'Experimental structure summary for a PDB entry: title, method, resolution, organism, chains, and bound ligands.',
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
      .array(
        z
          .object({
            entityId: z.string().describe('Polymer entity ID.'),
            description: z.string().optional().describe('Entity description.'),
            organism: z.string().optional().describe('Source organism.'),
            chains: z.array(z.string()).optional().describe('Author chain IDs.'),
            sequenceLength: z.number().optional().describe('Residue count.'),
          })
          .describe('A modeled polymer entity (chain group).'),
      )
      .describe('Modeled polymer entities.'),
    ligands: z
      .array(
        z
          .object({
            compId: z.string().describe('Chemical component ID.'),
            name: z.string().optional().describe('Chemical name.'),
            formula: z.string().optional().describe('Molecular formula.'),
          })
          .describe('A bound ligand (non-polymer chemical component).'),
      )
      .describe('Bound ligands.'),
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
