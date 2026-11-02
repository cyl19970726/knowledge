import type {PoolClient} from 'pg';
import {CoordinationRunSchema,MaintenanceTaskSchema,MaintenanceOutcomeSchema,type Cost,type MaintenanceOutcome} from '@commerce/knowledge-contracts';
import {KnowledgeError} from '@commerce/knowledge-core/types';
type Db=Pick<PoolClient,'query'>;
type Origin={id:string;project_id:string;space_id:string;principal_id:string;installation_id:string;purpose:string};
const fail=()=>{throw new KnowledgeError('COORDINATION_REVIEW_BINDING_INVALID','Coordination, task and exact compilation do not agree',409);};
function preserveCost(before:Cost|undefined,next:Cost){if(!before)return;
 for(const key of ['modelCalls','tokens'] as const){const a=before[key],b=next[key];if(a.state==='known'&&(b.state!=='known'||b.value<a.value))fail();}
 if(before.money.state==='known'&&(next.money.state!=='known'||next.money.amount<before.money.amount||before.money.amount>0&&next.money.currency!==before.money.currency))fail();
}
/** Runs inside the independent review/publication transaction; it cannot publish anything itself. */
export async function finalizeCoordinationReview(db:Db,origin:Origin,compiled:{state:'published'|'rejected';completedAt:string}){
 const exists=(await db.query<{present:boolean}>("SELECT to_regclass('ccl_knowledge_coordination_runs') IS NOT NULL AS present")).rows[0].present;
 if(!exists)return;
 const rows=(await db.query<{id:string;task_id:string;result:unknown;state:string}>(`SELECT id,task_id,result,state FROM ccl_knowledge_coordination_runs
   WHERE project_id=$1 AND space_id=$2 AND principal_id=$3 AND installation_id=$4 AND purpose=$5
     AND result->>'compilationId'=$6 FOR UPDATE`,[origin.project_id,origin.space_id,origin.principal_id,origin.installation_id,origin.purpose,origin.id])).rows;
 if(!rows.length)return;if(rows.length!==1)fail();
 const row=rows[0],run=CoordinationRunSchema.parse(row.result);
 if(row.state!=='waiting_for_review'||run.state!=='waiting_for_review'||run.compilationId!==origin.id||
   !run.steps.some(step=>step.kind==='compilation'&&step.state==='known'&&step.resultId===origin.id))fail();
 const taskRow=(await db.query<{input_digest:string;request:unknown;trigger:unknown;state:string;attempts:number;attempt_id:string|null;lease_token:string;cancel_requested:boolean;dispatch_state:string;outcome:MaintenanceOutcome|null;created_at:Date;updated_at:Date}>(`SELECT * FROM ccl_knowledge_maintenance_tasks
   WHERE project_id=$1 AND space_id=$2 AND principal_id=$3 AND installation_id=$4 AND purpose=$5 AND id=$6 FOR UPDATE`,
   [origin.project_id,origin.space_id,origin.principal_id,origin.installation_id,origin.purpose,row.task_id])).rows[0];
 if(!taskRow||run.request.taskId!==row.task_id||run.request.taskInputDigest!==taskRow.input_digest||run.request.purpose!==origin.purpose)fail();
 const task=MaintenanceTaskSchema.parse({id:row.task_id,request:taskRow.request,trigger:taskRow.trigger,inputDigest:taskRow.input_digest,state:taskRow.state,
  attempts:taskRow.attempts,attemptId:taskRow.attempt_id,leaseToken:Number(taskRow.lease_token),cancelRequested:taskRow.cancel_requested,dispatchState:taskRow.dispatch_state,outcome:taskRow.outcome,createdAt:taskRow.created_at.toISOString(),updatedAt:taskRow.updated_at.toISOString()});
 if(!['waiting_for_review','running','outcome_unknown'].includes(task.state)||task.state==='waiting_for_review'&&task.outcome?.compilationId!==origin.id)fail();
 preserveCost(task.outcome?.cost,run.cost);
 const reason=compiled.state==='published'?'独立审阅已通过并发表；准确版本见编纂记录。':'独立审阅未批准；候选没有发表。';
 const next=CoordinationRunSchema.parse({...run,state:'completed',compilationOutcome:compiled.state,reason,completedAt:compiled.completedAt});
 await db.query(`UPDATE ccl_knowledge_coordination_runs SET state='completed',result=$2,updated_at=now() WHERE id=$1 AND state='waiting_for_review'`,[run.id,next]);
 // An executing worker retains its lease; its finish path reads the committed run.
 if(task.state==='running')return;
 const outcome=MaintenanceOutcomeSchema.parse({...task.outcome,state:'completed',findingIds:task.outcome?.findingIds??[],compilationId:origin.id,judgmentId:task.outcome?.judgmentId??run.judgmentIds[0]??null,cost:run.cost,reason});
 await db.query(`UPDATE ccl_knowledge_maintenance_tasks SET state='completed',outcome=$2,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND state=$3`,[task.id,outcome,task.state]);
}
/** Handles approval racing the worker's final acknowledgement without stealing its lease. */
export async function publishedCoordinationOutcome(db:Db,identity:readonly string[],taskId:string,inputDigest:string,incoming:MaintenanceOutcome):Promise<MaintenanceOutcome>{
 if(incoming.state!=='waiting_for_review'||!incoming.compilationId)return incoming;
 const exists=(await db.query<{present:boolean}>("SELECT to_regclass('ccl_knowledge_coordination_runs') IS NOT NULL AS present")).rows[0].present;if(!exists)return incoming;
 const row=(await db.query<{result:unknown}>(`SELECT result FROM ccl_knowledge_coordination_runs WHERE project_id=$1 AND space_id=$2 AND principal_id=$3 AND installation_id=$4 AND purpose=$5 AND task_id=$6 AND state='completed'`,[...identity,taskId])).rows[0];
 if(!row)return incoming;const run=CoordinationRunSchema.parse(row.result);
 if(run.request.taskInputDigest!==inputDigest||run.compilationId!==incoming.compilationId||!run.compilationOutcome)fail();
 preserveCost(incoming.cost,run.cost);return MaintenanceOutcomeSchema.parse({...incoming,state:'completed',cost:run.cost,reason:run.reason});
}

/** Lease expiry can reconcile a proved final review, without authorizing the old worker again. */
export async function completedCoordinationOutcome(db:Db,identity:readonly string[],taskId:string,inputDigest:string,previous:MaintenanceOutcome|null):Promise<MaintenanceOutcome|null>{
 const tables=(await db.query<{present:boolean}>("SELECT to_regclass('ccl_knowledge_coordination_runs') IS NOT NULL AND to_regclass('ccl_knowledge_compilations') IS NOT NULL AS present")).rows[0].present;
 if(!tables)return null;
 const row=(await db.query<{result:unknown}>(`SELECT r.result FROM ccl_knowledge_coordination_runs r JOIN ccl_knowledge_compilations c
   ON c.project_id=r.project_id AND c.space_id=r.space_id AND c.principal_id=r.principal_id
     AND c.installation_id=r.installation_id AND c.purpose=r.purpose AND c.id::text=r.result->>'compilationId'
   WHERE r.project_id=$1 AND r.space_id=$2 AND r.principal_id=$3 AND r.installation_id=$4 AND r.purpose=$5
     AND r.task_id=$6 AND r.state='completed' AND c.state IN ('published','rejected')
     AND r.result->>'compilationOutcome'=c.state`,[...identity,taskId])).rows[0];
 if(!row)return null;const run=CoordinationRunSchema.parse(row.result);
 if(run.request.taskInputDigest!==inputDigest||!run.compilationId||previous?.compilationId&&previous.compilationId!==run.compilationId)fail();
 preserveCost(previous?.cost,run.cost);
 return MaintenanceOutcomeSchema.parse({state:'completed',findingIds:previous?.findingIds??[],compilationId:run.compilationId,judgmentId:previous?.judgmentId??run.judgmentIds[0]??null,cost:run.cost,reason:run.reason});
}
