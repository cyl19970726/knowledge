import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import type {AskRequest, AskResult} from '../../../packages/knowledge-contracts/src/index.ts';
import type {ReadContext} from '../../../packages/knowledge-application/src/index.ts';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {migrateKnowledge} from '../../../packages/knowledge/src/migrations.ts';
import {rotateKnowledgeWriterAuthority} from '../../../packages/knowledge/src/writer-authority.ts';
import {createPgKnowledgeAnswers,migrateKnowledgeAnswers} from '../../../packages/adapters/knowledge-service/src/ask.ts';

const databaseUrl=readTestDatabase(),dbTest=databaseUrl?test:test.skip;
const hasCode=(code:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&error.code===code;

async function fixture(run:(input:{pool:pg.Pool;context:ReadContext;grant:Awaited<ReturnType<typeof rotateKnowledgeWriterAuthority>>})=>Promise<void>) {
  const admin=new pg.Pool({connectionString:databaseUrl!,max:2});
  const schema=`ccl_ask_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString:databaseUrl!,max:6,options:`-c search_path=${schema}`});
  try {
    await migrateKnowledge(pool);
    await migrateKnowledgeAnswers(pool);
    const projectId=`synthetic-${randomUUID()}`;
    const grant=await rotateKnowledgeWriterAuthority(pool,projectId,null,{ownerId:'ask-ledger-test',mode:'active'});
    const context:ReadContext={scope:{projectId,spaceId:'ask-space'},purpose:'exploration_reading',
      principal:{id:'ask-principal',clientInstallationId:'ask-test',projectId,
        spaceIds:['ask-space','other-space'],purposes:['exploration_reading','other-purpose']}};
    await run({pool,context,grant});
  } finally {
    await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();
  }
}

function request(purpose='exploration_reading'):AskRequest {
  return {question:'Which exact knowledge applies?',purpose,limit:5,maxPages:2,includeSourceContent:false,
    budget:{maxModelCalls:1,maxReadBytes:100_000,deadline:new Date(Date.now()+3600_000).toISOString(),maxMoney:null}};
}
function initial(input:AskRequest,id=randomUUID()):AskResult {
  return {id,question:input.question,purpose:input.purpose,state:'reserved',claims:[],evidence:[],excluded:[],
    coverage:{scopeDescription:'synthetic ask scope',returned:0,loaded:0,hasMore:false,nextCursor:null,
      completeness:'unknown',omittedReasons:['Research has not started'],snapshot:{publicationEpoch:null,consistency:'single_scope_snapshot'}},
    readsetFingerprint:'0'.repeat(64),cost:{modelCalls:{state:'known',value:0},
      tokens:{state:'known',value:0},money:{state:'known',amount:0,currency:'USD',source:'no_provider_call'}},
    provider:null,reason:'Research reserved',gaps:[],createdAt:new Date().toISOString(),completedAt:null};
}

dbTest('Ask reservation is atomic and purpose scoped; CAS executes once', {timeout:60_000},async()=>fixture(async({pool,context,grant})=>{
  const ledger=createPgKnowledgeAnswers(pool,grant),input=request(),key=randomUUID(),digest='a'.repeat(64),first=initial(input);
  const [a,b]=await Promise.all([ledger.reserve(context,key,digest,input,first),
    ledger.reserve(context,key,digest,input,initial(input))]);
  assert.equal([a,b].filter(item=>item.created).length,1);
  assert.equal(a.result.id,b.result.id);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM ccl_knowledge_answers')).rows[0].n),1);
  assert.equal((await ledger.lookup(context,key))?.id,a.result.id);
  assert.equal(await ledger.lookup(context,randomUUID()),null,'missing key has unknown outcome');
  assert.equal(await ledger.lookup({...context,purpose:'other-purpose'},key),null);
  assert.equal(await ledger.lookup({...context,scope:{...context.scope,spaceId:'other-space'}},key),null);
  assert.equal(await ledger.lookup({...context,principal:{...context.principal,id:'other-principal'}},key),null);
  assert.equal(await ledger.lookup({...context,scope:{...context.scope,projectId:'other-project'},
    principal:{...context.principal,projectId:'other-project'}},key),null);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM ccl_knowledge_answers')).rows[0].n),1,
    'lookup never creates an answer');
  await assert.rejects(ledger.reserve(context,key,'b'.repeat(64),input,initial(input)),hasCode('IDEMPOTENCY_CONFLICT'));
  const changed={...input,question:'A different question with the same supplied digest'};
  await assert.rejects(ledger.reserve(context,key,digest,changed,initial(changed)),hasCode('IDEMPOTENCY_CONFLICT'));
  assert.equal(await ledger.get({...context,purpose:'other-purpose'},a.result.id),null);
  assert.equal(await ledger.get({...context,scope:{...context.scope,spaceId:'other-space'}},a.result.id),null);
  assert.equal(await ledger.get({...context,principal:{...context.principal,id:'other-principal'}},a.result.id),null);
  await assert.rejects(ledger.checkpoint(context,a.result.id,{...a.result,state:'running'}),hasCode('ASK_NOT_RUNNING'));
  await assert.rejects(ledger.finish(context,a.result.id,{...a.result,state:'failed'}),hasCode('ASK_NOT_RUNNING'));
  const [started,duplicate]=await Promise.all([ledger.start(context,a.result.id),ledger.start(context,a.result.id)]);
  assert.deepEqual([started,duplicate].sort(),[false,true]);
  assert.equal((await ledger.get(context,a.result.id))?.state,'running');
  assert.equal((await ledger.get(context,a.result.id))?.cost.money.state,'unknown');
  assert.equal(await ledger.start(context,a.result.id),false);
  const finished:AskResult={...(await ledger.get(context,a.result.id))!,state:'needs_evidence',reason:'No exact source answers the question',
    gaps:['Evidence missing'],completedAt:new Date().toISOString()};
  await ledger.finish(context,a.result.id,finished);
  assert.equal((await ledger.get(context,a.result.id))?.state,'needs_evidence');
  assert.equal((await ledger.get(context,a.result.id))?.cost.money.state,'unknown','unknown billing remains unknown');
  await assert.rejects(ledger.finish(context,a.result.id,finished),hasCode('ASK_NOT_RUNNING'));
  await assert.rejects(ledger.checkpoint(context,a.result.id,{...finished,state:'running'}),hasCode('ASK_NOT_RUNNING'));
}));

dbTest('expired reserved Ask fails without provider execution on start, get, replay and lookup', {timeout:60_000},async()=>fixture(async({pool,context,grant})=>{
  const ledger=createPgKnowledgeAnswers(pool,grant),input=request();
  input.budget.deadline=new Date(Date.now()+1500).toISOString();
  const entries=await Promise.all(['start','get','replay','lookup'].map(async (path,index)=>{
    const key=`reserved-${path}-${randomUUID()}`,digest=String(index+1).repeat(64),first=initial(input);
    const saved=await ledger.reserve(context,key,digest,input,first);
    assert.equal(saved.result.state,'reserved');
    return {key,digest,first,saved};
  }));
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(input.budget.deadline)-Date.now()+50)));
  assert.equal(await ledger.start(context,entries[0].saved.result.id),false);
  const results=[await ledger.get(context,entries[0].saved.result.id),
    await ledger.get(context,entries[1].saved.result.id),
    (await ledger.reserve(context,entries[2].key,entries[2].digest,input,initial(input))).result,
    await ledger.lookup(context,entries[3].key)];
  for(const [index,result] of results.entries()){
    assert.equal(result?.state,'failed');
    assert.match(result!.reason,/deadline elapsed before execution; no provider was invoked/i);
    assert.ok(result?.completedAt);
    assert.deepEqual(result?.cost,entries[index].first.cost);
    assert.deepEqual(result?.evidence,[]);
    assert.equal(result?.provider,null);
  }
  const rows=await pool.query<{state:string}>('SELECT state FROM ccl_knowledge_answers');
  assert.deepEqual(rows.rows.map(row=>row.state),Array(4).fill('failed'));
  assert.equal(await ledger.start(context,entries[2].saved.result.id),false);
  const alreadyExpired=request();alreadyExpired.budget.deadline=new Date(Date.now()-1000).toISOString();
  const fresh=await ledger.reserve(context,randomUUID(),'9'.repeat(64),alreadyExpired,initial(alreadyExpired));
  assert.equal(fresh.created,true);assert.equal(fresh.result.state,'failed');
}));

dbTest('Ask result identity and exact reference scope are fenced', {timeout:60_000},async()=>fixture(async({pool,context,grant})=>{
  const ledger=createPgKnowledgeAnswers(pool,grant),input=request(),reserved=await ledger.reserve(context,randomUUID(),'c'.repeat(64),input,initial(input));
  assert.equal(await ledger.start(context,reserved.result.id),true);
  const running=(await ledger.get(context,reserved.result.id))!;
  await assert.rejects(ledger.finish(context,reserved.result.id,running),hasCode('ASK_RESULT_NOT_TERMINAL'));
  const terminal={...running,state:'needs_evidence' as const,reason:'More evidence required',completedAt:new Date().toISOString()};
  await assert.rejects(ledger.finish(context,reserved.result.id,{...terminal,id:randomUUID()}),hasCode('ASK_RESULT_IDENTITY_MISMATCH'));
  await assert.rejects(ledger.finish(context,reserved.result.id,{...terminal,purpose:'other-purpose'}),hasCode('ASK_RESULT_IDENTITY_MISMATCH'));
  const foreign={projectId:context.scope.projectId,spaceId:'other-space',domain:'knowledge' as const,
    objectId:randomUUID(),versionId:randomUUID(),contentDigest:'d'.repeat(64)};
  await assert.rejects(ledger.finish(context,reserved.result.id,{...terminal,excluded:[{ref:foreign,reason:'Unrelated'}]}),hasCode('ASK_RESULT_SCOPE_MISMATCH'));
  assert.equal((await ledger.get(context,reserved.result.id))?.state,'running');
  await ledger.finish(context,reserved.result.id,terminal);
}));

dbTest('checkpoint survives deadline reconciliation with exact evidence and unknown billing', {timeout:60_000},async()=>fixture(async({pool,context,grant})=>{
  const ledger=createPgKnowledgeAnswers(pool,grant),input=request(),key=randomUUID(),digest='e'.repeat(64);
  input.budget.deadline=new Date(Date.now()+1500).toISOString();
  const saved=await ledger.reserve(context,key,digest,input,initial(input));
  assert.equal(await ledger.start(context,saved.result.id),true);
  const running=(await ledger.get(context,saved.result.id))!;
  assert.equal(running.cost.money.state,'unknown');
  const ref={...context.scope,domain:'knowledge' as const,objectId:randomUUID(),versionId:randomUUID(),contentDigest:'1'.repeat(64)};
  const checkpoint:AskResult={...running,evidence:[{id:'w1',kind:'wiki_page',ref,title:'Synthetic page',locator:null,
    conditions:[],counterexamples:[],unknowns:[],actualReadCoverage:[]}],readsetFingerprint:'2'.repeat(64),
    provider:{id:'synthetic-provider',modelRequested:'synthetic-model',modelReturned:null,requestId:null},
    reason:'Provider intent recorded before invocation'};
  await assert.rejects(ledger.checkpoint(context,saved.result.id,{...checkpoint,id:randomUUID()}),hasCode('ASK_RESULT_IDENTITY_MISMATCH'));
  await assert.rejects(ledger.checkpoint(context,saved.result.id,{...checkpoint,state:'reserved'}),hasCode('ASK_CHECKPOINT_NOT_RUNNING'));
  const foreign={...ref,spaceId:'other-space'};
  await assert.rejects(ledger.checkpoint(context,saved.result.id,{...checkpoint,evidence:[{...checkpoint.evidence[0],ref:foreign}]}),hasCode('ASK_RESULT_SCOPE_MISMATCH'));
  await ledger.checkpoint(context,saved.result.id,checkpoint);
  assert.deepEqual(await ledger.get(context,saved.result.id),checkpoint);
  const second=await ledger.reserve(context,randomUUID(),'3'.repeat(64),input,initial(input));
  assert.equal(await ledger.start(context,second.result.id),true);
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(input.budget.deadline)-Date.now()+50)));
  assert.equal((await ledger.get(context,second.result.id))?.state,'outcome_unknown');
  const replay=await ledger.reserve(context,key,digest,input,initial(input));
  assert.equal(replay.created,false);assert.equal(replay.result.state,'outcome_unknown');
  assert.ok(replay.result.completedAt);assert.match(replay.result.reason,/deadline elapsed/i);
  assert.deepEqual(replay.result.cost,checkpoint.cost);
  assert.deepEqual(replay.result.evidence,checkpoint.evidence);
  assert.deepEqual(replay.result.provider,checkpoint.provider);
  assert.equal(replay.result.readsetFingerprint,checkpoint.readsetFingerprint);
  assert.equal((await ledger.get(context,saved.result.id))?.state,'outcome_unknown');
  assert.equal(await ledger.start(context,saved.result.id),false);
  await assert.rejects(ledger.finish(context,saved.result.id,{...replay.result,state:'needs_evidence'}),hasCode('ASK_NOT_RUNNING'));
}));

dbTest('writer guard rejects direct writes and revoked ledger writes', {timeout:60_000},async()=>fixture(async({pool,context,grant})=>{
  const ledger=createPgKnowledgeAnswers(pool,grant),input=request(),saved=await ledger.reserve(context,randomUUID(),'f'.repeat(64),input,initial(input));
  await assert.rejects(pool.query("UPDATE ccl_knowledge_answers SET state='running' WHERE id=$1",[saved.result.id]),
    (error:unknown)=>error instanceof Error&&/KNOWLEDGE_WRITER_REVOKED/.test(error.message));
  await rotateKnowledgeWriterAuthority(pool,context.scope.projectId,grant.generation,{ownerId:grant.ownerId,mode:'read_only'},grant);
  await assert.rejects(ledger.start(context,saved.result.id),hasCode('KNOWLEDGE_WRITER_REVOKED'));
  assert.equal((await ledger.get(context,saved.result.id))?.state,'reserved');
}));
