import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import pg from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {seedKnowledgeSyntheticFixture} from '../../../scripts/runtime/knowledge-synthetic-fixture.ts';
import {createKnowledgeApi,tokenSha256,type ApiPrincipal} from '../src/index.ts';
import {createKnowledgeClient} from '../../../packages/knowledge-client/src/index.ts';
import type {WikiCompiler} from '../../../packages/knowledge-application/src/wiki-compile.ts';
import type {KnowledgeRef} from '../../../packages/knowledge-contracts/src/index.ts';

const url=readTestDatabase(),dbTest=url?test:test.skip;
const zero={modelCalls:{state:'known' as const,value:0},tokens:{state:'known' as const,value:0},money:{state:'known' as const,amount:0,currency:'USD',source:'synthetic-local-fixture'}};
const codeOf=(error:unknown)=>error&&typeof error==='object'&&'code' in error?String(error.code):'none';

/** The first-round Commerce flow: analysis adopts under exploration_reading; publishing reports back with no use. */
dbTest('publication feedback without a use: accepted for agent-reviewed exploration pages, rejected as a whole when any cited page lost its source',{timeout:120_000},async t=>{
  const admin=new pg.Pool({connectionString:url!,max:2}),schema=`pub_feedback_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);const pool=new pg.Pool({connectionString:url!,max:10,options:`-c search_path=${schema}`});let server:Server|undefined;
  try{
    const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-${randomUUID()}`),purpose='exploration_reading',scope={projectId:seed.projectId,spaceId:seed.spaceId};
    const compiler:WikiCompiler={id:'synthetic-compiler',model:'synthetic-no-model',methodVersion:'pub-feedback-v1',execution:'local_deterministic',async compile(input){
      return {proposal:{outcome:'proposed',drafts:[{targetEvidenceId:null,profile:input.profiles.find(item=>item.id==='synthesis')??input.profiles[0],identityKey:`claim:${randomUUID()}`,
        title:input.question,summary:'合成摘要，仅用于发布反馈接线测试。',conditions:['claim_status:attributed'],counterexamples:[],unknowns:[],nextQuestions:[],
        supportEvidenceIds:input.evidence.filter(item=>item.kind==='source_content').map(item=>item.id),rationale:'synthetic'}],reason:'synthetic',gaps:[]},cost:zero,modelReturned:null,requestId:null};}};
    const tokens={analysis:`synthetic-${randomUUID()}`,agent:`synthetic-${randomUUID()}`,publishing:`synthetic-${randomUUID()}`};
    const principals:ApiPrincipal[]=[
      {tokenSha256:tokenSha256(tokens.analysis),principal:{...seed.principal,id:'commerce-analysis',actor:{kind:'service',model:null}},
        capabilities:{...seed.authorization,adapterIds:[...seed.authorization.adapterIds,'web-link','commerce-analysis'],
          actions:[...seed.authorization.actions,'sources:revoke','ingest:read','ingest:write','compile:read','compile:write','review:request','review:read','uses:write']}},
      {tokenSha256:tokenSha256(tokens.agent),principal:{...seed.principal,id:'review-agent-1',clientInstallationId:'knowledge-review-agent',actor:{kind:'agent',model:'claude-opus-5-5'}},
        capabilities:{actions:['review:read','review:decide','compile:read'],adapterIds:[],rightsPolicyIds:[]}},
      // Exactly the deployed shape: write-only actions, publication_feedback purpose, no read actions.
      {tokenSha256:tokenSha256(tokens.publishing),principal:{...seed.principal,id:'commerce-publishing',clientInstallationId:'commerce-publishing',purposes:['publication_feedback'],actor:{kind:'service',model:null}},
        capabilities:{actions:['uses:write','feedback:write'],adapterIds:['commerce-publishing'],rightsPolicyIds:[]}}];
    const api=await createKnowledgeApi({pool,principals,port:0,writerGrant:seed.writerGrant,compiler,enableSourceIngest:true});
    server=await api.listen();const address=server.address();assert.ok(address&&typeof address!=='string');
    const as=(token:string)=>createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope,headers:{Authorization:`Bearer ${token}`}});
    const analysis=as(tokens.analysis),agent=as(tokens.agent),publishing=as(tokens.publishing);

    /** Registers one source, compiles it, and has the agent principal decide exploration_only under exploration_reading. */
    async function publishedPage(question:string):Promise<{page:KnowledgeRef;source:KnowledgeRef}>{
      const text=`合成来源：${question}。${randomUUID()}`;
      const source=(await analysis.registerSource({externalIdentity:{adapterId:'web-link',externalObjectId:randomUUID(),externalVersion:'1'},expectedSourceHead:null,
        sourceSchemaVersion:'synthetic-note/1',contentDigest:createHash('sha256').update(text).digest('hex'),custody:{mode:'managed_copy',text},sourceKind:'document',author:null,publisher:null,
        acquirer:'synthetic-test',publishedAt:null,obtainedAt:new Date().toISOString(),assertionKind:'source_claim',sourceGroups:[{id:`origin-${randomUUID()}`,status:'known',authority:'synthetic-original'}],
        anchors:[],actualCoverage:[],limitations:['Synthetic only'],rightsPolicyRef:'synthetic-local-only'},{idempotencyKey:randomUUID(),purpose})).data;
      const eventKey=`source:${source.ref.versionId}`;
      const event=(await analysis.registerSourceEvent({adapterId:'web-link',eventKey,producerSequence:1,occurredAt:new Date().toISOString(),purpose,
        sourceRef:{...source.ref,domain:'source',contentDigest:source.ref.contentDigest!}},{idempotencyKey:eventKey,purpose})).data;
      const compiled=(await analysis.compileWiki({question,purpose,sourceEventIds:[event.id],queries:[`nomatch${randomUUID().replaceAll('-','')}`],limit:3,maxPages:1,
        budget:{maxModelCalls:0,maxReadBytes:400_000,maxMoney:{amount:0,currency:'USD'},deadline:new Date(Date.now()+60_000).toISOString()}},{idempotencyKey:randomUUID(),purpose})).data;
      const candidate=compiled.candidate!;
      const ticket=(await analysis.requestReview({target:{kind:'candidate',candidateId:candidate.candidateId,contentHash:candidate.contentHash},purpose},{idempotencyKey:randomUUID(),purpose})).data;
      await agent.decideReview(ticket.id,{expectedDigest:candidate.contentHash,decision:'exploration_only',reason:'Synthetic agent review',conditions:[],gaps:[]},{idempotencyKey:randomUUID(),purpose});
      const done=(await analysis.compilation(compiled.id,purpose)).data;
      assert.equal(done.state,'published');
      return {page:candidate.draftRefs[0],source:{...source.ref,domain:'source'}};
    }
    const observedAt=new Date().toISOString();
    const feedback=(refs:KnowledgeRef[],draftId:string,useIds:string[])=>({purpose:'publication_feedback',useId:null,
      context:{adapterId:'commerce-publishing',externalId:draftId,contextVersion:'1',inputDigest:createHash('sha256').update(draftId).digest('hex'),
        authority:'caller_reported' as const,description:`Published draft ${draftId}; analysis uses ${useIds.join(',')}`},
      knowledgeRefs:refs,feedbackKey:`publication:${draftId}`,status:'observed' as const,observedAt,
      observation:'合成观察：帖子发布后 24 小时内获得若干互动。',rawQuotation:null,interpretation:null,recommendation:null,artifactDigest:null,measurementScope:'synthetic',
      cost:zero,gaps:[]});

    const first=await publishedPage('机构甲发布声明'),second=await publishedPage('机构乙回应质疑');

    await t.test('the analysis principal adopts each cited page under exploration_reading, one exact read and one use per reference',async()=>{
      for(const {page} of [first,second]){
        const read=await analysis.document(page,purpose);
        assert.ok(read.readReceiptId);
        assert.equal(read.data.status.purpose.admitted,true,'exploration_only pages are admitted for exploration_reading');
      }
    });
    const draftId=`draft-${randomUUID()}`;
    const useIds:string[]=[];
    for(const {page} of [first,second]){
      const read=await analysis.document(page,purpose);
      const use=(await analysis.recordUse({context:{adapterId:'commerce-analysis',externalId:draftId,contextVersion:'1',inputDigest:createHash('sha256').update(draftId).digest('hex'),
        authority:'caller_reported',description:'Synthetic draft'},readReceiptId:read.readReceiptId!,purpose,
        considered:[{ref:page,decision:'adopted',reason:'cited in draft',before:null,after:null}],gaps:[],cost:zero},{idempotencyKey:randomUUID(),purpose})).data;
      useIds.push(use.id);
    }

    await t.test('publishing records one feedback with no use, a write-only principal and a purpose the pages were never reviewed for',async()=>{
      const caps=(await publishing.capabilities({purpose:'publication_feedback'})).data;
      assert.ok(caps.permittedActions.includes('recordFeedback'));
      const record=(await publishing.recordFeedback(feedback([first.page,second.page],draftId,useIds),{idempotencyKey:`publication:${draftId}`,purpose:'publication_feedback'})).data;
      assert.equal(record.useId,null);
      assert.equal(record.purpose,'publication_feedback');
      assert.equal(record.knowledgeRefs.length,2);
      const replay=(await publishing.recordFeedback(feedback([first.page,second.page],draftId,useIds),{idempotencyKey:`publication:${draftId}`,purpose:'publication_feedback'})).data;
      assert.equal(replay.id,record.id,'same key and input replay the same record');
    });

    await t.test('K7: one exact-set read gives one receipt, so one use can adopt every cited page of a draft',async()=>{
      assert.ok((await analysis.capabilities()).data.permittedActions.includes('exactSet'));
      const read=await analysis.documents({refs:[first.page,second.page],purpose});
      assert.deepEqual(read.data.items.map(item=>item.ref.objectId),[first.page.objectId,second.page.objectId],'items keep request order');
      const receipt=(await analysis.receipt(read.readReceiptId!,{purpose})).data;
      assert.equal(receipt.request.kind,'exact_set');
      assert.equal(receipt.orderedItems.length,2);
      const draft=`draft-${randomUUID()}`;
      const use=(await analysis.recordUse({context:{adapterId:'commerce-analysis',externalId:draft,contextVersion:'1',inputDigest:createHash('sha256').update(draft).digest('hex'),
        authority:'caller_reported',description:'Synthetic multi-citation draft'},readReceiptId:read.readReceiptId!,purpose,
        considered:[first.page,second.page].map(ref=>({ref,decision:'adopted' as const,reason:'cited in draft',before:null,after:null})),gaps:[],cost:zero},{idempotencyKey:randomUUID(),purpose})).data;
      assert.equal(use.considered.length,2);
      // All-or-nothing: an unknown version fails the whole read and issues no receipt.
      const missing={...first.page,versionId:randomUUID()};
      await assert.rejects(analysis.documents({refs:[first.page,missing],purpose}),(error:unknown)=>codeOf(error)==='NOT_FOUND');
      await assert.rejects(analysis.documents({refs:[first.page,first.page],purpose}),(error:unknown)=>codeOf(error)==='CLIENT_VALIDATION_ERROR');
      await assert.rejects(analysis.documents({refs:[{...first.page,contentDigest:null}],purpose}),(error:unknown)=>codeOf(error)==='CLIENT_VALIDATION_ERROR');
    });
    await t.test('a page whose source was revoked is rejected with FEEDBACK_ACCESS_REVOKED, and so is a feedback mixing it with a valid page',async()=>{
      await analysis.revokeSource({...second.source,contentDigest:null},{expectedGeneration:1,contentDigest:null},{idempotencyKey:randomUUID(),purpose});
      const status=(await analysis.document(second.page,purpose)).data.status;
      assert.equal(status.validity.valid,false);
      let outcome='accepted',code='none';
      try{await publishing.recordFeedback(feedback([second.page],`draft-${randomUUID()}`,[]),{idempotencyKey:randomUUID(),purpose:'publication_feedback'});}
      catch(error){outcome='rejected';code=codeOf(error);}
      t.diagnostic(`revoked-source page feedback: ${outcome} ${code}`);
      // Mixed references: one valid page and one invalid page in the same feedback.
      let mixed='accepted',mixedCode='none';
      try{await publishing.recordFeedback(feedback([first.page,second.page],`draft-${randomUUID()}`,[]),{idempotencyKey:randomUUID(),purpose:'publication_feedback'});}
      catch(error){mixed='rejected';mixedCode=codeOf(error);}
      t.diagnostic(`mixed valid+revoked feedback: ${mixed} ${mixedCode}`);
      assert.deepEqual([outcome,code],['rejected','FEEDBACK_ACCESS_REVOKED']);
      assert.deepEqual([mixed,mixedCode],['rejected','FEEDBACK_ACCESS_REVOKED'],'one invalid reference rejects the whole feedback');
      const valid=(await publishing.recordFeedback(feedback([first.page],`draft-${randomUUID()}`,[]),{idempotencyKey:randomUUID(),purpose:'publication_feedback'})).data;
      assert.equal(valid.knowledgeRefs.length,1,'dropping the invalid reference lets the rest through');
    });
  }finally{
    if(server)await new Promise(resolve=>server!.close(resolve));
    await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();
  }
});
