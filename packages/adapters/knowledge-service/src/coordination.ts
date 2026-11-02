import type {Pool,PoolClient} from 'pg';
import {CoordinationRunSchema,type CoordinationRun,type CoordinationRequest,type CoordinationStep} from '@commerce/knowledge-contracts';
import type {ReadContext} from '@commerce/knowledge-application';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {canonical} from '@commerce/knowledge-core/utils';
import {assertKnowledgeWriterAuthority,type KnowledgeWriterGrant} from '@commerce/knowledge-core/writer-authority';

/** Same structural contract as application/coordination-port; no public-index edit is needed here. */
export interface CoordinationOperationPort {
  reserve(context:ReadContext,inputDigest:string,initial:CoordinationRun):Promise<{created:boolean;result:CoordinationRun}>;
  checkpoint(context:ReadContext,id:string,result:CoordinationRun):Promise<void>;
  finish(context:ReadContext,id:string,result:CoordinationRun):Promise<void>;
  reconcile?(context:ReadContext,id:string,result:CoordinationRun):Promise<CoordinationRun>;
  get(context:ReadContext,id:string):Promise<CoordinationRun|null>;
  byTask(context:ReadContext,taskId:string):Promise<CoordinationRun|null>;
}
type Row={id:string;input_digest:string;request:CoordinationRequest;result:CoordinationRun;state:CoordinationRun['state']};
const scoped='project_id=$1 AND space_id=$2 AND principal_id=$3 AND installation_id=$4 AND purpose=$5';
const terminal=new Set<CoordinationRun['state']>(['waiting_for_review','no_change','needs_evidence','refused','failed',
  'outcome_unknown','completed','cancelled']);
const zero=():CoordinationRun['cost']=>({modelCalls:{state:'known',value:0},tokens:{state:'known',value:0},
  money:{state:'known',amount:0,currency:'USD',source:'no_provider_call'}});
const isZero=(cost:CoordinationRun['cost'])=>cost.modelCalls.state==='known'&&cost.modelCalls.value===0&&
  cost.tokens.state==='known'&&cost.tokens.value===0&&cost.money.state==='known'&&cost.money.amount===0;

export class CoordinationCommitUnknownError extends KnowledgeError {
  readonly commitStatus='unknown';
  constructor(readonly operationId:string){
    super('COMMIT_OUTCOME_UNKNOWN','Coordination commit acknowledgement was lost; look up the original task',503);
  }
}

/** Maintenance migration must precede this one so the task FK is enforced. */
export async function migrateCoordinationRuns(pool:Pool):Promise<void>{
  await pool.query(`CREATE TABLE IF NOT EXISTS ccl_knowledge_coordination_runs (
    id uuid PRIMARY KEY,
    project_id text NOT NULL,space_id text NOT NULL,principal_id text NOT NULL,installation_id text NOT NULL,
    purpose text NOT NULL,task_id uuid NOT NULL REFERENCES ccl_knowledge_maintenance_tasks(id),
    input_digest text NOT NULL,request jsonb NOT NULL,result jsonb NOT NULL,state text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(project_id,space_id,principal_id,installation_id,purpose,task_id)
  )`);
  await pool.query(`DROP TRIGGER IF EXISTS ccl_writer_guard ON ccl_knowledge_coordination_runs;
    CREATE TRIGGER ccl_writer_guard BEFORE INSERT OR UPDATE OR DELETE ON ccl_knowledge_coordination_runs
    FOR EACH ROW EXECUTE FUNCTION ccl_assert_knowledge_writer()`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ccl_knowledge_coordination_scope_state
    ON ccl_knowledge_coordination_runs(project_id,space_id,principal_id,installation_id,purpose,state)`);
}

function identity(context:ReadContext):[string,string,string,string,string]{
  const install=context.principal.clientInstallationId;
  if(!install?.trim()||context.scope.projectId!==context.principal.projectId||
    !context.principal.spaceIds.includes(context.scope.spaceId)||!context.principal.purposes.includes(context.purpose))
    throw new KnowledgeError('SCOPE_FORBIDDEN','Coordination identity, space or purpose is unavailable',403);
  return [context.scope.projectId,context.scope.spaceId,context.principal.id,install,context.purpose];
}
function assertCost(previous:CoordinationRun['cost'],next:CoordinationRun['cost'],allowUnknown=false):void{
  for(const name of ['modelCalls','tokens'] as const){
    const a=previous[name],b=next[name];
    if(a.state==='known'&&(b.state!=='known'&&!allowUnknown||b.state==='known'&&b.value<a.value))
      throw new KnowledgeError('COORDINATION_COST_REGRESSION','Acknowledged usage cannot disappear or decrease',409);
  }
  const a=previous.money,b=next.money;
  if(a.state==='known'&&(b.state!=='known'&&!allowUnknown||b.state==='known'&&
    (a.amount>0&&b.currency!==a.currency||b.amount<a.amount)))
    throw new KnowledgeError('COORDINATION_COST_REGRESSION','Acknowledged money cannot disappear or decrease',409);
}
function assertSteps(old:readonly CoordinationStep[],next:readonly CoordinationStep[]):void{
  if(next.length<old.length||next.length>8)
    throw new KnowledgeError('COORDINATION_STEPS_CHANGED','Acknowledged steps are append only and bounded',409);
  const keys=new Set<string>();
  for(const step of next){
    const key=`${step.kind}:${step.key}`;
    if(keys.has(key))throw new KnowledgeError('COORDINATION_STEP_DUPLICATE','Step kind and key must be distinct',409);
    if(step.resultId!==null&&step.state==='planned')
      throw new KnowledgeError('COORDINATION_STEP_STATE_REGRESSION','A child receipt cannot remain planned',409);
    keys.add(key);
  }
  for(let i=0;i<old.length;i++){
    const a=old[i],b=next[i];
    if(a.kind!==b.kind||a.key!==b.key||canonical(a.request)!==canonical(b.request)||
      a.resultId!==null&&a.resultId!==b.resultId||b.readBytes<a.readBytes)
      throw new KnowledgeError('COORDINATION_STEP_CHANGED','Frozen step input, result or acknowledged bytes changed',409);
    assertCost(a.cost,b.cost,a.resultId===null&&a.state==='planned'&&isZero(a.cost));
    if((a.state==='known'||a.state==='failed')&&b.state!==a.state||
      a.state==='outcome_unknown'&&!['outcome_unknown','known','failed'].includes(b.state))
      throw new KnowledgeError('COORDINATION_STEP_STATE_REGRESSION','Acknowledged step state cannot return to dispatch',409);
  }
}
function assertResult(context:ReadContext,row:Row|undefined,result:CoordinationRun):void{
  CoordinationRunSchema.parse(result);
  const request=row?.request??result.request;
  if(result.id!==(row?.id??result.id)||result.request.purpose!==context.purpose||
    canonical(result.request)!==canonical(request)||
    row&&(result.createdAt!==row.result.createdAt||result.request.taskId!==row.result.request.taskId))
    throw new KnowledgeError('COORDINATION_BINDING_CHANGED','Coordination identity or task request changed',409);
  if(result.candidateRefs.some(ref=>ref.projectId!==context.scope.projectId||ref.spaceId!==context.scope.spaceId))
    throw new KnowledgeError('COORDINATION_REF_SCOPE','Candidate reference is outside the task scope',403);
  if(result.discovery?.evidence.some(item=>item.ref.projectId!==context.scope.projectId||
    item.ref.spaceId!==context.scope.spaceId))
    throw new KnowledgeError('COORDINATION_REF_SCOPE','Discovery evidence is outside the task scope',403);
  if(result.readBytes>request.budget.maxReadBytes)
    throw new KnowledgeError('COORDINATION_READ_BUDGET_EXCEEDED','Aggregate read bytes exceed the task budget',422);
  if(result.readAccounting==='acknowledged_steps'){
    const steps=result.steps;
    if(result.readBytes!==steps.reduce((sum,step)=>sum+step.readBytes,0))
      throw new KnowledgeError('COORDINATION_ACCOUNTING_MISMATCH','Aggregate read bytes differ from acknowledged steps',409);
    for(const field of ['modelCalls','tokens'] as const){
      const known=steps.every(step=>step.cost[field].state==='known'),aggregate=result.cost[field];
      const total=steps.reduce((sum,step)=>sum+(step.cost[field].state==='known'?step.cost[field].value:0),0);
      if(known?(aggregate.state!=='known'||aggregate.value!==total):aggregate.state!=='unknown')
        throw new KnowledgeError('COORDINATION_ACCOUNTING_MISMATCH','Aggregate usage differs from acknowledged steps',409);
    }
    const moneyKnown=steps.every(step=>step.cost.money.state==='known');
    const currencies=new Set(steps.flatMap(step=>step.cost.money.state==='known'&&step.cost.money.amount>0?[step.cost.money.currency]:[]));
    const aggregate=result.cost.money,total=steps.reduce((sum,step)=>sum+(step.cost.money.state==='known'?step.cost.money.amount:0),0);
    if(moneyKnown&&currencies.size<=1?(aggregate.state!=='known'||aggregate.amount!==total||
      aggregate.currency!==([...currencies][0]??request.budget.maxMoney?.currency??'USD')):aggregate.state!=='unknown')
      throw new KnowledgeError('COORDINATION_ACCOUNTING_MISMATCH','Aggregate money differs from acknowledged steps',409);
  }
  const overCalls=result.cost.modelCalls.state==='known'&&result.cost.modelCalls.value>request.budget.maxModelCalls;
  const overMoney=result.cost.money.state==='known'&&request.budget.maxMoney!==null&&
    (result.cost.money.amount>0&&result.cost.money.currency!==request.budget.maxMoney.currency||
      result.cost.money.amount>request.budget.maxMoney.amount);
  if((overCalls||overMoney)&&terminal.has(result.state)&&result.state!=='failed')
    throw new KnowledgeError('COORDINATION_COST_EXCEEDED','Known overspend must be retained in a failed run',422);
  if(!row)return;
  if(row.result.readAccounting&&row.result.readAccounting!==result.readAccounting||
    row.result.discovery&&canonical(row.result.discovery)!==canonical(result.discovery)||
    row.result.sourcePlanId!==null&&row.result.sourcePlanId!==result.sourcePlanId||
    row.result.compilationId!==null&&row.result.compilationId!==result.compilationId||
    result.candidateRefs.length<row.result.candidateRefs.length||
    row.result.candidateRefs.some((ref,i)=>canonical(ref)!==canonical(result.candidateRefs[i]))||
    result.judgmentIds.length<row.result.judgmentIds.length||
    row.result.judgmentIds.some((id,i)=>id!==result.judgmentIds[i])||result.readBytes<row.result.readBytes)
    throw new KnowledgeError('COORDINATION_RESULT_CHANGED','Acknowledged references or read bytes cannot be removed',409);
  assertSteps(row.result.steps,result.steps);
  assertCost(row.result.cost,result.cost,
    row.state==='reserved'&&result.state==='running'&&isZero(row.result.cost)||
    result.readAccounting==='acknowledged_steps'&&result.steps.some((step,i)=>
      (i>=row.result.steps.length||row.result.steps[i].resultId===null&&
        row.result.steps[i].state==='planned'&&isZero(row.result.steps[i].cost))&&
      (step.cost.modelCalls.state==='unknown'||step.cost.tokens.state==='unknown'||step.cost.money.state==='unknown')));
}

export function createPgCoordinationRuns(pool:Pool,grant:KnowledgeWriterGrant):CoordinationOperationPort{
  async function transaction<T>(context:ReadContext,id:string,work:(client:PoolClient)=>Promise<T>):Promise<T>{
    identity(context);const client=await pool.connect();let committing=false;
    try{
      await client.query('BEGIN');await assertKnowledgeWriterAuthority(client,context.scope.projectId,grant);
      const authority=await client.query<{mode:string}>('SELECT mode FROM ccl_knowledge_writer_authority WHERE project_id=$1',[context.scope.projectId]);
      if(authority.rows[0]?.mode!=='active')throw new KnowledgeError('WRITER_AUTHORITY_REQUIRED','Coordination needs active writer authority',503);
      const value=await work(client);committing=true;await client.query('COMMIT');return value;
    }catch(error){
      if(committing)throw new CoordinationCommitUnknownError(id);
      await client.query('ROLLBACK').catch(()=>{});throw error;
    }finally{client.release();}
  }
  async function find(db:Pool|PoolClient,context:ReadContext,id:string,lock=false):Promise<Row|undefined>{
    return (await db.query<Row>(`SELECT id,input_digest,request,result,state FROM ccl_knowledge_coordination_runs
      WHERE ${scoped} AND id=$6${lock?' FOR UPDATE':''}`,[...identity(context),id])).rows[0];
  }
  async function expire(client:PoolClient,context:ReadContext,row:Row):Promise<CoordinationRun>{
    if(!['reserved','running'].includes(row.state)||Date.parse(row.request.budget.deadline)>Date.now())
      return CoordinationRunSchema.parse(row.result);
    const reserved=row.state==='reserved';
    const result=CoordinationRunSchema.parse({...row.result,state:reserved?'failed':'outcome_unknown',
      cost:reserved?zero():row.result.cost,
      reason:reserved?'Coordination deadline elapsed before execution':'Coordination deadline elapsed while running; reconcile acknowledged steps',
      completedAt:new Date().toISOString()});
    await client.query(`UPDATE ccl_knowledge_coordination_runs SET state=$7,result=$8,updated_at=now()
      WHERE ${scoped} AND id=$6 AND state=$9`,[...identity(context),row.id,result.state,result,row.state]);
    return result;
  }
  const ledger:CoordinationOperationPort={
    async reserve(context,inputDigest,initial){
      identity(context);assertResult(context,undefined,initial);
      if(initial.state!=='reserved'||initial.steps.length||initial.sourcePlanId||initial.compilationId||
        initial.candidateRefs.length||initial.judgmentIds.length||initial.readBytes!==0||!isZero(initial.cost)||
        !/^[0-9a-f]{64}$/.test(inputDigest)||Date.parse(initial.request.budget.deadline)-Date.now()>300_000)
        throw new KnowledgeError('COORDINATION_RESERVATION_INVALID','Exact task, zero-cost reserved state and five minute deadline required',422);
      return transaction(context,initial.id,async client=>{
        const task=(await client.query<{input_digest:string;request:{sourceEventIds:string[]}}>(`SELECT input_digest,request FROM ccl_knowledge_maintenance_tasks
          WHERE ${scoped} AND id=$6`,[...identity(context),initial.request.taskId])).rows[0];
        if(!task||task.input_digest!==initial.request.taskInputDigest||initial.request.sourceEventId!==null&&
          !task.request.sourceEventIds.includes(initial.request.sourceEventId))
          throw new KnowledgeError('COORDINATION_TASK_MISMATCH','Exact maintenance task and input digest are unavailable',409);
        const inserted=await client.query<Row>(`INSERT INTO ccl_knowledge_coordination_runs
          (project_id,space_id,principal_id,installation_id,purpose,id,task_id,input_digest,request,result,state)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'reserved') ON CONFLICT DO NOTHING
          RETURNING id,input_digest,request,result,state`,
          [...identity(context),initial.id,initial.request.taskId,inputDigest,initial.request,initial]);
        if(inserted.rows[0])return {created:true,result:await expire(client,context,inserted.rows[0])};
        const old=(await client.query<Row>(`SELECT id,input_digest,request,result,state FROM ccl_knowledge_coordination_runs
          WHERE ${scoped} AND task_id=$6 FOR UPDATE`,[...identity(context),initial.request.taskId])).rows[0];
        const requestWithOriginalDeadline={...initial.request,budget:{...initial.request.budget,
          deadline:old?.request.budget.deadline}};
        if(!old||old.input_digest!==inputDigest||canonical(old.request)!==canonical(requestWithOriginalDeadline))
          throw new KnowledgeError('IDEMPOTENCY_CONFLICT','Task has another coordination request or policy input',409);
        return {created:false,result:await expire(client,context,old)};
      });
    },
    async checkpoint(context,id,result){
      await transaction(context,id,async client=>{
        const row=await find(client,context,id,true);
        if(!row||!['reserved','running'].includes(row.state)||result.state!=='running'||
          row.state==='reserved'&&Date.parse(row.request.budget.deadline)<=Date.now())
          throw new KnowledgeError('COORDINATION_NOT_RUNNING','Only an active task can checkpoint a running run',409);
        assertResult(context,row,result);
        await client.query(`UPDATE ccl_knowledge_coordination_runs SET state='running',result=$7,updated_at=now()
          WHERE ${scoped} AND id=$6 AND state=$8`,[...identity(context),id,result,row.state]);
      });
    },
    async finish(context,id,result){
      await transaction(context,id,async client=>{
        const row=await find(client,context,id,true);
        if(!row)throw new KnowledgeError('COORDINATION_NOT_FOUND','Coordination run is unavailable',404);
        if(terminal.has(row.state)){
          if(canonical(row.result)===canonical(result))return;
          throw new KnowledgeError('COORDINATION_ALREADY_FINISHED','Terminal coordination result is immutable',409);
        }
        if(!terminal.has(result.state)||row.state==='reserved'&&Date.parse(row.request.budget.deadline)<=Date.now())
          throw new KnowledgeError('COORDINATION_NOT_TERMINAL','Only an active task can finish with a terminal result',409);
        assertResult(context,row,result);
        await client.query(`UPDATE ccl_knowledge_coordination_runs SET state=$7,result=$8,updated_at=now()
          WHERE ${scoped} AND id=$6 AND state=$9`,[...identity(context),id,result.state,result,row.state]);
      });
    },
    async reconcile(context,id,result){
      return transaction(context,id,async client=>{
        const row=await find(client,context,id,true);
        if(!row)throw new KnowledgeError('COORDINATION_NOT_FOUND','Coordination run is unavailable',404);
        if(terminal.has(row.state)&&row.state!=='outcome_unknown'){
          if(canonical(row.result)===canonical(result))return CoordinationRunSchema.parse(row.result);
          throw new KnowledgeError('COORDINATION_ALREADY_FINISHED','Known terminal run is immutable',409);
        }
        if(!['running','outcome_unknown'].includes(row.state)||
          !terminal.has(result.state)||result.steps.length!==row.result.steps.length||!result.completedAt)
          throw new KnowledgeError('COORDINATION_RECONCILE_INVALID','Only existing child steps can reconcile a running or unknown run',409);
        assertResult(context,row,result);
        await client.query(`UPDATE ccl_knowledge_coordination_runs SET state=$7,result=$8,updated_at=now()
          WHERE ${scoped} AND id=$6 AND state=$9`,[...identity(context),id,result.state,result,row.state]);
        return result;
      });
    },
    async get(context,id){
      const row=await find(pool,context,id);if(!row)return null;
      if(!['reserved','running'].includes(row.state)||Date.parse(row.request.budget.deadline)>Date.now())
        return CoordinationRunSchema.parse(row.result);
      return transaction(context,id,async client=>{
        const locked=await find(client,context,id,true);return locked?expire(client,context,locked):null;
      });
    },
    async byTask(context,taskId){
      identity(context);
      const found=(await pool.query<{id:string}>(`SELECT id FROM ccl_knowledge_coordination_runs
        WHERE ${scoped} AND task_id=$6`,[...identity(context),taskId])).rows[0];
      return found?ledger.get(context,found.id):null;
    },
  };
  return ledger;
}
