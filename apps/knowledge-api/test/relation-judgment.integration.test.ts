import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import type {Server} from 'node:http';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {seedKnowledgeSyntheticFixture} from '../../../scripts/runtime/knowledge-synthetic-fixture.ts';
import {createKnowledgeStore} from '../../../packages/knowledge/src/store.ts';
import {digest} from '../../../packages/knowledge/src/utils.ts';
import {createKnowledgeApi} from '../src/index.ts';
import {createKnowledgeClient} from '../../../packages/knowledge-client/src/index.ts';
import {decodeJevDecision,encodeJevDecision} from '../../../packages/knowledge-application/src/decision-codecs.ts';
import type {DecisionProvider} from '../../../packages/knowledge-application/src/relation-judgment.ts';
import type {RelationJudgmentRequest} from '../../../packages/knowledge-contracts/src/index.ts';
const url=readTestDatabase(),dbTest=url?test:test.skip;
const zero={modelCalls:{state:'known' as const,value:0},tokens:{state:'known' as const,value:0},money:{state:'known' as const,amount:0,currency:'USD',source:'synthetic-local-fixture'}};
dbTest('bounded pair judgments retain typed answers, original-source overlap and uncertain costs without publishing relations',async()=>{
 const admin=new pg.Pool({connectionString:url!,max:2}),schema=`judgment_api_${randomUUID().replaceAll('-','')}`;
 await admin.query(`CREATE SCHEMA "${schema}"`);const pool=new pg.Pool({connectionString:url!,max:8,options:`-c search_path=${schema}`});let server:Server|undefined;
 try{
  const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-judgment-${randomUUID()}`),purpose='exploration_reading',scope={projectId:seed.projectId,spaceId:seed.spaceId};
  const root=(await createKnowledgeStore(pool).get(seed.projectId,seed.root))!.revision;
  let calls=0,mode:'answer'|'insufficient'|'predicate_insufficient'|'missing'|'throw'|'unknown_cost'|'refuse'|'partial_refuse'='answer';
  const provider:DecisionProvider={id:'synthetic-decision-provider',version:'fixture-v1',model:'synthetic-no-model',execution:'local_deterministic',supportsMoneyLimit:true,async decide(input){calls++;
   const checkpoint=(await pool.query('SELECT result FROM ccl_knowledge_relation_judgments WHERE id=$1',[input.operationId])).rows[0].result;assert.equal(checkpoint.cost.money.state,'unknown');assert.equal(checkpoint.evidence.length,2);
   assert.ok(input.state.left.body);assert.ok(input.state.right.body);encodeJevDecision('synthetic-no-model',JSON.stringify(input.state),input.questions);
   if(mode==='throw')throw new Error('Synthetic lost provider acknowledgement');
   const relation=mode==='insufficient'?'insufficient_evidence':'challenges';
   const raw={model:'synthetic-decision-returned-v1',answers:{same_subject:{type:'noul',noul:0.8},relation:{type:'choice',choice:relation,confidence:0.6,probabilities:relation==='challenges'?{supports:0.1,challenges:0.8,insufficient_evidence:0.1}:{supports:0.1,challenges:0.1,insufficient_evidence:0.8}}},usage:{input_tokens:100,output_tokens:20}};
   const result=decodeJevDecision(raw,input.questions,'synthetic-request');
   if(mode==='predicate_insufficient')result.answers[0]={...result.answers[0],state:'insufficient_evidence',value:null,probability:null,distribution:null,confidence:null,reason:'Synthetic evidence lacks the required shared condition'};
   if(mode==='missing')result.answers=result.answers.slice(0,1);
   if(mode==='partial_refuse')result.answers[0]={...result.answers[0],state:'refused',value:null,probability:null,distribution:null,confidence:null,reason:'Synthetic one-question refusal'};
   if(mode==='refuse')result.answers=result.answers.map(answer=>({...answer,state:'refused',value:null,probability:null,distribution:null,confidence:null,reason:'Synthetic refusal'}));
   input.state.left.ref.projectId='provider-mutated-copy';input.budget.maxModelCalls=999;
   return {result,cost:mode==='unknown_cost'?{...zero,money:{state:'unknown',reason:'Synthetic missing billing receipt'}}:zero};}};
  const token=`synthetic-${randomUUID()}-${randomUUID()}`,api=await createKnowledgeApi({pool,token,port:0,principal:seed.principal,writerGrant:seed.writerGrant,decisionProvider:provider,
   capabilities:{...seed.authorization,actions:[...seed.authorization.actions,'judgments:read','judgments:write','sources:revoke']}});
  server=await api.listen();const address=server.address();assert.ok(address&&typeof address!=='string');const client=createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope,headers:{Authorization:`Bearer ${token}`}});
  const request:RelationJudgmentRequest={left:{...scope,domain:'knowledge',...root.ref,contentDigest:digest(root)},right:seed.source.ref,purpose,rubricVersion:'synthetic-propositions-v1',
   questions:[{id:'same_subject',type:'predicate',instructions:'两段合成主张是否讨论相同对象与结果？'},{id:'relation',type:'choice',instructions:'条件一致时右侧对左侧是什么关系？',options:[{value:'supports',description:'支持'},{value:'challenges',description:'挑战'},{value:'insufficient_evidence',description:'缺证，不能判断'}]}],
   budget:{maxModelCalls:0,maxReadBytes:100_000,maxMoney:{amount:0,currency:'USD'},deadline:new Date(Date.now()+120_000).toISOString()}};
  const counts=async()=>({deps:(await pool.query('SELECT count(*)::int n FROM ccl_knowledge_deps')).rows[0].n,pubs:(await pool.query('SELECT count(*)::int n FROM ccl_knowledge_publications')).rows[0].n});const before=await counts();
  const first=(await client.judgeRelation(request,{idempotencyKey:'pair-one',purpose})).data;assert.equal(first.state,'answered');assert.equal(first.sourceRelation,'same_original');assert.equal(first.resolution,'review');
  assert.equal(first.batch?.answers[0].value,null);assert.equal(first.batch?.answers[0].probability,0.8);assert.equal(first.batch?.answers[1].value,'challenges');assert.deepEqual(first.batch?.raw,{model:'synthetic-decision-returned-v1',answers:{same_subject:{type:'noul',noul:0.8},relation:{type:'choice',choice:'challenges',confidence:0.6,probabilities:{supports:0.1,challenges:0.8,insufficient_evidence:0.1}}},usage:{input_tokens:100,output_tokens:20}});
  assert.ok(first.evidence.every(item=>item.ref.projectId===seed.projectId));assert.equal(calls,1);assert.equal((await client.judgeRelation(request,{idempotencyKey:'pair-one',purpose})).data.id,first.id);assert.equal(calls,1);
  assert.equal((await client.judgmentLookup('pair-one',purpose)).data.state,'known');
  mode='insufficient';const insufficient=(await client.judgeRelation(request,{idempotencyKey:'pair-insufficient',purpose})).data;assert.equal(insufficient.state,'needs_evidence');assert.equal(insufficient.batch?.answers[1].state,'insufficient_evidence');
  mode='predicate_insufficient';const predicateInsufficient=(await client.judgeRelation(request,{idempotencyKey:'pair-predicate-insufficient',purpose})).data;assert.equal(predicateInsufficient.state,'needs_evidence');assert.equal(predicateInsufficient.batch?.answers[0].probability,null);
  mode='missing';const missing=(await client.judgeRelation(request,{idempotencyKey:'pair-missing',purpose})).data;assert.equal(missing.state,'failed');assert.match(missing.reason,/ANSWER_SET_INVALID/);
  mode='refuse';assert.equal((await client.judgeRelation(request,{idempotencyKey:'pair-refused',purpose})).data.state,'refused');
  mode='partial_refuse';assert.equal((await client.judgeRelation(request,{idempotencyKey:'pair-partial-refused',purpose})).data.state,'needs_evidence');
  mode='unknown_cost';const unknownCost=(await client.judgeRelation(request,{idempotencyKey:'pair-cost',purpose})).data;assert.equal(unknownCost.state,'outcome_unknown');assert.ok(unknownCost.batch);
  mode='throw';const unknown=(await client.judgeRelation(request,{idempotencyKey:'pair-unknown',purpose})).data;assert.equal(unknown.state,'outcome_unknown');const beforeReplay=calls;await client.judgeRelation(request,{idempotencyKey:'pair-unknown',purpose});assert.equal(calls,beforeReplay);
  provider.execution='external';const blocked=(await client.judgeRelation({...request,budget:{...request.budget,maxModelCalls:1,maxMoney:{amount:1,currency:'USD'}}},{idempotencyKey:'pair-no-disclosure',purpose})).data;assert.equal(blocked.state,'failed');assert.match(blocked.reason,/DISCLOSURE_PERMISSION_REQUIRED/);assert.equal(calls,beforeReplay);
  await assert.rejects(client.judgeRelation({...request,left:{...request.left,spaceId:'other-space'}},{idempotencyKey:'foreign-pair',purpose}));
  assert.deepEqual(await counts(),before,'judgment answers never create formal knowledge relations or publications');
  await client.revokeSource(seed.source.ref,{expectedGeneration:1,contentDigest:seed.source.ref.contentDigest},{idempotencyKey:'revoke-judgment-source',purpose});await assert.rejects(client.judgment(first.id,purpose));await assert.rejects(client.judgeRelation(request,{idempotencyKey:'pair-one',purpose}));assert.equal(calls,beforeReplay);
 }finally{if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
