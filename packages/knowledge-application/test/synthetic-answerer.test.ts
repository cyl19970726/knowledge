import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createSyntheticQueryAnswerer} from '../../../scripts/runtime/knowledge-synthetic-answerer.ts';
import type {AskEvidence} from '../src/ask.ts';

test('UI fixture labels synthetic content and reports zero actual model calls',async()=>{
  const provider=createSyntheticQueryAnswerer();
  const evidence:AskEvidence={id:'w1',kind:'wiki_page',ref:{projectId:'test',spaceId:'test',domain:'knowledge',
    objectId:randomUUID(),versionId:randomUUID(),contentDigest:'a'.repeat(64)},title:'合成条件页',body:'准确的合成正文',locator:null,
    conditions:['仅限夹具'],counterexamples:['反例仍需阅读'],unknowns:['没有真实业务观察'],actualReadCoverage:[]};
  const result=await provider.answer({operationId:randomUUID(),question:'测试',purpose:'exploration_reading',evidence:[evidence],
    budget:{maxModelCalls:1,maxReadBytes:10000,deadline:new Date(Date.now()+60000).toISOString(),maxMoney:{amount:0,currency:'USD'}},signal:new AbortController().signal});
  assert.equal(result.answer.outcome,'answered');assert.match(result.answer.claims[0].text,/合成问答演示/);
  assert.ok(result.answer.claims[0].text.includes(evidence.body));assert.deepEqual(result.answer.claims[0].evidenceIds,['w1']);
  assert.ok(result.answer.gaps.includes(evidence.unknowns[0]));
  assert.deepEqual(result.cost.modelCalls,{state:'known',value:0});assert.equal(result.cost.money.state,'known');
  assert.equal(result.modelReturned,'synthetic-no-model');
});

test('UI fixture cannot fabricate a cited answer without Wiki evidence',async()=>{
  const result=await createSyntheticQueryAnswerer().answer({operationId:randomUUID(),question:'测试',purpose:'exploration_reading',evidence:[],
    budget:{maxModelCalls:1,maxReadBytes:10000,deadline:new Date(Date.now()+60000).toISOString(),maxMoney:null},signal:new AbortController().signal});
  assert.equal(result.answer.outcome,'needs_evidence');assert.deepEqual(result.answer.claims,[]);
});
