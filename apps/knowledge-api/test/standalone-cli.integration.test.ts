import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {resolve} from 'node:path';
import pg from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {seedKnowledgeSyntheticFixture} from '../../../scripts/runtime/knowledge-synthetic-fixture.ts';
import {createKnowledgeClient} from '../../../packages/knowledge-client/src/index.ts';

const url=readTestDatabase(),dbTest=url?test:test.skip;
const root=resolve(import.meta.dirname,'../../..');
function start(path:string,env:NodeJS.ProcessEnv){const child=spawn(process.execPath,[resolve(root,path)],{cwd:root,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout?.on('data',chunk=>{output+=String(chunk);});child.stderr?.on('data',chunk=>{output+=String(chunk);});
  return {child,output:()=>output};}
async function stop(child:ChildProcess|undefined){if(!child||child.exitCode!==null)return;child.kill('SIGTERM');
  await Promise.race([once(child,'exit'),new Promise(resolve=>setTimeout(resolve,3000))]);if(child.exitCode===null)child.kill('SIGKILL');}

dbTest('built knowledge API and worker start as separate processes without business runtime configuration', {timeout:90_000},async()=>{
  const admin=new pg.Pool({connectionString:url!,max:2}),schema=`ccl_knowledge_cli_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const schemaUrl=new URL(url!);schemaUrl.searchParams.set('options',`-c search_path=${schema}`);
  const pool=new pg.Pool({connectionString:schemaUrl.toString(),max:8});
  let api:ChildProcess|undefined,worker:ChildProcess|undefined;
  try{
    const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-${randomUUID()}`),token=`test-${randomUUID()}-${randomUUID()}`;
    const common={KNOWLEDGE_DATABASE_URL:schemaUrl.toString(),KNOWLEDGE_API_PROJECT_ID:seed.projectId,
      KNOWLEDGE_SYNTHETIC_WRITES:'1',KNOWLEDGE_WRITER_GRANT_JSON:JSON.stringify(seed.writerGrant)};
    const apiRun=start('apps/knowledge-api/dist/index.js',{...common,KNOWLEDGE_API_TOKEN:token,KNOWLEDGE_API_SPACE_IDS:seed.spaceId,
      KNOWLEDGE_API_ACTIONS:'research:write',KNOWLEDGE_API_PORT:'0',KNOWLEDGE_SYNTHETIC_FIXTURE:'1'});api=apiRun.child;
    let port:number|null=null;
    for(let i=0;i<80&&!port;i++){const match=/Knowledge API listening on (\{[^\n]+\})/.exec(apiRun.output());
      if(match)port=JSON.parse(match[1]).port as number;
      if(api.exitCode!==null)throw new Error(`Standalone API exited: ${apiRun.output()}`);
      if(!port)await new Promise(resolve=>setTimeout(resolve,50));}
    assert.ok(port,`Standalone API did not report a listening port: ${apiRun.output()}`);
    const client=createKnowledgeClient({baseUrl:`http://127.0.0.1:${port}`,scope:{projectId:seed.projectId,spaceId:seed.spaceId},
      headers:{Authorization:`Bearer ${token}`}});
    const caps=await client.capabilities();assert.equal(caps.data.permittedActions.includes('research'),true);
    assert.ok(caps.warnings.includes('synthetic_engineering_fixture'));
    const queued=await client.research({question:'Synthetic separate process question',purpose:'exploration_reading',sourceRefs:[],knowledgeRefs:[],
      baseHeads:[],budget:{maxModelCalls:0,maxReadBytes:0,deadline:new Date(Date.now()+60_000).toISOString(),maxMoney:null},allowExternalAcquisition:false},
      {idempotencyKey:randomUUID()});
    const workerRun=start('apps/knowledge-worker/dist/index.js',common);worker=workerRun.child;
    let finalState='queued';for(let i=0;i<200&&['queued','running'].includes(finalState);i++){
      if(worker.exitCode!==null)throw new Error(`Standalone worker exited: ${workerRun.output()}`);
      finalState=(await client.researchOperation(queued.data.id)).data.state;
      if(['queued','running'].includes(finalState))await new Promise(resolve=>setTimeout(resolve,50));}
    assert.equal(finalState,'waiting_for_review');
    assert.equal((await client.researchResult(queued.data.id)).data.cognitiveOutcome,'needs_evidence');
  }finally{await stop(worker);await stop(api);await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
