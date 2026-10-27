import {SourceUpsertSchema,type SourceUpsert,type SourceRecord,type SourceContent,type KnowledgeRef,type SourceAccessProof} from '@commerce/knowledge-contracts';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import type {ReadContext,SourceOwnerPort} from './index.ts';
export interface CapabilityPrincipal {actions:readonly string[];adapterIds:readonly string[];rightsPolicyIds:readonly string[]}
export interface CapabilityContext extends ReadContext {authorization:CapabilityPrincipal}
export function authorizeCapability(context:CapabilityContext,action:string):void {
  if(context.scope.projectId!==context.principal.projectId||!context.principal.spaceIds.includes(context.scope.spaceId)||
    !context.principal.purposes.includes(context.purpose)||!context.authorization.actions.includes(action))
    throw new KnowledgeError('CAPABILITY_FORBIDDEN','Principal, space, purpose or action is not authorized',403);
}
export interface SourceRegistryPort extends SourceOwnerPort {
  upsert(context:CapabilityContext,input:SourceUpsert,key:string):Promise<SourceRecord>;
  revoke(context:CapabilityContext,ref:KnowledgeRef,expectedGeneration:number,key:string):Promise<SourceRecord>;
  proof(context:ReadContext,ref:KnowledgeRef):Promise<SourceAccessProof>;
}
/** Source owner custody and rights stay explicit. Registration does not invent observation or independent support. */
export function createSourceApplication(port:SourceRegistryPort){return{
  async upsert(context:CapabilityContext,input:unknown,key:string){
    authorizeCapability(context,'sources:write');const parsed=SourceUpsertSchema.parse(input);
    if(!context.authorization.adapterIds.includes(parsed.externalIdentity.adapterId)||!context.authorization.rightsPolicyIds.includes(parsed.rightsPolicyRef))
      throw new KnowledgeError('SOURCE_RIGHTS_FORBIDDEN','Adapter or rights policy is not authorized',403);
    if(parsed.actualCoverage.length)throw new KnowledgeError('SOURCE_COVERAGE_UNVERIFIED','Caller metadata cannot assert actual knowledge-service reads',422);
    return port.upsert(context,parsed,key);
  },
  async revoke(context:CapabilityContext,ref:KnowledgeRef,expectedGeneration:number,key:string){
    authorizeCapability(context,'sources:revoke');return port.revoke(context,ref,expectedGeneration,key);
  },
  record:(context:ReadContext,ref:KnowledgeRef)=>port.readRecord(context.scope,ref,context),
  content:(context:ReadContext,ref:KnowledgeRef,anchor:unknown)=>port.readContent(context.scope,ref,anchor,context),
  proof:(context:ReadContext,ref:KnowledgeRef)=>port.proof(context,ref),
};}
