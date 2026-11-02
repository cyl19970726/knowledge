import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {SemanticSweepRequestSchema,SemanticSweepSchema,
  type KnowledgeRef,type MaintenanceTaskRequest,type MaintenanceTrigger,
  type SemanticSweep,type SemanticSweepRequest} from '@commerce/knowledge-contracts';
import type {ReadContext,SemanticSweepPort} from '@commerce/knowledge-application';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {assertKnowledgeWriterAuthority,type KnowledgeWriterGrant} from '@commerce/knowledge-core/writer-authority';
import {installCapabilityWriterGuards} from './transaction.ts';
import {insertMaintenanceTask} from './maintenance-tasks.ts';

type PassRow={id:string;request:SemanticSweepRequest;scanned:number;last_object_id:string|null;
  complete:boolean;limit_reached:boolean;task_ids:string[];task_count:number;skipped:number;
  start_epoch:string;observed_epoch:string;omitted_reasons:string[];updated_at:Date};
type Head={object_id:string;version_id:string;review_admitted:boolean};
const scoped=(context:ReadContext)=>[context.scope.projectId,context.scope.spaceId,
  context.principal.id,context.principal.clientInstallationId,context.purpose];
const keyWhere=`project_id=$1 AND space_id=$2 AND principal_id=$3 AND installation_id=$4 AND purpose=$5
  AND cycle_key=$6 AND shard_count=$7 AND shard=$8 AND method_version=$9 AND rubric_version=$10`;
const reasons=(items:string[])=>[...new Set(items)].slice(0,100);
function assertContext(context:ReadContext):void{
  if(!context.principal.id?.trim()||!context.principal.clientInstallationId?.trim()||!context.purpose?.trim()||
    context.scope.projectId!==context.principal.projectId||
    !context.principal.spaceIds.includes(context.scope.spaceId)||
    !context.principal.purposes.includes(context.purpose))
    throw new KnowledgeError('SEMANTIC_SWEEP_SCOPE_FORBIDDEN','Scope, installation or purpose is unavailable',403);
}
function dto(row:PassRow):SemanticSweep{return SemanticSweepSchema.parse({id:row.id,request:row.request,
  scanned:row.scanned,lastObjectId:row.last_object_id,complete:row.complete,limitReached:row.limit_reached,
  taskIds:row.task_ids,taskCount:row.task_count,skipped:row.skipped,
  startEpoch:Number(row.start_epoch),observedEpoch:Number(row.observed_epoch),
  consistency:'incremental_current_heads',omittedReasons:reasons([...row.omitted_reasons,...row.task_count>row.task_ids.length?['taskIds is only the latest batch preview; taskCount is cumulative; use maintenance task pagination for all tasks']:[]]),
  updatedAt:row.updated_at.toISOString()});}

export class SemanticSweepCommitUnknownError extends KnowledgeError{
  readonly commitStatus='unknown';
  constructor(readonly operationId:string){super('COMMIT_OUTCOME_UNKNOWN',
    'Sweep commit acknowledgement was lost; inspect the original pass before another write',503);}
}

/** Core and maintenance-task migrations must precede this additive migration. */
export async function migrateSemanticSweeps(pool:Pool):Promise<void>{
  await pool.query(`CREATE TABLE IF NOT EXISTS ccl_knowledge_semantic_sweeps(
    id uuid PRIMARY KEY,project_id text NOT NULL,space_id text NOT NULL,principal_id text NOT NULL,
    installation_id text NOT NULL,purpose text NOT NULL,cycle_key text NOT NULL,shard_count integer NOT NULL,
    shard integer NOT NULL,method_version text NOT NULL,rubric_version text NOT NULL,request jsonb NOT NULL,
    scanned integer NOT NULL DEFAULT 0,last_object_id uuid,complete boolean NOT NULL DEFAULT false,
    limit_reached boolean NOT NULL DEFAULT false,task_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    task_count integer NOT NULL DEFAULT 0,skipped integer NOT NULL DEFAULT 0,
    start_epoch bigint NOT NULL,observed_epoch bigint NOT NULL,
    omitted_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(project_id,space_id,principal_id,installation_id,purpose,cycle_key,shard_count,shard,method_version,rubric_version));`);
  await installCapabilityWriterGuards(pool,['ccl_knowledge_semantic_sweeps']);
}

/** Incremental metadata discovery. The project lock also fences a concurrent publisher and task writer. */
export function createPgSemanticSweep(pool:Pool,grant:KnowledgeWriterGrant):SemanticSweepPort{
  return {
    async runPass(context,raw){
      assertContext(context);const request=SemanticSweepRequestSchema.parse(raw),newId=randomUUID();
      const client=await pool.connect();let committing=false,operationId:string=newId;
      try{
        await client.query('BEGIN');await assertKnowledgeWriterAuthority(client,context.scope.projectId,grant);
        const authority=(await client.query<{mode:string}>(
          'SELECT mode FROM ccl_knowledge_writer_authority WHERE project_id=$1',[context.scope.projectId])).rows[0];
        if(authority?.mode!=='active')throw new KnowledgeError('WRITER_AUTHORITY_REQUIRED','Active writer authority is required',503);
        const epoch=Number((await client.query<{epoch:string}>(
          'SELECT epoch FROM ccl_knowledge_projects WHERE project_id=$1',[context.scope.projectId])).rows[0]?.epoch??0);
        const key=[...scoped(context),request.cycleKey,request.shardCount,request.shard,
          request.methodVersion,request.rubricVersion];
        await client.query(`INSERT INTO ccl_knowledge_semantic_sweeps
          (id,project_id,space_id,principal_id,installation_id,purpose,cycle_key,shard_count,shard,
           method_version,rubric_version,request,start_epoch,observed_epoch,omitted_reasons)
          VALUES($11,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$12,$13,$13,$14)
          ON CONFLICT DO NOTHING`,[...key,newId,request,epoch,JSON.stringify(['current_heads_can_change_between_pages'])]);
        let row=(await client.query<PassRow>(`SELECT * FROM ccl_knowledge_semantic_sweeps
          WHERE ${keyWhere} FOR UPDATE`,key)).rows[0];
        if(!row)throw new KnowledgeError('SEMANTIC_SWEEP_MISSING','Pass reservation failed',503);
        operationId=row.id;
        if(row.request.maxTasksPerShard!==request.maxTasksPerShard)
          throw new KnowledgeError('SEMANTIC_SWEEP_LIMIT_CONFLICT','Original task cap is immutable for this cycle',409);
        if(row.complete||row.limit_reached){committing=true;await client.query('COMMIT');return dto(row);}
        if(row.scanned>=1_000_000)
          throw new KnowledgeError('SEMANTIC_SWEEP_SCAN_LIMIT','Cycle scanned one million heads; use more shards or a new cycle',422);
        const remaining=request.maxTasksPerShard-row.task_count;
        // Fetch only metadata. The extra row proves whether a capped page leaves any heads behind.
        const take=Math.min(request.limit,1_000_000-row.scanned,Math.max(remaining,1));
        const heads=(await client.query<Head>(`SELECT h.object_id,h.version_id,
          EXISTS(SELECT 1 FROM ccl_knowledge_publications p JOIN ccl_knowledge_reviews v
            ON v.project_id=p.project_id AND v.id=p.review_id
            WHERE p.project_id=r.project_id AND p.changeset_id=r.changeset_id
              AND v.changeset_id=r.changeset_id
              AND v.payload->>'purpose'=$5
              AND (v.payload->>'decision'='approved_for_purpose' OR
                ($5='exploration_reading' AND v.payload->>'decision'='exploration_only'))) AS review_admitted
          FROM ccl_knowledge_heads h JOIN ccl_knowledge_revisions r
            ON r.project_id=h.project_id AND r.object_id=h.object_id AND r.version_id=h.version_id
          WHERE h.project_id=$1 AND r.kind='wiki_page' AND r.published_at IS NOT NULL
            AND r.payload->'binding'->>'spaceId'=$2
            AND ($3::uuid IS NULL OR r.object_id::uuid>$3::uuid)
            AND get_byte(uuid_send(r.object_id::uuid),0)%$4=$6
          ORDER BY r.object_id::uuid LIMIT $7`,
          [context.scope.projectId,context.scope.spaceId,row.last_object_id,request.shardCount,
            context.purpose,request.shard,take+1])).rows;
        const page=heads.slice(0,take),taskIds:string[]=[];
        let taskCount=row.task_count,skipped=row.skipped;
        const omitted=[...row.omitted_reasons];
        if(epoch!==Number(row.start_epoch))omitted.push('publication_epoch_changed; earlier_keys_or_versions_may_be_missed');
        for(const head of page){
          if(!head.review_admitted){skipped++;omitted.push('head_not_reviewed_for_requested_purpose');continue;}
          const ref:KnowledgeRef={...context.scope,domain:'knowledge',objectId:head.object_id,
            versionId:head.version_id,contentDigest:null};
          const taskRequest:MaintenanceTaskRequest={kind:'relation_check',subjectRef:ref,sourceEventIds:[],
            relatedRefs:[],reason:'Periodic semantic relation check for an exact current Wiki head',
            methodVersion:request.methodVersion,rubricVersion:request.rubricVersion};
          const trigger:MaintenanceTrigger={stream:'periodic',eventKey:`semantic-sweep:${row.id}:${head.version_id}`,
            sequence:0,ref,sourceEventId:null};
          const made=await insertMaintenanceTask(client,context,taskRequest,trigger);
          if(made.created)taskCount++;
          if(taskIds.length<100)taskIds.push(made.value.id);
        }
        const last=page.at(-1)?.object_id??row.last_object_id;
        const complete=heads.length<=page.length;
        const limitReached=!complete&&taskCount>=request.maxTasksPerShard;
        if(limitReached)omitted.push('max_tasks_per_shard_reached; remaining_heads_unscanned');
        if(!complete&&row.scanned+page.length===1_000_000)
          omitted.push('scan_limit_reached; remaining_heads_unscanned');
        row=(await client.query<PassRow>(`UPDATE ccl_knowledge_semantic_sweeps SET
          request=$2,scanned=scanned+$3,last_object_id=$4,complete=$5,limit_reached=$6,
          task_ids=$7,task_count=$8,skipped=$9,observed_epoch=$10,omitted_reasons=$11,
          updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
          [row.id,request,page.length,last,complete,limitReached,JSON.stringify(taskIds),taskCount,skipped,
            epoch,JSON.stringify(reasons(omitted))])).rows[0];
        committing=true;await client.query('COMMIT');return dto(row);
      }catch(error){if(committing)throw new SemanticSweepCommitUnknownError(operationId);
        await client.query('ROLLBACK').catch(()=>{});throw error;
      }finally{client.release();}
    },
    async get(context,id){
      assertContext(context);const row=(await pool.query<PassRow>(`SELECT * FROM ccl_knowledge_semantic_sweeps
        WHERE project_id=$1 AND space_id=$2 AND principal_id=$3 AND installation_id=$4
          AND purpose=$5 AND id=$6`,[...scoped(context),id])).rows[0];
      return row?dto(row):null;
    }
  };
}
