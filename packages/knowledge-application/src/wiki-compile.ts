import {executeWithDeadline} from './provider-execution.ts';
import type {KnowledgeRevision} from '@commerce/knowledge-core/types';
import type {WikiCompileRequest,WikiCompileResult,WikiCompileProposal,SourceAccessProof,CandidateReceipt,ProfileRef,RelationJudgment,DecisionAnswer,KnowledgeRef,AskClaim} from '@commerce/knowledge-contracts';
import type {AskEvidence,AskAnswerReader} from './ask.ts';
import type {ReadContext} from './index.ts';
export interface WikiCompileOperationPort {
 reserve(context:ReadContext,key:string,inputDigest:string,request:WikiCompileRequest,initial:WikiCompileResult):Promise<{created:boolean;result:WikiCompileResult}>;
 start(context:ReadContext,id:string):Promise<boolean>;
 checkpoint(context:ReadContext,id:string,result:WikiCompileResult):Promise<void>;
 finish(context:ReadContext,id:string,result:WikiCompileResult):Promise<void>;
 get(context:ReadContext,id:string):Promise<WikiCompileResult|null>;
 lookup(context:ReadContext,key:string):Promise<WikiCompileResult|null>;
 reconcileCandidate?(context:ReadContext,id:string,requestHash:string,candidate:CandidateReceipt):Promise<WikiCompileResult>;
}
export interface WikiCompiler {
 id:string;model:string;methodVersion:string;execution:'local_deterministic'|'external';supportsMoneyLimit?:boolean;
 compile(input:{operationId:string;question:string;purpose:string;evidence:readonly AskEvidence[];profiles:readonly ProfileRef[];
  budget:WikiCompileRequest['budget'];signal:AbortSignal;gaps:readonly string[];
  answerSeed?:{answerId:string;answerFingerprint:string;question:string;claims:readonly AskClaim[];gaps:readonly string[]};
  /** Present only for repair. The target evidence is comparison-only; each critical dependency needs an explicit disposition. */
  repairTarget?:{evidenceId:string;invalidityReasons:readonly string[];reviewDueAt:string|null;
   dependencies:readonly {domain:string;ref:{objectId:string;versionId:string};critical:boolean;valid:boolean}[]};
  relationHints?:readonly {judgmentId:string;inputFingerprint:string;sourceRelation:RelationJudgment['sourceRelation'];answers:readonly DecisionAnswer[]}[]}):Promise<{proposal:WikiCompileProposal;
   cost:WikiCompileResult['cost'];modelReturned:string|null;requestId:string|null}>;
}
export interface WikiCompileStageInput {operationId:string;request:WikiCompileRequest;proposal:WikiCompileProposal;evidence:readonly AskEvidence[];
 bases:ReadonlyMap<string,KnowledgeRevision>;sourceProofs:readonly SourceAccessProof[];createdAt:string;methodVersion:string;cost:WikiCompileResult['cost']}
export interface WikiCompileStagePort {stage(context:ReadContext,input:WikiCompileStageInput):Promise<CandidateReceipt>;
 lookup?(context:ReadContext,operationId:string,requestHash:string):Promise<CandidateReceipt|null>}

import {randomUUID} from 'node:crypto';
import {WikiCompileRequestSchema,WikiCompileResultSchema,WikiCompileProposalSchema,CostSchema,QueryRequestSchema,fromVersionRef} from '@commerce/knowledge-contracts';
import type {RepairTargetPage} from './index.ts';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {digest} from '@commerce/knowledge-core/utils';
import {getWikiPageProfile,wikiPageProfileFingerprint,listWikiPageProfiles} from '@commerce/knowledge-core/wiki-page';
import type {KnowledgeApplication} from './index.ts';
import type {CapabilityContext,SourceRegistryPort} from './sources.ts';
import {authorizeCapability} from './sources.ts';
import type {createSourceIntakeApplication} from './source-intake.ts';
import {resolveAnswerSeed,type ResolvedAnswerSeed} from './answer-research.ts';
export function wikiCompileStageRequestHash(input:Pick<WikiCompileStageInput,'operationId'|'request'|'proposal'|'evidence'|'methodVersion'|'cost'>){return digest({operationId:input.operationId,request:input.request,proposal:input.proposal,
 evidence:input.evidence.map(({body,...item})=>({...item,bodyDigest:digest(body)})),methodVersion:input.methodVersion,cost:input.cost});}
const zero=():WikiCompileResult['cost']=>({modelCalls:{state:'known',value:0},tokens:{state:'known',value:0},money:{state:'known',amount:0,currency:'USD',source:'no_provider_call'}});
const pending=():WikiCompileResult['cost']=>({modelCalls:{state:'unknown',reason:'Provider dispatch prepared'},tokens:{state:'unknown',reason:'Provider response not acknowledged'},money:{state:'unknown',reason:'Reconcile the original compilation before retrying'}});
const receipt=({body:_,...item}:AskEvidence)=>item;
const unknownGroup=()=>({id:null,status:'unknown' as const,authority:null});
const exactRefKey=(ref:KnowledgeRef)=>digest(ref);
const sameExactRefs=(actual:readonly KnowledgeRef[],expected:readonly KnowledgeRef[])=>
 actual.length===expected.length&&canonicalRefs(actual)===canonicalRefs(expected);
const canonicalRefs=(refs:readonly KnowledgeRef[])=>JSON.stringify(refs.map(exactRefKey).sort());

const repairKey=(domain:string,ref:{objectId:string;versionId:string})=>`${domain}:${ref.objectId}/${ref.versionId}`;
/** A repair revises its exact target once and disposes every prior critical dependency; nothing invalid is inherited silently. */
export function assertRepairProposal(proposal:WikiCompileProposal,repair:{evidenceId:string;page:RepairTargetPage},evidence:readonly AskEvidence[],at:Date){
 const fail=(code:string,message:string):never=>{throw new KnowledgeError(code,message,422);};
 if(proposal.drafts.length!==1)fail('REPAIR_DRAFT_INVALID','A repair proposes exactly one revision of its target');
 const draft=proposal.drafts[0],plan=draft.repair;
 if(draft.targetEvidenceId!==repair.evidenceId)fail('REPAIR_DRAFT_INVALID','A repair must revise its exact target');
 if(!plan)fail('REPAIR_DISPOSITION_REQUIRED','A repair must dispose each prior critical dependency');
 const self=repair.page.ref.objectId,prior=new Map<string,RepairTargetPage['dependencies'][number]>();
 for(const dependency of repair.page.dependencies){
  if(!dependency.critical||dependency.domain==='knowledge'&&dependency.ref.objectId===self)continue;
  if(dependency.domain!=='knowledge'&&dependency.domain!=='source')fail('REPAIR_DEPENDENCY_UNSUPPORTED','Only local source and Wiki dependencies can be repaired');
  prior.set(repairKey(dependency.domain,dependency.ref),dependency);
 }
 const disposed=new Set(plan!.dependencies.map(item=>repairKey(item.domain,item.ref)));
 if(disposed.size!==prior.size||[...prior.keys()].some(key=>!disposed.has(key)))
  fail('REPAIR_DISPOSITION_INCOMPLETE','Each prior critical dependency needs exactly one keep, replace or remove disposition');
 for(const item of plan!.dependencies){
  const old=prior.get(repairKey(item.domain,item.ref))!;
  if(!item.reason.trim())fail('REPAIR_DISPOSITION_REASON_REQUIRED','Each dependency disposition needs a reason');
  if(item.action==='keep'&&!old.valid)fail('REPAIR_KEEPS_INVALID_DEPENDENCY','An invalid dependency cannot be kept in the repaired version');
  if(item.action==='replace'){
   const replacement=evidence.find(read=>read.id===item.replacementEvidenceId);
   if(!replacement||replacement.role==='repair_target'||replacement.kind!==(item.domain==='knowledge'?'wiki_page':'source_content'))
    fail('REPAIR_REPLACEMENT_UNREAD','A replacement must be exact current evidence of the same domain read in this compilation');
   if(replacement!.ref.objectId===item.ref.objectId&&replacement!.ref.versionId===item.ref.versionId)
    fail('REPAIR_REPLACEMENT_UNCHANGED','A replacement must name a different exact version');
   if(!draft.supportEvidenceIds.includes(replacement!.id))fail('REPAIR_REPLACEMENT_UNSUPPORTED','A replacement must be declared as new support');
  }
 }
 const due=repair.page.reviewDueAt,elapsed=!!due&&Date.parse(due)<=at.getTime();
 if(plan!.reviewDue.action==='keep'&&elapsed)fail('REPAIR_REVIEW_DUE_REQUIRED','An elapsed review date needs a new date or an explicit clearing reason');
 if(plan!.reviewDue.action!=='keep'&&!plan!.reviewDue.reason.trim())fail('REPAIR_REVIEW_DUE_REASON_REQUIRED','A review date change needs a reason');
 if(plan!.reviewDue.action==='set'&&Date.parse(plan!.reviewDue.until)<=at.getTime())fail('REPAIR_REVIEW_DUE_PAST','A new review date must be in the future');
}

/** Compiles a bounded exact readset into proposals; only the trusted stage port can create a changeset. */
export function createWikiCompileApplication(options:{reader:Pick<KnowledgeApplication,'queryCandidates'|'readCandidate'|'validateFrozenWiki'|'sourceRecord'|'sourceContentBounded'|'assertReadEpoch'>&Partial<Pick<KnowledgeApplication,'validateHistoricalWiki'|'readWikiExactBounded'|'readRepairTarget'|'validateRepairTarget'>>;
 intake:Pick<ReturnType<typeof createSourceIntakeApplication>,'get'>;operations:WikiCompileOperationPort;provider:WikiCompiler;
 stage?:WikiCompileStagePort;sources?:SourceRegistryPort;answers?:AskAnswerReader;
 judgments?:{get(context:CapabilityContext,id:string):Promise<RelationJudgment>};now?:()=>Date;
 authorizeExternalDispatch?:(context:ReadContext,evidence:readonly AskEvidence[],provider:WikiCompiler)=>Promise<void>}){
 const now=()=>options.now?.()??new Date();
 function auth(context:CapabilityContext,action:string){authorizeCapability(context,action);
  if(!context.principal.clientInstallationId?.trim())throw new KnowledgeError('INSTALLATION_REQUIRED','Compilation requires an authenticated installation',403);}
 async function validate(context:ReadContext,result:WikiCompileResult){
  if(result.answerOrigin){
   if(!options.answers)throw new KnowledgeError('ANSWER_READER_REQUIRED','Answer origin needs an authenticated reader',503);
   const origin=result.answerOrigin,seed={answerId:origin.answerId,expectedAnswerFingerprint:origin.answerFingerprint,claimIndexes:origin.claimIndexes};
   const resolved=await resolveAnswerSeed(context,seed,options.answers,['published','rejected'].includes(result.state)?'historical':'current');
   if(digest(resolved.origin)!==digest(origin))
    throw new KnowledgeError('ANSWER_ORIGIN_CHANGED','Compilation origin differs from its authenticated answer',409);
  }
  for(const item of result.evidence){
   if(item.kind==='wiki_page'){
    if(!item.storageDigest)throw new KnowledgeError('COMPILE_READSET_INVALID','Missing frozen Wiki storage fingerprint',409);
    if(item.role==='repair_target'){
     // A finished repair keeps the target as history; an open one must still be the unchanged current head.
     if(['published','rejected'].includes(result.state)){
      if(!options.reader.validateHistoricalWiki)throw new KnowledgeError('BOUNDED_WIKI_READ_UNSUPPORTED','Historical Wiki verifier is unavailable',503);
      await options.reader.validateHistoricalWiki(context,item.ref,item.storageDigest);
     }else{
      if(!options.reader.validateRepairTarget)throw new KnowledgeError('REPAIR_UNSUPPORTED','Repair target verifier is unavailable',503);
      await options.reader.validateRepairTarget(context,item.ref,item.storageDigest);
     }
    }else if(['published','rejected'].includes(result.state)&&options.reader.validateHistoricalWiki)await options.reader.validateHistoricalWiki(context,item.ref,item.storageDigest);
    else await options.reader.validateFrozenWiki(context,item.ref,item.storageDigest);
   }else{const source=await options.reader.sourceRecord(context,item.ref);
    if(!source.readability.contentReadable||!source.readability.metadataVisible)throw new KnowledgeError('SOURCE_FORBIDDEN','Compilation source is no longer readable',403);}
  }
 }
 async function recover(context:ReadContext,value:WikiCompileResult){
  await validate(context,value);
  if(['running','outcome_unknown'].includes(value.state)&&value.stageIntent&&value.drafts.length&&options.stage?.lookup&&options.operations.reconcileCandidate){
   const found=await options.stage.lookup(context,value.id,value.stageIntent.requestHash);
   if(found)return options.operations.reconcileCandidate(context,value.id,value.stageIntent.requestHash,found);
  }return value;
 }
 async function get(context:CapabilityContext,id:string){auth(context,'compile:read');const value=await options.operations.get(context,id);
  if(!value)throw new KnowledgeError('NOT_FOUND','Compilation is unavailable',404);return recover(context,value);}
 async function committed<T>(work:Promise<T>,id:string):Promise<T>{try{return await work;}catch(error){
  const failure=error instanceof Error?error:new KnowledgeError('COMPILATION_UNAVAILABLE','Compilation requires reconciliation',503);
  return Promise.reject(Object.assign(failure,{...!('commitStatus'in failure)?{commitStatus:'committed'}:{},operationId:id}));}}
 return {get,async lookup(context:CapabilityContext,key:string){auth(context,'compile:read');const value=await options.operations.lookup(context,key);
   return value?recover(context,value):null;},
  async compile(context:CapabilityContext,raw:unknown,key:string,parentSignal?:AbortSignal):Promise<WikiCompileResult>{
   auth(context,'compile:write');auth(context,'compile:read');const request=WikiCompileRequestSchema.parse(raw);
   if(request.sourceEventIds.length)auth(context,'ingest:read');
   if(request.purpose!==context.purpose)throw new KnowledgeError('PURPOSE_MISMATCH','Compilation purpose differs',403);
   if(request.selectedRefs?.some(ref=>ref.projectId!==context.scope.projectId||ref.spaceId!==context.scope.spaceId))
    throw new KnowledgeError('SELECTED_REF_SCOPE_MISMATCH','Selected Wiki versions must belong to the authenticated scope',403);
   if((request.selectedRefs?.length??0)>request.limit)
    throw new KnowledgeError('SELECTED_WIKI_LIMIT_EXCEEDED','Selected Wiki versions exceed the global Wiki read limit',422);
   if(request.sourceRefs?.some(ref=>ref.projectId!==context.scope.projectId||ref.spaceId!==context.scope.spaceId))
    throw new KnowledgeError('SOURCE_REF_SCOPE_MISMATCH','Exact sources must belong to the authenticated scope',403);
   if(request.selectedRefs?.length&&!options.reader.readWikiExactBounded)
    throw new KnowledgeError('BOUNDED_WIKI_READ_UNSUPPORTED','Exact bounded Wiki reading is unavailable for selected versions',503);
   if(request.repairTarget&&(request.repairTarget.projectId!==context.scope.projectId||request.repairTarget.spaceId!==context.scope.spaceId))
    throw new KnowledgeError('REPAIR_TARGET_SCOPE_MISMATCH','A repair target must belong to the authenticated scope',403);
   if(request.repairTarget&&(!options.reader.readRepairTarget||!options.reader.validateRepairTarget))
    throw new KnowledgeError('REPAIR_UNSUPPORTED','Repair target reading is unavailable',503);
   if(!key.trim()||key.length>200)throw new KnowledgeError('IDEMPOTENCY_KEY_REQUIRED','Bounded compilation key required',400);
   if(new Set(request.sourceEventIds).size!==request.sourceEventIds.length)throw new KnowledgeError('DUPLICATE_SOURCE_EVENT','Source event IDs must be distinct',422);
   if(Date.parse(request.budget.deadline)-now().getTime()>300_000)throw new KnowledgeError('DEADLINE_TOO_LARGE','Compilation deadline must be within five minutes',422);
   let resolvedAnswer:ResolvedAnswerSeed|undefined;
   if(request.answerSeed){
    if(!options.answers)throw new KnowledgeError('ANSWER_READER_REQUIRED','Answer-seeded compilation requires an authenticated answer reader',503);
    const prior=await options.operations.lookup(context,key);
    resolvedAnswer=await resolveAnswerSeed(context,request.answerSeed,options.answers,
     prior&&['published','rejected'].includes(prior.state)?'historical':'current');
    if(!sameExactRefs(request.selectedRefs??[],resolvedAnswer.selectedRefs)||
      !sameExactRefs(request.sourceRefs??[],resolvedAnswer.sourceRefs))
     throw new KnowledgeError('ANSWER_READSET_MISMATCH','Compilation must include the complete exact answer readset without additions',409);
    if(resolvedAnswer.selectedRefs.length>request.limit)
     throw new KnowledgeError('ANSWER_READSET_LIMIT_EXCEEDED','All original Wiki inputs need room within the Wiki read limit',422);
   }
   const empty:WikiCompileResult={id:randomUUID(),question:request.question,purpose:request.purpose,state:'reserved',drafts:[],candidate:null,stageStatus:'not_requested',
    ...resolvedAnswer?{answerOrigin:resolvedAnswer.origin}:{},
    evidence:[],excluded:[],readUsage:{wikiPayloadBytes:0,sourceContentBytes:0,preparedInputBytes:0,maxReadBytes:request.budget.maxReadBytes},readsetFingerprint:digest([]),
    coverage:{scopeDescription:`${context.scope.projectId}/${context.scope.spaceId}`,returned:0,loaded:0,hasMore:false,nextCursor:null,completeness:'unknown',omittedReasons:['Retrieval not started'],snapshot:{publicationEpoch:null,consistency:'single_scope_snapshot'}},
    cost:zero(),provider:null,reason:'Reserved; no provider invocation',gaps:[],createdAt:now().toISOString(),completedAt:null};
   const providerIdentity={id:options.provider.id,model:options.provider.model,methodVersion:options.provider.methodVersion,execution:options.provider.execution};
   const reservation=await options.operations.reserve(context,key,digest({request,providerIdentity}),request,empty);
   if(!reservation.created)return committed(recover(context,reservation.result),reservation.result.id);
   const id=reservation.result.id;
   if(!await committed(options.operations.start(context,id),id))return committed(get(context,id),id);
   let result:WikiCompileResult={...reservation.result,state:'running'},invoked=false,acknowledged=false,epoch:number|null=null;
   const evidence:AskEvidence[]=[],bases=new Map<string,KnowledgeRevision>(),sourceProofs:SourceAccessProof[]=[],gaps:string[]=[],excluded:WikiCompileResult['excluded']=[];
   let repair:{evidenceId:string;page:RepairTargetPage}|null=null;
   let wikiBytes=0,sourceBytes=0,preparedBytes=0,loaded=0,hasMore=false;
   const remaining=()=>Math.max(0,request.budget.maxReadBytes-wikiBytes-sourceBytes);
   const check=()=>{if(Date.parse(request.budget.deadline)<=now().getTime())throw new KnowledgeError('DEADLINE_EXPIRED','Compilation deadline elapsed',422);};
   const update=()=>{result={...result,evidence:evidence.map(receipt),excluded:excluded.slice(0,100),gaps:[...new Set([...gaps,...result.gaps])].slice(0,100),readsetFingerprint:digest(evidence.map(receipt)),
    readUsage:{wikiPayloadBytes:wikiBytes,sourceContentBytes:sourceBytes,preparedInputBytes:preparedBytes,maxReadBytes:request.budget.maxReadBytes},
    coverage:{scopeDescription:`${context.scope.projectId}/${context.scope.spaceId}: ${request.selectedRefs?.length?'selected Wiki, lexical v2, bounded sources':'Wiki lexical v2, bounded original reports'}`,returned:evidence.length,loaded:loaded+evidence.filter(item=>item.kind==='source_content').length,hasMore,nextCursor:null,
     completeness:'bounded',omittedReasons:['Lexical candidates do not prove all related knowledge was found',...hasMore?['Additional candidates were not read']:[]],snapshot:{publicationEpoch:epoch,consistency:'single_scope_snapshot'}}};};
   try{
    check();
    if(request.repairTarget){
     const page=await options.reader.readRepairTarget!(context,request.repairTarget,Math.min(1_000_000,remaining()));
     wikiBytes+=page.payloadBytes;
     if(page.payloadBytes>request.budget.maxReadBytes)throw new KnowledgeError('READ_BUDGET_EXCEEDED','Repair target exceeded the input bound',422);
     check();
     const target=request.repairTarget,base=page.frozenRevision;
     if(page.ref.objectId!==target.objectId||page.ref.versionId!==target.versionId||page.ref.contentDigest!==target.contentDigest||base?.kind!=='wiki_page')
      throw new KnowledgeError('EXACT_REF_MISMATCH','Repair target differs from the exact requested version',409);
     const profile=getWikiPageProfile(base.content.profile.id,base.content.profile.version);
     if(!profile)throw new KnowledgeError('REPAIR_TARGET_PROFILE_UNSUPPORTED','Repair target profile is unavailable',422);
     const evidenceId=`repair:${page.ref.objectId}:${page.ref.versionId}`;
     evidence.push({id:evidenceId,kind:'wiki_page',role:'repair_target',ref:page.ref,title:page.title,body:page.body,locator:null,conditions:page.conditions,
      counterexamples:page.counterexamples,unknowns:page.unknowns,actualReadCoverage:[],storageDigest:page.storageDigest,
      sourceGroups:page.sourceGroups.length?page.sourceGroups.map(id=>({id,status:'known',authority:'knowledge-revision-lineage'})):[unknownGroup()],
      wiki:{profile:{id:profile.id,version:profile.version,digest:wikiPageProfileFingerprint(profile)},identity:base.content.identity}});
     bases.set(evidenceId,base);repair={evidenceId,page};
     gaps.push('修复对照页只用于修订对照和准确基线，不作为新支持证据');
    }
    const seenSources=new Map<string,string>();
    const addSource=async(ref:KnowledgeRef,evidenceId:string,title:string)=>{
     const identity=`${ref.domain}/${ref.objectId}/${ref.versionId}`,prior=seenSources.get(identity);
     if(prior!==undefined){if(prior!==ref.contentDigest)throw new KnowledgeError('EXACT_SOURCE_CONFLICT','One source version has conflicting exact digests',409);return;}
     if(evidence.length>=100)throw new KnowledgeError('COMPILE_EVIDENCE_LIMIT_EXCEEDED','Exact source inputs exceed the global evidence limit',422);
     seenSources.set(identity,ref.contentDigest!);
     const record=await options.reader.sourceRecord(context,ref);check();
     let content:Awaited<ReturnType<KnowledgeApplication['sourceContentBounded']>>;
     try{content=await options.reader.sourceContentBounded(context,ref,null,Math.min(1_000_000,remaining()));}
     catch(error){
      if(error instanceof KnowledgeError&&error.status===409){
       gaps.push('Exact source read conflicted after possible body transfer; byte usage is unknown and further content reads were stopped');
       excluded.push({ref,reason:`Exact source read conflicted (${error.code}); no text was sent to the compiler`});
      }
      throw error;
     }
     check();
     sourceBytes+=Buffer.byteLength(content.content,'utf8');
     if(sourceBytes+wikiBytes>request.budget.maxReadBytes)throw new KnowledgeError('READ_BUDGET_EXCEEDED','Source owner exceeded the remaining input bound',422);
     evidence.push({id:evidenceId,kind:'source_content',ref,title,body:content.content,locator:null,conditions:[],counterexamples:[],unknowns:record.limitations,
      actualReadCoverage:[content.actualCoverage],sourceGroups:record.sourceGroups.length?record.sourceGroups:[unknownGroup()]});
     if(ref.domain==='source'&&options.sources)sourceProofs.push(await options.sources.proof(context,ref));
    };
    for(const sourceEventId of request.sourceEventIds){check();const event=await options.intake.get(context,sourceEventId),ref=event.request.sourceRef;
     if(resolvedAnswer&&!resolvedAnswer.sourceRefs.some(original=>exactRefKey(original)===exactRefKey(ref)))
      throw new KnowledgeError('ANSWER_READSET_MISMATCH','An extra source event is outside the original answer readset',409);
     await addSource(ref,`source:${sourceEventId}`,`Registered ${ref.domain} source`);
    }
    for(const ref of request.sourceRefs??[]){check();await addSource(ref,`source:${ref.domain}:${ref.objectId}:${ref.versionId}`,`Exact ${ref.domain} source`);}
    if(evidence.length+(request.selectedRefs?.length??0)>100)
     throw new KnowledgeError('COMPILE_EVIDENCE_LIMIT_EXCEEDED','Exact inputs exceed the global evidence limit',422);
    const seenWiki=new Set<string>(),cursors=new Map<string,string|undefined>();let readWiki=0;
    const addWiki=(pageData:Awaited<ReturnType<KnowledgeApplication['readCandidate']>>,exact=false,accounted=false)=>{
     if(exact&&(!pageData.admitted||pageData.frozenRevision?.kind!=='wiki_page'))
      throw new KnowledgeError('SELECTED_WIKI_NOT_ADMITTED','Selected Wiki is not current and reviewed for this purpose',403);
     if(!accounted){
      if(pageData.payloadBytes>remaining())throw new KnowledgeError('READ_BUDGET_EXCEEDED','Wiki owner exceeded the remaining input bound',422);
      wikiBytes+=pageData.payloadBytes;
     }
     readWiki++;
     const base=pageData.frozenRevision,profile=base?.kind==='wiki_page'?getWikiPageProfile(base.content.profile.id,base.content.profile.version):null;
     const evidenceId=`wiki:${pageData.ref.objectId}:${pageData.ref.versionId}`;
     evidence.push({id:evidenceId,kind:'wiki_page',ref:pageData.ref,title:pageData.title,body:pageData.body,locator:null,conditions:pageData.conditions,counterexamples:pageData.counterexamples,
      unknowns:pageData.unknowns,actualReadCoverage:[],storageDigest:pageData.storageDigest,sourceGroups:pageData.sourceGroups.length?pageData.sourceGroups.map(id=>({id,status:'known',authority:'knowledge-revision-lineage'})):[unknownGroup()],
      ...base?.kind==='wiki_page'&&profile?{wiki:{profile:{id:profile.id,version:profile.version,digest:wikiPageProfileFingerprint(profile)},identity:base.content.identity}}:{}});
     if(base)bases.set(evidenceId,base);
    };
    for(const ref of request.selectedRefs??[]){check();const key=`${ref.objectId}/${ref.versionId}`;seenWiki.add(key);
     const available=remaining();let pageData:Awaited<ReturnType<KnowledgeApplication['readCandidate']>>;
     try{pageData=await options.reader.readWikiExactBounded!(context,ref,available);}
     catch(error){
      if(error instanceof KnowledgeError&&error.status===409){
       gaps.push('Selected exact Wiki read conflicted after possible body transfer; byte usage is unknown and further content reads were stopped');
       excluded.push({ref,reason:`Selected exact Wiki read conflicted (${error.code}); no text was sent to the compiler`});
      }
      throw error;
     }
     // A returned page has a confirmed physical size even if its ref fails exact verification.
     wikiBytes+=pageData.payloadBytes;
     if(pageData.payloadBytes>available)throw new KnowledgeError('READ_BUDGET_EXCEEDED','Wiki owner exceeded the remaining input bound',422);
     check();
     if(pageData.ref.projectId!==ref.projectId||pageData.ref.spaceId!==ref.spaceId||pageData.ref.objectId!==ref.objectId||
      pageData.ref.versionId!==ref.versionId||pageData.ref.contentDigest!==ref.contentDigest)
      throw new KnowledgeError('EXACT_REF_MISMATCH','Selected Wiki differs from the exact requested version',409);
     addWiki(pageData,true,true);
    }
    if(readWiki>=request.limit||evidence.length>=100||repair){
     // Repair reads only its exact current inputs; lexical expansion would add unrequested support.
     hasMore=!repair;
     // Exact selections may fill the limit. Capture the publication epoch without loading another body.
     const observed=await options.reader.queryCandidates(context,QueryRequestSchema.parse({question:request.queries[0],purpose:request.purpose,
      kinds:['wiki_page'],limit:1,retrievalMethod:'wiki-lexical-v2'}));
     epoch=observed.coverage.snapshot.publicationEpoch;
    }
    for(let page=0;!repair&&page<request.maxPages&&readWiki<request.limit&&evidence.length<100;page++){
     for(const query of [...new Set(request.queries)]){if(page&&!cursors.has(query))continue;check();
      const found=await options.reader.queryCandidates(context,QueryRequestSchema.parse({question:query,purpose:request.purpose,kinds:['wiki_page'],limit:request.limit,cursor:cursors.get(query),retrievalMethod:'wiki-lexical-v2'}));
      const nextEpoch=found.coverage.snapshot.publicationEpoch;
      if(epoch!==null&&epoch!==nextEpoch)throw new KnowledgeError('READSET_CHANGED','Knowledge changed during compilation retrieval',409);
      epoch=nextEpoch;loaded+=found.data.items.length;
      if(found.coverage.hasMore&&found.coverage.nextCursor)cursors.set(query,found.coverage.nextCursor);else cursors.delete(query);
      hasMore=hasMore||found.coverage.hasMore;
      for(const candidate of found.data.items){const key=`${candidate.ref.objectId}/${candidate.ref.versionId}`;if(seenWiki.has(key))continue;seenWiki.add(key);check();
       if(readWiki>=request.limit||evidence.length>=100||candidate.payloadBytes>remaining()){hasMore=true;excluded.push({ref:fromVersionRef(candidate.ref,context.scope,'knowledge',null),
        reason:readWiki>=request.limit?'Global Wiki read count reached':evidence.length>=100?'Global evidence count reached':'Wiki JSON exceeds remaining content budget'});continue;}
       let pageData;try{pageData=await options.reader.readCandidate(context,candidate,remaining());}catch(error){if(error instanceof KnowledgeError&&error.code==='CANDIDATE_NOT_ADMITTED'){excluded.push({ref:fromVersionRef(candidate.ref,context.scope,'knowledge',null),reason:'Not current/reviewed for this purpose'});continue;}throw error;}
       addWiki(pageData);
      }
     }
     if(!cursors.size||readWiki>=request.limit||evidence.length>=100)break;
    }
    check();const profiles=listWikiPageProfiles().map(profile=>({id:profile.id,version:profile.version,digest:wikiPageProfileFingerprint(profile)}));
    const relationHints:NonNullable<Parameters<WikiCompiler['compile']>[0]['relationHints']>[number][]=[];
    if(request.judgmentIds?.length){
     if(!options.judgments)throw new KnowledgeError('JUDGMENT_READER_REQUIRED','Compiler relation hints need an authenticated judgment reader',503);
     if(new Set(request.judgmentIds).size!==request.judgmentIds.length)throw new KnowledgeError('DUPLICATE_JUDGMENT','Advisory judgment IDs must be distinct',422);
     for(const judgmentId of request.judgmentIds){check();const judged=await options.judgments.get(context,judgmentId);
      if(!judged.batch||!['answered','needs_evidence','refused'].includes(judged.state)){gaps.push('An advisory judgment had no usable acknowledged answer');continue;}
      if(judged.evidence.length!==2||judged.evidence.some(item=>!evidence.some(read=>digest(read.ref)===digest(item.ref)))){
       gaps.push('Advisory judgment omitted because both endpoints are not in this exact compiler readset');continue;}
      relationHints.push({judgmentId:judged.id,inputFingerprint:judged.inputFingerprint,sourceRelation:judged.sourceRelation,answers:judged.batch.answers});
     }
    }
    // Hints guide research; only evidence IDs can become draft support citations.
    let answerSeedAdvisory:NonNullable<Parameters<WikiCompiler['compile']>[0]['answerSeed']>|undefined;
    if(resolvedAnswer){
     const originalById=new Map(resolvedAnswer.answer.evidence.map(item=>[item.id,item.ref]));
     const currentByRef=new Map(evidence.map(item=>[exactRefKey(item.ref),item.id]));
     const claims=resolvedAnswer.claims.map(claim=>({...claim,evidenceIds:claim.evidenceIds.map(id=>{
      const original=originalById.get(id),mapped=original&&currentByRef.get(exactRefKey(original));
      if(!mapped)throw new KnowledgeError('ANSWER_CLAIM_EVIDENCE_MISSING','Selected answer claim cites an input not actually read by this compilation',409);
      return mapped;
     })}));
     answerSeedAdvisory={answerId:resolvedAnswer.origin.answerId,answerFingerprint:resolvedAnswer.origin.answerFingerprint,
      question:resolvedAnswer.origin.question,claims,gaps:resolvedAnswer.answer.gaps};
    }
    const repairAdvisory=repair?{evidenceId:repair.evidenceId,invalidityReasons:[...new Set(repair.page.validity.issues.map(issue=>issue.reason))],
     reviewDueAt:repair.page.reviewDueAt,dependencies:repair.page.dependencies.filter(item=>item.domain==='knowledge'||item.domain==='source')
      .map(item=>({domain:item.domain,ref:{objectId:item.ref.objectId,versionId:item.ref.versionId},critical:item.critical,valid:item.valid}))}:undefined;
    const prepared={question:request.question,purpose:request.purpose,evidence,profiles,gaps,
     ...answerSeedAdvisory?{answerSeed:answerSeedAdvisory}:{},...relationHints.length?{relationHints}:{},...repairAdvisory?{repairTarget:repairAdvisory}:{}};
    preparedBytes=Buffer.byteLength(JSON.stringify(prepared),'utf8');
    if(preparedBytes>request.budget.maxReadBytes)
     throw new KnowledgeError('PREPARED_INPUT_BUDGET_EXCEEDED','Prepared compiler input exceeds its bound',422);
    update();await validate(context,result);await committed(options.operations.checkpoint(context,id,result),id);
    check();await validate(context,result);await options.reader.assertReadEpoch(context,epoch);check();
    if(providerIdentity.execution==='external'){
     if(request.budget.maxModelCalls<1||!request.budget.maxMoney||!options.provider.supportsMoneyLimit)throw new KnowledgeError('MODEL_BUDGET_REQUIRED','External compiler requires explicit enforceable model/money limits',422);
     if(!options.authorizeExternalDispatch)throw new KnowledgeError('MODEL_DISCLOSURE_PERMISSION_REQUIRED','External compiler disclosure is not authorized',403);
     await options.authorizeExternalDispatch(context,evidence,options.provider);check();await validate(context,result);await options.reader.assertReadEpoch(context,epoch);
    }
    result={...result,cost:pending(),provider:{id:providerIdentity.id,modelRequested:providerIdentity.model,modelReturned:null,requestId:null}};
    await committed(options.operations.checkpoint(context,id,result),id);check();await validate(context,result);await options.reader.assertReadEpoch(context,epoch);check();
    parentSignal?.throwIfAborted();invoked=true;
    const execution=await executeWithDeadline(request.budget.deadline,signal=>options.provider.compile({operationId:id,...structuredClone(prepared),budget:structuredClone(request.budget),signal}),parentSignal,()=>now().getTime());
    acknowledged=true;result={...result,cost:CostSchema.parse(execution.cost),provider:{...result.provider!,modelReturned:execution.modelReturned,requestId:execution.requestId}};
    await committed(options.operations.checkpoint(context,id,result),id);
    if(result.cost.modelCalls.state==='known'&&result.cost.modelCalls.value>request.budget.maxModelCalls)throw new KnowledgeError('MODEL_BUDGET_EXCEEDED','Compiler reported excess calls',422);
    if(request.budget.maxMoney&&result.cost.money.state==='known'&&(result.cost.money.currency!==request.budget.maxMoney.currency||result.cost.money.amount>request.budget.maxMoney.amount))throw new KnowledgeError('MONEY_BUDGET_EXCEEDED','Compiler reported excess money',422);
    if(Buffer.byteLength(JSON.stringify(execution.proposal),'utf8')>1_000_000)throw new KnowledgeError('COMPILE_OUTPUT_LIMIT','Compiler proposal exceeds one million UTF-8 bytes',422);
    let proposal=WikiCompileProposalSchema.parse(execution.proposal);const ids=new Set(evidence.map(item=>item.id));
    if(repair){
     // A repaired dependency set is itself a change; "no change" cannot close a repair.
     if(proposal.outcome==='no_change')proposal={outcome:'needs_evidence',drafts:[],reason:`${proposal.reason}; 修复任务不接受“无变化”：失效依赖仍须逐项保留、替换或移除`,
      gaps:[...proposal.gaps,'修复未完成：需要带依赖处置的修订候选']};
     if(proposal.outcome==='proposed')assertRepairProposal(proposal,repair,evidence,now());
    }else if(proposal.drafts.some(draft=>draft.repair))throw new KnowledgeError('REPAIR_DISPOSITION_UNEXPECTED','Only a repair compilation may dispose prior dependencies',422);
    for(const draft of proposal.drafts){
     if(draft.supportEvidenceIds.some(id=>evidence.find(item=>item.id===id)?.role==='repair_target'))
      throw new KnowledgeError('REPAIR_TARGET_AS_SUPPORT','A repair target is comparison-only and cannot support its own repair',422);
     if(draft.supportEvidenceIds.some(id=>!ids.has(id))||new Set(draft.supportEvidenceIds).size!==draft.supportEvidenceIds.length)throw new KnowledgeError('UNREAD_CITATION','Compile proposal cites unread or duplicate evidence',422);
     const profile=profiles.find(item=>item.id===draft.profile.id&&item.version===draft.profile.version);
     if(!profile||profile.digest!==draft.profile.digest)throw new KnowledgeError('PROFILE_MISMATCH','Compiler profile fingerprint differs',422);
     if(draft.targetEvidenceId){const base=bases.get(draft.targetEvidenceId);
      if(base?.kind!=='wiki_page'||base.content.identity.key!==draft.identityKey||base.content.profile.id!==draft.profile.id||base.content.profile.version!==draft.profile.version)
       throw new KnowledgeError('COMPILE_TARGET_INVALID','Update target must be an exact read Wiki with unchanged identity/profile',422);}
    }
    await validate(context,result);await options.reader.assertReadEpoch(context,epoch);check();
    result={...result,drafts:proposal.drafts,reason:proposal.reason,gaps:[...gaps,...proposal.gaps].slice(0,100),
     ...proposal.outcome==='proposed'?{stageIntent:{requestHash:wikiCompileStageRequestHash({operationId:id,request,proposal,evidence,methodVersion:providerIdentity.methodVersion,cost:result.cost})}}:{}};
    // Persist the acknowledged proposal before attempting stage; recovery never calls the model again automatically.
    await committed(options.operations.checkpoint(context,id,result),id);
    check();await validate(context,result);await options.reader.assertReadEpoch(context,epoch);check();
    if(result.cost.money.state==='unknown'||result.cost.modelCalls.state==='unknown'){
     result={...result,state:'outcome_unknown',stageStatus:'not_requested',reason:`${proposal.reason}; provider accounting is incomplete and requires reconciliation`};
    }else if(proposal.outcome==='proposed'){
     result={...result,state:'draft_ready',stageStatus:options.stage?'blocked_source_assurance':'not_configured'};
     if(options.stage){
      try{const candidate=await options.stage.stage(context,{operationId:id,request,proposal,evidence,bases,sourceProofs,createdAt:result.createdAt,methodVersion:providerIdentity.methodVersion,cost:result.cost});
       result={...result,state:'waiting_for_review',stageStatus:'staged',candidate};
      }catch(error){if(!(error instanceof KnowledgeError)||error.code!=='COMPILATION_SOURCE_ASSURANCE_REQUIRED')throw error;
       result={...result,reason:`${proposal.reason}; stage awaits source assurance: ${error.message}`};}
     }
    }else result={...result,state:proposal.outcome};
   }catch(error){
    if(error&&typeof error==='object'&&'commitStatus'in error&&error.commitStatus==='unknown')throw error;
    update();result={...result,state:invoked&&(!acknowledged||result.cost.modelCalls.state==='unknown'||result.cost.money.state==='unknown')?'outcome_unknown':'failed',candidate:null,stageStatus:'not_requested',
     cost:invoked?result.cost:zero(),reason:error instanceof KnowledgeError?`${error.code}: ${error.message}`:'Compilation execution failed; reconcile before retrying'};
    if(!acknowledged)result={...result,drafts:[]};
   }
   result=WikiCompileResultSchema.parse({...result,completedAt:now().toISOString()});await committed(options.operations.finish(context,id,result),id);return committed(get(context,id),id);
  },
 };
}
