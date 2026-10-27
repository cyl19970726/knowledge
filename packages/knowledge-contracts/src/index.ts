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
export const CapabilitiesSchema = z.strictObject({ permittedActions: List(Text(100), 100), purposes: List(Purpose, 100), profiles: List(ProfileRefSchema, 100), mode: z.enum(['ready','read_only']), contractVersion: z.literal(CONTRACT_VERSION), policyVersion: Text(100), limits: z.record(Text(100), Int(Number.MAX_SAFE_INTEGER)) });
export const QueryRequestSchema = PageRequestSchema.extend({ question: Text(2000), purpose: Purpose, profileIds: List(Text(100), 20).optional(), kinds: List(Text(100), 20).optional(), topics: List(Text(100), 20).optional() });
export type QueryRequest = z.infer<typeof QueryRequestSchema>;
export const QueryResultSchema = z.strictObject({ items: List(KnowledgeDocumentSchema, 100), originalQuestion: Text(2000), retrieval: z.strictObject({ methodVersion: Text(100), terms: List(Text(100), 100), truncated: z.boolean() }), readReceiptId: IdSchema, readsetFingerprint: Sha256Schema, pageFingerprint: Sha256Schema, emptyState: EmptyStateSchema.nullable() });
export type QueryResult = z.infer<typeof QueryResultSchema>;
export const CatalogRequestSchema = PageRequestSchema.extend({ query: Text(2000).optional(), profileIds: List(Text(100), 20).optional(), purpose: Purpose });
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
export const SourceUpsertSchema = z.strictObject({ externalIdentity: z.strictObject({ adapterId: Text(100), externalObjectId: Text(500), externalVersion: Text(200) }), existingObjectId: IdSchema.optional(), expectedSourceHead: IdSchema.nullable(), sourceSchemaVersion: Text(100), contentDigest: Sha256Schema, custody: z.discriminatedUnion('mode',[z.strictObject({ mode: z.literal('reference_only'), opaqueLocator: Text(2000) }),z.strictObject({ mode: z.literal('managed_copy'), text: Text(100_000) })]), sourceKind: Text(100), author: Text(300).nullable(), publisher: Text(300).nullable(), acquirer: Text(300), publishedAt: TimestampSchema.nullable(), obtainedAt: TimestampSchema, assertionKind: z.enum(['source_claim','direct_observation','inference','caller_reported']), sourceGroups: List(SourceGroupSchema, 100), anchors: List(AnchorSchema, 100), actualCoverage: List(ReadCoverageSchema, 100), limitations: List(Text(1000), 100), rightsPolicyRef: Text(200) });
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
export const SourceContentSchema = z.strictObject({ ref: KnowledgeRefSchema, contentDigest: Sha256Schema, content: z.string().max(1_000_000), media:SourceMediaSchema.optional(), anchor: AnchorSchema.nullable(), actualCoverage: ReadCoverageSchema, readability: SourceReadabilitySchema });
export const ReceiptItemSchema = z.strictObject({ ref: KnowledgeRefSchema, revisionDigest: Sha256Schema, statusAtRead: KnowledgeStatusSchema, sourceGroups: List(SourceGroupSchema,100), title: Text(500), summary: z.string().max(2000) });
export const ReadReceiptSchema = z.strictObject({ id: IdSchema, requestDigest: Sha256Schema, request: z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('query'),payload:QueryRequestSchema}),z.strictObject({kind:z.literal('catalog'),payload:CatalogRequestSchema}),z.strictObject({kind:z.literal('exact'),payload:ExactReadSchema}),z.strictObject({kind:z.literal('history'),payload:HistoryRequestSchema})]), orderedItems: List(ReceiptItemSchema,100), readsetFingerprint: Sha256Schema, pageFingerprint: Sha256Schema, coverage: CoverageSchema, purpose: Purpose, policyVersion: Text(100), effectiveScope: ScopeSchema, principalId: Text(200), clientInstallationId: Text(200), actualReads: List(ReadCoverageSchema,100), createdAt: TimestampSchema, expiresAt: TimestampSchema });
export type ReadReceipt = z.infer<typeof ReadReceiptSchema>;
const KnownUnknownNumber = z.discriminatedUnion('state',[z.strictObject({state:z.literal('known'),value:Int(Number.MAX_SAFE_INTEGER)}),z.strictObject({state:z.literal('unknown'),reason:Text(500)})]);
export const CostSchema = z.strictObject({ modelCalls: KnownUnknownNumber, tokens: KnownUnknownNumber, money: z.discriminatedUnion('state',[z.strictObject({state:z.literal('known'),amount:z.number().finite().min(0),currency:z.string().regex(/^[A-Z]{3}$/),source:Text(200)}),z.strictObject({state:z.literal('unknown'),reason:Text(500)})]) });
export const BudgetSchema = z.strictObject({maxModelCalls:Int(1000),maxReadBytes:Int(10_000_000),deadline:TimestampSchema,maxMoney:z.strictObject({amount:z.number().finite().min(0),currency:z.string().regex(/^[A-Z]{3}$/)}).nullable()});
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
  state:z.enum(['waiting_for_review','cancelled','published','rejected','outcome_unknown']),
  exactReadset:List(KnowledgeRefSchema,100),changes:List(z.strictObject({ref:KnowledgeRefSchema,
    title:Text(500),body:z.string().max(100_000),profile:ProfileRefSchema,
    conditions:List(Text(1000),100),counterexamples:List(Text(1000),100),unknowns:List(Text(1000),100),
    nextQuestions:List(Text(1000),100),sourceGroups:List(SourceGroupSchema,100)}),100)});
export const ReviewTargetSchema = z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('candidate'),candidateId:IdSchema,contentHash:Sha256Schema}),z.strictObject({kind:z.literal('research_result'),researchId:IdSchema,resultDigest:Sha256Schema})]);
export const ReviewRequestSchema = z.strictObject({target:ReviewTargetSchema,purpose:Purpose});
export const ReviewTicketSchema = z.strictObject({id:IdSchema,target:ReviewTargetSchema,status:Text(100),purpose:Purpose});
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
