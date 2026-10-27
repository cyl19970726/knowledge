import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {seedKnowledgeSyntheticFixture} from '../../../scripts/runtime/knowledge-synthetic-fixture.ts';
import {createKnowledgeStore} from '../../../packages/knowledge/src/store.ts';
import {FeedbackInputSchema,type SourceUpsert} from '../../../packages/knowledge-contracts/src/index.ts';
import {createSyntheticResearchService} from '../../../packages/knowledge-application/src/research.ts';
import {createPgSourceRegistry,migrateManagedSources} from '../../../packages/adapters/knowledge-service/src/sources.ts';
import {createPgFeedbackSourcePort} from '../../../packages/adapters/knowledge-service/src/feedback-source.ts';
import {createPgUseFeedbackPort,migrateKnowledgeUses} from '../../../packages/adapters/knowledge-service/src/uses.ts';
import {createPgKnowledgeOperations,migrateKnowledgeOperations} from '../../../packages/adapters/knowledge-service/src/operations.ts';
import {createPgReviewPort,migrateKnowledgeReviews} from '../../../packages/adapters/knowledge-service/src/reviews.ts';

const url=readTestDatabase(),dbTest=url?test:test.skip;
const isCode=(expected:string)=>(error:unknown)=>typeof error==='object'&&error!==null&&'code' in error&&error.code===expected;

dbTest('source and feedback-source write replays cannot report withdrawn or replaced rights as current', {timeout:60_000},async()=>{
  const admin=new pg.Pool({connectionString:url!,max:2}),schema=`ccl_knowledge_replay_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString:url!,max:8,options:`-c search_path=${schema}`});
  try{
    const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-${randomUUID()}`);
    const context={scope:{projectId:seed.projectId,spaceId:seed.spaceId},principal:seed.principal,
      purpose:'exploration_reading',authorization:seed.authorization};
    const sources=createPgSourceRegistry(pool,{writerGrant:seed.writerGrant});
    const stored=await pool.query<{payload:SourceUpsert}>(`SELECT payload FROM ccl_knowledge_source_versions
      WHERE project_id=$1 AND space_id=$2 AND object_id=$3 AND version_id=$4`,
      [seed.projectId,seed.spaceId,seed.source.ref.objectId,seed.source.ref.versionId]);
    const original=stored.rows[0].payload;
    assert.equal((await sources.upsert(context,original,'synthetic-source-v1')).readability.contentReadable,true);
    const replacement=await sources.upsert(context,{...original,externalIdentity:{...original.externalIdentity,externalVersion:'2'},
      expectedSourceHead:seed.source.ref.versionId},'synthetic-source-v2');
    await assert.rejects(sources.upsert(context,original,'synthetic-source-v1'),isCode('SOURCE_REPLAY_STALE'));
    await sources.revoke(context,replacement.ref,2,'synthetic-source-revoke');
    await assert.rejects(sources.upsert(context,{...original,externalIdentity:{...original.externalIdentity,externalVersion:'2'},
      expectedSourceHead:seed.source.ref.versionId},'synthetic-source-v2'),isCode('SOURCE_REPLAY_STALE'));

    await migrateKnowledgeUses(pool);
    const feedbackPort=createPgUseFeedbackPort(pool,{writerGrant:seed.writerGrant});
    const feedback=await feedbackPort.feedback(context,FeedbackInputSchema.parse({purpose:'exploration_reading',useId:null,context:{adapterId:'document',
      externalId:`feedback-${randomUUID()}`,contextVersion:'1',inputDigest:'a'.repeat(64),authority:'caller_reported',
      description:'Synthetic reported observation'},knowledgeRefs:[],feedbackKey:randomUUID(),status:'observed',
      observedAt:new Date().toISOString(),observation:'A synthetic reader saw a label.',rawQuotation:null,
      interpretation:'The label might help; unverified.',recommendation:null,artifactDigest:null,measurementScope:null,
      cost:{modelCalls:{state:'known',value:0},tokens:{state:'known',value:0},money:{state:'unknown',reason:'Not billed'}},gaps:[]}),randomUUID());
    const feedbackSources=createPgFeedbackSourcePort(pool,{writerGrant:seed.writerGrant,rightsPolicyRef:'synthetic-local-only'});
    const feedbackKey=randomUUID(),registered=await feedbackSources.register(context,feedback.id,feedback.digest,feedbackKey);
    assert.equal((await feedbackSources.register(context,feedback.id,feedback.digest,feedbackKey)).ref.versionId,registered.ref.versionId);
    await sources.revoke(context,registered.ref,1,'feedback-source-revoke');
    await assert.rejects(feedbackSources.register(context,feedback.id,feedback.digest,feedbackKey),isCode('SOURCE_REPLAY_STALE'));
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});

dbTest('revoked source blocks approval but allows independent rejection; ticket metadata remains role-scoped', {timeout:60_000},async()=>{
  const admin=new pg.Pool({connectionString:url!,max:2}),schema=`ccl_knowledge_review_access_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString:url!,max:8,options:`-c search_path=${schema}`});
  try{
    const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-${randomUUID()}`);
    const context={scope:{projectId:seed.projectId,spaceId:seed.spaceId},principal:seed.principal,
      purpose:'exploration_reading',authorization:seed.authorization};
    await migrateKnowledgeOperations(pool);await migrateKnowledgeReviews(pool);
    const sources=createPgSourceRegistry(pool,{writerGrant:seed.writerGrant}),operations=createPgKnowledgeOperations(pool,seed.writerGrant);
    const research=createSyntheticResearchService({store:createKnowledgeStore(pool,{writerGrant:seed.writerGrant}),
      receipts:{async save(){},async get(){return null;}},operations,sources});
    const operation=await research.submit(context,{question:'Review a revoked synthetic source',purpose:'exploration_reading',
      sourceRefs:[seed.source.ref],knowledgeRefs:[],baseHeads:[],budget:{maxModelCalls:0,maxReadBytes:10000,
        deadline:new Date(Date.now()+60_000).toISOString(),maxMoney:null},allowExternalAcquisition:false},randomUUID());
    assert.equal(await research.processOne(seed.projectId),true);
    const result=(await operations.get(context.scope,context.principal.id,operation.id))?.result;assert.ok(result);
    const reviews=createPgReviewPort(pool,seed.writerGrant,sources);
    const ticket=await reviews.request(context,{target:{kind:'research_result',researchId:operation.id,
      resultDigest:result.resultDigest},purpose:'exploration_reading'},randomUUID());
    assert.equal((await reviews.ticket(context,ticket.id))?.id,ticket.id);
    const unrelated={...context,principal:{...seed.principal,id:'unrelated-same-scope'},
      authorization:{...seed.authorization,actions:[]}};
    assert.equal(await reviews.ticket(unrelated,ticket.id),null);
    const reviewer={...context,principal:{...seed.principal,id:'independent-reviewer'},
      authorization:{...seed.authorization,actions:['review:decide']}};
    assert.equal((await reviews.ticket(reviewer,ticket.id))?.id,ticket.id);
    await sources.revoke(context,seed.source.ref,1,randomUUID());
    await assert.rejects(reviews.decide(reviewer,ticket.id,{expectedDigest:result.resultDigest,
      decision:'exploration_only',reason:'Cannot approve a withdrawn source',conditions:[],gaps:[]},randomUUID()),
      isCode('SOURCE_PROOF_UNAVAILABLE'));
    const closed=await reviews.decide(reviewer,ticket.id,{expectedDigest:result.resultDigest,
      decision:'rejected',reason:'Source rights were withdrawn',conditions:[],gaps:['Source unavailable']},randomUUID());
    assert.equal(closed.publication,null);assert.equal(closed.result,'no_change');
    assert.equal((await operations.get(context.scope,context.principal.id,operation.id))?.operation.state,'succeeded');
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
