import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createAskWikiService,type AskOperationPort} from '../src/ask.ts';
import type {KnowledgeApplication} from '../src/index.ts';
import {KnowledgeError} from '../../knowledge/src/types.ts';
import type {AskResult} from '../../knowledge-contracts/src/index.ts';

test('revocation during the awaited checkpoint prevents provider dispatch and preserves zero calls',async()=>{
  let revoked=false,calls=0,finished:AskResult|undefined;
  const scope={projectId:'test-project',spaceId:'test-space'},ref={...scope,domain:'knowledge' as const,objectId:randomUUID(),versionId:randomUUID(),contentDigest:'a'.repeat(64)};
  const context={scope,purpose:'exploration_reading',principal:{id:'reader',clientInstallationId:'test',projectId:scope.projectId,spaceIds:[scope.spaceId],purposes:['exploration_reading']},
    authorization:{actions:['ask:write'],adapterIds:[],rightsPolicyIds:[]}};
  const reader={async queryCandidates(){return {data:{items:[{ref:{objectId:ref.objectId,versionId:ref.versionId},title:'test',payloadBytes:1000,storageDigest:'b'.repeat(64)}]},
    coverage:{scopeDescription:'test',returned:1,loaded:1,hasMore:false,nextCursor:null,completeness:'bounded' as const,omittedReasons:[],snapshot:{publicationEpoch:1,consistency:'single_scope_snapshot' as const}}};},
    async readCandidate(){return {ref,title:'test',body:'准确的合成正文',conditions:[],counterexamples:[],unknowns:[],citations:[],storageDigest:'b'.repeat(64),payloadBytes:1000,admitted:true};},
    async validateFrozenWiki(){if(revoked)throw new KnowledgeError('ASK_READSET_INVALIDATED','Revoked during checkpoint',409);},
    async assertReadEpoch(){if(revoked)throw new KnowledgeError('READSET_CHANGED','Changed during checkpoint',409);},
  } as unknown as KnowledgeApplication;
  const operations:AskOperationPort={async reserve(_ctx,_key,_digest,_request,initial){return {created:true,result:initial};},async start(){return true;},
    async checkpoint(){revoked=true;},async finish(_ctx,_id,result){finished=result;},async get(){return finished??null;},async lookup(){return null;}};
  const service=createAskWikiService({reader,operations,provider:{id:'test',model:'not-a-real-model',async answer(){calls++;return {answer:{outcome:'answered',claims:[{text:'test',evidenceIds:['w1']}],reason:'test',gaps:[]},
    cost:{modelCalls:{state:'known',value:1},tokens:{state:'known',value:0},money:{state:'known',amount:0,currency:'USD',source:'synthetic-fixture'}},modelReturned:'test',requestId:'test'};}}});
  await assert.rejects(service.ask(context,{question:'test question',purpose:context.purpose,limit:1,maxPages:1,includeSourceContent:false,
    budget:{maxModelCalls:1,maxReadBytes:10000,deadline:new Date(Date.now()+60000).toISOString(),maxMoney:null}},'frozen-key'),
    error=>error instanceof KnowledgeError&&error.code==='ASK_READSET_INVALIDATED');
  assert.equal(calls,0,'revoked evidence must never reach the provider');
  assert.equal(finished?.state,'failed');assert.deepEqual(finished?.cost.modelCalls,{state:'known',value:0});
});
