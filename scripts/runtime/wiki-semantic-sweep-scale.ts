/** Bounded synthetic metadata scale probe for the actual semantic-sweep head query. */
import {randomUUID,createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {readTestDatabase} from './test-database.mjs';
import {seedKnowledgeSyntheticFixture} from './knowledge-synthetic-fixture.ts';
import {assertKnowledgeWriterAuthority} from '../../packages/knowledge/src/writer-authority.ts';
import {migrateMaintenanceTasks} from '../../packages/adapters/knowledge-service/src/maintenance-tasks.ts';
import {migrateSemanticSweeps,createPgSemanticSweep} from '../../packages/adapters/knowledge-service/src/semantic-sweep.ts';

const TARGETS=[10_000,100_000] as const;
const PAGES=5,EXPLAIN_POINTS=['first','middle','late'] as const;
const CHUNK=5_000,WORK_CUTOFF_MS=200_000,STATEMENT_TIMEOUT_MS=30_000;
const defaultOutput=resolve(fileURLToPath(new URL('../../docs/knowledge/evidence/wiki-semantic-sweep-scale-before-20261102.json',import.meta.url)));
const indexOutput=resolve(fileURLToPath(new URL('../../docs/knowledge/evidence/wiki-semantic-sweep-scale-index-20261102.json',import.meta.url)));
const orderedOutput=resolve(fileURLToPath(new URL('../../docs/knowledge/evidence/wiki-semantic-sweep-scale-ordered-revision-20261102.json',import.meta.url)));
const finalOutput=resolve(fileURLToPath(new URL('../../docs/knowledge/evidence/wiki-semantic-sweep-scale-final-20261102.json',import.meta.url)));
const ms=(value:number)=>Math.round(value*100)/100;
const percentile=(numbers:number[],p:number)=>numbers.length?ms([...numbers].sort((a,b)=>a-b)[Math.ceil(numbers.length*p)-1]):null;
const errorOf=(error:unknown)=>({code:typeof error==='object'&&error&&'code'in error?String(error.code):'UNKNOWN',
  message:error instanceof Error?error.message.slice(0,500):String(error).slice(0,500)});
const historicalIndexConflict=(error:unknown)=>typeof error==='object'&&error!==null&&
  'message'in error&&String(error.message).startsWith('HISTORICAL_MODE_HAS_PRODUCTION_REVISION_INDEX');
const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid=`format('%s-%s-5%s-8%s-%s',substr(hash,1,8),substr(hash,9,4),substr(hash,14,3),substr(hash,18,3),substr(hash,21,12))`;
type HeadCapture={sql:string;params:unknown[];latencyMs:number;returned:number};
type Attempt={status:'ok'|'error'|'not_run_budget';elapsedMs:number|null;error?:ReturnType<typeof errorOf>};
type Point={position:string;status:'ok'|'error'|'not_run_budget';cursor:string|null;params:unknown[]|null;
  orderedRefs?:Array<{object_id:string;version_id:string}>;orderedRefsDigest?:string;
  executionMs?:number;planningMs?:number;plan?:unknown;revisionIndexUsed?:boolean;
  revisionIndexRows?:ReturnType<typeof indexNode>;error?:ReturnType<typeof errorOf>};
type Scale={target:number;actualHeads:number|null;seedMs:number|null;seedStatus:Attempt['status'];
  pages:Attempt[];headSqlMs:number[];headSelectSql:string|null;headSelectParams:unknown[]|null;
  points:Point[];pageP95Ms:number|null;headSqlP95Ms:number|null;taskCount:number|null;
  scanned:number|null;complete:boolean|null;limitReached:boolean|null;error?:ReturnType<typeof errorOf>};

/** Keep a single client per seed chunk. All write guards and temp rows stay in its transaction. */
async function addNeutral(pool:pg.Pool,projectId:string,template:unknown,first:number,last:number,grant:Parameters<typeof assertKnowledgeWriterAuthority>[2]){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');await assertKnowledgeWriterAuthority(client,projectId,grant);
    await client.query(`CREATE TEMP TABLE semantic_scale_batch ON COMMIT DROP AS
      WITH numbered AS (SELECT n,md5('semantic-scale-object-'||n) AS object_hash,
        md5('semantic-scale-version-'||n) AS version_hash FROM generate_series($1::int,$2::int) AS n),
      identified AS (SELECT n,${uuid.replaceAll('hash','object_hash')} AS object_id,
        ${uuid.replaceAll('hash','version_hash')} AS version_id FROM numbered)
      SELECT object_id,version_id,'合成占位条目'||n AS title,'合成占位正文'||n AS body,
        $3::jsonb || jsonb_build_object('ref',jsonb_build_object('objectId',object_id,'versionId',version_id),
          'title','合成占位条目'||n,'body','合成占位正文'||n,
          'content',($3::jsonb->'content') || jsonb_build_object('identity',
            jsonb_build_object('key','synthetic-scale-'||n,'aliases','[]'::jsonb))) AS payload
      FROM identified`,[first,last,template]);
    await client.query(`INSERT INTO ccl_knowledge_changesets(project_id,id,request_key,request_hash,content_hash,payload)
      SELECT $1,object_id,'semantic-scale:'||object_id,object_id,version_id,'{"changes":[]}'::jsonb
      FROM semantic_scale_batch`,[projectId]);
    await client.query(`INSERT INTO ccl_knowledge_revisions
      (project_id,object_id,version_id,changeset_id,kind,title,body,payload,published_at)
      SELECT $1,object_id,version_id,object_id,'wiki_page',title,body,payload,
        '2026-11-02T00:00:00Z'::timestamptz FROM semantic_scale_batch`,[projectId]);
    // Synthetic admission-shaped rows exist solely to time task enqueue. No reviewer examined these copies.
    await client.query(`INSERT INTO ccl_knowledge_reviews
      (project_id,id,changeset_id,content_hash,payload)
      SELECT $1,version_id,object_id,version_id,
        '{"purpose":"exploration_reading","decision":"exploration_only"}'::jsonb
      FROM semantic_scale_batch`,[projectId]);
    await client.query(`INSERT INTO ccl_knowledge_publications
      (project_id,changeset_id,review_id,payload)
      SELECT $1,object_id,version_id,'{}'::jsonb FROM semantic_scale_batch`,[projectId]);
    await client.query(`INSERT INTO ccl_knowledge_heads(project_id,object_id,version_id)
      SELECT $1,object_id,version_id FROM semantic_scale_batch`,[projectId]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}

function capturePool(pool:pg.Pool,captures:HeadCapture[],rewrite?:(sql:string)=>string):pg.Pool{
  return {connect:async()=>{
    const client=await pool.connect();
    return new Proxy(client,{get(target,property){
      if(property==='release')return target.release.bind(target);
      if(property!=='query')return Reflect.get(target,property);
      return async(...args:unknown[])=>{
        const original=String(args[0]),head=original.includes('SELECT h.object_id,h.version_id')&&original.includes('AS review_admitted');
        const sql=head&&rewrite?rewrite(original):original;
        const started=performance.now(),result=await Reflect.apply(target.query,target,[sql,...args.slice(1)]);
        if(head)captures.push({sql,params:[...(args[1] as unknown[])],latencyMs:ms(performance.now()-started),
          returned:result.rows.length});
        return result;
      };
    }});
  },query:pool.query.bind(pool)} as unknown as pg.Pool;
}

async function cursorAt(pool:pg.Pool,projectId:string,offset:number){
  return (await pool.query<{object_id:string}>(`SELECT object_id FROM ccl_knowledge_heads
    WHERE project_id=$1 ORDER BY object_id::uuid OFFSET $2 LIMIT 1`,[projectId,offset])).rows[0]?.object_id??null;
}

const productionRevisionIndex='ccl_knowledge_revisions_project_scope_uuid_idx';
async function assertRevisionIndexState(pool:pg.Pool,expected:'present'|'absent'){
  const present=(await pool.query<{present:boolean}>(
    'SELECT to_regclass($1) IS NOT NULL AS present',[productionRevisionIndex])).rows[0].present;
  if(present!==(expected==='present'))throw new Error(expected==='present'?
    'FINAL_MODE_REQUIRES_PRODUCTION_REVISION_INDEX':
    'HISTORICAL_MODE_HAS_PRODUCTION_REVISION_INDEX: baseline would be mislabeled; use --final');
}

export async function runSemanticSweepScale(output=defaultOutput,mode:'before'|'final'='before'){
  if(process.env.TEST_DATABASE_REQUIRED!=='1')throw new Error('TEST_DATABASE_REQUIRED=1 is required');
  const url=readTestDatabase(process.env,{required:true})!,started=performance.now();
  const budget=()=>{if(performance.now()-started>WORK_CUTOFF_MS)throw new Error('WORK_BUDGET_EXHAUSTED');};
  const schema=`semantic_scale_${randomUUID().replaceAll('-','')}`;
  const report:{[key:string]:unknown}={label:mode==='final'?
    'Synthetic 10k/100k final production semantic-sweep port and migration index; limited pages, not full sweep or semantic acceptance':
    'Synthetic semantic-sweep metadata SQL scale before index change; not semantic, review, or production acceptance',
    mode,sqlRewrite:false,revisionIndex:mode==='final'?productionRevisionIndex:null,
    generatedAt:new Date().toISOString(),targets:[...TARGETS],pagesPlannedPerTarget:PAGES,
    explainPositions:[...EXPLAIN_POINTS],workCutoffMs:WORK_CUTOFF_MS,statementTimeoutMs:STATEMENT_TIMEOUT_MS,
    seedAssurance:'32 canonical synthetic fixture Wiki plus short SQL-generated neutral current heads. Their copied binding fingerprints and SQL admission-shaped review/publication rows are not formal independent review or canonical revisions.',
    modelCalls:0,queries:[],schemaCleanup:'pending'};
  const results:Scale[]=TARGETS.map(target=>({target,actualHeads:null,seedMs:null,seedStatus:'not_run_budget',
    pages:Array.from({length:PAGES},()=>({status:'not_run_budget',elapsedMs:null})),headSqlMs:[],
    headSelectSql:null,headSelectParams:null,
    points:EXPLAIN_POINTS.map(position=>({position,status:'not_run_budget',cursor:null,params:null})),
    pageP95Ms:null,headSqlP95Ms:null,taskCount:null,scanned:null,complete:null,limitReached:null}));
  report.queries=results;
  const admin=new pg.Pool({connectionString:url,max:1,connectionTimeoutMillis:5_000,
    options:`-c statement_timeout=${STATEMENT_TIMEOUT_MS} -c lock_timeout=5000`});
  let pool:pg.Pool|undefined,created=false;
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`);created=true;
    pool=new pg.Pool({connectionString:url,max:4,connectionTimeoutMillis:5_000,
      options:`-c search_path=${schema} -c statement_timeout=${STATEMENT_TIMEOUT_MS} -c lock_timeout=5000`});
    const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-${schema}`,'semantic-scale');
    await assertRevisionIndexState(pool,mode==='final'?'present':'absent');
    await migrateMaintenanceTasks(pool);await migrateSemanticSweeps(pool);
    const projectId=seed.projectId,context={scope:{projectId,spaceId:seed.spaceId},
      principal:seed.principal,purpose:'exploration_reading'};
    const template=(await pool.query<{payload:unknown}>(`SELECT payload FROM ccl_knowledge_revisions
      WHERE project_id=$1 AND object_id=$2 AND version_id=$3`,
      [projectId,seed.root.objectId,seed.root.versionId])).rows[0].payload;
    let current=32;
    for(const row of results){
      try{
        budget();const seedStart=performance.now();
        for(let first=current-31;first<=row.target-32;first+=CHUNK){
          budget();await addNeutral(pool,projectId,template,first,Math.min(first+CHUNK-1,row.target-32),seed.writerGrant);
        }
        row.seedMs=ms(performance.now()-seedStart);row.seedStatus='ok';current=row.target;
        row.actualHeads=Number((await pool.query<{n:number}>(
          'SELECT count(*)::int n FROM ccl_knowledge_heads WHERE project_id=$1',[projectId])).rows[0].n);
        if(row.actualHeads!==row.target)throw new Error(`Expected ${row.target} heads, saw ${row.actualHeads}`);
        budget();await pool.query('ANALYZE ccl_knowledge_heads,ccl_knowledge_revisions,ccl_knowledge_reviews,ccl_knowledge_publications');
        const captures:HeadCapture[]=[],sweep=createPgSemanticSweep(capturePool(pool,captures),seed.writerGrant);
        const request={cycleKey:`scale-${row.target}`,shard:0,shardCount:1,limit:10,maxTasksPerShard:200,
          methodVersion:'synthetic-scale/1',rubricVersion:'synthetic-scale/1'};
        for(let page=0;page<PAGES;page++){
          try{budget();const pageStart=performance.now();
            const pass=await sweep.runPass(context,request);
            row.pages[page]={status:'ok',elapsedMs:ms(performance.now()-pageStart)};
            row.taskCount=pass.taskCount;row.scanned=pass.scanned;row.complete=pass.complete;
            row.limitReached=pass.limitReached;
            if(pass.complete||pass.limitReached)break;
          }catch(error){row.pages[page]={status:errorOf(error).message==='WORK_BUDGET_EXHAUSTED'?'not_run_budget':'error',
            elapsedMs:null,error:errorOf(error)};break;}
        }
        row.headSqlMs=captures.map(item=>item.latencyMs);
        row.headSelectSql=captures[0]?.sql??null;row.headSelectParams=captures[0]?.params??null;
        if(mode==='final'&&((captures[0]?.sql.match(/r\.object_id::uuid/g)??[]).length!==3||
          captures[0]?.sql.includes('h.object_id::uuid')))
          throw new Error('FINAL_SWEEP_SQL_SHAPE_CHANGED: expected revision UUID cursor, shard, and order');
        row.pageP95Ms=percentile(row.pages.filter(item=>item.status==='ok').map(item=>item.elapsedMs!),0.95);
        row.headSqlP95Ms=percentile(row.headSqlMs,0.95);
        if(!captures.length)continue;
        for(const point of row.points){
          try{budget();const offset=point.position==='first'?0:point.position==='middle'?
            Math.floor(row.target/2):Math.floor(row.target*0.95);
            point.cursor=point.position==='first'?null:await cursorAt(pool,projectId,offset);
            point.params=[...captures[0].params];point.params[2]=point.cursor;
            const refs=(await pool.query<{object_id:string;version_id:string}>(captures[0].sql,point.params)).rows
              .map(({object_id,version_id})=>({object_id,version_id}));
            point.orderedRefs=refs;point.orderedRefsDigest=sha(refs);
            const explained=(await pool.query<{['QUERY PLAN']:Array<{Plan:unknown;'Planning Time':number;'Execution Time':number}>}>(
              `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${captures[0].sql}`,point.params)).rows[0]['QUERY PLAN'][0];
            point.executionMs=ms(explained['Execution Time']);point.planningMs=ms(explained['Planning Time']);
            point.plan=explained.Plan;point.status='ok';
            if(mode==='final'){
              point.revisionIndexUsed=usesIndex(point.plan,productionRevisionIndex);
              point.revisionIndexRows=indexNode(point.plan,productionRevisionIndex);
            }
          }catch(error){point.status=errorOf(error).message==='WORK_BUDGET_EXHAUSTED'?'not_run_budget':'error';
            point.error=errorOf(error);break;}
        }
      }catch(error){row.error=errorOf(error);if(errorOf(error).message==='WORK_BUDGET_EXHAUSTED')break;}
    }
  }catch(error){report.setupError=errorOf(error);}
  finally{
    if(pool)await pool.end().catch(error=>{report.poolCloseError=errorOf(error);});
    if(created){try{await admin.query(`DROP SCHEMA "${schema}" CASCADE`);report.schemaCleanup='dropped';}
      catch(error){report.schemaCleanup='failed';report.cleanupError=errorOf(error);}}
    await admin.end().catch(error=>{report.adminCloseError=errorOf(error);});
    report.elapsedMs=ms(performance.now()-started);
    report.counts={plannedTargets:results.length,seededTargets:results.filter(row=>row.seedStatus==='ok').length,
      plannedPages:results.length*PAGES,runPages:results.flatMap(row=>row.pages).filter(item=>item.status==='ok').length,
      notRunPages:results.flatMap(row=>row.pages).filter(item=>item.status==='not_run_budget').length,
      failedPages:results.flatMap(row=>row.pages).filter(item=>item.status==='error').length,
      plannedExplains:results.length*EXPLAIN_POINTS.length,
      runExplains:results.flatMap(row=>row.points).filter(item=>item.status==='ok').length,
      notRunExplains:results.flatMap(row=>row.points).filter(item=>item.status==='not_run_budget').length,
      failedExplains:results.flatMap(row=>row.points).filter(item=>item.status==='error').length};
    if(!historicalIndexConflict(report.setupError))
      await writeFile(output,`${JSON.stringify(report,null,2)}\n`,'utf8');
  }
  return report;
}

export const runSemanticSweepFinal=(output=finalOutput)=>runSemanticSweepScale(output,'final');

type DiagnosticPhase={name:string;status:'ok'|'error'|'not_run_budget';sql:string|null;params:unknown[]|null;
  pages:Attempt[];headSqlMs:number[];pageP95Ms:number|null;headSqlP95Ms:number|null;
  taskCount:number|null;scanned:number|null;complete:boolean|null;points:Point[];error?:ReturnType<typeof errorOf>};
const usesIndex=(node:unknown,name:string):boolean=>{
  if(!node||typeof node!=='object')return false;
  const value=node as {'Index Name'?:string;Plans?:unknown[]};
  return value['Index Name']===name||!!value.Plans?.some(child=>usesIndex(child,name));
};

async function sampleDiagnostic(pool:pg.Pool,context:{scope:{projectId:string;spaceId:string};principal:{id:string;clientInstallationId:string;projectId:string;spaceIds:readonly string[];purposes:readonly string[]};purpose:string},
  grant:Parameters<typeof createPgSemanticSweep>[1],name:string,check:()=>void):Promise<DiagnosticPhase>{
  const phase:DiagnosticPhase={name,status:'not_run_budget',sql:null,params:null,
    pages:Array.from({length:PAGES},()=>({status:'not_run_budget',elapsedMs:null})),headSqlMs:[],
    pageP95Ms:null,headSqlP95Ms:null,taskCount:null,scanned:null,complete:null,
    points:EXPLAIN_POINTS.map(position=>({position,status:'not_run_budget',cursor:null,params:null}))};
  const captures:HeadCapture[]=[],sweep=createPgSemanticSweep(capturePool(pool,captures),grant);
  const request={cycleKey:`index-diagnostic-${name}`,shard:0,shardCount:1,limit:10,
    maxTasksPerShard:200,methodVersion:'synthetic-index-diagnostic/1',rubricVersion:'synthetic-index-diagnostic/1'};
  try{
    for(let page=0;page<PAGES;page++){
      check();const started=performance.now();const pass=await sweep.runPass(context,request);
      phase.pages[page]={status:'ok',elapsedMs:ms(performance.now()-started)};
      phase.taskCount=pass.taskCount;phase.scanned=pass.scanned;phase.complete=pass.complete;
      if(pass.complete||pass.limitReached)break;
    }
    phase.sql=captures[0]?.sql??null;phase.params=captures[0]?.params??null;
    phase.headSqlMs=captures.map(item=>item.latencyMs);
    phase.pageP95Ms=percentile(phase.pages.filter(item=>item.status==='ok').map(item=>item.elapsedMs!),0.95);
    phase.headSqlP95Ms=percentile(phase.headSqlMs,0.95);
    if(!phase.sql||!phase.params)throw new Error('SWEEP_HEAD_QUERY_NOT_CAPTURED');
    for(const point of phase.points){
      check();const offset=point.position==='first'?0:point.position==='middle'?50_000:95_000;
      point.cursor=point.position==='first'?null:await cursorAt(pool,context.scope.projectId,offset);
      point.params=[...phase.params];point.params[2]=point.cursor;
      const refs=(await pool.query<{object_id:string;version_id:string}>(phase.sql,point.params)).rows
        .map(({object_id,version_id})=>({object_id,version_id}));
      point.orderedRefs=refs;point.orderedRefsDigest=sha(refs);
      const explained=(await pool.query<{['QUERY PLAN']:Array<{Plan:unknown;'Planning Time':number;'Execution Time':number}>}>(
        `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${phase.sql}`,point.params)).rows[0]['QUERY PLAN'][0];
      point.executionMs=ms(explained['Execution Time']);point.planningMs=ms(explained['Planning Time']);
      point.plan=explained.Plan;point.status='ok';
    }
    phase.status='ok';
  }catch(error){phase.status=errorOf(error).message==='WORK_BUDGET_EXHAUSTED'?'not_run_budget':'error';
    phase.error=errorOf(error);}
  return phase;
}

/** Paired actual-SQL diagnostic. It never changes the production migration or search policy. */
export async function runSemanticSweepIndexDiagnostic(output=indexOutput){
  if(process.env.TEST_DATABASE_REQUIRED!=='1')throw new Error('TEST_DATABASE_REQUIRED=1 is required');
  const url=readTestDatabase(process.env,{required:true})!,started=performance.now();
  const check=()=>{if(performance.now()-started>WORK_CUTOFF_MS)throw new Error('WORK_BUDGET_EXHAUSTED');};
  const schema=`semantic_idx_${randomUUID().replaceAll('-','')}`;
  const report:{[key:string]:unknown}={label:'Same synthetic 100k current heads, paired actual semantic-sweep SQL before/after up to two diagnostic indexes',
    generatedAt:new Date().toISOString(),targetHeads:100_000,pagesPlannedPerPhase:PAGES,
    explainPositions:[...EXPLAIN_POINTS],statementTimeoutMs:STATEMENT_TIMEOUT_MS,
    workCutoffMs:WORK_CUTOFF_MS,modelCalls:0,
    seedAssurance:'32 canonical synthetic Wiki plus SQL-generated neutral short-body copies. Their SQL admission-shaped rows are not independent review or semantic acceptance.',
    phases:[],indexes:[],pairedChecks:[],schemaCleanup:'pending'};
  const phases:DiagnosticPhase[]=[],indexes:Array<{name:string;sql:string;createdMs:number|null;bytes:number|null;status:string;error?:ReturnType<typeof errorOf>}> = [];
  report.phases=phases;report.indexes=indexes;
  const admin=new pg.Pool({connectionString:url,max:1,connectionTimeoutMillis:5_000,
    options:`-c statement_timeout=${STATEMENT_TIMEOUT_MS} -c lock_timeout=5000`});
  let pool:pg.Pool|undefined,created=false;
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`);created=true;
    pool=new pg.Pool({connectionString:url,max:4,connectionTimeoutMillis:5_000,
      options:`-c search_path=${schema} -c statement_timeout=${STATEMENT_TIMEOUT_MS} -c lock_timeout=5000`});
    const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-${schema}`,'semantic-scale');
    await assertRevisionIndexState(pool,'absent');
    await migrateMaintenanceTasks(pool);await migrateSemanticSweeps(pool);
    const context={scope:{projectId:seed.projectId,spaceId:seed.spaceId},principal:seed.principal,purpose:'exploration_reading'};
    const template=(await pool.query<{payload:unknown}>(`SELECT payload FROM ccl_knowledge_revisions
      WHERE project_id=$1 AND object_id=$2 AND version_id=$3`,
      [seed.projectId,seed.root.objectId,seed.root.versionId])).rows[0].payload;
    const seedStarted=performance.now();
    for(let first=1;first<=99_968;first+=CHUNK){
      check();await addNeutral(pool,seed.projectId,template,first,Math.min(first+CHUNK-1,99_968),seed.writerGrant);
    }
    report.seedMs=ms(performance.now()-seedStarted);
    report.actualHeads=Number((await pool.query<{n:number}>(
      'SELECT count(*)::int n FROM ccl_knowledge_heads WHERE project_id=$1',[seed.projectId])).rows[0].n);
    if(report.actualHeads!==100_000)throw new Error('SYNTHETIC_HEAD_COUNT_MISMATCH');
    check();await pool.query('ANALYZE ccl_knowledge_heads,ccl_knowledge_revisions,ccl_knowledge_reviews,ccl_knowledge_publications');
    phases.push(await sampleDiagnostic(pool,context,seed.writerGrant,'before',check));
    const candidates=[{name:'ccl_knowledge_heads_project_uuid_idx',
      sql:'CREATE INDEX ccl_knowledge_heads_project_uuid_idx ON ccl_knowledge_heads(project_id,(object_id::uuid))'},
    {name:'ccl_knowledge_revisions_project_scope_idx',
      sql:`CREATE INDEX ccl_knowledge_revisions_project_scope_idx ON ccl_knowledge_revisions
        (project_id, ((payload->'binding'->>'spaceId')))
        WHERE kind='wiki_page' AND published_at IS NOT NULL`}];
    for(const [ordinal,candidate] of candidates.entries()){
      if(ordinal===1&&usesIndex(phases.at(-1)?.points[0]?.plan,candidates[0].name))break;
      const record={name:candidate.name,sql:candidate.sql,createdMs:null as number|null,
        bytes:null as number|null,status:'not_run_budget',error:undefined as ReturnType<typeof errorOf>|undefined};
      indexes.push(record);
      try{
        check();const begin=performance.now();await pool.query(candidate.sql);record.createdMs=ms(performance.now()-begin);
        record.bytes=Number((await pool.query<{size:string}>('SELECT pg_relation_size($1::regclass)::text AS size',[candidate.name])).rows[0].size);
        await pool.query('ANALYZE ccl_knowledge_heads,ccl_knowledge_revisions');record.status='ok';
        phases.push(await sampleDiagnostic(pool,context,seed.writerGrant,`after-${ordinal+1}`,check));
      }catch(error){record.status=errorOf(error).message==='WORK_BUDGET_EXHAUSTED'?'not_run_budget':'error';
        record.error=errorOf(error);break;}
    }
    const before=phases[0];
    report.pairedChecks=phases.slice(1).map(phase=>({phase:phase.name,
      sameSql:phase.sql===before.sql,
      sameFirstParams:JSON.stringify(phase.params)===JSON.stringify(before.params),
      positions:EXPLAIN_POINTS.map((position,index)=>({position,
        sameCursor:phase.points[index].cursor===before.points[index].cursor,
        orderedRefsEqual:JSON.stringify(phase.points[index].orderedRefs)===JSON.stringify(before.points[index].orderedRefs),
        beforeDigest:before.points[index].orderedRefsDigest,afterDigest:phase.points[index].orderedRefsDigest})),
      firstUsesHeadIndex:usesIndex(phase.points[0]?.plan,candidates[0].name)}));
    if((report.pairedChecks as Array<{sameSql:boolean;sameFirstParams:boolean;positions:Array<{sameCursor:boolean;orderedRefsEqual:boolean}>}>).some(
      item=>!item.sameSql||!item.sameFirstParams||item.positions.some(point=>!point.sameCursor||!point.orderedRefsEqual)))
      report.parityError='ACTUAL_SQL_ORDERED_REFS_DIFFER';
  }catch(error){report.setupError=errorOf(error);}
  finally{
    if(pool)await pool.end().catch(error=>{report.poolCloseError=errorOf(error);});
    if(created){try{await admin.query(`DROP SCHEMA "${schema}" CASCADE`);report.schemaCleanup='dropped';}
      catch(error){report.schemaCleanup='failed';report.cleanupError=errorOf(error);}}
    await admin.end().catch(error=>{report.adminCloseError=errorOf(error);});
    report.elapsedMs=ms(performance.now()-started);
    report.counts={plannedPhases:3,runPhases:phases.filter(phase=>phase.status==='ok').length,
      notRunPhases:3-phases.length+phases.filter(phase=>phase.status==='not_run_budget').length,
      plannedPages:3*PAGES,runPages:phases.flatMap(phase=>phase.pages).filter(item=>item.status==='ok').length,
      notRunPages:3*PAGES-phases.flatMap(phase=>phase.pages).filter(item=>item.status==='ok').length,
      plannedExplains:3*EXPLAIN_POINTS.length,
      runExplains:phases.flatMap(phase=>phase.points).filter(item=>item.status==='ok').length,
      notRunExplains:3*EXPLAIN_POINTS.length-
        phases.flatMap(phase=>phase.points).filter(item=>item.status==='ok').length};
    if(!historicalIndexConflict(report.setupError))
      await writeFile(output,`${JSON.stringify(report,null,2)}\n`,'utf8');
  }
  return report;
}

type OrderedPhase={name:string;shardCount:number;shard:number;status:'ok'|'error'|'not_run_budget';
  sql:string|null;params:unknown[]|null;pages:Attempt[];headSqlMs:number[];
  pageP95Ms:number|null;headSqlP95Ms:number|null;taskCount:number|null;scanned:number|null;
  complete:boolean|null;points:Point[];error?:ReturnType<typeof errorOf>};
const orderedRevisionIndex='ccl_knowledge_revisions_project_scope_uuid_idx';
const orderedRevisionSql=(sql:string)=>{
  if((sql.match(/h\.object_id::uuid/g)??[]).length!==3)
    throw new Error('SWEEP_SQL_SHAPE_CHANGED: expected exactly three head UUID expressions');
  return sql.replaceAll('h.object_id::uuid','r.object_id::uuid');
};
const indexNode=(node:unknown,name:string):{rows:number;loops:number;removedByFilter:number;examinedApprox:number}|null=>{
  if(!node||typeof node!=='object')return null;
  const value=node as {'Index Name'?:string;'Actual Rows'?:number;'Actual Loops'?:number;
    'Rows Removed by Filter'?:number;Plans?:unknown[]};
  if(value['Index Name']===name){const rows=value['Actual Rows']??0,loops=value['Actual Loops']??0,
    removedByFilter=value['Rows Removed by Filter']??0;
    return {rows,loops,removedByFilter,examinedApprox:(rows+removedByFilter)*loops};}
  for(const child of value.Plans??[]){const found=indexNode(child,name);if(found)return found;}
  return null;
};

async function sampleOrdered(pool:pg.Pool,context:{scope:{projectId:string;spaceId:string};principal:{id:string;clientInstallationId:string;projectId:string;spaceIds:readonly string[];purposes:readonly string[]};purpose:string},
  grant:Parameters<typeof createPgSemanticSweep>[1],name:string,shardCount:number,shard:number,
  rewrite:((sql:string)=>string)|undefined,check:()=>void):Promise<OrderedPhase>{
  const phase:OrderedPhase={name,shardCount,shard,status:'not_run_budget',sql:null,params:null,
    pages:Array.from({length:10},()=>({status:'not_run_budget',elapsedMs:null})),headSqlMs:[],
    pageP95Ms:null,headSqlP95Ms:null,taskCount:null,scanned:null,complete:null,
    points:EXPLAIN_POINTS.map(position=>({position,status:'not_run_budget',cursor:null,params:null}))};
  const captures:HeadCapture[]=[],sweep=createPgSemanticSweep(capturePool(pool,captures,rewrite),grant);
  const request={cycleKey:`ordered-revision-${name}-${shardCount}-${shard}`,shardCount,shard,limit:10,
    maxTasksPerShard:200,methodVersion:'synthetic-ordered-probe/1',rubricVersion:'synthetic-ordered-probe/1'};
  try{
    for(let page=0;page<phase.pages.length;page++){
      check();const started=performance.now(),pass=await sweep.runPass(context,request);
      phase.pages[page]={status:'ok',elapsedMs:ms(performance.now()-started)};
      phase.taskCount=pass.taskCount;phase.scanned=pass.scanned;phase.complete=pass.complete;
      if(pass.complete||pass.limitReached)break;
    }
    phase.sql=captures[0]?.sql??null;phase.params=captures[0]?.params??null;
    phase.headSqlMs=captures.map(item=>item.latencyMs);
    phase.pageP95Ms=percentile(phase.pages.filter(item=>item.status==='ok').map(item=>item.elapsedMs!),0.95);
    phase.headSqlP95Ms=percentile(phase.headSqlMs,0.95);
    if(!phase.sql||!phase.params)throw new Error('SWEEP_HEAD_QUERY_NOT_CAPTURED');
    for(const point of phase.points){
      check();const offset=point.position==='first'?0:point.position==='middle'?50_000:95_000;
      point.cursor=point.position==='first'?null:await cursorAt(pool,context.scope.projectId,offset);
      point.params=[...phase.params];point.params[2]=point.cursor;
      const refs=(await pool.query<{object_id:string;version_id:string}>(phase.sql,point.params)).rows
        .map(({object_id,version_id})=>({object_id,version_id}));
      point.orderedRefs=refs;point.orderedRefsDigest=sha(refs);
      const explained=(await pool.query<{['QUERY PLAN']:Array<{Plan:unknown;'Planning Time':number;'Execution Time':number}>}>(
        `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${phase.sql}`,point.params)).rows[0]['QUERY PLAN'][0];
      point.executionMs=ms(explained['Execution Time']);point.planningMs=ms(explained['Planning Time']);
      point.plan=explained.Plan;point.status='ok';
    }
    phase.status='ok';
  }catch(error){phase.status=errorOf(error).message==='WORK_BUDGET_EXHAUSTED'?'not_run_budget':'error';
    phase.error=errorOf(error);}
  return phase;
}

/** One fresh synthetic schema: original SQL versus revision-keyset SQL plus exactly one partial index. */
export async function runOrderedRevisionProbe(output=orderedOutput){
  if(process.env.TEST_DATABASE_REQUIRED!=='1')throw new Error('TEST_DATABASE_REQUIRED=1 is required');
  const url=readTestDatabase(process.env,{required:true})!,started=performance.now();
  const check=()=>{if(performance.now()-started>WORK_CUTOFF_MS)throw new Error('WORK_BUDGET_EXHAUSTED');};
  const schema=`semantic_ordered_${randomUUID().replaceAll('-','')}`;
  const report:{[key:string]:unknown}={label:'Same-schema synthetic 100k exact semantic-sweep SQL: original head key order versus revision key order with one partial index',
    generatedAt:new Date().toISOString(),targetHeads:100_000,pagesPlannedPerPhase:10,
    shardCases:[{shardCount:1,shard:0},{shardCount:16,shard:3}],explainPositions:[...EXPLAIN_POINTS],
    workCutoffMs:WORK_CUTOFF_MS,statementTimeoutMs:STATEMENT_TIMEOUT_MS,modelCalls:0,
    seedAssurance:'32 canonical synthetic Wiki plus SQL-generated short neutral heads; copied fingerprints and SQL review rows do not establish formal review or semantic quality.',
    phases:[],comparisons:[],index:null,schemaCleanup:'pending'};
  const phases:OrderedPhase[]=[];report.phases=phases;
  const admin=new pg.Pool({connectionString:url,max:1,connectionTimeoutMillis:5_000,
    options:`-c statement_timeout=${STATEMENT_TIMEOUT_MS} -c lock_timeout=5000`});
  let pool:pg.Pool|undefined,created=false;
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`);created=true;
    pool=new pg.Pool({connectionString:url,max:4,connectionTimeoutMillis:5_000,
      options:`-c search_path=${schema} -c statement_timeout=${STATEMENT_TIMEOUT_MS} -c lock_timeout=5000`});
    const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-${schema}`,'semantic-scale');
    await assertRevisionIndexState(pool,'absent');
    await migrateMaintenanceTasks(pool);await migrateSemanticSweeps(pool);
    const context={scope:{projectId:seed.projectId,spaceId:seed.spaceId},principal:seed.principal,purpose:'exploration_reading'};
    const template=(await pool.query<{payload:unknown}>(`SELECT payload FROM ccl_knowledge_revisions
      WHERE project_id=$1 AND object_id=$2 AND version_id=$3`,
      [seed.projectId,seed.root.objectId,seed.root.versionId])).rows[0].payload;
    const seedStarted=performance.now();
    for(let first=1;first<=99_968;first+=CHUNK){
      check();await addNeutral(pool,seed.projectId,template,first,Math.min(first+CHUNK-1,99_968),seed.writerGrant);
    }
    report.seedMs=ms(performance.now()-seedStarted);
    report.actualHeads=Number((await pool.query<{n:number}>(
      'SELECT count(*)::int n FROM ccl_knowledge_heads WHERE project_id=$1',[seed.projectId])).rows[0].n);
    if(report.actualHeads!==100_000)throw new Error('SYNTHETIC_HEAD_COUNT_MISMATCH');
    check();await pool.query('ANALYZE ccl_knowledge_heads,ccl_knowledge_revisions,ccl_knowledge_reviews,ccl_knowledge_publications');
    for(const shardCase of report.shardCases as Array<{shardCount:number;shard:number}>){
      phases.push(await sampleOrdered(pool,context,seed.writerGrant,'before',shardCase.shardCount,
        shardCase.shard,undefined,check));
    }
    const createSql=`CREATE INDEX ${orderedRevisionIndex} ON ccl_knowledge_revisions
      (project_id, ((payload->'binding'->>'spaceId')), (object_id::uuid))
      WHERE kind='wiki_page' AND published_at IS NOT NULL`;
    check();const indexStarted=performance.now();await pool.query(createSql);
    const indexMs=ms(performance.now()-indexStarted);
    const indexBytes=Number((await pool.query<{size:string}>(
      'SELECT pg_relation_size($1::regclass)::text AS size',[orderedRevisionIndex])).rows[0].size);
    report.index={name:orderedRevisionIndex,sql:createSql,createdMs:indexMs,bytes:indexBytes};
    await pool.query('ANALYZE ccl_knowledge_heads,ccl_knowledge_revisions');
    for(const shardCase of report.shardCases as Array<{shardCount:number;shard:number}>){
      phases.push(await sampleOrdered(pool,context,seed.writerGrant,'after',shardCase.shardCount,
        shardCase.shard,orderedRevisionSql,check));
    }
    const comparisons=[];
    for(const shardCase of report.shardCases as Array<{shardCount:number;shard:number}>){
      const before=phases.find(x=>x.name==='before'&&x.shardCount===shardCase.shardCount)!;
      const after=phases.find(x=>x.name==='after'&&x.shardCount===shardCase.shardCount)!;
      comparisons.push({shardCount:shardCase.shardCount,shard:shardCase.shard,
        sameQueryExceptThreeUuidExpressions:!!before.sql&&after.sql===orderedRevisionSql(before.sql),
        sameFirstParams:JSON.stringify(before.params)===JSON.stringify(after.params),
        positions:EXPLAIN_POINTS.map((position,index)=>({position,
          sameCursor:before.points[index].cursor===after.points[index].cursor,
          orderedRefsEqual:JSON.stringify(before.points[index].orderedRefs)===JSON.stringify(after.points[index].orderedRefs),
          beforeDigest:before.points[index].orderedRefsDigest,afterDigest:after.points[index].orderedRefsDigest,
          revisionIndexUsed:usesIndex(after.points[index].plan,orderedRevisionIndex),
          revisionIndexRows:indexNode(after.points[index].plan,orderedRevisionIndex)}))});
    }
    report.comparisons=comparisons;
    if(comparisons.some(item=>!item.sameQueryExceptThreeUuidExpressions||!item.sameFirstParams||
      item.positions.some(point=>!point.sameCursor||!point.orderedRefsEqual)))report.parityError='ORDERED_REFS_DIFFER';
    report.indexRouteEffective=comparisons.every(item=>item.positions.every(point=>point.revisionIndexUsed&&
      point.revisionIndexRows&&point.revisionIndexRows.examinedApprox<=2_000));
    report.indexNearPageSizeOnAllPoints=comparisons.every(item=>item.positions.every(point=>
      point.revisionIndexRows&&point.revisionIndexRows.examinedApprox<=100));
    report.indexInterpretation='Approximate index entries examined = (Actual Rows + Rows Removed by Filter) × Actual Loops. shardCount=16 can filter many entries before returning 11.';
  }catch(error){report.setupError=errorOf(error);}
  finally{
    if(pool)await pool.end().catch(error=>{report.poolCloseError=errorOf(error);});
    if(created){try{await admin.query(`DROP SCHEMA "${schema}" CASCADE`);report.schemaCleanup='dropped';}
      catch(error){report.schemaCleanup='failed';report.cleanupError=errorOf(error);}}
    await admin.end().catch(error=>{report.adminCloseError=errorOf(error);});
    report.elapsedMs=ms(performance.now()-started);
    report.counts={plannedPhases:4,runPhases:phases.filter(phase=>phase.status==='ok').length,
      notRunPhases:4-phases.filter(phase=>phase.status==='ok').length,
      plannedPages:40,runPages:phases.flatMap(phase=>phase.pages).filter(item=>item.status==='ok').length,
      notRunPages:40-phases.flatMap(phase=>phase.pages).filter(item=>item.status==='ok').length,
      plannedExplains:12,runExplains:phases.flatMap(phase=>phase.points).filter(item=>item.status==='ok').length,
      notRunExplains:12-phases.flatMap(phase=>phase.points).filter(item=>item.status==='ok').length};
    if(!historicalIndexConflict(report.setupError))
      await writeFile(output,`${JSON.stringify(report,null,2)}\n`,'utf8');
  }
  return report;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const diagnostic=process.argv.includes('--diagnose-index');
  const ordered=process.argv.includes('--ordered-revision-probe');
  const historical=process.argv.includes('--before');
  const explicitFinal=process.argv.includes('--final');
  if([diagnostic,ordered,historical,explicitFinal].filter(Boolean).length>1)
    throw new Error('Choose only one scale mode');
  const output=process.argv.find(arg=>arg.startsWith('--output='));
  const location=output?resolve(output.slice(9)):ordered?orderedOutput:diagnostic?indexOutput:
    historical?defaultOutput:finalOutput;
  (ordered?runOrderedRevisionProbe(location):diagnostic?runSemanticSweepIndexDiagnostic(location):
    historical?runSemanticSweepScale(location):runSemanticSweepFinal(location)).then(report=>{
    if(ordered){
      const rows=report.phases as OrderedPhase[];
      process.stdout.write(`${JSON.stringify({elapsedMs:report.elapsedMs,cleanup:report.schemaCleanup,
        setupError:report.setupError,counts:report.counts,index:report.index,indexRouteEffective:report.indexRouteEffective,
        indexNearPageSizeOnAllPoints:report.indexNearPageSizeOnAllPoints,
        parityError:report.parityError,comparisons:report.comparisons,
        phases:rows.map(row=>({name:row.name,shardCount:row.shardCount,status:row.status,
          pageP95Ms:row.pageP95Ms,headSqlP95Ms:row.headSqlP95Ms,error:row.error}))})}\n`);
      if(report.setupError||report.parityError||rows.some(row=>row.status==='error'))process.exitCode=1;
      return;
    }
    if(diagnostic){
      const rows=report.phases as DiagnosticPhase[];
      process.stdout.write(`${JSON.stringify({elapsedMs:report.elapsedMs,cleanup:report.schemaCleanup,
        setupError:report.setupError,counts:report.counts,indexes:report.indexes,pairedChecks:report.pairedChecks,
        phases:rows.map(row=>({name:row.name,status:row.status,pageP95Ms:row.pageP95Ms,
          headSqlP95Ms:row.headSqlP95Ms,firstExplainMs:row.points[0]?.executionMs,
          error:row.error}))})}\n`);
      if(report.setupError||report.parityError||rows.some(row=>row.status==='error'))process.exitCode=1;
      return;
    }
    const rows=report.queries as Scale[];
    process.stdout.write(`${JSON.stringify({elapsedMs:report.elapsedMs,cleanup:report.schemaCleanup,
      mode:report.mode,setupError:report.setupError,counts:report.counts,targets:rows.map(row=>({target:row.target,seedStatus:row.seedStatus,
        actualHeads:row.actualHeads,pageP95Ms:row.pageP95Ms,headSqlP95Ms:row.headSqlP95Ms,
        pagesRun:row.pages.filter(item=>item.status==='ok').length,
        explainsRun:row.points.filter(item=>item.status==='ok').length,
        revisionIndexPoints:row.points.filter(item=>item.revisionIndexUsed).length,error:row.error}))})}\n`);
    if(report.setupError||rows.some(row=>row.error||row.pages.some(item=>item.status==='error')||
      row.points.some(item=>item.status==='error')))process.exitCode=1;
  }).catch(error=>{process.stderr.write(`${String(error)}\n`);process.exitCode=1;});
}
