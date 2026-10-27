import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {UseRecordSchema,FeedbackRecordSchema,ReadReceiptSchema,type UseInput,type FeedbackInput,type UseRecord,type FeedbackRecord,type KnowledgeRef,type KnowledgeStatus,type ReadReceipt,type ChangeItem} from '@commerce/knowledge-contracts';
import type {CapabilityContext} from '@commerce/knowledge-application';
import type {ReadContext} from '@commerce/knowledge-application';
import type {UseFeedbackPort} from '@commerce/knowledge-application';
import {evaluateKnowledgeRevision} from '@commerce/knowledge-application';
import {createKnowledgeStore} from '@commerce/knowledge-core/store';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {digest} from '@commerce/knowledge-core/utils';
import {assertKnowledgeWriterAuthority,type KnowledgeWriterGrant} from '@commerce/knowledge-core/writer-authority';
import {capabilityTransaction,migrateCapabilityReceipts,installCapabilityWriterGuards} from './transaction.ts';
import {createPgSourceRegistry} from './sources.ts';
const sameRef=(a:KnowledgeRef,b:KnowledgeRef)=>a.projectId===b.projectId&&a.spaceId===b.spaceId&&a.domain===b.domain&&a.objectId===b.objectId&&a.versionId===b.versionId&&a.contentDigest===b.contentDigest;
function readContext(context:ReadContext){if(context.scope.projectId!==context.principal.projectId||!context.principal.spaceIds.includes(context.scope.spaceId)||!context.principal.purposes.includes(context.purpose))throw new KnowledgeError('USE_READ_FORBIDDEN','Context is not authorized',403);}
export async function migrateKnowledgeUses(pool:Pool,options:{writerGrant?:KnowledgeWriterGrant}={}){await migrateCapabilityReceipts(pool);await pool.query(`
 CREATE TABLE IF NOT EXISTS ccl_knowledge_external_uses(project_id text NOT NULL,space_id text NOT NULL,principal_id text NOT NULL,id text PRIMARY KEY,payload jsonb NOT NULL);
 CREATE TABLE IF NOT EXISTS ccl_knowledge_external_feedback(project_id text NOT NULL,space_id text NOT NULL,principal_id text NOT NULL,id text PRIMARY KEY,feedback_key text NOT NULL,payload jsonb NOT NULL,
 UNIQUE(project_id,space_id,principal_id,feedback_key));
 CREATE TABLE IF NOT EXISTS ccl_knowledge_external_changes(sequence bigserial PRIMARY KEY,project_id text NOT NULL,space_id text NOT NULL,principal_id text NOT NULL,use_id text,feedback_id text,payload jsonb NOT NULL);
 ALTER TABLE ccl_knowledge_external_uses ADD COLUMN IF NOT EXISTS purpose text;
 ALTER TABLE ccl_knowledge_external_feedback ADD COLUMN IF NOT EXISTS purpose text;
 ALTER TABLE ccl_knowledge_external_changes ADD COLUMN IF NOT EXISTS purpose text;
 CREATE INDEX IF NOT EXISTS ccl_knowledge_external_changes_purpose_idx ON ccl_knowledge_external_changes(project_id,space_id,principal_id,purpose,sequence);
`);await installCapabilityWriterGuards(pool,["ccl_knowledge_external_uses", "ccl_knowledge_external_feedback", "ccl_knowledge_external_changes"]);
  const projects=await pool.query<{project_id:string}>(`SELECT DISTINCT project_id FROM (
    SELECT project_id FROM ccl_knowledge_external_uses WHERE purpose IS NULL UNION
    SELECT project_id FROM ccl_knowledge_external_feedback WHERE purpose IS NULL UNION
    SELECT project_id FROM ccl_knowledge_external_changes WHERE purpose IS NULL) pending`);
  for(const {project_id:projectId} of projects.rows){const client=await pool.connect();try{await client.query('BEGIN');
    await assertKnowledgeWriterAuthority(client,projectId,options.writerGrant);
    await client.query(`UPDATE ccl_knowledge_external_uses SET purpose=payload->>'purpose' WHERE project_id=$1 AND purpose IS NULL
      AND jsonb_typeof(payload->'purpose')='string' AND payload->>'purpose'<>''
      AND payload#>>'{snapshot,purpose}'=payload->>'purpose'`,[projectId]);
    await client.query(`UPDATE ccl_knowledge_external_feedback SET purpose=payload->>'purpose' WHERE project_id=$1 AND purpose IS NULL
      AND jsonb_typeof(payload->'purpose')='string' AND payload->>'purpose'<>''`,[projectId]);
    // Purpose is derived authorization metadata for legacy feedback. Its immutable payload and old digest stay byte-for-byte intact.
    await client.query(`UPDATE ccl_knowledge_external_feedback f SET purpose=u.purpose FROM ccl_knowledge_external_uses u
      WHERE f.project_id=$1 AND f.purpose IS NULL AND f.payload->>'useId'=u.id AND u.project_id=f.project_id
      AND u.space_id=f.space_id AND u.principal_id=f.principal_id AND u.purpose IS NOT NULL
      AND (f.payload->>'purpose' IS NULL OR f.payload->>'purpose'=u.purpose)`,[projectId]);
    await client.query(`UPDATE ccl_knowledge_external_changes c SET purpose=f.purpose FROM ccl_knowledge_external_feedback f
      WHERE c.project_id=$1 AND c.purpose IS NULL AND c.feedback_id=f.id AND f.project_id=c.project_id
      AND f.space_id=c.space_id AND f.principal_id=c.principal_id AND f.purpose IS NOT NULL
      AND (c.use_id IS NULL OR EXISTS(SELECT 1 FROM ccl_knowledge_external_uses u WHERE u.id=c.use_id
        AND u.project_id=c.project_id AND u.space_id=c.space_id AND u.principal_id=c.principal_id AND u.purpose=f.purpose))`,[projectId]);
    await client.query(`UPDATE ccl_knowledge_external_changes c SET purpose=u.purpose FROM ccl_knowledge_external_uses u
      WHERE c.project_id=$1 AND c.purpose IS NULL AND c.feedback_id IS NULL AND c.use_id=u.id
      AND u.project_id=c.project_id AND u.space_id=c.space_id AND u.principal_id=c.principal_id AND u.purpose IS NOT NULL`,[projectId]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');if(!(error instanceof KnowledgeError&&error.code==='KNOWLEDGE_WRITER_REVOKED'))throw error;
    // Activated projects without a matching server-held grant retain private NULL-purpose legacy rows.
  }finally{client.release();}}
}
async function item<T>(db:Pick<PoolClient,'query'>,context:ReadContext,table:'uses'|'feedback',id:string):Promise<T|null>{readContext(context);
 const rows=await db.query<{payload:T;purpose:string}>(`SELECT payload,purpose FROM ccl_knowledge_external_${table}
   WHERE project_id=$1 AND space_id=$2 AND principal_id=$3 AND id=$4 AND purpose=$5`,
   [context.scope.projectId,context.scope.spaceId,context.principal.id,id,context.purpose]);
 const row=rows.rows[0];if(!row)return null;
 // A proven legacy purpose is projected for authorization; it is never written into or rehashed in the original payload.
 return table==='feedback'&&row.payload&&typeof row.payload==='object'&&!('purpose' in row.payload)?
   {...row.payload,purpose:row.purpose}:row.payload;
}
async function event(client:PoolClient,context:ReadContext,kind:string,useId:string|null,feedbackId:string|null,refs:KnowledgeRef[]){const payload:ChangeItem={id:randomUUID(),kind,before:null,after:null,reason:kind==='use_recorded'?'Caller recorded an explicit decision about exact knowledge versions':'Caller feedback recorded; knowledge text unchanged',researchId:null,reviewReceiptId:null,cognitiveOutcome:null,affected:refs};
 await client.query(`INSERT INTO ccl_knowledge_external_changes(project_id,space_id,principal_id,purpose,use_id,feedback_id,payload) VALUES($1,$2,$3,$4,$5,$6,$7)`,[context.scope.projectId,context.scope.spaceId,context.principal.id,context.purpose,useId,feedbackId,payload]);}
/** External contexts never require an internal Task or creative draft. Observations stay distinct from reviewed facts. */
export function createPgUseFeedbackPort(pool:Pool,options:{writerGrant?:KnowledgeWriterGrant}={}):UseFeedbackPort{
 const store=createKnowledgeStore(pool),sources=createPgSourceRegistry(pool);
 async function assertKnowledgeAccess(context:ReadContext,ref:KnowledgeRef,expectedDigest?:string):Promise<void>{
  if(ref.domain!=='knowledge'||ref.projectId!==context.scope.projectId||ref.spaceId!==context.scope.spaceId)
   throw new KnowledgeError('FEEDBACK_ACCESS_REVOKED','Knowledge ref is outside the authorized scope',403);
  const view=await store.get(context.scope.projectId,{objectId:ref.objectId,versionId:ref.versionId});
  if(!view?.published||digest(view.revision)!==(expectedDigest??ref.contentDigest)||
    evaluateKnowledgeRevision(view,context.purpose).spaceId!==context.scope.spaceId||
    view.validity.issues.some(issue=>issue.reason==='source_rights_revoked'))
   throw new KnowledgeError('FEEDBACK_ACCESS_REVOKED','Current access to exact knowledge or its source rights was revoked',403);
 }
 async function assertSourceAccess(context:ReadContext,ref:KnowledgeRef):Promise<void>{
  if(ref.domain!=='source'||ref.projectId!==context.scope.projectId||ref.spaceId!==context.scope.spaceId||!ref.contentDigest)
    throw new KnowledgeError('FEEDBACK_ACCESS_REVOKED','Linked source is outside the authorized exact scope',403);
  const record=await sources.readRecord(context.scope,ref,context);
  if(!record||record.ref.contentDigest!==ref.contentDigest||!record.readability.contentReadable)
    throw new KnowledgeError('FEEDBACK_ACCESS_REVOKED','Linked source rights were revoked',403);
 }
 async function assertCurrentSnapshotAccess(context:ReadContext,record:Pick<UseRecord,'purpose'|'snapshot'>):Promise<void>{
  if(record.purpose!==context.purpose)throw new KnowledgeError('USE_PURPOSE_FORBIDDEN','Recorded use belongs to a different purpose',403);
  if(record.snapshot.effectiveScope.projectId!==context.scope.projectId||record.snapshot.effectiveScope.spaceId!==context.scope.spaceId||
    record.snapshot.purpose!==context.purpose)throw new KnowledgeError('USE_SNAPSHOT_ACCESS_REVOKED','Frozen use snapshot context changed',403);
  for(const item of record.snapshot.orderedItems)try{await assertKnowledgeAccess(context,item.ref,item.revisionDigest);}
    catch{throw new KnowledgeError('USE_SNAPSHOT_ACCESS_REVOKED','Current access to a frozen use snapshot was revoked; stored historical evidence is retained privately',403);}
 }
 async function assertFeedbackAccess(context:ReadContext,record:FeedbackRecord):Promise<void>{
  if(record.purpose!==context.purpose)throw new KnowledgeError('FEEDBACK_PURPOSE_FORBIDDEN','Feedback belongs to a different purpose',403);
  if(record.useId){const use=await item<UseRecord>(pool,context,'uses',record.useId);
    if(!use)throw new KnowledgeError('FEEDBACK_ACCESS_REVOKED','Linked use is unavailable for this purpose',403);
    try{await assertCurrentSnapshotAccess(context,use);}catch{throw new KnowledgeError('FEEDBACK_ACCESS_REVOKED','Linked use access was revoked',403);}}
  for(const ref of record.knowledgeRefs)await assertKnowledgeAccess(context,ref);
  if(record.sourceRef)await assertSourceAccess(context,record.sourceRef);
 }

 async function eligibility(context:ReadContext,ref:KnowledgeRef):Promise<KnowledgeStatus>{
  if(ref.projectId!==context.scope.projectId||ref.spaceId!==context.scope.spaceId||ref.domain!=='knowledge')throw new KnowledgeError('USE_REF_FORBIDDEN','Knowledge ref crosses the authorized scope',403);
  const view=await store.get(context.scope.projectId,{objectId:ref.objectId,versionId:ref.versionId});
  if(!view?.published||digest(view.revision)!==ref.contentDigest)throw new KnowledgeError('USE_REF_UNAVAILABLE','Exact knowledge version is unavailable',409);
  const policy=evaluateKnowledgeRevision(view,context.purpose);
  if(policy.spaceId!==context.scope.spaceId)throw new KnowledgeError('USE_REF_FORBIDDEN','Knowledge revision belongs to a different space',403);
  const issues=view.validity.issues.map(i=>i.reason);
  return {current:view.current,currentRef:view.current?ref:null,published:true,reviewDecision:view.review?.decision??null,policyVersion:view.review?.policyVersion??null,
   validity:{valid:view.validity.valid,issues,checkedAt:new Date().toISOString(),reviewDueAt:view.revision.scope.reviewDueAt},
   purpose:{requested:context.purpose,admitted:policy.admitted,reasons:policy.reasons},contentSupported:policy.contentSupported,
   historicalAt:view.current?null:view.revision.createdAt};
 }
 return {
 async use(context:CapabilityContext,input:UseInput,key:string){return capabilityTransaction(pool,context,'uses:write',key,input,options.writerGrant,async(client,id)=>{
  if(input.purpose!==context.purpose)throw new KnowledgeError('USE_PURPOSE_FORBIDDEN','Use purpose differs from authenticated context',403);
  const rows=await client.query<{payload:ReadReceipt}>(`SELECT payload FROM ccl_knowledge_read_receipts WHERE project_id=$1 AND space_id=$2 AND principal_id=$3 AND id=$4 AND expires_at>now()`,[context.scope.projectId,context.scope.spaceId,context.principal.id,input.readReceiptId]);
  if(!rows.rows[0])throw new KnowledgeError('READ_RECEIPT_UNAVAILABLE','Read receipt is unavailable or expired; exact readset is never replaced with current heads',409);
  const snapshot=ReadReceiptSchema.parse(rows.rows[0].payload);
  if(snapshot.purpose!==input.purpose||snapshot.clientInstallationId!==context.principal.clientInstallationId)throw new KnowledgeError('READ_RECEIPT_CONTEXT_MISMATCH','Receipt purpose or client installation differs',403);
  await assertCurrentSnapshotAccess(context,{purpose:input.purpose,snapshot});
  const keys=new Set<string>();const eligibilityAtUse:UseRecord['eligibilityAtUse']=[];
  for(const choice of input.considered){const k=`${choice.ref.objectId}/${choice.ref.versionId}`;
   if(keys.has(k)||!snapshot.orderedItems.some(i=>sameRef(i.ref,choice.ref)))throw new KnowledgeError('USE_READSET_MISMATCH','Decisions must name unique exact members of the frozen readset',422);keys.add(k);
   const status=await eligibility(context,choice.ref);if(['adopted','adapted'].includes(choice.decision)&&!status.purpose.admitted)throw new KnowledgeError('USE_NOT_ELIGIBLE','Selected historical, invalid or unreviewed knowledge is not eligible for this purpose',409);
   eligibilityAtUse.push({ref:choice.ref,status});}
  const result=UseRecordSchema.parse({...input,id,snapshot,eligibilityAtUse,createdAt:new Date().toISOString()});
  await client.query(`INSERT INTO ccl_knowledge_external_uses(project_id,space_id,principal_id,purpose,id,payload) VALUES($1,$2,$3,$4,$5,$6)`,[context.scope.projectId,context.scope.spaceId,context.principal.id,context.purpose,id,result]);
  await event(client,context,'use_recorded',id,null,input.considered.map(c=>c.ref));return result;
 },result=>assertCurrentSnapshotAccess(context,result));},
 async feedback(context:CapabilityContext,input:FeedbackInput,key:string){return capabilityTransaction(pool,context,'feedback:write',key,input,options.writerGrant,async(client,id)=>{
   if(input.purpose!==context.purpose)throw new KnowledgeError('FEEDBACK_PURPOSE_FORBIDDEN','Feedback purpose differs from authenticated context',403);
   const existing=(await client.query<{purpose:string|null;payload:FeedbackRecord}>(`SELECT purpose,payload FROM ccl_knowledge_external_feedback WHERE project_id=$1 AND space_id=$2 AND principal_id=$3 AND feedback_key=$4`,[context.scope.projectId,context.scope.spaceId,context.principal.id,input.feedbackKey])).rows[0];
   if(existing){const {id:_id,version:_v,digest:_d,supersedes:_s,sourceRef:_r,maintenanceState:_m,...original}=existing.payload;
     const {purpose:_inputPurpose,...legacyInput}=input;
     const comparable=Object.prototype.hasOwnProperty.call(existing.payload,'purpose')?input:legacyInput;
     if(existing.purpose!==context.purpose||digest(original)!==digest(comparable))throw new KnowledgeError('FEEDBACK_KEY_CONFLICT','Feedback key already names different input or purpose',409);
     const current=await item<FeedbackRecord>(client,context,'feedback',existing.payload.id);
     if(!current)throw new KnowledgeError('FEEDBACK_ACCESS_REVOKED','Feedback is unavailable for this purpose',403);
     await assertFeedbackAccess(context,current);return current;}
   let use:UseRecord|null=null;if(input.useId){use=await item<UseRecord>(client,context,'uses',input.useId);if(!use)throw new KnowledgeError('USE_UNAVAILABLE','Use is unavailable to this caller',404);
     await assertCurrentSnapshotAccess(context,use);
     if(digest(input.context)!==digest(use.context))throw new KnowledgeError('FEEDBACK_CONTEXT_MISMATCH','Feedback context differs from the recorded use',422);}
   for(const ref of input.knowledgeRefs){if(use&&!use.considered.some(c=>sameRef(c.ref,ref)))throw new KnowledgeError('FEEDBACK_USE_MISMATCH','Feedback knowledge was not considered in this use',422);await eligibility(context,ref);await assertKnowledgeAccess(context,ref);}
   const result=FeedbackRecordSchema.parse({...input,id,version:'1',digest:digest(input),supersedes:null,sourceRef:null,maintenanceState:'not_requested'});
   await client.query(`INSERT INTO ccl_knowledge_external_feedback(project_id,space_id,principal_id,purpose,id,feedback_key,payload) VALUES($1,$2,$3,$4,$5,$6,$7)`,[context.scope.projectId,context.scope.spaceId,context.principal.id,context.purpose,id,input.feedbackKey,result]);
   await event(client,context,'feedback_recorded',input.useId,id,input.knowledgeRefs);return result;
 },async(result,client)=>{const current=await item<FeedbackRecord>(client,context,'feedback',result.id);
   if(!current)throw new KnowledgeError('FEEDBACK_ACCESS_REVOKED','Current feedback is unavailable for this purpose',403);
   await assertFeedbackAccess(context,current);});},
 getUse:async(context,id)=>{const epoch=await store.epoch(context.scope.projectId);
   const record=await item<UseRecord>(pool,context,'uses',id);if(record)await assertCurrentSnapshotAccess(context,record);
   if(await store.epoch(context.scope.projectId)!==epoch)throw new KnowledgeError('READSET_CHANGED','Knowledge or source rights changed during use access check',409);
   return record;},
 getFeedback:async(context,id)=>{const epoch=await store.epoch(context.scope.projectId);
   const record=await item<FeedbackRecord>(pool,context,'feedback',id);if(record)await assertFeedbackAccess(context,record);
   if(await store.epoch(context.scope.projectId)!==epoch)throw new KnowledgeError('READSET_CHANGED','Knowledge or source rights changed during feedback access check',409);
   return record;},
 async changes(context,after,limit,useId,feedbackId){readContext(context);if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new KnowledgeError('CHANGES_LIMIT','Changes limit must be 1–100',400);
  const epoch=await store.epoch(context.scope.projectId);
  const binding=digest({scope:context.scope,principal:context.principal.id,purpose:context.purpose,useId,feedbackId});
  let cursor=0;if(after){try{const decoded=JSON.parse(Buffer.from(after,'base64url').toString());
    if(decoded.scope!==binding||!Number.isSafeInteger(decoded.sequence)||decoded.sequence<0)throw new Error();cursor=decoded.sequence;
  }catch{throw new KnowledgeError('CHANGES_CURSOR','Cursor does not match this scope, purpose and filter',400);}}
  const scanLimit=Math.min(500,Math.max(100,limit*5));
  const rows=await pool.query<{sequence:string;payload:ChangeItem;use_id:string|null;feedback_id:string|null}>(`
    SELECT sequence,payload,use_id,feedback_id FROM ccl_knowledge_external_changes
    WHERE project_id=$1 AND space_id=$2 AND principal_id=$3 AND purpose=$4 AND sequence>$5
      AND ($6::text IS NULL OR use_id=$6) AND ($7::text IS NULL OR feedback_id=$7)
    ORDER BY sequence LIMIT $8`,[context.scope.projectId,context.scope.spaceId,context.principal.id,context.purpose,cursor,useId??null,feedbackId??null,scanLimit+1]);
  const visible:ChangeItem[]=[];let consumed=0,lastSequence=cursor;
  for(const row of rows.rows.slice(0,scanLimit)){
    consumed++;lastSequence=Number(row.sequence);
    try{
      if(row.use_id){const use=await item<UseRecord>(pool,context,'uses',row.use_id);
        if(!use)continue;await assertCurrentSnapshotAccess(context,use);}
      if(row.feedback_id){const feedback=await item<FeedbackRecord>(pool,context,'feedback',row.feedback_id);
        if(!feedback)continue;await assertFeedbackAccess(context,feedback);}
      for(const ref of [row.payload.before,row.payload.after,...row.payload.affected]){
        if(!ref)continue;
        if(ref.domain==='knowledge')await assertKnowledgeAccess(context,ref);
        else if(ref.domain==='source')await assertSourceAccess(context,ref);
        else throw new KnowledgeError('CHANGES_REF_UNAVAILABLE','Change ref has no current owner access proof',403);
      }
      visible.push(row.payload);if(visible.length>=limit)break;
    }catch(error){if(error instanceof KnowledgeError&&error.status>=400&&error.status<500)continue;throw error;}
  }
  const hasMore=rows.rows.length>consumed;
  if(await store.epoch(context.scope.projectId)!==epoch)throw new KnowledgeError('READSET_CHANGED','Knowledge or source rights changed during changes access check',409);
  return {data:{items:visible},hasMore,nextCursor:consumed?
    Buffer.from(JSON.stringify({scope:binding,sequence:lastSequence})).toString('base64url'):after??null};}
 };
}
