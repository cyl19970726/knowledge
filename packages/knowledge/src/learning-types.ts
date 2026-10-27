import type { PoolClient } from 'pg';
import type { VersionRef } from '../../contracts/src/index.ts';
import type { KnowledgeRevision, RegisteredSource, WikiCompilationBinding } from './types.ts';
import type { WikiCompilationIdentity, WikiCompilationExecutionSnapshot } from './wiki-compilation-identity.ts';
import type { PublicationPermit } from './wiki-publication-authority.ts';

export type LearningSourceDomain = 'analysis' | 'source' | 'knowledge';
export interface LearningSourceRef { domain: LearningSourceDomain; ref: VersionRef; sourceGroup?: string | null }
export type TopicStatus = 'candidate' | 'confirmed' | 'retired';
export interface Topic {
  id: string; projectId: string; title: string; question: string; questionKey: string;
  status: TopicStatus; version: number; method: string; aliases: string[];
  createdAt: string; updatedAt: string;
}
export interface TopicRelation {
  id: string; projectId: string; kind: 'split' | 'merge'; fromTopicIds: string[];
  toTopicIds: string[]; oldRefs: VersionRef[]; newRefs: VersionRef[];
  reason: string; reviewer: string; createdAt: string;
}
export type MembershipState = 'candidate' | 'confirmed' | 'rejected' | 'unassigned';
export interface TopicMembership {
  id: string; projectId: string; source: LearningSourceRef; topicId: string | null;
  topicVersion: number | null; state: MembershipState; reason: string;
  methodVersion: string; version: number; createdAt: string; updatedAt: string;
}
export type LearningEventType = 'report' | 'adoption' | 'source' | 'vocabulary' | 'policy' | 'feedback' | 'due';
export interface LearningInputEvent {
  sequence: number; projectId: string; eventKey: string; type: LearningEventType;
  sources: LearningSourceRef[]; topicIds: string[]; requestedTopicIds: string[]; reason: string; createdAt: string;
}
export interface LearningManifest {
  sources: LearningSourceRef[]; decisionRefs?: VersionRef[]; vocabularyVersion?: string | null;
  relationRefs?: VersionRef[]; baseHeads: Array<{objectId:string;versionId:string|null}>;
  /** Event watermark observed while freezing inputs; later arrivals remain dirty. */
  throughSequence?: number;
  methodVersion: string; policyVersion: string; budget: Record<string, unknown>;
  /** Captured from trusted admission facts; old immutable manifests have no permit. */
  publicationPermit?: PublicationPermit | null;
  scope?: Record<string, unknown>; [key: string]: unknown;
}
/** Source-generic targeted compilation uses the existing immutable build ledger. */
export interface WikiExperienceManifest extends LearningManifest {
  manifestVersion: 'wiki-experience@1';
  /** The actual host-selected compilation spec, not an inherited legacy binding. */
  binding: WikiCompilationBinding;
  topic: Pick<Topic, 'id' | 'version' | 'question'>;
  sourceRecords: RegisteredSource[];
  targetRevisions: KnowledgeRevision[];
  /** Repair may compare an invalid current page; it cannot use it as live support. */
  oldValidity?: Array<{ref:VersionRef;valid:boolean;issues:string[]}>;
  /** Exact old dependency/citation checks frozen before a maintenance model call. */
  oldBasisValidity?: Array<{targetRef:VersionRef;basisId:string;valid:boolean;issues:string[]}>;
  maintenanceFindingFingerprint?: string;
  /** Actual agent route captured at admission; each physical reservation must match it. */
  modelRoute?: {builder:{model:string;effort:string};reviewer:{model:string;effort:string}};
  identity: WikiCompilationIdentity;
  executionSnapshot: WikiCompilationExecutionSnapshot;
  intent: string;
  purpose: string;
  budget: { maxModelCalls: number; [key: string]: unknown };
  /** A zero-model host continuation of a restricted, independently reviewed run. */
  reconciliation?: {parentBuildId:string;parentManifestHash:string;workflowRunId:string;
    workflowInputFingerprint:string;reviewedOutputDigest:string};
}
export type BuildOutcome = 'changed' | 'no_change' | 'restricted' | 'failed' | 'proposed';
export interface BuildRecord {
  id: string; projectId: string; topicId: string; manifestHash: string;
  manifest: LearningManifest; throughSequence: number; reason: string;
  jobId: string | null; outcome: BuildOutcome | null; outcomeReason: string | null;
  recovery: string | null; usage: Record<string, unknown> | null;
  cost: Record<string, unknown> | null; publishedRefs: VersionRef[];
  createdAt: string; finishedAt: string | null;
}
export interface ReportCoverage {
  ref:VersionRef;processingFingerprint:string;acceptedBuildId:string;publishedRef:VersionRef|null;acceptedAt:string;
}
export interface LearningPageInfo {total:number;hasMore:boolean;nextCursor:string|null}
export type LearningCategory = 'topics'|'pending'|'builds'|'needs'|'requests'|'memberships'|'unassigned';
export interface LearningSummaryMeta {truncatedFields?:string[]}
export type TopicSummary = Topic & LearningSummaryMeta;
export type TopicMembershipSummary = TopicMembership & LearningSummaryMeta;
export type BuildSummary = Omit<BuildRecord,'manifest'> & LearningSummaryMeta & {publishedRefCount?:number};
export type ResearchNeedSummary = Omit<ResearchNeed,'budget'|'resolutionSourceRefs'|'resolutionResultRefs'> & LearningSummaryMeta;
export type ResearchRequestSummary = Omit<ResearchRequest,'budget'|'inputRefs'> & LearningSummaryMeta;
export interface LearningOverview {schemaVersion:'1.0';topics:TopicSummary[];pending:LearningSnapshot['pending'];counts:Record<LearningCategory,number>;
  pageInfo:{topics:LearningPageInfo;pending:LearningPageInfo}}
export interface LearningItemsQuery {category:LearningCategory;limit?:number;cursor?:string|null;topicId?:string|null;source?:LearningSourceRef|null}
export interface LearningItemsPage {schemaVersion:'1.0';category:LearningCategory;items:Array<BuildSummary|ResearchNeed|ResearchRequest|TopicMembershipSummary|TopicSummary|LearningSnapshot['pending'][number]>;pageInfo:LearningPageInfo}
export type ResearchAction = 'collect' | 'analyze_segment' | 'verify_fact' | 'experiment';
export type ResearchNeedStatus = 'open' | 'assigned' | 'resolved' | 'insufficient' | 'withdrawn';
export interface ResearchNeed {
  id: string; projectId: string; topicId: string | null; subject: LearningSourceRef;
  problem: string; expectedEvidence: string; value: string; priority: number;
  action: ResearchAction; budget: Record<string, unknown>; status: ResearchNeedStatus;
  resolutionSourceRefs: LearningSourceRef[]; resolutionResultRefs: VersionRef[];
  reviewReason: string | null; createdAt: string; updatedAt: string;
}
export interface ResearchRequest {
  id: string; projectId: string; needId: string; jobId: string | null;
  action: ResearchAction; inputRefs: LearningSourceRef[]; budget: Record<string, unknown>;
  authorization: string; expectedResult: string; requestKey: string; createdAt: string;
}
export interface LearningSnapshot {
  schemaVersion: '1.0'; topics: Topic[]; memberships: TopicMembership[];
  unassigned: TopicMembership[]; needs: ResearchNeed[]; requests: ResearchRequest[];
  builds: BuildRecord[]; pending: Array<{topicId:string;latestSequence:number;processedSequence:number;count:number;oldestAt:string|null}>;
  pageInfo?:Record<'topics'|'memberships'|'unassigned'|'needs'|'requests'|'builds'|'pending',LearningPageInfo>;
}
export interface KnowledgeLearningStore {
  overview(projectId:string):Promise<LearningOverview>;
  listItems(projectId:string,query:LearningItemsQuery):Promise<LearningItemsPage>;
  getItem(projectId:string,category:Exclude<LearningCategory,'pending'>,id:string):Promise<BuildRecord|ResearchNeed|ResearchRequest|TopicMembership|Topic|null>;
  listTopics(projectId:string):Promise<Topic[]>;
  getTopic(projectId:string,topicId:string):Promise<Topic|null>;
  getNeed(projectId:string,needId:string):Promise<ResearchNeed|null>;
  getMembershipBySource(projectId:string,topicId:string,source:LearningSourceRef):Promise<TopicMembership|null>;
  listTopicMemberships(projectId:string,topicId:string,afterId?:string|null,limit?:number):Promise<TopicMembership[]>;
  pendingTopics(projectId:string):Promise<LearningSnapshot['pending']>;
  listTopicBuilds(projectId:string,topicId:string,after?:{throughSequence:number;id:string}|null,limit?:number):Promise<BuildRecord[]>;
  listRunBuilds(projectId:string,topicId:string,runId:string):Promise<BuildRecord[]>;
  latestAcceptedBatch(projectId:string,topicId:string):Promise<BuildRecord|null>;
  reportCoverage(projectId:string,topicId:string):Promise<ReportCoverage[]>;
  listUnfinishedBuilds(projectId:string,topicId:string,client?:Pick<PoolClient,'query'>):Promise<BuildRecord[]>;
  createTopic(input: {projectId:string;title:string;question:string;method:string;aliases?:string[];status?:TopicStatus;id?:string}): Promise<Topic>;
  setTopicStatus(projectId:string,topicId:string,status:TopicStatus,reason:string): Promise<Topic>;
  relateTopics(input: {projectId:string;kind:'split'|'merge';fromTopicIds:string[];toTopicIds:string[];oldRefs:VersionRef[];newRefs:VersionRef[];reason:string;reviewer:string;id?:string}): Promise<TopicRelation>;
  assignMembership(input: {projectId:string;source:LearningSourceRef;topicId:string|null;state:MembershipState;reason:string;methodVersion:string;id?:string;
    /** Navigation imports must not revise a human membership, including an explicit unassigned decision. */
    ifAbsent?:boolean}): Promise<TopicMembership>;
  registerInput(input: {projectId:string;eventKey:string;type:LearningEventType;sources?:LearningSourceRef[];topicIds?:string[];reason:string}): Promise<LearningInputEvent>;
  markDirty(input: {projectId:string;eventKey:string;type:LearningEventType;sources?:LearningSourceRef[];topicIds?:string[];reason:string}): Promise<LearningInputEvent>;
  prepareBuild(input: {projectId:string;topicId:string;manifest:LearningManifest;reason:string;jobId?:string|null},client?:Pick<PoolClient,'query'>): Promise<BuildRecord>;
  getBuild(projectId:string,buildId:string): Promise<BuildRecord|null>;
  attachBuildJob(projectId:string,buildId:string,jobId:string,client?:Pick<PoolClient,'query'>): Promise<BuildRecord>;
  assertInputs(projectId:string,input:{topicId:string;topicVersion:number;memberships:Array<{id:string;version:number}>;allowAdditionalMemberships?:boolean},client:Pick<PoolClient,'query'>):Promise<void>;
  acknowledgeCognitionInput(input:{projectId:string;topicId:string;throughSequence:number;topicVersion:number;
    memberships:Array<{id:string;version:number}>;allMemberships:Array<{id:string;version:number}>},client?:Pick<PoolClient,'query'>):Promise<void>;
  finishBuild(input: {projectId:string;buildId:string;outcome:BuildOutcome;reason:string;recovery?:string|null;usage?:Record<string,unknown>|null;cost?:Record<string,unknown>|null;publishedRefs?:VersionRef[];acknowledge?:boolean}, client?:Pick<PoolClient,'query'>): Promise<BuildRecord>;
  createNeed(input: Omit<ResearchNeed,'id'|'status'|'resolutionSourceRefs'|'resolutionResultRefs'|'reviewReason'|'createdAt'|'updatedAt'> & {id?:string}): Promise<ResearchNeed>;
  createRequest(input: Omit<ResearchRequest,'id'|'createdAt'> & {id?:string}): Promise<ResearchRequest>;
  resolveNeed(input: {projectId:string;needId:string;status:'resolved'|'insufficient'|'withdrawn';sourceRefs:LearningSourceRef[];resultRefs:VersionRef[];reviewReason:string}): Promise<ResearchNeed>;
  snapshot(projectId:string,limit?:number): Promise<LearningSnapshot>;
}
