import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createAskWikiService,type AskOperationPort,type AskReader,type AskEvidence} from '../src/ask.ts';
import {createKnowledgeApplication,type BoundedWikiPage} from '../src/index.ts';
import type {CapabilityContext} from '../src/sources.ts';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import type {KnowledgeStore,RevisionView} from '../../knowledge/src/types.ts';
import {getWikiPageProfile,wikiPageProfileFingerprint,wikiPageInputFingerprint,wikiPageReadsetFingerprint,
  type WikiPageRevision} from '../../knowledge/src/wiki-page.ts';
import {AskResultSchema,type AskResult,type KnowledgeRef,type SourceRecord} from '../../knowledge-contracts/src/index.ts';
type SourceGroup=NonNullable<AskResult['evidence'][number]['sourceGroups']>[number];

const scope={projectId:'provenance-project',spaceId:'provenance-space'};
const purpose='exploration_reading';
const context:CapabilityContext={scope,purpose,principal:{id:'reader',clientInstallationId:'installation',projectId:scope.projectId,
  spaceIds:[scope.spaceId],purposes:[purpose]},authorization:{actions:['ask:write'],adapterIds:[],rightsPolicyIds:[]}};
const sourceText='同一原片的合成摘录';
const sourceDigest=createHash('sha256').update(sourceText,'utf8').digest('hex');
const sourceRef:KnowledgeRef={...scope,domain:'source',objectId:randomUUID(),versionId:randomUUID(),contentDigest:sourceDigest};
const knownGroup:SourceGroup={id:'original-film-A',status:'known',authority:'owner-custody'};
const readable={metadataVisible:true,contentReadable:true,anchorResolved:false,assurance:'owner_lease' as const,reasons:[]};
const coverage={sourceRef,anchors:[],byteCount:Buffer.byteLength(sourceText,'utf8'),coverage:'full' as const,exclusions:[],
  readAt:new Date().toISOString(),readerAuthority:'synthetic-owner',readProofId:null};

function harness(options:{wikiGroups:string[][];ownerGroups:SourceGroup[];metadataReadable?:boolean;metadataError?:boolean;
  revokeAfterRead?:boolean;metadataDigestMissing?:boolean}){
  let providerCalls=0,sourceReads=0,metadataReads=0,finished:AskResult|null=null;
  let seen:readonly AskEvidence[]=[];
  const pages:BoundedWikiPage[]=options.wikiGroups.map((groups,index)=>({
    ref:{...scope,domain:'knowledge',objectId:randomUUID(),versionId:randomUUID(),contentDigest:'a'.repeat(64)},
    title:`合成报告 ${index+1}`,body:`合成报告 ${index+1} 的准确正文`,conditions:[],counterexamples:[],unknowns:[],
    citations:[{ref:{...sourceRef,contentDigest:null},locator:null,supports:'合成引文'}],sourceGroups:groups,storageDigest:'b'.repeat(64),payloadBytes:100,admitted:true,
  }));
  const record:SourceRecord={ref:sourceRef,head:null,sourceSchemaVersion:'1',sourceKind:'video',assertionKind:'source_claim',
    sourceGroups:options.ownerGroups,readability:{...readable,contentReadable:options.metadataReadable??true},actualCoverage:[coverage],
    limitations:[],supersedes:null,receiptId:randomUUID()};
  const reader={
    async queryCandidates(){return {data:{items:pages.map(page=>({ref:{objectId:page.ref.objectId,versionId:page.ref.versionId},
      title:page.title,payloadBytes:page.payloadBytes,storageDigest:page.storageDigest}))},coverage:{scopeDescription:'synthetic scope',
      returned:pages.length,loaded:pages.length,hasMore:false,nextCursor:null,completeness:'bounded',omittedReasons:[],
      snapshot:{publicationEpoch:1,consistency:'single_scope_snapshot'}}};},
    async readCandidate(_context:unknown,candidate:{ref:{objectId:string}}){return pages.find(page=>page.ref.objectId===candidate.ref.objectId)!;},
    async validateFrozenWiki(){},async assertReadEpoch(){},
    async sourceContentBounded(_context:unknown,ref:KnowledgeRef){assert.equal(ref.contentDigest,sourceDigest,'bounded owner read needs metadata digest');
      sourceReads++;return {ref:sourceRef,contentDigest:sourceDigest,content:sourceText,anchor:null,
      actualCoverage:coverage,readability:readable};},
    async sourceRecord(_context:unknown,ref:KnowledgeRef){
      assert.equal(ref.contentDigest,sourceReads===0?null:sourceDigest,'citation metadata is resolved before the bounded read');
      metadataReads++;
      if(options.metadataError)throw new KnowledgeError('SOURCE_FORBIDDEN','Owner revoked metadata',403);
      return {...record,ref:options.metadataDigestMissing?{...sourceRef,contentDigest:null}:sourceRef,
        readability:{...record.readability,contentReadable:options.revokeAfterRead&&sourceReads>0?false:record.readability.contentReadable}};},
  } as unknown as AskReader;
  const operations:AskOperationPort={async reserve(_ctx,_key,_digest,_request,initial){return {created:true,result:initial};},
    async start(){return true;},async checkpoint(){},async finish(_ctx,_id,result){finished=result;},async get(){return finished;},async lookup(){return null;}};
  const service=createAskWikiService({reader,operations,provider:{id:'synthetic',model:'synthetic',
    async answer(input){providerCalls++;seen=input.evidence;return {answer:{outcome:'answered',claims:[{text:'有据合成回答',evidenceIds:['w1']}],
      reason:'合成测试',gaps:[]},cost:{modelCalls:{state:'known',value:1},tokens:{state:'known',value:0},
        money:{state:'known',amount:0,currency:'USD',source:'synthetic'}},modelReturned:'synthetic',requestId:null};}}});
  const ask=()=>service.ask(context,{question:'报告是否来自同一原片',purpose,limit:3,maxPages:1,includeSourceContent:true,
    budget:{maxModelCalls:1,maxReadBytes:20000,deadline:new Date(Date.now()+60_000).toISOString(),maxMoney:null}},randomUUID());
  return {ask,seen:()=>seen,providerCalls:()=>providerCalls,sourceReads:()=>sourceReads,metadataReads:()=>metadataReads,finished:()=>finished};
}

test('provider and persisted readset retain shared Wiki lineage and exact owner source groups without counting independent votes',async()=>{
  const ownerGroups:SourceGroup[]=[knownGroup,{id:null,status:'unknown',authority:null}];
  const h=harness({wikiGroups:[['original-film-A'],['original-film-A']],ownerGroups});
  const result=await h.ask();
  assert.equal(result.state,'answered');assert.equal(h.providerCalls(),1);assert.equal(h.sourceReads(),1);
  const wiki=h.seen().filter(item=>item.kind==='wiki_page');
  assert.equal(wiki.length,2);
  assert.deepEqual(wiki.map(item=>item.sourceGroups),[
    [{id:'original-film-A',status:'known',authority:'knowledge-revision-lineage'}],
    [{id:'original-film-A',status:'known',authority:'knowledge-revision-lineage'}],
  ]);
  assert.deepEqual(h.seen().find(item=>item.kind==='source_content')?.sourceGroups,ownerGroups);
  assert.deepEqual(AskResultSchema.parse(result).evidence.map(item=>item.sourceGroups),h.seen().map(item=>item.sourceGroups));
});

test('bounded candidate read returns the revision lineage without deriving source IDs',async()=>{
  const profile=getWikiPageProfile('concept','1')!;
  const revision:WikiPageRevision={kind:'wiki_page',ref:{objectId:randomUUID(),versionId:randomUUID()},projectId:scope.projectId,
    title:'合成 Wiki 页',body:'准确正文',scope:{applicability:{productVersionRefs:[],platforms:[],markets:[],languages:[],
      audiences:[],goals:[],requiredProduction:[],transferRationale:null},limitations:[],unknowns:[],reviewDueAt:null},
    content:{schemaVersion:'1.0',profile:{id:'concept',version:'1'},identity:{key:'synthetic-page',aliases:[]},summary:'合成摘要',
      conditions:[],counterexamples:[],unknowns:[],nextQuestions:[],citations:[],navigation:[]},
    binding:{bindingKind:'wiki_page',spaceId:scope.spaceId,specificationId:'synthetic-spec',specificationVersion:'1',
      contentVersion:'wiki_page/1.0',methodVersion:'synthetic-method',policyVersion:'synthetic-policy',
      inputFingerprint:'0'.repeat(64),readsetFingerprint:'0'.repeat(64),profileFingerprint:wikiPageProfileFingerprint(profile)},
    dependencies:[],sourceGroups:['original-film-A'],artifactRef:null,createdAt:new Date().toISOString(),analysisQuality:null};
  revision.binding.readsetFingerprint=wikiPageReadsetFingerprint(revision);
  revision.binding.inputFingerprint=wikiPageInputFingerprint(revision);
  const review={id:randomUUID(),projectId:scope.projectId,changeSetId:randomUUID(),contentHash:'a'.repeat(64),
    reviewer:'synthetic-reviewer',policyVersion:'synthetic-policy',purpose,decision:'approved_for_purpose' as const,
    rationale:'synthetic approval',createdAt:new Date().toISOString()};
  const view:RevisionView={revision,current:true,published:true,review,validity:{valid:true,issues:[]}};
  const frozen={kind:'wiki_page' as const,spaceId:scope.spaceId,published:true,current:true,review,validity:view.validity,
    storageDigest:'b'.repeat(64),payloadBytes:100,criticalSources:[],criticalSourcesComplete:true};
  const store={inspectFrozen:async()=>frozen,getBounded:async()=>({view,storageDigest:frozen.storageDigest,payloadBytes:frozen.payloadBytes})} as unknown as KnowledgeStore;
  const app=createKnowledgeApplication({store,receipts:{async save(){},async get(){return null;}}});
  const page=await app.readCandidate(context,{ref:revision.ref,title:revision.title,payloadBytes:100,storageDigest:frozen.storageDigest},1000);
  assert.equal(page.admitted,true);assert.deepEqual(page.sourceGroups,['original-film-A']);
});

test('empty Wiki and owner provenance stays explicitly unknown, without generated group IDs',async()=>{
  const h=harness({wikiGroups:[[]],ownerGroups:[]});const result=await h.ask();
  assert.equal(result.state,'answered');
  assert.deepEqual(result.evidence.map(item=>item.sourceGroups),[
    [{id:null,status:'unknown',authority:null}],[{id:null,status:'unknown',authority:null}],
  ]);
});

test('metadata that forbids content leaves a gap and never starts bounded source read',async()=>{
  const h=harness({wikiGroups:[['original-film-A']],ownerGroups:[knownGroup],metadataReadable:false});
  const result=await h.ask();
  assert.equal(h.sourceReads(),0);assert.equal(h.metadataReads(),1);assert.equal(h.providerCalls(),1);
  assert.equal(result.state,'answered');assert.ok(result.gaps.some(gap=>gap.includes('metadata does not permit content')));
  assert.equal(result.evidence.some(item=>item.kind==='source_content'),false);
});

test('owner metadata 403 before content read is a visible gap without a null-digest owner call',async()=>{
  const h=harness({wikiGroups:[['original-film-A']],ownerGroups:[knownGroup],metadataError:true});
  const result=await h.ask();
  assert.equal(h.sourceReads(),0);assert.equal(h.providerCalls(),1);assert.equal(result.state,'answered');
  assert.ok(result.gaps.some(gap=>gap.includes('SOURCE_FORBIDDEN')));
  assert.equal(result.evidence.some(item=>item.kind==='source_content'),false);
});

test('metadata without an exact digest never starts a bounded owner read',async()=>{
  const h=harness({wikiGroups:[['original-film-A']],ownerGroups:[knownGroup],metadataDigestMissing:true});
  const result=await h.ask();
  assert.equal(h.sourceReads(),0);assert.equal(result.state,'answered');
  assert.ok(result.gaps.some(gap=>gap.includes('no exact content digest')));
});

test('dispatch revalidation blocks provider when owner revokes content after the bounded read',async()=>{
  const h=harness({wikiGroups:[['original-film-A']],ownerGroups:[knownGroup],revokeAfterRead:true});
  await assert.rejects(h.ask(),error=>error instanceof KnowledgeError&&error.code==='ASK_READSET_INVALIDATED');
  assert.equal(h.sourceReads(),1);assert.ok(h.metadataReads()>=2);assert.equal(h.providerCalls(),0);
  assert.equal(h.finished()?.state,'failed');assert.match(h.finished()?.reason??'',/ASK_READSET_INVALIDATED/);
});
