import {KnowledgeError} from '@commerce/knowledge-core/types';

/** USD per million tokens. Cache writes use the five-minute TTL multiplier (1.25x input). */
export interface ModelPrice {input:number;output:number;cacheWrite:number;cacheRead:number}
export const PRICE_TABLE_VERSION='anthropic-list-2026-10';
const PRICES:Record<string,ModelPrice>={
  'claude-opus-5-5':{input:4,output:20,cacheWrite:5,cacheRead:0.2},
  'claude-sonnet-5-5':{input:2,output:10,cacheWrite:2.5,cacheRead:0.2},
  // Haiku 5.5 doubles past 100K prompt tokens; the higher tier is used so a reservation is never under-priced.
  'claude-haiku-5-5':{input:0.5,output:2.5,cacheWrite:0.625,cacheRead:0.05},
};

export function modelPrice(model:string):ModelPrice{
  const price=PRICES[model];
  if(!price)throw new KnowledgeError('MODEL_PRICE_UNKNOWN',`No price is configured for ${model}; spending cannot be bounded`,422);
  return price;
}
export const supportedModels=():string[]=>Object.keys(PRICES);

export interface TokenUsage {inputTokens:number;outputTokens:number;cacheCreationInputTokens:number;cacheReadInputTokens:number}
const perToken=(perMillion:number)=>perMillion/1_000_000;
/** Actual cost from reported usage. */
export function usageCost(model:string,usage:TokenUsage):number{
  const p=modelPrice(model);
  return round(usage.inputTokens*perToken(p.input)+usage.outputTokens*perToken(p.output)+
    usage.cacheCreationInputTokens*perToken(p.cacheWrite)+usage.cacheReadInputTokens*perToken(p.cacheRead));
}
/** Upper bound before dispatch: every input token priced at the dearer of input and cache write, plus the full output allowance. */
export function worstCaseCost(model:string,inputTokens:number,maxOutputTokens:number):number{
  const p=modelPrice(model);
  return round(inputTokens*perToken(Math.max(p.input,p.cacheWrite))+maxOutputTokens*perToken(p.output));
}
/** Largest output allowance that keeps the worst case within a money cap. */
export function outputAllowance(model:string,inputTokens:number,capUsd:number):number{
  const p=modelPrice(model);
  const left=capUsd-inputTokens*perToken(Math.max(p.input,p.cacheWrite));
  return left<=0?0:Math.floor(left/perToken(p.output));
}
const round=(value:number)=>Math.ceil(value*1_000_000)/1_000_000;
