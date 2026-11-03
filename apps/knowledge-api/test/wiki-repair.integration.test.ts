import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import pg from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {seedKnowledgeSyntheticFixture} from '../../../scripts/runtime/knowledge-synthetic-fixture.ts';
import {createKnowledgeApi} from '../src/index.ts';
import {createKnowledgeClient} from '../../../packages/knowledge-client/src/index.ts';
import {createPgMaintenanceTasks} from '../../../packages/adapters/knowledge-service/src/maintenance-tasks.ts';
import type {WikiCompiler} from '../../../packages/knowledge-application/src/wiki-compile.ts';
import type {QueryAnswerer} from '../../../packages/knowledge-application/src/ask.ts';
import type {KnowledgeRef,MaintenanceTask,WikiCompileProposal,WikiCompileResult,WikiDraftChange} from '../../../packages/knowledge-contracts/src/index.ts';
const url=readTestDatabase(),dbTest=url?test:test.skip;
const zero={modelCalls:{state:'known' as const,value:0},tokens:{state:'known' as const,value:0},money:{state:'known' as const,amount:0,currency:'USD',source:'local-fixture-no-model'}};
type RepairMode='repair'|'keep_invalid'|'target_support'|'no_change'|'incomplete';

dbTest('A1→A2 invalidates C1 → recompile → independent review publishes C2 → downstream D repairs → next Ask adopts C2; stale, revoked, rejected and racing repairs publish nothing',
 {timeout:180_000},async()=>{
 const admin=new pg.Pool({connectionString:url!,max:2}),schema=`wiki_repair_${randomUUID().replaceAll('-','')}`;
 await admin.query(`CREATE SCHEMA "${schema}"`);
 const pool=new pg.Pool({connectionString:url!,max:12,options:`-c search_path=${schema}`});const servers:Server[]=[];
 try{
  const reviewerId=`repair-reviewer-${randomUUID()}`;
  const seed=await seedKnowledgeSyntheticFixture(pool,`repair-${randomUUID()}`,'repair-space',{readerIds:[reviewerId]});
  const purpose='exploration_reading',scope={projectId:seed.projectId,spaceId:seed.spaceId};
  const cKey=`repaircfixture${randomUUID().replaceAll('-','')}`,dKey=`repairdfixture${randomUUID().replaceAll('-','')}`;
  let mode:RepairMode='repair',phase:'create_c'|'create_d'='create_c';
  const repairs:Array<{target:string;inputs:string[];reasons:readonly string[]}>=[];let creations=0,answers=0;
  const compiler:WikiCompiler={id:'repair-fixture-compiler',model:'local-fixture-no-model',methodVersion:'repair-fixture/1',execution:'local_deterministic',async compile(input){
   const answer=(proposal:WikiCompileProposal)=>({proposal,cost:zero,modelReturned:'local-fixture-no-model',requestId:`repair-fixture-${randomUUID()}`});
   if(input.repairTarget){
    const target=input.evidence.find(item=>item.id===input.repairTarget!.evidenceId)!;
    assert.equal(target.role,'repair_target');assert.ok(target.body.length>0,'the invalid target is genuinely read for comparison');
    const fresh=input.evidence.filter(item=>item.role!=='repair_target');
    repairs.push({target:target.ref.objectId,inputs:fresh.map(item=>`${item.ref.domain}:${item.ref.objectId}/${item.ref.versionId}`),reasons:input.repairTarget.invalidityReasons});
    if(mode==='no_change')return answer({outcome:'no_change',drafts:[],reason:'Fixture claims nothing changed',gaps:[]});
    const dependencies=input.repairTarget.dependencies.filter(dep=>dep.critical&&!(dep.domain==='knowledge'&&dep.ref.objectId===target.ref.objectId));
    const seen=new Set<string>(),plan:NonNullable<WikiDraftChange['repair']>['dependencies']=[];
    for(const dep of dependencies){const key=`${dep.domain}:${dep.ref.objectId}/${dep.ref.versionId}`;if(seen.has(key))continue;seen.add(key);
     const successor=fresh.find(item=>item.ref.objectId===dep.ref.objectId&&item.ref.versionId!==dep.ref.versionId&&
      item.kind===(dep.domain==='knowledge'?'wiki_page':'source_content'));
     plan.push(dep.valid||mode==='keep_invalid'?{domain:dep.domain as 'knowledge'|'source',ref:dep.ref,action:'keep',replacementEvidenceId:null,reason:'仍有效，保留'}:
      successor?{domain:dep.domain as 'knowledge'|'source',ref:dep.ref,action:'replace',replacementEvidenceId:successor.id,reason:'由已读的当前版本替换'}:
       {domain:dep.domain as 'knowledge'|'source',ref:dep.ref,action:'remove',replacementEvidenceId:null,reason:'没有可读后继，移除并收窄'});}
    const due=input.repairTarget.reviewDueAt&&Date.parse(input.repairTarget.reviewDueAt)<=Date.now();
    return answer({outcome:'proposed',drafts:[{targetEvidenceId:target.id,profile:target.wiki!.profile,identityKey:target.wiki!.identity.key,
     title:target.title,summary:`${target.title}：按当前已读依据修订；旧版只作对照。`,conditions:['仅供合成工程验证'],counterexamples:[],unknowns:['真实语义尚未验证'],nextQuestions:[],
     supportEvidenceIds:mode==='target_support'?[target.id,...fresh.map(item=>item.id)]:fresh.map(item=>item.id),rationale:'失效依赖逐项处置',
     repair:{dependencies:mode==='incomplete'?plan.slice(1):plan,reviewDue:due?{action:'set',until:new Date(Date.now()+86_400_000).toISOString(),reason:'修复后重新设定复核期'}:{action:'keep'}}}],
     reason:'Local repair fixture proposal for independent review',gaps:['No real semantic acceptance']});
   }
   creations++;
   const sources=input.evidence.filter(item=>item.kind==='source_content'),old=input.evidence.find(item=>item.kind==='wiki_page'&&item.title==='合成修复认识 C');
   if(phase==='create_d')assert.ok(old,'D genuinely reads the published C1');
   return answer({outcome:'proposed',drafts:[{targetEvidenceId:null,profile:input.profiles.find(item=>item.id==='question')!,identityKey:phase==='create_d'?dKey:cKey,
    title:phase==='create_d'?'合成修复派生 D':'合成修复认识 C',summary:phase==='create_d'?'D 依赖 C 的条件。':'C 来自来源 A 的第一版。',
    conditions:['仅供合成工程验证'],counterexamples:[],unknowns:['真实语义尚未验证'],nextQuestions:[],
    supportEvidenceIds:[...sources.map(item=>item.id),...phase==='create_d'?[old!.id]:[]],rationale:'准确已读资料'}],reason:'Local fixture creation',gaps:[]});
  }};
  let adopted:KnowledgeRef[]=[];
  const answerer:QueryAnswerer={id:'repair-fixture-answerer',model:'local-fixture-no-model',supportsMoneyLimit:true,async answer(input){answers++;
   adopted=input.evidence.filter(item=>item.kind==='wiki_page').map(item=>item.ref);
   return {answer:{outcome:'answered',claims:[{text:input.evidence[0].body,evidenceIds:[input.evidence[0].id]}],reason:'Fixture echo',gaps:[]},
    cost:zero,modelReturned:'local-fixture-no-model',requestId:`repair-answer-${answers}`};}};
  const authorization={...seed.authorization,adapterIds:[...seed.authorization.adapterIds,'repair-fixture'],actions:[...new Set([...seed.authorization.actions,'sources:revoke','ingest:read','ingest:write',
   'compile:read','compile:write','review:request','review:read','review:decide','ask:write','maintenance:read','maintenance:write'])]};
  async function start(id:string,installation:string,coordinated:boolean){const token=`repair-${randomUUID()}-${randomUUID()}`;
   const api=await createKnowledgeApi({pool,token,port:0,principal:{...seed.principal,id,clientInstallationId:installation},writerGrant:seed.writerGrant,compiler,answerer,
    enableSourceIngest:true,enableMaintenance:true,capabilities:authorization,sourceReaderIds:[seed.principal.id,reviewerId],
    ...coordinated?{coordinationPolicy:{version:'repair-fixture/1',maxCandidates:3,maxPairs:0,queryLimit:5,
     budget:{maxModelCalls:0,maxReadBytes:4_000_000,maxMoney:{amount:0,currency:'USD'},timeoutMs:120_000}}}:{}});
   const server=await api.listen();servers.push(server);const address=server.address();assert.ok(address&&typeof address!=='string');
   return createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope,headers:{Authorization:`Bearer ${token}`}});}
  const owner=await start(seed.principal.id,seed.principal.clientInstallationId!,true),reviewer=await start(reviewerId,'repair-reviewer-install',false);
  const budget=()=>({maxModelCalls:0,maxReadBytes:400_000,maxMoney:{amount:0,currency:'USD'},deadline:new Date(Date.now()+120_000).toISOString()});
  const register=async(text:string,externalObjectId:string,externalVersion:string,expectedSourceHead:string|null)=>(await owner.registerSource({
   externalIdentity:{adapterId:'repair-fixture',externalObjectId,externalVersion},expectedSourceHead,sourceSchemaVersion:'synthetic-note/1',
   contentDigest:createHash('sha256').update(text).digest('hex'),custody:{mode:'managed_copy',text},sourceKind:'document',author:null,publisher:null,
   acquirer:'repair-test',publishedAt:null,obtainedAt:new Date().toISOString(),assertionKind:'source_claim',
   sourceGroups:[{id:`origin-${externalObjectId}`,status:'known',authority:'synthetic-original'}],anchors:[],actualCoverage:[],limitations:['Synthetic only'],
   rightsPolicyRef:'synthetic-local-only'},{idempotencyKey:randomUUID(),purpose})).data.ref;
  const event=async(ref:KnowledgeRef)=>{const key=`source:${ref.versionId}`;
   return (await owner.registerSourceEvent({adapterId:'repair-fixture',eventKey:key,producerSequence:1,occurredAt:new Date().toISOString(),purpose,
    sourceRef:{...ref,domain:'source',contentDigest:ref.contentDigest!}},{idempotencyKey:key,purpose})).data.id;};
  const publish=async(compiled:WikiCompileResult,key:string)=>{const c=compiled.candidate!;
   const ticket=(await owner.requestReview({target:{kind:'candidate',candidateId:c.candidateId,contentHash:c.contentHash},purpose},{idempotencyKey:`ticket-${key}`,purpose})).data;
   const final=(await reviewer.decideReview(ticket.id,{expectedDigest:c.contentHash,decision:'exploration_only',reason:'Independent fixture approval',conditions:[],gaps:[]},
    {idempotencyKey:`approve-${key}`,purpose})).data;
   return {ticket,ref:final.publication!.refs[0]};};
  const publications=async()=>(await pool.query<{n:number}>('SELECT count(*)::int n FROM ccl_knowledge_publications')).rows[0].n;
  const collect=(key:string)=>owner.collectMaintenance({purpose,methodVersion:'repair-fixture/1',rubricVersion:'repair-fixture/1',limit:500},{idempotencyKey:key,purpose});
  const processAll=async(label:string)=>{const done:MaintenanceTask[]=[];
   for(let i=0;i<20;i++){const task=(await owner.processMaintenance(purpose,{idempotencyKey:`${label}-${i}`,purpose})).data;if(!task)break;done.push(task);}
   return done;};
  const repairTasks=(tasks:MaintenanceTask[],objectId:string)=>tasks.filter(task=>task.request.kind==='recompile'&&task.request.subjectRef?.objectId===objectId);

  // Baseline: C1 cites source A1; D1 derives from C1 and source B.
  const aExternal=`a-${randomUUID()}`;
  const a1=await register('来源A第一版：结果先出现。',aExternal,'1',null),b=await register('来源B：观众需要辨认商品。',`b-${randomUUID()}`,'1',null);
  const c1Compiled=(await owner.compileWiki({question:'C 的依据',purpose,sourceEventIds:[await event(a1)],queries:[cKey],limit:3,maxPages:1,budget:budget()},{idempotencyKey:'compile-c1',purpose})).data;
  assert.equal(c1Compiled.state,'waiting_for_review');const c1=(await publish(c1Compiled,'c1')).ref;
  phase='create_d';
  const d1Compiled=(await owner.compileWiki({question:'D 的依据',purpose,sourceEventIds:[await event(b)],queries:[cKey],limit:3,maxPages:1,budget:budget()},{idempotencyKey:'compile-d1',purpose})).data;
  assert.equal(d1Compiled.state,'waiting_for_review');const d1=(await publish(d1Compiled,'d1')).ref;
  assert.equal(creations,2);
  await collect('collect-baseline');
  assert.equal((await processAll('baseline')).filter(task=>task.request.kind==='recompile').length,0,'valid new pages are left to periodic discovery');

  // A2 supersedes A1: C1 and its dependent D1 become invalid and are queued for repair.
  const a2=await register('来源A第二版：结果先出现，但须先让商品可辨。',aExternal,'2',a1.versionId);
  assert.equal(a2.objectId,a1.objectId);assert.notEqual(a2.versionId,a1.versionId);
  const invalidAsk=(await owner.ask({question:cKey,purpose,limit:3,maxPages:1,includeSourceContent:false,budget:{...budget(),maxModelCalls:1}},{idempotencyKey:'ask-invalid-c1',purpose})).data;
  assert.equal(invalidAsk.state,'needs_evidence');assert.equal(answers,0,'an invalid C1 never reaches the answerer');
  const c1Document=(await owner.document(c1,purpose)).data;
  assert.equal(c1Document.status.validity.valid,false,'C1 stays readable while its adoption status is invalid');assert.ok(c1Document.body.length>0);
  await collect('collect-a2');
  const firstPass=await processAll('after-a2');
  const c1Tasks=repairTasks(firstPass,c1.objectId),d1Tasks=repairTasks(firstPass,d1.objectId);
  assert.equal(c1Tasks.length,1);assert.equal(c1Tasks[0].state,'waiting_for_review',JSON.stringify(c1Tasks[0].outcome));
  assert.equal(d1Tasks.length,1);assert.equal(d1Tasks[0].state,'needs_evidence','downstream waits for its upstream repair instead of claiming no change');
  assert.equal(d1Tasks[0].outcome?.compilationId,null);assert.equal(repairs.length,1,'only C1 reached the compiler');
  assert.ok(repairs[0].reasons.includes('source_superseded'));
  assert.ok(repairs[0].inputs.includes(`source:${a2.objectId}/${a2.versionId}`),'the readable A2 replaces A1');
  assert.ok(repairs[0].inputs.every(ref=>!ref.endsWith(`/${a1.versionId}`)),'invalid A1 is not re-read as new support');

  // A lost process response is recovered read-only from the original task key; nothing is dispatched again.
  const run=(await owner.coordinationForTask(c1Tasks[0].id,purpose)).data!;
  assert.equal(run.state,'waiting_for_review');assert.ok(run.compilationId);
  const repairCompiled=(await owner.compilation(run.compilationId!,purpose)).data;
  assert.equal(repairCompiled.state,'waiting_for_review');assert.equal(repairs.length,1);
  assert.equal(repairCompiled.evidence.filter(item=>item.role==='repair_target').length,1);
  const draft=repairCompiled.drafts[0];assert.ok(draft.repair);
  assert.ok(draft.repair!.dependencies.some(item=>item.domain==='source'&&item.ref.versionId===a1.versionId&&item.action==='replace'));

  // Independent review sees the old version as comparison-only and the explicit dispositions.
  const view=(await reviewer.candidateView(repairCompiled.candidate!.candidateId,purpose)).data;
  assert.equal(view.reviewable,true,JSON.stringify(view.reviewIssues));
  assert.equal(view.changes[0].before?.ref.versionId,c1.versionId);
  assert.equal(view.changes[0].repair?.comparisonOnly,true);assert.ok(view.changes[0].repair!.invalidityReasons.includes('source_superseded'));

  // A second, racing repair of the same head is staged from another task. Only one can publish.
  const tasks=createPgMaintenanceTasks(pool,seed.writerGrant);
  const ownerContext={scope,purpose,principal:{...seed.principal,clientInstallationId:seed.principal.clientInstallationId!}};
  const subject={...c1,contentDigest:null};
  const manual=(key:string,ref=subject)=>tasks.enqueue(ownerContext,{kind:'recompile',subjectRef:ref,sourceEventIds:[],relatedRefs:[],reason:`Manual repair ${key}`,
   methodVersion:'repair-fixture/1',rubricVersion:'repair-fixture/1'},{stream:'manual',eventKey:`manual:${key}`,sequence:0,ref,sourceEventId:null});
  // Invalid proposals are refused before stage; "no change" cannot close a repair.
  for(const [index,bad] of (['keep_invalid','target_support','incomplete'] as const).entries()){mode=bad;await manual(`bad-${index}`);
   const [done]=repairTasks(await processAll(`bad-${index}`),c1.objectId);assert.equal(done.state,'failed',`${bad}: ${JSON.stringify(done.outcome)}`);
   const compiled=(await owner.compilation(done.outcome!.compilationId!,purpose)).data;assert.equal(compiled.candidate,null);
   assert.match(compiled.reason,bad==='keep_invalid'?/REPAIR_KEEPS_INVALID_DEPENDENCY/:bad==='target_support'?/REPAIR_TARGET_AS_SUPPORT/:/REPAIR_DISPOSITION_INCOMPLETE/);}
  mode='no_change';await manual('no-change');
  const [unchanged]=repairTasks(await processAll('no-change'),c1.objectId);assert.equal(unchanged.state,'needs_evidence');
  mode='repair';await manual('race');
  const [racing]=repairTasks(await processAll('race'),c1.objectId);assert.equal(racing.state,'waiting_for_review');
  const racingCompiled=(await owner.compilation((await owner.coordinationForTask(racing.id,purpose)).data!.compilationId!,purpose)).data;

  const before=await publications();
  const c2=(await publish(repairCompiled,'c2')).ref;
  assert.equal(c2.objectId,c1.objectId);assert.notEqual(c2.versionId,c1.versionId);assert.equal(await publications(),before+1);
  assert.equal((await owner.maintenanceTask(c1Tasks[0].id,purpose)).data.state,'completed','review completes the original repair task');
  const c2Document=(await owner.document(c2,purpose)).data;assert.equal(c2Document.status.validity.valid,true);assert.equal(c2Document.status.current,true);
  const c2Dependencies=(await pool.query<{deps:Array<{domain:string;ref:{objectId:string;versionId:string}}>}>(
   `SELECT payload->'dependencies' deps FROM ccl_knowledge_revisions WHERE object_id=$1 AND version_id=$2`,[c2.objectId,c2.versionId])).rows[0].deps;
  assert.ok(c2Dependencies.some(dep=>dep.domain==='source'&&dep.ref.versionId===a2.versionId),'C2 depends on the A2 it actually read');
  assert.ok(c2Dependencies.every(dep=>dep.ref.versionId!==a1.versionId&&dep.ref.versionId!==c1.versionId),'neither invalid A1 nor old C1 is inherited');
  const racingTicket=(await owner.requestReview({target:{kind:'candidate',candidateId:racingCompiled.candidate!.candidateId,contentHash:racingCompiled.candidate!.contentHash},purpose},
   {idempotencyKey:'ticket-race',purpose})).data;
  await assert.rejects(reviewer.decideReview(racingTicket.id,{expectedDigest:racingCompiled.candidate!.contentHash,decision:'exploration_only',reason:'Racing approval',conditions:[],gaps:[]},
   {idempotencyKey:'approve-race',purpose}),'a repair staged against the old head cannot publish after C2');
  assert.equal(await publications(),before+1,'the racing approval rolled back completely');
  const rejected=(await reviewer.decideReview(racingTicket.id,{expectedDigest:racingCompiled.candidate!.contentHash,decision:'rejected',reason:'Superseded by C2',conditions:[],gaps:[]},
   {idempotencyKey:'reject-race',purpose})).data;
  assert.equal(rejected.publication,null);assert.equal(await publications(),before+1,'a rejected repair publishes nothing');

  // An old task for C1 is now operationally stale.
  const compilerCallsBefore=repairs.length;await manual('stale');
  const [stale]=repairTasks(await processAll('stale'),c1.objectId);assert.equal(stale.state,'superseded');assert.equal(repairs.length,compilerCallsBefore);

  // Publishing C2 queues D1; D1 now replaces C1 with the current C2 and keeps valid B.
  await collect('collect-c2');
  const secondPass=await processAll('after-c2');const [dRepair]=repairTasks(secondPass,d1.objectId);
  assert.equal(dRepair.state,'waiting_for_review',JSON.stringify(dRepair.outcome));
  const dRun=(await owner.coordinationForTask(dRepair.id,purpose)).data!;
  const dCompiled=(await owner.compilation(dRun.compilationId!,purpose)).data;
  assert.ok(dCompiled.drafts[0].repair!.dependencies.some(item=>item.domain==='knowledge'&&item.ref.versionId===c1.versionId&&item.action==='replace'));
  assert.ok(dCompiled.drafts[0].repair!.dependencies.some(item=>item.domain==='source'&&item.ref.objectId===b.objectId&&item.action==='keep'));
  const d2=(await publish(dCompiled,'d2')).ref;assert.equal((await owner.document(d2,purpose)).data.status.validity.valid,true);

  // The next Ask reads C2, never the invalid C1.
  const asked=(await owner.ask({question:cKey,purpose,limit:3,maxPages:1,includeSourceContent:false,budget:{...budget(),maxModelCalls:1}},{idempotencyKey:'ask-c2',purpose})).data;
  assert.equal(asked.state,'answered',asked.reason);assert.ok(adopted.some(ref=>ref.versionId===c2.versionId));assert.ok(adopted.every(ref=>ref.versionId!==c1.versionId));

  // Revoking B makes D2 unreadable for repair: the task ends without any model call.
  const callsBeforeRevoke=repairs.length;
  await owner.revokeSource(b,{expectedGeneration:1,contentDigest:b.contentDigest},{idempotencyKey:'revoke-b',purpose});
  await collect('collect-revoke');await manual('revoked',{...d2,contentDigest:null});
  const revoked=repairTasks(await processAll('after-revoke'),d2.objectId);
  assert.ok(revoked.length>=1);assert.ok(revoked.every(task=>task.state==='needs_evidence'),JSON.stringify(revoked.map(task=>task.outcome)));
  assert.equal(repairs.length,callsBeforeRevoke,'revoked lineage sends nothing to the compiler');
 }finally{for(const server of servers)await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
