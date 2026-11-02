import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {seedKnowledgeSyntheticFixture} from '../../../scripts/runtime/knowledge-synthetic-fixture.ts';
import {assertKnowledgeWriterAuthority} from '../../../packages/knowledge/src/writer-authority.ts';
import {createPgWikiLint,migrateWikiLint} from '../../../packages/adapters/knowledge-service/src/wiki-lint.ts';

const databaseUrl=readTestDatabase(),dbTest=databaseUrl?test:test.skip;
async function schemaPool(){
  const admin=new pg.Pool({connectionString:databaseUrl!,max:2});
  const schema=`wiki_lint_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  return {admin,schema,pool:new pg.Pool({connectionString:databaseUrl!,max:8,options:`-c search_path=${schema}`})};
}
async function writer(pool:pg.Pool,projectId:string,grant:Parameters<typeof assertKnowledgeWriterAuthority>[2],
  action:(client:pg.PoolClient)=>Promise<void>){
  const client=await pool.connect();
  try{await client.query('BEGIN');await assertKnowledgeWriterAuthority(client,projectId,grant);
    await action(client);await client.query('COMMIT');}
  catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
const request=(cycleKey:string,shard=0,shardCount=1,limit=100)=>({cycleKey,shard,shardCount,limit,methodVersion:'metadata-lint-v1'});

dbTest('Wiki lint scans metadata by shard and cycle, finds seeded defects, and isolates findings',{timeout:90_000},async()=>{
  const {admin,schema,pool}=await schemaPool();
  try{
    const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-${randomUUID()}`,'wiki-lint-space');
    await migrateWikiLint(pool);
    const context={scope:{projectId:seed.projectId,spaceId:seed.spaceId},principal:seed.principal,purpose:'exploration_reading'};
    const root=seed.root;
    const other=(await pool.query<{object_id:string;version_id:string}>(`SELECT h.object_id,h.version_id
      FROM ccl_knowledge_heads h WHERE h.project_id=$1 AND h.object_id<>$2 ORDER BY h.object_id LIMIT 1`,
      [seed.projectId,root.objectId])).rows[0];assert.ok(other);
    const critical=(await pool.query<{dep_object_id:string;dep_version_id:string}>(`SELECT dep_object_id,dep_version_id
      FROM ccl_knowledge_deps WHERE project_id=$1 AND object_id=$2 AND version_id=$3
        AND domain='knowledge' AND critical LIMIT 1`,[seed.projectId,root.objectId,root.versionId])).rows[0];
    assert.ok(critical);
    const missingId=randomUUID(),missingVersion=randomUUID();
    await writer(pool,seed.projectId,seed.writerGrant,async client=>{
      await client.query(`UPDATE ccl_knowledge_revisions SET payload=jsonb_set(
        jsonb_set(jsonb_set(payload,'{scope,reviewDueAt}',to_jsonb('2020-01-01T00:00:00.000Z'::text)),
          '{content,citations}','[]'::jsonb),'{sourceGroups}',
          '["synthetic:shared-notes","synthetic:shared-notes"]'::jsonb)
        WHERE project_id=$1 AND object_id=$2 AND version_id=$3`,[seed.projectId,root.objectId,root.versionId]);
      await client.query(`INSERT INTO ccl_knowledge_deps(project_id,object_id,version_id,domain,dep_object_id,dep_version_id,role,critical)
        VALUES($1,$2,$3,'knowledge',$4,$5,'uses',false)`,
        [seed.projectId,root.objectId,root.versionId,missingId,missingVersion]);
      await client.query(`INSERT INTO ccl_knowledge_invalidities(project_id,domain,object_id,version_id,reason,state)
        VALUES($1,'knowledge',$2,$3,'synthetic-stale','stale')`,
        [seed.projectId,critical.dep_object_id,critical.dep_version_id]);
      await client.query(`INSERT INTO ccl_knowledge_invalidities(project_id,domain,object_id,version_id,reason,state)
        VALUES($1,'source',$2,$3,'synthetic-source-stale','stale')`,
        [seed.projectId,seed.source.ref.objectId,seed.source.ref.versionId]);
      await client.query(`UPDATE ccl_knowledge_revisions SET payload=jsonb_set(jsonb_set(jsonb_set(
        jsonb_set(payload,'{content,profile,id}',to_jsonb('synthesis'::text)),
        '{content,identity,key}',to_jsonb('visibility'::text)),
        '{sourceGroups}','{"malformed":true}'::jsonb),'{content,citations}','{"malformed":true}'::jsonb)
        WHERE project_id=$1 AND object_id=$2 AND version_id=$3`,
        [seed.projectId,other.object_id,other.version_id]);
    });
    let inspected=0;
    const spy={connect:async()=>{
      const client=await pool.connect();
      return new Proxy(client,{get(target,property){
        if(property==='release')return target.release.bind(target);
        if(property!=='query')return Reflect.get(target,property);
        return async(...args:unknown[])=>{
          const sql=String(args[0]);
          const result=await Reflect.apply(target.query,target,args);
          if(sql.includes('AS review_admitted')){
            inspected++;
            assert.ok(!/SELECT\s+(?:r\.)?payload(?:\s|,)/i.test(sql));
            for(const row of result.rows)assert.ok(!('payload' in row)&&!('body' in row));
          }
          return result;
        };
      }});
    },query:pool.query.bind(pool)} as unknown as pg.Pool;
    const lint=createPgWikiLint(spy,seed.writerGrant);
    const pass=await lint.runPass(context,request('defects'));
    assert.equal(pass.complete,true);
    assert.equal(pass.consistency,'incremental_current_heads');
    assert.ok(pass.omittedReasons.includes('current_heads_can_change_between_pages'));
    assert.ok(pass.omittedReasons.includes('malformed_source_group_metadata'));
    assert.ok(pass.omittedReasons.includes('malformed_citation_metadata'));
    assert.ok(inspected>0);
    const findings=await lint.findings(context,{limit:100});
    assert.equal(pass.findingCount,findings.items.length);
    const rootKinds=new Set(findings.items.filter(item=>item.subjectRef.objectId===root.objectId).map(item=>item.kind));
    for(const kind of ['review_due','broken_link','invalid_critical_basis','missing_citation',
      'duplicate_source_group','suspected_duplicate'])assert.ok(rootKinds.has(kind as never),kind);
    assert.ok(findings.items.some(item=>item.kind==='orphan'));
    assert.ok(findings.items.every(item=>item.subjectRef.contentDigest===null&&item.status==='open'&&item.taskId===null));
    const broken=findings.items.find(item=>item.subjectRef.objectId===root.objectId&&item.kind==='broken_link');
    assert.ok(broken?.reason.includes(`${missingId}/${missingVersion}`));
    assert.ok(broken?.relatedRefs.every(item=>item.contentDigest===null));
    const criticalFinding=findings.items.find(item=>item.subjectRef.objectId===root.objectId&&item.kind==='invalid_critical_basis');
    assert.ok(criticalFinding?.reason.includes(`source:${seed.source.ref.objectId}/${seed.source.ref.versionId}`));
    const replay=await lint.runPass(context,request('defects'));
    assert.equal(replay.scanned,pass.scanned);
    assert.equal(replay.findingCount,pass.findingCount);
    assert.deepEqual((await lint.findings(context,{limit:100})).items.map(item=>item.id),findings.items.map(item=>item.id));
    const firstPage=await lint.findings(context,{limit:2});assert.equal(firstPage.hasMore,true);
    const next=await lint.findings(context,{limit:2,cursor:firstPage.nextCursor!});
    assert.ok(next.items.every(item=>!firstPage.items.some(before=>before.id===item.id)));
    const otherInstallation={...context,principal:{...context.principal,clientInstallationId:'other-installation'}};
    assert.deepEqual(await lint.findings(otherInstallation,{limit:10}),{items:[],hasMore:false,nextCursor:null});
    const otherPrincipal={...context,principal:{...context.principal,id:'other-principal'}};
    assert.deepEqual(await lint.findings(otherPrincipal,{limit:10}),{items:[],hasMore:false,nextCursor:null});
    const otherSpace={...context,scope:{...context.scope,spaceId:'other-space'},
      principal:{...context.principal,spaceIds:[seed.spaceId,'other-space']}};
    assert.deepEqual(await lint.findings(otherSpace,{limit:10}),{items:[],hasMore:false,nextCursor:null});
    assert.deepEqual((await lint.findings(context,{limit:10,status:'resolved'})).items,[]);
    const otherPurpose={...context,purpose:'other-purpose',principal:{...context.principal,purposes:['exploration_reading','other-purpose']}};
    assert.deepEqual(await lint.findings(otherPurpose,{limit:10}),{items:[],hasMore:false,nextCursor:null});
    const skipped=await lint.runPass(otherPurpose,request('purpose-review'));
    assert.equal(skipped.scanned,pass.scanned);
    assert.deepEqual(skipped.findingIds,[]);
    assert.ok(skipped.omittedReasons.includes('head_not_reviewed_for_requested_purpose'));
    const shard0=await lint.runPass(context,request('shards',0,2,3));
    const shard1=await lint.runPass(context,request('shards',1,2,3));
    let a=shard0,b=shard1;
    while(!a.complete)a=await lint.runPass(context,request('shards',0,2,3));
    while(!b.complete)b=await lint.runPass(context,request('shards',1,2,3));
    assert.equal(a.scanned+b.scanned,pass.scanned);
    const epochFirst=await lint.runPass(context,request('epoch',0,1,1));
    assert.equal(epochFirst.complete,false);
    await writer(pool,seed.projectId,seed.writerGrant,async client=>{
      await client.query('UPDATE ccl_knowledge_projects SET epoch=epoch+1 WHERE project_id=$1',[seed.projectId]);
    });
    const epochNext=await lint.runPass(context,request('epoch',0,1,1));
    assert.ok(epochNext.observedEpoch>epochNext.startEpoch);
    assert.ok(epochNext.omittedReasons.some(reason=>reason.includes('earlier_keys_or_versions_may_be_missed')));
    const concurrent=await Promise.all([lint.runPass(context,request('concurrent',0,1,1)),
      lint.runPass(context,request('concurrent',0,1,1))]);
    assert.equal(concurrent[0].id,concurrent[1].id);
    assert.deepEqual(concurrent.map(item=>item.scanned).sort((x,y)=>x-y),[1,2]);
    const newCycle=await lint.runPass(context,request('new-cycle'));
    assert.equal(newCycle.scanned,pass.scanned);
    assert.notEqual(newCycle.id,pass.id);
    assert.ok(newCycle.findingIds.length>0);
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});

dbTest('Wiki lint fault rolls back findings and cursor; lost COMMIT preserves pass ID',{timeout:90_000},async()=>{
  const {admin,schema,pool}=await schemaPool();
  try{
    const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-${randomUUID()}`,'wiki-lint-fault');
    await migrateWikiLint(pool);
    const context={scope:{projectId:seed.projectId,spaceId:seed.spaceId},principal:seed.principal,purpose:'exploration_reading'};
    const lint=createPgWikiLint(pool,seed.writerGrant);
    const beforeFailure=await lint.runPass(context,request('mid-fault',0,1,1));
    assert.equal(beforeFailure.scanned,1);
    const findingsBefore=(await pool.query<{count:string}>(`SELECT count(*) FROM ccl_knowledge_lint_findings
      WHERE pass_id=$1`,[beforeFailure.id])).rows[0].count;
    await pool.query(`CREATE FUNCTION lint_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic lint finding failure'; END $$;
      CREATE TRIGGER lint_failure BEFORE INSERT ON ccl_knowledge_lint_findings
      FOR EACH ROW EXECUTE FUNCTION lint_fail()`);
    await assert.rejects(lint.runPass(context,request('mid-fault',0,1,1)),/synthetic lint finding failure/);
    const unchanged=(await pool.query<{scanned:number;last_object_id:string|null}>(`SELECT scanned,last_object_id
      FROM ccl_knowledge_lint_passes WHERE id=$1`,[beforeFailure.id])).rows[0];
    assert.equal(unchanged.scanned,1);
    assert.equal(unchanged.last_object_id,beforeFailure.lastObjectId);
    assert.equal((await pool.query<{count:string}>(`SELECT count(*) FROM ccl_knowledge_lint_findings
      WHERE pass_id=$1`,[beforeFailure.id])).rows[0].count,findingsBefore);
    await assert.rejects(lint.runPass(context,request('fault')),/synthetic lint finding failure/);
    assert.equal((await pool.query<{count:string}>(`SELECT count(*) FROM ccl_knowledge_lint_passes
      WHERE cycle_key='fault'`)).rows[0].count,'0');
    await pool.query('DROP TRIGGER lint_failure ON ccl_knowledge_lint_findings; DROP FUNCTION lint_fail()');
    const continued=await lint.runPass(context,request('mid-fault',0,1,1));
    assert.equal(continued.scanned,2);
    const after=await lint.runPass(context,request('fault'));
    assert.equal(after.complete,true);
    const lost={connect:async()=>{
      const client=await pool.connect();let thrown=false,lintStarted=false;
      return new Proxy(client,{get(target,property){
        if(property==='release')return target.release.bind(target);
        if(property!=='query')return Reflect.get(target,property);
        return async(...args:unknown[])=>{
          if(String(args[0]).includes('INSERT INTO ccl_knowledge_lint_passes'))lintStarted=true;
          const result=await Reflect.apply(target.query,target,args);
          if(args[0]==='COMMIT'&&lintStarted&&!thrown){thrown=true;throw new Error('synthetic lost COMMIT ACK');}
          return result;
        };
      }});
    },query:pool.query.bind(pool)} as unknown as pg.Pool;
    let unknownId='';
    await assert.rejects(createPgWikiLint(lost,seed.writerGrant).runPass(context,request('lost-ack')),
      (error:unknown)=>{const value=error as {commitStatus?:string;operationId?:string};
        unknownId=value.operationId??'';return value.commitStatus==='unknown'&&!!unknownId;});
    const recovered=await lint.runPass(context,request('lost-ack'));
    assert.equal(recovered.id,unknownId);
    assert.equal(recovered.complete,true);
    await assert.rejects(pool.query(`INSERT INTO ccl_knowledge_lint_passes
      (id,project_id,space_id,principal_id,installation_id,purpose,cycle_key,shard_count,shard,method_version,start_epoch,observed_epoch)
      VALUES($1,$2,$3,$4,$5,$6,'guard',1,0,'v1',0,0)`,
      [randomUUID(),seed.projectId,seed.spaceId,seed.principal.id,seed.principal.clientInstallationId,context.purpose]),
      (error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&error.code==='42501');
    const findingId=(await pool.query<{id:string}>('SELECT id FROM ccl_knowledge_lint_findings LIMIT 1')).rows[0]?.id;
    assert.ok(findingId);
    await assert.rejects(pool.query('DELETE FROM ccl_knowledge_lint_findings WHERE id=$1',[findingId]),
      (error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&error.code==='42501');
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});

dbTest('large cycle keeps a bounded pass preview and a complete paginated finding ledger',{timeout:90_000},async()=>{
  const {admin,schema,pool}=await schemaPool();
  try{
    const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-${randomUUID()}`,'wiki-lint-large');
    await migrateWikiLint(pool);
    const context={scope:{projectId:seed.projectId,spaceId:seed.spaceId},principal:seed.principal,purpose:'exploration_reading'};
    await writer(pool,seed.projectId,seed.writerGrant,async client=>{
      await client.query(`WITH template AS (
        SELECT r.* FROM ccl_knowledge_revisions r JOIN ccl_knowledge_heads h
          ON h.project_id=r.project_id AND h.object_id=r.object_id AND h.version_id=r.version_id
        WHERE r.project_id=$1 AND r.kind='wiki_page' AND r.published_at IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM ccl_knowledge_deps d
            WHERE d.project_id=r.project_id AND d.object_id=r.object_id AND d.version_id=r.version_id
              AND d.domain='knowledge') LIMIT 1
      ), hashes AS (
        SELECT md5('lint-preview-object-'||n) AS object_hash,
          md5('lint-preview-version-'||n) AS version_hash FROM generate_series(1,220) AS n
      ), generated AS (
        SELECT format('%s-%s-5%s-a%s-%s',substr(object_hash,1,8),substr(object_hash,9,4),
          substr(object_hash,14,3),substr(object_hash,18,3),substr(object_hash,21,12)) AS object_id,
          format('%s-%s-5%s-a%s-%s',substr(version_hash,1,8),substr(version_hash,9,4),
          substr(version_hash,14,3),substr(version_hash,18,3),substr(version_hash,21,12)) AS version_id FROM hashes
      )
      INSERT INTO ccl_knowledge_revisions
        (project_id,object_id,version_id,changeset_id,kind,title,body,payload,published_at)
      SELECT t.project_id,g.object_id,g.version_id,t.changeset_id,t.kind,'lint-preview-clone',t.body,
        jsonb_set(jsonb_set(jsonb_set(jsonb_set(t.payload,'{ref}',
          jsonb_build_object('objectId',g.object_id,'versionId',g.version_id)),
          '{scope,reviewDueAt}',to_jsonb('2020-01-01T00:00:00.000Z'::text)),
          '{content,citations}','[]'::jsonb),'{sourceGroups}',
          '["synthetic:shared-notes","synthetic:shared-notes"]'::jsonb),t.published_at
      FROM template t CROSS JOIN generated g`,[seed.projectId]);
      await client.query(`INSERT INTO ccl_knowledge_heads(project_id,object_id,version_id)
        SELECT project_id,object_id,version_id FROM ccl_knowledge_revisions
        WHERE project_id=$1 AND title='lint-preview-clone'`,[seed.projectId]);
    });
    const lint=createPgWikiLint(pool,seed.writerGrant);
    let pass=await lint.runPass(context,request('large-cycle'));
    while(!pass.complete)pass=await lint.runPass(context,request('large-cycle'));
    const total=Number((await pool.query<{finding_count:string}>(
      'SELECT finding_count FROM ccl_knowledge_lint_passes WHERE id=$1',[pass.id])).rows[0].finding_count);
    assert.ok(total>1000,`expected more than 1000 findings, got ${total}`);
    assert.equal(pass.findingCount,total);
    assert.ok(pass.findingIds.length<=1000);
    assert.ok(pass.omittedReasons.some(reason=>reason.includes(`of ${total} findings`)&&reason.includes('findings() pagination')));
    let cursor:string|undefined,count=0;
    do{const page=await lint.findings(context,{limit:100,...(cursor?{cursor}:{})});
      count+=page.items.length;cursor=page.nextCursor??undefined;
    }while(cursor);
    assert.equal(count,total);
    const replay=await lint.runPass(context,request('large-cycle'));
    assert.equal(replay.scanned,pass.scanned);
    assert.equal(replay.findingCount,total);
    assert.equal(Number((await pool.query<{finding_count:string}>(
      'SELECT finding_count FROM ccl_knowledge_lint_passes WHERE id=$1',[pass.id])).rows[0].finding_count),total);
    await writer(pool,seed.projectId,seed.writerGrant,async client=>{
      await client.query('UPDATE ccl_knowledge_lint_passes SET finding_count=0 WHERE id=$1',[pass.id]);
    });
    const migratedReplay=await lint.runPass(context,request('large-cycle'));
    assert.equal(migratedReplay.scanned,pass.scanned);
    assert.equal(migratedReplay.findingCount,total);
    assert.ok(migratedReplay.omittedReasons.some(reason=>reason.includes(`of ${total} findings`)));
    assert.equal(Number((await pool.query<{finding_count:string}>(
      'SELECT finding_count FROM ccl_knowledge_lint_passes WHERE id=$1',[pass.id])).rows[0].finding_count),total);
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
