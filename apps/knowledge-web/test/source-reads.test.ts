import assert from 'node:assert/strict';
import test from 'node:test';
import {KnowledgeClientError,type KnowledgeClient} from '@commerce/knowledge-client';
import type {KnowledgeRef,SourceRecord,SourceContent} from '@commerce/knowledge-contracts';
import {SourceReads} from '../src/source-reads.ts';
type Client=Pick<KnowledgeClient,'source'|'sourceContent'>;
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const a={projectId:'synthetic',spaceId:'space',domain:'analysis',objectId:'00000000-0000-4000-8000-000000000001',versionId:'00000000-0000-4000-8000-000000000002',contentDigest:null} as KnowledgeRef;
const b={...a,objectId:'00000000-0000-4000-8000-000000000003'};
const metadata=(ref:KnowledgeRef)=>({data:{ref:{...ref,contentDigest:'a'.repeat(64)},readability:{contentReadable:true}} as SourceRecord}) as Awaited<ReturnType<Client['source']>>;
const content=(ref:KnowledgeRef,text:string)=>({data:{ref,content:text,anchor:null} as SourceContent}) as Awaited<ReturnType<Client['sourceContent']>>;
function view(){const state={ref:'previous',text:'previous text',error:'previous error',status:'content_read',anchor:''};return {state,observer:{
  start:()=>{state.ref='';state.text='';state.error='';state.status='loading';state.anchor='';},metadata:(value:SourceRecord)=>{state.ref=value.ref.objectId;state.status='metadata';},
  content:(value:SourceContent)=>{state.text=value.content;state.status='content_read';},error:(error:unknown)=>{state.error=String(error);state.status='error';},anchor:(message:string)=>{state.anchor=message;}}};}

test('A metadata arriving after B cannot start an A content read or overwrite B',async()=>{
  const pending=deferred<Awaited<ReturnType<Client['source']>>>(),reads:string[]=[],loader=new SourceReads(),v=view();
  const client:Client={source:async ref=>ref.objectId===a.objectId?pending.promise:metadata(ref),sourceContent:async ref=>{reads.push(ref.objectId);return content(ref,'B exact body');}};
  const first=loader.open(client,a,'reading',null,v.observer);assert.equal(v.state.text,'');assert.equal(v.state.status,'loading');
  await loader.open(client,b,'reading',null,v.observer);pending.resolve(metadata(a));await first;
  assert.deepEqual(reads,[b.objectId]);assert.equal(v.state.ref,b.objectId);assert.equal(v.state.text,'B exact body');assert.equal(v.state.error,'');
});

test('late A content cannot overwrite a failed B read or retain the previous body',async()=>{
  const pending=deferred<Awaited<ReturnType<Client['sourceContent']>>>(),started=deferred<void>(),loader=new SourceReads(),v=view();let oldSignal:AbortSignal|undefined;
  const client:Client={source:async ref=>metadata(ref),sourceContent:async(ref,_purpose,_anchor,opts)=>{if(ref.objectId===a.objectId){oldSignal=opts?.signal;started.resolve();return pending.promise;}throw new Error('B forbidden');}};
  const first=loader.open(client,a,'reading',null,v.observer);await started.promise;
  await loader.open(client,b,'reading',null,v.observer);assert.equal(oldSignal?.aborted,true);
  assert.equal(v.state.text,'');assert.equal(v.state.ref,b.objectId);assert.match(v.state.error,/B forbidden/);assert.equal(v.state.status,'error');
  pending.resolve(content(a,'A late body'));await first;
  assert.equal(v.state.text,'');assert.equal(v.state.ref,b.objectId);assert.match(v.state.error,/B forbidden/);
});

test('leaving the source page cancels in-flight content and suppresses late failure or read status',async()=>{
  const pending=deferred<Awaited<ReturnType<Client['sourceContent']>>>(),started=deferred<void>(),loader=new SourceReads(),v=view();
  const client:Client={source:async ref=>metadata(ref),sourceContent:async()=>{started.resolve();return pending.promise;}};
  const first=loader.open(client,a,'reading',null,v.observer);await started.promise;
  loader.cancel();pending.reject(new Error('late response after leaving'));await first;
  assert.equal(v.state.text,'');assert.equal(v.state.error,'');assert.notEqual(v.state.status,'content_read');
});

test('unresolved anchor fallback retains the owner-resolved digest and does not claim content before receipt',async()=>{
  const loader=new SourceReads(),v=view(),calls:Array<{ref:KnowledgeRef;anchor:unknown}>=[];
  const client:Client={source:async ref=>metadata(ref),sourceContent:async(ref,_purpose,anchor)=>{calls.push({ref,anchor});
    assert.equal(v.state.status,'metadata');assert.equal(v.state.text,'');
    if(anchor)throw new KnowledgeClientError({code:'SOURCE_ANCHOR_UNRESOLVED',message:'unresolved'});return content(ref,'exact whole report');}};
  await loader.open(client,a,'reading','paragraph:99',v.observer);
  assert.equal(calls.length,2);assert.ok(calls.every(call=>call.ref.contentDigest==='a'.repeat(64)));
  assert.equal(v.state.text,'exact whole report');assert.match(v.state.anchor,/未确认此引用锚点/);
});
