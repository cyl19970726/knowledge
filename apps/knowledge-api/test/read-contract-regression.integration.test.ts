import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {seedKnowledgeSyntheticFixture} from '../../../scripts/runtime/knowledge-synthetic-fixture.ts';
import {createKnowledgeApi} from '../src/index.ts';
import {createKnowledgeClient,KnowledgeClientError} from '../../../packages/knowledge-client/src/index.ts';
import {createKnowledgeApplication} from '../../../packages/knowledge-application/src/index.ts';
import {createKnowledgeStore} from '../../../packages/knowledge/src/store.ts';
import {assertKnowledgeWriterAuthority} from '../../../packages/knowledge/src/writer-authority.ts';
import {digest} from '../../../packages/knowledge/src/utils.ts';
import {fromVersionRef} from '../../../packages/knowledge-contracts/src/index.ts';

const url=readTestDatabase();
const dbTest=url?test:test.skip;
const hasCode=(code:string)=>(error:unknown)=>error instanceof KnowledgeClientError&&error.code===code;

/** A separate schema makes publication and source changes disposable engineering evidence. */
dbTest('bounded history and graph reject unsupported historical claims and preserve source readability', {timeout:90_000},async()=>{
  const admin=new pg.Pool({connectionString:url!,max:2}),schema=`ccl_knowledge_read_contract_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString:url!,max:8,options:`-c search_path=${schema}`});
  let server:import('node:http').Server|undefined;
  try{
    const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-${randomUUID()}`),token=`test-${randomUUID()}-${randomUUID()}`;
    const api=await createKnowledgeApi({pool,token,principal:seed.principal,capabilities:seed.authorization,writerGrant:seed.writerGrant,port:0});
    server=await api.listen();const address=server.address();assert.ok(address&&typeof address!=='string');
    const client=createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope:{projectId:seed.projectId,spaceId:seed.spaceId},headers:{Authorization:`Bearer ${token}`}});
    const first=await client.history({objectId:seed.root.objectId,purpose:'exploration_reading',limit:1});
    assert.equal(first.data.versions.length,1);assert.equal(first.coverage?.hasMore,true);assert.ok(first.coverage?.nextCursor);
    const second=await client.history({objectId:seed.root.objectId,purpose:'exploration_reading',limit:1,cursor:first.coverage!.nextCursor!});
    assert.equal(second.data.versions.length,1);assert.equal(second.coverage?.hasMore,false);
    assert.notEqual(first.data.versions[0].ref.versionId,second.data.versions[0].ref.versionId);
    await assert.rejects(client.history({objectId:seed.root.objectId,purpose:'exploration_reading',limit:1,cursor:'foreign-cursor'}),hasCode('INVALID_CURSOR'));
    await assert.rejects(client.history({objectId:seed.root.objectId,purpose:'exploration_reading',limit:1,asOf:'2020-01-01T00:00:00Z'}),hasCode('HISTORICAL_CUTOFF_UNSUPPORTED'));
    const catalog=await client.catalog({purpose:'exploration_reading',limit:50});
    assert.ok(catalog.data.items.length>=30);
    const supported=catalog.data.items.find(item=>item.ref.objectId===seed.root.objectId);
    assert.equal(supported?.status.contentSupported,true);
    assert.equal(supported?.status.purpose.admitted,true);
    const graphRequest={root:{readReceiptId:catalog.data.readReceiptId},purpose:'exploration_reading',relationKinds:['supports','challenges','context','navigation'] as Array<'supports'|'challenges'|'context'|'navigation'>,maxDepth:3,maxNodes:100,maxBytes:1_000_000};
    await assert.rejects(client.graph({...graphRequest,asOf:'2020-01-01T00:00:00Z'}),hasCode('GRAPH_OPTION_UNSUPPORTED'));
    await assert.rejects(client.graph({...graphRequest,cursor:'unused'}),hasCode('GRAPH_OPTION_UNSUPPORTED'));
    const graph=await client.graph(graphRequest);
    assert.ok(graph.data.nodes.length>=30);
    assert.equal(new Set(graph.data.edges.map(edge=>edge.id)).size,graph.data.edges.length,'each relationship must have a distinct ID');
    const parallelSourceRelations=graph.data.edges.filter(edge=>edge.from.objectId===seed.source.ref.objectId&&edge.to.objectId===seed.root.objectId&&edge.to.versionId===seed.root.versionId);
    assert.ok(parallelSourceRelations.length>=2,'source citation and selected source dependency are separate relations');
    assert.equal(new Set(parallelSourceRelations.map(edge=>edge.id)).size,parallelSourceRelations.length);
    for(const maxNodes of [1,3]){
      const bounded=await client.graph({...graphRequest,maxNodes});
      assert.ok(bounded.data.nodes.length+bounded.data.externalNodes.length<=maxNodes,'internal and external nodes share one budget');
      assert.equal(bounded.coverage?.completeness,'bounded');
    }
    const firstNodeBytes=Buffer.byteLength(JSON.stringify({nodes:[graph.data.nodes[0]],externalNodes:[],edges:[]}), 'utf8');
    const byteBudget=firstNodeBytes+30;
    const byteBounded=await client.graph({...graphRequest,maxBytes:byteBudget});
    assert.ok(byteBounded.data.nodes.length>=1,'the budget admits the first Chinese knowledge page');
    assert.ok(Buffer.byteLength(JSON.stringify(byteBounded.data),'utf8')<=byteBudget,'actual UTF-8 graph payload must fit the byte budget');
    assert.equal(byteBounded.coverage?.completeness,'bounded');
    const sourceNode=graph.data.externalNodes.find(node=>node.ref.objectId===seed.source.ref.objectId);
    assert.equal(sourceNode?.availability,'content_readable');assert.equal(sourceNode.ref.contentDigest,seed.source.ref.contentDigest);
    const store=createKnowledgeStore(pool),real=await store.get(seed.projectId,seed.root);
    assert.ok(real&&real.revision.kind==='wiki_page'&&real.revision.binding&&real.review);
    const scoped={scope:{projectId:seed.projectId,spaceId:seed.spaceId},principal:seed.principal,purpose:'exploration_reading'};
    let interleaved=false;
    const concurrentStore={...store,get:async(projectId:string,ref:{objectId:string;versionId:string})=>{
      if(!interleaved){interleaved=true;const db=await pool.connect();
        try{await db.query('BEGIN');await assertKnowledgeWriterAuthority(db,seed.projectId,seed.writerGrant);
          await db.query('UPDATE ccl_knowledge_projects SET epoch=epoch+1 WHERE project_id=$1',[seed.projectId]);await db.query('COMMIT');}
        catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}}
      return store.get(projectId,ref);
    }};
    const concurrentReader=createKnowledgeApplication({store:concurrentStore,receipts:{save:async()=>{},get:async()=>null}});
    await assert.rejects(concurrentReader.graph(scoped,{...graphRequest,root:{ref:fromVersionRef(seed.root,scoped.scope,'knowledge',digest(real.revision))}}),
      (error:unknown)=>error instanceof Error&&'code' in error&&error.code==='READSET_CHANGED');
    assert.equal(interleaved,true,'the project epoch must change during traversal');
    const projected=(view:typeof real)=>createKnowledgeApplication({store:{...store,get:async(projectId,ref)=>
      ref.objectId===seed.root.objectId&&ref.versionId===seed.root.versionId?view:store.get(projectId,ref)},
      receipts:{save:async()=>{},get:async()=>null}});
    const invalidBinding={...real,revision:{...real.revision,binding:{...real.revision.binding,profileFingerprint:'0'.repeat(64)}}};
    const unsupported=await projected(invalidBinding).exact(scoped,fromVersionRef(seed.root,scoped.scope,'knowledge',digest(invalidBinding.revision)));
    assert.equal(unsupported.data.status.contentSupported,false);
    assert.equal(unsupported.data.status.purpose.admitted,false);
    assert.equal(unsupported.data.body,real.revision.body,'unsupported content remains visible as raw historical text');
    const limitedPurpose={...real,review:{...real.review,purpose:'commerce_use',decision:'exploration_only' as const}};
    const commerceContext={...scoped,purpose:'commerce_use',principal:{...seed.principal,purposes:[...seed.principal.purposes,'commerce_use']}};
    const explorationOnly=await projected(limitedPurpose).exact(commerceContext,fromVersionRef(seed.root,scoped.scope,'knowledge',digest(limitedPurpose.revision)));
    assert.equal(explorationOnly.data.status.contentSupported,true);
    assert.equal(explorationOnly.data.status.purpose.admitted,false);
    await client.revokeSource(seed.source.ref,{contentDigest:seed.source.ref.contentDigest,expectedGeneration:1},{idempotencyKey:randomUUID()});
    const after=await client.graph(graphRequest);
    assert.equal(after.data.externalNodes.find(node=>node.ref.objectId===seed.source.ref.objectId)?.availability,'metadata_only');
    const current=await client.document(supported!.ref,'exploration_reading');
    assert.equal(current.data.status.validity.valid,false);
    assert.equal(current.data.status.purpose.admitted,false);
  }finally{
    await new Promise<void>(resolve=>server?.close(()=>resolve())??resolve());
    await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();
  }
});
