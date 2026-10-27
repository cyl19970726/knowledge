import {FeedbackSourceRequestSchema,type SourceRecord} from '@commerce/knowledge-contracts';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {authorizeCapability,type CapabilityContext} from './sources.ts';
export interface FeedbackSourcePort {register(context:CapabilityContext,feedbackId:string,expectedDigest:string,key:string):Promise<SourceRecord>}
/** Caller-reported observations enter source custody without changing any knowledge revision. */
export function createFeedbackSourceApplication(port:FeedbackSourcePort){return{
  register(context:CapabilityContext,feedbackId:string,input:unknown,key:string){authorizeCapability(context,'feedback:source');
    if(!feedbackId)throw new KnowledgeError('FEEDBACK_ID_REQUIRED','Feedback ID required',422);
    const parsed=FeedbackSourceRequestSchema.parse(input);
    if(parsed.purpose!==context.purpose)throw new KnowledgeError('PURPOSE_MISMATCH','Feedback source purpose differs from authenticated context',403);
    return port.register(context,feedbackId,parsed.expectedFeedbackDigest,key);
  },
};}
