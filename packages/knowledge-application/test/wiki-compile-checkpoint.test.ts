import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {createWikiCompileApplication,type WikiCompileOperationPort} from '../src/wiki-compile.ts';
import type {KnowledgeApplication} from '../src/index.ts';
import type {CapabilityContext} from '../src/sources.ts';
import type {SourceEventRecord,SourceRecord,WikiCompileResult} from '../../knowledge-contracts/src/index.ts';
const zero={modelCalls:{state:'known' as const,value:0},tokens:{state:'known' as const,value:0},money:{state:'known' as const,amount:0,currency:'USD',source:'synthetic-local-only'}};
for(const revokeAt of ['dispatch','proposal'] as const)test(`source revoked during ${revokeAt} checkpoint cannot reach the next execution step`,async()=>{
 const scope={projectId:'synthetic-checkpoint',spaceId:'synthetic-space'},purpose='exploration_reading',sourceEventId=randomUUID(),body='合成报告';
 const ref={...scope,domain:'source' as const,objectId:randomUUID(),versionId:randomUUID(),contentDigest:createHash('sha256').update(body).digest('hex')};
 const context:CapabilityContext={scope,purpose,principal:{id:'synthetic-proposer',clientInstallationId:'synthetic-install',projectId:scope.projectId,spaceIds:[scope.spaceId],purposes:[purpose]},
  authorization:{actions:['compile:read','compile:write','ingest:read'],adapterIds:['synthetic'],rightsPolicyIds:[]}};
 let readable=true,providerCalls=0,stages=0,stored:WikiCompileResult|null=null;
 const operations:WikiCompileOperationPort={async reserve(_context,_key,_digest,_request,initial){stored=initial;return {created:true,result:initial};},async start(){return true;},
  async checkpoint(_context,_id,result){stored=structuredClone(result);if(revokeAt==='dispatch'&&result.provider&&result.drafts.length===0||revokeAt==='proposal'&&result.drafts.length>0)readable=false;},
  async finish(_context,_id,result){stored=result;},async get(){return stored;},async lookup(){return stored;}};
 const metadata=():SourceRecord=>({ref,head:ref,sourceSchemaVersion:'synthetic-text/1',sourceKind:'document',assertionKind:'caller_reported',actualCoverage:[],supersedes:null,receiptId:randomUUID(),limitations:[],sourceGroups:[],readability:{metadataVisible:true,contentReadable:readable,anchorResolved:true,assurance:'local_transaction',reasons:[]}});
 const coverage={scopeDescription:'synthetic',returned:0,loaded:0,hasMore:false,nextCursor:null,completeness:'complete' as const,omittedReasons:[],snapshot:{publicationEpoch:0,consistency:'single_scope_snapshot' as const}};
 const reader={async sourceRecord(){return metadata();},async sourceContentBounded(){return {ref,content:body,contentDigest:ref.contentDigest,anchor:null,readability:metadata().readability,
  actualCoverage:{sourceRef:ref,anchors:[],byteCount:Buffer.byteLength(body),coverage:'full' as const,exclusions:[],readAt:new Date().toISOString(),readerAuthority:'synthetic',readProofId:null}};},
  async queryCandidates(){return {data:{items:[]},coverage};},async readCandidate(){assert.fail('No Wiki candidates');},async validateFrozenWiki(){},async assertReadEpoch(){}} as unknown as KnowledgeApplication;
 const app=createWikiCompileApplication({reader,operations,intake:{async get():Promise<SourceEventRecord>{return {id:sourceEventId,request:{sourceRef:ref,adapterId:'synthetic',eventKey:'source-checkpoint',producerSequence:1,occurredAt:new Date().toISOString(),purpose},inputDigest:'a'.repeat(64),source:metadata(),registeredAt:new Date().toISOString(),assurance:'read_time_only',state:'registered'};}},
  provider:{id:'synthetic-compiler',model:'synthetic-no-model',methodVersion:'checkpoint-fixture/1',execution:'local_deterministic',async compile(input){providerCalls++;
   return {proposal:{outcome:'proposed',drafts:[{targetEvidenceId:null,profile:input.profiles.find(item=>item.id==='question')!,identityKey:'synthetic-question',title:'合成问题',summary:'合成待审认识',conditions:[],counterexamples:[],unknowns:['未语义验收'],nextQuestions:[],supportEvidenceIds:[input.evidence[0].id],rationale:'合成依据'}],reason:'Synthetic fixture',gaps:[]},cost:zero,modelReturned:'synthetic-no-model',requestId:'synthetic-request'};}},
  stage:{async stage(){stages++;return {candidateId:randomUUID(),changeSetId:randomUUID(),draftRefs:[],contentHash:'a'.repeat(64),published:false};}}});
 await assert.rejects(app.compile(context,{question:'合成问题',purpose,sourceEventIds:[sourceEventId],queries:['合成'],limit:1,maxPages:1,budget:{maxModelCalls:0,maxReadBytes:80_000,maxMoney:{amount:0,currency:'USD'},deadline:new Date(Date.now()+30_000).toISOString()}},`checkpoint-${revokeAt}`),error=>error instanceof KnowledgeError&&error.code==='SOURCE_FORBIDDEN');
 const result=stored as WikiCompileResult|null;assert.equal(result?.state,'failed');assert.equal(providerCalls,revokeAt==='dispatch'?0:1);assert.equal(stages,0);assert.equal(result?.candidate,null);assert.equal(result?.cost.money.state,'known');
});
