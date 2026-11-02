import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {CoordinationRun,SourcePlanResult,Cost} from '@commerce/knowledge-contracts';
import {createCoordinationProcessor} from '../src/coordination.ts';
import type {CapabilityContext} from '../src/sources.ts';
const cost:Cost={modelCalls:{state:'known',value:1},tokens:{state:'known',value:10},money:{state:'known',amount:0.1,currency:'USD',source:'synthetic_stored_receipt'}};
for(const childState of ['failed','refused','needs_evidence'] as const){
 test(`readonly reconciliation preserves a planning ${childState} after the parent checkpoint is lost`,async()=>{
  const now=new Date().toISOString(),scope={projectId:'synthetic',spaceId:'space'},purpose='exploration_reading',taskId=randomUUID(),planId=randomUUID(),eventId=randomUUID();
  const context:CapabilityContext={scope,purpose,principal:{id:'synthetic',clientInstallationId:'synthetic-install',projectId:'synthetic',spaceIds:['space'],purposes:[purpose]},authorization:{actions:['maintenance:read','maintenance:write'],adapterIds:[],rightsPolicyIds:[]}};
  const budget={maxModelCalls:3,maxReadBytes:10000,maxMoney:{amount:1,currency:'USD'},deadline:now};
  const child:SourcePlanResult={id:planId,request:{sourceEventId:eventId,purpose,methodVersion:'fixture',budget},state:childState,evidence:[],proposal:null,provenance:'model_proposed',raw:{fixture:true},readUsage:{sourceContentBytes:25,wikiPayloadBytes:0,preparedInputBytes:100,maxReadBytes:10000},inputFingerprint:'a'.repeat(64),cost,provider:null,reason:'Synthetic terminal planning receipt',createdAt:now,completedAt:now};
  const uncertain:Cost={modelCalls:{state:'unknown',reason:'lost parent checkpoint'},tokens:{state:'unknown',reason:'lost parent checkpoint'},money:{state:'unknown',reason:'lost parent checkpoint'}};
  let run:CoordinationRun={id:randomUUID(),request:{taskId,taskInputDigest:'b'.repeat(64),purpose,policyVersion:'fixture',sourceEventId:eventId,budget},state:'outcome_unknown',sourcePlanId:null,candidateRefs:[],judgmentIds:[],compilationId:null,steps:[{kind:'planning',key:'original-plan-key',request:child.request,state:'running',resultId:null,cost:uncertain,readBytes:0}],readAccounting:'acknowledged_steps',cost:uncertain,readBytes:0,reason:'Synthetic interrupted parent',gaps:[],createdAt:now,completedAt:now};
  let dispatched=0;
  const processor=createCoordinationProcessor({reader:{async queryCandidates(){assert.fail('Reconcile must not query or dispatch');},async readCandidate(){assert.fail();}},intake:{async get(){return {} as never;}},
   planner:{async get(){return child;},async lookup(_context,key){assert.equal(key,'original-plan-key');return child;},async plan(){dispatched++;assert.fail('Never rerun planner');}},
   compiler:{async get(){assert.fail();},async lookup(){assert.fail();},async compile(){dispatched++;assert.fail();}},
   operations:{async reserve(){assert.fail();},async checkpoint(){assert.fail();},async finish(){assert.fail();},async get(){return run;},async byTask(){return run;},async reconcile(_context,id,next){assert.equal(id,run.id);run=next;return next;}},
   policy:{version:'fixture',providerFingerprint:'fixture',maxPairs:0,maxCandidates:1,queryLimit:1,budget:{maxModelCalls:3,maxReadBytes:10000,maxMoney:{amount:1,currency:'USD'},timeoutMs:30000}},execution:'local_deterministic'});
  const recovered=await processor.byTask(context,taskId);assert.equal(recovered!.state,childState);assert.equal(recovered!.sourcePlanId,planId);assert.deepEqual(recovered!.steps[0].cost,cost);assert.deepEqual(recovered!.cost.modelCalls,cost.modelCalls);assert.equal(recovered!.cost.money.state,'known');assert.equal(recovered!.readBytes,25);assert.equal(dispatched,0);
 });
}

test('a reported child overrun is durably retained and stops all later calls',async()=>{
 const now=new Date().toISOString(),scope={projectId:'synthetic',spaceId:'space'},purpose='exploration_reading',taskId=randomUUID(),eventId=randomUUID();
 const context:CapabilityContext={scope,purpose,principal:{id:'synthetic',clientInstallationId:'synthetic-install',projectId:'synthetic',spaceIds:['space'],purposes:[purpose]},authorization:{actions:['maintenance:read','maintenance:write'],adapterIds:[],rightsPolicyIds:[]}};
 const expensive:Cost={...cost,modelCalls:{state:'known',value:5},money:{state:'known',amount:2,currency:'USD',source:'synthetic_reported_overrun'}};
 const child:SourcePlanResult={id:randomUUID(),request:{sourceEventId:eventId,purpose,methodVersion:'fixture',budget:{maxModelCalls:1,maxReadBytes:2000,maxMoney:{amount:0.5,currency:'USD'},deadline:new Date(Date.now()+30000).toISOString()}},state:'failed',evidence:[],proposal:null,provenance:'model_proposed',raw:{fixture:true},readUsage:{sourceContentBytes:25,wikiPayloadBytes:0,preparedInputBytes:100,maxReadBytes:2000},inputFingerprint:'a'.repeat(64),cost:expensive,provider:null,reason:'Synthetic provider exceeded its grant',createdAt:now,completedAt:now};
 let stored:CoordinationRun|null=null;const checkpoints:CoordinationRun[]=[];
 const processor=createCoordinationProcessor({reader:{async queryCandidates(){assert.fail('No next step after overspend');},async readCandidate(){assert.fail();}},intake:{async get(){return {} as never;}},planner:{async get(){return child;},async lookup(){return child;},async plan(){return child;}},
  compiler:{async get(){assert.fail();},async lookup(){assert.fail();},async compile(){assert.fail('Do not dispatch compiler after overspend');}},
  operations:{async reserve(_context,_digest,initial){stored=initial;return {created:true,result:initial};},async checkpoint(_context,_id,next){stored=structuredClone(next);checkpoints.push(stored);},async finish(_context,_id,next){stored=structuredClone(next);},async get(){return stored;},async byTask(){return stored;}},
  policy:{version:'fixture',providerFingerprint:'fixture',maxPairs:0,maxCandidates:1,queryLimit:1,budget:{maxModelCalls:2,maxReadBytes:10000,maxMoney:{amount:1,currency:'USD'},timeoutMs:30000}},execution:'local_deterministic'});
 const result=await processor.process(context,{id:taskId,request:{kind:'source_research',subjectRef:null,sourceEventIds:[eventId],relatedRefs:[],methodVersion:'fixture',rubricVersion:'fixture',reason:'Synthetic'},trigger:{stream:'manual',eventKey:'fixture',sequence:0,ref:null,sourceEventId:eventId},inputDigest:'b'.repeat(64),state:'running',attempts:1,attemptId:randomUUID(),leaseToken:1,cancelRequested:false,dispatchState:'not_dispatched',outcome:null,createdAt:now,updatedAt:now},new AbortController().signal);
 assert.equal(result.state,'failed');assert.deepEqual(result.cost.modelCalls,{state:'known',value:5});
 assert.ok(checkpoints.some(x=>x.cost.modelCalls.state==='known'&&x.cost.modelCalls.value===5));
 assert.equal((stored as CoordinationRun|null)?.state,'failed');assert.equal((stored as CoordinationRun|null)?.sourcePlanId,child.id);
});
