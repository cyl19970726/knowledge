import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {ReadContext} from '@commerce/knowledge-application';
import {FeedbackInputSchema,FeedbackRecordSchema,type LookupResult,type Operation} from '@commerce/knowledge-contracts';
import type {CapabilityContext} from '@commerce/knowledge-application';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {digest} from '@commerce/knowledge-core/utils';
import {assertKnowledgeWriterAuthority,type KnowledgeWriterGrant} from '@commerce/knowledge-core/writer-authority';
export class CapabilityWriteError extends KnowledgeError {readonly commitStatus='unknown';readonly operationId:string;
  constructor(id:string){super('COMMIT_OUTCOME_UNKNOWN','Commit acknowledgement was lost; reconcile the same operation key before any retry',503);this.operationId=id;}}
export async function migrateCapabilityReceipts(pool:Pool){await pool.query(`CREATE TABLE IF NOT EXISTS ccl_knowledge_capability_receipts(
 project_id text NOT NULL,space_id text NOT NULL,principal_id text NOT NULL,action text NOT NULL,request_key text NOT NULL,
 id text NOT NULL UNIQUE,input_digest text NOT NULL,purpose text,result jsonb,PRIMARY KEY(project_id,space_id,principal_id,action,request_key))`);
 await pool.query('ALTER TABLE ccl_knowledge_capability_receipts ADD COLUMN IF NOT EXISTS purpose text');
 await installCapabilityWriterGuards(pool,['ccl_knowledge_capability_receipts']);}
/** Older rows are visible only when their immutable result proves one unambiguous purpose. */
function receiptPurpose(row:{purpose:string|null;result:unknown}):string|null{
  if(row.purpose)return row.purpose;
  if(!row.result||typeof row.result!=='object')return null;
  const value=row.result as {purpose?:unknown;snapshot?:{purpose?:unknown}};
  const direct=typeof value.purpose==='string'&&value.purpose.trim()?value.purpose:null;
  const snapshot=typeof value.snapshot?.purpose==='string'&&value.snapshot.purpose.trim()?value.snapshot.purpose:null;
  return direct&&snapshot&&direct!==snapshot?null:direct??snapshot;
}
type ReceiptRow<T>={id:string;input_digest:string;action:string;purpose:string|null;result:T};
/** A legacy feedback result has no purpose field; bind it to the current canonical row by exact ID and original digest. */
async function resolvedReceipt<T>(db:Pick<PoolClient,'query'>,context:ReadContext,row:ReceiptRow<T>):Promise<{purpose:string|null;result:T;legacyFeedback:boolean}>{
  const explicit=receiptPurpose(row);
  if(explicit||row.action!=='feedback:write'||row.purpose!==null||!row.result||typeof row.result!=='object')
    return {purpose:explicit,result:row.result,legacyFeedback:false};
  const raw=row.result as {id?:unknown;digest?:unknown;feedbackKey?:unknown;purpose?:unknown};
  if(raw.purpose!==undefined||typeof raw.id!=='string'||typeof raw.digest!=='string'||raw.digest!==row.input_digest||
    typeof raw.feedbackKey!=='string')return {purpose:null,result:row.result,legacyFeedback:false};
  let canonical:{purpose:string|null;feedback_key:string;payload:unknown}|undefined;
  try{canonical=(await db.query<{purpose:string|null;feedback_key:string;payload:unknown}>(`
    SELECT purpose,feedback_key,payload FROM ccl_knowledge_external_feedback
    WHERE project_id=$1 AND space_id=$2 AND principal_id=$3 AND id=$4`,
    [context.scope.projectId,context.scope.spaceId,context.principal.id,raw.id])).rows[0];}
  catch(error){if((error as {code?:string}).code==='42P01')return {purpose:null,result:row.result,legacyFeedback:false};throw error;}
  if(!canonical?.purpose||canonical.feedback_key!==raw.feedbackKey||!canonical.payload||typeof canonical.payload!=='object')
    return {purpose:null,result:row.result,legacyFeedback:false};
  const saved=canonical.payload as {id?:unknown;digest?:unknown;purpose?:unknown};
  if(saved.id!==raw.id||saved.digest!==raw.digest||(saved.purpose!==undefined&&saved.purpose!==canonical.purpose))
    return {purpose:null,result:row.result,legacyFeedback:false};
  const parsed=FeedbackRecordSchema.safeParse({...raw,purpose:canonical.purpose});
  if(!parsed.success)return {purpose:null,result:row.result,legacyFeedback:false};
  return {purpose:canonical.purpose,result:parsed.data as unknown as T,legacyFeedback:true};
}
/** Key reservation and result are one transaction. A lost response must be reconciled by the original key. */
export async function capabilityTransaction<T>(pool:Pool,context:CapabilityContext,action:string,key:string,input:unknown,
 writerGrant:KnowledgeWriterGrant|undefined,apply:(client:PoolClient,id:string)=>Promise<T>,validateReplay?:(result:T,client:PoolClient)=>Promise<void>):Promise<T>{
  if(!key.trim()||key.length>200)throw new KnowledgeError('IDEMPOTENCY_KEY_REQUIRED','Explicit bounded idempotency key required',400);
  const client=await pool.connect(),id=randomUUID(),inputDigest=digest(input);let committing=false;let operationId:string=id;
  try{await client.query('BEGIN');await assertKnowledgeWriterAuthority(client,context.scope.projectId,writerGrant);
    const args=[context.scope.projectId,context.scope.spaceId,context.principal.id,action,key];
    const old=(await client.query<ReceiptRow<T>>(`SELECT id,input_digest,action,purpose,result FROM ccl_knowledge_capability_receipts
      WHERE project_id=$1 AND space_id=$2 AND principal_id=$3 AND action=$4 AND request_key=$5`,args)).rows[0];
    if(old){const resolved=await resolvedReceipt(client,context,old);
      if(resolved.purpose!==context.purpose)throw new KnowledgeError('OPERATION_PURPOSE_MISMATCH','Operation key belongs to another or unproven purpose',403);
      if(old.input_digest!==inputDigest){
        const parsed=resolved.legacyFeedback?FeedbackInputSchema.safeParse(input):null;
        if(!parsed?.success){throw new KnowledgeError('IDEMPOTENCY_CONFLICT','Same operation key names different input',409);}
        const {purpose:_purpose,...legacyInput}=parsed.data;
        if(digest(legacyInput)!==old.input_digest)throw new KnowledgeError('IDEMPOTENCY_CONFLICT','Same operation key names different input',409);
      }
      operationId=old.id;if(validateReplay)await validateReplay(resolved.result,client);committing=true;await client.query('COMMIT');return resolved.result;}
    await client.query(`INSERT INTO ccl_knowledge_capability_receipts(project_id,space_id,principal_id,action,request_key,id,input_digest,purpose)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[...args,id,inputDigest,context.purpose]);
    const result=await apply(client,id);
    await client.query('UPDATE ccl_knowledge_capability_receipts SET result=$2 WHERE id=$1',[id,result]);
    committing=true;await client.query('COMMIT');return result;
  }catch(error){if(committing)throw new CapabilityWriteError(operationId);await client.query('ROLLBACK');throw error;}finally{client.release();}
}

/** Static installer input only. Read receipts intentionally remain writable in a readonly knowledge API. */
export async function installCapabilityWriterGuards(pool:Pool,tables:readonly string[]){
 for(const table of tables){if(!/^ccl_knowledge_[a-z_]+$/.test(table))throw new Error('Invalid capability table');
 await pool.query(`DROP TRIGGER IF EXISTS ccl_writer_guard ON ${table}; CREATE TRIGGER ccl_writer_guard BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION ccl_assert_knowledge_writer()`);}
}

const reconciliationCost={modelCalls:{state:'known' as const,value:0},tokens:{state:'known' as const,value:0},money:{state:'unknown' as const,reason:'Synchronous capability record; no billing inference'}};
function receiptOperation(row:{id:string;input_digest:string;action:string}):Operation{return {id:row.id,state:'succeeded',inputDigest:row.input_digest,commitStatus:'committed',statusUrl:`operations/${row.id}`,attemptId:null,reason:`Committed ${row.action}; read current authorized result or replay the same key`,cost:reconciliationCost};}
function assertLookupContext(context:ReadContext){if(context.scope.projectId!==context.principal.projectId||!context.principal.spaceIds.includes(context.scope.spaceId)||!context.principal.purposes.includes(context.purpose))throw new KnowledgeError('OPERATION_LOOKUP_FORBIDDEN','Operation lookup context is not authorized',403);}
export async function lookupCapabilityOperation(pool:Pool,context:ReadContext,action:string,key:string):Promise<LookupResult>{
 assertLookupContext(context);
 const row=(await pool.query<ReceiptRow<unknown>>(`SELECT id,input_digest,action,purpose,result FROM ccl_knowledge_capability_receipts WHERE project_id=$1 AND space_id=$2 AND principal_id=$3 AND action=$4 AND request_key=$5 AND result IS NOT NULL`,[context.scope.projectId,context.scope.spaceId,context.principal.id,action,key])).rows[0];
 return row&&(await resolvedReceipt(pool,context,row)).purpose===context.purpose?{state:'committed',operation:receiptOperation(row),reservationState:'committed'}:{state:'unknown',operation:null,reservationState:null};
}
export async function getCapabilityOperation(pool:Pool,context:ReadContext,id:string):Promise<Operation|null>{assertLookupContext(context);
 const row=(await pool.query<ReceiptRow<unknown>>(`SELECT id,input_digest,action,purpose,result FROM ccl_knowledge_capability_receipts WHERE project_id=$1 AND space_id=$2 AND principal_id=$3 AND id=$4 AND result IS NOT NULL`,[context.scope.projectId,context.scope.spaceId,context.principal.id,id])).rows[0];return row&&(await resolvedReceipt(pool,context,row)).purpose===context.purpose?receiptOperation(row):null;}
