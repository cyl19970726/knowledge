import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {seedKnowledgeSyntheticFixture} from '../../../scripts/runtime/knowledge-synthetic-fixture.ts';
import {createKnowledgeStore} from '../../../packages/knowledge/src/store.ts';
import {digest} from '../../../packages/knowledge/src/utils.ts';
import {getWikiPageProfile,wikiPageProfileFingerprint} from '../../../packages/knowledge/src/wiki-page.ts';
import {assertKnowledgeWriterAuthority} from '../../../packages/knowledge/src/writer-authority.ts';
import {wikiCompileStageRequestHash,type WikiCompileStageInput} from '../../../packages/knowledge-application/src/wiki-compile.ts';
import type {CapabilityContext} from '../../../packages/knowledge-application/src/sources.ts';
import type {AskEvidence} from '../../../packages/knowledge-application/src/ask.ts';
import type {WikiCompileResult} from '../../../packages/knowledge-contracts/src/index.ts';
import {createPgSourceRegistry} from '../../../packages/adapters/knowledge-service/src/sources.ts';
import {createPgWikiCompileStage} from '../../../packages/adapters/knowledge-service/src/wiki-compile-stage.ts';
import {createPgWikiCompilations} from '../../../packages/adapters/knowledge-service/src/wiki-compile.ts';
import {migrateKnowledgeReviews} from '../../../packages/adapters/knowledge-service/src/reviews.ts';
import {createPgCompilationReviewPort} from '../../../packages/adapters/knowledge-service/src/compilation-review.ts';

const databaseUrl=readTestDatabase(),dbTest=databaseUrl?test:test.skip;
const code=(name:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&error.code===name;

dbTest('compiled Wiki candidate uses independent local review, exact history and revocation-safe replay',{timeout:120_000},async()=>{
  const admin=new pg.Pool({connectionString:databaseUrl!,max:2}),schema=`wiki_comp_review_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString:databaseUrl!,max:10,options:`-c search_path=${schema}`});
  try{
    const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-${randomUUID()}`,'compile-review');
    await migrateKnowledgeReviews(pool);
    const reviewerId='synthetic-independent-reviewer';
    const owner:CapabilityContext={scope:{projectId:seed.projectId,spaceId:seed.spaceId},principal:seed.principal,
      purpose:'exploration_reading',authorization:{...seed.authorization,
        actions:[...seed.authorization.actions,'review:read']}};
    const reviewer:CapabilityContext={...owner,principal:{...seed.principal,id:reviewerId,clientInstallationId:'review-installation'},
      authorization:{...seed.authorization,actions:['review:read','review:decide']}};
    // A trusted fixture writer grants this reviewer access to the managed source used by the seed Wiki.
    const setup=await pool.connect();
    try{await setup.query('BEGIN');await assertKnowledgeWriterAuthority(setup,seed.projectId,seed.writerGrant);
      await setup.query(`UPDATE ccl_knowledge_source_heads SET readers=$3::jsonb WHERE project_id=$1 AND object_id=$2`,
        [seed.projectId,seed.source.ref.objectId,JSON.stringify([seed.principal.id,reviewerId])]);
      await setup.query('COMMIT');
    }catch(error){await setup.query('ROLLBACK');throw error;}finally{setup.release();}
    const registry=createPgSourceRegistry(pool,{writerGrant:seed.writerGrant});
    const stage=createPgWikiCompileStage(pool,seed.writerGrant,registry);
    const ledger=createPgWikiCompilations(pool,seed.writerGrant);
    const review=createPgCompilationReviewPort(pool,seed.writerGrant,registry);
    const store=createKnowledgeStore(pool,{writerGrant:seed.writerGrant});
    const sourceContent=await registry.readContent(owner.scope,seed.source.ref,null,owner);
    const sourceRecord=await registry.readRecord(owner.scope,seed.source.ref,owner);
    assert.ok(sourceContent&&sourceRecord);
    const source:AskEvidence={id:'source-1',kind:'source_content',ref:sourceContent.ref,title:'合成来源',
      body:sourceContent.content,locator:null,conditions:[],counterexamples:[],unknowns:[],
      actualReadCoverage:[sourceContent.actualCoverage],sourceGroups:sourceRecord.sourceGroups};
    const profile=getWikiPageProfile('question','1')!;
    const input=(id:string,identityKey:string,base?:{evidence:AskEvidence;revision:NonNullable<Awaited<ReturnType<typeof store.get>>>['revision']}):WikiCompileStageInput=>({
      operationId:id,createdAt:new Date().toISOString(),methodVersion:'test-compiler-v1',
      request:{question:'合成来源能支持怎样的限定表达？',purpose:owner.purpose,sourceEventIds:[randomUUID()],
        queries:['合成'],limit:5,maxPages:1,budget:{maxModelCalls:1,maxReadBytes:100000,
          deadline:new Date(Date.now()+120_000).toISOString(),maxMoney:{amount:0,currency:'USD'}}},
      proposal:{outcome:'proposed',reason:'仅用于独立审阅测试',gaps:[],drafts:[{
        targetEvidenceId:base?.evidence.id??null,
        profile:{id:profile.id,version:profile.version,digest:wikiPageProfileFingerprint(profile)},
        identityKey,title:'合成编纂候选',summary:base?'修订后的合成候选。':'第一版合成候选。',
        conditions:['仅限合成来源'],counterexamples:['不能证明经营成效'],unknowns:['未验证真实读者'],
        nextQuestions:['如何验证？'],supportEvidenceIds:base?[base.evidence.id]:[source.id],
        rationale:'一份来源只算一份来源'}]},evidence:base?[base.evidence]:[source],
      bases:base?new Map([[base.evidence.id,base.revision]]):new Map(),
      sourceProofs:base?[]:[awaitedProof],cost:{modelCalls:{state:'known',value:1},
        tokens:{state:'known',value:10},money:{state:'known',amount:0,currency:'USD',source:'synthetic-test'}}});
    const awaitedProof=await registry.proof(owner,source.ref);
    const stageResult=async(stageInput:WikiCompileStageInput)=>{
      const {body:_,...evidence}=stageInput.evidence[0];
      const initial:WikiCompileResult={id:stageInput.operationId,question:stageInput.request.question,purpose:owner.purpose,
        state:'reserved',drafts:[],candidate:null,stageStatus:'not_requested',evidence:[],excluded:[],
        readUsage:{wikiPayloadBytes:0,sourceContentBytes:0,preparedInputBytes:0,maxReadBytes:stageInput.request.budget.maxReadBytes},
        readsetFingerprint:digest([]),coverage:{scopeDescription:'synthetic scope',returned:0,loaded:0,hasMore:false,
          nextCursor:null,completeness:'bounded',omittedReasons:[],snapshot:{publicationEpoch:null,consistency:'single_scope_snapshot'}},
        cost:{modelCalls:{state:'known',value:0},tokens:{state:'known',value:0},
          money:{state:'known',amount:0,currency:'USD',source:'no_provider_call'}},
        provider:null,reason:'Reserved',gaps:[],createdAt:stageInput.createdAt,completedAt:null};
      await ledger.reserve(owner,randomUUID(),digest(stageInput.request),stageInput.request,initial);
      assert.equal(await ledger.start(owner,stageInput.operationId),true);
      const receipt=await stage.stage(owner,stageInput);
      const stageIntent={requestHash:wikiCompileStageRequestHash(stageInput)};
      const running:WikiCompileResult={...initial,state:'running',drafts:stageInput.proposal.drafts,candidate:null,
        evidence:[evidence],readsetFingerprint:digest([evidence]),stageIntent,cost:stageInput.cost,
        provider:{id:'synthetic-test',modelRequested:'synthetic-test',modelReturned:'synthetic-test',requestId:null},
        reason:stageInput.proposal.reason};
      await ledger.checkpoint(owner,stageInput.operationId,running);
      await ledger.finish(owner,stageInput.operationId,{...running,state:'waiting_for_review',stageStatus:'staged',
        candidate:receipt,completedAt:new Date().toISOString()});
      return receipt;
    };
    const firstInput=input(randomUUID(),'review-test-new-page');
    const first=await stageResult(firstInput);
    assert.equal(await review.hasOrigin(owner,first.candidateId),true);
    assert.equal(await review.hasOrigin({...owner,scope:{...owner.scope,spaceId:'other'}},first.candidateId),false);
    assert.equal(await review.hasOrigin({...owner,purpose:''},first.candidateId),false);
    const firstView=await review.viewCandidate(reviewer,first.candidateId);
    assert.equal(firstView?.changes[0].before,null);
    assert.equal(firstView?.canRequestReview,false);
    assert.equal(firstView?.canDecideReview,true);
    assert.equal(firstView?.reviewTicketId,null);
    assert.equal((await review.viewCandidate(owner,first.candidateId))?.canDecideReview,false);
    const unprivileged={...reviewer,authorization:{...reviewer.authorization,actions:[]}};
    await assert.rejects(review.viewCandidate(unprivileged,first.candidateId),code('CANDIDATE_READ_FORBIDDEN'));
    const noSourceRight={...reviewer,principal:{...reviewer.principal,id:'another-reviewer'}};
    await assert.rejects(review.viewCandidate(noSourceRight,first.candidateId),
      code('COMPILATION_SOURCE_ASSURANCE_REQUIRED'));
    const target={kind:'candidate' as const,candidateId:first.candidateId,contentHash:first.contentHash};
    const ticket=await review.request(owner,{target,purpose:owner.purpose},'request-c1');
    const requestingReviewer={...reviewer,authorization:{...reviewer.authorization,
      actions:[...reviewer.authorization.actions,'review:request']}};
    assert.equal((await review.request(requestingReviewer,{target,purpose:owner.purpose},'request-c1-other-actor')).id,ticket.id);
    assert.equal((await review.request(owner,{target,purpose:owner.purpose},'request-c1-another-key')).id,ticket.id);
    assert.equal((await review.viewCandidate(reviewer,first.candidateId))?.reviewTicketId,ticket.id);
    assert.equal((await review.ticket(reviewer,ticket.id))?.id,ticket.id);
    assert.equal(await review.ticket({...reviewer,purpose:'other-purpose',principal:{...reviewer.principal,purposes:['other-purpose']}},ticket.id),null);
    const decision={expectedDigest:first.contentHash,decision:'approved_for_purpose' as const,
      reason:'独立核查合成候选与来源权限',conditions:['仅限合成来源'],gaps:[]};
    await assert.rejects(review.decide(owner,ticket.id,decision,'self-decision'),code('SELF_REVIEW_FORBIDDEN'));
    await assert.rejects(review.decide(noSourceRight,ticket.id,decision,'unreadable-decision'),
      code('COMPILATION_SOURCE_ASSURANCE_REQUIRED'));
    await assert.rejects(review.decide(reviewer,ticket.id,{...decision,gaps:['未经候选声明的缺口']},'new-gap'),
      code('REVIEW_CONTENT_CHANGE_REQUIRED'));
    const finalized=await review.decide(reviewer,ticket.id,decision,'approve-c1');
    assert.ok(finalized.publication);
    assert.equal((await review.request(requestingReviewer,{target,purpose:owner.purpose},'request-c1-after-final')).status,'finalized');
    assert.equal((await review.request(owner,{target,purpose:owner.purpose},'request-c1')).status,'finalized');
    assert.deepEqual(await review.decide(reviewer,ticket.id,decision,'approve-c1'),finalized,'same key is a verified read-only replay');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ccl_knowledge_publications WHERE changeset_id=$1',
      [first.candidateId])).rows[0].n,1);
    await assert.rejects(review.decide(reviewer,ticket.id,decision,'approve-c1-second-key'),code('REVIEW_ALREADY_FINALIZED'));
    const published=await store.get(seed.projectId,{objectId:first.draftRefs[0].objectId,versionId:first.draftRefs[0].versionId});
    assert.ok(published?.published);
    const revision=published.revision;
    assert.equal(revision.kind,'wiki_page');
    if(revision.kind!=='wiki_page')throw new Error('Published first Wiki must be a page');
    const metadata=await store.inspectFrozen!(seed.projectId,revision.ref);assert.ok(metadata);
    const page:AskEvidence={id:'page-1',kind:'wiki_page',ref:{...owner.scope,domain:'knowledge',...revision.ref,
      contentDigest:digest(revision)},title:revision.title,body:revision.body,locator:null,
      conditions:revision.content.conditions,counterexamples:revision.content.counterexamples,
      unknowns:revision.content.unknowns,actualReadCoverage:[],storageDigest:metadata.storageDigest,
      sourceGroups:revision.sourceGroups.map(id=>({id,status:'known',authority:'knowledge-revision-lineage'})),
      wiki:{profile:{id:profile.id,version:profile.version,digest:wikiPageProfileFingerprint(profile)},
        identity:revision.content.identity}};
    const secondInput=input(randomUUID(),revision.content.identity.key,{evidence:page,revision});
    const second=await stageResult(secondInput);
    const updateView=await review.viewCandidate(reviewer,second.candidateId);
    assert.equal(updateView?.changes[0].effect,'correct');
    assert.equal(updateView?.changes[0].before?.ref.versionId,revision.ref.versionId);
    assert.equal(updateView?.changes[0].before?.body,revision.body);
    const secondTarget={target:{kind:'candidate' as const,candidateId:second.candidateId,
      contentHash:second.contentHash},purpose:owner.purpose};
    const [secondTicket,secondShared]=await Promise.all([
      review.request(owner,secondTarget,'request-c2'),
      review.request(requestingReviewer,secondTarget,'request-c2-reviewer')]);
    assert.equal(secondTicket.id,secondShared.id,'concurrent request keys share one exact review ticket');
    const secondDecision={...decision,expectedDigest:second.contentHash};
    assert.ok((await review.decide(reviewer,secondTicket.id,secondDecision,'approve-c2')).publication);
    const historical=await review.viewCandidate(reviewer,second.candidateId);
    assert.equal(historical?.state,'published');
    assert.equal(historical?.changes[0].before?.ref.versionId,revision.ref.versionId);
    const mismatchInput=input(randomUUID(),'cost-mismatch');
    const mismatch=await stageResult(mismatchInput);
    const tamper=await pool.connect();
    try{await tamper.query('BEGIN');await assertKnowledgeWriterAuthority(tamper,seed.projectId,seed.writerGrant);
      await tamper.query(`UPDATE ccl_knowledge_compilations SET result=jsonb_set(result,'{cost,money,amount}','3'::jsonb)
        WHERE id=$1 AND project_id=$2`,[mismatch.candidateId,seed.projectId]);
      await tamper.query('COMMIT');
    }catch(error){await tamper.query('ROLLBACK');throw error;}finally{tamper.release();}
    await assert.rejects(review.request(owner,{target:{kind:'candidate',candidateId:mismatch.candidateId,
      contentHash:mismatch.contentHash},purpose:owner.purpose},'mismatched-cost'),code('COMPILATION_REVIEW_ORIGIN_INVALID'));
    const hashInput=input(randomUUID(),'hash-mismatch');
    const hashReceipt=await stageResult(hashInput);
    const hashTamper=await pool.connect();
    try{await hashTamper.query('BEGIN');await assertKnowledgeWriterAuthority(hashTamper,seed.projectId,seed.writerGrant);
      await hashTamper.query(`UPDATE ccl_knowledge_compilations SET result=jsonb_set(result,'{stageIntent,requestHash}',$2::jsonb)
        WHERE id=$1 AND project_id=$3`,[hashReceipt.candidateId,JSON.stringify('f'.repeat(64)),seed.projectId]);
      await hashTamper.query('COMMIT');
    }catch(error){await hashTamper.query('ROLLBACK');throw error;}finally{hashTamper.release();}
    await assert.rejects(review.request(owner,{target:{kind:'candidate',candidateId:hashReceipt.candidateId,
      contentHash:hashReceipt.contentHash},purpose:owner.purpose},'mismatched-hash'),code('COMPILATION_REVIEW_ORIGIN_INVALID'));
    const rejectedInput=input(randomUUID(),'reject-after-revoke');
    const rejected=await stageResult(rejectedInput);
    const rejectedTicket=await review.request(owner,{target:{kind:'candidate',candidateId:rejected.candidateId,
      contentHash:rejected.contentHash},purpose:owner.purpose},'request-reject');
    await registry.revoke(owner,seed.source.ref,1,'revoke-source');
    await assert.rejects(review.viewCandidate(reviewer,second.candidateId),code('COMPILATION_SOURCE_ASSURANCE_REQUIRED'));
    await assert.rejects(review.decide(reviewer,secondTicket.id,secondDecision,'approve-c2'),
      code('COMPILATION_SOURCE_ASSURANCE_REQUIRED'));
    const rejection=await review.decide(reviewer,rejectedTicket.id,{expectedDigest:rejected.contentHash,
      decision:'rejected',reason:'来源已撤权',conditions:[],gaps:['来源撤权']},'reject-stale');
    assert.equal(rejection.publication,null);
    assert.equal((await ledger.get(owner,rejected.candidateId))?.state,'rejected');
    assert.equal((await review.ticket(reviewer,rejectedTicket.id))?.status,'finalized');
    await assert.rejects(review.decide(reviewer,rejectedTicket.id,{expectedDigest:rejected.contentHash,
      decision:'rejected',reason:'来源已撤权',conditions:[],gaps:['来源撤权']},'reject-stale'),
      code('COMPILATION_SOURCE_ASSURANCE_REQUIRED'),'a replay cannot reveal a derived receipt after source withdrawal');
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
