import { z } from 'zod';
import { ContentPlatformSchema, ContentTypeSchema } from './platforms.js';
import { CostObservationSchema, EvidenceAnchorSchema, IdSchema, MediaScopeSchema, ObjectRefSchema, ProjectIdSchema, Sha256Schema, TimestampSchema, VersionRefSchema } from './primitives.js';
import { ProviderObservationSchema } from './observations.js';

const SourceTextSchema = z.strictObject({ text: z.string().trim().min(1).max(20000), sourceRef: z.string().min(1).max(300), observedAt: TimestampSchema.nullable() });
/** Archived source record and separately associated cover, never a mutable library label. */
export const AnalysisPostSourceSchema = z.strictObject({
  schemaVersion: z.literal('post-source@1'), platform: ContentPlatformSchema.optional(), contentType: ContentTypeSchema.optional(), platformPostId: z.string().min(1).max(200),
  record: ObjectRefSchema, title: SourceTextSchema.nullable(), caption: SourceTextSchema.nullable(),
  cover: z.strictObject({ assetVersionId: IdSchema, object: ObjectRefSchema,
    sourceRef: z.string().min(1).max(300), observedAt: TimestampSchema.nullable() }).nullable(),
});
export type AnalysisPostSource = z.infer<typeof AnalysisPostSourceSchema>;

export const AnalysisSelectionSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('coarse_upgrade'), ruleVersion: z.literal('selective-fine@1'),
    overviewResultRef: VersionRefSchema, lanes: z.array(z.enum(['product', 'creative'])).min(1).max(2),
    rationale: z.string().trim().min(1).max(2000) }),
  z.strictObject({ mode: z.literal('manual'), ruleVersion: z.literal('selective-fine@1'),
    rationale: z.string().trim().min(1).max(2000) }),
]);
export type AnalysisSelection = z.infer<typeof AnalysisSelectionSchema>;

/** A snapshot freezes source evidence without merging creator, publisher or ad identities. */
export const AnalysisContextSnapshotSchema = z.strictObject({
  schemaVersion: z.literal('1.0'),
  ref: VersionRefSchema,
  projectId: ProjectIdSchema,
  assetVersionId: IdSchema,
  original: ObjectRefSchema,
  capturedAt: TimestampSchema,
  sourceContext: z.strictObject({
    providerObservations: z.array(ProviderObservationSchema).max(100),
    post: AnalysisPostSourceSchema.optional(),
  }),
  durationMs: z.int().positive().nullable(),
  language: z.string().trim().min(1).max(100).nullable(),
  unknowns: z.array(z.string().trim().min(1)).max(100),
}).superRefine((snapshot, context) => {
  snapshot.sourceContext.providerObservations.forEach((observation, index) => {
    if (observation.projectId !== snapshot.projectId) context.addIssue({ code: 'custom', path: ['sourceContext', 'providerObservations', index, 'projectId'], message: 'Observation belongs to another project' });
  });
});
export type AnalysisContextSnapshot = z.infer<typeof AnalysisContextSnapshotSchema>;

/** Null spendLimit means the cap is unknown, never unlimited paid execution. */
export const AnalysisExecutionLimitsSchema = z.strictObject({
  maxRunMs: z.int().min(100).max(86_400_000),
  maxModelCalls: z.int().min(0).max(1000),
  maxToolCalls: z.int().min(0).max(10000),
  maxRevisions: z.int().min(0).max(3),
  spendLimit: z.strictObject({ amount: z.number().finite().min(0), currency: z.string().regex(/^[A-Z]{3}$/) }).nullable(),
});
export type AnalysisExecutionLimits = z.infer<typeof AnalysisExecutionLimitsSchema>;

export const AnalysisRequestSchema = z.strictObject({
  projectId: ProjectIdSchema,
  assetVersionId: IdSchema,
  contextSnapshotId: IdSchema,
  profile: z.enum(['overview', 'fine']),
  question: z.string().trim().min(1).max(2000),
  scope: MediaScopeSchema,
  methodDigest: Sha256Schema,
  purpose: z.string().trim().min(1).max(500),
  limits: AnalysisExecutionLimitsSchema,
  /** Optional only for reading historical requests. New fine submissions require a reason. */
  selection: AnalysisSelectionSchema.optional(),
});
export type AnalysisRequest = z.infer<typeof AnalysisRequestSchema>;

/** Admission can verify the request, frozen snapshot and resolved asset together. */
export const RequestContextLinkSchema = z.strictObject({
  request: AnalysisRequestSchema,
  contextSnapshot: AnalysisContextSnapshotSchema,
  resolvedOriginal: z.strictObject({ assetVersionId: IdSchema, object: ObjectRefSchema }),
}).superRefine(({ request, contextSnapshot, resolvedOriginal }, context) => {
  if (request.projectId !== contextSnapshot.projectId) context.addIssue({ code: 'custom', path: ['contextSnapshot', 'projectId'], message: 'Snapshot belongs to another project' });
  if (request.contextSnapshotId !== contextSnapshot.ref.versionId) context.addIssue({ code: 'custom', path: ['request', 'contextSnapshotId'], message: 'Request refers to another snapshot version' });
  if (request.assetVersionId !== contextSnapshot.assetVersionId || request.assetVersionId !== resolvedOriginal.assetVersionId) {
    context.addIssue({ code: 'custom', path: ['request', 'assetVersionId'], message: 'Asset version differs across request, snapshot and resolver' });
  }
  if (request.scope.kind === 'segment' && contextSnapshot.durationMs !== null && request.scope.endMs > contextSnapshot.durationMs) {
    context.addIssue({ code: 'custom', path: ['request', 'scope', 'endMs'], message: 'Requested segment exceeds known media duration' });
  }
  const frozen = contextSnapshot.original;
  const resolved = resolvedOriginal.object;
  if (frozen.objectId !== resolved.objectId || frozen.sha256 !== resolved.sha256 || frozen.bytes !== resolved.bytes || frozen.mimeType !== resolved.mimeType || frozen.storage !== resolved.storage) {
    context.addIssue({ code: 'custom', path: ['resolvedOriginal', 'object'], message: 'Resolved original differs from frozen snapshot' });
  }
});
export type RequestContextLink = z.infer<typeof RequestContextLinkSchema>;

/** Analysis owns this read port; knowledge consumes exact versions through it. */
export interface AnalysisReadPort {
  getResult(projectId: string, ref: z.infer<typeof VersionRefSchema>): Promise<AnalysisResult | null>;
  getContextSnapshot(projectId: string, versionId: string): Promise<AnalysisContextSnapshot | null>;
  /** Missing support or a null decision is unknown, never production approval. */
  getCurrentAdoption?(projectId: string, ref: z.infer<typeof VersionRefSchema>, purpose: string): Promise<AnalysisAdoptionRecord | null>;
}

const CoverageSchema = z.strictObject({
  requested: MediaScopeSchema,
  observed: z.array(MediaScopeSchema).max(1000),
  gaps: z.array(z.string().min(1)).max(100),
  channels: z.array(z.enum(['visual', 'audio', 'captions'])).max(3),
});

function contains(outer: z.infer<typeof MediaScopeSchema>, inner: z.infer<typeof MediaScopeSchema>): boolean {
  if (outer.kind === 'whole') return true;
  return inner.kind === 'segment' && outer.startMs <= inner.startMs && outer.endMs >= inner.endMs;
}

/** Candidate and review record distinct upstream facts, neither implying adoption. */
export const AnalysisQualitySchema = z.strictObject({
  candidate: z.enum(['unreviewed', 'original_reviewed', 'revised_unverified', 'review_incomplete']),
  review: z.enum(['not_run', 'completed_no_findings', 'completed_with_findings', 'failed']),
});
export type AnalysisQuality = z.infer<typeof AnalysisQualitySchema>;

/** A later adoption decision is its own immutable record, not a mutable result field. */
export const AnalysisAdoptionRecordSchema = z.strictObject({
  schemaVersion: z.literal('1.0'),
  ref: VersionRefSchema,
  analysisResultRef: VersionRefSchema,
  purpose: z.string().trim().min(1),
  decision: z.enum(['exploration_only', 'approved', 'rejected']),
  rationale: z.string().trim().min(1),
  decidedAt: TimestampSchema,
});
export type AnalysisAdoptionRecord = z.infer<typeof AnalysisAdoptionRecordSchema>;

export const AnalysisResultSchema = z.strictObject({
  schemaVersion: z.literal('1.0'),
  ref: VersionRefSchema,
  projectId: ProjectIdSchema,
  contextSnapshotId: IdSchema,
  runId: IdSchema,
  attemptId: IdSchema,
  assetVersionId: IdSchema,
  profile: z.enum(['overview', 'fine']),
  question: z.string().min(1),
  purpose: z.string().trim().min(1).max(500),
  methodDigest: Sha256Schema,
  inputDigest: Sha256Schema,
  selection: AnalysisSelectionSchema.optional(),
  coverage: CoverageSchema,
  payloadRef: ObjectRefSchema,
  evidence: z.array(EvidenceAnchorSchema).max(10000),
  quality: AnalysisQualitySchema,
  cost: CostObservationSchema,
  createdAt: TimestampSchema,
}).superRefine((result, context) => {
  result.coverage.observed.forEach((scope, index) => {
    if (!contains(result.coverage.requested, scope)) context.addIssue({ code: 'custom', path: ['coverage', 'observed', index], message: 'Observed scope exceeds requested scope' });
  });
  result.evidence.forEach((anchor, index) => {
    if (anchor.assetVersionId !== result.assetVersionId) context.addIssue({ code: 'custom', path: ['evidence', index, 'assetVersionId'], message: 'Evidence refers to another asset version' });
    if (!result.coverage.observed.some(scope => contains(scope, anchor.scope))) context.addIssue({ code: 'custom', path: ['evidence', index, 'scope'], message: 'Evidence is outside observed coverage' });
  });
});
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;
