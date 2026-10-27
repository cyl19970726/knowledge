import { readTestDatabase } from '../../../scripts/runtime/test-database.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrateKnowledge } from '../src/migrations.ts';
import { createKnowledgeStore } from '../src/store.ts';
import { assertKnowledgeWriterAuthority, rotateKnowledgeWriterAuthority } from '../src/writer-authority.ts';
import type { KnowledgeChangeSet, KnowledgeRevision, KnowledgeReview } from '../src/types.ts';
const connectionString=readTestDatabase();
const dbTest=connectionString?test:test.skip;
function candidate(projectId:string):KnowledgeChangeSet {
  const ref={objectId:randomUUID(),versionId:randomUUID()},createdAt=new Date().toISOString();
  const revision:KnowledgeRevision={kind:'pattern',projectId,ref,title:'Synthetic authority test',body:'Synthetic authority test',
    scope:{applicability:{productVersionRefs:[],markets:[],languages:[],audiences:[],goals:[],requiredProduction:[],transferRationale:null},limitations:[],unknowns:[],goalTags:[],reviewDueAt:null},
    dependencies:[],sourceGroups:[],artifactRef:null,createdAt,analysisQuality:null,
    content:{ref,projectId,title:'Synthetic authority test',problem:'fixture',mechanism:'fixture',sequence:[],requiredElements:[],variableSlots:[],applicability:[],exclusions:[],supportRefs:[],counterexampleRefs:[],prediction:'none',evidenceLevel:'inconclusive',citations:[]}};
  return {id:randomUUID(),projectId,requestKey:randomUUID(),requestHash:'1'.repeat(64),contentHash:'2'.repeat(64),purpose:'exploration_reading',
    proposer:'builder',rationale:'Synthetic only',methodVersion:'synthetic@1',cost:{state:'unknown',reason:'fixture'},baseHeads:[{objectId:ref.objectId,versionId:null}],
    inputManifest:[],changes:[{revision,effect:'create',explanation:'Synthetic only'}],createdAt};
}
function reviewed(c:KnowledgeChangeSet):KnowledgeReview{return{id:randomUUID(),projectId:c.projectId,changeSetId:c.id,contentHash:c.contentHash,purpose:c.purpose,reviewer:'reviewer',policyVersion:'test',decision:'exploration_only',rationale:'Synthetic only',createdAt:c.createdAt};}

dbTest('writer authority rejects legacy store and old SQL, rotates by CAS, and checks publish in its transaction', {timeout:60000},async()=>{
  const admin=new pg.Pool({connectionString,max:2}),schema=`ccl_writer_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,max:8,options:`-c search_path=${schema}`});
  try {
    await migrateKnowledge(pool);await migrateKnowledge(pool);
    const projectId='synthetic-authority',legacy=createKnowledgeStore(pool),c=candidate(projectId);
    const unactivatedGrant={ownerId:'not-activated',generation:1,token:randomUUID()};
    assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_writer_authority WHERE project_id=$1',[projectId])).rows[0].n,0,
      'schema migration does not activate a project writer');
    await assert.rejects(createKnowledgeStore(pool,{writerGrant:unactivatedGrant}).stage(candidate(projectId)),
      (error:unknown)=>error instanceof Error&&'code' in error&&error.code==='KNOWLEDGE_WRITER_REVOKED');
    await legacy.stage(c);await legacy.recordReview(reviewed(c));
    const first=await rotateKnowledgeWriterAuthority(pool,projectId,null,{ownerId:'knowledge-service',mode:'active'});
    await assert.rejects(legacy.stage(candidate(projectId)),/capability.*absent|revoked/i);
    await assert.rejects(legacy.recordReview(reviewed(c)),/capability.*absent|revoked/i);
    await assert.rejects(legacy.publish(projectId,c.id,c.contentHash),/capability.*absent|revoked/i);
    await assert.rejects(legacy.invalidate(projectId,{domain:'knowledge',ref:c.changes[0].revision.ref,state:'stale',reason:'legacy',createdAt:c.createdAt}),/capability.*absent|revoked/i);
    await assert.rejects(pool.query('UPDATE ccl_knowledge_revisions SET body=$2 WHERE project_id=$1',[projectId,'old binary raw SQL']),/KNOWLEDGE_WRITER_REVOKED/);
    await assert.rejects(pool.query('UPDATE ccl_knowledge_revisions SET project_id=$2 WHERE project_id=$1',[projectId,'other']),/KNOWLEDGE_PROJECT_IMMUTABLE/);
    const owner=createKnowledgeStore(pool,{writerGrant:first});
    const publication=await owner.publish(projectId,c.id,c.contentHash);
    assert.equal(publication.epoch,1);
    assert.deepEqual(await legacy.head(projectId,c.changes[0].revision.ref.objectId),c.changes[0].revision.ref,'old readers retain access');
    const raw=await pool.query<{token_hash:string}>('SELECT token_hash FROM ccl_knowledge_writer_authority WHERE project_id=$1',[projectId]);
    assert.notEqual(raw.rows[0].token_hash,first.token);
    const client=await pool.connect();
    let second:Awaited<ReturnType<typeof rotateKnowledgeWriterAuthority>>;
    try {
      await client.query('BEGIN');await assertKnowledgeWriterAuthority(client,projectId,first);
      await client.query('UPDATE ccl_knowledge_revisions SET body=body WHERE project_id=$1',[projectId]);
      let switched=false;
      const pending=rotateKnowledgeWriterAuthority(pool,projectId,1,{ownerId:'new-service',mode:'active'},first).then(v=>{switched=true;return v;});
      await new Promise(resolve=>setTimeout(resolve,30));assert.equal(switched,false,'rotation waits for current authoritative transaction');
      await client.query('COMMIT');second=await pending;
      // Transaction-local grant must not leak into arbitrary SQL on a reused connection.
      await assert.rejects(client.query('UPDATE ccl_knowledge_revisions SET body=body WHERE project_id=$1',[projectId]),/KNOWLEDGE_WRITER_REVOKED/);
    } finally {client.release();}
    assert.equal(second!.generation,2);
    await assert.rejects(owner.stage(candidate(projectId)),/capability.*absent|revoked/i);
    await assert.rejects(rotateKnowledgeWriterAuthority(pool,projectId,1,{ownerId:'third',mode:'active'},first),/generation changed/);
    await assert.rejects(rotateKnowledgeWriterAuthority(pool,projectId,2,{ownerId:'third',mode:'active'},first),/Current owner capability/);
    const readonly=await rotateKnowledgeWriterAuthority(pool,projectId,2,{ownerId:'new-service',mode:'read_only'},second!);
    await assert.rejects(createKnowledgeStore(pool,{writerGrant:readonly}).stage(candidate(projectId)),/capability.*absent|revoked/i);
    assert.equal((await owner.get(projectId,c.changes[0].revision.ref))?.published,true);
    // Projects that have not opted into the local switch preserve existing authorized behavior.
    await legacy.stage(candidate('unmigrated-synthetic-project'));
  } finally {await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});

dbTest('revision reads report authoritative publication time, distinct from authored time', {timeout:60000},async()=>{
  const admin=new pg.Pool({connectionString,max:2}),schema=`ccl_publication_time_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,max:8,options:`-c search_path=${schema}`});
  try{
    await migrateKnowledge(pool);
    const projectId='synthetic-publication-time',grant=await rotateKnowledgeWriterAuthority(pool,projectId,null,{ownerId:'time-test',mode:'active'});
    const store=createKnowledgeStore(pool,{writerGrant:grant}),change=candidate(projectId);
    const authoredAt='2020-01-02T03:04:05.000Z';
    change.createdAt=authoredAt;change.changes[0].revision.createdAt=authoredAt;
    await store.stage(change);await store.recordReview(reviewed(change));
    const publication=await store.publish(projectId,change.id,change.contentHash),ref=change.changes[0].revision.ref;
    assert.notEqual(publication.publishedAt,authoredAt);
    const exact=await store.get(projectId,ref),history=await store.history(projectId,ref.objectId);
    const search=await store.search(projectId,{kinds:['pattern'],limit:10});
    const asOf=await store.getAsOf!(projectId,ref,new Date(Date.parse(publication.publishedAt)+1000).toISOString());
    for(const [name,view] of [['get',exact],['history',history[0]],['search',search[0]],['getAsOf',asOf]] as const){
      assert.ok(view,`${name} must return the exact revision`);
      assert.equal(view.publishedAt,publication.publishedAt,`${name} must project stored published_at`);
      assert.equal(view.revision.createdAt,authoredAt,`${name} must preserve authored time`);
    }
    assert.equal(await store.getAsOf!(projectId,ref,new Date(Date.parse(publication.publishedAt)-1000).toISOString()),null);
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
