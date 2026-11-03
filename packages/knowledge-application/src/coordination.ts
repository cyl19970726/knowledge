import {discoverFromWiki} from './wiki-discovery.ts';
import {randomUUID} from 'node:crypto';
import {CoordinationRunSchema,SourcePlanRequestSchema,WikiCompileRequestSchema,RelationJudgmentRequestSchema,
 type Budget,type Cost,type CoordinationRun,type CoordinationStep,type MaintenanceTask,type MaintenanceOutcome,type KnowledgeRef,type DecisionQuestion} from '@commerce/knowledge-contracts';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {digest} from '@commerce/knowledge-core/utils';
import type {KnowledgeApplication,ReadContext} from './index.ts';
import {authorizeCapability,type CapabilityContext} from './sources.ts';
import type {createSourcePlanApplication} from './source-plan.ts';
import type {createWikiCompileApplication} from './wiki-compile.ts';
import type {createRelationJudgmentApplication} from './relation-judgment.ts';
import type {createSourceIntakeApplication} from './source-intake.ts';
import type {MaintenanceProcessor,MaintenanceTaskPort} from './maintenance.ts';
import type {CoordinationOperationPort} from './coordination-port.ts';

const zero=(currency='USD'):Cost=>({modelCalls:{state:'known',value:0},tokens:{state:'known',value:0},money:{state:'known',amount:0,currency,source:'no_model_step'}});
const unknown=():Cost=>({modelCalls:{state:'unknown',reason:'Child operation has not been reconciled'},tokens:{state:'unknown',reason:'Usage is not acknowledged'},money:{state:'unknown',reason:'Reconcile original child key'}});
export interface CoordinationPolicy {version:string;providerFingerprint:string;maxPairs:number;maxCandidates:number;queryLimit:number;
 budget:{maxModelCalls:number;maxReadBytes:number;maxMoney:Budget['maxMoney'];timeoutMs:number}}
const questions:DecisionQuestion[]=[
 {id:'same_subject',type:'predicate',instructions:'Do the two inputs concern the same subject and outcome? Preserve scope and ambiguity.'},
 {id:'relation',type:'choice',instructions:'Under comparable conditions, what does the right input add relative to the left? Shared origin is not independent support.',options:[
  {value:'supports',description:'Supports within matching conditions'},{value:'challenges',description:'Provides a counterexample or contradiction'},
  {value:'narrows',description:'Narrows applicability or adds a necessary condition'},{value:'duplicate',description:'Repeats the same original claim'},
  {value:'context',description:'Useful context without establishing support'},{value:'unrelated',description:'Different subject or outcome'},
  {value:'insufficient_evidence',description:'Evidence or comparable conditions are missing'}]},
 {id:'conditions_match',type:'predicate',instructions:'Are the relevant conditions comparable enough to assess support or challenge?'}];
function sumCost(steps:readonly CoordinationStep[],defaultCurrency:string):Cost{
 const costs=steps.map(x=>x.cost);
 const count=(key:'tokens'|'modelCalls')=>costs.every(x=>x[key].state==='known')?
  {state:'known' as const,value:costs.reduce((n,x)=>n+(x[key].state==='known'?x[key].value:0),0)}:
  {state:'unknown' as const,reason:'At least one child operation has unacknowledged usage'};
 const currencies=new Set(costs.flatMap(x=>x.money.state==='known'&&x.money.amount>0?[x.money.currency]:[]));
 return {modelCalls:count('modelCalls'),tokens:count('tokens'),money:costs.every(x=>x.money.state==='known')&&currencies.size<=1?
  {state:'known',amount:costs.reduce((n,x)=>n+(x.money.state==='known'?x.money.amount:0),0),currency:[...currencies][0]??defaultCurrency,source:'sum_of_child_operation_receipts'}:
  {state:'unknown',reason:'At least one child billing receipt is unknown or currencies differ'}};
}
function stateOf(value:string):CoordinationRun['state']{
 return value==='waiting_for_review'?'waiting_for_review':value==='superseded'?'superseded':value==='draft_ready'?'needs_evidence':
 value==='no_change'?'no_change':value==='needs_evidence'?'needs_evidence':value==='refused'?'refused':
 value==='failed'?'failed':value==='outcome_unknown'||value==='reserved'||value==='running'?'outcome_unknown':'completed';
}
function outcome(run:CoordinationRun):MaintenanceOutcome{return {state:run.state==='reserved'||run.state==='running'?'outcome_unknown':run.state==='refused'?'needs_evidence':run.state,
 findingIds:[],compilationId:run.compilationId,judgmentId:run.judgmentIds[0]??null,cost:run.cost,reason:'后台研究已留下可核对记录；具体依据和结论见获授权的协调详情。'};}
/** A durable coordinator composes existing operations. It has no publication authority. */
export function createCoordinationProcessor(options:{reader:Pick<KnowledgeApplication,'queryCandidates'|'readCandidate'>&Partial<Pick<KnowledgeApplication,'inspectWikiCandidate'|'assertReadEpoch'|'validateFrozenWiki'|'validateHistoricalWiki'|'readRepairTarget'|'currentWikiRef'|'sourceRecord'>>;
 intake?:Pick<ReturnType<typeof createSourceIntakeApplication>,'get'>;planner?:ReturnType<typeof createSourcePlanApplication>;
 compiler:ReturnType<typeof createWikiCompileApplication>;judgments?:ReturnType<typeof createRelationJudgmentApplication>;
 operations:CoordinationOperationPort;tasks?:Pick<MaintenanceTaskPort,'get'>;policy:CoordinationPolicy;execution:MaintenanceProcessor['execution'];now?:()=>Date}){
 const policy=structuredClone(options.policy),now=()=>options.now?.()??new Date();
 if(!policy.version.trim()||!policy.providerFingerprint||!Number.isInteger(policy.maxPairs)||policy.maxPairs<0||policy.maxPairs>3||
  !Number.isInteger(policy.maxCandidates)||policy.maxCandidates<1||policy.maxCandidates>5||!Number.isInteger(policy.queryLimit)||policy.queryLimit<1||policy.queryLimit>20||
  !Number.isInteger(policy.budget.timeoutMs)||policy.budget.timeoutMs<1000||policy.budget.timeoutMs>300_000)
  throw new KnowledgeError('COORDINATION_POLICY_INVALID','Explicit bounded coordination policy required',422);
 const policyDigest=digest(policy);
 async function visible(context:CapabilityContext,run:CoordinationRun){
  authorizeCapability(context,'maintenance:read');
  if(run.request.sourceEventId){if(!options.intake)throw new KnowledgeError('SOURCE_INTAKE_DISABLED','Source run reader is unavailable',503);await options.intake.get(context,run.request.sourceEventId);}
  if(run.sourcePlanId){if(!options.planner)throw new KnowledgeError('SOURCE_PLANNER_DISABLED','Source plan reader is unavailable',503);await options.planner.get(context,run.sourcePlanId);}
  if(run.compilationId)await options.compiler.get(context,run.compilationId);
  for(const item of run.discovery?.evidence??[]){
   const validate=run.compilationOutcome&&options.reader.validateHistoricalWiki?options.reader.validateHistoricalWiki:options.reader.validateFrozenWiki;
   if(!validate||!item.storageDigest)throw new KnowledgeError('COORDINATION_READSET_UNAVAILABLE','Discovery evidence cannot be verified',503);
   await validate(context,item.ref,item.storageDigest);
  }
  return run;
 }
 async function reconcile(context:CapabilityContext,original:CoordinationRun){
  if(original.state!=='outcome_unknown'||!options.operations.reconcile)return original;
  let run=structuredClone(original),lastState:string|null=null;
  for(const [index,saved] of run.steps.entries()){
   if(saved.kind==='discovery'||!['running','outcome_unknown'].includes(saved.state)&&saved.kind!=='planning')continue;
   const found=saved.kind==='planning'?await options.planner?.lookup(context,saved.key):saved.kind==='compilation'?
    await options.compiler.lookup(context,saved.key):await options.judgments?.lookup(context,saved.key);
   if(!found)continue;
   const pending=['reserved','running','outcome_unknown'].includes(found.state);
   run.steps[index]={...saved,resultId:found.id,state:pending?'outcome_unknown':found.state==='failed'?'failed':'known',cost:found.cost,
    readBytes:found.readUsage.sourceContentBytes+found.readUsage.wikiPayloadBytes};
   if(saved.kind==='planning'){run.sourcePlanId=found.id;if(!['reserved','running','outcome_unknown','planned'].includes(found.state))lastState=found.state;}
   if(saved.kind==='compilation'){run.compilationId=found.id;lastState=found.state;}
   if(saved.kind==='judgment')run.judgmentIds=[...new Set([...run.judgmentIds,found.id])];
  }
  const unresolved=run.steps.some(x=>['running','outcome_unknown'].includes(x.state));
  run={...run,state:unresolved?'outcome_unknown':lastState?stateOf(lastState):'needs_evidence',
   cost:sumCost(run.steps,run.request.budget.maxMoney?.currency??'USD'),readBytes:run.steps.reduce((n,x)=>n+x.readBytes,0),
   reason:unresolved?'Original child receipts remain uncertain; no provider was called during reconciliation':
    lastState?'Reconciled the original child receipt; no provider was called':
      'Known steps were reconciled; remaining phases were not dispatched and require a newly authorized task',
   completedAt:original.completedAt??now().toISOString()};
  if(digest(run)===digest(original))return original;
  return options.operations.reconcile(context,run.id,CoordinationRunSchema.parse(run));
 }
 async function get(context:CapabilityContext,id:string){const run=await options.operations.get(context,id);
  if(!run)throw new KnowledgeError('NOT_FOUND','Coordination run is unavailable',404);await visible(context,run);return visible(context,await reconcile(context,run));}
 async function byTask(context:CapabilityContext,taskId:string){const run=await options.operations.byTask(context,taskId);if(!run)return null;await visible(context,run);return visible(context,await reconcile(context,run));}
 // Repair composes one exact compilation. It never publishes and never treats "no change" as a repair.
 async function repair(context:CapabilityContext,task:MaintenanceTask,signal:AbortSignal):Promise<MaintenanceOutcome>{
  const subject=task.request.subjectRef!,currency=policy.budget.maxMoney?.currency??'USD';
  const initial:CoordinationRun={id:randomUUID(),request:{taskId:task.id,taskInputDigest:task.inputDigest,purpose:context.purpose,policyVersion:policy.version,
   sourceEventId:null,subjectRef:subject,budget:{maxModelCalls:policy.budget.maxModelCalls,maxReadBytes:policy.budget.maxReadBytes,maxMoney:policy.budget.maxMoney,
    deadline:new Date(now().getTime()+policy.budget.timeoutMs).toISOString()}},state:'reserved',sourcePlanId:null,candidateRefs:[],discovery:null,readAccounting:'acknowledged_steps',
   judgmentIds:[],compilationId:null,steps:[],cost:zero(currency),readBytes:0,reason:'Reserved; no child dispatched',gaps:[],createdAt:now().toISOString(),completedAt:null};
  const reservation=await options.operations.reserve(context,digest({task:task.inputDigest,policyDigest}),initial);
  let run=reservation.result;
  if(!reservation.created&&!['reserved','running'].includes(run.state))return outcome(await visible(context,await reconcile(context,run)));
  const check=async()=>{signal.throwIfAborted();if(Date.parse(run.request.budget.deadline)<=now().getTime())throw new KnowledgeError('DEADLINE_EXPIRED','Coordination deadline elapsed',422);
   if(options.tasks){const current=await options.tasks.get(context,task.id);
    if(current?.cancelRequested)throw new KnowledgeError('TASK_CANCELLED','Maintenance cancellation was confirmed before another step',409);
    if(!current||current.state!=='running'||current.attemptId!==task.attemptId||current.leaseToken!==task.leaseToken)
     throw new KnowledgeError('TASK_LEASE_LOST','Another attempt owns this maintenance task',409);}};
  const checkpoint=async()=>{run=CoordinationRunSchema.parse({...run,state:'running',cost:sumCost(run.steps,currency),readBytes:run.steps.reduce((n,x)=>n+x.readBytes,0)});
   if(run.readBytes>run.request.budget.maxReadBytes)throw new KnowledgeError('READ_BUDGET_EXCEEDED','Acknowledged child reads exceeded task budget',422);
   await options.operations.checkpoint(context,run.id,run);
   if(run.cost.modelCalls.state==='known'&&run.cost.modelCalls.value>run.request.budget.maxModelCalls)throw new KnowledgeError('MODEL_BUDGET_EXCEEDED','Child operations reported excess model calls',422);};
  const finish=async(state:CoordinationRun['state'],reason:string)=>{
   run=CoordinationRunSchema.parse({...run,state,reason,cost:sumCost(run.steps,currency),readBytes:run.steps.reduce((n,x)=>n+x.readBytes,0),completedAt:now().toISOString()});
   await options.operations.finish(context,run.id,run);return outcome(await visible(context,run));};
  const step=async(kind:CoordinationStep['kind'],request:unknown)=>{
   const key=`coord:${run.id}:${kind}:0`,old=run.steps.find(x=>x.key===key);if(old)return old;
   const value:CoordinationStep={kind,key,request:JSON.parse(JSON.stringify(request)),resultId:null,state:'planned',cost:zero(currency),readBytes:0};
   run={...run,steps:[...run.steps,value]};await checkpoint();return value;};
  const saveStep=async(saved:CoordinationStep,changes:Partial<CoordinationStep>)=>{run={...run,steps:run.steps.map(x=>x.key===saved.key?{...x,...changes}:x)};await checkpoint();};
  const readable=async(ref:KnowledgeRef)=>{try{const record=await options.reader.sourceRecord!(context,ref);
    return record.readability.metadataVisible&&record.readability.contentReadable&&record.ref.contentDigest?record:null;}
   catch(error){if(error instanceof KnowledgeError&&[403,404,409].includes(error.status))return null;throw error;}};
  try{
   await check();await checkpoint();
   // Resolved inputs are frozen only in the compilation request; before it exists they are re-resolved locally.
   let compilation=run.steps.find(x=>x.kind==='compilation');
   if(!compilation){
    const saved=run.steps.find(x=>x.kind==='discovery')??await step('discovery',{subjectRef:subject,method:'wiki-repair-inputs-v1'});
    // Reading the target is local and bounded. A stale head or revoked lineage ends here without any model call.
    let target;
    try{target=await options.reader.readRepairTarget!(context,subject,Math.floor(policy.budget.maxReadBytes*0.4));}
    catch(error){
     if(!(error instanceof KnowledgeError))throw error;
     if(saved.state!=='known')await saveStep(saved,{state:'failed',cost:zero(currency)});
     if(['REPAIR_TARGET_STALE','NOT_FOUND'].includes(error.code))return finish('superseded','修复目标已不是当前版本；旧任务按过时结束，未调用模型');
     if(['ASK_READSET_INVALIDATED','SOURCE_FORBIDDEN','REPAIR_TARGET_NOT_REVIEWED'].includes(error.code))
      return finish('needs_evidence','修复目标或其关键来源当前不可读；未向模型发送任何内容');
     if(error.code==='KNOWLEDGE_READ_BUDGET_EXCEEDED')return finish('needs_evidence','修复目标超出读取预算；未调用模型');
     throw error;
    }
    if(target.validity.valid&&!(target.reviewDueAt&&Date.parse(target.reviewDueAt)<=now().getTime()))
     return finish('superseded','修复目标当前有效且未到复核期；无需修复，未调用模型');
    const wiki=new Map<string,KnowledgeRef>(),sources=new Map<string,KnowledgeRef>(),gaps:string[]=[];
    let upstreamPending=false;
    const addSource=async(ref:Pick<KnowledgeRef,'objectId'|'versionId'>,valid:boolean)=>{
     const exact={...context.scope,domain:'source' as const,objectId:ref.objectId,versionId:ref.versionId,contentDigest:null};
     const record=await readable(exact);
     const chosen=valid?record:record?.head&&record.head.versionId!==ref.versionId?await readable({...record.head,contentDigest:null}):null;
     if(chosen)sources.set(`${chosen.ref.objectId}/${chosen.ref.versionId}`,chosen.ref);
     else gaps.push(valid?'一个仍有效的来源当前不可读':'一个失效来源没有可读的新版本');
    };
    const addWiki=async(ref:Pick<KnowledgeRef,'objectId'|'versionId'>,valid:boolean)=>{
     if(ref.objectId===subject.objectId)return;
     const current=await options.reader.currentWikiRef!(context,ref.objectId);
     if(current&&(valid?current.versionId===ref.versionId:current.versionId!==ref.versionId))wiki.set(current.objectId,current);
     else if(!valid){upstreamPending=true;gaps.push('一份上游 Wiki 仍未修好，暂不能替换');}
    };
    for(const dependency of target.dependencies.filter(item=>item.critical)){
     if(dependency.domain==='source')await addSource(dependency.ref,dependency.valid);
     else if(dependency.domain==='knowledge')await addWiki(dependency.ref,dependency.valid);
     else gaps.push('目标依赖非本地来源，不能自动修复');
     await check();
    }
    for(const related of task.request.relatedRefs){
     if(related.domain==='source'&&!sources.has(`${related.objectId}/${related.versionId}`))await addSource(related,false);
     else if(related.domain==='knowledge'&&!wiki.has(related.objectId))await addWiki(related,false);
    }
    run={...run,gaps:[...run.gaps,...new Set(gaps)].slice(0,100),
     discovery:{epoch:null,evidence:[],hasMore:false,question:`修复失效 Wiki：${target.title}`.slice(0,2000),queries:[target.title.slice(0,500)||'repair']}};
    const inputs={repairTarget:target.ref,selectedRefs:[...wiki.values()].slice(0,20),sourceRefs:[...sources.values()].slice(0,20)};
    if(saved.state!=='known')await saveStep(saved,{state:'known',readBytes:target.payloadBytes,cost:zero(currency)});
    if(upstreamPending)return finish('needs_evidence','上游 Wiki 仍待修复；本页暂不重编，未调用模型');
    if(!inputs.selectedRefs.length&&!inputs.sourceRefs.length)return finish('needs_evidence','没有可读的当前输入能支撑修复；未调用模型');
    await check();
    compilation=await step('compilation',WikiCompileRequestSchema.parse({question:run.discovery!.question,purpose:context.purpose,sourceEventIds:[],
     repairTarget:inputs.repairTarget,...inputs.selectedRefs.length?{selectedRefs:inputs.selectedRefs}:{},...inputs.sourceRefs.length?{sourceRefs:inputs.sourceRefs}:{},
     queries:run.discovery!.queries,limit:Math.max(1,inputs.selectedRefs.length),maxPages:1,
     budget:{maxModelCalls:Math.min(1,run.request.budget.maxModelCalls),maxReadBytes:Math.floor(run.request.budget.maxReadBytes*0.6),deadline:run.request.budget.deadline,
      maxMoney:run.request.budget.maxMoney}}));
   }
   if(compilation.state==='planned')await saveStep(compilation,{state:'running',cost:unknown()});
   const compiled=await options.compiler.compile(context,compilation.request,compilation.key,signal);run={...run,compilationId:compiled.id};
   await saveStep(compilation,{resultId:compiled.id,state:['reserved','running','outcome_unknown'].includes(compiled.state)?'outcome_unknown':compiled.state==='failed'?'failed':'known',cost:compiled.cost,readBytes:compiled.readUsage.sourceContentBytes+compiled.readUsage.wikiPayloadBytes});
   return finish(stateOf(compiled.state),compiled.reason);
  }catch(error){
   if(error&&typeof error==='object'&&'commitStatus'in error&&error.commitStatus==='unknown')throw error;
   const attempted=run.steps.find(x=>x.state==='running'||x.state==='outcome_unknown');
   if(attempted)run={...run,steps:run.steps.map(x=>x===attempted?{...x,state:'outcome_unknown',cost:unknown()}:x)};
   return finish(attempted?'outcome_unknown':signal.aborted||error instanceof KnowledgeError&&error.code==='TASK_CANCELLED'?'cancelled':'failed',
    error instanceof KnowledgeError?`${error.code}: ${error.message}`:'Repair coordination interrupted; inspect original child keys');
  }
 }
 const repairs=!!(options.reader.readRepairTarget&&options.reader.currentWikiRef&&options.reader.sourceRecord);
 const processor:MaintenanceProcessor={execution:options.execution,kinds:[...options.intake&&options.planner?['source_research' as const]:[],...options.reader.inspectWikiCandidate&&options.reader.assertReadEpoch&&options.reader.validateFrozenWiki?['relation_check' as const]:[],...repairs?['recompile' as const]:[]],async process(readContext,task,signal){
  const context=readContext as CapabilityContext;authorizeCapability(context,'maintenance:write');authorizeCapability(context,'maintenance:read');
  const repairTask=task.request.kind==='recompile',wikiTask=task.request.kind==='relation_check';
  if(repairTask&&(!repairs||!task.request.subjectRef||task.request.subjectRef.domain!=='knowledge'||task.request.sourceEventIds.length>0))
   throw new KnowledgeError('COORDINATION_TASK_UNSUPPORTED','An exact Wiki repair task is required',422);
  if(repairTask)return repair(context,task,signal);
  if(wikiTask?(!task.request.subjectRef||task.request.subjectRef.domain!=='knowledge'||task.request.sourceEventIds.length>0||!options.reader.inspectWikiCandidate||!options.reader.assertReadEpoch||!options.reader.validateFrozenWiki):
   task.request.kind!=='source_research'||task.request.sourceEventIds.length!==1||!options.intake||!options.planner)
   throw new KnowledgeError('COORDINATION_TASK_UNSUPPORTED','A source event or exact Wiki relation task is required',422);
  const initial:CoordinationRun={id:randomUUID(),request:{taskId:task.id,taskInputDigest:task.inputDigest,purpose:context.purpose,policyVersion:policy.version,
   sourceEventId:wikiTask?null:task.request.sourceEventIds[0],...wikiTask?{subjectRef:task.request.subjectRef!}:{},budget:{maxModelCalls:policy.budget.maxModelCalls,maxReadBytes:policy.budget.maxReadBytes,maxMoney:policy.budget.maxMoney,
    deadline:new Date(now().getTime()+policy.budget.timeoutMs).toISOString()}},state:'reserved',sourcePlanId:null,candidateRefs:[],discovery:null,readAccounting:'acknowledged_steps',judgmentIds:[],compilationId:null,steps:[],cost:zero(policy.budget.maxMoney?.currency??'USD'),readBytes:0,reason:'Reserved; no child dispatched',gaps:[],createdAt:now().toISOString(),completedAt:null};
  const reservation=await options.operations.reserve(context,digest({task:task.inputDigest,policyDigest}),initial);
  let run=reservation.result;
  if(!reservation.created&&!['reserved','running'].includes(run.state))return outcome(await visible(context,await reconcile(context,run)));
  const check=async()=>{signal.throwIfAborted();if(Date.parse(run.request.budget.deadline)<=now().getTime())throw new KnowledgeError('DEADLINE_EXPIRED','Coordination deadline elapsed',422);
   if(options.tasks){const current=await options.tasks.get(context,task.id);
    if(current?.cancelRequested)throw new KnowledgeError('TASK_CANCELLED','Maintenance cancellation was confirmed before another step',409);
    if(!current||current.state!=='running'||current.attemptId!==task.attemptId||current.leaseToken!==task.leaseToken)
     throw new KnowledgeError('TASK_LEASE_LOST','Another attempt owns this maintenance task',409);
   }};
  const refresh=()=>{run={...run,cost:sumCost(run.steps,run.request.budget.maxMoney?.currency??'USD'),readBytes:run.steps.reduce((n,x)=>n+x.readBytes,0)};
   if(run.readBytes>run.request.budget.maxReadBytes)throw new KnowledgeError('READ_BUDGET_EXCEEDED','Acknowledged child reads exceeded task budget',422);
  };
  const checkSpend=()=>{if(run.cost.modelCalls.state==='known'&&run.cost.modelCalls.value>run.request.budget.maxModelCalls)throw new KnowledgeError('MODEL_BUDGET_EXCEEDED','Child operations reported excess model calls',422);
   const money=run.request.budget.maxMoney;if(money&&run.cost.money.state==='known'&&(run.cost.money.amount>0&&run.cost.money.currency!==money.currency||run.cost.money.amount>money.amount+1e-9))throw new KnowledgeError('MONEY_BUDGET_EXCEEDED','Child operations reported excess money',422);};
  // Observed spend is persisted even if a provider violated its grant. Stop before another call.
  const checkpoint=async()=>{refresh();run=CoordinationRunSchema.parse({...run,state:'running'});await options.operations.checkpoint(context,run.id,run);checkSpend();};
  const grant=(kind:'planning'|'discovery'|'judgment'|'compilation',index=0):Budget=>{
   const parent=run.request.budget,pairs=options.judgments?policy.maxPairs:0,total=pairs+(wikiTask?1:2);
   const readFraction=kind==='planning'?0.2:kind==='discovery'?(wikiTask?0.4:0.2):kind==='judgment'?0.3/Math.max(1,pairs):pairs?0.3:0.6;
   const calls=kind==='planning'?Math.min(1,parent.maxModelCalls):kind==='compilation'?Math.min(1,Math.max(0,parent.maxModelCalls-(wikiTask?0:1))):
     kind==='judgment'?Math.min(1,Math.max(0,parent.maxModelCalls-(wikiTask?1:2)-index)):0;
   return {maxModelCalls:calls,maxReadBytes:Math.floor(parent.maxReadBytes*readFraction),deadline:parent.deadline,
    maxMoney:parent.maxMoney?{currency:parent.maxMoney.currency,amount:Math.floor(parent.maxMoney.amount/total*1_000_000)/1_000_000}:null};
  };
  const step=async(kind:CoordinationStep['kind'],ordinal:number,request:unknown)=>{
   const key=`coord:${run.id}:${kind}:${ordinal}`,old=run.steps.find(x=>x.key===key);if(old)return old;
   const value:CoordinationStep={kind,key,request:JSON.parse(JSON.stringify(request)),resultId:null,state:'planned',cost:zero(run.request.budget.maxMoney?.currency??'USD'),readBytes:0};
   run={...run,steps:[...run.steps,value]};await checkpoint();return value;
  };
  const saveStep=async(saved:CoordinationStep,changes:Partial<CoordinationStep>)=>{
   run={...run,steps:run.steps.map(x=>x.key===saved.key?{...x,...changes}:x)};await checkpoint();};
  const finish=async(state:CoordinationRun['state'],reason:string)=>{
   refresh();run=CoordinationRunSchema.parse({...run,state,reason,completedAt:now().toISOString()});await options.operations.finish(context,run.id,run);return outcome(await visible(context,run));};
  try{
   await check();await checkpoint();
   let researchQuestion:string,queries:string[],rightRef:KnowledgeRef;
   if(wikiTask){
    let saved=run.steps.find(x=>x.kind==='discovery');
    if(!saved||saved.state!=='known'){
     saved=await step('discovery',0,{subjectRef:run.request.subjectRef!,method:'wiki-identity-title-v1',maxCandidates:policy.maxCandidates,budget:grant('discovery')});
     let acknowledgedReadBytes=0;
     try{const found=await discoverFromWiki(options.reader as Parameters<typeof discoverFromWiki>[0],context,run.request.subjectRef!,
       {maxCandidates:policy.maxCandidates,queryLimit:policy.queryLimit,maxReadBytes:grant('discovery').maxReadBytes},check,bytes=>{acknowledgedReadBytes=bytes;});
      run={...run,candidateRefs:found.candidateRefs,discovery:found.discovery,gaps:[...run.gaps,
       'Discovery uses frozen Wiki titles and identities; conceptual links without lexical overlap may be missed',
       ...found.discovery.hasMore?['Candidate discovery is bounded; additional candidates remain unread']:[]]};
      await saveStep(saved,{state:'known',readBytes:found.readBytes,cost:zero(run.request.budget.maxMoney?.currency??'USD')});
     }catch(error){if(error&&typeof error==='object'&&'commitStatus'in error&&error.commitStatus==='unknown')throw error;
      if(acknowledgedReadBytes){run={...run,gaps:[...run.gaps,'Discovery stopped after acknowledged body reads; no provider received those inputs']};await saveStep(saved,{state:'failed',readBytes:acknowledgedReadBytes,cost:zero(run.request.budget.maxMoney?.currency??'USD')});}
      if(error instanceof KnowledgeError&&['NOT_FOUND','CANDIDATE_NOT_ADMITTED','SOURCE_FORBIDDEN','KNOWLEDGE_READ_BUDGET_EXCEEDED'].includes(error.code))
       return finish('needs_evidence','The periodic Wiki subject is unavailable or outside the read budget; no model dispatched');throw error;}
    }
    if(!run.discovery?.question||!run.discovery.queries?.length||!run.candidateRefs.length)
     throw new KnowledgeError('WIKI_DISCOVERY_INVALID','Frozen periodic discovery is incomplete',409);
    researchQuestion=run.discovery.question;queries=run.discovery.queries;rightRef=run.candidateRefs[0];
    if(run.candidateRefs.length<2)return finish('needs_evidence','Bounded discovery found no second readable Wiki; this is not a claim that no relation exists');
   }else{
   await options.intake!.get(context,run.request.sourceEventId!);
   const planning=await step('planning',0,SourcePlanRequestSchema.parse({sourceEventId:run.request.sourceEventId,purpose:context.purpose,methodVersion:policy.version,budget:grant('planning')}));
   if(planning.state==='planned')await saveStep(planning,{state:'running',cost:unknown()});
   const plan=await options.planner!.plan(context,planning.request,planning.key,signal);
   run={...run,sourcePlanId:plan.id};await saveStep(planning,{resultId:plan.id,state:['reserved','running','outcome_unknown'].includes(plan.state)?'outcome_unknown':plan.state==='failed'?'failed':'known',cost:plan.cost,readBytes:plan.readUsage.sourceContentBytes+plan.readUsage.wikiPayloadBytes});
   if(plan.state!=='planned'||!plan.proposal)return finish(stateOf(plan.state),`Source planning: ${plan.reason}`);
   await check();
   let discovery=run.steps.find(x=>x.kind==='discovery');
   if(!discovery||discovery.state!=='known'){
    discovery=await step('discovery',0,{queries:plan.proposal.queries,maxCandidates:policy.maxCandidates,budget:grant('discovery')});
    const candidates:KnowledgeRef[]=[],evidence:NonNullable<CoordinationRun['discovery']>['evidence']=[];
    let readBytes=0,epoch:number|null=null,hasMore=false;const limit=grant('discovery').maxReadBytes;
    for(const query of plan.proposal.queries){await check();const found=await options.reader.queryCandidates(context,{question:query,purpose:context.purpose,kinds:['wiki_page'],limit:policy.queryLimit,retrievalMethod:'wiki-lexical-v2'});
     if(epoch!==null&&epoch!==found.coverage.snapshot.publicationEpoch)throw new KnowledgeError('READSET_CHANGED','Knowledge changed during candidate discovery',409);
     epoch=found.coverage.snapshot.publicationEpoch;hasMore=hasMore||found.coverage.hasMore;
     for(const candidate of found.data.items){if(candidates.length>=policy.maxCandidates){hasMore=true;break;}
      if(candidates.some(ref=>ref.objectId===candidate.ref.objectId&&ref.versionId===candidate.ref.versionId))continue;
      if(candidate.payloadBytes>limit-readBytes){hasMore=true;continue;}
      let page;try{page=await options.reader.readCandidate(context,candidate,limit-readBytes);}catch(error){if(error instanceof KnowledgeError&&error.code==='CANDIDATE_NOT_ADMITTED')continue;throw error;}
      readBytes+=page.payloadBytes;candidates.push(page.ref);evidence.push({id:`candidate:${page.ref.objectId}`,kind:'wiki_page',ref:page.ref,title:page.title,locator:null,
       conditions:page.conditions,counterexamples:page.counterexamples,unknowns:page.unknowns,storageDigest:page.storageDigest,actualReadCoverage:[],sourceGroups:page.sourceGroups.map(id=>({id,status:'known',authority:'knowledge-revision-lineage'}))});
     }
     if(candidates.length>=policy.maxCandidates)break;
    }
    run={...run,candidateRefs:candidates,discovery:{epoch,evidence,hasMore},gaps:[...run.gaps,...hasMore?['Candidate discovery is bounded; additional candidates remain unread']:[]]};
    await saveStep(discovery,{state:'known',readBytes,cost:zero(run.request.budget.maxMoney?.currency??'USD')});
   }
   researchQuestion=plan.proposal.question!;queries=plan.proposal.queries;
   const source=plan.evidence[0]?.ref;if(!source)throw new KnowledgeError('SOURCE_PLAN_READSET_INVALID','Planning has no exact source receipt',409);rightRef=source;
   }
   const pairRefs=options.judgments?run.candidateRefs.slice(wikiTask?1:0,(wikiTask?1:0)+policy.maxPairs):[];
   for(const [index,left] of pairRefs.entries()){
    await check();const right=rightRef;
    const saved=await step('judgment',index,RelationJudgmentRequestSchema.parse({left,right,purpose:context.purpose,rubricVersion:task.request.rubricVersion,questions,budget:grant('judgment',index)}));
    if(saved.state==='planned')await saveStep(saved,{state:'running',cost:unknown()});
    const judged=await options.judgments!.judge(context,saved.request,saved.key,signal);
    run={...run,judgmentIds:[...new Set([...run.judgmentIds,judged.id])]};await saveStep(saved,{resultId:judged.id,state:['reserved','running','outcome_unknown'].includes(judged.state)?'outcome_unknown':judged.state==='failed'?'failed':'known',cost:judged.cost,readBytes:judged.readUsage.sourceContentBytes+judged.readUsage.wikiPayloadBytes});
    if(['reserved','running','outcome_unknown'].includes(judged.state))return finish('outcome_unknown','An original-key judgment needs reconciliation; compilation was not dispatched');
   }
   await check();const compilation=await step('compilation',0,WikiCompileRequestSchema.parse({question:researchQuestion,purpose:context.purpose,sourceEventIds:wikiTask?[]:[run.request.sourceEventId!],selectedRefs:run.candidateRefs,queries,judgmentIds:run.judgmentIds,limit:Math.max(policy.queryLimit,run.candidateRefs.length),maxPages:1,budget:grant('compilation')}));
   if(compilation.state==='planned')await saveStep(compilation,{state:'running',cost:unknown()});
   const compiled=await options.compiler.compile(context,compilation.request,compilation.key,signal);run={...run,compilationId:compiled.id};
   await saveStep(compilation,{resultId:compiled.id,state:['reserved','running','outcome_unknown'].includes(compiled.state)?'outcome_unknown':compiled.state==='failed'?'failed':'known',cost:compiled.cost,readBytes:compiled.readUsage.sourceContentBytes+compiled.readUsage.wikiPayloadBytes});
   return finish(stateOf(compiled.state),compiled.state==='no_change'?'Compiler proposed no change; independent no-change review remains required':compiled.reason);
  }catch(error){
   if(error&&typeof error==='object'&&'commitStatus'in error&&error.commitStatus==='unknown')throw error;
   const attempted=run.steps.find(x=>x.state==='running'||x.state==='outcome_unknown');
   if(attempted)run={...run,steps:run.steps.map(x=>x===attempted?{...x,state:'outcome_unknown',cost:unknown()}:x)};
   return finish(attempted?'outcome_unknown':signal.aborted||error instanceof KnowledgeError&&error.code==='TASK_CANCELLED'?'cancelled':'failed',error instanceof KnowledgeError?`${error.code}: ${error.message}`:'Coordination interrupted; inspect original child keys');
  }
 }};
 return {...processor,get,byTask};
}
