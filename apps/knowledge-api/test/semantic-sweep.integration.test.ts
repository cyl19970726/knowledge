import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {seedKnowledgeSyntheticFixture} from '../../../scripts/runtime/knowledge-synthetic-fixture.ts';
import {assertKnowledgeWriterAuthority,rotateKnowledgeWriterAuthority} from '../../../packages/knowledge/src/writer-authority.ts';
import {migrateMaintenanceTasks,createPgMaintenanceTasks} from '../../../packages/adapters/knowledge-service/src/maintenance-tasks.ts';
import {migrateSemanticSweeps,createPgSemanticSweep} from '../../../packages/adapters/knowledge-service/src/semantic-sweep.ts';

const databaseUrl=readTestDatabase(),dbTest=databaseUrl?test:test.skip;
const hasCode=(code:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&error.code===code;
const request=(cycleKey:string,shard=0,shardCount=1,limit=3,maxTasksPerShard=100)=>({
  cycleKey,shard,shardCount,limit,maxTasksPerShard,methodVersion:'semantic-fixture/1',rubricVersion:'rubric/1'});
async function setup(){
  const admin=new pg.Pool({connectionString:databaseUrl!,max:2});
  const schema=`semantic_sweep_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString:databaseUrl!,max:8,options:`-c search_path=${schema}`});
  try{
    const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-${randomUUID()}`,'semantic-space');
    await migrateMaintenanceTasks(pool);await migrateSemanticSweeps(pool);
    const context={scope:{projectId:seed.projectId,spaceId:seed.spaceId},principal:seed.principal,purpose:'exploration_reading'};
    return {admin,schema,pool,seed,context,close:async()=>{
      await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}};
  }catch(error){await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();throw error;}
}

dbTest('semantic sweep partitions current Wiki heads and persists exact periodic tasks once',{timeout:120_000},async()=>{
  const f=await setup();
  try{
    const sweep=createPgSemanticSweep(f.pool,f.seed.writerGrant);
    const tasks=createPgMaintenanceTasks(f.pool,f.seed.writerGrant);
    const all=new Set<string>();let total=0,ownedPassId='';
    for(let shard=0;shard<3;shard++){
      const input=request('partition',shard,3,2);
      let pass=await sweep.runPass(f.context,input);
      const firstId=pass.id;
      if(shard===0)ownedPassId=firstId;
      if(shard===0){
        const client=await f.pool.connect();
        try{await client.query('BEGIN');await assertKnowledgeWriterAuthority(client,f.seed.projectId,f.seed.writerGrant);
          await client.query('UPDATE ccl_knowledge_projects SET epoch=epoch+1 WHERE project_id=$1',[f.seed.projectId]);
          await client.query('COMMIT');}
        catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
      }
      while(true){
        for(const id of pass.taskIds){assert.ok(!all.has(id));all.add(id);}
        if(pass.complete)break;
        assert.equal(pass.limitReached,false);
        pass=await sweep.runPass(f.context,{...input,limit:5});
      }
      total+=pass.taskCount;
      assert.equal(pass.id,firstId);
      assert.equal(pass.scanned,pass.taskCount);
      if(shard===0)assert.ok(pass.omittedReasons.some(reason=>reason.startsWith('publication_epoch_changed')));
      assert.equal((await sweep.get(f.context,pass.id))?.taskCount,pass.taskCount);
      const replay=await sweep.runPass(f.context,input);
      assert.equal(replay.taskCount,pass.taskCount);
      assert.equal(replay.updatedAt,pass.updatedAt,'terminal pass must not busy-loop on replay');
      await assert.rejects(sweep.runPass(f.context,{...input,maxTasksPerShard:99}),hasCode('SEMANTIC_SWEEP_LIMIT_CONFLICT'));
    }
    const expected=(await f.pool.query<{count:number}>(`SELECT count(*)::int AS count
      FROM ccl_knowledge_heads h JOIN ccl_knowledge_revisions r
        ON r.project_id=h.project_id AND r.object_id=h.object_id AND r.version_id=h.version_id
      WHERE h.project_id=$1 AND r.kind='wiki_page' AND r.published_at IS NOT NULL
        AND r.payload->'binding'->>'spaceId'=$2`,[f.seed.projectId,f.seed.spaceId])).rows[0].count;
    assert.equal(total,expected);assert.equal(all.size,total);
    for(const id of all){
      const item=await tasks.get(f.context,id);assert.ok(item);
      assert.equal(item.request.kind,'relation_check');
      assert.equal(item.request.subjectRef?.domain,'knowledge');
      assert.equal(item.request.subjectRef?.contentDigest,null);
      assert.deepEqual(item.request.sourceEventIds,[]);
      assert.equal(item.trigger.stream,'periodic');assert.equal(item.trigger.sequence,0);
      assert.equal(item.trigger.sourceEventId,null);
      assert.deepEqual(item.trigger.ref,item.request.subjectRef);
      assert.ok(item.trigger.eventKey.includes(item.request.subjectRef!.versionId));
      assert.ok(!item.request.reason.includes('合成'));
    }
    const otherPurpose={...f.context,purpose:'alternate',principal:{...f.context.principal,
      purposes:[...f.context.principal.purposes,'alternate']}};
    const skipped=await sweep.runPass(otherPurpose,request('purpose-isolation',0,1,100));
    assert.equal(skipped.complete,true);assert.equal(skipped.taskCount,0);
    assert.equal(skipped.skipped,expected);
    assert.ok(skipped.omittedReasons.includes('head_not_reviewed_for_requested_purpose'));
    assert.equal(await sweep.get(otherPurpose,ownedPassId),null);
    assert.equal(await sweep.get({...f.context,principal:{...f.context.principal,
      clientInstallationId:'different-installation'}},ownedPassId),null);
    assert.equal(await sweep.get({...f.context,principal:{...f.context.principal,
      id:'different-principal'}},ownedPassId),null);
    await assert.rejects(sweep.runPass({...f.context,scope:{...f.context.scope,spaceId:'forbidden'}},
      request('forbidden')),hasCode('SEMANTIC_SWEEP_SCOPE_FORBIDDEN'));
  }finally{await f.close();}
});

dbTest('semantic sweep caps a cycle, serializes concurrent pages and rolls back task plus cursor',{timeout:120_000},async()=>{
  const f=await setup();
  try{
    const sweep=createPgSemanticSweep(f.pool,f.seed.writerGrant);
    await f.pool.query(`CREATE FUNCTION semantic_fail_task() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic task failure'; END $$;
      CREATE TRIGGER semantic_fail_task BEFORE INSERT ON ccl_knowledge_maintenance_tasks
      FOR EACH ROW EXECUTE FUNCTION semantic_fail_task()`);
    await assert.rejects(sweep.runPass(f.context,request('crash',0,1,2,3)));
    assert.equal((await f.pool.query<{n:number}>('SELECT count(*)::int n FROM ccl_knowledge_semantic_sweeps')).rows[0].n,0);
    assert.equal((await f.pool.query<{n:number}>('SELECT count(*)::int n FROM ccl_knowledge_maintenance_tasks')).rows[0].n,0);
    await f.pool.query('DROP TRIGGER semantic_fail_task ON ccl_knowledge_maintenance_tasks');
    const input=request('crash',0,1,2,3);
    const [a,b]=await Promise.all([sweep.runPass(f.context,input),sweep.runPass(f.context,input)]);
    assert.equal(a.id,b.id);
    const capped=await sweep.runPass(f.context,input);
    assert.equal(capped.taskCount,3);assert.equal(capped.limitReached,true);assert.equal(capped.complete,false);
    const unchanged=await sweep.runPass(f.context,{...input,limit:100});
    assert.equal(unchanged.updatedAt,capped.updatedAt);
    assert.equal(unchanged.scanned,capped.scanned);
    assert.equal((await f.pool.query<{n:number}>('SELECT count(*)::int n FROM ccl_knowledge_maintenance_tasks')).rows[0].n,3);
    assert.ok(capped.omittedReasons.some(reason=>reason.includes('remaining_heads_unscanned')));
    const upgraded=await sweep.runPass(f.context,{...input,cycleKey:'fresh-cycle',rubricVersion:'rubric/2',maxTasksPerShard:1});
    assert.equal(upgraded.taskCount,1,'a new policy has an independent cycle and task identity');
  }finally{await f.close();}
});

dbTest('semantic sweep fences revoked writers and reports lost commit acknowledgement',{timeout:120_000},async()=>{
  const f=await setup();
  try{
    let failCommit=true;
    const lost={connect:async()=>{
      const client=await f.pool.connect();
      return new Proxy(client,{get(target,property){
        if(property==='release')return target.release.bind(target);
        if(property!=='query')return Reflect.get(target,property);
        return async(...args:unknown[])=>{
          const result=await Reflect.apply(target.query,target,args);
          if(String(args[0])==='COMMIT'&&failCommit){failCommit=false;throw new Error('synthetic lost ack');}
          return result;
        };
      }});
    },query:f.pool.query.bind(f.pool)} as unknown as pg.Pool;
    let unknown:unknown;
    try{await createPgSemanticSweep(lost,f.seed.writerGrant).runPass(f.context,request('lost-ack',0,1,1));}
    catch(error){unknown=error;}
    assert.ok(unknown&&typeof unknown==='object'&&'commitStatus' in unknown&&unknown.commitStatus==='unknown');
    assert.ok('operationId' in unknown&&typeof unknown.operationId==='string');
    const id=unknown.operationId;
    const pass=await createPgSemanticSweep(f.pool,f.seed.writerGrant).get(f.context,id);
    assert.equal(pass?.taskCount,1);
    assert.equal((await createPgSemanticSweep(f.pool,f.seed.writerGrant).runPass(f.context,request('lost-ack',0,1,1))).id,id);
    await rotateKnowledgeWriterAuthority(f.pool,f.seed.projectId,f.seed.writerGrant.generation,
      {ownerId:'locked-synthetic-writer',mode:'read_only'},f.seed.writerGrant);
    await assert.rejects(createPgSemanticSweep(f.pool,f.seed.writerGrant).runPass(f.context,request('blocked')),
      hasCode('KNOWLEDGE_WRITER_REVOKED'));
  }finally{await f.close();}
});
