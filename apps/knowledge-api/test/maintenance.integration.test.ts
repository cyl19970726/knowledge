import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import type {Server} from 'node:http';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {seedKnowledgeSyntheticFixture} from '../../../scripts/runtime/knowledge-synthetic-fixture.ts';
import {createKnowledgeApi} from '../src/index.ts';
import {createKnowledgeClient} from '../../../packages/knowledge-client/src/index.ts';
import {createKnowledgeWorker} from '../../knowledge-worker/src/index.ts';
import type {CapabilityContext} from '../../../packages/knowledge-application/src/sources.ts';
const url=readTestDatabase(),dbTest=url?test:test.skip;
const zero={modelCalls:{state:'known' as const,value:0},tokens:{state:'known' as const,value:0},money:{state:'known' as const,amount:0,currency:'USD',source:'synthetic-local-fixture'}};
dbTest('source events reach independent durable maintenance tasks; worker and sharded lint retain coverage without rewriting knowledge',{timeout:90_000},async()=>{
 const admin=new pg.Pool({connectionString:url!,max:2}),schema=`maintenance_api_${randomUUID().replaceAll('-','')}`;
 await admin.query(`CREATE SCHEMA "${schema}"`);const pool=new pg.Pool({connectionString:url!,max:10,options:`-c search_path=${schema}`});let server:Server|undefined;
 try{
  const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-maintenance-${randomUUID()}`),purpose='exploration_reading',scope={projectId:seed.projectId,spaceId:seed.spaceId};
  const auth={...seed.authorization,adapterIds:[...seed.authorization.adapterIds,'synthetic-maintenance'],actions:[...seed.authorization.actions,'maintenance:read','maintenance:write','ingest:read','ingest:write']};
  const context:CapabilityContext={scope,purpose,principal:seed.principal,authorization:auth},token=`synthetic-${randomUUID()}-${randomUUID()}`;
  const api=await createKnowledgeApi({pool,token,port:0,principal:seed.principal,writerGrant:seed.writerGrant,enableMaintenance:true,enableSourceIngest:true,capabilities:auth});
  server=await api.listen();const address=server.address();assert.ok(address&&typeof address!=='string');const client=createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope,headers:{Authorization:`Bearer ${token}`}});
  const coreSnapshot=async()=>({pubs:(await pool.query('SELECT count(*)::int n FROM ccl_knowledge_publications')).rows[0].n,heads:(await pool.query('SELECT object_id,version_id FROM ccl_knowledge_heads ORDER BY object_id')).rows});const before=await coreSnapshot();
  async function arrival(key:string,sequence:number){return (await client.registerSourceEvent({adapterId:'synthetic-maintenance',eventKey:key,producerSequence:sequence,occurredAt:new Date().toISOString(),purpose,sourceRef:{...seed.source.ref,domain:'source',contentDigest:seed.source.ref.contentDigest!}},{idempotencyKey:key,purpose})).data;}
  const first=await arrival('source-arrival-one',1);
  const collected=(await client.collectMaintenance({purpose,methodVersion:'maintenance-fixture/1',rubricVersion:'relations-fixture/1',limit:500},{idempotencyKey:'collect-one',purpose})).data;assert.ok(collected.taskIds.length>0);
  const list=(await client.maintenanceTasks(purpose,{limit:100})).data;const task=list.items.find(item=>item.request.kind==='source_research'&&item.request.sourceEventIds.includes(first.id));assert.ok(task);assert.equal(task.state,'queued');
  const total=(await pool.query('SELECT count(*)::int n FROM ccl_knowledge_maintenance_tasks')).rows[0].n;
  await client.collectMaintenance({purpose,methodVersion:'maintenance-fixture/1',rubricVersion:'relations-fixture/1',limit:500},{idempotencyKey:'collect-repeat',purpose});
  assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_maintenance_tasks')).rows[0].n,total);
  const initialProjection=(await client.searchProjectionStatus(purpose)).data;assert.ok(!initialProjection?.ready);
  let projection=(await client.rebuildSearchProjection({purpose,limit:1,restart:false},{idempotencyKey:'projection-progress',purpose})).data;
  for(let round=0;round<50&&!projection.complete;round++)projection=(await client.rebuildSearchProjection({purpose,limit:1,restart:false},{idempotencyKey:'projection-progress',purpose})).data;
  assert.equal(projection.ready,true,JSON.stringify(projection));assert.equal((await client.searchProjectionStatus(purpose)).data?.ready,true);
  await assert.rejects(client.rebuildSearchProjection({purpose:'ungranted-purpose',limit:1,restart:false},{idempotencyKey:'projection-foreign-purpose',purpose:'ungranted-purpose'}));
  let processed=0;const worker=await createKnowledgeWorker({pool,projectId:seed.projectId,writerGrant:seed.writerGrant,enableResearch:false,
   maintenance:{context,methodVersion:'maintenance-fixture/1',rubricVersion:'relations-fixture/1',searchProjection:{limit:1},lint:{cyclePrefix:'integration',shardCount:2,limit:100},
    processor:{execution:'local_deterministic',kinds:['source_research'],async process(_context,claimed){processed++;assert.equal(claimed.request.sourceEventIds[0],first.id);
     return {state:'no_change',findingIds:[],compilationId:null,judgmentId:null,reason:'Synthetic deterministic task result, not a semantic no-change approval',cost:zero};}}}});
  await worker.runOne();assert.equal(processed,1);assert.equal((await client.maintenanceTask(task.id,purpose)).data.state,'no_change');
  // Completed shard passes must not make an idle worker report work forever.
  for(let round=0;round<4;round++)await worker.runOne();assert.equal(await worker.runOne(),false);
  const second=await arrival('source-arrival-two',2);await client.collectMaintenance({purpose,methodVersion:'maintenance-fixture/1',rubricVersion:'relations-fixture/1',limit:500},{idempotencyKey:'collect-new-arrival',purpose});
  const newTask=(await client.maintenanceTasks(purpose,{limit:100})).data.items.find(item=>item.request.sourceEventIds.includes(second.id));assert.ok(newTask);assert.notEqual(newTask.id,task.id,'old no_change never acknowledges a later event');
  await client.cancelMaintenance(newTask.id,purpose,{idempotencyKey:'cancel-queued',purpose});assert.equal((await client.maintenanceTask(newTask.id,purpose)).data.state,'cancelled');
  const oldCount=(await pool.query('SELECT count(*)::int n FROM ccl_knowledge_maintenance_tasks')).rows[0].n;
  await client.collectMaintenance({purpose,methodVersion:'maintenance-fixture/1',rubricVersion:'relations-fixture/2',limit:500},{idempotencyKey:'collect-new-rubric',purpose});assert.ok((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_maintenance_tasks')).rows[0].n>oldCount,'policy upgrade has an independent replay watermark');
  const pass=await client.lintWiki({purpose,cycleKey:'manual-structural-check',shard:0,shardCount:1,limit:100,methodVersion:'lint-fixture/1'},{idempotencyKey:'lint-one',purpose});assert.equal(pass.data.complete,true);assert.ok(pass.data.scanned>0);assert.equal(pass.data.consistency,'incremental_current_heads');
  const findings=await client.maintenanceFindings(purpose,{limit:100});assert.ok(findings.data.items.every(item=>item.subjectRef.projectId===seed.projectId));
  assert.deepEqual(await coreSnapshot(),before,'maintenance findings/tasks do not rewrite current knowledge');
 }finally{if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});

dbTest('maintenance-only worker initializes an empty schema without activating writer authority',async()=>{
 const admin=new pg.Pool({connectionString:url!,max:2}),schema=`maintenance_empty_${randomUUID().replaceAll('-','')}`;
 await admin.query(`CREATE SCHEMA "${schema}"`);const pool=new pg.Pool({connectionString:url!,max:4,options:`-c search_path=${schema}`});
 try{
  const projectId=`synthetic-empty-${randomUUID()}`,context:CapabilityContext={scope:{projectId,spaceId:'space'},purpose:'exploration_reading',principal:{id:'synthetic',projectId,spaceIds:['space'],purposes:['exploration_reading'],clientInstallationId:'synthetic'},authorization:{actions:['maintenance:read','maintenance:write'],adapterIds:[],rightsPolicyIds:[]}};
  const worker=await createKnowledgeWorker({pool,projectId,writerGrant:{ownerId:'synthetic',generation:1,token:`synthetic-${randomUUID()}`},enableResearch:false,maintenance:{context,methodVersion:'empty/1',rubricVersion:'empty/1',lint:{cyclePrefix:'empty',shardCount:1,limit:1}}});
  assert.ok((await pool.query("SELECT to_regclass('ccl_knowledge_maintenance_tasks') AS name")).rows[0].name);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM ccl_knowledge_writer_authority')).rows[0].n,0,'migrations do not activate a writer');
  await assert.rejects(worker.runOne(),/writer|project|authority/i);
 }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
