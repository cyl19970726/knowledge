import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {SourceRecordSchema,SourceContentSchema,SourceUpsertSchema,type SourceUpsert,type SourceRecord,type KnowledgeRef,type Scope,type SourceAccessProof} from '@commerce/knowledge-contracts';
import type {CapabilityContext,SourceRegistryPort} from '@commerce/knowledge-application';
import type {ReadContext} from '@commerce/knowledge-application';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {digest} from '@commerce/knowledge-core/utils';
import type {KnowledgeWriterGrant} from '@commerce/knowledge-core/writer-authority';
import {capabilityTransaction,migrateCapabilityReceipts,installCapabilityWriterGuards} from './transaction.ts';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
interface SourceRow {object_id:string;version_id:string;head_version:string;generation:string;owner_id:string;revoked:boolean;payload:SourceUpsert;receipt_id:string;supersedes:KnowledgeRef|null;readers:string[]}
export async function migrateManagedSources(pool:Pool){await migrateCapabilityReceipts(pool);await pool.query(`
 CREATE TABLE IF NOT EXISTS ccl_knowledge_source_heads(project_id text NOT NULL,space_id text NOT NULL,object_id text NOT NULL,
 adapter_id text NOT NULL,external_id text NOT NULL,head_version text NOT NULL,generation bigint NOT NULL,
 owner_id text NOT NULL,revoked boolean NOT NULL DEFAULT false,readers jsonb NOT NULL,
 PRIMARY KEY(project_id,space_id,object_id),UNIQUE(project_id,space_id,adapter_id,external_id));
 CREATE TABLE IF NOT EXISTS ccl_knowledge_source_versions(project_id text NOT NULL,space_id text NOT NULL,object_id text NOT NULL,
 version_id text NOT NULL,external_version text NOT NULL,payload jsonb NOT NULL,receipt_id text NOT NULL,supersedes jsonb,
 PRIMARY KEY(project_id,space_id,object_id,version_id),UNIQUE(project_id,space_id,object_id,external_version));`);await installCapabilityWriterGuards(pool,["ccl_knowledge_source_heads", "ccl_knowledge_source_versions"]);}
function assertRead(context:ReadContext,ref:KnowledgeRef){if(context.scope.projectId!==context.principal.projectId||!context.principal.spaceIds.includes(context.scope.spaceId)||
 !context.principal.purposes.includes(context.purpose)||ref.projectId!==context.scope.projectId||ref.spaceId!==context.scope.spaceId||ref.domain!=='source')
 throw new KnowledgeError('SOURCE_FORBIDDEN','Source is outside the authorized context',403);}
async function rowFor(db:Pick<PoolClient,'query'>,scope:Scope,ref:KnowledgeRef):Promise<SourceRow|null>{const r=await db.query<SourceRow>(`SELECT v.*,h.head_version,h.generation,h.owner_id,h.revoked,h.readers
 FROM ccl_knowledge_source_versions v JOIN ccl_knowledge_source_heads h USING(project_id,space_id,object_id)
 WHERE v.project_id=$1 AND v.space_id=$2 AND v.object_id=$3 AND v.version_id=$4`,[scope.projectId,scope.spaceId,ref.objectId,ref.versionId]);
 const row=r.rows[0];if(row&&ref.contentDigest!==null&&row.payload.contentDigest!==ref.contentDigest)throw new KnowledgeError('SOURCE_DIGEST_MISMATCH','Exact source digest differs',409);return row??null;}
const refFor=(scope:Scope,row:SourceRow):KnowledgeRef=>({...scope,domain:'source',objectId:row.object_id,versionId:row.version_id,contentDigest:row.payload.contentDigest});
function readable(row:SourceRow,principalId:string){return !row.revoked&&row.readers.includes(principalId)&&row.payload.custody.mode==='managed_copy';}
/** Feedback-derived managed copies inherit the observation's one authenticated purpose. */
function assertCallerFeedbackPurpose(row:SourceRow,context:ReadContext):void{
 if(row.payload.sourceKind!=='caller_feedback')return;
 if(row.payload.sourceSchemaVersion!=='feedback-source/1.0'||row.payload.custody.mode!=='managed_copy')
   throw new KnowledgeError('SOURCE_PURPOSE_FORBIDDEN','Feedback source purpose cannot be established',403);
 let value:unknown;try{value=JSON.parse(row.payload.custody.text);}catch{}
 if(!value||typeof value!=='object'||!('schemaVersion' in value)||value.schemaVersion!=='feedback-source/1.0'||
   !('purpose' in value)||typeof value.purpose!=='string'||!value.purpose.trim()||value.purpose!==context.purpose)
   throw new KnowledgeError('SOURCE_PURPOSE_FORBIDDEN','Feedback source is unavailable for this purpose',403);
}
function record(scope:Scope,row:SourceRow,principalId:string):SourceRecord {const can=readable(row,principalId),stored=SourceUpsertSchema.safeParse(row.payload);
 const provenance=stored.success?{externalIdentity:stored.data.externalIdentity,author:stored.data.author,publisher:stored.data.publisher,
   acquirer:stored.data.acquirer,obtainedAt:stored.data.obtainedAt,publishedAt:stored.data.publishedAt,
   custody:{mode:stored.data.custody.mode},rightsPolicyRef:stored.data.rightsPolicyRef}:undefined;
 return SourceRecordSchema.parse({ref:refFor(scope,row),head:{...scope,domain:'source',objectId:row.object_id,versionId:row.head_version,contentDigest:row.head_version===row.version_id?row.payload.contentDigest:null},
 sourceSchemaVersion:row.payload.sourceSchemaVersion,sourceKind:row.payload.sourceKind,assertionKind:row.payload.assertionKind,sourceGroups:row.payload.sourceGroups,
 readability:{metadataVisible:row.readers.includes(principalId),contentReadable:can,anchorResolved:can,assurance:row.payload.custody.mode==='managed_copy'?'local_transaction':'read_time_only',
 reasons:row.revoked?['source_revoked']:row.payload.custody.mode==='reference_only'?['external_owner_lease_unavailable']:!can?['source_read_forbidden']:[]},actualCoverage:[],limitations:row.payload.limitations,supersedes:row.supersedes,receiptId:row.receipt_id,
 ...(provenance?{provenance}:{})});}
/** A replayed write receipt must not present historical rights or head state as current. */
export async function assertCurrentSourceReplay(client:PoolClient,context:CapabilityContext,result:SourceRecord,expectedRightsPolicyRef:string):Promise<void>{
 const saved=SourceRecordSchema.parse(result);
 if(saved.ref.projectId!==context.scope.projectId||saved.ref.spaceId!==context.scope.spaceId||saved.ref.domain!=='source')
   throw new KnowledgeError('SOURCE_REPLAY_STALE','Source replay scope changed',409);
 const row=await rowFor(client,context.scope,saved.ref);
 if(!row||row.revoked||row.owner_id!==context.principal.id||!row.readers.includes(context.principal.id)||
   row.head_version!==saved.ref.versionId||row.payload.rightsPolicyRef!==expectedRightsPolicyRef)
   throw new KnowledgeError('SOURCE_REPLAY_STALE','Source head or rights changed since the original write',409);
 const current=record(context.scope,row,context.principal.id);
 if(digest(current.head)!==digest(saved.head)||digest(current.readability)!==digest(saved.readability))
   throw new KnowledgeError('SOURCE_REPLAY_STALE','Source availability changed since the original write',409);
}
/** Caller holds the same project writer transaction and owns the idempotency reservation. */
export async function upsertSourceInTransaction(client:PoolClient,context:CapabilityContext,input:SourceUpsert,id:string,
 options:{readerIds?:readonly string[]}={}):Promise<SourceRecord>{
   if(input.custody.mode==='managed_copy'&&sha(input.custody.text)!==input.contentDigest)throw new KnowledgeError('SOURCE_CONTENT_DIGEST','Submitted text does not match content digest',422);
   const identity=input.externalIdentity;
   const old=(await client.query<SourceRow>(`SELECT * FROM ccl_knowledge_source_heads WHERE project_id=$1 AND space_id=$2 AND adapter_id=$3 AND external_id=$4`,[context.scope.projectId,context.scope.spaceId,identity.adapterId,identity.externalObjectId])).rows[0];
   if((old?.head_version??null)!==input.expectedSourceHead||input.existingObjectId&&input.existingObjectId!==old?.object_id)
     throw new KnowledgeError('SOURCE_HEAD_CONFLICT','Expected source head no longer matches',409);
   if(old&&(old.owner_id!==context.principal.id||old.revoked))throw new KnowledgeError('SOURCE_OWNER_FORBIDDEN','Source owner was changed or rights revoked',403);
   const objectId=old?.object_id??randomUUID(),versionId=randomUUID();
   const supersedes=old?{...context.scope,domain:'source' as const,objectId,versionId:old.head_version,contentDigest:null}:null;
   const readers=[...new Set([context.principal.id,...options.readerIds??[]])];
   await client.query(`INSERT INTO ccl_knowledge_source_heads(project_id,space_id,object_id,adapter_id,external_id,head_version,generation,owner_id,readers)
    VALUES($1,$2,$3,$4,$5,$6,1,$7,$8) ON CONFLICT(project_id,space_id,object_id) DO UPDATE SET head_version=$6,generation=ccl_knowledge_source_heads.generation+1`,
    [context.scope.projectId,context.scope.spaceId,objectId,identity.adapterId,identity.externalObjectId,versionId,context.principal.id,JSON.stringify(readers)]);
   await client.query(`INSERT INTO ccl_knowledge_source_versions(project_id,space_id,object_id,version_id,external_version,payload,receipt_id,supersedes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [context.scope.projectId,context.scope.spaceId,objectId,versionId,identity.externalVersion,input,id,supersedes]);
   if(old)await client.query(`INSERT INTO ccl_knowledge_invalidities(project_id,domain,object_id,version_id,reason,state)
    VALUES($1,'source',$2,$3,'source_superseded','stale') ON CONFLICT DO NOTHING`,[context.scope.projectId,objectId,old.head_version]);
   await client.query('UPDATE ccl_knowledge_projects SET epoch=epoch+1 WHERE project_id=$1',[context.scope.projectId]);
   await client.query(`INSERT INTO ccl_knowledge_events(project_id,kind,data) VALUES($1,'SourceRegistered',$2)`,[context.scope.projectId,{sourceRef:{objectId,versionId},supersedes,generation:old?Number(old.generation)+1:1}]);
   return record(context.scope,(await rowFor(client,context.scope,{...context.scope,domain:'source',objectId,versionId,contentDigest:input.contentDigest}))!,context.principal.id);
}
/** The source owner and knowledge writer share the project transaction barrier. External leases are never inferred. */
export function createPgSourceRegistry(pool:Pool,options:{writerGrant?:KnowledgeWriterGrant;readerIds?:readonly string[]}={}):SourceRegistryPort{return{
 async upsert(context:CapabilityContext,input:SourceUpsert,key:string){return capabilityTransaction(pool,context,'sources:upsert',key,input,options.writerGrant,
   (client,id)=>upsertSourceInTransaction(client,context,input,id,options),
   (result,client)=>assertCurrentSourceReplay(client,context,result,input.rightsPolicyRef));},
 async revoke(context,ref,expectedGeneration,key){assertRead(context,ref);return capabilityTransaction(pool,context,'sources:revoke',key,{ref,expectedGeneration},options.writerGrant,async(client)=>{
   const row=await rowFor(client,context.scope,ref);if(!row||row.owner_id!==context.principal.id)throw new KnowledgeError('SOURCE_OWNER_FORBIDDEN','Only the source owner may revoke',403);
   if(Number(row.generation)!==expectedGeneration)throw new KnowledgeError('SOURCE_GENERATION_CONFLICT','Source owner generation changed',409);
   await client.query('UPDATE ccl_knowledge_source_heads SET revoked=true,generation=generation+1 WHERE project_id=$1 AND space_id=$2 AND object_id=$3',[context.scope.projectId,context.scope.spaceId,ref.objectId]);
   // Existing direct and indirect consumers become invalid in the same commit. No second revision/head authority.
   await client.query(`INSERT INTO ccl_knowledge_invalidities(project_id,domain,object_id,version_id,reason,state)
    SELECT project_id,'source',object_id,version_id,'source_rights_revoked','withdrawn' FROM ccl_knowledge_source_versions
    WHERE project_id=$1 AND space_id=$2 AND object_id=$3 ON CONFLICT DO NOTHING`,[context.scope.projectId,context.scope.spaceId,ref.objectId]);
   await client.query('UPDATE ccl_knowledge_projects SET epoch=epoch+1 WHERE project_id=$1',[context.scope.projectId]);
   await client.query(`INSERT INTO ccl_knowledge_events(project_id,kind,data) VALUES($1,'SourceRightsRevoked',$2)`,[context.scope.projectId,{ref,generation:expectedGeneration+1}]);
   return record(context.scope,{...row,revoked:true,generation:String(expectedGeneration+1)},context.principal.id);
 });},
 async readRecord(scope,ref,context){assertRead(context,ref);const row=await rowFor(pool,scope,ref);if(!row||!row.readers.includes(context.principal.id))return null;
   assertCallerFeedbackPurpose(row,context);return record(scope,row,context.principal.id);},
 async readContent(scope,ref,anchor,context){assertRead(context,ref);const row=await rowFor(pool,scope,ref);if(!row)return null;
   if(!readable(row,context.principal.id)||row.payload.custody.mode!=='managed_copy')throw new KnowledgeError('SOURCE_UNREADABLE','Source content is unavailable or revoked',403);
   assertCallerFeedbackPurpose(row,context);
   const selected=anchor??null;if(selected&&!row.payload.anchors.some(a=>JSON.stringify(a)===JSON.stringify(selected)))throw new KnowledgeError('SOURCE_ANCHOR_UNRESOLVED','Requested anchor is not registered',422);
   return SourceContentSchema.parse({ref:refFor(scope,row),contentDigest:row.payload.contentDigest,content:row.payload.custody.text,anchor:selected,
    actualCoverage:{sourceRef:refFor(scope,row),anchors:selected?[selected]:row.payload.anchors,byteCount:Buffer.byteLength(row.payload.custody.text),coverage:'full',exclusions:[],readAt:new Date().toISOString(),readerAuthority:'knowledge-local-source-owner',readProofId:row.receipt_id},readability:record(scope,row,context.principal.id).readability});},
 async proof(context,ref){assertRead(context,ref);const row=await rowFor(pool,context.scope,ref);if(!row||!readable(row,context.principal.id))throw new KnowledgeError('SOURCE_PROOF_UNAVAILABLE','A local readable managed source is required',403);
   assertCallerFeedbackPurpose(row,context);
   return {ownerId:row.owner_id,sourceRef:refFor(context.scope,row),digest:row.payload.contentDigest,subject:context.principal.id,audience:'knowledge-publication',purpose:context.purpose,
    ownerGeneration:String(row.generation),validUntil:new Date(Date.now()+60_000).toISOString(),assurance:'local_transaction'};}
};}
/** Recheck under the publication transaction's same project lock; a read-time proof alone is insufficient. */
export async function assertLocalSourceProof(client:PoolClient,context:ReadContext,proof:SourceAccessProof){assertRead(context,proof.sourceRef);
 await client.query('SELECT 1 FROM ccl_knowledge_projects WHERE project_id=$1 FOR UPDATE',[context.scope.projectId]);
 const row=await rowFor(client,context.scope,proof.sourceRef);
 if(!row||proof.assurance!=='local_transaction'||proof.subject!==context.principal.id||proof.audience!=='knowledge-publication'||proof.purpose!==context.purpose||
  Date.parse(proof.validUntil)<=Date.now()||proof.ownerId!==row.owner_id||proof.ownerGeneration!==String(row.generation)||proof.digest!==row.payload.contentDigest||!readable(row,context.principal.id))
 throw new KnowledgeError('SOURCE_PROOF_REVOKED','Source rights, digest, generation or proof expiry changed before commit',409);
}
