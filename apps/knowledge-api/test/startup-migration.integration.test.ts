import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {resolve} from 'node:path';
import pg from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {migrateKnowledge} from '../../../packages/knowledge/src/migrations.ts';
import {createKnowledgeStore} from '../../../packages/knowledge/src/store.ts';
import {digest} from '../../../packages/knowledge/src/utils.ts';
import type {KnowledgeRevision,KnowledgeChangeSet} from '../../../packages/knowledge/src/types.ts';
import {createKnowledgeClient} from '../../../packages/knowledge-client/src/index.ts';
import {createKnowledgeApi} from '../src/index.ts';

const url=readTestDatabase(),dbTest=url?test:test.skip;
async function isolated(run:(pool:pg.Pool,schemaUrl:string)=>Promise<void>){
 const admin=new pg.Pool({connectionString:url!,max:2}),schema=`ccl_knowledge_startup_${randomUUID().replaceAll('-','')}`;
 await admin.query(`CREATE SCHEMA "${schema}"`);const schemaUrl=new URL(url!);schemaUrl.searchParams.set('options',`-c search_path=${schema}`);
 const pool=new pg.Pool({connectionString:schemaUrl.toString(),max:8});
 try{await run(pool,schemaUrl.toString());}finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
}
function config(pool:pg.Pool,projectId:string,spaceId:string){return {pool,port:0,token:`synthetic-startup-${randomUUID()}`,
 principal:{id:'synthetic-read-only',clientInstallationId:'startup-test',projectId,spaceIds:[spaceId],purposes:['exploration_reading']}};}
async function listen(settings:ReturnType<typeof config>){
 const api=await createKnowledgeApi(settings),server=await api.listen(),address=server.address();assert.ok(address&&typeof address!=='string');
 const baseUrl=`http://127.0.0.1:${address.port}`,scope={projectId:settings.principal.projectId,spaceId:settings.principal.spaceIds[0]};
 return {server,api,baseUrl,client:createKnowledgeClient({baseUrl,scope,headers:{Authorization:`Bearer ${settings.token}`}})};
}
async function stop(child:ChildProcess){if(child.exitCode!==null)return;child.kill('SIGTERM');
 const timeout=new Promise<void>(done=>setTimeout(done,3000).unref());await Promise.race([once(child,'exit'),timeout]);
 if(child.exitCode===null){child.kill('SIGKILL');await once(child,'exit');}}
async function ledger(pool:pg.Pool){
 const tables=['projects','changesets','revisions','heads','reviews','publications','deps','invalidities','events'] as const;
 const result:Record<string,unknown>={};for(const table of tables)result[table]=(await pool.query(`SELECT to_jsonb(r) AS row FROM ccl_knowledge_${table} r ORDER BY to_jsonb(r)::text`)).rows;
 return result;
}

dbTest('standalone read-only API initializes an empty schema without activating a writer',async()=>isolated(async pool=>{
 assert.equal((await pool.query("SELECT to_regprocedure('ccl_assert_knowledge_writer()') AS writer")).rows[0].writer,null);
 const settings=config(pool,`synthetic-${randomUUID()}`,'empty-space'),running=await listen(settings);
 try{
  assert.equal((await running.client.capabilities()).data.mode,'read_only');
  assert.deepEqual((await running.client.catalog({purpose:'exploration_reading',limit:10})).data.items,[]);
  assert.ok((await pool.query("SELECT to_regprocedure('ccl_assert_knowledge_writer()') AS writer")).rows[0].writer);
  assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_writer_authority')).rows[0].n,0);
  const denied=await fetch(`${running.baseUrl}/api/v1/projects/${settings.principal.projectId}/spaces/empty-space/knowledge/sources`,{
   method:'POST',headers:{Authorization:`Bearer ${settings.token}`,'Content-Type':'application/json'},body:'{}'});
  assert.equal(denied.status,503);assert.equal((await denied.json()).code,'WRITES_DISABLED');
  assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_revisions')).rows[0].n,0);
  const second=await listen(settings);try{assert.equal((await second.client.capabilities()).data.mode,'read_only');}
  finally{await new Promise<void>(done=>second.server.close(()=>done()));}
  assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_writer_authority')).rows[0].n,0);
 }finally{await new Promise<void>(done=>running.server.close(()=>done()));}
}));

dbTest('old schema missing writer support starts read-only and preserves the complete existing knowledge ledger',async()=>isolated(async pool=>{
 await migrateKnowledge(pool);const projectId=`synthetic-legacy-${randomUUID()}`,spaceId='legacy:video-research',ref={objectId:randomUUID(),versionId:randomUUID()};
 const revision:KnowledgeRevision={kind:'pattern',projectId,ref,title:'Synthetic old published pattern',body:'A synthetic historical record, never business evidence.',
  scope:{applicability:{productVersionRefs:[],markets:[],languages:[],audiences:[],goals:[],requiredProduction:[],transferRationale:null},limitations:[],unknowns:[],reviewDueAt:null},
  dependencies:[],sourceGroups:[],artifactRef:null,createdAt:'2020-01-01T00:00:00.000Z',analysisQuality:null,
  content:{ref,projectId,title:'Synthetic old published pattern',problem:'test',mechanism:'test',sequence:[],requiredElements:[],variableSlots:[],applicability:[],exclusions:[],supportRefs:[],counterexampleRefs:[],prediction:'test',evidenceLevel:'inconclusive',citations:[]}};
 const change:KnowledgeChangeSet={id:randomUUID(),projectId,requestKey:randomUUID(),requestHash:digest(revision),contentHash:digest(revision),purpose:'exploration_reading',proposer:'synthetic-old-builder',rationale:'Synthetic old schema fixture',methodVersion:'test-v1',cost:{state:'unknown',reason:'No real model'},baseHeads:[{objectId:ref.objectId,versionId:null}],inputManifest:[],changes:[{revision,effect:'create',explanation:'Synthetic fixture'}],createdAt:revision.createdAt};
 const store=createKnowledgeStore(pool);await store.stage(change);await store.recordReview({id:randomUUID(),projectId,changeSetId:change.id,contentHash:change.contentHash,reviewer:'independent-synthetic-reviewer',policyVersion:'test-v1',purpose:'exploration_reading',decision:'exploration_only',rationale:'Engineering fixture',createdAt:revision.createdAt});
 const publication=await store.publish(projectId,change.id,change.contentHash);
 // Simulate an actual pre-writer migration state, retaining the published ledger rather than using the demo seeder.
 await pool.query('DROP FUNCTION ccl_assert_knowledge_writer() CASCADE; DROP TABLE ccl_knowledge_writer_authority');
 const before=await ledger(pool);assert.equal((await pool.query("SELECT to_regprocedure('ccl_assert_knowledge_writer()') AS writer")).rows[0].writer,null);
 const running=await listen(config(pool,projectId,spaceId));try{
  assert.deepEqual(await ledger(pool),before,'startup DDL must not rewrite revisions, heads, reviews, publication time, hashes, keys or epochs');
  const catalog=await running.client.catalog({purpose:'exploration_reading',limit:10});assert.equal(catalog.data.items.length,1);assert.equal(catalog.data.items[0].ref.contentDigest,digest(revision));
  assert.equal((await running.client.document(catalog.data.items[0].ref,'exploration_reading')).data.body,revision.body);
  assert.equal((await running.client.history({objectId:ref.objectId,purpose:'exploration_reading',limit:10})).data.versions[0].publishedAt,publication.publishedAt);
  assert.deepEqual(await ledger(pool),before);assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_writer_authority')).rows[0].n,0);
 }finally{await new Promise<void>(done=>running.server.close(()=>done()));}
}));

dbTest('built independent API CLI starts against an untouched empty schema', {timeout:30_000},async()=>isolated(async(pool,schemaUrl)=>{
 const projectId=`synthetic-cli-${randomUUID()}`,token=`synthetic-${randomUUID()}`;
 const child=spawn(process.execPath,[resolve(import.meta.dirname,'../dist/index.js')],{cwd:resolve(import.meta.dirname,'../../..'),
  env:{...process.env,KNOWLEDGE_DATABASE_URL:schemaUrl,KNOWLEDGE_API_PROJECT_ID:projectId,KNOWLEDGE_API_TOKEN:token,KNOWLEDGE_API_SPACE_IDS:'empty-cli',KNOWLEDGE_API_PORT:'0',KNOWLEDGE_SYNTHETIC_WRITES:undefined,KNOWLEDGE_WRITER_GRANT_JSON:undefined},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',chunk=>{output+=String(chunk);});child.stderr.on('data',chunk=>{output+=String(chunk);});
 try{
  let port:number|null=null;for(let i=0;i<80&&!port;i++){
   const match=/Knowledge API listening on (\{[^\n]+\})/.exec(output);if(match)port=JSON.parse(match[1]).port;
   if(child.exitCode!==null)throw new Error(`Read-only CLI exited before initialization: ${output}`);
   if(!port)await new Promise(done=>setTimeout(done,50));
  }
  assert.ok(port,`Read-only CLI must listen without a seed/migration helper: ${output}`);
  const client=createKnowledgeClient({baseUrl:`http://127.0.0.1:${port}`,scope:{projectId,spaceId:'empty-cli'},headers:{Authorization:`Bearer ${token}`}});
  assert.equal((await client.capabilities()).data.mode,'read_only');assert.deepEqual((await client.catalog({purpose:'exploration_reading',limit:10})).data.items,[]);
  assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_writer_authority')).rows[0].n,0);
 }finally{await stop(child);}
}));
