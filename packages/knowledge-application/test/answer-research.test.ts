import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {AskResult,KnowledgeRef,WikiCompileRequest,WikiCompileResult} from '@commerce/knowledge-contracts';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {digest} from '@commerce/knowledge-core/utils';
import {askAnswerFingerprint,type AskAnswerReader} from '../src/ask.ts';
import {createAnswerResearchApplication,resolveAnswerSeed,type AnswerResearchCompiler} from '../src/answer-research.ts';
import type {CapabilityContext} from '../src/sources.ts';

const scope={projectId:'answer-research-project',spaceId:'answer-research-space'},purpose='exploration_reading';
const context:CapabilityContext={scope,purpose,principal:{id:'answer-researcher',clientInstallationId:'research-installation',
  projectId:scope.projectId,spaceIds:[scope.spaceId],purposes:[purpose]},
  authorization:{actions:['compile:read','compile:write'],adapterIds:[],rightsPolicyIds:[]}};
const ref=(domain:'knowledge'|'source'):KnowledgeRef=>({...scope,domain,objectId:randomUUID(),versionId:randomUUID(),contentDigest:'a'.repeat(64)});
const budget=()=>({maxModelCalls:0,maxReadBytes:500_000,maxMoney:{amount:0,currency:'USD'},deadline:new Date(Date.now()+60_000).toISOString()});
const hasCode=(code:string)=>(error:unknown)=>error instanceof KnowledgeError&&error.code===code;
function answer(wikis=20,sources=20):AskResult{
  const createdAt=new Date().toISOString();
  return {id:randomUUID(),question:'Original cited question',purpose,state:'answered',claims:[{text:'One cited claim',evidenceIds:['wiki-0']}],
    evidence:[...Array.from({length:wikis},(_,index)=>({id:`wiki-${index}`,kind:'wiki_page' as const,ref:ref('knowledge'),
      title:`Wiki ${index}`,locator:null,storageDigest:'b'.repeat(64),conditions:[],counterexamples:[],unknowns:[],actualReadCoverage:[]})),
      ...Array.from({length:sources},(_,index)=>({id:`source-${index}`,kind:'source_content' as const,ref:ref('source'),
        title:`Source ${index}`,locator:null,conditions:[],counterexamples:[],unknowns:[],actualReadCoverage:[]}))],
    excluded:[],coverage:{scopeDescription:'synthetic answer readset',returned:wikis+sources,loaded:wikis+sources,hasMore:false,nextCursor:null,
      completeness:'bounded',omittedReasons:[],snapshot:{publicationEpoch:1,consistency:'single_scope_snapshot'}},
    readsetFingerprint:'c'.repeat(64),cost:{modelCalls:{state:'known',value:1},tokens:{state:'known',value:0},
      money:{state:'known',amount:0,currency:'USD',source:'synthetic'}},provider:{id:'synthetic-answerer',modelRequested:'local',
      modelReturned:'local',requestId:null},reason:'Synthetic cited answer',gaps:[],createdAt,completedAt:createdAt};
}
function fixture(result:AskResult=answer()){
  const modes:('current'|'historical')[]=[],requests:WikiCompileRequest[]=[],keys:string[]=[],ledger=new Map<string,{hash:string;result:WikiCompileResult}>();
  let denied=false;
  const answers:AskAnswerReader={async get(_context,id,mode='current'){
    modes.push(mode);if(id!==result.id)throw new KnowledgeError('NOT_FOUND','Answer unavailable',404);
    if(denied)throw new KnowledgeError('ASK_READSET_INVALIDATED','Source rights revoked',409);
    return structuredClone({...result,answerFingerprint:askAnswerFingerprint(result)});},
    async lookup(){return {state:'unknown',answer:null};}};
  const compilation={id:randomUUID(),state:'waiting_for_review'} as WikiCompileResult;
  const compiler:AnswerResearchCompiler={async lookup(_context,key){return ledger.get(key)?.result??null;},
    async compile(_context,request,key){requests.push(structuredClone(request));keys.push(key);
      const hash=digest(request),old=ledger.get(key);
      if(old){if(old.hash!==hash)throw new KnowledgeError('IDEMPOTENCY_CONFLICT','Frozen compilation request differs',409);
        return old.result;}
      ledger.set(key,{hash,result:compilation});return compilation;}};
  const app=createAnswerResearchApplication({answers,compiler});
  const raw=(extra:Record<string,unknown>={})=>({purpose,expectedAnswerFingerprint:askAnswerFingerprint(result),
    claimIndexes:[0],question:'Research the original answer further',limit:100,maxPages:2,budget:budget(),...extra});
  return {app,answer:result,answers,raw,requests,keys,modes,ledger,deny:()=>{denied=true;}};
}

test('selected claim keeps all original Wiki and source inputs, including uncited background',async()=>{
  const f=fixture(),seed={answerId:f.answer.id,expectedAnswerFingerprint:askAnswerFingerprint(f.answer),claimIndexes:[0]};
  const resolved=await resolveAnswerSeed(context,seed,f.answers);
  assert.equal(resolved.claims.length,1);assert.equal(resolved.selectedRefs.length,20);assert.equal(resolved.sourceRefs.length,20);
  assert.deepEqual(resolved.origin,{answerId:f.answer.id,answerFingerprint:seed.expectedAnswerFingerprint,
    claimIndexes:[0],question:f.answer.question});
  await f.app.research(context,f.answer.id,f.raw(),'research-key');
  assert.deepEqual(f.requests[0].selectedRefs,resolved.selectedRefs);
  assert.deepEqual(f.requests[0].sourceRefs,resolved.sourceRefs);
  assert.deepEqual(f.requests[0].sourceEventIds,[]);
  assert.deepEqual(f.requests[0].answerSeed,seed);
  assert.deepEqual(f.requests[0].queries,['Research the original answer further']);
  assert.equal(f.requests[0].budget.maxReadBytes,500_000);
  await f.app.research(context,f.answer.id,f.raw({limit:20}),'wiki-limit-20');
  assert.equal(f.requests.at(-1)?.selectedRefs?.length,20);
  assert.equal(f.requests.at(-1)?.sourceRefs?.length,20,'sources do not consume the Wiki page limit');
});

test('the exact 100-input boundary preserves every actual readset ref',async()=>{
  const f=fixture(answer(80,20));await f.app.research(context,f.answer.id,f.raw(),'full-bound');
  assert.equal(f.requests[0].selectedRefs?.length,80);
  assert.equal(f.requests[0].sourceRefs?.length,20);
  assert.equal(f.requests[0].limit,100);
});

test('answer basis rejects foreign or digestless refs and deduplicates an exact repeated version',async()=>{
  const foreign=answer(1,0);foreign.evidence[0].ref={...foreign.evidence[0].ref,spaceId:'foreign'};
  const blocked=fixture(foreign);
  await assert.rejects(blocked.app.research(context,foreign.id,blocked.raw(),'foreign-ref'),hasCode('ANSWER_READSET_INVALID'));
  const digestless=answer(1,0);digestless.evidence[0].ref={...digestless.evidence[0].ref,contentDigest:null};
  const missing=fixture(digestless);
  await assert.rejects(missing.app.research(context,digestless.id,missing.raw(),'digestless-ref'),hasCode('ANSWER_READSET_INVALID'));
  const repeated=answer(2,0);repeated.evidence[1].ref=structuredClone(repeated.evidence[0].ref);
  const f=fixture(repeated);await f.app.research(context,repeated.id,f.raw(),'repeated-ref');
  assert.equal(f.requests[0].selectedRefs?.length,1);
});

test('new key starts once and original key replays only the same frozen compiler request',async()=>{
  const f=fixture(),original=f.raw();const first=await f.app.research(context,f.answer.id,original,'original');
  const replay=await f.app.research(context,f.answer.id,original,'original');
  assert.equal(replay,first);assert.deepEqual(f.keys,['original','original']);
  await assert.rejects(f.app.research(context,f.answer.id,{...original,question:'Changed research question'},'original'),hasCode('IDEMPOTENCY_CONFLICT'));
  await f.app.research(context,f.answer.id,original,'new-key');
  assert.equal(f.ledger.size,2);assert.deepEqual(f.modes,['current','current','current','current']);
});

test('scope, fingerprint, invalid indexes and insufficient Wiki limit fail before compiler dispatch',async()=>{
  const f=fixture();
  await assert.rejects(f.app.research({...context,scope:{...scope,spaceId:'foreign'}},f.answer.id,f.raw(),'scope'),hasCode('CAPABILITY_FORBIDDEN'));
  await assert.rejects(f.app.research(context,f.answer.id,f.raw({expectedAnswerFingerprint:'f'.repeat(64)}),'fingerprint'),hasCode('ANSWER_FINGERPRINT_MISMATCH'));
  await assert.rejects(f.app.research(context,f.answer.id,f.raw({claimIndexes:[1]}),'claim'),hasCode('ANSWER_CLAIM_INDEX_INVALID'));
  await assert.rejects(f.app.research(context,f.answer.id,f.raw({claimIndexes:[0,0]}),'duplicate'));
  await assert.rejects(f.app.research(context,f.answer.id,f.raw({limit:19}),'limit'),hasCode('ANSWER_READSET_LIMIT_EXCEEDED'));
  assert.equal(f.requests.length,0);
});

test('a revised answer explanation rejects its former expected fingerprint without dispatch',async()=>{
  const f=fixture(),oldFingerprint=askAnswerFingerprint(f.answer);
  f.answer.reason='The explanation was changed after the seed was captured';
  await assert.rejects(f.app.research(context,f.answer.id,f.raw({expectedAnswerFingerprint:oldFingerprint}),'changed-reason'),
    hasCode('ANSWER_FINGERPRINT_MISMATCH'));
  assert.equal(f.requests.length,0);
});

test('published replay may validate historical Wiki, but revoked source rights still block it',async()=>{
  const f=fixture(),original=f.raw();await f.app.research(context,f.answer.id,original,'published');
  f.ledger.get('published')!.result={state:'published'} as WikiCompileResult;
  await f.app.research(context,f.answer.id,original,'published');assert.deepEqual(f.modes,['current','historical']);
  f.deny();await assert.rejects(f.app.research(context,f.answer.id,original,'published'),hasCode('ASK_READSET_INVALIDATED'));
  assert.equal(f.requests.length,2,'revoked history never reaches compiler');
  await assert.rejects(f.app.research(context,f.answer.id,original,'new-current'),hasCode('ASK_READSET_INVALIDATED'));
  assert.equal(f.modes.at(-1),'current');
});

test('500-unit query bound never leaves half an emoji and preserves the full research question',async()=>{
  const f=fixture(),question=`${'x'.repeat(499)}😀 more context`;
  await f.app.research(context,f.answer.id,f.raw({question}),'emoji-boundary');
  assert.equal(f.requests[0].question,question);
  assert.equal(f.requests[0].queries[0],'x'.repeat(499));
  assert.equal(f.requests[0].queries[0].includes('\ufffd'),false);
});
