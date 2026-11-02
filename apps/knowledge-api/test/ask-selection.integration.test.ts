import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import pg from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {seedKnowledgeSyntheticFixture} from '../../../scripts/runtime/knowledge-synthetic-fixture.ts';
import {createKnowledgeApi} from '../src/index.ts';
import {createKnowledgeClient,KnowledgeClientError} from '../../../packages/knowledge-client/src/index.ts';
import type {QueryAnswerer} from '../../../packages/knowledge-application/src/ask.ts';
import type {AskRequest,KnowledgeRef} from '../../../packages/knowledge-contracts/src/index.ts';

const databaseUrl=readTestDatabase(),dbTest=databaseUrl?test:test.skip;

dbTest('HTTP Ask reads two selected exact Wiki versions outside lexical results and freezes the original key',
  {timeout:90_000},async()=>{
  const admin=new pg.Pool({connectionString:databaseUrl!,max:2});
  const schema=`ask_selected_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString:databaseUrl!,max:8,options:`-c search_path=${schema}`});
  let server:Server|undefined;
  try{
    const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-selected-${randomUUID()}`);
    const purpose='exploration_reading',scope={projectId:seed.projectId,spaceId:seed.spaceId};
    let calls=0;let selected:KnowledgeRef[]=[];let expectedBodies:string[]=[];
    const answerer:QueryAnswerer={id:'synthetic-selected-answerer',model:'synthetic-no-paid-model',
      supportsMoneyLimit:true,async answer(input){
        calls++;
        assert.equal(input.evidence.length,2,'only the two selected, actually read Wiki pages reach the answerer');
        assert.ok(input.evidence.every(item=>item.kind==='wiki_page'));
        assert.deepEqual(input.evidence.map(item=>item.ref),selected);
        assert.deepEqual(input.evidence.map(item=>item.body),expectedBodies);
        return {answer:{outcome:'answered',claims:[{text:'两份准确合成 Wiki 均已读取',
          evidenceIds:input.evidence.map(item=>item.id)}],reason:'Synthetic selected-reference fixture; no LLM call',gaps:[]},
          cost:{modelCalls:{state:'known',value:0},tokens:{state:'known',value:0},
            money:{state:'known',amount:0,currency:'USD',source:'synthetic_no_model_call'}},
          modelReturned:'synthetic-no-paid-model',requestId:null};
      }};
    const token=`synthetic-${randomUUID()}-${randomUUID()}`;
    const api=await createKnowledgeApi({pool,token,port:0,principal:seed.principal,
      capabilities:{...seed.authorization,actions:[...seed.authorization.actions,'ask:write']},
      writerGrant:seed.writerGrant,answerer,syntheticFixture:true});
    server=await api.listen();
    const address=server.address();assert.ok(address&&typeof address!=='string');
    const client=createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope,
      headers:{Authorization:`Bearer ${token}`}});
    assert.ok((await client.capabilities()).data.permittedActions.includes('askSelection'));
    const catalog=(await client.catalog({purpose,limit:50})).data.items;
    assert.ok(catalog.length>=2);
    selected=catalog.slice(0,2).map(item=>item.ref);
    assert.ok(selected.every(ref=>ref.domain==='knowledge'&&ref.contentDigest!==null));
    const exact=await Promise.all(selected.map(ref=>client.document(ref,purpose)));
    assert.deepEqual(exact.map(item=>item.data.ref),selected,'public exact reads confirm canonical current refs');
    expectedBodies=exact.map(item=>item.data.body);
    const question='月石玄冰';
    const lexical=await client.query({question,purpose,limit:10,retrievalMethod:'wiki-lexical-v2'});
    assert.equal(lexical.data.items.length,0,'selection is independent of lexical matching');
    const request:AskRequest={question,purpose,limit:10,maxPages:2,includeSourceContent:false,selectedRefs:selected,
      budget:{maxModelCalls:1,maxReadBytes:60_000,deadline:new Date(Date.now()+60_000).toISOString(),
        maxMoney:{amount:0,currency:'USD'}}};
    const key=`selected:${randomUUID()}`;
    const first=(await client.ask(request,{idempotencyKey:key,purpose})).data;
    assert.equal(first.state,'answered');assert.equal(first.evidence.length,2);
    assert.deepEqual(first.evidence.map(item=>item.ref),selected);
    assert.deepEqual(first.claims[0].evidenceIds,first.evidence.map(item=>item.id));
    assert.ok(first.readUsage&&first.readUsage.wikiPayloadBytes>0&&first.readUsage.preparedInputBytes>0);
    assert.deepEqual(first.cost.modelCalls,{state:'known',value:0});
    assert.equal(first.cost.money.state,'known');
    if(first.cost.money.state==='known')assert.equal(first.cost.money.amount,0);
    assert.equal(calls,1,'one local synthetic answerer invocation; zero actual paid model calls');
    const stored=await pool.query<{request:AskRequest}>('SELECT request FROM ccl_knowledge_answers WHERE id=$1',[first.id]);
    assert.deepEqual(stored.rows[0].request.selectedRefs,selected,'ledger keeps the original selection');
    assert.equal((await client.ask(request,{idempotencyKey:key,purpose})).data.id,first.id);
    const lookedUp=(await client.lookupAnswer(key,purpose)).data;
    assert.equal(lookedUp.state,'committed');assert.equal(lookedUp.answer?.id,first.id);
    assert.equal(calls,1,'replay and lookup do not call the answerer again');
    await assert.rejects(client.ask({...request,selectedRefs:[...selected].reverse()},{idempotencyKey:key,purpose}),
      error=>error instanceof KnowledgeClientError&&error.code==='IDEMPOTENCY_CONFLICT'&&error.httpStatus===409);
    assert.equal(calls,1);
  }finally{
    if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
    await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();
  }
});
