import { CaseFactRefSchema } from './case-fact.ts';
import { SourceRecordRefSchema } from './source-record.ts';
import { CaseFieldReadingRefSchema } from './case-field-reading.ts';
import { VideoTopicSynthesisMetadataValidator } from './video-topic-synthesis-types.ts';
import { z } from 'zod';
import { CaseVersionSchema, ClaimVersionSchema, CitationSchema, ContentPlatformSchema, CostObservationSchema, EvidenceAnchorSchema, IdSchema, KnowledgeDecisionGuideSchema, MediaScopeSchema, ObjectRefSchema, ProjectIdSchema, ReferencePackVersionSchema, Sha256Schema, TimestampSchema, VersionRefSchema } from '../../contracts/src/index.ts';
import {PublicationPermitSchema} from './wiki-publication-authority.ts';
import { WikiPageBindingSchema, WikiPageContentSchema } from './wiki-page.ts';
import {digest} from './utils.ts';
import type { KnowledgeRevision, CreativeKnowledgeTask, RegisteredSource } from './types.ts';
const text = z.string().trim().min(1).max(12000);
const texts = z.array(text).max(50);
export const DependencySchema = z.strictObject({ domain: z.enum(['knowledge','analysis','context','source','evidence']), ref: VersionRefSchema, role: z.enum(['derived_from','supports','challenges','uses']), critical: z.boolean(),
  useScope:z.strictObject({claimRef:VersionRefSchema.optional(),anchor:EvidenceAnchorSchema.optional(),channels:z.array(z.enum(['visual','audio','captions'])).min(1).max(3),mediaScope:MediaScopeSchema}).optional(),
  rationale:text.optional(),conditions:texts.optional(),citations:z.array(CitationSchema).max(100).optional(),purpose:text.optional(),reviewRef:VersionRefSchema.optional() });
export const ApplicabilitySchema = z.strictObject({
  productVersionRefs: z.array(VersionRefSchema).max(30),
  platforms: z.array(ContentPlatformSchema).max(4).optional(),
  platformTransfers: z.array(z.strictObject({to:ContentPlatformSchema.exclude(['unknown']),rationale:text})).max(3).optional(),
  markets: texts, languages: texts, audiences: texts, goals: texts,
  requiredProduction: texts, transferRationale: text.nullable(),
});
export const KnowledgeScopeSchema = z.strictObject({ applicability: ApplicabilitySchema, limitations: texts, unknowns: texts,
  goalTags: z.array(z.enum(['platform_rules','data_acquisition','market_research','yesnap_benchmark','perseek_diagnosis','video_business_actions','testing_learning'])).min(1).max(7).optional(), reviewDueAt: TimestampSchema.nullable() });
export const WikiPageScopeSchema = z.strictObject({applicability:ApplicabilitySchema,limitations:texts,unknowns:texts,reviewDueAt:TimestampSchema.nullable()});
const identity = { ref: VersionRefSchema, projectId: ProjectIdSchema, title: text };
const refs = z.array(VersionRefSchema).max(100);
const citations = z.array(CitationSchema).min(1).max(100);
const FactRefs=z.array(CaseFactRefSchema).min(1).max(30);
const SourceRecordRefs=z.array(SourceRecordRefSchema).min(1).max(30);
const CollectionMemberSchema=z.strictObject({ ref: VersionRefSchema, role: z.enum(['support','counterexample','incomparable','example']), reason: text,
  evidenceBasis:z.enum(['media_observation','case_metadata','source_record','case_field_reading']).optional(),caseFactRefs:FactRefs.optional(),
  sourceRecordRefs:SourceRecordRefs.optional(),caseFieldReadingRef:CaseFieldReadingRefSchema.optional() }).superRefine((member,ctx)=>{
    if(member.evidenceBasis==='case_metadata'){
      if(!member.caseFactRefs)ctx.addIssue({code:'custom',path:['caseFactRefs'],message:'Case metadata classification requires exact registered Case facts'});
      if(member.role!=='incomparable')ctx.addIssue({code:'custom',path:['role'],message:'Case metadata may classify comparability only'});
    }
    if(member.evidenceBasis!=='case_metadata'&&member.caseFactRefs)
      ctx.addIssue({code:'custom',path:['caseFactRefs'],message:'Case facts require the explicit metadata evidence basis'});
    if(member.evidenceBasis==='source_record'&&!member.sourceRecordRefs)
      ctx.addIssue({code:'custom',path:['sourceRecordRefs'],message:'Source record classification requires exact Case records'});
    if(member.evidenceBasis!=='source_record'&&member.sourceRecordRefs)
      ctx.addIssue({code:'custom',path:['sourceRecordRefs'],message:'Source records require the explicit source_record evidence basis'});
    if(member.evidenceBasis==='case_field_reading'&&!member.caseFieldReadingRef)
      ctx.addIssue({code:'custom',path:['caseFieldReadingRef'],message:'Case field reading requires an exact reading reference'});
    if(member.evidenceBasis==='case_field_reading'&&member.role!=='example')
      ctx.addIssue({code:'custom',path:['role'],message:'A coarse Case field reading may classify a descriptive example only'});
    if(member.evidenceBasis!=='case_field_reading'&&member.caseFieldReadingRef)
      ctx.addIssue({code:'custom',path:['caseFieldReadingRef'],message:'Field reading references require the explicit case_field_reading basis'});
  });
export const CollectionContentSchema = z.strictObject({ ...identity, question: text,
  members: z.array(CollectionMemberSchema).min(1).max(100),
  exclusions: texts, samplingFrame: text, window: text.nullable(),
});
const ComparisonObservationSchema=z.strictObject({memberRef:VersionRefSchema,observation:text,citations:z.array(CitationSchema).max(100),
  evidenceBasis:z.enum(['media_observation','case_metadata','source_record','case_field_reading']).optional(),caseFactRefs:FactRefs.optional(),
  sourceRecordRefs:SourceRecordRefs.optional(),caseFieldReadingRef:CaseFieldReadingRefSchema.optional()}).superRefine((item,ctx)=>{
    if(item.evidenceBasis==='case_metadata'){
      if(!item.caseFactRefs)ctx.addIssue({code:'custom',path:['caseFactRefs'],message:'Metadata observation requires exact registered Case facts'});
      if(item.citations.length)ctx.addIssue({code:'custom',path:['citations'],message:'Case metadata is not a media citation'});
    } else if(item.evidenceBasis==='source_record'){
      if(!item.sourceRecordRefs)ctx.addIssue({code:'custom',path:['sourceRecordRefs'],message:'Source observation requires exact Case records'});
      if(item.caseFactRefs)ctx.addIssue({code:'custom',path:['caseFactRefs'],message:'Source records cannot mix with metadata facts'});
      if(item.citations.length)ctx.addIssue({code:'custom',path:['citations'],message:'Source record references do not establish media anchors'});
    } else if(item.evidenceBasis==='case_field_reading'){
      if(!item.caseFieldReadingRef)ctx.addIssue({code:'custom',path:['caseFieldReadingRef'],message:'Case field reading requires an exact reading reference'});
      if(item.caseFactRefs||item.sourceRecordRefs)
        ctx.addIssue({code:'custom',path:['caseFieldReadingRef'],message:'Case field reading cannot mix with other evidence bases'});
      if(item.citations.length)ctx.addIssue({code:'custom',path:['citations'],message:'A field reading is not a media citation'});
    } else {
      if(!item.citations.length)ctx.addIssue({code:'custom',path:['citations'],message:'Media observation requires at least one citation'});
      if(item.caseFactRefs)ctx.addIssue({code:'custom',path:['caseFactRefs'],message:'Case facts require the explicit metadata evidence basis'});
    }
    if(item.evidenceBasis!=='source_record'&&item.sourceRecordRefs)
      ctx.addIssue({code:'custom',path:['sourceRecordRefs'],message:'Source records require the explicit source_record evidence basis'});
    if(item.evidenceBasis!=='case_field_reading'&&item.caseFieldReadingRef)
      ctx.addIssue({code:'custom',path:['caseFieldReadingRef'],message:'Field reading references require the explicit case_field_reading basis'});
  });
export const ComparisonContentSchema = z.strictObject({ ...identity, collectionRef: VersionRefSchema,
  dimensions: z.array(z.strictObject({ name: text, observations: z.array(ComparisonObservationSchema).min(1).max(100) })).min(1).max(30),
  incomparable: texts, unresolved: texts,
  researchKind:z.literal('descriptive').optional(),
  crossCaseFindings:z.array(z.strictObject({text,memberRefs:z.array(VersionRefSchema).min(2).max(100)})).min(1).max(30).optional(),
  cognition:VideoTopicSynthesisMetadataValidator.optional(),
}).superRefine((comparison,ctx)=>{
  if(comparison.researchKind==='descriptive'&&!comparison.crossCaseFindings?.length)
    ctx.addIssue({code:'custom',path:['crossCaseFindings'],message:'Descriptive comparison requires cross-case findings'});
  if(!comparison.researchKind&&comparison.crossCaseFindings)
    ctx.addIssue({code:'custom',path:['researchKind'],message:'Cross-case findings require explicit descriptive research kind'});
  if(comparison.researchKind!=='descriptive'&&comparison.dimensions.some(dimension=>
    dimension.observations.some(observation=>observation.evidenceBasis==='case_field_reading')))
    ctx.addIssue({code:'custom',path:['researchKind'],message:'Case field reading basis requires a descriptive comparison'});
  for(const [dimensionIndex,dimension] of comparison.dimensions.entries())
    if(dimension.observations.some(observation=>observation.evidenceBasis==='case_metadata')&&dimension.name!=='可比范围')
      ctx.addIssue({code:'custom',path:['dimensions',dimensionIndex,'name'],message:'Case metadata is restricted to the comparability-boundary dimension'});
});
export const PatternContentSchema = z.strictObject({ ...identity, problem: text, mechanism: text, sequence: texts.min(1), requiredElements: texts.min(1), variableSlots: texts,
  applicability: texts.min(1), exclusions: texts, supportRefs: refs.min(1), counterexampleRefs: refs, prediction: text,
  evidenceLevel: z.enum(['single_case','repeated_observation','inconclusive']), citations,
});
export const WikiContentSchema = z.strictObject({ ...identity, question: text, claimRefs: refs, patternRefs: refs, relatedRefs: refs,
  comparisonContext:z.array(z.strictObject({ref:VersionRefSchema,rationale:text,countsAsIndependentSupport:z.literal(false)})).max(20).optional(),
  navigationOnly:z.literal(true).optional(),
  navigation:z.strictObject({total:z.int().nonnegative(),covered:z.int().nonnegative(),pending:z.int().nonnegative(),
    recentPages:z.array(z.strictObject({ref:VersionRefSchema,title:text})).max(3),omittedPages:z.int().nonnegative()}).optional(),
  dailyReportIds: z.array(IdSchema).max(50).optional(), decisionGuide:KnowledgeDecisionGuideSchema.optional(), disputes: texts, nextQuestions: texts,
  citations:z.array(CitationSchema).max(100) }).superRefine((wiki,context)=>{
    if(!wiki.navigationOnly&&!wiki.citations.length)context.addIssue({code:'custom',path:['citations'],message:'Synthesis Wiki requires evidence citations'});
    if(!wiki.navigationOnly&&wiki.navigation)context.addIssue({code:'custom',path:['navigation'],message:'Only navigation-only Wiki may carry navigation metadata'});
    if(wiki.navigationOnly&&(!wiki.navigation||wiki.citations.length||wiki.claimRefs.length||wiki.patternRefs.length||
      wiki.disputes.length||wiki.nextQuestions.length||wiki.dailyReportIds?.length||wiki.decisionGuide||wiki.comparisonContext?.length))
      context.addIssue({code:'custom',path:['navigationOnly'],message:'Navigation-only Wiki must have structured coverage and no independent claims'});
    const comparisonKeys=new Set<string>();
    for(const [index,item] of (wiki.comparisonContext??[]).entries()){
      const key=`${item.ref.objectId}@${item.ref.versionId}`;
      if(comparisonKeys.has(key))
        context.addIssue({code:'custom',path:['comparisonContext',index],message:'Comparison context requires a unique exact version'});
      comparisonKeys.add(key);
    }
    if(wiki.decisionGuide){
      const entries=[wiki.decisionGuide.judgment,...wiki.decisionGuide.applicableWhen,...wiki.decisionGuide.avoidWhen,
        ...wiki.decisionGuide.adaptationIdeas,...wiki.decisionGuide.validationPlan];
      for(const [index,entry] of entries.entries()){
        const marker=entry.match(/〔引证 ([1-9]\d*(?:、[1-9]\d*)*)〕$/);
        if(!marker||marker[1].split('、').some(value=>Number(value)>wiki.citations.length))
          context.addIssue({code:'custom',path:['decisionGuide',index],message:'Every guide entry needs an exact in-range citation marker'});
      }
    }
    if(wiki.navigation) {
      if(wiki.navigation.covered+wiki.navigation.pending!==wiki.navigation.total)
        context.addIssue({code:'custom',path:['navigation'],message:'Navigation coverage must reconcile to its frozen total'});
      if(JSON.stringify(wiki.relatedRefs)!==JSON.stringify(wiki.navigation.recentPages.map(page=>page.ref)))
        context.addIssue({code:'custom',path:['relatedRefs'],message:'Navigation links must be the exact recent research pages'});
    }
  });
export const CreativeKnowledgeTaskSchema: z.ZodType<CreativeKnowledgeTask> = z.strictObject({ productVersionRef: VersionRefSchema, platform:ContentPlatformSchema.optional(), purpose: text, goal: text, audience: text, market: text, language: text,
  production: texts, query: z.string().max(2000), tokenBudget: z.int().min(1).max(100000), maxItems: z.int().min(1).max(10) });
const selection = z.strictObject({ ref: VersionRefSchema, selected: z.boolean(), reason: text, sourceGroups: texts });
export const PackContentSchema = z.strictObject({ pack: ReferencePackVersionSchema, task: CreativeKnowledgeTaskSchema, decisions: z.array(selection).max(300), contextText: z.string().min(1).max(1_000_000), tokenCounter: text, knowledgeEpoch: z.int().min(0), explorationRefs: z.array(VersionRefSchema).max(200).optional() });
export const WikiCompilationBindingSchema=z.strictObject({spaceId:text,specificationId:text,specificationVersion:text,
  contentVersion:text,methodVersion:text,policyVersion:text,sourceRef:VersionRefSchema,sourceSha256:Sha256Schema});
export const CrossDomainWikiBindingSchema=z.strictObject({bindingKind:z.literal('cross_domain_wiki'),spaceId:z.literal('cross-domain'),
  specificationId:text,specificationVersion:text,contentVersion:text,methodVersion:text,policyVersion:text,
  questionRef:VersionRefSchema,readsetFingerprint:Sha256Schema,coverage:z.literal('bounded_per_space_200'),
  consistency:z.literal('per_space_reads_no_global_snapshot'),basis:z.array(z.strictObject({
    ref:VersionRefSchema,spaceId:text,revisionSha256:Sha256Schema,reason:text})).min(2).max(200)}).superRefine((binding,ctx)=>{
    if(new Set(binding.basis.map(item=>`${item.ref.objectId}/${item.ref.versionId}`)).size!==binding.basis.length)
      ctx.addIssue({code:'custom',path:['basis'],message:'Cross-domain basis revisions must be distinct'});
    if(new Set(binding.basis.map(item=>item.spaceId)).size<2)
      ctx.addIssue({code:'custom',path:['basis'],message:'Cross-domain synthesis requires two distinct spaces'});
  });
export const KnowledgeBindingSchema=z.union([WikiCompilationBindingSchema,CrossDomainWikiBindingSchema,WikiPageBindingSchema]);
const common = { ref: VersionRefSchema, projectId: ProjectIdSchema, title: text, scope: KnowledgeScopeSchema,
  binding:KnowledgeBindingSchema.optional(),
  dependencies: z.array(DependencySchema).max(500), sourceGroups: texts, body: z.string().max(1_000_000), artifactRef: ObjectRefSchema.nullable(), createdAt: TimestampSchema,
  analysisQuality: z.strictObject({ candidate: z.enum(['unreviewed','original_reviewed','revised_unverified','review_incomplete']), review: z.enum(['not_run','completed_no_findings','completed_with_findings','failed']) }).nullable() };
export const KnowledgeRevisionSchema: z.ZodType<KnowledgeRevision> = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('case'), content: CaseVersionSchema }),
  z.strictObject({ ...common, kind: z.literal('claim'), content: ClaimVersionSchema }),
  z.strictObject({ ...common, kind: z.literal('collection'), content: CollectionContentSchema }),
  z.strictObject({ ...common, kind: z.literal('comparison'), content: ComparisonContentSchema }),
  z.strictObject({ ...common, kind: z.literal('pattern'), content: PatternContentSchema }),
  z.strictObject({ ...common, kind: z.literal('wiki'), content: WikiContentSchema }),
  z.strictObject({ ...common, kind: z.literal('wiki_page'), content: WikiPageContentSchema,
    scope:WikiPageScopeSchema,binding:WikiPageBindingSchema }),
  z.strictObject({ ...common, kind: z.literal('reference_pack'), content: PackContentSchema }),
]).superRefine((rev, ctx) => {
  if(rev.kind==='wiki_page')return;
  if(!rev.scope.goalTags?.length)ctx.addIssue({code:'custom',path:['scope','goalTags'],message:'Historical knowledge requires goal tags'});
  const content = rev.kind === 'reference_pack' ? rev.content.pack : rev.content;
  if (content.projectId !== rev.projectId || content.ref.objectId !== rev.ref.objectId || content.ref.versionId !== rev.ref.versionId)
    ctx.addIssue({ code: 'custom', message: 'Revision and content identity differ' });
  if(rev.binding && 'bindingKind' in rev.binding && rev.binding.bindingKind==='wiki_page')
    ctx.addIssue({code:'custom',path:['binding'],message:'Wiki page binding requires a wiki_page revision'});
});
export const ProposeChangeSchema = z.strictObject({ projectId: ProjectIdSchema, requestKey: z.string().trim().min(1).max(200), purpose: text, proposer: text, rationale: text, methodVersion: text, cost: CostObservationSchema,
  publicationPermit:PublicationPermitSchema.nullable().optional(),
  baseHeads: z.array(z.strictObject({ objectId: IdSchema, versionId: IdSchema.nullable() })).min(1).max(100),
  changes: z.array(z.strictObject({ revision: KnowledgeRevisionSchema, effect: z.enum(['create','support','narrow','dispute','withdraw','correct']), explanation: text })).min(1).max(100),
});
export type ProposeChange = z.infer<typeof ProposeChangeSchema>;
export const ReviewInputSchema = z.strictObject({ projectId: ProjectIdSchema, changeSetId: IdSchema, contentHash: Sha256Schema, purpose: text });
export const RegisteredSourceSchema: z.ZodType<RegisteredSource> = z.strictObject({ ref: VersionRefSchema, projectId: ProjectIdSchema,
  kind: z.enum(['product_fact','platform_rule','business_record','client_statement','third_party_estimate','document_rule','experience_record']), productVersionRef: VersionRefSchema.nullable(), statement: text, citations,
  taskFeedback:z.strictObject({schemaVersion:z.literal('1.0'),certainty:z.literal('caller_reported'),status:z.literal('observed'),
    feedbackKind:z.enum(['owner_review','production','audience']),adoptionRequestKey:text,adoptionId:IdSchema,
    taskExternalId:text,taskSha256:Sha256Schema,draftSha256:Sha256Schema,feedbackId:IdSchema,feedbackKey:text,
    feedbackInputHash:Sha256Schema,feedbackSnapshotDigest:Sha256Schema,
    feedbackSnapshot:z.record(z.string(),z.unknown()),selectedKnowledgeRefs:z.array(VersionRefSchema).max(100)}).optional(),
  experience:z.strictObject({domain:z.enum(['technical_workflow','creative_production']),
    provenance:z.enum(['registered_run','synthetic_fixture']),quality:z.enum(['verified','revised_unverified','synthetic']),
    task:text,method:text,steps:z.array(z.strictObject({action:text,observation:text,condition:text.nullable()})).min(1).max(30),
    observedOutcome:text,outcomeStatus:z.enum(['complete','partial','failed']),
    conditions:texts,counterexamples:texts,unknowns:texts}).optional(),
  ruleScope: z.strictObject({
    platforms: z.array(z.string().trim().min(1).max(300).refine(value => value !== '*')).min(1).max(20),
    markets: z.array(z.string().trim().min(1).max(300)).min(1).max(50),
  }).optional(),
  sourceGroup: text, valid: z.boolean(), limitations: texts, reviewDueAt: TimestampSchema.nullable() }).superRefine((source,ctx)=>{
    if(source.taskFeedback&&source.kind!=='business_record')
      ctx.addIssue({code:'custom',path:['taskFeedback'],message:'Task feedback metadata requires a business record'});
    if(source.taskFeedback){
      const meta=source.taskFeedback,snapshot=meta.feedbackSnapshot;
      const {id:feedbackId,inputHash:feedbackInputHash,recordedAt,...feedbackInput}=snapshot;
      if(snapshot.id!==meta.feedbackId||snapshot.feedbackKey!==meta.feedbackKey||
        snapshot.inputHash!==meta.feedbackInputHash||digest(feedbackInput)!==meta.feedbackInputHash||
        snapshot.draftSha256!==meta.draftSha256||
        snapshot.kind!==meta.feedbackKind||snapshot.status!=='observed'||
        typeof snapshot.observation!=='string'||!snapshot.observation.trim()||
        snapshot.observation!==source.statement||typeof snapshot.observedAt!=='string'||
        !Number.isFinite(Date.parse(snapshot.observedAt))||digest(snapshot)!==meta.feedbackSnapshotDigest)
        ctx.addIssue({code:'custom',path:['taskFeedback','feedbackSnapshot'],
          message:'Exact observed feedback snapshot must match its identity, statement and digest'});
    }
    if((source.kind==='experience_record')!==Boolean(source.experience))
      ctx.addIssue({code:'custom',path:['experience'],message:'Experience structure requires an exact experience source'});
    if(source.kind!=='experience_record')return;
    if(source.experience?.provenance==='synthetic_fixture'&&source.experience.quality!=='synthetic'||
      source.experience?.provenance==='registered_run'&&source.experience.quality==='synthetic')
      ctx.addIssue({code:'custom',path:['experience','quality'],message:'Experience quality must match provenance'});
    if(!source.citations.some(c=>c.kind==='source'&&c.sourceRef.objectId===source.ref.objectId&&
      c.sourceRef.versionId===source.ref.versionId&&c.locator))
      ctx.addIssue({code:'custom',path:['citations'],message:'Experience needs a locator on its exact source version'});
  });
