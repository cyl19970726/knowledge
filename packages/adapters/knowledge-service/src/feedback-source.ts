import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {FeedbackRecordSchema,SourceUpsertSchema,type FeedbackRecord,type SourceRecord,type ChangeItem} from '@commerce/knowledge-contracts';
import type {CapabilityContext,FeedbackSourcePort} from '@commerce/knowledge-application';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {digest} from '@commerce/knowledge-core/utils';
import type {KnowledgeWriterGrant} from '@commerce/knowledge-core/writer-authority';
import {capabilityTransaction} from './transaction.ts';
import {assertCurrentSourceReplay,upsertSourceInTransaction} from './sources.ts';
import {createPgUseFeedbackPort} from './uses.ts';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
/** Source admission and feedback link commit together under the project writer/rights barrier. */
export function createPgFeedbackSourcePort(pool:Pool,options:{writerGrant:KnowledgeWriterGrant;rightsPolicyRef:string}):FeedbackSourcePort{
  return {async register(context:CapabilityContext,feedbackId:string,expectedDigest:string,key:string):Promise<SourceRecord>{
    if(!context.authorization.rightsPolicyIds.includes(options.rightsPolicyRef))
      throw new KnowledgeError('SOURCE_RIGHTS_FORBIDDEN','Feedback source rights policy is not authorized',403);
    return capabilityTransaction(pool,context,'feedback:source',key,{feedbackId,expectedDigest},options.writerGrant,async(client,id)=>{
      if(!await createPgUseFeedbackPort(pool).getFeedback(context,feedbackId))
        throw new KnowledgeError('FEEDBACK_UNAVAILABLE','Feedback is unavailable for this purpose',404);
      const row=await client.query<{purpose:string;payload:FeedbackRecord}>(`SELECT purpose,payload FROM ccl_knowledge_external_feedback
        WHERE project_id=$1 AND space_id=$2 AND principal_id=$3 AND id=$4 AND purpose=$5 FOR UPDATE`,
        [context.scope.projectId,context.scope.spaceId,context.principal.id,feedbackId,context.purpose]);
      if(!row.rows[0])throw new KnowledgeError('FEEDBACK_UNAVAILABLE','Feedback is unavailable to this caller',404);
      if(row.rows[0].payload.purpose&&row.rows[0].payload.purpose!==row.rows[0].purpose)
        throw new KnowledgeError('FEEDBACK_PURPOSE_FORBIDDEN','Stored feedback purpose conflicts with its authenticated binding',403);
      const feedback=FeedbackRecordSchema.parse({...row.rows[0].payload,purpose:row.rows[0].purpose});
      if(feedback.purpose!==context.purpose)throw new KnowledgeError('FEEDBACK_PURPOSE_FORBIDDEN','Feedback source purpose differs',403);
      if(feedback.digest!==expectedDigest)throw new KnowledgeError('FEEDBACK_DIGEST_MISMATCH','Feedback changed from the requested exact digest',409);
      if(feedback.sourceRef)throw new KnowledgeError('FEEDBACK_SOURCE_ALREADY_LINKED','Feedback source has already been linked',409);
      if(feedback.status!=='observed'||!feedback.observedAt||!feedback.observation)
        throw new KnowledgeError('FEEDBACK_NOT_OBSERVED','Only an explicit caller-reported observation can become a source',422);
      if(!context.authorization.adapterIds.includes(feedback.context.adapterId))
        throw new KnowledgeError('SOURCE_ADAPTER_FORBIDDEN','Feedback adapter is not authorized',403);
      const sourceText=JSON.stringify({schemaVersion:'feedback-source/1.0',assertionKind:'caller_reported',purpose:feedback.purpose,feedbackId:feedback.id,
        feedbackDigest:feedback.digest,context:feedback.context,status:feedback.status,observedAt:feedback.observedAt,
        observation:feedback.observation,rawQuotation:feedback.rawQuotation,interpretation:feedback.interpretation,
        recommendation:feedback.recommendation,artifactDigest:feedback.artifactDigest,measurementScope:feedback.measurementScope,
        gaps:feedback.gaps,cost:feedback.cost});
      const source=SourceUpsertSchema.parse({externalIdentity:{adapterId:feedback.context.adapterId,externalObjectId:`feedback:${feedback.id}`,
          externalVersion:feedback.version},expectedSourceHead:null,sourceSchemaVersion:'feedback-source/1.0',contentDigest:sha(sourceText),
        custody:{mode:'managed_copy',text:sourceText},sourceKind:'caller_feedback',author:context.principal.id,publisher:null,
        acquirer:feedback.context.adapterId,publishedAt:feedback.observedAt,obtainedAt:new Date().toISOString(),assertionKind:'caller_reported',
        sourceGroups:[{id:`caller-context:${digest(feedback.context)}`,status:'known',authority:'caller_reported'}],anchors:[],actualCoverage:[],
        limitations:['Caller-reported observation; neither independent verification nor knowledge adoption'],rightsPolicyRef:options.rightsPolicyRef});
      const registered=await upsertSourceInTransaction(client,context,source,id);
      const linked=FeedbackRecordSchema.parse({...feedback,sourceRef:registered.ref,maintenanceState:'linked'});
      const {purpose:_derivedPurpose,...legacyLinked}=linked;
      await client.query(`UPDATE ccl_knowledge_external_feedback SET payload=$2 WHERE id=$1`,
        [feedback.id,'purpose' in row.rows[0].payload?linked:legacyLinked]);
      const event:ChangeItem={id:randomUUID(),kind:'feedback_source_registered',before:null,after:registered.ref,
        reason:'Caller-reported observation registered as a source; knowledge revisions are unchanged',researchId:null,
        reviewReceiptId:null,cognitiveOutcome:null,affected:[registered.ref]};
      await client.query(`INSERT INTO ccl_knowledge_external_changes(project_id,space_id,principal_id,purpose,use_id,feedback_id,payload)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[context.scope.projectId,context.scope.spaceId,context.principal.id,context.purpose,feedback.useId,feedback.id,event]);
      return registered;
    },async(result,client)=>{await assertCurrentSourceReplay(client,context,result,options.rightsPolicyRef);
      if(!await createPgUseFeedbackPort(pool).getFeedback(context,feedbackId))
        throw new KnowledgeError('FEEDBACK_ACCESS_REVOKED','Current feedback access was revoked',403);});
  }};
}
