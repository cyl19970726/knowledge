import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {AskRequest,AskResult,KnowledgeRef} from '@commerce/knowledge-contracts';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {askAnswerFingerprint,createAskAnswerReader,createAskWikiService,type AskOperationPort,type AskReader} from '../src/ask.ts';
import type {ReadContext,BoundedWikiPage} from '../src/index.ts';
import type {CapabilityContext} from '../src/sources.ts';

const scope={projectId:'answer-reader-project',spaceId:'answer-reader-space'},purpose='exploration_reading';
const context:ReadContext={scope,purpose,principal:{id:'answer-reader',clientInstallationId:'reader-installation',
  projectId:scope.projectId,spaceIds:[scope.spaceId],purposes:[purpose]}};
const ref=(domain:'knowledge'|'source'):KnowledgeRef=>({...scope,domain,objectId:randomUUID(),versionId:randomUUID(),contentDigest:'a'.repeat(64)});
function answered():AskResult{
  const wiki=ref('knowledge'),source=ref('source'),createdAt=new Date().toISOString();
  return {id:randomUUID(),question:'What does the exact basis say?',purpose,state:'answered',
    claims:[{text:'A cited claim',evidenceIds:['wiki']}],evidence:[
      {id:'wiki',kind:'wiki_page',ref:wiki,title:'Exact Wiki',locator:null,storageDigest:'b'.repeat(64),
        conditions:[],counterexamples:[],unknowns:[],actualReadCoverage:[]},
      {id:'source',kind:'source_content',ref:source,title:'Exact source',locator:null,
        conditions:[],counterexamples:[],unknowns:[],actualReadCoverage:[]}],
    excluded:[],coverage:{scopeDescription:'test scope',returned:2,loaded:2,hasMore:false,nextCursor:null,
      completeness:'bounded',omittedReasons:[],snapshot:{publicationEpoch:1,consistency:'single_scope_snapshot'}},
    readsetFingerprint:'c'.repeat(64),cost:{modelCalls:{state:'known',value:1},tokens:{state:'known',value:20},
      money:{state:'known',amount:0,currency:'USD',source:'synthetic'}},provider:{id:'synthetic',modelRequested:'local',
      modelReturned:'local',requestId:null},reason:'Cited',gaps:[],createdAt,completedAt:createdAt};
}
const hasCode=(code:string)=>(error:unknown)=>error instanceof KnowledgeError&&error.code===code;
function fixture(value:AskResult=answered()){
  let frozen=0,historical=0,sourceReads=0,operationReads=0,revoked=false;
  const operations={async get(_context:ReadContext,id:string){operationReads++;return id===value.id?value:null;},
    async lookup(_context:ReadContext,key:string){operationReads++;return key==='original-key'?value:null;}} as AskOperationPort;
  const reader={async validateFrozenWiki(){frozen++;},async validateHistoricalWiki(){historical++;},
    async sourceRecord(){sourceReads++;return {readability:{metadataVisible:true,contentReadable:!revoked}};}} as unknown as AskReader;
  return {answers:createAskAnswerReader({reader,operations}),value,revoke:()=>{revoked=true;},
    counts:()=>({frozen,historical,sourceReads,operationReads})};
}

test('fingerprint freezes answer substance while accounting and the derived field can change',()=>{
  const result=answered(),original=askAnswerFingerprint(result);
  assert.equal(askAnswerFingerprint({...result,cost:{...result.cost,tokens:{state:'known',value:200}},
    answerFingerprint:'0'.repeat(64)}),original);
  assert.notEqual(askAnswerFingerprint({...result,claims:[{text:'Different claim',evidenceIds:['wiki']}]}),original);
  assert.notEqual(askAnswerFingerprint({...result,reason:'A revised explanation'}),original);
  assert.notEqual(askAnswerFingerprint({...result,gaps:['A new gap']}),original);
});

test('answer reader recomputes old-row fingerprint, checks current rights and returns detached objects',async()=>{
  const f=fixture();const first=await f.answers.get(context,f.value.id);
  assert.equal(first.answerFingerprint,askAnswerFingerprint(f.value));
  first.claims[0].text='caller mutation';first.evidence[0].title='caller mutation';
  const second=await f.answers.lookup(context,'original-key');
  assert.equal(second.state,'committed');assert.equal(second.answer?.claims[0].text,'A cited claim');
  assert.equal(second.answer?.evidence[0].title,'Exact Wiki');
  assert.deepEqual(f.counts(),{frozen:2,historical:0,sourceReads:2,operationReads:2});
  assert.deepEqual(await f.answers.lookup(context,'missing'),{state:'unknown',answer:null});
});

test('historical Wiki validation still requires current source rights; scope fails before ledger access',async()=>{
  const f=fixture();await f.answers.get(context,f.value.id,'historical');
  assert.deepEqual(f.counts(),{frozen:0,historical:1,sourceReads:1,operationReads:1});
  f.revoke();await assert.rejects(f.answers.get(context,f.value.id,'historical'),hasCode('ASK_READSET_INVALIDATED'));
  const foreign={...context,scope:{...scope,spaceId:'foreign'}};
  await assert.rejects(f.answers.get(foreign,f.value.id),hasCode('SCOPE_FORBIDDEN'));
  assert.equal(f.counts().operationReads,2);
});

test('non-answered rows never expose an answer fingerprint',async()=>{
  const value={...answered(),state:'needs_evidence' as const,claims:[],answerFingerprint:'d'.repeat(64)};
  const f=fixture(value),result=await f.answers.get(context,value.id);
  assert.equal('answerFingerprint' in result,false);
});

test('fresh Ask and original-key replay both return the derived fingerprint without another provider call',async()=>{
  const wiki=ref('knowledge'),page={ref:wiki,title:'Synthetic Wiki',body:'A bounded synthetic page',conditions:[],
    counterexamples:[],unknowns:[],citations:[],sourceGroups:[],storageDigest:'b'.repeat(64),payloadBytes:100,
    admitted:true} as BoundedWikiPage;
  const coverage={scopeDescription:'synthetic',returned:1,loaded:1,hasMore:false,nextCursor:null,
    completeness:'bounded' as const,omittedReasons:[],snapshot:{publicationEpoch:1,consistency:'single_scope_snapshot' as const}};
  let saved:AskResult|null=null,providerCalls=0;
  const reader={async queryCandidates(){return {data:{items:[{ref:{objectId:wiki.objectId,versionId:wiki.versionId},
    title:page.title,payloadBytes:100,storageDigest:page.storageDigest}]},coverage};},
  async readCandidate(){return page;},async validateFrozenWiki(){},async assertReadEpoch(){},
  async sourceRecord(){throw new Error('No source content requested');},
  async sourceContentBounded(){throw new Error('No source content requested');}} as unknown as AskReader;
  const operations:AskOperationPort={async reserve(_context,_key,_hash,_request,initial){
    if(saved)return {created:false,result:saved};saved=initial;return {created:true,result:initial};},
  async start(){return true;},async checkpoint(_context,_id,result){saved=result;},
  async finish(_context,_id,result){saved=result;},async get(){return saved;},async lookup(){return saved;}};
  const service=createAskWikiService({reader,operations,provider:{id:'synthetic',model:'local',async answer(input){
    providerCalls++;return {answer:{outcome:'answered',claims:[{text:'Cited synthetic answer',evidenceIds:[input.evidence[0].id]}],
      reason:'Synthetic',gaps:[]},cost:{modelCalls:{state:'known',value:1},tokens:{state:'known',value:0},
      money:{state:'known',amount:0,currency:'USD',source:'synthetic'}},modelReturned:'local',requestId:null};}}});
  const capabilityContext:CapabilityContext={...context,authorization:{actions:['ask:write'],adapterIds:[],rightsPolicyIds:[]}};
  const request:AskRequest={question:'Ask an exact synthetic page',purpose,limit:1,maxPages:1,
    includeSourceContent:false,budget:{maxModelCalls:1,maxReadBytes:10_000,maxMoney:null,
      deadline:new Date(Date.now()+60_000).toISOString()}};
  const first=await service.ask(capabilityContext,request,'same-ask-key');
  assert.equal(first.state,'answered');assert.equal(first.answerFingerprint,askAnswerFingerprint(first));
  const replay=await service.ask(capabilityContext,request,'same-ask-key');
  assert.equal(replay.answerFingerprint,first.answerFingerprint);assert.equal(providerCalls,1);
  assert.equal((await service.get(context,first.id)).answerFingerprint,first.answerFingerprint);
});
