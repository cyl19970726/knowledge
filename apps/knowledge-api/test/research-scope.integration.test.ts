import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import type {KnowledgeRef} from '../../../packages/knowledge-contracts/src/index.ts';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {seedKnowledgeSyntheticFixture} from '../../../scripts/runtime/knowledge-synthetic-fixture.ts';
import {createKnowledgeStore} from '../../../packages/knowledge/src/store.ts';
import {digest} from '../../../packages/knowledge/src/utils.ts';
import {createSyntheticResearchService} from '../../../packages/knowledge-application/src/research.ts';
import {createKnowledgeApi} from '../src/index.ts';
import {createKnowledgeClient,KnowledgeClientError} from '../../../packages/knowledge-client/src/index.ts';
import {createPgKnowledgeOperations,migrateKnowledgeOperations} from '../../../packages/adapters/knowledge-service/src/operations.ts';

const url=readTestDatabase(),dbTest=url?test:test.skip;
async function fixture(run:(v:{pool:pg.Pool;seed:Awaited<ReturnType<typeof seedKnowledgeSyntheticFixture>>})=>Promise<void>){
 const admin=new pg.Pool({connectionString:url!,max:2}),schema=`ccl_research_scope_${randomUUID().replaceAll('-','')}`;
 await admin.query(`CREATE SCHEMA "${schema}"`);const pool=new pg.Pool({connectionString:url!,max:8,options:`-c search_path=${schema}`});
 try{const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-${randomUUID()}`);await migrateKnowledgeOperations(pool);await run({pool,seed});}
 finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
}
const request=(knowledgeRefs:KnowledgeRef[])=>({question:'Synthetic cross-space research check',purpose:'exploration_reading',sourceRefs:[],knowledgeRefs,baseHeads:[],budget:{maxModelCalls:0,maxReadBytes:100000,deadline:new Date(Date.now()+60_000).toISOString(),maxMoney:null},allowExternalAcquisition:false as const});

dbTest('research submit verifies the stored binding rather than a caller relabelled space',async()=>fixture(async({pool,seed})=>{
 const store=createKnowledgeStore(pool,{writerGrant:seed.writerGrant}),operations=createPgKnowledgeOperations(pool,seed.writerGrant);
 const original=(await store.get(seed.projectId,seed.root))!;
 const ref={projectId:seed.projectId,spaceId:seed.spaceId,domain:'knowledge' as const,...seed.root,contentDigest:digest(original.revision)};
 const otherSpace='other-space',context={scope:{projectId:seed.projectId,spaceId:otherSpace},purpose:'exploration_reading',principal:{...seed.principal,spaceIds:[seed.spaceId,otherSpace]},authorization:seed.authorization};
 let calls=0;const research=createSyntheticResearchService({store,operations,receipts:{async save(){},async get(){return null;}},provider:{async generate(){calls++;return {outcome:'no_change',reason:'Synthetic only',gaps:[],sourceNeeds:[]};}}});
 await assert.rejects(research.submit(context,request([{...ref,spaceId:otherSpace}]),randomUUID()),(e:unknown)=>!!e&&typeof e==='object'&&'code' in e&&e.code==='RESEARCH_BASIS_INVALID');
 assert.equal(calls,0);assert.equal(Number((await pool.query('SELECT count(*) AS n FROM ccl_knowledge_operations')).rows[0].n),0);
 const correct={...context,scope:{projectId:seed.projectId,spaceId:seed.spaceId}};
 const accepted=await research.submit(correct,request([ref]),randomUUID());await research.processOne(seed.projectId);
 assert.equal((await operations.get(correct.scope,seed.principal.id,accepted.id))?.result?.cognitiveOutcome,'no_change');assert.equal(calls,1);
}));

dbTest('worker rechecks real space binding even for an already reserved malformed exact basis',async()=>fixture(async({pool,seed})=>{
 const store=createKnowledgeStore(pool,{writerGrant:seed.writerGrant}),operations=createPgKnowledgeOperations(pool,seed.writerGrant);
 const original=(await store.get(seed.projectId,seed.root))!,scope={projectId:seed.projectId,spaceId:'other-space'};
 const ref={...scope,domain:'knowledge' as const,...seed.root,contentDigest:digest(original.revision)},input=request([ref]);
 const reserved=await operations.reserve({scope,principalId:seed.principal.id,operation:'research',key:randomUUID(),inputDigest:digest(input),input:{request:input,refs:[ref],sourceRefs:[],sourceProofs:[],sourceGroups:[],actualReadCoverage:[],receiptId:null,epoch:await store.epoch(seed.projectId),submittedAt:new Date().toISOString()}});
 let calls=0;const research=createSyntheticResearchService({store,operations,receipts:{async save(){},async get(){return null;}},provider:{async generate(){calls++;return {outcome:'candidate',summary:'Synthetic candidate must not be produced',conditions:[],counterexamples:[],unknowns:[],nextQuestions:[]};}}});
 await research.processOne(seed.projectId);const result=await operations.get(scope,seed.principal.id,reserved.id);
 assert.equal(calls,0);assert.equal(result?.operation.state,'waiting_for_source');assert.equal(result?.result?.candidateId,null);
 assert.match(result?.result?.reason??'',/basis is unavailable/);
 assert.equal(await store.getChangeSet(seed.projectId,reserved.id),null);
}));


dbTest('configured independent API writer cannot mutate a migrated but unactivated project',async()=>fixture(async({pool,seed})=>{
 const projectId=`unactivated-${randomUUID()}`,scope={projectId,spaceId:seed.spaceId},token=`synthetic-${randomUUID()}`;
 const api=await createKnowledgeApi({pool,token,principal:{...seed.principal,projectId},capabilities:seed.authorization,writerGrant:seed.writerGrant,port:0});
 const server=await api.listen();try{
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const client=createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope,headers:{Authorization:`Bearer ${token}`}});
  const source=(await pool.query('SELECT payload FROM ccl_knowledge_source_versions WHERE project_id=$1 LIMIT 1',[seed.projectId])).rows[0].payload;
  await assert.rejects(client.registerSource(source,{idempotencyKey:randomUUID()}),(e:unknown)=>e instanceof KnowledgeClientError&&e.code==='KNOWLEDGE_WRITER_REVOKED'&&e.httpStatus===409);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM ccl_knowledge_source_versions WHERE project_id=$1',[projectId])).rows[0].n),0);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
}));

dbTest('HTTP history projects authoritative publication time separately from revision creation',async()=>fixture(async({pool,seed})=>{
 const token=`synthetic-${randomUUID()}`,scope={projectId:seed.projectId,spaceId:seed.spaceId};
 const api=await createKnowledgeApi({pool,token,principal:seed.principal,writerGrant:seed.writerGrant,port:0});
 const server=await api.listen();try{const address=server.address();assert.ok(address&&typeof address!=='string');
  const client=createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope,headers:{Authorization:`Bearer ${token}`}});
  const expected=(await pool.query('SELECT published_at,payload FROM ccl_knowledge_revisions WHERE project_id=$1 AND object_id=$2 AND version_id=$3',[seed.projectId,seed.root.objectId,seed.root.versionId])).rows[0];
  assert.notEqual(expected.published_at.toISOString(),expected.payload.createdAt);
  const history=await client.history({objectId:seed.root.objectId,purpose:'exploration_reading',limit:20});
  assert.equal(history.data.versions.find(item=>item.ref.versionId===seed.root.versionId)?.publishedAt,expected.published_at.toISOString());
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
}));

dbTest('HTTP client keeps feedback, source copies and reconciliation within an explicit purpose',async()=>fixture(async({pool,seed})=>{
 const purpose='exploration_reading',other='other_authorized_purpose',scope={projectId:seed.projectId,spaceId:seed.spaceId},token=`synthetic-${randomUUID()}`;
 const api=await createKnowledgeApi({pool,token,principal:{...seed.principal,purposes:[purpose,other]},capabilities:seed.authorization,
  writerGrant:seed.writerGrant,feedbackSourceRightsPolicyRef:'synthetic-local-only',port:0});
 const server=await api.listen();try{const address=server.address();assert.ok(address&&typeof address!=='string');
  const client=createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope,headers:{Authorization:`Bearer ${token}`}});
  const cost={modelCalls:{state:'known' as const,value:0},tokens:{state:'known' as const,value:0},money:{state:'unknown' as const,reason:'No paid calls'}};
  const context={adapterId:'document',externalId:randomUUID(),contextVersion:'1',inputDigest:'a'.repeat(64),authority:'caller_reported' as const,description:'Synthetic purpose isolation'};
  const catalog=await client.catalog({purpose,limit:1});
  const used=await client.recordUse({context,purpose,readReceiptId:catalog.data.readReceiptId,considered:[{ref:catalog.data.items[0].ref,decision:'deferred',reason:'Synthetic inspection',before:null,after:null}],gaps:[],cost},{idempotencyKey:randomUUID()});
  const key=randomUUID(),input={purpose,useId:used.data.id,context,knowledgeRefs:[catalog.data.items[0].ref],feedbackKey:randomUUID(),status:'observed' as const,observedAt:new Date().toISOString(),observation:'Synthetic caller observation',rawQuotation:'Synthetic quote',interpretation:'Not independently verified',recommendation:null,artifactDigest:null,measurementScope:null,cost,gaps:[]};
  const feedback=await client.recordFeedback(input,{idempotencyKey:key});
  const isError=(code:string)=>(e:unknown)=>e instanceof KnowledgeClientError&&e.code===code;
  assert.equal((await client.feedback(feedback.data.id,purpose)).data.purpose,purpose);
  await assert.rejects(client.feedback(feedback.data.id,other),isError('NOT_FOUND'));
  await assert.rejects(client.use(used.data.id,other),isError('NOT_FOUND'));
  await assert.rejects(client.recordFeedback({...input,purpose:other,feedbackKey:randomUUID()},{idempotencyKey:randomUUID()}),isError('USE_UNAVAILABLE'));
  assert.equal((await client.lookupOperation({purpose,operation:'feedback:write',key})).data.state,'committed');
  assert.equal((await client.lookupOperation({purpose:other,operation:'feedback:write',key})).data.state,'unknown');
  await assert.rejects(client.operation(feedback.data.id,other),isError('NOT_FOUND'));
  const before=await client.changes({purpose,limit:1});assert.ok(before.coverage?.nextCursor);
  await assert.rejects(client.changes({purpose:other,limit:1,after:before.coverage.nextCursor}),isError('CHANGES_CURSOR'));
  assert.equal((await client.changes({purpose:other,limit:10})).data.items.length,0);
  const registered=await client.registerFeedbackSource(feedback.data.id,{purpose,expectedFeedbackDigest:feedback.data.digest},{idempotencyKey:randomUUID()});
  await assert.rejects(client.source(registered.data.ref,other),isError('SOURCE_PURPOSE_FORBIDDEN'));
  await assert.rejects(client.sourceContent(registered.data.ref,other),isError('SOURCE_PURPOSE_FORBIDDEN'));
  await client.revokeSource(seed.source.ref,{contentDigest:seed.source.ref.contentDigest,expectedGeneration:1},{idempotencyKey:randomUUID()});
  await assert.rejects(client.feedback(feedback.data.id,purpose),isError('FEEDBACK_ACCESS_REVOKED'));
  await assert.rejects(client.recordFeedback(input,{idempotencyKey:key}),isError('FEEDBACK_ACCESS_REVOKED'));
  await assert.rejects(client.recordFeedback({...input,feedbackKey:randomUUID()},{idempotencyKey:randomUUID()}),(e:unknown)=>e instanceof KnowledgeClientError&&e.httpStatus===403&&['FEEDBACK_ACCESS_REVOKED','USE_SNAPSHOT_ACCESS_REVOKED'].includes(e.code));
  assert.equal((await client.changes({purpose,limit:20,feedbackId:feedback.data.id})).data.items.length,0);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
}));

dbTest('explicit B purpose works through research result, independent review, receipt and cancellation',async()=>fixture(async({pool,seed})=>{
 const purpose='other_authorized_purpose',scope={projectId:seed.projectId,spaceId:seed.spaceId},token=`synthetic-${randomUUID()}`;
 const api=await createKnowledgeApi({pool,token,principal:{...seed.principal,purposes:['exploration_reading',purpose]},capabilities:seed.authorization,
  writerGrant:seed.writerGrant,enableSyntheticResearch:true,port:0});
 const server=await api.listen();let reviewerServer:import('node:http').Server|undefined;
 try{const address=server.address();assert.ok(address&&typeof address!=='string');
  const client=createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope,headers:{Authorization:`Bearer ${token}`}});
  const catalog=await client.catalog({purpose,limit:1});
  assert.equal((await client.receipt(catalog.data.readReceiptId,{purpose})).data.purpose,purpose);
  const input={...request([]),purpose,sourceRefs:[seed.source.ref]};
  const op=await client.research(input,{idempotencyKey:randomUUID()});await api.research!.processOne(seed.projectId);
  assert.equal((await client.researchOperation(op.data.id,{purpose})).data.state,'waiting_for_review');
  const result=await client.researchResult(op.data.id,{purpose});assert.equal(result.data.cognitiveOutcome,'no_change');
  await assert.rejects(client.researchResult(op.data.id,{purpose:'exploration_reading'}),(e:unknown)=>e instanceof KnowledgeClientError&&e.code==='RESULT_UNAVAILABLE');
  const ticket=await client.requestReview({purpose,target:{kind:'research_result',researchId:op.data.id,resultDigest:result.data.resultDigest}},{idempotencyKey:randomUUID()});
  assert.equal((await client.reviewTicket(ticket.data.id,{purpose})).data.purpose,purpose);
  await assert.rejects(client.reviewTicket(ticket.data.id,{purpose:'exploration_reading'}),(e:unknown)=>e instanceof KnowledgeClientError&&e.code==='NOT_FOUND');
  const reviewerToken=`synthetic-${randomUUID()}`;
  const reviewerApi=await createKnowledgeApi({pool,token:reviewerToken,principal:{...seed.principal,id:'independent-purpose-reviewer',purposes:['exploration_reading',purpose]},
   capabilities:{...seed.authorization,actions:['review:decide']},writerGrant:seed.writerGrant,port:0});
  reviewerServer=await reviewerApi.listen();const reviewerAddress=reviewerServer.address();assert.ok(reviewerAddress&&typeof reviewerAddress!=='string');
  const reviewer=createKnowledgeClient({baseUrl:`http://127.0.0.1:${reviewerAddress.port}`,scope,headers:{Authorization:`Bearer ${reviewerToken}`}});
  const decision={expectedDigest:result.data.resultDigest,decision:'approved_for_purpose' as const,reason:'Synthetic independent engineering review',conditions:[],gaps:[]};
  await reviewer.decideReview(ticket.data.id,decision,{idempotencyKey:randomUUID(),purpose});
  assert.equal((await client.operation(op.data.id,purpose)).data.state,'succeeded');
  assert.equal((await client.reviewTicket(ticket.data.id,{purpose})).data.status,'finalized');
  const queued=await client.research({...input,question:'Synthetic B cancellation'},{idempotencyKey:randomUUID()});
  await assert.rejects(client.cancelResearch(queued.data.id,{reason:'Wrong purpose'},{idempotencyKey:randomUUID(),purpose:'exploration_reading'}),
   (e:unknown)=>e instanceof KnowledgeClientError&&e.code==='NOT_FOUND');
  assert.equal((await client.cancelResearch(queued.data.id,{reason:'Synthetic cancellation'},{idempotencyKey:randomUUID(),purpose})).data.state,'cancelled');
 }finally{await new Promise<void>(resolve=>reviewerServer?.close(()=>resolve())??resolve());await new Promise<void>(resolve=>server.close(()=>resolve()));}
}));
