import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {digest} from '@commerce/knowledge-core/utils';
import {syntheticRevision} from '../../../scripts/runtime/wiki-query-baseline.ts';
import {createWikiCompileApplication,type WikiCompileOperationPort,type WikiCompileStageInput} from '../src/wiki-compile.ts';
import type {KnowledgeApplication,BoundedWikiPage} from '../src/index.ts';
import type {CapabilityContext} from '../src/sources.ts';
import type {WikiCompileRequest,WikiCompileResult,RelationJudgment} from '../../knowledge-contracts/src/index.ts';

const zero={modelCalls:{state:'known' as const,value:0},tokens:{state:'known' as const,value:0},money:{state:'known' as const,amount:0,currency:'USD',source:'synthetic-local-fixture'}};
const scope={projectId:'selected-compile-synthetic',spaceId:'selected-space'},purpose='exploration_reading';
const context:CapabilityContext={scope,purpose,principal:{id:'synthetic-proposer',clientInstallationId:'selected-test',projectId:scope.projectId,spaceIds:[scope.spaceId],purposes:[purpose]},
 authorization:{actions:['compile:read','compile:write'],adapterIds:[],rightsPolicyIds:[]}};
function page(name:'A'|'B'):BoundedWikiPage{
 const revision=syntheticRevision({id:randomUUID(),versionId:randomUUID(),title:`合成准确页${name}`,body:`合成条件${name}，仅供准确选区编纂。`,sourceGroup:'synthetic:one-source',aliases:[],spaceId:scope.spaceId},scope.projectId);
 if(revision.kind!=='wiki_page')throw new Error('Synthetic fixture must be a Wiki page');
 return {ref:{...scope,domain:'knowledge' as const,...revision.ref,contentDigest:digest(revision)},title:revision.title,body:revision.body,conditions:revision.content.conditions,
  counterexamples:revision.content.counterexamples,unknowns:revision.content.unknowns,citations:[],sourceGroups:revision.sourceGroups,
  storageDigest:'b'.repeat(64),payloadBytes:100,admitted:true,frozenRevision:revision};
}
function fixture(options:{bounded?:boolean;lexicalDuplicate?:boolean;revokeDuringDispatch?:boolean;wrongDigest?:boolean;conflictAfterBody?:boolean}={}){
 const a=page('A'),b=page('B');let calls=0,queryCalls=0,reads=0,exactReads=0,providerCalls=0,stageInput:WikiCompileStageInput|null=null;
 const deadline=new Date(Date.now()+60_000).toISOString();
 let saved:WikiCompileResult|null=null,savedKey:string|null=null,savedDigest:string|null=null,revoked=false;
 const operations:WikiCompileOperationPort={async reserve(_context,key,inputDigest,_request,initial){calls++;
   if(savedKey===key){if(savedDigest!==inputDigest)throw new KnowledgeError('IDEMPOTENCY_CONFLICT','Changed input for original key',409);return {created:false,result:saved!};}
   savedKey=key;savedDigest=inputDigest;saved=initial;return {created:true,result:initial};},async start(){return true;},
  async checkpoint(_context,_id,result){saved=structuredClone(result);if(options.revokeDuringDispatch&&result.provider&&result.drafts.length===0)revoked=true;},
  async finish(_context,_id,result){saved=structuredClone(result);},async get(){return saved;},async lookup(){return saved;}};
 const coverage={scopeDescription:'synthetic selected',returned:0,loaded:0,hasMore:false,nextCursor:null,completeness:'complete' as const,omittedReasons:[],snapshot:{publicationEpoch:1,consistency:'single_scope_snapshot' as const}};
 const reader={async queryCandidates(){queryCalls++;return {data:{items:options.lexicalDuplicate?[{ref:{objectId:a.ref.objectId,versionId:a.ref.versionId},title:a.title,payloadBytes:a.payloadBytes,storageDigest:a.storageDigest}]:[]},coverage};},
  async readCandidate(){reads++;return a;},async validateFrozenWiki(){if(revoked)throw new KnowledgeError('SOURCE_FORBIDDEN','Synthetic critical source revoked',403);},
  async assertReadEpoch(){},async sourceRecord(){assert.fail('Wiki-only compilation must not read a source event');},
  async sourceContentBounded(){assert.fail('Wiki-only compilation must not materialize a source event');},
  ...options.bounded===false?{}:{async readWikiExactBounded(_context:unknown,ref:{objectId:string},maxBytes:number){exactReads++;
   const found=[a,b].find(item=>item.ref.objectId===ref.objectId)!;
   if(maxBytes<found.payloadBytes)throw new KnowledgeError('READ_BUDGET_EXCEEDED','Synthetic bounded read rejected',422);
   if(options.conflictAfterBody&&found.ref.objectId===b.ref.objectId)throw new KnowledgeError('EXACT_REF_MISMATCH','Synthetic conflict after an unreported bounded body read',409);
   return options.wrongDigest?{...found,ref:{...found.ref,contentDigest:'f'.repeat(64)}}:found;}}} as unknown as KnowledgeApplication;
 const seen:{evidence:readonly {ref:{objectId:string};id:string}[];hints:number}[]=[];
 const app=createWikiCompileApplication({reader,operations,intake:{async get(){assert.fail('No source event should be fetched');}},
  provider:{id:'synthetic-selected-compiler',model:'synthetic-no-model',methodVersion:'selected-compiler-test-v1',execution:'local_deterministic',
   async compile(input){providerCalls++;seen.push({evidence:input.evidence,hints:input.relationHints?.length??0});
    return {proposal:{outcome:'proposed',drafts:[{targetEvidenceId:null,profile:input.profiles.find(item=>item.id==='question')!,identityKey:'selected-synthesis',
     title:'选区合成候选',summary:'只对已读准确页提出合成候选',conditions:[],counterexamples:[],unknowns:['真实语义未验'],nextQuestions:[],
     supportEvidenceIds:input.evidence.map(item=>item.id),rationale:'准确选区读集'}],reason:'Synthetic only',gaps:[]},cost:zero,modelReturned:'synthetic-no-model',requestId:'fixture-request'};}},
  stage:{async stage(_context,input){stageInput=input;return {candidateId:input.operationId,changeSetId:input.operationId,draftRefs:[],contentHash:'a'.repeat(64),published:false};}},
  judgments:{async get(_context,id){return {id,state:'answered',inputFingerprint:'a'.repeat(64),sourceRelation:{},batch:{answers:[]},
   evidence:[{ref:a.ref},{ref:b.ref}]} as unknown as RelationJudgment;}}});
 const request=(extra:Partial<WikiCompileRequest>={}):WikiCompileRequest=>({question:'合成选区研究',purpose,sourceEventIds:[],selectedRefs:[a.ref,b.ref],queries:['词项无法命中准确A或B'],
  limit:3,maxPages:1,budget:{maxModelCalls:0,maxReadBytes:20_000,maxMoney:{amount:0,currency:'USD'},deadline},...extra});
 return {app,request,a,b,stats:()=>({calls,queryCalls,reads,exactReads,providerCalls,stageInput,seen,saved})};
}

test('selected A/B are bounded exact inputs even on lexical miss; actual readset admits both advisory endpoints',async()=>{
 const f=fixture(),judgmentId=randomUUID();const result=await f.app.compile(context,f.request({judgmentIds:[judgmentId]}),'selected-a-b');
 assert.equal(result.state,'waiting_for_review');assert.deepEqual(result.evidence.map(item=>item.ref.objectId),[f.a.ref.objectId,f.b.ref.objectId]);
 assert.equal(f.stats().exactReads,2);assert.equal(f.stats().queryCalls,1);assert.equal(f.stats().reads,0);
 assert.equal(f.stats().seen[0].hints,1);assert.equal(f.stats().stageInput?.bases.size,2);assert.deepEqual(f.stats().stageInput?.sourceProofs,[]);
 assert.equal((await f.app.compile(context,f.request({judgmentIds:[judgmentId]}),'selected-a-b')).id,result.id);
 assert.equal(f.stats().providerCalls,1,'same key only verifies the frozen result');
});

test('lexical duplicate of a selected exact version is never read again',async()=>{
 const f=fixture({lexicalDuplicate:true});const result=await f.app.compile(context,f.request(),'selected-dedup');
 assert.equal(result.state,'waiting_for_review');assert.equal(f.stats().reads,0);assert.equal(f.stats().exactReads,2);
 assert.equal(result.evidence.length,2);
});

test('an exact selection filling the Wiki limit still obtains an epoch before dispatch',async()=>{
 const f=fixture();const result=await f.app.compile(context,f.request({selectedRefs:[f.a.ref],limit:1}),'selected-full-limit');
 assert.equal(result.state,'waiting_for_review');assert.equal(result.coverage.snapshot.publicationEpoch,1);
 assert.equal(f.stats().queryCalls,1);assert.equal(f.stats().exactReads,1);assert.equal(f.stats().reads,0);
});

test('selected budget and pre-reserve scope/limit/bounded validations do not dispatch',async()=>{
 const f=fixture();const first=await f.app.compile(context,f.request(),'budget-reference');
 assert.ok(first.readUsage.preparedInputBytes>first.readUsage.wikiPayloadBytes);
 const g=fixture(),enough=first.readUsage.preparedInputBytes;
 const admitted=await g.app.compile(context,g.request({budget:{...g.request().budget,maxReadBytes:enough}}),'independent-budget-bounds');
 assert.equal(admitted.state,'waiting_for_review','serialized input reuses the same text and is not a second body read');
 assert.ok(admitted.readUsage.wikiPayloadBytes+admitted.readUsage.preparedInputBytes>enough);
 const h=fixture(),prepared=await h.app.compile(context,h.request({budget:{...h.request().budget,maxReadBytes:enough-1}}),'prepared-too-small');
 assert.equal(prepared.state,'failed');assert.match(prepared.reason,/PREPARED_INPUT_BUDGET_EXCEEDED/);
 assert.equal(prepared.readUsage.wikiPayloadBytes,first.readUsage.wikiPayloadBytes);assert.equal(h.stats().providerCalls,0);
 const physical=fixture(),physicalResult=await physical.app.compile(context,physical.request({budget:{...physical.request().budget,maxReadBytes:199}}),'physical-too-small');
 assert.equal(physicalResult.state,'failed');assert.match(physicalResult.reason,/READ_BUDGET_EXCEEDED/);
 assert.equal(physicalResult.readUsage.wikiPayloadBytes,100);assert.equal(physical.stats().providerCalls,0);
 const unavailable=fixture({bounded:false});await assert.rejects(unavailable.app.compile(context,unavailable.request(),'missing-bounded'),(error:unknown)=>error instanceof KnowledgeError&&error.code==='BOUNDED_WIKI_READ_UNSUPPORTED');
 assert.equal(unavailable.stats().calls,0);
 const i=fixture();await assert.rejects(i.app.compile(context,i.request({limit:1}),'limit'),(error:unknown)=>error instanceof KnowledgeError&&error.code==='SELECTED_WIKI_LIMIT_EXCEEDED');
 await assert.rejects(i.app.compile(context,i.request({selectedRefs:[{...i.a.ref,spaceId:'other-space'}]}),'scope'),(error:unknown)=>error instanceof KnowledgeError&&error.code==='SELECTED_REF_SCOPE_MISMATCH');
 await assert.rejects(i.app.compile(context,{...i.request(),selectedRefs:[],sourceEventIds:[]},'empty'));
 assert.equal(i.stats().calls,0);
});

test('stale selected digest cannot be replaced by lexical retrieval',async()=>{
 const f=fixture({wrongDigest:true,lexicalDuplicate:true});const result=await f.app.compile(context,f.request(),'bad-digest');
 assert.equal(result.state,'failed');assert.match(result.reason,/EXACT_REF_MISMATCH/);assert.equal(f.stats().queryCalls,0);assert.equal(f.stats().providerCalls,0);
 assert.equal(result.readUsage.wikiPayloadBytes,100,'returned mismatched body is a known physical read');
 assert.equal(result.evidence.length,0,'mismatched exact body is never admitted as compiler evidence');
});

test('409 from exact owner reports unknown byte usage and stops before another content read',async()=>{
 const f=fixture({conflictAfterBody:true});const result=await f.app.compile(context,f.request(),'unknown-exact-bytes');
 assert.equal(result.state,'failed');assert.match(result.reason,/EXACT_REF_MISMATCH/);
 assert.equal(result.readUsage.wikiPayloadBytes,100,'only the first confirmed body is counted');
 assert.ok(result.gaps.some(gap=>gap.includes('byte usage is unknown')));
 assert.equal(f.stats().exactReads,2);assert.equal(f.stats().queryCalls,0);assert.equal(f.stats().providerCalls,0);
});

test('critical source revocation during checkpoint prevents first response and provider dispatch',async()=>{
 const f=fixture({revokeDuringDispatch:true});await assert.rejects(f.app.compile(context,f.request(),'revoked-before-dispatch'),
  (error:unknown)=>error instanceof KnowledgeError&&error.code==='SOURCE_FORBIDDEN');
 assert.equal(f.stats().providerCalls,0);assert.equal(f.stats().stageInput,null);assert.equal(f.stats().saved?.state,'failed');
});
