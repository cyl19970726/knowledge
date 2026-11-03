import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {LintPassRequestSchema,LintPassSchema,MaintenanceFindingSchema,
  type KnowledgeRef,type LintPass,type LintPassRequest,type MaintenanceFinding} from '@commerce/knowledge-contracts';
import type {ReadContext} from '@commerce/knowledge-application';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {createKnowledgeStore} from '@commerce/knowledge-core/store';
import {assertKnowledgeWriterAuthority,type KnowledgeWriterGrant} from '@commerce/knowledge-core/writer-authority';
import {insertMaintenanceTask,migrateMaintenanceTasks} from './maintenance-tasks.ts';

type PassRow={id:string;scanned:number;last_object_id:string|null;complete:boolean;finding_ids:string[];
  finding_count:string;start_epoch:string;observed_epoch:string;omitted_reasons:string[];updated_at:Date};
type Head={object_id:string;version_id:string;due_at:string|null;profile_id:string|null;profile_version:string|null;
  identity_key:string|null;group_count:number;group_distinct:number;group_shape_valid:boolean;
  citation_count:number;citation_shape:string|null;review_admitted:boolean};
type Dep={domain:string;dep_object_id:string;dep_version_id:string;critical:boolean;published_at:Date|null;
  target_space:string|null;exists:boolean};
type FindingKind=MaintenanceFinding['kind'];
const scope=(c:ReadContext)=>[c.scope.projectId,c.scope.spaceId,c.principal.id,c.principal.clientInstallationId,c.purpose];
const stableId=(value:string)=>{const hex=createHash('sha256').update(value).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;};
const unique=(values:string[])=>[...new Set(values)].slice(0,100);
function assertContext(context:ReadContext):void{
  if(context.scope.projectId!==context.principal.projectId||!context.principal.spaceIds.includes(context.scope.spaceId)||
    !context.principal.purposes.includes(context.purpose))
    throw new KnowledgeError('WIKI_LINT_SCOPE_FORBIDDEN','Lint scope or purpose is unavailable',403);
  if(!context.principal.clientInstallationId?.trim())
    throw new KnowledgeError('INSTALLATION_REQUIRED','Lint requires an authenticated installation',403);
}
function ref(context:ReadContext,objectId:string,versionId:string,spaceId=context.scope.spaceId):KnowledgeRef{
  return {projectId:context.scope.projectId,spaceId,domain:'knowledge',
    objectId,versionId,contentDigest:null};
}
export class WikiLintCommitUnknownError extends KnowledgeError{
  readonly commitStatus='unknown';readonly operationId:string;
  constructor(id:string){super('COMMIT_OUTCOME_UNKNOWN','Lint pass commit acknowledgement was lost; read the same cycle before retrying',503);
    this.operationId=id;}
}

export async function migrateWikiLint(pool:Pool):Promise<void>{
  await migrateMaintenanceTasks(pool);
  await pool.query(`CREATE TABLE IF NOT EXISTS ccl_knowledge_lint_passes (
    id uuid PRIMARY KEY,project_id text NOT NULL,space_id text NOT NULL,principal_id text NOT NULL,
    installation_id text NOT NULL,purpose text NOT NULL,cycle_key text NOT NULL,shard_count int NOT NULL,
    shard int NOT NULL,method_version text NOT NULL,scanned int NOT NULL DEFAULT 0,last_object_id uuid,
    complete boolean NOT NULL DEFAULT false,finding_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    finding_count bigint NOT NULL DEFAULT 0,
    start_epoch bigint NOT NULL,observed_epoch bigint NOT NULL,omitted_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(project_id,space_id,principal_id,installation_id,purpose,cycle_key,shard_count,shard,method_version)
  );
  CREATE TABLE IF NOT EXISTS ccl_knowledge_lint_findings (
    id uuid PRIMARY KEY,pass_id uuid NOT NULL REFERENCES ccl_knowledge_lint_passes(id),
    project_id text NOT NULL,space_id text NOT NULL,principal_id text NOT NULL,installation_id text NOT NULL,
    purpose text NOT NULL,finding_key text NOT NULL,kind text NOT NULL,status text NOT NULL DEFAULT 'open',
    payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(pass_id,finding_key)
  );
  ALTER TABLE ccl_knowledge_lint_passes ADD COLUMN IF NOT EXISTS finding_count bigint NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS ccl_knowledge_lint_findings_scope_idx ON ccl_knowledge_lint_findings
    (project_id,space_id,principal_id,installation_id,purpose,id);
  DROP TRIGGER IF EXISTS ccl_writer_guard ON ccl_knowledge_lint_passes;
  CREATE TRIGGER ccl_writer_guard BEFORE INSERT OR UPDATE OR DELETE ON ccl_knowledge_lint_passes
    FOR EACH ROW EXECUTE FUNCTION ccl_assert_knowledge_writer();
  DROP TRIGGER IF EXISTS ccl_writer_guard ON ccl_knowledge_lint_findings;
  CREATE TRIGGER ccl_writer_guard BEFORE INSERT OR UPDATE OR DELETE ON ccl_knowledge_lint_findings
    FOR EACH ROW EXECUTE FUNCTION ccl_assert_knowledge_writer()`);
}

function passDto(row:PassRow,request:LintPassRequest):LintPass{
  const total=Number(row.finding_count);
  const previewNote=total>row.finding_ids.length
    ?`findingIds is a preview of the latest page (${row.finding_ids.length} of ${total} findings); use findings() pagination for the complete list.`:null;
  return LintPassSchema.parse({id:row.id,request,scanned:row.scanned,lastObjectId:row.last_object_id,
    complete:row.complete,findingIds:row.finding_ids,findingCount:total,startEpoch:Number(row.start_epoch),
    observedEpoch:Number(row.observed_epoch),consistency:'incremental_current_heads',
    omittedReasons:previewNote?unique([...row.omitted_reasons.slice(0,99),previewNote]):row.omitted_reasons,
    updatedAt:row.updated_at.toISOString()});
}
const passWhere=`project_id=$1 AND space_id=$2 AND principal_id=$3 AND installation_id=$4 AND purpose=$5
  AND cycle_key=$6 AND shard_count=$7 AND shard=$8 AND method_version=$9`;

/** A bounded metadata pass over current heads; its epoch is an observed watermark, not a snapshot claim. */
export function createPgWikiLint(pool:Pool,grant:KnowledgeWriterGrant){
  const store=createKnowledgeStore(pool,{writerGrant:grant});
  return {
    async runPass(context:ReadContext,raw:LintPassRequest):Promise<LintPass>{
      assertContext(context);const request=LintPassRequestSchema.parse(raw),id=randomUUID();
      const client=await pool.connect();let committing=false,operationId:string=id;
      try{
        await client.query('BEGIN');
        await assertKnowledgeWriterAuthority(client,context.scope.projectId,grant);
        const authority=(await client.query<{mode:string}>(
          'SELECT mode FROM ccl_knowledge_writer_authority WHERE project_id=$1',[context.scope.projectId])).rows[0];
        if(authority?.mode!=='active')throw new KnowledgeError('WRITER_AUTHORITY_REQUIRED','Active writer authority is required',503);
        const epoch=Number((await client.query<{epoch:string}>(
          'SELECT epoch FROM ccl_knowledge_projects WHERE project_id=$1',[context.scope.projectId])).rows[0]?.epoch??0);
        const key=[...scope(context),request.cycleKey,request.shardCount,request.shard,request.methodVersion];
        await client.query(`INSERT INTO ccl_knowledge_lint_passes
          (id,project_id,space_id,principal_id,installation_id,purpose,cycle_key,shard_count,shard,method_version,start_epoch,observed_epoch)
          VALUES($10,$1,$2,$3,$4,$5,$6,$7,$8,$9,$11,$11) ON CONFLICT DO NOTHING`,[...key,id,epoch]);
        let row=(await client.query<PassRow>(`SELECT * FROM ccl_knowledge_lint_passes WHERE ${passWhere} FOR UPDATE`,key)).rows[0];
        if(!row)throw new KnowledgeError('WIKI_LINT_PASS_MISSING','Lint pass reservation failed',503);
        operationId=row.id;
        // Additive migration gives old passes a zero count; recover it from their durable findings.
        if(row.scanned>0&&Number(row.finding_count)===0){
          const actual=Number((await client.query<{total:string}>(
            'SELECT count(*) AS total FROM ccl_knowledge_lint_findings WHERE pass_id=$1',[row.id])).rows[0].total);
          if(actual>0)row=(await client.query<PassRow>(`UPDATE ccl_knowledge_lint_passes
            SET finding_count=$2 WHERE id=$1 RETURNING *`,[row.id,actual])).rows[0];
        }
        if(row.complete){committing=true;await client.query('COMMIT');return passDto(row,request);}
        const heads=(await client.query<Head>(`SELECT h.object_id,h.version_id,
          CASE WHEN jsonb_typeof(r.payload->'scope'->'reviewDueAt')='string'
            THEN r.payload->'scope'->>'reviewDueAt' END AS due_at,
          CASE WHEN jsonb_typeof(r.payload->'content'->'profile'->'id')='string'
            THEN r.payload->'content'->'profile'->>'id' END AS profile_id,
          CASE WHEN jsonb_typeof(r.payload->'content'->'profile'->'version')='string'
            THEN r.payload->'content'->'profile'->>'version' END AS profile_version,
          CASE WHEN jsonb_typeof(r.payload->'content'->'identity'->'key')='string'
            THEN r.payload->'content'->'identity'->>'key' END AS identity_key,
          CASE WHEN jsonb_typeof(r.payload->'sourceGroups')='array'
            THEN jsonb_array_length(r.payload->'sourceGroups') ELSE 0 END AS group_count,
          (SELECT count(DISTINCT value)::int FROM jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(r.payload->'sourceGroups')='array'
              THEN r.payload->'sourceGroups' ELSE '[]'::jsonb END) AS g(value)) AS group_distinct,
          CASE WHEN jsonb_typeof(r.payload->'sourceGroups')='array' THEN NOT EXISTS(
            SELECT 1 FROM jsonb_array_elements(r.payload->'sourceGroups') AS g(value)
            WHERE jsonb_typeof(g.value)<>'string') ELSE false END AS group_shape_valid,
          CASE WHEN jsonb_typeof(r.payload->'content'->'citations')='array'
            THEN jsonb_array_length(r.payload->'content'->'citations') ELSE 0 END AS citation_count,
          jsonb_typeof(r.payload->'content'->'citations') AS citation_shape,
          EXISTS(SELECT 1 FROM ccl_knowledge_publications p JOIN ccl_knowledge_reviews v
            ON v.project_id=p.project_id AND v.id=p.review_id
            WHERE p.project_id=r.project_id AND p.changeset_id=r.changeset_id
              AND v.payload->>'purpose'=$5 AND v.payload->>'decision' IN ('approved_for_purpose','exploration_only')) AS review_admitted
          FROM ccl_knowledge_heads h JOIN ccl_knowledge_revisions r
            ON r.project_id=h.project_id AND r.object_id=h.object_id AND r.version_id=h.version_id
          WHERE h.project_id=$1 AND r.kind='wiki_page' AND r.published_at IS NOT NULL
            AND r.payload->'binding'->>'spaceId'=$2
            AND ($3::uuid IS NULL OR r.object_id::uuid>$3::uuid)
            AND get_byte(uuid_send(r.object_id::uuid),0)%$4=$6
          ORDER BY r.object_id::uuid LIMIT $7`,
          [context.scope.projectId,context.scope.spaceId,row.last_object_id,request.shardCount,
            context.purpose,request.shard,request.limit+1])).rows;
        const page=heads.slice(0,request.limit),findingIds:string[]=[];
        let newFindingCount=0;
        if(row.scanned+page.length>1_000_000)
          throw new KnowledgeError('WIKI_LINT_SCAN_LIMIT','This cycle exceeds the bounded scan limit; use more shards or a new cycle',422);
        const omitted=[...row.omitted_reasons,'current_heads_can_change_between_pages'];
        if(epoch!==Number(row.start_epoch))omitted.push('publication_epoch_changed; earlier_keys_or_versions_may_be_missed');
        const add=async(head:Head,kind:FindingKind,reason:string,relatedRefs:KnowledgeRef[]=[],repair=false)=>{
          const findingKey=`${head.object_id}/${head.version_id}/${kind}`;
          const exactRelated=[...new Map(relatedRefs.map(item=>[`${item.domain}/${item.objectId}/${item.versionId}`,item])).values()];
          const subjectRef=ref(context,head.object_id,head.version_id);
          const linked=repair?await insertMaintenanceTask(client,context,{kind:'recompile',subjectRef,
            sourceEventIds:[],relatedRefs:exactRelated.filter(item=>item.spaceId===context.scope.spaceId).slice(0,50),
            reason:`Wiki lint ${kind}: ${reason}`,methodVersion:request.methodVersion,rubricVersion:'wiki-lint/1'},
            {stream:'periodic',eventKey:`lint:${row.id}:${findingKey}`,sequence:0,ref:subjectRef,sourceEventId:null}):null;
          const findingId=stableId(`${row.id}/${findingKey}`),found:MaintenanceFinding=MaintenanceFindingSchema.parse({
            id:findingId,taskId:linked?.value.id??null,kind,subjectRef,
            relatedRefs:exactRelated.slice(0,50),reason,methodVersion:request.methodVersion,status:'open',
            createdAt:new Date().toISOString()});
          const inserted=await client.query<{id:string}>(`INSERT INTO ccl_knowledge_lint_findings
            (id,pass_id,project_id,space_id,principal_id,installation_id,purpose,finding_key,kind,payload)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(pass_id,finding_key) DO NOTHING RETURNING id`,
            [findingId,row.id,...scope(context),findingKey,kind,found]);
          if(inserted.rowCount){newFindingCount++;
            if(findingIds.length<1000)findingIds.push(findingId);}
        };
        for(const head of page){
          if(!head.review_admitted){omitted.push('head_not_reviewed_for_requested_purpose');continue;}
          if(head.due_at&&Number.isFinite(Date.parse(head.due_at))&&Date.parse(head.due_at)<=Date.now())
            await add(head,'review_due','Current Wiki reviewDueAt has elapsed.',[],true);
          const deps=(await client.query<Dep>(`SELECT d.domain,d.dep_object_id,d.dep_version_id,d.critical,
            r.published_at,r.payload->'binding'->>'spaceId' AS target_space,(r.object_id IS NOT NULL) AS exists
            FROM ccl_knowledge_deps d LEFT JOIN ccl_knowledge_revisions r
              ON r.project_id=d.project_id AND r.object_id=d.dep_object_id AND r.version_id=d.dep_version_id
            WHERE d.project_id=$1 AND d.object_id=$2 AND d.version_id=$3 AND d.domain='knowledge'`,
            [context.scope.projectId,head.object_id,head.version_id])).rows;
          if(!deps.length)await add(head,'orphan','Current Wiki has no normalized knowledge edge; inspect its intended links.');
          const broken=deps.filter(dep=>!dep.exists||!dep.published_at);
          if(broken.length)await add(head,'broken_link',
            `Knowledge dependency points to a missing or unpublished exact version: ${broken.slice(0,10).map(dep=>
              `${dep.dep_object_id}/${dep.dep_version_id}`).join(', ')}${broken.length>10?' (more omitted)':''}.`,
            broken.filter(dep=>dep.exists&&dep.target_space).map(dep=>
              ref(context,dep.dep_object_id,dep.dep_version_id,dep.target_space!)),broken.some(dep=>dep.critical));
          const invalid:KnowledgeRef[]=[];
          for(const dep of deps.filter(item=>item.critical&&!broken.includes(item))){
            const frozen=await store.inspectFrozen?.(context.scope.projectId,
              {objectId:dep.dep_object_id,versionId:dep.dep_version_id});
            if(!frozen?.published||!frozen.validity.valid)invalid.push(ref(context,dep.dep_object_id,
              dep.dep_version_id,frozen?.spaceId??dep.target_space??context.scope.spaceId));
          }
          const subjectFrozen=await store.inspectFrozen?.(context.scope.projectId,
            {objectId:head.object_id,versionId:head.version_id});
          const sourceIssues=subjectFrozen?.validity.issues.filter(issue=>issue.domain!=='knowledge')??[];
          if(invalid.length||sourceIssues.length)await add(head,'invalid_critical_basis',
            `Critical frozen basis has invalid metadata${sourceIssues.length?`: ${sourceIssues.slice(0,5).map(issue=>
              `${issue.domain}:${issue.ref.objectId}/${issue.ref.versionId} (${issue.reason})`).join(', ')}`:''}.`,invalid,true);
          if(head.citation_shape!=='array'||head.citation_count===0)
            await add(head,'missing_citation','No structured Wiki citation is recorded; this is a review prompt, not proof of an incorrect claim.');
          if(head.citation_shape&&head.citation_shape!=='array')omitted.push('malformed_citation_metadata');
          if(!head.group_shape_valid)omitted.push('malformed_source_group_metadata');
          if(head.group_shape_valid&&head.group_count>head.group_distinct)
            await add(head,'duplicate_source_group','A source group identifier occurs more than once in this exact revision.');
          if(head.profile_id&&head.profile_version&&head.identity_key){
            const duplicates=(await client.query<{object_id:string;version_id:string}>(`SELECT other.object_id,other.version_id
              FROM ccl_knowledge_heads other JOIN ccl_knowledge_revisions revision
                ON revision.project_id=other.project_id AND revision.object_id=other.object_id
                  AND revision.version_id=other.version_id
              WHERE other.project_id=$1 AND other.object_id<>$2 AND revision.kind='wiki_page'
                AND revision.published_at IS NOT NULL AND revision.payload->'binding'->>'spaceId'=$3
                AND jsonb_typeof(revision.payload->'content'->'profile'->'id')='string'
                AND jsonb_typeof(revision.payload->'content'->'profile'->'version')='string'
                AND jsonb_typeof(revision.payload->'content'->'identity'->'key')='string'
                AND revision.payload->'content'->'profile'->>'id'=$4
                AND revision.payload->'content'->'profile'->>'version'=$5
                AND revision.payload->'content'->'identity'->>'key'=$6
              ORDER BY other.object_id::uuid LIMIT 50`,
              [context.scope.projectId,head.object_id,context.scope.spaceId,head.profile_id,
                head.profile_version,head.identity_key])).rows;
            if(duplicates.length)await add(head,'suspected_duplicate',
              'Another current Wiki has the same exact profile and identity key; manual review is required.',
              duplicates.map(other=>ref(context,other.object_id,other.version_id)));
          }
        }
        const last=page.at(-1)?.object_id??row.last_object_id;
        const complete=heads.length<=request.limit;
        const updated=(await client.query<PassRow>(`UPDATE ccl_knowledge_lint_passes SET scanned=scanned+$2,
          last_object_id=$3,complete=$4,finding_ids=$5,observed_epoch=$6,omitted_reasons=$7,
          finding_count=finding_count+$8,updated_at=now()
          WHERE id=$1 RETURNING *`,[row.id,page.length,last,complete,JSON.stringify(findingIds),epoch,
            JSON.stringify(unique(omitted)),newFindingCount])).rows[0];
        committing=true;await client.query('COMMIT');return passDto(updated,request);
      }catch(error){if(committing)throw new WikiLintCommitUnknownError(operationId);
        await client.query('ROLLBACK');throw error;}finally{client.release();}
    },
    async findings(context:ReadContext,options:{limit:number;cursor?:string;status?:MaintenanceFinding['status']}):
      Promise<{items:MaintenanceFinding[];hasMore:boolean;nextCursor:string|null}>{
      assertContext(context);
      if(!Number.isInteger(options.limit)||options.limit<1||options.limit>100||
        options.cursor!==undefined&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.cursor)||
        options.status!==undefined&&!['open','superseded','resolved'].includes(options.status))
        throw new KnowledgeError('WIKI_LINT_PAGE_INVALID','Bounded findings pagination is required',422);
      const rows=(await pool.query<{id:string;status:MaintenanceFinding['status'];payload:MaintenanceFinding}>(`SELECT id,status,payload FROM ccl_knowledge_lint_findings
        WHERE project_id=$1 AND space_id=$2 AND principal_id=$3 AND installation_id=$4 AND purpose=$5
          AND ($6::uuid IS NULL OR id>$6::uuid) AND ($7::text IS NULL OR status=$7)
        ORDER BY id LIMIT $8`,[...scope(context),options.cursor??null,options.status??null,options.limit+1])).rows;
      const items=rows.slice(0,options.limit).map(row=>MaintenanceFindingSchema.parse({...row.payload,status:row.status}));
      return {items,hasMore:rows.length>options.limit,nextCursor:rows.length>options.limit?items.at(-1)!.id:null};
    },
  };
}
