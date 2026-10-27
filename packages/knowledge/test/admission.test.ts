import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { evaluateScopedUse, type ScopedUseDecision } from '../src/admission.ts';
import { ref, timestamp } from './service-fixtures.ts';

const reportRef=ref();
const scoped=(decision:ScopedUseDecision['decision'],channels:ScopedUseDecision['channels'],startMs=0,endMs=10000):ScopedUseDecision=>({
  id:randomUUID(),projectId:'test',reportRef,purpose:'creative_reference',channels,mediaScope:{kind:'segment',startMs,endMs},decision,reviewer:'independent-reviewer',rationale:'synthetic review',decidedAt:timestamp,
});
const use=(channels:ScopedUseDecision['channels'],startMs=1000,endMs=2000)=>({channels,mediaScope:{kind:'segment' as const,startMs,endMs}});

test('scoped approvals require the exact covered channels and seconds',()=>{
  const decisions=[scoped('approved',['visual'],0,3000),scoped('rejected',['audio'],0,3000)];
  assert.equal(evaluateScopedUse(decisions,use(['visual']),false),'approved');
  assert.equal(evaluateScopedUse(decisions,use(['audio']),false),'rejected');
  assert.equal(evaluateScopedUse(decisions,use(['visual','audio']),false),'rejected');
  assert.equal(evaluateScopedUse(decisions,use(['visual'],4000,5000),false),'unknown');
  assert.equal(evaluateScopedUse([],use(['visual']),false),'unknown');
});

test('a partial rejection only intersects its own segment; exploration still respects rejection',()=>{
  const decisions=[scoped('approved',['visual'],0,10000),scoped('rejected',['visual'],3000,4000),scoped('exploration_only',['captions'],0,10000)];
  assert.equal(evaluateScopedUse(decisions,use(['visual'],5000,6000),false),'approved');
  assert.equal(evaluateScopedUse(decisions,use(['visual'],3500,3600),true),'rejected');
  assert.equal(evaluateScopedUse(decisions,use(['captions'],5000,6000),false),'unknown');
  assert.equal(evaluateScopedUse(decisions,use(['captions'],5000,6000),true),'exploration_only');
});

test('an approval without an exact claim or anchor cannot grant a requested narrow use',()=>{
  const approval=scoped('approved',['visual']);
  assert.equal(evaluateScopedUse([approval],{...use(['visual']),claimRef:ref()},false),'unknown');
  const claim=ref();
  assert.equal(evaluateScopedUse([{...approval,claimRef:claim}],{...use(['visual']),claimRef:claim},false),'approved');
});
