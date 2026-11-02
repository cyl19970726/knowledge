import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import pg from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {seedKnowledgeSyntheticFixture} from '../../../scripts/runtime/knowledge-synthetic-fixture.ts';
import {createKnowledgeApi} from '../src/index.ts';
import {createKnowledgeClient} from '../../../packages/knowledge-client/src/index.ts';
import {createKnowledgeStore} from '../../../packages/knowledge/src/store.ts';
import type {WikiCompiler} from '../../../packages/knowledge-application/src/wiki-compile.ts';
import type {QueryAnswerer} from '../../../packages/knowledge-application/src/ask.ts';
import type {KnowledgeRef,WikiCompileResult,WikiCompileRequest} from '../../../packages/knowledge-contracts/src/index.ts';
const url=readTestDatabase(),dbTest=url?test:test.skip;
const zero={modelCalls:{state:'known' as const,value:0},tokens:{state:'known' as const,value:0},money:{state:'known' as const,amount:0,currency:'USD',source:'synthetic-local-fixture'}};
const code=(value:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code===value;

dbTest('compile C1 → independent review/publish → inherited D → counterexample C2 → current query, while exact history and rights stay distinct',{timeout:90_000},async()=>{
 const admin=new pg.Pool({connectionString:url!,max:2}),schema=`compile_review_${randomUUID().replaceAll('-','')}`;
 await admin.query(`CREATE SCHEMA "${schema}"`);const pool=new pg.Pool({connectionString:url!,max:12,options:`-c search_path=${schema}`});const servers:Server[]=[];
 try{
  const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-loop-${randomUUID()}`),purpose='exploration_reading',scope={projectId:seed.projectId,spaceId:seed.spaceId};
  const reviewerId='independent-fixture-reviewer',loopKey=`loopfixture${randomUUID().replaceAll('-','')}`,derivedKey=`derivefixture${randomUUID().replaceAll('-','')}`;
  const originalA=`synthetic-original-a-${randomUUID()}`,originalB=`synthetic-original-b-${randomUUID()}`;
  let phase:'create'|'derive'|'counterexample'='create',target:KnowledgeRef|null=null,compilerCalls=0,answerCalls=0;
  const compiler:WikiCompiler={id:'synthetic-loop-compiler',model:'synthetic-no-model',methodVersion:'bounded-loop-fixture-v1',execution:'local_deterministic',async compile(input){compilerCalls++;
   const sources=input.evidence.filter(item=>item.kind==='source_content'),old=target?input.evidence.find(item=>item.kind==='wiki_page'&&item.ref.objectId===target!.objectId):undefined;
   if(phase!=='create')assert.ok(old,'published C1 is genuinely read before deriving or correcting');
   return {proposal:{outcome:'proposed',drafts:[{targetEvidenceId:phase==='counterexample'?old!.id:null,
    profile:phase==='counterexample'?old!.wiki!.profile:input.profiles.find(item=>item.id==='question')!,identityKey:phase==='derive'?derivedKey:loopKey,
    title:phase==='derive'?'合成派生认识 D':'合成连续认识 C',summary:phase==='counterexample'?'合成修订：没有可见差异时，应先说明名称；旧顺序只适用于差异可见。':phase==='derive'?'合成派生：解释顺序必须依赖当前C的适用条件。':'合成认识：差异清楚可见时，可先展示差异再报名称。',
    conditions:['仅供合成工程验证','差异是否可见须单独核验'],counterexamples:phase==='counterexample'?['合成反例B不符合旧顺序前提']:[],unknowns:['真实语义与经营效果未验'],nextQuestions:[],
    supportEvidenceIds:[...sources.map(item=>item.id),...phase==='derive'?[old!.id]:[]],rationale:'准确已读资料与旧认识；独立审阅后才可发表'}],reason:'Synthetic engineering proposal',gaps:['No real semantic acceptance']},cost:zero,modelReturned:'synthetic-no-model',requestId:`synthetic-${compilerCalls}`};}};
  const answerer:QueryAnswerer={id:'synthetic-loop-answerer',model:'synthetic-no-model',supportsMoneyLimit:true,async answer(input){answerCalls++;
   return {answer:{outcome:'answered',claims:[{text:input.evidence[0].body,evidenceIds:[input.evidence[0].id]}],reason:'Synthetic evidence echo',gaps:[]},cost:zero,modelReturned:'synthetic-no-model',requestId:'synthetic-answer'};}};
  const authorization={...seed.authorization,adapterIds:[...seed.authorization.adapterIds,'loop-fixture'],actions:[...seed.authorization.actions,'sources:revoke','ingest:read','ingest:write','compile:read','compile:write','review:request','review:read','review:decide','ask:write']};
  async function start(id:string,installation:string){const token=`synthetic-${randomUUID()}-${randomUUID()}`;
   const api=await createKnowledgeApi({pool,token,port:0,principal:{...seed.principal,id,clientInstallationId:installation},writerGrant:seed.writerGrant,compiler,answerer,enableSourceIngest:true,capabilities:authorization,sourceReaderIds:[seed.principal.id,reviewerId]});
   const server=await api.listen();servers.push(server);const address=server.address();assert.ok(address&&typeof address!=='string');
   return createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope,headers:{Authorization:`Bearer ${token}`}});}
  const proposer=await start(seed.principal.id,seed.principal.clientInstallationId!),reviewer=await start(reviewerId,'reviewer-install'),noSource=await start('review-role-without-source','no-source-install');
  async function arrival(text:string,sourceGroup:string){const source=await proposer.registerSource({externalIdentity:{adapterId:'loop-fixture',externalObjectId:randomUUID(),externalVersion:'1'},expectedSourceHead:null,
    sourceSchemaVersion:'synthetic-note/1',contentDigest:createHash('sha256').update(text).digest('hex'),custody:{mode:'managed_copy',text},sourceKind:'document',author:null,publisher:null,acquirer:'synthetic-test',publishedAt:null,obtainedAt:new Date().toISOString(),
    assertionKind:'source_claim',sourceGroups:[{id:sourceGroup,status:'known',authority:'synthetic-original'}],anchors:[],actualCoverage:[],limitations:['Synthetic only'],rightsPolicyRef:'synthetic-local-only'},{idempotencyKey:randomUUID(),purpose});
   const key=`source:${source.data.ref.versionId}`,record=await proposer.registerSourceEvent({adapterId:'loop-fixture',eventKey:key,producerSequence:1,occurredAt:new Date().toISOString(),purpose,sourceRef:{...source.data.ref,domain:'source',contentDigest:source.data.ref.contentDigest!}},{idempotencyKey:key,purpose});
   return {source:source.data.ref,event:record.data.id};}
  const a=await arrival('合成观察A：差异可见时先展示差异。',originalA),aPrime=await arrival('同原始资料A的精细描述：名称随后出现。',originalA),b=await arrival('合成反例B：差异不可见，名称迟到时无法辨认。',originalB);
  const request=(events:string[]):WikiCompileRequest=>({question:'连续研究认识C的条件与反例',purpose,sourceEventIds:events,queries:[loopKey],limit:3,maxPages:2,budget:{maxModelCalls:0,maxReadBytes:400_000,maxMoney:{amount:0,currency:'USD'},deadline:new Date(Date.now()+120_000).toISOString()}});
  const first=(await proposer.compileWiki(request([a.event,aPrime.event]),{idempotencyKey:'compile-c1',purpose})).data;
  assert.equal(first.state,'waiting_for_review');const candidate=first.candidate!;
  assert.equal((await proposer.query({question:loopKey,purpose,limit:10,retrievalMethod:'wiki-lexical-v2'})).data.items.length,0,'staged C is not queryable as published knowledge');
  const firstView=(await proposer.candidateView(candidate.candidateId,purpose)).data;assert.equal(firstView.changes[0].before,null);assert.equal(firstView.changes[0].sourceGroups.length,1,'coarse/fine reports share one original source');
  await assert.rejects(noSource.candidateView(candidate.candidateId,purpose),'review role never grants original-source access');
  const ticket=(await proposer.requestReview({target:{kind:'candidate',candidateId:candidate.candidateId,contentHash:candidate.contentHash},purpose},{idempotencyKey:'request-c1',purpose})).data;
  assert.equal((await reviewer.requestReview({target:ticket.target,purpose},{idempotencyKey:'peer-request-c1',purpose})).data.id,ticket.id,'one exact ticket shared across authorized actors');
  await assert.rejects(proposer.decideReview(ticket.id,{expectedDigest:candidate.contentHash,decision:'exploration_only',reason:'self must fail',conditions:[],gaps:[]},{idempotencyKey:'self-review',purpose}),code('SELF_REVIEW_FORBIDDEN'));
  await assert.rejects(reviewer.decideReview(ticket.id,{expectedDigest:'a'.repeat(64),decision:'exploration_only',reason:'wrong digest',conditions:[],gaps:[]},{idempotencyKey:'wrong-digest',purpose}));
  await assert.rejects(reviewer.decideReview(ticket.id,{expectedDigest:candidate.contentHash,decision:'exploration_only',reason:'new condition needs revision',conditions:['an unseen new condition'],gaps:[]},{idempotencyKey:'change-during-review',purpose}),code('REVIEW_CONTENT_CHANGE_REQUIRED'));
  const publicationsBefore=(await pool.query('SELECT count(*)::int n FROM ccl_knowledge_publications')).rows[0].n;
  await pool.query(`CREATE FUNCTION fail_compilation_publication_finish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.state='published' THEN RAISE EXCEPTION 'synthetic publication finish failure'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER fail_compilation_publication_finish BEFORE UPDATE ON ccl_knowledge_compilations FOR EACH ROW EXECUTE FUNCTION fail_compilation_publication_finish()`);
  await assert.rejects(reviewer.decideReview(ticket.id,{expectedDigest:candidate.contentHash,decision:'exploration_only',reason:'Synthetic independent engineering approval only',conditions:[],gaps:[]},{idempotencyKey:'approve-c1',purpose}));
  assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_publications')).rows[0].n,publicationsBefore,'publication and review roll back when ledger finalization fails');
  assert.equal(await createKnowledgeStore(pool).head(seed.projectId,candidate.draftRefs[0].objectId),null);
  assert.equal((await proposer.reviewTicket(ticket.id,{purpose})).data.status,'pending');
  await pool.query('DROP TRIGGER fail_compilation_publication_finish ON ccl_knowledge_compilations');
  await pool.query(`CREATE FUNCTION delay_same_review_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.request_key='approve-c1' THEN PERFORM pg_sleep(0.3); END IF; RETURN NEW; END; $$;
    CREATE TRIGGER delay_same_review_receipt BEFORE INSERT ON ccl_knowledge_capability_receipts FOR EACH ROW EXECUTE FUNCTION delay_same_review_receipt()`);
  const approvals=await Promise.all([1,2].map(()=>reviewer.decideReview(ticket.id,{expectedDigest:candidate.contentHash,decision:'exploration_only',reason:'Synthetic independent engineering approval only',conditions:[],gaps:[]},{idempotencyKey:'approve-c1',purpose})));
  await pool.query('DROP TRIGGER delay_same_review_receipt ON ccl_knowledge_capability_receipts');
  const approved=approvals[0].data;assert.equal(approvals[1].data.reviewReceiptId,approved.reviewReceiptId,'concurrent same-key approvals replay one exact receipt');
  assert.ok(approved.publication);target=approved.publication!.refs[0];
  assert.equal((await proposer.compilation(first.id,purpose)).data.state,'published');assert.equal((await reviewer.candidateView(candidate.candidateId,purpose)).data.state,'published');
  const firstDocument=(await proposer.document(target,purpose)).data;assert.equal(firstDocument.status.current,true);assert.equal(firstDocument.sourceGroups.length,1);
  assert.equal((await reviewer.decideReview(ticket.id,{expectedDigest:candidate.contentHash,decision:'exploration_only',reason:'Synthetic independent engineering approval only',conditions:[],gaps:[]},{idempotencyKey:'approve-c1',purpose})).data.reviewReceiptId,approved.reviewReceiptId);
  async function publish(compilation:WikiCompileResult,key:string){const c=compilation.candidate!;const t=(await proposer.requestReview({target:{kind:'candidate',candidateId:c.candidateId,contentHash:c.contentHash},purpose},{idempotencyKey:`ticket-${key}`,purpose})).data;
   return {ticket:t,final:(await reviewer.decideReview(t.id,{expectedDigest:c.contentHash,decision:'exploration_only',reason:'Synthetic independent fixture approval',conditions:[],gaps:[]},{idempotencyKey:`approve-${key}`,purpose})).data};}
  phase='derive';const d=(await proposer.compileWiki(request([a.event]),{idempotencyKey:'compile-d',purpose})).data;const dFinal=await publish(d,'d');const dRef=dFinal.final.publication!.refs[0];
  assert.equal((await proposer.document(dRef,purpose)).data.status.validity.valid,true);
  phase='counterexample';const second=(await proposer.compileWiki(request([b.event]),{idempotencyKey:'compile-c2',purpose})).data;
  const sibling=(await proposer.compileWiki(request([b.event]),{idempotencyKey:'compile-sibling',purpose})).data;
  const delta=(await reviewer.candidateView(second.candidate!.candidateId,purpose)).data;assert.equal(delta.changes[0].effect,'correct');assert.equal(delta.changes[0].before?.ref.versionId,target.versionId);assert.match(delta.changes[0].before!.body,/差异清楚可见|差异可见/);
  const staleTicket=(await proposer.requestReview({target:{kind:'candidate',candidateId:sibling.candidate!.candidateId,contentHash:sibling.candidate!.contentHash},purpose},{idempotencyKey:'stale-request',purpose})).data;
  const secondFinal=await publish(second,'c2'),c2=secondFinal.final.publication!.refs[0];assert.equal(c2.objectId,target.objectId);assert.notEqual(c2.versionId,target.versionId);
  const latest=(await proposer.query({question:loopKey,purpose,limit:10,retrievalMethod:'wiki-lexical-v2'})).data.items;assert.ok(latest.some(item=>item.ref.versionId===c2.versionId));assert.ok(latest.every(item=>item.ref.versionId!==target!.versionId));
  assert.equal((await proposer.compilation(second.id,purpose)).data.state,'published','correct publication can retain its historical old-page input');
  assert.equal((await proposer.compilation(first.id,purpose)).data.state,'published');
  assert.equal((await reviewer.decideReview(ticket.id,{expectedDigest:candidate.contentHash,decision:'exploration_only',reason:'Synthetic independent engineering approval only',conditions:[],gaps:[]},{idempotencyKey:'approve-c1',purpose})).data.reviewReceiptId,approved.reviewReceiptId,'exact review replay remains historical after C2');
  assert.equal((await proposer.document(dRef,purpose)).data.status.validity.valid,false,'critical dependency C1 is stale after C2');
  const asksBefore=answerCalls,staleAnswer=await proposer.ask({question:derivedKey,purpose,limit:3,maxPages:1,includeSourceContent:false,budget:{maxModelCalls:0,maxReadBytes:200_000,maxMoney:{amount:0,currency:'USD'},deadline:new Date(Date.now()+30_000).toISOString()}},{idempotencyKey:'stale-derived-query',purpose});
  assert.equal(staleAnswer.data.state,'needs_evidence');assert.equal(answerCalls,asksBefore,'invalidated D cannot be used by answerer');
  const stale=(await reviewer.candidateView(sibling.candidate!.candidateId,purpose)).data;assert.equal(stale.reviewable,false);assert.equal(stale.changes[0].before?.ref.versionId,target.versionId,'stale candidate still shows its exact original base');
  const pubCount=(await pool.query('SELECT count(*)::int n FROM ccl_knowledge_publications')).rows[0].n;
  await assert.rejects(reviewer.decideReview(staleTicket.id,{expectedDigest:sibling.candidate!.contentHash,decision:'exploration_only',reason:'stale head must fail',conditions:[],gaps:[]},{idempotencyKey:'stale-approve',purpose}));
  assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_publications')).rows[0].n,pubCount);
  await proposer.revokeSource(a.source,{expectedGeneration:1,contentDigest:a.source.contentDigest},{idempotencyKey:'revoke-origin-a',purpose});
  await assert.rejects(proposer.compilation(first.id,purpose));await assert.rejects(proposer.compilation(second.id,purpose));await assert.rejects(reviewer.candidateView(candidate.candidateId,purpose));
  await assert.rejects(reviewer.decideReview(ticket.id,{expectedDigest:candidate.contentHash,decision:'exploration_only',reason:'Synthetic independent engineering approval only',conditions:[],gaps:[]},{idempotencyKey:'approve-c1',purpose}),'approved receipt replay rechecks withdrawn basis');
  assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_publications')).rows[0].n,pubCount);
  assert.equal(compilerCalls,4);assert.ok(await createKnowledgeStore(pool).get(seed.projectId,c2));
 }finally{for(const server of servers)await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
