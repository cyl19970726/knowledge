import type {Pool,PoolClient} from 'pg';
import {RelationJudgmentSchema,RelationJudgmentRequestSchema,type RelationJudgment,type RelationJudgmentRequest} from '@commerce/knowledge-contracts';
import type {ReadContext,JudgmentOperationPort} from '@commerce/knowledge-application';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {canonical} from '@commerce/knowledge-core/utils';
import {assertKnowledgeWriterAuthority,type KnowledgeWriterGrant} from '@commerce/knowledge-core/writer-authority';
export class JudgmentCommitUnknownError extends KnowledgeError {readonly commitStatus='unknown';constructor(readonly operationId:string){super('COMMIT_OUTCOME_UNKNOWN','Judgment commit acknowledgement lost; reconcile original key',503);}}
export async function migrateRelationJudgments(pool:Pool){await pool.query(`CREATE TABLE IF NOT EXISTS ccl_knowledge_relation_judgments(
 id uuid PRIMARY KEY,project_id text NOT NULL,space_id text NOT NULL,principal_id text NOT NULL,installation_id text NOT NULL,purpose text NOT NULL,
 request_key text NOT NULL,input_digest text NOT NULL,request jsonb NOT NULL,result jsonb NOT NULL,state text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(project_id,space_id,principal_id,installation_id,purpose,request_key));
 DROP TRIGGER IF EXISTS ccl_writer_guard ON ccl_knowledge_relation_judgments;CREATE TRIGGER ccl_writer_guard BEFORE INSERT OR UPDATE OR DELETE ON ccl_knowledge_relation_judgments FOR EACH ROW EXECUTE FUNCTION ccl_assert_knowledge_writer()`);}
type Row={id:string;input_digest:string;request:RelationJudgmentRequest;result:RelationJudgment;state:RelationJudgment['state']};
function identity(context:ReadContext){if(!context.principal.clientInstallationId||context.scope.projectId!==context.principal.projectId||!context.principal.spaceIds.includes(context.scope.spaceId)||!context.principal.purposes.includes(context.purpose))throw new KnowledgeError('SCOPE_FORBIDDEN','Judgment context is unavailable',403);return [context.scope.projectId,context.scope.spaceId,context.principal.id,context.principal.clientInstallationId,context.purpose];}
const where='project_id=$1 AND space_id=$2 AND principal_id=$3 AND installation_id=$4 AND purpose=$5';
export function createPgRelationJudgments(pool:Pool,grant:KnowledgeWriterGrant):JudgmentOperationPort{
 async function tx<T>(context:ReadContext,id:string,run:(client:PoolClient)=>Promise<T>):Promise<T>{identity(context);const client=await pool.connect();let committing=false;
  try{await client.query('BEGIN');await assertKnowledgeWriterAuthority(client,context.scope.projectId,grant);
   const active=await client.query('SELECT mode FROM ccl_knowledge_writer_authority WHERE project_id=$1',[context.scope.projectId]);if(active.rows[0]?.mode!=='active')throw new KnowledgeError('WRITER_AUTHORITY_REQUIRED','Judgments require active writer authority',503);
   const value=await run(client);committing=true;await client.query('COMMIT');return value;
  }catch(error){if(committing)throw new JudgmentCommitUnknownError(id);await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}}
 function check(context:ReadContext,id:string,result:RelationJudgment,request:RelationJudgmentRequest,old?:RelationJudgment){RelationJudgmentSchema.parse(result);
  if(result.id!==id||result.request.purpose!==context.purpose||canonical(result.request)!==canonical(request)||result.evidence.some(item=>item.ref.projectId!==context.scope.projectId||item.ref.spaceId!==context.scope.spaceId)||
   [request.left,request.right].some(ref=>ref.projectId!==context.scope.projectId||ref.spaceId!==context.scope.spaceId)||old&&(result.createdAt!==old.createdAt||old.provider!==null&&result.inputFingerprint!==old.inputFingerprint))throw new KnowledgeError('JUDGMENT_BINDING_CHANGED','Judgment immutable identity or frozen input changed',409);}
 async function row(db:Pick<Pool,'query'>|PoolClient,context:ReadContext,id:string,lock=false){return (await db.query<Row>(`SELECT id,input_digest,request,result,state FROM ccl_knowledge_relation_judgments WHERE ${where} AND id=$6${lock?' FOR UPDATE':''}`,[...identity(context),id])).rows[0];}
 async function expire(context:ReadContext,item:Row):Promise<RelationJudgment>{
  if(!['reserved','running'].includes(item.state)||Date.parse(item.request.budget.deadline)>Date.now())return RelationJudgmentSchema.parse(item.result);
  return tx(context,item.id,async client=>{const current=await row(client,context,item.id,true);if(!current)throw new KnowledgeError('NOT_FOUND','Judgment unavailable',404);
   if(!['reserved','running'].includes(current.state)||Date.parse(current.request.budget.deadline)>Date.now())return current.result;
   const result=RelationJudgmentSchema.parse({...current.result,state:current.state==='reserved'?'failed':'outcome_unknown',reason:current.state==='reserved'?'Deadline elapsed before execution':'Running judgment expired; reconcile original provider request',completedAt:new Date().toISOString()});
   await client.query('UPDATE ccl_knowledge_relation_judgments SET state=$2,result=$3,updated_at=now() WHERE id=$1',[item.id,result.state,result]);return result;});}
 return {
  async reserve(context,key,inputDigest,request,initial){RelationJudgmentRequestSchema.parse(request);check(context,initial.id,initial,request);
   if(initial.state!=='reserved'||!key.trim()||key.length>200||!/^[0-9a-f]{64}$/.test(inputDigest))throw new KnowledgeError('JUDGMENT_RESERVATION_INVALID','Exact bounded judgment reservation required',422);
   return tx(context,initial.id,async client=>{const inserted=await client.query<Row>(`INSERT INTO ccl_knowledge_relation_judgments(id,project_id,space_id,principal_id,installation_id,purpose,request_key,input_digest,request,result,state)
    VALUES($6,$1,$2,$3,$4,$5,$7,$8,$9,$10,'reserved') ON CONFLICT DO NOTHING RETURNING id,input_digest,request,result,state`,[...identity(context),initial.id,key,inputDigest,request,initial]);
    if(inserted.rowCount)return {created:true,result:initial};const old=(await client.query<Row>(`SELECT id,input_digest,request,result,state FROM ccl_knowledge_relation_judgments WHERE ${where} AND request_key=$6 FOR UPDATE`,[...identity(context),key])).rows[0];
    if(!old||old.input_digest!==inputDigest||canonical(old.request)!==canonical(request))throw new KnowledgeError('IDEMPOTENCY_CONFLICT','Judgment key has different input or provider version',409);return {created:false,result:RelationJudgmentSchema.parse(old.result)};});},
  async start(context,id){return tx(context,id,async client=>{const current=await row(client,context,id,true);if(!current||current.state!=='reserved')return false;
   if(Date.parse(current.request.budget.deadline)<=Date.now()){const result=RelationJudgmentSchema.parse({...current.result,state:'failed',reason:'Deadline elapsed before execution',completedAt:new Date().toISOString()});await client.query('UPDATE ccl_knowledge_relation_judgments SET state=$2,result=$3 WHERE id=$1',[id,result.state,result]);return false;}
   const result=RelationJudgmentSchema.parse({...current.result,state:'running',cost:{modelCalls:{state:'unknown',reason:'Execution started'},tokens:{state:'unknown',reason:'No acknowledged usage'},money:{state:'unknown',reason:'Execution outcome not acknowledged'}}});
   await client.query('UPDATE ccl_knowledge_relation_judgments SET state=$2,result=$3,updated_at=now() WHERE id=$1',[id,result.state,result]);return true;});},
  async checkpoint(context,id,result){await tx(context,id,async client=>{const current=await row(client,context,id,true);if(!current||current.state!=='running'||result.state!=='running')throw new KnowledgeError('JUDGMENT_NOT_RUNNING','Only running judgment can be checkpointed',409);
   check(context,id,result,current.request,current.result);await client.query('UPDATE ccl_knowledge_relation_judgments SET result=$2,updated_at=now() WHERE id=$1',[id,result]);});},
  async finish(context,id,result){await tx(context,id,async client=>{const current=await row(client,context,id,true);if(!current||current.state!=='running'||['reserved','running'].includes(result.state))throw new KnowledgeError('JUDGMENT_NOT_RUNNING','Only running judgment can finish once',409);
   check(context,id,result,current.request,current.result);await client.query('UPDATE ccl_knowledge_relation_judgments SET state=$2,result=$3,updated_at=now() WHERE id=$1',[id,result.state,result]);});},
  async get(context,id){const found=await row(pool,context,id);return found?expire(context,found):null;},
  async lookup(context,key){const found=(await pool.query<Row>(`SELECT id,input_digest,request,result,state FROM ccl_knowledge_relation_judgments WHERE ${where} AND request_key=$6`,[...identity(context),key])).rows[0];return found?expire(context,found):null;},
 };
}
