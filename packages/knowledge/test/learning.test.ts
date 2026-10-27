import { readTestDatabase } from '../../../scripts/runtime/test-database.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { manifestHash, questionKey, sourceKey } from '../src/learning-schemas.ts';
import { migrateKnowledgeLearning } from '../src/learning-migrations.ts';
import { createKnowledgeLearningStore } from '../src/learning-store.ts';
import { COVERAGE_CONTRACT_VERSION,evidenceAdmissionFingerprint } from '../src/learning-coverage.ts';
import type { LearningManifest, LearningSourceRef } from '../src/learning-types.ts';

test('learning keys are deterministic and exact-version scoped',()=>{
  assert.equal(questionKey('  NAD＋  转化?  '),questionKey('nad+ 转化?'));
  const a:LearningSourceRef={domain:'analysis',ref:{objectId:'report',versionId:'v1'}};
  const b:LearningSourceRef={domain:'analysis',ref:{objectId:'report',versionId:'v2'}};
  assert.notEqual(sourceKey(a),sourceKey(b));
  const manifest:LearningManifest={sources:[a],baseHeads:[],methodVersion:'m1',policyVersion:'p1',budget:{tokens:100}};
  assert.equal(manifestHash(manifest),manifestHash({budget:{tokens:100},policyVersion:'p1',methodVersion:'m1',baseHeads:[],sources:[a]}));
});

const connectionString=readTestDatabase();

const dbTest=connectionString?test:test.skip;

dbTest('legacy coverage proof is recomputed from accepted evidence and cannot acknowledge a quarantined gap',async()=>{
  const admin=new pg.Pool({connectionString,max:2}),schema=`ccl_coverage_contract_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,max:4,options:`-c search_path=${schema}`});
  try {
    await migrateKnowledgeLearning(pool);
    const store=createKnowledgeLearningStore(pool),topic=await store.createTopic({projectId:'p',title:'Coverage',
      question:'What exact evidence remains?',method:'human',status:'confirmed'});
    const ref={objectId:randomUUID(),versionId:randomUUID()},page={objectId:randomUUID(),versionId:randomUUID()};
    const report={ref,coverage:{channels:['visual'],requested:{kind:'whole'},observed:[{kind:'whole'}],gaps:[]},
      adoptionEpoch:1,adoptions:[],
      scopedDecisions:[],membership:{id:randomUUID(),version:1},validityFingerprint:'validity-1'};
    const oldReport={...report,processingFingerprint:'old-daily-context'},newReport={...report,
      processingFingerprint:'new-daily-context'};
    const source={domain:'analysis' as const,ref,sourceGroup:'one-original'};
    await store.markDirty({projectId:'p',eventKey:'source',type:'source',sources:[source],topicIds:[topic.id],reason:'source'});
    const common={sources:[source],baseHeads:[],policyVersion:'exploration-source-and-independent-review-v1',
      purpose:'exploration_reading',budget:{maxModelCalls:2},topic};
    const oldBatch={runId:'old-run',index:0,count:1,reportRefs:[ref],inventoryRefs:[ref],inventory:[oldReport],
      pageObjectId:page.objectId,reusedCoverage:[],planRefs:[[ref]]};
    const accepted=await store.prepareBuild({projectId:'p',topicId:topic.id,reason:'old accepted page',
      manifest:{...common,methodVersion:'topic-synthesis-bounded-pages-v6',batch:oldBatch}});
    await store.finishBuild({projectId:'p',buildId:accepted.id,outcome:'changed',reason:'reviewed',
      usage:{modelCalls:2,independentReviewPassed:true},publishedRefs:[page],acknowledge:false});
    const evidence=evidenceAdmissionFingerprint(oldReport,topic);
    assert.equal(evidence,evidenceAdmissionFingerprint(newReport,topic),'daily context is excluded');
    const unknownFrozenField={...oldReport,unrecognizedEvidence:'new meaning'};
    assert.equal(evidenceAdmissionFingerprint(unknownFrozenField,topic,
      {legacyFrozen:true}),null,'unknown frozen fields fail closed');
    assert.equal(evidenceAdmissionFingerprint({...oldReport,coverage:{...report.coverage,unrecognizedScope:true}},topic,
      {legacyFrozen:true}),null,'unknown nested coverage semantics fail closed');
    const reuse={buildId:accepted.id,ref,processingFingerprint:oldReport.processingFingerprint,
      proof:{kind:'legacy_compatible' as const,sourceBuildId:accepted.id,
        recordedProcessingFingerprint:oldReport.processingFingerprint,coverageContractVersion:COVERAGE_CONTRACT_VERSION,
        evidenceAdmissionFingerprint:evidence!}};
    const makeTarget=(reportValue:typeof newReport,proof:typeof reuse,scope:string,quarantined:unknown[]=[]):LearningManifest=>({
      ...common,methodVersion:'topic-synthesis-semantic-projection-v10',coverageContractVersion:COVERAGE_CONTRACT_VERSION,
      scope:{scope},batch:{runId:`new-${scope}`,index:0,count:1,reportRefs:[],inventoryRefs:[ref],inventory:[reportValue],
        pageObjectId:randomUUID(),reusedCoverage:[proof],planRefs:[],ackOnly:true,quarantined}});
    for(const [name,reportValue,proof] of [
      ['forged proof',newReport,{...reuse,proof:{...reuse.proof,evidenceAdmissionFingerprint:'forged'}}],
      ['adoption changed',{...newReport,adoptionEpoch:2},reuse],
      ['membership changed',{...newReport,membership:{...report.membership,version:2}},reuse],
      ['validity changed',{...newReport,validityFingerprint:'withdrawn'},reuse],
    ] as const) {
      const target=await store.prepareBuild({projectId:'p',topicId:topic.id,reason:name,
        manifest:makeTarget(reportValue,proof,name)});
      await assert.rejects(store.finishBuild({projectId:'p',buildId:target.id,outcome:'no_change',reason:name,
        usage:{modelCalls:0},acknowledge:true}),
      (error:unknown)=>error instanceof Error&&'code' in error&&error.code==='BUILD_COVERAGE_INVALID');
      assert.equal((await store.getBuild('p',target.id))?.outcome,null);
    }
    const unknownMethodManifest={...accepted.manifest,methodVersion:'future-unreviewed-method'};
    const unknownHash=manifestHash(unknownMethodManifest);
    await pool.query(`UPDATE ccl_learning_builds SET manifest_hash=$2,
      payload=jsonb_set(jsonb_set(payload,'{manifest}',$3::jsonb),'{manifestHash}',to_jsonb($2::text))
      WHERE id=$1`,[accepted.id,unknownHash,unknownMethodManifest]);
    const unknownMethod=await store.prepareBuild({projectId:'p',topicId:topic.id,reason:'unknown method',
      manifest:makeTarget(newReport,reuse,'unknown-method')});
    await assert.rejects(store.finishBuild({projectId:'p',buildId:unknownMethod.id,outcome:'no_change',
      reason:'cannot reuse unknown method',usage:{modelCalls:0},acknowledge:true}),
    (error:unknown)=>error instanceof Error&&'code' in error&&error.code==='BUILD_COVERAGE_INVALID');
    await pool.query(`UPDATE ccl_learning_builds SET manifest_hash=$2,
      payload=jsonb_set(jsonb_set(payload,'{manifest}',$3::jsonb),'{manifestHash}',to_jsonb($2::text))
      WHERE id=$1`,[accepted.id,accepted.manifestHash,accepted.manifest]);
    const quarantined=await store.prepareBuild({projectId:'p',topicId:topic.id,reason:'unknown gap',
      manifest:makeTarget(newReport,reuse,'unknown-gap',[{reportRefs:[ref]}])});
    await assert.rejects(store.finishBuild({projectId:'p',buildId:quarantined.id,outcome:'no_change',reason:'must wait',
      usage:{modelCalls:0},acknowledge:true}),
    (error:unknown)=>error instanceof Error&&'code' in error&&error.code==='BUILD_COVERAGE_INCOMPLETE');
    const valid=await store.prepareBuild({projectId:'p',topicId:topic.id,reason:'compatible evidence',
      manifest:makeTarget(newReport,reuse,'valid')});
    assert.equal((await store.finishBuild({projectId:'p',buildId:valid.id,outcome:'no_change',reason:'compatible',
      usage:{modelCalls:0},acknowledge:true})).outcome,'no_change');
    assert.equal((await store.reportCoverage('p',topic.id))[0].processingFingerprint,'old-daily-context',
      'the recorded old fingerprint is not rewritten to impersonate a new review');
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});

dbTest('a reviewed research workflow page remains reusable when a later event needs only acknowledgement',async()=>{
  const admin=new pg.Pool({connectionString,max:2}),schema=`ccl_research_reuse_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,max:4,options:`-c search_path=${schema}`});
  try {
    await migrateKnowledgeLearning(pool);
    const store=createKnowledgeLearningStore(pool),projectId='p';
    const topic=await store.createTopic({projectId,title:'Research continuation',question:'What remains valid?',method:'human',status:'confirmed'});
    const ref={objectId:randomUUID(),versionId:randomUUID()};
    const page={objectId:randomUUID(),versionId:randomUUID()};
    const source={domain:'analysis' as const,ref,sourceGroup:`media-sha256:${'a'.repeat(64)}`};
    const report={ref,coverage:{channels:['visual'],requested:{kind:'whole'},observed:[{kind:'whole'}],gaps:[]},
      adoptionEpoch:1,adoptions:[],scopedDecisions:[],membership:{id:randomUUID(),version:1},
      validityFingerprint:'valid',processingFingerprint:'same-exact-input'};
    const common={sources:[source],baseHeads:[],policyVersion:'exploration-source-and-independent-review-v1',
      purpose:'exploration_reading',budget:{maxModelCalls:4},topic,coverageContractVersion:COVERAGE_CONTRACT_VERSION};
    await store.markDirty({projectId,eventKey:'original',type:'source',sources:[source],topicIds:[topic.id],reason:'original evidence'});
    const reviewed=await store.prepareBuild({projectId,topicId:topic.id,reason:'reviewed research page',manifest:{
      ...common,methodVersion:'knowledge-research-agent-workflow@1',
      batch:{runId:'first-run',index:0,count:1,reportRefs:[ref],inventoryRefs:[ref],inventory:[report],
        inventorySources:[source],pageObjectId:page.objectId,reusedCoverage:[],planRefs:[[ref]]}}});
    await store.finishBuild({projectId,buildId:reviewed.id,outcome:'changed',reason:'independently reviewed',
      usage:{modelCalls:2,independentReviewPassed:true},publishedRefs:[page],acknowledge:false});
    assert.equal((await store.reportCoverage(projectId,topic.id))[0]?.acceptedBuildId,reviewed.id);
    await store.markDirty({projectId,eventKey:'later-due',type:'due',topicIds:[topic.id],reason:'check unchanged input'});
    const acknowledgement=await store.prepareBuild({projectId,topicId:topic.id,reason:'reuse exact reviewed page',manifest:{
      ...common,methodVersion:'knowledge-research-agent-workflow@1',
      batch:{runId:'second-run',index:0,count:1,reportRefs:[],inventoryRefs:[ref],inventory:[report],
        inventorySources:[source],pageObjectId:randomUUID(),reusedCoverage:[{
          buildId:reviewed.id,ref,processingFingerprint:report.processingFingerprint,proof:{kind:'exact'}}],
        planRefs:[],ackOnly:true}}});
    assert.equal((await store.finishBuild({projectId,buildId:acknowledgement.id,outcome:'no_change',
      reason:'exact coverage remains valid',usage:{modelCalls:0},acknowledge:true})).outcome,'no_change');
    assert.equal((await store.reportCoverage(projectId,topic.id))[0]?.acceptedBuildId,reviewed.id);
    assert.equal((await store.pendingTopics(projectId)).some(item=>item.topicId===topic.id),false);
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});

dbTest('reviewed v13 and research workflow pages can be continued at the same watermark',async()=>{
  const admin=new pg.Pool({connectionString,max:2}),schema=`ccl_research_rebase_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,max:4,options:`-c search_path=${schema}`});
  try {
    await migrateKnowledgeLearning(pool);
    const store=createKnowledgeLearningStore(pool),projectId='p';
    const topic=await store.createTopic({projectId,title:'Historical page continuation',
      question:'Which original evidence has been reviewed?',method:'human',status:'confirmed'});
    const refs=Array.from({length:22},()=>({objectId:randomUUID(),versionId:randomUUID()}));
    const sources=refs.map((ref,index)=>({domain:'analysis' as const,ref,
      sourceGroup:`media-sha256:${(index+1).toString(16).padStart(64,'0')}`}));
    const reports=refs.map((ref,index)=>({ref,coverage:{channels:['visual'],requested:{kind:'whole'},
      observed:[{kind:'whole'}],gaps:[]},adoptionEpoch:1,adoptions:[],scopedDecisions:[],
      membership:{id:randomUUID(),version:1},validityFingerprint:`valid-${index}`,
      processingFingerprint:`exact-${index}`}));
    await store.markDirty({projectId,eventKey:'sources',type:'source',sources,topicIds:[topic.id],reason:'source evidence'});
    const common={sources,baseHeads:[],policyVersion:'exploration-source-and-independent-review-v1',
      purpose:'exploration_reading',budget:{maxModelCalls:4},topic,coverageContractVersion:COVERAGE_CONTRACT_VERSION};
    const oldPage={objectId:randomUUID(),versionId:randomUUID()};
    const historical=await store.prepareBuild({projectId,topicId:topic.id,reason:'reviewed historical page',manifest:{
      ...common,methodVersion:'topic-synthesis-independent-page-commit-v13',
      batch:{runId:'historical-run',index:0,count:2,reportRefs:refs.slice(0,20),inventoryRefs:refs,inventory:reports,
        inventorySources:sources,pageObjectId:oldPage.objectId,reusedCoverage:[],
        planRefs:[refs.slice(0,20),refs.slice(20)]}}});
    await store.finishBuild({projectId,buildId:historical.id,outcome:'changed',reason:'independently reviewed',
      usage:{modelCalls:2,independentReviewPassed:true},publishedRefs:[oldPage],acknowledge:false});
    const reuse=(buildId:string,index:number)=>({buildId,ref:refs[index]!,processingFingerprint:reports[index]!.processingFingerprint,
      proof:{kind:'exact' as const}});
    const firstPage={objectId:randomUUID(),versionId:randomUUID()};
    const first=await store.prepareBuild({projectId,topicId:topic.id,reason:'first current-method page',manifest:{
      ...common,methodVersion:'knowledge-research-agent-workflow@1',
      batch:{runId:'current-first',index:0,count:2,reportRefs:[refs[20]!],inventoryRefs:refs,inventory:reports,
        inventorySources:sources,pageObjectId:firstPage.objectId,reusedCoverage:refs.slice(0,20).map((_,index)=>reuse(historical.id,index)),
        planRefs:[[refs[20]!],[refs[21]!]]}}});
    assert.equal((await store.finishBuild({projectId,buildId:first.id,outcome:'changed',reason:'independently reviewed',
      usage:{modelCalls:2,independentReviewPassed:true},publishedRefs:[firstPage],acknowledge:false})).outcome,'changed');
    const secondPage={objectId:randomUUID(),versionId:randomUUID()};
    const second=await store.prepareBuild({projectId,topicId:topic.id,reason:'second current-method page',manifest:{
      ...common,methodVersion:'knowledge-research-agent-workflow@1',
      batch:{runId:'current-second',index:0,count:1,reportRefs:[refs[21]!],inventoryRefs:refs,inventory:reports,
        inventorySources:sources,pageObjectId:secondPage.objectId,
        reusedCoverage:[...refs.slice(0,20).map((_,index)=>reuse(historical.id,index)),reuse(first.id,20)],
        planRefs:[[refs[21]!]]}}});
    assert.equal((await store.finishBuild({projectId,buildId:second.id,outcome:'changed',reason:'independently reviewed',
      usage:{modelCalls:2,independentReviewPassed:true},publishedRefs:[secondPage],acknowledge:true})).outcome,'changed');
    const coverage=await store.reportCoverage(projectId,topic.id);
    assert.equal(coverage.length,22);
    assert.equal(coverage.filter(item=>item.acceptedBuildId===historical.id).length,20);
    assert.equal(coverage.filter(item=>item.acceptedBuildId===first.id).length,1);
    assert.equal(coverage.filter(item=>item.acceptedBuildId===second.id).length,1);
    assert.equal((await store.pendingTopics(projectId)).some(item=>item.topicId===topic.id),false);
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});

dbTest('a fully reused independent page may commit at the same watermark across v11 and v12 runs',async()=>{
  const admin=new pg.Pool({connectionString,max:2}),schema=`ccl_independent_page_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,max:4,options:`-c search_path=${schema}`});
  try {
    await migrateKnowledgeLearning(pool);
    const store=createKnowledgeLearningStore(pool),projectId='p';
    const topic=await store.createTopic({projectId,title:'Independent pages',question:'Which evidence is separate?',method:'human',status:'confirmed'});
    const oldRef={objectId:randomUUID(),versionId:randomUUID()},newRef={objectId:randomUUID(),versionId:randomUUID()},
      unknownRef={objectId:randomUUID(),versionId:randomUUID()};
    const oldPage={objectId:randomUUID(),versionId:randomUUID()},newPage={objectId:randomUUID(),versionId:randomUUID()},
      unknownPage={objectId:randomUUID(),versionId:randomUUID()};
    const groups=[`media-sha256:${'a'.repeat(64)}`,`media-sha256:${'b'.repeat(64)}`,`media-sha256:${'c'.repeat(64)}`];
    const sources=[oldRef,newRef,unknownRef].map((ref,index)=>({domain:'analysis' as const,ref,sourceGroup:groups[index]!}));
    const reports=[oldRef,newRef,unknownRef].map((ref,index)=>({ref,coverage:{channels:['visual'],requested:{kind:'whole'},
      observed:[{kind:'whole'}],gaps:[]},adoptionEpoch:1,adoptions:[],scopedDecisions:[],
      membership:{id:randomUUID(),version:1},validityFingerprint:`validity-${index}`,processingFingerprint:`exact-${index}`}));
    await store.markDirty({projectId,eventKey:'sources',type:'source',sources,topicIds:[topic.id],reason:'two independent originals'});
    const common={sources,baseHeads:[],policyVersion:'exploration-source-and-independent-review-v1',
      purpose:'exploration_reading',budget:{maxModelCalls:4},topic,coverageContractVersion:COVERAGE_CONTRACT_VERSION};
    const unknownJobId=randomUUID();
    const unknownBatch={runId:'unknown-run',index:0,count:1,reportRefs:[unknownRef],inventoryRefs:[oldRef,newRef,unknownRef],
      inventory:reports,inventorySources:sources,pageObjectId:unknownPage.objectId,reusedCoverage:[],planRefs:[[unknownRef]]};
    const unknown=await store.prepareBuild({projectId,topicId:topic.id,reason:'frozen unknown source page',
      manifest:{...common,methodVersion:'topic-synthesis-strict-draft-time-evidence-v11',batch:unknownBatch}});
    await store.attachBuildJob(projectId,unknown.id,unknownJobId);
    const quarantined=[{buildId:unknown.id,jobId:unknownJobId,runId:unknownBatch.runId,index:0,
      manifestHash:unknown.manifestHash,pageObjectId:unknownPage.objectId,reportRefs:[unknownRef],sourceGroups:[groups[2]!]}];
    const oldBatch={runId:'old-run',index:0,count:2,reportRefs:[oldRef],inventoryRefs:[oldRef,newRef,unknownRef],inventory:reports,
      inventorySources:sources,pageObjectId:oldPage.objectId,reusedCoverage:[],planRefs:[[oldRef],[newRef]],quarantined};
    const first=await store.prepareBuild({projectId,topicId:topic.id,reason:'reviewed first page',
      manifest:{...common,methodVersion:'topic-synthesis-strict-draft-time-evidence-v11',batch:oldBatch}});
    await store.finishBuild({projectId,buildId:first.id,outcome:'changed',reason:'independently reviewed',
      usage:{modelCalls:2,independentReviewPassed:true},publishedRefs:[oldPage],acknowledge:false});
    const reuse={buildId:first.id,ref:oldRef,processingFingerprint:reports[0]!.processingFingerprint,proof:{kind:'exact' as const}};
    const targetBatch={runId:'new-run',index:0,count:1,reportRefs:[newRef],inventoryRefs:[oldRef,newRef,unknownRef],inventory:reports,
      inventorySources:sources,pageObjectId:newPage.objectId,reusedCoverage:[reuse],planRefs:[[newRef]],quarantined};
    const rejectConflict=async(name:string,plan:typeof targetBatch)=>{
      const attempt=await store.prepareBuild({projectId,topicId:topic.id,reason:name,
        manifest:{...common,methodVersion:'topic-synthesis-independent-page-commit-v12',batch:{...plan,runId:name}}});
      await assert.rejects(store.finishBuild({projectId,buildId:attempt.id,outcome:'changed',reason:name,
        usage:{modelCalls:2,independentReviewPassed:true},publishedRefs:[newPage],acknowledge:false}),
      /newer build exists; recheck head and manifest/);
      assert.equal((await store.getBuild(projectId,attempt.id))?.outcome,null);
    };
    await rejectConflict('same target page',{...targetBatch,pageObjectId:oldPage.objectId});
    await rejectConflict('same original group',{...targetBatch,inventorySources:[sources[0]!,{...sources[1]!,sourceGroup:groups[0]!}]});
    await rejectConflict('no exact reuse',{...targetBatch,index:1,count:2,reusedCoverage:[],planRefs:[[oldRef],[newRef]]});
    await rejectConflict('incomplete page plan',{...targetBatch,planRefs:[[oldRef]]});
    const legacyManifest={...first.manifest,methodVersion:'topic-synthesis-semantic-projection-v10'};
    const legacyHash=manifestHash(legacyManifest);
    await pool.query(`UPDATE ccl_learning_builds SET manifest_hash=$2,
      payload=jsonb_set(jsonb_set(payload,'{manifest}',$3::jsonb),'{manifestHash}',to_jsonb($2::text))
      WHERE id=$1`,[first.id,legacyHash,legacyManifest]);
    await rejectConflict('legacy accepted page',targetBatch);
    await pool.query(`UPDATE ccl_learning_builds SET manifest_hash=$2,
      payload=jsonb_set(jsonb_set(payload,'{manifest}',$3::jsonb),'{manifestHash}',to_jsonb($2::text))
      WHERE id=$1`,[first.id,first.manifestHash,first.manifest]);
    const second=await store.prepareBuild({projectId,topicId:topic.id,reason:'independent next page',
      manifest:{...common,methodVersion:'topic-synthesis-independent-page-commit-v12',batch:targetBatch}});
    assert.equal((await store.finishBuild({projectId,buildId:second.id,outcome:'changed',reason:'independently reviewed',
      usage:{modelCalls:2,independentReviewPassed:true},publishedRefs:[newPage],acknowledge:false})).outcome,'changed');
    assert.equal((await store.getBuild(projectId,first.id))?.outcome,'changed');
    assert.equal((await store.getBuild(projectId,unknown.id))?.outcome,null);
    assert.equal((await store.reportCoverage(projectId,topic.id)).length,2);
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});

dbTest('external-client build preparation works with one connection and admission takes event lock before dirty lock',async()=>{
  const admin=new pg.Pool({connectionString,max:2}),schema=`ccl_admission_locks_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const one=new pg.Pool({connectionString,max:1,connectionTimeoutMillis:500,options:`-c search_path=${schema}`});
  const two=new pg.Pool({connectionString,max:2,connectionTimeoutMillis:1000,options:`-c search_path=${schema}`});
  try {
    await migrateKnowledgeLearning(one);
    const store=createKnowledgeLearningStore(one),topic=await store.createTopic({projectId:'p',title:'Atomic admission',
      question:'Can the same transaction prepare?',method:'test',status:'confirmed'});
    await store.markDirty({projectId:'p',eventKey:'admit',type:'due',topicIds:[topic.id],reason:'admit'});
    const manifest:LearningManifest={sources:[],baseHeads:[],methodVersion:'m',policyVersion:'p',budget:{}};
    const client=await one.connect();
    try {
      await client.query('BEGIN');
      await store.assertInputs('p',{topicId:topic.id,topicVersion:topic.version,memberships:[]},client);
      const build=await store.prepareBuild({projectId:'p',topicId:topic.id,manifest,reason:'same connection'},client);
      assert.ok(build.id);
      await client.query('COMMIT');
    }finally{client.release();}
    const concurrent=createKnowledgeLearningStore(two),low=await two.connect();
    try {
      await low.query('BEGIN');
      await low.query('SELECT pg_advisory_xact_lock(hashtext($1))',['learning-event-order:p']);
      const entering=(async()=>{
        const db=await two.connect();
        try {
          await db.query('BEGIN');
          await concurrent.assertInputs('p',{topicId:topic.id,topicVersion:topic.version,memberships:[]},db);
          await concurrent.prepareBuild({projectId:'p',topicId:topic.id,manifest:{...manifest,methodVersion:'m2'},
            reason:'ordered admission'},db);
          await db.query('COMMIT');
        }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
      })();
      await new Promise(resolve=>setTimeout(resolve,30));
      await low.query("SET LOCAL lock_timeout='500ms'");
      await low.query('SELECT 1 FROM ccl_learning_dirty WHERE project_id=$1 AND topic_id=$2 FOR UPDATE',['p',topic.id]);
      await low.query('COMMIT');
      await entering;
    }finally{await low.query('ROLLBACK').catch(()=>{});low.release();}
    assert.equal((await concurrent.listUnfinishedBuilds('p',topic.id)).length,2);
  }finally{await one.end();await two.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});

dbTest('learning ledger keeps project, versions, dirty boundary and research decisions', {timeout:60_000}, async()=>{
  const admin=new pg.Pool({connectionString,max:2});
  const schema=`ccl_learning_test_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,max:5,options:`-c search_path=${schema}`});
  try {
    await migrateKnowledgeLearning(pool); await migrateKnowledgeLearning(pool);
    const store=createKnowledgeLearningStore(pool);
    const topic=await store.createTopic({projectId:'p',id:'wiki-1',title:'Mechanisms',question:'What mechanism?',aliases:['Which mechanism?'],method:'human'});
    assert.equal((await store.createTopic({projectId:'p',id:'wrong-id',title:'Same',question:'  what mechanism? ',method:'human'})).id,topic.id);
    assert.equal((await store.createTopic({projectId:'p',id:'another-id',title:'Alias',question:'Which mechanism?',method:'human'})).id,topic.id);
    const second=await store.createTopic({projectId:'p',title:'Other',question:'What other mechanism?',method:'human'});
    const firstPage=await store.snapshot('p',1);
    assert.equal(firstPage.topics.length,1);
    assert.equal(firstPage.pageInfo?.topics.total,2);
    assert.equal(firstPage.pageInfo?.topics.hasMore,true);
    assert.ok(firstPage.pageInfo?.topics.nextCursor,'a bounded page must disclose omitted records');
    assert.equal((await store.snapshot('other')).topics.length,0);
    const src:LearningSourceRef={domain:'analysis',ref:{objectId:'r',versionId:'v1'},sourceGroup:'video-1'};
    const firstInput={projectId:'p',eventKey:'report-r-v1',type:'report' as const,sources:[src],reason:'new result'};
    const events=await Promise.all(Array.from({length:5},()=>store.registerInput(firstInput)));
    const event=events[0];
    assert.ok(events.every(item=>item.sequence===event.sequence));
    await assert.rejects(store.registerInput({...firstInput,reason:'different source decision'}),/event key conflict/);
    await assert.rejects(store.registerInput({...firstInput,sources:[{...src,ref:{...src.ref,versionId:'v2'}}]}),/event key conflict/);
    assert.equal((await store.snapshot('p')).unassigned.length,1);
    const firstMembership={projectId:'p',source:src,topicId:topic.id,state:'confirmed' as const,reason:'supports question',methodVersion:'human-1'};
    const secondMembership={projectId:'p',source:src,topicId:second.id,state:'candidate' as const,reason:'possible fit',methodVersion:'human-1'};
    const assigned=await Promise.all([store.assignMembership(firstMembership),store.assignMembership(firstMembership),store.assignMembership(secondMembership)]);
    assert.equal(assigned[0].id,assigned[1].id);
    assert.equal((await store.snapshot('p')).memberships.length,2);
    const firstPending=(await store.snapshot('p')).pending;
    assert.equal(firstPending.find(item=>item.topicId===topic.id)?.count,1);
    assert.equal(firstPending.find(item=>item.topicId===second.id)?.count,1);
    const firstBoundary=firstPending.find(item=>item.topicId===topic.id)?.latestSequence;
    await store.assignMembership(firstMembership);
    assert.equal((await store.snapshot('p')).pending.find(item=>item.topicId===topic.id)?.latestSequence,firstBoundary);
    const secondBoundary=firstPending.find(item=>item.topicId===second.id)?.latestSequence??0;
    await store.assignMembership({...secondMembership,state:'rejected',reason:'review found unrelated'});
    assert.ok(((await store.snapshot('p')).pending.find(item=>item.topicId===second.id)?.latestSequence??0)>secondBoundary);
    assert.equal((await store.snapshot('p')).unassigned.length,0);
    const e2=await store.markDirty({projectId:'p',eventKey:'adoption-r-v1',type:'adoption',sources:[src],reason:'adoption changed'});
    assert.ok(e2.sequence>event.sequence);
    const manifest:LearningManifest={sources:[src],baseHeads:[],methodVersion:'m1',policyVersion:'p1',budget:{tokens:100}};
    const frozen=await store.prepareBuild({projectId:'p',topicId:topic.id,manifest,reason:'new adoption'});
    assert.equal(frozen.throughSequence,e2.sequence);
    assert.equal((await store.prepareBuild({projectId:'p',topicId:topic.id,manifest,reason:'repeat'})).id,frozen.id);
    assert.equal(await store.getBuild('other',frozen.id),null);
    await assert.rejects(store.finishBuild({projectId:'other',buildId:frozen.id,outcome:'no_change',reason:'wrong project'}),/build not found/);
    await store.attachBuildJob('p',frozen.id,'job-1');
    const later=await store.markDirty({projectId:'p',eventKey:'feedback-r-v1',type:'feedback',sources:[src],reason:'new feedback'});
    const external=await pool.connect();
    try {
      await external.query('BEGIN');
      await store.finishBuild({projectId:'p',buildId:frozen.id,outcome:'no_change',reason:'trial rollback'},external);
      await external.query('ROLLBACK');
    } finally { external.release(); }
    assert.equal((await store.getBuild('p',frozen.id))?.outcome,null);
    await store.finishBuild({projectId:'p',buildId:frozen.id,outcome:'no_change',reason:'no new claim',usage:{tokens:0},cost:{usd:0}});
    const pending=(await store.snapshot('p')).pending.find(x=>x.topicId===topic.id);
    assert.equal(pending?.processedSequence,e2.sequence);
    assert.equal(pending?.latestSequence,later.sequence);
    assert.equal(pending?.count,1);
    const fine:LearningSourceRef={domain:'analysis',ref:{objectId:'r',versionId:'v2'},sourceGroup:'video-1'};
    await store.assignMembership({projectId:'p',source:fine,topicId:topic.id,state:'confirmed',reason:'same original fine profile',methodVersion:'human-1'});
    await store.markDirty({projectId:'p',eventKey:'fine-r-v2',type:'report',sources:[{domain:fine.domain,ref:fine.ref}],reason:'fine report arrived'});
    assert.equal((await store.snapshot('p')).pending.find(x=>x.topicId===topic.id)?.count,1);
    await store.markDirty({projectId:'p',eventKey:'policy-p2',type:'policy',topicIds:[topic.id],reason:'policy changed'});
    assert.equal((await store.snapshot('p')).pending.find(x=>x.topicId===topic.id)?.count,1);
    const distinct:LearningSourceRef={domain:'source',ref:{objectId:'other',versionId:'v1'},sourceGroup:'different-original'};
    await store.assignMembership({projectId:'p',source:distinct,topicId:topic.id,state:'candidate',reason:'candidate source',methodVersion:'human-1'});
    await store.markDirty({projectId:'p',eventKey:'source-other-v1',type:'source',sources:[distinct],reason:'new original'});
    assert.equal((await store.snapshot('p')).pending.find(x=>x.topicId===topic.id)?.count,2);
    const onlyDue=await store.createTopic({projectId:'p',title:'Due only',question:'What is due?',method:'human'});
    await store.markDirty({projectId:'p',eventKey:'due-only',type:'due',topicIds:[onlyDue.id],reason:'review due'});
    assert.equal((await store.snapshot('p')).pending.find(x=>x.topicId===onlyDue.id)?.count,0);
    const restricted=await store.prepareBuild({projectId:'p',topicId:topic.id,manifest:{...manifest,policyVersion:'p2'},reason:'policy changed'});
    await store.finishBuild({projectId:'p',buildId:restricted.id,outcome:'restricted',reason:'source invalid',recovery:'verify source'});
    assert.equal((await store.snapshot('p')).pending.find(x=>x.topicId===topic.id)?.processedSequence,e2.sequence);
    const failed=await store.prepareBuild({projectId:'p',topicId:topic.id,manifest:{...manifest,policyVersion:'p3'},reason:'retry after restriction'});
    await store.finishBuild({projectId:'p',buildId:failed.id,outcome:'failed',reason:'worker error',recovery:'retry after reconciliation'});
    const overview=await store.overview('p');
    assert.equal(overview.counts.builds,3);
    assert.equal('builds' in overview,false);
    const topicsPage=await store.listItems('p',{category:'topics',limit:2});
    assert.equal(topicsPage.pageInfo.total,3);
    assert.equal(topicsPage.pageInfo.hasMore,true);
    const finalTopic=await store.listItems('p',{category:'topics',limit:2,cursor:topicsPage.pageInfo.nextCursor});
    assert.equal(finalTopic.items.length,1);
    assert.equal(new Set([...topicsPage.items,...finalTopic.items].map(item=>'id' in item?item.id:null)).size,3);
    await assert.rejects(store.listItems('other',{category:'topics',cursor:topicsPage.pageInfo.nextCursor}),/cursor/i);
    const pendingPage=await store.listItems('p',{category:'pending',limit:1});
    assert.equal(pendingPage.pageInfo.hasMore,true);
    const nextPending=await store.listItems('p',{category:'pending',limit:1,cursor:pendingPage.pageInfo.nextCursor});
    assert.notEqual((pendingPage.items[0] as {topicId:string}).topicId,(nextPending.items[0] as {topicId:string}).topicId);
    await assert.rejects(store.listItems('p',{category:'topics',cursor:pendingPage.pageInfo.nextCursor}),/cursor/i);
    const pageSql:string[]=[];
    const summaryReader=createKnowledgeLearningStore(new Proxy(pool,{get(target,key){
      if(key==='query')return (...args:unknown[])=>{if(typeof args[0]==='string')pageSql.push(args[0]);
        return (target.query as (...values:unknown[])=>unknown)(...args);};
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }}));
    const buildPage=await summaryReader.listItems('p',{category:'builds',limit:2,topicId:topic.id});
    assert.equal(buildPage.items.length,2);
    assert.equal(buildPage.pageInfo.total,3);
    assert.equal(buildPage.pageInfo.hasMore,true);
    assert.equal('manifest' in buildPage.items[0],false);
    assert.ok(pageSql.some(sql=>sql.includes("payload - 'manifest'")));
    assert.ok(pageSql.every(sql=>!/^\s*SELECT\s+payload\s+FROM\s+ccl_learning_builds/i.test(sql)));
    assert.ok(JSON.stringify(buildPage).length<100_000);
    const nextBuildPage=await store.listItems('p',{category:'builds',limit:2,topicId:topic.id,cursor:buildPage.pageInfo.nextCursor});
    assert.equal(nextBuildPage.items.length,1);
    assert.equal(new Set([...buildPage.items,...nextBuildPage.items].map(item=>'id' in item?item.id:null)).size,3);
    await assert.rejects(store.listItems('p',{category:'builds',limit:2,topicId:second.id,cursor:buildPage.pageInfo.nextCursor}),/cursor/i);
    await assert.rejects(store.listItems('other',{category:'builds',limit:2,topicId:topic.id,cursor:buildPage.pageInfo.nextCursor}),/cursor/i);
    assert.deepEqual((await store.getBuild('p',failed.id))?.manifest,failed.manifest);
    const memberPage=await store.listItems('p',{category:'memberships',limit:1,topicId:topic.id,source:src});
    assert.equal(memberPage.items.length,1);
    assert.equal(memberPage.pageInfo.total,1);
    assert.equal((await store.snapshot('p')).pending.find(x=>x.topicId===topic.id)?.processedSequence,e2.sequence);
    const need=await store.createNeed({projectId:'p',topicId:topic.id,subject:src,problem:'Does this support the claim?',expectedEvidence:'timestamped clip',value:'production relevance',priority:2,action:'analyze_segment',budget:{tokens:500}});
    const limited=await store.createRequest({projectId:'p',needId:need.id,jobId:null,action:'analyze_segment',inputRefs:[src],budget:{tokens:500},authorization:'No action port configured',expectedResult:'anchored observation',requestKey:'need-limited'});
    assert.equal(limited.jobId,null);
    assert.equal((await store.snapshot('p')).needs[0].status,'open');
    const request=await store.createRequest({projectId:'p',needId:need.id,jobId:'job-2',action:'analyze_segment',inputRefs:[src],budget:{tokens:500},authorization:'reviewed',expectedResult:'anchored observation',requestKey:'need-1'});
    assert.equal((await store.createRequest({...request})).id,request.id);
    await assert.rejects(store.createRequest({...request,expectedResult:'different'}),/request key conflict/);
    assert.equal((await store.snapshot('p')).needs[0].status,'assigned');
    await assert.rejects(store.resolveNeed({projectId:'p',needId:need.id,status:'resolved',sourceRefs:[],resultRefs:[],reviewReason:'done'}),/evidence refs/);
    const resolved=await store.resolveNeed({projectId:'p',needId:need.id,status:'resolved',sourceRefs:[src],resultRefs:[],reviewReason:'independent review'});
    assert.equal(resolved.status,'resolved');
    assert.equal((await store.snapshot('other')).needs.length,0);
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
});

dbTest('long learning text stays within a bounded SQL summary page and exact detail remains full', {timeout:30_000},async()=>{
  const admin=new pg.Pool({connectionString,max:2});
  const schema=`ccl_learning_budget_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,max:3,options:`-c search_path=${schema}`});
  try {
    await migrateKnowledgeLearning(pool);
    const store=createKnowledgeLearningStore(pool),reason='证'.repeat(4000);
    const topic=await store.createTopic({projectId:'p',title:'Budget',question:'What fits?',method:'test'});
    const rows=Array.from({length:50},(_,i)=>{
      const id=randomUUID(),source={domain:'analysis',ref:{objectId:randomUUID(),versionId:randomUUID()},sourceGroup:`group-${i}`};
      return {id,projectId:'p',source,topicId:topic.id,topicVersion:1,state:'confirmed',reason,
        methodVersion:'test',version:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    });
    for(const row of rows)await pool.query(`INSERT INTO ccl_learning_memberships(project_id,member_key,id,source_key,topic_id,payload)
      VALUES($1,$2,$3,$4,$5,$6)`,['p',row.id,row.id,row.id,topic.id,row]);
    const page=await store.listItems('p',{category:'memberships',limit:50,topicId:topic.id});
    assert.equal(page.items.length,50);
    assert.ok(Buffer.byteLength(JSON.stringify(page))<100_000);
    assert.ok(page.items.every(item=>'truncatedFields' in item && (item.truncatedFields as string[]).includes('reason')));
    assert.equal((await store.getItem('p','memberships',rows[0].id) as typeof rows[number])?.reason.length,4000);
    const unassigned=await store.createNeed({projectId:'p',topicId:null,subject:rows[0].source as LearningSourceRef,
      problem:reason,expectedEvidence:reason,value:reason,priority:1,action:'verify_fact',budget:{context:reason}});
    const needs=await store.listItems('p',{category:'needs',topicId:'unassigned'});
    assert.equal(needs.pageInfo.total,1);
    assert.ok(JSON.stringify(needs).length<5000);
    assert.equal((await store.getItem('p','needs',unassigned.id) as {problem:string})?.problem.length,4000);
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});

dbTest('project event lock orders allocation with commit and preserves later dirty', {timeout:60_000}, async()=>{
  const admin=new pg.Pool({connectionString,max:2});
  const schema=`ccl_learning_order_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,max:5,options:`-c search_path=${schema}`});
  try {
    await migrateKnowledgeLearning(pool);
    const store=createKnowledgeLearningStore(pool);
    const topic=await store.createTopic({projectId:'p',title:'Ordering',question:'Do arrivals remain visible?',method:'test'});
    const source:LearningSourceRef={domain:'analysis',ref:{objectId:'ordered',versionId:'v1'},sourceGroup:'one-original'};
    const low=await pool.connect();
    let committed=false;
    try {
      await low.query('BEGIN');
      await low.query('SELECT pg_advisory_xact_lock(hashtext($1))',['learning-event-order:p']);
      const first=await low.query<{sequence:string}>(`INSERT INTO ccl_learning_events(project_id,event_key,payload)
        VALUES($1,$2,$3) RETURNING sequence`,['p','low-uncommitted',{
        projectId:'p',eventKey:'low-uncommitted',type:'source',sources:[source],topicIds:[topic.id],requestedTopicIds:[topic.id],reason:'held transaction',createdAt:new Date().toISOString(),
      }]);
      const lowSequence=Number(first.rows[0].sequence);
      await low.query('INSERT INTO ccl_learning_event_topics(project_id,sequence,topic_id) VALUES($1,$2,$3)',['p',lowSequence,topic.id]);
      await low.query('INSERT INTO ccl_learning_dirty(project_id,topic_id,latest_sequence) VALUES($1,$2,$3)',['p',topic.id,lowSequence]);
      const arrival=store.registerInput({projectId:'p',eventKey:'high-arrival',type:'report',sources:[source],topicIds:[topic.id],reason:'later arrival'});
      const assignment=store.assignMembership({projectId:'p',source,topicId:topic.id,state:'confirmed',reason:'first assignment',methodVersion:'test'});
      const early=await Promise.race([arrival.then(()=>false),assignment.then(()=>false),new Promise<boolean>(resolve=>setTimeout(()=>resolve(true),40))]);
      assert.equal(early,true,'both event writers must wait for earlier transaction to commit');
      await low.query('COMMIT'); committed=true;
      const [arrived]=await Promise.all([arrival,assignment]);
      assert.ok(arrived.sequence>lowSequence);
      const sequences=await pool.query<{sequence:string}>('SELECT sequence FROM ccl_learning_events WHERE project_id=$1 ORDER BY sequence',['p']);
      assert.ok(sequences.rows.slice(1).every(row=>Number(row.sequence)>lowSequence));
      const manifest:LearningManifest={sources:[source],baseHeads:[],methodVersion:'m1',policyVersion:'p1',budget:{}};
      const frozen=await store.prepareBuild({projectId:'p',topicId:topic.id,manifest,reason:'ordered inputs'});
      const later=await store.registerInput({projectId:'p',eventKey:'after-freeze',type:'feedback',sources:[source],topicIds:[topic.id],reason:'newer feedback'});
      await store.finishBuild({projectId:'p',buildId:frozen.id,outcome:'no_change',reason:'frozen batch consumed'});
      const pending=(await store.snapshot('p')).pending.find(item=>item.topicId===topic.id);
      assert.equal(pending?.processedSequence,frozen.throughSequence);
      assert.equal(pending?.latestSequence,later.sequence);
      assert.equal(pending?.count,1);
    } finally { if(!committed) await low.query('ROLLBACK'); low.release(); }
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
});

dbTest('transaction input barrier rejects changed membership but permits later source dirty', {timeout:60_000}, async()=>{
  const admin=new pg.Pool({connectionString,max:2});
  const schema=`ccl_learning_barrier_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,max:5,options:`-c search_path=${schema}`});
  try {
    await migrateKnowledgeLearning(pool);
    const store=createKnowledgeLearningStore(pool);
    const topic=await store.createTopic({projectId:'p',title:'Barrier',question:'What changed?',method:'test',status:'confirmed'});
    const source:LearningSourceRef={domain:'analysis',ref:{objectId:'report',versionId:'v1'},sourceGroup:'original-one'};
    const firstMember=await store.assignMembership({projectId:'p',source,topicId:topic.id,state:'confirmed',reason:'first reading',methodVersion:'test'});
    const manifest:LearningManifest={sources:[source],baseHeads:[],methodVersion:'m1',policyVersion:'p1',budget:{}};
    const stale=await store.prepareBuild({projectId:'p',topicId:topic.id,manifest,reason:'first'});
    const revised=await store.assignMembership({projectId:'p',source,topicId:topic.id,state:'confirmed',reason:'revised reading',methodVersion:'test'});
    const transaction=await pool.connect();
    try {
      await transaction.query('BEGIN');
      await assert.rejects(store.assertInputs('p',{topicId:topic.id,topicVersion:topic.version,memberships:[{id:firstMember.id,version:firstMember.version}]},transaction),
        /Confirmed topic memberships changed/);
      await transaction.query('ROLLBACK');
    } finally {transaction.release();}
    assert.equal((await store.getBuild('p',stale.id))?.outcome,null);
    assert.equal((await store.snapshot('p')).pending.find(item=>item.topicId===topic.id)?.processedSequence,0);
    const fresh=await store.prepareBuild({projectId:'p',topicId:topic.id,manifest:{...manifest,methodVersion:'m2'},reason:'rebase'});
    const later=await store.registerInput({projectId:'p',eventKey:'later-source',type:'source',sources:[source],reason:'later source observation'});
    const committing=await pool.connect();
    try {
      await committing.query('BEGIN');
      await store.assertInputs('p',{topicId:topic.id,topicVersion:topic.version,memberships:[{id:revised.id,version:revised.version}]},committing);
      const concurrentMembership=store.assignMembership({projectId:'p',source,topicId:topic.id,state:'confirmed',
        reason:'arrived during publication',methodVersion:'test'});
      const blocked=await Promise.race([concurrentMembership.then(()=>false),new Promise<boolean>(resolve=>setTimeout(()=>resolve(true),40))]);
      assert.equal(blocked,true,'membership mutation must wait until publication transaction commits');
      await store.finishBuild({projectId:'p',buildId:fresh.id,outcome:'no_change',reason:'same confirmed membership'},committing);
      await committing.query('COMMIT');
      assert.equal((await concurrentMembership).version,revised.version+1);
    } finally {committing.release();}
    const pending=(await store.snapshot('p')).pending.find(item=>item.topicId===topic.id);
    assert.equal(pending?.processedSequence,fresh.throughSequence);
    assert.ok((pending?.latestSequence??0)>later.sequence);
    const retired=await store.setTopicStatus('p',topic.id,'retired','retired after review');
    const check=await pool.connect();
    try {
      await check.query('BEGIN');
      await assert.rejects(store.assertInputs('p',{topicId:topic.id,topicVersion:topic.version,memberships:[{id:revised.id,version:revised.version}]},check),
        /Topic status or version changed/);
      await check.query('ROLLBACK');
    } finally {check.release();}
    assert.equal(retired.status,'retired');
  } finally {await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});

dbTest('prepareBuild uses the manifest-frozen watermark, leaving later events pending', {timeout:60_000}, async()=>{
  const admin=new pg.Pool({connectionString,max:2});
  const schema=`ccl_learning_watermark_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,max:4,options:`-c search_path=${schema}`});
  try {
    await migrateKnowledgeLearning(pool);
    const store=createKnowledgeLearningStore(pool);
    const topic=await store.createTopic({projectId:'p',title:'Frozen boundary',question:'What changed after freezing?',method:'test',status:'confirmed'});
    const source:LearningSourceRef={domain:'analysis',ref:{objectId:'report',versionId:'v1'},sourceGroup:'original-one'};
    const manifest:LearningManifest={sources:[source],baseHeads:[],methodVersion:'m1',policyVersion:'p1',budget:{},throughSequence:0};
    assert.equal((await store.prepareBuild({projectId:'p',topicId:topic.id,manifest,reason:'empty checkpoint'})).throughSequence,0);
    const first=await store.registerInput({projectId:'p',eventKey:'source-A',type:'source',sources:[source],topicIds:[topic.id],reason:'A'});
    const boundary=(await store.snapshot('p')).pending.find(item=>item.topicId===topic.id)?.latestSequence;
    assert.equal(boundary,first.sequence);
    const later=await store.registerInput({projectId:'p',eventKey:'source-B',type:'feedback',sources:[source],topicIds:[topic.id],reason:'B after freeze'});
    const frozen=await store.prepareBuild({projectId:'p',topicId:topic.id,manifest:{...manifest,throughSequence:boundary},reason:'frozen A'});
    assert.equal(frozen.throughSequence,first.sequence);
    assert.ok(later.sequence>frozen.throughSequence);
    await assert.rejects(store.prepareBuild({projectId:'p',topicId:topic.id,manifest:{...manifest,throughSequence:later.sequence+1},reason:'future watermark'}),
      (error:unknown)=>error instanceof Error && 'code' in error && error.code==='BUILD_WATERMARK_INVALID');
    await store.finishBuild({projectId:'p',buildId:frozen.id,outcome:'no_change',reason:'A had no new finding'});
    const pending=(await store.snapshot('p')).pending.find(item=>item.topicId===topic.id);
    assert.equal(pending?.processedSequence,first.sequence);
    assert.equal(pending?.latestSequence,later.sequence);
    assert.equal(pending?.count,1);
    await assert.rejects(store.prepareBuild({projectId:'p',topicId:topic.id,manifest:{...manifest,throughSequence:0},reason:'already processed'}),
      (error:unknown)=>error instanceof Error && 'code' in error && error.code==='BUILD_WATERMARK_INVALID');
  } finally {await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});

dbTest('last rejected topic returns source to unassigned inbox and event replay preserves history', {timeout:60_000}, async()=>{
  const admin=new pg.Pool({connectionString,max:2});
  const schema=`ccl_learning_inbox_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,max:4,options:`-c search_path=${schema}`});
  try {
    await migrateKnowledgeLearning(pool);
    const store=createKnowledgeLearningStore(pool);
    const topic=await store.createTopic({projectId:'p',title:'Inbox',question:'Where does this source belong?',method:'test'});
    const source:LearningSourceRef={domain:'analysis',ref:{objectId:'report',versionId:'v1'},sourceGroup:'same-original'};
    const bare:LearningSourceRef={domain:source.domain,ref:source.ref};
    await store.registerInput({projectId:'p',eventKey:'initial-report',type:'report',sources:[source],reason:'first arrival'});
    assert.equal((await store.snapshot('p')).unassigned.length,1);
    const confirmed=await store.assignMembership({projectId:'p',source:bare,topicId:topic.id,state:'confirmed',reason:'initial fit',methodVersion:'test'});
    assert.equal(confirmed.source.sourceGroup,'same-original','stored membership retains original group when API omits it');
    assert.equal((await store.snapshot('p')).unassigned.length,0);
    const rejected=await store.assignMembership({projectId:'p',source:bare,topicId:topic.id,state:'rejected',reason:'review disproved fit',methodVersion:'test'});
    assert.equal(rejected.source.sourceGroup,'same-original');
    assert.equal((await store.snapshot('p')).unassigned[0]?.source.sourceGroup,'same-original');
    // Reproduce an older row closed before the last topic was rejected.
    await pool.query(`UPDATE ccl_learning_memberships SET payload=jsonb_set(payload,'{state}','"rejected"'::jsonb)
      WHERE project_id=$1 AND topic_id IS NULL`,['p']);
    assert.equal((await store.snapshot('p')).unassigned.length,0);
    const later={projectId:'p',eventKey:'later-report',type:'source' as const,sources:[bare],reason:'source revised'};
    await store.registerInput(later);
    assert.equal((await store.snapshot('p')).unassigned[0]?.source.sourceGroup,'same-original');
    const count=async()=>Number((await pool.query<{count:string}>(`SELECT count(*) FROM ccl_learning_membership_history h
      JOIN ccl_learning_memberships m ON m.project_id=h.project_id AND m.member_key=h.member_key
      WHERE m.project_id=$1 AND m.topic_id IS NULL`,['p'])).rows[0].count);
    const before=await count();
    await store.registerInput(later);
    assert.equal(await count(),before,'same event must not add another unassigned history version');
  } finally {await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
