import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import { createKnowledgeService } from '../src/service.ts';
import type { KnowledgeChangeSet, KnowledgeStore, RevisionView } from '../src/types.ts';
import { claimRevision, mediaCitation, proposal, ref, scope, SyntheticAnalysis, timestamp } from './service-fixtures.ts';

test('an observation Claim may cite an anchor in its explicitly selected exact analysis result',async()=>{
  const projectId='normalizer-test';const product=ref();const analysis=new SyntheticAnalysis();const row=analysis.add(projectId);
  const claim=claimRevision(projectId,product,'Visible hook',mediaCitation(row.anchor),'observation');
  claim.dependencies=[{domain:'analysis',ref:row.result.ref,role:'derived_from',critical:true}];
  let staged:KnowledgeChangeSet|null=null;
  const store=new Proxy({getByRequestKey:async()=>null,validate:async()=>({valid:true,issues:[]}),stage:async(value:KnowledgeChangeSet)=>{staged=value;return value;}},
    {get(target,key){return Reflect.get(target,key)??(async()=>null);}}) as unknown as KnowledgeStore;
  const knowledge=createKnowledgeService({store,analysis});
  await knowledge.propose(proposal(projectId,[claim]));
  assert.ok(staged);
  assert.ok((staged as KnowledgeChangeSet).changes[0].revision.dependencies.some(d=>d.domain==='analysis'&&d.ref.versionId===row.result.ref.versionId&&d.critical));
});

test('Wiki containment keeps an old invalid Claim readable without promoting it to critical',async()=>{
  const projectId='normalizer-nav';const product=ref();const analysis=new SyntheticAnalysis();
  const citation=mediaCitation(analysis.add(projectId).anchor);
  const claim=claimRevision(projectId,product,'Older observation',citation,'observation');
  const old:RevisionView={revision:claim,published:true,current:false,review:null,validity:{valid:false,issues:[]}};
  const wikiRef=ref();
  const wiki={kind:'wiki' as const,ref:wikiRef,projectId,title:'Topic',body:'Historic references',scope:scope(product),dependencies:[],sourceGroups:[],artifactRef:null,createdAt:timestamp,analysisQuality:null,
    content:{ref:wikiRef,projectId,title:'Topic',question:'What changed?',claimRefs:[claim.ref],patternRefs:[],relatedRefs:[],disputes:[],nextQuestions:[],citations:[citation]}};
  let staged:KnowledgeChangeSet|null=null;
  const store=new Proxy({getByRequestKey:async()=>null,get:async(_projectId:string,exact:typeof claim.ref)=>exact.versionId===claim.ref.versionId?old:null,
    validate:async()=>({valid:true,issues:[]}),stage:async(value:KnowledgeChangeSet)=>{staged=value;return value;}},
    {get(target,key){return Reflect.get(target,key)??(async()=>null);}}) as unknown as KnowledgeStore;
  const knowledge=createKnowledgeService({store,analysis});
  await knowledge.propose(proposal(projectId,[wiki]));
  assert.ok(staged);
  assert.ok((staged as KnowledgeChangeSet).changes[0].revision.dependencies.some(d=>d.domain==='knowledge'&&d.ref.versionId===claim.ref.versionId&&!d.critical));
});

test('an explicit noncritical Claim relation stays noncritical after normalization',async()=>{
  const projectId='normalizer-noncritical';const product=ref();const analysis=new SyntheticAnalysis();const row=analysis.add(projectId);
  const oldClaim=claimRevision(projectId,product,'Earlier wording',mediaCitation(row.anchor),'observation');
  const claim=claimRevision(projectId,product,'New wording',mediaCitation(row.anchor),'observation');
  claim.dependencies=[{domain:'analysis',ref:row.result.ref,role:'derived_from',critical:true},{domain:'knowledge',ref:oldClaim.ref,role:'uses',critical:false}];
  const old:RevisionView={revision:oldClaim,published:true,current:false,review:null,validity:{valid:false,issues:[]}};
  let staged:KnowledgeChangeSet|null=null;
  const store=new Proxy({getByRequestKey:async()=>null,get:async(_projectId:string,exact:typeof claim.ref)=>exact.versionId===oldClaim.ref.versionId?old:null,
    validate:async()=>({valid:true,issues:[]}),stage:async(value:KnowledgeChangeSet)=>{staged=value;return value;}},
    {get(target,key){return Reflect.get(target,key)??(async()=>null);}}) as unknown as KnowledgeStore;
  await createKnowledgeService({store,analysis}).propose(proposal(projectId,[claim]));
  assert.ok(staged);
  const links=(staged as KnowledgeChangeSet).changes[0].revision.dependencies.filter(d=>d.domain==='knowledge'&&d.ref.versionId===oldClaim.ref.versionId);
  assert.ok(links.length>0 && links.every(d=>!d.critical));
});

test('an exact critical knowledge basis authenticates inherited media, but an unrelated anchor is rejected',async()=>{
  const projectId='normalizer-derived-media',product=ref(),analysis=new SyntheticAnalysis();
  const observed=analysis.add(projectId),unrelated=analysis.add(projectId);
  const citation=mediaCitation(observed.anchor);
  const basis=claimRevision(projectId,product,'Observed sampled cue',citation,'observation');
  const view:RevisionView={revision:basis,published:true,current:true,
    review:{id:randomUUID(),projectId,changeSetId:randomUUID(),contentHash:'h',
      reviewer:'independent-fixture',policyVersion:'fixture',purpose:'exploration_reading',
      decision:'exploration_only',rationale:'Exact sampled cue only',createdAt:timestamp},
    validity:{valid:true,issues:[]}};
  let staged:KnowledgeChangeSet|null=null;
  const store=new Proxy({getByRequestKey:async()=>null,get:async(_projectId:string,exact:typeof basis.ref)=>
      exact.versionId===basis.ref.versionId?view:null,
    validate:async()=>({valid:true,issues:[]}),stage:async(value:KnowledgeChangeSet)=>{staged=value;return value;}},
    {get(target,key){return Reflect.get(target,key)??(async()=>null);}}) as unknown as KnowledgeStore;
  const knowledge=createKnowledgeService({store,analysis});
  const makeDerived=(inherited:typeof citation)=>{const own=ref();return {kind:'wiki' as const,ref:own,projectId,
    title:'Derived boundary',body:'Only the sampled cue is supported',scope:scope(product),
    dependencies:[{domain:'knowledge' as const,ref:basis.ref,role:'derived_from' as const,critical:true}],
    sourceGroups:[],artifactRef:null,createdAt:timestamp,analysisQuality:null,
    content:{ref:own,projectId,title:'Derived boundary',question:'What is bounded?',claimRefs:[],patternRefs:[],
      relatedRefs:[],disputes:[],nextQuestions:[],citations:[inherited]}};};
  await knowledge.propose({...proposal(projectId,[makeDerived(citation)]),purpose:'exploration_reading'});
  assert.ok(staged,'the exact basis authorizes its inherited anchor');
  await assert.rejects(knowledge.propose({...proposal(projectId,[makeDerived(mediaCitation(unrelated.anchor))]),
    purpose:'exploration_reading'}),{code:'UNREGISTERED_ANCHOR'});
});
