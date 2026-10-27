import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {seedKnowledgeSyntheticFixture} from '../../../scripts/runtime/knowledge-synthetic-fixture.ts';
import {createKnowledgeApi} from '../src/index.ts';
import {createKnowledgeClient,KnowledgeClientError} from '../../../packages/knowledge-client/src/index.ts';
import {createDocumentKnowledgeAdapter} from '../../../packages/adapters/knowledge-document/src/index.ts';
import {createPgSourceRegistry,assertLocalSourceProof} from '../../../packages/adapters/knowledge-service/src/sources.ts';
import type {FeedbackInput,UseInput} from '../../../packages/knowledge-contracts/src/index.ts';

const url=readTestDatabase();
const dbTest=url?test:test.skip;
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const cost={modelCalls:{state:'unknown' as const,reason:'not measured'},tokens:{state:'unknown' as const,reason:'not measured'},money:{state:'unknown' as const,reason:'not measured'}};
const errorCode=(code:string)=>(error:unknown)=>error instanceof KnowledgeClientError&&error.code===code;

async function withFixture(run:(value:{pool:pg.Pool;seed:Awaited<ReturnType<typeof seedKnowledgeSyntheticFixture>>;baseUrl:string;token:string;client:ReturnType<typeof createKnowledgeClient>})=>Promise<void>){
  const admin=new pg.Pool({connectionString:url!,max:2}),schema=`ccl_knowledge_source_use_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString:url!,max:8,options:`-c search_path=${schema}`});
  let server:import('node:http').Server|undefined;
  try{
    const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-${randomUUID()}`);
    const token=`synthetic-${randomUUID()}-${randomUUID()}`;
    const api=await createKnowledgeApi({pool,token,principal:seed.principal,capabilities:seed.authorization,writerGrant:seed.writerGrant,port:0});
    server=await api.listen();const address=server.address();assert.ok(address&&typeof address!=='string');
    const baseUrl=`http://127.0.0.1:${address.port}`;
    const client=createKnowledgeClient({baseUrl,scope:{projectId:seed.projectId,spaceId:seed.spaceId},headers:{Authorization:`Bearer ${token}`}});
    await run({pool,seed,baseUrl,token,client});
  }finally{
    await new Promise<void>(resolve=>server?.close(()=>resolve())??resolve());
    await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();
  }
}

function documentInput(id:string,text:string){return {externalId:id,version:'1',text,author:'Synthetic author',publisher:'Synthetic publisher',acquirer:'Engineering test',obtainedAt:new Date().toISOString(),rightsPolicyRef:'synthetic-local-only',expectedSourceHead:null,sourceGroups:[{id:`synthetic:${id}`,status:'known' as const,authority:'synthetic-test'}],limitations:['Synthetic test only']};}

/** These tests exercise a disposable PG schema and a real loopback HTTP server; evidence is engineering-only. */
dbTest('M2: document source versions enforce replay, owner CAS, and revocation at the publication lock', {timeout:90_000},async()=>withFixture(async({pool,seed,baseUrl,token,client})=>{
  const document=createDocumentKnowledgeAdapter(client);
  const sourceInput=documentInput(`notes-${randomUUID()}`,'Synthetic paragraph one.\n\nSynthetic paragraph two.');
  const key=randomUUID();
  const [first,replay]=await Promise.all([document.contribute(sourceInput,{idempotencyKey:key}),document.contribute(sourceInput,{idempotencyKey:key})]);
  assert.deepEqual(replay.data.ref,first.data.ref);
  const documentRecord=(await client.source(first.data.ref,'exploration_reading')).data;
  assert.deepEqual(documentRecord.provenance,{externalIdentity:{adapterId:'document',externalObjectId:sourceInput.externalId,externalVersion:sourceInput.version},
    author:sourceInput.author,publisher:sourceInput.publisher,acquirer:sourceInput.acquirer,obtainedAt:sourceInput.obtainedAt,
    publishedAt:null,custody:{mode:'managed_copy'},rightsPolicyRef:sourceInput.rightsPolicyRef});
  assert.equal('text' in documentRecord.provenance!.custody,false,'metadata must not copy managed source text');
  const sourceOperation=await client.lookupOperation({purpose:'exploration_reading',operation:'sources:upsert',key});
  assert.equal(sourceOperation.data.state,'committed');
  assert.equal(sourceOperation.data.operation?.commitStatus,'committed');
  assert.equal((await client.operation(sourceOperation.data.operation!.id,'exploration_reading')).data.id,sourceOperation.data.operation!.id);
  assert.equal((await client.lookupOperation({purpose:'exploration_reading',operation:'sources:upsert',key:randomUUID()})).data.state,'unknown');
  assert.equal((await client.sourceContent(first.data.ref,'exploration_reading')).data.content,sourceInput.text);
  await assert.rejects(document.contribute({...sourceInput,text:'Changed text'}, {idempotencyKey:key}),errorCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(document.contribute({...sourceInput,version:'2',text:'A newer synthetic source',existingObjectId:first.data.ref.objectId}, {idempotencyKey:randomUUID()}),errorCode('SOURCE_HEAD_CONFLICT'));
  const secondToken=`secondary-${randomUUID()}-${randomUUID()}`;
  const secondApi=await createKnowledgeApi({pool,token:secondToken,principal:{...seed.principal,id:'foreign-owner'},capabilities:seed.authorization,writerGrant:seed.writerGrant,port:0});
  const secondServer=await secondApi.listen();
  try{const address=secondServer.address();assert.ok(address&&typeof address!=='string');
    const other=createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope:{projectId:seed.projectId,spaceId:seed.spaceId},headers:{Authorization:`Bearer ${secondToken}`}});
    const foreignDocument=createDocumentKnowledgeAdapter(other);
    await assert.rejects(foreignDocument.contribute({...sourceInput,version:'2',text:'Foreign owner update',expectedSourceHead:first.data.ref.versionId,existingObjectId:first.data.ref.objectId},{idempotencyKey:randomUUID()}),errorCode('SOURCE_OWNER_FORBIDDEN'));
    assert.equal((await other.lookupOperation({purpose:'exploration_reading',operation:'sources:upsert',key})).data.state,'unknown');
    await assert.rejects(other.operation(sourceOperation.data.operation!.id,'exploration_reading'),errorCode('NOT_FOUND'));
  }finally{await new Promise<void>(resolve=>secondServer.close(()=>resolve()));}
  const context={scope:{projectId:seed.projectId,spaceId:seed.spaceId},principal:seed.principal,purpose:'exploration_reading'};
  const registry=createPgSourceRegistry(pool,{writerGrant:seed.writerGrant,readerIds:[seed.principal.id]});
  const proof=await registry.proof(context,first.data.ref);
  const lock=await pool.connect();await lock.query('BEGIN');await lock.query('SELECT 1 FROM ccl_knowledge_projects WHERE project_id=$1 FOR UPDATE',[seed.projectId]);
  const revoke=client.revokeSource(first.data.ref,{contentDigest:first.data.ref.contentDigest,expectedGeneration:1},{idempotencyKey:randomUUID()});
  try{
    let waitingOnProjectLock=false;
    for(let attempt=0;attempt<25&&!waitingOnProjectLock;attempt++){
      const active=await pool.query<{blocked:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'
        AND query ILIKE '%ccl_knowledge_projects%') blocked`);
      waitingOnProjectLock=active.rows[0].blocked;
      if(!waitingOnProjectLock)await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(waitingOnProjectLock,true,'source revoke must reach the same project lock as publication');
    const settled=await Promise.race([revoke.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),80))]);
    assert.equal(settled,false,'source revoke must wait behind the project publication lock');
  }finally{
    await lock.query('COMMIT');lock.release();
  }
  const revoked=await revoke;assert.equal(revoked.data.readability.contentReadable,false);
  await assert.rejects(client.sourceContent(first.data.ref,'exploration_reading'),errorCode('SOURCE_UNREADABLE'));
  const db=await pool.connect();try{await db.query('BEGIN');await assert.rejects(assertLocalSourceProof(db,context,proof),(error:unknown)=>error instanceof Error&&'code' in error&&error.code==='SOURCE_PROOF_REVOKED');await db.query('ROLLBACK');}finally{db.release();}
}));

dbTest('M3: document exact read receipt records external choices and scoped feedback without a Task', {timeout:90_000},async()=>withFixture(async({pool,seed,baseUrl,token,client})=>{
  const document=createDocumentKnowledgeAdapter(client);
  const catalog=await client.catalog({purpose:'exploration_reading',limit:20});
  const catalogReceipt=await client.receipt(catalog.data.readReceiptId);
  assert.deepEqual(catalogReceipt.data.orderedItems.map(item=>item.ref),catalog.data.items.map(item=>item.ref));
  const catalogGraph=await client.graph({root:{readReceiptId:catalog.data.readReceiptId},purpose:'exploration_reading',relationKinds:['supports','challenges','context','navigation'],maxDepth:2,maxNodes:50,maxBytes:1_000_000});
  assert.ok(catalogGraph.data.nodes.length>=3,'global graph must use the complete catalog receipt, not its first item');
  const result=await document.query({question:'合成',purpose:'exploration_reading',limit:20});
  assert.ok(result.data.items.length>=3,'synthetic fixture must return multiple exact knowledge versions');
  const refs=result.data.items.slice(0,3).map(item=>item.ref);
  const receipt=await client.receipt(result.data.readReceiptId);
  assert.deepEqual(receipt.data.orderedItems.slice(0,3).map(item=>item.ref),refs);
  const context=document.context(`document-task-${randomUUID()}`,'v1',sha('synthetic external context'),'Synthetic external review, no internal Task');
  const input:UseInput={context,readReceiptId:receipt.data.id,purpose:'exploration_reading',considered:[
    {ref:refs[0],decision:'adopted',reason:'Synthetic choice',before:null,after:null},
    {ref:refs[1],decision:'adapted',reason:'Synthetic adaptation',before:'Before',after:'After'},
    {ref:refs[2],decision:'rejected',reason:'Synthetic rejection',before:null,after:null}],gaps:[],cost};
  const useKey=randomUUID();
  const use=await document.use(input,{idempotencyKey:useKey});
  assert.equal(use.data.considered.length,3);assert.equal(use.data.snapshot.id,receipt.data.id);
  const useReplay=await document.use(input,{idempotencyKey:useKey});
  assert.equal(useReplay.data.id,use.data.id);
  assert.equal((await client.lookupOperation({purpose:'exploration_reading',operation:'uses:write',key:useKey})).data.state,'committed');
  assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_external_uses')).rows[0].n,1);
  await assert.rejects(document.use({...input,considered:[{...input.considered[0],ref:{...refs[0],versionId:randomUUID()}}]},{idempotencyKey:randomUUID()}),errorCode('USE_READSET_MISMATCH'));
  const feedback:FeedbackInput={purpose:'exploration_reading',useId:use.data.id,context,knowledgeRefs:[refs[0]],feedbackKey:`observation-${randomUUID()}`,status:'observed',observedAt:new Date().toISOString(),observation:'Synthetic observer saw a label.',rawQuotation:'A visible label',interpretation:'It may aid identification; unverified.',recommendation:'Test readers separately.',artifactDigest:null,measurementScope:'Single synthetic observation',cost,gaps:['No real audience evidence']};
  const feedbackKey=randomUUID();
  const one=await document.feedback(feedback,{idempotencyKey:feedbackKey});
  assert.equal((await client.lookupOperation({purpose:'exploration_reading',operation:'feedback:write',key:feedbackKey})).data.state,'committed');
  const replay=await document.feedback(feedback,{idempotencyKey:randomUUID()});
  assert.equal(replay.data.id,one.data.id);assert.equal(one.data.observation,feedback.observation);assert.equal(one.data.interpretation,feedback.interpretation);
  const negative={...feedback,feedbackKey:`negative-${randomUUID()}`,status:'not_observed',observedAt:feedback.observedAt};
  const negativeResponse=await fetch(`${baseUrl}/api/v1/projects/${encodeURIComponent(seed.projectId)}/spaces/${encodeURIComponent(seed.spaceId)}/knowledge/feedback`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify(negative)});
  assert.equal(negativeResponse.status,400);assert.equal((await negativeResponse.json()).code,'INVALID_REQUEST');
  const page1=await client.changes({purpose:'exploration_reading',limit:1});assert.equal(page1.data.items.length,1);assert.equal(page1.coverage?.hasMore,true);
  const page2=await client.changes({purpose:'exploration_reading',limit:1,after:page1.coverage!.nextCursor!});assert.equal(page2.data.items.length,1);assert.notEqual(page1.data.items[0].id,page2.data.items[0].id);
  await assert.rejects(client.changes({purpose:'exploration_reading',limit:1,after:page1.coverage!.nextCursor!,feedbackId:one.data.id}),errorCode('CHANGES_CURSOR'));
  assert.equal((await client.changes({purpose:'exploration_reading',limit:10,useId:use.data.id})).data.items.length,2);
  assert.equal((await client.feedbackResolutions(one.data.id,{purpose:'exploration_reading',limit:10})).data.items.length,1);
  for(const principal of [{...seed.principal,id:'foreign-reader'},{...seed.principal,clientInstallationId:'other-installation'}]){
    const alternateToken=`alternate-${randomUUID()}-${randomUUID()}`;
    const alternateApi=await createKnowledgeApi({pool,token:alternateToken,principal,capabilities:seed.authorization,writerGrant:seed.writerGrant,port:0});
    const alternateServer=await alternateApi.listen();
    try{const address=alternateServer.address();assert.ok(address&&typeof address!=='string');
      const alternate=createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope:{projectId:seed.projectId,spaceId:seed.spaceId},headers:{Authorization:`Bearer ${alternateToken}`}});
      await assert.rejects(alternate.recordUse(input,{idempotencyKey:randomUUID()}),errorCode(principal.id==='foreign-reader'?'READ_RECEIPT_UNAVAILABLE':'READ_RECEIPT_CONTEXT_MISMATCH'));
    }finally{await new Promise<void>(resolve=>alternateServer.close(()=>resolve()));}
  }
  await pool.query(`UPDATE ccl_knowledge_read_receipts SET expires_at=now()-interval '1 second' WHERE id=$1`,[receipt.data.id]);
  await assert.rejects(document.use(input,{idempotencyKey:randomUUID()}),errorCode('READ_RECEIPT_UNAVAILABLE'));
  await client.revokeSource(seed.source.ref,{contentDigest:seed.source.ref.contentDigest,expectedGeneration:1},{idempotencyKey:randomUUID()});
  await assert.rejects(client.use(use.data.id,'exploration_reading'),errorCode('USE_SNAPSHOT_ACCESS_REVOKED'));
  await assert.rejects(document.use(input,{idempotencyKey:useKey}),errorCode('USE_SNAPSHOT_ACCESS_REVOKED'));
  assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_external_uses')).rows[0].n,1,'replay must not create a new use');
}));

dbTest('lost COMMIT acknowledgement is reconciled by the original capability key', {timeout:90_000},async()=>withFixture(async({pool,seed})=>{
  let loseAcknowledgement=false;
  const originalConnect=pool.connect.bind(pool);
  const faultPool=new Proxy(pool,{get(target,property){
    if(property==='connect')return async()=>{
      const db=await originalConnect();
      return new Proxy(db,{get(connection,member){
        if(member==='query')return async(...args:unknown[])=>{
          const result=await (connection.query as (...values:unknown[])=>Promise<unknown>)(...args);
          if(loseAcknowledgement&&args[0]==='COMMIT'){
            loseAcknowledgement=false;
            throw new Error('Synthetic COMMIT acknowledgement lost after PostgreSQL committed');
          }
          return result;
        };
        const value=Reflect.get(connection,member);
        return typeof value==='function'?value.bind(connection):value;
      }});
    };
    const value=Reflect.get(target,property);
    return typeof value==='function'?value.bind(target):value;
  }}) as pg.Pool;
  const token=`fault-${randomUUID()}-${randomUUID()}`;
  const api=await createKnowledgeApi({pool:faultPool,token,principal:seed.principal,capabilities:seed.authorization,writerGrant:seed.writerGrant,port:0});
  const server=await api.listen();
  try{
    const address=server.address();assert.ok(address&&typeof address!=='string');
    const client=createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope:{projectId:seed.projectId,spaceId:seed.spaceId},headers:{Authorization:`Bearer ${token}`}});
    const document=createDocumentKnowledgeAdapter(client),input=documentInput(`lost-ack-${randomUUID()}`,'Synthetic commit acknowledgement fault');
    const key=randomUUID();let operationId:string|undefined;
    loseAcknowledgement=true;
    await assert.rejects(document.contribute(input,{idempotencyKey:key}),(error:unknown)=>{
      if(!(error instanceof KnowledgeClientError))return false;
      operationId=error.operationId;
      return error.code==='COMMIT_OUTCOME_UNKNOWN'&&error.commitStatus==='unknown'&&!!operationId;
    });
    assert.equal(loseAcknowledgement,false,'fault must fire exactly after the real COMMIT');
    const lookup=await client.lookupOperation({purpose:'exploration_reading',operation:'sources:upsert',key});
    assert.equal(lookup.data.state,'committed');
    assert.equal(lookup.data.operation?.id,operationId);
    assert.equal((await client.operation(operationId!,'exploration_reading')).data.commitStatus,'committed');
    const replay=await document.contribute(input,{idempotencyKey:key});
    assert.equal(replay.data.receiptId,operationId);
    assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_knowledge_capability_receipts WHERE action=$1 AND request_key=$2',['sources:upsert',key])).rows[0].n,1);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
}));
