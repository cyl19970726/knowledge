import {executeWithDeadline} from './provider-execution.ts';
import {randomUUID} from 'node:crypto';
import {RelationJudgmentRequestSchema,RelationJudgmentSchema,DecisionBatchResultSchema,CostSchema,type RelationJudgment,type RelationJudgmentRequest,type DecisionQuestion,type DecisionBatchResult} from '@commerce/knowledge-contracts';
import type {AskEvidence} from './ask.ts';
import type {ReadContext,KnowledgeApplication} from './index.ts';
import {authorizeCapability,type CapabilityContext} from './sources.ts';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {digest} from '@commerce/knowledge-core/utils';
export interface DecisionProvider {id:string;version:string;model:string;execution:'local_deterministic'|'external';supportsMoneyLimit?:boolean;
 decide(input:{operationId:string;state:{left:AskEvidence;right:AskEvidence};questions:readonly DecisionQuestion[];rubricVersion:string;budget:RelationJudgmentRequest['budget'];signal:AbortSignal}):Promise<{result:DecisionBatchResult;cost:RelationJudgment['cost']}>}
export interface JudgmentOperationPort {
 reserve(context:ReadContext,key:string,inputDigest:string,request:RelationJudgmentRequest,initial:RelationJudgment):Promise<{created:boolean;result:RelationJudgment}>;
 start(context:ReadContext,id:string):Promise<boolean>;
 checkpoint(context:ReadContext,id:string,result:RelationJudgment):Promise<void>;
 finish(context:ReadContext,id:string,result:RelationJudgment):Promise<void>;
 get(context:ReadContext,id:string):Promise<RelationJudgment|null>;
 lookup(context:ReadContext,key:string):Promise<RelationJudgment|null>;
}
const zero=():RelationJudgment['cost']=>({modelCalls:{state:'known',value:0},tokens:{state:'known',value:0},money:{state:'known',amount:0,currency:'USD',source:'no_provider_call'}});
const pending=():RelationJudgment['cost']=>({modelCalls:{state:'unknown',reason:'Decision dispatch prepared'},tokens:{state:'unknown',reason:'Decision acknowledgement unavailable'},money:{state:'unknown',reason:'Reconcile original judgment before retrying'}});
const meta=({body:_,...item}:AskEvidence)=>item;
function validateAnswers(request:RelationJudgmentRequest,batch:DecisionBatchResult){
 const answers=new Map(batch.answers.map(answer=>[answer.id,answer]));
 if(answers.size!==batch.answers.length||answers.size!==request.questions.length||request.questions.some(q=>!answers.has(q.id)))throw new KnowledgeError('JUDGMENT_ANSWER_SET_INVALID','Decision answers must cover each distinct requested question exactly once',422);
 for(const q of request.questions){const answer=answers.get(q.id)!;
  if(answer.type!==q.type)throw new KnowledgeError('JUDGMENT_ANSWER_TYPE_INVALID','Decision type differs from requested question',422);
  if(q.type!=='predicate'&&answer.probability!==null)throw new KnowledgeError('JUDGMENT_PROBABILITY_INVALID','Only predicates carry a probability; choices and scores use distributions',422);
  if(answer.state!=='answered'&&answer.state!=='insufficient_evidence'){
   if(answer.value!==null||answer.probability!==null||answer.distribution!==null||answer.confidence!==null)
    throw new KnowledgeError('JUDGMENT_ANSWER_SHAPE_INVALID','Non-answers cannot contain a value, probability, distribution or confidence',422);
   continue;
  }
  if(answer.state==='insufficient_evidence'){
   if(answer.value===null){
    if(answer.probability!==null||answer.distribution!==null||answer.confidence!==null)
     throw new KnowledgeError('JUDGMENT_ANSWER_SHAPE_INVALID','Unvalued insufficient evidence must have null decision fields',422);
    continue;
   }
   if(q.type!=='choice'||answer.value!=='insufficient_evidence'||!q.options.some(option=>option.value===answer.value))
    throw new KnowledgeError('JUDGMENT_ANSWER_SHAPE_INVALID','Valued insufficient evidence requires the exact explicit choice option',422);
  }
  if(q.type==='predicate'&&(answer.value!==null||answer.probability===null||answer.distribution!==null))throw new KnowledgeError('JUDGMENT_PREDICATE_INVALID','Predicate is a probability, not a binary claim',422);
  if(q.type==='choice'&&(typeof answer.value!=='string'||!q.options.some(option=>option.value===answer.value)))throw new KnowledgeError('JUDGMENT_CHOICE_INVALID','Choice value is outside its exact options',422);
  if(q.type==='score'&&(typeof answer.value!=='number'||answer.value<Math.min(...q.levels.map(x=>x.value))||answer.value>Math.max(...q.levels.map(x=>x.value))))throw new KnowledgeError('JUDGMENT_SCORE_INVALID','Score is outside requested levels',422);
  if(answer.distribution){const entries=Object.entries(answer.distribution),keys=q.type==='choice'?q.options.map(x=>x.value):q.type==='score'?q.levels.map(x=>String(x.value)):[];
   if(entries.length!==keys.length||entries.some(([key])=>!keys.includes(key))||Math.abs(entries.reduce((n,[,p])=>n+p,0)-1)>0.00001)throw new KnowledgeError('JUDGMENT_DISTRIBUTION_INVALID','Distribution must cover exact options and sum to one',422);}
 }
}
/** A judgment ledger proposes a relationship; it never writes the formal knowledge graph. */
export function createRelationJudgmentApplication(options:{reader:Pick<KnowledgeApplication,'readWikiExactBounded'|'validateFrozenWiki'|'sourceRecord'|'sourceContentBounded'>;operations:JudgmentOperationPort;provider:DecisionProvider;now?:()=>Date;
 authorizeExternalDispatch?:(context:ReadContext,evidence:readonly AskEvidence[],provider:DecisionProvider)=>Promise<void>}){
 const now=()=>options.now?.()??new Date();
 function auth(context:CapabilityContext,action:string){authorizeCapability(context,action);if(!context.principal.clientInstallationId?.trim())throw new KnowledgeError('INSTALLATION_REQUIRED','Judgment requires authenticated installation',403);}
 async function validate(context:ReadContext,result:RelationJudgment){for(const item of result.evidence){
  if(item.kind==='wiki_page'){if(!item.storageDigest)throw new KnowledgeError('JUDGMENT_READSET_INVALID','Missing Wiki storage fingerprint',409);await options.reader.validateFrozenWiki(context,item.ref,item.storageDigest);}
  else{const source=await options.reader.sourceRecord(context,item.ref);if(!source.readability.contentReadable||!source.readability.metadataVisible)throw new KnowledgeError('SOURCE_FORBIDDEN','Judgment source is no longer readable',403);}
 }}
 async function get(context:CapabilityContext,id:string){auth(context,'judgments:read');const value=await options.operations.get(context,id);if(!value)throw new KnowledgeError('NOT_FOUND','Judgment is unavailable',404);await validate(context,value);return value;}
 return {get,async lookup(context:CapabilityContext,key:string){auth(context,'judgments:read');const value=await options.operations.lookup(context,key);if(value)await validate(context,value);return value;},
  async judge(context:CapabilityContext,input:unknown,key:string,parentSignal?:AbortSignal):Promise<RelationJudgment>{
   auth(context,'judgments:write');auth(context,'judgments:read');const request=RelationJudgmentRequestSchema.parse(input);
   if(request.purpose!==context.purpose||[request.left,request.right].some(ref=>ref.projectId!==context.scope.projectId||ref.spaceId!==context.scope.spaceId))throw new KnowledgeError('REF_SCOPE_MISMATCH','Judgment endpoints/purpose must match authenticated scope',403);
   if([request.left,request.right].some(ref=>!ref.contentDigest)||new Set(request.questions.map(q=>q.id)).size!==request.questions.length)throw new KnowledgeError('JUDGMENT_INPUT_INVALID','Exact digests and distinct question IDs required',422);
   if(!key.trim()||key.length>200)throw new KnowledgeError('IDEMPOTENCY_KEY_REQUIRED','Bounded judgment key required',422);
   if(Date.parse(request.budget.deadline)-now().getTime()>300_000)throw new KnowledgeError('DEADLINE_TOO_LARGE','Judgment deadline must be within five minutes',422);
   const provider={id:options.provider.id,version:options.provider.version,modelRequested:options.provider.model,modelReturned:null};
   const initial:RelationJudgment={id:randomUUID(),request,state:'reserved',evidence:[],readUsage:{wikiPayloadBytes:0,sourceContentBytes:0,preparedInputBytes:0,maxReadBytes:request.budget.maxReadBytes},inputFingerprint:digest([]),batch:null,cost:zero(),provider:null,sourceRelation:'unknown',resolution:'unknown',reason:'Reserved; no provider invoked',createdAt:now().toISOString(),completedAt:null};
   const reserved=await options.operations.reserve(context,key,digest({request,provider}),request,initial);
   if(!reserved.created)return get(context,reserved.result.id);
   const id=reserved.result.id;if(!await options.operations.start(context,id))return get(context,id);
   let result:RelationJudgment={...reserved.result,state:'running'},invoked=false,acknowledged=false;const evidence:AskEvidence[]=[];
   let wikiBytes=0,sourceBytes=0,inputBytes=0;
   const check=()=>{if(Date.parse(request.budget.deadline)<=now().getTime())throw new KnowledgeError('DEADLINE_EXPIRED','Judgment deadline elapsed',422);};
   const update=()=>{result={...result,evidence:evidence.map(meta),readUsage:{wikiPayloadBytes:wikiBytes,sourceContentBytes:sourceBytes,preparedInputBytes:inputBytes,maxReadBytes:request.budget.maxReadBytes},inputFingerprint:digest({evidence:evidence.map(meta),questions:request.questions,rubricVersion:request.rubricVersion,provider})};};
   try{
    for(const [index,ref] of [request.left,request.right].entries()){check();const remaining=Math.max(0,request.budget.maxReadBytes-wikiBytes-sourceBytes);
     if(ref.domain==='knowledge'){const page=await options.reader.readWikiExactBounded(context,ref,remaining);wikiBytes+=page.payloadBytes;
      evidence.push({id:index?'right':'left',kind:'wiki_page',ref,title:page.title,body:page.body,locator:null,conditions:page.conditions,counterexamples:page.counterexamples,unknowns:page.unknowns,storageDigest:page.storageDigest,actualReadCoverage:[],sourceGroups:page.sourceGroups.length?page.sourceGroups.map(id=>({id,status:'known',authority:'knowledge-revision-lineage'})):[{id:null,status:'unknown',authority:null}]});
     }else{const record=await options.reader.sourceRecord(context,ref),content=await options.reader.sourceContentBounded(context,ref,null,Math.min(remaining,1_000_000));sourceBytes+=Buffer.byteLength(content.content,'utf8');
      evidence.push({id:index?'right':'left',kind:'source_content',ref,title:`Exact ${ref.domain} source`,body:content.content,locator:null,conditions:[],counterexamples:[],unknowns:record.limitations,actualReadCoverage:[content.actualCoverage],sourceGroups:record.sourceGroups.length?record.sourceGroups:[{id:null,status:'unknown',authority:null}]});}
     if(wikiBytes+sourceBytes>request.budget.maxReadBytes)throw new KnowledgeError('READ_BUDGET_EXCEEDED','Pair input exceeds content budget',422);
    }
    const groups=evidence.map(item=>(item.sourceGroups??[]).filter(x=>x.status==='known'&&x.id).map(x=>x.id!));
    result={...result,sourceRelation:groups[0].some(id=>groups[1].includes(id))?'same_original':groups.every(x=>x.length)?'declared_distinct_groups':'unknown'};
    const state={left:evidence[0],right:evidence[1]};inputBytes=Buffer.byteLength(JSON.stringify({state,questions:request.questions}),'utf8');
    if(inputBytes>request.budget.maxReadBytes)throw new KnowledgeError('PREPARED_INPUT_BUDGET_EXCEEDED','Prepared decision state exceeds its input bound',422);
    update();await validate(context,result);await options.operations.checkpoint(context,id,result);check();await validate(context,result);
    if(options.provider.execution==='external'){
     if(request.budget.maxModelCalls<1||!request.budget.maxMoney||!options.provider.supportsMoneyLimit)throw new KnowledgeError('MODEL_BUDGET_REQUIRED','External judgment requires enforceable model/money limits',422);
     if(!options.authorizeExternalDispatch)throw new KnowledgeError('MODEL_DISCLOSURE_PERMISSION_REQUIRED','External judgment disclosure is not authorized',403);
     await options.authorizeExternalDispatch(context,evidence,options.provider);check();await validate(context,result);
    }
    result={...result,cost:pending(),provider};await options.operations.checkpoint(context,id,result);check();await validate(context,result);check();
    parentSignal?.throwIfAborted();invoked=true;
    const execution=await executeWithDeadline(request.budget.deadline,signal=>options.provider.decide({operationId:id,state:structuredClone(state),questions:structuredClone(request.questions),rubricVersion:request.rubricVersion,budget:structuredClone(request.budget),signal}),parentSignal,()=>now().getTime());
    acknowledged=true;result={...result,cost:CostSchema.parse(execution.cost)};
    await options.operations.checkpoint(context,id,RelationJudgmentSchema.parse(result));
    if(Buffer.byteLength(JSON.stringify(execution.result),'utf8')>1_000_000)throw new KnowledgeError('JUDGMENT_OUTPUT_LIMIT','Decision response exceeds byte bound',422);
    const batch=DecisionBatchResultSchema.parse(execution.result);
    result={...result,batch,provider:{...provider,modelReturned:batch.modelReturned}};
    await options.operations.checkpoint(context,id,RelationJudgmentSchema.parse(result));
    validateAnswers(request,batch);
    if(result.cost.modelCalls.state==='known'&&result.cost.modelCalls.value>request.budget.maxModelCalls)throw new KnowledgeError('MODEL_BUDGET_EXCEEDED','Decision provider reported excess calls',422);
    if(request.budget.maxMoney&&result.cost.money.state==='known'&&(result.cost.money.currency!==request.budget.maxMoney.currency||result.cost.money.amount>request.budget.maxMoney.amount))throw new KnowledgeError('MONEY_BUDGET_EXCEEDED','Decision provider reported excess money',422);
    await validate(context,result);check();
    const insufficient=batch.answers.some(answer=>answer.state!=='answered'),refused=batch.answers.every(answer=>answer.state==='refused');
    result={...result,state:result.cost.money.state==='unknown'||result.cost.modelCalls.state==='unknown'?'outcome_unknown':refused?'refused':insufficient?'needs_evidence':'answered',
     resolution:refused?'unknown':insufficient?'needs_evidence':'review',reason:'Typed semantic judgments are proposals; no formal relation or independent evidence vote was published'};
   }catch(error){if(error&&typeof error==='object'&&'commitStatus'in error&&error.commitStatus==='unknown')throw error;
    update();result={...result,state:invoked&&(!acknowledged||result.cost.money.state==='unknown'||result.cost.modelCalls.state==='unknown')?'outcome_unknown':'failed',cost:invoked?result.cost:zero(),resolution:'unknown',reason:error instanceof KnowledgeError?`${error.code}: ${error.message}`:'Judgment execution failed; reconcile original key'};}
   result=RelationJudgmentSchema.parse({...result,completedAt:now().toISOString()});await options.operations.finish(context,id,result);return get(context,id);
  },
 };
}
