import { z } from 'zod';
import { ContentPlatformSchema, ContentTypeSchema } from './platforms.js';
import { AnalysisQualitySchema } from './analysis.js';
import { EvidenceAnchorSchema, MediaScopeSchema, ProjectIdSchema, VersionRefSchema } from './primitives.js';

/** A bounded, lossless selection of fields from an immutable analysis report. The report remains canonical. */
export const ResearchSourceFieldSchema = z.strictObject({
  path: z.string().startsWith('/').max(300),
  presence: z.enum(['present', 'absent']),
  value: z.json().optional(),
}).superRefine((field, context) => {
  if ((field.presence === 'present') !== Object.hasOwn(field, 'value'))
    context.addIssue({ code: 'custom', message: 'Presence and value must agree' });
});
export type ResearchSourceField = z.infer<typeof ResearchSourceFieldSchema>;

export const ResearchEvidenceAliasSchema = z.discriminatedUnion('status', [
  z.strictObject({ localId: z.string().min(1).max(300), status: z.literal('resolved'),
    evidenceIndex: z.int().nonnegative(), anchor: EvidenceAnchorSchema }),
  z.strictObject({ localId: z.string().min(1).max(300), status: z.literal('unresolved'),
    reason: z.enum(['catalog_unavailable', 'not_registered']) }),
]);
export type ResearchEvidenceAlias = z.infer<typeof ResearchEvidenceAliasSchema>;

export const ResearchSourceProjectionSchema = z.strictObject({
  schemaVersion: z.literal('research-source-projection@1'),
  source: z.strictObject({ platform: ContentPlatformSchema.optional(), contentType: ContentTypeSchema.optional(), projectId: ProjectIdSchema, sourceGroup: z.string().trim().min(1).max(300),
    analysisRef: VersionRefSchema, assetVersionId: z.uuid(), profile: z.enum(['overview', 'fine']),
    payloadSchemaVersion: z.string().min(1).max(100), createdAt: z.iso.datetime({ offset: true }),
    question: z.string().min(1), purpose: z.string().min(1),
    quality: AnalysisQualitySchema,
    coverage: z.strictObject({ requested: MediaScopeSchema, observed: z.array(MediaScopeSchema),
      gaps: z.array(z.string()), channels: z.array(z.enum(['visual', 'audio', 'captions'])) }),
  }),
  fields: z.array(ResearchSourceFieldSchema).max(100),
  evidenceAliases: z.array(ResearchEvidenceAliasSchema).max(10000),
});
export type ResearchSourceProjection = z.infer<typeof ResearchSourceProjectionSchema>;

/** Entries must come from the host's verified manifest/registered-evidence join. */
export const VerifiedResearchEvidenceEntrySchema = z.strictObject({
  evidenceIndex: z.int().nonnegative(), sourceEvidenceId: z.string().min(1).max(300).nullable(),
  kind: z.enum(['frame', 'caption', 'source_text']).nullable(), atMs: z.int().nonnegative().nullable(),
  endMs: z.int().nonnegative().nullable(), sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
});
export type VerifiedResearchEvidenceEntry = z.infer<typeof VerifiedResearchEvidenceEntrySchema>;
