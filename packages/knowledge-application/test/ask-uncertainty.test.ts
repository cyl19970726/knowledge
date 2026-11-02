import test from 'node:test';
import assert from 'node:assert/strict';
import {createAskWikiService,type AskOperationPort} from '../src/ask.ts';
import type {KnowledgeApplication} from '../src/index.ts';
import type {CapabilityContext} from '../src/sources.ts';
import {AskCommitUnknownError} from '../../adapters/knowledge-service/src/ask.ts';

test('lost start commit acknowledgement remains unknown and never invokes the answerer',async()=>{
  let operationId='',calls=0;
  const operations:AskOperationPort={
    async reserve(_context,_key,_digest,_request,initial){operationId=initial.id;return {created:true,result:initial};},
    async start(){throw new AskCommitUnknownError(operationId);},
    async checkpoint(){assert.fail('must not checkpoint after unknown start');},
    async finish(){assert.fail('must not finish after unknown start');},
    async get(){return null;},async lookup(){return null;},
  };
  const service=createAskWikiService({reader:{} as KnowledgeApplication,operations,
    provider:{id:'test-only',model:'no-model',async answer(){calls++;assert.fail('provider must not run');}}});
  const context:CapabilityContext={scope:{projectId:'test-project',spaceId:'test-space'},purpose:'exploration_reading',
    principal:{id:'reader',clientInstallationId:'test',projectId:'test-project',spaceIds:['test-space'],purposes:['exploration_reading']},
    authorization:{actions:['ask:write'],adapterIds:[],rightsPolicyIds:[]}};
  await assert.rejects(service.ask(context,{question:'提交结果未知时怎样处理',purpose:context.purpose,limit:1,maxPages:1,includeSourceContent:false,
    budget:{maxModelCalls:1,maxReadBytes:10000,deadline:new Date(Date.now()+60_000).toISOString(),maxMoney:null}},'frozen-key'),
    (error:unknown)=>error instanceof AskCommitUnknownError&&error.commitStatus==='unknown'&&error.operationId===operationId);
  assert.equal(calls,0);
});
