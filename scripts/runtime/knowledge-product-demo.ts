import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {Pool} from 'pg';
import {readTestDatabase} from './test-database.mjs';
import {seedKnowledgeSyntheticFixture} from './knowledge-synthetic-fixture.ts';
import {createKnowledgeApi} from '../../apps/knowledge-api/src/index.ts';
import {createKnowledgeWorker} from '../../apps/knowledge-worker/src/index.ts';
// A new disposable schema per invocation, never the normal business schema or DATABASE_URL.
const connectionString=readTestDatabase({TEST_DATABASE_URL:process.env.KNOWLEDGE_DEMO_DATABASE_URL,TEST_DATABASE_REQUIRED:'1'},{required:true});
const admin=new Pool({connectionString}),schema=`ccl_knowledge_demo_${randomUUID().replaceAll('-','')}`;
await admin.query(`CREATE SCHEMA "${schema}"`);
const pool=new Pool({connectionString,max:12,options:`-c search_path=${schema}`});
const output=resolve('local/knowledge-product/demo');await mkdir(output,{recursive:true});
let server:import('node:http').Server|undefined;let stopped=false;let interval:ReturnType<typeof setInterval>|undefined;
async function cleanup(){if(stopped)return;stopped=true;if(interval)clearInterval(interval);
 await new Promise<void>(done=>server?.close(()=>done())??done());await pool.end();
 await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();
 await writeFile(resolve(output,'status.json'),JSON.stringify({status:'stopped',schemaDropped:true},null,2)+'\n');}
try{
 const fixture=await seedKnowledgeSyntheticFixture(pool);
 const token=`synthetic-local-${randomUUID()}-${randomUUID()}`;
 const api=await createKnowledgeApi({pool,token,principal:fixture.principal,writerGrant:fixture.writerGrant,enableSyntheticResearch:true,syntheticFixture:true,feedbackSourceRightsPolicyRef:'synthetic-local-only',
  capabilities:fixture.authorization,port:Number(process.env.KNOWLEDGE_API_PORT??4311)});
 server=await api.listen();
 const worker=await createKnowledgeWorker({pool,projectId:fixture.projectId,writerGrant:fixture.writerGrant});
 let busy=false;interval=setInterval(()=>{if(busy||stopped)return;busy=true;void worker.runOne().catch(error=>console.error('Synthetic worker failed:',error instanceof Error?error.message:'unknown')).finally(()=>{busy=false;});},500);
 await writeFile(resolve(output,'connection.json'),JSON.stringify({baseUrl:'http://127.0.0.1:4311',projectId:fixture.projectId,spaceId:fixture.spaceId,purpose:'exploration_reading',token},null,2)+'\n',{mode:0o600});
 await writeFile(resolve(output,'status.json'),JSON.stringify({status:'running',owner:'knowledge-product-demo',pid:process.pid,schema,apiPort:Number(process.env.KNOWLEDGE_API_PORT??4311),synthetic:true},null,2)+'\n');
 process.stdout.write(`Synthetic knowledge demo ready at loopback:${process.env.KNOWLEDGE_API_PORT??4311}; connection details in local/knowledge-product/demo/connection.json. All data is synthetic; no paid model.\n`);
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void cleanup().then(()=>process.exit(0)));
}catch(error){await cleanup();throw error;}
