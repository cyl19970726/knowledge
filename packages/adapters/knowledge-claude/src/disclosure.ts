import type {KnowledgeRef,SourceRecord} from '@commerce/knowledge-contracts';
import type {AskEvidence,ReadContext} from '@commerce/knowledge-application';
import {KnowledgeError} from '@commerce/knowledge-core/types';

/**
 * Sending evidence to Anthropic is a disclosure to an external processor.
 * Source content may go only when its rights policy is explicitly listed; derived Wiki pages only when the operator allows it.
 */
export interface ModelDisclosurePolicy {rightsPolicyIds:readonly string[];allowWikiPages:boolean}
export function createModelDisclosureAuthorizer(options:{policy:ModelDisclosurePolicy;
  sourceRecord:(context:ReadContext,ref:KnowledgeRef)=>Promise<SourceRecord>}){
  const allowed=new Set(options.policy.rightsPolicyIds);
  return async(context:ReadContext,evidence:AskEvidence|readonly AskEvidence[])=>{
    for(const item of Array.isArray(evidence)?evidence:[evidence] as AskEvidence[]){
      if(item.kind==='wiki_page'){
        if(!options.policy.allowWikiPages)throw new KnowledgeError('MODEL_DISCLOSURE_FORBIDDEN','Wiki pages may not be sent to the external model',403);
        continue;
      }
      const record=await options.sourceRecord(context,item.ref);
      const policy=record.provenance?.rightsPolicyRef;
      if(!policy||!allowed.has(policy))
        throw new KnowledgeError('MODEL_DISCLOSURE_FORBIDDEN','A source rights policy does not permit external model processing',403);
    }
  };
}
