import assert from 'node:assert/strict';
import test from 'node:test';
import { createKnowledgeClient, KnowledgeClientError } from '../src/index.js';

const id='11111111-1111-4111-8111-111111111111';
const scope={projectId:'test-project',spaceId:'test-space'};
const at='2026-11-02T00:00:00Z';
const request={question:'What is supported?',purpose:'exploration_reading',limit:2,maxPages:1,includeSourceContent:false,
  budget:{maxModelCalls:2,maxReadBytes:1000,deadline:at,maxMoney:null}};
const answer={id,question:request.question,purpose:request.purpose,state:'reserved',claims:[],evidence:[],excluded:[],
  coverage:{scopeDescription:'Test',returned:0,loaded:0,hasMore:false,nextCursor:null,completeness:'bounded',omittedReasons:[],snapshot:{publicationEpoch:1,consistency:'single_scope_snapshot'}},
  readsetFingerprint:'a'.repeat(64),cost:{modelCalls:{state:'unknown',reason:'pending'},tokens:{state:'unknown',reason:'pending'},money:{state:'unknown',reason:'pending'}},
  provider:null,reason:'Reserved',gaps:[],createdAt:at,completedAt:null};
const envelope=(data:unknown)=>({contractVersion:'1.0.0',requestId:'req',effectiveScope:scope,observedAt:at,data,warnings:[]});

test('ask writes to /ask with idempotency key; answer reads exact id and purpose',async()=>{
  const sent:Array<{url:URL;init:RequestInit}>=[];
  const client=createKnowledgeClient({baseUrl:'http://localhost:8765',scope,fetch:async(input,init)=>{
    sent.push({url:new URL(String(input)),init:init!});
    return new Response(JSON.stringify(envelope(answer)),{status:200});
  }});
  assert.equal((await client.ask(request,{idempotencyKey:'ask-1'})).data.state,'reserved');
  assert.equal(sent[0]!.url.pathname,'/api/v1/projects/test-project/spaces/test-space/knowledge/ask');
  assert.equal(sent[0]!.init.method,'POST');
  assert.equal(new Headers(sent[0]!.init.headers).get('Idempotency-Key'),'ask-1');
  assert.deepEqual(JSON.parse(String(sent[0]!.init.body)),request);
  assert.equal((await client.answer(id,request.purpose)).data.id,id);
  assert.equal(sent[1]!.init.method,'GET');
  assert.equal(sent[1]!.url.pathname,`/api/v1/projects/test-project/spaces/test-space/knowledge/answers/${id}`);
  assert.equal(sent[1]!.url.searchParams.get('purpose'),request.purpose);
  assert.equal(sent[1]!.init.body,undefined);
});

test('invalid Ask input, missing key and invalid answer parameters never reach transport',async()=>{
  let calls=0;
  const client=createKnowledgeClient({baseUrl:'http://localhost',scope,fetch:async()=>{calls++;throw Error('unexpected fetch');}});
  for(const [data,options] of [[request,undefined],[{...request,limit:0},{idempotencyKey:'ask-1'}],[{...request,extra:true},{idempotencyKey:'ask-1'}]] as const)
    await assert.rejects(async()=>client.ask(data as never,options as never),(error:unknown)=>error instanceof KnowledgeClientError&&error.code==='CLIENT_VALIDATION_ERROR'&&error.commitStatus==='not_committed');
  for(const [answerId,purpose] of [['bad-id',request.purpose],[id,'']])
    assert.throws(()=>client.answer(answerId,purpose),(error:unknown)=>error instanceof KnowledgeClientError&&error.code==='CLIENT_VALIDATION_ERROR');
  assert.equal(calls,0);
});

test('unknown Ask write outcome is not marked retryable; caller can read by known id',async()=>{
  let calls=0;
  const client=createKnowledgeClient({baseUrl:'http://localhost',scope,fetch:async(input,init)=>{
    calls++;
    if(init?.method==='POST')throw Error('connection lost after send');
    assert.match(String(input),new RegExp(`/answers/${id}\\?purpose=exploration_reading$`));
    return new Response(JSON.stringify(envelope(answer)),{status:200});
  }});
  await assert.rejects(client.ask(request,{idempotencyKey:'ask-unknown'}),(error:unknown)=>error instanceof KnowledgeClientError&&error.commitStatus==='unknown'&&error.retryable===false&&error.code==='TRANSPORT_OUTCOME_UNKNOWN');
  assert.equal(calls,1,'SDK must not retry an uncertain write');
  assert.equal((await client.answer(id,request.purpose)).data.state,'reserved');
  assert.equal(calls,2);
});

test('a server error with unknown commit never recommends retrying Ask',async()=>{
  let calls=0;
  const client=createKnowledgeClient({baseUrl:'http://localhost',scope,fetch:async()=>{
    calls++;
    return new Response(JSON.stringify({requestId:'server-request',code:'ASK_OUTCOME_UNKNOWN',message:'Execution may have started',retryable:true,commitStatus:'unknown',operationId:id}),{status:503});
  }});
  await assert.rejects(client.ask(request,{idempotencyKey:'ask-unknown-server'}),(error:unknown)=>
    error instanceof KnowledgeClientError&&error.commitStatus==='unknown'&&error.retryable===false&&error.operationId===id);
  assert.equal(calls,1);
});

test('lookupAnswer uses read-only route and returns an unknown outcome without resubmitting',async()=>{
  const sent:Array<{url:URL;method:string|undefined}>=[];
  const client=createKnowledgeClient({baseUrl:'http://localhost',scope,fetch:async(input,init)=>{
    sent.push({url:new URL(String(input)),method:init?.method});
    return new Response(JSON.stringify(envelope({state:'unknown',answer:null})),{status:200});
  }});
  const lookup=await client.lookupAnswer('ask key/+?',request.purpose);
  assert.deepEqual(lookup.data,{state:'unknown',answer:null});
  assert.equal(sent.length,1);
  assert.equal(sent[0]!.method,'GET');
  assert.equal(sent[0]!.url.pathname,'/api/v1/projects/test-project/spaces/test-space/knowledge/answers/lookup');
  assert.equal(sent[0]!.url.searchParams.get('key'),'ask key/+?');
  assert.equal(sent[0]!.url.searchParams.get('purpose'),request.purpose);
});

test('lookupAnswer validates parameters and a committed result',async()=>{
  let calls=0;
  const client=createKnowledgeClient({baseUrl:'http://localhost',scope,fetch:async()=>{
    calls++;
    return new Response(JSON.stringify(envelope({state:'committed',answer})),{status:200});
  }});
  assert.equal((await client.lookupAnswer('ask-key',request.purpose)).data.answer?.id,id);
  assert.throws(()=>client.lookupAnswer('',request.purpose),(error:unknown)=>error instanceof KnowledgeClientError&&error.code==='CLIENT_VALIDATION_ERROR');
  assert.throws(()=>client.lookupAnswer('ask-key',''),(error:unknown)=>error instanceof KnowledgeClientError&&error.code==='CLIENT_VALIDATION_ERROR');
  assert.equal(calls,1);
});

test('Ask responses are schema checked and answer purpose must match',async()=>{
  const malformed=createKnowledgeClient({baseUrl:'http://localhost',scope,fetch:async()=>new Response(JSON.stringify(envelope({...answer,state:'answered'})),{status:200})});
  await assert.rejects(malformed.ask(request,{idempotencyKey:'ask-2'}),(error:unknown)=>error instanceof KnowledgeClientError&&error.code==='MALFORMED_RESPONSE'&&error.commitStatus==='unknown');
  const mismatched=createKnowledgeClient({baseUrl:'http://localhost',scope,fetch:async()=>new Response(JSON.stringify(envelope({...answer,purpose:'another-purpose'})),{status:200})});
  await assert.rejects(mismatched.answer(id,request.purpose),(error:unknown)=>error instanceof KnowledgeClientError&&error.code==='ANSWER_IDENTITY_MISMATCH');
  const wrongId=createKnowledgeClient({baseUrl:'http://localhost',scope,fetch:async()=>new Response(JSON.stringify(envelope({...answer,id:'22222222-2222-4222-8222-222222222222'})),{status:200})});
  await assert.rejects(wrongId.answer(id,request.purpose),(error:unknown)=>error instanceof KnowledgeClientError&&error.code==='ANSWER_IDENTITY_MISMATCH');
});
