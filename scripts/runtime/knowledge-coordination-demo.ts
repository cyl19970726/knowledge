/** Disposable, loopback-only browser QA fixture. No model or business source is contacted. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {rename,stat,unlink,writeFile} from 'node:fs/promises';
import {createServer,type Server} from 'node:http';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import express from 'express';
import pg from 'pg';
import {readTestDatabase} from './test-database.mjs';
import {seedKnowledgeSyntheticFixture} from './knowledge-synthetic-fixture.ts';
import {createSyntheticQueryAnswerer} from './knowledge-synthetic-answerer.ts';
import {createKnowledgeApi} from '../../apps/knowledge-api/src/index.ts';
import {createKnowledgeClient} from '../../packages/knowledge-client/src/index.ts';
import {createPgMaintenanceTasks} from '../../packages/adapters/knowledge-service/src/maintenance-tasks.ts';
import {assertKnowledgeWriterAuthority} from '../../packages/knowledge/src/writer-authority.ts';
import type {CapabilityContext,DecisionProvider,SourcePlanner,WikiCompiler} from '@commerce/knowledge-application';
import type {KnowledgeRef,MaintenanceTask} from '@commerce/knowledge-contracts';

const MAX_LIFETIME_MS=5*60_000;
const READY_FILE='/tmp/wiki-coordination-demo.json';
const zero={modelCalls:{state:'known' as const,value:0},tokens:{state:'known' as const,value:0},
  money:{state:'known' as const,amount:0,currency:'USD',source:'synthetic_no_model'}};
const testEnvironment={TEST_DATABASE_URL:process.env.TEST_DATABASE_URL,TEST_DATABASE_REQUIRED:process.env.TEST_DATABASE_REQUIRED};
if(testEnvironment.TEST_DATABASE_REQUIRED!=='1')throw new Error('TEST_DATABASE_REQUIRED=1 is required');
const connectionString=readTestDatabase(testEnvironment,{required:true})!;
const database=new URL(connectionString);
if(database.hostname!=='127.0.0.1'||database.port!=='59356'||database.pathname!=='/ccl_test_wiki')
  throw new Error('This demo requires the dedicated 127.0.0.1:59356/ccl_test_wiki test database');
const dist=fileURLToPath(new URL('../../apps/knowledge-web/dist/',import.meta.url));
const schema=`wiki_coord_demo_${randomUUID().replaceAll('-','')}`;
const admin=new pg.Pool({connectionString,max:2,connectionTimeoutMillis:5_000,statement_timeout:30_000,query_timeout:35_000});
let pool:pg.Pool|undefined,server:Server|undefined,schemaCreated=false,readyWritten=false,temporaryReadyPath:string|undefined;
let stopRequested=false,stopResolve!:()=>void,stdinBuffer='';
const stopped=new Promise<void>(resolve=>{stopResolve=resolve;});
const requestStop=()=>{stopRequested=true;stopResolve();};
const onStdin=(chunk:string)=>{stdinBuffer+=chunk;let newline=stdinBuffer.indexOf('\n');
  while(newline>=0){const line=stdinBuffer.slice(0,newline).trim();stdinBuffer=stdinBuffer.slice(newline+1);
    if(line==='stop')requestStop();newline=stdinBuffer.indexOf('\n');}};
process.stdin.setEncoding('utf8');process.stdin.on('data',onStdin);process.stdin.resume();
process.once('SIGTERM',requestStop);process.once('SIGINT',requestStop);
const timer=setTimeout(requestStop,MAX_LIFETIME_MS);

async function closeServer(value:Server|undefined){if(!value)return;
  await new Promise<void>((resolve,reject)=>{value.close(error=>error?reject(error):resolve());value.closeAllConnections();});}
async function cleanup(){clearTimeout(timer);process.stdin.off('data',onStdin);process.stdin.pause();
  process.off('SIGTERM',requestStop);process.off('SIGINT',requestStop);
  const errors:unknown[]=[];
  try{await closeServer(server);}catch(error){errors.push(error);}
  try{await pool?.end();}catch(error){errors.push(error);}
  if(schemaCreated)try{await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}catch(error){errors.push(error);}
  try{await admin.end();}catch(error){errors.push(error);}
  if(temporaryReadyPath)try{await unlink(temporaryReadyPath);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')errors.push(error);}
  if(readyWritten)try{await unlink(READY_FILE);}catch(error){errors.push(error);}
  if(errors.length)throw new Error('Synthetic demo cleanup did not complete');
}

async function main(){
  try{
    assert.ok((await stat(dist)).isDirectory(),'Build apps/knowledge-web/dist before starting the demo');
    assert.ok((await stat(join(dist,'index.html'))).isFile(),'Missing built web index');
    await admin.query(`CREATE SCHEMA "${schema}"`);schemaCreated=true;
    pool=new pg.Pool({connectionString,max:12,options:`-c search_path=${schema}`,
      connectionTimeoutMillis:5_000,statement_timeout:30_000,query_timeout:35_000});
    const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-coordination-demo-${randomUUID()}`);
    const {projectId,spaceId}=seed,purpose='exploration_reading',scope={projectId,spaceId};
    const heads=Number((await pool.query<{count:number}>(`SELECT count(*)::int AS count FROM ccl_knowledge_heads WHERE project_id=$1`,[projectId])).rows[0]?.count);
    assert.equal(heads,32,'The browser fixture must contain exactly 32 current Wiki pages');
    const publicationsBefore=Number((await pool.query<{count:number}>(`SELECT count(*)::int AS count FROM ccl_knowledge_publications WHERE project_id=$1`,[projectId])).rows[0]?.count);
    const topic=`霁蓝罗盘${randomUUID().slice(0,8)}`,identity=`synthetic-compass-${randomUUID()}`;
    const sourceText=`纯合成来源：${topic}在固定光线下展示了一个可见标记。该陈述仅供界面与协议测试，未验证真实人群、销量或效果。`;
    const planner:SourcePlanner={id:'synthetic-coordination-planner',version:'1',model:'synthetic-no-model',execution:'local_deterministic',
      async plan(input){const surface=topic,index=input.source.body.indexOf(surface);assert.ok(index>=0,'Exact synthetic topic must be in source body');
        const startByte=Buffer.byteLength(input.source.body.slice(0,index));
        return {proposal:{outcome:'planned',question:`核对${topic}的来源条件`,queries:[topic],
          mentions:[{entityType:'concept',surface,startByte,endByte:startByte+Buffer.byteLength(surface)}],
          reason:'本地合成提案；提及并非身份消歧或事实确认',gaps:['缺少真实来源与真实观察']},
          raw:{synthetic:true,method:'fixed-span'},cost:zero,modelReturned:'synthetic-no-model',requestId:'synthetic-plan'};}};
    const compiler:WikiCompiler={id:'synthetic-coordination-compiler',model:'synthetic-no-model',methodVersion:'coord-demo/1',execution:'local_deterministic',
      async compile(input){const source=input.evidence.find(item=>item.kind==='source_content');
        assert.ok(source,'Only the current source is allowed to support this draft');
        assert.ok(source.body.includes(topic));
        const profile=input.profiles.find(item=>item.id==='concept');assert.ok(profile);
        return {proposal:{outcome:'proposed',drafts:[{targetEvidenceId:null,profile,identityKey:identity,title:topic,
          summary:'仅据本次合成来源提出的待审认识。',conditions:['仅适用于合成固定光线场景'],counterexamples:[],
          unknowns:['真实语义与效果未验证'],nextQuestions:['独立审阅是否接受？'],supportEvidenceIds:[source.id],
          rationale:'只引用本次新登记的来源；不自动发表'}],reason:'合成编纂待独立审阅',gaps:[]},
          cost:zero,modelReturned:'synthetic-no-model',requestId:'synthetic-compile'};}};
    const decision:DecisionProvider={id:'synthetic-coordination-decision',version:'1',model:'synthetic-no-model',execution:'local_deterministic',
      async decide(){throw new Error('Unique demo topic must not require a relation decision');}};
    const reviewerId='synthetic-reviewer',callerId=seed.principal.id;
    const principal={...seed.principal,id:callerId,clientInstallationId:'synthetic-coordination-demo'};
    const authorization={...seed.authorization,adapterIds:[...seed.authorization.adapterIds,'synthetic-coordination-demo'],
      actions:[...seed.authorization.actions,'ingest:read','ingest:write','source-plans:read','source-plans:write',
        'ask:write','compile:read','compile:write','judgments:read','judgments:write','maintenance:read','maintenance:write',
        'review:read','review:request','review:decide']};
    const context:CapabilityContext={scope,purpose,principal,authorization};
    const token=`synthetic-local-${randomUUID()}-${randomUUID()}`;
    const api=await createKnowledgeApi({pool,token,port:0,host:'127.0.0.1',principal,writerGrant:seed.writerGrant,
      syntheticFixture:true,answerer:createSyntheticQueryAnswerer(),enableMaintenance:true,enableSourceIngest:true,sourcePlanner:planner,compiler,decisionProvider:decision,
      sourceReaderIds:[callerId,reviewerId],capabilities:authorization,
      coordinationPolicy:{version:'coord-demo/1',maxPairs:1,maxCandidates:1,queryLimit:1,
        budget:{maxModelCalls:0,maxReadBytes:10_000_000,maxMoney:{amount:0,currency:'USD'},timeoutMs:120_000}}});
    const outer=express();outer.disable('x-powered-by');outer.use(express.static(dist));outer.use(api.app);
    server=createServer(outer);
    await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(0,'127.0.0.1',()=>resolve());});
    const address=server.address();assert.ok(address&&typeof address!=='string');
    const baseUrl=`http://127.0.0.1:${address.port}`;
    const client=createKnowledgeClient({baseUrl,scope,headers:{Authorization:`Bearer ${token}`}});
    const registered=(await client.registerSource({externalIdentity:{adapterId:'synthetic-coordination-demo',externalObjectId:randomUUID(),externalVersion:'1'},
      expectedSourceHead:null,sourceSchemaVersion:'synthetic-note/1',contentDigest:createHash('sha256').update(sourceText).digest('hex'),
      custody:{mode:'managed_copy',text:sourceText},sourceKind:'document',author:null,publisher:null,acquirer:'synthetic-fixture',
      publishedAt:null,obtainedAt:new Date().toISOString(),assertionKind:'source_claim',
      sourceGroups:[{id:`synthetic:${randomUUID()}`,status:'known',authority:'synthetic-original'}],anchors:[],actualCoverage:[],
      limitations:['完全合成，不用于业务判断'],rightsPolicyRef:'synthetic-local-only'},
      {idempotencyKey:randomUUID(),purpose})).data;
    const eventKey=randomUUID();const event=(await client.registerSourceEvent({adapterId:'synthetic-coordination-demo',eventKey,
      producerSequence:1,occurredAt:new Date().toISOString(),purpose,
      sourceRef:{...registered.ref,domain:'source',contentDigest:registered.ref.contentDigest!}},
      {idempotencyKey:eventKey,purpose})).data;
    // One bounded collection page keeps the QA inbox focused on the new source task.
    await client.collectMaintenance({purpose,methodVersion:'coord-demo/1',rubricVersion:'relations-demo/1',limit:1},
      {idempotencyKey:randomUUID(),purpose});
    const page=(await client.maintenanceTasks(purpose,{limit:100})).data;
    const collected=page.items.find(task=>task.request.kind==='source_research'&&task.request.sourceEventIds.includes(event.id));
    assert.ok(collected,'The source event must create a maintenance task');
    const processed=(await client.processMaintenance(purpose,{idempotencyKey:randomUUID(),purpose})).data;
    assert.equal(processed?.id,collected.id);assert.equal(processed.state,'waiting_for_review');
    const run=(await client.coordinationForTask(collected.id,purpose)).data;
    assert.equal(run?.state,'waiting_for_review');assert.ok(run.sourcePlanId&&run.compilationId);
    assert.deepEqual(run.candidateRefs,[]);assert.deepEqual(run.judgmentIds,[]);
    const plan=(await client.sourcePlan(run.sourcePlanId,purpose)).data;
    assert.equal(plan.provenance,'model_proposed');assert.equal(plan.proposal?.mentions[0]?.surface,topic);
    assert.equal(JSON.stringify(plan.raw).includes(sourceText),false,'Planner diagnostics must not echo the full source');
    const compilation=(await client.compilation(run.compilationId,purpose)).data;
    assert.equal(compilation.state,'waiting_for_review');assert.ok(compilation.candidate?.candidateId);
    assert.deepEqual(compilation.drafts[0]?.supportEvidenceIds,[compilation.evidence.find(item=>item.kind==='source_content')?.id]);
    assert.equal(Number((await pool.query<{count:number}>(`SELECT count(*)::int AS count FROM ccl_knowledge_publications WHERE project_id=$1`,[projectId])).rows[0]?.count),
      publicationsBefore,'The coordination demo must not publish its candidate');

    // A separate synthetic manual task records prepared dispatch, then expires through the port's GET reconciliation.
    const tasks=createPgMaintenanceTasks(pool,seed.writerGrant);
    const uncertain=await tasks.enqueue(context,{kind:'lint_page',subjectRef:null,sourceEventIds:[],relatedRefs:[],
      reason:'合成未知提交：原响应待核对',methodVersion:'coord-demo/1',rubricVersion:'relations-demo/1'},
      {stream:'manual',eventKey:`unknown:${randomUUID()}`,sequence:0,ref:null,sourceEventId:null});
    const claimed=await tasks.claim(context,['lint_page'],60_000);
    assert.equal(claimed?.id,uncertain.id);assert.ok(claimed.attemptId);
    await tasks.markDispatch(context,claimed.id,claimed.attemptId,claimed.leaseToken,'dispatch_prepared');
    const writer=await pool.connect();try{await writer.query('BEGIN');await assertKnowledgeWriterAuthority(writer,projectId,seed.writerGrant);
      await writer.query(`UPDATE ccl_knowledge_maintenance_tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,[claimed.id]);
      await writer.query('COMMIT');}catch(error){await writer.query('ROLLBACK');throw error;}finally{writer.release();}
    const unknown=await tasks.get(context,uncertain.id);assert.equal(unknown?.state,'outcome_unknown');
    assert.equal(unknown.outcome?.cost.money.state,'unknown');

    // One deliberate due date produces a visible, scoped lint finding without changing publication.
    const lintWriter=await pool.connect();try{await lintWriter.query('BEGIN');await assertKnowledgeWriterAuthority(lintWriter,projectId,seed.writerGrant);
      await lintWriter.query(`UPDATE ccl_knowledge_revisions SET payload=jsonb_set(payload,'{scope,reviewDueAt}',
        to_jsonb('2020-01-01T00:00:00.000Z'::text)) WHERE project_id=$1 AND object_id=$2 AND version_id=$3`,
      [projectId,seed.root.objectId,seed.root.versionId]);await lintWriter.query('COMMIT');
    }catch(error){await lintWriter.query('ROLLBACK');throw error;}finally{lintWriter.release();}
    const cycleKey=`synthetic-demo-${randomUUID()}`;
    let lint=(await client.lintWiki({purpose,cycleKey,shard:0,shardCount:1,limit:100,methodVersion:'lint-demo/1'},
      {idempotencyKey:randomUUID(),purpose})).data;
    for(let batch=0;batch<4&&!lint.complete;batch++)lint=(await client.lintWiki({purpose,cycleKey,shard:0,shardCount:1,limit:100,
      methodVersion:'lint-demo/1'},{idempotencyKey:randomUUID(),purpose})).data;
    assert.equal(lint.complete,true);assert.ok((await client.maintenanceFindings(purpose,{limit:100})).data.items.some(item=>item.kind==='review_due'));
    let projection=(await client.rebuildSearchProjection({purpose,limit:100,restart:false},{idempotencyKey:randomUUID(),purpose})).data;
    for(let batch=0;batch<4&&!projection.complete;batch++)projection=(await client.rebuildSearchProjection({purpose,limit:100,restart:false},
      {idempotencyKey:randomUUID(),purpose})).data;
    assert.equal(projection.ready,true);assert.equal(projection.complete,true);assert.equal(projection.blockedRows,0);
    assert.equal((await client.searchProjectionStatus(purpose)).data?.ready,true);
    assert.equal(Number((await pool.query<{count:number}>(`SELECT count(*)::int AS count FROM ccl_knowledge_publications WHERE project_id=$1`,[projectId])).rows[0]?.count),
      publicationsBefore,'Lint and index maintenance must not publish the candidate');
    if(stopRequested)return;
    temporaryReadyPath=`${READY_FILE}.${randomUUID()}`;
    await writeFile(temporaryReadyPath,JSON.stringify({baseUrl,projectId,spaceId,purpose,token,taskId:collected.id,
      candidateId:compilation.candidate.candidateId,schema},null,2)+'\n',{mode:0o600,flag:'wx'});
    await rename(temporaryReadyPath,READY_FILE);temporaryReadyPath=undefined;readyWritten=true;
    process.stdout.write(`readyFile=${READY_FILE} port=${address.port}\n`);
    await stopped;
  }finally{await cleanup();}
}

await main().catch(()=>{process.stderr.write('Synthetic coordination demo failed; isolated cleanup attempted.\n');process.exitCode=1;});
