import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createSourceIntakeApplication,type SourceIntakePort} from '../src/source-intake.ts';
import type {CapabilityContext} from '../src/sources.ts';
import type {SourceEventRecord,SourceRecord,EntityMentionBatch} from '../../knowledge-contracts/src/index.ts';

test('source mention claim remains owned until awaited persistence completes, and releases after failure',async()=>{
 const scope={projectId:'synthetic-claim',spaceId:'synthetic-space'},purpose='exploration_reading',body='品牌甲',token=randomUUID();
 const ref={...scope,domain:'source' as const,objectId:randomUUID(),versionId:randomUUID(),contentDigest:createHash('sha256').update(body).digest('hex')};
 const metadata:SourceRecord={ref,head:ref,sourceSchemaVersion:'synthetic/1',sourceKind:'document',assertionKind:'source_claim',sourceGroups:[],actualCoverage:[],limitations:[],supersedes:null,receiptId:randomUUID(),
  readability:{metadataVisible:true,contentReadable:true,anchorResolved:true,assurance:'local_transaction',reasons:[]}};
 const event:SourceEventRecord={id:randomUUID(),request:{sourceRef:ref,adapterId:'synthetic',eventKey:'synthetic-claim-event',producerSequence:1,purpose,occurredAt:new Date().toISOString()},inputDigest:'a'.repeat(64),source:metadata,registeredAt:new Date().toISOString(),state:'registered',assurance:'read_time_only'};
 const context:CapabilityContext={scope,purpose,principal:{id:'synthetic-reader',clientInstallationId:'synthetic',projectId:scope.projectId,spaceIds:[scope.spaceId],purposes:[purpose]},authorization:{actions:['ingest:read','ingest:mentions'],adapterIds:['synthetic'],rightsPolicyIds:[]}};
 let held=false,stored:EntityMentionBatch|null=null,fail=false,releases=0;
 const port:SourceIntakePort={async receive(){return event;},async get(){return event;},async lookup(){return event;},async mentions(){return stored;},
  async claimMentions(){held=true;return token;},async releaseMentions(){held=false;releases++;},async putMentions(_context,_event,_digest,batch){
   await new Promise(resolve=>setImmediate(resolve));assert.equal(held,true,'persistence must finish before its claim is released');
   if(fail)throw new Error('Synthetic persistence failure');stored=batch;return batch;}};
 const app=createSourceIntakeApplication({port,reader:{async sourceRecord(){return metadata;},async sourceContentBounded(){return {ref,content:body,contentDigest:ref.contentDigest,anchor:null,readability:metadata.readability,actualCoverage:{sourceRef:ref,anchors:[],byteCount:Buffer.byteLength(body),coverage:'full',exclusions:[],readAt:new Date().toISOString(),readerAuthority:'synthetic',readProofId:null}};}}});
 const extraction={methodVersion:'claim-fixture/1',mentions:[{entityType:'brand',surface:body,startByte:0,endByte:Buffer.byteLength(body)}]};
 await app.recordMentions(context,event.id,extraction,1000);assert.equal(held,false);assert.equal(releases,1);
 stored=null;fail=true;await assert.rejects(app.recordMentions(context,event.id,{...extraction,methodVersion:'claim-fixture/2'},1000),/Synthetic persistence failure/);
 assert.equal(held,false);assert.equal(releases,2);
});
