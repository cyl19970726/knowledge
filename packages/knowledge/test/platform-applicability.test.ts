import assert from 'node:assert/strict';
import test from 'node:test';
import {platformFit,platformOfAnalysis} from '../src/platform-applicability.ts';
import {SyntheticAnalysis,ref,scope} from './service-fixtures.ts';

test('legacy applicability is TikTok only and transfer names its exact target',()=>{
  const old=scope(ref()).applicability;
  assert.equal(platformFit(old,'tiktok'),'direct');
  assert.equal(platformFit(old,'douyin'),null);
  old.platformTransfers=[{to:'douyin',rationale:'Original format hypothesis to validate on Douyin'}];
  assert.equal(platformFit(old,'douyin'),'transfer');
  assert.equal(platformFit(old,'xiaohongshu'),null);
  old.platforms=['unknown'];
  assert.equal(platformFit(old,'tiktok'),null);
});

test('analysis uses explicit public post identity but does not infer a client media platform',()=>{
  const sample=new SyntheticAnalysis().add('platform-test');
  assert.equal(platformOfAnalysis(sample.snapshot),'tiktok');
  const client={...sample.snapshot,sourceContext:{providerObservations:sample.snapshot.sourceContext.providerObservations.map(item=>({
    ...item,acquisition:{...item.acquisition,source:'client_provided' as const}}))}};
  assert.equal(platformOfAnalysis(client),'unknown');
  const explicit={...client,sourceContext:{...client.sourceContext,post:{schemaVersion:'post-source@1' as const,
    platform:'douyin' as const,platformPostId:'123',record:sample.snapshot.original,title:null,caption:null,cover:null}}};
  assert.equal(platformOfAnalysis(explicit),'douyin');
});
