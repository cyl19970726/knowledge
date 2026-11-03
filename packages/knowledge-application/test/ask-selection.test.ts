import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createAskWikiService,type AskOperationPort,type AskReader,type AskEvidence} from '../src/ask.ts';
import type {BoundedWikiPage} from '../src/index.ts';
import type {CapabilityContext} from '../src/sources.ts';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {canonical} from '../../knowledge/src/utils.ts';
import type {AskRequest,AskResult,KnowledgeRef} from '../../knowledge-contracts/src/index.ts';

const scope={projectId:'selected-project',spaceId:'selected-space'},purpose='exploration_reading';
const context:CapabilityContext={scope,purpose,principal:{id:'selected-reader',clientInstallationId:'selected-installation',
  projectId:scope.projectId,spaceIds:[scope.spaceId],purposes:[purpose]},
  authorization:{actions:['ask:write'],adapterIds:[],rightsPolicyIds:[]}};
const ref=(letter:string):KnowledgeRef=>({...scope,domain:'knowledge',objectId:randomUUID(),versionId:randomUUID(),
  contentDigest:letter.repeat(64)});
const page=(ref:KnowledgeRef,bytes=100):BoundedWikiPage=>({ref,title:`Synthetic Wiki ${ref.contentDigest?.[0]}`,
  body:`Exact synthetic body ${ref.contentDigest?.[0]}`,conditions:[],counterexamples:[],unknowns:[],citations:[],
  sourceGroups:[],storageDigest:'9'.repeat(64),payloadBytes:bytes,admitted:true});
const request=(selectedRefs:KnowledgeRef[],maxReadBytes=10_000):AskRequest=>({question:'What do the selected exact pages say?',purpose,
  limit:5,maxPages:1,includeSourceContent:false,selectedRefs,budget:{maxModelCalls:1,maxReadBytes,
    deadline:new Date(Date.now()+60_000).toISOString(),maxMoney:null}});
const hasCode=(code:string)=>(error:unknown)=>error instanceof KnowledgeError&&error.code===code;

function harness(input:{pages:BoundedWikiPage[];queryRefs?:KnowledgeRef[];
  exactError?:(ref:KnowledgeRef)=>KnowledgeError|null;missingExact?:boolean}){
  const stored=new Map<string,{hash:string;request:AskRequest;result:AskResult}>();
  let queryCalls=0,exactReads=0,candidateReads=0,reservations=0,providerCalls=0;
  let seen:readonly AskEvidence[]=[];
  const item=(ref:KnowledgeRef)=>input.pages.find(page=>page.ref.objectId===ref.objectId&&page.ref.versionId===ref.versionId);
  const reader={
    async queryCandidates(){queryCalls++;const refs=input.queryRefs??[];return {data:{items:refs.map(ref=>({ref:{objectId:ref.objectId,
      versionId:ref.versionId},title:'Synthetic candidate',payloadBytes:item(ref)?.payloadBytes??100,
      storageDigest:'9'.repeat(64)}))},coverage:{scopeDescription:'synthetic selected scope',returned:refs.length,
      loaded:refs.length,hasMore:false,nextCursor:null,completeness:'bounded',omittedReasons:[],
      snapshot:{publicationEpoch:1,consistency:'single_scope_snapshot'}}};},
    async readWikiExactBounded(_context:unknown,ref:KnowledgeRef,maxBytes:number){exactReads++;
      const error=input.exactError?.(ref);if(error)throw error;
      const found=item(ref);if(!found)throw new KnowledgeError('NOT_FOUND','Exact Wiki unavailable',404);
      if(found.payloadBytes>maxBytes)throw new KnowledgeError('KNOWLEDGE_READ_BUDGET_EXCEEDED','Bounded Wiki budget',422);
      return found;},
    async readCandidate(_context:unknown,candidate:{ref:{objectId:string;versionId:string}},maxBytes:number){candidateReads++;
      const found=input.pages.find(page=>page.ref.objectId===candidate.ref.objectId&&page.ref.versionId===candidate.ref.versionId);
      if(!found)throw new KnowledgeError('NOT_FOUND','Candidate unavailable',404);
      if(found.payloadBytes>maxBytes)throw new KnowledgeError('KNOWLEDGE_READ_BUDGET_EXCEEDED','Bounded Wiki budget',422);
      return found;},
    async validateFrozenWiki(){},async assertReadEpoch(){},
  } as unknown as AskReader;
  if(input.missingExact)delete (reader as {readWikiExactBounded?:unknown}).readWikiExactBounded;
  const operations:AskOperationPort={
    async reserve(_context,key,hash,req,initial){reservations++;
      const old=stored.get(key);if(old){if(old.hash!==hash||canonical(old.request)!==canonical(req))
        throw new KnowledgeError('IDEMPOTENCY_CONFLICT','Original Ask input differs',409);
        return {created:false,result:old.result};}
      stored.set(key,{hash,request:req,result:initial});return {created:true,result:initial};},
    async start(){return true;},
    async checkpoint(){},
    async finish(_context,_id,result){for(const entry of stored.values())if(entry.result.id===result.id)entry.result=result;},
    async get(_context,id){return [...stored.values()].find(entry=>entry.result.id===id)?.result??null;},
    async lookup(_context,key){return stored.get(key)?.result??null;},
  };
  const service=createAskWikiService({reader,operations,provider:{id:'synthetic-answerer',model:'synthetic-only',
    async answer(input){providerCalls++;seen=input.evidence;return {answer:{outcome:'answered',
      claims:[{text:'Exact synthetic answer',evidenceIds:input.evidence.map(item=>item.id)}],reason:'Synthetic answer',gaps:[]},
      cost:{modelCalls:{state:'known',value:1},tokens:{state:'known',value:0},money:{state:'known',amount:0,
        currency:'USD',source:'synthetic-only'}},modelReturned:'synthetic-only',requestId:null};}}});
  return {service,counts:()=>({queryCalls,exactReads,candidateReads,reservations,providerCalls}),seen:()=>seen,stored};
}

test('selected exact A and B reach the answerer even when lexical retrieval misses both',async()=>{
  const a=ref('a'),b=ref('b'),h=harness({pages:[page(a),page(b)]});
  const result=await h.service.ask(context,request([a,b]),'selected-a-b');
  assert.equal(result.state,'answered');assert.deepEqual(h.seen().map(item=>item.ref),[a,b]);
  assert.deepEqual(result.evidence.map(item=>item.ref),[a,b]);
  assert.deepEqual(h.counts(),{queryCalls:1,exactReads:2,candidateReads:0,reservations:1,providerCalls:1});
  assert.equal(result.readUsage?.wikiPayloadBytes,200);
  assert.equal(result.readUsage?.preparedInputBytes,Buffer.byteLength(JSON.stringify({question:result.question,
    purpose:result.purpose,evidence:h.seen()}),'utf8'));
});

test('selected intent beyond the bounded Wiki budget is excluded without substitution',async()=>{
  const a=ref('a'),b=ref('b'),h=harness({pages:[page(a,600),page(b,600)],queryRefs:[b]});
  const result=await h.service.ask(context,request([a,b],1000),'selected-budget');
  assert.equal(result.state,'answered');assert.deepEqual(h.seen().map(item=>item.ref),[a]);
  assert.deepEqual(result.excluded.map(item=>item.ref),[b]);
  assert.equal(result.readUsage?.wikiPayloadBytes,600);
  assert.deepEqual(h.counts(),{queryCalls:1,exactReads:2,candidateReads:0,reservations:1,providerCalls:1});
});

test('cross-scope selection and missing exact-read port fail before reservation or paid work',async()=>{
  const a=ref('a'),foreign={...a,spaceId:'foreign-space'},h=harness({pages:[page(a)]});
  await assert.rejects(h.service.ask(context,request([foreign]),'foreign'),hasCode('SELECTED_REF_SCOPE_MISMATCH'));
  assert.deepEqual(h.counts(),{queryCalls:0,exactReads:0,candidateReads:0,reservations:0,providerCalls:0});
  const unsupported=harness({pages:[page(a)],missingExact:true});
  await assert.rejects(unsupported.service.ask(context,request([a]),'unsupported'),hasCode('BOUNDED_WIKI_READ_UNSUPPORTED'));
  assert.equal(unsupported.counts().reservations,0);assert.equal(unsupported.counts().providerCalls,0);
});

test('digest mismatch or revoked selected version is excluded and never sent as a wrong input',async()=>{
  const a=ref('a');
  const mismatched=harness({pages:[page({...a,contentDigest:'b'.repeat(64)})]});
  const digestResult=await mismatched.service.ask(context,request([a]),'digest-mismatch');
  assert.equal(digestResult.state,'needs_evidence');assert.deepEqual(digestResult.excluded.map(item=>item.ref),[a]);
  assert.equal(mismatched.counts().providerCalls,0);
  const revoked=harness({pages:[page(a)],exactError:()=>new KnowledgeError('SOURCE_FORBIDDEN','Secret body must stay private',403)});
  const revokedResult=await revoked.service.ask(context,request([a]),'revoked');
  assert.equal(revokedResult.state,'needs_evidence');assert.deepEqual(revokedResult.excluded.map(item=>item.ref),[a]);
  assert.equal(revoked.counts().providerCalls,0);
  assert.equal(JSON.stringify(revokedResult).includes('Secret body must stay private'),false);
});

test('unknown bytes from a selected digest failure stop later content reads without inventing usage',async()=>{
  const a=ref('a'),b=ref('b'),ordinary=ref('c');
  const h=harness({pages:[page(a),page(b),page(ordinary)],queryRefs:[ordinary],exactError:ref=>
    ref.objectId===b.objectId?new KnowledgeError('EXACT_REF_MISMATCH','Digest failed after bounded read',409):null});
  const result=await h.service.ask(context,request([a,b]),'unknown-read-bytes');
  assert.equal(result.state,'answered');assert.deepEqual(h.seen().map(item=>item.ref),[a]);
  assert.equal(h.counts().exactReads,2);assert.equal(h.counts().candidateReads,0);
  assert.equal(result.readUsage?.wikiPayloadBytes,100,'failed exact read bytes are not fabricated');
  assert.ok(result.gaps.some(gap=>gap.includes('unknown byte usage')));
  assert.ok(result.excluded.some(item=>item.ref.objectId===b.objectId));
});

test('same selected version in query results reads once; original key replays the frozen answer',async()=>{
  const a=ref('a'),h=harness({pages:[page(a)],queryRefs:[a]});
  const input=request([a]),first=await h.service.ask(context,input,'original-key');
  assert.equal(first.state,'answered');assert.equal(h.counts().exactReads,1);assert.equal(h.counts().candidateReads,0);
  const replay=await h.service.ask(context,input,'original-key');
  assert.equal(replay.id,first.id);assert.equal(h.counts().providerCalls,1);assert.equal(h.counts().exactReads,1);
  assert.equal((await h.service.lookup(context,'original-key')).answer?.id,first.id);
  await assert.rejects(h.service.ask(context,{...input,selectedRefs:[]},'original-key'),hasCode('IDEMPOTENCY_CONFLICT'));
  assert.equal(h.counts().providerCalls,1);
});
