import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import pg from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {seedKnowledgeSyntheticFixture} from '../../../scripts/runtime/knowledge-synthetic-fixture.ts';
import {createKnowledgeApi,tokenSha256,type ApiPrincipal} from '../src/index.ts';
import {parsePrincipalsFile} from '../src/principals-file.ts';
import {createKnowledgeClient} from '../../../packages/knowledge-client/src/index.ts';
import type {WikiCompiler} from '../../../packages/knowledge-application/src/wiki-compile.ts';

const url=readTestDatabase(),dbTest=url?test:test.skip;
const zero={modelCalls:{state:'known' as const,value:0},tokens:{state:'known' as const,value:0},money:{state:'known' as const,amount:0,currency:'USD',source:'synthetic-local-fixture'}};
const code=(value:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code===value;

test('principals file holds token digests, per-principal purposes and attested actors',()=>{
  const digest='a'.repeat(64);
  const parsed=parsePrincipalsFile(JSON.stringify({principals:[
    {id:'review-agent-1',tokenSha256:digest,clientInstallationId:'knowledge-review-agent',purposes:['exploration_reading'],actions:['review:read','review:decide'],actor:{kind:'agent',model:'claude-opus-5-5'}},
    {id:'commerce-publishing',tokenSha256:'b'.repeat(64),clientInstallationId:'commerce-publishing',purposes:['publication_feedback'],spaceIds:['s1'],actions:['feedback:write'],adapterIds:['commerce-publishing'],actor:{kind:'service',model:null}}]}),
    {projectId:'p',spaceIds:['s1','s2']});
  assert.deepEqual(parsed[0].principal,{id:'review-agent-1',clientInstallationId:'knowledge-review-agent',projectId:'p',spaceIds:['s1','s2'],purposes:['exploration_reading'],actor:{kind:'agent',model:'claude-opus-5-5'}});
  assert.deepEqual(parsed[1].capabilities,{actions:['feedback:write'],adapterIds:['commerce-publishing'],rightsPolicyIds:[]});
  const bad=(principals:unknown[])=>()=>parsePrincipalsFile(JSON.stringify({principals}),{projectId:'p',spaceIds:['s1']});
  const ok={id:'x',tokenSha256:digest,clientInstallationId:'i',purposes:['exploration_reading'],actions:[],actor:{kind:'service',model:null}};
  assert.throws(bad([{...ok,token:'raw-token-never-allowed'}]));
  assert.throws(bad([{...ok,tokenSha256:'raw-token'}]),/SHA-256/);
  assert.throws(bad([{...ok,spaceIds:['other']}]),/outside/);
  assert.throws(bad([{...ok,actor:{kind:'human',model:'claude-opus-5-5'}}]),/Only agent/);
});

dbTest('one API serves several principals: own tokens, own purposes, independent agent review recorded with its model',{timeout:90_000},async()=>{
  const admin=new pg.Pool({connectionString:url!,max:2}),schema=`multi_principal_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);const pool=new pg.Pool({connectionString:url!,max:10,options:`-c search_path=${schema}`});let server:Server|undefined;
  try{
    const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-${randomUUID()}`),purpose='exploration_reading',scope={projectId:seed.projectId,spaceId:seed.spaceId};
    const compiler:WikiCompiler={id:'synthetic-compiler',model:'synthetic-no-model',methodVersion:'k5-fixture-v1',execution:'local_deterministic',async compile(input){
      const sources=input.evidence.filter(item=>item.kind==='source_content');
      return {proposal:{outcome:'proposed',drafts:[{targetEvidenceId:null,profile:input.profiles.find(item=>item.id==='synthesis')??input.profiles[0],identityKey:`claim:k5-${randomUUID()}`,
        title:'合成断言页',summary:'合成摘要，仅用于多主体审阅接线测试。',conditions:['claim_status:attributed'],counterexamples:[],unknowns:[],nextQuestions:[],
        supportEvidenceIds:sources.map(item=>item.id),rationale:'synthetic'}],reason:'synthetic',gaps:[]},cost:zero,modelReturned:null,requestId:null};}};
    const tokens={proposer:`synthetic-${randomUUID()}`,agent:`synthetic-${randomUUID()}`,publisher:`synthetic-${randomUUID()}`};
    const base=seed.principal;
    const principals:ApiPrincipal[]=[
      {tokenSha256:tokenSha256(tokens.proposer),principal:{...base,actor:{kind:'service',model:null}},
        capabilities:{...seed.authorization,adapterIds:[...seed.authorization.adapterIds,'k5-fixture'],actions:[...seed.authorization.actions,'ingest:read','ingest:write','compile:read','compile:write','review:request','review:read','review:decide']}},
      {tokenSha256:tokenSha256(tokens.agent),principal:{...base,id:'review-agent-1',clientInstallationId:'knowledge-review-agent',actor:{kind:'agent',model:'claude-opus-5-5'}},
        capabilities:{actions:['review:read','review:decide','compile:read'],adapterIds:[],rightsPolicyIds:[]}},
      {tokenSha256:tokenSha256(tokens.publisher),principal:{...base,id:'commerce-publishing',clientInstallationId:'commerce-publishing',purposes:['publication_feedback'],actor:{kind:'service',model:null}},
        capabilities:{actions:['feedback:write'],adapterIds:['commerce-publishing'],rightsPolicyIds:[]}}];
    const api=await createKnowledgeApi({pool,principals,port:0,writerGrant:seed.writerGrant,compiler,enableSourceIngest:true});
    server=await api.listen();const address=server.address();assert.ok(address&&typeof address!=='string');
    const as=(token:string)=>createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope,headers:{Authorization:`Bearer ${token}`}});
    const proposer=as(tokens.proposer),agent=as(tokens.agent),publisher=as(tokens.publisher);

    await assert.rejects(as(`unknown-${randomUUID()}`).capabilities(),code('UNAUTHORIZED'));
    const agentCaps=(await agent.capabilities()).data;
    assert.ok(agentCaps.permittedActions.includes('decideReview')&&!agentCaps.permittedActions.includes('compileWiki'),'actions are per principal');
    assert.deepEqual((await publisher.capabilities({purpose:'publication_feedback'})).data.purposes,['publication_feedback']);
    await assert.rejects(proposer.capabilities({purpose:'publication_feedback'}),code('SCOPE_FORBIDDEN'));

    const text=`合成来源：某机构发布声明。${randomUUID()}`;
    const source=(await proposer.registerSource({externalIdentity:{adapterId:'k5-fixture',externalObjectId:randomUUID(),externalVersion:'1'},expectedSourceHead:null,
      sourceSchemaVersion:'synthetic-note/1',contentDigest:createHash('sha256').update(text).digest('hex'),custody:{mode:'managed_copy',text},sourceKind:'document',author:null,publisher:null,
      acquirer:'synthetic-test',publishedAt:null,obtainedAt:new Date().toISOString(),assertionKind:'source_claim',sourceGroups:[{id:`origin-${randomUUID()}`,status:'known',authority:'synthetic-original'}],
      anchors:[],actualCoverage:[],limitations:['Synthetic only'],rightsPolicyRef:'synthetic-local-only'},{idempotencyKey:randomUUID(),purpose})).data;
    const eventKey=`source:${source.ref.versionId}`;
    const event=(await proposer.registerSourceEvent({adapterId:'k5-fixture',eventKey,producerSequence:1,occurredAt:new Date().toISOString(),purpose,
      sourceRef:{...source.ref,domain:'source',contentDigest:source.ref.contentDigest!}},{idempotencyKey:eventKey,purpose})).data;
    const compiled=(await proposer.compileWiki({question:'该声明说了什么',purpose,sourceEventIds:[event.id],queries:['声明'],limit:3,maxPages:1,
      budget:{maxModelCalls:0,maxReadBytes:400_000,maxMoney:{amount:0,currency:'USD'},deadline:new Date(Date.now()+60_000).toISOString()}},{idempotencyKey:randomUUID(),purpose})).data;
    assert.equal(compiled.state,'waiting_for_review');
    const candidate=compiled.candidate!;
    const ticket=(await proposer.requestReview({target:{kind:'candidate',candidateId:candidate.candidateId,contentHash:candidate.contentHash},purpose},{idempotencyKey:randomUUID(),purpose})).data;
    const decision={expectedDigest:candidate.contentHash,decision:'exploration_only' as const,reason:'Synthetic agent review',conditions:[],gaps:[]};
    await assert.rejects(proposer.decideReview(ticket.id,decision,{idempotencyKey:randomUUID(),purpose}),code('SELF_REVIEW_FORBIDDEN'));
    // The agent reads sources without extra reader configuration: every configured principal is a source reader by default.
    await agent.decideReview(ticket.id,decision,{idempotencyKey:randomUUID(),purpose});
    const finalized=(await agent.reviewTicket(ticket.id,{purpose})).data;
    assert.equal(finalized.status,'finalized');
    assert.deepEqual(finalized.reviewer,{principalId:'review-agent-1',kind:'agent',model:'claude-opus-5-5'});
  }finally{
    if(server)await new Promise(resolve=>server!.close(resolve));
    await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();
  }
});
