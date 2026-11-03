import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool, type PoolClient} from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {syntheticRevision, type Page} from '../../../scripts/runtime/wiki-query-baseline.ts';
import {migrateKnowledge} from '../src/migrations.ts';
import {createKnowledgeStore} from '../src/store.ts';
import {createWikiSearchProjection} from '../src/wiki-search-projection.ts';
import {planWikiLexicalQuery, type WikiLexicalMethodVersion} from '../src/wiki-lexical-query.ts';
import {assertKnowledgeWriterAuthority, rotateKnowledgeWriterAuthority,
  type KnowledgeWriterGrant} from '../src/writer-authority.ts';

const url=readTestDatabase();
const dbTest=url?test:test.skip;
const id=(n:number)=>`00000000-0000-5000-8000-${String(n).padStart(12,'0')}`;
const project='synthetic-wiki-search-projection';
const space='knowledge';
type SeedOptions={projectId?:string;head?:boolean;rawAliases?:unknown[];rawBody?:string;platforms?:string[]};
type SearchOptions={projectId?:string;spaceId?:string;sourceGroups?:string[];
  platform?:'tiktok'|'douyin'|'xiaohongshu'|'unknown';limit?:number;offset?:number};

function page(n:number,overrides:Partial<Page>={}):Page{return {
  id:id(n),versionId:id(n+1000),title:'普通标题',body:'普通正文',sourceGroup:null,
  identityKey:'普通身份',aliases:[],spaceId:space,...overrides};}

async function isolated(fn:(pool:Pool)=>Promise<void>){
  const admin=new Pool({connectionString:url!,max:1}),schema=`wiki_search_projection_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new Pool({connectionString:url!,options:`-c search_path=${schema}`,max:3});
  try{await migrateKnowledge(pool);await fn(pool);}
  finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
}

async function active(pool:Pool,projectId=project){return rotateKnowledgeWriterAuthority(pool,projectId,null,
  {ownerId:'synthetic-projection-owner',mode:'active'});}

async function write<T>(pool:Pool,projectId:string,grant:KnowledgeWriterGrant,action:(client:PoolClient)=>Promise<T>){
  const client=await pool.connect();
  try{await client.query('BEGIN');await assertKnowledgeWriterAuthority(client,projectId,grant);
    const result=await action(client);await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK');throw error;}
  finally{client.release();}
}

async function seed(client:PoolClient,item:Page,options:SeedOptions={}){
  const projectId=options.projectId??project,revision=syntheticRevision(item,projectId),changeId=randomUUID();
  if(revision.kind!=='wiki_page')throw new Error('Synthetic fixture must be a Wiki page');
  // Non-string aliases are deliberately raw SQL fixtures: the public WikiPage schema rejects them.
  const content={...revision.content,identity:{...revision.content.identity,
    aliases:options.rawAliases??revision.content.identity.aliases}};
  const payload={...revision,content,scope:{...revision.scope,applicability:{...revision.scope.applicability,
    platforms:options.platforms??revision.scope.applicability.platforms}}};
  await client.query(`INSERT INTO ccl_knowledge_changesets(project_id,id,request_key,request_hash,content_hash,payload)
    VALUES($1,$2,$3,$4,$5,$6)`, [projectId,changeId,changeId,item.id,item.versionId,
    {changes:[{revision:{ref:revision.ref},effect:'create',explanation:'Synthetic search projection fixture'}]}]);
  await client.query(`INSERT INTO ccl_knowledge_revisions(project_id,object_id,version_id,changeset_id,kind,title,body,payload,published_at)
    VALUES($1,$2,$3,$4,'wiki_page',$5,$6,$7,$8)`,
    [projectId,item.id,item.versionId,changeId,item.title,options.rawBody??item.body,payload,revision.createdAt]);
  if(options.head!==false)await client.query(`INSERT INTO ccl_knowledge_heads(project_id,object_id,version_id)
    VALUES($1,$2,$3) ON CONFLICT(project_id,object_id) DO UPDATE SET version_id=EXCLUDED.version_id`,
    [projectId,item.id,item.versionId]);
}

function readers(pool:Pool){return {
  baseline:createKnowledgeStore(pool,{wikiSearchProjection:'disabled'}),
  projected:createKnowledgeStore(pool,{wikiSearchProjection:'auto'}),
};}

async function comparison(pool:Pool,question:string,method:WikiLexicalMethodVersion,options:SearchOptions={}){
  const {baseline,projected}=readers(pool),projectId=options.projectId??project,spaceId=options.spaceId??space;
  const lexical=planWikiLexicalQuery(question,method),limit=options.limit??100,offset=options.offset??0;
  const request={kinds:['wiki_page' as const],spaceId,lexical,sourceGroups:options.sourceGroups,
    platform:options.platform,limit,offset};
  const summarize=(rows:Awaited<ReturnType<typeof baseline.search>>)=>rows.map(row=>({
    ref:row.revision.ref,score:row.searchMatch?.score,matchedTerms:row.searchMatch?.matchedTerms,
    title:row.revision.title,valid:row.validity.valid}));
  const expected=summarize(await baseline.search(projectId,request));
  const actual=summarize(await projected.search(projectId,request));
  assert.deepEqual(actual,expected,`${method} ${JSON.stringify({question,...options})}`);
  const candidateRequest={spaceId,lexical,limit,offset};
  const expectedCandidates=await baseline.wikiCandidates!(projectId,candidateRequest);
  const actualCandidates=await projected.wikiCandidates!(projectId,candidateRequest);
  assert.deepEqual(actualCandidates,expectedCandidates,`candidate order ${method} ${question}`);
  return actual;
}

async function untilReady(pool:Pool,grant:KnowledgeWriterGrant,projectId=project,spaceId=space,limit=2){
  const projection=createWikiSearchProjection(pool,{writerGrant:grant});
  for(let n=0;n<30;n++){
    const status=await projection.runBatch(projectId,spaceId,{limit});
    assert.equal(status.formatVersion,'wiki-bigram-v1');
    if(status.ready){assert.equal(status.complete,true);return status;}
  }
  assert.fail('bounded rebuild did not become ready');
}

dbTest('current-head projection preserves v1/v2 scoring, full order, candidates, and filters before and after rebuild',
  {timeout:60_000},async()=>isolated(async pool=>{
    const grant=await active(pool),projection=createWikiSearchProjection(pool,{writerGrant:grant});
    const foreign='synthetic-projection-foreign',foreignGrant=await active(pool,foreign);
    const old=page(1,{versionId:id(2001),title:'旧标题',body:'过期词',identityKey:'Old Alias',aliases:['旧别名']});
    const rows=[page(1,{title:'中文标题',body:'海岸品牌增长实验',identityKey:'Aurora',aliases:['蓝港','蓝港延伸']}),
      page(2,{title:'海岸品牌',body:'中文蓝港正文',identityKey:'Other',aliases:['Blue Harbor','Blue Harbor East'],sourceGroup:'group-1'}),
      page(3,{title:'ＦｏｏＢＡＲ',body:'中文正文',identityKey:'NFKC',aliases:['Blue Harbor'],sourceGroup:'group-2'}),
      page(4,{title:'普通标题',body:'普通正文',identityKey:'Blue Harbor',aliases:['蓝港', '蓝港另名']}),
      page(5,{title:'中文蓝港外部空间',spaceId:'other',identityKey:'Aurora',aliases:['Blue Harbor']}),
      page(6,{title:'蓝港中文',body:'海岸品牌',identityKey:'Aurora',aliases:['Blue Harbor']})];
    await write(pool,project,grant,async client=>{
      await seed(client,old,{head:false});
      for(const item of rows)await seed(client,item,{platforms:item.id===id(2)?['douyin']:['tiktok']});
      await seed(client,page(7,{title:'普通',body:'普通',identityKey:'Nonstring',aliases:[]}),
        {rawAliases:['蓝港',42,{label:'Blue Harbor'}]});
    });
    await write(pool,foreign,foreignGrant,client=>seed(client,page(8,{title:'中文蓝港异项目'}),{projectId:foreign}));
    assert.equal((await projection.status(project,space))?.ready??false,false);
    const queries:[string,WikiLexicalMethodVersion][]=[['中文','wiki-lexical-v1'],['中文','wiki-lexical-v2'],
      ['海岸品牌增长实验','wiki-lexical-v1'],['Blue Harbor','wiki-lexical-v2'],
      ['foobar','wiki-lexical-v1'],['42','wiki-lexical-v2'],['Aurora','wiki-lexical-v2']];
    for(const [q,m] of queries)await comparison(pool,q,m);
    assert.deepEqual(await comparison(pool,'Old Alias','wiki-lexical-v2'),[],'old head cannot return');
    assert.deepEqual(await comparison(pool,'Aurora','wiki-lexical-v1'),[],'v1 excludes identity-only hits');
    await untilReady(pool,grant);
    await untilReady(pool,grant,project,'other');
    await untilReady(pool,foreignGrant,foreign);
    for(const [q,m] of queries){await comparison(pool,q,m);
      for(const offset of [0,1,2,3])await comparison(pool,q,m,{limit:1,offset});}
    assert.deepEqual(await comparison(pool,'Aurora','wiki-lexical-v1'),[]);
    assert.deepEqual(await comparison(pool,'Old Alias','wiki-lexical-v2'),[]);
    for(const method of ['wiki-lexical-v1','wiki-lexical-v2'] as const){
      assert.deepEqual((await comparison(pool,'中文',method,{sourceGroups:['group-1']})).map(x=>x.ref.objectId),[id(2)]);
      assert.deepEqual((await comparison(pool,'中文',method,{platform:'douyin'})).map(x=>x.ref.objectId),[id(2)]);
      assert.deepEqual((await comparison(pool,'中文',method,{spaceId:'other'})).map(x=>x.ref.objectId),[id(5)]);
    }
    assert.deepEqual((await comparison(pool,'中文','wiki-lexical-v1',{projectId:foreign})).map(x=>x.ref.objectId),[id(8)]);
    assert.equal((await projection.status(project,space))?.ready,true);
    await write(pool,project,grant,client=>client.query(`UPDATE ccl_knowledge_revisions SET body=$3
      WHERE project_id=$1 AND object_id=$2 AND version_id=$4`,
      [project,id(3),'字段更新独有词',id(1003)]).then(()=>undefined));
    assert.deepEqual((await comparison(pool,'字段更新独有词','wiki-lexical-v1')).map(x=>x.ref.objectId),[id(3)],
      'a current revision text update must refresh or invalidate the projection');
  }));

dbTest('one astral Han code point uses the original search instead of an empty bigram lookup',
  {timeout:60_000},async()=>isolated(async pool=>{
    const grant=await active(pool),astral='𠀀',plan=planWikiLexicalQuery(astral,'wiki-lexical-v1');
    assert.deepEqual(plan.terms,[astral]);
    await write(pool,project,grant,client=>seed(client,page(1,{title:`${astral}记录`,body:'普通正文'})));
    await untilReady(pool,grant);
    const found=await comparison(pool,astral,'wiki-lexical-v1');
    assert.deepEqual(found.map(row=>row.ref.objectId),[id(1)]);
  }));

dbTest('rebuild catches a lower key inserted and a head replacement after its first keyset page',
  {timeout:60_000},async()=>isolated(async pool=>{
    const grant=await active(pool),projection=createWikiSearchProjection(pool,{writerGrant:grant});
    await write(pool,project,grant,async client=>{
      await seed(client,page(10,{title:'海岸旧版'}));
      await seed(client,page(20,{title:'海岸稳定版'}));
    });
    const first=await projection.runBatch(project,space,{limit:1});
    assert.equal(first.ready,false);
    assert.equal(first.lastObjectId,id(10));
    await write(pool,project,grant,async client=>{
      await seed(client,page(1,{title:'海岸低键新增'}));
      await seed(client,page(10,{versionId:id(3010),title:'海岸新版'}));
    });
    await untilReady(pool,grant,project,space,1);
    const hits=await comparison(pool,'海岸','wiki-lexical-v1');
    assert.deepEqual(new Set(hits.map(row=>row.ref.objectId)),new Set([id(1),id(10),id(20)]));
    assert.equal(hits.find(row=>row.ref.objectId===id(10))?.ref.versionId,id(3010));
    assert.deepEqual(await comparison(pool,'旧版','wiki-lexical-v1'),[]);
  }));

dbTest('missing or wrong-version projection invalidates scope and returns the complete original result',
  {timeout:60_000},async()=>isolated(async pool=>{
    const grant=await active(pool),projection=createWikiSearchProjection(pool,{writerGrant:grant});
    const old=page(1,{versionId:id(2001),title:'旧版'});
    await write(pool,project,grant,async client=>{
      await seed(client,old,{head:false});
      await seed(client,page(1,{title:'海岸一'}));
      await seed(client,page(2,{title:'海岸二'}));
    });
    await untilReady(pool,grant);
    await write(pool,project,grant,client=>client.query(`DELETE FROM ccl_knowledge_wiki_search_heads
      WHERE project_id=$1 AND object_id=$2`,[project,id(1)]).then(()=>undefined));
    assert.equal((await comparison(pool,'海岸','wiki-lexical-v1')).length,2);
    assert.equal((await projection.status(project,space))?.ready,false);
    await untilReady(pool,grant);
    await write(pool,project,grant,client=>client.query(`UPDATE ccl_knowledge_wiki_search_heads SET version_id=$3
      WHERE project_id=$1 AND object_id=$2`,[project,id(1),old.versionId]).then(()=>undefined));
    assert.equal((await comparison(pool,'海岸','wiki-lexical-v1')).length,2);
    assert.equal((await projection.status(project,space))?.ready,false);
  }));

dbTest('cleared grams reset the rebuild cursor; ready replay leaves its timestamp unchanged',
  {timeout:60_000},async()=>isolated(async pool=>{
    const grant=await active(pool),projection=createWikiSearchProjection(pool,{writerGrant:grant});
    await write(pool,project,grant,async client=>{
      await seed(client,page(1,{title:'海岸第一页',aliases:['Blue Harbor']}));
      await seed(client,page(2,{title:'海岸第二页'}));
      await seed(client,page(3,{title:'海岸第三页'}));
    });
    const ready=await untilReady(pool,grant,project,space,1);
    assert.deepEqual(await projection.runBatch(project,space,{limit:1}),ready,
      'a completed scope must not advance its cursor or updatedAt on replay');
    await write(pool,project,grant,client=>client.query(`UPDATE ccl_knowledge_wiki_search_heads
      SET grams_v1='{}'::text[],grams_v2='{}'::text[] WHERE project_id=$1 AND object_id=$2`,
      [project,id(1)]).then(()=>undefined));
    const invalid=await projection.status(project,space);
    assert.equal(invalid?.ready,false);
    assert.equal(invalid?.complete,false);
    assert.equal(invalid?.lastObjectId,null,'rebuild must revisit the lower key whose grams were cleared');
    assert.equal(invalid?.scanned,0);
    for(const method of ['wiki-lexical-v1','wiki-lexical-v2'] as const){
      const hits=await comparison(pool,'海岸',method);
      assert.deepEqual(new Set(hits.map(row=>row.ref.objectId)),new Set([id(1),id(2),id(3)]),
        'auto must use the complete original query while the projection is invalid');
    }
    assert.deepEqual((await comparison(pool,'Blue Harbor','wiki-lexical-v2')).map(row=>row.ref.objectId),[id(1)]);
    const first=await projection.runBatch(project,space,{limit:1});
    assert.equal(first.ready,false);
    assert.equal(first.lastObjectId,id(1));
    await untilReady(pool,grant,project,space,1);
    for(const method of ['wiki-lexical-v1','wiki-lexical-v2'] as const){
      const hits=await comparison(pool,'海岸',method);
      assert.deepEqual(new Set(hits.map(row=>row.ref.objectId)),new Set([id(1),id(2),id(3)]));
    }
    assert.deepEqual((await comparison(pool,'Blue Harbor','wiki-lexical-v2')).map(row=>row.ref.objectId),[id(1)]);
  }));

dbTest('oversize normalized UTF8 text blocks readiness and keeps complete fallback results',
  {timeout:60_000},async()=>isolated(async pool=>{
    const grant=await active(pool),projection=createWikiSearchProjection(pool,{writerGrant:grant});
    await write(pool,project,grant,client=>seed(client,page(1,{title:'超限中文'}),
      {rawBody:'中'.repeat(66_700)}));
    const status=await projection.runBatch(project,space,{limit:1});
    assert.equal(status.ready,false);
    assert.ok(status.blockedRows>0);
    assert.equal((await comparison(pool,'超限中文','wiki-lexical-v1')).length,1);
  }));

dbTest('rolled-back head cannot leave projection state, and read-only authority forbids rebuild and DML',
  {timeout:60_000},async()=>isolated(async pool=>{
    const grant=await active(pool),projection=createWikiSearchProjection(pool,{writerGrant:grant});
    await write(pool,project,grant,client=>seed(client,page(2,{title:'已提交'})));
    const client=await pool.connect();
    try{await client.query('BEGIN');await assertKnowledgeWriterAuthority(client,project,grant);
      await seed(client,page(1,{title:'将回滚'}));
      await client.query('ROLLBACK');
    }finally{client.release();}
    assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_heads WHERE project_id=$1 AND object_id=$2',
      [project,id(1)])).rows[0].n,0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_wiki_search_heads WHERE project_id=$1 AND object_id=$2',
      [project,id(1)])).rows[0].n,0);
    await untilReady(pool,grant);
    const readonly=await rotateKnowledgeWriterAuthority(pool,project,1,
      {ownerId:'synthetic-projection-owner',mode:'read_only'},grant);
    await assert.rejects(createWikiSearchProjection(pool,{writerGrant:readonly}).runBatch(project,space,{limit:1,restart:true}),
      /writer|revoked|read.only|active/i);
    await assert.rejects(pool.query(`UPDATE ccl_knowledge_wiki_search_heads SET indexable=indexable
      WHERE project_id=$1 AND object_id=$2`,[project,id(2)]),/KNOWLEDGE_WRITER_REVOKED|writer|revoked/i);
    assert.equal((await comparison(pool,'已提交','wiki-lexical-v1')).length,1);
  }));

dbTest('one current revision update refreshes its search projection exactly once',async()=>isolated(async pool=>{
  const grant=await active(pool);await write(pool,project,grant,client=>seed(client,page(1,{body:'更新前的中文正文'})));
  await pool.query(`CREATE TABLE projection_refresh_audit (object_id text);
    CREATE FUNCTION projection_count_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO projection_refresh_audit VALUES(NEW.object_id);RETURN NULL;END;$$;
    CREATE TRIGGER projection_count_refresh AFTER UPDATE ON ccl_knowledge_wiki_search_heads
      FOR EACH ROW EXECUTE FUNCTION projection_count_refresh()`);
  await write(pool,project,grant,client=>client.query(`UPDATE ccl_knowledge_revisions SET body='更新后的正文'
    WHERE project_id=$1 AND object_id=$2 AND version_id=$3`,[project,id(1),id(1001)]).then(()=>undefined));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM projection_refresh_audit')).rows[0].n,1);
  await comparison(pool,'更新后的正文','wiki-lexical-v1');
}));

dbTest('rebuild removes cache-only orphan keys and converges without altering authoritative heads',async()=>isolated(async pool=>{
  const grant=await active(pool);await write(pool,project,grant,client=>seed(client,page(1,{title:'中文缓存恢复'})));
  await untilReady(pool,grant);
  await write(pool,project,grant,client=>client.query(`INSERT INTO ccl_knowledge_wiki_search_heads
    (project_id,space_id,object_id,version_id,format_version,grams_v1,grams_v2,indexable)
    VALUES($1,$2,$3,$4,'wiki-bigram-v1',ARRAY['中文'],ARRAY['中文'],true)`,
    [project,space,id(999),id(1999)]).then(()=>undefined));
  assert.equal((await createWikiSearchProjection(pool).status(project,space))?.ready,false);
  await untilReady(pool,grant);
  assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_wiki_search_heads WHERE project_id=$1',[project])).rows[0].n,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_heads WHERE project_id=$1',[project])).rows[0].n,1);
  await comparison(pool,'中文','wiki-lexical-v1');
}));
