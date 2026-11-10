import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import type {Message} from '@anthropic-ai/sdk/resources/messages/messages';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {seedKnowledgeSyntheticFixture} from '../../../scripts/runtime/knowledge-synthetic-fixture.ts';
import {createKnowledgeClient,KnowledgeClientError} from '../../../packages/knowledge-client/src/index.ts';
import {createKnowledgeApi} from '../src/index.ts';
import {createClaudeModelPort,createClaudeAnswerer,createPgSpendLedger,migrateModelSpend,createModelCallService,createPgModelCallStore,migrateModelCalls,
  type ClaudeTransport,type ClaudeRequest} from '../../../packages/adapters/knowledge-claude/src/index.ts';

const url=readTestDatabase(),dbTest=url?test:test.skip;
/** No network: a fake transport stands in for Anthropic and records what would have been sent. */
function fakeTransport(reply:(params:ClaudeRequest)=>string){
  const sent:ClaudeRequest[]=[];
  const transport:ClaudeTransport={async countTokens(){return 2000;},async send(params){sent.push(params);
    return {requestId:'req_synthetic',message:{id:'msg',type:'message',role:'assistant',model:'claude-sonnet-5-5',content:[{type:'text',text:reply(params),citations:null}],
      stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:2000,output_tokens:150,cache_creation_input_tokens:0,cache_read_input_tokens:0}} as unknown as Message};}};
  return {transport,sent};
}

dbTest('Claude providers through the API: disclosure gate, budgeted Ask, ledger and idempotent model calls',{timeout:90_000},async t=>{
  const admin=new pg.Pool({connectionString:url!,max:2}),schema=`claude_api_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString:url!,max:8,options:`-c search_path=${schema}`});
  const servers:import('node:http').Server[]=[];
  try{
    const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-${randomUUID()}`),token=`test-${randomUUID()}-${randomUUID()}`;
    await migrateModelSpend(pool);await migrateModelCalls(pool);
    const ledger=createPgSpendLedger(pool);
    let garbled=false;
    const {transport,sent}=fakeTransport(params=>{
      if(garbled)return 'not json at all';
      const text=JSON.stringify(params.messages);
      const id=/<evidence id=\\"([^\\"]+)\\" kind=\\"wiki_page\\"/.exec(text)?.[1];
      return id?JSON.stringify({outcome:'answered',claims:[{text:'合成断言，仅用于接线测试。',evidenceIds:[id]}],reason:'synthetic',gaps:[]}):'plain arm answer';
    });
    const port=createClaudeModelPort({transport,ledger,config:{model:'claude-sonnet-5-5',effort:'medium',maxCallUsd:0.5,dailyCapUsd:2,maxOutputTokens:8000}});
    const start=async(allowWikiPages:boolean)=>{
      const api=await createKnowledgeApi({pool,token,principal:seed.principal,writerGrant:seed.writerGrant,port:0,
        capabilities:{...seed.authorization,actions:[...seed.authorization.actions,'ask:write','model:call']},
        answerer:createClaudeAnswerer(port),modelDisclosure:{rightsPolicyIds:[],allowWikiPages},
        modelCalls:createModelCallService({port,store:createPgModelCallStore(pool)})});
      const server=await api.listen();servers.push(server);const address=server.address();assert.ok(address&&typeof address!=='string');
      return createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope:{projectId:seed.projectId,spaceId:seed.spaceId},headers:{Authorization:`Bearer ${token}`}});
    };
    const ask=()=>({question:'商品辨认的条件与反例',purpose:'exploration_reading',limit:3,maxPages:1,includeSourceContent:false,
      budget:{maxModelCalls:1,maxReadBytes:50_000,deadline:new Date(Date.now()+60_000).toISOString(),maxMoney:{amount:0.3,currency:'USD'}}});

    await t.test('without a disclosure grant no evidence leaves the service',async()=>{
      const client=await start(false);
      const denied=(await client.ask(ask(),{idempotencyKey:randomUUID()})).data;
      assert.equal(denied.state,'failed');
      assert.match(denied.reason,/^MODEL_DISCLOSURE_FORBIDDEN/);
      assert.equal(denied.cost.modelCalls.state==='known'&&denied.cost.modelCalls.value,0);
      assert.equal(sent.length,0);
      assert.equal(await ledger.spentToday(new Date()),0);
    });
    await t.test('an allowed Ask is answered, costed and recorded in the spend ledger',async()=>{
      const client=await start(true);
      assert.ok((await client.capabilities()).data.permittedActions.includes('modelCall'));
      const answer=(await client.ask(ask(),{idempotencyKey:randomUUID()})).data;
      assert.equal(answer.state,'answered');
      assert.equal(answer.provider?.modelRequested,'claude-sonnet-5-5');
      assert.equal(answer.provider?.requestId,'req_synthetic');
      assert.equal(answer.cost.money.state,'known');
      const rows=(await pool.query("SELECT role,state,actual_usd::float8 AS usd FROM ccl_knowledge_model_spend")).rows;
      assert.deepEqual(rows.map(row=>[row.role,row.state]),[['ask','settled']]);
      assert.equal(answer.cost.money.state==='known'&&answer.cost.money.amount,rows[0].usd);
    });
    await t.test('an answered but unusable reply fails with its billed cost instead of an unknown outcome',async()=>{
      const client=await start(true);garbled=true;
      try{
        const answer=(await client.ask(ask(),{idempotencyKey:randomUUID()})).data;
        assert.equal(answer.state,'failed');
        assert.match(answer.reason,/^PROVIDER_OUTPUT_INVALID/);
        assert.equal(answer.cost.money.state,'known');
        assert.ok(answer.cost.money.state==='known'&&answer.cost.money.amount>0);
        assert.equal(answer.provider?.requestId,'req_synthetic');
      }finally{garbled=false;}
    });
    await t.test('a generic model call shares the ledger and replays without a second charge',async()=>{
      const client=await start(true),key=`eval-${randomUUID()}`;
      const request={purpose:'exploration_reading',label:'eval:B:full-source',system:'Answer from the document.',cachedPrefix:'synthetic full source text '.repeat(2000),
        prompt:'What happened?',maxOutputTokens:null,maxMoney:{amount:0.2,currency:'USD' as const}};
      const before=sent.length;
      const first=(await client.modelCall(request,{idempotencyKey:key})).data;
      const replay=(await client.modelCall(request,{idempotencyKey:key})).data;
      assert.deepEqual(replay,first);
      assert.equal(sent.length,before+1);
      assert.equal(first.text,'plain arm answer');
      assert.equal(first.provider.effort,'medium');
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM ccl_knowledge_model_spend WHERE role='model_call'")).rows[0].n,1);
      await assert.rejects(client.modelCall({...request,prompt:'Different?'},{idempotencyKey:key}),(error:unknown)=>error instanceof KnowledgeClientError&&error.code==='IDEMPOTENCY_CONFLICT');
    });
  }finally{
    for(const server of servers)await new Promise(resolve=>server.close(resolve));
    await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();
  }
});
