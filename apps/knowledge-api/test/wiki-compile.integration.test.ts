import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import pg from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {seedKnowledgeSyntheticFixture} from '../../../scripts/runtime/knowledge-synthetic-fixture.ts';
import {createKnowledgeApi} from '../src/index.ts';
import {createKnowledgeClient} from '../../../packages/knowledge-client/src/index.ts';
import {createKnowledgeStore} from '../../../packages/knowledge/src/store.ts';
import type {WikiCompiler} from '../../../packages/knowledge-application/src/wiki-compile.ts';
import type {WikiCompileRequest,WikiDraftChange} from '../../../packages/knowledge-contracts/src/index.ts';
const url=readTestDatabase(),dbTest=url?test:test.skip;
const code=(name:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code===name;
const zero={modelCalls:{state:'known' as const,value:0},tokens:{state:'known' as const,value:0},money:{state:'known' as const,amount:0,currency:'USD',source:'synthetic-local-fixture'}};

dbTest('registered source and bounded old Wikis compile into distinct new/update candidates without publishing or replaying provider calls',{timeout:90_000},async()=>{
 const admin=new pg.Pool({connectionString:url!,max:2}),schema=`compile_api_${randomUUID().replaceAll('-','')}`;
 await admin.query(`CREATE SCHEMA "${schema}"`);const pool=new pg.Pool({connectionString:url!,max:8,options:`-c search_path=${schema}`});
 let server:Server|undefined;
 try{
  const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-compile-${randomUUID()}`),purpose='exploration_reading';
  let mode:'new'|'update'|'collision'|'unread'|'no_change'|'throw'|'mutate'|'unknown_cost'='new',calls=0;
  const key=`synthetic-page-${randomUUID()}`;
  const compiler:WikiCompiler={id:'synthetic-test-compiler',model:'synthetic-no-real-model',methodVersion:'bounded-wiki-compiler-fixture-v1',execution:'local_deterministic',supportsMoneyLimit:true,
   async compile(input){calls++;
    const checkpoint=(await pool.query('SELECT result FROM ccl_knowledge_compilations WHERE id=$1',[input.operationId])).rows[0].result;
    assert.equal(checkpoint.cost.money.state,'unknown');assert.ok(checkpoint.evidence.some((item:{kind:string})=>item.kind==='wiki_page'));
    assert.ok(input.evidence.some(item=>item.kind==='source_content'&&item.body));
    if(mode==='throw')throw new Error('Synthetic lost provider response');
    if(mode==='no_change')return {proposal:{outcome:'no_change',drafts:[],reason:'Synthetic unchanged proposal; no semantic quality claim',gaps:[]},cost:zero,modelReturned:'synthetic-no-real-model',requestId:'synthetic-no-change'};
    const source=input.evidence.find(item=>item.kind==='source_content')!,old=input.evidence.find(item=>item.ref.objectId===seed.root.objectId)!;
    assert.ok(old?.wiki,'Exact old page identity is supplied from the bounded frozen revision');
    const profile=mode==='new'||mode==='mutate'?input.profiles.find(item=>item.id==='question')!:old.wiki.profile;
    const draft:WikiDraftChange={targetEvidenceId:mode==='update'?old.id:null,identityKey:mode==='update'||mode==='collision'?old.wiki.identity.key:key,
     profile,title:mode==='update'?'合成修订：区分注意与辨认':'合成新问题页',summary:'仅供工程验证：当前资料允许提出一个待审认识，不能据此推断经营结果。',
     conditions:['仅限给定合成资料'],counterexamples:['同源材料不是独立支持'],unknowns:['真实语义与业务效果未验'],nextQuestions:['需要补充什么独立观察？'],
     supportEvidenceIds:[mode==='unread'?'not-read':source.id],rationale:'准确报告与旧页已读；仍需独立审阅。'};
    if(mode==='mutate'){input.evidence[0].ref.projectId='forged-provider-scope';input.evidence[0].body='provider mutated its copy';input.budget.maxReadBytes=9_999_999;}
    return {proposal:{outcome:'proposed',drafts:[draft],reason:'Synthetic compile proposal',gaps:['Not a semantic acceptance test']},cost:mode==='unknown_cost'?{...zero,money:{state:'unknown',reason:'Synthetic missing billing receipt'}}:zero,modelReturned:'synthetic-no-real-model',requestId:'synthetic-compile-response'};
   }};
  const token=`test-${randomUUID()}-${randomUUID()}`,api=await createKnowledgeApi({pool,token,port:0,principal:seed.principal,writerGrant:seed.writerGrant,compiler,enableSourceIngest:true,
   capabilities:{...seed.authorization,adapterIds:[...seed.authorization.adapterIds,'synthetic-reports'],actions:[...seed.authorization.actions,'ingest:write','ingest:read','compile:write','compile:read']}});
  server=await api.listen();const address=server.address();assert.ok(address&&typeof address!=='string');
  const client=createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope:{projectId:seed.projectId,spaceId:seed.spaceId},headers:{Authorization:`Bearer ${token}`}});
  const arrival={adapterId:'synthetic-reports',eventKey:`source:${seed.source.ref.versionId}`,producerSequence:1,occurredAt:new Date().toISOString(),purpose,sourceRef:{...seed.source.ref,domain:'source' as const,contentDigest:seed.source.ref.contentDigest!}};
  const event=await client.registerSourceEvent(arrival,{idempotencyKey:arrival.eventKey,purpose});
  const request:WikiCompileRequest={question:'商品的可展示性如何影响辨认',purpose,sourceEventIds:[event.data.id],queries:['商品的可展示性'],limit:3,maxPages:2,
   budget:{maxModelCalls:0,maxReadBytes:200_000,maxMoney:{amount:0,currency:'USD'},deadline:new Date(Date.now()+120_000).toISOString()}};
  const store=createKnowledgeStore(pool),oldHead=await store.head(seed.projectId,seed.root.objectId),published=(await pool.query('SELECT count(*)::int n FROM ccl_knowledge_publications')).rows[0].n;
  const first=await client.compileWiki(request,{idempotencyKey:'new-page',purpose});
  assert.equal(first.data.state,'waiting_for_review');assert.equal(first.data.stageStatus,'staged');assert.ok(first.data.candidate);
  assert.equal(first.data.candidate.published,false);assert.equal(calls,1);assert.ok(first.data.evidence.some(item=>item.wiki));
  assert.equal((await client.compileWiki(request,{idempotencyKey:'new-page',purpose})).data.id,first.data.id);assert.equal(calls,1);
  assert.equal((await client.compilationLookup('new-page',purpose)).data.state,'known');
  mode='update';const updated=await client.compileWiki(request,{idempotencyKey:'update-page',purpose});
  assert.equal(updated.data.state,'waiting_for_review');const change=await store.getChangeSet(seed.projectId,updated.data.candidate!.candidateId);
  assert.equal(change?.changes[0].effect,'correct');assert.equal(change?.baseHeads[0].versionId,seed.root.versionId);
  assert.deepEqual(await store.head(seed.projectId,seed.root.objectId),oldHead);assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_publications')).rows[0].n,published);
  mode='unread';const invalid=await client.compileWiki(request,{idempotencyKey:'unread-citation',purpose});assert.equal(invalid.data.state,'failed');assert.match(invalid.data.reason,/UNREAD_CITATION/);assert.equal(invalid.data.candidate,null);
  mode='collision';const collision=await client.compileWiki(request,{idempotencyKey:'identity-conflict',purpose});assert.equal(collision.data.state,'failed');assert.equal(collision.data.candidate,null);
  mode='no_change';const unchanged=await client.compileWiki(request,{idempotencyKey:'unchanged',purpose});assert.equal(unchanged.data.state,'no_change');assert.equal(unchanged.data.drafts.length,0);
  mode='unknown_cost';const unaccounted=await client.compileWiki(request,{idempotencyKey:'unaccounted-cost',purpose});assert.equal(unaccounted.data.state,'outcome_unknown');assert.equal(unaccounted.data.candidate,null);assert.equal(unaccounted.data.drafts.length,1);
  mode='throw';const unknown=await client.compileWiki(request,{idempotencyKey:'uncertain-response',purpose});assert.equal(unknown.data.state,'outcome_unknown');assert.equal(unknown.data.cost.money.state,'unknown');
  const beforeReplay=calls;await client.compileWiki(request,{idempotencyKey:'uncertain-response',purpose});assert.equal(calls,beforeReplay);
  await assert.rejects(client.compileWiki({...request,question:'changed question'},{idempotencyKey:'new-page',purpose}),code('IDEMPOTENCY_CONFLICT'));
  compiler.execution='external';const denied=await client.compileWiki({...request,budget:{...request.budget,maxModelCalls:1,maxMoney:{amount:1,currency:'USD'}}},{idempotencyKey:'no-disclosure-permission',purpose});
  assert.equal(denied.data.state,'failed');assert.match(denied.data.reason,/MODEL_DISCLOSURE_PERMISSION_REQUIRED/);assert.equal(calls,beforeReplay);
  compiler.execution='local_deterministic';mode='mutate';
  const mutated=await client.compileWiki(request,{idempotencyKey:'provider-input-copy',purpose});assert.equal(mutated.data.state,'waiting_for_review');
  assert.ok(mutated.data.evidence.every(item=>item.ref.projectId===seed.projectId));assert.equal(mutated.data.readUsage.maxReadBytes,request.budget.maxReadBytes);
  mode='new';
  await pool.query(`CREATE FUNCTION fail_compile_finish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.state='waiting_for_review' THEN RAISE EXCEPTION 'synthetic finish failure after stage'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER fail_compile_finish BEFORE UPDATE ON ccl_knowledge_compilations FOR EACH ROW EXECUTE FUNCTION fail_compile_finish()`);
  const beforeInterrupted=calls;
  await assert.rejects(client.compileWiki(request,{idempotencyKey:'stage-before-finish-fault',purpose}));
  assert.equal(calls,beforeInterrupted+1);
  const interrupted=(await pool.query(`SELECT id,result FROM ccl_knowledge_compilations WHERE request_key='stage-before-finish-fault'`)).rows[0];
  assert.equal(interrupted.result.state,'running');assert.equal(interrupted.result.candidate,null);
  assert.ok(await store.getChangeSet(seed.projectId,interrupted.id),'candidate committed before the ledger finish failed');
  await pool.query('DROP TRIGGER fail_compile_finish ON ccl_knowledge_compilations');
  const recovered=await client.compilationLookup('stage-before-finish-fault',purpose);
  assert.equal(recovered.data.state,'known');
  if(recovered.data.state==='known'){assert.equal(recovered.data.compilation.state,'waiting_for_review');assert.equal(recovered.data.compilation.candidate?.candidateId,interrupted.id);}
  assert.equal(calls,beforeInterrupted+1,'lookup only associates the already-staged candidate, never invokes compiler again');
  const tiny=await client.compileWiki({...request,budget:{...request.budget,maxReadBytes:1}},{idempotencyKey:'tiny-input',purpose});assert.equal(tiny.data.state,'failed');
  assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_publications')).rows[0].n,published);
 }finally{if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
