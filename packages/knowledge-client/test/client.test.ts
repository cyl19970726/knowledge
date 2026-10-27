import assert from 'node:assert/strict';
import test from 'node:test';
import { createKnowledgeClient, KnowledgeClientError } from '../src/index.js';
const scope={projectId:'local-perseek',spaceId:'demo'};
const at='2026-10-26T01:00:00Z';
const id='11111111-1111-4111-8111-111111111111';
const envelope=(data:unknown)=>({contractVersion:'1.0.0',requestId:'r',effectiveScope:scope,observedAt:at,data,warnings:[]});
test('node fetch injection validates both input and output',async()=>{
  let calls=0;
  const client=createKnowledgeClient({baseUrl:'http://localhost:8765',scope,fetch:async(input)=>{calls++;assert.match(String(input),/projects\/local-perseek\/spaces\/demo\/knowledge\/profiles$/);return new Response(JSON.stringify(envelope([])),{status:200,headers:{'content-type':'application/json'}});}});
  assert.deepEqual((await client.profiles()).data,[]);
  assert.equal(calls,1);
  await assert.rejects(client.query({question:'',purpose:'exploration_reading',limit:1}),/too_small|Too small|Invalid/);
  assert.equal(calls,1);
});
test('missing mutation response preserves unknown commit and can be reconciled by key',async()=>{
  let lookupUrl='';
  const client=createKnowledgeClient({baseUrl:'http://localhost:8765',scope,fetch:async(input,init)=>{if(init?.method==='POST') throw new Error('connection lost'); lookupUrl=String(input);return new Response(JSON.stringify(envelope({state:'unknown',operation:null,reservationState:null})),{status:200});}});
  const input={context:{adapterId:'demo',externalId:'task',contextVersion:'1',inputDigest:'a'.repeat(64),authority:'caller_reported' as const,description:'demo'},readReceiptId:id,purpose:'exploration_reading',considered:[],gaps:[],cost:{modelCalls:{state:'unknown' as const,reason:'not supplied'},tokens:{state:'unknown' as const,reason:'not supplied'},money:{state:'unknown' as const,reason:'not supplied'}}};
  await assert.rejects(client.recordUse(input,{idempotencyKey:'key-1'}),(e:unknown)=>e instanceof KnowledgeClientError&&e.commitStatus==='unknown'&&e.code==='TRANSPORT_OUTCOME_UNKNOWN');
  assert.equal((await client.lookupOperation({purpose:'exploration_reading',operation:'uses',key:'key-1'})).data.state,'unknown');
  assert.match(lookupUrl,/operations\/lookup\?operation=uses&key=key-1/);
});
test('structured server error and malformed successful response are not accepted',async()=>{
  const client=createKnowledgeClient({baseUrl:'http://localhost',scope,fetch:async()=>new Response(JSON.stringify({requestId:'r',code:'READSET_CHANGED',message:'changed',retryable:false,commitStatus:'not_committed'}),{status:409})});
  await assert.rejects(client.profiles(),(e:unknown)=>e instanceof KnowledgeClientError&&e.code==='READSET_CHANGED'&&e.commitStatus==='not_committed');
  const bad=createKnowledgeClient({baseUrl:'http://localhost',scope,fetch:async()=>new Response(JSON.stringify(envelope({not:'a list'})),{status:200})});
  await assert.rejects(bad.profiles(),(e:unknown)=>e instanceof KnowledgeClientError&&e.code==='MALFORMED_RESPONSE');
});
test('feedback and reconciliation require and transmit their explicit purpose',async()=>{
 const sent:Array<{url:string;body:unknown}>=[];
 const feedback={purpose:'review_correction',useId:null,context:{adapterId:'document',externalId:'synthetic-purpose',contextVersion:'1',inputDigest:'a'.repeat(64),authority:'caller_reported' as const,description:'Synthetic purpose boundary'},knowledgeRefs:[],feedbackKey:'synthetic-purpose-feedback',status:'not_observed' as const,observedAt:null,observation:null,rawQuotation:null,interpretation:null,recommendation:null,artifactDigest:null,measurementScope:null,cost:{modelCalls:{state:'unknown' as const,reason:'unmeasured'},tokens:{state:'unknown' as const,reason:'unmeasured'},money:{state:'unknown' as const,reason:'unmeasured'}},gaps:[]};
 const record={...feedback,id,version:'1',digest:'b'.repeat(64),supersedes:null,sourceRef:null,maintenanceState:'not_requested'};
 const client=createKnowledgeClient({baseUrl:'http://localhost',scope,fetch:async(url,init)=>{
  sent.push({url:String(url),body:init?.body?JSON.parse(String(init.body)):null});
  if(String(url).includes('/operations/lookup'))return new Response(JSON.stringify(envelope({state:'unknown',operation:null,reservationState:null})),{status:200});
  if(String(url).includes('/feedback'))return new Response(JSON.stringify(envelope(record)),{status:200});
  return new Response(JSON.stringify({requestId:'r',code:'NOT_FOUND',message:'Synthetic unavailable',retryable:false,commitStatus:'not_committed'}),{status:404});
 }});
 await client.recordFeedback(feedback,{idempotencyKey:'purpose-feedback'});
 assert.equal((sent[0].body as typeof feedback).purpose,'review_correction');
 assert.equal((await client.feedback(id,'review_correction')).data.purpose,'review_correction');
 await client.lookupOperation({operation:'feedback:write',key:'purpose-feedback',purpose:'review_correction'});
 await assert.rejects(client.operation(id,'review_correction'),(e:unknown)=>e instanceof KnowledgeClientError&&e.code==='NOT_FOUND');
 await assert.rejects(client.use(id,'review_correction'),(e:unknown)=>e instanceof KnowledgeClientError&&e.code==='NOT_FOUND');
 for(const request of sent.slice(1))assert.equal(new URL(request.url).searchParams.get('purpose'),'review_correction');
 const count=sent.length;
 assert.throws(()=>client.feedback(id,undefined as unknown as string));
 assert.throws(()=>client.lookupOperation({operation:'feedback:write',key:'purpose-feedback'} as never));
 assert.equal(sent.length,count,'missing purpose must fail before transport');
});
test('local write validation is definitely not committed and never reaches fetch',async()=>{
 let calls=0;const client=createKnowledgeClient({baseUrl:'http://localhost',scope,fetch:async()=>{calls++;throw new Error('must not be reached');}});
 await assert.rejects(async()=>client.recordUse({context:{description:'Invalid synthetic input'}} as never,{idempotencyKey:'validation-key'}),
  (e:unknown)=>e instanceof KnowledgeClientError&&e.code==='CLIENT_VALIDATION_ERROR'&&e.commitStatus==='not_committed'&&e.retryable===false);
 assert.equal(calls,0);
});
