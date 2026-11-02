import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import type {Server} from 'node:http';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {seedKnowledgeSyntheticFixture} from '../../../scripts/runtime/knowledge-synthetic-fixture.ts';
import {createKnowledgeApi} from '../src/index.ts';
import {createKnowledgeClient} from '../../../packages/knowledge-client/src/index.ts';
import type {SourceOwnerPort} from '../../../packages/knowledge-application/src/index.ts';
import type {SourceRecord,SourceContent,SourceEventRequest} from '../../../packages/knowledge-contracts/src/index.ts';
import {KnowledgeError} from '../../../packages/knowledge/src/types.ts';
const url=readTestDatabase(),dbTest=url?test:test.skip;
const code=(expected:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code===expected;

dbTest('source arrival and exact UTF-8 entity mentions persist once, preserve originals, and remain purpose/installation/revocation guarded',async()=>{
 const admin=new pg.Pool({connectionString:url!,max:2}),schema=`source_intake_${randomUUID().replaceAll('-','')}`;
 await admin.query(`CREATE SCHEMA "${schema}"`);const pool=new pg.Pool({connectionString:url!,max:8,options:`-c search_path=${schema}`});
 const servers:Server[]=[];let unblock:(()=>void)|undefined;
 try{
  const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-intake-${randomUUID()}`),purpose='exploration_reading';
  const text='  合成报告：品牌甲与品牌乙。\n',sha=createHash('sha256').update(text).digest('hex');
  const ref={projectId:seed.projectId,spaceId:seed.spaceId,domain:'analysis' as const,objectId:randomUUID(),versionId:randomUUID(),contentDigest:sha};
  let allowed=true,reads=0,readEntered:(()=>void)|undefined;let holdRead:Promise<void>|undefined;
  const metadata:SourceRecord={...seed.source,ref,sourceGroups:[{id:randomUUID(),status:'known',authority:'synthetic-original'}],
   actualCoverage:[],provenance:undefined,readability:{metadataVisible:true,contentReadable:true,anchorResolved:true,assurance:'read_time_only',reasons:[]}};
  const check=()=>{if(!allowed)throw new KnowledgeError('SOURCE_FORBIDDEN','Synthetic owner revoked',403);};
  const owner:SourceOwnerPort={async readRecord(_scope,requested){check();assert.deepEqual(requested,ref);return metadata;},
   async readContent(){throw new Error('Unbounded content must never be used');},
   async readContentBounded(_scope,requested,_anchor,_context,maxBytes){check();reads++;readEntered?.();await holdRead;assert.deepEqual(requested,ref);
    if(Buffer.byteLength(text)>maxBytes)throw new KnowledgeError('SOURCE_READ_BUDGET_EXCEEDED','Synthetic bound',422);
    return {ref,content:text,contentDigest:sha,anchor:null,readability:metadata.readability,
     actualCoverage:{sourceRef:ref,anchors:[],byteCount:Buffer.byteLength(text),coverage:'full',exclusions:['Synthetic text only'],
      readAt:new Date().toISOString(),readerAuthority:'synthetic-owner',readProofId:randomUUID()}} satisfies SourceContent;}};
  const token=`test-${randomUUID()}-${randomUUID()}`,authorization={actions:['ingest:read','ingest:write','ingest:mentions'],adapterIds:['synthetic-reports'],rightsPolicyIds:[]};
  async function client(installation?:string,actions=authorization.actions){
   const api=await createKnowledgeApi({pool,token,principal:{...seed.principal,...installation?{clientInstallationId:installation}:{}},
    writerGrant:seed.writerGrant,capabilities:{...authorization,actions},sourceOwner:owner,enableSourceIngest:true,port:0});
   const server=await api.listen();servers.push(server);const address=server.address();assert.ok(address&&typeof address!=='string');
   return createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope:{projectId:ref.projectId,spaceId:ref.spaceId},headers:{Authorization:`Bearer ${token}`}});
  }
  const sdk=await client(),request:SourceEventRequest={adapterId:'synthetic-reports',eventKey:`result:${randomUUID()}`,producerSequence:1,
   occurredAt:new Date().toISOString(),purpose,sourceRef:ref};
  const options={idempotencyKey:request.eventKey,purpose};
  const before=(await pool.query('SELECT count(*)::int n FROM ccl_knowledge_revisions')).rows[0].n;
  const copies=(await pool.query('SELECT count(*)::int n FROM ccl_knowledge_source_versions')).rows[0].n;
  const [a,b]=await Promise.all([sdk.registerSourceEvent(request,options),sdk.registerSourceEvent(request,options)]);
  assert.equal(a.data.id,b.data.id);assert.equal(reads,0,'arrival reads metadata only');
  assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_source_events')).rows[0].n,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_source_intake_outbox')).rows[0].n,1);
  assert.equal((await sdk.sourceEventLookup(request.adapterId,request.eventKey,purpose)).data.state,'known');
  await assert.rejects(sdk.registerSourceEvent({...request,producerSequence:2},options),code('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(sdk.registerSourceEvent({...request,adapterId:'not-authorized'},options),code('SOURCE_ADAPTER_FORBIDDEN'));
  const denied=await client(undefined,[]);await assert.rejects(denied.registerSourceEvent(request,options),code('CAPABILITY_FORBIDDEN'));
  const another=await client('another-installation');assert.equal((await another.sourceEventLookup(request.adapterId,request.eventKey,purpose)).data.state,'unknown');
  await assert.rejects(another.sourceEvent(a.data.id,purpose),code('NOT_FOUND'));
  const start=Buffer.byteLength(text.slice(0,text.indexOf('品牌甲'))),extraction={methodVersion:'synthetic-proposer/1',mentions:[{entityType:'brand',surface:'品牌甲',startByte:start,endByte:start+Buffer.byteLength('品牌甲')}]};
  const mentionsOnly=await client(undefined,['ingest:mentions']);assert.equal((await mentionsOnly.capabilities()).data.permittedActions.includes('recordEntityMentions'),false);
  const entered=new Promise<void>(resolve=>{readEntered=resolve;});holdRead=new Promise<void>(resolve=>{unblock=resolve;});
  const pending=sdk.recordEntityMentions(a.data.id,extraction,{idempotencyKey:extraction.methodVersion,purpose});await entered;
  try{await assert.rejects(sdk.recordEntityMentions(a.data.id,extraction,{idempotencyKey:extraction.methodVersion,purpose,signal:AbortSignal.timeout(1000)}),code('ENTITY_MENTIONS_IN_PROGRESS'));}
  finally{unblock!();holdRead=undefined;readEntered=undefined;}
  const batch=await pending;
  assert.equal(batch.data.mentions[0].resolution,'unresolved');assert.equal(batch.data.semanticCoverage,'unknown');assert.equal(batch.data.provenance,'caller_proposed');
  assert.deepEqual(batch.data.sourceGroups,metadata.sourceGroups);assert.equal(reads,1);
  assert.equal((await sdk.recordEntityMentions(a.data.id,extraction,{idempotencyKey:extraction.methodVersion,purpose})).data.id,batch.data.id);
  assert.equal(reads,1,'same extraction replay does not read source body again');
  assert.equal((await sdk.entityMentions(a.data.id,extraction.methodVersion,purpose)).data?.id,batch.data.id);
  await assert.rejects(sdk.recordEntityMentions(a.data.id,{...extraction,mentions:[]},{idempotencyKey:extraction.methodVersion,purpose}),code('IDEMPOTENCY_CONFLICT'));
  const bad={...extraction,methodVersion:'synthetic-proposer/2',mentions:[{...extraction.mentions[0],surface:'不存在'}]};
  await assert.rejects(sdk.recordEntityMentions(a.data.id,bad,{idempotencyKey:bad.methodVersion,purpose}),error=>!!error&&typeof error==='object'&&'httpStatus'in error&&error.httpStatus===422);
  assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_entity_mention_batches')).rows[0].n,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_source_intake_outbox')).rows[0].n,2);
  assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_revisions')).rows[0].n,before,'no identity merge, knowledge candidate, or publication was fabricated');
  assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_source_versions')).rows[0].n,copies,'no original source copied');
  // If the outbox write fails, the event and receipt must roll back together.
  await pool.query(`CREATE FUNCTION fail_intake_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic outbox failure'; END; $$;
    CREATE TRIGGER fail_intake BEFORE INSERT ON ccl_knowledge_source_intake_outbox FOR EACH ROW EXECUTE FUNCTION fail_intake_outbox()`);
  const failed={...request,eventKey:`result:${randomUUID()}`,producerSequence:3};
  await assert.rejects(sdk.registerSourceEvent(failed,{idempotencyKey:failed.eventKey,purpose}));
  assert.equal((await sdk.sourceEventLookup(failed.adapterId,failed.eventKey,purpose)).data.state,'unknown');
  await pool.query('DROP TRIGGER fail_intake ON ccl_knowledge_source_intake_outbox');
  allowed=false;
  await assert.rejects(sdk.sourceEvent(a.data.id,purpose),code('SOURCE_FORBIDDEN'));
  await assert.rejects(sdk.entityMentions(a.data.id,extraction.methodVersion,purpose),code('SOURCE_FORBIDDEN'));
  await assert.rejects(sdk.registerSourceEvent(request,options),code('SOURCE_FORBIDDEN'));
 }finally{unblock?.();for(const server of servers)await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
