import { z } from 'zod';
import {
  CONTRACT_VERSION, ScopeSchema, KnowledgeRefSchema, EnvelopeSchema, ApiErrorSchema,
  CapabilitiesSchema, ProfileRefSchema, QueryRequestSchema, QueryResultSchema, AskRequestSchema, AskResultSchema, AskLookupResultSchema, CatalogRequestSchema, CatalogResultSchema,
  KnowledgeDocumentSchema, GraphRequestSchema, GraphResultSchema, HistoryRequestSchema, HistoryResultSchema,
  CompareRequestSchema, CompareResultSchema, SourceRecordSchema, SourceContentSchema, SourceUpsertSchema,
  ReadReceiptSchema, SourceRevokeSchema, ImpactRequestSchema, ImpactResultSchema, ResearchRequestSchema, ResearchResultSchema,
  OperationSchema, OperationLookupSchema, LookupResultSchema, CancelRequestSchema, CancelReceiptSchema,
  CandidateInputSchema, CandidateReceiptSchema, CandidateViewSchema, ReviewRequestSchema, ReviewTicketSchema, ReviewDecisionSchema,
  FinalizeReceiptSchema, UseInputSchema, UseRecordSchema, FeedbackInputSchema, FeedbackRecordSchema,
  FeedbackSourceRequestSchema, ChangesRequestSchema, ChangesResultSchema, SourceEventRequestSchema, SourceEventRecordSchema, SourceEventLookupSchema, EntityMentionExtractionSchema, EntityMentionBatchSchema, WikiCompileRequestSchema, WikiCompileResultSchema, WikiCompileLookupSchema, MaintenanceCollectRequestSchema, MaintenanceCollectResultSchema, LintRequestSchema, LintPassSchema, MaintenanceTaskSchema, MaintenanceTaskPageSchema, MaintenanceFindingPageSchema, RelationJudgmentRequestSchema, RelationJudgmentSchema, RelationJudgmentLookupSchema, SearchProjectionStatusSchema, SearchProjectionBuildRequestSchema, SourcePlanRequestSchema, SourcePlanResultSchema, SourcePlanLookupSchema, CoordinationRunSchema, SemanticSweepApiRequestSchema, SemanticSweepSchema, AnswerResearchRequestSchema,
  type Envelope, type Scope, type KnowledgeRef, type ApiError,
} from '@commerce/knowledge-contracts';

export class KnowledgeClientError extends Error {
  readonly code: string;
  readonly commitStatus: ApiError['commitStatus'];
  readonly operationId?: string;
  readonly requestId?: string;
  readonly httpStatus?: number;
  readonly retryable: boolean;
  constructor(error: Partial<ApiError> & { message: string; httpStatus?: number }) {
    super(error.message);
    this.name = 'KnowledgeClientError';
    this.code = error.code ?? 'TRANSPORT_ERROR';
    this.commitStatus = error.commitStatus ?? 'unknown';
    this.operationId = error.operationId;
    this.requestId = error.requestId;
    this.httpStatus = error.httpStatus;
    this.retryable = error.retryable ?? false;
  }
}
export interface KnowledgeClientOptions {
  /** Origin or prefix before /api/v1/projects. */
  baseUrl: string;
  scope: Scope;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
}
export interface ReadOptions { signal?: AbortSignal; purpose?: string }
export interface WriteOptions extends ReadOptions { idempotencyKey: string }
const keySchema = z.string().min(1).max(200);
const purposeSchema = z.string().trim().min(1).max(100);
const idSchema = z.uuid();
function parseLocal<T extends z.ZodTypeAny>(schema:T,value:unknown):z.infer<T>{
  try{return schema.parse(value);}catch(cause){
    if(cause instanceof z.ZodError)throw new KnowledgeClientError({code:'CLIENT_VALIDATION_ERROR',
      message:`Invalid request input: ${cause.message}`,commitStatus:'not_committed',retryable:false});
    throw cause;
  }
}
function encode(value: string): string { return encodeURIComponent(value); }
function queryString(values: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const item of value) params.append(key, String(item));
    else params.set(key, String(value));
  }
  const string = params.toString();
  return string ? `?${string}` : '';
}
export function createKnowledgeClient(options: KnowledgeClientOptions) {
  const scope = parseLocal(ScopeSchema,options.scope);
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== 'function') throw new TypeError('A fetch implementation is required');
  const prefix = options.baseUrl.replace(/\/$/, '');
  const root = `${prefix}/api/v1/projects/${encode(scope.projectId)}/spaces/${encode(scope.spaceId)}/knowledge`;
  async function request<T extends z.ZodTypeAny>(method: 'GET'|'POST', path: string, output: T, input?: {schema: z.ZodTypeAny; data: unknown}, opts: (ReadOptions & {idempotencyKey?: string}) = {}): Promise<Envelope<z.infer<T>>> {
    let data: unknown;
    if (input) data = parseLocal(input.schema,input.data);
    if (opts.idempotencyKey !== undefined) parseLocal(keySchema,opts.idempotencyKey);
    const mayCommit = method === 'POST' && opts.idempotencyKey !== undefined;
    let requestPath=path;
    if(opts.purpose!==undefined){
      const purpose=parseLocal(purposeSchema,opts.purpose),separator=path.indexOf('?');
      const params=new URLSearchParams(separator<0?'':path.slice(separator+1));
      const bodyPurpose=data&&typeof data==='object'&&'purpose' in data?data.purpose:undefined;
      if(params.has('purpose')&&params.get('purpose')!==purpose||bodyPurpose!==undefined&&bodyPurpose!==purpose)
        throw new KnowledgeClientError({code:'CLIENT_VALIDATION_ERROR',message:'Explicit purpose differs from request purpose',commitStatus:'not_committed',retryable:false});
      params.set('purpose',purpose);requestPath=`${separator<0?path:path.slice(0,separator)}?${params}`;
    }
    const headers = new Headers(typeof options.headers === 'function' ? await options.headers() : options.headers);
    headers.set('Accept', 'application/json');
    headers.set('X-Knowledge-Contract-Version', CONTRACT_VERSION);
    if (input) headers.set('Content-Type', 'application/json');
    if (opts.idempotencyKey) headers.set('Idempotency-Key', opts.idempotencyKey);
    let response: Response;
    try {
      response = await fetcher(`${root}${requestPath}`, {method, headers, body: input ? JSON.stringify(data) : undefined, signal: opts.signal});
    } catch (cause) {
      throw new KnowledgeClientError({code:'TRANSPORT_OUTCOME_UNKNOWN',message:`Request response unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,commitStatus:mayCommit ? 'unknown' : 'not_committed',retryable:method === 'GET'});
    }
    let body: unknown;
    try { body = await response.json(); }
    catch { throw new KnowledgeClientError({code:'MALFORMED_RESPONSE',message:'Response is not valid JSON',commitStatus:mayCommit ? 'unknown' : 'not_committed',httpStatus:response.status}); }
    if (!response.ok) {
      const error = ApiErrorSchema.safeParse(body);
      if (!error.success) throw new KnowledgeClientError({code:'MALFORMED_ERROR',message:'Server returned an invalid error envelope',commitStatus:mayCommit ? 'unknown' : 'not_committed',httpStatus:response.status});
      throw new KnowledgeClientError({...error.data,httpStatus:response.status});
    }
    const parsed = EnvelopeSchema(output).safeParse(body);
    if (!parsed.success) throw new KnowledgeClientError({code:'MALFORMED_RESPONSE',message:'Server response violates knowledge contract',commitStatus:mayCommit ? 'unknown' : 'not_committed',httpStatus:response.status});
    if (parsed.data.effectiveScope.projectId !== scope.projectId || parsed.data.effectiveScope.spaceId !== scope.spaceId) throw new KnowledgeClientError({code:'SCOPE_MISMATCH',message:'Response scope differs from requested scope',commitStatus:mayCommit ? 'unknown' : 'not_committed',httpStatus:response.status});
    return parsed.data as Envelope<z.infer<T>>;
  }
  function exactRef(ref: KnowledgeRef, domain: KnowledgeRef['domain']) {
    const value = parseLocal(KnowledgeRefSchema,ref);
    if (value.domain !== domain || value.projectId !== scope.projectId || value.spaceId !== scope.spaceId) throw new KnowledgeClientError({code:'CLIENT_VALIDATION_ERROR',message:'Exact ref domain or scope mismatch',commitStatus:'not_committed',retryable:false});
    return value;
  }
  function assertReturnedRef(requested: KnowledgeRef, returned: KnowledgeRef): void {
    if (requested.projectId !== returned.projectId || requested.spaceId !== returned.spaceId || requested.domain !== returned.domain || requested.objectId !== returned.objectId || requested.versionId !== returned.versionId || (requested.contentDigest !== null && requested.contentDigest !== returned.contentDigest)) {
      throw new KnowledgeClientError({code:'EXACT_REF_MISMATCH',message:'Exact read returned a different revision',commitStatus:'not_committed'});
    }
  }
  const post = <T extends z.ZodTypeAny>(path:string, output:T, schema:z.ZodTypeAny, data:unknown, opts:WriteOptions) => { parseLocal(keySchema,opts?.idempotencyKey); return request('POST',path,output,{schema,data},opts); };
  function exactSourceRef(ref:KnowledgeRef):KnowledgeRef {
    const parsed=parseLocal(KnowledgeRefSchema,ref);
    if(parsed.domain==='knowledge')throw new KnowledgeClientError({code:'CLIENT_VALIDATION_ERROR',message:'Use document() for knowledge refs',commitStatus:'not_committed'});
    return exactRef(parsed,parsed.domain);
  }
  return {
    scope,
    capabilities: (opts:ReadOptions & {includeRecoveryScope?:boolean}={}) => {
      const {includeRecoveryScope,...readOptions}=opts;
      return request('GET',includeRecoveryScope?'/capabilities?recovery=1':'/capabilities',CapabilitiesSchema,undefined,readOptions);
    },
    profiles: (opts:ReadOptions={}) => request('GET','/profiles',z.array(ProfileRefSchema).max(100),undefined,opts),
    query: (data:z.input<typeof QueryRequestSchema>,opts:ReadOptions={}) => request('POST','/query',QueryResultSchema,{schema:QueryRequestSchema,data},opts),
    ask: (data:z.input<typeof AskRequestSchema>,opts:WriteOptions) => post('/ask',AskResultSchema,AskRequestSchema,data,opts).catch(error=>{
      if(error instanceof KnowledgeClientError&&error.commitStatus==='unknown'&&error.retryable)
        throw new KnowledgeClientError({code:error.code,message:error.message,commitStatus:'unknown',retryable:false,
          operationId:error.operationId,requestId:error.requestId,httpStatus:error.httpStatus});
      throw error;
    }),
    answer: (id:string,purpose:string,opts:ReadOptions={}) => {
      const exactId=parseLocal(idSchema,id),exactPurpose=parseLocal(purposeSchema,purpose);
      return request('GET',`/answers/${encode(exactId)}${queryString({purpose:exactPurpose})}`,AskResultSchema,undefined,opts).then(result=>{
        if(result.data.id!==exactId||result.data.purpose!==exactPurpose)
          throw new KnowledgeClientError({code:'ANSWER_IDENTITY_MISMATCH',message:'Answer identity differs from requested identity',commitStatus:'not_committed',retryable:false});
        return result;
      });
    },
    lookupAnswer: (key:string,purpose:string,opts:ReadOptions={}) => {
      const exactKey=parseLocal(keySchema,key),exactPurpose=parseLocal(purposeSchema,purpose);
      return request('GET',`/answers/lookup${queryString({key:exactKey,purpose:exactPurpose})}`,AskLookupResultSchema,undefined,opts).then(result=>{
        if(result.data.answer&&result.data.answer.purpose!==exactPurpose)
          throw new KnowledgeClientError({code:'PURPOSE_MISMATCH',message:'Lookup answer purpose differs from requested purpose',commitStatus:'not_committed',retryable:false});
        return result;
      });
    },
    catalog: (data:z.input<typeof CatalogRequestSchema>,opts:ReadOptions={}) => { const q=parseLocal(CatalogRequestSchema,data); return request('GET',`/catalog${queryString(q)}`,CatalogResultSchema,undefined,opts); },
    document: (ref:KnowledgeRef,purpose:string,opts:ReadOptions={}) => { const r=exactRef(ref,'knowledge'); if (!r.contentDigest) throw new KnowledgeClientError({code:'CLIENT_VALIDATION_ERROR',message:'Knowledge exact read requires contentDigest',commitStatus:'not_committed',retryable:false}); return request('GET',`/objects/${encode(r.objectId)}/versions/${encode(r.versionId)}${queryString({purpose:parseLocal(purposeSchema,purpose),digest:r.contentDigest})}`,KnowledgeDocumentSchema,undefined,opts).then(result=>{assertReturnedRef(r,result.data.ref);return result;}); },
    history: (data:z.input<typeof HistoryRequestSchema>,opts:ReadOptions={}) => { const q=parseLocal(HistoryRequestSchema,data); const {objectId,...params}=q; return request('GET',`/objects/${encode(objectId)}/history${queryString(params)}`,HistoryResultSchema,undefined,opts); },
    compare: (data:z.input<typeof CompareRequestSchema>,opts:ReadOptions={}) => request('POST','/compare',CompareResultSchema,{schema:CompareRequestSchema,data},opts),
    graph: (data:z.input<typeof GraphRequestSchema>,opts:ReadOptions={}) => request('POST','/graph',GraphResultSchema,{schema:GraphRequestSchema,data},opts),
    impact: (data:z.input<typeof ImpactRequestSchema>,opts:ReadOptions={}) => request('POST','/impact',ImpactResultSchema,{schema:ImpactRequestSchema,data},opts),
    source: (ref:KnowledgeRef,purpose:string,opts:ReadOptions={}) => { const r=exactSourceRef(ref); return request('GET',`/sources/${encode(r.objectId)}/versions/${encode(r.versionId)}${queryString({purpose:parseLocal(purposeSchema,purpose),domain:r.domain,digest:r.contentDigest})}`,SourceRecordSchema,undefined,opts).then(result=>{assertReturnedRef(r,result.data.ref);return result;}); },
    sourceContent: (ref:KnowledgeRef,purpose:string,anchor?:z.input<typeof SourceUpsertSchema.shape.anchors.element>,opts:ReadOptions={}) => { const r=exactSourceRef(ref); return request('GET',`/sources/${encode(r.objectId)}/versions/${encode(r.versionId)}/content${queryString({purpose:parseLocal(purposeSchema,purpose),domain:r.domain,digest:r.contentDigest,anchor:anchor?JSON.stringify(anchor):undefined})}`,SourceContentSchema,undefined,opts).then(result=>{assertReturnedRef(r,result.data.ref);return result;}); },
    receipt: (receiptId:string,opts:ReadOptions={}) => request('GET',`/receipts/${encode(parseLocal(idSchema,receiptId))}`,ReadReceiptSchema,undefined,opts),
    searchProjectionStatus: (purpose:string,opts:ReadOptions={}) => request('GET',`/maintenance/search-index${queryString({purpose:parseLocal(purposeSchema,purpose)})}`,SearchProjectionStatusSchema.nullable(),undefined,opts),
    rebuildSearchProjection: (data:z.input<typeof SearchProjectionBuildRequestSchema>,opts:WriteOptions) => post('/maintenance/search-index',SearchProjectionStatusSchema,SearchProjectionBuildRequestSchema,data,opts),
    planSource: (data:z.input<typeof SourcePlanRequestSchema>,opts:WriteOptions) => post('/source-plans',SourcePlanResultSchema,SourcePlanRequestSchema,data,opts),
    sourcePlan: (id:string,purpose:string,opts:ReadOptions={}) => request('GET',`/source-plans/${encode(parseLocal(idSchema,id))}${queryString({purpose:parseLocal(purposeSchema,purpose)})}`,SourcePlanResultSchema,undefined,opts),
    sourcePlanLookup: (key:string,purpose:string,opts:ReadOptions={}) => request('GET',`/source-plans/lookup${queryString({key:parseLocal(keySchema,key),purpose:parseLocal(purposeSchema,purpose)})}`,SourcePlanLookupSchema,undefined,opts),
    coordinationRun: (id:string,purpose:string,opts:ReadOptions={}) => request('GET',`/coordination-runs/${encode(parseLocal(idSchema,id))}${queryString({purpose:parseLocal(purposeSchema,purpose)})}`,CoordinationRunSchema,undefined,opts),
    coordinationForTask: (taskId:string,purpose:string,opts:ReadOptions={}) => request('GET',`/coordination-runs/by-task/${encode(parseLocal(idSchema,taskId))}${queryString({purpose:parseLocal(purposeSchema,purpose)})}`,CoordinationRunSchema.nullable(),undefined,opts),
    runSemanticSweep: (data:z.input<typeof SemanticSweepApiRequestSchema>,opts:WriteOptions) => post('/maintenance/semantic-sweeps',SemanticSweepSchema,SemanticSweepApiRequestSchema,data,opts),
    semanticSweep: (id:string,purpose:string,opts:ReadOptions={}) => request('GET',`/maintenance/semantic-sweeps/${encode(parseLocal(idSchema,id))}${queryString({purpose:parseLocal(purposeSchema,purpose)})}`,SemanticSweepSchema,undefined,opts),
    processMaintenance: (purpose:string,opts:WriteOptions) => post('/maintenance/process-one',MaintenanceTaskSchema.nullable(),z.strictObject({purpose:purposeSchema}),{purpose},opts),
    collectMaintenance: (data:z.input<typeof MaintenanceCollectRequestSchema>,opts:WriteOptions) => post('/maintenance/collect',MaintenanceCollectResultSchema,MaintenanceCollectRequestSchema,data,opts),
    lintWiki: (data:z.input<typeof LintRequestSchema>,opts:WriteOptions) => post('/maintenance/lint',LintPassSchema,LintRequestSchema,data,opts),
    maintenanceTasks: (purpose:string,params:{limit?:number;cursor?:string}={},opts:ReadOptions={}) => request('GET',`/maintenance/tasks${queryString({purpose:parseLocal(purposeSchema,purpose),...params})}`,MaintenanceTaskPageSchema,undefined,opts),
    maintenanceTask: (id:string,purpose:string,opts:ReadOptions={}) => request('GET',`/maintenance/tasks/${encode(parseLocal(idSchema,id))}${queryString({purpose:parseLocal(purposeSchema,purpose)})}`,MaintenanceTaskSchema,undefined,opts),
    cancelMaintenance: (id:string,purpose:string,opts:WriteOptions) => post(`/maintenance/tasks/${encode(parseLocal(idSchema,id))}/cancel`,MaintenanceTaskSchema,z.strictObject({purpose:purposeSchema}),{purpose},opts),
    maintenanceFindings: (purpose:string,params:{limit?:number;cursor?:string;status?:'open'|'superseded'|'resolved'}={},opts:ReadOptions={}) => request('GET',`/maintenance/findings${queryString({purpose:parseLocal(purposeSchema,purpose),...params})}`,MaintenanceFindingPageSchema,undefined,opts),
    judgeRelation: (data:z.input<typeof RelationJudgmentRequestSchema>,opts:WriteOptions) => post('/judgments',RelationJudgmentSchema,RelationJudgmentRequestSchema,data,opts),
    judgment: (id:string,purpose:string,opts:ReadOptions={}) => request('GET',`/judgments/${encode(parseLocal(idSchema,id))}${queryString({purpose:parseLocal(purposeSchema,purpose)})}`,RelationJudgmentSchema,undefined,opts),
    judgmentLookup: (key:string,purpose:string,opts:ReadOptions={}) => request('GET',`/judgments/lookup${queryString({key:parseLocal(keySchema,key),purpose:parseLocal(purposeSchema,purpose)})}`,RelationJudgmentLookupSchema,undefined,opts),
    researchAnswer: (answerId:string,data:z.input<typeof AnswerResearchRequestSchema>,opts:WriteOptions) => post(`/answers/${encode(parseLocal(idSchema,answerId))}/research`,WikiCompileResultSchema,AnswerResearchRequestSchema,data,opts),
    compileWiki: (data:z.input<typeof WikiCompileRequestSchema>,opts:WriteOptions) => post('/compilations',WikiCompileResultSchema,WikiCompileRequestSchema,data,opts),
    compilation: (id:string,purpose:string,opts:ReadOptions={}) => request('GET',`/compilations/${encode(parseLocal(idSchema,id))}${queryString({purpose:parseLocal(purposeSchema,purpose)})}`,WikiCompileResultSchema,undefined,opts),
    compilationLookup: (key:string,purpose:string,opts:ReadOptions={}) => request('GET',`/compilations/lookup${queryString({key:parseLocal(keySchema,key),purpose:parseLocal(purposeSchema,purpose)})}`,WikiCompileLookupSchema,undefined,opts),
    registerSourceEvent: (data:z.input<typeof SourceEventRequestSchema>,opts:WriteOptions) => {
      const parsed=parseLocal(SourceEventRequestSchema,data);exactSourceRef(parsed.sourceRef);
      if(parsed.sourceRef.projectId!==scope.projectId||parsed.sourceRef.spaceId!==scope.spaceId||opts?.idempotencyKey!==parsed.eventKey)
        throw new KnowledgeClientError({code:'CLIENT_VALIDATION_ERROR',message:'Source event scope or original key differs',commitStatus:'not_committed'});
      return post('/source-events',SourceEventRecordSchema,SourceEventRequestSchema,parsed,opts).then(result=>{
        if(JSON.stringify(result.data.request)!==JSON.stringify(parsed)||JSON.stringify(result.data.source.ref)!==JSON.stringify(parsed.sourceRef))
          throw new KnowledgeClientError({code:'EXACT_EVENT_MISMATCH',message:'Source event response refers to different input',commitStatus:'unknown'});
        return result;
      });
    },
    sourceEventLookup: (adapterId:string,eventKey:string,purpose:string,opts:ReadOptions={}) => {
      const adapter=parseLocal(SourceEventRequestSchema.shape.adapterId,adapterId),key=parseLocal(SourceEventRequestSchema.shape.eventKey,eventKey),use=parseLocal(purposeSchema,purpose);
      return request('GET',`/source-events/lookup${queryString({adapterId:adapter,eventKey:key,purpose:use})}`,SourceEventLookupSchema,undefined,opts).then(result=>{
        if(result.data.state==='known'&&(result.data.event.request.adapterId!==adapter||result.data.event.request.eventKey!==key||result.data.event.request.purpose!==use||
          result.data.event.request.sourceRef.projectId!==scope.projectId||result.data.event.request.sourceRef.spaceId!==scope.spaceId))
          throw new KnowledgeClientError({code:'EXACT_EVENT_MISMATCH',message:'Source event lookup returned another event',commitStatus:'not_committed'});
        return result;
      });
    },
    sourceEvent: (id:string,purpose:string,opts:ReadOptions={}) => request('GET',`/source-events/${encode(parseLocal(idSchema,id))}${queryString({purpose:parseLocal(purposeSchema,purpose)})}`,SourceEventRecordSchema,undefined,opts),
    recordEntityMentions: (id:string,data:z.input<typeof EntityMentionExtractionSchema>,opts:WriteOptions) => {
      const input=parseLocal(EntityMentionExtractionSchema,data);
      if(opts?.idempotencyKey!==input.methodVersion)throw new KnowledgeClientError({code:'CLIENT_VALIDATION_ERROR',message:'Mention key must retain its method version',commitStatus:'not_committed'});
      return post(`/source-events/${encode(parseLocal(idSchema,id))}/mentions`,EntityMentionBatchSchema,EntityMentionExtractionSchema,input,opts);
    },
    entityMentions: (id:string,methodVersion:string,purpose:string,opts:ReadOptions={}) => request('GET',`/source-events/${encode(parseLocal(idSchema,id))}/mentions${queryString({methodVersion:parseLocal(EntityMentionExtractionSchema.shape.methodVersion,methodVersion),purpose:parseLocal(purposeSchema,purpose)})}`,EntityMentionBatchSchema.nullable(),undefined,opts),
    registerSource: (data:z.input<typeof SourceUpsertSchema>,opts:WriteOptions) => post('/sources',SourceRecordSchema,SourceUpsertSchema,data,opts),
    revokeSource: (ref:KnowledgeRef,data:z.input<typeof SourceRevokeSchema>,opts:WriteOptions) => {const r=exactRef(ref,'source');return post(`/sources/${encode(r.objectId)}/versions/${encode(r.versionId)}/revoke`,SourceRecordSchema,SourceRevokeSchema,data,opts);},
    research: (data:z.input<typeof ResearchRequestSchema>,opts:WriteOptions) => post('/research',OperationSchema,ResearchRequestSchema,data,opts),
    researchOperation: (researchId:string,opts:ReadOptions={}) => request('GET',`/research/${encode(parseLocal(idSchema,researchId))}`,OperationSchema,undefined,opts),
    researchResult: (researchId:string,opts:ReadOptions={}) => request('GET',`/research/${encode(parseLocal(idSchema,researchId))}/result`,ResearchResultSchema,undefined,opts),
    cancelResearch: (researchId:string,data:z.input<typeof CancelRequestSchema>,opts:WriteOptions) => post(`/research/${encode(parseLocal(idSchema,researchId))}/cancel`,CancelReceiptSchema,CancelRequestSchema,data,opts),
    operation: (operationId:string,purpose:string,opts:ReadOptions={}) => request('GET',`/operations/${encode(parseLocal(idSchema,operationId))}${queryString({purpose:parseLocal(purposeSchema,purpose)})}`,OperationSchema,undefined,opts),
    lookupOperation: (data:z.input<typeof OperationLookupSchema>,opts:ReadOptions={}) => {const q=parseLocal(OperationLookupSchema,data);return request('GET',`/operations/lookup${queryString(q)}`,LookupResultSchema,undefined,opts);},
    candidate: (data:z.input<typeof CandidateInputSchema>,opts:WriteOptions) => post('/candidates',CandidateReceiptSchema,CandidateInputSchema,data,opts),
    candidateView: (candidateId:string,purpose='exploration_reading',opts:ReadOptions={}) => request('GET',
      `/candidates/${encode(parseLocal(idSchema,candidateId))}${queryString({purpose:parseLocal(purposeSchema,purpose)})}`,CandidateViewSchema,undefined,opts),
    requestReview: (data:z.input<typeof ReviewRequestSchema>,opts:WriteOptions) => post('/review-requests',ReviewTicketSchema,ReviewRequestSchema,data,opts),
    reviewTicket: (reviewRequestId:string,opts:ReadOptions={}) => request('GET',`/review-requests/${encode(parseLocal(idSchema,reviewRequestId))}`,ReviewTicketSchema,undefined,opts),
    decideReview: (reviewRequestId:string,data:z.input<typeof ReviewDecisionSchema>,opts:WriteOptions) => post(`/review-requests/${encode(parseLocal(idSchema,reviewRequestId))}/decisions`,FinalizeReceiptSchema,ReviewDecisionSchema,data,opts),
    recordUse: (data:z.input<typeof UseInputSchema>,opts:WriteOptions) => post('/uses',UseRecordSchema,UseInputSchema,data,opts),
    use: (useId:string,purpose:string,opts:ReadOptions={}) => request('GET',`/uses/${encode(parseLocal(idSchema,useId))}${queryString({purpose:parseLocal(purposeSchema,purpose)})}`,UseRecordSchema,undefined,opts),
    recordFeedback: (data:z.input<typeof FeedbackInputSchema>,opts:WriteOptions) => post('/feedback',FeedbackRecordSchema,FeedbackInputSchema,data,opts),
    feedback: (feedbackId:string,purpose:string,opts:ReadOptions={}) => request('GET',`/feedback/${encode(parseLocal(idSchema,feedbackId))}${queryString({purpose:parseLocal(purposeSchema,purpose)})}`,FeedbackRecordSchema,undefined,opts),
    registerFeedbackSource: (feedbackId:string,data:z.input<typeof FeedbackSourceRequestSchema>,opts:WriteOptions) => post(`/feedback/${encode(parseLocal(idSchema,feedbackId))}/source-registration`,SourceRecordSchema,FeedbackSourceRequestSchema,data,opts),
    changes: (data:z.input<typeof ChangesRequestSchema>,opts:ReadOptions={}) => {const q=parseLocal(ChangesRequestSchema,data);return request('GET',`/changes${queryString(q)}`,ChangesResultSchema,undefined,opts);},
    feedbackResolutions: (feedbackId:string,data:z.input<typeof ChangesRequestSchema>,opts:ReadOptions={}) => {const q=parseLocal(ChangesRequestSchema,data);return request('GET',`/feedback/${encode(parseLocal(idSchema,feedbackId))}/resolutions${queryString(q)}`,ChangesResultSchema,undefined,opts);},
  };
}
export type KnowledgeClient = ReturnType<typeof createKnowledgeClient>;
