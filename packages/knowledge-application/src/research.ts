import {createHash} from 'node:crypto';
import type {KnowledgeStore,KnowledgeRevision,KnowledgeChangeSet,Dependency} from '@commerce/knowledge-core/types';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {digest} from '@commerce/knowledge-core/utils';
import {getWikiPageProfile,WikiPageContentSchema,wikiPageFrozenDependencies,wikiPageProfileFingerprint,wikiPageReadsetFingerprint,wikiPageInputFingerprint,matchesWikiPageFrozenBinding} from '@commerce/knowledge-core/wiki-page';
import {ResearchResultSchema,type KnowledgeRef,type Operation,type ResearchRequest,type ResearchResult,type Scope,type SourceContent,type SourceAccessProof} from '@commerce/knowledge-contracts';
import type {ReadContext,ReceiptPort} from './index.ts';
import {authorizeCapability,type CapabilityContext,type SourceRegistryPort} from './sources.ts';
import {evaluateKnowledgeRevision} from './status-policy.ts';

type ReadCoverage=SourceContent['actualCoverage'];
type FrozenResearch={request:ResearchRequest;refs:KnowledgeRef[];sourceRefs:KnowledgeRef[];sourceProofs:SourceAccessProof[];
  sourceGroups:string[];actualReadCoverage:ReadCoverage[];receiptId:string|null;epoch:number;submittedAt:string};
const zeroCost={modelCalls:{state:'known' as const,value:0},tokens:{state:'known' as const,value:0},
  money:{state:'known' as const,amount:0,currency:'USD',source:'synthetic_local_no_paid_calls'}};
const same=(a:KnowledgeRef,b:KnowledgeRef)=>a.projectId===b.projectId&&a.spaceId===b.spaceId&&a.domain===b.domain&&a.objectId===b.objectId&&a.versionId===b.versionId&&a.contentDigest===b.contentDigest;
export interface ResearchOperationPort {
  replay(input:{scope:Scope;principalId:string;operation:string;key:string;inputDigest:string}):Promise<Operation|null>;
  reserve(input:{scope:Scope;principalId:string;operation:string;key:string;inputDigest:string;input:unknown}):Promise<Operation>;
  claim(projectId?:string):Promise<{id:string;scope:Scope;principalId:string;input:unknown;attemptId:string}|null>;
  finish(id:string,attemptId:string,result:ResearchResult,state:'succeeded'|'waiting_for_review'|'waiting_for_source'):Promise<void>;
  reconcileExpired(projectId?:string):Promise<number>;
}
export interface FeedbackResearchPort {validateLinks(context:ReadContext,feedbackIds:readonly string[],sourceRefs:readonly KnowledgeRef[]):Promise<void>}
export type SyntheticResearchFinding={outcome:'candidate';summary:string;conditions:string[];counterexamples:string[];unknowns:string[];nextQuestions:string[]}
  |{outcome:'no_change'|'needs_evidence';reason:string;gaps:string[];sourceNeeds:string[]};
export interface SyntheticResearchProvider {generate(input:{question:string;refs:KnowledgeRef[];sourceRefs:KnowledgeRef[];scope:Scope;
  knowledgeInputs:Array<{ref:KnowledgeRef;title:string;body:string}>;sourceInputs:SourceContent[]}):Promise<SyntheticResearchFinding>}
const defaultProvider:SyntheticResearchProvider={async generate(input){return input.refs.length||input.sourceRefs.length?
  {outcome:'no_change',reason:'Synthetic engineering provider reused exact inputs without creating a new claim; semantic research was not performed.',gaps:['Semantic research not performed'],sourceNeeds:[]}:
  {outcome:'needs_evidence',reason:'Synthetic engineering provider has no evidence inputs; no factual candidate was created.',
    gaps:['No exact source or knowledge basis supplied'],sourceNeeds:['Register and independently review a source before research']};}};
function stableUuid(input:string){const hash=createHash('sha256').update(input).digest('hex');
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;}

/** An engineering-only synthetic provider. It never publishes or claims semantic evidence quality. */
export function createSyntheticResearchService(options:{store:KnowledgeStore;receipts:ReceiptPort;operations:ResearchOperationPort;
  sources?:SourceRegistryPort;feedback?:FeedbackResearchPort;provider?:SyntheticResearchProvider;now?:()=>Date}){
  const now=()=>options.now?.()??new Date();
  async function assertExact(scope:Scope,ref:KnowledgeRef,purpose:string){
    if(ref.projectId!==scope.projectId||ref.spaceId!==scope.spaceId||ref.domain!=='knowledge'||!ref.contentDigest)
      throw new KnowledgeError('RESEARCH_REF_SCOPE','Research ref must be an exact knowledge version in scope',403);
    const view=await options.store.get(scope.projectId,{objectId:ref.objectId,versionId:ref.versionId});
    if(!view?.published||digest(view.revision)!==ref.contentDigest)
      throw new KnowledgeError('RESEARCH_BASIS_INVALID','Exact current reviewed knowledge basis is unavailable',409);
    const policy=evaluateKnowledgeRevision(view,purpose);
    if(policy.spaceId!==scope.spaceId||!policy.admitted)
      throw new KnowledgeError('RESEARCH_BASIS_INVALID','Exact current reviewed knowledge basis is unavailable',409);
    return view;
  }
  async function submit(context:CapabilityContext,request:ResearchRequest,key:string):Promise<Operation>{
    authorizeCapability(context,'research:write');
    if(request.purpose!==context.purpose)throw new KnowledgeError('PURPOSE_MISMATCH','Research purpose differs from authenticated context',403);
    if(request.allowExternalAcquisition!==false)throw new KnowledgeError('ACQUISITION_FORBIDDEN','Research cannot acquire raw sources',422);
    const operationIdentity={scope:context.scope,principalId:context.principal.id,operation:'research',key,
      inputDigest:digest({scope:context.scope,principalId:context.principal.id,request})};
    const prior=await options.operations.replay(operationIdentity);if(prior)return prior;
    if(request.budget.maxModelCalls!==0||request.budget.maxMoney!==null)
      throw new KnowledgeError('SYNTHETIC_ONLY','Local engineering research permits zero model calls and no paid budget only',422);
    if(request.feedbackIds?.length){if(!options.feedback)throw new KnowledgeError('FEEDBACK_LINK_UNAVAILABLE','Feedback lineage reader is unavailable',503);
      if(new Set(request.feedbackIds).size!==request.feedbackIds.length)throw new KnowledgeError('FEEDBACK_DUPLICATE','Feedback IDs must be distinct',422);
      await options.feedback.validateLinks(context,request.feedbackIds,request.sourceRefs);}
    if(Date.parse(request.budget.deadline)<=now().getTime())throw new KnowledgeError('DEADLINE_EXPIRED','Research deadline has passed',422);
    const epoch=await options.store.epoch(context.scope.projectId);
    let refs=request.knowledgeRefs;
    if(request.readReceiptId){const receipt=await options.receipts.get(context.scope,context.principal.id,request.readReceiptId);
      if(!receipt||receipt.purpose!==context.purpose||Date.parse(receipt.expiresAt)<=now().getTime())
        throw new KnowledgeError('READ_RECEIPT_INVALID','Exact read receipt unavailable or expired',409);
      if(receipt.coverage.snapshot.publicationEpoch!==epoch)throw new KnowledgeError('READ_RECEIPT_STALE','Knowledge changed since the frozen read',409);
      if(!refs.length)refs=receipt.orderedItems.map(item=>item.ref);
      else if(refs.some(ref=>!receipt.orderedItems.some(item=>same(item.ref,ref))))
        throw new KnowledgeError('READSET_MISMATCH','Explicit research refs must be in the frozen read receipt',409);
    }
    if(new Set(refs.map(ref=>`${ref.objectId}/${ref.versionId}`)).size!==refs.length)throw new KnowledgeError('DUPLICATE_BASIS','Research basis repeats exact refs',422);
    let bytes=0;for(const ref of refs){const view=await assertExact(context.scope,ref,context.purpose);bytes+=Buffer.byteLength(view.revision.body,'utf8');}
    const sourceProofs:SourceAccessProof[]=[],actualReadCoverage:ReadCoverage[]=[],sourceGroups:string[]=[];
    for(const ref of request.sourceRefs){
      if(ref.projectId!==context.scope.projectId||ref.spaceId!==context.scope.spaceId||ref.domain!=='source'||!ref.contentDigest)
        throw new KnowledgeError('SOURCE_REF_SCOPE','Research source needs an exact digest in its authenticated scope',403);
      if(!options.sources)throw new KnowledgeError('SOURCE_ASSURANCE_UNAVAILABLE','Source owner port is unavailable',503);
      const content=await options.sources.readContent(context.scope,ref,null,context);
      if(!content||content.contentDigest!==ref.contentDigest||content.readability.assurance!=='local_transaction'||!content.readability.contentReadable)
        throw new KnowledgeError('SOURCE_ASSURANCE_UNAVAILABLE','Only readable managed local source content can enter research',503);
      bytes+=Buffer.byteLength(content.content,'utf8');actualReadCoverage.push(content.actualCoverage);
      const record=await options.sources.readRecord(context.scope,ref,context);
      if(!record||record.readability.assurance!=='local_transaction')throw new KnowledgeError('SOURCE_ASSURANCE_UNAVAILABLE','Exact local source metadata unavailable',503);
      sourceGroups.push(...record.sourceGroups.flatMap(group=>group.id?[group.id]:[]));
      sourceProofs.push(await options.sources.proof(context,ref));
    }
    if(bytes>request.budget.maxReadBytes)throw new KnowledgeError('READ_BUDGET_EXCEEDED','Frozen knowledge read exceeds the declared byte budget',422);
    for(const base of request.baseHeads){const head=await options.store.head(context.scope.projectId,base.objectId);
      if((head?.versionId??null)!==base.versionId)throw new KnowledgeError('BASE_HEAD_CHANGED','Candidate base head changed',409);}
    const frozen:FrozenResearch={request,refs,sourceRefs:request.sourceRefs,sourceProofs,sourceGroups,actualReadCoverage,
      receiptId:request.readReceiptId??null,epoch,submittedAt:now().toISOString()};
    return options.operations.reserve({...operationIdentity,input:frozen});
  }
  async function processOne(projectId?:string):Promise<boolean>{
    await options.operations.reconcileExpired(projectId);const claimed=await options.operations.claim(projectId);if(!claimed)return false;
    const frozen=claimed.input as FrozenResearch;
    try{
      if(!frozen||!Array.isArray(frozen.refs)||!frozen.request)throw new KnowledgeError('RESEARCH_INPUT_INVALID','Frozen research input is malformed',422);
      if(Date.parse(frozen.request.budget.deadline)<=now().getTime())throw new KnowledgeError('DEADLINE_EXPIRED','Research deadline elapsed before execution',422);
      if(await options.store.epoch(claimed.scope.projectId)!==frozen.epoch)throw new KnowledgeError('RESEARCH_INPUT_CHANGED','Knowledge epoch changed before research execution',409);
      const views=await Promise.all(frozen.refs.map(ref=>assertExact(claimed.scope,ref,frozen.request.purpose)));
      const sourceInputs:SourceContent[]=[];
      for(const ref of frozen.sourceRefs){if(!options.sources)throw new KnowledgeError('SOURCE_ASSURANCE_UNAVAILABLE','Source owner port is unavailable',503);
        const context:ReadContext={scope:claimed.scope,purpose:frozen.request.purpose,principal:{id:claimed.principalId,clientInstallationId:'worker',
          projectId:claimed.scope.projectId,spaceIds:[claimed.scope.spaceId],purposes:[frozen.request.purpose]}};
        const content=await options.sources.readContent(claimed.scope,ref,null,context);
        if(!content||content.contentDigest!==ref.contentDigest||content.readability.assurance!=='local_transaction')
          throw new KnowledgeError('SOURCE_REVOKED','Source content or rights changed before research',409);
        sourceInputs.push(content);
      }
      const finding=await (options.provider??defaultProvider).generate({question:frozen.request.question,refs:frozen.refs,sourceRefs:frozen.sourceRefs,
        scope:claimed.scope,knowledgeInputs:views.map((view,index)=>({ref:frozen.refs[index],title:view.revision.title,body:view.revision.body})),sourceInputs});
      let candidateId:string|null=null;
      if(finding.outcome==='candidate'){
        if(!frozen.refs.length&&!frozen.sourceRefs.length)throw new KnowledgeError('CANDIDATE_BASIS_REQUIRED','A candidate needs an exact source or knowledge basis',422);
        const profile=getWikiPageProfile('question','1');if(!profile)throw new KnowledgeError('PROFILE_UNAVAILABLE','Question profile is unavailable',503);
        const objectId=stableUuid(`${claimed.scope.projectId}:${claimed.scope.spaceId}:question:${frozen.request.question.normalize('NFKC')}`),
          versionId=stableUuid(`${claimed.id}:${digest(finding)}`),ref={objectId,versionId},
          prior=frozen.request.baseHeads.find(base=>base.objectId===objectId)?.versionId??null;
        if(((await options.store.head(claimed.scope.projectId,objectId))?.versionId??null)!==prior)
          throw new KnowledgeError('BASE_HEAD_CHANGED','Candidate object head changed',409);
        const content=WikiPageContentSchema.parse({schemaVersion:'1.0' as const,profile:{id:'question',version:'1'},identity:{key:frozen.request.question,aliases:[]},
          summary:finding.summary,conditions:finding.conditions,counterexamples:finding.counterexamples,unknowns:finding.unknowns,
          nextQuestions:finding.nextQuestions,citations:[],navigation:[]});
        const selected:Dependency[]=[...frozen.refs.map(item=>({domain:'knowledge' as const,ref:{objectId:item.objectId,versionId:item.versionId},role:'derived_from' as const,critical:true})),
          ...frozen.sourceRefs.map(item=>({domain:'source' as const,ref:{objectId:item.objectId,versionId:item.versionId},role:'derived_from' as const,critical:true}))];
        const dependencies=wikiPageFrozenDependencies({content,dependencies:selected});
        const sourceGroups=[...new Set([...views.flatMap(view=>view.revision.sourceGroups),...frozen.sourceGroups])];
        const base:KnowledgeRevision={kind:'wiki_page',ref,projectId:claimed.scope.projectId,title:frozen.request.question,
          body:finding.summary,content,scope:{applicability:{productVersionRefs:[],markets:[],languages:[],audiences:[],goals:[],requiredProduction:[],transferRationale:null},
            limitations:['Synthetic engineering candidate; no semantic or business validation'],unknowns:finding.unknowns,reviewDueAt:null},
          dependencies,sourceGroups,artifactRef:null,createdAt:frozen.submittedAt,analysisQuality:null};
        const binding={bindingKind:'wiki_page' as const,spaceId:claimed.scope.spaceId,specificationId:'synthetic-research-v1',
          specificationVersion:'1',contentVersion:'wiki_page/1.0' as const,methodVersion:'synthetic-local-v1',policyVersion:'independent-review-required-v1',
          inputFingerprint:wikiPageInputFingerprint(base),readsetFingerprint:wikiPageReadsetFingerprint(base),profileFingerprint:wikiPageProfileFingerprint(profile)};
        const revision:KnowledgeRevision={...base,binding};
        if(!matchesWikiPageFrozenBinding(revision))throw new KnowledgeError('CANDIDATE_BINDING_INVALID','Frozen candidate binding did not validate',422);
        const contentHash=digest(revision),change:KnowledgeChangeSet={id:claimed.id,projectId:claimed.scope.projectId,
          requestKey:`synthetic-research:${claimed.id}`,requestHash:digest(frozen.request),contentHash,purpose:frozen.request.purpose,
          proposer:claimed.principalId,rationale:'Synthetic engineering candidate; independent semantic review required',methodVersion:'synthetic-local-v1',
          cost:{state:'known',amount:0,currency:'USD'},baseHeads:[{objectId,versionId:prior}],inputManifest:dependencies,
          changes:[{revision,effect:prior?'correct':'create',explanation:'Synthetic candidate from frozen exact readset'}],createdAt:frozen.submittedAt};
        await options.store.stage(change);candidateId=change.id;
      }
      const resultBase={researchId:claimed.id,cognitiveOutcome:finding.outcome,exactReadset:[...frozen.refs,...frozen.sourceRefs],inheritedBasis:frozen.refs,
        actualReadCoverage:frozen.actualReadCoverage,selected:[...frozen.refs,...frozen.sourceRefs].map(ref=>({ref,reason:'Exact synthetic fixture input'})),excluded:[],
        reason:finding.outcome==='candidate'?'Synthetic engineering candidate; independent semantic review required.':finding.reason,
        gaps:finding.outcome==='candidate'?finding.unknowns:finding.gaps,
        sourceNeeds:finding.outcome==='candidate'?[]:finding.sourceNeeds,cost:zeroCost,
        reviewState:'waiting_for_review',reviewReceiptId:null,candidateId,publication:null};
      const result:ResearchResult=ResearchResultSchema.parse({...resultBase,resultDigest:digest(resultBase)});
      await options.operations.finish(claimed.id,claimed.attemptId,result,'waiting_for_review');return true;
    }catch(error){
      // A validation failure after reservation is durable uncertainty until an operator reviews exact inputs.
      const reason=(error instanceof Error?error.message:String(error)).slice(0,2000);
      const resultBase={researchId:claimed.id,cognitiveOutcome:'needs_evidence' as const,exactReadset:frozen?.refs??[],inheritedBasis:[],
        actualReadCoverage:[],selected:[],excluded:[],reason:`Synthetic operation could not safely proceed: ${reason}`,
        gaps:[reason],sourceNeeds:[],cost:zeroCost,reviewState:'needs_reconciliation',reviewReceiptId:null,candidateId:null,publication:null};
      const result:ResearchResult=ResearchResultSchema.parse({...resultBase,resultDigest:digest(resultBase)});
      await options.operations.finish(claimed.id,claimed.attemptId,result,'waiting_for_source');return true;
    }
  }
  return {submit,processOne};
}
