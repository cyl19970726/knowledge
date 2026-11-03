import type {Pool, PoolClient} from 'pg';
import type {AskOperationPort, ReadContext} from '@commerce/knowledge-application';
import {AskRequestSchema, AskResultSchema, type AskRequest, type AskResult} from '@commerce/knowledge-contracts';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {assertKnowledgeWriterAuthority, type KnowledgeWriterGrant} from '@commerce/knowledge-core/writer-authority';
import {canonical} from '@commerce/knowledge-core/utils';

type AnswerRow = {id:string; input_digest:string; request:AskRequest; result:AskResult; state:string};
type Json = Record<string, unknown>;

export class AskCommitUnknownError extends KnowledgeError {
  readonly commitStatus = 'unknown';
  readonly operationId: string;
  constructor(id:string) {
    super('COMMIT_OUTCOME_UNKNOWN','Ask commit acknowledgement was lost; reconcile this operation before retrying',503);
    this.operationId=id;
  }
}

export async function migrateKnowledgeAnswers(pool:Pool):Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS ccl_knowledge_answers (
    id uuid PRIMARY KEY,
    project_id text NOT NULL, space_id text NOT NULL, principal_id text NOT NULL,
    purpose text NOT NULL, request_key text NOT NULL, input_digest text NOT NULL,
    request jsonb NOT NULL, result jsonb NOT NULL, state text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(project_id,space_id,principal_id,purpose,request_key)
  )`);
  await pool.query(`DROP TRIGGER IF EXISTS ccl_writer_guard ON ccl_knowledge_answers;
    CREATE TRIGGER ccl_writer_guard BEFORE INSERT OR UPDATE OR DELETE ON ccl_knowledge_answers
    FOR EACH ROW EXECUTE FUNCTION ccl_assert_knowledge_writer()`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ccl_knowledge_answers_deadline_idx
    ON ccl_knowledge_answers(project_id,space_id,principal_id,purpose,state)`);
}

function object(value:unknown):Json {
  if(!value||typeof value!=='object'||Array.isArray(value))
    throw new KnowledgeError('ASK_RESULT_INVALID','Ask result must be an object',422);
  return value as Json;
}

function assertContext(context:ReadContext):void {
  if(context.scope.projectId!==context.principal.projectId||!context.principal.spaceIds.includes(context.scope.spaceId))
    throw new KnowledgeError('SCOPE_FORBIDDEN','Ask scope is not authorized',403);
  if(!context.principal.purposes.includes(context.purpose))
    throw new KnowledgeError('PURPOSE_FORBIDDEN','Ask purpose is not authorized',403);
}

function assertIdentity(context:ReadContext,result:AskResult,id:string,expected?:AskResult):void {
  AskResultSchema.parse(result);
  const data=object(result),old=expected?object(expected):null;
  if(data.id!==id||typeof data.state!=='string'||!data.state)
    throw new KnowledgeError('ASK_RESULT_IDENTITY_MISMATCH','Ask result ID or state changed',409);
  if(data.purpose!==context.purpose||old&&data.purpose!==old.purpose)
    throw new KnowledgeError('ASK_RESULT_IDENTITY_MISMATCH','Ask result purpose changed',409);
  if(old&&(data.question!==old.question||data.createdAt!==old.createdAt))
    throw new KnowledgeError('ASK_RESULT_IDENTITY_MISMATCH','Ask question or creation identity changed',409);
  for(const field of ['scope','effectiveScope'] as const) {
    const scope=data[field];
    if(scope!==undefined&&scope!==null){const value=object(scope);
      if(value.projectId!==context.scope.projectId||value.spaceId!==context.scope.spaceId)
        throw new KnowledgeError('ASK_RESULT_SCOPE_MISMATCH','Ask result scope changed',403);
    }
    if(old&&JSON.stringify(data[field]??null)!==JSON.stringify(old[field]??null))
      throw new KnowledgeError('ASK_RESULT_SCOPE_MISMATCH','Ask result scope changed',403);
  }
  // Exact references carried by the answer cannot be relabelled into another scope.
  const walk=(value:unknown,depth:number):void=>{
    if(depth>20)return;
    if(Array.isArray(value)){for(const entry of value)walk(entry,depth+1);return;}
    if(!value||typeof value!=='object')return;
    const item=value as Json;
    if(typeof item.domain==='string'&&typeof item.objectId==='string'&&typeof item.versionId==='string'&&
      (item.projectId!==context.scope.projectId||item.spaceId!==context.scope.spaceId))
      throw new KnowledgeError('ASK_RESULT_SCOPE_MISMATCH','Ask result contains a reference outside its scope',403);
    for(const child of Object.values(item))walk(child,depth+1);
  };
  walk(data,0);
}

function deadline(request:AskRequest):number {
  const raw=object(request).budget;
  const date=raw&&typeof raw==='object'&&!Array.isArray(raw)?Date.parse(String((raw as Json).deadline??'')):NaN;
  if(!Number.isFinite(date))throw new KnowledgeError('ASK_DEADLINE_INVALID','Ask budget deadline is required',422);
  return date;
}

export function createPgKnowledgeAnswers(pool:Pool,grant:KnowledgeWriterGrant):AskOperationPort {
  async function requireActive(client:PoolClient,context:ReadContext):Promise<void> {
    await assertKnowledgeWriterAuthority(client,context.scope.projectId,grant);
    const row=await client.query<{mode:string}>(
      'SELECT mode FROM ccl_knowledge_writer_authority WHERE project_id=$1',[context.scope.projectId]);
    if(row.rows[0]?.mode!=='active')
      throw new KnowledgeError('WRITER_AUTHORITY_REQUIRED','Explicit active knowledge writer authority is required',503);
  }
  async function transaction<T>(context:ReadContext,id:string,work:(client:PoolClient)=>Promise<T>):Promise<T> {
    const client=await pool.connect();let committing=false;
    try {
      await client.query('BEGIN');await requireActive(client,context);
      const result=await work(client);
      committing=true;await client.query('COMMIT');return result;
    } catch(error) {
      if(committing)throw new AskCommitUnknownError(id);
      await client.query('ROLLBACK');throw error;
    } finally {client.release();}
  }
  const scope=(context:ReadContext)=>[context.scope.projectId,context.scope.spaceId,context.principal.id,context.purpose];
  async function expire(client:PoolClient,context:ReadContext,row:AnswerRow):Promise<AnswerRow> {
    if(!['reserved','running'].includes(row.state)||deadline(row.request)>Date.now())return row;
    const state=row.state==='reserved'?'failed':'outcome_unknown';
    const reason=row.state==='reserved'
      ?'Ask deadline elapsed before execution; no provider was invoked'
      :'Ask deadline elapsed while running; external outcome requires reconciliation';
    const result=AskResultSchema.parse({...row.result,state,reason,
      completedAt:new Date().toISOString()});
    await client.query(`UPDATE ccl_knowledge_answers SET state=$2,result=$3,updated_at=now()
      WHERE id=$1 AND project_id=$4 AND space_id=$5 AND principal_id=$6 AND purpose=$7 AND state=$8`,
      [row.id,state,result,...scope(context),row.state]);
    return {...row,state,result};
  }
  const ledger:AskOperationPort={
    async reserve(context,key,inputDigest,request,initial) {
      assertContext(context);
      AskRequestSchema.parse(request);
      if(!key.trim()||key.length>200||!/^[0-9a-f]{64}$/.test(inputDigest))
        throw new KnowledgeError('ASK_RESERVATION_INVALID','Bounded request key and input digest required',422);
      const id=String(object(initial).id??'');
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)||object(initial).state!=='reserved')
        throw new KnowledgeError('ASK_RESERVATION_INVALID','Initial answer needs a UUID and reserved state',422);
      if(request.purpose!==context.purpose)throw new KnowledgeError('PURPOSE_MISMATCH','Ask purpose differs from context',403);
      deadline(request);assertIdentity(context,initial,id);
      if(initial.question!==request.question)throw new KnowledgeError('ASK_RESULT_IDENTITY_MISMATCH','Initial Ask question differs from request',409);
      return transaction(context,id,async client=>{
        const inserted=await client.query<AnswerRow>(`INSERT INTO ccl_knowledge_answers
          (id,project_id,space_id,principal_id,purpose,request_key,input_digest,request,result,state)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'reserved')
          ON CONFLICT(project_id,space_id,principal_id,purpose,request_key) DO NOTHING
          RETURNING id,input_digest,request,result,state`,
          [id,...scope(context),key,inputDigest,request,initial]);
        if(inserted.rows[0])return {created:true,result:(await expire(client,context,inserted.rows[0])).result};
        const prior=await client.query<AnswerRow>(`SELECT id,input_digest,request,result,state FROM ccl_knowledge_answers
          WHERE project_id=$1 AND space_id=$2 AND principal_id=$3 AND purpose=$4 AND request_key=$5 FOR UPDATE`,
          [...scope(context),key]);
        const row=prior.rows[0];
        if(!row)throw new KnowledgeError('ASK_RESERVATION_UNKNOWN','Ask reservation must be reconciled',503);
        if(row.input_digest!==inputDigest||canonical(row.request)!==canonical(request))
          throw new KnowledgeError('IDEMPOTENCY_CONFLICT','Same Ask key has different input',409);
        return {created:false,result:(await expire(client,context,row)).result};
      });
    },
    async start(context,id) {
      assertContext(context);
      return transaction(context,id,async client=>{
        const row=await client.query<AnswerRow>(`SELECT id,input_digest,request,result,state FROM ccl_knowledge_answers
          WHERE id=$1 AND project_id=$2 AND space_id=$3 AND principal_id=$4 AND purpose=$5 FOR UPDATE`,[id,...scope(context)]);
        const current=row.rows[0];if(!current||current.state!=='reserved')return false;
        if(deadline(current.request)<=Date.now()){await expire(client,context,current);return false;}
        // Execution can be interrupted before the provider receipt is stored. A running
        // row must not carry the reservation's synthetic zero-call estimate.
        const result=AskResultSchema.parse({...current.result,state:'running',cost:{
          modelCalls:{state:'unknown',reason:'Execution started; provider invocation acknowledgement is unavailable'},
          tokens:{state:'unknown',reason:'Execution started; provider usage is unavailable'},
          money:{state:'unknown',reason:'Execution started; billing receipt is unavailable'},
        }});
        await client.query(`UPDATE ccl_knowledge_answers SET state='running',result=$2,updated_at=now()
          WHERE id=$1 AND project_id=$3 AND space_id=$4 AND principal_id=$5 AND purpose=$6 AND state='reserved'`,
          [id,result,...scope(context)]);
        return true;
      });
    },
    async checkpoint(context,id,result) {
      assertContext(context);
      await transaction(context,id,async client=>{
        const row=await client.query<AnswerRow>(`SELECT id,input_digest,request,result,state FROM ccl_knowledge_answers
          WHERE id=$1 AND project_id=$2 AND space_id=$3 AND principal_id=$4 AND purpose=$5 FOR UPDATE`,[id,...scope(context)]);
        const current=row.rows[0];
        if(!current||current.state!=='running')throw new KnowledgeError('ASK_NOT_RUNNING','Only a running Ask may be checkpointed',409);
        assertIdentity(context,result,id,current.result);
        if(result.state!=='running')throw new KnowledgeError('ASK_CHECKPOINT_NOT_RUNNING','Ask checkpoint requires running state',422);
        await client.query(`UPDATE ccl_knowledge_answers SET result=$2,updated_at=now()
          WHERE id=$1 AND project_id=$3 AND space_id=$4 AND principal_id=$5 AND purpose=$6 AND state='running'`,
          [id,result,...scope(context)]);
      });
    },
    async finish(context,id,result) {
      assertContext(context);
      await transaction(context,id,async client=>{
        const row=await client.query<AnswerRow>(`SELECT id,input_digest,request,result,state FROM ccl_knowledge_answers
          WHERE id=$1 AND project_id=$2 AND space_id=$3 AND principal_id=$4 AND purpose=$5 FOR UPDATE`,[id,...scope(context)]);
        const current=row.rows[0];
        if(!current||current.state!=='running')throw new KnowledgeError('ASK_NOT_RUNNING','Only a running Ask may finish',409);
        assertIdentity(context,result,id,current.result);
        const state=object(result).state;
        if(typeof state!=='string'||!['answered','needs_evidence','refused','failed','outcome_unknown'].includes(state))
          throw new KnowledgeError('ASK_RESULT_NOT_TERMINAL','A finished Ask requires a terminal result',422);
        await client.query(`UPDATE ccl_knowledge_answers SET state=$2,result=$3,updated_at=now()
          WHERE id=$1 AND project_id=$4 AND space_id=$5 AND principal_id=$6 AND purpose=$7 AND state='running'`,
          [id,state,result,...scope(context)]);
      });
    },
    async get(context,id) {
      assertContext(context);
      const found=await pool.query<AnswerRow>(`SELECT id,input_digest,request,result,state FROM ccl_knowledge_answers
        WHERE id=$1 AND project_id=$2 AND space_id=$3 AND principal_id=$4 AND purpose=$5`,[id,...scope(context)]);
      const row=found.rows[0];if(!row)return null;
      if(!['reserved','running'].includes(row.state)||deadline(row.request)>Date.now())return row.result;
      return transaction(context,id,async client=>{
        const locked=await client.query<AnswerRow>(`SELECT id,input_digest,request,result,state FROM ccl_knowledge_answers
          WHERE id=$1 AND project_id=$2 AND space_id=$3 AND principal_id=$4 AND purpose=$5 FOR UPDATE`,[id,...scope(context)]);
        return locked.rows[0]?(await expire(client,context,locked.rows[0])).result:null;
      });
    },
    async lookup(context,key) {
      assertContext(context);
      if(!key.trim()||key.length>200)throw new KnowledgeError('ASK_LOOKUP_INVALID','Bounded request key required',422);
      const found=await pool.query<{id:string}>(`SELECT id FROM ccl_knowledge_answers
        WHERE project_id=$1 AND space_id=$2 AND principal_id=$3 AND purpose=$4 AND request_key=$5`,
        [...scope(context),key]);
      return found.rows[0]?ledger.get(context,found.rows[0].id):null;
    },
  };
  return ledger;
}
