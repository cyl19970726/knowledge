import type {Effort,ClaudeModelConfig} from './model-port.ts';
import type {ModelDisclosurePolicy} from './disclosure.ts';
import {supportedModels} from './pricing.ts';

export const CLAUDE_ROLES=['ask','source_plan','wiki_compile','relation_judgment','model_call'] as const;
export type ClaudeRole=typeof CLAUDE_ROLES[number];
export interface ClaudeRuntimeConfig {apiKeyFile:string;model:ClaudeModelConfig;roles:ReadonlySet<ClaudeRole>;disclosure:ModelDisclosurePolicy;redactionFile:string|null}

const list=(value:string|undefined)=>value?.split(',').map(item=>item.trim()).filter(Boolean)??[];
function usd(env:Record<string,string|undefined>,name:string):number{
  const raw=env[name];
  if(!raw?.trim())throw new Error(`${name} is required when Claude providers are enabled`);
  if(!/^\d+(\.\d{1,6})?$/.test(raw.trim()))throw new Error(`${name} must be a plain USD amount`);
  return Number(raw);
}
/** Off unless explicitly enabled; spending caps have no defaults. */
export function readClaudeRuntimeConfig(env:Record<string,string|undefined>):ClaudeRuntimeConfig|undefined{
  const flag=env.KNOWLEDGE_CLAUDE_ENABLED;
  if(flag===undefined||flag==='0')return undefined;
  if(flag!=='1')throw new Error('KNOWLEDGE_CLAUDE_ENABLED must be 0 or 1');
  const apiKeyFile=env.KNOWLEDGE_CLAUDE_API_KEY_FILE?.trim();
  if(!apiKeyFile)throw new Error('KNOWLEDGE_CLAUDE_API_KEY_FILE is required; the key itself is never read from the environment');
  const model=env.KNOWLEDGE_CLAUDE_MODEL?.trim()||'claude-opus-5-5';
  if(!supportedModels().includes(model))throw new Error(`KNOWLEDGE_CLAUDE_MODEL must be one of ${supportedModels().join(', ')}`);
  const effort=(env.KNOWLEDGE_CLAUDE_EFFORT?.trim()||'high') as Effort;
  const maxOutputTokens=Number(env.KNOWLEDGE_CLAUDE_MAX_OUTPUT_TOKENS??'32000');
  const roleNames=list(env.KNOWLEDGE_CLAUDE_ROLES);
  const unknown=roleNames.filter(role=>!(CLAUDE_ROLES as readonly string[]).includes(role));
  if(unknown.length)throw new Error(`Unknown KNOWLEDGE_CLAUDE_ROLES: ${unknown.join(', ')}`);
  const wiki=env.KNOWLEDGE_MODEL_DISCLOSURE_WIKI;
  if(wiki!==undefined&&!['0','1'].includes(wiki))throw new Error('KNOWLEDGE_MODEL_DISCLOSURE_WIKI must be 0 or 1');
  return {apiKeyFile,
    model:{model,effort,maxCallUsd:usd(env,'KNOWLEDGE_CLAUDE_MAX_CALL_USD'),dailyCapUsd:usd(env,'KNOWLEDGE_CLAUDE_DAILY_USD'),maxOutputTokens},
    roles:new Set((roleNames.length?roleNames:CLAUDE_ROLES) as ClaudeRole[]),
    disclosure:{rightsPolicyIds:list(env.KNOWLEDGE_MODEL_DISCLOSURE_RIGHTS_POLICY_IDS),allowWikiPages:wiki==='1'},
    redactionFile:env.KNOWLEDGE_MODEL_REDACTION_FILE?.trim()||null};
}
