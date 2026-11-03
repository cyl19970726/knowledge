import type {Pool,PoolClient} from 'pg';
import {SourcePlanRequestSchema,SourcePlanResultSchema,
  type SourcePlanRequest,type SourcePlanResult} from '@commerce/knowledge-contracts';
import type {ReadContext} from '@commerce/knowledge-application';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {canonical} from '@commerce/knowledge-core/utils';
import {assertKnowledgeWriterAuthority,type KnowledgeWriterGrant} from '@commerce/knowledge-core/writer-authority';

/** Structurally matches the application port without requiring its public index to re-export it. */
export interface SourcePlanOperationPort {
  reserve(context:ReadContext,key:string,inputDigest:string,request:SourcePlanRequest,initial:SourcePlanResult):Promise<{created:boolean;result:SourcePlanResult}>;
  start(context:ReadContext,id:string):Promise<boolean>;
  checkpoint(context:ReadContext,id:string,result:SourcePlanResult):Promise<void>;
  finish(context:ReadContext,id:string,result:SourcePlanResult):Promise<void>;
  get(context:ReadContext,id:string):Promise<SourcePlanResult|null>;
  lookup(context:ReadContext,key:string):Promise<SourcePlanResult|null>;
}

type Row={id:string;input_digest:string;request:SourcePlanRequest;result:SourcePlanResult;state:SourcePlanResult['state']};
const pending=():SourcePlanResult['cost']=>({
  modelCalls:{state:'unknown',reason:'Provider execution started; invocation receipt unavailable'},
  tokens:{state:'unknown',reason:'Provider usage acknowledgement unavailable'},
  money:{state:'unknown',reason:'Provider billing acknowledgement unavailable'},
});
const zero=():SourcePlanResult['cost']=>({modelCalls:{state:'known',value:0},tokens:{state:'known',value:0},
  money:{state:'known',amount:0,currency:'USD',source:'no_provider_call'}});

export class SourcePlanCommitUnknownError extends KnowledgeError {
  readonly commitStatus='unknown';
  constructor(readonly operationId:string){
    super('COMMIT_OUTCOME_UNKNOWN','Source planning commit acknowledgement was lost; look up the original key',503);
  }
}

/** Source intake migration must run first: source_event_id is a real local FK. */
export async function migrateSourcePlans(pool:Pool):Promise<void>{
  await pool.query(`CREATE TABLE IF NOT EXISTS ccl_knowledge_source_plans (
    id uuid PRIMARY KEY,
    project_id text NOT NULL,space_id text NOT NULL,principal_id text NOT NULL,installation_id text NOT NULL,
    purpose text NOT NULL,request_key text NOT NULL,input_digest text NOT NULL,
    source_event_id uuid NOT NULL REFERENCES ccl_knowledge_source_events(id),
    request jsonb NOT NULL,result jsonb NOT NULL,state text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(project_id,space_id,principal_id,installation_id,purpose,request_key)
  )`);
  await pool.query(`DROP TRIGGER IF EXISTS ccl_writer_guard ON ccl_knowledge_source_plans;
    CREATE TRIGGER ccl_writer_guard BEFORE INSERT OR UPDATE OR DELETE ON ccl_knowledge_source_plans
    FOR EACH ROW EXECUTE FUNCTION ccl_assert_knowledge_writer()`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ccl_knowledge_source_plans_scope_state
    ON ccl_knowledge_source_plans(project_id,space_id,principal_id,installation_id,purpose,state)`);
}

function identity(context:ReadContext):[string,string,string,string,string]{
  const installation=context.principal.clientInstallationId;
  if(!installation?.trim()||context.scope.projectId!==context.principal.projectId||
    !context.principal.spaceIds.includes(context.scope.spaceId)||!context.principal.purposes.includes(context.purpose))
    throw new KnowledgeError('SCOPE_FORBIDDEN','Source planning identity, space or purpose is unavailable',403);
  return [context.scope.projectId,context.scope.spaceId,context.principal.id,installation,context.purpose];
}
const scoped='project_id=$1 AND space_id=$2 AND principal_id=$3 AND installation_id=$4 AND purpose=$5';
function assertResult(context:ReadContext,id:string,request:SourcePlanRequest,result:SourcePlanResult,prior?:SourcePlanResult):void{
  SourcePlanResultSchema.parse(result);
  if(result.id!==id||result.request.purpose!==context.purpose||canonical(result.request)!==canonical(request)||
    prior&&(result.createdAt!==prior.createdAt||result.provenance!==prior.provenance||
      prior.provider!==null&&(result.inputFingerprint!==prior.inputFingerprint||result.provider===null||
        result.provider.id!==prior.provider.id||result.provider.version!==prior.provider.version||
        result.provider.modelRequested!==prior.provider.modelRequested)))
    throw new KnowledgeError('SOURCE_PLAN_BINDING_CHANGED','Planning identity or acknowledged provider input changed',409);
  for(const evidence of result.evidence){
    if(evidence.kind!=='source_content'||evidence.ref.domain==='knowledge'||
      evidence.ref.projectId!==context.scope.projectId||evidence.ref.spaceId!==context.scope.spaceId||
      evidence.actualReadCoverage.some(read=>canonical(read.sourceRef)!==canonical(evidence.ref)))
      throw new KnowledgeError('SOURCE_PLAN_EVIDENCE_INVALID','Planning evidence must be an exact source in this scope',409);
  }
  if(result.evidence.length>1)throw new KnowledgeError('SOURCE_PLAN_EVIDENCE_INVALID','Only the registered source may be read',409);
  if(result.state==='reserved'&&(result.evidence.length||result.proposal||result.provider||result.raw))
    throw new KnowledgeError('SOURCE_PLAN_RESERVATION_INVALID','Reserved planning cannot contain a model result',422);
  if(result.proposal&&['planned','needs_evidence','refused'].includes(result.state)&&result.proposal.outcome!==result.state||
    result.state==='planned'&&!result.proposal)
    throw new KnowledgeError('SOURCE_PLAN_PROPOSAL_MISMATCH','Terminal proposal outcome differs from planning state',409);
  if(prior){
    if(prior.proposal&&(!result.proposal||canonical(result.proposal)!==canonical(prior.proposal))||
      prior.raw!==null&&canonical(result.raw)!==canonical(prior.raw))
      throw new KnowledgeError('SOURCE_PLAN_ACKNOWLEDGEMENT_CHANGED','Acknowledged proposal or provider raw output changed',409);
    if(prior.provider!==null){
      for(const field of ['modelCalls','tokens'] as const){
        const before=prior.cost[field],after=result.cost[field];
        if(before.state==='known'&&(after.state!=='known'||after.value<before.value))
          throw new KnowledgeError('SOURCE_PLAN_COST_REGRESSION','Acknowledged model usage cannot disappear',409);
      }
      const before=prior.cost.money,after=result.cost.money;
      if(before.state==='known'&&(after.state!=='known'||after.currency!==before.currency||after.amount<before.amount))
        throw new KnowledgeError('SOURCE_PLAN_COST_REGRESSION','Acknowledged provider money cannot disappear',409);
    }
  }
}

export function createPgSourcePlans(pool:Pool,grant:KnowledgeWriterGrant):SourcePlanOperationPort{
  async function transaction<T>(context:ReadContext,id:string,work:(client:PoolClient)=>Promise<T>):Promise<T>{
    identity(context);const client=await pool.connect();let committing=false;
    try{
      await client.query('BEGIN');await assertKnowledgeWriterAuthority(client,context.scope.projectId,grant);
      const authority=await client.query<{mode:string}>('SELECT mode FROM ccl_knowledge_writer_authority WHERE project_id=$1',[context.scope.projectId]);
      if(authority.rows[0]?.mode!=='active')throw new KnowledgeError('WRITER_AUTHORITY_REQUIRED','Source planning needs active writer authority',503);
      const value=await work(client);committing=true;await client.query('COMMIT');return value;
    }catch(error){
      if(committing)throw new SourcePlanCommitUnknownError(id);
      await client.query('ROLLBACK').catch(()=>{});throw error;
    }finally{client.release();}
  }
  async function find(db:Pool|PoolClient,context:ReadContext,id:string,lock=false):Promise<Row|undefined>{
    return (await db.query<Row>(`SELECT id,input_digest,request,result,state FROM ccl_knowledge_source_plans
      WHERE ${scoped} AND id=$6${lock?' FOR UPDATE':''}`,[...identity(context),id])).rows[0];
  }
  async function expire(client:PoolClient,context:ReadContext,row:Row):Promise<SourcePlanResult>{
    if(!['reserved','running'].includes(row.state)||Date.parse(row.request.budget.deadline)>Date.now())
      return SourcePlanResultSchema.parse(row.result);
    const reserved=row.state==='reserved';
    const result=SourcePlanResultSchema.parse({...row.result,state:reserved?'failed':'outcome_unknown',
      cost:reserved?zero():row.result.cost,
      reason:reserved?'Planning deadline elapsed before provider execution':'Planning deadline elapsed during execution; reconcile the original provider request',
      completedAt:new Date().toISOString()});
    await client.query(`UPDATE ccl_knowledge_source_plans SET state=$7,result=$8,updated_at=now()
      WHERE ${scoped} AND id=$6 AND state=$9`,[...identity(context),row.id,result.state,result,row.state]);
    return result;
  }
  const ledger:SourcePlanOperationPort={
    async reserve(context,key,inputDigest,request,initial){
      identity(context);SourcePlanRequestSchema.parse(request);assertResult(context,initial.id,request,initial);
      if(request.purpose!==context.purpose)throw new KnowledgeError('PURPOSE_MISMATCH','Planning purpose differs from context',403);
      if(!key.trim()||key.length>200||!/^[0-9a-f]{64}$/.test(inputDigest)||initial.state!=='reserved'||
        Date.parse(request.budget.deadline)-Date.now()>300_000)
        throw new KnowledgeError('SOURCE_PLAN_RESERVATION_INVALID','Exact bounded key, digest, reserved state and five minute deadline required',422);
      return transaction(context,initial.id,async client=>{
        const event=(await client.query<{source_ref:unknown}>(`SELECT document->'request'->'sourceRef' AS source_ref
          FROM ccl_knowledge_source_events WHERE ${scoped} AND id=$6`,[...identity(context),request.sourceEventId])).rows[0];
        if(!event?.source_ref)throw new KnowledgeError('SOURCE_EVENT_NOT_FOUND','Registered source event is unavailable in this namespace',404);
        const inserted=await client.query<Row>(`INSERT INTO ccl_knowledge_source_plans
          (project_id,space_id,principal_id,installation_id,purpose,id,request_key,input_digest,source_event_id,request,result,state)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'reserved')
          ON CONFLICT DO NOTHING RETURNING id,input_digest,request,result,state`,
          [...identity(context),initial.id,key,inputDigest,request.sourceEventId,request,initial]);
        if(inserted.rows[0])return {created:true,result:await expire(client,context,inserted.rows[0])};
        const old=(await client.query<Row>(`SELECT id,input_digest,request,result,state FROM ccl_knowledge_source_plans
          WHERE ${scoped} AND request_key=$6 FOR UPDATE`,[...identity(context),key])).rows[0];
        if(!old||old.input_digest!==inputDigest||canonical(old.request)!==canonical(request))
          throw new KnowledgeError('IDEMPOTENCY_CONFLICT','Planning key has different request or provider input',409);
        return {created:false,result:await expire(client,context,old)};
      });
    },
    async start(context,id){
      return transaction(context,id,async client=>{
        const row=await find(client,context,id,true);if(!row||row.state!=='reserved')return false;
        if(Date.parse(row.request.budget.deadline)<=Date.now()){await expire(client,context,row);return false;}
        const result=SourcePlanResultSchema.parse({...row.result,state:'running',cost:pending()});
        await client.query(`UPDATE ccl_knowledge_source_plans SET state='running',result=$7,updated_at=now()
          WHERE ${scoped} AND id=$6 AND state='reserved'`,[...identity(context),id,result]);
        return true;
      });
    },
    async checkpoint(context,id,result){
      await transaction(context,id,async client=>{
        const row=await find(client,context,id,true);
        if(!row||row.state!=='running'||result.state!=='running')
          throw new KnowledgeError('SOURCE_PLAN_NOT_RUNNING','Only an unexpired running plan can be checkpointed',409);
        assertResult(context,id,row.request,result,row.result);
        const source=(await client.query<{source_ref:unknown}>(`SELECT document->'request'->'sourceRef' AS source_ref
          FROM ccl_knowledge_source_events WHERE ${scoped} AND id=$6`,[...identity(context),row.request.sourceEventId])).rows[0];
        if(result.evidence.some(e=>canonical(e.ref)!==canonical(source?.source_ref)))
          throw new KnowledgeError('SOURCE_PLAN_EVIDENCE_INVALID','Evidence differs from registered exact source',409);
        await client.query(`UPDATE ccl_knowledge_source_plans SET result=$7,updated_at=now()
          WHERE ${scoped} AND id=$6 AND state='running'`,[...identity(context),id,result]);
      });
    },
    async finish(context,id,result){
      await transaction(context,id,async client=>{
        const row=await find(client,context,id,true);
        if(!row||row.state!=='running'||
          !['planned','needs_evidence','refused','failed','outcome_unknown'].includes(result.state))
          throw new KnowledgeError('SOURCE_PLAN_NOT_RUNNING','Only an unexpired running plan can finish once',409);
        assertResult(context,id,row.request,result,row.result);
        const source=(await client.query<{source_ref:unknown}>(`SELECT document->'request'->'sourceRef' AS source_ref
          FROM ccl_knowledge_source_events WHERE ${scoped} AND id=$6`,[...identity(context),row.request.sourceEventId])).rows[0];
        if(result.evidence.some(e=>canonical(e.ref)!==canonical(source?.source_ref)))
          throw new KnowledgeError('SOURCE_PLAN_EVIDENCE_INVALID','Evidence differs from registered exact source',409);
        await client.query(`UPDATE ccl_knowledge_source_plans SET state=$7,result=$8,updated_at=now()
          WHERE ${scoped} AND id=$6 AND state='running'`,[...identity(context),id,result.state,result]);
      });
    },
    async get(context,id){
      const row=await find(pool,context,id);if(!row)return null;
      if(!['reserved','running'].includes(row.state)||Date.parse(row.request.budget.deadline)>Date.now())
        return SourcePlanResultSchema.parse(row.result);
      return transaction(context,id,async client=>{
        const locked=await find(client,context,id,true);
        return locked?expire(client,context,locked):null;
      });
    },
    async lookup(context,key){
      identity(context);
      if(!key.trim()||key.length>200)throw new KnowledgeError('SOURCE_PLAN_LOOKUP_INVALID','Bounded original key required',422);
      const found=(await pool.query<{id:string}>(`SELECT id FROM ccl_knowledge_source_plans WHERE ${scoped} AND request_key=$6`,
        [...identity(context),key])).rows[0];
      return found?ledger.get(context,found.id):null;
    },
  };
  return ledger;
}
