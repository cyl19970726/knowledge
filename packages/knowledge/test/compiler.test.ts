import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createKnowledgeCompiler, type KnowledgeCompileCommand, type KnowledgeProposerPort } from '../src/compiler.ts';
import type { KnowledgeService } from '../src/service.ts';
import type { KnowledgeChangeSet, KnowledgeRevision } from '../src/types.ts';
import type { ProposeChange } from '../src/schemas.ts';
import { digest } from '../src/utils.ts';
import { caseRevision, claimRevision, mediaCitation, ref, scope, sha, SyntheticAnalysis, timestamp } from './service-fixtures.ts';

function harness() {
  const projectId='compiler-test';const product=ref();const analysis=new SyntheticAnalysis();
  const a=analysis.add(projectId);const caseRef=ref();
  const caseOutput=caseRevision(projectId,product,a.result,a.anchor,'compiler case',caseRef);
  const command:KnowledgeCompileCommand={commandVersion:'knowledge.compile.v1',projectId,analysisResultRefs:[a.result.ref],purpose:'creative_reference',scope:scope(product),
    baseHeads:[{objectId:caseRef.objectId,versionId:null}],mode:'case',question:'What is the hook?',methodDigest:sha('a'),
    limits:{maxInputBytes:100_000,maxOutputBytes:100_000,maxModelCalls:1,maxRunMs:10_000,spendLimit:null},publishMode:'proposal_only'};
  let prior:KnowledgeChangeSet|null=null;let output:KnowledgeRevision=caseOutput;let proposerCalls=0;let analysisReads=0;let knowledgeProposals=0;
  const knowledge={
    getByRequestKey:async()=>prior,
    revalidate:async()=>{},
    readAnalysis:async()=>{analysisReads++;return {result:a.result,snapshot:a.snapshot};},
    get:async()=>null,
    propose:async(input:ProposeChange,_signal:AbortSignal|undefined,identity:unknown)=>{
      knowledgeProposals++;
      const change:KnowledgeChangeSet={...input,id:randomUUID(),requestHash:digest(identity),contentHash:sha('b'),inputManifest:[],createdAt:timestamp};
      prior=change;return change;
    },
  } as unknown as KnowledgeService;
  const proposer:KnowledgeProposerPort={methodDigest:command.methodDigest,async propose(){proposerCalls++;return {changes:[{revision:structuredClone(output),effect:'create',explanation:'synthetic compiler output'}],proposer:'synthetic proposer',methodVersion:'fixture-v1',cost:{state:'unknown',reason:'no model called'}};}};
  return {command,knowledge,proposer,caseOutput,analysis:a,product,
    compile:()=>createKnowledgeCompiler({knowledge,proposer}),
    setPrior:(value:KnowledgeChangeSet|null)=>{prior=value;},setOutput:(value:KnowledgeRevision)=>{output=value;},
    counts:()=>({proposerCalls,analysisReads,knowledgeProposals})};
}

test('compile replay returns exact staged proposal without calling proposer or rereading analysis',async()=>{
  const h=harness();const compile=h.compile();const key=randomUUID();const signal=new AbortController().signal;
  const first=await compile(h.command,key,signal);
  assert.equal(first.kind,'changed');
  assert.equal(first.requestHash,digest({operation:'compile-v1',command:h.command}));
  assert.deepEqual(h.counts(),{proposerCalls:1,analysisReads:1,knowledgeProposals:1});
  assert.deepEqual(await compile(h.command,key,signal),first);
  assert.deepEqual(h.counts(),{proposerCalls:1,analysisReads:1,knowledgeProposals:1});
  await assert.rejects(compile({...h.command,question:'Different command'},key,signal),/request key|another command/i);
  assert.deepEqual(h.counts(),{proposerCalls:1,analysisReads:1,knowledgeProposals:1});
});

test('method binding and output guards reject scope change and unselected non-case analysis dependency',async()=>{
  const h=harness();const signal=new AbortController().signal;
  const wrongMethod=createKnowledgeCompiler({knowledge:h.knowledge,proposer:{...h.proposer,methodDigest:sha('f')}});
  await assert.rejects(wrongMethod(h.command,randomUUID(),signal),/method|compiler/i);
  assert.deepEqual(h.counts(),{proposerCalls:0,analysisReads:0,knowledgeProposals:0});
  const changedScope=structuredClone(h.caseOutput);
  changedScope.scope.applicability.markets=['CA'];h.setOutput(changedScope);
  await assert.rejects(h.compile()(h.command,randomUUID(),signal),/scope|applicab/i);
  assert.equal(h.counts().knowledgeProposals,0);
  const claim=claimRevision(h.command.projectId,h.product,'Observed opening',mediaCitation(h.analysis.anchor),'observation');
  claim.dependencies=[{domain:'analysis',ref:ref(),role:'derived_from',critical:true}];h.setOutput(claim);
  await assert.rejects(h.compile()({...h.command,mode:'topic',baseHeads:[{objectId:claim.ref.objectId,versionId:null}]},randomUUID(),signal),/unselected analysis/i);
  assert.equal(h.counts().knowledgeProposals,0);
  const pattern:KnowledgeRevision={kind:'pattern',ref:ref(),projectId:h.command.projectId,title:'pattern',body:'pattern',scope:scope(h.product),dependencies:[],sourceGroups:[],artifactRef:null,createdAt:timestamp,analysisQuality:null,
    content:{ref:ref(),projectId:h.command.projectId,title:'pattern',problem:'problem',mechanism:'mechanism',sequence:['step'],requiredElements:['hook'],variableSlots:[],applicability:['US'],exclusions:[],supportRefs:[h.caseOutput.ref],counterexampleRefs:[],prediction:'prediction',evidenceLevel:'single_case',citations:[mediaCitation(h.analysis.anchor)]}};
  h.setOutput(pattern);
  await assert.rejects(h.compile()(h.command,randomUUID(),signal),/case compilation|mode/i);
  assert.equal(h.counts().knowledgeProposals,0);
});

test('no-change keeps actual cost, creates no empty change set and replays from durable ledger',async()=>{
  const h=harness();let calls=0;let saved:Awaited<ReturnType<ReturnType<typeof createKnowledgeCompiler>>>|null=null;
  const proposer:KnowledgeProposerPort={...h.proposer,async propose(){calls++;return {changes:[],noChangeReason:'All selected evidence is already represented',proposer:'fixture',methodVersion:'v1',cost:{state:'known',amount:0.04,currency:'USD'}};}};
  const ledger={get:async()=>saved,record:async (value:NonNullable<typeof saved>)=>{saved=value;return value;}};
  const compile=createKnowledgeCompiler({knowledge:h.knowledge,proposer,outcomeLedger:ledger});
  const key=randomUUID();const signal=new AbortController().signal;
  const first=await compile(h.command,key,signal);
  assert.equal(first.kind,'no_change');
  assert.deepEqual(first.cost,{state:'known',amount:0.04,currency:'USD'});
  assert.equal(h.counts().knowledgeProposals,0);
  assert.deepEqual(await compile(h.command,key,signal),first);
  assert.equal(calls,1);
});
test('an uncertain proposer failure records unknown cost and does not replay the external call',async()=>{
  const h=harness();let calls=0;let saved:Awaited<ReturnType<ReturnType<typeof createKnowledgeCompiler>>>|null=null;
  const proposer:KnowledgeProposerPort={...h.proposer,async propose(){calls++;throw new Error('provider response lost');}};
  const ledger={get:async()=>saved,record:async (value:NonNullable<typeof saved>)=>{saved=value;return value;}};
  const compile=createKnowledgeCompiler({knowledge:h.knowledge,proposer,outcomeLedger:ledger});
  const key=randomUUID();const signal=new AbortController().signal;
  const first=await compile(h.command,key,signal);
  assert.equal(first.kind,'failed');
  assert.equal(first.cost.state,'unknown');
  assert.equal(first.kind==='failed'&&first.retryable,false);
  assert.deepEqual(await compile(h.command,key,signal),first);
  assert.equal(calls,1);
});
