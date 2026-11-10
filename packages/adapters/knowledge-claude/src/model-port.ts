import {readFileSync,statSync} from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import type {Message,MessageCreateParamsNonStreaming,MessageCountTokensParams,OutputConfig,TextBlockParam} from '@anthropic-ai/sdk/resources/messages/messages';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {modelPrice,outputAllowance,usageCost,worstCaseCost,PRICE_TABLE_VERSION,type TokenUsage} from './pricing.ts';
import type {SpendLedger} from './ledger.ts';

export type Effort=NonNullable<OutputConfig['effort']>;
export type ClaudeRequest=Omit<MessageCreateParamsNonStreaming,'stream'>;
/** The only thing that talks to Anthropic. Tests replace it; production wraps the official SDK. */
export interface ClaudeTransport {
  countTokens(params:MessageCountTokensParams,signal:AbortSignal):Promise<number>;
  send(params:ClaudeRequest,signal:AbortSignal):Promise<{message:Message;requestId:string|null}>;
}
export class ClaudeDispatchError extends Error{
  constructor(message:string,readonly billed:'no'|'unknown',readonly status:number|null){super(message);}
}

/** Reads the key from a private file; the value never enters configuration, logs or errors. */
export function readApiKeyFile(path:string):string{
  const stat=statSync(path);
  if(!stat.isFile())throw new Error('Claude API key path must be a regular file');
  if((stat.mode&0o077)!==0)throw new Error('Claude API key file must not be readable by group or others (chmod 600)');
  const key=readFileSync(path,'utf8').trim();
  if(!key||/\s/.test(key))throw new Error('Claude API key file must contain exactly one key');
  return key;
}

export function createAnthropicTransport(options:{apiKey:string;timeoutMs?:number}):ClaudeTransport{
  // Retries are disabled: a retried request could be billed twice outside the reservation.
  const client=new Anthropic({apiKey:options.apiKey,maxRetries:0,timeout:options.timeoutMs??600_000});
  const classify=(error:unknown):never=>{
    if(error instanceof Anthropic.APIUserAbortError)throw new ClaudeDispatchError('Model call was aborted','unknown',null);
    if(error instanceof Anthropic.APIConnectionError)throw new ClaudeDispatchError('Anthropic connection failed','unknown',null);
    if(error instanceof Anthropic.APIError){
      const status=typeof error.status==='number'?error.status:null;
      // 4xx other than timeouts are rejected before generation and are not billed.
      throw new ClaudeDispatchError(`Anthropic returned ${status}`,status!==null&&status>=400&&status<500&&status!==408?'no':'unknown',status);
    }
    throw new ClaudeDispatchError('Model call failed','unknown',null);
  };
  return {
    async countTokens(params,signal){
      try{return (await client.messages.countTokens(params,{signal})).input_tokens;}
      catch(error){return classify(error);}
    },
    async send(params,signal){
      // Streaming avoids HTTP timeouts on long outputs; only the final message is used.
      try{const stream=client.messages.stream(params,{signal});const message=await stream.finalMessage();return {message,requestId:stream.request_id??null};}
      catch(error){return classify(error);}
    },
  };
}

export interface ClaudeModelConfig {model:string;effort:Effort;maxCallUsd:number;dailyCapUsd:number;maxOutputTokens:number;minOutputTokens?:number}
export interface ModelCallInput {
  role:string;operationId:string;system:string;
  /** Large stable context placed before the volatile prompt and marked for caching. */
  cachedPrefix?:string;prompt:string;
  outputFormat?:OutputConfig['format'];
  /** Caller cap in USD; the configured per-call cap still applies. */
  maxMoneyUsd?:number|null;maxOutputTokens?:number;signal:AbortSignal;now?:Date;
}
export interface ModelCallResult {
  outcome:'completed'|'refused'|'truncated';text:string;usage:TokenUsage;costUsd:number;reservedUsd:number;
  modelRequested:string;modelReturned:string|null;requestId:string|null;stopReason:string|null;priceTable:string;
}
export interface ClaudeModelPort {
  readonly config:Readonly<ClaudeModelConfig>;
  call(input:ModelCallInput):Promise<ModelCallResult>;
}

export function validateModelConfig(config:ClaudeModelConfig):ClaudeModelConfig{
  modelPrice(config.model);
  const money=(value:number,name:string)=>{if(!Number.isFinite(value)||value<=0)throw new Error(`${name} must be a positive USD amount`);};
  money(config.maxCallUsd,'Per-call cap');money(config.dailyCapUsd,'Daily cap');
  if(config.maxCallUsd>config.dailyCapUsd)throw new Error('Per-call cap cannot exceed the daily cap');
  if(!Number.isSafeInteger(config.maxOutputTokens)||config.maxOutputTokens<1024||config.maxOutputTokens>128_000)throw new Error('Output token ceiling must be 1024..128000');
  if(!['low','medium','high','xhigh','max'].includes(config.effort))throw new Error('Unknown effort level');
  return config;
}

/** Generic, budgeted Claude call shared by every knowledge provider and the HTTP model-call route. */
export function createClaudeModelPort(options:{transport:ClaudeTransport;ledger:SpendLedger;config:ClaudeModelConfig;now?:()=>Date}):ClaudeModelPort{
  const config=Object.freeze(validateModelConfig({...options.config}));
  const now=()=>options.now?.()??new Date();
  return {config,
    async call(input){
      const cap=Math.min(config.maxCallUsd,input.maxMoneyUsd??Number.POSITIVE_INFINITY);
      if(!(cap>0))throw new KnowledgeError('MODEL_BUDGET_EXCEEDED','Model call has no money allowance',422);
      const system:TextBlockParam[]=[{type:'text',text:input.system,cache_control:{type:'ephemeral'}}];
      const content:TextBlockParam[]=[...input.cachedPrefix?[{type:'text' as const,text:input.cachedPrefix,cache_control:{type:'ephemeral' as const}}]:[],
        {type:'text',text:input.prompt}];
      const output_config:OutputConfig={effort:config.effort,...input.outputFormat?{format:input.outputFormat}:{}};
      const base={model:config.model,system,messages:[{role:'user' as const,content}],output_config};
      // Token counting is free and gives an exact input size for the worst-case reservation.
      const inputTokens=await options.transport.countTokens(base,input.signal);
      const ceiling=Math.min(input.maxOutputTokens??config.maxOutputTokens,config.maxOutputTokens);
      const maxTokens=Math.min(ceiling,outputAllowance(config.model,inputTokens,cap));
      if(maxTokens<(config.minOutputTokens??1024))
        throw new KnowledgeError('MODEL_BUDGET_EXCEEDED',`Money cap ${cap} USD cannot cover ${inputTokens} input tokens and a useful answer`,422);
      const reservedUsd=worstCaseCost(config.model,inputTokens,maxTokens);
      const reservation=await options.ledger.reserve({role:input.role,operationId:input.operationId,model:config.model,reservedUsd,dailyCapUsd:config.dailyCapUsd,now:input.now??now()});
      let message:Message,requestId:string|null;
      try{({message,requestId}=await options.transport.send({...base,max_tokens:maxTokens},input.signal));}
      catch(error){
        const billed=error instanceof ClaudeDispatchError?error.billed:'unknown';
        const reason=error instanceof Error?error.message:'Model call failed';
        if(billed==='no')await options.ledger.release(reservation.id,reason);else await options.ledger.markUnknown(reservation.id,reason);
        throw new KnowledgeError(billed==='no'?'MODEL_CALL_REJECTED':'PROVIDER_OUTCOME_UNKNOWN',reason,billed==='no'?502:504);
      }
      const usage:TokenUsage={inputTokens:message.usage.input_tokens,outputTokens:message.usage.output_tokens,
        cacheCreationInputTokens:message.usage.cache_creation_input_tokens??0,cacheReadInputTokens:message.usage.cache_read_input_tokens??0};
      const costUsd=usageCost(config.model,usage);
      await options.ledger.settle(reservation.id,{actualUsd:costUsd,usage,modelReturned:message.model,requestId,stopReason:message.stop_reason});
      const text=message.content.flatMap(block=>block.type==='text'?[block.text]:[]).join('');
      const outcome=message.stop_reason==='refusal'?'refused':message.stop_reason==='max_tokens'?'truncated':'completed';
      return {outcome,text,usage,costUsd,reservedUsd,modelRequested:config.model,modelReturned:message.model,requestId,stopReason:message.stop_reason,priceTable:PRICE_TABLE_VERSION};
    },
  };
}

/** Knowledge cost record for one settled call. */
export function knowledgeCost(result:Pick<ModelCallResult,'usage'|'costUsd'|'priceTable'>){
  const tokens=result.usage.inputTokens+result.usage.outputTokens+result.usage.cacheCreationInputTokens+result.usage.cacheReadInputTokens;
  return {modelCalls:{state:'known' as const,value:1},tokens:{state:'known' as const,value:tokens},
    money:{state:'known' as const,amount:result.costUsd,currency:'USD',source:`anthropic_usage:${result.priceTable}`}};
}
