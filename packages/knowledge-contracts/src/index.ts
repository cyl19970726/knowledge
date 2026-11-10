import { z } from 'zod';
import { IdSchema, ProjectIdSchema, Sha256Schema, TimestampSchema, VersionRefSchema } from '@commerce/contract-primitives';

/** Public API v1. Authenticated identity is supplied by the server, never accepted in DTO bodies. */
export const CONTRACT_VERSION = '1.0.0';
const Text = (max = 2000) => z.string().trim().min(1).max(max);
const List = <T extends z.ZodTypeAny>(item: T, max = 100) => z.array(item).max(max);
const Cursor = z.string().min(1).max(4096);
const Purpose = Text(100);
const SpaceId = Text(200);
const Int = (max: number) => z.int().min(0).max(max);
export const ScopeSchema = z.strictObject({ projectId: ProjectIdSchema, spaceId: SpaceId });
export type Scope = z.infer<typeof ScopeSchema>;
export const KnowledgeRefSchema = ScopeSchema.extend({
  domain: z.enum(['knowledge', 'source', 'analysis', 'evidence']),
  objectId: IdSchema, versionId: IdSchema, contentDigest: Sha256Schema.nullable(),
});
export type KnowledgeRef = z.infer<typeof KnowledgeRefSchema>;
/** Existing stored IDs are retained exactly. The extra fields are transport provenance, not new stored IDs. */
export const toVersionRef = (ref: KnowledgeRef): z.infer<typeof VersionRefSchema> =>
  VersionRefSchema.parse({ objectId: ref.objectId, versionId: ref.versionId });
export const fromVersionRef = (ref: z.infer<typeof VersionRefSchema>, scope: Scope, domain: KnowledgeRef['domain'], contentDigest: string | null): KnowledgeRef =>
  KnowledgeRefSchema.parse({ ...ref, ...scope, domain, contentDigest });
export const ProfileRefSchema = z.strictObject({ id: Text(100), version: Text(100), digest: Sha256Schema });
export const SourceGroupSchema = z.strictObject({ id: Text(200).nullable(), status: z.enum(['known','unknown']), authority: Text(200).nullable() });
export const AnchorSchema = z.strictObject({ kind: z.enum(['time_range','page','paragraph','record']), value: Text(500), resolved: z.boolean() });
export const SourceReadabilitySchema = z.strictObject({ metadataVisible: z.boolean(), contentReadable: z.boolean(), anchorResolved: z.boolean(), assurance: z.enum(['local_transaction','owner_lease','read_time_only','unknown']), reasons: List(Text(500), 30) });
export const ReadCoverageSchema = z.strictObject({ sourceRef: KnowledgeRefSchema, anchors: List(AnchorSchema, 100), byteCount: Int(10_000_000), coverage: z.enum(['full','partial','unknown']), exclusions: List(Text(500), 30), readAt: TimestampSchema, readerAuthority: Text(200), readProofId: Text(200).nullable() });
export const CoverageSchema = z.strictObject({ scopeDescription: Text(500), returned: Int(500), loaded: Int(100_000), hasMore: z.boolean(), nextCursor: Cursor.nullable(), completeness: z.enum(['complete','bounded','unknown']), omittedReasons: List(Text(500), 30), snapshot: z.strictObject({ publicationEpoch: Int(Number.MAX_SAFE_INTEGER).nullable(), perSpace: z.record(SpaceId, Int(Number.MAX_SAFE_INTEGER)).optional(), consistency: z.enum(['single_scope_snapshot','per_space_non_atomic']) }) });
export type Coverage = z.infer<typeof CoverageSchema>;
export const EmptyStateSchema = z.enum(['not_loaded','unclassified','content_version_unsupported','source_unreadable','no_matches_in_scope','restricted_for_purpose','partial_result']);
export const EnvelopeSchema = <T extends z.ZodTypeAny>(data: T) => z.strictObject({ contractVersion: z.literal(CONTRACT_VERSION), requestId: Text(200), effectiveScope: ScopeSchema, observedAt: TimestampSchema, data, warnings: List(Text(500), 30), coverage: CoverageSchema.optional(), readReceiptId: IdSchema.optional() });
export type Envelope<T> = { contractVersion: typeof CONTRACT_VERSION; requestId: string; effectiveScope: Scope; observedAt: string; data: T; warnings: string[]; coverage?: Coverage; readReceiptId?: string };
export const CommitStatusSchema = z.enum(['not_committed','committed','unknown']);
export const ApiErrorSchema = z.strictObject({ requestId: Text(200), code: Text(100), message: Text(1000), retryable: z.boolean(), commitStatus: CommitStatusSchema, operationId: IdSchema.optional() });
export type ApiError = z.infer<typeof ApiErrorSchema>;
export const KnowledgeStatusSchema = z.strictObject({ current: z.boolean(), currentRef: KnowledgeRefSchema.nullable(), published: z.boolean(), reviewDecision: Text(200).nullable(), policyVersion: Text(100).nullable(), validity: z.strictObject({ valid: z.boolean(), issues: List(Text(500), 30), checkedAt: TimestampSchema, reviewDueAt: TimestampSchema.nullable() }), purpose: z.strictObject({ requested: Purpose, admitted: z.boolean(), reasons: List(Text(500), 30) }), contentSupported: z.boolean(), historicalAt: TimestampSchema.nullable() });
export type KnowledgeStatus = z.infer<typeof KnowledgeStatusSchema>;
export const KnowledgeCitationSchema = z.strictObject({ref:KnowledgeRefSchema,locator:z.string().trim().min(1).max(2000).nullable(),supports:z.string().trim().min(1).max(100_000)});
export type KnowledgeCitation = z.infer<typeof KnowledgeCitationSchema>;
export const KnowledgeDocumentSchema = z.strictObject({ ref: KnowledgeRefSchema, title: Text(500), body: z.string().max(100_000), contentSchemaVersion: Text(100), profile: ProfileRefSchema, status: KnowledgeStatusSchema, conditions: List(Text(1000), 100), counterexamples: List(Text(1000), 100), unknowns: List(Text(1000), 100), nextQuestions: List(Text(1000), 100), sourceGroups: List(SourceGroupSchema, 100), inheritedBasis: List(KnowledgeRefSchema, 100), actualReadCoverage: List(ReadCoverageSchema, 100), citations:List(KnowledgeCitationSchema,100).optional() });
export type KnowledgeDocument = z.infer<typeof KnowledgeDocumentSchema>;
export const PageRequestSchema = z.strictObject({ limit: z.int().min(1).max(100), cursor: Cursor.optional() });
export const CapabilityRequestSchema = z.strictObject({ clientContractVersion: Text(100).optional() });
export const CapabilitiesSchema = z.strictObject({ permittedActions: List(Text(100), 100), purposes: List(Purpose, 100), profiles: List(ProfileRefSchema, 100), mode: z.enum(['ready','read_only']), contractVersion: z.literal(CONTRACT_VERSION), policyVersion: Text(100), limits: z.record(Text(100), Int(Number.MAX_SAFE_INTEGER)), recoveryScope: Sha256Schema.optional() });
export const QueryRequestSchema = PageRequestSchema.extend({ question: Text(2000), purpose: Purpose, profileIds: List(Text(100), 20).optional(), kinds: List(Text(100), 20).optional(), topics: List(Text(100), 20).optional(), retrievalMethod: z.enum(['wiki-lexical-v1','wiki-lexical-v2']).optional() });
export type QueryRequest = z.infer<typeof QueryRequestSchema>;
export const QueryResultSchema = z.strictObject({ items: List(KnowledgeDocumentSchema, 100), originalQuestion: Text(2000), retrieval: z.strictObject({ methodVersion: Text(100), terms: List(Text(100), 100), truncated: z.boolean() }), readReceiptId: IdSchema, readsetFingerprint: Sha256Schema, pageFingerprint: Sha256Schema, emptyState: EmptyStateSchema.nullable() });
export type QueryResult = z.infer<typeof QueryResultSchema>;
export const CatalogRequestSchema = PageRequestSchema.extend({ query: Text(2000).optional(), profileIds: List(Text(100), 20).optional(), kinds: z.array(z.literal('wiki_page')).min(1).max(1).optional(), purpose: Purpose });
export const CatalogResultSchema = z.strictObject({ readReceiptId: IdSchema, items: List(KnowledgeDocumentSchema, 100), emptyState: EmptyStateSchema.nullable() });
export const ExactReadSchema = z.strictObject({ ref: KnowledgeRefSchema, purpose: Purpose, anchor: AnchorSchema.optional(), asOf: TimestampSchema.optional() });
export const HistoryRequestSchema = PageRequestSchema.extend({ objectId: IdSchema, purpose: Purpose, asOf: TimestampSchema.optional() });
export const HistoryResultSchema = z.strictObject({ versions: List(z.strictObject({ ref: KnowledgeRefSchema, publishedAt: TimestampSchema.nullable(), reason: Text(1000) }), 100) });
export const CompareRequestSchema = z.strictObject({ before: KnowledgeRefSchema, after: KnowledgeRefSchema, purpose: Purpose });
export const CompareResultSchema = z.strictObject({ before: KnowledgeDocumentSchema, after: KnowledgeDocumentSchema, differences: List(z.strictObject({ field: Text(200), before: z.unknown(), after: z.unknown(), reason: Text(500).nullable() }), 500) });
export const RelationSchema = z.strictObject({ id: Text(200), relationVersion: Text(100), from: KnowledgeRefSchema, to: KnowledgeRefSchema, stance: z.enum(['supports','challenges','context','navigation']), critical: z.boolean(), targetStatementAnchor: AnchorSchema.nullable(), rationale: Text(1000).nullable(), conditions: List(Text(1000), 100), evidenceStatus: z.enum(['observed','untested','unknown']), sourceGroups: List(SourceGroupSchema, 100) });
export type Relation = z.infer<typeof RelationSchema>;
export const GraphRequestSchema = z.strictObject({ root: z.union([z.strictObject({ ref: KnowledgeRefSchema }),z.strictObject({ readReceiptId: IdSchema })]), purpose: Purpose, relationKinds: List(RelationSchema.shape.stance, 4), maxDepth: z.int().min(1).max(5), maxNodes: z.int().min(1).max(200), maxBytes: z.int().min(1).max(1_000_000), cursor: Cursor.optional(), asOf: TimestampSchema.optional() });
export type GraphRequest = z.infer<typeof GraphRequestSchema>;
export const ExternalGraphNodeSchema = z.strictObject({ ref: KnowledgeRefSchema, label: Text(500), availability: z.enum(['content_readable','metadata_only','unknown','owner_unconnected','unsupported','forbidden']) });
export const GraphResultSchema = z.strictObject({ nodes: List(KnowledgeDocumentSchema, 200), externalNodes: List(ExternalGraphNodeSchema, 200), edges: List(RelationSchema, 500) });
export type GraphResult = z.infer<typeof GraphResultSchema>;
export const ImpactRequestSchema = PageRequestSchema.extend({ ref: KnowledgeRefSchema, purpose: Purpose });
export const ImpactResultSchema = z.strictObject({ root: KnowledgeRefSchema, affected: List(KnowledgeRefSchema, 100), completeness: CoverageSchema.shape.completeness });
export const SourceUpsertSchema = z.strictObject({ externalIdentity: z.strictObject({ adapterId: Text(100), externalObjectId: Text(500), externalVersion: Text(200) }), existingObjectId: IdSchema.optional(), expectedSourceHead: IdSchema.nullable(), sourceSchemaVersion: Text(100), contentDigest: Sha256Schema, custody: z.discriminatedUnion('mode',[z.strictObject({ mode: z.literal('reference_only'), opaqueLocator: Text(2000) }),z.strictObject({ mode: z.literal('managed_copy'), text: z.string().min(1).max(100_000) })]), sourceKind: Text(100), author: Text(300).nullable(), publisher: Text(300).nullable(), acquirer: Text(300), publishedAt: TimestampSchema.nullable(), obtainedAt: TimestampSchema, assertionKind: z.enum(['source_claim','direct_observation','inference','caller_reported']), sourceGroups: List(SourceGroupSchema, 100), anchors: List(AnchorSchema, 100), actualCoverage: List(ReadCoverageSchema, 100), limitations: List(Text(1000), 100), rightsPolicyRef: Text(200) });
/** Attribution is stored evidence, not an inference from a title or source group. Never expose custody text or locator here. */
export const SourceProvenanceSchema = z.strictObject({
  externalIdentity: SourceUpsertSchema.shape.externalIdentity,
  author: SourceUpsertSchema.shape.author,
  publisher: SourceUpsertSchema.shape.publisher,
  acquirer: SourceUpsertSchema.shape.acquirer,
  obtainedAt: SourceUpsertSchema.shape.obtainedAt,
  publishedAt: SourceUpsertSchema.shape.publishedAt,
  custody: z.strictObject({mode:z.enum(['reference_only','managed_copy'])}),
  rightsPolicyRef: SourceUpsertSchema.shape.rightsPolicyRef,
});
export type SourceProvenance = z.infer<typeof SourceProvenanceSchema>;
/** Publication assurance is distinct from a successful read. An external read-time check is not a lease. */
export const SourceAccessProofSchema = z.strictObject({ ownerId: Text(200), sourceRef: KnowledgeRefSchema, digest: Sha256Schema, subject: Text(200), audience: Text(200), purpose: Purpose, ownerGeneration: Text(200), validUntil: TimestampSchema, assurance: z.enum(['local_transaction','owner_lease','read_time_only','unknown']) });
export type SourceAccessProof = z.infer<typeof SourceAccessProofSchema>;
export const SourceRecordSchema = z.strictObject({ ref: KnowledgeRefSchema, head: KnowledgeRefSchema.nullable(), sourceSchemaVersion: Text(100), sourceKind: Text(100), assertionKind: SourceUpsertSchema.shape.assertionKind, sourceGroups: List(SourceGroupSchema, 100), readability: SourceReadabilitySchema, actualCoverage: List(ReadCoverageSchema, 100), limitations: List(Text(1000), 100), supersedes: KnowledgeRefSchema.nullable(), receiptId: IdSchema, provenance:SourceProvenanceSchema.optional() });
export type SourceRecord = z.infer<typeof SourceRecordSchema>;
export const SourceMediaSchema = z.strictObject({ kind:z.literal('image'), mimeType:z.enum(['image/png','image/jpeg','image/webp']), base64:z.string().max(5_600_000), byteCount:Int(4_000_000), digest:Sha256Schema });
export const SourceOwnerRequestSchema = z.strictObject({scope:ScopeSchema,ref:KnowledgeRefSchema,purpose:Purpose,subjectId:Text(200),anchor:AnchorSchema.nullable().optional()});
/** Separate endpoint contract: old owners must not silently ignore a content limit. */
export const BoundedSourceOwnerRequestSchema = SourceOwnerRequestSchema.extend({maxBytes:Int(1_000_000)});
export const SourceContentSchema = z.strictObject({ ref: KnowledgeRefSchema, contentDigest: Sha256Schema, content: z.string().max(1_000_000), media:SourceMediaSchema.optional(), anchor: AnchorSchema.nullable(), actualCoverage: ReadCoverageSchema, readability: SourceReadabilitySchema });
export const ReceiptItemSchema = z.strictObject({ ref: KnowledgeRefSchema, revisionDigest: Sha256Schema, statusAtRead: KnowledgeStatusSchema, sourceGroups: List(SourceGroupSchema,100), title: Text(500), summary: z.string().max(2000) });
export const ReadReceiptSchema = z.strictObject({ id: IdSchema, requestDigest: Sha256Schema, request: z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('query'),payload:QueryRequestSchema}),z.strictObject({kind:z.literal('catalog'),payload:CatalogRequestSchema}),z.strictObject({kind:z.literal('exact'),payload:ExactReadSchema}),z.strictObject({kind:z.literal('history'),payload:HistoryRequestSchema})]), orderedItems: List(ReceiptItemSchema,100), readsetFingerprint: Sha256Schema, pageFingerprint: Sha256Schema, coverage: CoverageSchema, purpose: Purpose, policyVersion: Text(100), effectiveScope: ScopeSchema, principalId: Text(200), clientInstallationId: Text(200), actualReads: List(ReadCoverageSchema,100), createdAt: TimestampSchema, expiresAt: TimestampSchema });
export type ReadReceipt = z.infer<typeof ReadReceiptSchema>;
const KnownUnknownNumber = z.discriminatedUnion('state',[z.strictObject({state:z.literal('known'),value:Int(Number.MAX_SAFE_INTEGER)}),z.strictObject({state:z.literal('unknown'),reason:Text(500)})]);
export const CostSchema = z.strictObject({ modelCalls: KnownUnknownNumber, tokens: KnownUnknownNumber, money: z.discriminatedUnion('state',[z.strictObject({state:z.literal('known'),amount:z.number().finite().min(0),currency:z.string().regex(/^[A-Z]{3}$/),source:Text(200)}),z.strictObject({state:z.literal('unknown'),reason:Text(500)})]) });
export const BudgetSchema = z.strictObject({maxModelCalls:Int(1000),maxReadBytes:Int(10_000_000),deadline:TimestampSchema,maxMoney:z.strictObject({amount:z.number().finite().min(0),currency:z.string().regex(/^[A-Z]{3}$/)}).nullable()});
export const AskRequestSchema = z.strictObject({question:Text(2000),purpose:Purpose,limit:z.int().min(1).max(20),maxPages:z.int().min(1).max(5),includeSourceContent:z.boolean(),selectedRefs:List(KnowledgeRefSchema,5).optional(),budget:BudgetSchema}).superRefine((request,ctx)=>{
 const refs=request.selectedRefs??[];
 if(refs.some(ref=>ref.domain!=='knowledge'||ref.contentDigest===null))ctx.addIssue({code:'custom',path:['selectedRefs'],message:'Selected Wiki references require exact content digests'});
 if(new Set(refs.map(ref=>`${ref.objectId}/${ref.versionId}`)).size!==refs.length)ctx.addIssue({code:'custom',path:['selectedRefs'],message:'Selected exact versions must be distinct'});
});
export type AskRequest = z.infer<typeof AskRequestSchema>;
export const AskClaimSchema = z.strictObject({text:Text(5000),evidenceIds:z.array(Text(100)).min(1).max(20)}).superRefine((claim,ctx)=>{
  if(new Set(claim.evidenceIds).size!==claim.evidenceIds.length)
    ctx.addIssue({code:'custom',path:['evidenceIds'],message:'Claim evidence IDs must be distinct'});
});
export type AskClaim = z.infer<typeof AskClaimSchema>;
export const AskEvidenceReceiptSchema = z.strictObject({id:Text(100),kind:z.enum(['wiki_page','source_content']),ref:KnowledgeRefSchema,title:Text(500),locator:Text(2000).nullable(),conditions:List(Text(1000),100),counterexamples:List(Text(1000),100),unknowns:List(Text(1000),100),actualReadCoverage:List(ReadCoverageSchema,100),storageDigest:Sha256Schema.optional(),sourceGroups:List(SourceGroupSchema,100).optional(),wiki:z.strictObject({profile:ProfileRefSchema,identity:z.strictObject({key:Text(300),aliases:List(Text(300),100)})}).optional()});
export type AskEvidenceReceipt = z.infer<typeof AskEvidenceReceiptSchema>;
export const AskProviderAnswerSchema = z.strictObject({outcome:z.enum(['answered','needs_evidence','refused']),claims:List(AskClaimSchema,50),reason:Text(5000),gaps:List(Text(1000),100)}).superRefine((answer,ctx)=>{
  if(answer.outcome==='answered'&&answer.claims.length===0)ctx.addIssue({code:'custom',path:['claims'],message:'answered requires at least one cited claim'});
  if(answer.outcome!=='answered'&&answer.claims.length>0)ctx.addIssue({code:'custom',path:['claims'],message:'non-answered outcome cannot contain claims'});
});
export type AskProviderAnswer = z.infer<typeof AskProviderAnswerSchema>;
export const AskReadUsageSchema = z.strictObject({wikiPayloadBytes:Int(10_000_000),sourceContentBytes:Int(10_000_000),preparedInputBytes:Int(11_000_000),maxReadBytes:Int(10_000_000)});
export const AskResultSchema = z.strictObject({id:IdSchema,answerFingerprint:Sha256Schema.optional(),question:Text(2000),purpose:Purpose,state:z.enum(['reserved','running','answered','needs_evidence','refused','failed','outcome_unknown']),claims:List(AskClaimSchema,50),evidence:List(AskEvidenceReceiptSchema,100),excluded:List(z.strictObject({ref:KnowledgeRefSchema,reason:Text(1000)}),100),coverage:CoverageSchema,readsetFingerprint:Sha256Schema,cost:CostSchema,readUsage:AskReadUsageSchema.optional(),provider:z.strictObject({id:Text(100),modelRequested:Text(200),modelReturned:Text(200).nullable(),requestId:Text(200).nullable()}).nullable(),reason:Text(5000),gaps:List(Text(1000),100),createdAt:TimestampSchema,completedAt:TimestampSchema.nullable()}).superRefine((result,ctx)=>{
  if(result.state==='answered'&&result.claims.length===0)ctx.addIssue({code:'custom',path:['claims'],message:'answered requires at least one cited claim'});
  if(result.state!=='answered'&&result.claims.length>0)ctx.addIssue({code:'custom',path:['claims'],message:'non-answered state cannot contain claims'});
  const evidenceIds=new Set<string>();
  for(const [index,item] of result.evidence.entries()){
    if(evidenceIds.has(item.id))ctx.addIssue({code:'custom',path:['evidence',index,'id'],message:'Evidence IDs must be distinct'});
    evidenceIds.add(item.id);
    if(item.kind==='wiki_page'&&item.ref.domain!=='knowledge'||item.kind==='source_content'&&item.ref.domain==='knowledge')
      ctx.addIssue({code:'custom',path:['evidence',index,'ref','domain'],message:'Evidence kind and reference domain disagree'});
    if(item.ref.contentDigest===null)
      ctx.addIssue({code:'custom',path:['evidence',index,'ref','contentDigest'],message:'Evidence requires an exact content digest'});
  }
  for(const [claimIndex,claim] of result.claims.entries())for(const [refIndex,id] of claim.evidenceIds.entries())
    if(!evidenceIds.has(id))ctx.addIssue({code:'custom',path:['claims',claimIndex,'evidenceIds',refIndex],message:'Claim cites evidence outside the result readset'});
});
export type AskResult = z.infer<typeof AskResultSchema>;
export const AskLookupResultSchema = z.strictObject({state:z.enum(['committed','unknown']),answer:AskResultSchema.nullable()}).superRefine((result,ctx)=>{
  if((result.state==='committed')!==(result.answer!==null))
    ctx.addIssue({code:'custom',path:['answer'],message:'Only a committed lookup may carry an answer operation'});
});
export type AskLookupResult = z.infer<typeof AskLookupResultSchema>;
export const ResearchRequestSchema = z.strictObject({question:Text(2000),purpose:Purpose,sourceRefs:List(KnowledgeRefSchema,100),knowledgeRefs:List(KnowledgeRefSchema,100),readReceiptId:IdSchema.optional(),baseHeads:List(z.strictObject({objectId:IdSchema,versionId:IdSchema.nullable()}),100),budget:BudgetSchema,allowExternalAcquisition:z.literal(false),feedbackIds:List(IdSchema,100).optional()});
export const ExecutionStateSchema = z.enum(['queued','running','waiting_for_source','waiting_for_review','cancel_requested','succeeded','failed','cancelled','outcome_unknown']);
export const OperationSchema = z.strictObject({id:IdSchema,researchId:IdSchema.optional(),state:ExecutionStateSchema,inputDigest:Sha256Schema,commitStatus:CommitStatusSchema,statusUrl:Text(2000),attemptId:IdSchema.nullable(),reason:Text(1000).nullable(),cost:CostSchema});
export type Operation = z.infer<typeof OperationSchema>;
export const OperationLookupSchema = z.strictObject({operation:Text(100),key:Text(200),purpose:Purpose});
export const LookupResultSchema = z.strictObject({state:z.enum(['committed','definitively_not_committed','unknown']),operation:OperationSchema.nullable(),reservationState:Text(200).nullable()});
export const CognitiveOutcomeSchema = z.enum(['candidate','no_change','needs_evidence']);
export const PublicationSchema = z.strictObject({changeSetId:IdSchema,refs:List(KnowledgeRefSchema,100),epoch:Int(Number.MAX_SAFE_INTEGER),publishedAt:TimestampSchema});
export const ResearchResultSchema = z.strictObject({researchId:IdSchema,resultDigest:Sha256Schema,cognitiveOutcome:CognitiveOutcomeSchema,exactReadset:List(KnowledgeRefSchema,100),inheritedBasis:List(KnowledgeRefSchema,100),actualReadCoverage:List(ReadCoverageSchema,100),selected:List(z.strictObject({ref:KnowledgeRefSchema,reason:Text(1000)}),100),excluded:List(z.strictObject({ref:KnowledgeRefSchema,reason:Text(1000)}),100),reason:Text(5000),gaps:List(Text(1000),100),sourceNeeds:List(Text(1000),100),cost:CostSchema,reviewState:Text(100),reviewReceiptId:IdSchema.nullable(),candidateId:IdSchema.nullable(),publication:PublicationSchema.nullable()});
export const CancelRequestSchema = z.strictObject({reason:Text(1000)});
export const CancelReceiptSchema = z.strictObject({operationId:IdSchema,state:z.enum(['cancel_requested','cancelled','too_late']),publication:PublicationSchema.nullable()});
export const CandidateInputSchema = z.strictObject({purpose:Purpose,methodVersion:Text(100),baseHeads:List(z.strictObject({objectId:IdSchema,versionId:IdSchema.nullable()}),100),changes:List(z.strictObject({objectId:IdSchema,profile:ProfileRefSchema,body:Text(100_000),content:z.json(),dependencies:List(RelationSchema,100),citations:List(z.strictObject({ref:KnowledgeRefSchema,anchor:AnchorSchema}),100)}),100),rationale:Text(5000),contentDigest:Sha256Schema});
export const CandidateReceiptSchema = z.strictObject({candidateId:IdSchema,changeSetId:IdSchema,draftRefs:List(KnowledgeRefSchema,100),contentHash:Sha256Schema,published:z.literal(false)});
/** A bounded review projection of an immutable staged change set, never a second candidate store. */
export const CandidateViewSchema = z.strictObject({candidateId:IdSchema,contentHash:Sha256Schema,purpose:Purpose,
  proposer:Text(200),rationale:Text(5000),createdAt:TimestampSchema,
  state:z.enum(['waiting_for_review','cancelled','published','rejected','outcome_unknown']),reviewable:z.boolean().optional(),reviewIssues:List(Text(1000),100).optional(),canRequestReview:z.boolean().optional(),canDecideReview:z.boolean().optional(),reviewTicketId:IdSchema.nullable().optional(),
  exactReadset:List(KnowledgeRefSchema,100),changes:List(z.strictObject({ref:KnowledgeRefSchema,
    title:Text(500),body:z.string().max(100_000),profile:ProfileRefSchema,effect:Text(100).optional(),
    before:z.strictObject({ref:KnowledgeRefSchema,title:Text(500),body:z.string().max(100_000),conditions:List(Text(12000),50),counterexamples:List(Text(12000),50),unknowns:List(Text(12000),50)}).nullable().optional(),
    conditions:List(Text(1000),100),counterexamples:List(Text(1000),100),unknowns:List(Text(1000),100),
    nextQuestions:List(Text(1000),100),sourceGroups:List(SourceGroupSchema,100)}),100)});
export const ReviewTargetSchema = z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('candidate'),candidateId:IdSchema,contentHash:Sha256Schema}),z.strictObject({kind:z.literal('research_result'),researchId:IdSchema,resultDigest:Sha256Schema})]);
export const ReviewRequestSchema = z.strictObject({target:ReviewTargetSchema,purpose:Purpose});
export const ReviewerSchema = z.strictObject({principalId:Text(200),kind:z.enum(['human','agent','service','unspecified']),model:Text(200).nullable()});
/** reviewer appears once a ticket is finalized; kind and model come from the reviewer's server-side principal configuration. */
export const ReviewEscalationCategorySchema = z.enum(['private_person','legal_risk','source_conflict','low_confidence','other']);
/** A reviewer hands a ticket to a person instead of deciding it; the ticket stays pending. */
export const ReviewEscalationRequestSchema = z.strictObject({purpose:Purpose,categories:z.array(ReviewEscalationCategorySchema).min(1).max(5),note:Text(2000)});
export type ReviewEscalationRequest = z.infer<typeof ReviewEscalationRequestSchema>;
export const ReviewEscalationSchema = ReviewEscalationRequestSchema.omit({purpose:true}).extend({by:ReviewerSchema,at:TimestampSchema});
export const ReviewTicketSchema = z.strictObject({id:IdSchema,target:ReviewTargetSchema,status:Text(100),purpose:Purpose,reviewer:ReviewerSchema.optional(),escalation:ReviewEscalationSchema.optional()});
export const ReviewQueueRequestSchema = z.strictObject({purpose:Purpose,escalated:z.enum(['exclude','only','include']).default('exclude'),limit:z.int().min(1).max(50).default(20)});
export const ReviewQueueSchema = z.strictObject({items:List(ReviewTicketSchema,50)});
export const ReviewDecisionSchema = z.strictObject({expectedDigest:Sha256Schema,decision:z.enum(['approved_for_purpose','exploration_only','rejected']),reason:Text(5000),conditions:List(Text(1000),100),gaps:List(Text(1000),100)});
export const FinalizeReceiptSchema = z.strictObject({reviewReceiptId:IdSchema,target:ReviewTargetSchema,publication:PublicationSchema.nullable(),result:CognitiveOutcomeSchema.nullable()});
export const ExternalContextSchema = z.strictObject({adapterId:Text(100),externalId:Text(500),contextVersion:Text(200),inputDigest:Sha256Schema,authority:z.enum(['caller_reported','knowledge_internal']),description:Text(1000)});
export const UseInputSchema = z.strictObject({context:ExternalContextSchema,readReceiptId:IdSchema,purpose:Purpose,considered:List(z.strictObject({ref:KnowledgeRefSchema,decision:z.enum(['adopted','adapted','rejected','deferred']),reason:Text(1000),before:z.string().max(5000).nullable(),after:z.string().max(5000).nullable()}),100),gaps:List(Text(1000),100),cost:CostSchema});
export const UseRecordSchema = UseInputSchema.extend({id:IdSchema,snapshot:ReadReceiptSchema,eligibilityAtUse:List(z.strictObject({ref:KnowledgeRefSchema,status:KnowledgeStatusSchema}),100),createdAt:TimestampSchema});
export const FeedbackInputSchema = z.strictObject({purpose:Purpose,useId:IdSchema.nullable(),context:ExternalContextSchema,knowledgeRefs:List(KnowledgeRefSchema,100),feedbackKey:Text(200),status:z.enum(['observed','not_observed']),observedAt:TimestampSchema.nullable(),observation:z.string().max(5000).nullable(),rawQuotation:z.string().max(5000).nullable(),interpretation:z.string().max(5000).nullable(),recommendation:z.string().max(5000).nullable(),artifactDigest:Sha256Schema.nullable(),measurementScope:z.string().max(1000).nullable(),cost:CostSchema,gaps:List(Text(1000),100)}).superRefine((v,ctx)=>{if(v.status==='not_observed'&&(v.observedAt||v.observation||v.rawQuotation))ctx.addIssue({code:'custom',message:'not_observed cannot assert an observation'});if(v.status==='observed'&&(!v.observedAt||!v.observation))ctx.addIssue({code:'custom',message:'observed requires observedAt and observation'});});
export const FeedbackRecordSchema = FeedbackInputSchema.safeExtend({id:IdSchema,version:Text(100),digest:Sha256Schema,supersedes:IdSchema.nullable(),sourceRef:KnowledgeRefSchema.nullable(),maintenanceState:z.enum(['not_requested','queued','linked','resolved'])});
export const FeedbackSourceRequestSchema = z.strictObject({expectedFeedbackDigest:Sha256Schema,purpose:Purpose});
export const ChangesRequestSchema = PageRequestSchema.extend({after:Cursor.optional(),useId:IdSchema.optional(),feedbackId:IdSchema.optional(),purpose:Purpose});
export const ChangeItemSchema = z.strictObject({id:Text(200),kind:Text(100),before:KnowledgeRefSchema.nullable(),after:KnowledgeRefSchema.nullable(),reason:Text(2000),researchId:IdSchema.nullable(),reviewReceiptId:IdSchema.nullable(),cognitiveOutcome:CognitiveOutcomeSchema.nullable(),affected:List(KnowledgeRefSchema,100)});
export const ChangesResultSchema = z.strictObject({items:List(ChangeItemSchema,100)});
export type ResearchRequest = z.infer<typeof ResearchRequestSchema>;
export type ResearchResult = z.infer<typeof ResearchResultSchema>;
export type UseInput = z.infer<typeof UseInputSchema>;
export type FeedbackInput = z.infer<typeof FeedbackInputSchema>;
export type ChangeItem = z.infer<typeof ChangeItemSchema>;
export type CatalogRequest = z.infer<typeof CatalogRequestSchema>;
export type CatalogResult = z.infer<typeof CatalogResultSchema>;
export type HistoryRequest = z.infer<typeof HistoryRequestSchema>;
export type HistoryResult = z.infer<typeof HistoryResultSchema>;
export type CompareRequest = z.infer<typeof CompareRequestSchema>;
export type CompareResult = z.infer<typeof CompareResultSchema>;
export type SourceContent = z.infer<typeof SourceContentSchema>;
export type SourceUpsert = z.infer<typeof SourceUpsertSchema>;
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export type ProfileRef = z.infer<typeof ProfileRefSchema>;
export type ReviewTicket = z.infer<typeof ReviewTicketSchema>;
export type UseRecord = z.infer<typeof UseRecordSchema>;
export type FeedbackRecord = z.infer<typeof FeedbackRecordSchema>;
export type ChangesResult = z.infer<typeof ChangesResultSchema>;
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;
export type FinalizeReceipt = z.infer<typeof FinalizeReceiptSchema>;
export type CandidateReceipt = z.infer<typeof CandidateReceiptSchema>;
export type CandidateView = z.infer<typeof CandidateViewSchema>;

export const SourceRevokeSchema=z.strictObject({expectedGeneration:z.int().min(1),contentDigest:Sha256Schema.nullable()});
export type SourceRevoke=z.infer<typeof SourceRevokeSchema>;

export type ReadCoverage=z.infer<typeof ReadCoverageSchema>;
export type LookupResult=z.infer<typeof LookupResultSchema>;

/** Source intake preserves the owner's exact identity. It confers no publication authority. */
export const ExactSourceRefSchema = KnowledgeRefSchema.extend({domain:z.enum(['source','analysis','evidence']),contentDigest:Sha256Schema});
export const SourceEventRequestSchema = z.strictObject({adapterId:Text(100),eventKey:Text(200),producerSequence:Int(Number.MAX_SAFE_INTEGER),
  occurredAt:TimestampSchema,purpose:Purpose,sourceRef:ExactSourceRefSchema});
export type SourceEventRequest = z.infer<typeof SourceEventRequestSchema>;
export const SourceEventRecordSchema = z.strictObject({id:IdSchema,request:SourceEventRequestSchema,inputDigest:Sha256Schema,
  source:SourceRecordSchema,registeredAt:TimestampSchema,assurance:z.literal('read_time_only'),state:z.literal('registered')});
export type SourceEventRecord = z.infer<typeof SourceEventRecordSchema>;
/** Offsets are UTF-8 bytes in the exact source text, never character indices or inferred identities. */
export const EntityMentionProposalSchema = z.strictObject({entityType:Text(100),surface:z.string().min(1).max(1000),
  startByte:Int(1_000_000),endByte:Int(1_000_000)});
export const EntityMentionExtractionSchema = z.strictObject({methodVersion:Text(200),mentions:List(EntityMentionProposalSchema,100)});
export type EntityMentionExtraction = z.infer<typeof EntityMentionExtractionSchema>;
export const EntityMentionRecordSchema = EntityMentionProposalSchema.extend({id:IdSchema,sourceRef:ExactSourceRefSchema,
  resolution:z.literal('unresolved')});
export const EntityMentionBatchSchema = z.strictObject({id:IdSchema,sourceEventId:IdSchema,methodVersion:Text(200),inputDigest:Sha256Schema,
  sourceRef:ExactSourceRefSchema,sourceGroups:List(SourceGroupSchema,100),mentions:List(EntityMentionRecordSchema,100),
  actualReadCoverage:ReadCoverageSchema,semanticCoverage:z.literal('unknown'),provenance:z.literal('caller_proposed'),recordedAt:TimestampSchema});
export type EntityMentionBatch = z.infer<typeof EntityMentionBatchSchema>;

export const SourceEventLookupSchema = z.discriminatedUnion('state',[z.strictObject({state:z.literal('known'),event:SourceEventRecordSchema}),z.strictObject({state:z.literal('unknown'),event:z.null()})]);

const AnswerClaimSelectionSchema=z.array(z.int().min(0).max(49)).min(1).max(50).refine(values=>new Set(values).size===values.length,{message:'Claim indexes must be distinct'});
export const AnswerSeedSchema=z.strictObject({answerId:IdSchema,expectedAnswerFingerprint:Sha256Schema,claimIndexes:AnswerClaimSelectionSchema});
export type AnswerSeed=z.infer<typeof AnswerSeedSchema>;
export const AnswerOriginSchema=z.strictObject({answerId:IdSchema,answerFingerprint:Sha256Schema,claimIndexes:AnswerClaimSelectionSchema,question:Text(2000)});
export type AnswerOrigin=z.infer<typeof AnswerOriginSchema>;
export const AnswerResearchRequestSchema=z.strictObject({purpose:Purpose,expectedAnswerFingerprint:Sha256Schema,claimIndexes:AnswerClaimSelectionSchema,question:Text(2000),limit:z.int().min(1).max(100).describe('Maximum Wiki pages; all Wiki and source evidence together remain bounded by 100'),maxPages:z.int().min(1).max(5),budget:BudgetSchema});
export type AnswerResearchRequest=z.infer<typeof AnswerResearchRequestSchema>;

export const WikiCompileRequestSchema = z.strictObject({question:Text(2000),purpose:Purpose,sourceEventIds:List(IdSchema,20),selectedRefs:List(KnowledgeRefSchema,100).optional(),sourceRefs:List(KnowledgeRefSchema,100).optional(),answerSeed:AnswerSeedSchema.optional(),
  queries:z.array(Text(500)).min(1).max(5),judgmentIds:List(IdSchema,3).optional(),limit:z.int().min(1).max(100).describe('Maximum Wiki pages; all Wiki and source evidence together remain bounded by 100'),maxPages:z.int().min(1).max(5),budget:BudgetSchema}).superRefine((value,ctx)=>{
 const refs=value.selectedRefs??[],sources=value.sourceRefs??[];
 if(!value.sourceEventIds.length&&!refs.length&&!sources.length)ctx.addIssue({code:'custom',message:'Compilation needs exact sources or selected Wiki versions'});
 if(refs.some(ref=>ref.domain!=='knowledge'||ref.contentDigest===null))ctx.addIssue({code:'custom',path:['selectedRefs'],message:'Selected Wiki inputs need canonical digests'});
 if(new Set(refs.map(ref=>`${ref.objectId}/${ref.versionId}`)).size!==refs.length)ctx.addIssue({code:'custom',path:['selectedRefs'],message:'Selected Wiki versions must be distinct'});
 if(sources.some(ref=>ref.domain==='knowledge'||ref.contentDigest===null))ctx.addIssue({code:'custom',path:['sourceRefs'],message:'Exact source references require canonical digests'});
 if(new Set(sources.map(ref=>`${ref.domain}/${ref.objectId}/${ref.versionId}`)).size!==sources.length)ctx.addIssue({code:'custom',path:['sourceRefs'],message:'Exact source versions must be distinct'});
 if(value.sourceEventIds.length+refs.length+sources.length>100)ctx.addIssue({code:'custom',message:'Explicit compilation inputs exceed the evidence bound'});
});
export type WikiCompileRequest = z.infer<typeof WikiCompileRequestSchema>;
export const WikiDraftChangeSchema = z.strictObject({targetEvidenceId:Text(100).nullable(),profile:ProfileRefSchema,identityKey:Text(300),
  title:Text(500),summary:Text(12000),conditions:List(Text(1000),50),counterexamples:List(Text(1000),50),unknowns:List(Text(1000),50),
  nextQuestions:List(Text(1000),50),supportEvidenceIds:z.array(Text(100)).min(1).max(50),rationale:Text(3000)});
export type WikiDraftChange = z.infer<typeof WikiDraftChangeSchema>;
export const WikiCompileProposalSchema = z.strictObject({outcome:z.enum(['proposed','no_change','needs_evidence','refused']),drafts:List(WikiDraftChangeSchema,5),reason:Text(5000),gaps:List(Text(1000),100)}).superRefine((value,ctx)=>{
  if((value.outcome==='proposed')!==(value.drafts.length>0))ctx.addIssue({code:'custom',path:['drafts'],message:'Only a proposed outcome has nonempty drafts'});
});
export type WikiCompileProposal = z.infer<typeof WikiCompileProposalSchema>;
export const WikiCompileResultSchema = z.strictObject({id:IdSchema,answerOrigin:AnswerOriginSchema.optional(),question:Text(2000),purpose:Purpose,
  state:z.enum(['reserved','running','draft_ready','waiting_for_review','no_change','needs_evidence','refused','failed','outcome_unknown','published','rejected']),
  publication:PublicationSchema.nullable().optional(),reviewReceiptId:IdSchema.nullable().optional(),reviewDecision:z.enum(['approved_for_purpose','exploration_only','rejected']).optional(),
  drafts:List(WikiDraftChangeSchema,5),candidate:CandidateReceiptSchema.nullable(),
  stageStatus:z.enum(['not_requested','not_configured','blocked_source_assurance','staged']),stageIntent:z.strictObject({requestHash:Sha256Schema}).optional(),
  evidence:List(AskEvidenceReceiptSchema,100),excluded:List(z.strictObject({ref:KnowledgeRefSchema,reason:Text(1000)}),100),
  readUsage:AskReadUsageSchema,readsetFingerprint:Sha256Schema,coverage:CoverageSchema,cost:CostSchema,
  provider:z.strictObject({id:Text(100),modelRequested:Text(200),modelReturned:Text(200).nullable(),requestId:Text(200).nullable()}).nullable(),
  reason:Text(5000),gaps:List(Text(1000),100),createdAt:TimestampSchema,completedAt:TimestampSchema.nullable()});
export type WikiCompileResult = z.infer<typeof WikiCompileResultSchema>;
export const WikiCompileLookupSchema = z.discriminatedUnion('state',[z.strictObject({state:z.literal('known'),compilation:WikiCompileResultSchema}),z.strictObject({state:z.literal('unknown'),compilation:z.null()})]);

export const MaintenanceTriggerSchema=z.strictObject({stream:z.enum(['source_intake','knowledge','manual','periodic']),eventKey:Text(300),sequence:Int(Number.MAX_SAFE_INTEGER),ref:KnowledgeRefSchema.nullable(),sourceEventId:IdSchema.nullable()});
export const MaintenanceTaskRequestSchema=z.strictObject({kind:z.enum(['source_research','recompile','lint_page','relation_check']),subjectRef:KnowledgeRefSchema.nullable(),sourceEventIds:List(IdSchema,20),relatedRefs:List(KnowledgeRefSchema,50),reason:Text(3000),methodVersion:Text(100),rubricVersion:Text(100)});
export type MaintenanceTaskRequest=z.infer<typeof MaintenanceTaskRequestSchema>;
export type MaintenanceTrigger=z.infer<typeof MaintenanceTriggerSchema>;
export const MaintenanceOutcomeSchema=z.strictObject({state:z.enum(['completed','no_change','needs_evidence','waiting_for_review','failed','outcome_unknown','cancelled','superseded']),findingIds:List(IdSchema,100),compilationId:IdSchema.nullable(),judgmentId:IdSchema.nullable(),reason:Text(5000),cost:CostSchema});
export type MaintenanceOutcome=z.infer<typeof MaintenanceOutcomeSchema>;
export const MaintenanceTaskSchema=z.strictObject({id:IdSchema,request:MaintenanceTaskRequestSchema,trigger:MaintenanceTriggerSchema,inputDigest:Sha256Schema,
 state:z.enum(['queued','running','completed','no_change','needs_evidence','waiting_for_review','failed','outcome_unknown','cancelled','superseded']),attempts:Int(100),attemptId:IdSchema.nullable(),leaseToken:Int(Number.MAX_SAFE_INTEGER),cancelRequested:z.boolean(),dispatchState:z.enum(['not_dispatched','dispatch_prepared','response_recorded']),outcome:MaintenanceOutcomeSchema.nullable(),createdAt:TimestampSchema,updatedAt:TimestampSchema});
export type MaintenanceTask=z.infer<typeof MaintenanceTaskSchema>;
export const MaintenanceTaskPageSchema=z.strictObject({items:List(MaintenanceTaskSchema,100),hasMore:z.boolean(),nextCursor:Cursor.nullable()});
export const MaintenanceFindingSchema=z.strictObject({id:IdSchema,taskId:IdSchema.nullable(),kind:z.enum(['review_due','broken_link','orphan','invalid_critical_basis','missing_citation','duplicate_source_group','suspected_duplicate','semantic_relation','source_unavailable']),subjectRef:KnowledgeRefSchema,relatedRefs:List(KnowledgeRefSchema,50),reason:Text(3000),methodVersion:Text(100),status:z.enum(['open','superseded','resolved']),createdAt:TimestampSchema});
export type MaintenanceFinding=z.infer<typeof MaintenanceFindingSchema>;
export const LintPassRequestSchema=z.strictObject({cycleKey:Text(200),shard:z.int().min(0).max(255),shardCount:z.int().min(1).max(256),limit:z.int().min(1).max(100),methodVersion:Text(100)}).superRefine((v,ctx)=>{if(v.shard>=v.shardCount)ctx.addIssue({code:'custom',path:['shard'],message:'Shard must be below shardCount'});});
export type LintPassRequest=z.infer<typeof LintPassRequestSchema>;
export const LintPassSchema=z.strictObject({id:IdSchema,request:LintPassRequestSchema,scanned:Int(1_000_000),lastObjectId:IdSchema.nullable(),complete:z.boolean(),findingIds:List(IdSchema,1000),findingCount:Int(Number.MAX_SAFE_INTEGER).optional(),startEpoch:Int(Number.MAX_SAFE_INTEGER),observedEpoch:Int(Number.MAX_SAFE_INTEGER),consistency:z.literal('incremental_current_heads'),omittedReasons:List(Text(1000),100),updatedAt:TimestampSchema});
export type LintPass=z.infer<typeof LintPassSchema>;
/** Periodic discovery creates bounded tasks; no model runs during the metadata sweep. */
export const SemanticSweepRequestSchema=z.strictObject({cycleKey:Text(200),shard:z.int().min(0).max(255),shardCount:z.int().min(1).max(256),limit:z.int().min(1).max(100),maxTasksPerShard:z.int().min(1).max(10000),methodVersion:Text(100),rubricVersion:Text(100)}).superRefine((v,ctx)=>{if(v.shard>=v.shardCount)ctx.addIssue({code:'custom',path:['shard'],message:'Shard must be below shardCount'});});
export type SemanticSweepRequest=z.infer<typeof SemanticSweepRequestSchema>;
export const SemanticSweepSchema=z.strictObject({id:IdSchema,request:SemanticSweepRequestSchema,scanned:Int(1_000_000),lastObjectId:IdSchema.nullable(),complete:z.boolean(),limitReached:z.boolean(),taskIds:List(IdSchema,100),taskCount:Int(10000),skipped:Int(1_000_000),startEpoch:Int(Number.MAX_SAFE_INTEGER),observedEpoch:Int(Number.MAX_SAFE_INTEGER),consistency:z.literal('incremental_current_heads'),omittedReasons:List(Text(1000),100),updatedAt:TimestampSchema});
export type SemanticSweep=z.infer<typeof SemanticSweepSchema>;
export const SemanticSweepApiRequestSchema=SemanticSweepRequestSchema.safeExtend({purpose:Purpose});

export const DecisionQuestionSchema=z.discriminatedUnion('type',[
 z.strictObject({id:Text(100),type:z.literal('predicate'),instructions:Text(5000),yes:Text(2000).optional(),no:Text(2000).optional()}),
 z.strictObject({id:Text(100),type:z.literal('choice'),instructions:Text(5000),options:z.array(z.strictObject({value:Text(100),description:Text(2000)})).min(2).max(30)}),
 z.strictObject({id:Text(100),type:z.literal('score'),instructions:Text(5000),levels:z.array(z.strictObject({value:z.number().finite(),description:Text(2000)})).min(2).max(30)})]);
export type DecisionQuestion=z.infer<typeof DecisionQuestionSchema>;
export const DecisionAnswerSchema=z.strictObject({id:Text(100),type:z.enum(['predicate','choice','score']),state:z.enum(['answered','refused','insufficient_evidence','not_evaluated','provider_error']),value:z.union([z.string(),z.number().finite(),z.null()]),probability:z.number().min(0).max(1).nullable(),distribution:z.record(z.string(),z.number().min(0).max(1)).nullable(),confidence:z.number().min(0).max(1).nullable(),reason:Text(1000).nullable()});
export type DecisionAnswer=z.infer<typeof DecisionAnswerSchema>;
export const DecisionBatchResultSchema=z.strictObject({modelReturned:Text(200),answers:List(DecisionAnswerSchema,100),inputTokens:Int(Number.MAX_SAFE_INTEGER).nullable(),outputTokens:Int(Number.MAX_SAFE_INTEGER).nullable(),requestId:Text(200).nullable(),raw:z.json()});
export type DecisionBatchResult=z.infer<typeof DecisionBatchResultSchema>;

export const RelationJudgmentRequestSchema=z.strictObject({left:KnowledgeRefSchema,right:KnowledgeRefSchema,purpose:Purpose,rubricVersion:Text(100),questions:z.array(DecisionQuestionSchema).min(1).max(100),budget:BudgetSchema});
export type RelationJudgmentRequest=z.infer<typeof RelationJudgmentRequestSchema>;
export const RelationJudgmentSchema=z.strictObject({id:IdSchema,request:RelationJudgmentRequestSchema,state:z.enum(['reserved','running','answered','needs_evidence','refused','failed','outcome_unknown']),
 evidence:List(AskEvidenceReceiptSchema,2),readUsage:AskReadUsageSchema,inputFingerprint:Sha256Schema,batch:DecisionBatchResultSchema.nullable(),cost:CostSchema,
 provider:z.strictObject({id:Text(100),version:Text(100),modelRequested:Text(200),modelReturned:Text(200).nullable()}).nullable(),
 sourceRelation:z.enum(['same_original','declared_distinct_groups','unknown']),resolution:z.enum(['review','needs_evidence','not_related','unknown']),reason:Text(5000),createdAt:TimestampSchema,completedAt:TimestampSchema.nullable()});
export type RelationJudgment=z.infer<typeof RelationJudgmentSchema>;
export const RelationJudgmentLookupSchema=z.discriminatedUnion('state',[z.strictObject({state:z.literal('known'),judgment:RelationJudgmentSchema}),z.strictObject({state:z.literal('unknown'),judgment:z.null()})]);
export const MaintenanceCollectRequestSchema=z.strictObject({purpose:Purpose,methodVersion:Text(100),rubricVersion:Text(100),limit:z.int().min(1).max(500)});
export const MaintenanceCollectResultSchema=z.strictObject({taskIds:List(IdSchema,2000),sourceThrough:Int(Number.MAX_SAFE_INTEGER),knowledgeThrough:Int(Number.MAX_SAFE_INTEGER),hasMore:z.boolean(),skipped:Int(100000),createdCount:Int(Number.MAX_SAFE_INTEGER).optional(),omittedReasons:List(Text(1000),100).optional()});
export const MaintenanceFindingPageSchema=z.strictObject({items:List(MaintenanceFindingSchema,100),hasMore:z.boolean(),nextCursor:Cursor.nullable()});
export const LintRequestSchema=LintPassRequestSchema.safeExtend({purpose:Purpose});

export const SearchProjectionStatusSchema=z.strictObject({formatVersion:z.literal('wiki-bigram-v1'),ready:z.boolean(),complete:z.boolean(),lastObjectId:Text(200).nullable(),scanned:Int(Number.MAX_SAFE_INTEGER),blockedRows:Int(Number.MAX_SAFE_INTEGER),updatedAt:TimestampSchema});
export type SearchProjectionStatus=z.infer<typeof SearchProjectionStatusSchema>;
export const SearchProjectionBuildRequestSchema=z.strictObject({purpose:Purpose,limit:z.int().min(1).max(5000),restart:z.boolean()});

/** Planning emits research questions and exact proposed spans, never published knowledge. */
export const SourcePlanRequestSchema=z.strictObject({sourceEventId:IdSchema,purpose:Purpose,methodVersion:Text(100),budget:BudgetSchema});
export type SourcePlanRequest=z.infer<typeof SourcePlanRequestSchema>;
export const SourcePlanProposalSchema=z.strictObject({outcome:z.enum(['planned','needs_evidence','refused']),question:Text(2000).nullable(),queries:List(Text(500),5),mentions:List(EntityMentionProposalSchema,100),reason:Text(5000),gaps:List(Text(1000),100)}).superRefine((value,ctx)=>{
 if(value.outcome==='planned'&&(!value.question||!value.queries.length))ctx.addIssue({code:'custom',message:'Planned research needs a question and queries'});
 if(value.outcome!=='planned'&&(value.question!==null||value.queries.length||value.mentions.length))ctx.addIssue({code:'custom',message:'Non-planned outcomes cannot contain a research proposal'});
 if(new Set(value.queries).size!==value.queries.length)ctx.addIssue({code:'custom',message:'Research queries must be distinct'});
});
export type SourcePlanProposal=z.infer<typeof SourcePlanProposalSchema>;
export const SourcePlanResultSchema=z.strictObject({id:IdSchema,request:SourcePlanRequestSchema,state:z.enum(['reserved','running','planned','needs_evidence','refused','failed','outcome_unknown']),evidence:List(AskEvidenceReceiptSchema,1),proposal:SourcePlanProposalSchema.nullable(),provenance:z.literal('model_proposed'),readUsage:AskReadUsageSchema,inputFingerprint:Sha256Schema,cost:CostSchema,provider:z.strictObject({id:Text(100),version:Text(100),modelRequested:Text(200),modelReturned:Text(200).nullable(),requestId:Text(200).nullable()}).nullable(),raw:z.json().nullable(),reason:Text(5000),createdAt:TimestampSchema,completedAt:TimestampSchema.nullable()});
export type SourcePlanResult=z.infer<typeof SourcePlanResultSchema>;
export const SourcePlanLookupSchema=z.discriminatedUnion('state',[z.strictObject({state:z.literal('known'),plan:SourcePlanResultSchema}),z.strictObject({state:z.literal('unknown'),plan:z.null()})]);

export const CoordinationStepSchema=z.strictObject({kind:z.enum(['planning','discovery','judgment','compilation']),key:Text(200),request:z.json(),resultId:IdSchema.nullable(),state:z.enum(['planned','running','known','failed','outcome_unknown']),cost:CostSchema,readBytes:Int(10_000_000)});
export type CoordinationStep=z.infer<typeof CoordinationStepSchema>;
export const CoordinationRequestSchema=z.strictObject({taskId:IdSchema,taskInputDigest:Sha256Schema,purpose:Purpose,policyVersion:Text(100),sourceEventId:IdSchema.nullable(),subjectRef:KnowledgeRefSchema.optional(),budget:BudgetSchema});
export type CoordinationRequest=z.infer<typeof CoordinationRequestSchema>;
export const CoordinationRunSchema=z.strictObject({id:IdSchema,request:CoordinationRequestSchema,state:z.enum(['reserved','running','waiting_for_review','no_change','needs_evidence','refused','failed','outcome_unknown','completed','cancelled']),sourcePlanId:IdSchema.nullable(),compilationOutcome:z.enum(['published','rejected']).optional(),candidateRefs:List(KnowledgeRefSchema,5),discovery:z.strictObject({epoch:Int(Number.MAX_SAFE_INTEGER).nullable(),evidence:List(AskEvidenceReceiptSchema,5),hasMore:z.boolean(),question:Text(2000).optional(),queries:List(Text(500),5).optional()}).nullable().optional(),readAccounting:z.literal('acknowledged_steps').optional(),judgmentIds:List(IdSchema,3),compilationId:IdSchema.nullable(),steps:List(CoordinationStepSchema,8),cost:CostSchema,readBytes:Int(10_000_000),reason:Text(5000),gaps:List(Text(1000),100),createdAt:TimestampSchema,completedAt:TimestampSchema.nullable()});
export type CoordinationRun=z.infer<typeof CoordinationRunSchema>;

export type Budget=z.infer<typeof BudgetSchema>;
export type Cost=z.infer<typeof CostSchema>;

/** Generic budgeted model call for evaluation arms that must share the knowledge service's model, settings and spend ledger. */
export const ModelCallRequestSchema=z.strictObject({purpose:Purpose,label:Text(200),system:z.string().min(1).max(100_000),
  cachedPrefix:z.string().min(1).max(3_000_000).nullable(),prompt:z.string().min(1).max(200_000),
  maxOutputTokens:z.int().min(1024).max(128_000).nullable(),maxMoney:z.strictObject({amount:z.number().finite().positive(),currency:z.literal('USD')})});
export type ModelCallRequest=z.infer<typeof ModelCallRequestSchema>;
export const ModelCallResultSchema=z.strictObject({id:IdSchema,label:Text(200),requestDigest:Sha256Schema,
  outcome:z.enum(['completed','refused','truncated']),text:z.string().max(2_000_000),
  usage:z.strictObject({inputTokens:Int(Number.MAX_SAFE_INTEGER),outputTokens:Int(Number.MAX_SAFE_INTEGER),cacheCreationInputTokens:Int(Number.MAX_SAFE_INTEGER),cacheReadInputTokens:Int(Number.MAX_SAFE_INTEGER)}),
  cost:CostSchema,reservedMoney:z.strictObject({amount:z.number().finite().min(0),currency:z.literal('USD')}),
  provider:z.strictObject({id:Text(100),modelRequested:Text(200),modelReturned:Text(200).nullable(),requestId:Text(200).nullable(),effort:Text(20)}),
  createdAt:TimestampSchema});
export type ModelCallResult=z.infer<typeof ModelCallResultSchema>;
