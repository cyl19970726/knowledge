import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import type {ReadContext} from '../../../packages/knowledge-application/src/index.ts';
import type {SourcePlanRequest,SourcePlanResult,KnowledgeRef} from '../../../packages/knowledge-contracts/src/index.ts';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {migrateKnowledge} from '../../../packages/knowledge/src/migrations.ts';
import {assertKnowledgeWriterAuthority,rotateKnowledgeWriterAuthority} from '../../../packages/knowledge/src/writer-authority.ts';
import {migrateSourceIntake} from '../../../packages/adapters/knowledge-service/src/source-intake.ts';
import {createPgSourcePlans,migrateSourcePlans,SourcePlanCommitUnknownError} from '../../../packages/adapters/knowledge-service/src/source-plan.ts';

const databaseUrl=readTestDatabase(),dbTest=databaseUrl?test:test.skip;
const hasCode=(code:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&error.code===code;
const zero:SourcePlanResult['cost']={modelCalls:{state:'known',value:0},tokens:{state:'known',value:0},
  money:{state:'known',amount:0,currency:'USD',source:'no_provider_call'}};

async function fixture(run:(scope:{pool:pg.Pool;context:ReadContext;grant:Awaited<ReturnType<typeof rotateKnowledgeWriterAuthority>>;
  sourceEventId:string;sourceRef:KnowledgeRef})=>Promise<void>){
  const admin=new pg.Pool({connectionString:databaseUrl!,max:2}),schema=`ccl_source_plan_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString:databaseUrl!,max:8,options:`-c search_path=${schema}`});
  try{
    await migrateKnowledge(pool);await migrateSourceIntake(pool);await migrateSourcePlans(pool);
    const projectId=`synthetic-${randomUUID()}`;
    const grant=await rotateKnowledgeWriterAuthority(pool,projectId,null,{ownerId:'source-plan-test',mode:'active'});
    const context:ReadContext={scope:{projectId,spaceId:'source-space'},purpose:'exploration_reading',
      principal:{id:'planning-principal',clientInstallationId:'planning-installation',projectId,
        spaceIds:['source-space','other-space'],purposes:['exploration_reading','other-purpose']}};
    const sourceEventId=randomUUID(),sourceRef:KnowledgeRef={...context.scope,domain:'analysis',objectId:randomUUID(),
      versionId:randomUUID(),contentDigest:'a'.repeat(64)};
    const client=await pool.connect();
    try{
      await client.query('BEGIN');await assertKnowledgeWriterAuthority(client,projectId,grant);
      await client.query(`INSERT INTO ccl_knowledge_source_events
        (id,project_id,space_id,principal_id,installation_id,purpose,adapter_id,event_key,input_digest,document)
        VALUES($1,$2,$3,$4,$5,$6,'synthetic-source-owner',$7,$8,$9)`,
      [sourceEventId,projectId,context.scope.spaceId,context.principal.id,context.principal.clientInstallationId,
        context.purpose,`source:${sourceEventId}`,'b'.repeat(64),{request:{sourceRef}}]);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
    await run({pool,context,grant,sourceEventId,sourceRef});
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
}

function request(sourceEventId:string,deadline=Date.now()+120_000):SourcePlanRequest{
  return {sourceEventId,purpose:'exploration_reading',methodVersion:'synthetic-plan/1',
    budget:{maxModelCalls:1,maxReadBytes:60_000,deadline:new Date(deadline).toISOString(),maxMoney:{amount:1,currency:'USD'}}};
}
function initial(input:SourcePlanRequest,id=randomUUID()):SourcePlanResult{
  return {id,request:input,state:'reserved',evidence:[],proposal:null,provenance:'model_proposed',
    readUsage:{wikiPayloadBytes:0,sourceContentBytes:0,preparedInputBytes:0,maxReadBytes:input.budget.maxReadBytes},
    inputFingerprint:'c'.repeat(64),cost:zero,provider:null,raw:null,reason:'Reserved; no provider invoked',
    createdAt:new Date().toISOString(),completedAt:null};
}
function evidence(ref:KnowledgeRef):SourcePlanResult['evidence'][number]{
  return {id:'source',kind:'source_content',ref,title:'Synthetic report',locator:null,conditions:[],
    counterexamples:[],unknowns:[],actualReadCoverage:[]};
}

dbTest('source plan is scoped to registered event, installation and purpose; CAS and provider input stay frozen',async()=>fixture(async({pool,context,grant,sourceEventId,sourceRef})=>{
  const ledger=createPgSourcePlans(pool,grant),input=request(sourceEventId),key='one-plan',hash='d'.repeat(64);
  const first=await ledger.reserve(context,key,hash,input,initial(input));
  assert.equal(first.created,true);
  const replay=await ledger.reserve(context,key,hash,input,initial(input));
  assert.equal(replay.created,false);assert.equal(replay.result.id,first.result.id);
  await assert.rejects(ledger.reserve(context,key,'e'.repeat(64),input,initial(input)),hasCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(ledger.reserve(context,key,hash,{...input,methodVersion:'synthetic-plan/2'},initial({...input,methodVersion:'synthetic-plan/2'})),hasCode('IDEMPOTENCY_CONFLICT'));
  const otherInstall={...context,principal:{...context.principal,clientInstallationId:'other-installation'}};
  assert.equal(await ledger.lookup(otherInstall,key),null);
  await assert.rejects(ledger.reserve(otherInstall,'different-install','f'.repeat(64),input,initial(input)),hasCode('SOURCE_EVENT_NOT_FOUND'));
  const otherPrincipal={...context,principal:{...context.principal,id:'another-principal'}};
  assert.equal(await ledger.lookup(otherPrincipal,key),null);
  await assert.rejects(ledger.reserve(otherPrincipal,'different-principal','f'.repeat(64),input,initial(input)),hasCode('SOURCE_EVENT_NOT_FOUND'));
  const otherSpace={...context,scope:{...context.scope,spaceId:'other-space'}};
  assert.equal(await ledger.lookup(otherSpace,key),null);
  await assert.rejects(ledger.reserve(otherSpace,'different-space','f'.repeat(64),input,initial(input)),hasCode('SOURCE_EVENT_NOT_FOUND'));
  const otherPurpose={...context,purpose:'other-purpose'};
  await assert.rejects(ledger.reserve(otherPurpose,'other-purpose','f'.repeat(64),{...input,purpose:'other-purpose'},initial({...input,purpose:'other-purpose'})),hasCode('SOURCE_EVENT_NOT_FOUND'));
  const missing=request(randomUUID());
  await assert.rejects(ledger.reserve(context,'no-event','f'.repeat(64),missing,initial(missing)),hasCode('SOURCE_EVENT_NOT_FOUND'));
  const [a,b]=await Promise.all([ledger.start(context,first.result.id),ledger.start(context,first.result.id)]);
  assert.deepEqual([a,b].sort(),[false,true]);assert.equal(await ledger.start(context,first.result.id),false);
  const running=(await ledger.get(context,first.result.id))!;
  const withProvider:SourcePlanResult={...running,evidence:[evidence(sourceRef)],provider:{id:'synthetic-provider',
    version:'v1',modelRequested:'synthetic-model',modelReturned:null,requestId:null},
    inputFingerprint:'1'.repeat(64),reason:'Bounded source read acknowledged'};
  await ledger.checkpoint(context,first.result.id,withProvider);
  await assert.rejects(ledger.checkpoint(context,first.result.id,{...withProvider,inputFingerprint:'2'.repeat(64)}),hasCode('SOURCE_PLAN_BINDING_CHANGED'));
  await assert.rejects(ledger.checkpoint(context,first.result.id,{...withProvider,evidence:[evidence({...sourceRef,contentDigest:'3'.repeat(64)})]}),hasCode('SOURCE_PLAN_EVIDENCE_INVALID'));
  const terminal:SourcePlanResult={...withProvider,state:'planned',proposal:{outcome:'planned',question:'What should we research?',
    queries:['synthetic query'],mentions:[],reason:'Synthetic proposal only',gaps:[]},
    cost:{modelCalls:{state:'known',value:1},tokens:{state:'known',value:30},money:{state:'known',amount:0.01,currency:'USD',source:'synthetic-receipt'}},
    completedAt:new Date().toISOString()};
  await ledger.checkpoint(context,first.result.id,{...withProvider,proposal:terminal.proposal,raw:{synthetic:'acknowledged'},cost:terminal.cost});
  await assert.rejects(ledger.finish(context,first.result.id,terminal),hasCode('SOURCE_PLAN_ACKNOWLEDGEMENT_CHANGED'));
  await assert.rejects(ledger.checkpoint(context,first.result.id,{...withProvider,proposal:terminal.proposal,raw:{synthetic:'acknowledged'},cost:zero}),hasCode('SOURCE_PLAN_COST_REGRESSION'));
  terminal.raw={synthetic:'acknowledged'};
  await ledger.finish(context,first.result.id,terminal);
  assert.equal((await ledger.lookup(context,key))?.proposal?.outcome,'planned');
  await assert.rejects(ledger.finish(context,first.result.id,terminal),hasCode('SOURCE_PLAN_NOT_RUNNING'));
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM ccl_knowledge_publications')).rows[0].n),0);
}));

dbTest('deadline gives never-started zero cost and preserves acknowledged proposal, raw and cost from running plan',async()=>fixture(async({context,grant,pool,sourceEventId,sourceRef})=>{
  const ledger=createPgSourcePlans(pool,grant),input=request(sourceEventId,Date.now()+700);
  const waiting=await ledger.reserve(context,'waiting','4'.repeat(64),input,initial(input));
  const active=await ledger.reserve(context,'active','5'.repeat(64),input,initial(input));
  assert.equal(await ledger.start(context,active.result.id),true);
  const running=(await ledger.get(context,active.result.id))!;
  const proposal:NonNullable<SourcePlanResult['proposal']>={outcome:'planned',question:'What is the synthetic question?',
    queries:['synthetic query'],mentions:[],reason:'Model output acknowledged',gaps:[]};
  const checkpoint:SourcePlanResult={...running,evidence:[evidence(sourceRef)],proposal,raw:{synthetic:'provider payload'},
    cost:{modelCalls:{state:'known',value:1},tokens:{state:'known',value:45},
      money:{state:'known',amount:0.03,currency:'USD',source:'synthetic-receipt'}}};
  await ledger.checkpoint(context,active.result.id,checkpoint);
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(input.budget.deadline)-Date.now()+40)));
  const failed=await ledger.lookup(context,'waiting');assert.equal(failed?.state,'failed');assert.deepEqual(failed?.cost,zero);
  assert.equal(await ledger.start(context,waiting.result.id),false);
  const unknown=await ledger.get(context,active.result.id);
  assert.equal(unknown?.state,'outcome_unknown');assert.deepEqual(unknown?.proposal,proposal);
  assert.deepEqual(unknown?.raw,checkpoint.raw);assert.deepEqual(unknown?.cost,checkpoint.cost);
  assert.equal((await ledger.reserve(context,'active','5'.repeat(64),input,initial(input))).result.state,'outcome_unknown');
  assert.equal(await ledger.start(context,active.result.id),false);
}));

dbTest('lost COMMIT acknowledgement reports typed unknown with original id for lookup',async()=>fixture(async({pool,context,grant,sourceEventId})=>{
  const input=request(sourceEventId),original=pool.connect.bind(pool);
  const interrupted={connect:async()=>{
    const client=await original(),query=client.query.bind(client);let lost=false;
    return {query:async(...args:Parameters<typeof query>)=>{
      const value=await query(...args);
      if(args[0]==='COMMIT'&&!lost){lost=true;throw new Error('Synthetic COMMIT acknowledgement lost');}
      return value;
    },release:()=>client.release()};
  }} as unknown as pg.Pool;
  const ledger=createPgSourcePlans(interrupted,grant),id=randomUUID();
  await assert.rejects(ledger.reserve(context,'lost','6'.repeat(64),input,initial(input,id)),error=>
    error instanceof SourcePlanCommitUnknownError&&error.operationId===id&&error.commitStatus==='unknown');
  const lookup=createPgSourcePlans(pool,grant);
  assert.equal((await lookup.lookup(context,'lost'))?.id,id);
}));

dbTest('read-only authority blocks mutation and still permits terminal lookup',async()=>fixture(async({pool,context,grant,sourceEventId})=>{
  const ledger=createPgSourcePlans(pool,grant),input=request(sourceEventId),saved=await ledger.reserve(context,'read-only','7'.repeat(64),input,initial(input));
  assert.equal(await ledger.start(context,saved.result.id),true);
  const running=(await ledger.get(context,saved.result.id))!;
  await ledger.finish(context,saved.result.id,{...running,state:'failed',reason:'Synthetic failure',completedAt:new Date().toISOString()});
  await rotateKnowledgeWriterAuthority(pool,context.scope.projectId,grant.generation,{ownerId:'read-only-test',mode:'read_only'},grant);
  assert.equal((await ledger.lookup(context,'read-only'))?.state,'failed');
  await assert.rejects(ledger.reserve(context,'blocked','8'.repeat(64),input,initial(input)),hasCode('KNOWLEDGE_WRITER_REVOKED'));
}));
