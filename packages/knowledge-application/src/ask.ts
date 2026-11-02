import {randomUUID} from 'node:crypto';
import {AskRequestSchema,AskResultSchema,AskProviderAnswerSchema,CostSchema,
  type AskRequest,type AskResult,type AskEvidenceReceipt,type AskProviderAnswer} from '@commerce/knowledge-contracts';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {digest} from '@commerce/knowledge-core/utils';
import type {KnowledgeApplication,ReadContext,BoundedWikiPage} from './index.ts';
import {fromVersionRef} from '@commerce/knowledge-contracts';
import {authorizeCapability,type CapabilityContext} from './sources.ts';
type Cost=AskResult['cost'];

export interface AskOperationPort {
  reserve(context:ReadContext,key:string,inputDigest:string,request:AskRequest,initial:AskResult):Promise<{created:boolean;result:AskResult}>;
  start(context:ReadContext,id:string):Promise<boolean>;
  checkpoint(context:ReadContext,id:string,result:AskResult):Promise<void>;
  finish(context:ReadContext,id:string,result:AskResult):Promise<void>;
  get(context:ReadContext,id:string):Promise<AskResult|null>;
  lookup(context:ReadContext,key:string):Promise<AskResult|null>;
}
export type AskEvidence = AskEvidenceReceipt & {body:string};
export type AskReader=Pick<KnowledgeApplication,'queryCandidates'|'readCandidate'|'validateFrozenWiki'|'sourceRecord'|'sourceContentBounded'|'assertReadEpoch'>&
  Partial<Pick<KnowledgeApplication,'readWikiExactBounded'>>;
/** Trusted execution adapter. Evidence is untrusted source content, never tool instructions. */
export interface QueryAnswerer {
  id:string;
  model:string;
  supportsMoneyLimit?:boolean;
  answer(input:{operationId:string;question:string;purpose:string;evidence:readonly AskEvidence[];
    budget:AskRequest['budget'];signal:AbortSignal;gaps?:readonly string[];coverage?:AskResult['coverage']}):Promise<{answer:AskProviderAnswer;cost:Cost;
      modelReturned:string|null;requestId:string|null}>;
}
const noCalls=():Cost=>({modelCalls:{state:'known',value:0},tokens:{state:'known',value:0},
  money:{state:'known',amount:0,currency:'USD',source:'no_provider_call'}});
const pendingCost=():Cost=>({modelCalls:{state:'unknown',reason:'Provider invocation is prepared but not acknowledged'},tokens:{state:'unknown',reason:'Provider execution not acknowledged'},
  money:{state:'unknown',reason:'Provider execution not acknowledged; reconcile the original operation'}});
const metadata=({body:_,...item}:AskEvidence):AskEvidenceReceipt=>item;
const unknownGroup=():NonNullable<AskEvidenceReceipt['sourceGroups']>[number]=>({id:null,status:'unknown',authority:null});

/** A temporary answer has a durable readset, but no knowledge publication capability. */
export function createAskWikiService(options:{reader:AskReader;operations:AskOperationPort;provider:QueryAnswerer;now?:()=>Date}){
  const clock=()=>options.now?.()??new Date();
  function assertContext(context:ReadContext){
    if(context.scope.projectId!==context.principal.projectId||!context.principal.spaceIds.includes(context.scope.spaceId)||
      !context.principal.purposes.includes(context.purpose))throw new KnowledgeError('SCOPE_FORBIDDEN','Ask scope or purpose is unavailable',403);
  }
  async function validateReadset(context:ReadContext,result:AskResult){
    for(const item of result.evidence){
      if(item.kind==='wiki_page'){
        if(!item.storageDigest)throw new KnowledgeError('ASK_READSET_INVALIDATED','This answer predates bounded readset verification; no automatic recomputation is allowed',409);
        await options.reader.validateFrozenWiki(context,item.ref,item.storageDigest);
      }else{
        const source=await options.reader.sourceRecord(context,item.ref);
        if(!source.readability.contentReadable)throw new KnowledgeError('ASK_READSET_INVALIDATED','An answer source is no longer readable',409);
      }
    }
  }
  async function get(context:ReadContext,id:string):Promise<AskResult>{
    assertContext(context);
    const result=await options.operations.get(context,id);
    if(!result)throw new KnowledgeError('NOT_FOUND','Answer operation is unavailable',404);
    await validateReadset(context,result);return result;
  }
  async function lookup(context:ReadContext,key:string){
    assertContext(context);
    if(!key.trim()||key.length>200)throw new KnowledgeError('IDEMPOTENCY_KEY_REQUIRED','Bounded request key required',400);
    const answer=await options.operations.lookup(context,key);
    if(answer)await validateReadset(context,answer);
    return {state:answer?'committed' as const:'unknown' as const,answer};
  }
  async function committed<T>(work:Promise<T>,id:string):Promise<T>{
    try{return await work;}catch(error){
      const failure=error instanceof Error?error:new KnowledgeError('ASK_OPERATION_UNAVAILABLE','Ask operation requires reconciliation',503);
      const prior='commitStatus' in failure?failure.commitStatus:undefined;
      // Reservation exists, but a later transaction may have lost its acknowledgement.
      // Preserve that typed uncertainty rather than claiming that transaction committed.
      throw Object.assign(failure,{commitStatus:['unknown','committed','not_committed'].includes(String(prior))?prior:'committed',operationId:id});
    }
  }
  async function ask(context:CapabilityContext,raw:AskRequest,key:string):Promise<AskResult>{
    authorizeCapability(context,'ask:write');
    const request=AskRequestSchema.parse(raw);
    if(request.purpose!==context.purpose)throw new KnowledgeError('PURPOSE_MISMATCH','Ask purpose differs from authenticated context',403);
    if(request.selectedRefs?.some(ref=>ref.projectId!==context.scope.projectId||ref.spaceId!==context.scope.spaceId))
      throw new KnowledgeError('SELECTED_REF_SCOPE_MISMATCH','Selected Wiki versions must belong to the authenticated scope',403);
    if(request.selectedRefs?.length&&!options.reader.readWikiExactBounded)
      throw new KnowledgeError('BOUNDED_WIKI_READ_UNSUPPORTED','Exact bounded Wiki reading is unavailable for selected versions',503);
    if(!key.trim()||key.length>200)throw new KnowledgeError('IDEMPOTENCY_KEY_REQUIRED','Bounded request key required',400);
    if(Date.parse(request.budget.deadline)-clock().getTime()>300_000)throw new KnowledgeError('DEADLINE_TOO_LARGE','Ask deadline must be within five minutes',422);
    const now=clock().toISOString();
    const initial:AskResult={id:randomUUID(),question:request.question,purpose:request.purpose,state:'reserved',claims:[],evidence:[],excluded:[],
      coverage:{scopeDescription:`${context.scope.projectId}/${context.scope.spaceId}`,returned:0,loaded:0,hasMore:false,nextCursor:null,
        completeness:'unknown',omittedReasons:['Retrieval has not started'],snapshot:{publicationEpoch:null,consistency:'single_scope_snapshot'}},
      readsetFingerprint:digest([]),cost:noCalls(),readUsage:{wikiPayloadBytes:0,sourceContentBytes:0,preparedInputBytes:0,maxReadBytes:request.budget.maxReadBytes},provider:null,reason:'Reserved; no model invocation yet',gaps:[],createdAt:now,completedAt:null};
    const reserved=await options.operations.reserve(context,key,digest({scope:context.scope,principalId:context.principal.id,request}),request,initial);
    if(!reserved.created){await committed(validateReadset(context,reserved.result),reserved.result.id);return reserved.result;}
    if(!await committed(options.operations.start(context,reserved.result.id),reserved.result.id))return committed(get(context,reserved.result.id),reserved.result.id);
    let result:AskResult={...reserved.result,state:'running'},invoked=false,acknowledged=false;
    const evidence:AskEvidence[]=[],excluded:AskResult['excluded']=[],gaps:string[]=[];
    let bytes=0,wikiPayloadBytes=0,sourceContentBytes=0,unaccountedReadBytes=0;
    const pages=new Map<string,BoundedWikiPage>();
    const seenVersions=new Set<string>();
    const versionKey=(ref:{objectId:string;versionId:string})=>`${ref.objectId}/${ref.versionId}`;
    const remaining=()=>Math.max(0,request.budget.maxReadBytes-wikiPayloadBytes-sourceContentBytes-unaccountedReadBytes);
    const usage=()=>({wikiPayloadBytes,sourceContentBytes,preparedInputBytes:Buffer.byteLength(JSON.stringify({question:request.question,purpose:request.purpose,evidence}),'utf8'),maxReadBytes:request.budget.maxReadBytes});
    const add=(item:AskEvidence)=>{
      const size=Buffer.byteLength(JSON.stringify(item),'utf8');
      if(evidence.length>=100||bytes+size>request.budget.maxReadBytes){excluded.push({ref:item.ref,reason:'Evidence input budget exceeded'});return false;}
      evidence.push(item);bytes+=size;return true;
    };
    const checkDeadline=()=>{if(Date.parse(request.budget.deadline)<=clock().getTime())throw new KnowledgeError('DEADLINE_EXPIRED','Ask deadline elapsed',422);};
    try{
      checkDeadline();let cursor:string|undefined,loaded=0,epoch:number|null=null,hasMore=false;
      for(let page=0;page<request.maxPages;page++){
        checkDeadline();
        const found=await options.reader.queryCandidates(context,{question:request.question,purpose:request.purpose,limit:request.limit,retrievalMethod:'wiki-lexical-v2',...cursor?{cursor}:{}});
        const nextEpoch=found.coverage.snapshot.publicationEpoch;
        if(page&&epoch!==nextEpoch)throw new KnowledgeError('READSET_CHANGED','Knowledge changed during Ask retrieval',409);
        epoch=nextEpoch;loaded+=found.data.items.length;
        if(page===0&&request.selectedRefs?.length){
          for(const ref of request.selectedRefs){
            checkDeadline();seenVersions.add(versionKey(ref));
            if(remaining()===0){excluded.push({ref,reason:'Selected Wiki exceeds the remaining content read budget; body was not fetched'});continue;}
            let doc:BoundedWikiPage;
            const available=remaining();
            try{doc=await options.reader.readWikiExactBounded!(context,ref,available);}catch(error){
              if(error instanceof KnowledgeError&&[403,404,409,422].includes(error.status)){
                // An exact digest can fail after a bounded body read. Reserve its full byte allowance
                // so an unreported read cannot make later content reads exceed the caller's budget.
                if(error.status===409){unaccountedReadBytes+=available;
                  gaps.push('An excluded exact Wiki read has unknown byte usage; further content reads were stopped');}
                excluded.push({ref,reason:error.status===403?'Selected Wiki is unavailable for this purpose; no text was sent to the answerer':
                  `Selected exact Wiki was excluded (${error.code}); no text was sent to the answerer`});continue;
              }
              throw error;
            }
            wikiPayloadBytes+=doc.payloadBytes;
            if(doc.ref.projectId!==ref.projectId||doc.ref.spaceId!==ref.spaceId||
              versionKey(doc.ref)!==versionKey(ref)||doc.ref.contentDigest!==ref.contentDigest||!doc.admitted){
              excluded.push({ref,reason:'Selected exact Wiki version is not current, admitted or digest-matched'});continue;
            }
            const item:AskEvidence={id:`w${evidence.length+1}`,kind:'wiki_page',ref:doc.ref,title:doc.title,body:doc.body,
              locator:null,storageDigest:doc.storageDigest,conditions:doc.conditions,counterexamples:doc.counterexamples,
              unknowns:doc.unknowns,actualReadCoverage:[],sourceGroups:doc.sourceGroups?.length?
                doc.sourceGroups.map(group=>({id:group,status:'known',authority:'knowledge-revision-lineage'})):[unknownGroup()]};
            if(Buffer.byteLength(JSON.stringify({question:request.question,purpose:request.purpose,evidence:[...evidence,item]}),'utf8')>
              request.budget.maxReadBytes){excluded.push({ref,reason:'Selected Wiki exceeds the prepared answer input budget'});continue;}
            if(add(item))pages.set(item.id,doc);
          }
        }
        for(const candidate of found.data.items){
          checkDeadline();
          const key=versionKey(candidate.ref);
          if(seenVersions.has(key))continue;
          seenVersions.add(key);
          if(remaining()===0){
            excluded.push({ref:fromVersionRef(candidate.ref,context.scope,'knowledge',null),reason:'Wiki payload exceeds the remaining content read budget; body was not fetched'});continue;
          }
          if(candidate.payloadBytes>remaining()){
            excluded.push({ref:fromVersionRef(candidate.ref,context.scope,'knowledge',null),reason:'Wiki payload exceeds the remaining content read budget; body was not fetched'});continue;
          }
          let doc:BoundedWikiPage;
          try{doc=await options.reader.readCandidate(context,candidate,remaining());}catch(error){
            if(error instanceof KnowledgeError&&error.code==='CANDIDATE_NOT_ADMITTED'){
              excluded.push({ref:fromVersionRef(candidate.ref,context.scope,'knowledge',null),reason:'Candidate not admitted; body was not fetched'});continue;
            }
            throw error;
          }
          wikiPayloadBytes+=doc.payloadBytes;
          if(!doc.admitted){excluded.push({ref:doc.ref,reason:'Not current and admitted for this purpose'});continue;}
          const id=`w${evidence.length+1}`;
          if(add({id,kind:'wiki_page',ref:doc.ref,title:doc.title,body:doc.body,locator:null,storageDigest:doc.storageDigest,
            conditions:doc.conditions,counterexamples:doc.counterexamples,unknowns:doc.unknowns,actualReadCoverage:[],
            sourceGroups:doc.sourceGroups?.length?doc.sourceGroups.map(group=>({id:group,status:'known',authority:'knowledge-revision-lineage'})):[unknownGroup()]}))pages.set(id,doc);
        }
        hasMore=found.coverage.hasMore;cursor=found.coverage.nextCursor??undefined;
        if(!hasMore||!cursor||remaining()===0)break;
      }
      // Source metadata is not a primary-content read. Only explicit, successful content reads enter the model input.
      if(request.includeSourceContent){let sourceReads=0;
        for(const page of [...evidence]){
          const doc=pages.get(page.id);if(!doc)continue;
          for(const citation of doc.citations??[]){
            checkDeadline();
            if(evidence.length>=100||remaining()===0||sourceReads>=20){gaps.push('Source reads were bounded by the evidence or source-count budget');break;}
            if(evidence.some(item=>item.kind==='source_content'&&item.ref.domain===citation.ref.domain&&item.ref.objectId===citation.ref.objectId&&item.ref.versionId===citation.ref.versionId))continue;
            try{
              // Resolve the exact owner digest and current readability before asking for bounded content.
              const record=await options.reader.sourceRecord(context,citation.ref);
              if(!record.readability.contentReadable){gaps.push(`Primary source metadata does not permit content: ${citation.ref.objectId}`);continue;}
              if(!record.ref.contentDigest){gaps.push(`Primary source has no exact content digest: ${citation.ref.objectId}`);continue;}
              sourceReads++;
              // This text adapter reads full permitted source content; it does not claim a citation locator was resolved.
              const source=await options.reader.sourceContentBounded(context,record.ref,null,Math.min(1_000_000,remaining()));
              sourceContentBytes+=source.actualCoverage.byteCount;
              if(!source.readability.contentReadable||!source.content){gaps.push(`Primary source unavailable: ${citation.ref.objectId}`);continue;}
              if(source.media){gaps.push(`Image source was not sent to this text-only answerer: ${citation.ref.objectId}`);continue;}
              // Owner groups describe lineage, not independent votes. Dispatch revalidates current rights below.
              add({id:`s${evidence.length+1}`,kind:'source_content',ref:source.ref,title:`Source for ${page.title}`,body:source.content,
                locator:source.anchor?`${source.anchor.kind}:${source.anchor.value}`:null,conditions:[],counterexamples:[],unknowns:source.actualCoverage.exclusions,
                actualReadCoverage:[source.actualCoverage],sourceGroups:record.sourceGroups.length?record.sourceGroups:[unknownGroup()]});
            }catch(error){
              if(error instanceof KnowledgeError&&[403,404,422,503].includes(error.status))gaps.push(`Primary source not read (${error.code}): ${citation.ref.objectId}`);
              else throw error;
            }
          }
        }
      }else gaps.push('Primary source content was not requested; the answer uses compiled Wiki pages only');
      result={...result,evidence:evidence.map(metadata),excluded:excluded.slice(0,100),readsetFingerprint:digest(evidence),readUsage:usage(),
        coverage:{scopeDescription:`${context.scope.projectId}/${context.scope.spaceId}: bounded Wiki lexical v2 retrieval; identity and aliases are candidate signals only`,returned:evidence.length,
          loaded,hasMore,nextCursor:null,completeness:'bounded',omittedReasons:[
            'Lexical candidate coverage does not establish that all relevant knowledge was found',
            ...hasMore?['Additional lexical pages were not read']:[],...excluded.length?['Some candidates were excluded by eligibility or input budget']:[]],
          snapshot:{publicationEpoch:epoch,consistency:'single_scope_snapshot'}},gaps:gaps.slice(0,100)};
      await validateReadset(context,result);
      if(!evidence.some(item=>item.kind==='wiki_page')){
        result={...result,state:'needs_evidence',reason:'No eligible Wiki evidence fits the retrieval and input budget'};
      }else{
        checkDeadline();
        if(request.budget.maxModelCalls<1)throw new KnowledgeError('MODEL_BUDGET_EXCEEDED','Ask requires one admitted model call',422);
        if(usage().preparedInputBytes>request.budget.maxReadBytes)
          throw new KnowledgeError('READ_BUDGET_EXCEEDED','Serialized answer evidence exceeds the declared input byte budget',422);
        if(request.budget.maxMoney&&!options.provider.supportsMoneyLimit)throw new KnowledgeError('MONEY_LIMIT_UNSUPPORTED','Provider cannot enforce the requested money limit',422);
        result={...result,cost:pendingCost(),provider:{id:options.provider.id,modelRequested:options.provider.model,modelReturned:null,requestId:null}};
        await options.operations.checkpoint(context,result.id,AskResultSchema.parse(result));
        // Checkpoint persistence is an await boundary: rights may have changed while it ran.
        await validateReadset(context,result);
        await options.reader.assertReadEpoch(context,result.coverage.snapshot.publicationEpoch);
        checkDeadline();
        const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
        const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new KnowledgeError('PROVIDER_OUTCOME_UNKNOWN','Provider deadline exceeded; reconcile this operation',504));},Math.max(1,Date.parse(request.budget.deadline)-clock().getTime()));});
        invoked=true;
        let execution:Awaited<ReturnType<QueryAnswerer['answer']>>;
        try{execution=await Promise.race([options.provider.answer({operationId:result.id,question:request.question,purpose:request.purpose,
          evidence,budget:request.budget,signal:controller.signal,gaps:[...result.gaps],coverage:result.coverage}),timeout]);}finally{if(timer)clearTimeout(timer);}
        acknowledged=true;
        result={...result,cost:CostSchema.parse(execution.cost),provider:{...result.provider!,modelReturned:execution.modelReturned,requestId:execution.requestId}};
        const answer=AskProviderAnswerSchema.parse(execution.answer),ids=new Set(evidence.map(item=>item.id));
        if(answer.claims.some(claim=>claim.evidenceIds.some(id=>!ids.has(id))))throw new KnowledgeError('UNREAD_CITATION','Provider cited evidence outside the exact readset',422);
        if(result.cost.modelCalls.state==='known'&&result.cost.modelCalls.value>request.budget.maxModelCalls)
          throw new KnowledgeError('MODEL_BUDGET_EXCEEDED','Provider reported excess model calls',422);
        if(request.budget.maxMoney&&result.cost.money.state==='known'&&(result.cost.money.currency!==request.budget.maxMoney.currency||result.cost.money.amount>request.budget.maxMoney.amount))
          throw new KnowledgeError('MONEY_BUDGET_EXCEEDED','Provider reported usage exceeding the admitted money budget',422);
        await validateReadset(context,result);
        result={...result,state:answer.outcome,claims:answer.claims,reason:answer.reason,gaps:[...result.gaps,...answer.gaps].slice(0,100)};
      }
    }catch(error){
      const known=error instanceof KnowledgeError;
      result={...result,state:invoked&&!acknowledged?'outcome_unknown':'failed',claims:[],cost:invoked?result.cost:noCalls(),
        evidence:evidence.map(metadata),excluded:excluded.slice(0,100),readsetFingerprint:digest(evidence),readUsage:usage(),gaps:[...result.gaps,...gaps].slice(0,100),
        reason:known?`${error.code}: ${error.message}`:'Ask execution failed; provider acknowledgement or output requires reconciliation'};
    }
    result=AskResultSchema.parse({...result,completedAt:clock().toISOString()});
    await committed(options.operations.finish(context,result.id,result),result.id);
    // Replay and fresh answers both recheck current rights; durable audit is not permission to disclose stale evidence.
    await committed(validateReadset(context,result),result.id);return result;
  }
  return {ask,get,lookup};
}
