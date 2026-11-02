/** Synthetic store.search scale probe. Run each target size separately against a dedicated test DB. */
import {cpus,freemem,totalmem} from 'node:os';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {Pool} from 'pg';
import {createKnowledgeStore} from '../../packages/knowledge/src/store.ts';
import {migrateKnowledge} from '../../packages/knowledge/src/migrations.ts';
import {createWikiSearchProjection} from '../../packages/knowledge/src/wiki-search-projection.ts';
import {planWikiLexicalQuery,type WikiLexicalMethodVersion} from '../../packages/knowledge/src/wiki-lexical-query.ts';
import {loadCorpus,syntheticRevision,validateCorpus,type Corpus} from './wiki-query-baseline.ts';
import {readTestDatabase} from './test-database.mjs';

const METHODS:WikiLexicalMethodVersion[]=['wiki-lexical-v1','wiki-lexical-v2'];
const REPETITIONS=3,STATEMENT_TIMEOUT_MS=5_000,SEED_STATEMENT_TIMEOUT_MS=30_000;
const RUN_LIMIT_MS=300_000,WORK_CUTOFF_MS=230_000,SEED_CHUNK=5_000;
type QueryStatus='ok'|'statement_timeout'|'error'|'not_run_budget';
type QueryRow={repeat:number;questionId:string;category:string;method:WikiLexicalMethodVersion;
  status:QueryStatus;latencyMs:number|null;requiredCount:number;foundRequired:number|null;
  requiredRecallAt10:number|null;missingRequired:string[]|null;returnedRows:number|null;
  returnedViewJsonBytesApprox:number|null;errorCode?:string;errorMessage?:string};
const round=(n:number)=>Math.round(n*100)/100;
const elapsed=(start:number)=>round(performance.now()-start);
const percentile=(numbers:number[],p:number)=>numbers.length?round([...numbers].sort((a,b)=>a-b)[Math.ceil(numbers.length*p)-1]):null;
export function summarizeQueries(queries:readonly QueryRow[]){
  const attempted=queries.filter(row=>row.latencyMs!==null);
  return {planned:queries.length,attempted:attempted.length,
    successful:queries.filter(row=>row.status==='ok').length,
    statementTimeouts:queries.filter(row=>row.status==='statement_timeout').length,
    errors:queries.filter(row=>row.status==='error').length,
    notRunBudget:queries.filter(row=>row.status==='not_run_budget').length,
    latencyAllAttemptsMs:{p50:percentile(attempted.map(row=>row.latencyMs!),0.5),
      p95:percentile(attempted.map(row=>row.latencyMs!),0.95)},
    byMethod:Object.fromEntries(METHODS.map(method=>{
      const planned=queries.filter(row=>row.method===method),tried=planned.filter(row=>row.latencyMs!==null),
        completed=planned.filter(row=>row.status==='ok');
      const plannedRequired=planned.reduce((sum,row)=>sum+row.requiredCount,0),
        observedRequired=completed.reduce((sum,row)=>sum+row.requiredCount,0),
        unobservedRequired=plannedRequired-observedRequired,
        foundObservedRequired=completed.reduce((sum,row)=>sum+row.foundRequired!,0);
      return [method,{planned:planned.length,attempted:tried.length,successful:completed.length,
        statementTimeouts:planned.filter(row=>row.status==='statement_timeout').length,
        errors:planned.filter(row=>row.status==='error').length,
        notRunBudget:planned.filter(row=>row.status==='not_run_budget').length,
        latencyAllAttemptsMs:{p50:percentile(tried.map(row=>row.latencyMs!),0.5),
          p95:percentile(tried.map(row=>row.latencyMs!),0.95)},
        requiredRecallAt10:{plannedRequired,observedRequired,unobservedRequired,
          foundObservedRequired,completedOnly:observedRequired?round(foundObservedRequired/observedRequired):null,
          lowerBound:plannedRequired?round(foundObservedRequired/plannedRequired):null,
          upperBound:plannedRequired?round((foundObservedRequired+unobservedRequired)/plannedRequired):null}}];
    }))};
}
const errorInfo=(value:unknown)=>{
  const error=value as {code?:unknown;message?:unknown};
  return {errorCode:typeof error?.code==='string'?error.code:'UNKNOWN',
    errorMessage:typeof error?.message==='string'?error.message.slice(0,400):'Unknown error'};
};
const cpuSnapshot=()=>{const cpu=process.cpuUsage(),memory=process.memoryUsage();return {
  nodeCpuUserMs:round(cpu.user/1000),nodeCpuSystemMs:round(cpu.system/1000),
  nodeRssBytes:memory.rss,nodeHeapUsedBytes:memory.heapUsed,nodeExternalBytes:memory.external,
  nodeMaxRssKiB:process.resourceUsage().maxRSS};};

function parsePages(args:string[],corpus:Corpus):number{
  if(args.length!==1||!/^--pages=(?:[1-9][0-9]*)$/.test(args[0]))
    throw new Error('Supply one --pages=N (fixture size..100000); run 10000 and 100000 separately for scale');
  const count=Number(args[0].slice('--pages='.length));
  if(!Number.isSafeInteger(count)||count<corpus.pages.length||count>100_000)
    throw new Error(`Target current Wiki count must be ${corpus.pages.length}..100000`);
  return count;
}

async function seedFixture(pool:Pool,corpus:Corpus,projectId:string,checkBudget:()=>void){
  // Only the fixed 119-page fixture is materialized in Node. It has no reviews, like the original baseline.
  const rows=corpus.pages.map(page=>({object_id:page.id,version_id:page.versionId,title:page.title,
    body:page.body,payload:syntheticRevision(page,projectId)}));
  const input=JSON.stringify(rows);
  checkBudget();
  await pool.query(`INSERT INTO ccl_knowledge_changesets(project_id,id,request_key,request_hash,content_hash,payload)
    SELECT $1,object_id,'fixture:'||object_id,object_id,version_id,
      jsonb_build_object('changes',jsonb_build_array(jsonb_build_object('revision',
        jsonb_build_object('ref',jsonb_build_object('objectId',object_id,'versionId',version_id)),
        'effect','create','explanation','Synthetic baseline')))
    FROM jsonb_to_recordset($2::jsonb) AS p(object_id text,version_id text,title text,body text,payload jsonb)`,
    [projectId,input]);
  checkBudget();
  await pool.query(`INSERT INTO ccl_knowledge_revisions
      (project_id,object_id,version_id,changeset_id,kind,title,body,payload,published_at)
    SELECT $1,object_id,version_id,object_id,'wiki_page',title,body,payload,
      '2026-11-02T00:00:00Z'::timestamptz
    FROM jsonb_to_recordset($2::jsonb) AS p(object_id text,version_id text,title text,body text,payload jsonb)`,
    [projectId,input]);
  checkBudget();
  await pool.query(`INSERT INTO ccl_knowledge_heads(project_id,object_id,version_id)
    SELECT $1,object_id,version_id
    FROM jsonb_to_recordset($2::jsonb) AS p(object_id text,version_id text,title text,body text,payload jsonb)`,
    [projectId,input]);
}

// Version-5-shaped UUIDs are deterministic, disjoint from the fixture, and generated wholly inside PostgreSQL.
const bulkIds=`format('%s-%s-5%s-8%s-%s',substr(hash,1,8),substr(hash,9,4),
  substr(hash,14,3),substr(hash,18,3),substr(hash,21,12))`;
async function seedNeutralBatch(pool:Pool,projectId:string,template:unknown,first:number,last:number,
  checkBudget:()=>void){
  checkBudget();
  await pool.query(`CREATE TEMP TABLE wiki_scale_batch AS WITH numbered AS (
      SELECT n,md5('wiki-scale-object-'||n) AS object_hash,
        md5('wiki-scale-version-'||n) AS version_hash,
        '规模占位条目'||n AS title,'虚构占位语料'||n AS body
      FROM generate_series($1::int,$2::int) AS n
    ), identified AS (
      SELECT n,title,body,${bulkIds.replaceAll('hash','object_hash')} AS object_id,
        ${bulkIds.replaceAll('hash','version_hash')} AS version_id FROM numbered
    ) SELECT object_id,version_id,title,body,
      ($3::jsonb || jsonb_build_object('ref',jsonb_build_object('objectId',object_id,'versionId',version_id),
        'title',title,'body',body,'sourceGroups','[]'::jsonb,'dependencies','[]'::jsonb,
        'artifactRef','null'::jsonb,'analysisQuality','null'::jsonb,
        'content',jsonb_build_object('schemaVersion',$3::jsonb->'content'->'schemaVersion',
          'profile',$3::jsonb->'content'->'profile',
          'identity',jsonb_build_object('key',title,'aliases','[]'::jsonb),
          'summary',body,'conditions','[]'::jsonb,'counterexamples','[]'::jsonb,
          'unknowns','[]'::jsonb,'nextQuestions','[]'::jsonb,
          'citations','[]'::jsonb,'navigation','[]'::jsonb))) AS payload FROM identified`,[first,last,template]);
  try{
    checkBudget();
    await pool.query(`INSERT INTO ccl_knowledge_changesets(project_id,id,request_key,request_hash,content_hash,payload)
      SELECT $1,object_id,'scale:'||object_id,object_id,version_id,
        jsonb_build_object('changes',jsonb_build_array(jsonb_build_object('revision',
          jsonb_build_object('ref',jsonb_build_object('objectId',object_id,'versionId',version_id)),
          'effect','create','explanation','Unreviewed synthetic scale filler')))
      FROM wiki_scale_batch`,[projectId]);
    checkBudget();
    await pool.query(`INSERT INTO ccl_knowledge_revisions
        (project_id,object_id,version_id,changeset_id,kind,title,body,payload,published_at)
      SELECT $1,object_id,version_id,object_id,'wiki_page',title,body,payload,
        '2026-11-02T00:00:00Z'::timestamptz FROM wiki_scale_batch`,[projectId]);
    checkBudget();
    await pool.query(`INSERT INTO ccl_knowledge_heads(project_id,object_id,version_id)
      SELECT $1,object_id,version_id FROM wiki_scale_batch`,[projectId]);
  }finally{await pool.query('DROP TABLE IF EXISTS wiki_scale_batch');}
}

async function relationSizes(pool:Pool,schema:string){
  const rows=await pool.query<{table_name:string;heap_bytes:string;index_bytes:string;total_bytes:string}>(`
    SELECT c.relname AS table_name,pg_relation_size(c.oid)::text AS heap_bytes,
      pg_indexes_size(c.oid)::text AS index_bytes,pg_total_relation_size(c.oid)::text AS total_bytes
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relkind='r' AND c.relname LIKE 'ccl_knowledge_%'
    ORDER BY c.relname`,[schema]);
  return rows.rows.map(row=>({table:row.table_name,heapBytes:Number(row.heap_bytes),
    indexBytes:Number(row.index_bytes),totalBytes:Number(row.total_bytes)}));
}

export async function runWikiScaleBaseline(targetPages:number,corpus=loadCorpus(),options:{projection?:boolean}={}){
  if(process.env.TEST_DATABASE_REQUIRED!=='1')throw new Error('TEST_DATABASE_REQUIRED=1 is mandatory');
  validateCorpus(corpus);
  if(corpus.questions.length!==30||targetPages<corpus.pages.length||targetPages>100_000||!Number.isInteger(targetPages))
    throw new Error('Use the fixed 30 questions and a target between fixture size and 100000');
  const neutral='规模占位条目虚构占位语料';
  if(corpus.questions.some(question=>METHODS.some(method=>planWikiLexicalQuery(question.question,method).terms
    .some(term=>neutral.includes(term)||/[0-9]/.test(term)))))
    throw new Error('Neutral filler could match a fixed question; revise the fixture before measuring');
  const url=readTestDatabase(process.env,{required:true})!;
  const started=performance.now(),schema=`wiki_scale_${randomUUID().replaceAll('-','')}`;
  const checkBudget=()=>{if(performance.now()-started>=WORK_CUTOFF_MS)
    throw new Error('Run budget exceeded; no further seed or queries will start');};
  const admin=new Pool({connectionString:url,max:1,connectionTimeoutMillis:5_000,
    options:'-c statement_timeout=30000 -c lock_timeout=5000'});
  let data:Pool|undefined,created=false;
  const result:{[key:string]:unknown}={label:'synthetic real store.search v1/v2 scale baseline; not Ask, Lint, semantic quality, or production capacity',
    projectionMode:options.projection?'current-head-bigram':'disabled-original-scan',targetCurrentWiki:targetPages,fixturePages:corpus.pages.length,neutralPages:targetPages-corpus.pages.length,
    questions:30,repetitions:REPETITIONS,statementTimeoutMs:STATEMENT_TIMEOUT_MS,
    seedStatementTimeoutMs:SEED_STATEMENT_TIMEOUT_MS,runLimitMs:RUN_LIMIT_MS,
    fixtureAssurance:'Direct SQL published_at; no review/publication receipts. Neutral bulk payloads reuse a template binding fingerprint after SQL text substitution, so they are not canonical approved revisions.',
    schemaCleanup:'pending',environment:{nodeVersion:process.version,cpuModel:cpus()[0]?.model??'unknown',
      logicalCpuCount:cpus().length,hostTotalMemoryBytes:totalmem(),hostFreeMemoryBytesAtStart:freemem()},
    cpuMeasurementScope:'Node process CPU only; PostgreSQL server CPU is not attributed to this process',
    resources:{start:cpuSnapshot()},queries:[]};
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`);created=true;
    data=new Pool({connectionString:url,max:1,connectionTimeoutMillis:5_000,
      options:`-c search_path=${schema} -c statement_timeout=${SEED_STATEMENT_TIMEOUT_MS} -c lock_timeout=5000`});
    const migrationStart=performance.now();await migrateKnowledge(data);result.migrationMs=elapsed(migrationStart);
    const projectId=`synthetic-${schema}`;
    await data.query('INSERT INTO ccl_knowledge_projects(project_id) VALUES($1)',[projectId]);
    const server=await data.query<{server_version:string;database_name:string}>(
      "SELECT current_setting('server_version') AS server_version,current_database() AS database_name");
    result.database={postgresVersion:server.rows[0].server_version,databaseName:server.rows[0].database_name,
      connection:'explicit loopback dedicated TEST_DATABASE_URL',maxConnections:2};
    const fixedStart=performance.now();await seedFixture(data,corpus,projectId,checkBudget);
    const fixedMs=elapsed(fixedStart),bulkStart=performance.now();
    const template=syntheticRevision(corpus.pages[0],projectId);
    for(let first=1;first<=targetPages-corpus.pages.length;first+=SEED_CHUNK){
      checkBudget();
      await seedNeutralBatch(data,projectId,template,first,
        Math.min(first+SEED_CHUNK-1,targetPages-corpus.pages.length),checkBudget);
    }
    result.seed={fixedMs,bulkMs:elapsed(bulkStart),totalMs:round(fixedMs+elapsed(bulkStart)),
      mode:'119 fixed pages in three SQL inserts; neutral filler generated in PostgreSQL chunks of 5000'};
    result.resources={...result.resources as object,afterSeed:cpuSnapshot()};
    checkBudget();
    const count=Number((await data.query<{total:string}>(
      'SELECT count(*)::text AS total FROM ccl_knowledge_heads WHERE project_id=$1',[projectId])).rows[0].total);
    if(count!==targetPages)throw new Error(`Seed count mismatch: ${count} versus ${targetPages}`);
    result.actualCurrentWiki=count;
    if(options.projection){
      const projection=createWikiSearchProjection(data),indexStart=performance.now();
      let state=await projection.runBatch(projectId,'knowledge',{limit:5000});
      for(let page=0;!state.complete&&page<100;page++){checkBudget();state=await projection.runBatch(projectId,'knowledge',{limit:5000});}
      result.projectionBuild={elapsedMs:elapsed(indexStart),state};
      if(!state.ready)throw new Error('Search projection did not become ready within its bounded build');
    }
    checkBudget();
    await data.query('ANALYZE ccl_knowledge_revisions,ccl_knowledge_heads,ccl_knowledge_wiki_search_heads,ccl_knowledge_wiki_search_scopes');
    result.statistics='ANALYZE both authority and projection before timing';
    checkBudget();
    result.relations=await relationSizes(data,schema);
    checkBudget();
    await data.query(`SET statement_timeout=${STATEMENT_TIMEOUT_MS}`);
    const explainInputs:Array<{method:WikiLexicalMethodVersion;sql:string;params:unknown[]}>=[];
    let currentMethod:WikiLexicalMethodVersion='wiki-lexical-v1';
    const measuredPool={connect:async()=>{const client=await data!.connect();
      return {release:()=>client.release(),query:async(sql:string,params?:unknown[])=>{
        if(sql.includes('lex.score')&&sql.includes('SELECT r.payload')&&!explainInputs.some(x=>x.method===currentMethod))
          explainInputs.push({method:currentMethod,sql,params:params??[]});
        return client.query(sql,params);
      }};}} as unknown as Pool;
    const store=createKnowledgeStore(measuredPool,{wikiSearchProjection:options.projection?'auto':'disabled'}),queries:QueryRow[]=[];
    for(let repeat=1;repeat<=REPETITIONS;repeat++)for(const question of corpus.questions)for(const method of METHODS){
      const base={repeat,questionId:question.id,category:question.category,method,
        requiredCount:question.requiredPageIds.length};
      if(performance.now()-started>=WORK_CUTOFF_MS){queries.push({...base,status:'not_run_budget',
        latencyMs:null,foundRequired:null,requiredRecallAt10:null,missingRequired:null,
        returnedRows:null,returnedViewJsonBytesApprox:null});continue;}
      currentMethod=method;
      const plan=planWikiLexicalQuery(question.question,method),queryStart=performance.now();
      try{
        const views=await store.search(projectId,{kinds:['wiki_page'],spaceId:'knowledge',lexical:plan,limit:10,offset:0});
        const ids=new Set(views.map(view=>view.revision.ref.objectId));
        const missing=question.requiredPageIds.filter(id=>!ids.has(id));
        queries.push({...base,status:'ok',latencyMs:elapsed(queryStart),
          foundRequired:question.requiredPageIds.length-missing.length,
          requiredRecallAt10:question.requiredPageIds.length?round((question.requiredPageIds.length-missing.length)/question.requiredPageIds.length):null,
          missingRequired:missing,returnedRows:views.length,
          returnedViewJsonBytesApprox:Buffer.byteLength(JSON.stringify(views),'utf8')});
      }catch(error){const info=errorInfo(error);
        queries.push({...base,status:info.errorCode==='57014'||/statement timeout/i.test(info.errorMessage)?'statement_timeout':'error',
          latencyMs:elapsed(queryStart),foundRequired:null,requiredRecallAt10:null,missingRequired:null,
          returnedRows:null,returnedViewJsonBytesApprox:null,...info});}
    }
    result.queries=queries;
    result.summary=summarizeQueries(queries);
    if(options.projection){
      const original=createKnowledgeStore(data,{wikiSearchProjection:'disabled'}),parity=[];
      const ordered=(views:Awaited<ReturnType<typeof store.search>>)=>views.map(view=>({ref:view.revision.ref,
        score:view.searchMatch?.score,matchedTerms:view.searchMatch?.matchedTerms}));
      for(const question of corpus.questions)for(const method of METHODS){
        if(performance.now()-started>=WORK_CUTOFF_MS){parity.push({questionId:question.id,method,state:'not_run_budget'});continue;}
        const request={kinds:['wiki_page' as const],spaceId:'knowledge',lexical:planWikiLexicalQuery(question.question,method),limit:10,offset:0};
        try{const originalStart=performance.now(),before=ordered(await original.search(projectId,request)),originalMs=elapsed(originalStart);
          const projectedStart=performance.now(),after=ordered(await store.search(projectId,request)),projectedMs=elapsed(projectedStart);
          parity.push({questionId:question.id,method,state:JSON.stringify(before)===JSON.stringify(after)?'matched':'mismatch',originalMs,projectedMs,before,after});
        }catch(error){parity.push({questionId:question.id,method,state:'failed',...errorInfo(error)});}
      }
      result.orderParity={planned:corpus.questions.length*METHODS.length,matched:parity.filter(x=>x.state==='matched').length,
        mismatches:parity.filter(x=>x.state==='mismatch').length,notRun:parity.filter(x=>x.state==='not_run_budget').length,items:parity};
    }
    const plans:unknown[]=[];
    for(const input of explainInputs){
      if(performance.now()-started>=WORK_CUTOFF_MS){plans.push({method:input.method,state:'not_run_budget'});continue;}
      try{const plan=await data.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${input.sql}`,input.params);
        plans.push({method:input.method,state:'completed',plan:plan.rows[0]['QUERY PLAN']});
      }catch(error){plans.push({method:input.method,state:'failed',...errorInfo(error)});}
    }
    result.explain=plans;
    result.resources={...result.resources as object,afterQueries:cpuSnapshot()};
    const parityOk=!options.projection||(result.orderParity as {matched:number}).matched===corpus.questions.length*METHODS.length;
    result.state=queries.some(row=>row.status!=='ok')||!parityOk?'incomplete_or_failed':'completed';
  }catch(error){result.state='failed';result.failure=errorInfo(error);}
  finally{
    if(data)try{await data.end();}catch(error){result.poolCloseError=errorInfo(error);}
    if(created)try{await admin.query(`DROP SCHEMA "${schema}" CASCADE`);result.schemaCleanup='dropped';}
      catch(error){result.schemaCleanup='failed';result.cleanupError=errorInfo(error);result.retainedSchema=schema;}
    else result.schemaCleanup='not_created';
    await admin.end();
    result.durationMs=elapsed(started);
    result.resources={...result.resources as object,finish:cpuSnapshot()};
    result.hostFreeMemoryBytesAtFinish=freemem();
  }
  return result;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{const corpus=loadCorpus(),args=process.argv.slice(2),projection=args.includes('--projection'),pages=parsePages(args.filter(arg=>arg!=='--projection'),corpus);
    const result=await runWikiScaleBaseline(pages,corpus,{projection});
    process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
    if(result.state!=='completed'||result.schemaCleanup!=='dropped')process.exitCode=1;
  }catch(error){process.stderr.write(`${errorInfo(error).errorMessage}\n`);process.exitCode=1;}
}
