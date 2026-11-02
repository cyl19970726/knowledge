import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {SourcePlanResultSchema,type SourceEventRecord,type SourcePlanProposal,type SourcePlanResult,
  type SourcePlanRequest,type SourceRecord} from '../../knowledge-contracts/src/index.ts';
import {createSourcePlanApplication,type SourcePlanner,type SourcePlanOperationPort} from '../src/source-plan.ts';
import type {KnowledgeApplication} from '../src/index.ts';
import type {CapabilityContext} from '../src/sources.ts';

const knownCost:SourcePlanResult['cost']={modelCalls:{state:'known',value:1},tokens:{state:'known',value:12},
  money:{state:'known',amount:0.01,currency:'USD',source:'synthetic-provider-receipt'}};
const proposal:SourcePlanProposal={outcome:'planned',question:'应研究哪些来源条件？',queries:['品牌甲','活动条件'],
  mentions:[{entityType:'brand',surface:'品牌甲',startByte:0,endByte:9}],reason:'Synthetic model proposal',gaps:[]};

function fixture(options:{execution?:SourcePlanner['execution'];supportsMoneyLimit?:boolean;
  failFinish?:boolean;revokeAt?:'readsetCheckpoint'|'pendingCheckpoint'|'provider';body?:string;
  proposal?:SourcePlanProposal;proposalWire?:unknown;cost?:SourcePlanResult['cost'];raw?:unknown;
  commitUnknownAtCheckpoint?:boolean;noDisclosure?:boolean;modelReturned?:string|null;
  mutateProviderInput?:boolean;mutateGroupsAtReadsetCheckpoint?:boolean;
  waitForAbort?:boolean;onProviderStart?:(signal:AbortSignal)=>void}={}){
  const scope={projectId:'synthetic-plan-project',spaceId:'synthetic-plan-space'},purpose='exploration_reading';
  const body=options.body??'品牌甲的活动记录',ref={...scope,domain:'source' as const,objectId:randomUUID(),versionId:randomUUID(),
    contentDigest:createHash('sha256').update(body).digest('hex')},sourceEventId=randomUUID();
  const groups=[{id:'synthetic-original-group',status:'known' as const,authority:'owner'}];
  const context:CapabilityContext={scope,purpose,principal:{id:'synthetic-reader',clientInstallationId:'synthetic-installation',
    projectId:scope.projectId,spaceIds:[scope.spaceId],purposes:[purpose]},authorization:{
      actions:['ingest:read','source-plans:read','source-plans:write'],adapterIds:['synthetic-adapter'],rightsPolicyIds:[]}};
  let clock=Date.now(),readable=true,calls=0,stored:SourcePlanResult|null=null,savedKey:string|null=null,checkpoints=0,gets=0,
    disclosureCalls=0,lastProviderInput:Parameters<SourcePlanner['plan']>[0]|null=null;
  const request:SourcePlanRequest={sourceEventId,purpose,methodVersion:'synthetic-planner/1',
    budget:{maxModelCalls:1,maxReadBytes:100_000,deadline:new Date(clock+60_000).toISOString(),maxMoney:null}};
  const metadata=():SourceRecord=>({ref,head:ref,sourceSchemaVersion:'synthetic/1',sourceKind:'document',
    assertionKind:'caller_reported',sourceGroups:groups,actualCoverage:[],limitations:['Synthetic only'],supersedes:null,
    receiptId:randomUUID(),readability:{metadataVisible:true,contentReadable:readable,anchorResolved:true,
      assurance:'read_time_only',reasons:readable?[]:['revoked']}});
  const event=():SourceEventRecord=>({id:sourceEventId,request:{sourceRef:ref,adapterId:'synthetic-adapter',eventKey:'synthetic-event',
    producerSequence:1,purpose,occurredAt:new Date(clock).toISOString()},inputDigest:'a'.repeat(64),source:metadata(),
    registeredAt:new Date(clock).toISOString(),assurance:'read_time_only',state:'registered'});
  const operations:SourcePlanOperationPort={
    async reserve(_ctx,key,_inputDigest,_request,initial){if(stored){assert.equal(key,savedKey);return {created:false,result:structuredClone(stored)};}
      savedKey=key;
      stored=structuredClone(initial);return {created:true,result:initial};},
    async start(){if(stored?.state!=='reserved')return false;stored={...stored,state:'running'};return true;},
    async checkpoint(_ctx,_id,result){checkpoints++;if(options.commitUnknownAtCheckpoint&&checkpoints===1)
      throw Object.assign(new Error('Synthetic uncertain commit'),{commitStatus:'unknown',operationId:result.id});
      stored=SourcePlanResultSchema.parse(structuredClone(result));
      if(options.revokeAt==='readsetCheckpoint'&&result.evidence.length&&result.provider===null)readable=false;
      if(options.mutateGroupsAtReadsetCheckpoint&&result.evidence.length&&result.provider===null)
        groups[0].id='changed-original-group';
      if(options.revokeAt==='pendingCheckpoint'&&result.provider&&result.cost.modelCalls.state==='unknown')readable=false;},
    async finish(_ctx,_id,result){if(options.failFinish)throw new Error('Synthetic finish failed');
      stored=SourcePlanResultSchema.parse(structuredClone(result));},
    async get(){gets++;if(stored&&(stored.state==='reserved'||stored.state==='running')&&
      Date.parse(stored.request.budget.deadline)<=clock)stored={...stored,
        state:stored.state==='reserved'?'failed':'outcome_unknown',completedAt:new Date(clock).toISOString(),reason:'Synthetic deadline reconciliation'};
      return stored?structuredClone(stored):null;},
    async lookup(_ctx,key){return stored&&key===savedKey?structuredClone(stored):null;},
  };
  const reader={async sourceRecord(){return metadata();},async sourceContentBounded(_context:unknown,_ref:unknown,
    _anchor:unknown,maxBytes:number){assert.ok(Buffer.byteLength(body)<=maxBytes);
    return {ref,content:body,contentDigest:ref.contentDigest,anchor:null,readability:metadata().readability,
      actualCoverage:{sourceRef:ref,anchors:[],byteCount:Buffer.byteLength(body),coverage:'full' as const,exclusions:[],
        readAt:new Date(clock).toISOString(),readerAuthority:'synthetic-owner',readProofId:null}};}} as unknown as Pick<KnowledgeApplication,'sourceRecord'|'sourceContentBounded'>;
  const provider:SourcePlanner={id:'synthetic-planner',version:'v1',model:'synthetic-requested-model',
    execution:options.execution??'local_deterministic',supportsMoneyLimit:options.supportsMoneyLimit,
    async plan(input){calls++;lastProviderInput=input;
      options.onProviderStart?.(input.signal);
      if(options.waitForAbort)return new Promise<never>(()=>{});
      if(options.mutateProviderInput){input.source.body='provider-mutated-copy';input.budget.maxReadBytes=0;}
      if(options.revokeAt==='provider')readable=false;
      return {proposal:structuredClone(options.proposalWire??options.proposal??proposal) as SourcePlanProposal,
        raw:options.raw??{provider:'synthetic'},
        cost:structuredClone(options.cost??knownCost),modelReturned:options.modelReturned===undefined
          ?'synthetic-returned-model':options.modelReturned,requestId:'synthetic-request-id'};}};
  const app=createSourcePlanApplication({reader,intake:{async get(){return event();}},operations,provider,
    authorizeExternalDispatch:options.noDisclosure?undefined:async(_context,source)=>{
      disclosureCalls++;assert.equal(source.body,body);},
    now:()=>new Date(clock)});
  return {app,context,request,body,ref,groups,provider,operations,
    advance(){clock+=61_000;},revoke(){readable=false;},
    get stored(){return stored;},get calls(){return calls;},get checkpoints(){return checkpoints;},
    get gets(){return gets;},get disclosureCalls(){return disclosureCalls;},
    get lastProviderInput(){return lastProviderInput;}};
}

test('bounded exact source becomes a proposal with frozen receipt, validated UTF-8 span, and provider receipt',async()=>{
  const f=fixture({raw:{echo:'品牌甲的活动记录',diagnostic:'synthetic'}});
  const result=await f.app.plan(f.context,f.request,'plan-key');
  assert.equal(result.state,'planned');assert.equal(result.provenance,'model_proposed');
  assert.deepEqual(result.proposal?.mentions,[proposal.mentions[0]]);
  assert.equal(result.evidence[0]?.ref.contentDigest,f.ref.contentDigest);
  assert.deepEqual(result.evidence[0]?.sourceGroups,f.groups);
  assert.equal(result.evidence[0]?.actualReadCoverage[0]?.coverage,'full');
  assert.equal(result.readUsage.sourceContentBytes,Buffer.byteLength(f.body));
  assert.ok(result.readUsage.preparedInputBytes>result.readUsage.sourceContentBytes);
  assert.equal(result.provider?.modelReturned,'synthetic-returned-model');
  assert.equal(result.provider?.requestId,'synthetic-request-id');
  assert.deepEqual(result.cost,knownCost);assert.equal(result.raw,null,'echoed original text is not retained');
  assert.equal(JSON.stringify(result).includes(f.body),false);
  assert.equal(f.lastProviderInput?.source.body,f.body);
  assert.equal(f.calls,1);assert.ok(f.checkpoints>=3);
  assert.deepEqual(await f.app.lookup(f.context,'plan-key'),result);
  assert.equal(await f.app.lookup(f.context,'missing-key'),null);
});

test('acknowledged proposal and cost survive failed finish; same-key replay expires without another call',async()=>{
  const f=fixture({failFinish:true,raw:{receipt:'acknowledged'}});
  await assert.rejects(f.app.plan(f.context,f.request,'plan-key'),/Synthetic finish failed/);
  assert.equal(f.stored?.state,'running');assert.equal(f.stored?.proposal?.outcome,'planned');
  assert.deepEqual(f.stored?.raw,{receipt:'acknowledged'});
  assert.deepEqual(f.stored?.cost,knownCost);
  f.advance();const replay=await f.app.plan(f.context,f.request,'plan-key');
  assert.equal(replay.state,'outcome_unknown');assert.deepEqual(replay.proposal?.mentions,proposal.mentions);
  assert.equal(f.calls,1);assert.ok(f.gets>0);
});

test('invalid UTF-8 byte span retains safe raw response and known cost without replaying provider',async()=>{
  const raw={wire:'acknowledged-before-span-validation'};
  const f=fixture({proposal:{...proposal,mentions:[{...proposal.mentions[0],endByte:8}]},raw});
  const result=await f.app.plan(f.context,f.request,'plan-key');
  assert.equal(result.state,'failed');assert.match(result.reason,/ENTITY_MENTION_SPAN_INVALID/);
  assert.deepEqual(result.cost,knownCost);assert.equal(result.proposal,null);assert.deepEqual(result.raw,raw);
  const replay=await f.app.plan(f.context,f.request,'plan-key');
  assert.equal(replay.id,result.id);assert.deepEqual(replay.raw,raw);assert.equal(f.calls,1);
});

test('invalid proposal shape retains safe raw response and known cost without replaying provider',async()=>{
  const raw={wire:'acknowledged-before-proposal-validation'};
  const f=fixture({proposalWire:{outcome:'planned',question:null,queries:[],mentions:[],reason:'invalid',gaps:[]},raw});
  const result=await f.app.plan(f.context,f.request,'plan-key');
  assert.equal(result.state,'failed');assert.equal(result.proposal,null);
  assert.deepEqual(result.cost,knownCost);assert.deepEqual(result.raw,raw);
  const replay=await f.app.plan(f.context,f.request,'plan-key');
  assert.equal(replay.id,result.id);assert.deepEqual(replay.raw,raw);assert.equal(f.calls,1);
});

test('invalid provider receipt metadata cannot erase already checkpointed known usage',async()=>{
  const f=fixture({modelReturned:''});
  const result=await f.app.plan(f.context,f.request,'plan-key');
  assert.equal(result.state,'failed');assert.deepEqual(result.cost,knownCost);
  assert.equal(result.provider?.modelReturned,null);assert.equal(f.calls,1);
});

test('provider receives a clone; source body echoes outside mention surfaces cannot enter a proposal',async()=>{
  const cloned=fixture({mutateProviderInput:true});
  const result=await cloned.app.plan(cloned.context,cloned.request,'plan-key');
  assert.equal(result.state,'planned');assert.equal(result.readUsage.maxReadBytes,100_000);
  assert.equal(cloned.request.budget.maxReadBytes,100_000);
  const echoed=fixture({proposal:{...proposal,question:`研究${'品牌甲的活动记录'}`}});
  const failed=await echoed.app.plan(echoed.context,echoed.request,'plan-key');
  assert.equal(failed.state,'failed');assert.match(failed.reason,/SOURCE_PLAN_BODY_ECHO/);
  assert.deepEqual(failed.cost,knownCost);assert.equal(failed.proposal,null);
});

for(const outcome of ['needs_evidence','refused'] as const)test(`${outcome} remains a distinct model proposal`,async()=>{
  const f=fixture({proposal:{outcome,question:null,queries:[],mentions:[],reason:`Synthetic ${outcome}`,gaps:[]}});
  const result=await f.app.plan(f.context,f.request,'plan-key');
  assert.equal(result.state,outcome);assert.equal(result.proposal?.outcome,outcome);assert.deepEqual(result.cost,knownCost);
});

test('empty exact text yields needs_evidence with zero provider calls',async()=>{
  const f=fixture({body:''});const result=await f.app.plan(f.context,f.request,'plan-key');
  assert.equal(result.state,'needs_evidence');assert.equal(f.calls,0);
  assert.equal(result.cost.modelCalls.state,'known');
});

test('prepared input bound and readset checkpoint revocation stop before provider dispatch',async()=>{
  const bounded=fixture();bounded.request.budget.maxReadBytes=100;
  const result=await bounded.app.plan(bounded.context,bounded.request,'plan-key');
  assert.equal(result.state,'failed');assert.match(result.reason,/PREPARED_INPUT_BUDGET_EXCEEDED/);
  assert.equal(bounded.calls,0);assert.equal(JSON.stringify(result).includes(bounded.body),false);
  const revoked=fixture({revokeAt:'readsetCheckpoint'});
  await assert.rejects(revoked.app.plan(revoked.context,revoked.request,'plan-key'),
    error=>error instanceof KnowledgeError&&error.code==='SOURCE_FORBIDDEN');
  assert.equal(revoked.calls,0);assert.equal(revoked.stored?.state,'failed');
  const drift=fixture({mutateGroupsAtReadsetCheckpoint:true});
  await assert.rejects(drift.app.plan(drift.context,drift.request,'plan-key'),
    error=>error instanceof KnowledgeError&&error.code==='SOURCE_READSET_CHANGED');
  assert.equal(drift.calls,0);assert.equal(drift.stored?.state,'failed');
});

test('local deterministic planning may report zero calls under a zero-call budget',async()=>{
  const zero={modelCalls:{state:'known' as const,value:0},tokens:{state:'known' as const,value:0},
    money:{state:'known' as const,amount:0,currency:'USD',source:'synthetic-local-only'}};
  const f=fixture({cost:zero});f.request.budget.maxModelCalls=0;
  const result=await f.app.plan(f.context,f.request,'plan-key');
  assert.equal(result.state,'planned');assert.deepEqual(result.cost,zero);
});

test('five-minute deadline bound and elapsed deadline prevent provider dispatch',async()=>{
  const tooLong=fixture();tooLong.request.budget.deadline=new Date(Date.now()+360_000).toISOString();
  await assert.rejects(tooLong.app.plan(tooLong.context,tooLong.request,'plan-key'),
    error=>error instanceof KnowledgeError&&error.code==='DEADLINE_TOO_LARGE');
  assert.equal(tooLong.calls,0);
  const expired=fixture();expired.advance();
  const result=await expired.app.plan(expired.context,expired.request,'plan-key');
  assert.equal(result.state,'failed');assert.match(result.reason,/DEADLINE_EXPIRED/);
  assert.equal(expired.calls,0);
});

test('external dispatch needs enforceable money and disclosure, then rechecks rights after checkpoint',async()=>{
  const noMoney=fixture({execution:'external',supportsMoneyLimit:true});
  const denied=await noMoney.app.plan(noMoney.context,noMoney.request,'plan-key');
  assert.equal(denied.state,'failed');assert.equal(noMoney.calls,0);assert.match(denied.reason,/MODEL_BUDGET_REQUIRED/);
  const noDisclosure=fixture({execution:'external',supportsMoneyLimit:true,noDisclosure:true});
  noDisclosure.request.budget.maxMoney={amount:1,currency:'USD'};
  const undisclosed=await noDisclosure.app.plan(noDisclosure.context,noDisclosure.request,'plan-key');
  assert.equal(undisclosed.state,'failed');assert.equal(noDisclosure.calls,0);
  assert.match(undisclosed.reason,/MODEL_DISCLOSURE_PERMISSION_REQUIRED/);
  const f=fixture({execution:'external',supportsMoneyLimit:true,revokeAt:'pendingCheckpoint'});
  f.request.budget.maxMoney={amount:1,currency:'USD'};
  const result=await f.app.plan(f.context,f.request,'plan-key').catch(error=>error);
  assert.ok(result instanceof KnowledgeError&&result.status===403,'revoked source is withheld by the final read gate');
  assert.equal(f.calls,0);assert.equal(f.disclosureCalls,1);
  assert.equal(f.stored?.state,'failed');
});

test('revocation during provider work leaves the confirmed ledger but withholds the first POST',async()=>{
  const f=fixture({revokeAt:'provider'});
  await assert.rejects(f.app.plan(f.context,f.request,'plan-key'),
    error=>error instanceof KnowledgeError&&error.code==='SOURCE_FORBIDDEN');
  assert.equal(f.stored?.state,'planned');assert.deepEqual(f.stored?.cost,knownCost);assert.equal(f.calls,1);
  await assert.rejects(f.app.get(f.context,f.stored!.id),/no longer readable/);
});

test('unknown accounting remains unknown and never looks like zero cost',async()=>{
  const f=fixture({cost:{modelCalls:{state:'unknown',reason:'No receipt'},tokens:{state:'unknown',reason:'No receipt'},
    money:{state:'unknown',reason:'No receipt'}}});
  const result=await f.app.plan(f.context,f.request,'plan-key');
  assert.equal(result.state,'outcome_unknown');assert.equal(result.cost.money.state,'unknown');
  assert.equal(result.proposal?.outcome,'planned');
});

test('oversize raw provider diagnostics fail while preserving known usage',async()=>{
  const f=fixture({raw:{data:'x'.repeat(1_000_001)}});
  const result=await f.app.plan(f.context,f.request,'plan-key');
  assert.equal(result.state,'failed');assert.match(result.reason,/SOURCE_PLAN_RAW_LIMIT/);
  assert.deepEqual(result.cost,knownCost);assert.equal(result.raw,null);
});

test('read and ingest actions gate lookup independently; commit uncertainty is preserved',async()=>{
  const f=fixture({commitUnknownAtCheckpoint:true});
  await assert.rejects(f.app.plan(f.context,f.request,'plan-key'),
    error=>error instanceof Error&&'commitStatus'in error&&error.commitStatus==='unknown');
  assert.equal(f.calls,0);
  const normal=fixture();const plan=await normal.app.plan(normal.context,normal.request,'plan-key');
  const denied={...normal.context,authorization:{...normal.context.authorization,
    actions:['source-plans:read']}};
  await assert.rejects(normal.app.get(denied,plan.id),/not authorized/);
  await assert.rejects(normal.app.lookup(denied,'plan-key'),/not authorized/);
});

test('pre-dispatch parent cancellation makes no provider call and records zero fee',async()=>{
  const already=new AbortController();already.abort();
  const before=fixture();
  await assert.rejects(before.app.plan(before.context,before.request,'plan-key',already.signal),
    error=>error instanceof KnowledgeError&&error.code==='SOURCE_PLAN_ABORTED');
  assert.equal(before.calls,0);assert.equal(before.stored,null,'already cancelled requests do not reserve');

  const during=new AbortController(),f=fixture();
  const checkpoint=f.operations.checkpoint.bind(f.operations);
  f.operations.checkpoint=async(context,id,result)=>{await checkpoint(context,id,result);
    if(result.evidence.length&&result.provider===null)during.abort();};
  const result=await f.app.plan(f.context,f.request,'plan-key',during.signal);
  assert.equal(result.state,'failed');assert.match(result.reason,/SOURCE_PLAN_ABORTED/);
  assert.deepEqual(result.cost.modelCalls,{state:'known',value:0});
  assert.equal(result.cost.money.state,'known');assert.equal(f.calls,0);

  const pendingParent=new AbortController(),prepared=fixture();
  const pendingCheckpoint=prepared.operations.checkpoint.bind(prepared.operations);
  prepared.operations.checkpoint=async(context,id,value)=>{await pendingCheckpoint(context,id,value);
    if(value.provider&&value.cost.modelCalls.state==='unknown')pendingParent.abort();};
  const preparedResult=await prepared.app.plan(prepared.context,prepared.request,'plan-key',pendingParent.signal);
  assert.equal(preparedResult.state,'failed');assert.equal(prepared.calls,0);
  assert.deepEqual(preparedResult.cost.modelCalls,{state:'known',value:0});
  assert.deepEqual(preparedResult.cost.money,{state:'known',amount:0,currency:'USD',source:'no_provider_call'});
});

test('in-flight cancellation aborts provider signal, records unknown, and never redispatches the same key',async()=>{
  const parent=new AbortController(),observed:{signal?:AbortSignal}={};let started!:()=>void;
  const entered=new Promise<void>(resolve=>{started=resolve;});
  const f=fixture({waitForAbort:true,onProviderStart:signal=>{observed.signal=signal;started();}});
  const pending=f.app.plan(f.context,f.request,'plan-key',parent.signal);
  await entered;assert.equal(observed.signal?.aborted,false);
  parent.abort();const result=await pending;
  assert.equal(observed.signal?.aborted,true);assert.equal(result.state,'outcome_unknown');
  assert.match(result.reason,/PROVIDER_OUTCOME_UNKNOWN/);
  assert.equal(result.cost.modelCalls.state,'unknown');assert.equal(result.cost.money.state,'unknown');
  assert.equal(f.calls,1);
  const replay=await f.app.plan(f.context,f.request,'plan-key',new AbortController().signal);
  assert.equal(replay.id,result.id);assert.equal(replay.state,'outcome_unknown');assert.equal(f.calls,1);
});

test('cancellation after acknowledgement keeps known cost and proposal; successful calls detach parent listener',async()=>{
  const parent=new AbortController(),f=fixture();
  const checkpoint=f.operations.checkpoint.bind(f.operations);
  f.operations.checkpoint=async(context,id,result)=>{await checkpoint(context,id,result);
    if(result.proposal?.outcome==='planned')parent.abort();};
  const result=await f.app.plan(f.context,f.request,'plan-key',parent.signal);
  assert.equal(result.state,'outcome_unknown');assert.deepEqual(result.cost,knownCost);
  assert.equal(result.proposal?.outcome,'planned');assert.equal(f.calls,1);

  const completedParent=new AbortController(),completed=fixture();
  const settled=await completed.app.plan(completed.context,completed.request,'plan-key',completedParent.signal);
  assert.equal(settled.state,'planned');assert.equal(completed.lastProviderInput?.signal.aborted,false);
  completedParent.abort();assert.equal(completed.lastProviderInput?.signal.aborted,false,
    'a finished provider call must no longer listen to its parent signal');
});
