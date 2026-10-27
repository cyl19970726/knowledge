import { z } from 'zod';
import {
  CONTRACT_VERSION, ScopeSchema, KnowledgeRefSchema, EnvelopeSchema, ApiErrorSchema,
  CapabilitiesSchema, ProfileRefSchema, QueryRequestSchema, QueryResultSchema, CatalogRequestSchema, CatalogResultSchema,
  KnowledgeDocumentSchema, GraphRequestSchema, GraphResultSchema, HistoryRequestSchema, HistoryResultSchema,
  CompareRequestSchema, CompareResultSchema, SourceRecordSchema, SourceContentSchema, SourceUpsertSchema,
  ReadReceiptSchema, SourceRevokeSchema, ImpactRequestSchema, ImpactResultSchema, ResearchRequestSchema, ResearchResultSchema,
  OperationSchema, OperationLookupSchema, LookupResultSchema, CancelRequestSchema, CancelReceiptSchema,
  CandidateInputSchema, CandidateReceiptSchema, CandidateViewSchema, ReviewRequestSchema, ReviewTicketSchema, ReviewDecisionSchema,
  FinalizeReceiptSchema, UseInputSchema, UseRecordSchema, FeedbackInputSchema, FeedbackRecordSchema,
  FeedbackSourceRequestSchema, ChangesRequestSchema, ChangesResultSchema,
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
    capabilities: (opts:ReadOptions={}) => request('GET','/capabilities',CapabilitiesSchema,undefined,opts),
    profiles: (opts:ReadOptions={}) => request('GET','/profiles',z.array(ProfileRefSchema).max(100),undefined,opts),
    query: (data:z.input<typeof QueryRequestSchema>,opts:ReadOptions={}) => request('POST','/query',QueryResultSchema,{schema:QueryRequestSchema,data},opts),
    catalog: (data:z.input<typeof CatalogRequestSchema>,opts:ReadOptions={}) => { const q=parseLocal(CatalogRequestSchema,data); return request('GET',`/catalog${queryString(q)}`,CatalogResultSchema,undefined,opts); },
    document: (ref:KnowledgeRef,purpose:string,opts:ReadOptions={}) => { const r=exactRef(ref,'knowledge'); if (!r.contentDigest) throw new KnowledgeClientError({code:'CLIENT_VALIDATION_ERROR',message:'Knowledge exact read requires contentDigest',commitStatus:'not_committed',retryable:false}); return request('GET',`/objects/${encode(r.objectId)}/versions/${encode(r.versionId)}${queryString({purpose:parseLocal(purposeSchema,purpose),digest:r.contentDigest})}`,KnowledgeDocumentSchema,undefined,opts).then(result=>{assertReturnedRef(r,result.data.ref);return result;}); },
    history: (data:z.input<typeof HistoryRequestSchema>,opts:ReadOptions={}) => { const q=parseLocal(HistoryRequestSchema,data); const {objectId,...params}=q; return request('GET',`/objects/${encode(objectId)}/history${queryString(params)}`,HistoryResultSchema,undefined,opts); },
    compare: (data:z.input<typeof CompareRequestSchema>,opts:ReadOptions={}) => request('POST','/compare',CompareResultSchema,{schema:CompareRequestSchema,data},opts),
    graph: (data:z.input<typeof GraphRequestSchema>,opts:ReadOptions={}) => request('POST','/graph',GraphResultSchema,{schema:GraphRequestSchema,data},opts),
    impact: (data:z.input<typeof ImpactRequestSchema>,opts:ReadOptions={}) => request('POST','/impact',ImpactResultSchema,{schema:ImpactRequestSchema,data},opts),
    source: (ref:KnowledgeRef,purpose:string,opts:ReadOptions={}) => { const r=exactSourceRef(ref); return request('GET',`/sources/${encode(r.objectId)}/versions/${encode(r.versionId)}${queryString({purpose:parseLocal(purposeSchema,purpose),domain:r.domain,digest:r.contentDigest})}`,SourceRecordSchema,undefined,opts).then(result=>{assertReturnedRef(r,result.data.ref);return result;}); },
    sourceContent: (ref:KnowledgeRef,purpose:string,anchor?:z.input<typeof SourceUpsertSchema.shape.anchors.element>,opts:ReadOptions={}) => { const r=exactSourceRef(ref); return request('GET',`/sources/${encode(r.objectId)}/versions/${encode(r.versionId)}/content${queryString({purpose:parseLocal(purposeSchema,purpose),domain:r.domain,digest:r.contentDigest,anchor:anchor?JSON.stringify(anchor):undefined})}`,SourceContentSchema,undefined,opts).then(result=>{assertReturnedRef(r,result.data.ref);return result;}); },
    receipt: (receiptId:string,opts:ReadOptions={}) => request('GET',`/receipts/${encode(parseLocal(idSchema,receiptId))}`,ReadReceiptSchema,undefined,opts),
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
