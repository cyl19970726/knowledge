import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {digest} from '@commerce/knowledge-core/utils';
import {syntheticRevision} from '../../../scripts/runtime/wiki-query-baseline.ts';
import {askAnswerFingerprint,type AskAnswerReader} from '../src/ask.ts';
import {createWikiCompileApplication,type WikiCompileOperationPort,type WikiCompileStageInput} from '../src/wiki-compile.ts';
import type {KnowledgeApplication,BoundedWikiPage} from '../src/index.ts';
import type {CapabilityContext} from '../src/sources.ts';
import type {AskResult,KnowledgeRef,WikiCompileRequest,WikiCompileResult} from '@commerce/knowledge-contracts';

const scope={projectId:'answer-compile-fixture',spaceId:'answer-space'},purpose='exploration_reading';
const context:CapabilityContext={scope,purpose,principal:{id:'answer-researcher',clientInstallationId:'answer-install',projectId:scope.projectId,
 spaceIds:[scope.spaceId],purposes:[purpose]},authorization:{actions:['compile:read','compile:write'],adapterIds:[],rightsPolicyIds:[]}};
const zero={modelCalls:{state:'known' as const,value:0},tokens:{state:'known' as const,value:0},money:{state:'known' as const,amount:0,currency:'USD',source:'synthetic-local-fixture'}};
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const code=(expected:string)=>(error:unknown)=>error instanceof KnowledgeError&&error.code===expected;

function page(label:string):BoundedWikiPage{
 const revision=syntheticRevision({id:randomUUID(),versionId:randomUUID(),title:`准确背景${label}`,body:`合成认识${label}`,sourceGroup:'synthetic:original',
  aliases:[],spaceId:scope.spaceId},scope.projectId);
 if(revision.kind!=='wiki_page')throw new Error('Synthetic fixture must be Wiki');
 return {ref:{...scope,domain:'knowledge',...revision.ref,contentDigest:digest(revision)},title:revision.title,body:revision.body,
  conditions:revision.content.conditions,counterexamples:revision.content.counterexamples,unknowns:revision.content.unknowns,
  citations:[],sourceGroups:revision.sourceGroups,storageDigest:'b'.repeat(64),payloadBytes:100,admitted:true,frozenRevision:revision};
}
function fixture(options:{sourceError?:KnowledgeError}={}){
 const a=page('A'),b=page('B'),sourceText='合成原始来源，仅验证答复回流的准确正文。';
 const source:KnowledgeRef={...scope,domain:'source',objectId:randomUUID(),versionId:randomUUID(),contentDigest:sha(sourceText)};
 const createdAt=new Date().toISOString(),deadline=new Date(Date.now()+60_000).toISOString(),answer:AskResult={id:randomUUID(),question:'原答复问题',purpose,state:'answered',
  claims:[{text:'回答中的受限主张',evidenceIds:['old-a','old-source']}],evidence:[
   ...[a,b].map((item,index)=>({id:index?'old-b':'old-a',kind:'wiki_page' as const,ref:item.ref,title:item.title,locator:null,
    storageDigest:item.storageDigest,conditions:[],counterexamples:[],unknowns:[],actualReadCoverage:[]})),
   {id:'old-source',kind:'source_content',ref:source,title:'原始来源',locator:null,conditions:[],counterexamples:[],unknowns:[],actualReadCoverage:[]}],
  excluded:[],coverage:{scopeDescription:'synthetic complete answer readset',returned:3,loaded:3,hasMore:false,nextCursor:null,
   completeness:'bounded',omittedReasons:[],snapshot:{publicationEpoch:1,consistency:'single_scope_snapshot'}},
  readsetFingerprint:'c'.repeat(64),cost:zero,provider:{id:'synthetic-answerer',modelRequested:'synthetic-local',modelReturned:'synthetic-local',requestId:null},
  reason:'Synthetic cited answer',gaps:['Original answer has an unresolved question'],createdAt,completedAt:createdAt};
 const fingerprint=askAnswerFingerprint(answer),seed={answerId:answer.id,expectedAnswerFingerprint:fingerprint,claimIndexes:[0]};
 const answerModes:('current'|'historical')[]=[];
 let saved:WikiCompileResult|null=null,savedKey:string|null=null,savedDigest:string|null=null,providerCalls=0,sourceReads=0,exactReads=0,
  answerReads=0,revoked=false,stageInput:WikiCompileStageInput|null=null,providerInput:Parameters<Parameters<typeof createWikiCompileApplication>[0]['provider']['compile']>[0]|null=null;
 const operations:WikiCompileOperationPort={async reserve(_ctx,key,inputDigest,_request,initial){
   if(savedKey===key){if(savedDigest!==inputDigest)throw new KnowledgeError('IDEMPOTENCY_CONFLICT','Frozen request changed',409);
    return {created:false,result:saved!};}
   savedKey=key;savedDigest=inputDigest;saved=structuredClone(initial);return {created:true,result:initial};},async start(){return true;},
  async checkpoint(_ctx,_id,value){saved=structuredClone(value);},async finish(_ctx,_id,value){saved=structuredClone(value);},
  async get(){return saved;},async lookup(_ctx,key){return key===savedKey?saved:null;}};
 const answers:AskAnswerReader={async get(_ctx,id,mode='current'){answerReads++;answerModes.push(mode);
   if(id!==answer.id)throw new KnowledgeError('NOT_FOUND','No answer',404);
   if(revoked)throw new KnowledgeError('ASK_READSET_INVALIDATED','Original source withdrawn',409);
   return {...structuredClone(answer),answerFingerprint:fingerprint};},async lookup(){return {state:'unknown',answer:null};}};
 const reader={async queryCandidates(){return {data:{items:[]},coverage:{scopeDescription:'synthetic',returned:0,loaded:0,hasMore:false,nextCursor:null,
   completeness:'complete' as const,omittedReasons:[],snapshot:{publicationEpoch:1,consistency:'single_scope_snapshot' as const}}};},
  async readCandidate(){assert.fail('Lexical miss must not replace explicit old inputs');},
  async readWikiExactBounded(_ctx:unknown,ref:KnowledgeRef,maxBytes:number){exactReads++;
   const found=[a,b].find(item=>item.ref.objectId===ref.objectId);
   if(!found)throw new KnowledgeError('NOT_FOUND','Exact Wiki absent',404);
   if(found.payloadBytes>maxBytes)throw new KnowledgeError('KNOWLEDGE_READ_BUDGET_EXCEEDED','Exact Wiki too large',422);return found;},
  async validateFrozenWiki(){if(revoked)throw new KnowledgeError('ASK_READSET_INVALIDATED','Source withdrawn',409);},
  async validateHistoricalWiki(){if(revoked)throw new KnowledgeError('ASK_READSET_INVALIDATED','Source withdrawn',409);},
  async assertReadEpoch(_ctx:unknown,epoch:number|null){assert.equal(epoch,1);},
  async sourceRecord(){sourceReads++;if(revoked)throw new KnowledgeError('SOURCE_FORBIDDEN','Source withdrawn',403);
   return {readability:{metadataVisible:true,contentReadable:true},sourceGroups:[],limitations:[]};},
  async sourceContentBounded(_ctx:unknown,ref:KnowledgeRef,_anchor:unknown,maxBytes:number){
   if(options.sourceError)throw options.sourceError;
   if(ref.objectId!==source.objectId)throw new KnowledgeError('NOT_FOUND','Exact source absent',404);
   if(Buffer.byteLength(sourceText)>maxBytes)throw new KnowledgeError('SOURCE_READ_BUDGET_EXCEEDED','Source too large',422);
   return {content:sourceText,actualCoverage:{sourceRef:source,anchors:[],byteCount:Buffer.byteLength(sourceText),coverage:'full',
    exclusions:[],readAt:createdAt,readerAuthority:'synthetic-fixture',readProofId:randomUUID()}};}} as unknown as KnowledgeApplication;
 const app=createWikiCompileApplication({reader,answers,operations,intake:{async get(){return {request:{sourceRef:source}} as never;}},
  provider:{id:'answer-compile-local',model:'synthetic-no-model',methodVersion:'answer-compile-fixture-v1',execution:'local_deterministic',
   async compile(input){providerCalls++;providerInput=structuredClone(input);
    return {proposal:{outcome:'proposed',drafts:[{targetEvidenceId:null,profile:input.profiles.find(item=>item.id==='question')!,
     identityKey:'answer-derived-synthetic',title:'合成答复后的研究候选',summary:'旧答复的完整来源与背景已重读。',
     conditions:['仅用于合成工程验证'],counterexamples:[],unknowns:['真实语义未验'],nextQuestions:[],
     supportEvidenceIds:[input.evidence.find(item=>item.ref.objectId===a.ref.objectId)!.id,
      input.evidence.find(item=>item.ref.objectId===source.objectId)!.id],rationale:'本轮准确读到的正文'}],
     reason:'Synthetic proposal only',gaps:[]},cost:zero,modelReturned:'synthetic-no-model',requestId:'synthetic-answer-compile'};}},
  stage:{async stage(_ctx,input){stageInput=input;return {candidateId:input.operationId,changeSetId:input.operationId,
   draftRefs:[],contentHash:'a'.repeat(64),published:false};}}});
 const request=(extra:Partial<WikiCompileRequest>={}):WikiCompileRequest=>({question:'深入研究原答复',purpose,sourceEventIds:[],
  selectedRefs:[a.ref,b.ref],sourceRefs:[source],answerSeed:seed,queries:['不会命中旧页的词'],limit:3,maxPages:1,
  budget:{maxModelCalls:0,maxReadBytes:100_000,maxMoney:{amount:0,currency:'USD'},deadline},...extra});
 return {app,request,answer,seed,a,b,source,stats:()=>({saved,savedKey,providerCalls,sourceReads,exactReads,answerReads,answerModes,stageInput,providerInput}),
  revoke:()=>{revoked=true;}};
}

test('answer origin freezes the complete old readset and remaps cited claims to real newly read evidence',async()=>{
 const f=fixture(),request=f.request({limit:2}),result=await f.app.compile(context,request,'answer-compile');
 assert.equal(result.state,'waiting_for_review');assert.equal(result.answerOrigin?.answerFingerprint,f.seed.expectedAnswerFingerprint);
 assert.deepEqual(result.answerOrigin?.claimIndexes,[0]);assert.equal(result.evidence.length,3);
 assert.equal(result.evidence.filter(item=>item.kind==='wiki_page').length,2,'Wiki limit excludes the separate exact source read');
 assert.equal(f.stats().exactReads,2);assert.equal(f.stats().providerCalls,1);
 const proposed=f.stats().providerInput!.answerSeed!;
 assert.equal(proposed.question,'原答复问题');assert.deepEqual(proposed.gaps,['Original answer has an unresolved question']);
 assert.deepEqual(proposed.claims[0].evidenceIds,[`wiki:${f.a.ref.objectId}:${f.a.ref.versionId}`,
  `source:source:${f.source.objectId}:${f.source.versionId}`]);
 assert.equal(f.stats().stageInput?.bases.size,2);assert.equal(f.stats().stageInput?.evidence.length,3);
 assert.equal((await f.app.compile(context,request,'answer-compile')).id,result.id);assert.equal(f.stats().providerCalls,1);
});

test('legacy source flow keeps limit as Wiki count when source and one Wiki are both read',async()=>{
 const f=fixture();
 const result=await f.app.compile(context,f.request({answerSeed:undefined,selectedRefs:[f.a.ref],limit:1}),'legacy-limit-one');
 assert.equal(result.state,'waiting_for_review');
 assert.equal(result.evidence.length,2);
 assert.equal(result.evidence.filter(item=>item.kind==='wiki_page').length,1);
 assert.equal(result.evidence.filter(item=>item.kind==='source_content').length,1);
 assert.equal(f.stats().providerCalls,1);
});

test('registered source event and direct exact source deduplicate while preserving the old event evidence ID',async()=>{
 const f=fixture(),eventId=randomUUID(),withIngest={...context,authorization:{...context.authorization,actions:[...context.authorization.actions,'ingest:read']}};
 const result=await f.app.compile(withIngest,f.request({sourceEventIds:[eventId],limit:2}),'event-and-direct-source');
 assert.equal(result.state,'waiting_for_review');assert.equal(result.evidence.length,3);
 assert.deepEqual(result.evidence.filter(item=>item.kind==='source_content').map(item=>item.id),[`source:${eventId}`]);
 assert.equal(f.stats().providerCalls,1);
});

test('answer fingerprint, claim index, missing background, extra ref and foreign scope fail before reserve or provider',async()=>{
 const f=fixture();
 await assert.rejects(f.app.compile(context,f.request({answerSeed:{...f.seed,expectedAnswerFingerprint:'f'.repeat(64)}}),'fingerprint'),code('ANSWER_FINGERPRINT_MISMATCH'));
 await assert.rejects(f.app.compile(context,f.request({answerSeed:{...f.seed,claimIndexes:[9]}}),'claim'),code('ANSWER_CLAIM_INDEX_INVALID'));
 await assert.rejects(f.app.compile(context,f.request({selectedRefs:[f.a.ref]}),'missing-background'),code('ANSWER_READSET_MISMATCH'));
 await assert.rejects(f.app.compile(context,f.request({sourceRefs:[f.source,{...f.source,objectId:randomUUID()}]}),'extra'),code('ANSWER_READSET_MISMATCH'));
 await assert.rejects(f.app.compile(context,f.request({sourceRefs:[{...f.source,spaceId:'foreign'}]}),'scope'),code('SOURCE_REF_SCOPE_MISMATCH'));
 assert.equal(f.stats().savedKey,null);assert.equal(f.stats().providerCalls,0);
});

test('revocation hides the original answer origin before provider and on historical replay',async()=>{
 const f=fixture(),result=await f.app.compile(context,f.request(),'origin-replay');assert.equal(result.state,'waiting_for_review');
 f.stats().saved!.state='published';await f.app.get(context,result.id);
 assert.equal(f.stats().answerModes.at(-1),'historical');f.revoke();
 await assert.rejects(f.app.get(context,result.id),code('ASK_READSET_INVALIDATED'));
 await assert.rejects(f.app.compile(context,f.request(),'origin-replay'),code('ASK_READSET_INVALIDATED'));
 await assert.rejects(f.app.compile(context,f.request(),'new-key'),code('ASK_READSET_INVALIDATED'));
 assert.equal(f.stats().providerCalls,1);
});

test('a bounded image owner cannot be counted as text or sent to the compiler',async()=>{
 const f=fixture({sourceError:new KnowledgeError('SOURCE_CONTENT_UNSUPPORTED','Image is not bounded text',422)});
 const result=await f.app.compile(context,f.request(),'image-not-text');
 assert.equal(result.state,'failed');assert.match(result.reason,/SOURCE_CONTENT_UNSUPPORTED/);
 assert.equal(result.evidence.length,0);assert.equal(result.readUsage.sourceContentBytes,0);
 assert.equal(f.stats().providerCalls,0);
});

test('a source owner 409 preserves unknown physical read accounting and stops compilation',async()=>{
 const f=fixture({sourceError:new KnowledgeError('SOURCE_DIGEST_MISMATCH','Conflict after owner body read',409)});
 const result=await f.app.compile(context,f.request(),'source-unknown-bytes');
 assert.equal(result.state,'failed');assert.match(result.reason,/SOURCE_DIGEST_MISMATCH/);
 assert.ok(result.gaps.some(gap=>gap.includes('byte usage is unknown')));
 assert.equal(result.readUsage.sourceContentBytes,0);assert.equal(f.stats().exactReads,0);
 assert.equal(f.stats().providerCalls,0);
});
