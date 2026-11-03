import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import pg from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {seedKnowledgeSyntheticFixture} from '../../../scripts/runtime/knowledge-synthetic-fixture.ts';
import {createKnowledgeApi} from '../src/index.ts';
import {assertKnowledgeWriterAuthority} from '@commerce/knowledge-core/writer-authority';
import {createKnowledgeWorker} from '../../knowledge-worker/src/index.ts';
import {createKnowledgeClient} from '../../../packages/knowledge-client/src/index.ts';
import type {SourcePlanner,WikiCompiler,DecisionProvider,CapabilityContext,QueryAnswerer} from '@commerce/knowledge-application';
import type {KnowledgeRef,WikiCompileResult} from '@commerce/knowledge-contracts';
const url=readTestDatabase(),dbTest=url?test:test.skip;
const zero={modelCalls:{state:'known' as const,value:0},tokens:{state:'known' as const,value:0},money:{state:'known' as const,amount:0,currency:'USD',source:'synthetic_no_model'}};
for(const expireWorker of [false,true])dbTest(`durable background source planning, judgment and review feed the next query (lease expiry ${expireWorker})`,{timeout:90_000},async()=>{
 const admin=new pg.Pool({connectionString:url!,max:2}),schema=`coord_loop_${randomUUID().replaceAll('-','')}`;
 await admin.query(`CREATE SCHEMA "${schema}"`);const pool=new pg.Pool({connectionString:url!,max:12,options:`-c search_path=${schema}`}),servers:Server[]=[];let releaseWorker=()=>{};let heldWork:Promise<boolean>|null=null;
 try{
  const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-coordination-${randomUUID()}`),purpose='exploration_reading',scope={projectId:seed.projectId,spaceId:seed.spaceId},reviewerId='synthetic-coord-reviewer';
  let phase:'first'|'counterexample'='first',plans=0,pairs=0,compiles=0,answers=0;let firstRef:KnowledgeRef|null=null;let afterPlanning:(()=>Promise<void>)|undefined;
  const title='靛青灯箱',identity=`indigo-fixture-${randomUUID()}`;
  const planner:SourcePlanner={id:'synthetic-source-planner',version:'1',model:'synthetic-no-model',execution:'local_deterministic',async plan(input){plans++;
   const surface='靛青灯箱',char=input.source.body.indexOf(surface);assert.ok(char>=0);const startByte=Buffer.byteLength(input.source.body.slice(0,char));if(afterPlanning){const action=afterPlanning;afterPlanning=undefined;await action();}
   return {proposal:{outcome:'planned',question:'研究靛青灯箱的识别条件和反例',queries:[title],mentions:[{entityType:'concept',surface,startByte,endByte:startByte+Buffer.byteLength(surface)}],reason:'Synthetic proposed research, not entity resolution',gaps:['No real semantic acceptance']},raw:{fixture:true},cost:zero,modelReturned:'synthetic-no-model',requestId:`plan-${plans}`};}};
  const decision:DecisionProvider={id:'synthetic-coord-decider',version:'1',model:'synthetic-no-model',execution:'local_deterministic',async decide(input){pairs++;
   assert.equal(input.state.left.ref.objectId,firstRef!.objectId);assert.ok(input.state.right.body.includes('反例'));
   return {cost:zero,result:{modelReturned:'synthetic-no-model',inputTokens:0,outputTokens:0,requestId:`pair-${pairs}`,raw:{fixture:true},answers:input.questions.map(q=>q.type==='predicate'?{id:q.id,type:q.type,state:'answered',value:null,probability:0.9,distribution:null,confidence:null,reason:null}:q.type==='choice'?{id:q.id,type:q.type,state:'answered',value:'challenges',probability:null,distribution:Object.fromEntries(q.options.map(x=>[x.value,x.value==='challenges'?1:0])),confidence:null,reason:null}:{id:q.id,type:q.type,state:'not_evaluated',value:null,probability:null,distribution:null,confidence:null,reason:'Not used by this fixture'})}};}};
  const compiler:WikiCompiler={id:'synthetic-coord-compiler',model:'synthetic-no-model',methodVersion:'coord-fixture/1',execution:'local_deterministic',async compile(input){compiles++;
   const old=input.evidence.find(x=>x.kind==='wiki_page'&&x.ref.objectId===firstRef?.objectId),source=input.evidence.find(x=>x.kind==='source_content')!;
   if(phase==='counterexample'){assert.ok(old);assert.equal(input.relationHints?.length,1);assert.equal(input.relationHints![0].answers.find(x=>x.id==='relation')?.value,'challenges');}
   else assert.equal(input.relationHints?.length??0,0);
   return {proposal:{outcome:'proposed',drafts:[{targetEvidenceId:phase==='counterexample'?old!.id:null,profile:old?.wiki?.profile??input.profiles.find(x=>x.id==='concept')!,identityKey:identity,title,
    summary:phase==='first'?'合成认识：固定条件下灯箱可能帮助识别。':'合成修订：灯箱本身不足以改善识别，必须同时核对可见信息与对照条件。',conditions:['仅供合成工程验证','需要可比较的拍摄条件'],counterexamples:phase==='counterexample'?['亮度变化不等于识别改善']:[],unknowns:['真实语义未验'],nextQuestions:[],supportEvidenceIds:[source.id],rationale:'Read source, old Wiki and advisory judgment; independent review still required'}],reason:'Synthetic bounded proposal',gaps:[]},cost:zero,modelReturned:'synthetic-no-model',requestId:`compile-${compiles}`};}};
  const answerer:QueryAnswerer={id:'synthetic-coord-answerer',model:'synthetic-no-model',supportsMoneyLimit:true,async answer(input){answers++;return {answer:{outcome:'answered',claims:[{text:input.evidence[0].body,evidenceIds:[input.evidence[0].id]}],reason:'Synthetic exact-read echo',gaps:['Not a semantic quality test']},cost:zero,modelReturned:'synthetic-no-model',requestId:'answer'};}};
  const auth={...seed.authorization,adapterIds:[...seed.authorization.adapterIds,'coord-fixture'],actions:[...seed.authorization.actions,'ingest:read','ingest:write','source-plans:read','source-plans:write','compile:read','compile:write','judgments:read','judgments:write','maintenance:read','maintenance:write','review:request','review:decide','review:read','ask:write']};
  async function start(id:string,installation:string,coordinated:boolean){const token=`synthetic-${randomUUID()}-${randomUUID()}`;
   const api=await createKnowledgeApi({pool,token,port:0,principal:{...seed.principal,id,clientInstallationId:installation},writerGrant:seed.writerGrant,enableSourceIngest:true,enableMaintenance:true,
    compiler,answerer,sourcePlanner:planner,decisionProvider:decision,capabilities:auth,sourceReaderIds:[seed.principal.id,reviewerId],...coordinated?{coordinationPolicy:{version:'coord-fixture/1',maxPairs:1,maxCandidates:1,queryLimit:1,budget:{maxModelCalls:0,maxReadBytes:10_000_000,maxMoney:{amount:0,currency:'USD'},timeoutMs:120_000}}}:{} });
   const server=await api.listen();servers.push(server);const address=server.address();assert.ok(address&&typeof address!=='string');
   return {api,client:createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope,headers:{Authorization:`Bearer ${token}`}})};}
  const owner=await start(seed.principal.id,seed.principal.clientInstallationId!,true),reviewer=(await start(reviewerId,'coord-reviewer',false)).client;
  const context:CapabilityContext={scope,purpose,principal:seed.principal,authorization:auth};
  let parentReady!:()=>void;const ready=new Promise<void>(resolve=>{parentReady=resolve;}),held=new Promise<void>(resolve=>{releaseWorker=resolve;});let holdFinish=true;
  const worker=await createKnowledgeWorker({pool,projectId:seed.projectId,writerGrant:seed.writerGrant,enableResearch:false,maintenance:{context,methodVersion:'coord-fixture/1',rubricVersion:'relations-fixture/1',processor:{...owner.api.coordination!,async process(...args){const result=await owner.api.coordination!.process(...args);if(holdFinish){parentReady();await held;holdFinish=false;}return result;}}}});
  async function source(text:string){const registered=(await owner.client.registerSource({externalIdentity:{adapterId:'coord-fixture',externalObjectId:randomUUID(),externalVersion:'1'},expectedSourceHead:null,sourceSchemaVersion:'synthetic-note/1',contentDigest:createHash('sha256').update(text).digest('hex'),custody:{mode:'managed_copy',text},sourceKind:'document',author:null,publisher:null,acquirer:'synthetic-fixture',publishedAt:null,obtainedAt:new Date().toISOString(),assertionKind:'source_claim',sourceGroups:[{id:randomUUID(),status:'known',authority:'synthetic-original'}],anchors:[],actualCoverage:[],limitations:['Synthetic only'],rightsPolicyRef:'synthetic-local-only'},{idempotencyKey:randomUUID(),purpose})).data;
   const eventKey=randomUUID();return (await owner.client.registerSourceEvent({adapterId:'coord-fixture',eventKey,producerSequence:1,occurredAt:new Date().toISOString(),purpose,sourceRef:{...registered.ref,domain:'source',contentDigest:registered.ref.contentDigest!}},{idempotencyKey:eventKey,purpose})).data;}
  async function taskFor(eventId:string){let cursor:string|undefined;for(let page=0;page<10;page++){const result=(await owner.client.maintenanceTasks(purpose,{limit:100,cursor})).data,found=result.items.find(x=>x.request.sourceEventIds.includes(eventId));if(found)return found;if(!result.hasMore)break;cursor=result.nextCursor!;}assert.fail('Expected source task');}
  async function publicationRelationTasks(ref:KnowledgeRef){return Number((await pool.query<{n:string}>(`
   SELECT count(*) AS n FROM ccl_knowledge_maintenance_tasks WHERE project_id=$1
     AND trigger->>'stream'='knowledge' AND request->>'kind'='relation_check'
     AND request->'subjectRef'->>'objectId'=$2 AND request->'subjectRef'->>'versionId'=$3`,
   [seed.projectId,ref.objectId,ref.versionId])).rows[0].n);}
  async function publish(compilation:WikiCompileResult,key:string){assert.equal(compilation.state,'waiting_for_review');const c=compilation.candidate!,ticket=(await owner.client.requestReview({target:{kind:'candidate',candidateId:c.candidateId,contentHash:c.contentHash},purpose},{idempotencyKey:`ticket-${key}`,purpose})).data;
   return (await reviewer.decideReview(ticket.id,{expectedDigest:c.contentHash,decision:'exploration_only',reason:'Synthetic independent engineering approval',conditions:[],gaps:[]},{idempotencyKey:`approve-${key}`,purpose})).data.publication!.refs[0];}
  const a=await source('合成观察：靛青灯箱在固定拍摄条件下可能帮助识别，但还没有真实观众验证。');
  const pubsBefore=Number((await pool.query('SELECT count(*) n FROM ccl_knowledge_publications')).rows[0].n);
  heldWork=worker.runOne();void heldWork.then(parentReady,parentReady);await ready;const firstTask=await taskFor(a.id);assert.equal(firstTask.state,'running');
  const run1=(await owner.client.coordinationForTask(firstTask.id,purpose)).data!;assert.equal(run1.state,'waiting_for_review');assert.equal(run1.steps.length,3);assert.equal(run1.judgmentIds.length,0);assert.ok(run1.readBytes>0&&run1.readBytes<=run1.request.budget.maxReadBytes);
  const plan1=(await owner.client.sourcePlan(run1.sourcePlanId!,purpose)).data;assert.equal(plan1.provenance,'model_proposed');assert.equal(plan1.proposal!.mentions[0].surface,title);
  assert.equal(Number((await pool.query('SELECT count(*) n FROM ccl_knowledge_publications')).rows[0].n),pubsBefore,'background proposals cannot publish');
  const first=(await owner.client.compilation(run1.compilationId!,purpose)).data;
  await pool.query(`CREATE FUNCTION fail_coordination_review_finish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='completed' THEN RAISE EXCEPTION 'synthetic coordination finish failure';END IF;RETURN NEW;END;$$;
    CREATE TRIGGER fail_coordination_review_finish BEFORE UPDATE ON ccl_knowledge_coordination_runs FOR EACH ROW EXECUTE FUNCTION fail_coordination_review_finish()`);
  await assert.rejects(publish(first,'c1'));
  assert.equal(Number((await pool.query('SELECT count(*) n FROM ccl_knowledge_publications')).rows[0].n),pubsBefore,'failed coordination closure rolls publication back too');
  assert.equal((await owner.client.compilation(first.id,purpose)).data.state,'waiting_for_review');
  await pool.query('DROP TRIGGER fail_coordination_review_finish ON ccl_knowledge_coordination_runs');
  firstRef=await publish(first,'c1');
  if(expireWorker){const db=await pool.connect();try{await db.query('BEGIN');await assertKnowledgeWriterAuthority(db,seed.projectId,seed.writerGrant);await db.query("UPDATE ccl_knowledge_maintenance_tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[firstTask.id]);await db.query('COMMIT');}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
   assert.equal((await owner.client.maintenanceTask(firstTask.id,purpose)).data.state,'completed','expired task recovers the already completed review without a provider');
  }else assert.equal((await owner.client.maintenanceTask(firstTask.id,purpose)).data.state,'running','review must not steal the active worker lease');
  releaseWorker();assert.equal(await heldWork,true);heldWork=null;
  assert.equal((await owner.client.maintenanceTask(firstTask.id,purpose)).data.state,'completed','worker acknowledges the already published result');
  assert.equal((await owner.client.coordinationForTask(firstTask.id,purpose)).data!.compilationOutcome,'published');
  assert.equal(await worker.runOne(),false,'initial publication adds no immediate relation study');
  assert.equal(await publicationRelationTasks(firstRef),0);
  assert.equal(plans,1);assert.equal(compiles,1);
  phase='counterexample';const b=await source('合成反例：靛青灯箱改变了亮度，其他条件不同，不能证明商品识别真的改善。');
  await owner.client.collectMaintenance({purpose,methodVersion:'coord-fixture/1',rubricVersion:'relations-fixture/1',limit:500},{idempotencyKey:'collect-b',purpose});
  const processed=(await owner.client.processMaintenance(purpose,{idempotencyKey:'process-b',purpose})).data!;assert.equal(processed.state,'waiting_for_review');
  const secondTask=await taskFor(b.id),run2=(await owner.client.coordinationForTask(secondTask.id,purpose)).data!;
  assert.equal(run2.judgmentIds.length,1);assert.equal(run2.steps.length,4);assert.equal(run2.candidateRefs[0].versionId,firstRef.versionId);assert.equal(run2.cost.money.state,'known');
  const second=(await owner.client.compilation(run2.compilationId!,purpose)).data,secondRef=await publish(second,'c2');assert.equal(secondRef.objectId,firstRef.objectId);assert.notEqual(secondRef.versionId,firstRef.versionId);assert.equal((await owner.client.maintenanceTask(secondTask.id,purpose)).data.state,'completed');assert.equal((await owner.client.coordinationForTask(secondTask.id,purpose)).data!.compilationOutcome,'published');
  const queried=(await owner.client.query({question:title,purpose,limit:3,retrievalMethod:'wiki-lexical-v2'})).data;assert.ok(queried.items.some(x=>x.ref.versionId===secondRef.versionId));assert.ok(queried.items.every(x=>x.ref.versionId!==firstRef!.versionId));
  const answer=(await owner.client.ask({question:title,purpose,limit:1,maxPages:1,includeSourceContent:false,budget:{maxModelCalls:1,maxReadBytes:500_000,maxMoney:{amount:0,currency:'USD'},deadline:new Date(Date.now()+30_000).toISOString()}},{idempotencyKey:'after-c2',purpose})).data;assert.equal(answer.state,'answered',JSON.stringify(answer));assert.equal(answer.evidence[0].ref.versionId,secondRef.versionId);
  await owner.client.coordinationForTask(secondTask.id,purpose);assert.equal(plans,2);assert.equal(pairs,1);assert.equal(compiles,2);assert.equal(answers,1);
  await owner.client.collectMaintenance({purpose,methodVersion:'coord-fixture/1',rubricVersion:'relations-fixture/1',limit:500},
   {idempotencyKey:'collect-publication-c2',purpose});
  assert.equal(await publicationRelationTasks(secondRef),0);
  assert.equal((await owner.client.processMaintenance(purpose,{idempotencyKey:'empty-work',purpose})).data,null,
   'new publication is left to the periodic sweep, so source processing is idle');
  const c=await source('合成反例补充：靛青灯箱的这一份提案并未满足独立审阅要求。');
  await owner.client.collectMaintenance({purpose,methodVersion:'coord-fixture/1',rubricVersion:'relations-fixture/1',limit:500},{idempotencyKey:'collect-c',purpose});
  await owner.client.processMaintenance(purpose,{idempotencyKey:'process-c',purpose});const thirdTask=await taskFor(c.id),run3=(await owner.client.coordinationForTask(thirdTask.id,purpose)).data!;
  const rejectedCompilation=(await owner.client.compilation(run3.compilationId!,purpose)).data,rc=rejectedCompilation.candidate!;
  const rejectTicket=(await owner.client.requestReview({target:{kind:'candidate',candidateId:rc.candidateId,contentHash:rc.contentHash},purpose},{idempotencyKey:'ticket-reject',purpose})).data;
  const publicationCount=Number((await pool.query('SELECT count(*) n FROM ccl_knowledge_publications')).rows[0].n);
  await reviewer.decideReview(rejectTicket.id,{expectedDigest:rc.contentHash,decision:'rejected',reason:'Synthetic independent rejection',conditions:[],gaps:[]},{idempotencyKey:'reject-c',purpose});
  const rejectedRun=(await owner.client.coordinationForTask(thirdTask.id,purpose)).data!;assert.equal(rejectedRun.state,'completed');assert.equal(rejectedRun.compilationOutcome,'rejected');
  assert.equal((await owner.client.maintenanceTask(thirdTask.id,purpose)).data.state,'completed');assert.equal(Number((await pool.query('SELECT count(*) n FROM ccl_knowledge_publications')).rows[0].n),publicationCount);
  assert.ok((await owner.client.query({question:title,purpose,limit:3,retrievalMethod:'wiki-lexical-v2'})).data.items.some(x=>x.ref.versionId===secondRef.versionId));
  const d=await source('合成取消场景：靛青灯箱这一份输入只用于确认取消能阻止后续编纂。');
  await owner.client.collectMaintenance({purpose,methodVersion:'coord-fixture/1',rubricVersion:'relations-fixture/1',limit:500},{idempotencyKey:'collect-cancel',purpose});
  const cancelledTask=await taskFor(d.id),beforeCancelCompile=compiles,beforeCancelPairs=pairs;
  afterPlanning=async()=>{await owner.client.cancelMaintenance(cancelledTask.id,purpose,{idempotencyKey:'cancel-after-plan',purpose});};
  const cancelled=(await owner.client.processMaintenance(purpose,{idempotencyKey:'process-cancel',purpose})).data!;
  assert.equal(cancelled.state,'cancelled');assert.equal(compiles,beforeCancelCompile);assert.equal(pairs,beforeCancelPairs);
  const cancelledRun=(await owner.client.coordinationForTask(cancelledTask.id,purpose)).data!;assert.equal(cancelledRun.state,'cancelled');assert.ok(cancelledRun.sourcePlanId);assert.equal(cancelledRun.compilationId,null);


 }finally{releaseWorker();if(heldWork)await heldWork.catch(()=>{});for(const server of servers)await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
