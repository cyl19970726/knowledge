import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {migrateKnowledge} from '../../../packages/knowledge/src/migrations.ts';
import {rotateKnowledgeWriterAuthority,assertKnowledgeWriterAuthority} from '../../../packages/knowledge/src/writer-authority.ts';
import {digest} from '../../../packages/knowledge/src/utils.ts';
import {capabilityTransaction,migrateCapabilityReceipts,lookupCapabilityOperation,getCapabilityOperation} from '../../../packages/adapters/knowledge-service/src/transaction.ts';
import {createPgKnowledgeOperations,migrateKnowledgeOperations} from '../../../packages/adapters/knowledge-service/src/operations.ts';
import {migrateKnowledgeUses} from '../../../packages/adapters/knowledge-service/src/uses.ts';
import {createKnowledgeApi} from '../src/index.ts';

const databaseUrl=readTestDatabase();
const dbTest=databaseUrl?test:test.skip;
const purposes=['exploration_reading','commerce_use'] as const;
async function withFixture(run:(v:{pool:pg.Pool;projectId:string;scope:{projectId:string;spaceId:string};principal:{id:string;clientInstallationId:string;projectId:string;spaceIds:string[];purposes:string[]};grant:Awaited<ReturnType<typeof rotateKnowledgeWriterAuthority>>})=>Promise<void>){
  const admin=new pg.Pool({connectionString:databaseUrl!,max:2}),schema=`ccl_reconcile_purpose_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString:databaseUrl!,max:6,options:`-c search_path=${schema}`});
  try{
    await migrateKnowledge(pool);await migrateCapabilityReceipts(pool);await migrateKnowledgeOperations(pool);
    const projectId=`synthetic-${randomUUID()}`,scope={projectId,spaceId:'synthetic-space'};
    const grant=await rotateKnowledgeWriterAuthority(pool,projectId,null,{ownerId:'purpose-test',mode:'active'});
    const principal={id:'same-principal',clientInstallationId:'same-installation',projectId,spaceIds:[scope.spaceId],purposes:[...purposes]};
    await run({pool,projectId,scope,principal,grant});
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
}

dbTest('capability reconciliation and replay stay within the authenticated purpose', {timeout:60000},async()=>withFixture(async({pool,projectId,scope,principal,grant})=>{
  const context=(purpose:string)=>({scope,principal,purpose,authorization:{actions:[],adapterIds:[],rightsPolicyIds:[]}});
  const input={value:'same body'},key=randomUUID(),result={purpose:purposes[0],secret:'purpose A only'};
  assert.deepEqual(await capabilityTransaction(pool,context(purposes[0]),'test:write',key,input,grant,async()=>result),result);
  const known=await lookupCapabilityOperation(pool,context(purposes[0]),'test:write',key);
  assert.equal(known.state,'committed');assert.ok(known.operation);
  assert.equal((await getCapabilityOperation(pool,context(purposes[0]),known.operation.id))?.id,known.operation.id);
  assert.equal((await lookupCapabilityOperation(pool,context(purposes[1]),'test:write',key)).state,'unknown');
  assert.equal(await getCapabilityOperation(pool,context(purposes[1]),known.operation.id),null);
  await assert.rejects(capabilityTransaction(pool,context(purposes[1]),'test:write',key,input,grant,async()=>({secret:'must not run'})),
    (error:unknown)=>error instanceof Error&&'code' in error&&error.code==='OPERATION_PURPOSE_MISMATCH');
  assert.deepEqual(await capabilityTransaction(pool,context(purposes[0]),'test:write',key,input,grant,async()=>({secret:'must not run'})),result);
  // A historical row may be reconciled only when its stored result itself proves purpose.
  const oldKey=randomUUID(),unknownKey=randomUUID();
  await capabilityTransaction(pool,context(purposes[0]),'test:write',oldKey,input,grant,async()=>result);
  await capabilityTransaction(pool,context(purposes[0]),'test:write',unknownKey,input,grant,async()=>({secret:'legacy purpose unknown'}));
  const db=await pool.connect();try{await db.query('BEGIN');await assertKnowledgeWriterAuthority(db,projectId,grant);
    await db.query('UPDATE ccl_knowledge_capability_receipts SET purpose=NULL WHERE request_key=ANY($1::text[])',[ [oldKey,unknownKey] ]);
    await db.query('COMMIT');}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  assert.equal((await lookupCapabilityOperation(pool,context(purposes[0]),'test:write',oldKey)).state,'committed');
  assert.equal((await lookupCapabilityOperation(pool,context(purposes[1]),'test:write',oldKey)).state,'unknown');
  assert.deepEqual(await capabilityTransaction(pool,context(purposes[0]),'test:write',oldKey,input,grant,async()=>({secret:'must not run'})),result);
  await assert.rejects(capabilityTransaction(pool,context(purposes[1]),'test:write',oldKey,input,grant,async()=>({secret:'must not run'})),
    (error:unknown)=>error instanceof Error&&'code' in error&&error.code==='OPERATION_PURPOSE_MISMATCH');
  assert.equal((await lookupCapabilityOperation(pool,context(purposes[0]),'test:write',unknownKey)).state,'unknown');
  await assert.rejects(capabilityTransaction(pool,context(purposes[0]),'test:write',unknownKey,input,grant,async()=>({secret:'must not run'})),
    (error:unknown)=>error instanceof Error&&'code' in error&&error.code==='OPERATION_PURPOSE_MISMATCH');
}));

dbTest('research operation result, key lookup and cancel hide the other purpose', {timeout:60000},async()=>withFixture(async({pool,scope,principal,grant})=>{
  const operations=createPgKnowledgeOperations(pool,grant),key=randomUUID();
  const input={request:{purpose:purposes[0]},refs:[]},identity={scope,principalId:principal.id,operation:'research',key,inputDigest:digest(input),input};
  const reserved=await operations.reserve(identity);
  assert.equal((await operations.get(scope,principal.id,reserved.id,purposes[0]))?.operation.id,reserved.id);
  assert.equal(await operations.get(scope,principal.id,reserved.id,purposes[1]),null);
  assert.equal((await operations.lookup(scope,principal.id,'research',key,purposes[1])).state,'unknown');
  await assert.rejects(operations.cancel(scope,principal.id,reserved.id,purposes[1]),
    (error:unknown)=>error instanceof Error&&'code' in error&&error.code==='NOT_FOUND');
  assert.equal((await operations.get(scope,principal.id,reserved.id,purposes[0]))?.operation.state,'queued');
}));

dbTest('legacy feedback receipt replays over HTTP and PG only for proven purpose without rewriting old bytes', {timeout:60000},async()=>withFixture(async({pool,projectId,scope,principal,grant})=>{
  await migrateKnowledgeUses(pool,{writerGrant:grant});
  const context=(purpose:string)=>({scope,principal,purpose,authorization:{actions:[],adapterIds:[],rightsPolicyIds:[]}});
  const feedbackKey=randomUUID(),requestKey=randomUUID(),feedbackId=randomUUID();
  const input={purpose:purposes[0],useId:null,context:{adapterId:'document',externalId:'legacy',contextVersion:'1',inputDigest:'a'.repeat(64),authority:'caller_reported',description:'Legacy observation'},
    knowledgeRefs:[],feedbackKey,status:'observed',observedAt:new Date().toISOString(),observation:'Synthetic historical observation',rawQuotation:null,
    interpretation:null,recommendation:null,artifactDigest:null,measurementScope:null,gaps:[],cost:{modelCalls:{state:'known',value:0},tokens:{state:'known',value:0},money:{state:'unknown',reason:'No billing'}}};
  const {purpose:_purpose,...oldInput}=input,oldHash=digest(oldInput);
  const oldResult={...oldInput,id:feedbackId,version:'1',digest:oldHash,supersedes:null,sourceRef:null,maintenanceState:'not_requested'};
  const db=await pool.connect();try{await db.query('BEGIN');await assertKnowledgeWriterAuthority(db,projectId,grant);
    await db.query(`INSERT INTO ccl_knowledge_external_feedback(project_id,space_id,principal_id,id,feedback_key,purpose,payload)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[projectId,scope.spaceId,principal.id,feedbackId,feedbackKey,purposes[0],oldResult]);
    await db.query(`INSERT INTO ccl_knowledge_capability_receipts(project_id,space_id,principal_id,action,request_key,id,input_digest,purpose,result)
      VALUES($1,$2,$3,'feedback:write',$4,$5,$6,NULL,$7)`,[projectId,scope.spaceId,principal.id,requestKey,feedbackId,oldHash,oldResult]);
    await db.query('COMMIT');}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  assert.equal((await lookupCapabilityOperation(pool,context(purposes[0]),'feedback:write',requestKey)).state,'committed');
  assert.equal((await lookupCapabilityOperation(pool,context(purposes[1]),'feedback:write',requestKey)).state,'unknown');
  let checked=false;
  const replay=await capabilityTransaction<typeof oldResult & {purpose:string}>(pool,context(purposes[0]),'feedback:write',requestKey,input,grant,async()=>{throw new Error('unexpected write');},async(result)=>{
    checked=true;assert.equal(result.id,feedbackId);assert.equal(result.purpose,purposes[0]);
  });
  assert.ok(checked,'current access replay check was retained');assert.equal(replay.purpose,purposes[0]);assert.equal(replay.digest,oldHash);
  await assert.rejects(capabilityTransaction(pool,context(purposes[1]),'feedback:write',requestKey,{...input,purpose:purposes[1]},grant,async()=>{throw new Error('unexpected write');}),
    (error:unknown)=>error instanceof Error&&'code' in error&&error.code==='OPERATION_PURPOSE_MISMATCH');
  const token=`synthetic-${randomUUID()}`,api=await createKnowledgeApi({pool,token,principal,writerGrant:grant,
    capabilities:{actions:['feedback:write'],adapterIds:['document'],rightsPolicyIds:[]},port:0});
  const server=await api.listen();try{const address=server.address();assert.ok(address&&typeof address!=='string');
    const url=`http://127.0.0.1:${address.port}/api/v1/projects/${projectId}/spaces/${scope.spaceId}/knowledge/feedback`;
    const post=(body:unknown)=>fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':requestKey},body:JSON.stringify(body)});
    const same=await post(input);assert.equal(same.status,200);assert.equal((await same.json()).data.purpose,purposes[0]);
    const foreign=await post({...input,purpose:purposes[1]});assert.equal(foreign.status,403);
    assert.equal((await foreign.json()).code,'OPERATION_PURPOSE_MISMATCH');
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
  const saved=(await pool.query<{input_digest:string;result:unknown}>(`SELECT input_digest,result FROM ccl_knowledge_capability_receipts WHERE request_key=$1`,[requestKey])).rows[0];
  assert.equal(saved.input_digest,oldHash);assert.deepEqual(saved.result,oldResult);
  const writer=await pool.connect();try{await writer.query('BEGIN');await assertKnowledgeWriterAuthority(writer,projectId,grant);
    await writer.query('UPDATE ccl_knowledge_external_feedback SET purpose=NULL WHERE id=$1',[feedbackId]);await writer.query('COMMIT');
  }catch(error){await writer.query('ROLLBACK');throw error;}finally{writer.release();}
  assert.equal((await lookupCapabilityOperation(pool,context(purposes[0]),'feedback:write',requestKey)).state,'unknown');
  await assert.rejects(capabilityTransaction(pool,context(purposes[0]),'feedback:write',requestKey,input,grant,async()=>{throw new Error('unexpected write');}),
    (error:unknown)=>error instanceof Error&&'code' in error&&error.code==='OPERATION_PURPOSE_MISMATCH');
}));
