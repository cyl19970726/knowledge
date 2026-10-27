import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {Operation,ResearchResult,Scope} from '@commerce/knowledge-contracts';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {assertKnowledgeWriterAuthority,type KnowledgeWriterGrant} from '@commerce/knowledge-core/writer-authority';

export interface ReservedOperation {operation:Operation;input:unknown;result:ResearchResult|null}
export interface OperationIdentity {scope:Scope;principalId:string;operation:string;key:string;inputDigest:string;input:unknown}
export class OperationCommitUnknownError extends KnowledgeError {readonly commitStatus='unknown';readonly operationId:string;
  constructor(id:string){super('COMMIT_OUTCOME_UNKNOWN','Commit acknowledgement was lost; reconcile the original operation key',503);this.operationId=id;}}
const unknownCost={modelCalls:{state:'known' as const,value:0},tokens:{state:'known' as const,value:0},
  money:{state:'known' as const,amount:0,currency:'USD',source:'synthetic_local_no_paid_calls'}};
export async function migrateKnowledgeOperations(pool:Pool):Promise<void>{
  await pool.query(`CREATE TABLE IF NOT EXISTS ccl_knowledge_operations (
    id uuid PRIMARY KEY, project_id text NOT NULL, space_id text NOT NULL,
    principal_id text NOT NULL, operation_kind text NOT NULL, request_key text NOT NULL,
    input_digest text NOT NULL, input jsonb NOT NULL, state text NOT NULL,
    attempt_id uuid, lease_until timestamptz, reason text,
    result jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(project_id,space_id,principal_id,operation_kind,request_key)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ccl_knowledge_operation_outbox (
    project_id text NOT NULL,
    operation_id uuid PRIMARY KEY REFERENCES ccl_knowledge_operations(id),
    queued_at timestamptz NOT NULL DEFAULT now(), dispatched_at timestamptz
  )`);
  await pool.query(`ALTER TABLE ccl_knowledge_operation_outbox ADD COLUMN IF NOT EXISTS project_id text`);
  await pool.query(`UPDATE ccl_knowledge_operation_outbox b SET project_id=o.project_id FROM ccl_knowledge_operations o
    WHERE b.operation_id=o.id AND b.project_id IS NULL`);
  await pool.query(`ALTER TABLE ccl_knowledge_operation_outbox ALTER COLUMN project_id SET NOT NULL`);
  for(const table of ['ccl_knowledge_operations','ccl_knowledge_operation_outbox'])
    await pool.query(`DROP TRIGGER IF EXISTS ccl_writer_guard ON ${table}; CREATE TRIGGER ccl_writer_guard
      BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION ccl_assert_knowledge_writer()`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ccl_knowledge_operation_state_idx ON ccl_knowledge_operations(state,updated_at)`);
}
function publicOperation(row:{id:string;state:string;input_digest:string;attempt_id:string|null;reason:string|null}):Operation{
  return {id:row.id,researchId:row.id,state:row.state as Operation['state'],inputDigest:row.input_digest,
    commitStatus:'committed',statusUrl:`/research/${row.id}`,attemptId:row.attempt_id,reason:row.reason,cost:unknownCost};
}
export function createPgKnowledgeOperations(pool:Pool,grant:KnowledgeWriterGrant){
  async function requireActive(client:import('pg').PoolClient,projectId:string){
    await assertKnowledgeWriterAuthority(client,projectId,grant);
    const row=await client.query<{mode:string}>(`SELECT mode FROM ccl_knowledge_writer_authority WHERE project_id=$1`,[projectId]);
    if(row.rows[0]?.mode!=='active')throw new KnowledgeError('WRITER_AUTHORITY_REQUIRED','Explicit active knowledge writer authority is required',503);
  }
  return {
    async replay(identity:Pick<OperationIdentity,'scope'|'principalId'|'operation'|'key'|'inputDigest'>):Promise<Operation|null>{
      const row=await pool.query<{id:string;state:string;input_digest:string;attempt_id:string|null;reason:string|null}>(`
        SELECT id,state,input_digest,attempt_id,reason FROM ccl_knowledge_operations
        WHERE project_id=$1 AND space_id=$2 AND principal_id=$3 AND operation_kind=$4 AND request_key=$5`,
        [identity.scope.projectId,identity.scope.spaceId,identity.principalId,identity.operation,identity.key]);
      const found=row.rows[0];if(!found)return null;
      if(found.input_digest!==identity.inputDigest)throw new KnowledgeError('IDEMPOTENCY_CONFLICT','Same idempotency key has different input',409);
      return publicOperation(found);
    },
    async reserve(identity:OperationIdentity):Promise<Operation>{
      if(!identity.key.trim()||identity.key.length>200)throw new KnowledgeError('IDEMPOTENCY_KEY_REQUIRED','Bounded idempotency key required',400);
      const client=await pool.connect();let id:string=randomUUID(),committing=false;
      try{await client.query('BEGIN');await requireActive(client,identity.scope.projectId);
        const inserted=await client.query<{id:string;state:string;input_digest:string;attempt_id:string|null;reason:string|null}>(`
          INSERT INTO ccl_knowledge_operations(id,project_id,space_id,principal_id,operation_kind,request_key,input_digest,input,state)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued') ON CONFLICT(project_id,space_id,principal_id,operation_kind,request_key) DO NOTHING
          RETURNING id,state,input_digest,attempt_id,reason`,
          [id,identity.scope.projectId,identity.scope.spaceId,identity.principalId,identity.operation,identity.key,identity.inputDigest,identity.input]);
        let row=inserted.rows[0];
        if(row)await client.query('INSERT INTO ccl_knowledge_operation_outbox(project_id,operation_id) VALUES($1,$2)',[identity.scope.projectId,row.id]);
        else{const existing=await client.query<{id:string;state:string;input_digest:string;attempt_id:string|null;reason:string|null}>(`
          SELECT id,state,input_digest,attempt_id,reason FROM ccl_knowledge_operations
          WHERE project_id=$1 AND space_id=$2 AND principal_id=$3 AND operation_kind=$4 AND request_key=$5 FOR UPDATE`,
          [identity.scope.projectId,identity.scope.spaceId,identity.principalId,identity.operation,identity.key]);
          row=existing.rows[0];if(!row)throw new KnowledgeError('OPERATION_OUTCOME_UNKNOWN','Reservation outcome unavailable; reconcile before retry',503);
          if(row.input_digest!==identity.inputDigest)throw new KnowledgeError('IDEMPOTENCY_CONFLICT','Same idempotency key has different input',409);}
        id=row.id;
        committing=true;await client.query('COMMIT');return publicOperation(row);
      }catch(error){if(committing)throw new OperationCommitUnknownError(id);await client.query('ROLLBACK');throw error;}finally{client.release();}
    },
    async get(scope:Scope,principalId:string,id:string,purpose?:string):Promise<ReservedOperation|null>{
      const row=await pool.query<{id:string;state:string;input_digest:string;attempt_id:string|null;reason:string|null;input:unknown;result:ResearchResult|null}>(`
        SELECT id,state,input_digest,attempt_id,reason,input,result FROM ccl_knowledge_operations
        WHERE id=$1 AND project_id=$2 AND space_id=$3 AND principal_id=$4
          AND ($5::text IS NULL OR input#>>'{request,purpose}'=$5)`,[id,scope.projectId,scope.spaceId,principalId,purpose??null]);
      const value=row.rows[0];return value?{operation:publicOperation(value),input:value.input,result:value.result}:null;
    },
    async lookup(scope:Scope,principalId:string,operation:string,key:string,purpose?:string){
      const row=await pool.query<{id:string;state:string;input_digest:string;attempt_id:string|null;reason:string|null}>(`
        SELECT id,state,input_digest,attempt_id,reason FROM ccl_knowledge_operations
        WHERE project_id=$1 AND space_id=$2 AND principal_id=$3 AND operation_kind=$4 AND request_key=$5
          AND ($6::text IS NULL OR input#>>'{request,purpose}'=$6)`,
        [scope.projectId,scope.spaceId,principalId,operation,key,purpose??null]);
      // A missing row cannot establish that a lost request never committed on another authority or during failover.
      return row.rows[0]?{state:'committed' as const,operation:publicOperation(row.rows[0]),reservationState:row.rows[0].state}:
        {state:'unknown' as const,operation:null,reservationState:null};
    },
    async claim(projectId?:string):Promise<{id:string;scope:Scope;principalId:string;input:unknown;attemptId:string}|null>{
      const client=await pool.connect();try{await client.query('BEGIN');
        const found=await client.query<{id:string;project_id:string;space_id:string;principal_id:string;input:unknown}>(`
          SELECT o.id,o.project_id,o.space_id,o.principal_id,o.input FROM ccl_knowledge_operations o
          JOIN ccl_knowledge_operation_outbox b ON b.operation_id=o.id
          WHERE o.state='queued' AND ($1::text IS NULL OR o.project_id=$1) ORDER BY b.queued_at,o.id LIMIT 1`,[projectId??null]);
        const row=found.rows[0];if(!row){await client.query('COMMIT');return null;}
        await requireActive(client,row.project_id);
        const locked=await client.query<{id:string}>(`SELECT id FROM ccl_knowledge_operations WHERE id=$1 AND state='queued' FOR UPDATE SKIP LOCKED`,[row.id]);
        if(!locked.rows[0]){await client.query('COMMIT');return null;}
        const attemptId=randomUUID();await client.query(`UPDATE ccl_knowledge_operations
          SET state='running',attempt_id=$2,lease_until=now()+interval '30 seconds',updated_at=now() WHERE id=$1`,[row.id,attemptId]);
        await client.query('UPDATE ccl_knowledge_operation_outbox SET dispatched_at=now() WHERE operation_id=$1',[row.id]);
        await client.query('COMMIT');return {id:row.id,scope:{projectId:row.project_id,spaceId:row.space_id},principalId:row.principal_id,input:row.input,attemptId};
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    },
    async finish(id:string,attemptId:string,result:ResearchResult,state:'succeeded'|'waiting_for_review'|'waiting_for_source'){
      const client=await pool.connect();try{await client.query('BEGIN');
        const project=await client.query<{project_id:string}>(`SELECT project_id FROM ccl_knowledge_operations WHERE id=$1`,[id]);
        if(!project.rows[0])throw new KnowledgeError('ATTEMPT_FENCED','Research attempt is no longer current',409);
        await requireActive(client,project.rows[0].project_id);
        const row=await client.query<{project_id:string;state:string;attempt_id:string|null}>(`SELECT project_id,state,attempt_id FROM ccl_knowledge_operations WHERE id=$1 FOR UPDATE`,[id]);
        if(!row.rows[0]||!['running','cancel_requested'].includes(row.rows[0].state)||row.rows[0].attempt_id!==attemptId)
          throw new KnowledgeError('ATTEMPT_FENCED','Research attempt is no longer current',409);
        if(row.rows[0].state==='cancel_requested')await client.query(`UPDATE ccl_knowledge_operations SET state='cancelled',lease_until=NULL,updated_at=now() WHERE id=$1`,[id]);
        else await client.query(`UPDATE ccl_knowledge_operations SET state=$2,result=$3,lease_until=NULL,updated_at=now() WHERE id=$1`,[id,state,result]);
        await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    },
    async cancel(scope:Scope,principalId:string,id:string,purpose?:string){
      const client=await pool.connect();try{await client.query('BEGIN');
        await requireActive(client,scope.projectId);
        const row=await client.query<{project_id:string;state:string;result:ResearchResult|null}>(`SELECT project_id,state,result FROM ccl_knowledge_operations
          WHERE id=$1 AND project_id=$2 AND space_id=$3 AND principal_id=$4
            AND ($5::text IS NULL OR input#>>'{request,purpose}'=$5) FOR UPDATE`,[id,scope.projectId,scope.spaceId,principalId,purpose??null]);
        if(!row.rows[0])throw new KnowledgeError('NOT_FOUND','Research operation unavailable',404);
        const current=row.rows[0];
        const next=['queued','waiting_for_review','waiting_for_source'].includes(current.state)?'cancelled':
          current.state==='running'?'cancel_requested':null;
        if(next)await client.query('UPDATE ccl_knowledge_operations SET state=$2,updated_at=now() WHERE id=$1',[id,next]);
        await client.query('COMMIT');return {operationId:id,state:next==='cancelled'?'cancelled':next?'cancel_requested':'too_late',
          publication:current.result?.publication??null};
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    },
    async reconcileExpired(projectId?:string):Promise<number>{
      const rows=await pool.query<{id:string;project_id:string}>(`SELECT id,project_id FROM ccl_knowledge_operations
        WHERE state IN ('running','cancel_requested') AND lease_until<now() AND ($1::text IS NULL OR project_id=$1) ORDER BY updated_at LIMIT 100`,[projectId??null]);
      let count=0;for(const row of rows.rows){const client=await pool.connect();try{await client.query('BEGIN');await requireActive(client,row.project_id);
        const result=await client.query(`UPDATE ccl_knowledge_operations SET state='outcome_unknown',reason='Attempt lease expired; execution outcome requires reconciliation',updated_at=now()
          WHERE id=$1 AND state IN ('running','cancel_requested') AND lease_until<now()`,[row.id]);await client.query('COMMIT');count+=result.rowCount??0;
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}return count;
    }
  };
}
export type PgKnowledgeOperations=ReturnType<typeof createPgKnowledgeOperations>;
