import {randomUUID} from 'node:crypto';
import {CostSchema,SourcePlanProposalSchema,SourcePlanRequestSchema,SourcePlanResultSchema,
  type SourcePlanRequest,type SourcePlanResult,type SourcePlanProposal,type SourceEventRecord,
  type SourceRecord,type KnowledgeRef} from '@commerce/knowledge-contracts';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {digest} from '@commerce/knowledge-core/utils';
import type {AskEvidence} from './ask.ts';
import type {KnowledgeApplication,ReadContext} from './index.ts';
import type {CapabilityContext} from './sources.ts';
import {authorizeCapability} from './sources.ts';
import type {createSourceIntakeApplication} from './source-intake.ts';
import {validateEntityMentionSpans} from './entity-mentions.ts';

export interface SourcePlanner {
  id:string;version:string;model:string;execution:'local_deterministic'|'external';supportsMoneyLimit?:boolean;
  plan(input:{operationId:string;source:AskEvidence;methodVersion:string;budget:SourcePlanRequest['budget'];signal:AbortSignal}):
    Promise<{proposal:SourcePlanProposal;raw:unknown;cost:SourcePlanResult['cost'];modelReturned:string|null;requestId:string|null}>;
}
export interface SourcePlanOperationPort {
  reserve(context:ReadContext,key:string,inputDigest:string,request:SourcePlanRequest,initial:SourcePlanResult):Promise<{created:boolean;result:SourcePlanResult}>;
  start(context:ReadContext,id:string):Promise<boolean>;
  checkpoint(context:ReadContext,id:string,result:SourcePlanResult):Promise<void>;
  finish(context:ReadContext,id:string,result:SourcePlanResult):Promise<void>;
  get(context:ReadContext,id:string):Promise<SourcePlanResult|null>;
  lookup(context:ReadContext,key:string):Promise<SourcePlanResult|null>;
}

const zero=():SourcePlanResult['cost']=>({modelCalls:{state:'known',value:0},tokens:{state:'known',value:0},
  money:{state:'known',amount:0,currency:'USD',source:'no_provider_call'}});
const pending=():SourcePlanResult['cost']=>({modelCalls:{state:'unknown',reason:'Source planning dispatch prepared'},
  tokens:{state:'unknown',reason:'Provider acknowledgement unavailable'},
  money:{state:'unknown',reason:'Reconcile the original planning operation before retrying'}});
const receipt=({body:_,...item}:AskEvidence)=>item;
const sameRef=(left:KnowledgeRef,right:KnowledgeRef)=>digest(left)===digest(right);
const commitUnknown=(error:unknown)=>error!==null&&typeof error==='object'&&'commitStatus'in error&&error.commitStatus==='unknown';
const rawWithoutSourceBody=(raw:unknown,body:string):SourcePlanResult['raw']=>{
  // Raw provider diagnostics may echo the input. Never persist the exact source body there.
  const serialized=JSON.stringify(raw);
  if(serialized===undefined)throw new KnowledgeError('SOURCE_PLAN_RAW_INVALID','Provider raw response must be JSON',422);
  if(Buffer.byteLength(serialized,'utf8')>1_000_000)throw new KnowledgeError('SOURCE_PLAN_RAW_LIMIT','Provider raw response exceeds one million bytes',422);
  const echoes=(value:unknown):boolean=>typeof value==='string'?value.includes(body):
    Array.isArray(value)?value.some(echoes):value!==null&&typeof value==='object'&&
      Object.entries(value).some(([key,item])=>key.includes(body)||echoes(item));
  return SourcePlanResultSchema.shape.raw.parse(body&&echoes(raw)?null:raw);
};

/** A bounded source read creates proposed questions and spans; it does not resolve entities or publish knowledge. */
export function createSourcePlanApplication(options:{
  reader:Pick<KnowledgeApplication,'sourceRecord'|'sourceContentBounded'>;
  intake:Pick<ReturnType<typeof createSourceIntakeApplication>,'get'>;
  operations:SourcePlanOperationPort;provider:SourcePlanner;now?:()=>Date;
  authorizeExternalDispatch?:(context:ReadContext,source:AskEvidence,provider:SourcePlanner)=>Promise<void>;
}){
  const now=()=>options.now?.()??new Date();
  function auth(context:CapabilityContext,action:string){
    authorizeCapability(context,action);
    if(!context.principal.clientInstallationId?.trim())
      throw new KnowledgeError('INSTALLATION_REQUIRED','Source planning requires an authenticated installation',403);
  }
  async function eventFor(context:CapabilityContext,request:SourcePlanRequest):Promise<SourceEventRecord>{
    const event=await options.intake.get(context,request.sourceEventId);
    if(event.id!==request.sourceEventId||!sameRef(event.source.ref,event.request.sourceRef)||
      event.request.purpose!==request.purpose||event.request.sourceRef.projectId!==context.scope.projectId||
      event.request.sourceRef.spaceId!==context.scope.spaceId)
      throw new KnowledgeError('SOURCE_PLAN_SCOPE_MISMATCH','Source event is outside the exact planning scope or purpose',403);
    return event;
  }
  async function current(context:ReadContext,event:SourceEventRecord,expectedGroups?:SourceRecord['sourceGroups']){
    const ref=event.request.sourceRef;
    const record=await options.reader.sourceRecord(context,ref);
    if(!sameRef(record.ref,ref)||!record.readability.metadataVisible||!record.readability.contentReadable)
      throw new KnowledgeError('SOURCE_FORBIDDEN','Exact source is no longer readable for this purpose',403);
    if(expectedGroups&&digest(record.sourceGroups)!==digest(expectedGroups))
      throw new KnowledgeError('SOURCE_READSET_CHANGED','Source lineage groups changed after planning input was frozen',409);
    return record;
  }
  async function validate(context:CapabilityContext,result:SourcePlanResult){
    const event=await eventFor(context,result.request);
    const record=await current(context,event,result.evidence[0]?.sourceGroups);
    if(result.evidence.length&&(!sameRef(result.evidence[0].ref,event.request.sourceRef)||
      digest(result.evidence[0].sourceGroups??[])!==digest(record.sourceGroups)))
      throw new KnowledgeError('SOURCE_READSET_CHANGED','Planning evidence differs from the exact source event',409);
  }
  async function get(context:CapabilityContext,id:string){
    auth(context,'source-plans:read');auth(context,'ingest:read');
    const result=await options.operations.get(context,id);
    if(!result)throw new KnowledgeError('NOT_FOUND','Source plan is unavailable',404);
    await validate(context,result);return result;
  }
  return {get,async lookup(context:CapabilityContext,key:string){
    auth(context,'source-plans:read');auth(context,'ingest:read');
    const result=await options.operations.lookup(context,key);
    return result?get(context,result.id):null;
  },async plan(context:CapabilityContext,input:unknown,key:string,parentSignal?:AbortSignal):Promise<SourcePlanResult>{
    auth(context,'source-plans:write');auth(context,'source-plans:read');auth(context,'ingest:read');
    if(parentSignal?.aborted)throw new KnowledgeError('SOURCE_PLAN_ABORTED','Source planning was cancelled before reservation',409);
    const request=SourcePlanRequestSchema.parse(input);
    if(request.purpose!==context.purpose)throw new KnowledgeError('PURPOSE_MISMATCH','Plan purpose differs from authenticated purpose',403);
    if(!key.trim()||key.length>200)throw new KnowledgeError('IDEMPOTENCY_KEY_REQUIRED','Bounded source plan key required',422);
    if(Date.parse(request.budget.deadline)-now().getTime()>300_000)
      throw new KnowledgeError('DEADLINE_TOO_LARGE','Planning deadline must be within five minutes',422);
    const provider={id:options.provider.id,version:options.provider.version,modelRequested:options.provider.model,
      modelReturned:null,requestId:null};
    const initial:SourcePlanResult={id:randomUUID(),request,state:'reserved',evidence:[],proposal:null,
      provenance:'model_proposed',readUsage:{wikiPayloadBytes:0,sourceContentBytes:0,preparedInputBytes:0,maxReadBytes:request.budget.maxReadBytes},
      inputFingerprint:digest([]),cost:zero(),provider:null,raw:null,reason:'Reserved; no provider invoked',
      createdAt:now().toISOString(),completedAt:null};
    const reserved=await options.operations.reserve(context,key,digest({request,provider}),request,SourcePlanResultSchema.parse(initial));
    if(!reserved.created)return get(context,reserved.result.id);
    const id=reserved.result.id;
    if(!await options.operations.start(context,id))return get(context,id);
    let result:SourcePlanResult={...reserved.result,state:'running'},invoked=false,acknowledged=false;
    let event:SourceEventRecord|null=null,record:SourceRecord|null=null,source:AskEvidence|null=null;
    let frozenGroups:SourceRecord['sourceGroups']=[];
    const check=()=>{if(parentSignal?.aborted)
      throw new KnowledgeError(invoked?'PROVIDER_OUTCOME_UNKNOWN':'SOURCE_PLAN_ABORTED',
        invoked?'Source planning was cancelled after provider dispatch; reconcile the original operation':
          'Source planning was cancelled before provider dispatch',invoked?504:409);
      if(Date.parse(request.budget.deadline)<=now().getTime())
      throw new KnowledgeError('DEADLINE_EXPIRED','Source planning deadline elapsed',422);};
    try{
      check();event=await eventFor(context,request);check();record=await current(context,event);check();
      const ref=event.request.sourceRef;
      if(!ref.contentDigest)throw new KnowledgeError('EXACT_DIGEST_REQUIRED','Source plan needs exact source digest',422);
      const content=await options.reader.sourceContentBounded(context,ref,null,
        Math.min(request.budget.maxReadBytes,1_000_000));
      check();
      if(!sameRef(content.ref,ref)||!content.readability.contentReadable||content.actualCoverage.coverage!=='full'||content.media)
        throw new KnowledgeError('SOURCE_PLAN_INCOMPLETE','Source planning needs complete exact text',422);
      const sourceBytes=Buffer.byteLength(content.content,'utf8');
      if(sourceBytes!==content.actualCoverage.byteCount||sourceBytes>request.budget.maxReadBytes)
        throw new KnowledgeError('SOURCE_READ_BUDGET_EXCEEDED','Source receipt exceeds the planning byte budget',422);
      frozenGroups=structuredClone(record.sourceGroups);
      source={id:`source:${event.id}`,kind:'source_content',ref,title:`Registered ${ref.domain} source`,body:content.content,
        locator:null,conditions:[],counterexamples:[],unknowns:structuredClone(record.limitations),
        actualReadCoverage:[structuredClone(content.actualCoverage)],sourceGroups:frozenGroups};
      const preparedBytes=Buffer.byteLength(JSON.stringify({operationId:id,source,methodVersion:request.methodVersion,
        budget:request.budget}),'utf8');
      result={...result,evidence:[receipt(source)],readUsage:{wikiPayloadBytes:0,sourceContentBytes:sourceBytes,
        preparedInputBytes:preparedBytes,maxReadBytes:request.budget.maxReadBytes},
        inputFingerprint:digest({request,provider,evidence:receipt(source),bodyDigest:ref.contentDigest})};
      if(preparedBytes>request.budget.maxReadBytes)
        throw new KnowledgeError('PREPARED_INPUT_BUDGET_EXCEEDED','Prepared planning input exceeds its byte budget',422);
      await options.operations.checkpoint(context,id,SourcePlanResultSchema.parse(result));
      check();await current(context,event,frozenGroups);check();
      if(sourceBytes===0)throw new KnowledgeError('SOURCE_PLAN_NO_EVIDENCE','Exact source text is empty',422);
      if(options.provider.execution==='external'){
        if(request.budget.maxModelCalls<1||!request.budget.maxMoney||!options.provider.supportsMoneyLimit)
          throw new KnowledgeError('MODEL_BUDGET_REQUIRED','External planning requires an enforceable money limit',422);
        if(!options.authorizeExternalDispatch)
          throw new KnowledgeError('MODEL_DISCLOSURE_PERMISSION_REQUIRED','External source disclosure is not authorized',403);
        await options.authorizeExternalDispatch(context,source,options.provider);
        check();await current(context,event,frozenGroups);check();
      }
      result={...result,cost:pending(),provider};
      await options.operations.checkpoint(context,id,SourcePlanResultSchema.parse(result));
      check();await current(context,event,frozenGroups);check();
      const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
      let parentAbortListener:(()=>void)|undefined;
      const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();
        reject(new KnowledgeError('PROVIDER_OUTCOME_UNKNOWN','Source planner response deadline elapsed',504));},
        Math.max(1,Date.parse(request.budget.deadline)-now().getTime()));});
      const parentAbort=new Promise<never>((_,reject)=>{
        if(parentSignal){parentAbortListener=()=>{controller.abort();
          reject(new KnowledgeError('PROVIDER_OUTCOME_UNKNOWN',
            'Source planning was cancelled after provider dispatch; reconcile the original operation',504));};
          parentSignal.addEventListener('abort',parentAbortListener,{once:true});}
      });
      invoked=true;let execution:Awaited<ReturnType<SourcePlanner['plan']>>;
      try{execution=await Promise.race([options.provider.plan({operationId:id,source:structuredClone(source),
        methodVersion:request.methodVersion,budget:structuredClone(request.budget),signal:controller.signal}),
        timeout,parentAbort]);}
      finally{if(timer)clearTimeout(timer);if(parentSignal&&parentAbortListener)
        parentSignal.removeEventListener('abort',parentAbortListener);}
      check();
      acknowledged=true;
      result={...result,cost:CostSchema.parse(execution.cost)};
      // Preserve acknowledged accounting before parsing untrusted output or attempting finish.
      await options.operations.checkpoint(context,id,SourcePlanResultSchema.parse(result));
      result={...result,provider:SourcePlanResultSchema.shape.provider.parse({...provider,
        modelReturned:execution.modelReturned,requestId:execution.requestId})};
      await options.operations.checkpoint(context,id,SourcePlanResultSchema.parse(result));
      const sourceBody=source.body;
      // Keep the acknowledged wire response even when proposal or byte-span validation fails.
      // A provider echo of the full source body is never written to the operation ledger.
      result={...result,raw:rawWithoutSourceBody(execution.raw,sourceBody)};
      await options.operations.checkpoint(context,id,SourcePlanResultSchema.parse(result));
      const proposal=SourcePlanProposalSchema.parse(execution.proposal);
      validateEntityMentionSpans(sourceBody,{methodVersion:request.methodVersion,mentions:proposal.mentions});
      if(sourceBody&&[proposal.question,...proposal.queries,proposal.reason,...proposal.gaps].some(text=>text?.includes(sourceBody)))
        throw new KnowledgeError('SOURCE_PLAN_BODY_ECHO','Proposal cannot retain the full source body outside exact mention surfaces',422);
      result={...result,proposal,reason:proposal.reason};
      await options.operations.checkpoint(context,id,SourcePlanResultSchema.parse(result));
      check();
      if(result.cost.modelCalls.state==='known'&&result.cost.modelCalls.value>request.budget.maxModelCalls)
        throw new KnowledgeError('MODEL_BUDGET_EXCEEDED','Source planner reported excess model calls',422);
      if(request.budget.maxMoney&&result.cost.money.state==='known'&&
        (result.cost.money.currency!==request.budget.maxMoney.currency||result.cost.money.amount>request.budget.maxMoney.amount))
        throw new KnowledgeError('MONEY_BUDGET_EXCEEDED','Source planner reported excess money',422);
      result={...result,state:result.cost.money.state==='unknown'||result.cost.modelCalls.state==='unknown'
        ?'outcome_unknown':proposal.outcome};
    }catch(error){
      if(commitUnknown(error))throw error;
      result={...result,state:error instanceof KnowledgeError&&error.code==='SOURCE_PLAN_NO_EVIDENCE'
        ?'needs_evidence':invoked&&(error instanceof KnowledgeError&&error.code==='PROVIDER_OUTCOME_UNKNOWN'||
          !acknowledged||result.cost.money.state==='unknown'||result.cost.modelCalls.state==='unknown')
          ?'outcome_unknown':'failed',cost:invoked?result.cost:zero(),
        reason:error instanceof KnowledgeError?`${error.code}: ${error.message}`:
          'Source planning failed; reconcile the original operation before retrying'};
    }
    result=SourcePlanResultSchema.parse({...result,completedAt:now().toISOString()});
    await options.operations.finish(context,id,result);
    // The provider may have run while source rights changed. Keep the ledger, withhold the POST result.
    return get(context,id);
  }};
}
