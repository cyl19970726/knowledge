import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {seedKnowledgeSyntheticFixture} from '../../../scripts/runtime/knowledge-synthetic-fixture.ts';
import {createKnowledgeWorker} from '../../knowledge-worker/src/index.ts';
import type {CapabilityContext,MaintenanceProcessor} from '@commerce/knowledge-application';

const databaseUrl=readTestDatabase(),dbTest=databaseUrl?test:test.skip;
dbTest('explicit periodic worker resumes bounded shards and becomes idle without redispatching old tasks',{timeout:60_000},async()=>{
 const admin=new pg.Pool({connectionString:databaseUrl!,max:2}),schema=`periodic_worker_${randomUUID().replaceAll('-','')}`;
 await admin.query(`CREATE SCHEMA "${schema}"`);const pool=new pg.Pool({connectionString:databaseUrl!,max:8,options:`-c search_path=${schema}`});
 try{
  const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-worker-${randomUUID()}`),purpose='exploration_reading';
  const context:CapabilityContext={scope:{projectId:seed.projectId,spaceId:seed.spaceId},purpose,principal:seed.principal,
   authorization:{...seed.authorization,actions:['maintenance:read','maintenance:write']}};
  const calls:string[]=[];const processor:MaintenanceProcessor={execution:'local_deterministic',kinds:['relation_check'],async process(_context,task){
   calls.push(task.id);assert.equal(task.trigger.stream,'periodic');assert.equal(task.request.subjectRef?.domain,'knowledge');
   return {state:'needs_evidence',findingIds:[],compilationId:null,judgmentId:null,reason:'Synthetic processor only; semantic judgment not exercised here',
    cost:{modelCalls:{state:'known',value:0},tokens:{state:'known',value:0},money:{state:'known',amount:0,currency:'USD',source:'synthetic_no_model'}}};}};
  const config={pool,projectId:seed.projectId,writerGrant:seed.writerGrant,enableResearch:false,
   maintenance:{context,methodVersion:'worker-periodic/1',rubricVersion:'relations/1',processor,
    semanticSweep:{cyclePrefix:'bounded-worker',shardCount:2,limit:1,maxTasksPerShard:2}}};
  const worker=await createKnowledgeWorker(config);let idle=false;
  for(let i=0;i<40;i++){if(!await worker.runOne()){idle=true;break;}}
  assert.equal(idle,true,'complete or limited shards must not busy-loop');assert.equal(calls.length,4);
  assert.equal(new Set(calls).size,4,'one processor invocation per sweep task');
  const passes=(await pool.query<{limit_reached:boolean;complete:boolean;task_count:number;updated_at:Date}>(
   'SELECT limit_reached,complete,task_count,updated_at FROM ccl_knowledge_semantic_sweeps ORDER BY shard')).rows;
  assert.equal(passes.length,2);assert.ok(passes.every(p=>p.limit_reached&&!p.complete&&p.task_count===2));
  assert.equal((await pool.query<{n:number}>(`SELECT count(*)::int n FROM ccl_knowledge_maintenance_tasks
    WHERE trigger->>'stream'='knowledge' AND request->>'kind'='relation_check'`)).rows[0].n,0,
  'publication creates no duplicate relation checks');
  const publishedRefs=(await pool.query<{n:number}>(`SELECT COALESCE(sum(jsonb_array_length(data->'refs')),0)::int n
    FROM ccl_knowledge_events WHERE project_id=$1 AND kind='KnowledgePublished'`,[seed.projectId])).rows[0].n;
  assert.equal(publishedRefs,33,'32 original revisions plus one replacement are published events');
  assert.equal((await pool.query<{n:number}>(`SELECT count(*)::int n FROM ccl_knowledge_maintenance_event_receipts
    WHERE stream='knowledge' AND skip_reason='published_ref_deferred_to_semantic_sweep'`)).rows[0].n,publishedRefs,
  'every published version has a skip receipt, including the superseded historical version');
  const restarted=await createKnowledgeWorker(config);
  for(let i=0;i<8;i++)await restarted.runOne();assert.equal(await restarted.runOne(),false);
  assert.equal(calls.length,4,'restart reads persistent progress instead of creating or executing duplicate tasks');
  const later=(await pool.query<{updated_at:Date}>('SELECT updated_at FROM ccl_knowledge_semantic_sweeps ORDER BY shard')).rows;
  assert.deepEqual(later.map(p=>p.updated_at.toISOString()),passes.map(p=>p.updated_at.toISOString()));
  await assert.rejects(createKnowledgeWorker({...config,maintenance:{...config.maintenance,processor:undefined}}),/explicit relation processor/);
 }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
