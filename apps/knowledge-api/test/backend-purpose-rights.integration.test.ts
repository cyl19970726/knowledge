import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {migrateKnowledge} from '../../../packages/knowledge/src/migrations.ts';
import {createKnowledgeStore} from '../../../packages/knowledge/src/store.ts';
import type {KnowledgeChangeSet,KnowledgeReview,KnowledgeRevision} from '../../../packages/knowledge/src/types.ts';
import {createKnowledgeApplication} from '../../../packages/knowledge-application/src/index.ts';
import {createUseFeedbackApplication} from '../../../packages/knowledge-application/src/uses.ts';
import {createPgKnowledgeReceiptPort,migrateKnowledgeReadReceipts} from '../../../packages/adapters/knowledge-service/src/index.ts';
import {createPgUseFeedbackPort,migrateKnowledgeUses} from '../../../packages/adapters/knowledge-service/src/uses.ts';
import {seedKnowledgeSyntheticFixture} from '../../../scripts/runtime/knowledge-synthetic-fixture.ts';
import {createPgSourceRegistry} from '../../../packages/adapters/knowledge-service/src/sources.ts';
import {createFeedbackSourceApplication} from '../../../packages/knowledge-application/src/feedback-source.ts';
import {createPgFeedbackSourcePort} from '../../../packages/adapters/knowledge-service/src/feedback-source.ts';
import {assertKnowledgeWriterAuthority} from '../../../packages/knowledge/src/writer-authority.ts';
import {digest} from '../../../packages/knowledge/src/utils.ts';
import {createSyntheticResearchService} from '../../../packages/knowledge-application/src/research.ts';
import {createPgKnowledgeOperations,migrateKnowledgeOperations} from '../../../packages/adapters/knowledge-service/src/operations.ts';
import {createPgReviewPort,migrateKnowledgeReviews} from '../../../packages/adapters/knowledge-service/src/reviews.ts';

const url=readTestDatabase(),dbTest=url?test:test.skip;
const hasCode=(code:string)=>(error:unknown)=>typeof error==='object'&&error!==null&&'code' in error&&error.code===code;

dbTest('unsupported published profile remains readable but cannot be adopted; history uses publication time', {timeout:60_000},async()=>{
  const admin=new pg.Pool({connectionString:url!,max:2}),schema=`ccl_knowledge_policy_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString:url!,max:8,options:`-c search_path=${schema}`});
  try{
    await migrateKnowledge(pool);await migrateKnowledgeReadReceipts(pool);await migrateKnowledgeUses(pool);
    const projectId=`synthetic-${randomUUID()}`,spaceId='legacy:video-research',ref={objectId:randomUUID(),versionId:randomUUID()};
    const revision:KnowledgeRevision={kind:'pattern',projectId,ref,title:'Unsupported legacy pattern',body:'Old pattern for policy testing',
      scope:{applicability:{productVersionRefs:[],markets:[],languages:[],audiences:[],goals:[],requiredProduction:[],transferRationale:null},
        limitations:[],unknowns:[],reviewDueAt:null},dependencies:[],sourceGroups:[],artifactRef:null,createdAt:'2020-01-01T00:00:00.000Z',
      analysisQuality:null,content:{ref,projectId,title:'Unsupported legacy pattern',problem:'test',mechanism:'test',sequence:[],
        requiredElements:[],variableSlots:[],applicability:[],exclusions:[],supportRefs:[],counterexampleRefs:[],prediction:'test',
        evidenceLevel:'inconclusive',citations:[]}};
    const change:KnowledgeChangeSet={id:randomUUID(),projectId,requestKey:randomUUID(),requestHash:'a'.repeat(64),contentHash:'b'.repeat(64),
      purpose:'exploration_reading',proposer:'proposer',rationale:'Synthetic legacy policy test',methodVersion:'test-v1',
      cost:{state:'unknown',reason:'synthetic'},baseHeads:[{objectId:ref.objectId,versionId:null}],inputManifest:[],
      changes:[{revision,effect:'create',explanation:'Synthetic test'}],createdAt:new Date().toISOString()};
    const review:KnowledgeReview={id:randomUUID(),projectId,changeSetId:change.id,contentHash:change.contentHash,reviewer:'independent',
      policyVersion:'test-v1',purpose:'exploration_reading',decision:'exploration_only',rationale:'Engineering test',createdAt:new Date().toISOString()};
    const store=createKnowledgeStore(pool);await store.stage(change);await store.recordReview(review);const publication=await store.publish(projectId,change.id,change.contentHash);
    const principal={id:'caller',clientInstallationId:'policy-test',projectId,spaceIds:[spaceId],purposes:['exploration_reading']};
    const context={scope:{projectId,spaceId},principal,purpose:'exploration_reading',authorization:{actions:['uses:write','feedback:write'],adapterIds:['document'],rightsPolicyIds:[]}};
    const application=createKnowledgeApplication({store,receipts:createPgKnowledgeReceiptPort(pool)});
    const catalog=await application.catalog(context,{purpose:'exploration_reading',limit:10});
    const document=catalog.data.items[0];assert.equal(document.status.contentSupported,false);
    assert.equal(document.status.purpose.admitted,false);
    const history=await application.history(context,{objectId:ref.objectId,purpose:'exploration_reading',limit:10});
    assert.equal(history.data.versions[0].publishedAt,publication.publishedAt);
    const uses=createUseFeedbackApplication(createPgUseFeedbackPort(pool));
    const input={context:{adapterId:'document',externalId:'legacy-pattern',contextVersion:'1',inputDigest:'c'.repeat(64),
      authority:'caller_reported' as const,description:'Synthetic context'},readReceiptId:catalog.data.readReceiptId,purpose:'exploration_reading',
      considered:[{ref:document.ref,decision:'adopted' as const,reason:'Should be ineligible',before:null,after:null}],gaps:[],
      cost:{modelCalls:{state:'known' as const,value:0},tokens:{state:'known' as const,value:0},money:{state:'unknown' as const,reason:'No cost check'}}};
    for(const decision of ['adopted','adapted'] as const)
      await assert.rejects(uses.use(context,{...input,considered:[{...input.considered[0],decision}]},randomUUID()),hasCode('USE_NOT_ELIGIBLE'));
    const rejected=await uses.use(context,{...input,considered:[{...input.considered[0],decision:'rejected' as const,reason:'Unsupported profile'}]},randomUUID());
    assert.equal(rejected.eligibilityAtUse[0].status.contentSupported,false);
    assert.equal(rejected.eligibilityAtUse[0].status.purpose.admitted,false);
    assert.equal(rejected.snapshot.orderedItems[0].statusAtRead.contentSupported,false);
    const correction={purpose:'exploration_reading',useId:null,context:input.context,knowledgeRefs:[document.ref],feedbackKey:randomUUID(),
      status:'not_observed' as const,observedAt:null,observation:null,rawQuotation:null,interpretation:'Synthetic correction about an unsupported old profile',
      recommendation:null,artifactDigest:null,measurementScope:null,cost:input.cost,gaps:['No observation asserted']};
    const unsupportedFeedback=await uses.feedback(context,correction,randomUUID());
    assert.equal((await uses.getFeedback(context,unsupportedFeedback.id))?.id,unsupportedFeedback.id,'correction feedback does not require adoption eligibility');
    await store.invalidate(projectId,{domain:'knowledge',ref,reason:'review_due',state:'review_due',createdAt:new Date().toISOString()});
    const ordinaryStale=await uses.feedback(context,{...correction,feedbackKey:randomUUID()},randomUUID());
    assert.equal((await uses.getFeedback(context,ordinaryStale.id))?.id,ordinaryStale.id,'ordinary stale access remains readable for correction');
    const deferred=await uses.use(context,{...input,considered:[{...input.considered[0],decision:'deferred' as const,reason:'Needs review'}]},randomUUID());
    assert.equal(deferred.eligibilityAtUse[0].status.validity.valid,false);
    assert.equal(deferred.snapshot.orderedItems[0].statusAtRead.validity.valid,true,'frozen read-time status remains distinct from current ineligibility');
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});

dbTest('feedback and changes remain private to their explicit purpose', {timeout:60_000},async()=>{
  const admin=new pg.Pool({connectionString:url!,max:2}),schema=`ccl_feedback_purpose_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);const pool=new pg.Pool({connectionString:url!,max:8,options:`-c search_path=${schema}`});
  try{
    const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-${randomUUID()}`);await migrateKnowledgeUses(pool,{writerGrant:seed.writerGrant});
    const principal={...seed.principal,purposes:['exploration_reading','marketing_decision']};
    const context={scope:{projectId:seed.projectId,spaceId:seed.spaceId},principal,purpose:'exploration_reading',authorization:seed.authorization};
    const other={...context,purpose:'marketing_decision'};
    const feedback=createUseFeedbackApplication(createPgUseFeedbackPort(pool,{writerGrant:seed.writerGrant}));
    const input={purpose:'exploration_reading',useId:null,context:{adapterId:'document',externalId:'purpose-check',contextVersion:'1',
      inputDigest:'a'.repeat(64),authority:'caller_reported' as const,description:'Purpose-specific observation'},knowledgeRefs:[],
      feedbackKey:randomUUID(),status:'observed' as const,observedAt:new Date().toISOString(),observation:'Only for exploration.',
      rawQuotation:null,interpretation:null,recommendation:null,artifactDigest:null,measurementScope:null,gaps:[],
      cost:{modelCalls:{state:'known' as const,value:0},tokens:{state:'known' as const,value:0},money:{state:'unknown' as const,reason:'No bill'}}};
    const created=await feedback.feedback(context,input,randomUUID());
    assert.equal((await feedback.getFeedback(context,created.id))?.purpose,'exploration_reading');
    assert.equal(await feedback.getFeedback(other,created.id),null);
    assert.deepEqual((await feedback.changes(other,undefined,10)).data.items,[]);
    await assert.rejects(feedback.feedback(other,input,randomUUID()),hasCode('EXTERNAL_CONTEXT_FORBIDDEN'));
    const registered=createFeedbackSourceApplication(createPgFeedbackSourcePort(pool,{writerGrant:seed.writerGrant,rightsPolicyRef:'synthetic-local-only'}));
    const source=await registered.register(context,created.id,{purpose:'exploration_reading',expectedFeedbackDigest:created.digest},randomUUID());
    const sources=createPgSourceRegistry(pool,{writerGrant:seed.writerGrant});
    await assert.rejects(sources.readRecord(other.scope,source.ref,other),hasCode('SOURCE_PURPOSE_FORBIDDEN'));
    await assert.rejects(sources.readContent(other.scope,source.ref,null,other),hasCode('SOURCE_PURPOSE_FORBIDDEN'));
    await assert.rejects(sources.proof(other,source.ref),hasCode('SOURCE_PURPOSE_FORBIDDEN'));
    const knowledge=createKnowledgeApplication({store:createKnowledgeStore(pool,{writerGrant:seed.writerGrant}),
      receipts:createPgKnowledgeReceiptPort(pool),sources});
    await migrateKnowledgeReadReceipts(pool);
    const catalog=await knowledge.catalog(context,{purpose:'exploration_reading',limit:1});
    const use=await feedback.use(context,{context:input.context,readReceiptId:catalog.data.readReceiptId,
      purpose:'exploration_reading',considered:[],gaps:[],cost:input.cost},randomUUID());
    const linkedId=randomUUID(),orphanId=randomUUID(),linkedKey=randomUUID();
    const linkedModernInput={...input,useId:use.id,feedbackKey:linkedKey};
    const {purpose:_purpose,...legacyInput}=linkedModernInput;
    const legacyDigest=digest(legacyInput);
    const {purpose:_storedPurpose,...modernPayload}=created;
    const legacyPayload={...modernPayload,useId:use.id,feedbackKey:linkedKey,digest:legacyDigest};
    const oldEvent=(await pool.query<{payload:unknown}>(`SELECT payload FROM ccl_knowledge_external_changes
      WHERE feedback_id=$1 LIMIT 1`,[created.id])).rows[0].payload;
    const linkedLegacyPayload={...legacyPayload,id:linkedId,useId:use.id,sourceRef:null,maintenanceState:'not_requested'};
    const writer=await pool.connect();try{await writer.query('BEGIN');await assertKnowledgeWriterAuthority(writer,seed.projectId,seed.writerGrant);
      for(const [id,useId,key] of [[linkedId,use.id,linkedKey],[orphanId,null,randomUUID()]] as const){
        await writer.query(`INSERT INTO ccl_knowledge_external_feedback(project_id,space_id,principal_id,purpose,id,feedback_key,payload)
          VALUES($1,$2,$3,NULL,$4,$5,$6)`,[seed.projectId,seed.spaceId,principal.id,id,key,
          {...legacyPayload,id,useId,feedbackKey:key,sourceRef:null,maintenanceState:'not_requested'}]);
      }
      await writer.query(`INSERT INTO ccl_knowledge_external_changes(project_id,space_id,principal_id,purpose,use_id,feedback_id,payload)
        VALUES($1,$2,$3,NULL,$4,$5,$6)`,[seed.projectId,seed.spaceId,principal.id,use.id,linkedId,oldEvent]);
      await writer.query('COMMIT');
    }catch(error){await writer.query('ROLLBACK');throw error;}finally{writer.release();}
    await migrateKnowledgeUses(pool,{writerGrant:seed.writerGrant});
    const rawAfter=(await pool.query<{payload:typeof linkedLegacyPayload;purpose:string}>(`
      SELECT payload,purpose FROM ccl_knowledge_external_feedback WHERE id=$1`,[linkedId])).rows[0];
    assert.deepEqual(rawAfter.payload,linkedLegacyPayload,'legacy observation payload and digest remain immutable');
    assert.equal(rawAfter.payload.digest,legacyDigest);
    assert.equal(rawAfter.purpose,'exploration_reading');
    assert.equal((await feedback.getFeedback(context,linkedId))?.purpose,'exploration_reading');
    assert.equal(await feedback.getFeedback(other,linkedId),null);
    assert.equal(await feedback.getFeedback(context,orphanId),null,'unprovable legacy purpose remains private');
    assert.equal((await feedback.feedback(context,linkedModernInput,randomUUID())).id,linkedId,'legacy feedbackKey replays with a new operation key');
    await assert.rejects(feedback.feedback(other,{...linkedModernInput,purpose:'marketing_decision'},randomUUID()),hasCode('FEEDBACK_KEY_CONFLICT'));
    assert.equal((await feedback.changes(context,undefined,10,undefined,linkedId)).data.items.length,1);
    await registered.register(context,linkedId,{purpose:'exploration_reading',expectedFeedbackDigest:legacyDigest},randomUUID());
    const linkedAfter=(await pool.query<{payload:typeof linkedLegacyPayload}>(`SELECT payload FROM ccl_knowledge_external_feedback WHERE id=$1`,[linkedId])).rows[0].payload;
    assert.equal('purpose' in linkedAfter,false,'link maintenance does not rewrite legacy hashed input');
    assert.equal(linkedAfter.digest,legacyDigest);
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});

dbTest('feedback with no knowledge refs is hidden after its linked source rights are revoked', {timeout:60_000},async()=>{
  const admin=new pg.Pool({connectionString:url!,max:2}),schema=`ccl_feedback_revoked_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);const pool=new pg.Pool({connectionString:url!,max:8,options:`-c search_path=${schema}`});
  try{
    const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-${randomUUID()}`);await migrateKnowledgeUses(pool,{writerGrant:seed.writerGrant});
    const context={scope:{projectId:seed.projectId,spaceId:seed.spaceId},principal:seed.principal,
      purpose:'exploration_reading',authorization:seed.authorization};
    const feedback=createUseFeedbackApplication(createPgUseFeedbackPort(pool,{writerGrant:seed.writerGrant}));
    await migrateKnowledgeReadReceipts(pool);
    const knowledge=createKnowledgeApplication({store:createKnowledgeStore(pool,{writerGrant:seed.writerGrant}),
      receipts:createPgKnowledgeReceiptPort(pool),sources:createPgSourceRegistry(pool,{writerGrant:seed.writerGrant})});
    const frozen=await knowledge.catalog(context,{purpose:'exploration_reading',limit:1});
    const input={purpose:'exploration_reading',useId:null,context:{adapterId:'document',externalId:'rights-check',contextVersion:'1',
      inputDigest:'b'.repeat(64),authority:'caller_reported' as const,description:'Source-backed caller report'},knowledgeRefs:[],
      feedbackKey:randomUUID(),status:'observed' as const,observedAt:new Date().toISOString(),observation:'A synthetic observation.',
      rawQuotation:'Sensitive after revoke',interpretation:'Unverified interpretation',recommendation:null,artifactDigest:null,
      measurementScope:null,gaps:[],cost:{modelCalls:{state:'known' as const,value:0},tokens:{state:'known' as const,value:0},
        money:{state:'unknown' as const,reason:'No bill'}}};
    const key=randomUUID(),created=await feedback.feedback(context,input,key);
    const registered=createFeedbackSourceApplication(createPgFeedbackSourcePort(pool,{writerGrant:seed.writerGrant,rightsPolicyRef:'synthetic-local-only'}));
    const source=await registered.register(context,created.id,{purpose:'exploration_reading',expectedFeedbackDigest:created.digest},randomUUID());
    const sources=createPgSourceRegistry(pool,{writerGrant:seed.writerGrant});await sources.revoke(context,source.ref,1,randomUUID());
    await assert.rejects(feedback.getFeedback(context,created.id),hasCode('FEEDBACK_ACCESS_REVOKED'));
    await assert.rejects(feedback.feedback(context,input,key),hasCode('FEEDBACK_ACCESS_REVOKED'));
    await assert.rejects(feedback.feedback(context,input,randomUUID()),hasCode('FEEDBACK_ACCESS_REVOKED'));
    assert.deepEqual((await feedback.changes(context,undefined,10,undefined,created.id)).data.items,[]);
    const visible=await feedback.feedback(context,{...input,feedbackKey:randomUUID(),context:{...input.context,externalId:'other-feedback'}},randomUUID());
    const page=await feedback.changes(context,undefined,1);
    assert.equal(page.data.items.length,1);
    assert.ok(!page.data.items[0].affected.some(ref=>ref.objectId===source.ref.objectId));
    assert.equal((await feedback.getFeedback(context,visible.id))?.id,visible.id);
    await sources.revoke(context,seed.source.ref,1,randomUUID());
    for(const decision of ['rejected','deferred'] as const){
      await assert.rejects(feedback.use(context,{context:input.context,readReceiptId:frozen.data.readReceiptId,
        purpose:'exploration_reading',considered:[{ref:frozen.data.items[0].ref,decision,reason:'Correction after withdrawal',before:null,after:null}],
        gaps:[],cost:input.cost},randomUUID()),hasCode('USE_SNAPSHOT_ACCESS_REVOKED'));
    }
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});

dbTest('review request and finalization bind the original research purpose', {timeout:60_000},async()=>{
  const admin=new pg.Pool({connectionString:url!,max:2}),schema=`ccl_review_purpose_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);const pool=new pg.Pool({connectionString:url!,max:8,options:`-c search_path=${schema}`});
  try{
    const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-${randomUUID()}`);
    await migrateKnowledgeOperations(pool);await migrateKnowledgeReviews(pool);
    const principal={...seed.principal,purposes:['exploration_reading','marketing_decision']};
    const context={scope:{projectId:seed.projectId,spaceId:seed.spaceId},principal,purpose:'exploration_reading',authorization:seed.authorization};
    const other={...context,purpose:'marketing_decision'};
    const sources=createPgSourceRegistry(pool,{writerGrant:seed.writerGrant});
    const operations=createPgKnowledgeOperations(pool,seed.writerGrant);
    const research=createSyntheticResearchService({store:createKnowledgeStore(pool,{writerGrant:seed.writerGrant}),
      receipts:{async save(){},async get(){return null;}},operations,sources});
    async function finishedResearch(question:string){
      const operation=await research.submit(context,{question,purpose:'exploration_reading',sourceRefs:[seed.source.ref],knowledgeRefs:[],baseHeads:[],
        budget:{maxModelCalls:0,maxReadBytes:10000,deadline:new Date(Date.now()+60_000).toISOString(),maxMoney:null},
        allowExternalAcquisition:false},randomUUID());
      assert.equal(await research.processOne(seed.projectId),true);
      const result=(await operations.get(context.scope,context.principal.id,operation.id))?.result;assert.ok(result);
      return {operation,result};
    }
    const reviews=createPgReviewPort(pool,seed.writerGrant,sources);
    const crossed=await finishedResearch('Cross-purpose request must fail');
    await assert.rejects(reviews.request(other,{target:{kind:'research_result',researchId:crossed.operation.id,
      resultDigest:crossed.result.resultDigest},purpose:'marketing_decision'},randomUUID()),hasCode('REVIEW_TARGET_INVALID'));
    const forged=await finishedResearch('Forged ticket finalization must fail');
    const ticket=await reviews.request(context,{target:{kind:'research_result',researchId:forged.operation.id,
      resultDigest:forged.result.resultDigest},purpose:'exploration_reading'},randomUUID());
    const writer=await pool.connect();try{await writer.query('BEGIN');await assertKnowledgeWriterAuthority(writer,seed.projectId,seed.writerGrant);
      await writer.query(`UPDATE ccl_knowledge_review_tickets SET purpose=$2,payload=jsonb_set(payload,'{purpose}',to_jsonb($2::text)) WHERE id=$1`,
        [ticket.id,'marketing_decision']);await writer.query('COMMIT');
    }catch(error){await writer.query('ROLLBACK');throw error;}finally{writer.release();}
    const reviewer={...other,principal:{...principal,id:'independent-reviewer'}};
    assert.equal(await reviews.ticket(reviewer,ticket.id),null,'a legacy wrongly purposed ticket must not reveal another purpose target metadata');
    await assert.rejects(reviews.decide(reviewer,ticket.id,{expectedDigest:forged.result.resultDigest,
      decision:'rejected',reason:'A forged purpose must not finalize another purpose',conditions:[],gaps:[]},randomUUID()),
      hasCode('REVIEW_TARGET_CHANGED'));
    assert.equal((await operations.get(context.scope,context.principal.id,forged.operation.id))?.operation.state,'waiting_for_review');
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
