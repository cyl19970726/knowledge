import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {seedKnowledgeSyntheticFixture} from '../../../scripts/runtime/knowledge-synthetic-fixture.ts';
import {createKnowledgeClient,KnowledgeClientError} from '../../../packages/knowledge-client/src/index.ts';
import {createKnowledgeApi} from '../src/index.ts';
import type {QueryAnswerer,AskEvidence} from '../../../packages/knowledge-application/src/ask.ts';
import {digest} from '../../../packages/knowledge/src/utils.ts';
import {CapabilitiesSchema} from '../../../packages/knowledge-contracts/src/index.ts';

const url=readTestDatabase(),dbTest=url?test:test.skip;
const zeroCost={modelCalls:{state:'known' as const,value:0},tokens:{state:'known' as const,value:0},
  money:{state:'known' as const,amount:0,currency:'USD',source:'synthetic_test_no_model_calls'}};
dbTest('AskWiki: exact evidence, durable replay, bounds, invalid citations, uncertainty and revocation',{timeout:90_000},async t=>{
  const admin=new pg.Pool({connectionString:url!,max:2}),schema=`ask_api_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString:url!,max:8,options:`-c search_path=${schema}`});
  let server:import('node:http').Server|undefined,deniedServer:import('node:http').Server|undefined;
  try{
    const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-${randomUUID()}`),token=`test-${randomUUID()}-${randomUUID()}`;
    let calls=0,lastEvidence:readonly AskEvidence[]=[];
    let mode:'answer'|'invalid'|'throw'|'timeout'|'refuse'|'delay'='answer';
    const answerer:QueryAnswerer={id:'synthetic-test-answerer',model:'synthetic-no-paid-model',async answer(input){
      calls++;lastEvidence=input.evidence;
      const checkpoint=await pool.query<{result:{readsetFingerprint:string;evidence:unknown[];cost:typeof zeroCost}}>(
        'SELECT result FROM ccl_knowledge_answers WHERE id=$1',[input.operationId]);
      assert.equal(checkpoint.rows[0].result.readsetFingerprint,digest(input.evidence));
      assert.ok(checkpoint.rows[0].result.evidence.length>0,'readset persisted before invocation');
      assert.equal(checkpoint.rows[0].result.cost.money.state,'unknown');
      if(mode==='throw')throw new Error('Simulated lost provider acknowledgement');
      if(mode==='timeout')return new Promise((_,reject)=>input.signal.addEventListener('abort',()=>reject(new Error('Aborted')),{once:true}));
      if(mode==='delay')await new Promise(resolve=>setTimeout(resolve,100));
      return {answer:{outcome:mode==='refuse'?'refused':'answered',claims:mode==='refuse'?[]:[{
        text:'仅在给定合成范围内，吸引注意不等于准确辨认；真实效果仍待观察。',evidenceIds:[mode==='invalid'?'unread-evidence':input.evidence[0].id]}],
        reason:'Synthetic execution fixture; no semantic quality assertion',gaps:['真实观众效果未验']},
        cost:zeroCost,modelReturned:'synthetic-no-paid-model',requestId:'synthetic-request'};
    }};
    const api=await createKnowledgeApi({pool,token,principal:seed.principal,writerGrant:seed.writerGrant,
      capabilities:{...seed.authorization,actions:[...seed.authorization.actions,'ask:write']},answerer,port:0});
    server=await api.listen();const address=server.address();assert.ok(address&&typeof address!=='string');
    const client=createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope:{projectId:seed.projectId,spaceId:seed.spaceId},headers:{Authorization:`Bearer ${token}`}});
    const request=()=>({question:'商品辨认的条件与反例',purpose:'exploration_reading',limit:3,maxPages:1,includeSourceContent:true,
      budget:{maxModelCalls:1,maxReadBytes:50_000,deadline:new Date(Date.now()+60_000).toISOString(),maxMoney:null}});
    const before=await pool.query('SELECT object_id,version_id FROM ccl_knowledge_heads ORDER BY object_id');
    let answerId='',answerKey='';let answerRequest=request();
    await t.test('capability recovery identity is opt-in and authenticated',async()=>{
      const legacy=(await client.capabilities()).data;
      assert.equal(CapabilitiesSchema.omit({recoveryScope:true}).safeParse(legacy).success,true);
      assert.equal('recoveryScope' in legacy,false,'old strict capability readers see the old response shape');
      const enabled=(await client.capabilities({includeRecoveryScope:true})).data;
      assert.equal(enabled.recoveryScope,digest({principalId:seed.principal.id,clientInstallationId:seed.principal.clientInstallationId,
        projectId:seed.projectId,spaceId:seed.spaceId}));
    });
    await t.test('full readset and source coverage survive idempotent replay',async()=>{
      assert.ok((await client.capabilities()).data.permittedActions.includes('ask'));
      const key=randomUUID(),req=request(),answer=await client.ask(req,{idempotencyKey:key});
      answerKey=key;answerRequest=req;
      answerId=answer.data.id;assert.equal(answer.data.state,'answered');assert.equal(calls,1);
      assert.equal(answer.data.readsetFingerprint,digest(lastEvidence));
      assert.ok(lastEvidence.some(item=>item.kind==='source_content'&&item.actualReadCoverage.length>0));
      for(const item of lastEvidence.filter(item=>item.kind==='wiki_page')){
        const exact=(await client.document(item.ref,req.purpose)).data;
        assert.equal(item.body,exact.body,'answerer receives the exact full body, not a catalog summary');
        assert.deepEqual(item.conditions,exact.conditions);assert.ok(item.counterexamples.length&&item.unknowns.length);
      }
      assert.equal(answer.data.evidence.filter(item=>item.kind==='source_content').length,1,'same source is read once across pages');
      assert.equal((await client.ask(req,{idempotencyKey:key})).data.id,answerId);assert.equal(calls,1);
      assert.equal((await client.answer(answerId,req.purpose)).data.id,answerId);
      assert.equal((await client.lookupAnswer(key,req.purpose)).data.answer?.id,answerId);
      assert.equal((await client.lookupAnswer(randomUUID(),req.purpose)).data.state,'unknown');
      await assert.rejects(client.ask({...req,question:'不同问题'},{idempotencyKey:key}),e=>e instanceof KnowledgeClientError&&e.code==='IDEMPOTENCY_CONFLICT');
      assert.deepEqual((await pool.query('SELECT object_id,version_id FROM ccl_knowledge_heads ORDER BY object_id')).rows,before.rows,'temporary answer cannot publish');
    });
    await t.test('concurrent identical submissions invoke the answerer once',async()=>{
      mode='delay';const count=calls,key=randomUUID(),req=request();
      const answers=await Promise.all([client.ask(req,{idempotencyKey:key}),client.ask(req,{idempotencyKey:key})]);
      assert.equal(answers[0].data.id,answers[1].data.id);assert.equal(calls,count+1);
      assert.equal((await client.answer(answers[0].data.id,req.purpose)).data.state,'answered');
    });
    await t.test('public query advertises identity retrieval without changing the legacy default',async()=>{
      assert.equal((await client.capabilities()).data.limits.queryIdentityLexicalVersion,2);
      const query={question:'visibility',purpose:'exploration_reading',limit:1};
      assert.equal((await client.query(query)).data.items.length,0,'legacy title/body matching stays unchanged');
      const enhanced=await client.query({...query,retrievalMethod:'wiki-lexical-v2'});
      assert.equal(enhanced.data.retrieval.methodVersion,'wiki-lexical-v2');
      assert.equal(enhanced.data.items[0].ref.objectId,seed.root.objectId);
      assert.equal(enhanced.data.items[0].ref.versionId,seed.root.versionId);
      const receipt=(await client.receipt(enhanced.data.readReceiptId)).data;
      assert.equal(receipt.request.kind,'query');
      if(receipt.request.kind==='query')assert.equal(receipt.request.payload.retrievalMethod,'wiki-lexical-v2');
    });
    await t.test('no matches and exhausted evidence budget avoid model invocation',async()=>{
      const count=calls;
      for(const req of [{...request(),question:'weather forecast ocean logistics'}, {...request(),budget:{...request().budget,maxReadBytes:1}}]){
        const answer=await client.ask(req,{idempotencyKey:randomUUID()});assert.equal(answer.data.state,'needs_evidence');
        assert.equal(answer.data.claims.length,0);assert.equal(answer.data.cost.modelCalls.state,'known');
      }
      assert.equal(calls,count);
    });
    await t.test('unread citations fail and cannot become an answer',async()=>{
      mode='invalid';const answer=await client.ask(request(),{idempotencyKey:randomUUID()});
      assert.equal(answer.data.state,'failed');assert.equal(answer.data.claims.length,0);assert.match(answer.data.reason,/UNREAD_CITATION/);
    });
    await t.test('refusal is distinct from no evidence',async()=>{
      mode='refuse';const answer=await client.ask(request(),{idempotencyKey:randomUUID()});assert.equal(answer.data.state,'refused');
    });
    await t.test('lost acknowledgement remains unknown and replay never reinvokes',async()=>{
      mode='throw';const key=randomUUID(),req=request(),answer=await client.ask(req,{idempotencyKey:key}),count=calls;
      assert.equal(answer.data.state,'outcome_unknown');assert.equal(answer.data.cost.money.state,'unknown');
      assert.equal((await client.ask(req,{idempotencyKey:key})).data.id,answer.data.id);assert.equal(calls,count);
    });
    await t.test('provider deadline aborts and preserves unknown outcome',async()=>{
      mode='timeout';const req={...request(),includeSourceContent:false,budget:{...request().budget,deadline:new Date(Date.now()+1000).toISOString()}};
      const answer=await client.ask(req,{idempotencyKey:randomUUID()});assert.equal(answer.data.state,'outcome_unknown');
    });
    await t.test('authenticated read permission does not authorize model execution',async()=>{
      mode='answer';const count=calls;
      const denied=await createKnowledgeApi({pool,token,principal:seed.principal,writerGrant:seed.writerGrant,answerer,port:0});
      deniedServer=await denied.listen();const addr=deniedServer.address();assert.ok(addr&&typeof addr!=='string');
      const reader=createKnowledgeClient({baseUrl:`http://127.0.0.1:${addr.port}`,scope:client.scope,headers:{Authorization:`Bearer ${token}`}});
      await assert.rejects(reader.ask(request(),{idempotencyKey:randomUUID()}),e=>e instanceof KnowledgeClientError&&e.httpStatus===403);
      assert.equal(calls,count);
    });
    await t.test('revocation blocks stored answer disclosure and idempotent replay',async()=>{
      await client.revokeSource(seed.source.ref,{contentDigest:seed.source.ref.contentDigest,expectedGeneration:1},{idempotencyKey:randomUUID()});
      await assert.rejects(client.answer(answerId,'exploration_reading'),e=>e instanceof KnowledgeClientError&&e.httpStatus===409);
      await assert.rejects(client.ask(answerRequest,{idempotencyKey:answerKey}),e=>e instanceof KnowledgeClientError&&e.httpStatus===409&&e.commitStatus==='committed'&&e.operationId===answerId);
    });
  }finally{
    await Promise.all([new Promise<void>(resolve=>server?.close(()=>resolve())??resolve()),new Promise<void>(resolve=>deniedServer?.close(()=>resolve())??resolve())]);
    await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();
  }
});
