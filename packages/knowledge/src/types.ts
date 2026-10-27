import type { CaseFactRef } from './case-fact.ts';
import type { SourceRecordRef } from './source-record.ts';
import type { CaseFieldReadingRef } from './case-field-reading.ts';
import type { VideoTopicSynthesisMetadata } from './video-topic-synthesis-types.ts';
import type { PublicationPermit,PublicationScopeFacts,PublicationAuthorityScopeV1 } from './wiki-publication-authority.ts';
import type { AnalysisQuality, CaseVersion, ClaimVersion, Citation, ContentPlatform, CostObservation, EvidenceAnchor, KnowledgeDecisionGuide, MediaScope, ObjectRef, ReferencePackVersion, VersionRef } from '../../contracts/src/index.ts';

// Module-owned payloads. Existing public DTOs are composed, never copied.
export type KnowledgeKind = 'case' | 'claim' | 'collection' | 'comparison' | 'pattern' | 'wiki' | 'wiki_page' | 'reference_pack';
export type DependencyDomain = 'knowledge' | 'analysis' | 'context' | 'source' | 'evidence';
export interface Dependency {
  domain: DependencyDomain; ref: VersionRef; role: 'derived_from' | 'supports' | 'challenges' | 'uses'; critical: boolean;
  /** An exact requested use; absence does not confer access to every channel or second. */
  useScope?: { claimRef?: VersionRef; anchor?: EvidenceAnchor; channels: Array<'visual' | 'audio' | 'captions'>; mediaScope: MediaScope };
  rationale?: string; conditions?: string[]; citations?: Citation[]; purpose?: string; reviewRef?: VersionRef;
}
export interface Applicability {
  productVersionRefs: VersionRef[];
  /** Absent on immutable pre-platform versions: historical TikTok context only. */
  platforms?: ContentPlatform[];
  /** Exact target and reason for an exploratory cross-platform transfer. */
  platformTransfers?: Array<{to: Exclude<ContentPlatform,'unknown'>; rationale:string}>;
  markets: string[]; languages: string[]; audiences: string[]; goals: string[];
  requiredProduction: string[]; transferRationale: string | null;
}
export interface KnowledgeScope {
  applicability: Applicability; limitations: string[]; unknowns: string[]; goalTags?: Array<'platform_rules' | 'data_acquisition' | 'market_research' | 'yesnap_benchmark' | 'perseek_diagnosis' | 'video_business_actions' | 'testing_learning'>;
  reviewDueAt: string | null;
}
/** General page scope; the seven Perseek goal tags belong only to historical research objects. */
export type WikiPageScope = Omit<KnowledgeScope, 'goalTags'>;
export interface CollectionContent {
  ref: VersionRef; projectId: string; title: string; question: string;
  members: Array<{ ref: VersionRef; role: 'support' | 'counterexample' | 'incomparable' | 'example'; reason: string;
    evidenceBasis?:'media_observation'|'case_metadata'|'source_record'|'case_field_reading';caseFactRefs?:CaseFactRef[];
    sourceRecordRefs?:SourceRecordRef[];caseFieldReadingRef?:CaseFieldReadingRef }>;
  exclusions: string[]; samplingFrame: string; window: string | null;
}
export interface ComparisonContent {
  ref: VersionRef; projectId: string; title: string; collectionRef: VersionRef;
  dimensions: Array<{ name: string; observations: Array<{ memberRef: VersionRef; observation: string; citations: Citation[];
    evidenceBasis?:'media_observation'|'case_metadata'|'source_record'|'case_field_reading';caseFactRefs?:CaseFactRef[];
    sourceRecordRefs?:SourceRecordRef[];caseFieldReadingRef?:CaseFieldReadingRef }> }>;
  incomparable: string[]; unresolved: string[];
  researchKind?:'descriptive';
  crossCaseFindings?:Array<{text:string;memberRefs:VersionRef[]}>;
  cognition?: VideoTopicSynthesisMetadata;
}
export interface PatternContent {
  ref: VersionRef; projectId: string; title: string; problem: string; mechanism: string;
  sequence: string[]; requiredElements: string[]; variableSlots: string[];
  applicability: string[]; exclusions: string[]; supportRefs: VersionRef[]; counterexampleRefs: VersionRef[];
  prediction: string; evidenceLevel: 'single_case' | 'repeated_observation' | 'inconclusive';
  citations: Citation[];
}
export interface NavigationWikiMetadata {
  /** Exact reports in the frozen run, not the entire historical topic. */
  total:number;covered:number;pending:number;
  /** The bounded, current research-page window exposed by this index. */
  recentPages:Array<{ref:VersionRef;title:string}>;
  omittedPages:number;
}
export interface WikiContent {
  ref: VersionRef; projectId: string; title: string; question: string;
  claimRefs: VersionRef[]; patternRefs: VersionRef[]; relatedRefs: VersionRef[];
  comparisonContext?:Array<{ref:VersionRef;rationale:string;countsAsIndependentSupport:false}>;
  /** Deterministic index of exact reviewed pages; it asserts no new source claim. */
  navigationOnly?: true;
  navigation?: NavigationWikiMetadata;
  /** Immutable research-context IDs for navigation, never support dependencies. */
  dailyReportIds?: string[];
  /** Source-bound exploration judgment; adaptation ideas are original hypotheses. */
  decisionGuide?: KnowledgeDecisionGuide;
  disputes: string[]; nextQuestions: string[]; citations: Citation[];
}
export interface CreativeKnowledgeTask {
  productVersionRef: VersionRef; purpose: string; goal: string; audience: string;
  /** Absent on frozen legacy tasks: TikTok only. New tasks must state their target. */
  platform?: ContentPlatform;
  market: string; language: string; production: string[]; query: string;
  tokenBudget: number; maxItems: number;
}
export interface SelectionDecision { ref: VersionRef; selected: boolean; reason: string; sourceGroups: string[] }
export interface PackContent {
  pack: ReferencePackVersion; task: CreativeKnowledgeTask; decisions: SelectionDecision[];
  contextText: string; tokenCounter: string; knowledgeEpoch: number;
  /** Exact versions admitted only to an explicitly requested exploration reading. */
  explorationRefs?: VersionRef[];
}
export type RevisionData =
  | { kind: 'case'; content: CaseVersion }
  | { kind: 'claim'; content: ClaimVersion }
  | { kind: 'collection'; content: CollectionContent }
  | { kind: 'comparison'; content: ComparisonContent }
  | { kind: 'pattern'; content: PatternContent }
  | { kind: 'wiki'; content: WikiContent }
  | { kind: 'wiki_page'; content: import('./wiki-page.ts').WikiPageContent }
  | { kind: 'reference_pack'; content: PackContent };
/** Optional on old immutable revisions; new domain methods freeze their actual selected contract here. */
export interface WikiCompilationBinding {
  spaceId:string;specificationId:string;specificationVersion:string;contentVersion:string;
  methodVersion:string;policyVersion:string;sourceRef:VersionRef;sourceSha256:string;
}
/** A derived Wiki cites exact knowledge versions, not an invented primary raw source. */
export interface CrossDomainWikiBinding {
  bindingKind:'cross_domain_wiki';spaceId:'cross-domain';specificationId:string;specificationVersion:string;
  contentVersion:string;methodVersion:string;policyVersion:string;questionRef:VersionRef;
  readsetFingerprint:string;coverage:'bounded_per_space_200';
  consistency:'per_space_reads_no_global_snapshot';
  basis:Array<{ref:VersionRef;spaceId:string;revisionSha256:string;reason:string}>;
}
export interface WikiPageBinding {
  bindingKind:'wiki_page';spaceId:string;specificationId:string;specificationVersion:string;
  contentVersion:'wiki_page/1.0';methodVersion:string;policyVersion:string;
  inputFingerprint:string;readsetFingerprint:string;profileFingerprint:string;
}
export type KnowledgeBinding=WikiCompilationBinding|CrossDomainWikiBinding|WikiPageBinding;
export type KnowledgeRevision = RevisionData & {
  ref: VersionRef; projectId: string; title: string; scope:KnowledgeScope;
  binding?:KnowledgeBinding;
  dependencies: Dependency[]; sourceGroups: string[]; body: string; artifactRef: ObjectRef | null;
  createdAt: string; analysisQuality: AnalysisQuality | null;
};
export type RevisionEffect = 'create' | 'support' | 'narrow' | 'dispute' | 'withdraw' | 'correct';
export interface KnowledgeChangeSet {
  id: string; projectId: string; requestKey: string; requestHash: string; contentHash: string; purpose: string;
  proposer: string; rationale: string; methodVersion: string; cost: CostObservation;
  /** Frozen at admission for protected publication scopes; absent on immutable legacy change sets. */
  publicationPermit?: PublicationPermit | null;
  baseHeads: Array<{ objectId: string; versionId: string | null }>;
  inputManifest: Dependency[];
  changes: Array<{ revision: KnowledgeRevision; effect: RevisionEffect; explanation: string }>;
  createdAt: string;
}
/** Audits the deterministic subset inspected by the semantic reviewer. */
export interface KnowledgeReviewInputReceipt {
  contractVersion:'topic-semantic-projection-v1';
  fullChangeContentHash:string|null;
  projectionHash:string;
  semanticRevisionRefs:VersionRef[];
  hostNavigationRevisionRefs:VersionRef[];
  relatedNavigation:Array<{caseRef:VersionRef;analysisResultRef:VersionRef}>;
  baseline?:{
    revisionRef:VersionRef;revisionHash:string;comparisonHash:string;
    removedRelatedNavigation:Array<{caseRef:VersionRef;analysisResultRef:VersionRef}>;
  };
}
export interface KnowledgeReview {
  id: string; projectId: string; changeSetId: string; contentHash: string;
  reviewer: string; policyVersion: string; purpose: string;
  decision: 'approved_for_purpose' | 'exploration_only' | 'rejected';
  rationale: string; createdAt: string;
  inputReceipt?:KnowledgeReviewInputReceipt;
}
export interface Publication { changeSetId: string; projectId: string; refs: VersionRef[]; epoch: number; publishedAt: string }
export interface Invalidity { domain: DependencyDomain; ref: VersionRef; reason: string; state: 'stale' | 'withdrawn' | 'review_due'; createdAt: string }
export interface Validity { valid: boolean; issues: Invalidity[] }
export interface RevisionView { revision: KnowledgeRevision; current: boolean; published: boolean; review: KnowledgeReview | null; validity: Validity;
  publishedAt?:string|null;
  searchMatch?:{methodVersion:'wiki-lexical-v1';matchedTerms:string[];score:number} }
export interface KnowledgeCatalogSummary {ref:VersionRef;kind:KnowledgeKind;title:string;summary:string;createdAt:string;reviewDecision:KnowledgeReview['decision']|null;reviewDueAt:string|null;reviewDue:boolean;withdrawn:boolean;invalidityRecorded:boolean}
export interface KnowledgeCatalogPage {schemaVersion:'1.0';items:KnowledgeCatalogSummary[];pageInfo:{total:number;hasMore:boolean;nextCursor:string|null}}
export interface KnowledgeImpactResult {schemaVersion:'1.0';basis:'authoritative_critical_dependencies';rootId:string;affectedIds:string[];criticalEdgeIds:string[];complete:boolean;completeness:'complete'|'unknown'|'truncated';limit:number}
export interface KnowledgeEvent { sequence: number; projectId: string; kind: string; data: Record<string, unknown>; occurredAt: string }
export interface KnowledgeStore {
  capturePublicationPermit(projectId:string,facts:PublicationScopeFacts,methodVersion:string):Promise<PublicationPermit|null>;
  setPublicationAuthorityScope(projectId:string,expectedGeneration:number|null,
    scope:Omit<PublicationAuthorityScopeV1,'generation'>):Promise<PublicationAuthorityScopeV1>;
  isPublicationScopeProtected(projectId:string,facts:PublicationScopeFacts):Promise<boolean>;
  stage(change: KnowledgeChangeSet): Promise<KnowledgeChangeSet>;
  getChangeSet(projectId: string, id: string): Promise<KnowledgeChangeSet | null>;
  getByRequestKey(projectId: string, requestKey: string): Promise<KnowledgeChangeSet | null>;
  recordReview(review: KnowledgeReview, client?: Pick<import('pg').PoolClient,'query'>): Promise<KnowledgeReview>;
  publish(projectId: string, changeSetId: string, contentHash: string, client?: Pick<import('pg').PoolClient,'query'>, expectedEpoch?: number): Promise<Publication>;
  get(projectId: string, ref: VersionRef): Promise<RevisionView | null>;
  getAsOf?(projectId:string,ref:VersionRef,cutoffAt:string):Promise<RevisionView|null>;
  head(projectId: string, objectId: string): Promise<VersionRef | null>;
  history(projectId: string, objectId: string): Promise<RevisionView[]>;
  search(projectId: string, options: { query?: string; kinds?: KnowledgeKind[]; sourceGroups?: string[]; platform?: ContentPlatform; spaceId?: string; limit?: number; offset?: number;
    lexical?:{methodVersion:'wiki-lexical-v1';terms:string[]} }): Promise<RevisionView[]>;
  catalog(projectId:string,options:{query?:string;kinds?:KnowledgeKind[];platform?:ContentPlatform;cursor?:string;limit?:number}):Promise<KnowledgeCatalogPage>;
  impact(projectId:string,rootId:string):Promise<KnowledgeImpactResult>;
  countCurrent(projectId:string):Promise<number>;
  validate(projectId: string, dependencies: Dependency[]): Promise<Validity>;
  invalidate(projectId: string, invalidity: Invalidity): Promise<VersionRef[]>;
  dependents(projectId: string, dependency: Pick<Dependency, 'domain' | 'ref'>): Promise<VersionRef[]>;
  epoch(projectId: string): Promise<number>;
  events(projectId: string, after: number, limit?: number): Promise<KnowledgeEvent[]>;
}
export interface ArtifactWritePort { writeArtifact(bytes: Uint8Array, mimeType: string, signal?: AbortSignal): Promise<ObjectRef> }
/** Owned and resolved by the source module; knowledge never writes a second source library. */
export interface RegisteredSource {
  ref: VersionRef; projectId: string;
  kind: 'product_fact' | 'platform_rule' | 'business_record' | 'client_statement' | 'third_party_estimate' | 'document_rule' | 'experience_record';
  productVersionRef: VersionRef | null; statement: string; citations: Citation[];
  /** Exact caller-reported task feedback; selected knowledge versions are lineage, not independent observations. */
  taskFeedback?: {schemaVersion:'1.0';certainty:'caller_reported';status:'observed';
    feedbackKind:'owner_review'|'production'|'audience';adoptionRequestKey:string;adoptionId:string;
    taskExternalId:string;taskSha256:string;draftSha256:string;feedbackId:string;feedbackKey:string;
    feedbackInputHash:string;feedbackSnapshotDigest:string;feedbackSnapshot:Record<string,unknown>;
    selectedKnowledgeRefs:VersionRef[]};
  /** Source-owned exact execution facts; semantic interpretation belongs to the compiler. */
  experience?: {
    domain:'technical_workflow'|'creative_production';
    provenance:'registered_run'|'synthetic_fixture';
    quality:'verified'|'revised_unverified'|'synthetic';
    task:string;method:string;steps:Array<{action:string;observation:string;condition:string|null}>;
    observedOutcome:string;outcomeStatus:'complete'|'partial'|'failed';
    conditions:string[];counterexamples:string[];unknowns:string[];
  };
  /** Trusted registration scope; absent on older research sources, never implicit creation permission. */
  ruleScope?: { platforms: string[]; markets: string[] };
  sourceGroup: string; valid: boolean; limitations: string[]; reviewDueAt: string | null;
}
export interface SourceReadPort { getSource(projectId: string, ref: VersionRef): Promise<RegisteredSource | null> }
export interface EvidenceReadPort { readEvidence(projectId: string, anchor: EvidenceAnchor, signal?: AbortSignal): Promise<{ anchor: EvidenceAnchor; text: string | null; objectRef: ObjectRef | null }> }
export interface TokenCounter { version: string; count(text: string): number }
export class KnowledgeError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); this.name = 'KnowledgeError'; }
}
