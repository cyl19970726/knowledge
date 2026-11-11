import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Message} from '@anthropic-ai/sdk/resources/messages/messages';
import type {AskEvidence} from '@commerce/knowledge-application';
import type {CandidateView,ReviewTicket} from '@commerce/knowledge-contracts';
import {readRedactionFile,createRedactor,createClaudeModelPort,createMemorySpendLedger,createClaudeWikiCompiler,createClaudeSourcePlanner,
  createReviewAgent,type ClaudeTransport,type ClaudeRequest,type ReviewAgentClient} from '../src/index.ts';

// Fictitious names used only for this test.
const policy={terms:['王小梅','Wang Xiaomei','Xiaomei Wang'],secondaryTerms:['Xiaomei'],replacement:{zh:'当事女性',default:'the woman'}};
const model='claude-sonnet-5-5',signal=new AbortController().signal;
const config={model,effort:'high' as const,maxCallUsd:0.5,dailyCapUsd:1,maxOutputTokens:16000};
function transport(text:string){const sent:ClaudeRequest[]=[];
  const t:ClaudeTransport={async countTokens(){return 500;},async send(params){sent.push(params);
    return {requestId:'req',message:{id:'m',type:'message',role:'assistant',model,content:[{type:'text',text,citations:null}],stop_reason:'end_turn',stop_sequence:null,
      usage:{input_tokens:500,output_tokens:100,cache_creation_input_tokens:0,cache_read_input_tokens:0}} as unknown as Message};}};
  return {t,sent};}
const evidence=(id:string,body:string):AskEvidence=>({id,kind:'source_content',ref:{projectId:'p',spaceId:'s',domain:'source',objectId:'00000000-0000-4000-8000-000000000001',
  versionId:'00000000-0000-4000-8000-000000000002',contentDigest:null},title:'t',locator:null,conditions:[],counterexamples:[],unknowns:[],actualReadCoverage:[],body});

test('the redaction file is private, well formed, and errors never echo its content',()=>{
  const dir=mkdtempSync(join(tmpdir(),'redaction-')),path=join(dir,'redaction.json');
  writeFileSync(path,JSON.stringify(policy));chmodSync(path,0o644);
  assert.throws(()=>readRedactionFile(path),/chmod 600/);
  chmodSync(path,0o600);
  assert.deepEqual(readRedactionFile(path),policy);
  writeFileSync(path,'{"terms":["王小梅"]');
  assert.throws(()=>readRedactionFile(path),(error:Error)=>!error.message.includes('王小梅'));
  writeFileSync(path,JSON.stringify({terms:['当事'],replacement:'当事女性'}));
  assert.throws(()=>readRedactionFile(path),/must not contain/);
  writeFileSync(path,JSON.stringify({terms:['Woman'],replacement:{zh:'当事女性',default:'the woman'}}));
  assert.throws(()=>readRedactionFile(path),/must not contain/);
});

test('matching is NFKC, case-insensitive, separator-tolerant and whole-word, with a per-language replacement',()=>{
  const r=createRedactor(policy);
  assert.deepEqual(r.redact('王小梅说，王·小梅和王 小梅都是她。'),{text:'当事女性说，当事女性和当事女性都是她。',count:3});
  assert.deepEqual(r.redact('Reports say WANG  XIAOMEI and Ｗａｎｇ－Ｘｉａｏｍｅｉ left.'),{text:'Reports say the woman and the woman left.',count:2});
  assert.equal(r.redact('报道称 Wang Xiaomei 已离开。').text,'报道称 当事女性 已离开。','Han context picks the Chinese replacement');
  assert.equal(r.redact('Wang Xiaomeiya is someone else.').count,0,'no partial-word matches');
  assert.equal(r.redact('王小 梅').count,1);
  assert.equal(r.contains('与本案无关'),false);
  assert.equal(r.redact('全角，标点：保持不变').text,'全角，标点：保持不变','text outside the names is untouched');
});

test('a secondary form is replaced only when a primary name appears in the output or in the call input',()=>{
  const r=createRedactor(policy);
  assert.deepEqual(r.redact('Xiaomei said no.'),{text:'Xiaomei said no.',count:0});
  assert.deepEqual(r.redact('Xiaomei said no.','Source: Wang Xiaomei spoke to reporters.'),{text:'the woman said no.',count:1});
  assert.deepEqual(r.redact('王小梅回应后，Xiaomei 再次发声。'),{text:'当事女性回应后，当事女性 再次发声。',count:2});
  assert.equal(r.contains('Xiaomei'),true,'the review gate also flags the secondary form');
});

test('every call carries the rule and every output is redacted before parsing, with only a count reported',async()=>{
  const {t,sent}=transport('王小梅回应了质疑。');const events:unknown[]=[];const ledger=createMemorySpendLedger();
  const port=createClaudeModelPort({transport:t,ledger,config,redactor:createRedactor(policy),onRedaction:event=>events.push(event)});
  const result=await port.call({role:'model_call',operationId:'op-1',system:'Answer.',prompt:'Who?',signal});
  assert.equal(result.text,'当事女性回应了质疑。');
  assert.equal(result.redactions,1);
  assert.deepEqual(events,[{role:'model_call',operationId:'op-1',count:1}]);
  assert.match(JSON.stringify(sent[0].system),/Privacy rule/);
  assert.equal(ledger.entries[0].redactions,1,'the count is stored per call, so it can be summed by role');
  const plain=createClaudeModelPort({transport:transport('王小梅回应了质疑。').t,ledger,config});
  assert.equal((await plain.call({role:'model_call',operationId:'op-2',system:'s',prompt:'p',signal})).text,'王小梅回应了质疑。','a port without a redactor is left untouched');
});

test('compiled pages never carry a protected name, even when the model ignores the rule',async()=>{
  const draft={targetEvidenceId:null,profileId:'synthesis',identityKey:'claim:wang-xiaomei-statement',title:'王小梅的声明',summary:'Wang Xiaomei 表示她不认可报道。',
    claimStatus:'attributed',conditions:['小梅本人发声'],counterexamples:[],unknowns:[],nextQuestions:['王小梅是否会起诉？'],supportEvidenceIds:['s1'],rationale:'r'};
  const {t}=transport(JSON.stringify({outcome:'proposed',drafts:[draft],reason:'r',gaps:[]}));
  const compiler=createClaudeWikiCompiler(createClaudeModelPort({transport:t,ledger:createMemorySpendLedger(),config,redactor:createRedactor(policy)}));
  const out=await compiler.compile({operationId:'c',question:'Q',purpose:'p',evidence:[evidence('s1','王小梅表示……')],profiles:[{id:'synthesis',version:'1',digest:'a'.repeat(64)}],
    budget:{maxModelCalls:1,maxReadBytes:1,deadline:new Date().toISOString(),maxMoney:null},signal,gaps:[]});
  const text=JSON.stringify(out.proposal);
  for(const term of policy.terms)assert.ok(!text.toLowerCase().includes(term.toLowerCase()),'no protected term survives');
  assert.equal(out.proposal.drafts[0].title,'当事女性的声明');
});

test('a plan never records a protected name as an entity mention',async()=>{
  const body='王小梅在发布会上表示，公司将回应。';
  const {t}=transport(JSON.stringify({outcome:'planned',question:'王小梅说了什么？',queries:['王小梅 发布会'],mentions:[{entityType:'person',surface:'王小梅',occurrence:1}],reason:'r',gaps:[]}));
  const planner=createClaudeSourcePlanner(createClaudeModelPort({transport:t,ledger:createMemorySpendLedger(),config,redactor:createRedactor(policy)}));
  const out=await planner.plan({operationId:'p',source:evidence('s',body),methodVersion:'m',budget:{maxModelCalls:1,maxReadBytes:1,deadline:new Date().toISOString(),maxMoney:null},signal});
  assert.equal(out.proposal.question,'当事女性说了什么？');
  assert.equal(out.proposal.mentions.length,0);
});

test('the review agent hands a page that still names her to a person without a model call',async()=>{
  const hash='c'.repeat(64);
  const ticket:ReviewTicket={id:'00000000-0000-4000-8000-0000000000aa',target:{kind:'candidate',candidateId:'00000000-0000-4000-8000-0000000000bb',contentHash:hash},status:'pending',purpose:'exploration_reading'};
  const view={candidateId:'00000000-0000-4000-8000-0000000000bb',contentHash:hash,purpose:'exploration_reading',proposer:'x',rationale:'r',createdAt:new Date().toISOString(),
    state:'waiting_for_review',exactReadset:[],changes:[{ref:{projectId:'p',spaceId:'s',domain:'knowledge',objectId:'o',versionId:'v',contentDigest:null},title:'声明',
    body:'当事女性（王小梅）表示……',profile:{id:'synthesis',version:'1',digest:'a'.repeat(64)},conditions:[],counterexamples:[],unknowns:[],nextQuestions:[],sourceGroups:[]}]} as unknown as CandidateView;
  const escalations:{categories:string[];note:string}[]=[];
  const client:ReviewAgentClient={async pendingReviews(){return [ticket];},async candidateView(){return view;},async sourceText(){return {text:'',rightsPolicyRef:'p'};},
    async wikiText(){return '';},async decide(){throw new Error('must not decide');},async escalate(_id,escalation){escalations.push(escalation);}};
  const {t,sent}=transport('{}');
  const agent=createReviewAgent({client,purpose:'exploration_reading',disclosure:{rightsPolicyIds:['p'],allowWikiPages:true},redactor:createRedactor(policy),
    port:createClaudeModelPort({transport:t,ledger:createMemorySpendLedger(),config})});
  const [result]=await agent.runOnce();
  assert.equal(result.action,'escalated');
  assert.equal(sent.length,0);
  assert.deepEqual(escalations[0].categories,['private_person']);
  assert.ok(!escalations[0].note.includes('王小梅'));
});
