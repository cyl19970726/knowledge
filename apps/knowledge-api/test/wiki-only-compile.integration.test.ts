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
import {assertKnowledgeWriterAuthority} from '../../../packages/knowledge/src/writer-authority.ts';
import {digest} from '../../../packages/knowledge/src/utils.ts';
import type {WikiCompiler} from '../../../packages/knowledge-application/src/wiki-compile.ts';
import type {QueryAnswerer} from '../../../packages/knowledge-application/src/ask.ts';
import type {WikiCompileRequest} from '../../../packages/knowledge-contracts/src/index.ts';

const url=readTestDatabase(),dbTest=url?test:test.skip;
const zero={modelCalls:{state:'known' as const,value:0},tokens:{state:'known' as const,value:0},money:{state:'known' as const,amount:0,currency:'USD',source:'synthetic-local-fixture'}};

dbTest('selected Wiki alone stages a local candidate, independent review publishes it, and Ask reads the new current page',{timeout:90_000},async()=>{
 const admin=new pg.Pool({connectionString:url!,max:1}),schema=`wiki_only_${randomUUID().replaceAll('-','')}`;
 await admin.query(`CREATE SCHEMA "${schema}"`);
 const pool=new pg.Pool({connectionString:url!,max:8,options:`-c search_path=${schema}`}),servers:Server[]=[];
 try{
  const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-wiki-only-${randomUUID()}`),scope={projectId:seed.projectId,spaceId:seed.spaceId},purpose='exploration_reading';
  const reviewerId='synthetic-independent-wiki-reviewer';
  // The shared seed predates these HTTP identities. Grant the independent reviewer
  // source read access inside this disposable fixture before any candidate is staged.
  const setup=await pool.connect();try{await setup.query('BEGIN');await assertKnowledgeWriterAuthority(setup,seed.projectId,seed.writerGrant);
   await setup.query(`UPDATE ccl_knowledge_source_heads SET readers=$1 WHERE project_id=$2 AND space_id=$3 AND object_id=$4`,
    [JSON.stringify([seed.principal.id,reviewerId]),seed.projectId,seed.spaceId,seed.source.ref.objectId]);
   await setup.query('COMMIT');}catch(error){await setup.query('ROLLBACK');throw error;}finally{setup.release();}
  const store=createKnowledgeStore(pool),old=(await store.get(seed.projectId,seed.root))!.revision;
  const selected={...scope,domain:'knowledge' as const,...seed.root,contentDigest:digest(old)};
  let compilerCalls=0,answerCalls=0,firstPublishedObjectId='';
  const compiler:WikiCompiler={id:'synthetic-wiki-only-compiler',model:'synthetic-no-model',methodVersion:'wiki-only-compiler-fixture-v1',execution:'local_deterministic',
   async compile(input){compilerCalls++;
    assert.equal(input.evidence.length,1);assert.equal(input.evidence[0].kind,'wiki_page');
    assert.deepEqual(input.evidence[0].ref,selected);
    return {proposal:{outcome:'proposed',drafts:[{targetEvidenceId:null,profile:input.profiles.find(item=>item.id==='question')!,
     identityKey:`wiki-only-${selected.objectId}`,title:'选区编纂的新认识',summary:'仅由合成旧页提出的新认识。',
     conditions:['仅适用于合成资料'],counterexamples:[],unknowns:['真实语义未验'],nextQuestions:[],
     supportEvidenceIds:[input.evidence[0].id],rationale:'准确旧版已实际读取'}],reason:'Synthetic Wiki-only proposal',gaps:[]},
     cost:zero,modelReturned:'synthetic-no-model',requestId:'synthetic-wiki-only'};}};
  const answerer:QueryAnswerer={id:'synthetic-wiki-only-answer',model:'synthetic-no-model',supportsMoneyLimit:true,
   async answer(input){answerCalls++;const current=input.evidence.find(item=>item.ref.objectId===firstPublishedObjectId)!;
    return {answer:{outcome:'answered',claims:[{text:current.body,evidenceIds:[current.id]}],
    reason:'Synthetic answer only',gaps:[]},cost:zero,modelReturned:'synthetic-no-model',requestId:'synthetic-answer'};}};
  const authorization={...seed.authorization,actions:[...seed.authorization.actions,'compile:read','compile:write','review:request','review:read','review:decide','ask:write']};
  assert.equal(authorization.actions.includes('ingest:read'),false,'Wiki-only caller has no source-event read action');
  async function open(id:string,installation:string){const token=`synthetic-${randomUUID()}-${randomUUID()}`;
   const api=await createKnowledgeApi({pool,token,port:0,principal:{...seed.principal,id,clientInstallationId:installation},writerGrant:seed.writerGrant,
    compiler,answerer,enableSourceIngest:true,capabilities:authorization,sourceReaderIds:[seed.principal.id,reviewerId]});
   const server=await api.listen();servers.push(server);const address=server.address();assert.ok(address&&typeof address!=='string');
   return createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope,headers:{Authorization:`Bearer ${token}`}});}
  const proposer=await open(seed.principal.id,seed.principal.clientInstallationId!),reviewer=await open(reviewerId,'reviewer-wiki-only');
  const request:WikiCompileRequest={question:'合成准确页能提出什么新认识',purpose,sourceEventIds:[],selectedRefs:[selected],queries:['不会命中任何旧页的选区专用词'],
   limit:2,maxPages:1,budget:{maxModelCalls:0,maxReadBytes:200_000,maxMoney:{amount:0,currency:'USD'},deadline:new Date(Date.now()+90_000).toISOString()}};
  const first=(await proposer.compileWiki(request,{idempotencyKey:'wiki-only-first',purpose})).data;
  assert.equal(first.state,'waiting_for_review');assert.equal(first.evidence.length,1);assert.equal(first.evidence[0].ref.versionId,selected.versionId);
  assert.equal(first.readUsage.sourceContentBytes,0);assert.ok(first.readUsage.wikiPayloadBytes>0);assert.equal(compilerCalls,1);
  assert.equal((await proposer.compilationLookup('wiki-only-first',purpose)).data.state,'known');
  assert.equal((await proposer.compileWiki(request,{idempotencyKey:'wiki-only-first',purpose})).data.id,first.id);assert.equal(compilerCalls,1);
  const tiny=(await proposer.compileWiki({...request,budget:{...request.budget,maxReadBytes:1}},
   {idempotencyKey:'wiki-only-tiny',purpose})).data;
  assert.equal(tiny.state,'failed');assert.match(tiny.reason,/KNOWLEDGE_READ_BUDGET_EXCEEDED/);assert.equal(compilerCalls,1);
  const prior=(await store.history(seed.projectId,seed.root.objectId)).find(view=>view.revision.ref.versionId!==seed.root.versionId)!;
  const stale=(await proposer.compileWiki({...request,selectedRefs:[{...selected,versionId:prior.revision.ref.versionId,contentDigest:digest(prior.revision)}]},
   {idempotencyKey:'wiki-only-old-head',purpose})).data;
  assert.equal(stale.state,'failed');assert.match(stale.reason,/CANDIDATE_NOT_ADMITTED/);assert.equal(compilerCalls,1);
  const beforeScope=(await pool.query('SELECT count(*)::int n FROM ccl_knowledge_compilations')).rows[0].n;
  await assert.rejects(proposer.compileWiki({...request,selectedRefs:[{...selected,spaceId:'other-space'}]},
   {idempotencyKey:'wiki-only-cross-scope',purpose}));
  assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_compilations')).rows[0].n,beforeScope,'foreign selected ref is denied before reservation');
  const candidate=first.candidate!;assert.equal(candidate.published,false);
  const ticket=(await proposer.requestReview({target:{kind:'candidate',candidateId:candidate.candidateId,contentHash:candidate.contentHash},purpose},
   {idempotencyKey:'wiki-only-ticket',purpose})).data;
  const decision=(await reviewer.decideReview(ticket.id,{expectedDigest:candidate.contentHash,decision:'exploration_only',
   reason:'Synthetic independent review only',conditions:[],gaps:[]},{idempotencyKey:'wiki-only-approve',purpose})).data;
  assert.ok(decision.publication);const ref=decision.publication!.refs[0];firstPublishedObjectId=ref.objectId;
  assert.equal((await proposer.compilation(first.id,purpose)).data.state,'published');
  assert.equal((await store.head(seed.projectId,ref.objectId))?.versionId,ref.versionId);
  const answer=(await proposer.ask({question:'选区编纂的新认识',purpose,limit:5,maxPages:1,includeSourceContent:false,
   budget:{maxModelCalls:1,maxReadBytes:200_000,maxMoney:{amount:0,currency:'USD'},deadline:new Date(Date.now()+30_000).toISOString()}},
   {idempotencyKey:'wiki-only-next-ask',purpose})).data;
  assert.equal(answer.state,'answered',answer.reason);assert.ok(answer.evidence.some(item=>item.ref.objectId===ref.objectId&&item.ref.versionId===ref.versionId));
  assert.equal(answerCalls,1);
  await proposer.revokeSource(seed.source.ref,{expectedGeneration:1,contentDigest:seed.source.ref.contentDigest},{idempotencyKey:'wiki-only-revoke',purpose});
  const withdrawn=(await proposer.compileWiki(request,{idempotencyKey:'wiki-only-after-revoke',purpose})).data;
  assert.equal(withdrawn.state,'failed',withdrawn.reason);assert.match(withdrawn.reason,/CANDIDATE_NOT_ADMITTED|SOURCE|READSET|FORBIDDEN/);
  assert.equal(withdrawn.provider,null);assert.equal(withdrawn.evidence.length,0);
  assert.equal(compilerCalls,1,'revoked critical source cannot reach compiler or disclose the first response');
 }finally{for(const server of servers)await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
