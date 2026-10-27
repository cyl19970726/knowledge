import { z } from 'zod';

export const IdSchema = z.uuid();
/** Existing project slugs such as `local-perseek` are valid identities. */
export const ProjectIdSchema = z.string().trim().min(1).max(200);
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, 'Expected lowercase SHA-256 hex');
export const TimestampSchema = z.iso.datetime({ offset: true });
export const JsonSchema = z.json();

/** Stable entity identity plus an exact, immutable revision identity. */
export const VersionRefSchema = z.strictObject({
  objectId: IdSchema,
  versionId: IdSchema,
});
export type VersionRef = z.infer<typeof VersionRefSchema>;

/** Private stored bytes only. A delivery URL is resolved separately for an authorized reader. */
export const ObjectRefSchema = z.strictObject({
  objectId: IdSchema,
  sha256: Sha256Schema,
  bytes: z.int().min(1),
  mimeType: z.string().trim().min(3).regex(/^[^\s/]+\/[^\s/]+$/),
  storage: z.literal('r2'),
});
export type ObjectRef = z.infer<typeof ObjectRefSchema>;

const WholeScopeSchema = z.strictObject({ kind: z.literal('whole') });
const SegmentScopeSchema = z.strictObject({
  kind: z.literal('segment'),
  startMs: z.int().min(0),
  endMs: z.int().positive(),
}).refine((scope) => scope.endMs > scope.startMs, { message: 'endMs must be greater than startMs' });
export const MediaScopeSchema = z.union([WholeScopeSchema, SegmentScopeSchema]);
export type MediaScope = z.infer<typeof MediaScopeSchema>;

export const EvidenceAnchorSchema = z.strictObject({
  assetVersionId: IdSchema,
  scope: MediaScopeSchema,
  sourceRef: VersionRefSchema,
});
export type EvidenceAnchor = z.infer<typeof EvidenceAnchorSchema>;

/** No monetary amount is inferred from absence of a bill or usage response. */
export const CostObservationSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('unknown'), reason: z.string().min(1) }),
  z.strictObject({ state: z.literal('known'), amount: z.number().finite().min(0), currency: z.string().regex(/^[A-Z]{3}$/) }),
]);
export type CostObservation = z.infer<typeof CostObservationSchema>;
