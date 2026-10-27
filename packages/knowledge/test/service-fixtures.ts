import { randomUUID } from 'node:crypto';
import type { AnalysisAdoptionRecord, AnalysisContextSnapshot, AnalysisReadPort, AnalysisResult, Citation, EvidenceAnchor, ObjectRef, VersionRef } from '../../contracts/src/index.ts';
import type { CreativeKnowledgeTask, KnowledgeRevision, KnowledgeScope, RegisteredSource, SourceReadPort } from '../src/types.ts';
import type { ProposeChange } from '../src/schemas.ts';
import type { ScopedUseDecision, ScopedUseDecisionStore } from '../src/admission.ts';

export const ref = (): VersionRef => ({objectId:randomUUID(),versionId:randomUUID()});
export const timestamp = '2026-10-14T00:00:00.000Z';
export const sha = (digit:string) => digit.repeat(64);
export const object = (hash=sha('a')):ObjectRef => ({objectId:randomUUID(),sha256:hash,bytes:100,mimeType:'video/mp4',storage:'r2'});
export const mediaCitation = (anchor:EvidenceAnchor):Citation => ({kind:'media',anchor,supports:'visible sequence'});
export const sourceCitation = (sourceRef:VersionRef):Citation => ({kind:'source',sourceRef,locator:'record:1',supports:'registered statement'});
export const scope = (productVersionRef:VersionRef, overrides:Partial<KnowledgeScope['applicability']>={}):KnowledgeScope => ({
  applicability:{productVersionRefs:[productVersionRef],markets:['US'],languages:['en'],audiences:['adults'],goals:['awareness'],requiredProduction:['phone'],transferRationale:null,...overrides},
  limitations:[],unknowns:[],goalTags:['video_business_actions'],reviewDueAt:null,
});
export const task = (productVersionRef:VersionRef, overrides:Partial<CreativeKnowledgeTask>={}):CreativeKnowledgeTask => ({
  productVersionRef,purpose:'creative_reference',goal:'awareness',audience:'adults',market:'US',language:'en',production:['phone'],query:'hook',tokenBudget:50_000,maxItems:10,...overrides,
});

export class SyntheticAnalysis implements AnalysisReadPort {
  results=new Map<string,AnalysisResult>();
  snapshots=new Map<string,AnalysisContextSnapshot>();
  adoptions=new Map<string,AnalysisAdoptionRecord>();
  scopedDecisions=new Map<string,ScopedUseDecision[]>();
  scopedUseStore:ScopedUseDecisionStore={
    append:async record=>{const key=this.adoptionKey(record.projectId,record.reportRef,record.purpose);this.scopedDecisions.set(key,[record,...(this.scopedDecisions.get(key)??[])]);return record;},
    current:async(projectId,reportRef,purpose)=>this.scopedDecisions.get(this.adoptionKey(projectId,reportRef,purpose))??[],
  };
  private adoptionKey(projectId:string,r:VersionRef,purpose:string) {return `${projectId}/${r.objectId}/${r.versionId}/${purpose}`;}
  getResult(_projectId:string,r:VersionRef) { return Promise.resolve(this.results.get(r.versionId)??null); }
  getContextSnapshot(_projectId:string,versionId:string) { return Promise.resolve(this.snapshots.get(versionId)??null); }
  getCurrentAdoption(projectId:string,r:VersionRef,purpose:string) {return Promise.resolve(this.adoptions.get(this.adoptionKey(projectId,r,purpose))??null);}
  decide(projectId:string,r:VersionRef,purpose:string,decision:AnalysisAdoptionRecord['decision']|null) {
    const key=this.adoptionKey(projectId,r,purpose);
    if(!decision) {this.adoptions.delete(key);this.scopedDecisions.delete(key);return;}
    this.adoptions.set(key,{schemaVersion:'1.0',ref:ref(),analysisResultRef:r,purpose,decision,rationale:'Synthetic independent purpose decision for test fixture',decidedAt:timestamp});
    const result=this.results.get(r.versionId);
    this.scopedDecisions.set(key,result?.evidence.map(anchor=>({id:randomUUID(),projectId,reportRef:r,purpose,anchor,
      channels:result.coverage.channels,mediaScope:anchor.scope,decision,reviewer:'independent-fixture-reviewer',rationale:'Exact synthetic anchor and channels reviewed',decidedAt:timestamp}))??[]);
  }
  add(projectId:string, options:{hash?:string;profile?:'overview'|'fine';providerCount?:number;quality?:AnalysisResult['quality'];assetVersionId?:string;adoptPurpose?:string|null}={}) {
    const assetVersionId=options.assetVersionId??randomUUID();
    const contextRef=ref(); const resultRef=ref(); const original=object(options.hash);
    const anchor:EvidenceAnchor={assetVersionId,scope:{kind:'whole'},sourceRef:ref()};
    const snapshot:AnalysisContextSnapshot={schemaVersion:'1.0',ref:contextRef,projectId,assetVersionId,original,capturedAt:timestamp,
      sourceContext:{providerObservations:Array.from({length:options.providerCount??1},(_,i)=>({schemaVersion:'1.0' as const,ref:ref(),projectId,provider:`provider-${i}`,observedAt:timestamp,
        acquisition:{source:'public_search' as const,sourceRef:ref()},platform:'tiktok',platformPostId:`post-${i}`,creatorAccountId:`creator-${i}`,publisherAccountId:null,advertiserAccountId:null,platformAdId:null,publicDiscoverability:'observed_public' as const}))},
      durationMs:10_000,language:'en',unknowns:['commercial outcome unknown']};
    const result:AnalysisResult={schemaVersion:'1.0',ref:resultRef,projectId,contextSnapshotId:contextRef.versionId,runId:randomUUID(),attemptId:randomUUID(),assetVersionId,
      profile:options.profile??'overview',question:'What is the hook?',purpose:'research',methodDigest:sha('b'),inputDigest:sha('c'),
      coverage:{requested:{kind:'whole'},observed:[{kind:'whole'}],gaps:[],channels:['visual']},payloadRef:object(sha('d')),evidence:[anchor],
      quality:options.quality??{candidate:'original_reviewed',review:'completed_no_findings'},cost:{state:'unknown',reason:'synthetic'},createdAt:timestamp};
    this.results.set(resultRef.versionId,result); this.snapshots.set(contextRef.versionId,snapshot);
    if(options.adoptPurpose!==null) this.decide(projectId,resultRef,options.adoptPurpose??'creative_reference','approved');
    return {result,snapshot,anchor};
  }
}
export class SyntheticSources implements SourceReadPort {
  records=new Map<string,RegisteredSource>();
  getSource(_projectId:string,r:VersionRef) { return Promise.resolve(this.records.get(r.versionId)??null); }
  add(projectId:string,kind:RegisteredSource['kind'],statement:string,productVersionRef:VersionRef|null=null):RegisteredSource {
    const source:RegisteredSource={ref:ref(),projectId,kind,statement,productVersionRef,citations:[sourceCitation(ref())],sourceGroup:`source:${randomUUID()}`,valid:true,limitations:[],reviewDueAt:null};
    this.records.set(source.ref.versionId,source);return source;
  }
}
export function caseRevision(projectId:string,product:VersionRef,analysis:AnalysisResult,anchor:EvidenceAnchor,title='hook case',caseRef=ref()):KnowledgeRevision {
  const citation=mediaCitation(anchor);
  return {kind:'case',ref:caseRef,projectId,title,body:title,scope:scope(product),dependencies:[],sourceGroups:[],artifactRef:null,createdAt:timestamp,analysisQuality:null,
    content:{schemaVersion:'1.0',ref:caseRef,projectId,analysisResultRef:analysis.ref,title,summary:title,citations:[citation],createdAt:timestamp}};
}
export function claimRevision(projectId:string,product:VersionRef,statement:string,citation:Citation,kind:'product_fact'|'observation'='product_fact'):KnowledgeRevision {
  const r=ref();return {kind:'claim',ref:r,projectId,title:statement,body:statement,scope:scope(product),dependencies:[],sourceGroups:[],artifactRef:null,createdAt:timestamp,analysisQuality:null,
    content:{schemaVersion:'1.0',ref:r,projectId,statement,claimKind:kind,citations:[citation],conditions:[],limitations:[],adoption:'candidate',approvedPurpose:null,createdAt:timestamp}};
}
export function proposal(projectId:string,revisions:KnowledgeRevision[],effect:'create'|'narrow'|'dispute'|'withdraw'|'correct'='create',baseVersions:Record<string,string|null>={}):ProposeChange {
  return {projectId,requestKey:randomUUID(),purpose:'creative_reference',proposer:'researcher',rationale:'synthetic integration exercise',methodVersion:'test-v1',cost:{state:'unknown',reason:'synthetic'},
    baseHeads:revisions.map(r=>({objectId:r.ref.objectId,versionId:baseVersions[r.ref.objectId]??null})),
    changes:revisions.map(revision=>({revision,effect,explanation:'synthetic evidence'}))};
}
