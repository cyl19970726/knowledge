import {publishedCoordinationOutcome,completedCoordinationOutcome} from './coordination-finalization.ts';
import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {IdSchema,TimestampSchema} from '@commerce/contract-primitives';
import {KnowledgeRefSchema,MaintenanceCollectResultSchema,MaintenanceOutcomeSchema,MaintenanceTaskPageSchema,MaintenanceTaskRequestSchema,
  MaintenanceTaskSchema,MaintenanceTriggerSchema,SourceEventRequestSchema,
  type KnowledgeRef,type MaintenanceOutcome,type MaintenanceTask,type MaintenanceTaskRequest,type MaintenanceTrigger} from '@commerce/knowledge-contracts';
import type {ReadContext,MaintenanceTaskPort} from '@commerce/knowledge-application';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {digest} from '@commerce/knowledge-core/utils';
import {assertKnowledgeWriterAuthority,type KnowledgeWriterGrant} from '@commerce/knowledge-core/writer-authority';
import {installCapabilityWriterGuards} from './transaction.ts';

type Db=Pick<PoolClient,'query'>;
type Identity=[string,string,string,string,string];
type Stream='source_intake'|'knowledge';
type Collected={taskIds:string[];createdCount:number;omitted:boolean};
type TaskState=MaintenanceTask['state'];
type TaskRow={id:string;request:MaintenanceTaskRequest;trigger:MaintenanceTrigger;input_digest:string;state:TaskState;
  attempts:number;attempt_id:string|null;lease_token:string;lease_until:Date|null;cancel_requested:boolean;
  dispatch_state:MaintenanceTask['dispatchState'];outcome:MaintenanceOutcome|null;created_at:Date;updated_at:Date;
  lease_active?:boolean|null};
type Skipped={count:number};
export class MaintenanceCommitUnknownError extends KnowledgeError{
  readonly commitStatus='unknown';
  constructor(readonly operationId:string){super('COMMIT_OUTCOME_UNKNOWN',
    'Maintenance write acknowledgement was lost; inspect the original task or event before retrying',503);}
}
const identity=(context:ReadContext):Identity=>{
  const principal=context.principal,scope=context.scope;
  if(!principal.id?.trim()||!principal.clientInstallationId?.trim()||!context.purpose?.trim()||
    principal.projectId!==scope.projectId||!principal.spaceIds.includes(scope.spaceId)||
    !principal.purposes.includes(context.purpose))
    throw new KnowledgeError('MAINTENANCE_SCOPE_FORBIDDEN','Principal, installation, space or purpose is unavailable',403);
  return [scope.projectId,scope.spaceId,principal.id,principal.clientInstallationId,context.purpose];
};
const where='project_id=$1 AND space_id=$2 AND principal_id=$3 AND installation_id=$4 AND purpose=$5';
const scopeRef=(context:ReadContext,ref:KnowledgeRef|null)=>{
  if(ref&&(ref.projectId!==context.scope.projectId||ref.spaceId!==context.scope.spaceId))
    throw new KnowledgeError('MAINTENANCE_REF_SCOPE','Task reference is outside its authenticated space',403);
};
const task=(row:TaskRow):MaintenanceTask=>MaintenanceTaskSchema.parse({id:row.id,request:row.request,trigger:row.trigger,
  inputDigest:row.input_digest,state:row.state,attempts:Number(row.attempts),attemptId:row.attempt_id,
  leaseToken:Number(row.lease_token),cancelRequested:row.cancel_requested,dispatchState:row.dispatch_state,
  outcome:row.outcome,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()});
const unknownCost:MaintenanceOutcome['cost']={modelCalls:{state:'unknown',reason:'Dispatch outcome was not acknowledged'},
  tokens:{state:'unknown',reason:'Provider usage is not acknowledged'},
  money:{state:'unknown',reason:'Billing outcome requires reconciliation'}};
const noDispatchCost:MaintenanceOutcome['cost']={modelCalls:{state:'known',value:0},tokens:{state:'known',value:0},
  money:{state:'known',amount:0,currency:'USD',source:'no_dispatch'}};
const terminal=(state:MaintenanceOutcome['state'],reason:string,cost=unknownCost):MaintenanceOutcome=>({state,
  findingIds:[],compilationId:null,judgmentId:null,reason,cost});
const lease=(ms:number)=>{if(!Number.isSafeInteger(ms)||ms<1000||ms>300_000)
  throw new KnowledgeError('MAINTENANCE_LEASE_INVALID','Lease must be 1000 to 300000 milliseconds',422);return ms;};
const sequence=(value:string|number)=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<0)
  throw new KnowledgeError('MAINTENANCE_SEQUENCE_INVALID','Event sequence exceeds supported precision',409);return n;};
const refKey=(ref:Pick<KnowledgeRef,'objectId'|'versionId'>)=>`${ref.objectId}:${ref.versionId}`;
const cursorKey=(context:ReadContext)=>digest(identity(context));

/** Core migration precedes this one; source-intake migration precedes event collection. */
export async function migrateMaintenanceTasks(pool:Pool):Promise<void>{
  await pool.query(`CREATE TABLE IF NOT EXISTS ccl_knowledge_maintenance_tasks(
    id uuid PRIMARY KEY,project_id text NOT NULL,space_id text NOT NULL,principal_id text NOT NULL,
    installation_id text NOT NULL,purpose text NOT NULL,input_digest text NOT NULL,
    request jsonb NOT NULL,trigger jsonb NOT NULL,state text NOT NULL,
    attempts integer NOT NULL DEFAULT 0,attempt_id uuid,lease_token bigint NOT NULL DEFAULT 0,
    lease_until timestamptz,cancel_requested boolean NOT NULL DEFAULT false,
    dispatch_state text NOT NULL DEFAULT 'not_dispatched',outcome jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(project_id,space_id,principal_id,installation_id,purpose,input_digest));
    CREATE INDEX IF NOT EXISTS ccl_knowledge_maintenance_claim_idx ON ccl_knowledge_maintenance_tasks
      (project_id,space_id,principal_id,installation_id,purpose,state,created_at,id);
    CREATE TABLE IF NOT EXISTS ccl_knowledge_maintenance_attempts(
      task_id uuid NOT NULL REFERENCES ccl_knowledge_maintenance_tasks(id),attempt_id uuid PRIMARY KEY,
      project_id text NOT NULL,token bigint NOT NULL,started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      lease_until timestamptz NOT NULL,dispatch_state text NOT NULL DEFAULT 'not_dispatched',
      ended_at timestamptz,outcome jsonb,UNIQUE(task_id,token));
    CREATE TABLE IF NOT EXISTS ccl_knowledge_maintenance_cursors(
      project_id text NOT NULL,space_id text NOT NULL,principal_id text NOT NULL,installation_id text NOT NULL,
      purpose text NOT NULL,stream text NOT NULL,policy_fingerprint text NOT NULL,
      sequence bigint NOT NULL DEFAULT 0,pending_sequence bigint,pending_offset bigint NOT NULL DEFAULT 0,
      PRIMARY KEY(project_id,space_id,principal_id,installation_id,purpose,stream,policy_fingerprint));
    CREATE TABLE IF NOT EXISTS ccl_knowledge_maintenance_event_receipts(
      project_id text NOT NULL,space_id text NOT NULL,principal_id text NOT NULL,installation_id text NOT NULL,
      purpose text NOT NULL,stream text NOT NULL,policy_fingerprint text NOT NULL,
      sequence bigint NOT NULL,ref_key text NOT NULL,
      task_id uuid REFERENCES ccl_knowledge_maintenance_tasks(id),skip_reason text,raw_event jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(project_id,space_id,principal_id,installation_id,purpose,stream,policy_fingerprint,sequence,ref_key),
      CHECK ((task_id IS NULL) <> (skip_reason IS NULL)));
    CREATE TABLE IF NOT EXISTS ccl_knowledge_maintenance_revocation_sets(
      project_id text NOT NULL,space_id text NOT NULL,principal_id text NOT NULL,installation_id text NOT NULL,
      purpose text NOT NULL,policy_fingerprint text NOT NULL,sequence bigint NOT NULL,
      source_object_id text NOT NULL,source_version_id text NOT NULL,ref_count bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(project_id,space_id,principal_id,installation_id,purpose,policy_fingerprint,sequence));
    CREATE TABLE IF NOT EXISTS ccl_knowledge_maintenance_revocation_refs(
      project_id text NOT NULL,space_id text NOT NULL,principal_id text NOT NULL,installation_id text NOT NULL,
      purpose text NOT NULL,policy_fingerprint text NOT NULL,sequence bigint NOT NULL,
      ordinal bigint NOT NULL,object_id text NOT NULL,version_id text NOT NULL,
      PRIMARY KEY(project_id,space_id,principal_id,installation_id,purpose,policy_fingerprint,sequence,ordinal));`);
  // Existing receipts and cursors belong to an unknown historical policy. Keep them intact
  // while allowing every explicit method/rubric pair to replay the original event stream.
  await pool.query(`ALTER TABLE ccl_knowledge_maintenance_cursors
      ADD COLUMN IF NOT EXISTS policy_fingerprint text NOT NULL DEFAULT 'legacy';
    ALTER TABLE ccl_knowledge_maintenance_cursors
      ADD COLUMN IF NOT EXISTS pending_sequence bigint;
    ALTER TABLE ccl_knowledge_maintenance_cursors
      ADD COLUMN IF NOT EXISTS pending_offset bigint NOT NULL DEFAULT 0;
    ALTER TABLE ccl_knowledge_maintenance_event_receipts
      ADD COLUMN IF NOT EXISTS policy_fingerprint text NOT NULL DEFAULT 'legacy';
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='ccl_knowledge_maintenance_cursors'::regclass
        AND contype='p' AND pg_get_constraintdef(oid) LIKE '%policy_fingerprint%') THEN
        ALTER TABLE ccl_knowledge_maintenance_cursors DROP CONSTRAINT ccl_knowledge_maintenance_cursors_pkey;
        ALTER TABLE ccl_knowledge_maintenance_cursors ADD PRIMARY KEY
          (project_id,space_id,principal_id,installation_id,purpose,stream,policy_fingerprint);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='ccl_knowledge_maintenance_event_receipts'::regclass
        AND contype='p' AND pg_get_constraintdef(oid) LIKE '%policy_fingerprint%') THEN
        ALTER TABLE ccl_knowledge_maintenance_event_receipts DROP CONSTRAINT ccl_knowledge_maintenance_event_receipts_pkey;
        ALTER TABLE ccl_knowledge_maintenance_event_receipts ADD PRIMARY KEY
          (project_id,space_id,principal_id,installation_id,purpose,stream,policy_fingerprint,sequence,ref_key);
      END IF;
    END $$;`);
  await installCapabilityWriterGuards(pool,['ccl_knowledge_maintenance_tasks','ccl_knowledge_maintenance_attempts',
    'ccl_knowledge_maintenance_cursors','ccl_knowledge_maintenance_event_receipts',
    'ccl_knowledge_maintenance_revocation_sets','ccl_knowledge_maintenance_revocation_refs']);
}

export function createPgMaintenanceTasks(pool:Pool,grant:KnowledgeWriterGrant):MaintenanceTaskPort{
  async function write<T>(context:ReadContext,operationId:string,action:(client:PoolClient)=>Promise<T>):Promise<T>{
    identity(context);const client=await pool.connect();let committing=false;
    try{await client.query('BEGIN');await assertKnowledgeWriterAuthority(client,context.scope.projectId,grant);
      const value=await action(client);committing=true;await client.query('COMMIT');return value;
    }catch(error){if(committing)throw new MaintenanceCommitUnknownError(operationId);
      await client.query('ROLLBACK').catch(()=>{});throw error;
    }finally{client.release();}
  }
  async function getRow(db:Db,context:ReadContext,id:string,lock=false):Promise<TaskRow|null>{
    const row=(await db.query<TaskRow>(`SELECT *,lease_until>clock_timestamp() AS lease_active
      FROM ccl_knowledge_maintenance_tasks WHERE ${where} AND id=$6${lock?' FOR UPDATE':''}`,
      [...identity(context),id])).rows[0];return row??null;
  }
  function validate(context:ReadContext,request:MaintenanceTaskRequest,trigger:MaintenanceTrigger):void{
    MaintenanceTaskRequestSchema.parse(request);MaintenanceTriggerSchema.parse(trigger);
    scopeRef(context,request.subjectRef);scopeRef(context,trigger.ref);
    for(const ref of request.relatedRefs)scopeRef(context,ref);
    if(trigger.ref&&request.subjectRef&&digest(trigger.ref)!==digest(request.subjectRef)||
      trigger.sourceEventId&&request.kind==='source_research'&&!request.sourceEventIds.includes(trigger.sourceEventId))
      throw new KnowledgeError('MAINTENANCE_TRIGGER_MISMATCH','Trigger does not name the task subject or source event',409);
    if(request.kind==='source_research'&&(!request.sourceEventIds.length||!request.subjectRef||
      !['source','analysis','evidence'].includes(request.subjectRef.domain)))
      throw new KnowledgeError('MAINTENANCE_TASK_INPUT','Source research needs an exact source event and subject',422);
    if(request.kind==='recompile'&&(!request.subjectRef||request.subjectRef.domain!=='knowledge'))
      throw new KnowledgeError('MAINTENANCE_TASK_INPUT','Recompile needs an exact Wiki subject',422);
  }
  async function insertTask(client:PoolClient,context:ReadContext,request:MaintenanceTaskRequest,trigger:MaintenanceTrigger){
    validate(context,request,trigger);const id=randomUUID(),inputDigest=digest({scope:context.scope,
      principalId:context.principal.id,installationId:context.principal.clientInstallationId,purpose:context.purpose,
      request,trigger});
    const inserted=await client.query<TaskRow>(`INSERT INTO ccl_knowledge_maintenance_tasks
      (id,project_id,space_id,principal_id,installation_id,purpose,input_digest,request,trigger,state)
      VALUES($6,$1,$2,$3,$4,$5,$7,$8,$9,'queued')
      ON CONFLICT(project_id,space_id,principal_id,installation_id,purpose,input_digest) DO NOTHING RETURNING *`,
      [...identity(context),id,inputDigest,request,trigger]);
    if(inserted.rows[0])return {value:task(inserted.rows[0]),created:true};
    const old=(await client.query<TaskRow>(`SELECT * FROM ccl_knowledge_maintenance_tasks WHERE ${where} AND input_digest=$6`,
      [...identity(context),inputDigest])).rows[0];
    if(!old||digest({scope:context.scope,principalId:context.principal.id,
      installationId:context.principal.clientInstallationId,purpose:context.purpose,request:old.request,trigger:old.trigger})!==inputDigest)
      throw new KnowledgeError('MAINTENANCE_IDEMPOTENCY_CONFLICT','Task digest collision or missing original',409);
    return {value:task(old),created:false};
  }
  function recordCreated(collected:Collected,made:Awaited<ReturnType<typeof insertTask>>){
    if(!made.created)return;
    collected.createdCount++;
    if(collected.taskIds.length<2000)collected.taskIds.push(made.value.id);
    else collected.omitted=true;
  }
  async function receipt(client:PoolClient,context:ReadContext,stream:Stream,policy:string,seq:number,ref:KnowledgeRef|null,
    raw:unknown,taskId:string|null,reason:string|null,receiptKey?:string):Promise<void>{
    await client.query(`INSERT INTO ccl_knowledge_maintenance_event_receipts
      (project_id,space_id,principal_id,installation_id,purpose,stream,policy_fingerprint,sequence,ref_key,task_id,skip_reason,raw_event)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT(project_id,space_id,principal_id,installation_id,purpose,stream,policy_fingerprint,sequence,ref_key) DO NOTHING`,
      [...identity(context),stream,policy,seq,receiptKey??(ref?`${ref.domain}:${refKey(ref)}`:'event'),taskId,reason,raw]);
  }
  async function cursor(client:PoolClient,context:ReadContext,stream:Stream,policy:string):Promise<number>{
    await client.query(`INSERT INTO ccl_knowledge_maintenance_cursors
      (project_id,space_id,principal_id,installation_id,purpose,stream,policy_fingerprint,sequence)
      VALUES($1,$2,$3,$4,$5,$6,$7,0) ON CONFLICT DO NOTHING`,[...identity(context),stream,policy]);
    const row=(await client.query<{sequence:string}>(`SELECT sequence FROM ccl_knowledge_maintenance_cursors
      WHERE ${where} AND stream=$6 AND policy_fingerprint=$7 FOR UPDATE`,[...identity(context),stream,policy])).rows[0];
    return sequence(row.sequence);
  }
  async function advance(client:PoolClient,context:ReadContext,stream:Stream,policy:string,through:number){
    await client.query(`UPDATE ccl_knowledge_maintenance_cursors SET sequence=$8,
      pending_sequence=NULL,pending_offset=0
      WHERE ${where} AND stream=$6 AND policy_fingerprint=$7`,
      [...identity(context),stream,policy,through]);
  }
  async function pendingKnowledge(client:PoolClient,context:ReadContext,policy:string,
    pendingSequence:number,offset:number){
    await client.query(`UPDATE ccl_knowledge_maintenance_cursors
      SET pending_sequence=$8,pending_offset=$9
      WHERE ${where} AND stream=$6 AND policy_fingerprint=$7`,
      [...identity(context),'knowledge',policy,pendingSequence,offset]);
  }
  async function originalKnowledgeReceipt(client:PoolClient,context:ReadContext,policy:string,seq:number){
    // The full event stays in PostgreSQL once; individual ref receipts carry only an ordinal.
    await client.query(`INSERT INTO ccl_knowledge_maintenance_event_receipts
      (project_id,space_id,principal_id,installation_id,purpose,stream,policy_fingerprint,
       sequence,ref_key,task_id,skip_reason,raw_event)
      SELECT $1,$2,$3,$4,$5,'knowledge',$6,e.sequence,'event:raw',NULL,
        'original_event_receipt',jsonb_build_object('sequence',e.sequence,'kind',e.kind,'data',e.data)
      FROM ccl_knowledge_events e WHERE e.project_id=$1 AND e.sequence=$7
      ON CONFLICT(project_id,space_id,principal_id,installation_id,purpose,stream,policy_fingerprint,sequence,ref_key)
      DO NOTHING`,[...identity(context),policy,seq]);
  }
  async function wikiMetadata(client:PoolClient,context:ReadContext,ref:{objectId:string;versionId:string}){
    return (await client.query<{kind:string;space_id:string|null;published:boolean;current:boolean}>(`SELECT r.kind,
      r.payload->'binding'->>'spaceId' AS space_id,r.published_at IS NOT NULL AS published,
      h.version_id=r.version_id AS current FROM ccl_knowledge_revisions r
      LEFT JOIN ccl_knowledge_heads h ON h.project_id=r.project_id AND h.object_id=r.object_id
      WHERE r.project_id=$1 AND r.object_id=$2 AND r.version_id=$3`,
      [context.scope.projectId,ref.objectId,ref.versionId])).rows[0]??null;
  }
  const version=(value:unknown):{objectId:string;versionId:string}|null=>{
    if(!value||typeof value!=='object')return null;
    const x=value as {objectId?:unknown;versionId?:unknown};
    const objectId=IdSchema.safeParse(x.objectId),versionId=IdSchema.safeParse(x.versionId);
    return objectId.success&&versionId.success?{objectId:objectId.data,versionId:versionId.data}:null;
  };
  async function revokedDependentsPage(client:PoolClient,context:ReadContext,policy:string,seq:number,
    source:{objectId:string;versionId:string},offset:number,limit:number){
    const key=[...identity(context),policy,seq];
    let marker=(await client.query<{source_object_id:string;source_version_id:string;ref_count:string}>(`
      SELECT source_object_id,source_version_id,ref_count FROM ccl_knowledge_maintenance_revocation_sets
      WHERE ${where} AND policy_fingerprint=$6 AND sequence=$7`,key)).rows[0];
    if(!marker){
      // One complete closure and sort are unavoidable for an unbounded graph. They run in
      // PostgreSQL once per event/policy; subsequent pages use the ordinal primary key.
      // The refs and this marker (including zero refs) commit with the event cursor.
      await client.query(`INSERT INTO ccl_knowledge_maintenance_revocation_refs
        (project_id,space_id,principal_id,installation_id,purpose,policy_fingerprint,
         sequence,ordinal,object_id,version_id)
        WITH RECURSIVE affected(object_id,version_id) AS (
          SELECT d.object_id,d.version_id FROM ccl_knowledge_deps d
          WHERE d.project_id=$1 AND d.domain='source' AND d.dep_object_id=$8
            AND d.dep_version_id=$9 AND d.critical=true
          UNION
          SELECT d.object_id,d.version_id FROM ccl_knowledge_deps d JOIN affected a
            ON d.project_id=$1 AND d.domain='knowledge' AND d.dep_object_id=a.object_id
            AND d.dep_version_id=a.version_id AND d.critical=true
        ) SELECT $1,$2,$3,$4,$5,$6,$7,row_number() OVER (ORDER BY object_id,version_id),
          object_id,version_id FROM affected`,[...key,source.objectId,source.versionId]);
      marker=(await client.query<{source_object_id:string;source_version_id:string;ref_count:string}>(`
        INSERT INTO ccl_knowledge_maintenance_revocation_sets
          (project_id,space_id,principal_id,installation_id,purpose,policy_fingerprint,
           sequence,source_object_id,source_version_id,ref_count)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,count(*)
        FROM ccl_knowledge_maintenance_revocation_refs
        WHERE ${where} AND policy_fingerprint=$6 AND sequence=$7
        RETURNING source_object_id,source_version_id,ref_count`,[...key,source.objectId,source.versionId])).rows[0];
    }
    if(marker.source_object_id!==source.objectId||marker.source_version_id!==source.versionId)
      throw new KnowledgeError('MAINTENANCE_REVOCATION_SET_CONFLICT','Materialized source differs from the event',409);
    const rows=await client.query<{object_id:string;version_id:string;ordinal:string}>(`
      SELECT object_id,version_id,ordinal FROM ccl_knowledge_maintenance_revocation_refs
      WHERE ${where} AND policy_fingerprint=$6 AND sequence=$7 AND ordinal>$8
      ORDER BY ordinal LIMIT $9`,[...key,offset,limit]);
    return rows.rows.map(row=>({value:{objectId:row.object_id,versionId:row.version_id},
      ordinal:sequence(row.ordinal)}));
  }
  async function collectSource(client:PoolClient,context:ReadContext,limit:number,methodVersion:string,rubricVersion:string,
    skipped:Skipped,collected:Collected):Promise<{through:number;more:boolean}>{
    const policy=digest({methodVersion,rubricVersion});
    let through=await cursor(client,context,'source_intake',policy);
    const rows=await client.query<{sequence:string;kind:string;source_event_id:string;batch_id:string|null;
      occurred_at:Date;event_request:unknown;event_input_digest:string;source_record:unknown;
      registered_at:unknown}>(`SELECT o.sequence,o.kind,o.source_event_id,o.batch_id,o.occurred_at,
      e.document->'request' AS event_request,e.document->'source' AS source_record,
      e.document->'registeredAt' AS registered_at,e.input_digest AS event_input_digest
      FROM ccl_knowledge_source_intake_outbox o JOIN ccl_knowledge_source_events e
        ON e.id=o.source_event_id AND e.project_id=o.project_id AND e.space_id=o.space_id
        AND e.principal_id=o.principal_id AND e.installation_id=o.installation_id AND e.purpose=o.purpose
      WHERE o.project_id=$1 AND o.space_id=$2 AND o.principal_id=$3 AND o.installation_id=$4
        AND o.purpose=$5 AND o.sequence>$6 ORDER BY o.sequence LIMIT $7`,
      [...identity(context),through,limit+1]);
    for(const row of rows.rows.slice(0,limit)){
      const seq=sequence(row.sequence),raw={sequence:seq,kind:row.kind,sourceEventId:row.source_event_id,
        batchId:row.batch_id,occurredAt:row.occurred_at.toISOString(),request:row.event_request,
        sourceRecord:row.source_record,registeredAt:row.registered_at,inputDigest:row.event_input_digest};
      const parsed=SourceEventRequestSchema.safeParse(row.event_request);
      const ref=parsed.success?parsed.data.sourceRef:null;
      let reason:string|null=null;
      if(!parsed.success||digest(parsed.data)!==row.event_input_digest||parsed.data.purpose!==context.purpose||
        ref?.projectId!==context.scope.projectId||ref?.spaceId!==context.scope.spaceId)
        reason='source_event_scope_or_metadata_invalid';
      else if(!['source_registered','mentions_recorded'].includes(row.kind))reason='source_event_kind_unmapped';
      if(reason){skipped.count++;
        await receipt(client,context,'source_intake',policy,seq,ref,raw,null,reason);
      }else{
        const request:MaintenanceTaskRequest={kind:'source_research',subjectRef:ref,sourceEventIds:[row.source_event_id],
          relatedRefs:[],reason:`${row.kind} event ${seq}; original batch ${row.batch_id??'none'}`,
          methodVersion,rubricVersion};
        const trigger:MaintenanceTrigger={stream:'source_intake',eventKey:`source_intake:${seq}:${row.source_event_id}`,
          sequence:seq,ref,sourceEventId:row.source_event_id};
        const made=await insertTask(client,context,request,trigger);recordCreated(collected,made);
        await receipt(client,context,'source_intake',policy,seq,ref,raw,made.value.id,null);
      }
      through=seq;
    }
    await advance(client,context,'source_intake',policy,through);
    return {through,more:rows.rows.length>limit};
  }
  async function collectKnowledge(client:PoolClient,context:ReadContext,limit:number,methodVersion:string,rubricVersion:string,
    skipped:Skipped,collected:Collected):Promise<{through:number;more:boolean}>{
    const policy=digest({methodVersion,rubricVersion});
    let through=await cursor(client,context,'knowledge',policy);
    const position=(await client.query<{pending_sequence:string|null;pending_offset:string}>(`
      SELECT pending_sequence,pending_offset FROM ccl_knowledge_maintenance_cursors
      WHERE ${where} AND stream='knowledge' AND policy_fingerprint=$6`,[...identity(context),policy])).rows[0];
    let pending=position.pending_sequence===null?null:sequence(position.pending_sequence);
    let offset=sequence(position.pending_offset),remaining=limit,events=0;
    while(remaining>0&&events<limit){
      const row=(await client.query<{sequence:string;kind:string;refs_type:string|null;affected_type:string|null;
        source_object_id:string|null;source_version_id:string|null}>(`SELECT sequence,left(kind,200) AS kind,
        jsonb_typeof(data->'refs') AS refs_type,jsonb_typeof(data->'affected') AS affected_type,
        left(data->'ref'->>'objectId',200) AS source_object_id,
        left(data->'ref'->>'versionId',200) AS source_version_id
        FROM ccl_knowledge_events WHERE project_id=$1 AND
          (($2::bigint IS NOT NULL AND sequence=$2) OR ($2::bigint IS NULL AND sequence>$3))
        ORDER BY sequence LIMIT 1`,[context.scope.projectId,pending,through])).rows[0];
      if(!row){
        if(pending!==null)throw new KnowledgeError('MAINTENANCE_PENDING_EVENT_MISSING','Pending event disappeared',409);
        break;
      }
      const seq=sequence(row.sequence);
      await originalKnowledgeReceipt(client,context,policy,seq);
      let unknown:string|null=null;
      let page:Array<{value:unknown;ordinal:number}>=[];
      if(row.kind==='KnowledgePublished'||row.kind==='KnowledgeInvalidated'){
        const field=row.kind==='KnowledgePublished'?'refs':'affected';
        if((field==='refs'?row.refs_type:row.affected_type)!=='array')
          unknown=field==='refs'?'published_event_missing_refs':'invalidated_event_missing_affected';
        const result=await client.query<{object_id:string|null;version_id:string|null;ordinal:string}>(`
          WITH event_refs AS (
            SELECT x.item,x.ordinality::bigint AS ordinal
            FROM ccl_knowledge_events e CROSS JOIN LATERAL
              jsonb_array_elements(CASE WHEN jsonb_typeof(e.data->$3)='array'
                THEN e.data->$3 ELSE '[]'::jsonb END) WITH ORDINALITY AS x(item,ordinality)
            WHERE e.project_id=$1 AND e.sequence=$2
            UNION ALL
            SELECT e.data->'invalidity'->'ref',
              (CASE WHEN jsonb_typeof(e.data->'affected')='array'
                THEN jsonb_array_length(e.data->'affected') ELSE 0 END)+1
            FROM ccl_knowledge_events e WHERE e.project_id=$1 AND e.sequence=$2
              AND $3='affected' AND e.data->'invalidity'->>'domain'='knowledge'
          ) SELECT left(item->>'objectId',200) AS object_id,
            left(item->>'versionId',200) AS version_id,ordinal
            FROM event_refs WHERE ordinal>$4 ORDER BY ordinal LIMIT $5`,
          [context.scope.projectId,seq,field,offset,remaining+1]);
        page=result.rows.map(item=>({value:{objectId:item.object_id,versionId:item.version_id},
          ordinal:sequence(item.ordinal)}));
      }else if(row.kind==='SourceRightsRevoked'){
        const source=version({objectId:row.source_object_id,versionId:row.source_version_id});
        if(source)page=await revokedDependentsPage(client,context,policy,seq,source,offset,remaining+1);
        else unknown='revocation_event_missing_ref';
      }else unknown=`unmapped_knowledge_kind:${row.kind}`;
      const moreInEvent=page.length>remaining;
      const taken=page.slice(0,remaining);
      if(unknown&&offset===0){skipped.count++;
        await receipt(client,context,'knowledge',policy,seq,null,{sequence:seq,kind:row.kind},null,unknown,'event:skip');}
      if(!taken.length&&offset===0&&!unknown){skipped.count++;
        await receipt(client,context,'knowledge',policy,seq,null,{sequence:seq,kind:row.kind},null,
          'event_has_no_affected_knowledge_ref','event:skip');}
      for(const item of taken){
        const ref=version(item.value),raw={sequence:seq,kind:row.kind,ordinal:item.ordinal};
        if(!ref){skipped.count++;
          await receipt(client,context,'knowledge',policy,seq,null,raw,null,'invalid_event_ref',`item:${item.ordinal}`);
          continue;}
        const metadata=await wikiMetadata(client,context,ref);
        const knowledgeRef=KnowledgeRefSchema.parse({...context.scope,domain:'knowledge',...ref,contentDigest:null});
        const reason=!metadata?'revision_metadata_unavailable':!metadata.published?'revision_not_published':
          metadata.space_id!==context.scope.spaceId?'ref_outside_space':metadata.kind!=='wiki_page'?'ref_not_wiki_page':
          !metadata.current?'revision_not_current':null;
        if(reason){skipped.count++;
          await receipt(client,context,'knowledge',policy,seq,knowledgeRef,raw,null,reason,`item:${item.ordinal}`);continue;}
        const request:MaintenanceTaskRequest={kind:'recompile',subjectRef:knowledgeRef,sourceEventIds:[],relatedRefs:[],
          reason:`${row.kind} event ${seq} for exact Wiki revision`,methodVersion,rubricVersion};
        const trigger:MaintenanceTrigger={stream:'knowledge',eventKey:`knowledge:${seq}:${ref.objectId}:${ref.versionId}`,
          sequence:seq,ref:knowledgeRef,sourceEventId:null};
        const made=await insertTask(client,context,request,trigger);recordCreated(collected,made);
        await receipt(client,context,'knowledge',policy,seq,knowledgeRef,raw,made.value.id,null,`item:${item.ordinal}`);
      }
      events++;
      remaining-=taken.length;
      if(moreInEvent){pending=seq;offset=taken.at(-1)!.ordinal;
        await pendingKnowledge(client,context,policy,seq,offset);break;}
      through=seq;pending=null;offset=0;
      await advance(client,context,'knowledge',policy,through);
    }
    const next=(await client.query(`SELECT 1 FROM ccl_knowledge_events
      WHERE project_id=$1 AND sequence>$2 LIMIT 1`,[context.scope.projectId,through])).rowCount;
    return {through,more:pending!==null||!!next};
  }
  async function setTerminal(client:PoolClient,context:ReadContext,row:TaskRow,outcome:MaintenanceOutcome,
    strictLease?:{attemptId:string;token:number}){
    const result=await client.query<TaskRow>(`UPDATE ccl_knowledge_maintenance_tasks SET state=$7,outcome=$8,
      lease_until=NULL,updated_at=clock_timestamp() WHERE ${where} AND id=$6${strictLease?
        " AND state='running' AND attempt_id=$9 AND lease_token=$10 AND lease_until>clock_timestamp()":''} RETURNING *`,
      [...identity(context),row.id,outcome.state,outcome,...strictLease?[strictLease.attemptId,strictLease.token]:[]]);
    if(!result.rows[0])throw new KnowledgeError('MAINTENANCE_LEASE_LOST','Current unexpired attempt and token required',409);
    if(row.attempt_id)await client.query(`UPDATE ccl_knowledge_maintenance_attempts SET ended_at=clock_timestamp(),outcome=$2
      WHERE task_id=$1 AND attempt_id=$3 AND project_id=$4`,[row.id,outcome,row.attempt_id,context.scope.projectId]);
    return task(result.rows[0]);
  }
  /** Expiry changes only task ownership; its request, trigger, cost and attempt audit remain intact. */
  async function reconcileExpiredRow(client:PoolClient,context:ReadContext,row:TaskRow):Promise<TaskRow|null>{
    if(row.state!=='running'||row.lease_active===true)return row;
    const completed=await completedCoordinationOutcome(client,identity(context),row.id,row.input_digest,row.outcome);
    if(completed){await setTerminal(client,context,row,completed);return null;}
    if(row.dispatch_state!=='not_dispatched'){
      const prior=row.outcome;
      await setTerminal(client,context,row,prior?{...prior,state:'outcome_unknown',
        reason:`Lease expired after dispatch; reconcile the original response; ${prior.reason}`.slice(0,5000)}:
        terminal('outcome_unknown','Lease expired after dispatch preparation; reconcile the original response'));
      return null;
    }
    if(row.cancel_requested){await setTerminal(client,context,row,terminal('cancelled','Cancellation preceded dispatch',
      row.outcome?.cost??noDispatchCost));return null;}
    if(row.attempts>=3){await setTerminal(client,context,row,terminal('failed','Three undispatched attempts expired',
      row.outcome?.cost??noDispatchCost));return null;}
    await client.query(`UPDATE ccl_knowledge_maintenance_attempts SET ended_at=clock_timestamp(),outcome=$3
      WHERE task_id=$1 AND attempt_id=$2 AND project_id=$4 AND ended_at IS NULL`,
      [row.id,row.attempt_id,terminal('superseded','Undispatched lease expired; safe new attempt',
        row.outcome?.cost??noDispatchCost),context.scope.projectId]);
    return (await client.query<TaskRow>(`UPDATE ccl_knowledge_maintenance_tasks SET state='queued',attempt_id=NULL,
      lease_until=NULL,updated_at=clock_timestamp() WHERE ${where} AND id=$6 AND state='running' RETURNING *`,
      [...identity(context),row.id])).rows[0];
  }
  async function reconcileExpiredBatch(client:PoolClient,context:ReadContext,limit:number):Promise<number>{
    const rows=await client.query<TaskRow>(`SELECT *,lease_until>clock_timestamp() AS lease_active
      FROM ccl_knowledge_maintenance_tasks WHERE ${where} AND state='running'
        AND (lease_until IS NULL OR lease_until<=clock_timestamp())
      ORDER BY created_at,id LIMIT $6 FOR UPDATE`,[...identity(context),limit]);
    for(const row of rows.rows)await reconcileExpiredRow(client,context,row);
    return rows.rows.length;
  }
  return {
    async enqueue(context,request,trigger){return write(context,randomUUID(),async client=>(await insertTask(client,context,request,trigger)).value);},
    async collectEvents(context,options){
      if(!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>500||
        !options.methodVersion?.trim()||options.methodVersion.length>100||
        !options.rubricVersion?.trim()||options.rubricVersion.length>100)
        throw new KnowledgeError('MAINTENANCE_COLLECT_INPUT','Versions and a limit from 1 to 500 are required',422);
      return write(context,randomUUID(),async client=>{
        const skipped:Skipped={count:0},collected:Collected={taskIds:[],createdCount:0,omitted:false};
        await reconcileExpiredBatch(client,context,options.limit);
        const source=await collectSource(client,context,options.limit,options.methodVersion,options.rubricVersion,skipped,collected);
        const knowledge=await collectKnowledge(client,context,options.limit,options.methodVersion,options.rubricVersion,skipped,collected);
        return MaintenanceCollectResultSchema.parse({taskIds:collected.taskIds,sourceThrough:source.through,
          knowledgeThrough:knowledge.through,hasMore:source.more||knowledge.more,skipped:skipped.count,
          createdCount:collected.createdCount,omittedReasons:collected.omitted?
            ['Task ID preview limited to 2000; createdCount includes every persisted task']:[]});
      });
    },
    async claim(context,kinds,leaseMs=60_000){lease(leaseMs);
      if(kinds&&(kinds.length===0||new Set(kinds).size!==kinds.length||
        kinds.some(kind=>!['source_research','recompile','lint_page','relation_check'].includes(kind))))
        throw new KnowledgeError('MAINTENANCE_KIND_INVALID','Claim kinds must be distinct supported kinds',422);
      return write(context,randomUUID(),async client=>{
        for(;;){
          let row=(await client.query<TaskRow>(`SELECT * FROM ccl_knowledge_maintenance_tasks WHERE ${where}
            AND (state='queued' OR (state='running' AND (lease_until IS NULL OR lease_until<=clock_timestamp())))
            AND ($6::text[] IS NULL OR request->>'kind'=ANY($6::text[]))
            ORDER BY CASE WHEN state='running' THEN 0 ELSE 1 END,created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
            [...identity(context),kinds??null])).rows[0];
          if(!row)return null;
          if(row.state==='running'){
            const reconciled=await reconcileExpiredRow(client,context,row);
            if(!reconciled)continue;
            row=reconciled;
          }
          if(row.cancel_requested){await setTerminal(client,context,row,terminal('cancelled','Cancelled before dispatch',noDispatchCost));continue;}
          const attemptId=randomUUID(),token=Number(row.lease_token)+1;
          if(!Number.isSafeInteger(token))throw new KnowledgeError('MAINTENANCE_TOKEN_EXHAUSTED','Lease fencing token exhausted',409);
          const claimed=(await client.query<TaskRow>(`UPDATE ccl_knowledge_maintenance_tasks SET state='running',
            attempts=attempts+1,attempt_id=$7,lease_token=$8,lease_until=clock_timestamp()+($9::bigint*interval '1 millisecond'),
            dispatch_state='not_dispatched',updated_at=clock_timestamp() WHERE ${where} AND id=$6 RETURNING *`,
            [...identity(context),row.id,attemptId,token,leaseMs])).rows[0];
          await client.query(`INSERT INTO ccl_knowledge_maintenance_attempts
            (task_id,attempt_id,project_id,token,lease_until) VALUES($1,$2,$3,$4,$5)`,
            [row.id,attemptId,context.scope.projectId,token,claimed.lease_until]);
          return task(claimed);
        }
      });
    },
    async heartbeat(context,id,attemptId,leaseToken,leaseMs){lease(leaseMs);
      return write(context,id,async client=>{
        const row=(await client.query<TaskRow>(`UPDATE ccl_knowledge_maintenance_tasks SET
          lease_until=clock_timestamp()+($9::bigint*interval '1 millisecond'),updated_at=clock_timestamp()
          WHERE ${where} AND id=$6 AND state='running' AND attempt_id=$7 AND lease_token=$8
            AND lease_until>clock_timestamp() AND cancel_requested=false RETURNING *`,
          [...identity(context),id,attemptId,leaseToken,leaseMs])).rows[0];
        if(!row)return false;
        await client.query(`UPDATE ccl_knowledge_maintenance_attempts SET lease_until=$3
          WHERE task_id=$1 AND attempt_id=$2 AND project_id=$4 AND token=$5`,
          [id,attemptId,row.lease_until,context.scope.projectId,leaseToken]);return true;
      });
    },
    async markDispatch(context,id,attemptId,leaseToken,state,acknowledgedOutcome?:MaintenanceOutcome){
      if(!['dispatch_prepared','response_recorded'].includes(state))
        throw new KnowledgeError('MAINTENANCE_DISPATCH_INVALID','Dispatch state is unsupported',422);
      if(state==='response_recorded'&&!acknowledgedOutcome)
        throw new KnowledgeError('MAINTENANCE_ACKNOWLEDGEMENT_REQUIRED','Recorded response needs its actual outcome',422);
      if(state==='dispatch_prepared'&&acknowledgedOutcome)
        throw new KnowledgeError('MAINTENANCE_DISPATCH_INVALID','Prepared dispatch cannot record a response',422);
      const acknowledged=acknowledgedOutcome?MaintenanceOutcomeSchema.parse(acknowledgedOutcome):null;
      return write(context,id,async client=>{
        const row=await getRow(client,context,id,true);
        if(!row||row.state!=='running'||row.attempt_id!==attemptId||Number(row.lease_token)!==leaseToken||
          row.lease_active!==true||(state==='dispatch_prepared'&&row.cancel_requested))
          throw new KnowledgeError('MAINTENANCE_LEASE_LOST','Current unexpired attempt and token required',409);
        if(row.dispatch_state!==state&&!(row.dispatch_state==='not_dispatched'&&state==='dispatch_prepared')&&
          !(row.dispatch_state==='dispatch_prepared'&&state==='response_recorded'))
          throw new KnowledgeError('MAINTENANCE_DISPATCH_ORDER','Dispatch state must advance in order',409);
        if(state==='response_recorded'&&row.dispatch_state===state&&row.outcome&&digest(row.outcome)!==digest(acknowledged))
          throw new KnowledgeError('MAINTENANCE_OUTCOME_CONFLICT','Acknowledged response cannot be replaced',409);
        const changed=await client.query(`UPDATE ccl_knowledge_maintenance_tasks SET dispatch_state=$2,
          outcome=CASE WHEN $2='response_recorded' THEN $6::jsonb ELSE outcome END,updated_at=clock_timestamp()
          WHERE id=$1 AND project_id=$3 AND state='running' AND attempt_id=$4 AND lease_token=$5
            AND lease_until>clock_timestamp() AND ($2='response_recorded' OR cancel_requested=false)`,
          [id,state,context.scope.projectId,attemptId,leaseToken,acknowledged]);
        if(changed.rowCount!==1)throw new KnowledgeError('MAINTENANCE_LEASE_LOST','Dispatch lease expired before write',409);
        const attempt=await client.query(`UPDATE ccl_knowledge_maintenance_attempts SET dispatch_state=$2,
          outcome=CASE WHEN $2='response_recorded' THEN $6::jsonb ELSE outcome END
          WHERE task_id=$1 AND attempt_id=$3 AND project_id=$4 AND token=$5`,
          [id,state,attemptId,context.scope.projectId,leaseToken,acknowledged]);
        if(attempt.rowCount!==1)
          throw new KnowledgeError('MAINTENANCE_ATTEMPT_MISSING','Dispatch attempt audit is unavailable',409);
      });
    },
    async finish(context,id,attemptId,leaseToken,outcome){MaintenanceOutcomeSchema.parse(outcome);
      return write(context,id,async client=>{
        const row=await getRow(client,context,id,true);
        if(!row||row.state!=='running'||row.attempt_id!==attemptId||Number(row.lease_token)!==leaseToken||
          row.lease_active!==true)
          throw new KnowledgeError('MAINTENANCE_LEASE_LOST','Current unexpired attempt and token required',409);
        const finalOutcome=row.dispatch_state==='response_recorded'&&row.outcome?{
          ...outcome,findingIds:row.outcome.findingIds,compilationId:row.outcome.compilationId,
          judgmentId:row.outcome.judgmentId,cost:row.outcome.cost}:outcome;
        const linkedOutcome=await publishedCoordinationOutcome(client,identity(context),id,row.input_digest,finalOutcome);
        return setTerminal(client,context,row,linkedOutcome,{attemptId,token:leaseToken});
      });
    },
    async cancel(context,id){return write(context,id,async client=>{
      const row=await getRow(client,context,id,true);
      if(!row)throw new KnowledgeError('MAINTENANCE_NOT_FOUND','Task is unavailable in this scope',404);
      if(row.state==='queued')return setTerminal(client,context,row,terminal('cancelled','Cancelled before claim',noDispatchCost));
      if(row.state!=='running'||row.cancel_requested)return task(row);
      const updated=(await client.query<TaskRow>(`UPDATE ccl_knowledge_maintenance_tasks SET cancel_requested=true,
        updated_at=clock_timestamp() WHERE ${where} AND id=$6 RETURNING *`,[...identity(context),id])).rows[0];
      return task(updated);
    });},
    async get(context,id){const row=await getRow(pool,context,id);
      if(!row)return null;
      if(row.state!=='running'||row.lease_active===true)return task(row);
      return write(context,id,async client=>{
        const current=await getRow(client,context,id,true);
        if(!current)return null;
        const reconciled=await reconcileExpiredRow(client,context,current);
        return reconciled?task(reconciled):task((await getRow(client,context,id))!);
      });},
    async list(context,options){identity(context);
      if(!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>100)
        throw new KnowledgeError('MAINTENANCE_PAGE_LIMIT','List limit must be 1 to 100',422);
      let after:{at:string;id:string}|null=null;
      if(options.cursor){try{const decoded=JSON.parse(Buffer.from(options.cursor,'base64url').toString('utf8')) as
          {scope:string;at:string;id:string};
          if(decoded.scope!==cursorKey(context)||!TimestampSchema.safeParse(decoded.at).success||
            !IdSchema.safeParse(decoded.id).success)throw new Error();after={at:decoded.at,id:decoded.id};
        }catch{throw new KnowledgeError('MAINTENANCE_CURSOR_INVALID','Cursor is unavailable in this scope',400);}}
      const pageQuery=()=>pool.query<TaskRow>(`SELECT *,lease_until>clock_timestamp() AS lease_active
        FROM ccl_knowledge_maintenance_tasks WHERE ${where}
        AND ($6::timestamptz IS NULL OR (created_at,id)>($6::timestamptz,$7::uuid))
        ORDER BY created_at,id LIMIT $8`,[...identity(context),after?.at??null,after?.id??null,options.limit+1]);
      let rows=await pageQuery();
      const expired=rows.rows.slice(0,options.limit).filter(row=>row.state==='running'&&row.lease_active!==true);
      if(expired.length){await write(context,expired[0].id,async client=>{
        for(const item of expired){const current=await getRow(client,context,item.id,true);
          if(current)await reconcileExpiredRow(client,context,current);}
      });rows=await pageQuery();}
      const page=rows.rows.slice(0,options.limit).map(task),hasMore=rows.rows.length>options.limit;
      const last=rows.rows[Math.min(rows.rows.length,options.limit)-1];
      return MaintenanceTaskPageSchema.parse({items:page,hasMore,nextCursor:hasMore&&last?
        Buffer.from(JSON.stringify({scope:cursorKey(context),at:last.created_at.toISOString(),id:last.id})).toString('base64url'):null});
    },
  };
}
