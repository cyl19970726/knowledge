import {finalizeCoordinationReview} from './coordination-finalization.ts';
import type {Pool,PoolClient} from 'pg';
import {IdSchema} from '@commerce/contract-primitives';
import {CandidateReceiptSchema,CandidateViewSchema,ReviewTicketSchema,WikiCompileRequestSchema,WikiCompileResultSchema,
  type CandidateView,type FinalizeReceipt,type KnowledgeRef,type ReviewDecision,type ReviewRequest,type ReviewTicket,
  type WikiCompileRequest,type WikiCompileResult} from '@commerce/knowledge-contracts';
import type {CapabilityContext,ReadContext,ReviewPort,SourceRegistryPort} from '@commerce/knowledge-application';
import {createKnowledgeStore} from '@commerce/knowledge-core/store';
import {KnowledgeError,type KnowledgeChangeSet,type KnowledgeReview} from '@commerce/knowledge-core/types';
import {canonical,digest,uniqueDeps} from '@commerce/knowledge-core/utils';
import {getWikiPageProfile,matchesWikiPageFrozenBinding,wikiPageProfileFingerprint} from '@commerce/knowledge-core/wiki-page';
import type {KnowledgeWriterGrant} from '@commerce/knowledge-core/writer-authority';
import {capabilityTransaction} from './transaction.ts';
import {assertLocalSourceProof} from './sources.ts';

type Db=Pick<PoolClient,'query'>;
type CompilationRow={id:string;project_id:string;space_id:string;principal_id:string;installation_id:string;
  purpose:string;request:WikiCompileRequest;result:WikiCompileResult;state:string};
type TicketRow={id:string;project_id:string;space_id:string;requester_id:string;proposer_id:string;purpose:string;
  origin_kind:string;target_kind:string;target_id:string;target_digest:string;state:string;payload:ReviewTicket;
  final_receipt:FinalizeReceipt|null};
const oldPageLimit=1_000_000;
const refKey=(ref:Pick<KnowledgeRef,'objectId'|'versionId'>)=>`${ref.objectId}/${ref.versionId}`;
function fail(code:string,message:string,status=409):never{throw new KnowledgeError(code,message,status);}
class ReviewTicketLookupUnknownError extends KnowledgeError{
  readonly commitStatus='unknown';
  readonly requestKey:string;
  constructor(key:string){super('COMMIT_OUTCOME_UNKNOWN','Review request committed or may have committed; look up the original key',503);
    this.requestKey=key;}
}
function contextIsValid(context:ReadContext):boolean{return !!context.purpose?.trim()&&
  context.scope.projectId===context.principal.projectId&&context.principal.spaceIds.includes(context.scope.spaceId)&&
  context.principal.purposes.includes(context.purpose);}
function requireContext(context:ReadContext):void{if(!contextIsValid(context))fail('REVIEW_READ_FORBIDDEN','Review scope or purpose is unavailable',403);}
function mayRead(context:CapabilityContext,proposer:string,requester?:string):boolean{return context.principal.id===proposer||
  context.principal.id===requester||['review:read','review:decide','review:request'].some(action=>context.authorization.actions.includes(action));}
function requireAction(context:CapabilityContext,action:string):void{requireContext(context);
  if(!context.authorization.actions.includes(action))fail('CAPABILITY_FORBIDDEN',`Review action ${action} is unavailable`,403);}
const version=(ref:Pick<KnowledgeRef,'objectId'|'versionId'>)=>({objectId:ref.objectId,versionId:ref.versionId});
function proposerContext(context:ReadContext,row:CompilationRow):ReadContext{return {scope:context.scope,purpose:context.purpose,
  principal:{id:row.principal_id,clientInstallationId:row.installation_id,projectId:row.project_id,
    spaceIds:[row.space_id],purposes:[row.purpose]}};}

/** A compilation is an origin only inside the authenticated project and space. */
export function createPgCompilationReviewPort(pool:Pool,grant:KnowledgeWriterGrant,sources?:SourceRegistryPort):ReviewPort & {
  hasOrigin(context:ReadContext,id:string):Promise<boolean>
}{
  const store=createKnowledgeStore(pool,{writerGrant:grant});
  async function compilation(db:Db,context:ReadContext,id:string,lock=false):Promise<CompilationRow|null>{
    const row=(await db.query<CompilationRow>(`SELECT id,project_id,space_id,principal_id,installation_id,purpose,request,result,state
      FROM ccl_knowledge_compilations WHERE id=$1 AND project_id=$2 AND space_id=$3${lock?' FOR UPDATE':''}`,
      [id,context.scope.projectId,context.scope.spaceId])).rows[0];
    if(!row||row.purpose!==context.purpose)return null;
    const request=WikiCompileRequestSchema.safeParse(row.request),result=WikiCompileResultSchema.safeParse(row.result);
    if(!request.success||!result.success||request.data.purpose!==row.purpose||result.data.purpose!==row.purpose||
      result.data.id!==row.id||result.data.question!==request.data.question||row.state!==result.data.state||
      !row.principal_id.trim()||!row.installation_id.trim())
      fail('COMPILATION_REVIEW_ORIGIN_INVALID','Compilation identity or result is inconsistent');
    return {...row,request:request.data,result:result.data};
  }
  async function changeSet(db:Db,context:ReadContext,id:string):Promise<KnowledgeChangeSet>{
    const row=(await db.query<{request_key:string;request_hash:string;content_hash:string;payload:KnowledgeChangeSet|null}>(`
      SELECT request_key,request_hash,content_hash,
        CASE WHEN octet_length(payload::text)<=3000000 THEN payload ELSE NULL END AS payload
      FROM ccl_knowledge_changesets WHERE project_id=$1 AND id=$2`,[context.scope.projectId,id])).rows[0];
    if(!row?.payload)fail('COMPILATION_REVIEW_CANDIDATE_UNAVAILABLE','Exact bounded candidate is unavailable');
    const change=row.payload;
    if(row.request_key!==`wiki-compile:${id}`||change.requestKey!==row.request_key||
      row.request_hash!==change.requestHash||row.content_hash!==change.contentHash||
      change.id!==id||change.projectId!==context.scope.projectId||change.changes.length<1||change.changes.length>5)
      fail('COMPILATION_REVIEW_CANDIDATE_MISMATCH','Candidate identity or stored hash differs');
    const hashInput={projectId:change.projectId,requestKey:change.requestKey,purpose:change.purpose,
      proposer:change.proposer,rationale:change.rationale,methodVersion:change.methodVersion,cost:change.cost,
      baseHeads:change.baseHeads,changes:change.changes};
    if(digest(hashInput)!==change.contentHash)fail('COMPILATION_REVIEW_CANDIDATE_MISMATCH','Candidate content hash differs');
    return change;
  }
  function checkedOrigin(context:ReadContext,row:CompilationRow,change:KnowledgeChangeSet):void{
    const result=row.result,receipt=result.candidate;
    if(!['waiting_for_review','published','rejected'].includes(row.state)||result.stageStatus!=='staged'||
      !result.stageIntent||!receipt||!result.drafts.length||result.drafts.length!==change.changes.length||
      row.principal_id!==change.proposer||row.purpose!==change.purpose||
      result.stageIntent.requestHash!==change.requestHash||
      change.requestKey!==`wiki-compile:${row.id}`||receipt.candidateId!==row.id||receipt.changeSetId!==row.id||
      receipt.contentHash!==change.contentHash||receipt.published||
      result.cost.modelCalls.state!=='known'||result.cost.money.state!=='known'||
      change.cost.state!=='known'||change.cost.amount!==result.cost.money.amount||
      change.cost.currency!==result.cost.money.currency||
      canonical(receipt.draftRefs)!==canonical(change.changes.map(entry=>({...context.scope,domain:'knowledge',
        ...entry.revision.ref,contentDigest:digest(entry.revision)}))))
      fail('COMPILATION_REVIEW_ORIGIN_INVALID','Compilation and staged candidate are not bound to one acknowledged result');
    CandidateReceiptSchema.parse(receipt);
    const ids=new Set(result.evidence.map(item=>item.id));
    if(ids.size!==result.evidence.length||result.readsetFingerprint!==digest(result.evidence)||
      result.evidence.some(item=>item.ref.projectId!==context.scope.projectId||
        item.ref.spaceId!==context.scope.spaceId||!item.ref.contentDigest||
        item.kind==='wiki_page'&&(!item.storageDigest||item.ref.domain!=='knowledge')||
        item.kind==='source_content'&&(item.ref.domain!=='source'||!item.actualReadCoverage.length||
          item.actualReadCoverage.some(read=>read.coverage!=='full'||refKey(read.sourceRef)!==refKey(item.ref)||
            read.sourceRef.contentDigest!==item.ref.contentDigest))))
      fail('COMPILATION_REVIEW_READSET_INVALID','Compilation readset is not exact or locally publishable');
    if(change.baseHeads.length!==change.changes.length||new Set(change.baseHeads.map(base=>base.objectId)).size!==change.baseHeads.length||
      canonical(change.inputManifest)!==canonical(uniqueDeps(change.changes.flatMap(item=>item.revision.dependencies))))
      fail('COMPILATION_REVIEW_CANDIDATE_MISMATCH','Candidate base heads are inconsistent');
    for(const [index,entry] of change.changes.entries()){
      const draft=result.drafts[index],revision=entry.revision,base=change.baseHeads[index];
      const target=draft.targetEvidenceId?result.evidence.find(item=>item.id===draft.targetEvidenceId):null;
      if(revision.kind!=='wiki_page'||!matchesWikiPageFrozenBinding(revision)||
        revision.projectId!==context.scope.projectId||revision.binding.spaceId!==context.scope.spaceId||
        revision.binding.specificationId!=='wiki-compile-stage'||revision.binding.specificationVersion!=='1'||
        revision.binding.methodVersion!==change.methodVersion||/synthetic/i.test(change.methodVersion)||
        base.objectId!==revision.ref.objectId||base.versionId!==(target?.ref.versionId??null)||
        (target&& (target.kind!=='wiki_page'||target.ref.objectId!==revision.ref.objectId))||
        entry.effect!==(target?'correct':'create')||revision.title!==draft.title||revision.body!==draft.summary||
        revision.content.summary!==draft.summary||revision.content.identity.key!==draft.identityKey||
        revision.content.profile.id!==draft.profile.id||revision.content.profile.version!==draft.profile.version||
        canonical(revision.content.conditions)!==canonical(draft.conditions)||
        canonical(revision.content.counterexamples)!==canonical(draft.counterexamples)||
        canonical(revision.content.unknowns)!==canonical(draft.unknowns)||
        canonical(revision.content.nextQuestions)!==canonical(draft.nextQuestions)||
        draft.supportEvidenceIds.some(id=>!ids.has(id))||
        new Set(draft.supportEvidenceIds).size!==draft.supportEvidenceIds.length||
        revision.dependencies.some(dep=>dep.domain==='analysis'||dep.domain==='evidence'||dep.domain==='context'))
        fail('COMPILATION_REVIEW_CANDIDATE_MISMATCH','Candidate differs from the frozen compiler proposal');
      const profile=getWikiPageProfile(draft.profile.id,draft.profile.version);
      if(!profile||wikiPageProfileFingerprint(profile)!==draft.profile.digest)
        fail('COMPILATION_REVIEW_PROFILE_INVALID','Candidate profile is unavailable');
      for(const id of draft.supportEvidenceIds){const evidence=result.evidence.find(item=>item.id===id)!;
        if(evidence.kind==='wiki_page'&&evidence.ref.objectId===revision.ref.objectId)continue;
        if(!revision.dependencies.some(dep=>dep.critical&&dep.domain===(evidence.kind==='wiki_page'?'knowledge':'source')&&
          refKey(dep.ref)===refKey(evidence.ref)))
          fail('COMPILATION_REVIEW_READSET_INVALID','A declared support is absent from candidate dependencies');
      }
    }
    if(row.state==='waiting_for_review'&&(result.reviewReceiptId||result.publication||result.reviewDecision)||
      row.state==='published'&&(!result.publication||!result.reviewReceiptId||
        !['approved_for_purpose','exploration_only'].includes(result.reviewDecision??'')||
        result.publication.changeSetId!==row.id||
        canonical(result.publication.refs)!==canonical(receipt.draftRefs))||
      row.state==='rejected'&&(result.publication||!result.reviewReceiptId||result.reviewDecision!=='rejected'))
      fail('COMPILATION_REVIEW_ORIGIN_INVALID','Compilation review state is inconsistent');
  }
  async function origin(db:Db,context:ReadContext,id:string,lock=false):Promise<{row:CompilationRow;change:KnowledgeChangeSet}|null>{
    const row=await compilation(db,context,id,lock);if(!row)return null;
    const change=await changeSet(db,context,id);checkedOrigin(context,row,change);return {row,change};
  }
  async function metadata(context:ReadContext,row:CompilationRow,change:KnowledgeChangeSet,approval:boolean){
    const sourceRefs=new Map<string,KnowledgeRef>(),issues:string[]=[];
    const addSource=(ref:KnowledgeRef)=>{if(ref.domain!=='source')fail('COMPILATION_SOURCE_ASSURANCE_REQUIRED','External source lineage cannot be published');
      const key=refKey(ref),old=sourceRefs.get(key);
      if(old?.contentDigest&&ref.contentDigest&&old.contentDigest!==ref.contentDigest)
        fail('COMPILATION_SOURCE_ASSURANCE_REQUIRED','Conflicting source digests in frozen lineage');
      sourceRefs.set(key,old?.contentDigest?old:ref);};
    const knowledgeRefs=new Map<string,{ref:KnowledgeRef;storageDigest?:string}>();
    for(const evidence of row.result.evidence){
      if(evidence.kind==='source_content')addSource(evidence.ref);
      else knowledgeRefs.set(refKey(evidence.ref),{ref:evidence.ref,storageDigest:evidence.storageDigest});
    }
    for(const entry of change.changes)for(const dep of entry.revision.dependencies){
      if(dep.domain==='source')addSource({...context.scope,domain:'source',...version(dep.ref),contentDigest:null});
      else if(dep.domain==='knowledge'&&dep.critical&&!change.changes.some(item=>refKey(item.revision.ref)===refKey(dep.ref)))
        knowledgeRefs.set(refKey(dep.ref),knowledgeRefs.get(refKey(dep.ref))??{ref:{...context.scope,domain:'knowledge',...version(dep.ref),contentDigest:null}});
      else if(dep.domain!=='knowledge')fail('COMPILATION_SOURCE_ASSURANCE_REQUIRED','External source lineage cannot be published');
    }
    for(const base of change.baseHeads.filter(item=>item.versionId))knowledgeRefs.set(refKey({objectId:base.objectId,versionId:base.versionId!}),
      knowledgeRefs.get(refKey({objectId:base.objectId,versionId:base.versionId!}))??
      {ref:{...context.scope,domain:'knowledge',objectId:base.objectId,versionId:base.versionId!,contentDigest:null}});
    for(const item of knowledgeRefs.values()){
      const frozen=await store.inspectFrozen?.(context.scope.projectId,version(item.ref));
      if(!frozen?.published||frozen.kind!=='wiki_page'||frozen.spaceId!==context.scope.spaceId||
        item.storageDigest&&frozen.storageDigest!==item.storageDigest)
        fail('COMPILATION_REVIEW_READSET_INVALID','Frozen Wiki origin is unavailable or its storage changed');
      if(!frozen.criticalSourcesComplete)fail('COMPILATION_SOURCE_ASSURANCE_REQUIRED','Critical source lineage is incomplete');
      for(const dep of frozen.criticalSources){if(dep.domain!=='source')
        fail('COMPILATION_SOURCE_ASSURANCE_REQUIRED','External source lineage cannot be published');
        addSource({...context.scope,domain:'source',...dep.ref,contentDigest:null});}
      if(!frozen.current)issues.push('一份所读 Wiki 已有新版');
      if(!frozen.validity.valid)issues.push('一份所读 Wiki 已失效');
      if(frozen.review?.purpose!==context.purpose||!['approved_for_purpose','exploration_only'].includes(frozen.review.decision)||
        frozen.review.decision==='exploration_only'&&context.purpose!=='exploration_reading')
        issues.push('一份所读 Wiki 未获此用途审阅');
    }
    if(approval&&issues.length)fail('COMPILATION_REVIEW_INPUT_STALE','Frozen input is no longer current and admitted');
    return {sourceRefs:[...sourceRefs.values()],issues:[...new Set(issues)]};
  }
  async function sourceProofs(client:Db,context:ReadContext,row:CompilationRow,refs:readonly KnowledgeRef[]):Promise<void>{
    if(refs.length&&!sources)fail('COMPILATION_SOURCE_ASSURANCE_REQUIRED','Local source proof service is unavailable');
    for(const ref of refs)for(const subject of [proposerContext(context,row),context]){
      try{const proof=await sources!.proof(subject,ref);
        if(proof.assurance!=='local_transaction'||proof.sourceRef.domain!=='source'||
          refKey(proof.sourceRef)!==refKey(ref)||ref.contentDigest&&proof.sourceRef.contentDigest!==ref.contentDigest)
          fail('COMPILATION_SOURCE_ASSURANCE_REQUIRED','Exact local source proof is unavailable');
        await assertLocalSourceProof(client as PoolClient,subject,proof);
      }catch{fail('COMPILATION_SOURCE_ASSURANCE_REQUIRED','Both proposer and reviewer need current local source rights');}
    }
  }
  async function checkedSources(context:ReadContext,row:CompilationRow,refs:readonly KnowledgeRef[]):Promise<void>{
    const client=await pool.connect();try{await client.query('BEGIN');await sourceProofs(client,context,row,refs);await client.query('COMMIT');}
    catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  async function before(context:ReadContext,change:KnowledgeChangeSet,index:number):Promise<CandidateView['changes'][number]['before']>{
    const base=change.baseHeads[index];if(!base.versionId)return null;
    const read=await store.getBounded?.(context.scope.projectId,{objectId:base.objectId,versionId:base.versionId},oldPageLimit);
    if(!read?.view.published||read.view.revision.kind!=='wiki_page'||
      read.view.revision.binding?.spaceId!==context.scope.spaceId)
      fail('COMPILATION_REVIEW_BASE_UNAVAILABLE','Exact prior Wiki version is unavailable');
    const old=read.view.revision,profile=getWikiPageProfile(old.content.profile.id,old.content.profile.version);
    if(!profile||!matchesWikiPageFrozenBinding(old))fail('COMPILATION_REVIEW_BASE_UNAVAILABLE','Prior Wiki profile is unsupported');
    if(old.body.length>100_000)fail('COMPILATION_REVIEW_BASE_TOO_LARGE','Exact prior Wiki body exceeds the review projection limit',422);
    return {ref:{...context.scope,domain:'knowledge',...old.ref,contentDigest:digest(old)},title:old.title,body:old.body,
      conditions:old.content.conditions,counterexamples:old.content.counterexamples,unknowns:old.content.unknowns};
  }
  async function ticketRow(db:Db,context:ReadContext,id:string,lock=false):Promise<TicketRow|null>{
    const row=(await db.query<TicketRow>(`SELECT * FROM ccl_knowledge_review_tickets WHERE id=$1 AND project_id=$2 AND space_id=$3
      AND origin_kind='wiki_compile' AND target_kind='candidate'${lock?' FOR UPDATE':''}`,
      [id,context.scope.projectId,context.scope.spaceId])).rows[0];
    return row?.purpose===context.purpose?row:null;
  }
  async function targetTicket(db:Db,context:ReadContext,id:string):Promise<TicketRow|null>{
    const row=(await db.query<TicketRow>(`SELECT * FROM ccl_knowledge_review_tickets
      WHERE project_id=$1 AND space_id=$2 AND origin_kind='wiki_compile' AND target_kind='candidate' AND target_id=$3`,
      [context.scope.projectId,context.scope.spaceId,id])).rows[0];
    return row??null;
  }
  function assertTicketOrigin(context:ReadContext,ticket:TicketRow,originRow:CompilationRow,change:KnowledgeChangeSet):void{
    if(!['pending','finalized'].includes(ticket.state)||ticket.purpose!==context.purpose||
      ticket.proposer_id!==originRow.principal_id||
      ticket.target_digest!==change.contentHash||ticket.payload.purpose!==context.purpose||
      ticket.payload.id!==ticket.id||ticket.payload.target.kind!=='candidate'||
      ticket.payload.target.candidateId!==originRow.id||ticket.payload.target.contentHash!==change.contentHash||
      ticket.payload.status!==(ticket.state==='pending'?'pending':'finalized'))
      fail('COMPILATION_REVIEW_TICKET_INVALID','Review ticket is not bound to its compilation');
  }
  return {
    async hasOrigin(context,id){if(!contextIsValid(context)||!IdSchema.safeParse(id).success)return false;
      const row=await pool.query('SELECT 1 FROM ccl_knowledge_compilations WHERE id=$1 AND project_id=$2 AND space_id=$3',
        [id,context.scope.projectId,context.scope.spaceId]);return row.rowCount===1;},
    async request(context,input,key){requireAction(context,'review:request');
      if(input.target.kind!=='candidate'||input.purpose!==context.purpose)
        fail('REVIEW_TARGET_INVALID','Only an exact compilation candidate can be reviewed',404);
      const candidateId=input.target.candidateId,contentHash=input.target.contentHash;
      const result=await capabilityTransaction(pool,context,'review:request',key,input,grant,async(client,id)=>{
        const found=await origin(client,context,candidateId);
        if(!found||found.change.contentHash!==contentHash)
          fail('REVIEW_TARGET_INVALID','Staged compilation candidate is unavailable',404);
        const prior=await targetTicket(client,context,candidateId);
        if(prior){assertTicketOrigin(context,prior,found.row,found.change);return ReviewTicketSchema.parse(prior.payload);}
        if(found.row.state!=='waiting_for_review')
          fail('REVIEW_TARGET_INVALID','Only a waiting candidate can receive a new review ticket',404);
        const ticket=ReviewTicketSchema.parse({id,target:input.target,status:'pending',purpose:context.purpose});
        const inserted=await client.query(`INSERT INTO ccl_knowledge_review_tickets(id,project_id,space_id,requester_id,proposer_id,purpose,
          origin_kind,target_kind,target_id,target_digest,state,payload)
          VALUES($1,$2,$3,$4,$5,$6,'wiki_compile','candidate',$7,$8,'pending',$9)
          ON CONFLICT (project_id,space_id,target_kind,target_id) DO NOTHING RETURNING id`,
          [id,context.scope.projectId,context.scope.spaceId,context.principal.id,found.row.principal_id,
            context.purpose,found.row.id,found.change.contentHash,ticket]);
        if(inserted.rowCount===0){const concurrent=await targetTicket(client,context,candidateId);
          if(!concurrent)fail('REVIEW_TICKET_UNAVAILABLE','Concurrent ticket requires exact lookup');
          assertTicketOrigin(context,concurrent,found.row,found.change);
          return ReviewTicketSchema.parse(concurrent.payload);}
        return ticket;
      },async(saved,client)=>{
        const ticket=await ticketRow(client,context,saved.id);
        const found=await origin(client,context,candidateId);
        if(!ticket||!found||ticket.target_digest!==contentHash||ticket.proposer_id!==found.row.principal_id||
          ticket.id!==saved.id||saved.purpose!==context.purpose||saved.target.kind!=='candidate'||
          saved.target.candidateId!==candidateId||saved.target.contentHash!==contentHash)
          fail('COMPILATION_REVIEW_REPLAY_INVALID','Review request receipt no longer matches its origin');
        assertTicketOrigin(context,ticket,found.row,found.change);
        const meta=await metadata(context,found.row,found.change,false);
        await sourceProofs(client,context,found.row,meta.sourceRefs);
      });
      let latest:TicketRow|null;
      try{latest=await ticketRow(pool,context,result.id);}catch{throw new ReviewTicketLookupUnknownError(key);}
      if(!latest)fail('COMPILATION_REVIEW_REPLAY_INVALID','Review ticket disappeared after acknowledgement');
      return ReviewTicketSchema.parse(latest.payload);},
    async ticket(context,id){requireContext(context);const row=await ticketRow(pool,context,id);if(!row)return null;
      if(!mayRead(context,row.proposer_id,row.requester_id))return null;
      const found=await origin(pool,context,row.target_id);
      if(!found)fail('COMPILATION_REVIEW_TICKET_INVALID','Review origin is unavailable');
      assertTicketOrigin(context,row,found.row,found.change);
      return ReviewTicketSchema.parse(row.payload);},
    async viewCandidate(context,id){requireContext(context);const found=await origin(pool,context,id);if(!found)return null;
      const {row,change}=found;if(!mayRead(context,row.principal_id))
        fail('CANDIDATE_READ_FORBIDDEN','Explicit review action is required',403);
      const meta=await metadata(context,row,change,false);
      await checkedSources(context,row,meta.sourceRefs);
      const ticket=await targetTicket(pool,context,id);
      if(ticket)assertTicketOrigin(context,ticket,row,change);
      const changes:CandidateView['changes']=[];
      for(const [index,entry] of change.changes.entries()){
        const page=entry.revision;if(page.kind!=='wiki_page')fail('CANDIDATE_CONTENT_UNSUPPORTED','Only Wiki pages can be reviewed');
        const profile=getWikiPageProfile(page.content.profile.id,page.content.profile.version);
        if(!profile)fail('CANDIDATE_PROFILE_UNAVAILABLE','Wiki profile is unavailable');
        changes.push({ref:{...context.scope,domain:'knowledge',...page.ref,contentDigest:digest(page)},effect:entry.effect,
          before:await before(context,change,index),title:page.title,body:page.body,
          profile:{id:profile.id,version:profile.version,digest:wikiPageProfileFingerprint(profile)},
          conditions:page.content.conditions,counterexamples:page.content.counterexamples,unknowns:page.content.unknowns,
          nextQuestions:page.content.nextQuestions,
          sourceGroups:page.sourceGroups.map(id=>({id,status:'known',authority:'knowledge-revision-lineage'}))});
      }
      return CandidateViewSchema.parse({candidateId:id,contentHash:change.contentHash,purpose:context.purpose,
        proposer:row.principal_id,rationale:change.rationale,createdAt:change.createdAt,state:row.state,
        reviewable:row.state==='waiting_for_review'&&meta.issues.length===0,reviewIssues:meta.issues,
        canRequestReview:row.state==='waiting_for_review'&&context.authorization.actions.includes('review:request'),
        canDecideReview:row.state==='waiting_for_review'&&context.principal.id!==row.principal_id&&
          context.authorization.actions.includes('review:decide'),reviewTicketId:ticket?.id??null,
        exactReadset:row.result.evidence.map(item=>item.ref),changes});},
    async decide(context,id,input,key){requireAction(context,'review:decide');
      return capabilityTransaction(pool,context,'review:decide',key,{id,input},grant,async(client,decisionId)=>{
        // One project lock spans admission, both source proofs, the review and publication.
        await client.query('SELECT 1 FROM ccl_knowledge_projects WHERE project_id=$1 FOR UPDATE',[context.scope.projectId]);
        const ticket=await ticketRow(client,context,id,true);
        if(!ticket)fail('REVIEW_TICKET_UNAVAILABLE','Review ticket is unavailable',404);
        if(ticket.state!=='pending')fail('REVIEW_ALREADY_FINALIZED','Review was already finalized');
        if(ticket.proposer_id===context.principal.id)fail('SELF_REVIEW_FORBIDDEN','Independent reviewer required',403);
        if(input.decision==='exploration_only'&&context.purpose!=='exploration_reading')
          fail('REVIEW_DECISION_PURPOSE_INVALID','Exploration only approval requires exploration reading purpose');
        if(ticket.target_digest!==input.expectedDigest||!input.reason.trim())
          fail('REVIEW_DIGEST_MISMATCH','Exact digest and reason are required');
        const found=await origin(client,context,ticket.target_id,true);
        if(!found||found.row.state!=='waiting_for_review'||found.row.principal_id!==ticket.proposer_id||
          found.change.contentHash!==ticket.target_digest||ticket.payload.purpose!==context.purpose)
          fail('REVIEW_TARGET_CHANGED','Compilation candidate changed before review');
        const {row,change}=found;
        if(ticket.payload.target.kind!=='candidate'||ticket.payload.target.candidateId!==row.id||
          ticket.payload.target.contentHash!==change.contentHash)
          fail('REVIEW_TARGET_CHANGED','Ticket target changed before review');
        let publication:FinalizeReceipt['publication']=null;
        if(input.decision!=='rejected'){
          const declared=new Set(change.changes.flatMap(item=>item.revision.kind==='wiki_page'?
            [...item.revision.content.conditions,...item.revision.content.unknowns,...item.revision.scope.limitations,
              ...item.revision.scope.unknowns]:[]));
          if([...input.conditions,...input.gaps].some(value=>!declared.has(value)))
            fail('REVIEW_CONTENT_CHANGE_REQUIRED','New conditions or gaps require a new candidate',409);
          const meta=await metadata(context,row,change,true);
          await sourceProofs(client,context,row,meta.sourceRefs);
          await store.recordReview({id:decisionId,projectId:context.scope.projectId,
            changeSetId:change.id,contentHash:change.contentHash,reviewer:context.principal.id,
            policyVersion:'wiki-compile-independent-review-v1',purpose:context.purpose,decision:input.decision,
            rationale:input.reason,createdAt:new Date().toISOString()} satisfies KnowledgeReview,client);
          const published=await store.publish(context.scope.projectId,change.id,change.contentHash,client);
          publication={changeSetId:published.changeSetId,
            refs:change.changes.map(entry=>({...context.scope,domain:'knowledge',...entry.revision.ref,
              contentDigest:digest(entry.revision)})),epoch:published.epoch,publishedAt:published.publishedAt};
        }else await store.recordReview({id:decisionId,projectId:context.scope.projectId,
          changeSetId:change.id,contentHash:change.contentHash,reviewer:context.principal.id,
          policyVersion:'wiki-compile-independent-review-v1',purpose:context.purpose,decision:'rejected',
          rationale:input.reason,createdAt:new Date().toISOString()},client);
        const final:FinalizeReceipt={reviewReceiptId:decisionId,target:ticket.payload.target,publication,result:null};
        const next=WikiCompileResultSchema.parse({...row.result,state:publication?'published':'rejected',
          publication,reviewReceiptId:decisionId,reviewDecision:input.decision,completedAt:new Date().toISOString()});
        const updated=await client.query(`UPDATE ccl_knowledge_compilations SET state=$2,result=$3,updated_at=now()
          WHERE id=$1 AND project_id=$4 AND space_id=$5 AND purpose=$6 AND state='waiting_for_review'`,
          [row.id,next.state,next,row.project_id,row.space_id,row.purpose]);
        if(updated.rowCount!==1)fail('REVIEW_TARGET_CHANGED','Compilation changed during review');
        const finalized=await client.query(`UPDATE ccl_knowledge_review_tickets SET state='finalized',payload=$2,
          final_receipt=$3,reviewer_id=$4,decision=$5,decided_at=now()
          WHERE id=$1 AND project_id=$6 AND space_id=$7 AND state='pending'`,
          [id,{...ticket.payload,status:'finalized'},final,context.principal.id,input,
            context.scope.projectId,context.scope.spaceId]);
        if(finalized.rowCount!==1)fail('REVIEW_ALREADY_FINALIZED','Review was finalized concurrently');
        await finalizeCoordinationReview(client,row,{state:publication?'published':'rejected',completedAt:next.completedAt!});
        return final;
      },async(saved,client)=>{
        await client.query('SELECT 1 FROM ccl_knowledge_projects WHERE project_id=$1 FOR UPDATE',[context.scope.projectId]);
        const ticket=await ticketRow(client,context,id);
        if(!ticket||ticket.state!=='finalized'||!ticket.final_receipt||
          canonical(ticket.final_receipt)!==canonical(saved)||ticket.proposer_id===context.principal.id||
          ticket.target_digest!==input.expectedDigest)
          fail('COMPILATION_REVIEW_REPLAY_INVALID','Review receipt no longer matches its finalized ticket');
        const found=await origin(client,context,ticket.target_id);
        if(!found||found.row.result.reviewReceiptId!==saved.reviewReceiptId||
          found.row.result.reviewDecision!==input.decision||
          canonical(found.row.result.publication??null)!==canonical(saved.publication))
          fail('COMPILATION_REVIEW_REPLAY_INVALID','Review receipt no longer matches the compilation');
        const meta=await metadata(context,found.row,found.change,false);
        await sourceProofs(client,context,found.row,meta.sourceRefs);
      });},
  };
}
