import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {ModelCallRequestSchema,ModelCallResultSchema,type ModelCallRequest,type ModelCallResult} from '@commerce/knowledge-contracts';
import {authorizeCapability,type CapabilityContext} from '@commerce/knowledge-application';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {digest} from '@commerce/knowledge-core/utils';
import {knowledgeCost,UNBILLED_MODEL_ERRORS,type ClaudeModelPort} from './model-port.ts';
import {CLAUDE_PROVIDER_ID} from './providers.ts';

/** One row per idempotency key: a replay returns the stored result and is never billed twice. */
export interface ModelCallStore {
  claim(owner:string,key:string,requestDigest:string,id:string):Promise<{state:'new'}|{state:'done';result:ModelCallResult}|{state:'pending'}|{state:'conflict'}>;
  complete(owner:string,key:string,result:ModelCallResult):Promise<void>;
  abandon(owner:string,key:string):Promise<void>;
}
export function createMemoryModelCallStore():ModelCallStore{
  const rows=new Map<string,{digest:string;result:ModelCallResult|null}>();
  return {
    async claim(owner,key,requestDigest){const id=`${owner}\u0000${key}`,row=rows.get(id);
      if(!row){rows.set(id,{digest:requestDigest,result:null});return {state:'new'};}
      if(row.digest!==requestDigest)return {state:'conflict'};
      return row.result?{state:'done',result:row.result}:{state:'pending'};},
    async complete(owner,key,result){rows.set(`${owner}\u0000${key}`,{digest:result.requestDigest,result});},
    async abandon(owner,key){rows.delete(`${owner}\u0000${key}`);},
  };
}
export async function migrateModelCalls(pool:Pool):Promise<void>{
  await pool.query(`CREATE TABLE IF NOT EXISTS ccl_knowledge_model_calls (
    owner text NOT NULL,request_key text NOT NULL,request_digest text NOT NULL,id uuid NOT NULL UNIQUE,result jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,PRIMARY KEY(owner,request_key))`);
}
export function createPgModelCallStore(pool:Pool):ModelCallStore{
  return {
    async claim(owner,key,requestDigest,id){
      const inserted=await pool.query(`INSERT INTO ccl_knowledge_model_calls(owner,request_key,request_digest,id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[owner,key,requestDigest,id]);
      if(inserted.rowCount===1)return {state:'new'};
      const row=(await pool.query('SELECT request_digest,result FROM ccl_knowledge_model_calls WHERE owner=$1 AND request_key=$2',[owner,key])).rows[0];
      if(!row)return {state:'pending'};
      if(row.request_digest!==requestDigest)return {state:'conflict'};
      return row.result?{state:'done',result:ModelCallResultSchema.parse(row.result)}:{state:'pending'};
    },
    async complete(owner,key,result){
      await pool.query('UPDATE ccl_knowledge_model_calls SET result=$3,completed_at=now() WHERE owner=$1 AND request_key=$2 AND result IS NULL',[owner,key,JSON.stringify(result)]);
    },
    async abandon(owner,key){await pool.query('DELETE FROM ccl_knowledge_model_calls WHERE owner=$1 AND request_key=$2 AND result IS NULL',[owner,key]);},
  };
}

export function createModelCallService(options:{port:ClaudeModelPort;store:ModelCallStore;now?:()=>Date}){
  const now=()=>options.now?.()??new Date();
  return {
    async call(context:CapabilityContext,raw:ModelCallRequest,key:string,signal?:AbortSignal):Promise<ModelCallResult>{
      authorizeCapability(context,'model:call');
      if(!context.principal.clientInstallationId?.trim())throw new KnowledgeError('INSTALLATION_REQUIRED','Model calls require an authenticated installation',403);
      if(!/^[A-Za-z0-9._:-]{8,200}$/.test(key))throw new KnowledgeError('IDEMPOTENCY_KEY_REQUIRED','A stable Idempotency-Key is required',400);
      const request=ModelCallRequestSchema.parse(raw);
      if(request.purpose!==context.purpose)throw new KnowledgeError('PURPOSE_MISMATCH','Model call purpose differs from authenticated context',403);
      const owner=JSON.stringify([context.scope.projectId,context.scope.spaceId,context.principal.id,context.principal.clientInstallationId,context.purpose]);
      const requestDigest=digest({tag:'model-call-v1',request,model:options.port.config.model,effort:options.port.config.effort});
      const id=randomUUID();
      const claim=await options.store.claim(owner,key,requestDigest,id);
      if(claim.state==='conflict')throw new KnowledgeError('IDEMPOTENCY_CONFLICT','This Idempotency-Key was used for a different model call',409);
      if(claim.state==='done')return claim.result;
      if(claim.state==='pending')throw Object.assign(new KnowledgeError('MODEL_CALL_IN_PROGRESS','A model call with this key is in progress or its outcome is unknown',409),{commitStatus:'unknown'});
      let result;
      try{
        result=await options.port.call({role:'model_call',operationId:id,system:request.system,cachedPrefix:request.cachedPrefix??undefined,prompt:request.prompt,
          maxMoneyUsd:request.maxMoney.amount,maxOutputTokens:request.maxOutputTokens??undefined,signal:signal??new AbortController().signal});
      }catch(error){
        // Only an error known to precede billing frees the key; any other error may follow a billed dispatch.
        if(error instanceof KnowledgeError&&UNBILLED_MODEL_ERRORS.has(error.code))await options.store.abandon(owner,key);
        throw error;
      }
      const stored=ModelCallResultSchema.parse({id,label:request.label,requestDigest,outcome:result.outcome,text:result.text,usage:result.usage,
        cost:knowledgeCost(result),reservedMoney:{amount:result.reservedUsd,currency:'USD'},
        provider:{id:CLAUDE_PROVIDER_ID,modelRequested:result.modelRequested,modelReturned:result.modelReturned,requestId:result.requestId,effort:options.port.config.effort},
        createdAt:now().toISOString()});
      await options.store.complete(owner,key,stored);
      return stored;
    },
  };
}
