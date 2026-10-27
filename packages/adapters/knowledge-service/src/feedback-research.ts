import type {Pool} from 'pg';
import type {KnowledgeRef} from '@commerce/knowledge-contracts';
import type {FeedbackResearchPort,ReadContext} from '@commerce/knowledge-application';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {createPgUseFeedbackPort} from './uses.ts';
export function createPgFeedbackResearchPort(pool:Pool):FeedbackResearchPort{return{
  async validateLinks(context:ReadContext,feedbackIds:readonly string[],sourceRefs:readonly KnowledgeRef[]){
    if(context.scope.projectId!==context.principal.projectId||!context.principal.spaceIds.includes(context.scope.spaceId)||
      !context.principal.purposes.includes(context.purpose))throw new KnowledgeError('FEEDBACK_FORBIDDEN','Feedback lineage context is unauthorized',403);
    const feedback=createPgUseFeedbackPort(pool);
    for(const id of feedbackIds){const record=await feedback.getFeedback(context,id),ref=record?.sourceRef;
      if(!record||record.status!=='observed'||record.maintenanceState!=='linked'||!ref||
        !sourceRefs.some(item=>item.domain==='source'&&item.projectId===ref.projectId&&item.spaceId===ref.spaceId&&
          item.objectId===ref.objectId&&item.versionId===ref.versionId&&item.contentDigest===ref.contentDigest))
        throw new KnowledgeError('FEEDBACK_SOURCE_MISMATCH','Feedback must be linked to an exact admitted source in this research request',409);
    }
  },
};}
