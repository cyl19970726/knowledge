import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import pg from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {seedKnowledgeSyntheticFixture} from '../../../scripts/runtime/knowledge-synthetic-fixture.ts';
import {assertKnowledgeWriterAuthority} from '../../../packages/knowledge/src/writer-authority.ts';
import {createKnowledgeStore} from '../../../packages/knowledge/src/store.ts';
import {digest} from '../../../packages/knowledge/src/utils.ts';
import {createKnowledgeApi} from '../src/index.ts';
import {createKnowledgeClient} from '../../../packages/knowledge-client/src/index.ts';
import {createPgWikiCompilations} from '../../../packages/adapters/knowledge-service/src/wiki-compile.ts';
import type {WikiCompiler} from '../../../packages/knowledge-application/src/wiki-compile.ts';
import type {QueryAnswerer} from '../../../packages/knowledge-application/src/ask.ts';
import type {KnowledgeRef,WikiCompileRequest,WikiCompileResult} from '../../../packages/knowledge-contracts/src/index.ts';

const url=readTestDatabase(),dbTest=url?test:test.skip;
const zero={modelCalls:{state:'known' as const,value:0},tokens:{state:'known' as const,value:0},money:{state:'known' as const,amount:0,currency:'USD',source:'synthetic-local-fixture'}};
const code=(expected:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code===expected;

dbTest('cited Ask readset becomes exact source and Wiki compiler evidence, then independent review publishes a new current page',{timeout:90_000},async()=>{
 const admin=new pg.Pool({connectionString:url!,max:1}),schema=`answer_compile_${randomUUID().replaceAll('-','')}`;
 await admin.query(`CREATE SCHEMA "${schema}"`);
 const pool=new pg.Pool({connectionString:url!,max:8,options:`-c search_path=${schema}`}),servers:Server[]=[];
 try{
  const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-answer-compile-${randomUUID()}`),purpose='exploration_reading';
  const scope={projectId:seed.projectId,spaceId:seed.spaceId},reviewerId='synthetic-independent-answer-reviewer';
  const setup=await pool.connect();try{await setup.query('BEGIN');await assertKnowledgeWriterAuthority(setup,seed.projectId,seed.writerGrant);
   await setup.query(`UPDATE ccl_knowledge_source_heads SET readers=$1 WHERE project_id=$2 AND space_id=$3 AND object_id=$4`,
    [JSON.stringify([seed.principal.id,reviewerId]),seed.projectId,seed.spaceId,seed.source.ref.objectId]);
   await setup.query('COMMIT');}catch(error){await setup.query('ROLLBACK');throw error;}finally{setup.release();}
  const store=createKnowledgeStore(pool),root=(await store.get(seed.projectId,seed.root))!.revision;
  const feature=(await store.search(seed.projectId,{query:'商品特征',spaceId:seed.spaceId,limit:50}))
   .find(view=>view.revision.title==='商品特征')?.revision;
  assert.ok(feature,'second current Wiki background is present');
  const rootRef:KnowledgeRef={...scope,domain:'knowledge',...seed.root,contentDigest:digest(root)};
  const featureRef:KnowledgeRef={...scope,domain:'knowledge',...feature.ref,contentDigest:digest(feature)};
  let askCalls=0,compilerCalls=0,currentObjectId='';
  const answerer:QueryAnswerer={id:'answer-research-fixture-answerer',model:'synthetic-no-model',supportsMoneyLimit:true,
   async answer(input){askCalls++;
    const wiki=input.evidence.find(item=>item.ref.objectId===rootRef.objectId),background=input.evidence.find(item=>item.ref.objectId===featureRef.objectId),
     source=input.evidence.find(item=>item.kind==='source_content');
    if(askCalls===1){assert.ok(wiki);assert.ok(background,'uncited old Wiki background was read');assert.ok(source,'original Ask actually read source text');}
    const chosen=currentObjectId?input.evidence.find(item=>item.ref.objectId===currentObjectId)!:wiki!;
    return {answer:{outcome:'answered',claims:currentObjectId?[{text:chosen.body,evidenceIds:[chosen.id]}]:[
      {text:wiki!.body,evidenceIds:[wiki!.id,source!.id]},{text:background!.body,evidenceIds:[background!.id]}],
     reason:'Synthetic answer only',gaps:[]},cost:zero,modelReturned:'synthetic-no-model',requestId:`synthetic-ask-${askCalls}`};}};
  const compiler:WikiCompiler={id:'answer-research-fixture-compiler',model:'synthetic-no-model',methodVersion:'answer-research-fixture-v1',execution:'local_deterministic',
   async compile(input){compilerCalls++;
    assert.ok(input.answerSeed);assert.equal(input.answerSeed!.claims.length,1);
    const wiki=input.evidence.find(item=>item.kind==='wiki_page'&&item.ref.objectId===seed.root.objectId),
     background=input.evidence.find(item=>item.ref.objectId===featureRef.objectId),source=input.evidence.find(item=>item.kind==='source_content');
    assert.ok(wiki,'original exact Wiki is re-read');assert.ok(background,'uncited old Wiki background is also re-read');
    assert.ok(source,'original exact primary source is re-read');
    assert.deepEqual(input.answerSeed!.claims[0].evidenceIds,[wiki.id,source.id]);
    return {proposal:{outcome:'proposed',drafts:[{targetEvidenceId:wiki.id,profile:wiki.wiki!.profile,
     identityKey:wiki.wiki!.identity.key,title:'商品的可展示性：答复修订',summary:'完整旧答复读集重新准确读取后形成的修订候选。',
     conditions:['仅供合成工程验证'],counterexamples:[],unknowns:['真实语义未验'],nextQuestions:[],
     supportEvidenceIds:[source.id],rationale:'本轮准确读到的原始来源正文，不将旧target当作自引来源'}],reason:'Synthetic proposal only',gaps:[]},
     cost:zero,modelReturned:'synthetic-no-model',requestId:'synthetic-compile'};}};
  const authorization={...seed.authorization,actions:[...seed.authorization.actions,'compile:read','compile:write','review:request','review:read','review:decide','ask:write']};
  async function open(id:string,installation:string){const token=`synthetic-${randomUUID()}-${randomUUID()}`;
   const api=await createKnowledgeApi({pool,token,port:0,principal:{...seed.principal,id,clientInstallationId:installation},writerGrant:seed.writerGrant,
    compiler,answerer,enableSourceIngest:true,capabilities:authorization,sourceReaderIds:[seed.principal.id,reviewerId]});
   const server=await api.listen();servers.push(server);const address=server.address();assert.ok(address&&typeof address!=='string');
   return createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope,headers:{Authorization:`Bearer ${token}`}});}
  const proposer=await open(seed.principal.id,seed.principal.clientInstallationId!),reviewer=await open(reviewerId,'independent-answer-review');
  const originalQuestion=`syntheticoriginal${randomUUID().replaceAll('-','')}`;
  const original=(await proposer.ask({question:originalQuestion,purpose,selectedRefs:[rootRef,featureRef],limit:2,maxPages:1,includeSourceContent:true,
   budget:{maxModelCalls:1,maxReadBytes:300_000,maxMoney:{amount:0,currency:'USD'},deadline:new Date(Date.now()+60_000).toISOString()}},
   {idempotencyKey:'original-cited-ask',purpose})).data;
  assert.equal(original.state,'answered',original.reason);assert.equal(askCalls,1);
  assert.ok(original.answerFingerprint);assert.equal(original.claims.length,2);
  assert.equal(original.evidence.filter(item=>item.kind==='wiki_page').length,2);
  assert.equal(original.evidence.filter(item=>item.kind==='source_content').length,1);
  const research={purpose,expectedAnswerFingerprint:original.answerFingerprint!,claimIndexes:[0],question:'深入核对这条合成答复',limit:3,maxPages:1,
   budget:{maxModelCalls:0,maxReadBytes:300_000,maxMoney:{amount:0,currency:'USD'},deadline:new Date(Date.now()+60_000).toISOString()}};
  const first=(await proposer.researchAnswer(original.id,research,{idempotencyKey:'research-original-answer',purpose})).data;
  assert.equal(first.state,'waiting_for_review',first.reason);assert.ok(first.answerOrigin);assert.equal(first.answerOrigin.answerId,original.id);
  assert.ok(first.evidence.length>=3);assert.ok(first.evidence.some(item=>item.ref.objectId===featureRef.objectId));
  assert.equal(compilerCalls,1);assert.equal(askCalls,1,'research reuses the original Ask receipt');
  assert.equal((await proposer.researchAnswer(original.id,research,{idempotencyKey:'research-original-answer',purpose})).data.id,first.id);
  assert.equal(compilerCalls,1);assert.equal(askCalls,1);
  await assert.rejects(proposer.researchAnswer(original.id,{...research,expectedAnswerFingerprint:'f'.repeat(64)},
   {idempotencyKey:'bad-answer-fingerprint',purpose}),code('ANSWER_FINGERPRINT_MISMATCH'));
  await assert.rejects(proposer.researchAnswer(original.id,{...research,claimIndexes:[9]},
   {idempotencyKey:'bad-answer-claim',purpose}),code('ANSWER_CLAIM_INDEX_INVALID'));
  const before=(await pool.query('SELECT count(*)::int n FROM ccl_knowledge_compilations')).rows[0].n;
  const source=original.evidence.find(item=>item.kind==='source_content')!.ref;
  const altered:WikiCompileRequest={question:research.question,purpose,sourceEventIds:[],selectedRefs:[rootRef,featureRef],sourceRefs:[],
   answerSeed:{answerId:original.id,expectedAnswerFingerprint:original.answerFingerprint!,claimIndexes:[0]},queries:[research.question],
   limit:3,maxPages:1,budget:research.budget};
  await assert.rejects(proposer.compileWiki(altered,{idempotencyKey:'missing-original-source',purpose}),code('ANSWER_READSET_MISMATCH'));
  await assert.rejects(proposer.compileWiki({...altered,sourceRefs:[{...source,spaceId:'foreign'}]},
   {idempotencyKey:'cross-scope-source',purpose}),code('SOURCE_REF_SCOPE_MISMATCH'));
  assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_compilations')).rows[0].n,before);
  const ledger=createPgWikiCompilations(pool,seed.writerGrant),ledgerRequest:WikiCompileRequest={...altered,sourceRefs:[source]};
  const initial:WikiCompileResult={id:randomUUID(),answerOrigin:first.answerOrigin,question:ledgerRequest.question,purpose,state:'reserved',
   drafts:[],candidate:null,stageStatus:'not_requested',evidence:[],excluded:[],readsetFingerprint:'0'.repeat(64),
   readUsage:{wikiPayloadBytes:0,sourceContentBytes:0,preparedInputBytes:0,maxReadBytes:ledgerRequest.budget.maxReadBytes},
   coverage:{scopeDescription:'synthetic reserved',returned:0,loaded:0,hasMore:false,nextCursor:null,completeness:'unknown',
    omittedReasons:[],snapshot:{publicationEpoch:null,consistency:'single_scope_snapshot'}},cost:zero,provider:null,
   reason:'Synthetic reservation',gaps:[],createdAt:new Date().toISOString(),completedAt:null};
  await assert.rejects(ledger.reserve({scope,principal:seed.principal,purpose},'missing-answer-origin','a'.repeat(64),ledgerRequest,
   {...initial,id:randomUUID(),answerOrigin:undefined}),code('WIKI_COMPILE_ANSWER_ORIGIN_MISMATCH'));
  const reserved=await ledger.reserve({scope,principal:seed.principal,purpose},'frozen-answer-origin','a'.repeat(64),ledgerRequest,initial);
  assert.equal(await ledger.start({scope,principal:seed.principal,purpose},reserved.result.id),true);
  const running=(await ledger.get({scope,principal:seed.principal,purpose},reserved.result.id))!;
  await assert.rejects(ledger.checkpoint({scope,principal:seed.principal,purpose},running.id,
   {...running,answerOrigin:{...running.answerOrigin!,question:'forged original question'}}),code('WIKI_COMPILE_ANSWER_ORIGIN_CHANGED'));
  const candidate=first.candidate!;const ticket=(await proposer.requestReview({target:{kind:'candidate',candidateId:candidate.candidateId,contentHash:candidate.contentHash},purpose},
   {idempotencyKey:'answer-candidate-ticket',purpose})).data;
  const approved=(await reviewer.decideReview(ticket.id,{expectedDigest:candidate.contentHash,decision:'exploration_only',
   reason:'Synthetic independent review',conditions:[],gaps:[]},{idempotencyKey:'answer-candidate-approve',purpose})).data;
  assert.ok(approved.publication);const published=approved.publication!.refs[0];currentObjectId=published.objectId;
  assert.equal(published.objectId,seed.root.objectId);assert.notEqual(published.versionId,seed.root.versionId);
  await assert.rejects(proposer.answer(original.id,purpose),'original public Ask GET now requires its old Wiki to remain current');
  assert.equal((await proposer.compilation(first.id,purpose)).data.state,'published');
  const historical=(await proposer.compilationLookup('research-original-answer',purpose)).data;
  assert.equal(historical.state,'known');if(historical.state==='known')assert.equal(historical.compilation.state,'published');
  assert.equal((await proposer.researchAnswer(original.id,research,{idempotencyKey:'research-original-answer',purpose})).data.state,'published');
  await assert.rejects(proposer.researchAnswer(original.id,research,{idempotencyKey:'new-research-after-old-head',purpose}));
  assert.equal(compilerCalls,1,'a new key may not rerun the original stale Ask or compiler');
  const next=(await proposer.ask({question:'商品的可展示性：答复修订',purpose,limit:3,maxPages:1,includeSourceContent:false,
   budget:{maxModelCalls:1,maxReadBytes:200_000,maxMoney:{amount:0,currency:'USD'},deadline:new Date(Date.now()+30_000).toISOString()}},
   {idempotencyKey:'ask-new-answer-research-page',purpose})).data;
  assert.equal(next.state,'answered',next.reason);assert.ok(next.evidence.some(item=>item.ref.objectId===published.objectId&&item.ref.versionId===published.versionId));
  await proposer.revokeSource(seed.source.ref,{expectedGeneration:1,contentDigest:seed.source.ref.contentDigest},{idempotencyKey:'withdraw-answer-source',purpose});
  await assert.rejects(proposer.compilation(first.id,purpose));
  await assert.rejects(proposer.compilationLookup('research-original-answer',purpose));
  await assert.rejects(proposer.researchAnswer(original.id,research,{idempotencyKey:'research-original-answer',purpose}));
  await assert.rejects(proposer.researchAnswer(original.id,research,{idempotencyKey:'new-research-key-after-revoke',purpose}));
  assert.equal(compilerCalls,1);assert.equal(askCalls,2);
 }finally{for(const server of servers)await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
