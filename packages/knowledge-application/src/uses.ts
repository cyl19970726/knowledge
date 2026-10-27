import {UseInputSchema,FeedbackInputSchema,type UseInput,type UseRecord,type FeedbackInput,type FeedbackRecord,type ChangesResult} from '@commerce/knowledge-contracts';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import type {CapabilityContext} from './sources.ts';
import {authorizeCapability} from './sources.ts';
import type {ReadContext} from './index.ts';
export interface UseFeedbackPort {
 use(context:CapabilityContext,input:UseInput,key:string):Promise<UseRecord>;
 feedback(context:CapabilityContext,input:FeedbackInput,key:string):Promise<FeedbackRecord>;
 getUse(context:ReadContext,id:string):Promise<UseRecord|null>;
 getFeedback(context:ReadContext,id:string):Promise<FeedbackRecord|null>;
 changes(context:ReadContext,after:string|undefined,limit:number,useId?:string,feedbackId?:string):Promise<{data:ChangesResult;nextCursor:string|null;hasMore:boolean}>;
}
export function createUseFeedbackApplication(port:UseFeedbackPort){return{
 async use(context:CapabilityContext,input:unknown,key:string){authorizeCapability(context,'uses:write');const parsed=UseInputSchema.parse(input);
   if(parsed.context.authority!=='caller_reported'||!context.authorization.adapterIds.includes(parsed.context.adapterId)||parsed.purpose!==context.purpose)
    throw new KnowledgeError('EXTERNAL_CONTEXT_FORBIDDEN','External context and purpose must match the authorized caller adapter',403);
   return port.use(context,parsed,key);},
 async feedback(context:CapabilityContext,input:unknown,key:string){authorizeCapability(context,'feedback:write');const parsed=FeedbackInputSchema.parse(input);
   if(parsed.purpose!==context.purpose||parsed.context.authority!=='caller_reported'||!context.authorization.adapterIds.includes(parsed.context.adapterId))
    throw new KnowledgeError('EXTERNAL_CONTEXT_FORBIDDEN','Feedback purpose and caller adapter must match the authenticated context',403);
   return port.feedback(context,parsed,key);},
 getUse:(context:ReadContext,id:string)=>port.getUse(context,id),getFeedback:(context:ReadContext,id:string)=>port.getFeedback(context,id),
 changes:(context:ReadContext,after:string|undefined,limit:number,useId?:string,feedbackId?:string)=>port.changes(context,after,limit,useId,feedbackId),
};}
