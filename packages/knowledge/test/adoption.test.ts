import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createKnowledgeService } from '../src/service.ts';
import type { KnowledgeStore, Dependency } from '../src/types.ts';
import type { ScopedUseDecisionStore, ScopedUseDecision } from '../src/admission.ts';
import { SyntheticAnalysis, timestamp } from './service-fixtures.ts';

function setup() {
  const projectId='adoption-test';const analysis=new SyntheticAnalysis();const row=analysis.add(projectId);
  let decision:'approved'|'exploration_only'|'rejected'|null=null;
  const reader={getResult:analysis.getResult.bind(analysis),getContextSnapshot:analysis.getContextSnapshot.bind(analysis),
    getCurrentAdoption:async (_projectId:string,ref:typeof row.result.ref,purpose:string)=>decision?{schemaVersion:'1.0' as const,ref:{objectId:randomUUID(),versionId:randomUUID()},analysisResultRef:ref,purpose,decision,rationale:'independent review',decidedAt:timestamp}:null};
  let scoped:ScopedUseDecision[]=[];
  const scopedUseDecisions={current:async (currentProjectId:string,reportRef:typeof row.result.ref,purpose:string)=>scoped.filter(record=>record.projectId===currentProjectId && record.reportRef.objectId===reportRef.objectId && record.reportRef.versionId===reportRef.versionId && record.purpose===purpose),append:async(record:ScopedUseDecision)=>record} as ScopedUseDecisionStore;
  const store=new Proxy({validate:async()=>({valid:true,issues:[]})},{get(target,key){return Reflect.get(target,key)??(async()=>null);}}) as unknown as KnowledgeStore;
  const knowledge=createKnowledgeService({store,analysis:reader,scopedUseDecisions});
  const dependency:Dependency={domain:'analysis',ref:row.result.ref,role:'uses',critical:true,useScope:{channels:['visual'],mediaScope:{kind:'segment',startMs:1000,endMs:2000}}};
  return {projectId,knowledge,dependency,setDecision:(next:typeof decision)=>{decision=next;},setScoped:(next:ScopedUseDecision[])=>{scoped=next;},row};
}
test('current report rejection blocks the same purpose even for exploration',async()=>{
  const h=setup();h.setDecision('rejected');
  await assert.rejects(h.knowledge.revalidate(h.projectId,[h.dependency],'exploration_reading'),/rejected/i);
  h.setDecision(null);
  await h.knowledge.revalidate(h.projectId,[h.dependency],'exploration_reading');
  await assert.rejects(h.knowledge.revalidate(h.projectId,[h.dependency],'creative_reference'),/adoption/i);
});
test('production requires matching scoped approval and a local audio rejection does not reject visual use',async()=>{
  const h=setup();h.setDecision('approved');
  const record=(decision:ScopedUseDecision['decision'],channels:ScopedUseDecision['channels']):ScopedUseDecision=>({
    id:randomUUID(),projectId:h.projectId,reportRef:h.row.result.ref,purpose:'creative_reference',channels,mediaScope:{kind:'whole'},decision,reviewer:'reviewer',rationale:'synthetic',decidedAt:timestamp,
  });
  await assert.rejects(h.knowledge.revalidate(h.projectId,[h.dependency],'creative_reference'),/channel and segment approval/i);
  h.setScoped([record('approved',['visual']),record('rejected',['audio'])]);
  await h.knowledge.revalidate(h.projectId,[h.dependency],'creative_reference');
  await assert.rejects(h.knowledge.revalidate(h.projectId,[{...h.dependency,useScope:undefined}],'creative_reference'),/covered channels and media seconds/i);
  h.row.result.coverage.channels.push('audio');
  await assert.rejects(h.knowledge.revalidate(h.projectId,[{...h.dependency,useScope:{channels:['audio'],mediaScope:{kind:'whole'}}}],'creative_reference'),/rejected/i);
});
test('unscoped exploration cannot conceal a scoped rejection for the same report and purpose',async()=>{
  const h=setup();h.setDecision('approved');
  h.setScoped([{id:randomUUID(),projectId:h.projectId,reportRef:h.row.result.ref,purpose:'exploration_reading',channels:['audio'],mediaScope:{kind:'segment',startMs:0,endMs:1000},decision:'rejected',reviewer:'reviewer',rationale:'synthetic rejection',decidedAt:timestamp}]);
  await assert.rejects(h.knowledge.revalidate(h.projectId,[{...h.dependency,useScope:undefined}],'exploration_reading'),/rejected/i);
});
test('analysis use cannot claim an unobserved channel or seconds outside the requested range',async()=>{
  const h=setup();h.setDecision('approved');
  await assert.rejects(h.knowledge.revalidate(h.projectId,[{...h.dependency,useScope:{channels:['audio'],mediaScope:{kind:'segment',startMs:1000,endMs:2000}}}],'creative_reference'),/channel absent/i);
  h.row.result.coverage.requested={kind:'segment',startMs:1000,endMs:2000};
  h.row.result.coverage.observed=[{kind:'segment',startMs:1000,endMs:2000}];
  h.row.result.evidence=[{...h.row.anchor,scope:{kind:'segment',startMs:1000,endMs:2000}}];
  await assert.rejects(h.knowledge.revalidate(h.projectId,[{...h.dependency,useScope:{channels:['visual'],mediaScope:{kind:'segment',startMs:0,endMs:1000}}}],'creative_reference'),/request range/i);
});
test('production needs continuous observed segments; exploratory whole reading retains known gaps',async()=>{
  const h=setup();h.setDecision('approved');
  h.setScoped([{id:randomUUID(),projectId:h.projectId,reportRef:h.row.result.ref,purpose:'creative_reference',channels:['visual'],mediaScope:{kind:'whole'},decision:'approved',reviewer:'reviewer',rationale:'synthetic approval',decidedAt:timestamp}]);
  h.row.result.coverage.observed=[{kind:'segment',startMs:0,endMs:1500},{kind:'segment',startMs:1800,endMs:3000}];
  h.row.result.evidence=[{...h.row.anchor,scope:{kind:'segment',startMs:0,endMs:1000}}];
  await assert.rejects(h.knowledge.revalidate(h.projectId,[h.dependency],'creative_reference'),/not observed/i);
  h.row.result.coverage.observed=[{kind:'segment',startMs:0,endMs:1500},{kind:'segment',startMs:1500,endMs:3000}];
  await h.knowledge.revalidate(h.projectId,[h.dependency],'creative_reference');
  const whole={...h.dependency,useScope:{channels:['visual' as const],mediaScope:{kind:'whole' as const}}};
  await assert.rejects(h.knowledge.revalidate(h.projectId,[whole],'creative_reference'),/not observed/i);
  await h.knowledge.revalidate(h.projectId,[whole],'exploration_reading');
});
test('a Claim-specific refusal follows its critical Case analysis path without affecting a sibling Claim',async()=>{
  const projectId='claim-use-test';const analysis=new SyntheticAnalysis();const row=analysis.add(projectId);
  const caseRef={objectId:randomUUID(),versionId:randomUUID()};
  const refusedClaim={objectId:randomUUID(),versionId:randomUUID()};
  const allowedClaim={objectId:randomUUID(),versionId:randomUUID()};
  const analysisUse:Dependency={domain:'analysis',ref:row.result.ref,role:'derived_from',critical:true,useScope:{anchor:row.anchor,channels:['visual'],mediaScope:{kind:'whole'}}};
  const views=new Map<string,unknown>([
    [caseRef.versionId,{published:true,current:true,validity:{valid:true,issues:[]},review:{purpose:'creative_reference',decision:'approved_for_purpose'},revision:{kind:'case',ref:caseRef,dependencies:[analysisUse]}}],
    ...[refusedClaim,allowedClaim].map(ref=>[ref.versionId,{published:true,current:true,validity:{valid:true,issues:[]},review:{purpose:'creative_reference',decision:'approved_for_purpose'},revision:{kind:'claim',ref,dependencies:[{domain:'knowledge',ref:caseRef,role:'supports',critical:true}]}}] as const),
  ]);
  const store=new Proxy({validate:async()=>({valid:true,issues:[]}),get:async(_projectId:string,ref:typeof caseRef)=>views.get(ref.versionId)??null},
    {get(target,key){return Reflect.get(target,key)??(async()=>null);}}) as unknown as KnowledgeStore;
  const record=(claimRef:typeof refusedClaim,decision:ScopedUseDecision['decision']):ScopedUseDecision=>({id:randomUUID(),projectId,reportRef:row.result.ref,purpose:'creative_reference',claimRef,anchor:row.anchor,channels:['visual'],mediaScope:{kind:'whole'},decision,reviewer:'reviewer',rationale:'exact Claim review',decidedAt:timestamp});
  const decisions=[record(refusedClaim,'rejected'),record(allowedClaim,'approved')];
  const scopedUseDecisions={current:async()=>decisions,append:async(row:ScopedUseDecision)=>row} as ScopedUseDecisionStore;
  const knowledge=createKnowledgeService({store,analysis,scopedUseDecisions});
  const useClaim=(ref:typeof refusedClaim):Dependency=>({domain:'knowledge',ref,role:'uses',critical:true});
  await assert.rejects(knowledge.revalidate(projectId,[useClaim(refusedClaim)],'creative_reference'),/rejected/i);
  await knowledge.revalidate(projectId,[useClaim(allowedClaim)],'creative_reference');
});
test('publication fence rejects a scoped decision added after preflight',async()=>{
  const h=setup();
  const client={query:async()=>({rows:[{epoch:'8'}]})};
  await h.knowledge.assertEpoch(h.projectId,8,client as never);
  await assert.rejects(h.knowledge.assertEpoch(h.projectId,7,client as never),/changed/i);
  await assert.rejects(h.knowledge.publishPrepared({projectId:h.projectId,changeSetId:randomUUID(),contentHash:'a'.repeat(64),knowledgeEpoch:7},client as never),/epoch|changed/i);
});
test('publication preflight rejects an epoch change occurring during revalidation',async()=>{
  const projectId='preflight-epoch';const analysis=new SyntheticAnalysis();const row=analysis.add(projectId,{adoptPurpose:null});
  let epoch=1;
  const store=new Proxy({epoch:async()=>epoch,getChangeSet:async()=>({projectId,contentHash:'a'.repeat(64),purpose:'exploration_reading',changes:[{effect:'create',revision:{ref:row.result.ref,dependencies:[{domain:'analysis',ref:row.result.ref,role:'uses',critical:true}]}}]}),
    get:async()=>({published:false,review:null}),validate:async()=>{epoch=2;return {valid:true,issues:[]};}},
    {get(target,key){return Reflect.get(target,key)??(async()=>null);}}) as never;
  const knowledge=createKnowledgeService({store,analysis});
  await assert.rejects(knowledge.preparePublication(projectId,'synthetic','a'.repeat(64)),/changed during publication preflight/i);
});
