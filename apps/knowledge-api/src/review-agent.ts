/**
 * Independent review agent. It authenticates to the knowledge API as its own principal (actor kind "agent"),
 * reads each candidate's cited originals itself in a fresh model context, and either decides the review or
 * escalates it to a person. It has no database access; its spending is recorded in a private JSONL ledger.
 */
import {readFileSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createKnowledgeClient} from '@commerce/knowledge-client';
import {createReviewAgent,createClaudeModelPort,createAnthropicTransport,createFileSpendLedger,readApiKeyFile,readClaudeRuntimeConfig,
  readRedactionFile,createRedactor,type ReviewAgentClient} from '@commerce/knowledge-claude-adapter';

export function reviewAgentClient(client:ReturnType<typeof createKnowledgeClient>):ReviewAgentClient{
  return {
    pendingReviews:async input=>(await client.reviewQueue({purpose:input.purpose,limit:input.limit,escalated:'exclude',targetKind:'candidate'})).data.items,
    candidateView:async(id,purpose)=>(await client.candidateView(id,purpose)).data,
    async sourceText(ref,purpose){
      const record=(await client.source(ref,purpose)).data;
      return {text:(await client.sourceContent(ref,purpose)).data.content,rightsPolicyRef:record.provenance?.rightsPolicyRef??null};
    },
    async wikiText(ref,purpose){
      const page=(await client.document(ref,purpose)).data;
      return [page.title,page.body,...page.conditions.map(item=>`条件: ${item}`),...page.counterexamples.map(item=>`反例: ${item}`)].join('\n');
    },
    async decide(id,decision,key,purpose){await client.decideReview(id,decision,{idempotencyKey:key,purpose});},
    async escalate(id,escalation,key,purpose){await client.escalateReview(id,escalation,{idempotencyKey:key,purpose});},
  };
}

function readPrivateToken(path:string){
  if((statSync(path).mode&0o077)!==0)throw new Error('Review agent token file must not be readable by group or others (chmod 600)');
  const token=readFileSync(path,'utf8').trim();if(!token)throw new Error('Review agent token file is empty');return token;
}
/** The agent reuses the Claude settings format under its own prefix, so it can run a different model and its own caps. */
export function reviewAgentEnv(env:Record<string,string|undefined>){
  const prefixed=Object.fromEntries(Object.entries(env).filter(([key])=>key.startsWith('KNOWLEDGE_REVIEW_AGENT_CLAUDE_'))
    .map(([key,value])=>[key.replace('KNOWLEDGE_REVIEW_AGENT_CLAUDE_','KNOWLEDGE_CLAUDE_'),value]));
  let claude;
  try{claude=readClaudeRuntimeConfig({...prefixed,KNOWLEDGE_CLAUDE_ENABLED:'1',
    KNOWLEDGE_MODEL_DISCLOSURE_RIGHTS_POLICY_IDS:env.KNOWLEDGE_MODEL_DISCLOSURE_RIGHTS_POLICY_IDS,KNOWLEDGE_MODEL_DISCLOSURE_WIKI:env.KNOWLEDGE_MODEL_DISCLOSURE_WIKI,
    KNOWLEDGE_MODEL_REDACTION_FILE:env.KNOWLEDGE_MODEL_REDACTION_FILE})!;}
  catch(error){throw new Error((error instanceof Error?error.message:'Invalid review agent model settings').replaceAll('KNOWLEDGE_CLAUDE_','KNOWLEDGE_REVIEW_AGENT_CLAUDE_'));}
  const required=(name:string)=>{const value=env[name]?.trim();if(!value)throw new Error(`${name} is required`);return value;};
  return {claude,baseUrl:required('KNOWLEDGE_REVIEW_AGENT_API_URL'),tokenFile:required('KNOWLEDGE_REVIEW_AGENT_TOKEN_FILE'),
    projectId:required('KNOWLEDGE_API_PROJECT_ID'),spaceId:required('KNOWLEDGE_REVIEW_AGENT_SPACE_ID'),
    purpose:env.KNOWLEDGE_REVIEW_AGENT_PURPOSE?.trim()||'exploration_reading',spendFile:required('KNOWLEDGE_REVIEW_AGENT_SPEND_FILE'),
    intervalSeconds:Number(env.KNOWLEDGE_REVIEW_AGENT_INTERVAL_SECONDS??'60')};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const config=reviewAgentEnv(process.env),once=process.argv.includes('--once');
  const client=createKnowledgeClient({baseUrl:config.baseUrl,scope:{projectId:config.projectId,spaceId:config.spaceId},
    headers:{Authorization:`Bearer ${readPrivateToken(config.tokenFile)}`}});
  const redactor=config.claude.redactionFile?createRedactor(readRedactionFile(config.claude.redactionFile)):undefined;
  const port=createClaudeModelPort({transport:createAnthropicTransport({apiKey:readApiKeyFile(config.claude.apiKeyFile)}),
    ledger:createFileSpendLedger(config.spendFile),config:config.claude.model,redactor,
    onRedaction:event=>process.stdout.write(`${JSON.stringify({redaction:event.count,ticketId:event.operationId})}\n`)});
  const agent=createReviewAgent({client:reviewAgentClient(client),port,purpose:config.purpose,disclosure:config.claude.disclosure,redactor});
  process.stdout.write(`Review agent: model=${config.claude.model.model} redaction=${redactor?'on':'off'} perCallUsd=${config.claude.model.maxCallUsd} dailyUsd=${config.claude.model.dailyCapUsd}\n`);
  for(;;){
    try{for(const result of await agent.runOnce())process.stdout.write(`${JSON.stringify({ticketId:result.ticketId,action:result.action,note:result.note})}\n`);}
    catch(error){process.stderr.write(`Review pass failed: ${error instanceof Error?error.message:'unknown error'}\n`);}
    if(once)break;
    await new Promise(done=>setTimeout(done,Math.max(10,config.intervalSeconds)*1000));
  }
}
