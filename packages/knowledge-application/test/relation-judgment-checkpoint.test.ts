import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import type {DecisionBatchResult,RelationJudgment,RelationJudgmentRequest} from '@commerce/knowledge-contracts';
import {createRelationJudgmentApplication,type DecisionProvider,type JudgmentOperationPort} from '../src/relation-judgment.ts';
import type {CapabilityContext} from '../src/sources.ts';

function fixture(options:{failFinish?:boolean;revokeAt?:'provider'|'ackCheckpoint';invalidWire?:boolean;invalidCost?:boolean;answer?:DecisionBatchResult['answers'][number]}){
 const scope={projectId:'synthetic-project',spaceId:'synthetic-space'},purpose='exploration_reading';
 const context:CapabilityContext={scope,purpose,principal:{id:'synthetic-principal',clientInstallationId:'synthetic-installation',projectId:scope.projectId,spaceIds:[scope.spaceId],purposes:[purpose]},authorization:{actions:['judgments:read','judgments:write'],adapterIds:[],rightsPolicyIds:[]}};
 const left={...scope,domain:'knowledge' as const,objectId:randomUUID(),versionId:randomUUID(),contentDigest:'a'.repeat(64)};
 const right={...left,objectId:randomUUID(),versionId:randomUUID()};
 let clock=Date.now(),calls=0,revoked=false,stored:RelationJudgment|null=null,gets=0,checkpoints=0;
 const request:RelationJudgmentRequest={left,right,purpose,rubricVersion:'synthetic-rubric-v1',questions:[{id:'same',type:'predicate',instructions:'Are these about the same item?'}],budget:{maxModelCalls:1,maxReadBytes:100_000,maxMoney:null,deadline:new Date(clock+60_000).toISOString()}};
 const batch:DecisionBatchResult={modelReturned:'synthetic-model-v1',answers:[options.answer??{id:'same',type:'predicate',state:'answered',value:null,probability:0.8,distribution:null,confidence:null,reason:null}],inputTokens:5,outputTokens:2,requestId:null,raw:{fixture:'acknowledged'}};
 const reader={async readWikiExactBounded(_context:unknown,ref:typeof left,_maxBytes:number){return {ref,title:'Synthetic Wiki',body:'same item',conditions:[],counterexamples:[],unknowns:[],citations:[],sourceGroups:[],storageDigest:'b'.repeat(64),payloadBytes:16,admitted:true};},
  async validateFrozenWiki(){if(revoked)throw new KnowledgeError('ASK_READSET_INVALIDATED','Synthetic source revoked',409);},
  async sourceRecord(){throw new Error('Unexpected source metadata read');},async sourceContentBounded(){throw new Error('Unexpected source body read');}};
 const operations:JudgmentOperationPort={
  async reserve(_context,key,_digest,_request,initial){assert.equal(key,'synthetic-key');if(stored)return {created:false,result:structuredClone(stored)};stored=structuredClone(initial);return {created:true,result:initial};},
  async start(){if(!stored||stored.state!=='reserved')return false;stored={...stored,state:'running'};return true;},
  async checkpoint(_context,_id,result){checkpoints++;stored=structuredClone(result);if(options.revokeAt==='ackCheckpoint'&&result.batch)revoked=true;},
  async finish(_context,_id,result){if(options.failFinish)throw new Error('Synthetic finish write failed');stored=structuredClone(result);},
  async get(){gets++;if(!stored)return null;if((stored.state==='reserved'||stored.state==='running')&&Date.parse(stored.request.budget.deadline)<=clock)stored={...stored,state:'outcome_unknown',reason:'Synthetic expiry',completedAt:new Date(clock).toISOString()};return structuredClone(stored);},
  async lookup(){return stored?structuredClone(stored):null;},
 };
 const provider:DecisionProvider={id:'synthetic-provider',version:'v1',model:'synthetic-requested',execution:'local_deterministic',async decide(){calls++;if(options.revokeAt==='provider')revoked=true;return {result:options.invalidWire?{...structuredClone(batch),modelReturned:''}:structuredClone(batch),cost:options.invalidCost?{money:null} as any:{modelCalls:{state:'known',value:1},tokens:{state:'known',value:7},money:{state:'known',amount:0,currency:'USD',source:'synthetic-cost'}}};}};
 const app=createRelationJudgmentApplication({reader:reader as any,operations,provider,now:()=>new Date(clock)});
 return {app,context,request,advance(){clock+=61_000;},get stored(){return stored;},get calls(){return calls;},get gets(){return gets;},get checkpoints(){return checkpoints;}};
}

test('acknowledged result and known cost survive failed finish; duplicate key expires without redispatch',async()=>{
 const f=fixture({failFinish:true});
 await assert.rejects(f.app.judge(f.context,f.request,'synthetic-key'),/Synthetic finish write failed/);
 assert.equal(f.stored?.state,'running');
 assert.deepEqual(f.stored?.batch?.raw,{fixture:'acknowledged'});
 assert.equal(f.stored?.provider?.modelReturned,'synthetic-model-v1');
 assert.deepEqual(f.stored?.cost.modelCalls,{state:'known',value:1});
 assert.ok(f.checkpoints>=3);
 f.advance();
 const replay=await f.app.judge(f.context,f.request,'synthetic-key');
 assert.equal(replay.state,'outcome_unknown');
 assert.deepEqual(replay.batch?.raw,{fixture:'acknowledged'});
 assert.equal(f.calls,1);
 assert.ok(f.gets>0,'duplicate key must use get to trigger expiry');
});
test('known cost checkpoints even when the acknowledged batch is malformed and finish fails',async()=>{
 const f=fixture({invalidWire:true,failFinish:true});
 await assert.rejects(f.app.judge(f.context,f.request,'synthetic-key'),/Synthetic finish write failed/);
 assert.equal(f.stored?.state,'running');
 assert.equal(f.stored?.batch,null);
 assert.deepEqual(f.stored?.cost.modelCalls,{state:'known',value:1});
 assert.equal(f.calls,1);
});
for(const revokeAt of ['provider','ackCheckpoint'] as const){
 test(`first POST revalidates read rights after ${revokeAt} revocation before disclosing result`,async()=>{
  const f=fixture({revokeAt});
  await assert.rejects(f.app.judge(f.context,f.request,'synthetic-key'),error=>error instanceof KnowledgeError&&error.code==='ASK_READSET_INVALIDATED'&&error.status===409);
  assert.equal(f.stored?.state,'failed');
  assert.deepEqual(f.stored?.batch?.raw,{fixture:'acknowledged'});
  assert.deepEqual(f.stored?.cost.modelCalls,{state:'known',value:1});
  assert.equal(f.calls,1);
  assert.ok(f.gets>0,'the result must pass through the read gate');
 });
}
test('invalid non-answer shape cannot bypass common checks; known cost remains recorded',async()=>{
 const f=fixture({answer:{id:'same',type:'predicate',state:'refused',value:1,probability:0.8,distribution:null,confidence:0.9,reason:'Synthetic refusal'}});
 const result=await f.app.judge(f.context,f.request,'synthetic-key');
 assert.equal(result.state,'failed');
 assert.match(result.reason,/JUDGMENT_ANSWER_SHAPE_INVALID/);
 assert.deepEqual(result.cost.modelCalls,{state:'known',value:1});
});
for(const state of ['not_evaluated','provider_error'] as const){
 test(`${state} cannot retain stale probability or confidence`,async()=>{
  const f=fixture({answer:{id:'same',type:'predicate',state,value:null,probability:0.8,distribution:null,confidence:0.2,reason:'Synthetic non-answer'}});
  const result=await f.app.judge(f.context,f.request,'synthetic-key');
  assert.equal(result.state,'failed');
  assert.match(result.reason,/JUDGMENT_ANSWER_SHAPE_INVALID/);
 });
}
test('predicate insufficient evidence requires every decision field null',async()=>{
 const f=fixture({answer:{id:'same',type:'predicate',state:'insufficient_evidence',value:null,probability:null,distribution:null,confidence:0.2,reason:'Synthetic gap'}});
 const result=await f.app.judge(f.context,f.request,'synthetic-key');
 assert.equal(result.state,'failed');
 assert.match(result.reason,/JUDGMENT_ANSWER_SHAPE_INVALID/);
});
test('valid refusal keeps all decision fields null and remains a refusal',async()=>{
 const f=fixture({answer:{id:'same',type:'predicate',state:'refused',value:null,probability:null,distribution:null,confidence:null,reason:'Synthetic refusal'}});
 const result=await f.app.judge(f.context,f.request,'synthetic-key');
 assert.equal(result.state,'refused');
 assert.equal(result.batch?.answers[0]?.value,null);
 assert.equal(result.batch?.answers[0]?.probability,null);
});
test('nonpredicate probability is invalid, while explicit insufficient-evidence choice retains its option',async()=>{
 const choice={id:'same',type:'choice' as const,instructions:'Relation?',options:[{value:'supports',description:'Supports'},{value:'insufficient_evidence',description:'Missing evidence'}]};
 const answer={id:'same',type:'choice' as const,state:'insufficient_evidence' as const,value:'insufficient_evidence',probability:0.8,distribution:{supports:0.2,insufficient_evidence:0.8},confidence:0.5,reason:null};
 const invalid=fixture({answer});invalid.request.questions=[choice];
 const failed=await invalid.app.judge(invalid.context,invalid.request,'synthetic-key');
 assert.equal(failed.state,'failed');assert.match(failed.reason,/JUDGMENT_PROBABILITY_INVALID/);
 const valid=fixture({answer:{...answer,probability:null}});valid.request.questions=[choice];
 const result=await valid.app.judge(valid.context,valid.request,'synthetic-key');
 assert.equal(result.state,'needs_evidence');
 assert.equal(result.batch?.answers[0]?.value,'insufficient_evidence');
 assert.equal(result.batch?.answers[0]?.probability,null);
});

test('malformed accounting after dispatch remains unknown instead of a retryable-looking failure',async()=>{
 const f=fixture({invalidCost:true});
 const result=await f.app.judge(f.context,f.request,'synthetic-key');
 assert.equal(result.state,'outcome_unknown');
 assert.equal(result.cost.money.state,'unknown');
 assert.equal(result.cost.modelCalls.state,'unknown');
 const replay=await f.app.judge(f.context,f.request,'synthetic-key');
 assert.equal(replay.id,result.id);assert.equal(f.calls,1);
});
