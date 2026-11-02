import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createHttpSourceOwner} from '../../../packages/adapters/knowledge-service/src/source-owner.ts';
import {BoundedSourceOwnerRequestSchema,SourceOwnerRequestSchema} from '../../../packages/knowledge-contracts/src/index.ts';
import type {ReadContext} from '../../../packages/knowledge-application/src/index.ts';

const scope={projectId:'synthetic-http',spaceId:'synthetic-space'},text='  原始报告\n';
const digest=createHash('sha256').update(text).digest('hex');
const ref={...scope,domain:'analysis' as const,objectId:randomUUID(),versionId:randomUUID(),contentDigest:digest};
const context:ReadContext={scope,purpose:'exploration_reading',principal:{id:'synthetic-reader',clientInstallationId:'test',projectId:scope.projectId,spaceIds:[scope.spaceId],purposes:['exploration_reading']}};
const content={ref,contentDigest:digest,content:text,anchor:null,
  actualCoverage:{sourceRef:ref,anchors:[],byteCount:Buffer.byteLength(text),coverage:'full',exclusions:['Only report text, no frames'],readAt:new Date().toISOString(),readerAuthority:'synthetic-owner',readProofId:randomUUID()},
  readability:{metadataVisible:true,contentReadable:true,anchorResolved:true,assurance:'read_time_only',reasons:[]}};
const code=(expected:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&error.code===expected;
const make=(fetch:typeof globalThis.fetch,supportsBoundedContent=true)=>createHttpSourceOwner({baseUrl:'http://127.0.0.1:1234/owner',token:'synthetic-secret-at-least-24-characters',fetch,supportsBoundedContent});

test('bounded request uses its own strict endpoint and retains exact whitespace and UTF-8 bytes',async()=>{
  const sent:Array<{url:string;body:unknown}>=[];
  const owner=make(async(input,init)=>{sent.push({url:String(input),body:JSON.parse(String(init?.body))});return new Response(JSON.stringify(content));});
  const result=await owner.readContentBounded!(scope,ref,null,context,Buffer.byteLength(text));
  assert.equal(result?.content,text);assert.equal(result?.actualCoverage.byteCount,Buffer.byteLength(text));
  assert.equal(new URL(sent[0].url).pathname,'/owner/content-bounded');
  assert.equal(BoundedSourceOwnerRequestSchema.parse(sent[0].body).maxBytes,Buffer.byteLength(text));
  assert.equal(SourceOwnerRequestSchema.safeParse(sent[0].body).success,false,'old endpoint must not silently ignore a maxBytes field');
});

test('missing bounded support and invalid limits never send an HTTP request',async()=>{
  let calls=0;const fetcher:typeof globalThis.fetch=async()=>{calls++;throw new Error('Unexpected HTTP');};
  const old=make(fetcher,false);
  await assert.rejects(old.readContentBounded!(scope,ref,null,context,10),code('BOUNDED_SOURCE_READ_UNSUPPORTED'));
  const current=make(fetcher);
  for(const amount of [-1,1_000_001,1.5,NaN])await assert.rejects(current.readContentBounded!(scope,ref,null,context,amount));
  assert.equal(calls,0);
});

test('bounded response rejects over-budget text, wrong references, usage and forbidden media',async()=>{
  const variants:Array<[unknown,number,string]>=[
    [content,1,'SOURCE_READ_BUDGET_EXCEEDED'],
    [{...content,ref:{...ref,spaceId:'other'}},1000,'SOURCE_REF_MISMATCH'],
    [{...content,actualCoverage:{...content.actualCoverage,byteCount:1}},1000,'SOURCE_CONTENT_INTEGRITY'],
    [{...content,content:'tampered'},1000,'SOURCE_CONTENT_INTEGRITY'],
    [{...content,media:{kind:'image',mimeType:'image/png',base64:'AA==',byteCount:1,digest:'a'.repeat(64)}},1000,'SOURCE_CONTENT_UNSUPPORTED'],
  ];
  for(const [body,limit,expected] of variants){
    const owner=make(async()=>new Response(JSON.stringify(body)));
    await assert.rejects(owner.readContentBounded!(scope,ref,null,context,limit),code(expected));
  }
});

test('bounded envelope stream is capped even without a truthful content-length',async()=>{
  let cancelled=false;
  const owner=make(async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(100_001));},cancel(){cancelled=true;}})));
  await assert.rejects(owner.readContentBounded!(scope,ref,null,context,0),code('SOURCE_OWNER_RESPONSE_INVALID'));
  assert.equal(cancelled,true);
});

test('manual source read keeps the legacy content endpoint and remote bounded refusal is explicit',async()=>{
  let path='',body:Record<string,unknown>={};
  const owner=make(async(input,init)=>{path=new URL(String(input)).pathname;body=JSON.parse(String(init?.body));return new Response(JSON.stringify(content));},false);
  assert.equal((await owner.readContent(scope,ref,null,context))?.content,text);
  assert.equal(path,'/owner/content');assert.equal('maxBytes' in body,false);
  const refused=make(async()=>new Response(JSON.stringify({code:'BOUNDED_SOURCE_READ_UNSUPPORTED'}),{status:503}));
  await assert.rejects(refused.readContentBounded!(scope,ref,null,context,1000),code('BOUNDED_SOURCE_READ_UNSUPPORTED'));
});
