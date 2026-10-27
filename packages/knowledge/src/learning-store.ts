import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VersionRef } from '../../contracts/src/index.ts';
import { assertSource, assertText, manifestHash, questionKey, sourceKey, stableHash } from './learning-schemas.ts';
import { KnowledgeError } from './types.ts';
import type { KnowledgeRevision } from './types.ts';
import { COVERAGE_CONTRACT_VERSION,evidenceAdmissionFingerprint,type EvidenceReport,type EvidenceTopic } from './learning-coverage.ts';
import type { BuildRecord, WikiExperienceManifest, KnowledgeLearningStore, LearningCategory, LearningInputEvent, LearningItemsQuery, LearningOverview, LearningSnapshot, ReportCoverage, ResearchNeed, ResearchRequest, Topic, TopicMembership, TopicRelation } from './learning-types.ts';

type Db = Pick<PoolClient, 'query'>;
const iso = () => new Date().toISOString();
const must = <T>(value:T|null|undefined, label:string):T => { if (!value) throw new Error(`${label} not found`); return value; };
async function transactional<T>(pool:Pool, action:(db:Db)=>Promise<T>, external?:Db):Promise<T> {
  if (external) return action(external);
  const db=await pool.connect();
  try { await db.query('BEGIN'); const result=await action(db); await db.query('COMMIT'); return result; }
  catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
async function topic(db:Db,projectId:string,id:string):Promise<Topic|null> {
  const r=await db.query('SELECT payload FROM ccl_learning_topics WHERE project_id=$1 AND id=$2',[projectId,id]);
  return r.rows[0]?.payload ?? null;
}
async function build(db:Db,projectId:string,id:string):Promise<BuildRecord|null> {
  const r=await db.query('SELECT payload FROM ccl_learning_builds WHERE project_id=$1 AND id=$2',[projectId,id]);
  return r.rows[0]?.payload ?? null;
}
async function lockEventOrder(db:Db,projectId:string):Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`learning-event-order:${projectId}`]);
}
async function recordMembershipChange(db:Db, membership:TopicMembership, source:TopicMembership['source'], affectedTopicIds:string[]) {
  if(!affectedTopicIds.length) return;
  const eventKey=`membership:${memberKey(source,membership.topicId)}:${membership.version}`;
  const reason=`membership ${membership.state}: ${membership.reason}`;
  const payload:Omit<LearningInputEvent,'sequence'>={projectId:membership.projectId,eventKey,type:'source',sources:[source],
    topicIds:[...new Set(affectedTopicIds)].sort(),requestedTopicIds:[...new Set(affectedTopicIds)].sort(),reason,createdAt:iso()};
  const inserted=await db.query(`INSERT INTO ccl_learning_events(project_id,event_key,payload) VALUES($1,$2,$3)
    ON CONFLICT(project_id,event_key) DO NOTHING RETURNING sequence`,[membership.projectId,eventKey,payload]);
  if(!inserted.rows[0]) return;
  const sequence=Number(inserted.rows[0].sequence);
  for(const id of payload.topicIds) {
    await db.query('INSERT INTO ccl_learning_event_topics(project_id,sequence,topic_id) VALUES($1,$2,$3)',[membership.projectId,sequence,id]);
    await db.query(`INSERT INTO ccl_learning_dirty(project_id,topic_id,latest_sequence) VALUES($1,$2,$3)
      ON CONFLICT(project_id,topic_id) DO UPDATE SET latest_sequence=GREATEST(ccl_learning_dirty.latest_sequence,EXCLUDED.latest_sequence)`,
      [membership.projectId,id,sequence]);
  }
}
function memberKey(source:TopicMembership['source'],topicId:string|null):string {
  return stableHash({source:sourceKey(source),topicId});
}
async function reconcileUnassigned(db:Db,projectId:string,source:TopicMembership['source'],unassigned:boolean,reason:string) {
  const key=memberKey(source,null);
  const row=await db.query('SELECT payload FROM ccl_learning_memberships WHERE project_id=$1 AND member_key=$2 FOR UPDATE',[projectId,key]);
  const old=row.rows[0]?.payload as TopicMembership|undefined;
  if(!old&&!unassigned)return;
  const mergedSource={...source,sourceGroup:source.sourceGroup??old?.source.sourceGroup??null};
  const state=unassigned?'unassigned':'rejected';
  if(old?.state===state && old.source.sourceGroup===mergedSource.sourceGroup)return;
  const now=iso();
  const value:TopicMembership={id:old?.id??randomUUID(),projectId,source:mergedSource,topicId:null,topicVersion:null,
    state,reason,methodVersion:old?.methodVersion??'deterministic-v1',version:(old?.version??0)+1,
    createdAt:old?.createdAt??now,updatedAt:now};
  await db.query(`INSERT INTO ccl_learning_memberships(project_id,member_key,id,source_key,topic_id,payload)
    VALUES($1,$2,$3,$4,NULL,$5) ON CONFLICT(project_id,member_key) DO UPDATE SET payload=EXCLUDED.payload`,
    [projectId,key,value.id,sourceKey(source),value]);
  await db.query('INSERT INTO ccl_learning_membership_history(project_id,member_key,version,payload) VALUES($1,$2,$3,$4)',
    [projectId,key,value.version,value]);
}
function eventIntent(input:{type:string;sources?:TopicMembership['source'][];topicIds?:string[];reason:string}) {
  return {type:input.type,sources:[...(input.sources??[])].sort((a,b)=>sourceKey(a).localeCompare(sourceKey(b))),
    requestedTopicIds:[...(input.topicIds??[])].sort(),reason:input.reason};
}
function assertSameEvent(actual:LearningInputEvent,input:Parameters<KnowledgeLearningStore['registerInput']>[0]) {
  const normalized={...actual,topicIds:actual.requestedTopicIds??actual.topicIds};
  if(stableHash(eventIntent(normalized))!==stableHash(eventIntent(input))) throw new Error('event key conflict');
}

export function createKnowledgeLearningStore(pool:Pool):KnowledgeLearningStore {
  const store:KnowledgeLearningStore={
    async getItem(projectId,category,id){
      const table={topics:'ccl_learning_topics',builds:'ccl_learning_builds',needs:'ccl_learning_needs',requests:'ccl_learning_requests',
        memberships:'ccl_learning_memberships',unassigned:'ccl_learning_memberships'}[category];
      const where=category==='memberships'?'AND topic_id IS NOT NULL':category==='unassigned'?"AND topic_id IS NULL AND payload->>'state'='unassigned'":'';
      const row=await pool.query(`SELECT payload FROM ${table} WHERE project_id=$1 AND id=$2 ${where}`,[projectId,id]);
      return row.rows[0]?.payload??null;
    },
    async overview(projectId) {
      const [topics,pending,counts]=await Promise.all([
        store.listItems(projectId,{category:'topics',limit:50}),
        store.listItems(projectId,{category:'pending',limit:50}),
        pool.query(`SELECT
          (SELECT count(*) FROM ccl_learning_topics WHERE project_id=$1)::int topics,
          (SELECT count(*) FROM ccl_learning_memberships WHERE project_id=$1 AND topic_id IS NOT NULL)::int memberships,
          (SELECT count(*) FROM ccl_learning_memberships WHERE project_id=$1 AND topic_id IS NULL AND payload->>'state'='unassigned')::int unassigned,
          (SELECT count(*) FROM ccl_learning_needs WHERE project_id=$1)::int needs,
          (SELECT count(*) FROM ccl_learning_requests WHERE project_id=$1)::int requests,
          (SELECT count(*) FROM ccl_learning_builds WHERE project_id=$1)::int builds,
          (SELECT count(*) FROM ccl_learning_dirty WHERE project_id=$1 AND latest_sequence>processed_sequence)::int pending`,[projectId]),
      ]);
      return {schemaVersion:'1.0',topics:topics.items as LearningOverview['topics'],pending:pending.items as LearningSnapshot['pending'],counts:counts.rows[0],
        pageInfo:{topics:topics.pageInfo,pending:pending.pageInfo}};
    },
    async listItems(projectId,query) {
      const category:LearningCategory=query.category;
      if(query.topicId&&['topics','pending','unassigned'].includes(category))throw new KnowledgeError('INVALID_TOPIC_FILTER','This category does not accept a topic filter',400);
      if(query.topicId==='unassigned'&&!['needs','requests'].includes(category))throw new KnowledgeError('INVALID_TOPIC_FILTER','Unassigned filter belongs to research needs or requests',400);
      if(query.source&&!['memberships','unassigned'].includes(category))throw new KnowledgeError('INVALID_SOURCE_FILTER','Exact source filter belongs to membership pages',400);
      const limit=Math.min(Math.max(query.limit??50,1),50);
      const binding={projectId,category,topicId:query.topicId??null,source:query.source?sourceKey(query.source):null};
      let after:{id:string;sequence?:number}|null=null;
      if(query.cursor) {
        try {const decoded=JSON.parse(Buffer.from(query.cursor,'base64url').toString('utf8'));
          if(stableHash(decoded.binding)!==stableHash(binding)||typeof decoded.id!=='string'||
            (['builds','pending'].includes(category)&&!Number.isSafeInteger(decoded.sequence)))throw new Error('invalid');
          after={id:decoded.id,sequence:decoded.sequence};
        } catch {throw new KnowledgeError('INVALID_CURSOR','Learning cursor does not match this project and filter',400);}
      }
      if(category==='topics'){
        const count=await pool.query('SELECT count(*)::int total FROM ccl_learning_topics WHERE project_id=$1',[projectId]);
        const rows=await pool.query(`SELECT id,(payload - 'aliases') || jsonb_build_object(
          'title',left(payload->>'title',80),'question',left(payload->>'question',120),'aliases','[]'::jsonb,
          'truncatedFields',to_jsonb(array_remove(ARRAY[
            CASE WHEN length(payload->>'title')>80 THEN 'title' END,
            CASE WHEN length(payload->>'question')>120 THEN 'question' END,
            CASE WHEN jsonb_array_length(COALESCE(payload->'aliases','[]'::jsonb))>0 THEN 'aliases' END]::text[],NULL))) item
          FROM ccl_learning_topics WHERE project_id=$1 AND ($2::text IS NULL OR id>$2) ORDER BY id LIMIT $3`,[projectId,after?.id??null,limit+1]);
        const visible=rows.rows.slice(0,limit),last=visible.at(-1),hasMore=rows.rows.length>limit;
        return {schemaVersion:'1.0',category,items:visible.map(row=>row.item),pageInfo:{total:Number(count.rows[0].total),hasMore,
          nextCursor:hasMore&&last?Buffer.from(JSON.stringify({binding,id:last.id})).toString('base64url'):null}};
      }
      if(category==='pending'){
        const count=await pool.query('SELECT count(*)::int total FROM ccl_learning_dirty WHERE project_id=$1 AND latest_sequence>processed_sequence',[projectId]);
        const rows=await pool.query(`WITH d AS (SELECT project_id,topic_id,latest_sequence,processed_sequence FROM ccl_learning_dirty
          WHERE project_id=$1 AND latest_sequence>processed_sequence AND ($2::bigint IS NULL OR (latest_sequence,topic_id)<($2,$3))
          ORDER BY latest_sequence DESC,topic_id DESC LIMIT $4)
          SELECT d.topic_id,d.latest_sequence,d.processed_sequence,
          (SELECT count(DISTINCT COALESCE(NULLIF(src.item->>'sourceGroup',''),
            (SELECT MIN(NULLIF(m.payload->'source'->>'sourceGroup','')) FROM ccl_learning_memberships m
              WHERE m.project_id=d.project_id AND m.source_key=(src.item->>'domain')||':'||(src.item->'ref'->>'objectId')||':'||(src.item->'ref'->>'versionId')),
            (src.item->>'domain')||':'||(src.item->'ref'->>'objectId')||':'||(src.item->'ref'->>'versionId')))::int
            FROM ccl_learning_event_topics e JOIN ccl_learning_events v ON v.sequence=e.sequence
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(v.payload->'sources','[]'::jsonb)) AS src(item)
            WHERE e.project_id=d.project_id AND e.topic_id=d.topic_id AND e.sequence>d.processed_sequence) count,
          (SELECT MIN((v.payload->>'createdAt')::timestamptz) FROM ccl_learning_event_topics e JOIN ccl_learning_events v ON v.sequence=e.sequence
            WHERE e.project_id=d.project_id AND e.topic_id=d.topic_id AND e.sequence>d.processed_sequence) oldest_at
          FROM d ORDER BY d.latest_sequence DESC,d.topic_id DESC`,[projectId,after?.sequence??null,after?.id??null,limit+1]);
        const visible=rows.rows.slice(0,limit),last=visible.at(-1),hasMore=rows.rows.length>limit;
        return {schemaVersion:'1.0',category,items:visible.map(row=>({topicId:row.topic_id,latestSequence:Number(row.latest_sequence),
          processedSequence:Number(row.processed_sequence),count:Number(row.count),oldestAt:row.oldest_at?.toISOString()??null})),
          pageInfo:{total:Number(count.rows[0].total),hasMore,nextCursor:hasMore&&last?Buffer.from(JSON.stringify({binding,id:last.topic_id,sequence:Number(last.latest_sequence)})).toString('base64url'):null}};
      }
      const spec:Record<Exclude<LearningCategory,'topics'|'pending'>,{table:string;where:string;params:unknown[]}>={
        builds:{table:'ccl_learning_builds',where:'($2::text IS NULL OR topic_id=$2) AND ($3::text IS NULL OR true)',params:[]},
        needs:{table:'ccl_learning_needs',where:"($2::text IS NULL OR topic_id=$2 OR ($2='unassigned' AND topic_id IS NULL)) AND ($3::text IS NULL OR true)",params:[]},
        requests:{table:'ccl_learning_requests',where:"($2::text IS NULL OR EXISTS (SELECT 1 FROM ccl_learning_needs n WHERE n.project_id=t.project_id AND n.id=t.need_id AND (n.topic_id=$2 OR ($2='unassigned' AND n.topic_id IS NULL)))) AND ($3::text IS NULL OR true)",params:[]},
        memberships:{table:'ccl_learning_memberships',where:'topic_id IS NOT NULL AND ($2::text IS NULL OR topic_id=$2) AND ($3::text IS NULL OR source_key=$3)',params:[]},
        unassigned:{table:'ccl_learning_memberships',where:"topic_id IS NULL AND payload->>'state'='unassigned' AND ($2::text IS NULL OR true) AND ($3::text IS NULL OR source_key=$3)",params:[]},
      };
      const {table,where}=spec[category];
      const base=[projectId,query.topicId??null,query.source?sourceKey(query.source):null];
      const count=await pool.query(`SELECT count(*)::int total FROM ${table} t WHERE project_id=$1 AND ${where}`,base);
      const seek=category==='builds'?'AND ($4::bigint IS NULL OR (through_sequence,id)<($4,$5))':'AND ($4::bigint IS NULL OR true) AND ($5::text IS NULL OR id>$5)';
      const order=category==='builds'?'through_sequence DESC,id DESC':'id ASC';
      const short=(field:string,size=120)=>`left(payload->>'${field}',${size})`;
      const clipped=(...fields:string[])=>`to_jsonb(array_remove(ARRAY[${fields.map(field=>`CASE WHEN length(payload->>'${field}')>120 THEN '${field}' END`).join(',')}]::text[],NULL))`;
      const projection=category==='builds'?`(payload - 'manifest' - 'usage' - 'cost' - 'publishedRefs') || jsonb_build_object(
        'reason',${short('reason')},'outcomeReason',${short('outcomeReason')},'recovery',${short('recovery')},
        'usage',CASE WHEN octet_length((payload->'usage')::text)<=512 THEN payload->'usage' ELSE NULL END,
        'cost',CASE WHEN octet_length((payload->'cost')::text)<=512 THEN payload->'cost' ELSE NULL END,
        'publishedRefs',COALESCE((SELECT jsonb_agg(ref.value) FROM jsonb_array_elements(COALESCE(payload->'publishedRefs','[]'::jsonb)) WITH ORDINALITY ref(value,n) WHERE n<=8),'[]'::jsonb),
        'publishedRefCount',jsonb_array_length(COALESCE(payload->'publishedRefs','[]'::jsonb)),
        'truncatedFields',to_jsonb(array_remove(ARRAY[
          CASE WHEN length(payload->>'reason')>120 THEN 'reason' END,
          CASE WHEN length(payload->>'outcomeReason')>120 THEN 'outcomeReason' END,
          CASE WHEN length(payload->>'recovery')>120 THEN 'recovery' END,
          CASE WHEN octet_length((payload->'usage')::text)>512 THEN 'usage' END,
          CASE WHEN octet_length((payload->'cost')::text)>512 THEN 'cost' END,
          CASE WHEN jsonb_array_length(COALESCE(payload->'publishedRefs','[]'::jsonb))>8 THEN 'publishedRefs' END]::text[],NULL)))`
        :category==='needs'?`(payload - 'budget' - 'resolutionSourceRefs' - 'resolutionResultRefs') || jsonb_build_object(
          'problem',${short('problem')},'expectedEvidence',${short('expectedEvidence')},'value',${short('value')},
          'reviewReason',${short('reviewReason')},'truncatedFields',${clipped('problem','expectedEvidence','value','reviewReason')})`
        :category==='requests'?`(payload - 'budget' - 'inputRefs') || jsonb_build_object(
          'authorization',${short('authorization')},'expectedResult',${short('expectedResult')},
          'truncatedFields',${clipped('authorization','expectedResult')})`
        :`payload || jsonb_build_object('reason',${short('reason')},'truncatedFields',${clipped('reason')})`;
      const rows=await pool.query(`SELECT id,${category==='builds'?'through_sequence,':''} ${projection} AS item FROM ${table} t
        WHERE project_id=$1 AND ${where} ${seek} ORDER BY ${order} LIMIT $6`,
        [...base,after?.sequence??null,after?.id??null,limit+1]);
      const visible=rows.rows.slice(0,limit),last=visible.at(-1),hasMore=rows.rows.length>limit;
      const nextCursor=hasMore&&last?Buffer.from(JSON.stringify({binding,id:last.id,...(category==='builds'?{sequence:Number(last.through_sequence)}:{})})).toString('base64url'):null;
      return {schemaVersion:'1.0',category,items:visible.map(row=>row.item),pageInfo:{total:Number(count.rows[0].total),hasMore,nextCursor}};
    },
    async listTopics(projectId) {
      return (await pool.query('SELECT payload FROM ccl_learning_topics WHERE project_id=$1 ORDER BY id',[projectId]))
        .rows.map(row=>row.payload as Topic);
    },
    async getTopic(projectId,topicId) {return topic(pool,projectId,topicId);},
    async getNeed(projectId,needId) {
      const row=await pool.query('SELECT payload FROM ccl_learning_needs WHERE project_id=$1 AND id=$2',[projectId,needId]);
      return row.rows[0]?.payload as ResearchNeed|undefined??null;
    },
    async getMembershipBySource(projectId,topicId,source) {
      const row=await pool.query('SELECT payload FROM ccl_learning_memberships WHERE project_id=$1 AND topic_id=$2 AND source_key=$3',
        [projectId,topicId,sourceKey(source)]);
      return row.rows[0]?.payload as TopicMembership|undefined??null;
    },
    async listTopicMemberships(projectId,topicId,afterId=null,limit=200) {
      const n=Math.max(1,Math.min(limit,500));
      return (await pool.query(`SELECT payload FROM ccl_learning_memberships WHERE project_id=$1 AND topic_id=$2
        AND ($3::text IS NULL OR id>$3) ORDER BY id LIMIT $4`,[projectId,topicId,afterId,n])).rows
        .map(row=>row.payload as TopicMembership);
    },
    async pendingTopics(projectId) {
      const rows=await pool.query(`SELECT d.topic_id,d.latest_sequence,d.processed_sequence,
        (SELECT count(DISTINCT COALESCE(NULLIF(src.item->>'sourceGroup',''),
          (SELECT MIN(NULLIF(m.payload->'source'->>'sourceGroup','')) FROM ccl_learning_memberships m
            WHERE m.project_id=d.project_id AND m.source_key=(src.item->>'domain')||':'||(src.item->'ref'->>'objectId')||':'||(src.item->'ref'->>'versionId')),
          (src.item->>'domain')||':'||(src.item->'ref'->>'objectId')||':'||(src.item->'ref'->>'versionId')))::int
          FROM ccl_learning_event_topics e JOIN ccl_learning_events v ON v.sequence=e.sequence
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(v.payload->'sources','[]'::jsonb)) AS src(item)
          WHERE e.project_id=d.project_id AND e.topic_id=d.topic_id AND e.sequence>d.processed_sequence) AS count,
        (SELECT MIN((v.payload->>'createdAt')::timestamptz) FROM ccl_learning_event_topics e JOIN ccl_learning_events v ON v.sequence=e.sequence
          WHERE e.project_id=d.project_id AND e.topic_id=d.topic_id AND e.sequence>d.processed_sequence) AS oldest_at
        FROM ccl_learning_dirty d WHERE d.project_id=$1 AND d.latest_sequence>d.processed_sequence ORDER BY d.latest_sequence DESC`,[projectId]);
      return rows.rows.map(row=>({topicId:row.topic_id,latestSequence:Number(row.latest_sequence),
        processedSequence:Number(row.processed_sequence),count:Number(row.count),oldestAt:row.oldest_at?.toISOString()??null}));
    },
    async listTopicBuilds(projectId,topicId,after=null,limit=100) {
      const n=Math.max(1,Math.min(limit,500));
      return (await pool.query(`SELECT payload FROM ccl_learning_builds WHERE project_id=$1 AND topic_id=$2
        AND ($3::bigint IS NULL OR (through_sequence,id)<($3,$4))
        ORDER BY through_sequence DESC,id DESC LIMIT $5`,[projectId,topicId,after?.throughSequence??null,after?.id??null,n])).rows
        .map(row=>row.payload as BuildRecord);
    },
    async listRunBuilds(projectId,topicId,runId) {
      return (await pool.query(`SELECT payload FROM ccl_learning_builds WHERE project_id=$1 AND topic_id=$2
        AND payload->'manifest'->'batch'->>'runId'=$3 ORDER BY (payload->'manifest'->'batch'->>'index')::int`,
        [projectId,topicId,runId])).rows.map(row=>row.payload as BuildRecord);
    },
    async latestAcceptedBatch(projectId,topicId) {
      const rows=await pool.query(`SELECT payload FROM ccl_learning_builds WHERE project_id=$1 AND topic_id=$2
        AND payload->'manifest'->'batch' IS NOT NULL AND payload->>'outcome' IN ('changed','no_change')
        ORDER BY payload->>'finishedAt' DESC LIMIT 1`,[projectId,topicId]);
      return rows.rows[0]?.payload as BuildRecord|undefined??null;
    },
    async reportCoverage(projectId,topicId) {
      const rows=await pool.query(`SELECT report_object_id,report_version_id,processing_fingerprint,accepted_build_id,published_ref,accepted_at
        FROM ccl_learning_report_coverage WHERE project_id=$1 AND topic_id=$2`,[projectId,topicId]);
      return rows.rows.map(row=>({ref:{objectId:row.report_object_id,versionId:row.report_version_id},
        processingFingerprint:row.processing_fingerprint,acceptedBuildId:row.accepted_build_id,
        publishedRef:row.published_ref as ReportCoverage['publishedRef'],acceptedAt:row.accepted_at.toISOString()}));
    },
    async listUnfinishedBuilds(projectId,topicId,client) {
      const rows=await (client??pool).query(`SELECT payload FROM ccl_learning_builds
        WHERE project_id=$1 AND topic_id=$2 AND payload->>'outcome' IS NULL
        ORDER BY through_sequence,id`,[projectId,topicId]);
      return rows.rows.map(row=>row.payload as BuildRecord);
    },
    async createTopic(input) {
      assertText(input.projectId,'projectId'); assertText(input.title,'title'); assertText(input.question,'question'); assertText(input.method,'method');
      const key=questionKey(input.question); const now=iso();
      const value:Topic={id:input.id??randomUUID(),projectId:input.projectId,title:input.title,question:input.question,questionKey:key,
        status:input.status??'candidate',version:1,method:input.method,aliases:input.aliases??[],createdAt:now,updatedAt:now};
      return transactional(pool,async db=>{
        await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`learning-topics:${input.projectId}`]);
        const all=await db.query('SELECT payload FROM ccl_learning_topics WHERE project_id=$1',[input.projectId]);
        const existing=(all.rows.map(row=>row.payload as Topic)).find(current=>
          current.questionKey===key || current.aliases.some(alias=>questionKey(alias)===key));
        if(existing) return existing;
        const sameId=(all.rows.map(row=>row.payload as Topic)).find(current=>current.id===value.id);
        if(sameId) throw new Error('topic id already belongs to another question');
        await db.query('INSERT INTO ccl_learning_topics(project_id,id,question_key,payload) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [input.projectId,value.id,key,value]);
        const found=await db.query('SELECT payload FROM ccl_learning_topics WHERE project_id=$1 AND (question_key=$2 OR id=$3) ORDER BY (question_key=$2) DESC LIMIT 1',
          [input.projectId,key,value.id]);
        const actual=must<Topic>(found.rows[0]?.payload,'topic');
        if (actual.id===value.id && actual.questionKey!==key) throw new Error('topic id already belongs to another question');
        await db.query('INSERT INTO ccl_learning_topic_history(project_id,topic_id,version,reason,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [input.projectId,actual.id,actual.version,'created',actual]);
        return actual;
      });
    },
    async setTopicStatus(projectId,topicId,status,reason) {
      assertText(reason,'reason');
      return transactional(pool,async db=>{
        const row=await db.query('SELECT payload FROM ccl_learning_topics WHERE project_id=$1 AND id=$2 FOR UPDATE',[projectId,topicId]);
        const old=must<Topic>(row.rows[0]?.payload,'topic');
        if(old.status===status) return old;
        const next={...old,status,version:old.version+1,updatedAt:iso()};
        await db.query('UPDATE ccl_learning_topics SET payload=$3 WHERE project_id=$1 AND id=$2',[projectId,topicId,next]);
        await db.query('INSERT INTO ccl_learning_topic_history(project_id,topic_id,version,reason,payload) VALUES($1,$2,$3,$4,$5)',[projectId,topicId,next.version,reason,next]);
        return next;
      });
    },
    async relateTopics(input) {
      assertText(input.reason,'reason'); assertText(input.reviewer,'reviewer');
      if (!input.fromTopicIds.length||!input.toTopicIds.length) throw new Error('old and new topics required');
      if(input.kind==='split' && (input.fromTopicIds.length!==1||input.toTopicIds.length<2)) throw new Error('split requires one old and multiple new topics');
      if(input.kind==='merge' && (input.fromTopicIds.length<2||input.toTopicIds.length!==1)) throw new Error('merge requires multiple old and one new topic');
      const value:TopicRelation={...input,id:input.id??randomUUID(),createdAt:iso()};
      return transactional(pool,async db=>{
        for(const id of [...input.fromTopicIds,...input.toTopicIds]) must(await topic(db,input.projectId,id),'topic');
        await db.query('INSERT INTO ccl_learning_topic_relations(project_id,id,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[input.projectId,value.id,value]);
        const row=await db.query('SELECT payload FROM ccl_learning_topic_relations WHERE project_id=$1 AND id=$2',[input.projectId,value.id]);
        return row.rows[0].payload;
      });
    },
    async assignMembership(input) {
      assertSource(input.source); assertText(input.reason,'reason'); assertText(input.methodVersion,'methodVersion');
      if(input.state==='unassigned' ? input.topicId!==null : input.topicId===null) throw new Error('membership topic/state mismatch');
      const key=memberKey(input.source,input.topicId);
      return transactional(pool,async db=>{
        await lockEventOrder(db,input.projectId);
        await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`learning-membership:${input.projectId}:${key}`]);
        const target=input.topicId===null?null:must(await topic(db,input.projectId,input.topicId),'topic');
        let priorUnassigned:TopicMembership|undefined;
        if(input.topicId) {
          const unassignedKey=memberKey(input.source,null);
          const waiting=await db.query('SELECT payload FROM ccl_learning_memberships WHERE project_id=$1 AND member_key=$2 FOR UPDATE',[input.projectId,unassignedKey]);
          priorUnassigned=waiting.rows[0]?.payload as TopicMembership|undefined;
        }
        const row=await db.query('SELECT payload FROM ccl_learning_memberships WHERE project_id=$1 AND member_key=$2 FOR UPDATE',[input.projectId,key]);
        const old=row.rows[0]?.payload as TopicMembership|undefined;
        if(input.ifAbsent&&(old||priorUnassigned&&priorUnassigned.methodVersion!=='deterministic-v1'))return old??priorUnassigned!;
        const mergedSource={...input.source,sourceGroup:input.source.sourceGroup??old?.source.sourceGroup??priorUnassigned?.source.sourceGroup??null};
        if(old && old.state===input.state && old.reason===input.reason && old.methodVersion===input.methodVersion &&
          old.topicVersion===(target?.version??null) && old.source.sourceGroup===mergedSource.sourceGroup) return old;
        const now=iso();
        const value:TopicMembership={id:old?.id??input.id??randomUUID(),projectId:input.projectId,source:mergedSource,
          topicId:input.topicId,topicVersion:target?.version??null,state:input.state,reason:input.reason,
          methodVersion:input.methodVersion,version:(old?.version??0)+1,createdAt:old?.createdAt??now,updatedAt:now};
        await db.query(`INSERT INTO ccl_learning_memberships(project_id,member_key,id,source_key,topic_id,payload)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(project_id,member_key) DO UPDATE SET payload=EXCLUDED.payload`,
          [input.projectId,key,value.id,sourceKey(input.source),input.topicId,value]);
        await db.query('INSERT INTO ccl_learning_membership_history(project_id,member_key,version,payload) VALUES($1,$2,$3,$4)',[input.projectId,key,value.version,value]);
        if(input.topicId) {
          const active=await db.query(`SELECT 1 FROM ccl_learning_memberships WHERE project_id=$1 AND source_key=$2 AND topic_id IS NOT NULL
            AND payload->>'state' IN ('candidate','confirmed') LIMIT 1`,[input.projectId,sourceKey(input.source)]);
          await reconcileUnassigned(db,input.projectId,mergedSource,active.rows.length===0,
            active.rows.length?`assigned to topic: ${input.reason}`:`no active topic membership: ${input.reason}`);
        }
        await recordMembershipChange(db,value,mergedSource,input.topicId?[input.topicId]:[]);
        return value;
      });
    },
    async registerInput(input) {
      assertText(input.projectId,'projectId'); assertText(input.eventKey,'eventKey'); assertText(input.reason,'reason');
      const sources=input.sources??[]; sources.forEach(assertSource);
      return transactional(pool,async db=>{
        await lockEventOrder(db,input.projectId);
        const existing=await db.query('SELECT sequence,payload FROM ccl_learning_events WHERE project_id=$1 AND event_key=$2',[input.projectId,input.eventKey]);
        if(existing.rows[0]) {
          const prior={...existing.rows[0].payload,sequence:Number(existing.rows[0].sequence)} as LearningInputEvent;
          assertSameEvent(prior,input);
          return prior;
        }
        const affected=new Set(input.topicIds??[]);
        for(const id of affected) must(await topic(db,input.projectId,id),'topic');
        for(const source of sources) {
          const rows=await db.query('SELECT topic_id FROM ccl_learning_memberships WHERE project_id=$1 AND source_key=$2 AND payload->>\'state\' IN (\'candidate\',\'confirmed\')',
            [input.projectId,sourceKey(source)]);
          for(const row of rows.rows) if(row.topic_id) affected.add(row.topic_id);
          if(!rows.rows.some(row=>row.topic_id))await reconcileUnassigned(db,input.projectId,source,true,'new input pending assignment');
        }
        const payload:Omit<LearningInputEvent,'sequence'>={projectId:input.projectId,eventKey:input.eventKey,type:input.type,sources,
          topicIds:[...affected].sort(),requestedTopicIds:[...(input.topicIds??[])].sort(),reason:input.reason,createdAt:iso()};
        const row=await db.query(`INSERT INTO ccl_learning_events(project_id,event_key,payload) VALUES($1,$2,$3)
          ON CONFLICT(project_id,event_key) DO NOTHING RETURNING sequence,payload`,[input.projectId,input.eventKey,payload]);
        const result=row.rows[0]??(await db.query('SELECT sequence,payload FROM ccl_learning_events WHERE project_id=$1 AND event_key=$2',[input.projectId,input.eventKey])).rows[0];
        assertSameEvent(result.payload as LearningInputEvent,input);
        const sequence=Number(result.sequence);
        if(row.rows[0]) for(const id of affected) {
          await db.query('INSERT INTO ccl_learning_event_topics(project_id,sequence,topic_id) VALUES($1,$2,$3)',[input.projectId,sequence,id]);
          await db.query(`INSERT INTO ccl_learning_dirty(project_id,topic_id,latest_sequence) VALUES($1,$2,$3)
            ON CONFLICT(project_id,topic_id) DO UPDATE SET latest_sequence=GREATEST(ccl_learning_dirty.latest_sequence,EXCLUDED.latest_sequence)`,[input.projectId,id,sequence]);
        }
        return {...result.payload,sequence};
      });
    },
    markDirty(input) { return store.registerInput(input); },
    async prepareBuild(input,client) {
      assertText(input.reason,'reason');
      const hash=manifestHash(input.manifest);
      return transactional(pool,async db=>{
        must(await topic(db,input.projectId,input.topicId),'topic');
        const dirty=await db.query('SELECT latest_sequence,processed_sequence FROM ccl_learning_dirty WHERE project_id=$1 AND topic_id=$2 FOR UPDATE',[input.projectId,input.topicId]);
        const latest=Number(dirty.rows[0]?.latest_sequence??0);
        const processed=Number(dirty.rows[0]?.processed_sequence??0);
        const throughSequence=input.manifest.throughSequence??latest;
        if(!Number.isSafeInteger(throughSequence)||throughSequence<0||throughSequence>latest||throughSequence<processed)
          throw new KnowledgeError('BUILD_WATERMARK_INVALID','Frozen event watermark is outside the current unprocessed topic range',422);
        const existing=await db.query('SELECT payload FROM ccl_learning_builds WHERE project_id=$1 AND topic_id=$2 AND through_sequence=$3 AND manifest_hash=$4',
          [input.projectId,input.topicId,throughSequence,hash]);
        if(existing.rows[0]) return existing.rows[0].payload;
        const value:BuildRecord={id:randomUUID(),projectId:input.projectId,topicId:input.topicId,manifestHash:hash,
          manifest:input.manifest,throughSequence,reason:input.reason,jobId:input.jobId??null,outcome:null,outcomeReason:null,
          recovery:null,usage:null,cost:null,publishedRefs:[],createdAt:iso(),finishedAt:null};
        await db.query('INSERT INTO ccl_learning_builds(project_id,id,topic_id,through_sequence,manifest_hash,payload) VALUES($1,$2,$3,$4,$5,$6)',
          [input.projectId,value.id,input.topicId,throughSequence,hash,value]);
        return value;
      },client);
    },
    getBuild(projectId,buildId) { return build(pool,projectId,buildId); },
    async attachBuildJob(projectId,buildId,jobId,client) {
      assertText(jobId,'jobId');
      return transactional(pool,async db=>{
        const row=await db.query('SELECT payload FROM ccl_learning_builds WHERE project_id=$1 AND id=$2 FOR UPDATE',[projectId,buildId]);
        const old=must<BuildRecord>(row.rows[0]?.payload,'build');
        if(old.jobId && old.jobId!==jobId) throw new Error('build job already attached');
        if(old.outcome) throw new Error('build already finished');
        const next={...old,jobId};
        await db.query('UPDATE ccl_learning_builds SET payload=$3 WHERE project_id=$1 AND id=$2',[projectId,buildId,next]);
        return next;
      },client);
    },
    async assertInputs(projectId,input,client) {
      await lockEventOrder(client,projectId);
      const current=await client.query('SELECT payload FROM ccl_learning_topics WHERE project_id=$1 AND id=$2 FOR SHARE',[projectId,input.topicId]);
      const topic=current.rows[0]?.payload as Topic|undefined;
      if(!topic||topic.status!=='confirmed'||topic.version!==input.topicVersion)
        throw new KnowledgeError('BUILD_INPUT_CHANGED','Topic status or version changed after the build was frozen');
      const rows=await client.query(`SELECT payload FROM ccl_learning_memberships
        WHERE project_id=$1 AND topic_id=$2 AND payload->>'state'='confirmed'`,[projectId,input.topicId]);
      const actual=rows.rows.map(row=>({id:(row.payload as TopicMembership).id,version:(row.payload as TopicMembership).version}))
        .sort((a,b)=>a.id.localeCompare(b.id));
      const expected=[...input.memberships].sort((a,b)=>a.id.localeCompare(b.id));
      if(input.allowAdditionalMemberships
        ? expected.some(member=>!actual.some(row=>row.id===member.id&&row.version===member.version))
        : stableHash(actual)!==stableHash(expected))
        throw new KnowledgeError('BUILD_INPUT_CHANGED','Confirmed topic memberships changed after the build was frozen');
    },
    async acknowledgeCognitionInput(input,client) {
      return transactional(pool,async db=>{
        await store.assertInputs(input.projectId,{topicId:input.topicId,topicVersion:input.topicVersion,
          memberships:input.memberships},db);
        const all=await db.query('SELECT payload FROM ccl_learning_memberships WHERE project_id=$1 AND topic_id=$2',
          [input.projectId,input.topicId]);
        const actual=all.rows.map(row=>({id:(row.payload as TopicMembership).id,version:(row.payload as TopicMembership).version}))
          .sort((a,b)=>a.id.localeCompare(b.id));
        const expected=[...input.allMemberships].sort((a,b)=>a.id.localeCompare(b.id));
        if(stableHash(actual)!==stableHash(expected))
          throw new KnowledgeError('COGNITION_MEMBERSHIP_CHANGED','The exact selected or excluded membership changed after freezing',409);
        const row=await db.query('SELECT latest_sequence,processed_sequence FROM ccl_learning_dirty WHERE project_id=$1 AND topic_id=$2 FOR UPDATE',
          [input.projectId,input.topicId]);
        const latest=Number(row.rows[0]?.latest_sequence??0),processed=Number(row.rows[0]?.processed_sequence??0);
        if(!Number.isSafeInteger(input.throughSequence)||input.throughSequence<processed||input.throughSequence>latest)
          throw new KnowledgeError('COGNITION_WATERMARK_INVALID','Frozen cognition event watermark is outside the current topic range',409);
        await db.query('UPDATE ccl_learning_dirty SET processed_sequence=GREATEST(processed_sequence,$3) WHERE project_id=$1 AND topic_id=$2',
          [input.projectId,input.topicId,input.throughSequence]);
      },client);
    },
    async finishBuild(input,client) {
      assertText(input.reason,'reason');
      return transactional(pool,async db=>{
        const row=await db.query('SELECT payload FROM ccl_learning_builds WHERE project_id=$1 AND id=$2 FOR UPDATE',[input.projectId,input.buildId]);
        const old=must<BuildRecord>(row.rows[0]?.payload,'build');
        const wikiResearch=old.manifest.manifestVersion==='wiki-research@1';
        const targeted=old.manifest.manifestVersion==='wiki-experience@1'||
          old.manifest.manifestVersion==='query-synthesis@1'||wikiResearch;
        if(targeted) {
          // A selected-source compilation never consumes the whole Topic's dirty inventory.
          if(input.acknowledge!==false)
            throw new KnowledgeError('WIKI_BUILD_ACKNOWLEDGEMENT_FORBIDDEN','Targeted Wiki builds require acknowledge:false',422);
          if(wikiResearch&&['changed','no_change','proposed'].includes(input.outcome)&&
            input.usage?.independentReviewPassed!==true)
            throw new KnowledgeError('WIKI_RESEARCH_REVIEW_MISSING','Research outcome requires a passing independent review',409);
          const refs=input.publishedRefs??[];
          if(input.outcome==='changed') {
            const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
            if(wikiResearch) {
              const selected=new Map(old.manifest.baseHeads.map(head=>[head.objectId,head.versionId]));
              if(!refs.length||new Set(refs.map(ref=>ref.objectId)).size!==refs.length||refs.some(ref=>
                !uuid.test(ref.objectId)||!uuid.test(ref.versionId)||selected.get(ref.objectId)===ref.versionId))
                throw new KnowledgeError('WIKI_BUILD_PUBLICATION_REFS_INVALID','Changed research builds require fresh published refs',422);
            } else {
              const manifest=old.manifest as WikiExperienceManifest;
              const selected=new Map(manifest.baseHeads.map(head=>[head.objectId,head.versionId]));
              const targetMatches=(ref:VersionRef)=>old.manifest.manifestVersion==='query-synthesis@1'
                ?ref.objectId===(old.manifest as {targetObjectId?:string}).targetObjectId&&
                  (selected.get(ref.objectId)??null)===((old.manifest as {target?:KnowledgeRevision|null}).target?.ref.versionId??null)
                :manifest.targetRevisions.some(target=>target.ref.objectId===ref.objectId&&
                  target.ref.versionId===selected.get(ref.objectId));
              if(!refs.length||new Set(refs.map(ref=>ref.objectId)).size!==refs.length||refs.some(ref=>
                !uuid.test(ref.objectId)||!uuid.test(ref.versionId)||!selected.has(ref.objectId)||
                selected.get(ref.objectId)===ref.versionId||!targetMatches(ref)))
                throw new KnowledgeError('WIKI_BUILD_PUBLICATION_REFS_INVALID','Changed Wiki builds require exact fresh refs for selected target objects',422);
            }
          } else if(refs.length) {
            throw new KnowledgeError('WIKI_BUILD_PUBLICATION_REFS_INVALID','Unpublished Wiki outcomes cannot carry published refs',422);
          }
        } else if(input.outcome==='proposed') {
          throw new KnowledgeError('BUILD_OUTCOME_UNSUPPORTED','Proposal-only outcome requires a versioned targeted Wiki manifest',422);
        }
        if(old.outcome) {
          if(old.outcome!==input.outcome) throw new Error('build outcome conflict');
          return old;
        }
        const dirty=await db.query('SELECT processed_sequence FROM ccl_learning_dirty WHERE project_id=$1 AND topic_id=$2 FOR UPDATE',[input.projectId,old.topicId]);
        const processed=Number(dirty.rows[0]?.processed_sequence??0);
        const accepted=input.outcome==='changed'||input.outcome==='no_change';
        type Reuse={buildId:string;ref:VersionRef;processingFingerprint:string;proof?:{kind:'exact'}|{
          kind:'legacy_compatible';sourceBuildId:string;recordedProcessingFingerprint:string;
          coverageContractVersion:string;evidenceAdmissionFingerprint:string}};
        type Batch={runId:string;index:number;count:number;reportRefs:VersionRef[];inventoryRefs:VersionRef[];
          inventory:Array<EvidenceReport&{processingFingerprint?:string;evidenceAdmissionFingerprint?:string}>;pageObjectId:string;
          inventorySources:Array<{domain:string;ref:VersionRef;sourceGroup?:string|null}>;
          planRefs:VersionRef[][];reusedCoverage:Reuse[];ackOnly?:boolean;quarantined?:Array<{
            buildId:string;jobId:string;runId:string;index:number;manifestHash:string;pageObjectId:string;
            reportRefs:VersionRef[];sourceGroups:string[]}>};
        const batch=targeted?undefined:(old.manifest as {batch?:Batch}).batch;
        const acknowledge=input.acknowledge??true;
        if(!targeted && accepted && processed>old.throughSequence) throw new Error('stale build boundary');
        if(accepted && batch) {
          if(!batch.ackOnly&&(input.usage as {independentReviewPassed?:boolean}|null|undefined)?.independentReviewPassed!==true)
            throw new KnowledgeError('BUILD_REVIEW_MISSING','A batch cannot cover reports without a passing independent review',409);
          const records=await db.query('SELECT payload FROM ccl_learning_builds WHERE project_id=$1 AND topic_id=$2 AND id<>$3 FOR SHARE',
            [input.projectId,old.topicId,old.id]);
          const prior=(records.rows.map(row=>row.payload as BuildRecord)).filter(row=>{
            const other=(row.manifest as typeof old.manifest & {batch?:typeof batch}).batch;
            return other?.runId===batch.runId&&(row.outcome==='changed'||row.outcome==='no_change');
          });
          const priorIndices=new Set(prior.map(row=>(row.manifest as typeof old.manifest & {batch:typeof batch}).batch.index));
          if(priorIndices.has(batch.index)||prior.some(row=>(row.manifest as typeof old.manifest & {batch:typeof batch})
            .batch.reportRefs.some(ref=>batch.reportRefs.some(current=>current.objectId===ref.objectId&&
              current.versionId===ref.versionId))))
            throw new KnowledgeError('BUILD_BATCH_ORDER','An exact report page was already accepted in this run',409);
          const reusedIds=[...new Set(batch.reusedCoverage.map(item=>item.buildId))];
          const reusedRows=reusedIds.length?(await db.query('SELECT payload FROM ccl_learning_builds WHERE project_id=$1 AND id=ANY($2::text[]) FOR SHARE',
            [input.projectId,reusedIds])).rows.map(row=>row.payload as BuildRecord):[];
          if(reusedRows.length!==reusedIds.length)throw new KnowledgeError('BUILD_COVERAGE_MISSING','Reused build record is missing',409);
          for(const item of batch.reusedCoverage) {
            const source=reusedRows.find(row=>row.id===item.buildId);
            const sourceManifest=source?.manifest as typeof old.manifest & {batch?:Batch;topic?:EvidenceTopic};
            const previous=sourceManifest?.batch;
            const recorded=previous?.inventory.find(report=>report.ref.objectId===item.ref.objectId&&report.ref.versionId===item.ref.versionId);
            const current=batch.inventory.find(report=>report.ref.objectId===item.ref.objectId&&report.ref.versionId===item.ref.versionId);
            const targetTopic=(old.manifest as {topic?:EvidenceTopic}).topic;
            const proof=item.proof?.kind==='legacy_compatible'?item.proof:null;
            const evidence=recorded&&sourceManifest.topic?evidenceAdmissionFingerprint(recorded,sourceManifest.topic,
              {legacyFrozen:true,allowStoredFingerprint:(sourceManifest as {coverageContractVersion?:string}).coverageContractVersion===COVERAGE_CONTRACT_VERSION}):null;
            const currentEvidence=current&&targetTopic?evidenceAdmissionFingerprint(current,targetTopic):null;
            const allowedMethod=!!sourceManifest?.methodVersion&&[
              'topic-synthesis-bounded-pages-v6','topic-synthesis-bounded-pages-v7',
              'topic-synthesis-evidence-catalog-v8','topic-synthesis-review-scope-v9',
              'topic-synthesis-semantic-projection-v10',
              'topic-synthesis-strict-draft-time-evidence-v11',
              'topic-synthesis-independent-page-commit-v12',
              'topic-synthesis-independent-page-commit-v13',
              'knowledge-research-agent-workflow@1'].includes(sourceManifest.methodVersion);
            if(!source||!previous?.reportRefs.some(ref=>ref.objectId===item.ref.objectId&&ref.versionId===item.ref.versionId)||
              source.manifestHash!==manifestHash(sourceManifest)||
              recorded?.processingFingerprint!==item.processingFingerprint||
              !evidence||!allowedMethod||sourceManifest.policyVersion!==old.manifest.policyVersion||
              sourceManifest.purpose!==(old.manifest as {purpose?:string}).purpose||
              sourceManifest.topic?.id!==targetTopic?.id||sourceManifest.topic?.version!==targetTopic?.version||
              sourceManifest.topic?.question!==targetTopic?.question||
              (!proof&&current?.processingFingerprint!==item.processingFingerprint)||
              (proof&&(proof.sourceBuildId!==source.id||
                proof.recordedProcessingFingerprint!==recorded?.processingFingerprint||
                proof.coverageContractVersion!==COVERAGE_CONTRACT_VERSION||
                !evidence||evidence!==currentEvidence||proof.evidenceAdmissionFingerprint!==evidence||
                (old.manifest as {coverageContractVersion?:string}).coverageContractVersion!==COVERAGE_CONTRACT_VERSION))||
              !['changed','no_change'].includes(source.outcome??'')||
              (source.usage as {independentReviewPassed?:boolean}|null)?.independentReviewPassed!==true||
              (source.outcome==='changed'&&!source.publishedRefs.some(ref=>ref.objectId===previous.pageObjectId)))
              throw new KnowledgeError('BUILD_COVERAGE_INVALID','Reused exact report was not accepted by a prior batch',409);
          }
          const covered=new Set([...prior.flatMap(row=>(row.manifest as typeof old.manifest & {batch:typeof batch}).batch.reportRefs),
            ...batch.reusedCoverage.map(item=>item.ref),...batch.reportRefs].map(ref=>ref.objectId+'/'+ref.versionId));
          const inventory=new Set(batch.inventoryRefs.map(ref=>ref.objectId+'/'+ref.versionId));
          if(acknowledge && ((batch.quarantined?.length??0)>0||covered.size!==inventory.size||
            [...inventory].some(ref=>!covered.has(ref))))
            throw new KnowledgeError('BUILD_COVERAGE_INCOMPLETE','The entire exact frozen report inventory is not covered',409);
        }
        if(!targeted && input.outcome==='changed') {
          const newer=await db.query(`SELECT payload FROM ccl_learning_builds WHERE project_id=$1 AND topic_id=$2
            AND ((through_sequence>$3 AND (payload->>'outcome' IS NULL OR payload->>'outcome' IN ('changed','no_change')))
              OR (through_sequence=$3 AND id<>$4 AND payload->>'outcome'='changed'
              AND ($5::text IS NULL OR payload->'manifest'->'batch'->>'runId' IS DISTINCT FROM $5
                OR payload->'manifest'->'batch'->>'index'=$6)))`,
            [input.projectId,old.topicId,old.throughSequence,old.id,batch?.runId??null,String(batch?.index??-1)]);
          const refKey=(ref:VersionRef)=>`${ref.objectId}/${ref.versionId}`;
          const exactGroup=(plan:Batch,ref:VersionRef):string|null=>{
            const matches=plan.inventorySources?.filter(source=>source.domain==='analysis'&&refKey(source.ref)===refKey(ref))??[];
            const group=matches.length===1?matches[0]?.sourceGroup:null;
            return typeof group==='string'&&/^media-sha256:[a-f0-9]{64}$/.test(group)?group:null;
          };
          const completePlan=(plan:Batch):boolean=>{
            if(!Array.isArray(plan.inventory)||!Array.isArray(plan.inventoryRefs)||!Array.isArray(plan.planRefs)||
              !Array.isArray(plan.reusedCoverage)||!Array.isArray(plan.reportRefs)||!Array.isArray(plan.inventorySources)||
              plan.ackOnly||!plan.reportRefs.length||plan.reportRefs.length>20||
              plan.count!==plan.planRefs.length||plan.index<0||plan.index>=plan.count||
              stableHash(plan.reportRefs)!==stableHash(plan.planRefs[plan.index]))return false;
            const inventory=new Set(plan.inventory.map(item=>refKey(item.ref)));
            const refs=plan.inventoryRefs.map(refKey),planned=plan.planRefs.flat().map(refKey);
            const quarantined=plan.quarantined??[];
            if(inventory.size!==plan.inventory.length||refs.length!==inventory.size||
              refs.some(ref=>!inventory.has(ref))||new Set(planned).size!==planned.length||
              planned.some(ref=>!inventory.has(ref))||quarantined.some(item=>
                !item.buildId||!item.jobId||!item.runId||!item.manifestHash||!item.pageObjectId||
                !Array.isArray(item.reportRefs)||!item.reportRefs.length||!Array.isArray(item.sourceGroups)||
                item.reportRefs.some(ref=>!exactGroup(plan,ref)||
                  !item.sourceGroups.includes(exactGroup(plan,ref)!))))return false;
            const unknownGroups=new Set(quarantined.flatMap(item=>item.sourceGroups));
            if(plan.reportRefs.some(ref=>quarantined.some(item=>item.reportRefs.some(other=>refKey(other)===refKey(ref)))||
              unknownGroups.has(exactGroup(plan,ref)??'')))return false;
            return [...inventory].every(ref=>planned.includes(ref)||plan.reusedCoverage.some(item=>refKey(item.ref)===ref)||
              quarantined.some(item=>item.reportRefs.some(occupied=>refKey(occupied)===ref)));
          };
          const reusablePriorPage=(prior:BuildRecord):boolean=>{
            const priorManifest=prior.manifest as typeof old.manifest&{batch?:Batch};
            const priorBatch=priorManifest.batch;
            if(!batch||!priorBatch||!['topic-synthesis-independent-page-commit-v12',
              'topic-synthesis-independent-page-commit-v13',
              'knowledge-research-agent-workflow@1'].includes(old.manifest.methodVersion)||
              !['topic-synthesis-strict-draft-time-evidence-v11','topic-synthesis-independent-page-commit-v12',
                'topic-synthesis-independent-page-commit-v13',
                'knowledge-research-agent-workflow@1'].includes(priorManifest.methodVersion)||
              prior.outcome!=='changed'||prior.throughSequence!==old.throughSequence||
              prior.manifestHash!==manifestHash(priorManifest)||!completePlan(priorBatch)||!completePlan(batch)||
              priorBatch.pageObjectId===batch.pageObjectId)return false;
            const currentGroups=batch.reportRefs.map(ref=>exactGroup(batch,ref));
            if(currentGroups.some(group=>!group))return false;
            return priorBatch.reportRefs.every(ref=>{
              const group=exactGroup(priorBatch,ref),currentGroup=exactGroup(batch,ref);
              const reused=batch.reusedCoverage.find(item=>item.buildId===prior.id&&refKey(item.ref)===refKey(ref)&&
                item.proof?.kind==='exact');
              return !!group&&group===currentGroup&&!currentGroups.includes(group)&&!!reused;
            });
          };
          if(newer.rows.some(row=>!reusablePriorPage(row.payload as BuildRecord)))
            throw new Error('newer build exists; recheck head and manifest');
          if(!(input.publishedRefs?.length)) throw new Error('changed build requires published refs');
        }
        const next:BuildRecord={...old,outcome:input.outcome,outcomeReason:input.reason,recovery:input.recovery??null,
          usage:input.usage??null,cost:input.cost??null,publishedRefs:input.publishedRefs??[],finishedAt:iso()};
        await db.query('UPDATE ccl_learning_builds SET payload=$3 WHERE project_id=$1 AND id=$2',[input.projectId,input.buildId,next]);
        if(accepted&&batch&&!batch.ackOnly) {
          const page=input.publishedRefs?.find(ref=>ref.objectId===batch.pageObjectId)??null;
          for(const ref of batch.reportRefs) {
            const report=batch.inventory.find(item=>item.ref.objectId===ref.objectId&&item.ref.versionId===ref.versionId);
            if(!report?.processingFingerprint)throw new KnowledgeError('BUILD_COVERAGE_INVALID','Accepted report lacks its frozen processing fingerprint',409);
            await db.query(`INSERT INTO ccl_learning_report_coverage(project_id,topic_id,report_object_id,report_version_id,
              processing_fingerprint,accepted_build_id,published_ref,accepted_at)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8)
              ON CONFLICT(project_id,topic_id,report_object_id,report_version_id) DO UPDATE SET
                processing_fingerprint=EXCLUDED.processing_fingerprint,accepted_build_id=EXCLUDED.accepted_build_id,
                published_ref=EXCLUDED.published_ref,accepted_at=EXCLUDED.accepted_at`,
            [input.projectId,old.topicId,ref.objectId,ref.versionId,report.processingFingerprint,old.id,page,next.finishedAt]);
          }
        }
        if(!targeted&&accepted&&acknowledge) await db.query(`UPDATE ccl_learning_dirty
          SET processed_sequence=GREATEST(processed_sequence,$3) WHERE project_id=$1 AND topic_id=$2`,
          [input.projectId,old.topicId,old.throughSequence]);
        return next;
      },client);
    },
    async createNeed(input) {
      assertSource(input.subject); assertText(input.problem,'problem'); assertText(input.expectedEvidence,'expectedEvidence');
      if(input.topicId) must(await topic(pool,input.projectId,input.topicId),'topic');
      const now=iso(); const value:ResearchNeed={...input,id:input.id??randomUUID(),status:'open',resolutionSourceRefs:[],resolutionResultRefs:[],reviewReason:null,createdAt:now,updatedAt:now};
      return transactional(pool,async db=>{
        await db.query('INSERT INTO ccl_learning_needs(project_id,id,topic_id,payload) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[input.projectId,value.id,input.topicId,value]);
        const row=await db.query('SELECT payload FROM ccl_learning_needs WHERE project_id=$1 AND id=$2',[input.projectId,value.id]);
        await db.query('INSERT INTO ccl_learning_need_history(project_id,need_id,version,payload) VALUES($1,$2,1,$3) ON CONFLICT DO NOTHING',[input.projectId,value.id,row.rows[0].payload]);
        return row.rows[0].payload;
      });
    },
    async createRequest(input) {
      assertText(input.requestKey,'requestKey'); assertText(input.expectedResult,'expectedResult'); assertText(input.authorization,'authorization');
      input.inputRefs.forEach(assertSource);
      const value:ResearchRequest={...input,id:input.id??randomUUID(),createdAt:iso()};
      return transactional(pool,async db=>{
        const need=await db.query('SELECT payload FROM ccl_learning_needs WHERE project_id=$1 AND id=$2 FOR UPDATE',[input.projectId,input.needId]);
        const old=must<ResearchNeed>(need.rows[0]?.payload,'research need');
        await db.query('INSERT INTO ccl_learning_requests(project_id,id,need_id,request_key,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(project_id,request_key) DO NOTHING',
          [input.projectId,value.id,input.needId,input.requestKey,value]);
        const row=await db.query('SELECT payload FROM ccl_learning_requests WHERE project_id=$1 AND request_key=$2',[input.projectId,input.requestKey]);
        const actual=row.rows[0].payload as ResearchRequest;
        const comparable=(request:ResearchRequest)=>({projectId:request.projectId,needId:request.needId,jobId:request.jobId,
          action:request.action,inputRefs:request.inputRefs,budget:request.budget,authorization:request.authorization,
          expectedResult:request.expectedResult,requestKey:request.requestKey});
        if(stableHash(comparable(actual))!==stableHash(comparable(value))) throw new Error('request key conflict');
        if(old.status==='open' && actual.jobId) {
          const next={...old,status:'assigned',updatedAt:iso()};
          await db.query('UPDATE ccl_learning_needs SET payload=$3 WHERE project_id=$1 AND id=$2',[input.projectId,input.needId,next]);
          await db.query('INSERT INTO ccl_learning_need_history(project_id,need_id,version,payload) SELECT $1,$2,COALESCE(MAX(version),0)+1,$3 FROM ccl_learning_need_history WHERE project_id=$1 AND need_id=$2',[input.projectId,input.needId,next]);
        }
        return actual;
      });
    },
    async resolveNeed(input) {
      assertText(input.reviewReason,'reviewReason');
      if(input.status==='resolved' && !input.sourceRefs.length && !input.resultRefs.length) throw new Error('resolution requires evidence refs');
      input.sourceRefs.forEach(assertSource);
      return transactional(pool,async db=>{
        const row=await db.query('SELECT payload FROM ccl_learning_needs WHERE project_id=$1 AND id=$2 FOR UPDATE',[input.projectId,input.needId]);
        const old=must<ResearchNeed>(row.rows[0]?.payload,'research need');
        if(old.status===input.status && old.reviewReason===input.reviewReason && stableHash(old.resolutionSourceRefs)===stableHash(input.sourceRefs) && stableHash(old.resolutionResultRefs)===stableHash(input.resultRefs)) return old;
        const next:ResearchNeed={...old,status:input.status,resolutionSourceRefs:input.sourceRefs,resolutionResultRefs:input.resultRefs,reviewReason:input.reviewReason,updatedAt:iso()};
        await db.query('UPDATE ccl_learning_needs SET payload=$3 WHERE project_id=$1 AND id=$2',[input.projectId,input.needId,next]);
        await db.query('INSERT INTO ccl_learning_need_history(project_id,need_id,version,payload) SELECT $1,$2,COALESCE(MAX(version),0)+1,$3 FROM ccl_learning_need_history WHERE project_id=$1 AND need_id=$2',[input.projectId,input.needId,next]);
        return next;
      });
    },
    async snapshot(projectId,limit=100) {
      assertText(projectId,'projectId'); const n=Math.max(1,Math.min(limit,500)),probe=n+1;
      const [topics,memberships,unassigned,needs,requests,builds,pending]=await Promise.all([
        pool.query('SELECT payload FROM ccl_learning_topics WHERE project_id=$1 ORDER BY id LIMIT $2',[projectId,probe]),
        pool.query('SELECT payload FROM ccl_learning_memberships WHERE project_id=$1 AND topic_id IS NOT NULL ORDER BY id LIMIT $2',[projectId,probe]),
        pool.query("SELECT payload FROM ccl_learning_memberships WHERE project_id=$1 AND topic_id IS NULL AND payload->>'state'='unassigned' ORDER BY id LIMIT $2",[projectId,probe]),
        pool.query('SELECT payload FROM ccl_learning_needs WHERE project_id=$1 ORDER BY id LIMIT $2',[projectId,probe]),
        pool.query('SELECT payload FROM ccl_learning_requests WHERE project_id=$1 ORDER BY id LIMIT $2',[projectId,probe]),
        pool.query('SELECT payload FROM ccl_learning_builds WHERE project_id=$1 ORDER BY through_sequence DESC,id DESC LIMIT $2',[projectId,probe]),
        pool.query(`SELECT d.topic_id,d.latest_sequence,d.processed_sequence,
          (SELECT count(DISTINCT COALESCE(
              NULLIF(src.item->>'sourceGroup',''),
              (SELECT MIN(NULLIF(m.payload->'source'->>'sourceGroup',''))
                FROM ccl_learning_memberships m
                WHERE m.project_id=d.project_id
                  AND m.source_key=(src.item->>'domain')||':'||(src.item->'ref'->>'objectId')||':'||(src.item->'ref'->>'versionId')),
              (src.item->>'domain')||':'||(src.item->'ref'->>'objectId')||':'||(src.item->'ref'->>'versionId')
            ))::int
            FROM ccl_learning_event_topics e JOIN ccl_learning_events v ON v.sequence=e.sequence
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(v.payload->'sources','[]'::jsonb)) AS src(item)
            WHERE e.project_id=d.project_id AND e.topic_id=d.topic_id AND e.sequence>d.processed_sequence) AS count,
          (SELECT MIN((v.payload->>'createdAt')::timestamptz) FROM ccl_learning_event_topics e JOIN ccl_learning_events v ON v.sequence=e.sequence
            WHERE e.project_id=d.project_id AND e.topic_id=d.topic_id AND e.sequence>d.processed_sequence) AS oldest_at
          FROM ccl_learning_dirty d WHERE d.project_id=$1 AND d.latest_sequence>d.processed_sequence ORDER BY d.latest_sequence DESC LIMIT $2`,[projectId,probe]),
      ]);
      const counts=(await pool.query(`SELECT
        (SELECT count(*) FROM ccl_learning_topics WHERE project_id=$1)::int AS topics,
        (SELECT count(*) FROM ccl_learning_memberships WHERE project_id=$1 AND topic_id IS NOT NULL)::int AS memberships,
        (SELECT count(*) FROM ccl_learning_memberships WHERE project_id=$1 AND topic_id IS NULL AND payload->>'state'='unassigned')::int AS unassigned,
        (SELECT count(*) FROM ccl_learning_needs WHERE project_id=$1)::int AS needs,
        (SELECT count(*) FROM ccl_learning_requests WHERE project_id=$1)::int AS requests,
        (SELECT count(*) FROM ccl_learning_builds WHERE project_id=$1)::int AS builds,
        (SELECT count(*) FROM ccl_learning_dirty WHERE project_id=$1 AND latest_sequence>processed_sequence)::int AS pending`,[projectId])).rows[0];
      const pageInfo=Object.fromEntries(Object.entries({topics,memberships,unassigned,needs,requests,builds,pending})
        .map(([name,result])=>{
          const visible=result.rows.slice(0,n),last=visible.at(-1);
          const nextCursor=result.rows.length>n&&last?name==='builds'?`${last.payload.throughSequence}:${last.payload.id}`:
            name==='pending'?`${last.latest_sequence}:${last.topic_id}`:last.payload.id:null;
          return [name,{total:Number(counts[name]),hasMore:result.rows.length>n,nextCursor}];
        })) as LearningSnapshot['pageInfo'];
      return {schemaVersion:'1.0',topics:topics.rows.slice(0,n).map(x=>x.payload),memberships:memberships.rows.slice(0,n).map(x=>x.payload),
        unassigned:unassigned.rows.slice(0,n).map(x=>x.payload),needs:needs.rows.slice(0,n).map(x=>x.payload),requests:requests.rows.slice(0,n).map(x=>x.payload),
        builds:builds.rows.slice(0,n).map(x=>x.payload),pending:pending.rows.slice(0,n).map(x=>({topicId:x.topic_id,latestSequence:Number(x.latest_sequence),processedSequence:Number(x.processed_sequence),count:Number(x.count),oldestAt:x.oldest_at?.toISOString()??null})),
        pageInfo} as LearningSnapshot;
    },
  };
  return store;
}
