import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import pg from 'pg';
import type {Message} from '@anthropic-ai/sdk/resources/messages/messages';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {seedKnowledgeSyntheticFixture} from '../../../scripts/runtime/knowledge-synthetic-fixture.ts';
import {createKnowledgeApi,tokenSha256,type ApiPrincipal} from '../src/index.ts';
import {reviewAgentClient} from '../src/review-agent.ts';
import {createKnowledgeClient} from '../../../packages/knowledge-client/src/index.ts';
import type {WikiCompiler} from '../../../packages/knowledge-application/src/wiki-compile.ts';
import {createReviewAgent,createClaudeModelPort,createMemorySpendLedger,type ClaudeTransport} from '../../../packages/adapters/knowledge-claude/src/index.ts';

const url=readTestDatabase(),dbTest=url?test:test.skip;
const zero={modelCalls:{state:'known' as const,value:0},tokens:{state:'known' as const,value:0},money:{state:'known' as const,amount:0,currency:'USD',source:'synthetic-local-fixture'}};
const code=(value:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code===value;

dbTest('review agent over HTTP: decides supported candidates, escalates sensitive ones, never sees its own queue entries',{timeout:120_000},async()=>{
  const admin=new pg.Pool({connectionString:url!,max:2}),schema=`review_agent_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);const pool=new pg.Pool({connectionString:url!,max:10,options:`-c search_path=${schema}`});let server:Server|undefined;
  try{
    const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-${randomUUID()}`),purpose='exploration_reading',scope={projectId:seed.projectId,spaceId:seed.spaceId};
    const compiler:WikiCompiler={id:'synthetic-compiler',model:'synthetic-no-model',methodVersion:'agent-fixture-v1',execution:'local_deterministic',async compile(input){
      return {proposal:{outcome:'proposed',drafts:[{targetEvidenceId:null,profile:input.profiles.find(item=>item.id==='synthesis')??input.profiles[0],identityKey:`claim:${randomUUID()}`,
        title:input.question,summary:'合成摘要，仅用于审阅 agent 接线测试。',conditions:['claim_status:attributed'],counterexamples:[],unknowns:[],nextQuestions:[],
        supportEvidenceIds:input.evidence.filter(item=>item.kind==='source_content').map(item=>item.id),rationale:'synthetic'}],reason:'synthetic',gaps:[]},cost:zero,modelReturned:null,requestId:null};}};
    const tokens={proposer:`synthetic-${randomUUID()}`,agent:`synthetic-${randomUUID()}`};
    const principals:ApiPrincipal[]=[
      {tokenSha256:tokenSha256(tokens.proposer),principal:{...seed.principal,actor:{kind:'service',model:null}},
        capabilities:{...seed.authorization,adapterIds:[...seed.authorization.adapterIds,'agent-fixture'],actions:[...seed.authorization.actions,'ingest:read','ingest:write','compile:read','compile:write','review:request','review:read','review:decide']}},
      {tokenSha256:tokenSha256(tokens.agent),principal:{...seed.principal,id:'review-agent-1',clientInstallationId:'knowledge-review-agent',actor:{kind:'agent',model:'claude-opus-5-5'}},
        capabilities:{actions:['review:read','review:decide','compile:read'],adapterIds:[],rightsPolicyIds:[]}}];
    const api=await createKnowledgeApi({pool,principals,port:0,writerGrant:seed.writerGrant,compiler,enableSourceIngest:true});
    server=await api.listen();const address=server.address();assert.ok(address&&typeof address!=='string');
    const as=(token:string)=>createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope,headers:{Authorization:`Bearer ${token}`}});
    const proposer=as(tokens.proposer),agentHttp=as(tokens.agent);

    async function candidate(question:string){
      const text=`合成来源：${question}。${randomUUID()}`;
      const source=(await proposer.registerSource({externalIdentity:{adapterId:'agent-fixture',externalObjectId:randomUUID(),externalVersion:'1'},expectedSourceHead:null,
        sourceSchemaVersion:'synthetic-note/1',contentDigest:createHash('sha256').update(text).digest('hex'),custody:{mode:'managed_copy',text},sourceKind:'document',author:null,publisher:null,
        acquirer:'synthetic-test',publishedAt:null,obtainedAt:new Date().toISOString(),assertionKind:'source_claim',sourceGroups:[{id:`origin-${randomUUID()}`,status:'known',authority:'synthetic-original'}],
        anchors:[],actualCoverage:[],limitations:['Synthetic only'],rightsPolicyRef:'synthetic-local-only'},{idempotencyKey:randomUUID(),purpose})).data;
      const eventKey=`source:${source.ref.versionId}`;
      const event=(await proposer.registerSourceEvent({adapterId:'agent-fixture',eventKey,producerSequence:1,occurredAt:new Date().toISOString(),purpose,
        sourceRef:{...source.ref,domain:'source',contentDigest:source.ref.contentDigest!}},{idempotencyKey:eventKey,purpose})).data;
      const compiled=(await proposer.compileWiki({question,purpose,sourceEventIds:[event.id],queries:[`nomatch${randomUUID().replaceAll('-','')}`],limit:3,maxPages:1,
        budget:{maxModelCalls:0,maxReadBytes:400_000,maxMoney:{amount:0,currency:'USD'},deadline:new Date(Date.now()+60_000).toISOString()}},{idempotencyKey:randomUUID(),purpose})).data;
      const target=compiled.candidate!;
      return (await proposer.requestReview({target:{kind:'candidate',candidateId:target.candidateId,contentHash:target.contentHash},purpose},{idempotencyKey:randomUUID(),purpose})).data;
    }
    const supported=await candidate('机构发布声明'),sensitive=await candidate('某位普通市民被指控');

    assert.equal((await proposer.reviewQueue({purpose})).data.items.length,0,'a proposer never sees its own proposals as reviewable');
    assert.deepEqual((await agentHttp.reviewQueue({purpose})).data.items.map(item=>item.id).sort(),[supported.id,sensitive.id].sort());
    await assert.rejects(proposer.escalateReview(supported.id,{purpose,categories:['other'],note:'self'},{idempotencyKey:randomUUID(),purpose}),code('SELF_REVIEW_FORBIDDEN'));

    const sent:string[]=[];
    const transport:ClaudeTransport={async countTokens(){return 2500;},async send(params){const text=JSON.stringify(params.messages);sent.push(text);
      const sensitiveCase=text.includes('普通市民');
      const verdict=sensitiveCase?{verdict:'needs_human',humanReviewCategories:['private_person'],checks:[],reason:'涉及普通个人。',gaps:[]}:
        {verdict:'exploration_only',humanReviewCategories:[],checks:[{changeTitle:'机构发布声明',supported:true,problem:null}],reason:'原文支持，但仅为单一来源。',gaps:['仅单一来源']};
      return {requestId:'req',message:{id:'m',type:'message',role:'assistant',model:'claude-opus-5-5',content:[{type:'text',text:JSON.stringify(verdict),citations:null}],
        stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:2500,output_tokens:200,cache_creation_input_tokens:0,cache_read_input_tokens:0}} as unknown as Message};}};
    const agent=createReviewAgent({client:reviewAgentClient(agentHttp),purpose,disclosure:{rightsPolicyIds:['synthetic-local-only'],allowWikiPages:false},
      port:createClaudeModelPort({transport,ledger:createMemorySpendLedger(),config:{model:'claude-opus-5-5',effort:'high',maxCallUsd:1,dailyCapUsd:5,maxOutputTokens:16000}})});
    const results=await agent.runOnce();
    assert.deepEqual(Object.fromEntries(results.map(result=>[result.ticketId,result.action])),{[supported.id]:'decided',[sensitive.id]:'escalated'});
    assert.ok(sent.every(text=>text.includes('合成来源')),'the agent sent the originals it read itself');

    const decided=(await agentHttp.reviewTicket(supported.id,{purpose})).data;
    assert.equal(decided.status,'finalized');
    assert.deepEqual(decided.reviewer,{principalId:'review-agent-1',kind:'agent',model:'claude-opus-5-5'});
    assert.equal((await agentHttp.reviewQueue({purpose})).data.items.length,0,'escalated tickets leave the agent queue');
    const human=(await agentHttp.reviewQueue({purpose,escalated:'only'})).data.items;
    assert.deepEqual(human.map(item=>[item.id,item.status,item.escalation?.categories,item.escalation?.by.kind]),[[sensitive.id,'pending',['private_person'],'agent']]);
    assert.equal((await agent.runOnce()).length,0,'nothing is reviewed or paid for twice');
  }finally{
    if(server)await new Promise(resolve=>server!.close(resolve));
    await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();
  }
});
