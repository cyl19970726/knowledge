import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import pg from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {migrateKnowledge} from '../../../packages/knowledge/src/migrations.ts';
import {assertKnowledgeWriterAuthority,rotateKnowledgeWriterAuthority} from '../../../packages/knowledge/src/writer-authority.ts';
import {SourceUpsertSchema,type KnowledgeRef,type SourceUpsert} from '../../../packages/knowledge-contracts/src/index.ts';
import type {CapabilityContext,ReadContext} from '../../../packages/knowledge-application/src/index.ts';
import {migrateManagedSources,createPgSourceRegistry} from '../../../packages/adapters/knowledge-service/src/sources.ts';
import {createHttpSourceOwner,routeSourceOwners} from '../../../packages/adapters/knowledge-service/src/source-owner.ts';

const url=readTestDatabase(),dbTest=url?test:test.skip;
const hasCode=(code:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&error.code===code;
const sha=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex');

async function fixture(run:(value:{pool:pg.Pool;context:CapabilityContext;grant:Awaited<ReturnType<typeof rotateKnowledgeWriterAuthority>>})=>Promise<void>){
  const admin=new pg.Pool({connectionString:url!,max:2}),schema=`ccl_bounded_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString:url!,max:6,options:`-c search_path=${schema}`});
  try{
    await migrateKnowledge(pool);await migrateManagedSources(pool);
    const projectId=`synthetic-${randomUUID()}`;
    const grant=await rotateKnowledgeWriterAuthority(pool,projectId,null,{ownerId:'bounded-test',mode:'active'});
    const context:CapabilityContext={scope:{projectId,spaceId:'synthetic-space'},purpose:'exploration_reading',
      principal:{id:'source-reader',clientInstallationId:'bounded-test',projectId,spaceIds:['synthetic-space'],
        purposes:['exploration_reading','marketing_decision']},
      authorization:{actions:['sources:write','sources:revoke'],adapterIds:['document'],rightsPolicyIds:['synthetic-local-only']}};
    await run({pool,context,grant});
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
}

function sourceInput(text:string,sourceKind='document'):SourceUpsert{
  return SourceUpsertSchema.parse({externalIdentity:{adapterId:'document',externalObjectId:randomUUID(),externalVersion:'1'},
    expectedSourceHead:null,sourceSchemaVersion:sourceKind==='caller_feedback'?'feedback-source/1.0':'document-text@1',
    contentDigest:sha(text),custody:{mode:'managed_copy',text},sourceKind,author:'Synthetic author',publisher:null,
    acquirer:'bounded-test',publishedAt:null,obtainedAt:new Date().toISOString(),assertionKind:'caller_reported',
    sourceGroups:[],anchors:[{kind:'paragraph',value:'1',resolved:true}],actualCoverage:[],limitations:['Synthetic test'],
    rightsPolicyRef:'synthetic-local-only'});
}

dbTest('managed bounded read checks UTF-8 bytes and never fetches full payload when over budget', {timeout:60_000},async()=>fixture(async({pool,context,grant})=>{
  const registry=createPgSourceRegistry(pool,{writerGrant:grant}),text='你好A';
  const input=sourceInput(text),source=await registry.upsert(context,input,randomUUID());
  const queries:string[]=[],returned:unknown[]=[];
  const spyPool=Object.create(pool) as pg.Pool;
  spyPool.query=(async(statement:string,values?:unknown[])=>{
    queries.push(statement);
    const result=await pool.query(statement,values);
    returned.push(...result.rows);
    return result;
  }) as pg.Pool['query'];
  const bounded=createPgSourceRegistry(spyPool,{writerGrant:grant});
  const anchor={kind:'paragraph' as const,value:'1',resolved:true};
  const metadata=await bounded.readRecord(context.scope,source.ref,context);
  assert.equal(metadata?.ref.contentDigest,source.ref.contentDigest);
  assert.deepEqual(metadata?.provenance,{externalIdentity:input.externalIdentity,author:'Synthetic author',
    publisher:null,acquirer:'bounded-test',obtainedAt:input.obtainedAt,publishedAt:null,custody:{mode:'managed_copy'},
    rightsPolicyRef:'synthetic-local-only'});
  assert.ok(!JSON.stringify(returned).includes(text),'metadata SQL must not return custody.text to Node');
  assert.ok(queries.every(sql=>!sql.includes('SELECT v.*')),'metadata read uses an explicit projection');
  queries.length=0;
  await assert.rejects(bounded.readContentBounded(context.scope,source.ref,anchor,context,6),hasCode('SOURCE_READ_BUDGET_EXCEEDED'));
  await assert.rejects(bounded.readContentBounded(context.scope,source.ref,null,context,0),hasCode('SOURCE_READ_BUDGET_EXCEEDED'));
  assert.equal(queries.length,2);
  assert.ok(queries.every(sql=>!sql.includes('SELECT v.*')&&!sql.includes('SELECT v.payload')),
    'over-budget reads use metadata projections only');
  const content=await bounded.readContentBounded(context.scope,source.ref,anchor,context,7);
  assert.equal(content?.content,text);assert.equal(content?.actualCoverage.byteCount,7);
  assert.deepEqual(content?.actualCoverage.anchors,[anchor]);
  assert.equal((await registry.readContent(context.scope,source.ref,anchor,context))?.content,text,
    'the existing unbounded read contract still works');
  await assert.rejects(bounded.readContentBounded(context.scope,source.ref,null,context,-1),hasCode('SOURCE_READ_BUDGET_INVALID'));
  await assert.rejects(bounded.readContentBounded(context.scope,source.ref,null,context,1.5),hasCode('SOURCE_READ_BUDGET_INVALID'));
  await assert.rejects(bounded.readContentBounded(context.scope,source.ref,null,context,1_000_001),hasCode('SOURCE_READ_BUDGET_INVALID'));
  const beforeForbidden=queries.length;
  const invalid:ReadContext={...context,scope:{...context.scope,spaceId:'other-space'}};
  await assert.rejects(bounded.readContentBounded(invalid.scope,source.ref,null,invalid,1),hasCode('SOURCE_FORBIDDEN'));
  assert.equal(queries.length,beforeForbidden,'context validation precedes SQL');
  await assert.rejects(bounded.readContentBounded(context.scope,{...source.ref,contentDigest:'f'.repeat(64)},null,context,1),
    hasCode('SOURCE_DIGEST_MISMATCH'));
  const foreign={...context,principal:{...context.principal,id:'not-a-reader'}};
  await assert.rejects(bounded.readContentBounded(context.scope,source.ref,null,foreign,1),hasCode('SOURCE_UNREADABLE'));
  await registry.revoke(context,source.ref,1,randomUUID());
  await assert.rejects(bounded.readContentBounded(context.scope,source.ref,null,context,1),hasCode('SOURCE_UNREADABLE'));
}));

dbTest('bounded second SQL rechecks byte size after preflight before returning a payload', {timeout:60_000},async()=>fixture(async({pool,context,grant})=>{
  const registry=createPgSourceRegistry(pool,{writerGrant:grant});
  const source=await registry.upsert(context,sourceInput('短'),randomUUID());
  const spyPool=Object.create(pool) as pg.Pool;let fullRows=-1,changed=false;
  spyPool.query=(async(statement:string,values?:unknown[])=>{
    if(statement.includes('SELECT v.*,h.head_version')){
      changed=true;
      const db=await pool.connect();
      try{await db.query('BEGIN');await assertKnowledgeWriterAuthority(db,context.scope.projectId,grant);
        await db.query(`UPDATE ccl_knowledge_source_versions
          SET payload=jsonb_set(payload,'{custody,text}',to_jsonb($2::text))
          WHERE project_id=$1 AND object_id=$3 AND version_id=$4`,
          [context.scope.projectId,'扩'.repeat(20),source.ref.objectId,source.ref.versionId]);
        await db.query('COMMIT');
      }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
    }
    const result=await pool.query(statement,values);
    if(statement.includes('SELECT v.*,h.head_version'))fullRows=result.rows.length;
    return result;
  }) as pg.Pool['query'];
  const bounded=createPgSourceRegistry(spyPool,{writerGrant:grant});
  await assert.rejects(bounded.readContentBounded(context.scope,source.ref,null,context,3),hasCode('SOURCE_READ_BUDGET_EXCEEDED'));
  assert.equal(changed,true);assert.equal(fullRows,0,'second SQL returns no full payload after text grows');
}));

dbTest('bounded owner refuses same-size text that no longer matches its stored digest', {timeout:60_000},async()=>fixture(async({pool,context,grant})=>{
  const registry=createPgSourceRegistry(pool,{writerGrant:grant});
  const source=await registry.upsert(context,sourceInput('AB'),randomUUID());
  const db=await pool.connect();
  try{await db.query('BEGIN');await assertKnowledgeWriterAuthority(db,context.scope.projectId,grant);
    await db.query(`UPDATE ccl_knowledge_source_versions
      SET payload=jsonb_set(payload,'{custody,text}',to_jsonb($2::text))
      WHERE project_id=$1 AND object_id=$3 AND version_id=$4`,
      [context.scope.projectId,'CD',source.ref.objectId,source.ref.versionId]);
    await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  await assert.rejects(registry.readContentBounded(context.scope,source.ref,null,context,2),hasCode('SOURCE_CONTENT_INTEGRITY'));
}));

dbTest('caller feedback purpose is checked from a SQL projection before body fetch', {timeout:60_000},async()=>fixture(async({pool,context,grant})=>{
  const registry=createPgSourceRegistry(pool,{writerGrant:grant});
  const text=JSON.stringify({schemaVersion:'feedback-source/1.0',purpose:context.purpose,observation:'Synthetic observation'});
  const source=await registry.upsert(context,sourceInput(text,'caller_feedback'),randomUUID());
  const other={...context,purpose:'marketing_decision'};
  const spyPool=Object.create(pool) as pg.Pool;const queries:string[]=[],returned:unknown[]=[];
  spyPool.query=(async(statement:string,values?:unknown[])=>{queries.push(statement);
    const result=await pool.query(statement,values);returned.push(...result.rows);return result;}) as pg.Pool['query'];
  const bounded=createPgSourceRegistry(spyPool,{writerGrant:grant});
  assert.ok((await bounded.readRecord(context.scope,source.ref,context))?.provenance);
  assert.ok(!JSON.stringify(returned).includes(text),'feedback metadata does not include source text');
  await assert.rejects(bounded.readRecord(other.scope,source.ref,other),hasCode('SOURCE_PURPOSE_FORBIDDEN'));
  await assert.rejects(bounded.readContentBounded(other.scope,source.ref,null,other,1),hasCode('SOURCE_PURPOSE_FORBIDDEN'));
  assert.ok(queries.every(sql=>!sql.includes('SELECT v.*')),'wrong purpose is rejected before full payload query');
  assert.equal((await bounded.readContentBounded(context.scope,source.ref,null,context,Buffer.byteLength(text)))?.content,text);
}));

dbTest('malformed feedback JSON and non-string purpose fail closed through metadata-only reads', {timeout:60_000},async()=>fixture(async({pool,context,grant})=>{
  const registry=createPgSourceRegistry(pool,{writerGrant:grant});
  const malformed='{"schemaVersion":"feedback-source/1.0","purpose":';
  const numeric=JSON.stringify({schemaVersion:'feedback-source/1.0',purpose:123,observation:'Synthetic observation'});
  const badJson=await registry.upsert(context,sourceInput(malformed,'caller_feedback'),randomUUID());
  const badPurpose=await registry.upsert(context,sourceInput(numeric,'caller_feedback'),randomUUID());
  const spyPool=Object.create(pool) as pg.Pool;const statements:string[]=[],returned:unknown[]=[];
  spyPool.query=(async(statement:string,values?:unknown[])=>{statements.push(statement);
    const result=await pool.query(statement,values);returned.push(...result.rows);return result;}) as pg.Pool['query'];
  const bounded=createPgSourceRegistry(spyPool,{writerGrant:grant});
  await assert.rejects(bounded.readRecord(context.scope,badJson.ref,context),hasCode('SOURCE_PURPOSE_FORBIDDEN'));
  await assert.rejects(bounded.readContentBounded(context.scope,badJson.ref,null,context,Buffer.byteLength(malformed)),
    hasCode('SOURCE_PURPOSE_FORBIDDEN'));
  const numericContext={...context,purpose:'123',principal:{...context.principal,purposes:[...context.principal.purposes,'123']}};
  await assert.rejects(bounded.readRecord(numericContext.scope,badPurpose.ref,numericContext),hasCode('SOURCE_PURPOSE_FORBIDDEN'));
  await assert.rejects(bounded.readContentBounded(numericContext.scope,badPurpose.ref,null,numericContext,Buffer.byteLength(numeric)),
    hasCode('SOURCE_PURPOSE_FORBIDDEN'));
  assert.ok(statements.every(sql=>!sql.includes('SELECT v.*')),'invalid feedback never reaches a full payload query');
  assert.ok(!JSON.stringify(returned).includes(malformed)&&!JSON.stringify(returned).includes(numeric),
    'invalid feedback text is not returned by metadata queries');
}));

test('owner routing requires bounded support from the selected owner and never falls back to full content',async()=>{
  const scope={projectId:'synthetic-project',spaceId:'synthetic-space'},context:ReadContext={scope,purpose:'exploration_reading',
    principal:{id:'reader',clientInstallationId:'test',projectId:scope.projectId,spaceIds:[scope.spaceId],purposes:['exploration_reading']}};
  const sourceRef:KnowledgeRef={...scope,domain:'source',objectId:randomUUID(),versionId:randomUUID(),contentDigest:null};
  const externalRef:KnowledgeRef={...sourceRef,domain:'evidence'};
  let fullReads=0,boundedReads=0,fetches=0;
  const unbounded={readRecord:async()=>null,readContent:async()=>{fullReads++;return null;}};
  const managed={...unbounded,readContentBounded:async()=>{boundedReads++;return null;}};
  const http=createHttpSourceOwner({baseUrl:'http://127.0.0.1:1',token:'x'.repeat(24),fetch:async()=>{fetches++;throw new Error('unreachable');}});
  const routed=routeSourceOwners(managed,http);
  assert.equal(await routed.readContentBounded(scope,sourceRef,null,context,8),null);
  assert.equal(boundedReads,1);
  await assert.rejects(routed.readContentBounded(scope,externalRef,null,context,8),hasCode('BOUNDED_SOURCE_READ_UNSUPPORTED'));
  await assert.rejects(routeSourceOwners(unbounded).readContentBounded(scope,sourceRef,null,context,8),hasCode('BOUNDED_SOURCE_READ_UNSUPPORTED'));
  assert.equal(fullReads,0);assert.equal(fetches,0);
});
