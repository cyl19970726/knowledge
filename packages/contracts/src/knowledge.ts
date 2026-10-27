import { z } from 'zod';
import { AnalysisResultSchema } from './analysis.js';
import { EvidenceAnchorSchema, ProjectIdSchema, TimestampSchema, VersionRefSchema } from './primitives.js';
import { ResearchSourceProjectionSchema } from './research-source.js';

export const CitationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('media'), anchor: EvidenceAnchorSchema, supports: z.string().trim().min(1) }),
  z.strictObject({ kind: z.literal('source'), sourceRef: VersionRefSchema, locator: z.string().trim().min(1).nullable(), supports: z.string().trim().min(1) }),
]);
export type Citation = z.infer<typeof CitationSchema>;

/** Exploration-only decision help; each rendered entry cites registered source evidence. */
export const KnowledgeDecisionGuideSchema = z.strictObject({
  judgment: z.string().trim().min(1).max(12000),
  applicableWhen: z.array(z.string().trim().min(1).max(12000)).min(1).max(8),
  avoidWhen: z.array(z.string().trim().min(1).max(12000)).min(1).max(8),
  adaptationIdeas: z.array(z.string().trim().min(1).max(12000).refine(value=>value.startsWith('原创迁移假设：'),
    'Adaptation ideas must be explicitly labeled as original transfer hypotheses')).min(1).max(8),
  validationPlan: z.array(z.string().trim().min(1).max(12000)).min(1).max(8),
});
export type KnowledgeDecisionGuide = z.infer<typeof KnowledgeDecisionGuideSchema>;

const ResearchCaseStatementSchema = z.strictObject({
  text:z.string().trim().min(1).max(8000),
  sourceUnitIds:z.array(z.string().trim().min(1).max(300)).max(30),
  evidenceAliases:z.array(z.string().trim().min(1).max(300)).min(1).max(30),
});
export const ResearchCaseUnderstandingSchema = z.strictObject({
  classification:z.literal('derived_exploration'),
  form:ResearchCaseStatementSchema,
  structure:z.array(ResearchCaseStatementSchema.extend({role:z.string().trim().min(1).max(8000)})).min(1).max(30),
  viewerChange:ResearchCaseStatementSchema,
  limitations:z.array(z.string().trim().min(1).max(8000)).min(1).max(30),
});
export type ResearchCaseUnderstanding=z.infer<typeof ResearchCaseUnderstandingSchema>;

export const CaseVersionSchema = z.strictObject({
  schemaVersion: z.enum(['1.0','1.1','2.0']),
  ref: VersionRefSchema,
  projectId: ProjectIdSchema,
  analysisResultRef: VersionRefSchema,
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().min(1),
  citations: z.array(CitationSchema).max(100),
  sourceProjection:ResearchSourceProjectionSchema.optional(),
  understanding:ResearchCaseUnderstandingSchema.optional(),
  createdAt: TimestampSchema,
}).superRefine((value,context)=>{
  if(value.schemaVersion!=='1.1'&&!value.citations.length)
    context.addIssue({code:'custom',path:['citations'],message:'Derived/legacy cases require citations'});
  if(value.schemaVersion==='2.0'&&(!value.sourceProjection||!value.understanding))
    context.addIssue({code:'custom',message:'Research case v2 requires preserved source and reviewed understanding'});
  if(value.schemaVersion==='1.0'&&(value.sourceProjection||value.understanding))
    context.addIssue({code:'custom',message:'Preserved source requires case schemaVersion 1.1 or 2.0'});
  if(value.schemaVersion==='1.1'&&(!value.sourceProjection||value.understanding))
    context.addIssue({code:'custom',message:'Source-only case v1.1 requires preserved source and forbids derived understanding'});
  const source=value.sourceProjection?.source;
  if(source&&(source.projectId!==value.projectId||source.analysisRef.objectId!==value.analysisResultRef.objectId||
      source.analysisRef.versionId!==value.analysisResultRef.versionId))
    context.addIssue({code:'custom',message:'Preserved research source differs from exact case analysis'});
});
export type CaseVersion = z.infer<typeof CaseVersionSchema>;

function sameAnchor(left: z.infer<typeof EvidenceAnchorSchema>, right: z.infer<typeof EvidenceAnchorSchema>): boolean {
  return left.assetVersionId === right.assetVersionId &&
    left.sourceRef.objectId === right.sourceRef.objectId && left.sourceRef.versionId === right.sourceRef.versionId &&
    left.scope.kind === right.scope.kind &&
    (left.scope.kind === 'whole' || (right.scope.kind === 'segment' && left.scope.startMs === right.scope.startMs && left.scope.endMs === right.scope.endMs));
}

/** Cross-document link check when a consumer already has both immutable versions. */
export const CaseAnalysisLinkSchema = z.strictObject({
  analysisResult: AnalysisResultSchema,
  caseVersion: CaseVersionSchema,
}).superRefine(({ analysisResult, caseVersion }, context) => {
  if (caseVersion.projectId !== analysisResult.projectId) {
    context.addIssue({ code: 'custom', path: ['caseVersion', 'projectId'], message: 'Case and analysis result belong to different projects' });
  }
  if (caseVersion.analysisResultRef.objectId !== analysisResult.ref.objectId || caseVersion.analysisResultRef.versionId !== analysisResult.ref.versionId) {
    context.addIssue({ code: 'custom', path: ['caseVersion', 'analysisResultRef'], message: 'Case refers to a different analysis result version' });
  }
  caseVersion.citations.forEach((citation, index) => {
    if (citation.kind === 'media' && !analysisResult.evidence.some(anchor => sameAnchor(anchor, citation.anchor))) {
      context.addIssue({ code: 'custom', path: ['caseVersion', 'citations', index], message: 'Media citation is not registered in the analysis result evidence' });
    }
  });
});
export type CaseAnalysisLink = z.infer<typeof CaseAnalysisLinkSchema>;

export const ClaimVersionSchema = z.strictObject({
  schemaVersion: z.literal('1.0'),
  ref: VersionRefSchema,
  projectId: ProjectIdSchema,
  statement: z.string().trim().min(1),
  claimKind: z.enum(['observation', 'interpretation', 'hypothesis', 'product_fact', 'outcome', 'rule']),
  citations: z.array(CitationSchema).min(1).max(100),
  conditions: z.array(z.string().trim().min(1)).max(30),
  limitations: z.array(z.string().trim().min(1)).max(30),
  adoption: z.enum(['candidate', 'exploration_only', 'approved_for_purpose', 'rejected']),
  approvedPurpose: z.string().trim().min(1).nullable(),
  createdAt: TimestampSchema,
}).refine((claim) => claim.adoption !== 'approved_for_purpose' || claim.approvedPurpose !== null, {
  path: ['approvedPurpose'], message: 'Approved claim requires an explicit purpose',
});
export type ClaimVersion = z.infer<typeof ClaimVersionSchema>;

const PackItemSchema = z.strictObject({
  ref: VersionRefSchema,
  reason: z.string().trim().min(1),
  citations: z.array(CitationSchema).min(1).max(20),
});

/** All references are exact revisions. Empty counterexamples remain a stated gap. */
export const ReferencePackVersionSchema = z.strictObject({
  schemaVersion: z.literal('1.0'),
  ref: VersionRefSchema,
  projectId: ProjectIdSchema,
  purpose: z.string().trim().min(1),
  productVersionRef: VersionRefSchema,
  selectedCases: z.array(PackItemSchema).max(10),
  selectedPatterns: z.array(PackItemSchema).max(10),
  counterexamples: z.array(PackItemSchema).max(10),
  /** Research synthesis for exploration reading; never an additional supporting case. */
  researchContext: z.array(PackItemSchema).max(10).optional(),
  productFacts: z.array(z.strictObject({ statement: z.string().trim().min(1), sourceRef: VersionRefSchema, citations: z.array(CitationSchema).min(1).max(10) })).max(30),
  restrictions: z.array(z.string().trim().min(1)).max(50),
  unknowns: z.array(z.string().trim().min(1)).max(50),
  omissions: z.array(z.string().trim().min(1)).max(50),
  tokenBudget: z.int().positive().max(100000),
  tokenUsed: z.int().min(0),
  createdAt: TimestampSchema,
}).refine((pack) => pack.tokenUsed <= pack.tokenBudget, { path: ['tokenUsed'], message: 'tokenUsed exceeds tokenBudget' });
export type ReferencePackVersion = z.infer<typeof ReferencePackVersionSchema>;
