import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {migrateKnowledgeLearning} from '../src/learning-migrations.ts';
import {migrateKnowledge} from '../src/migrations.ts';
import {createKnowledgeLearningStore} from '../src/learning-store.ts';
import {createKnowledgeStore} from '../src/store.ts';
import {manifestHash} from '../src/learning-schemas.ts';
import {createWikiCompilationIdentity,createWikiCompilationExecutionSnapshot} from '../src/wiki-compilation-identity.ts';
import type {LearningManifest,Topic,WikiExperienceManifest} from '../src/learning-types.ts';
import type {KnowledgeChangeSet,KnowledgeRevision} from '../src/types.ts';
import type {VersionRef} from '../../contracts/src/index.ts';

const connectionString=readTestDatabase();
const dbTest=connectionString?test:test.skip;
const projectId='wiki-store-test';
async function fixture(){
  const admin=new pg.Pool({connectionString,max:2}),schema=`ccl_wiki_build_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,max:4,options:`-c search_path=${schema}`});
  await migrateKnowledgeLearning(pool);await migrateKnowledge(pool);
  const learning=createKnowledgeLearningStore(pool),knowledge=createKnowledgeStore(pool);
  const topic=await learning.createTopic({projectId,title:'Synthetic workflow',question:'What did this workflow establish?',method:'human',status:'confirmed'});
  await learning.markDirty({projectId,eventKey:'unrelated-pending',type:'feedback',topicIds:[topic.id],reason:'Unrelated Topic feedback remains pending'});
  const close=async()=>{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();};
  return {pool,learning,knowledge,topic,close};
}
function revision(ref:VersionRef):KnowledgeRevision{return {kind:'wiki',ref,projectId,title:'Synthetic prior Wiki',body:'Synthetic prior workflow understanding',
  content:{ref,projectId,title:'Synthetic prior Wiki',question:'What did the workflow establish?',claimRefs:[],patternRefs:[],relatedRefs:[],disputes:[],nextQuestions:[],citations:[]},
  scope:{applicability:{productVersionRefs:[],platforms:['unknown'],markets:[],languages:[],audiences:[],goals:[],requiredProduction:[],transferRationale:null},limitations:['Synthetic store fixture; no domain validation implied'],unknowns:[],goalTags:['testing_learning'],reviewDueAt:null},
  dependencies:[],sourceGroups:[],artifactRef:null,createdAt:new Date().toISOString(),analysisQuality:null};}
function targeted(topic:Topic,target:KnowledgeRevision):WikiExperienceManifest{
  const identity=createWikiCompilationIdentity({projectId,topicId:topic.id,
    questionVersion:{objectId:topic.id,versionId:'00000000-0000-4000-8000-000000000001'},intent:'integrate_experience',purpose:'exploration_reading',
    scope:{targetIds:[target.ref.objectId]},sources:[],externalReadingRefs:[],methodVersion:'wiki-experience-semantic@1',contractVersions:{policy:'test-policy'},limits:{maxModelCalls:2}});
  return {manifestVersion:'wiki-experience@1',binding:{spaceId:'wiki-experience',specificationId:'fixture',specificationVersion:'1.0',contentVersion:'wiki/experience-1.0',methodVersion:'wiki-experience-semantic@1',policyVersion:'test-policy',sourceRef:target.ref,sourceSha256:'a'.repeat(64)},topic:{id:topic.id,version:topic.version,question:topic.question},
    sources:[],sourceRecords:[],targetRevisions:[target],identity,
    executionSnapshot:createWikiCompilationExecutionSnapshot({currentTargetHeads:[{targetId:target.ref.objectId,ref:target.ref}]}),
    intent:'integrate_experience',purpose:'exploration_reading',baseHeads:[{objectId:target.ref.objectId,versionId:target.ref.versionId}],
    methodVersion:'wiki-experience-semantic@1',policyVersion:'test-policy',budget:{maxModelCalls:2}};
}
function legacy():LearningManifest{return {sources:[],baseHeads:[],methodVersion:'legacy-test',policyVersion:'legacy-policy',budget:{maxModelCalls:0}};}

// Publish synthetic revisions through KnowledgeStore solely to model exact head advancement.
// Domain validity/CAS at the service boundary is deliberately outside these store-side tests.
async function publish(f:Awaited<ReturnType<typeof fixture>>,target:KnowledgeRevision,base:string|null){
  const change:KnowledgeChangeSet={id:randomUUID(),projectId,requestKey:randomUUID(),requestHash:randomUUID(),contentHash:randomUUID(),purpose:'exploration_reading',
    proposer:'synthetic-builder',rationale:'Store fixture only',methodVersion:'test',cost:{state:'known',amount:0,currency:'USD'},
    baseHeads:[{objectId:target.ref.objectId,versionId:base}],inputManifest:[],changes:[{revision:target,effect:base?'correct':'create',explanation:'Synthetic store fixture'}],createdAt:new Date().toISOString()};
  await f.knowledge.stage(change);await f.knowledge.recordReview({id:randomUUID(),projectId,changeSetId:change.id,contentHash:change.contentHash,
    reviewer:'independent-synthetic-reviewer',policyVersion:'test',purpose:'exploration_reading',decision:'exploration_only',rationale:'Store fixture only',createdAt:new Date().toISOString()});
  return f.knowledge.publish(projectId,change.id,change.contentHash);
}

dbTest('targeted changed builds accept later exact target heads at one Topic watermark without acknowledging unrelated input',async()=>{
  const f=await fixture();try{
    const original=revision({objectId:randomUUID(),versionId:randomUUID()});await publish(f,original,null);
    const one=await f.learning.prepareBuild({projectId,topicId:f.topic.id,manifest:targeted(f.topic,original),reason:'First targeted change'});
    const own=revision({...original.ref,versionId:randomUUID()});const first=await publish(f,own,original.ref.versionId);
    await f.learning.finishBuild({projectId,buildId:one.id,outcome:'changed',reason:'First review passed',publishedRefs:first.refs,acknowledge:false});
    const external=revision({...original.ref,versionId:randomUUID()});await publish(f,external,own.ref.versionId);
    assert.deepEqual(await f.knowledge.head(projectId,original.ref.objectId),external.ref);
    const two=await f.learning.prepareBuild({projectId,topicId:f.topic.id,manifest:targeted(f.topic,external),reason:'External head changed'});
    assert.equal(two.throughSequence,one.throughSequence);assert.notEqual(two.manifestHash,one.manifestHash);
    const revised=revision({...original.ref,versionId:randomUUID()});const second=await publish(f,revised,external.ref.versionId);
    const done=await f.learning.finishBuild({projectId,buildId:two.id,outcome:'changed',reason:'Second review passed',publishedRefs:second.refs,acknowledge:false});
    assert.equal(done.outcome,'changed');assert.deepEqual(done.publishedRefs,[revised.ref]);
    assert.equal((await f.learning.pendingTopics(projectId))[0]?.processedSequence,0);
  }finally{await f.close();}
});

dbTest('proposal-only targeted build is terminal, has no published refs and leaves Topic dirty',async()=>{
  const f=await fixture();try{
    const frozen=await f.learning.prepareBuild({projectId,topicId:f.topic.id,manifest:targeted(f.topic,revision({objectId:randomUUID(),versionId:randomUUID()})),reason:'Proposal only'});
    await assert.rejects(f.learning.finishBuild({projectId,buildId:frozen.id,outcome:'proposed',reason:'Must not default to Topic acknowledgment'}),/acknowledge:false/);
    const done=await f.learning.finishBuild({projectId,buildId:frozen.id,outcome:'proposed',reason:'Reviewed proposal; publication disabled',acknowledge:false,
      usage:{independentReviewPassed:true,changeSetId:randomUUID()}});
    assert.equal(done.outcome,'proposed');assert.ok(done.finishedAt);assert.deepEqual(done.publishedRefs,[]);
    assert.equal((await f.learning.listUnfinishedBuilds(projectId,f.topic.id)).length,0);
    assert.equal((await f.learning.pendingTopics(projectId))[0]?.processedSequence,0);
    assert.equal((await f.learning.getBuild(projectId,frozen.id))?.manifestHash,manifestHash(frozen.manifest));
    await assert.rejects(f.learning.finishBuild({projectId,buildId:frozen.id,outcome:'proposed',reason:'Invalid retry',acknowledge:false,
      publishedRefs:[{objectId:randomUUID(),versionId:randomUUID()}]}),/cannot carry published refs/);
  }finally{await f.close();}
});

dbTest('targeted publication refs are selected, unique and fresh; no-change cannot carry publication refs',async()=>{
  const f=await fixture();try{
    const target=revision({objectId:randomUUID(),versionId:randomUUID()});
    const build=await f.learning.prepareBuild({projectId,topicId:f.topic.id,manifest:targeted(f.topic,target),reason:'Validate exact refs'});
    const fresh={...target.ref,versionId:randomUUID()};
    for(const refs of [[],[target.ref],[{objectId:randomUUID(),versionId:randomUUID()}],[fresh,fresh],[{...fresh,versionId:'moving-head'}]]){
      await assert.rejects(f.learning.finishBuild({projectId,buildId:build.id,outcome:'changed',reason:'Invalid refs',publishedRefs:refs,acknowledge:false}),/exact fresh refs/);
    }
    await assert.rejects(f.learning.finishBuild({projectId,buildId:build.id,outcome:'no_change',reason:'No publication',publishedRefs:[fresh],acknowledge:false}),/cannot carry published refs/);
    assert.equal((await f.learning.finishBuild({projectId,buildId:build.id,outcome:'no_change',reason:'Independent review found no change',acknowledge:false})).outcome,'no_change');
    assert.equal((await f.learning.pendingTopics(projectId))[0]?.processedSequence,0);
  }finally{await f.close();}
});

dbTest('targeted completion is independent of unrelated Topic watermark advancement, while legacy stale boundaries remain rejected',async()=>{
  const f=await fixture();try{
    const target=revision({objectId:randomUUID(),versionId:randomUUID()});
    const selected=await f.learning.prepareBuild({projectId,topicId:f.topic.id,manifest:targeted(f.topic,target),reason:'Selected input'});
    const oldLegacy=await f.learning.prepareBuild({projectId,topicId:f.topic.id,manifest:legacy(),reason:'Legacy inventory'});
    await f.learning.markDirty({projectId,eventKey:'later-unrelated',type:'feedback',topicIds:[f.topic.id],reason:'Later unrelated input'});
    const newer=await f.learning.prepareBuild({projectId,topicId:f.topic.id,manifest:legacy(),reason:'New legacy inventory'});
    await f.learning.finishBuild({projectId,buildId:newer.id,outcome:'no_change',reason:'Legacy acknowledges complete inventory'});
    await assert.rejects(f.learning.finishBuild({projectId,buildId:oldLegacy.id,outcome:'no_change',reason:'Stale legacy inventory',acknowledge:false}),/stale build boundary/);
    const done=await f.learning.finishBuild({projectId,buildId:selected.id,outcome:'no_change',reason:'Exact selected sources unchanged',acknowledge:false});
    assert.equal(done.outcome,'no_change');
    assert.equal((await f.pool.query('SELECT processed_sequence FROM ccl_learning_dirty WHERE project_id=$1 AND topic_id=$2',[projectId,f.topic.id])).rows[0].processed_sequence,String(newer.throughSequence));
  }finally{await f.close();}
});

dbTest('legacy same-watermark changed collision and unsupported proposed outcome retain original contract',async()=>{
  const f=await fixture();try{
    const first=await f.learning.prepareBuild({projectId,topicId:f.topic.id,manifest:legacy(),reason:'Original legacy build'});
    const before=first.manifestHash;
    await f.learning.finishBuild({projectId,buildId:first.id,outcome:'changed',reason:'Legacy published',publishedRefs:[{objectId:randomUUID(),versionId:randomUUID()}],acknowledge:false});
    const second=await f.learning.prepareBuild({projectId,topicId:f.topic.id,manifest:{...legacy(),budget:{maxModelCalls:1}},reason:'Legacy collision'});
    await assert.rejects(f.learning.finishBuild({projectId,buildId:second.id,outcome:'changed',reason:'Must retain legacy collision',publishedRefs:[{objectId:randomUUID(),versionId:randomUUID()}],acknowledge:false}),/newer build exists/);
    await assert.rejects(f.learning.finishBuild({projectId,buildId:second.id,outcome:'proposed',reason:'Legacy cannot use new outcome',acknowledge:false}),/versioned targeted Wiki manifest/);
    assert.equal((await f.learning.getBuild(projectId,first.id))?.manifestHash,before);
    assert.equal(before,manifestHash(legacy()));
  }finally{await f.close();}
});
