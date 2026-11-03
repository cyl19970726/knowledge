import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {seedKnowledgeSyntheticFixture} from '../../../scripts/runtime/knowledge-synthetic-fixture.ts';
import {digest} from '../../../packages/knowledge/src/utils.ts';
import {assertKnowledgeWriterAuthority,rotateKnowledgeWriterAuthority} from '../../../packages/knowledge/src/writer-authority.ts';
import {createPgSourceIntake,migrateSourceIntake} from '../../../packages/adapters/knowledge-service/src/source-intake.ts';
import {createPgSourceRegistry} from '../../../packages/adapters/knowledge-service/src/sources.ts';
import {createPgMaintenanceTasks,migrateMaintenanceTasks} from '../../../packages/adapters/knowledge-service/src/maintenance-tasks.ts';
import {SourceEventRequestSchema,type MaintenanceOutcome,type MaintenanceTaskRequest,type MaintenanceTrigger} from '../../../packages/knowledge-contracts/src/index.ts';

const databaseUrl=readTestDatabase(),dbTest=databaseUrl?test:test.skip;
const hasCode=(name:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&error.code===name;
const noDispatch:MaintenanceOutcome['cost']={modelCalls:{state:'known',value:0},tokens:{state:'known',value:0},
  money:{state:'known',amount:0,currency:'USD',source:'synthetic_no_dispatch'}};
const outcome=(state:MaintenanceOutcome['state']):MaintenanceOutcome=>({state,findingIds:[],compilationId:null,
  judgmentId:null,reason:`Synthetic ${state}`,cost:noDispatch});

dbTest('maintenance ledger atomically consumes events, fences leases and preserves uncertain writes',{timeout:120_000},async()=>{
  const admin=new pg.Pool({connectionString:databaseUrl!,max:2}),schema=`maint_tasks_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString:databaseUrl!,max:8,options:`-c search_path=${schema}`});
  try{
    const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-${randomUUID()}`,'maintenance-test');
    await migrateSourceIntake(pool);await migrateMaintenanceTasks(pool);await migrateMaintenanceTasks(pool);
    const context={scope:{projectId:seed.projectId,spaceId:seed.spaceId},principal:seed.principal,purpose:'exploration_reading'};
    const tasks=createPgMaintenanceTasks(pool,seed.writerGrant),intake=createPgSourceIntake(pool,seed.writerGrant),
      sources=createPgSourceRegistry(pool,{writerGrant:seed.writerGrant});
    const sourceEvent=async(eventKey:string)=>{
      const request=SourceEventRequestSchema.parse({adapterId:'document',eventKey,producerSequence:1,
        occurredAt:new Date().toISOString(),purpose:context.purpose,sourceRef:seed.source.ref});
      return intake.receive(context,request,digest(request),seed.source);
    };
    const event1=await sourceEvent('first-source-event');
    await pool.query(`CREATE OR REPLACE FUNCTION maintenance_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic receipt failure'; END; $$;
      CREATE TRIGGER maintenance_fail_receipt BEFORE INSERT ON ccl_knowledge_maintenance_event_receipts
      FOR EACH ROW EXECUTE FUNCTION maintenance_fail_receipt()`);
    await assert.rejects(tasks.collectEvents(context,{methodVersion:'maint-v1',rubricVersion:'rubric-v1',limit:100}));
    assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_maintenance_tasks')).rows[0].n,0,
      'task insertion rolls back with its receipt and cursor');
    assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_maintenance_cursors')).rows[0].n,0);
    await pool.query('DROP TRIGGER maintenance_fail_receipt ON ccl_knowledge_maintenance_event_receipts');
    const first=await tasks.collectEvents(context,{methodVersion:'maint-v1',rubricVersion:'rubric-v1',limit:100});
    assert.ok(first.sourceThrough>0&&first.knowledgeThrough>0);
    assert.ok(first.skipped>0);
    const initialTasks=await Promise.all(first.taskIds.map(id=>tasks.get(context,id)));
    assert.equal(initialTasks.filter(item=>item?.trigger.stream==='knowledge').length,0,
      'new Wiki heads are left for the periodic semantic sweep');
    const skippedReasons=async(spaceId=seed.spaceId)=>
      (await pool.query<{skip_reason:string}>(`SELECT skip_reason FROM ccl_knowledge_maintenance_event_receipts
        WHERE project_id=$1 AND space_id=$2 AND skip_reason IS NOT NULL`,[seed.projectId,spaceId])).rows.map(row=>row.skip_reason);
    assert.ok((await skippedReasons()).some(reason=>reason.startsWith('unmapped_knowledge_kind:')),
      'unmapped core events retain visible reasons in immutable receipts');
    const publishedEvent=(await pool.query<{sequence:string;n:number}>(`SELECT sequence,
      jsonb_array_length(data->'refs') AS n FROM ccl_knowledge_events
      WHERE project_id=$1 AND kind='KnowledgePublished' ORDER BY sequence LIMIT 1`,[seed.projectId])).rows[0];
    const publishedReceipts=(await pool.query<{n:number}>(`SELECT count(*)::int AS n
      FROM ccl_knowledge_maintenance_event_receipts WHERE project_id=$1 AND space_id=$2
        AND principal_id=$3 AND installation_id=$4 AND purpose=$5 AND stream='knowledge' AND sequence=$6
        AND ref_key LIKE 'item:%'`,
      [seed.projectId,seed.spaceId,seed.principal.id,seed.principal.clientInstallationId,
        context.purpose,publishedEvent.sequence])).rows[0].n;
    assert.equal(publishedReceipts,publishedEvent.n,'every published ref has a task or explicit skip receipt');
    assert.equal((await pool.query<{n:number}>(`SELECT count(*)::int n
      FROM ccl_knowledge_maintenance_event_receipts WHERE project_id=$1 AND sequence=$2
        AND ref_key LIKE 'item:%' AND skip_reason='published_ref_deferred_to_semantic_sweep'`,
      [seed.projectId,publishedEvent.sequence])).rows[0].n,publishedEvent.n);
    assert.ok((await skippedReasons()).includes('publication_without_superseded_deferred_to_semantic_sweep'));
    const otherSpace={...context,scope:{...context.scope,spaceId:'other-space'},
      principal:{...context.principal,spaceIds:[...context.principal.spaceIds,'other-space']}};
    const outside=await tasks.collectEvents(otherSpace,{methodVersion:'maint-v1',rubricVersion:'rubric-v1',limit:100});
    assert.deepEqual(outside.taskIds,[],'project events cannot enqueue another space\'s Wiki');
    assert.ok(outside.skipped>0);
    assert.ok((await skippedReasons('other-space')).includes('ref_outside_space'));
    const firstSource=(await Promise.all(first.taskIds.map(id=>tasks.get(context,id)))).find(item=>item?.request.kind==='source_research');
    assert.ok(firstSource);
    assert.equal(firstSource.trigger.sourceEventId,event1.id);
    const noNew=await tasks.collectEvents(context,{methodVersion:'maint-v1',rubricVersion:'rubric-v1',limit:100});
    assert.deepEqual(noNew.taskIds,[],'advanced cursors do not recreate old tasks');
    const feature=(await pool.query<{object_id:string;version_id:string}>(`SELECT h.object_id,h.version_id
      FROM ccl_knowledge_heads h JOIN ccl_knowledge_revisions r ON r.project_id=h.project_id
        AND r.object_id=h.object_id AND r.version_id=h.version_id
      WHERE h.project_id=$1 AND r.payload->'content'->'identity'->>'key'='features'`,
      [seed.projectId])).rows[0];assert.ok(feature);
    const emitKnowledge=async(kind:string,data:unknown)=>{
      const writer=await pool.connect();try{await writer.query('BEGIN');await assertKnowledgeWriterAuthority(writer,seed.projectId,seed.writerGrant);
        const seq=Number((await writer.query<{sequence:string}>(`INSERT INTO ccl_knowledge_events(project_id,kind,data)
          VALUES($1,$2,$3) RETURNING sequence`,[seed.projectId,kind,data])).rows[0].sequence);
        await writer.query('COMMIT');return seq;
      }catch(error){await writer.query('ROLLBACK');throw error;}finally{writer.release();}};
    const superseded={objectId:feature.object_id,versionId:feature.version_id};
    const publishedSeq=await emitKnowledge('KnowledgePublished',{refs:[seed.root],superseded:[superseded]});
    const publicationTasks=await tasks.collectEvents(context,{methodVersion:'maint-v1',rubricVersion:'rubric-v1',limit:100});
    const publicationPage=await Promise.all(publicationTasks.taskIds.map(id=>tasks.get(context,id)));
    assert.ok(!publicationPage.some(item=>item?.trigger.sequence===publishedSeq&&item.request.kind==='relation_check'),
      'the new ref itself never starts another relation study');
    assert.equal((await pool.query<{skip_reason:string}>(`SELECT skip_reason
      FROM ccl_knowledge_maintenance_event_receipts WHERE project_id=$1 AND sequence=$2 AND ref_key='item:1'`,
      [seed.projectId,publishedSeq])).rows[0].skip_reason,'published_ref_deferred_to_semantic_sweep');
    const repair=publicationPage.find(item=>item?.trigger.sequence===publishedSeq&&item.request.kind==='recompile'&&
      item.request.subjectRef?.objectId===seed.root.objectId);
    assert.ok(repair,'superseded feature must fan out to its current critical dependent');
    assert.equal(repair.request.sourceEventIds.length,0);
    assert.ok(repair.request.relatedRefs.some(ref=>ref.objectId===feature.object_id&&ref.versionId===feature.version_id));
    const oldSource={...context.scope,domain:'source',objectId:seed.source.ref.objectId,
      versionId:seed.source.ref.versionId,contentDigest:null};
    const sourceSeq=await emitKnowledge('SourceRegistered',{sourceRef:{objectId:randomUUID(),versionId:randomUUID()},supersedes:oldSource});
    const sourcePage=await tasks.collectEvents(context,{methodVersion:'maint-v1',rubricVersion:'rubric-v1',limit:100});
    const sourceRepairs=await Promise.all(sourcePage.taskIds.map(id=>tasks.get(context,id)));
    assert.ok(sourceRepairs.some(item=>item?.trigger.sequence===sourceSeq&&item.request.kind==='recompile'&&
      item.request.relatedRefs.some(ref=>ref.domain==='source'&&ref.objectId===oldSource.objectId)));
    assert.equal((await tasks.collectEvents(context,{methodVersion:'maint-v1',rubricVersion:'rubric-v1',limit:100})).createdCount,0,
      'the same policy does not queue an event twice');
    const nextSeq=await emitKnowledge('SourceRegistered',{sourceRef:{objectId:randomUUID(),versionId:randomUUID()},supersedes:oldSource});
    const nextSource=await tasks.collectEvents(context,{methodVersion:'maint-v1',rubricVersion:'rubric-v1',limit:100});
    assert.ok(nextSource.taskIds.length>0&&nextSource.taskIds.every(id=>!sourcePage.taskIds.includes(id)),
      `a later source replacement event ${nextSeq} has separate repair receipts`);
    const claimed=await tasks.claim(context,['source_research'],1000);
    assert.equal(claimed?.id,firstSource.id);
    assert.equal(claimed?.attempts,1);
    assert.equal(await tasks.heartbeat(context,claimed!.id,claimed!.attemptId!,claimed!.leaseToken,2000),true);
    assert.equal(await tasks.heartbeat(context,claimed!.id,randomUUID(),claimed!.leaseToken,2000),false);
    const noChange=await tasks.finish(context,claimed!.id,claimed!.attemptId!,claimed!.leaseToken,outcome('no_change'));
    assert.equal(noChange.state,'no_change');
    const event2=await sourceEvent('second-source-event');
    const second=await tasks.collectEvents(context,{methodVersion:'maint-v1',rubricVersion:'rubric-v1',limit:100});
    const secondSource=(await Promise.all(second.taskIds.map(id=>tasks.get(context,id)))).find(item=>item?.request.kind==='source_research');
    assert.ok(secondSource);
    assert.notEqual(secondSource.id,noChange.id,'new event is not swallowed by old no_change');
    assert.equal(secondSource.trigger.sourceEventId,event2.id);
    const other={...context,principal:{...context.principal,clientInstallationId:'other-installation'}};
    assert.equal(await tasks.get(other,secondSource.id),null);
    assert.deepEqual((await tasks.list(other,{limit:10})).items,[]);
    const page=await tasks.list(context,{limit:1});
    assert.equal(page.items.length,1);assert.ok(page.nextCursor);
    await assert.rejects(tasks.list(other,{limit:1,cursor:page.nextCursor!}),hasCode('MAINTENANCE_CURSOR_INVALID'));
    const lease1=await tasks.claim(context,['source_research'],1000);
    assert.equal(lease1?.id,secondSource.id);
    const expire=async(id:string)=>{const client=await pool.connect();try{await client.query('BEGIN');
      await assertKnowledgeWriterAuthority(client,seed.projectId,seed.writerGrant);
      await client.query(`UPDATE ccl_knowledge_maintenance_tasks SET lease_until=clock_timestamp()-interval '1 second'
        WHERE id=$1 AND project_id=$2`,[id,seed.projectId]);await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};
    await expire(lease1!.id);
    const lease2=await tasks.claim(context,['source_research'],1000);
    assert.equal(lease2?.id,lease1!.id);
    assert.equal(lease2?.attempts,2);assert.ok(lease2!.leaseToken>lease1!.leaseToken);
    await assert.rejects(tasks.finish(context,lease1!.id,lease1!.attemptId!,lease1!.leaseToken,outcome('completed')),
      hasCode('MAINTENANCE_LEASE_LOST'));
    assert.equal((await tasks.cancel(context,lease2!.id)).cancelRequested,true);
    assert.equal(await tasks.heartbeat(context,lease2!.id,lease2!.attemptId!,lease2!.leaseToken,1000),false);
    assert.equal((await tasks.finish(context,lease2!.id,lease2!.attemptId!,lease2!.leaseToken,outcome('cancelled'))).state,'cancelled');
    assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_maintenance_attempts WHERE task_id=$1',
      [lease2!.id])).rows[0].n,2);
    const content=await sources.readContent(context.scope,seed.source.ref,null,context);assert.ok(content);
    const mentionDigest=digest({sourceEventId:event1.id,methodVersion:'synthetic-mentions',mentions:[]});
    const mentionToken=await intake.claimMentions(context,event1.id,'synthetic-mentions',mentionDigest);
    const batchId=randomUUID();
    await intake.putMentions(context,event1,mentionDigest,{id:batchId,sourceEventId:event1.id,
      methodVersion:'synthetic-mentions',inputDigest:mentionDigest,sourceRef:event1.request.sourceRef,
      sourceGroups:seed.source.sourceGroups,mentions:[],actualReadCoverage:content.actualCoverage,
      semanticCoverage:'unknown',provenance:'caller_proposed',recordedAt:new Date().toISOString()},mentionToken);
    const mentionCollect=await tasks.collectEvents(context,{methodVersion:'maint-v1',rubricVersion:'rubric-v1',limit:100});
    const mentionTask=(await Promise.all(mentionCollect.taskIds.map(id=>tasks.get(context,id)))).find(item=>
      item?.trigger.sourceEventId===event1.id&&item.trigger.sequence!==firstSource.trigger.sequence);
    assert.ok(mentionTask);
    assert.notEqual(mentionTask.id,firstSource.id,'mentions outbox event is distinct from source registration');
    const mentionReceipt=await pool.query<{raw_event:{batchId:string}}>(`SELECT raw_event FROM ccl_knowledge_maintenance_event_receipts
      WHERE task_id=$1 AND stream='source_intake'`,[mentionTask.id]);
    assert.equal(mentionReceipt.rows[0].raw_event.batchId,batchId);
    const manualRequest:MaintenanceTaskRequest={kind:'lint_page',subjectRef:null,sourceEventIds:[],relatedRefs:[],
      reason:'Synthetic lint',methodVersion:'maint-v1',rubricVersion:'rubric-v1'};
    const manualTrigger:MaintenanceTrigger={stream:'manual',eventKey:'manual-dispatch-test',sequence:0,ref:null,sourceEventId:null};
    await assert.rejects(tasks.enqueue({...context,purpose:'ungranted-purpose'},manualRequest,manualTrigger),
      hasCode('MAINTENANCE_SCOPE_FORBIDDEN'));
    const dispatchTask=await tasks.enqueue(context,manualRequest,manualTrigger);
    assert.equal((await tasks.enqueue(context,manualRequest,manualTrigger)).id,dispatchTask.id);
    const dispatch=await tasks.claim(context,['lint_page'],1000);assert.equal(dispatch?.id,dispatchTask.id);
    await tasks.markDispatch(context,dispatch!.id,dispatch!.attemptId!,dispatch!.leaseToken,'dispatch_prepared');
    await expire(dispatch!.id);
    const expiredByGet=await tasks.get(context,dispatch!.id);
    assert.equal(expiredByGet?.state,'outcome_unknown','GET reconciles an expired paid dispatch without a processor');
    assert.equal(expiredByGet.outcome?.cost.money.state,'unknown');
    assert.equal(expiredByGet.attemptId,dispatch!.attemptId,'the original attempt remains auditable');
    assert.equal(await tasks.claim(context,['lint_page'],1000),null);
    assert.equal((await tasks.get(context,dispatch!.id))?.state,'outcome_unknown');
    await assert.rejects(tasks.finish(context,dispatch!.id,dispatch!.attemptId!,dispatch!.leaseToken,outcome('completed')),
      hasCode('MAINTENANCE_LEASE_LOST'));
    const responseTask=await tasks.enqueue(context,manualRequest,{...manualTrigger,eventKey:'response-recorded-list'});
    const responseClaim=await tasks.claim(context,['lint_page'],1000);assert.equal(responseClaim?.id,responseTask.id);
    await tasks.markDispatch(context,responseClaim!.id,responseClaim!.attemptId!,responseClaim!.leaseToken,'dispatch_prepared');
    const acknowledged:MaintenanceOutcome={state:'completed',findingIds:[randomUUID()],compilationId:randomUUID(),
      judgmentId:randomUUID(),reason:'Synthetic processor returned an actual result',cost:{
        modelCalls:{state:'known',value:1},tokens:{state:'known',value:42},
        money:{state:'known',amount:1.25,currency:'USD',source:'synthetic_invoice'}}};
    await assert.rejects(tasks.markDispatch(context,responseClaim!.id,responseClaim!.attemptId!,responseClaim!.leaseToken,
      'response_recorded'),hasCode('MAINTENANCE_ACKNOWLEDGEMENT_REQUIRED'));
    await tasks.markDispatch(context,responseClaim!.id,responseClaim!.attemptId!,responseClaim!.leaseToken,
      'response_recorded',acknowledged);
    const beforeCrash=await tasks.get(context,responseClaim!.id);
    assert.equal(beforeCrash?.state,'running');assert.deepEqual(beforeCrash?.outcome,acknowledged);
    assert.deepEqual((await pool.query<{outcome:MaintenanceOutcome}>(`SELECT outcome FROM ccl_knowledge_maintenance_attempts
      WHERE attempt_id=$1`,[responseClaim!.attemptId])).rows[0].outcome,acknowledged,
    'response and attempt outcome commit together before finish');
    await assert.rejects(tasks.markDispatch(context,responseClaim!.id,responseClaim!.attemptId!,responseClaim!.leaseToken,
      'response_recorded',{...acknowledged,findingIds:[]}),hasCode('MAINTENANCE_OUTCOME_CONFLICT'));
    assert.equal((await tasks.cancel(context,responseClaim!.id)).cancelRequested,true);
    await expire(responseClaim!.id);
    let listed=await tasks.list(context,{limit:100});
    let afterCrash=listed.items.find(item=>item.id===responseClaim!.id);
    for(let page=0;!afterCrash&&listed.hasMore&&page<20;page++){
      listed=await tasks.list(context,{limit:100,cursor:listed.nextCursor!});
      afterCrash=listed.items.find(item=>item.id===responseClaim!.id);
    }
    assert.equal(afterCrash?.state,'outcome_unknown',
      'LIST reconciles response_recorded expiry without re-execution');
    assert.deepEqual(afterCrash?.outcome?.findingIds,acknowledged.findingIds);
    assert.equal(afterCrash?.outcome?.compilationId,acknowledged.compilationId);
    assert.equal(afterCrash?.outcome?.judgmentId,acknowledged.judgmentId);
    assert.deepEqual(afterCrash?.outcome?.cost,acknowledged.cost);
    assert.equal((await tasks.get(context,responseClaim!.id))?.outcome?.cost.money.state,'known');
    assert.equal(await tasks.claim(context,['lint_page'],1000),null,'recorded response is never claimed again');
    const interruptedTask=await tasks.enqueue(context,manualRequest,{...manualTrigger,eventKey:'response-then-interrupted'});
    const interruptedClaim=await tasks.claim(context,['lint_page'],1000);assert.equal(interruptedClaim?.id,interruptedTask.id);
    await tasks.markDispatch(context,interruptedClaim!.id,interruptedClaim!.attemptId!,interruptedClaim!.leaseToken,
      'dispatch_prepared');
    await tasks.markDispatch(context,interruptedClaim!.id,interruptedClaim!.attemptId!,interruptedClaim!.leaseToken,
      'response_recorded',acknowledged);
    const interrupted=await tasks.finish(context,interruptedClaim!.id,interruptedClaim!.attemptId!,
      interruptedClaim!.leaseToken,outcome('outcome_unknown'));
    assert.equal(interrupted.state,'outcome_unknown');
    assert.deepEqual(interrupted.outcome?.findingIds,acknowledged.findingIds);
    assert.equal(interrupted.outcome?.compilationId,acknowledged.compilationId);
    assert.equal(interrupted.outcome?.judgmentId,acknowledged.judgmentId);
    assert.deepEqual(interrupted.outcome?.cost,acknowledged.cost,
      'an interrupted finish cannot replace acknowledged cost and references');
    const preDispatchTask=await tasks.enqueue(context,manualRequest,{...manualTrigger,eventKey:'undispatched-get'});
    const preDispatch=await tasks.claim(context,['lint_page'],1000);assert.equal(preDispatch?.id,preDispatchTask.id);
    await expire(preDispatch!.id);
    const requeued=await tasks.get(context,preDispatch!.id);
    assert.equal(requeued?.state,'queued');assert.equal(requeued?.attemptId,null);
    assert.equal(requeued?.attempts,1);
    const nextAttempt=await tasks.claim(context,['lint_page'],1000);assert.equal(nextAttempt?.id,preDispatch!.id);
    assert.ok(nextAttempt!.leaseToken>preDispatch!.leaseToken);
    await tasks.finish(context,nextAttempt!.id,nextAttempt!.attemptId!,nextAttempt!.leaseToken,outcome('no_change'));
    const collectTask=await tasks.enqueue(context,manualRequest,{...manualTrigger,eventKey:'dispatch-collect'});
    const collectClaim=await tasks.claim(context,['lint_page'],1000);assert.equal(collectClaim?.id,collectTask.id);
    await tasks.markDispatch(context,collectClaim!.id,collectClaim!.attemptId!,collectClaim!.leaseToken,'dispatch_prepared');
    await expire(collectClaim!.id);
    await tasks.collectEvents(context,{methodVersion:'maint-v1',rubricVersion:'rubric-v1',limit:100});
    assert.equal((await tasks.get(context,collectClaim!.id))?.state,'outcome_unknown',
      'event collection reconciles expired dispatch even with no processor');
    const threeTrigger={...manualTrigger,eventKey:'manual-three-expiries'};
    const three=await tasks.enqueue(context,manualRequest,threeTrigger);
    for(let n=1;n<=3;n++){const attempt=await tasks.claim(context,['lint_page'],1000);
      assert.equal(attempt?.id,three.id);assert.equal(attempt.attempts,n);await expire(attempt.id);}
    assert.equal(await tasks.claim(context,['lint_page'],1000),null);
    assert.equal((await tasks.get(context,three.id))?.state,'failed');
    const cancelQueued=await tasks.enqueue(context,manualRequest,{...manualTrigger,eventKey:'manual-cancel-queued'});
    assert.equal((await tasks.cancel(context,cancelQueued.id)).state,'cancelled');
    const eventWrite=await pool.connect();try{await eventWrite.query('BEGIN');
      await assertKnowledgeWriterAuthority(eventWrite,seed.projectId,seed.writerGrant);
      await eventWrite.query(`INSERT INTO ccl_knowledge_events(project_id,kind,data) VALUES($1,'UnmappedSyntheticEvent',$2)`,
        [seed.projectId,{marker:'metadata-only'}]);await eventWrite.query('COMMIT');
    }catch(error){await eventWrite.query('ROLLBACK');throw error;}finally{eventWrite.release();}
    const unknown=await tasks.collectEvents(context,{methodVersion:'maint-v1',rubricVersion:'rubric-v1',limit:100});
    assert.ok(unknown.skipped>0);
    assert.ok((await skippedReasons()).includes('unmapped_knowledge_kind:UnmappedSyntheticEvent'));
    await sources.revoke({...context,authorization:seed.authorization},seed.source.ref,1,'synthetic-revoke');
    const revocation=await tasks.collectEvents(context,{methodVersion:'maint-v1',rubricVersion:'rubric-v1',limit:100});
    const recompile=(await Promise.all(revocation.taskIds.map(id=>tasks.get(context,id)))).filter(item=>
      item?.request.kind==='recompile');
    assert.ok(recompile.length>0,'source withdrawal creates tasks for affected current Wiki revisions');
    assert.ok(recompile.every(item=>item?.trigger.stream==='knowledge'));
    const newRubric=await tasks.collectEvents(context,{methodVersion:'maint-v1',rubricVersion:'rubric-v2',limit:100});
    assert.ok(newRubric.createdCount!>0,'a new rubric reconsumes prior source events despite the old watermark');
    assert.equal(newRubric.createdCount,newRubric.taskIds.length);
    const replayedSource=(await Promise.all(newRubric.taskIds.map(id=>tasks.get(context,id)))).find(item=>
      item?.trigger.sourceEventId===event1.id&&item.trigger.sequence===firstSource.trigger.sequence);
    assert.ok(replayedSource);
    assert.notEqual(replayedSource.id,firstSource.id);
    assert.equal(replayedSource.request.rubricVersion,'rubric-v2');
    const policyReceipts=await pool.query<{n:number}>(`SELECT count(DISTINCT policy_fingerprint)::int n
      FROM ccl_knowledge_maintenance_event_receipts WHERE task_id IN ($1,$2)`,[firstSource.id,replayedSource.id]);
    assert.equal(policyReceipts.rows[0].n,2,'original event receipts remain separate by policy');
    let rubricPage=newRubric;
    for(let page=0;rubricPage.hasMore&&page<20;page++)
      rubricPage=await tasks.collectEvents(context,{methodVersion:'maint-v1',rubricVersion:'rubric-v2',limit:100});
    assert.equal(rubricPage.hasMore,false,'the new rubric consumes every bounded event page');
    const sameRubric=await tasks.collectEvents(context,{methodVersion:'maint-v1',rubricVersion:'rubric-v2',limit:100});
    assert.equal(sameRubric.createdCount,0);assert.deepEqual(sameRubric.taskIds,[]);
    const periodic={...manualTrigger,stream:'periodic' as const,eventKey:'same-periodic-event'};
    const oldPeriodic=await tasks.enqueue(context,manualRequest,periodic);
    assert.equal((await tasks.enqueue(context,manualRequest,periodic)).id,oldPeriodic.id);
    const newPeriodic=await tasks.enqueue(context,{...manualRequest,methodVersion:'maint-v2'},periodic);
    assert.notEqual(newPeriodic.id,oldPeriodic.id,'method upgrade cannot conflict with the old periodic task');
    const fanoutPolicy={methodVersion:'fanout-v1',rubricVersion:'rubric-v1',limit:500};
    const baseline=await tasks.collectEvents(context,fanoutPolicy);
    const eventClient=await pool.connect();let bigSeq:number,sentinelSeq:number;
    try{await eventClient.query('BEGIN');await assertKnowledgeWriterAuthority(eventClient,seed.projectId,seed.writerGrant);
      bigSeq=Number((await eventClient.query<{sequence:string}>(`INSERT INTO ccl_knowledge_events(project_id,kind,data)
        SELECT project_id,kind,data FROM ccl_knowledge_events WHERE project_id=$1 AND sequence=$2
        RETURNING sequence`,[seed.projectId,publishedEvent.sequence])).rows[0].sequence);
      sentinelSeq=Number((await eventClient.query<{sequence:string}>(`INSERT INTO ccl_knowledge_events(project_id,kind,data)
        VALUES($1,'UnmappedSyntheticEvent',$2) RETURNING sequence`,[seed.projectId,{marker:'after-large-event'}])).rows[0].sequence);
      await eventClient.query('COMMIT');
    }catch(error){await eventClient.query('ROLLBACK');throw error;}finally{eventClient.release();}
    assert.ok(publishedEvent.n>7,'fixture provides one event larger than the seven-ref page');
    const fanoutPage=await tasks.collectEvents(context,{...fanoutPolicy,limit:7});
    assert.equal(fanoutPage.knowledgeThrough,baseline.knowledgeThrough,'main cursor stays before the pending event');
    assert.ok(fanoutPage.hasMore);assert.ok(fanoutPage.taskIds.length<=7);
    const position=async()=>(await pool.query<{sequence:string;pending_sequence:string|null;pending_offset:string}>(`
      SELECT sequence,pending_sequence,pending_offset FROM ccl_knowledge_maintenance_cursors
      WHERE project_id=$1 AND space_id=$2 AND principal_id=$3 AND installation_id=$4
        AND purpose=$5 AND stream='knowledge' AND policy_fingerprint=$6`,[seed.projectId,seed.spaceId,
      seed.principal.id,seed.principal.clientInstallationId,context.purpose,
      digest({methodVersion:fanoutPolicy.methodVersion,rubricVersion:fanoutPolicy.rubricVersion})])).rows[0];
    assert.equal(Number((await position()).pending_sequence),bigSeq);
    assert.equal(Number((await position()).pending_offset),7);
    const itemReceipts=async()=>(await pool.query<{n:number}>(`SELECT count(*)::int n
      FROM ccl_knowledge_maintenance_event_receipts WHERE project_id=$1 AND sequence=$2
        AND ref_key LIKE 'item:%' AND policy_fingerprint=$3`,[seed.projectId,bigSeq,
      digest({methodVersion:fanoutPolicy.methodVersion,rubricVersion:fanoutPolicy.rubricVersion})])).rows[0].n;
    assert.equal(await itemReceipts(),7);
    await pool.query(`CREATE OR REPLACE FUNCTION maintenance_fail_page() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.ref_key='item:8' THEN RAISE EXCEPTION 'synthetic second-page failure'; END IF;
      RETURN NEW; END; $$;
      CREATE TRIGGER maintenance_fail_page BEFORE INSERT ON ccl_knowledge_maintenance_event_receipts
      FOR EACH ROW EXECUTE FUNCTION maintenance_fail_page()`);
    await assert.rejects(tasks.collectEvents(context,{...fanoutPolicy,limit:7}));
    assert.equal(Number((await position()).pending_offset),7,'failed page does not advance committed offset');
    assert.equal(await itemReceipts(),7,'failed page leaves no partial task receipts');
    await pool.query('DROP TRIGGER maintenance_fail_page ON ccl_knowledge_maintenance_event_receipts');
    const restarted=createPgMaintenanceTasks(pool,seed.writerGrant),seen=new Set(fanoutPage.taskIds);
    let finalThrough=baseline.knowledgeThrough;
    for(let round=0;round<10&&finalThrough<bigSeq;round++){
      const page=await restarted.collectEvents(context,{...fanoutPolicy,limit:7});
      assert.ok(page.taskIds.length<=7,'Node return and per-call work remain bounded');
      for(const id of page.taskIds){assert.ok(!seen.has(id));seen.add(id);}
      finalThrough=page.knowledgeThrough;
      if(finalThrough<bigSeq)assert.equal(Number((await position()).pending_sequence),bigSeq);
    }
    assert.ok(finalThrough>=bigSeq,'all pages eventually advance the original event cursor');
    assert.equal(await itemReceipts(),publishedEvent.n,'every original ref has one committed receipt');
    assert.ok(finalThrough<=sentinelSeq);
    assert.equal((await pool.query<{n:number}>(`SELECT count(*)::int n FROM ccl_knowledge_maintenance_event_receipts
      WHERE project_id=$1 AND sequence=$2 AND ref_key='event:raw'`,[seed.projectId,bigSeq])).rows[0].n,1,
    'full original event is stored once in SQL');
    const receiptShape=await pool.query<{original_matches:boolean;item_has_data:boolean}>(`
      SELECT (raw.raw_event->'data'=e.data) AS original_matches,
        (item.raw_event ? 'data') AS item_has_data
      FROM ccl_knowledge_events e
      JOIN ccl_knowledge_maintenance_event_receipts raw ON raw.project_id=e.project_id
        AND raw.sequence=e.sequence AND raw.ref_key='event:raw'
      JOIN ccl_knowledge_maintenance_event_receipts item ON item.project_id=e.project_id
        AND item.sequence=e.sequence AND item.ref_key='item:1'
      WHERE e.project_id=$1 AND e.sequence=$2`,[seed.projectId,bigSeq]);
    assert.equal(receiptShape.rows[0].original_matches,true);
    assert.equal(receiptShape.rows[0].item_has_data,false,'per-ref rows never repeat the full event payload');
    const remaining=await restarted.collectEvents(context,{...fanoutPolicy,limit:7});
    assert.ok(remaining.knowledgeThrough>=sentinelSeq,'later event becomes eligible after all refs finish');
    assert.equal((await restarted.collectEvents(context,{...fanoutPolicy,limit:7})).createdCount,0);
    const revocationCopy=await pool.connect();let revokeSeq:number;
    try{await revocationCopy.query('BEGIN');await assertKnowledgeWriterAuthority(revocationCopy,seed.projectId,seed.writerGrant);
      revokeSeq=Number((await revocationCopy.query<{sequence:string}>(`INSERT INTO ccl_knowledge_events(project_id,kind,data)
        SELECT project_id,kind,data FROM ccl_knowledge_events
        WHERE project_id=$1 AND kind='SourceRightsRevoked' ORDER BY sequence DESC LIMIT 1
        RETURNING sequence`,[seed.projectId])).rows[0].sequence);
      await revocationCopy.query('COMMIT');
    }catch(error){await revocationCopy.query('ROLLBACK');throw error;}finally{revocationCopy.release();}
    const affectedCount=Number((await pool.query<{n:string}>(`WITH RECURSIVE affected(object_id,version_id) AS (
      SELECT object_id,version_id FROM ccl_knowledge_deps WHERE project_id=$1 AND domain='source'
        AND dep_object_id=$2 AND dep_version_id=$3 AND critical=true
      UNION
      SELECT d.object_id,d.version_id FROM ccl_knowledge_deps d JOIN affected a
        ON d.project_id=$1 AND d.domain='knowledge' AND d.dep_object_id=a.object_id
        AND d.dep_version_id=a.version_id AND d.critical=true
    ) SELECT count(*)::text n FROM affected`,[seed.projectId,seed.source.ref.objectId,seed.source.ref.versionId])).rows[0].n);
    assert.ok(affectedCount>7,'synthetic source has more affected Wiki revisions than one page');
    let recursiveCalls=0;
    const spyPool={query:pool.query.bind(pool),connect:async()=>{
      const client=await pool.connect();
      return new Proxy(client,{get(target,property){if(property==='release')return target.release.bind(target);
        if(property!=='query')return Reflect.get(target,property);
        return async(...args:unknown[])=>{if(typeof args[0]==='string'&&args[0].includes('WITH RECURSIVE affected'))
          recursiveCalls++;
          return Reflect.apply(target.query,target,args);};}});
    }} as unknown as pg.Pool;
    const spiedTasks=createPgMaintenanceTasks(spyPool,seed.writerGrant);
    const revokeFirst=await spiedTasks.collectEvents(context,{...fanoutPolicy,limit:7});
    assert.ok(revokeFirst.knowledgeThrough<revokeSeq);
    assert.equal(Number((await position()).pending_sequence),revokeSeq);
    assert.ok(revokeFirst.taskIds.length<=7);
    assert.equal(recursiveCalls,1);
    const materialized=async(seq:number)=>(await pool.query<{ref_count:string}>(`
      SELECT ref_count FROM ccl_knowledge_maintenance_revocation_sets
      WHERE project_id=$1 AND space_id=$2 AND principal_id=$3 AND installation_id=$4
        AND purpose=$5 AND policy_fingerprint=$6 AND sequence=$7`,[seed.projectId,seed.spaceId,
      seed.principal.id,seed.principal.clientInstallationId,context.purpose,
      digest({methodVersion:fanoutPolicy.methodVersion,rubricVersion:fanoutPolicy.rubricVersion}),seq])).rows[0];
    assert.equal(Number((await materialized(revokeSeq)).ref_count),affectedCount);
    await pool.query(`CREATE OR REPLACE FUNCTION maintenance_fail_revocation_page() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.sequence=${revokeSeq} AND NEW.ref_key='item:8' THEN
        RAISE EXCEPTION 'synthetic revocation page failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER maintenance_fail_revocation_page BEFORE INSERT ON ccl_knowledge_maintenance_event_receipts
      FOR EACH ROW EXECUTE FUNCTION maintenance_fail_revocation_page()`);
    await assert.rejects(spiedTasks.collectEvents(context,{...fanoutPolicy,limit:7}));
    assert.equal(Number((await position()).pending_offset),7);
    assert.equal(Number((await materialized(revokeSeq)).ref_count),affectedCount,
      'page rollback retains the earlier committed materialization');
    await pool.query('DROP TRIGGER maintenance_fail_revocation_page ON ccl_knowledge_maintenance_event_receipts');
    const resumedRevocation=createPgMaintenanceTasks(spyPool,seed.writerGrant);
    let revokeThrough=revokeFirst.knowledgeThrough;
    for(let round=0;round<20&&revokeThrough<revokeSeq;round++){
      const page=await resumedRevocation.collectEvents(context,{...fanoutPolicy,limit:7});
      assert.ok(page.taskIds.length<=7);revokeThrough=page.knowledgeThrough;
    }
    assert.equal(revokeThrough,revokeSeq);
    assert.equal(recursiveCalls,1,'all later pages use materialized ordinal reads');
    assert.equal((await pool.query<{n:number}>(`SELECT count(*)::int n FROM ccl_knowledge_maintenance_event_receipts
      WHERE project_id=$1 AND sequence=$2 AND ref_key LIKE 'item:%'`,[seed.projectId,revokeSeq])).rows[0].n,
    affectedCount,'recursive revocation closure is completely receipted across bounded pages');
    const emptyClient=await pool.connect();let emptySeq:number;
    try{await emptyClient.query('BEGIN');await assertKnowledgeWriterAuthority(emptyClient,seed.projectId,seed.writerGrant);
      emptySeq=Number((await emptyClient.query<{sequence:string}>(`INSERT INTO ccl_knowledge_events(project_id,kind,data)
        VALUES($1,'SourceRightsRevoked',$2) RETURNING sequence`,[seed.projectId,
        {ref:{objectId:randomUUID(),versionId:randomUUID()}}])).rows[0].sequence);
      await emptyClient.query('COMMIT');
    }catch(error){await emptyClient.query('ROLLBACK');throw error;}finally{emptyClient.release();}
    const emptyResult=await resumedRevocation.collectEvents(context,{...fanoutPolicy,limit:7});
    assert.equal(emptyResult.knowledgeThrough,emptySeq);
    assert.equal(Number((await materialized(emptySeq)).ref_count),0,'empty closure commits a durable marker');
    assert.equal(recursiveCalls,2);
    await resumedRevocation.collectEvents(context,{...fanoutPolicy,limit:7});
    assert.equal(recursiveCalls,2,'empty event is not recursively scanned again');
    const lostCommitPool={query:pool.query.bind(pool),connect:async()=>{
      const client=await pool.connect();let thrown=false;
      return new Proxy(client,{get(target,property){if(property==='release')return target.release.bind(target);
        if(property!=='query')return Reflect.get(target,property);
        return async(...args:unknown[])=>{const result=await Reflect.apply(target.query,target,args);
          if(args[0]==='COMMIT'&&!thrown){thrown=true;throw new Error('synthetic commit acknowledgement lost');}
          return result;};}});
    }} as unknown as pg.Pool;
    const unknownPort=createPgMaintenanceTasks(lostCommitPool,seed.writerGrant);
    const lostTrigger={...manualTrigger,eventKey:'manual-lost-commit'};
    await assert.rejects(unknownPort.enqueue(context,manualRequest,lostTrigger),
      (error:unknown)=>!!error&&typeof error==='object'&&'commitStatus'in error&&error.commitStatus==='unknown');
    const saved=await tasks.enqueue(context,manualRequest,lostTrigger);
    assert.equal(saved.trigger.eventKey,lostTrigger.eventKey);
    assert.equal((await pool.query<{n:number}>(`SELECT count(*)::int n FROM ccl_knowledge_maintenance_tasks
      WHERE project_id=$1 AND space_id=$2 AND principal_id=$3 AND installation_id=$4 AND purpose=$5
        AND trigger->>'eventKey'=$6`,[seed.projectId,seed.spaceId,seed.principal.id,
      seed.principal.clientInstallationId,context.purpose,lostTrigger.eventKey])).rows[0].n,1);
    await rotateKnowledgeWriterAuthority(pool,seed.projectId,seed.writerGrant.generation,
      {ownerId:seed.writerGrant.ownerId,mode:'read_only'},seed.writerGrant);
    await assert.rejects(tasks.enqueue(context,manualRequest,{...manualTrigger,eventKey:'writer-read-only'}),
      hasCode('KNOWLEDGE_WRITER_REVOKED'));
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});

dbTest('publication fanout is materialized once, paged without losing offsets and isolated by space',
  {timeout:90_000},async()=>{
    const admin=new pg.Pool({connectionString:databaseUrl!,max:2}),schema=`maint_fanout_${randomUUID().replaceAll('-','')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool=new pg.Pool({connectionString:databaseUrl!,max:8,options:`-c search_path=${schema}`});
    try{
      const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-${randomUUID()}`,'maintenance-fanout');
      await migrateSourceIntake(pool);await migrateMaintenanceTasks(pool);
      const context={scope:{projectId:seed.projectId,spaceId:seed.spaceId},principal:seed.principal,purpose:'exploration_reading'};
      const tasks=createPgMaintenanceTasks(pool,seed.writerGrant);
      const policy={methodVersion:'fanout-v1',rubricVersion:'fanout-r1',limit:500};
      await tasks.collectEvents(context,policy);
      const heads=(await pool.query<{object_id:string;version_id:string;identity_key:string}>(`
        SELECT h.object_id,h.version_id,r.payload->'content'->'identity'->>'key' AS identity_key
        FROM ccl_knowledge_heads h JOIN ccl_knowledge_revisions r
          ON r.project_id=h.project_id AND r.object_id=h.object_id AND r.version_id=h.version_id
        WHERE h.project_id=$1 AND r.kind='wiki_page' ORDER BY h.object_id`,[seed.projectId])).rows;
      assert.equal(heads.length,32);
      const feature=heads.find(row=>row.identity_key==='features');assert.ok(feature);
      const writer=await pool.connect();let sequence:number;
      try{await writer.query('BEGIN');await assertKnowledgeWriterAuthority(writer,seed.projectId,seed.writerGrant);
        sequence=Number((await writer.query<{sequence:string}>(`
          INSERT INTO ccl_knowledge_events(project_id,kind,data) VALUES($1,'KnowledgePublished',$2)
          RETURNING sequence`,[seed.projectId,{refs:heads.map(row=>({objectId:row.object_id,versionId:row.version_id})),
          superseded:[{objectId:feature.object_id,versionId:feature.version_id},
            {objectId:feature.object_id,versionId:feature.version_id}]}])).rows[0].sequence);
        await writer.query('COMMIT');
      }catch(error){await writer.query('ROLLBACK');throw error;}finally{writer.release();}
      const fingerprint=digest({methodVersion:policy.methodVersion,rubricVersion:policy.rubricVersion});
      const set=async()=>(await pool.query<{ref_count:string}>(`
        SELECT ref_count FROM ccl_knowledge_maintenance_fanout_sets
        WHERE project_id=$1 AND space_id=$2 AND principal_id=$3 AND installation_id=$4
          AND purpose=$5 AND policy_fingerprint=$6 AND sequence=$7`,[seed.projectId,seed.spaceId,
          seed.principal.id,seed.principal.clientInstallationId,context.purpose,fingerprint,sequence])).rows[0];
      await pool.query(`CREATE FUNCTION fail_fanout_first() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.sequence=${sequence} THEN RAISE EXCEPTION 'synthetic first fanout page failure'; END IF;
        RETURN NEW; END $$;
        CREATE TRIGGER fail_fanout_first BEFORE INSERT ON ccl_knowledge_maintenance_event_receipts
        FOR EACH ROW EXECUTE FUNCTION fail_fanout_first()`);
      await assert.rejects(tasks.collectEvents(context,{...policy,limit:7}),/synthetic first fanout page failure/);
      assert.equal(await set(),undefined,'first page rollback removes its materialized closure marker');
      await pool.query('DROP TRIGGER fail_fanout_first ON ccl_knowledge_maintenance_event_receipts; DROP FUNCTION fail_fanout_first()');
      const first=await tasks.collectEvents(context,{...policy,limit:7});
      assert.ok(first.knowledgeThrough<sequence);
      const total=Number((await set()).ref_count);assert.ok(total>32,'new refs and the affected closure have separate slots');
      const position=async()=>(await pool.query<{pending_sequence:string;pending_offset:number}>(`
        SELECT pending_sequence,pending_offset FROM ccl_knowledge_maintenance_cursors
        WHERE project_id=$1 AND space_id=$2 AND principal_id=$3 AND installation_id=$4
          AND purpose=$5 AND policy_fingerprint=$6 AND stream='knowledge'`,[seed.projectId,seed.spaceId,
          seed.principal.id,seed.principal.clientInstallationId,context.purpose,fingerprint])).rows[0];
      assert.equal(Number((await position()).pending_sequence),sequence);
      assert.equal(Number((await position()).pending_offset),7);
      const legacy=await pool.connect();
      try{await legacy.query('BEGIN');await assertKnowledgeWriterAuthority(legacy,seed.projectId,seed.writerGrant);
        await legacy.query(`DELETE FROM ccl_knowledge_maintenance_fanout_refs
          WHERE project_id=$1 AND space_id=$2 AND sequence=$3`,[seed.projectId,seed.spaceId,sequence]);
        await legacy.query(`DELETE FROM ccl_knowledge_maintenance_fanout_sets
          WHERE project_id=$1 AND space_id=$2 AND sequence=$3`,[seed.projectId,seed.spaceId,sequence]);
        await legacy.query('COMMIT');
      }catch(error){await legacy.query('ROLLBACK');throw error;}finally{legacy.release();}
      assert.equal(await set(),undefined,'a legacy pending cursor may predate the new fanout table');
      await pool.query(`CREATE FUNCTION fail_fanout_resume() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.sequence=${sequence} AND NEW.ref_key='item:8' THEN
          RAISE EXCEPTION 'synthetic resumed fanout page failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER fail_fanout_resume BEFORE INSERT ON ccl_knowledge_maintenance_event_receipts
        FOR EACH ROW EXECUTE FUNCTION fail_fanout_resume()`);
      await assert.rejects(tasks.collectEvents(context,{...policy,limit:7}),/synthetic resumed fanout page failure/);
      assert.equal(Number((await position()).pending_offset),7);
      assert.equal(await set(),undefined,'failed legacy resume rolls back its new materialization');
      await pool.query('DROP TRIGGER fail_fanout_resume ON ccl_knowledge_maintenance_event_receipts; DROP FUNCTION fail_fanout_resume()');
      const restarted=createPgMaintenanceTasks(pool,seed.writerGrant);
      const seen=new Set(first.taskIds);let through=first.knowledgeThrough;
      const resumed=await restarted.collectEvents(context,{...policy,limit:7});
      assert.equal(Number((await set()).ref_count),total);
      assert.equal(Number((await position()).pending_offset),14,'legacy offset resumes from the original refs ordinals');
      for(const id of resumed.taskIds){assert.ok(!seen.has(id));seen.add(id);}
      through=resumed.knowledgeThrough;
      await pool.query(`CREATE FUNCTION fail_fanout_later() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.sequence=${sequence} AND NEW.ref_key='item:15' THEN
          RAISE EXCEPTION 'synthetic later fanout page failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER fail_fanout_later BEFORE INSERT ON ccl_knowledge_maintenance_event_receipts
        FOR EACH ROW EXECUTE FUNCTION fail_fanout_later()`);
      await assert.rejects(restarted.collectEvents(context,{...policy,limit:7}),/synthetic later fanout page failure/);
      assert.equal(Number((await position()).pending_offset),14);
      assert.equal(Number((await set()).ref_count),total,'later rollback retains committed materialization');
      await pool.query('DROP TRIGGER fail_fanout_later ON ccl_knowledge_maintenance_event_receipts; DROP FUNCTION fail_fanout_later()');
      for(let round=0;round<20&&through<sequence;round++){
        const page=await restarted.collectEvents(context,{...policy,limit:7});
        for(const id of page.taskIds){assert.ok(!seen.has(id));seen.add(id);}
        through=page.knowledgeThrough;
      }
      assert.equal(through,sequence);
      assert.equal((await pool.query<{n:number}>(`SELECT count(*)::int n FROM ccl_knowledge_maintenance_event_receipts
        WHERE project_id=$1 AND space_id=$2 AND sequence=$3 AND ref_key LIKE 'item:%'`,
        [seed.projectId,seed.spaceId,sequence])).rows[0].n,total);
      assert.equal((await pool.query<{n:number}>(`SELECT count(*)::int n FROM (
        SELECT object_id,version_id FROM ccl_knowledge_maintenance_fanout_refs
        WHERE project_id=$1 AND space_id=$2 AND sequence=$3 AND action='recompile'
        GROUP BY object_id,version_id HAVING count(*)>1) duplicate`,
        [seed.projectId,seed.spaceId,sequence])).rows[0].n,0,'repeated superseded roots do not duplicate repair targets');
      const items=(await Promise.all([...seen].map(id=>restarted.get(context,id)))).filter(item=>item?.trigger.sequence===sequence);
      assert.ok(items.length>0&&items.every(item=>item?.request.kind==='recompile'),
        'only current dependents of the superseded revision become repair tasks');
      assert.equal((await pool.query<{n:number}>(`SELECT count(*)::int n
        FROM ccl_knowledge_maintenance_event_receipts WHERE project_id=$1 AND sequence=$2
          AND skip_reason='published_ref_deferred_to_semantic_sweep'`,
        [seed.projectId,sequence])).rows[0].n,32,'all new refs retain explicit skip receipts');
      assert.equal((await restarted.collectEvents(context,{...policy,limit:7})).createdCount,0);
      const otherSpace={...context,scope:{...context.scope,spaceId:'other-space'},
        principal:{...context.principal,spaceIds:[...context.principal.spaceIds,'other-space']}};
      const outside=await restarted.collectEvents(otherSpace,{...policy,limit:500});
      assert.equal(outside.createdCount,0,'cross-space event fanout does not create repair or relation tasks');
      assert.ok(outside.skipped>0);
      const emptyWriter=await pool.connect();let emptySequence:number;
      try{await emptyWriter.query('BEGIN');await assertKnowledgeWriterAuthority(emptyWriter,seed.projectId,seed.writerGrant);
        emptySequence=Number((await emptyWriter.query<{sequence:string}>(`
          INSERT INTO ccl_knowledge_events(project_id,kind,data) VALUES($1,'SourceRegistered',$2)
          RETURNING sequence`,[seed.projectId,{sourceRef:{objectId:randomUUID(),versionId:randomUUID()},
          supersedes:{...context.scope,domain:'source',objectId:randomUUID(),versionId:randomUUID()}}])).rows[0].sequence);
        await emptyWriter.query('COMMIT');
      }catch(error){await emptyWriter.query('ROLLBACK');throw error;}finally{emptyWriter.release();}
      const empty=await restarted.collectEvents(context,{...policy,limit:7});
      assert.equal(empty.knowledgeThrough,emptySequence);
      assert.equal((await pool.query<{ref_count:string}>(`SELECT ref_count FROM ccl_knowledge_maintenance_fanout_sets
        WHERE project_id=$1 AND space_id=$2 AND sequence=$3`,[seed.projectId,seed.spaceId,emptySequence])).rows[0].ref_count,'0',
      'empty source replacement closure has a durable marker');
      assert.equal(empty.createdCount,0);
      const sourceWriter=await pool.connect();let sourceSequence:number;
      try{await sourceWriter.query('BEGIN');await assertKnowledgeWriterAuthority(sourceWriter,seed.projectId,seed.writerGrant);
        sourceSequence=Number((await sourceWriter.query<{sequence:string}>(`
          INSERT INTO ccl_knowledge_events(project_id,kind,data) VALUES($1,'SourceRegistered',$2)
          RETURNING sequence`,[seed.projectId,{sourceRef:{objectId:seed.source.ref.objectId,versionId:randomUUID()},
          supersedes:{...context.scope,domain:'source',objectId:seed.source.ref.objectId,
            versionId:seed.source.ref.versionId}}])).rows[0].sequence);
        await sourceWriter.query('COMMIT');
      }catch(error){await sourceWriter.query('ROLLBACK');throw error;}finally{sourceWriter.release();}
      let sourceThrough=empty.knowledgeThrough,sourceCreated=0;
      for(let round=0;round<20&&sourceThrough<sourceSequence;round++){
        const page=await restarted.collectEvents(context,{...policy,limit:7});
        assert.ok(page.taskIds.length<=7);
        const queued=await Promise.all(page.taskIds.map(id=>restarted.get(context,id)));
        assert.ok(queued.every(item=>item?.request.kind==='recompile'&&item.trigger.sequence===sourceSequence));
        sourceCreated+=page.createdCount??page.taskIds.length;sourceThrough=page.knowledgeThrough;
      }
      assert.equal(sourceThrough,sourceSequence);
      assert.ok(sourceCreated>7,'source replacement critical closure is also paged and durable');
    }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
  });
