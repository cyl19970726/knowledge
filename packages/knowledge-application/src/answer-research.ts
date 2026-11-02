import {AnswerResearchRequestSchema,AnswerSeedSchema,type AnswerSeed,type AnswerOrigin,
  type AskClaim,type AskResult,type KnowledgeRef,type WikiCompileRequest,type WikiCompileResult} from '@commerce/knowledge-contracts';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import type {ReadContext} from './index.ts';
import {askAnswerFingerprint,type AskAnswerReader} from './ask.ts';
import {authorizeCapability,type CapabilityContext} from './sources.ts';

export type AnswerResearchReader=Pick<AskAnswerReader,'get'>;
export interface AnswerResearchCompiler {
  lookup(context:CapabilityContext,key:string):Promise<WikiCompileResult|null>;
  compile(context:CapabilityContext,request:WikiCompileRequest,key:string):Promise<WikiCompileResult>;
}
export interface ResolvedAnswerSeed {
  answer:AskResult;
  origin:AnswerOrigin;
  selectedRefs:KnowledgeRef[];
  sourceRefs:KnowledgeRef[];
  claims:AskClaim[];
}
function boundedQuery(question:string):string{
  const text=question.slice(0,500),last=text.charCodeAt(text.length-1);
  return last>=0xd800&&last<=0xdbff?text.slice(0,-1):text;
}

/** Resolve the whole authenticated readset, including evidence outside the selected claims. */
export async function resolveAnswerSeed(context:ReadContext,raw:AnswerSeed,answers:AnswerResearchReader,
  mode:'current'|'historical'='current'):Promise<ResolvedAnswerSeed>{
  const seed=AnswerSeedSchema.parse(raw);
  const answer=await answers.get(context,seed.answerId,mode);
  if(answer.id!==seed.answerId)throw new KnowledgeError('ANSWER_ID_MISMATCH','Answer reader returned another operation',409);
  if(answer.state!=='answered')throw new KnowledgeError('ANSWER_NOT_ANSWERED','Only a cited answer can seed research',409);
  if(answer.purpose!==context.purpose)throw new KnowledgeError('PURPOSE_MISMATCH','Answer purpose differs from research',403);
  const fingerprint=askAnswerFingerprint(answer);
  if(fingerprint!==seed.expectedAnswerFingerprint||answer.answerFingerprint&&answer.answerFingerprint!==fingerprint)
    throw new KnowledgeError('ANSWER_FINGERPRINT_MISMATCH','Answer changed from the exact selected version',409);
  if(seed.claimIndexes.some(index=>index>=answer.claims.length))
    throw new KnowledgeError('ANSWER_CLAIM_INDEX_INVALID','Selected claim is outside the exact answer',422);

  const selectedRefs:KnowledgeRef[]=[],sourceRefs:KnowledgeRef[]=[],seen=new Map<string,string>();
  for(const evidence of answer.evidence){
    const ref=evidence.ref;
    if(ref.projectId!==context.scope.projectId||ref.spaceId!==context.scope.spaceId||!ref.contentDigest)
      throw new KnowledgeError('ANSWER_READSET_INVALID','Answer contains an unscoped or noncanonical input',409);
    const key=`${ref.domain}/${ref.objectId}/${ref.versionId}`;
    const prior=seen.get(key);
    if(prior&&prior!==ref.contentDigest)
      throw new KnowledgeError('ANSWER_READSET_INVALID','One source version has conflicting canonical digests',409);
    if(prior)continue;
    seen.set(key,ref.contentDigest);
    if(evidence.kind==='wiki_page'){
      if(ref.domain!=='knowledge')throw new KnowledgeError('ANSWER_READSET_INVALID','Wiki evidence domain differs',409);
      selectedRefs.push(structuredClone(ref));
    }else{
      if(ref.domain==='knowledge')throw new KnowledgeError('ANSWER_READSET_INVALID','Source evidence domain differs',409);
      sourceRefs.push(structuredClone(ref));
    }
  }
  if(selectedRefs.length+sourceRefs.length>100)
    throw new KnowledgeError('ANSWER_READSET_LIMIT_EXCEEDED','Answer input count exceeds the exact compilation bound',422);
  const origin:AnswerOrigin={answerId:answer.id,answerFingerprint:fingerprint,
    claimIndexes:[...seed.claimIndexes],question:answer.question};
  return {answer:structuredClone(answer),origin,selectedRefs,sourceRefs,
    claims:seed.claimIndexes.map(index=>structuredClone(answer.claims[index]))};
}

/** The compiler's own ledger freezes the derived request and original key. */
export function createAnswerResearchApplication(options:{answers:AnswerResearchReader;compiler:AnswerResearchCompiler}){
  return {async research(context:CapabilityContext,answerId:string,raw:unknown,key:string):Promise<WikiCompileResult>{
    authorizeCapability(context,'compile:read');authorizeCapability(context,'compile:write');
    const request=AnswerResearchRequestSchema.parse(raw);
    if(request.purpose!==context.purpose)throw new KnowledgeError('PURPOSE_MISMATCH','Research purpose differs from authenticated context',403);
    if(!key.trim()||key.length>200)throw new KnowledgeError('IDEMPOTENCY_KEY_REQUIRED','Bounded compilation key required',400);
    // Only terminal compilation replay may inspect a historical Wiki answer basis.
    const prior=await options.compiler.lookup(context,key);
    const mode=prior&&['published','rejected'].includes(prior.state)?'historical':'current';
    const seed=AnswerSeedSchema.parse({answerId,expectedAnswerFingerprint:request.expectedAnswerFingerprint,
      claimIndexes:request.claimIndexes});
    const resolved=await resolveAnswerSeed(context,seed,options.answers,mode);
    if(resolved.selectedRefs.length>request.limit)
      throw new KnowledgeError('ANSWER_READSET_LIMIT_EXCEEDED','All original Wiki pages need room in the compilation Wiki limit',422);
    const compileRequest:WikiCompileRequest={question:request.question,purpose:request.purpose,sourceEventIds:[],
      selectedRefs:resolved.selectedRefs,sourceRefs:resolved.sourceRefs,answerSeed:seed,
      queries:[boundedQuery(request.question)],limit:request.limit,maxPages:request.maxPages,budget:structuredClone(request.budget)};
    return options.compiler.compile(context,compileRequest,key);
  }};
}
