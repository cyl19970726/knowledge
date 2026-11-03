import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import pg from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {seedKnowledgeSyntheticFixture} from '../../../scripts/runtime/knowledge-synthetic-fixture.ts';
import {syntheticRevision} from '../../../scripts/runtime/wiki-query-baseline.ts';
import {createKnowledgeApi} from '../src/index.ts';
import {createKnowledgeClient,KnowledgeClientError} from '../../../packages/knowledge-client/src/index.ts';
import {createKnowledgeStore} from '../../../packages/knowledge/src/store.ts';
import {digest} from '../../../packages/knowledge/src/utils.ts';
import type {KnowledgeChangeSet,KnowledgeReview,KnowledgeRevision} from '../../../packages/knowledge/src/types.ts';

const databaseUrl=readTestDatabase();
const dbTest=databaseUrl?test:test.skip;
const purpose='exploration_reading';
const spaceId='legacy:video-research';
const hasCode=(code:string)=>(error:unknown)=>error instanceof KnowledgeClientError&&error.code===code;

function proposal(projectId:string,revision:KnowledgeRevision):KnowledgeChangeSet {
  const changes=[{revision,effect:'create' as const,explanation:'Disposable catalog fixture'}];
  return {id:randomUUID(),projectId,requestKey:randomUUID(),requestHash:digest(changes),contentHash:digest(changes),
    purpose,proposer:'synthetic-catalog-proposer',rationale:'Synthetic catalog coverage',methodVersion:'synthetic-catalog-v1',
    cost:{state:'known',amount:0,currency:'USD'},baseHeads:[{objectId:revision.ref.objectId,versionId:null}],
    inputManifest:[],changes,createdAt:new Date().toISOString()};
}

function pattern(projectId:string):KnowledgeRevision {
  // This UUID sorts before every seeded Wiki UUID, making the LIMIT ordering check deterministic.
  const ref={objectId:'00000000-0000-4000-8000-000000000001',versionId:randomUUID()};
  const title='Synthetic read integration pattern';
  return {kind:'pattern',ref,projectId,title,body:'A bounded synthetic catalog document',
    scope:{applicability:{productVersionRefs:[],markets:[],languages:[],audiences:[],goals:[],requiredProduction:[],transferRationale:null},
      limitations:[],unknowns:[],reviewDueAt:null},dependencies:[],sourceGroups:[],artifactRef:null,
    createdAt:new Date().toISOString(),analysisQuality:null,
    content:{ref,projectId,title,problem:'test',mechanism:'test',sequence:[],requiredElements:[],variableSlots:[],
      applicability:[],exclusions:[],supportRefs:[],counterexampleRefs:[],prediction:'test',
      evidenceLevel:'inconclusive',citations:[]}};
}

dbTest('Wiki catalog filters before LIMIT and pages current heads through real HTTP/SDK', {timeout:90_000},async()=>{
  const admin=new pg.Pool({connectionString:databaseUrl!,max:1});
  const schema=`wiki_catalog_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString:databaseUrl!,options:`-c search_path=${schema}`,max:2});
  let server:Server|undefined;
  try{
    const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-wiki-catalog-${randomUUID()}`,spaceId);
    const store=createKnowledgeStore(pool,{writerGrant:seed.writerGrant});
    const nonWiki=pattern(seed.projectId),published=proposal(seed.projectId,nonWiki);
    await store.stage(published);
    const review:KnowledgeReview={id:randomUUID(),projectId:seed.projectId,changeSetId:published.id,
      contentHash:published.contentHash,reviewer:'synthetic-independent-catalog-reviewer',policyVersion:'synthetic-catalog-v1',
      purpose,decision:'exploration_only',rationale:'Synthetic fixture only',createdAt:new Date().toISOString()};
    await store.recordReview(review);
    await store.publish(seed.projectId,published.id,published.contentHash);

    const pending=syntheticRevision({id:randomUUID(),versionId:randomUUID(),title:'Pending catalog Wiki page',
      body:'Staged but never reviewed or published',sourceGroup:null,aliases:[],spaceId},seed.projectId);
    await store.stage(proposal(seed.projectId,pending));
    // The current head remains discoverable when its status says it cannot be adopted.
    await store.invalidate(seed.projectId,{domain:'knowledge',ref:seed.root,reason:'Synthetic catalog invalidation',
      state:'stale',createdAt:new Date().toISOString()});

    const token=`synthetic-${randomUUID()}-${randomUUID()}`;
    const api=await createKnowledgeApi({pool,token,port:0,principal:seed.principal,capabilities:seed.authorization,
      writerGrant:seed.writerGrant});
    server=await api.listen();const address=server.address();assert.ok(address&&typeof address!=='string');
    const baseUrl=`http://127.0.0.1:${address.port}`;
    const client=createKnowledgeClient({baseUrl,scope:{projectId:seed.projectId,spaceId},
      headers:{Authorization:`Bearer ${token}`}});
    const capabilities=await client.capabilities();
    assert.ok(capabilities.data.permittedActions.includes('wikiCatalog'));

    const oldFirst=await client.catalog({purpose,limit:1});
    assert.equal(oldFirst.data.items[0]?.ref.objectId,nonWiki.ref.objectId);
    const first=await client.catalog({purpose,limit:1,kinds:['wiki_page']});
    assert.equal(first.data.items.length,1,'the kind predicate must run before LIMIT');
    assert.notEqual(first.data.items[0].ref.objectId,nonWiki.ref.objectId);
    assert.ok(first.coverage?.nextCursor);

    const pages=[...first.data.items];let cursor:string|null=first.coverage!.nextCursor;
    while(cursor){const page=await client.catalog({purpose,limit:1,kinds:['wiki_page'],cursor});
      assert.equal(page.data.items.length,1);pages.push(...page.data.items);cursor=page.coverage?.nextCursor??null;
    }
    const ids=pages.map(page=>page.ref.objectId);
    assert.equal(new Set(ids).size,ids.length,'each current Wiki head appears exactly once');
    const publishedWiki=await pool.query<{object_id:string;version_id:string}>(`SELECT r.object_id,r.version_id FROM ccl_knowledge_revisions r
      JOIN ccl_knowledge_heads h ON h.project_id=r.project_id AND h.object_id=r.object_id AND h.version_id=r.version_id
      WHERE r.project_id=$1 AND r.kind='wiki_page' AND r.published_at IS NOT NULL`,[seed.projectId]);
    assert.ok(publishedWiki.rows.length>1);
    assert.equal(pages.length,publishedWiki.rows.length,'all synthetic current Wiki heads are present');
    assert.deepEqual(new Set(ids),new Set(publishedWiki.rows.map(row=>row.object_id)));
    assert.ok(!ids.includes(nonWiki.ref.objectId));
    assert.ok(!ids.includes(pending.ref.objectId),'unpublished Wiki candidate is absent');
    const current=pages.find(page=>page.ref.objectId===seed.root.objectId);
    assert.equal(current?.ref.versionId,seed.root.versionId,'historical version cannot replace current head');
    assert.equal(current?.status.current,true);
    assert.equal(current?.status.validity.valid,false,'invalid current page is visible with its actual status');
    assert.equal(current?.status.purpose.admitted,false);
    const history=await client.history({objectId:seed.root.objectId,purpose,limit:10});
    assert.equal(history.data.versions.length,2);
    assert.ok(!pages.some(page=>page.ref.versionId===history.data.versions.find(version=>version.ref.versionId!==seed.root.versionId)?.ref.versionId));

    await assert.rejects(client.catalog({purpose,limit:1,cursor:first.coverage!.nextCursor!}),hasCode('INVALID_CURSOR'));
    await assert.rejects(client.catalog({purpose,limit:1,kinds:['wiki_page'],query:'商品',cursor:first.coverage!.nextCursor!}),hasCode('INVALID_CURSOR'));
    const searched=await client.catalog({purpose,limit:10,kinds:['wiki_page'],query:'长中文标签'});
    assert.ok(searched.data.items.some(page=>page.title.includes('长中文标签')));
    assert.ok(searched.data.items.every(page=>ids.includes(page.ref.objectId)));
    const nonWikiSearch=await client.catalog({purpose,limit:10,query:nonWiki.title});
    assert.ok(nonWikiSearch.data.items.some(page=>page.ref.objectId===nonWiki.ref.objectId));
    const filteredSearch=await client.catalog({purpose,limit:10,kinds:['wiki_page'],query:nonWiki.title});
    assert.deepEqual(filteredSearch.data.items,[]);
    assert.equal(filteredSearch.data.emptyState,'no_matches_in_scope');
    const empty=await client.catalog({purpose,limit:10,kinds:['wiki_page'],query:'不存在的唯一目录词x908c7f2e'});
    assert.deepEqual(empty.data.items,[]);assert.equal(empty.data.emptyState,'no_matches_in_scope');

    const badUrl=`${baseUrl}/api/v1/projects/${encodeURIComponent(seed.projectId)}/spaces/${encodeURIComponent(spaceId)}/knowledge/catalog?purpose=${purpose}&kinds=pattern`;
    const bad=await fetch(badUrl,{headers:{Authorization:`Bearer ${token}`}});
    assert.equal(bad.status,400,'HTTP rejects kinds outside the public Wiki filter');
    const alien=createKnowledgeClient({baseUrl,scope:{projectId:seed.projectId,spaceId:'other-space'},
      headers:{Authorization:`Bearer ${token}`}});
    await assert.rejects(alien.catalog({purpose,limit:1,kinds:['wiki_page']}),hasCode('SCOPE_FORBIDDEN'));
  }finally{
    await new Promise<void>(resolve=>server?.close(()=>resolve())??resolve());
    await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();
  }
});
