import {randomUUID} from 'node:crypto';
import {SourceEventRequestSchema,EntityMentionExtractionSchema,EntityMentionBatchSchema,type SourceEventRequest,type SourceEventRecord,
  type EntityMentionBatch,type KnowledgeRef,type SourceRecord} from '@commerce/knowledge-contracts';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {digest,canonical} from '@commerce/knowledge-core/utils';
import type {KnowledgeApplication,ReadContext} from './index.ts';
import {authorizeCapability,type CapabilityContext} from './sources.ts';
import {validateEntityMentionSpans} from './entity-mentions.ts';

export interface SourceIntakePort {
  receive(context:ReadContext,request:SourceEventRequest,inputDigest:string,source:SourceRecord):Promise<SourceEventRecord>;
  get(context:ReadContext,id:string):Promise<SourceEventRecord|null>;
  lookup(context:ReadContext,adapterId:string,eventKey:string):Promise<SourceEventRecord|null>;
  claimMentions(context:ReadContext,eventId:string,methodVersion:string,inputDigest:string):Promise<string>;
  releaseMentions(context:ReadContext,eventId:string,methodVersion:string,token:string):Promise<void>;
  putMentions(context:ReadContext,event:SourceEventRecord,inputDigest:string,batch:EntityMentionBatch,token:string):Promise<EntityMentionBatch>;
  mentions(context:ReadContext,eventId:string,methodVersion:string):Promise<EntityMentionBatch|null>;
}
export function createSourceIntakeApplication(options:{reader:Pick<KnowledgeApplication,'sourceRecord'|'sourceContentBounded'>;port:SourceIntakePort}){
  function authorize(context:CapabilityContext,action:string,adapterId?:string){
    authorizeCapability(context,action);
    if(!context.principal.clientInstallationId?.trim())throw new KnowledgeError('INSTALLATION_REQUIRED','Source intake requires an authenticated client installation',403);
    if(adapterId&&!context.authorization.adapterIds.includes(adapterId))throw new KnowledgeError('SOURCE_ADAPTER_FORBIDDEN','Source adapter is not authorized',403);
  }
  async function current(context:ReadContext,ref:KnowledgeRef){
    const source=await options.reader.sourceRecord(context,ref);
    if(canonical(source.ref)!==canonical(ref))throw new KnowledgeError('SOURCE_REF_MISMATCH','Source owner returned a different exact version or digest',409);
    if(!source.readability.metadataVisible||!source.readability.contentReadable)
      throw new KnowledgeError('SOURCE_FORBIDDEN','Source is not currently readable for this purpose',403);
    return source;
  }
  async function get(context:CapabilityContext,id:string){
    authorize(context,'ingest:read');const record=await options.port.get(context,id);
    if(!record)throw new KnowledgeError('NOT_FOUND','Source event is unavailable',404);
    authorize(context,'ingest:read',record.request.adapterId);await current(context,record.request.sourceRef);return record;
  }
  return {
    async receive(context:CapabilityContext,input:unknown){
      authorize(context,'ingest:write');const request=SourceEventRequestSchema.parse(input);
      authorize(context,'ingest:write',request.adapterId);
      if(request.purpose!==context.purpose)throw new KnowledgeError('PURPOSE_MISMATCH','Event purpose differs from the authenticated purpose',403);
      if(request.sourceRef.projectId!==context.scope.projectId||request.sourceRef.spaceId!==context.scope.spaceId)
        throw new KnowledgeError('REF_SCOPE_MISMATCH','Event source is outside the authenticated scope',403);
      // Metadata only. The owner continues to hold original bytes; registration is not publication admission.
      const source=await current(context,request.sourceRef);
      return options.port.receive(context,request,digest(request),source);
    },get,
    async lookup(context:CapabilityContext,adapterId:string,eventKey:string){
      authorize(context,'ingest:read',adapterId);const record=await options.port.lookup(context,adapterId,eventKey);
      if(record)await current(context,record.request.sourceRef);return record;
    },
    async recordMentions(context:CapabilityContext,eventId:string,input:unknown,maxBytes:number){
      authorize(context,'ingest:mentions');const extraction=EntityMentionExtractionSchema.parse(input);
      const event=await get(context,eventId);authorize(context,'ingest:mentions',event.request.adapterId);
      const old=await options.port.mentions(context,eventId,extraction.methodVersion),inputDigest=digest(extraction);
      if(old){
        if(old.inputDigest!==inputDigest)throw new KnowledgeError('IDEMPOTENCY_CONFLICT','This extraction method already has different proposed mentions',409);
        return old;
      }
      const token=await options.port.claimMentions(context,eventId,extraction.methodVersion,inputDigest);
      try{
        const completed=await options.port.mentions(context,eventId,extraction.methodVersion);
        if(completed){
          if(completed.inputDigest!==inputDigest)throw new KnowledgeError('IDEMPOTENCY_CONFLICT','This extraction method already has different proposed mentions',409);
          return completed;
        }
      const source=await options.reader.sourceContentBounded(context,event.request.sourceRef,null,maxBytes);
      if(!source.readability.contentReadable||source.actualCoverage.coverage!=='full')
        throw new KnowledgeError('MENTION_SOURCE_INCOMPLETE','Entity spans require a complete bounded text read',422);
      const checked=validateEntityMentionSpans(source.content,extraction);
      // Recheck after awaited content IO. This is read-time assurance, not an external publication lease.
      const metadata=await current(context,event.request.sourceRef);
      const batch=EntityMentionBatchSchema.parse({id:randomUUID(),sourceEventId:event.id,methodVersion:checked.methodVersion,inputDigest,
        sourceRef:event.request.sourceRef,sourceGroups:metadata.sourceGroups,mentions:checked.mentions.map(item=>({...item,id:randomUUID(),
          sourceRef:event.request.sourceRef,resolution:'unresolved'})),actualReadCoverage:source.actualCoverage,
        semanticCoverage:'unknown',provenance:'caller_proposed',recordedAt:new Date().toISOString()});
      return await options.port.putMentions(context,event,inputDigest,batch,token);
      }finally{await options.port.releaseMentions(context,eventId,extraction.methodVersion,token).catch(()=>{});}

    },
    async mentions(context:CapabilityContext,eventId:string,methodVersion:string){
      const event=await get(context,eventId);authorize(context,'ingest:read',event.request.adapterId);
      return options.port.mentions(context,eventId,methodVersion);
    },
  };
}
