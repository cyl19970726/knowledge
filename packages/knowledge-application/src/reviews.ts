import {ReviewRequestSchema,ReviewDecisionSchema,ReviewEscalationRequestSchema,type ReviewEscalationRequest,type ReviewRequest,type ReviewDecision,type ReviewTicket,type FinalizeReceipt,type CandidateView} from '@commerce/knowledge-contracts';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {authorizeCapability,type CapabilityContext} from './sources.ts';
export interface ReviewPort {
  request(context:CapabilityContext,input:ReviewRequest,key:string):Promise<ReviewTicket>;
  ticket(context:CapabilityContext,id:string):Promise<ReviewTicket|null>;
  viewCandidate(context:CapabilityContext,id:string):Promise<CandidateView|null>;
  decide(context:CapabilityContext,id:string,input:ReviewDecision,key:string):Promise<FinalizeReceipt>;
  /** Pending tickets the caller may decide (never its own proposals), oldest first. */
  queue?(context:CapabilityContext,input:{escalated:'exclude'|'only'|'include';limit:number}):Promise<ReviewTicket[]>;
  escalate?(context:CapabilityContext,id:string,input:ReviewEscalationRequest,key:string):Promise<ReviewTicket>;
}
export function createReviewApplication(port:ReviewPort){return{
  request(context:CapabilityContext,input:unknown,key:string){authorizeCapability(context,'review:request');
    const parsed=ReviewRequestSchema.parse(input);if(parsed.purpose!==context.purpose)throw new KnowledgeError('PURPOSE_MISMATCH','Review purpose differs',403);
    return port.request(context,parsed,key);},
  ticket:(context:CapabilityContext,id:string)=>port.ticket(context,id),
  viewCandidate:(context:CapabilityContext,id:string)=>port.viewCandidate(context,id),
  decide(context:CapabilityContext,id:string,input:unknown,key:string){authorizeCapability(context,'review:decide');
    return port.decide(context,id,ReviewDecisionSchema.parse(input),key);},
  queue(context:CapabilityContext,input:{escalated:'exclude'|'only'|'include';limit:number}){
    if(!context.authorization.actions.includes('review:decide')&&!context.authorization.actions.includes('review:read'))
      throw new KnowledgeError('CAPABILITY_FORBIDDEN','Review queue needs review:read or review:decide',403);
    if(!port.queue)throw new KnowledgeError('REVIEW_QUEUE_UNAVAILABLE','Review queue is unavailable',503);
    return port.queue(context,input);},
  escalate(context:CapabilityContext,id:string,input:unknown,key:string){authorizeCapability(context,'review:decide');
    const parsed=ReviewEscalationRequestSchema.parse(input);if(parsed.purpose!==context.purpose)throw new KnowledgeError('PURPOSE_MISMATCH','Escalation purpose differs',403);
    if(!port.escalate)throw new KnowledgeError('REVIEW_ESCALATION_UNAVAILABLE','Review escalation is unavailable',503);
    return port.escalate(context,id,parsed,key);},
};}
