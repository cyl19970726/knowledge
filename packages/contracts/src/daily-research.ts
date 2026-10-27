import { CognitionDailySnapshotSchema } from './cognition-daily.js';
import { z } from 'zod';
import { ContentPlatformSchema, ContentTypeSchema } from './platforms.js';
import { IdSchema, ProjectIdSchema, Sha256Schema, TimestampSchema, VersionRefSchema } from './primitives.js';
import { ResearchSourceProjectionSchema } from './research-source.js';

const DateSchema = z.iso.date();
const LaneSchema = z.enum(['product', 'creative']);
const TextSchema = z.string().trim().min(1).max(2000);
const GuideTextSchema = z.string().trim().min(1).max(12000);
const KnowledgeBodySchema = z.string().trim().min(1).max(100000)
  .refine(value=>new TextEncoder().encode(value).byteLength<=80*1024,'Frozen knowledge body exceeds 80 KiB');

/** Exact input identity; the daily output itself is never a new evidence source. */
export const DailyEvidenceRefSchema = z.strictObject({
  domain: z.enum(['source', 'metric', 'analysis', 'adoption', 'knowledge']),
  ref: VersionRefSchema,
});
export type DailyEvidenceRef = z.infer<typeof DailyEvidenceRefSchema>;

export const DailyMaterialObservationSchema = z.strictObject({
  platform: ContentPlatformSchema.optional(),
  contentType: ContentTypeSchema.optional(),
  materialId: IdSchema,
  postId: TextSchema.nullable(),
  title: TextSchema.nullable(),
  sourceGroup: TextSchema,
  publisher: TextSchema.nullable(),
  publishedAt: TimestampSchema.nullable(),
  discoveredAt: TimestampSchema,
  lanes: z.array(LaneSchema).min(1).max(2),
  refs: z.array(DailyEvidenceRefSchema).min(1).max(20),
});
export type DailyMaterialObservation = z.infer<typeof DailyMaterialObservationSchema>;

export const DailyMetricFactSchema = z.strictObject({
  platform: ContentPlatformSchema.optional(),
  contentType: ContentTypeSchema.optional(),
  postId: TextSchema,
  sourceGroup: TextSchema,
  metric: z.enum(['likes', 'views', 'comments', 'shares', 'saves']),
  value: z.number().finite().nonnegative(),
  capturedAt: TimestampSchema,
  provider: TextSchema,
  scope: TextSchema,
  /** Only equal nonempty keys may be compared as a time series. */
  comparabilityKey: TextSchema,
  ref: DailyEvidenceRefSchema.refine(value => value.domain === 'metric', 'Expected a metric ref'),
});
export type DailyMetricFact = z.infer<typeof DailyMetricFactSchema>;

const DailyScreeningLaneSchema = z.strictObject({
  verdict: z.enum(['recommend_watch', 'defer', 'insufficient_evidence']),
  priority: z.enum(['high', 'medium', 'low', 'undetermined']),
  reasons: z.array(TextSchema).max(12),
}).refine(value => value.verdict === (value.priority === 'undetermined' ? 'insufficient_evidence' : value.priority === 'low' ? 'defer' : 'recommend_watch'),
  'Screening priority and verdict disagree');
export const DailyScreeningSchema = z.strictObject({ product: DailyScreeningLaneSchema, creative: DailyScreeningLaneSchema });
export type DailyScreening = z.infer<typeof DailyScreeningSchema>;

export const DailyAnalysisSummarySchema = z.strictObject({
  resultRef: DailyEvidenceRefSchema.refine(value => value.domain === 'analysis', 'Expected an analysis ref'),
  assetVersionId: IdSchema,
  createdAt: TimestampSchema,
  sourceGroup: TextSchema,
  profile: z.enum(['overview', 'fine']),
  lanes: z.array(LaneSchema).min(1).max(2),
  observations: z.array(TextSchema).max(20),
  hypotheses: z.array(TextSchema).max(20),
  unknowns: z.array(TextSchema).max(20),
  quality: z.enum(['unreviewed', 'original_reviewed', 'revised_unverified', 'review_incomplete']),
  adoption: z.enum(['approved', 'exploration_only', 'rejected', 'unknown']),
  adoptionRef: DailyEvidenceRefSchema.refine(value => value.domain === 'adoption', 'Expected an adoption ref').nullable(),
  screening: DailyScreeningSchema.optional(),
}).refine(value => !['approved', 'rejected'].includes(value.adoption) || value.adoptionRef !== null,
  'Approved or rejected adoption requires an exact decision ref');
export type DailyAnalysisSummary = z.infer<typeof DailyAnalysisSummarySchema>;

export const DailyKnowledgeRefSchema = z.strictObject({
  platforms: z.array(ContentPlatformSchema).optional(),
  platformTransfers: z.array(z.strictObject({to:ContentPlatformSchema.exclude(['unknown']),rationale:z.string().trim().min(1)})).optional(),
  ref: DailyEvidenceRefSchema.refine(value => value.domain === 'knowledge' || value.domain === 'source', 'Expected knowledge or source ref'),
  sourceGroups: z.array(TextSchema).min(1).max(100),
  lanes: z.array(LaneSchema).min(1).max(2),
  summary: TextSchema,
  kind: z.enum(['case','claim','pattern','comparison','wiki','collection','reference_pack']).optional(),
  title: TextSchema.optional(),
  body: KnowledgeBodySchema.optional(),
  createdAt: TimestampSchema.optional(),
  validity: z.enum(['valid', 'limited', 'invalid', 'unknown']),
  /** Present only when a valid, reviewed Wiki recorded a decision guide at freeze time. */
  decisionGuide: z.strictObject({
    judgment: GuideTextSchema, applicableWhen: z.array(GuideTextSchema), avoidWhen: z.array(GuideTextSchema),
    adaptationIdeas: z.array(GuideTextSchema), validationPlan: z.array(GuideTextSchema),
  }).optional(),
  decisionGuideReview: z.strictObject({decision:z.enum(['exploration_only','approved_for_purpose']),purpose:TextSchema}).optional(),
});
export type DailyKnowledgeRef = z.infer<typeof DailyKnowledgeRefSchema>;

export const DailyResearchQuestionSchema = z.strictObject({
  id: z.string().min(1).max(80), question: TextSchema,
  dimensions: z.array(z.enum(['product','consumer','market','creative','distribution','commerce','experiment','source_quality'])).min(1),
});
export const DailyResearchQueryLogSchema = z.strictObject({
  questionId: z.string().min(1).max(80), query: TextSchema,
  considered: z.int().nonnegative(),
  included: z.array(DailyEvidenceRefSchema).max(100),
  excluded: z.array(z.strictObject({ref:DailyEvidenceRefSchema,reason:z.enum(['outside_cutoff','unreviewed','invalid','unrelated','scope_limit','same_source_context'])})).max(200),
  limit: z.int().positive(), truncated: z.boolean(),
});

export const DailyAutomationObservationSchema = z.strictObject({
  policyVersion: TextSchema,
  selectedMaterials: z.int().min(0),
  selectedByTrack: z.strictObject({ fresh: z.int().min(0), backlog: z.int().min(0) }),
  knowledgeMode: z.enum(['capped','on_change']).optional(),
  limits: z.strictObject({ overview: z.int().min(0), fine: z.int().min(0).optional(), knowledgeBuilds: z.int().min(0), providerRequests: z.int().min(0), mediaBytes: z.int().min(0) }),
  operations: z.array(z.strictObject({kind:TextSchema,status:TextSchema,count:z.int().min(0)})).max(100),
});

export const DailyResearchManifestSchema = z.strictObject({
  schemaVersion: z.literal('daily-research@1'),
  projectId: ProjectIdSchema,
  date: DateSchema,
  timeZone: z.string().trim().min(1).max(100),
  cutoffAt: TimestampSchema,
  policyVersion: TextSchema,
  method: z.strictObject({version:z.literal('daily-semantic-research@1'),maxModelCalls:z.literal(4),maxToolReads:z.literal(12)}).optional(),
  cognition: CognitionDailySnapshotSchema.optional(),
  selection: z.lazy(() => DailySelectionSnapshotSchema).nullable(),
  automation: DailyAutomationObservationSchema.optional(),
  materials: z.array(DailyMaterialObservationSchema).max(1000),
  currentFacts: z.array(DailyMetricFactSchema).max(5000),
  historyFacts: z.array(DailyMetricFactSchema).max(10000),
  analyses: z.array(DailyAnalysisSummarySchema).max(1000),
  questions: z.array(DailyResearchQuestionSchema).optional(),
  sourceProjections: z.array(ResearchSourceProjectionSchema).max(50).optional(),
  queryLog: z.array(DailyResearchQueryLogSchema).max(50).optional(),
  knowledge: z.array(DailyKnowledgeRefSchema).max(1000),
  gaps: z.array(TextSchema).max(1000),
});
export type DailyResearchManifest = z.infer<typeof DailyResearchManifestSchema>;
/** The host freezes this exact manifest after registering its original sources in learning. */
export type DailyResearchInput = DailyResearchManifest;

export const DailyReportItemSchema = z.strictObject({
  lane: LaneSchema.nullable(),
  sourceGroup: TextSchema.nullable(),
  text: TextSchema,
  stance: z.enum(['observation', 'hypothesis', 'unknown']),
  references: z.array(DailyEvidenceRefSchema).max(20),
});
export type DailyReportItem = z.infer<typeof DailyReportItemSchema>;

export const DailySemanticFindingSchema = z.strictObject({
  questionId:z.string().min(1).max(80),
  form:TextSchema,structure:TextSchema,conditions:TextSchema,
  priorUnderstanding:TextSchema,currentUnderstanding:TextSchema,
  relationship:z.enum(['supports','challenges','narrows','unchanged','incomparable','unknown']),
  whyItMatters:TextSchema,watchFor:TextSchema,unknown:TextSchema,nextAction:TextSchema,
  references:z.array(DailyEvidenceRefSchema).min(1).max(20),
  sourceGroups:z.array(TextSchema).min(1).max(20),
});
export const DailySemanticDraftSchema = z.strictObject({
  findings:z.array(DailySemanticFindingSchema).max(20),limitations:z.array(TextSchema).min(1).max(30),
});

export const DailyResearchReportSchema = z.strictObject({
  schemaVersion: z.literal('daily-research-report@1'),
  status: z.enum(['research_digest', 'partial']),
  date: DateSchema,
  timeZone: z.string().trim().min(1),
  cutoffAt: TimestampSchema,
  cognition: CognitionDailySnapshotSchema.optional(),
  semanticResearch: z.strictObject({
    workflowRunId: IdSchema,
    methodVersion: TextSchema,
    status: z.enum(['reviewed','restricted']),
    review: z.strictObject({passed:z.boolean(),issues:z.array(TextSchema).max(20)}),
    ...DailySemanticDraftSchema.shape,
  }).optional(),
  sections: z.strictObject({
    discoveries: z.array(DailyReportItemSchema),
    product: z.array(DailyReportItemSchema),
    creative: z.array(DailyReportItemSchema),
    dataChanges: z.array(DailyReportItemSchema),
    knowledgeLinks: z.array(DailyReportItemSchema),
    counterexamplesAndGaps: z.array(DailyReportItemSchema),
    tomorrowActions: z.array(DailyReportItemSchema),
  }),
});
export type DailyResearchReport = z.infer<typeof DailyResearchReportSchema>;

const dailyEvidenceKey=(item:DailyEvidenceRef)=>`${item.domain}:${item.ref.objectId}:${item.ref.versionId}`;
/** Shared semantic admission check used before method publication and during durable report completion. */
export function validateDailyResearchDraft(manifest:DailyResearchManifest, value:unknown):{valid:boolean;details:string[]} {
  const parsed=DailySemanticDraftSchema.safeParse(value);
  if(!parsed.success)return {valid:false,details:parsed.error.issues.map(issue=>`${issue.path.join('.')}: ${issue.message}`).slice(0,20)};
  const permitted=new Set<string>();
  const analysisGroupByRef=new Map<string,string>();
  const analysisPlatformByRef=new Map<string,z.infer<typeof ContentPlatformSchema>>();
  const knowledgeByRef=new Map<string,DailyKnowledgeRef>();
  for(const source of manifest.sourceProjections??[]) {
    const key=dailyEvidenceKey({domain:'analysis',ref:source.source.analysisRef});
    permitted.add(key);analysisGroupByRef.set(key,source.source.sourceGroup);
    // Missing platform belongs to the historical TikTok corpus; explicit unknown stays unknown.
    analysisPlatformByRef.set(key,source.source.platform??'tiktok');
  }
  for(const item of manifest.knowledge) {
    const key=dailyEvidenceKey(item.ref);permitted.add(key);
    knowledgeByRef.set(key,item);
  }
  for(const metric of [...manifest.currentFacts,...manifest.historyFacts]) {
    permitted.add(dailyEvidenceKey(metric.ref));
  }
  const questions=new Set((manifest.questions??[]).map(item=>item.id));
  const issues:string[]=[];
  for(const question of manifest.questions??[]) {
    const included=manifest.queryLog?.find(log=>log.questionId===question.id)?.included??[];
    if(!included.some(ref=>ref.domain==='analysis'&&analysisGroupByRef.has(dailyEvidenceKey(ref)))&&
      !parsed.data.limitations.some(limit=>limit.includes(`${question.id}:`)))
      issues.push(`question ${question.id}: missing explicit no-analysis limitation`);
  }
  for(const [i,item] of parsed.data.findings.entries()) {
    if(!questions.has(item.questionId))issues.push(`finding ${i}: unknown question`);
    const refKeys=item.references.map(dailyEvidenceKey);
    const query=manifest.queryLog?.find(log=>log.questionId===item.questionId);
    if(!query)issues.push(`finding ${i}: question has no frozen read set`);
    else {
      const selected=new Set(query.included.map(dailyEvidenceKey));
      for(const key of refKeys)if(!selected.has(key))issues.push(`finding ${i}: reference excluded from question read set`);
      if(!query.included.some(ref=>ref.domain==='analysis'&&analysisGroupByRef.has(dailyEvidenceKey(ref))))
        issues.push(`finding ${i}: question has no original analysis in read set`);
    }
    for(const key of refKeys)if(!permitted.has(key))issues.push(`finding ${i}: reference outside frozen read set`);
    if(!item.references.some(r=>r.domain==='analysis'))issues.push(`finding ${i}: no original analysis reference`);
    const groups=new Set(item.sourceGroups);
    if(groups.size!==item.sourceGroups.length)issues.push(`finding ${i}: repeated source group`);
    const citedGroups=new Set(item.references.filter(ref=>ref.domain==='analysis').map(ref=>analysisGroupByRef.get(dailyEvidenceKey(ref))).filter((group):group is string=>!!group));
    for(const group of citedGroups)if(!groups.has(group))issues.push(`finding ${i}: cited source group missing`);
    for(const group of groups)if(!citedGroups.has(group))issues.push(`finding ${i}: source group has no cited origin`);
    if(['supports','challenges','narrows','unchanged'].includes(item.relationship)) {
      const citedPlatforms=new Set(item.references.filter(ref=>ref.domain==='analysis')
        .map(ref=>analysisPlatformByRef.get(dailyEvidenceKey(ref))).filter((platform):platform is z.infer<typeof ContentPlatformSchema>=>!!platform));
      for(const ref of item.references) {
        const knowledge=knowledgeByRef.get(dailyEvidenceKey(ref));
        if(!knowledge)continue;
        const nativePlatforms=knowledge.platforms??['tiktok'];
        for(const platform of citedPlatforms) {
          if(platform==='unknown'||(!nativePlatforms.includes(platform)&&
            !knowledge.platformTransfers?.some(transfer=>transfer.to===platform&&transfer.rationale.trim())))
            issues.push(`finding ${i}: knowledge platform does not support cited ${platform} analysis`);
        }
      }
    }
    const prose=[item.form,item.structure,item.conditions,item.priorUnderstanding,item.currentUnderstanding,
      item.whyItMatters,item.watchFor,item.unknown,item.nextAction].join(' ');
    if(/听到|听见|heard (?:the|a|an)|audio confirms/i.test(prose)) {
      const sources=(manifest.sourceProjections??[]).filter(p=>refKeys.includes(dailyEvidenceKey({domain:'analysis',ref:p.source.analysisRef})));
      if(sources.some(p=>!p.source.coverage.channels.includes('audio')||p.source.coverage.gaps.some(g=>/音轨|音频|audio/i.test(g))))
        issues.push(`finding ${i}: unsupported audio assertion`);
    }
  }
  return {valid:issues.length===0,details:issues.slice(0,20)};
}

export const DailyResearchEntrySchema = z.strictObject({
  id: IdSchema,
  projectId: ProjectIdSchema,
  date: DateSchema,
  revision: z.int().positive(),
  requestKey: TextSchema,
  manifestHash: Sha256Schema,
  manifest: DailyResearchManifestSchema,
  status: z.enum(['pending', 'complete']),
  report: DailyResearchReportSchema.nullable(),
  createdAt: TimestampSchema,
  completedAt: TimestampSchema.nullable(),
});
export type DailyResearchEntry = z.infer<typeof DailyResearchEntrySchema>;

/** Derived reading view. Stored report and manifest revisions remain immutable. */
export const DailyReadingSchema = z.strictObject({
  schemaVersion: z.literal('daily-reading@1'),
  currentReportId: IdSchema,
  previousReportId: IdSchema.nullable(),
  comparison: z.enum(['first_revision', 'same_day_revision']),
  changes: z.array(z.strictObject({
    kind: z.enum(['registered_text_change', 'judgment_text_change', 'version_only', 'scope_added', 'scope_missing']),
    sourceGroup: TextSchema.nullable(), text: TextSchema, references: z.array(DailyEvidenceRefSchema),
  })),
  nextSteps: z.array(z.strictObject({
    label: z.enum(['reasoned', 'deterministic_queue']), action: TextSchema, basis: TextSchema,
    unknown: TextSchema, decisionImpact: TextSchema, references: z.array(DailyEvidenceRefSchema),
  })).max(3),
  decisionGuides: z.array(z.strictObject({
    sourceGroups: z.array(TextSchema), ref: DailyEvidenceRefSchema,
    guide: DailyKnowledgeRefSchema.shape.decisionGuide.unwrap().nullable(),
    review: DailyKnowledgeRefSchema.shape.decisionGuideReview.unwrap().nullable().optional(),
  })),
});
export type DailyReading = z.infer<typeof DailyReadingSchema>;

export const DailySelectionPolicySchema = z.strictObject({
  version: TextSchema,
  asOf: TimestampSchema,
  track: z.enum(['fresh', 'backlog', 'mixed']).optional(),
  maxTotal: z.int().nonnegative().max(1000).optional(),
  freshMax: z.int().nonnegative().max(1000).optional(),
  minLikes: z.int().nonnegative(),
  recentDays: z.int().positive(),
  priorityDays: z.int().positive(),
  maxMetricAgeDays: z.int().positive(),
  maxPerPublisher: z.int().positive(),
  materialKindCaps: z.strictObject({ 'public-post': z.int().nonnegative(), 'ad-case': z.int().nonnegative(),
    'client-reference': z.int().nonnegative() }).optional(),
  quotas: z.strictObject({ product: z.int().nonnegative(), creative: z.int().nonnegative() }),
}).refine(value => value.priorityDays <= value.recentDays, 'priorityDays must be within recentDays');
export type DailySelectionPolicy = z.infer<typeof DailySelectionPolicySchema>;

export const DailySelectionCandidateSchema = z.strictObject({
  platform: ContentPlatformSchema.optional(),
  contentType: ContentTypeSchema.optional(),
  id: IdSchema,
  materialKind: z.enum(['public-post', 'ad-case', 'client-reference']).optional(),
  researchReason: TextSchema.optional(),
  postId: TextSchema.nullable(),
  contentHash: Sha256Schema.nullable(),
  sourceGroup: TextSchema,
  publisher: TextSchema.nullable(),
  publishedAt: TimestampSchema.nullable(),
  metricsCapturedAt: TimestampSchema.nullable(),
  likes: z.int().nonnegative().nullable(),
  hasOriginal: z.boolean(),
  alreadyAnalyzed: z.boolean(),
  lanes: z.array(LaneSchema).min(1).max(2),
});
export type DailySelectionCandidate = z.infer<typeof DailySelectionCandidateSchema>;

export const DailySelectionDecisionSchema = z.strictObject({
  candidateId: IdSchema,
  track: z.enum(['fresh', 'backlog']).optional(),
  lane: LaneSchema,
  selected: z.boolean(),
  reason: z.enum(['selected_priority', 'selected_recent', 'selected_backlog', 'selected_reference', 'selected_question', 'already_analyzed', 'duplicate', 'missing_original', 'unknown_likes', 'below_min_likes', 'unknown_published_at', 'outside_window', 'unknown_metrics_captured_at', 'unknown_publisher', 'publisher_cap', 'material_kind_cap', 'quota_full', 'stale_metrics']),
});
export type DailySelectionDecision = z.infer<typeof DailySelectionDecisionSchema>;

export const DailySelectionSnapshotSchema = z.strictObject({
  policy: DailySelectionPolicySchema,
  decisions: z.array(DailySelectionDecisionSchema),
  selected: z.strictObject({ product: z.array(IdSchema), creative: z.array(IdSchema) }),
});
export type DailySelectionSnapshot = z.infer<typeof DailySelectionSnapshotSchema>;
