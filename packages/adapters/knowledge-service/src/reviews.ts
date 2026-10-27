import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {CandidateViewSchema,type ReviewRequest,type ReviewDecision,type ReviewTicket,type FinalizeReceipt,type ResearchResult,
  type KnowledgeRef,type ChangeItem,type FeedbackRecord} from '@commerce/knowledge-contracts';
import type {CapabilityContext,ReadContext,ReviewPort,SourceRegistryPort} from '@commerce/knowledge-application';
import {createKnowledgeStore} from '@commerce/knowledge-core/store';
import {KnowledgeError,type KnowledgeReview} from '@commerce/knowledge-core/types';
import {digest} from '@commerce/knowledge-core/utils';
import {getWikiPageProfile,WikiPageContentSchema,wikiPageProfileFingerprint} from '@commerce/knowledge-core/wiki-page';
import type {KnowledgeWriterGrant} from '@commerce/knowledge-core/writer-authority';
import {capabilityTransaction,migrateCapabilityReceipts} from './transaction.ts';
import {assertLocalSourceProof} from './sources.ts';
import {createPgUseFeedbackPort} from './uses.ts';

interface TicketRow {id:string;project_id:string;space_id:string;requester_id:string;proposer_id:string;purpose:string;
  target_kind:'candidate'|'research_result';target_id:string;target_digest:string;state:string;payload:ReviewTicket;final_receipt:FinalizeReceipt|null}
export async function migrateKnowledgeReviews(pool:Pool){await migrateCapabilityReceipts(pool);await pool.query(`CREATE TABLE IF NOT EXISTS ccl_knowledge_review_tickets (
  id uuid PRIMARY KEY, project_id text NOT NULL, space_id text NOT NULL, requester_id text NOT NULL, proposer_id text NOT NULL,
  purpose text NOT NULL, target_kind text NOT NULL, target_id uuid NOT NULL, target_digest text NOT NULL,
  state text NOT NULL, payload jsonb NOT NULL, final_receipt jsonb, reviewer_id text, decision jsonb, decided_at timestamptz,
  UNIQUE(project_id,space_id,target_kind,target_id)
)`);await pool.query(`DROP TRIGGER IF EXISTS ccl_writer_guard ON ccl_knowledge_review_tickets;
  CREATE TRIGGER ccl_writer_guard BEFORE INSERT OR UPDATE OR DELETE ON ccl_knowledge_review_tickets
  FOR EACH ROW EXECUTE FUNCTION ccl_assert_knowledge_writer()`);}
function sameTarget(a:ReviewRequest['target'],b:ReviewRequest['target']){return digest(a)===digest(b);}
function originalResearchPurpose(input:unknown):string|null{
  if(!input||typeof input!=='object')return null;
  const request=(input as {request?:unknown}).request;
  if(!request||typeof request!=='object')return null;
  const purpose=(request as {purpose?:unknown}).purpose;
  return typeof purpose==='string'&&purpose.trim()?purpose:null;
}
/** Review targets are frozen by content digest. Candidate approval uses the same KnowledgeStore publish transaction. */
export function createPgReviewPort(pool:Pool,writerGrant:KnowledgeWriterGrant,sources?:SourceRegistryPort):ReviewPort{
  const store=createKnowledgeStore(pool,{writerGrant});
  async function target(context:ReadContext,input:ReviewRequest){
    if(input.target.kind==='candidate'){
      const change=await store.getChangeSet(context.scope.projectId,input.target.candidateId);
      const origin=await pool.query<{state:string;input:unknown;result:ResearchResult|null}>(`SELECT state,input,result FROM ccl_knowledge_operations
        WHERE id=$1 AND project_id=$2 AND space_id=$3 AND operation_kind='research'`,
        [input.target.candidateId,context.scope.projectId,context.scope.spaceId]);
      if(input.purpose!==context.purpose||!change||change.contentHash!==input.target.contentHash||change.purpose!==input.purpose||
        change.methodVersion!=='synthetic-local-v1'||origin.rows[0]?.result?.candidateId!==change.id||
        originalResearchPurpose(origin.rows[0]?.input)!==context.purpose||
        origin.rows[0]?.state!=='waiting_for_review'||origin.rows[0]?.result?.cognitiveOutcome!=='candidate'||
        change.changes.some(item=>item.revision.binding?.spaceId!==context.scope.spaceId))
        throw new KnowledgeError('REVIEW_TARGET_INVALID','Exact candidate or scope is unavailable',404);
      return {proposer:change.proposer,digest:change.contentHash,id:change.id};
    }
    const op=await pool.query<{principal_id:string;state:string;input:unknown;result:ResearchResult|null}>(`SELECT principal_id,state,input,result FROM ccl_knowledge_operations
      WHERE id=$1 AND project_id=$2 AND space_id=$3 AND operation_kind='research'`,
      [input.target.researchId,context.scope.projectId,context.scope.spaceId]);
    const found=op.rows[0];if(input.purpose!==context.purpose||found?.state!=='waiting_for_review'||
      originalResearchPurpose(found?.input)!==context.purpose||!found.result||found.result.resultDigest!==input.target.resultDigest||
      found.result.cognitiveOutcome==='candidate')
      throw new KnowledgeError('REVIEW_TARGET_INVALID','Exact research result is unavailable',404);
    return {proposer:found.principal_id,digest:found.result.resultDigest,id:input.target.researchId};
  }
  return {
    async viewCandidate(context,id){
      if(context.scope.projectId!==context.principal.projectId||!context.principal.spaceIds.includes(context.scope.spaceId)||
        !context.principal.purposes.includes(context.purpose))throw new KnowledgeError('CANDIDATE_READ_FORBIDDEN','Candidate context forbidden',403);
      const change=await store.getChangeSet(context.scope.projectId,id);
      const origin=await pool.query<{principal_id:string;state:string;result:ResearchResult|null}>(`
        SELECT principal_id,state,result FROM ccl_knowledge_operations
        WHERE id=$1 AND project_id=$2 AND space_id=$3 AND operation_kind='research'`,
        [id,context.scope.projectId,context.scope.spaceId]);
      const operation=origin.rows[0];
      if(!change||change.methodVersion!=='synthetic-local-v1'||change.purpose!==context.purpose||
        operation?.principal_id!==change.proposer||operation.result?.candidateId!==change.id||
        operation.result?.cognitiveOutcome!=='candidate'||
        change.changes.some(item=>item.revision.binding?.spaceId!==context.scope.spaceId))
        return null;
      if(context.principal.id!==change.proposer&&!context.authorization.actions.some(action=>
        action==='review:request'||action==='review:decide'))
        throw new KnowledgeError('CANDIDATE_READ_FORBIDDEN','Candidate review access is not authorized',403);
      const state=operation.state==='waiting_for_review'?'waiting_for_review':
        operation.state==='cancelled'?'cancelled':operation.state==='outcome_unknown'?'outcome_unknown':
        operation.state==='succeeded'?(operation.result.publication?'published':'rejected'):null;
      if(!state)return null;
      const changes=change.changes.map(item=>{
        if(item.revision.kind!=='wiki_page')throw new KnowledgeError('CANDIDATE_CONTENT_UNSUPPORTED','Candidate content cannot be projected for review',409);
        const page=WikiPageContentSchema.safeParse(item.revision.content);
        if(!page.success)throw new KnowledgeError('CANDIDATE_CONTENT_UNSUPPORTED','Candidate page content is unavailable',409);
        const profile=getWikiPageProfile(page.data.profile.id,page.data.profile.version);
        if(!profile)throw new KnowledgeError('CANDIDATE_PROFILE_UNAVAILABLE','Candidate profile is unavailable',409);
        return {ref:{...context.scope,domain:'knowledge' as const,objectId:item.revision.ref.objectId,
          versionId:item.revision.ref.versionId,contentDigest:digest(item.revision)},
          title:item.revision.title,body:item.revision.body,
          profile:{id:profile.id,version:profile.version,digest:wikiPageProfileFingerprint(profile)},
          conditions:page.data.conditions,counterexamples:page.data.counterexamples,unknowns:page.data.unknowns,
          nextQuestions:page.data.nextQuestions,
          sourceGroups:item.revision.sourceGroups.map(group=>({id:group,status:'known' as const,authority:null}))};
      });
      return CandidateViewSchema.parse({candidateId:change.id,contentHash:change.contentHash,purpose:change.purpose,
        proposer:change.proposer,rationale:change.rationale,createdAt:change.createdAt,state,
        exactReadset:operation.result.exactReadset,changes});
    },
    async request(context,input,key){return capabilityTransaction(pool,context,'review:request',key,input,writerGrant,async(client,id)=>{
      const targetInfo=await target(context,input),ticket:ReviewTicket={id,target:input.target,status:'pending',purpose:input.purpose};
      await client.query(`INSERT INTO ccl_knowledge_review_tickets(id,project_id,space_id,requester_id,proposer_id,purpose,target_kind,target_id,target_digest,state,payload)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10)`,
        [id,context.scope.projectId,context.scope.spaceId,context.principal.id,targetInfo.proposer,input.purpose,input.target.kind,targetInfo.id,targetInfo.digest,ticket]);
      return ticket;
    });},
    async ticket(context,id){if(context.scope.projectId!==context.principal.projectId||!context.principal.spaceIds.includes(context.scope.spaceId)||
      !context.principal.purposes.includes(context.purpose))throw new KnowledgeError('REVIEW_READ_FORBIDDEN','Review context forbidden',403);
      const row=await pool.query<{payload:ReviewTicket;requester_id:string;proposer_id:string;purpose:string}>(`
        SELECT t.payload,t.requester_id,t.proposer_id,t.purpose FROM ccl_knowledge_review_tickets t
        JOIN ccl_knowledge_operations o ON o.id=t.target_id AND o.project_id=t.project_id AND o.space_id=t.space_id
          AND o.input#>>'{request,purpose}'=t.purpose
        WHERE t.id=$1 AND t.project_id=$2 AND t.space_id=$3`,[id,context.scope.projectId,context.scope.spaceId]);
      const ticket=row.rows[0];if(!ticket||ticket.purpose!==context.purpose)return null;
      if(ticket.requester_id!==context.principal.id&&ticket.proposer_id!==context.principal.id&&
        !context.authorization.actions.includes('review:read')&&!context.authorization.actions.includes('review:decide'))return null;
      return ticket.payload;},
    async decide(context,id,input,key){return capabilityTransaction(pool,context,'review:decide',key,{id,input},writerGrant,async(client,decisionId)=>{
      const row=await client.query<TicketRow>(`SELECT * FROM ccl_knowledge_review_tickets
        WHERE id=$1 AND project_id=$2 AND space_id=$3 FOR UPDATE`,[id,context.scope.projectId,context.scope.spaceId]);
      const ticket=row.rows[0];if(!ticket)throw new KnowledgeError('REVIEW_TICKET_UNAVAILABLE','Review ticket unavailable',404);
      if(ticket.state!=='pending')throw new KnowledgeError('REVIEW_ALREADY_FINALIZED','Review was already finalized',409);
      if(ticket.proposer_id===context.principal.id)throw new KnowledgeError('SELF_REVIEW_FORBIDDEN','Independent reviewer must differ from proposer',403);
      if(ticket.purpose!==context.purpose||ticket.target_digest!==input.expectedDigest)
        throw new KnowledgeError('REVIEW_DIGEST_MISMATCH','Review must bind exact target digest and purpose',409);
      if(!input.reason.trim())throw new KnowledgeError('REVIEW_REASON_REQUIRED','Review needs a reason',422);
      const operationRow=await client.query<{principal_id:string;state:string;input:{request?:{feedbackIds?:string[];purpose?:string}};result:ResearchResult|null}>(`
        SELECT principal_id,state,input,result FROM ccl_knowledge_operations WHERE id=$1 AND project_id=$2 AND space_id=$3 FOR UPDATE`,
        [ticket.target_id,context.scope.projectId,context.scope.spaceId]);
      const operation=operationRow.rows[0];
      if(operation?.state!=='waiting_for_review'||!operation.result||operation.principal_id!==ticket.proposer_id||operation.result.reviewReceiptId)
        throw new KnowledgeError('REVIEW_TARGET_CHANGED','Research result changed before review',409);
      if(originalResearchPurpose(operation.input)!==context.purpose||ticket.purpose!==context.purpose||
        ticket.payload.purpose!==context.purpose)
        throw new KnowledgeError('REVIEW_TARGET_CHANGED','Review purpose no longer matches the original research request',409);
      const sourceRefs=operation.result.exactReadset.filter(ref=>ref.domain==='source');
      if(input.decision!=='rejected'&&sourceRefs.length){if(!sources)throw new KnowledgeError('SOURCE_PROOF_REQUIRED','Source owner capability is unavailable',409);
        const sourceContext:ReadContext={scope:context.scope,purpose:context.purpose,principal:{id:ticket.proposer_id,
          clientInstallationId:'review-proof',projectId:context.scope.projectId,spaceIds:[context.scope.spaceId],purposes:[context.purpose]}};
        for(const ref of sourceRefs){const proof=await sources.proof(sourceContext,ref);await assertLocalSourceProof(client,sourceContext,proof);}
      }
      let publication:FinalizeReceipt['publication']=null,cognitiveOutcome:FinalizeReceipt['result']=null;
      if(ticket.target_kind==='candidate'){
        const change=await store.getChangeSet(context.scope.projectId,ticket.target_id);
        if(!change||change.contentHash!==ticket.target_digest||change.proposer!==ticket.proposer_id||change.purpose!==context.purpose)
          throw new KnowledgeError('REVIEW_TARGET_CHANGED','Candidate changed before review',409);
        if(change.changes.some(item=>item.revision.dependencies.some(dep=>dep.domain==='analysis'||dep.domain==='evidence')))
          throw new KnowledgeError('SOURCE_PROOF_REQUIRED','Analysis/evidence owner proof is unavailable for this publication',409);
        const sourceDeps=change.changes.flatMap(item=>item.revision.dependencies.filter(dep=>dep.domain==='source'));
        if(sourceDeps.length){
          for(const dep of sourceDeps){const ref=sourceRefs.find(item=>item.objectId===dep.ref.objectId&&item.versionId===dep.ref.versionId);
            if(!ref?.contentDigest)throw new KnowledgeError('SOURCE_PROOF_REQUIRED','Candidate source is absent from frozen research readset',409);
          }
        }
        const review:KnowledgeReview={id:decisionId,projectId:context.scope.projectId,changeSetId:change.id,contentHash:change.contentHash,
          reviewer:context.principal.id,policyVersion:'knowledge-independent-review-v1',purpose:context.purpose,
          decision:input.decision,rationale:input.reason,createdAt:new Date().toISOString()};
        await store.recordReview(review,client);
        if(input.decision!=='rejected'){
          const published=await store.publish(context.scope.projectId,change.id,change.contentHash,client);
          publication={changeSetId:published.changeSetId,refs:change.changes.map(item=>({...context.scope,domain:'knowledge',
            objectId:item.revision.ref.objectId,versionId:item.revision.ref.versionId,contentDigest:digest(item.revision)} as KnowledgeRef)),
            epoch:published.epoch,publishedAt:published.publishedAt};
        }
      }else{
        const result=operation.result;if(result.resultDigest!==ticket.target_digest)
          throw new KnowledgeError('REVIEW_TARGET_CHANGED','Research result changed before review',409);
        cognitiveOutcome=result.cognitiveOutcome;
      }
      const final:FinalizeReceipt={reviewReceiptId:decisionId,target:ticket.payload.target,publication,result:cognitiveOutcome};
      await client.query(`UPDATE ccl_knowledge_review_tickets SET state='finalized',payload=$2,final_receipt=$3,reviewer_id=$4,decision=$5,decided_at=now() WHERE id=$1`,
        [id,{...ticket.payload,status:'finalized'},final,context.principal.id,input]);
      const researchId=ticket.target_kind==='candidate'?ticket.target_id:ticket.target_id;
      await client.query(`UPDATE ccl_knowledge_operations SET result=jsonb_set(jsonb_set(jsonb_set(result,'{reviewState}',$2::jsonb),'{reviewReceiptId}',$3::jsonb),'{publication}',$4::jsonb),
        state='succeeded',updated_at=now() WHERE id=$1 AND result IS NOT NULL`,
        [researchId,JSON.stringify(input.decision),JSON.stringify(decisionId),JSON.stringify(publication)]);
      for(const feedbackId of operation.input.request?.feedbackIds??[]){
        const feedback=await client.query<{payload:FeedbackRecord}>(`SELECT payload FROM ccl_knowledge_external_feedback
          WHERE id=$1 AND project_id=$2 AND space_id=$3 AND principal_id=$4 AND purpose=$5`,
          [feedbackId,context.scope.projectId,context.scope.spaceId,ticket.proposer_id,context.purpose]);
        const sourceRef=feedback.rows[0]?.payload.sourceRef;
        if(!sourceRef||!sourceRefs.some(ref=>ref.objectId===sourceRef.objectId&&ref.versionId===sourceRef.versionId&&
          ref.contentDigest===sourceRef.contentDigest))
          throw new KnowledgeError('FEEDBACK_SOURCE_MISMATCH','Resolved feedback must retain its exact source in the research readset',409);
        const feedbackContext:ReadContext={scope:context.scope,purpose:context.purpose,principal:{id:ticket.proposer_id,
          clientInstallationId:'review-feedback',projectId:context.scope.projectId,spaceIds:[context.scope.spaceId],purposes:[context.purpose]}};
        try{await createPgUseFeedbackPort(pool).getFeedback(feedbackContext,feedbackId);}
        catch(error){if(input.decision==='rejected'&&error instanceof KnowledgeError&&error.code==='FEEDBACK_ACCESS_REVOKED')continue;throw error;}
        const event:ChangeItem={id:randomUUID(),kind:'feedback_research_reviewed',before:sourceRef,after:publication?.refs[0]??null,
          reason:`Independent review recorded ${operation.result.cognitiveOutcome}; feedback remains caller-reported`,
          researchId:researchId,reviewReceiptId:decisionId,cognitiveOutcome:operation.result.cognitiveOutcome,
          affected:publication?.refs??[sourceRef]};
        await client.query(`INSERT INTO ccl_knowledge_external_changes(project_id,space_id,principal_id,purpose,use_id,feedback_id,payload)
          VALUES($1,$2,$3,$4,$5,$6,$7)`,[context.scope.projectId,context.scope.spaceId,ticket.proposer_id,context.purpose,feedback.rows[0].payload.useId,feedbackId,event]);
      }
      return final;
    });},
  };
}
