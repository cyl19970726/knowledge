import {ReviewRequestSchema,ReviewDecisionSchema,type ReviewRequest,type ReviewDecision,type ReviewTicket,type FinalizeReceipt,type CandidateView} from '@commerce/knowledge-contracts';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {authorizeCapability,type CapabilityContext} from './sources.ts';
export interface ReviewPort {
  request(context:CapabilityContext,input:ReviewRequest,key:string):Promise<ReviewTicket>;
  ticket(context:CapabilityContext,id:string):Promise<ReviewTicket|null>;
  viewCandidate(context:CapabilityContext,id:string):Promise<CandidateView|null>;
  decide(context:CapabilityContext,id:string,input:ReviewDecision,key:string):Promise<FinalizeReceipt>;
}
export function createReviewApplication(port:ReviewPort){return{
  request(context:CapabilityContext,input:unknown,key:string){authorizeCapability(context,'review:request');
    const parsed=ReviewRequestSchema.parse(input);if(parsed.purpose!==context.purpose)throw new KnowledgeError('PURPOSE_MISMATCH','Review purpose differs',403);
    return port.request(context,parsed,key);},
  ticket:(context:CapabilityContext,id:string)=>port.ticket(context,id),
  viewCandidate:(context:CapabilityContext,id:string)=>port.viewCandidate(context,id),
  decide(context:CapabilityContext,id:string,input:unknown,key:string){authorizeCapability(context,'review:decide');
    return port.decide(context,id,ReviewDecisionSchema.parse(input),key);},
};}
