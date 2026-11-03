import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import type {CandidateReceipt,WikiCompileRequest,WikiCompileResult} from '../../../packages/knowledge-contracts/src/index.ts';
import type {ReadContext,WikiCompileOperationPort} from '../../../packages/knowledge-application/src/index.ts';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {migrateKnowledge} from '../../../packages/knowledge/src/migrations.ts';
import {assertKnowledgeWriterAuthority,rotateKnowledgeWriterAuthority} from '../../../packages/knowledge/src/writer-authority.ts';
import {createPgWikiCompilations,migrateWikiCompilations,WikiCompileCommitUnknownError} from '../../../packages/adapters/knowledge-service/src/wiki-compile.ts';

const databaseUrl=readTestDatabase(),dbTest=databaseUrl?test:test.skip;
const hasCode=(code:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&error.code===code;

async function fixture(run:(input:{pool:pg.Pool;context:ReadContext;grant:Awaited<ReturnType<typeof rotateKnowledgeWriterAuthority>>})=>Promise<void>){
  const admin=new pg.Pool({connectionString:databaseUrl!,max:2}),schema=`ccl_wiki_compile_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString:databaseUrl!,max:6,options:`-c search_path=${schema}`});
  try{
    await migrateKnowledge(pool);await migrateWikiCompilations(pool);
    const projectId=`synthetic-${randomUUID()}`;
    const grant=await rotateKnowledgeWriterAuthority(pool,projectId,null,{ownerId:'wiki-compile-test',mode:'active'});
    const context:ReadContext={scope:{projectId,spaceId:'wiki-space'},purpose:'exploration_reading',
      principal:{id:'wiki-principal',clientInstallationId:'wiki-installation',projectId,
        spaceIds:['wiki-space','other-space'],purposes:['exploration_reading','other-purpose']}};
    await run({pool,context,grant});
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
}

function request(purpose='exploration_reading'):WikiCompileRequest{
  return {question:'What should the synthetic wiki draft say?',purpose,sourceEventIds:[randomUUID()],
    queries:['synthetic topic'],limit:5,maxPages:2,
    budget:{maxModelCalls:1,maxReadBytes:100_000,deadline:new Date(Date.now()+3_600_000).toISOString(),maxMoney:null}};
}
function initial(input:WikiCompileRequest,id=randomUUID()):WikiCompileResult{
  return {id,question:input.question,purpose:input.purpose,state:'reserved',drafts:[],candidate:null,
    stageStatus:'not_requested',evidence:[],excluded:[],readUsage:{wikiPayloadBytes:0,sourceContentBytes:0,
      preparedInputBytes:0,maxReadBytes:input.budget.maxReadBytes},readsetFingerprint:'0'.repeat(64),
    coverage:{scopeDescription:'synthetic wiki scope',returned:0,loaded:0,hasMore:false,nextCursor:null,
      completeness:'unknown',omittedReasons:['Compilation has not started'],
      snapshot:{publicationEpoch:null,consistency:'single_scope_snapshot'}},
    cost:{modelCalls:{state:'known',value:0},tokens:{state:'known',value:0},
      money:{state:'known',amount:0,currency:'USD',source:'no_provider_call'}},
    provider:null,reason:'Compilation reserved',gaps:[],createdAt:new Date().toISOString(),completedAt:null};
}

async function persistSyntheticStage(pool:pg.Pool,context:ReadContext,
  grant:Awaited<ReturnType<typeof rotateKnowledgeWriterAuthority>>,id:string,requestHash:string,candidate:CandidateReceipt){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');await assertKnowledgeWriterAuthority(client,context.scope.projectId,grant);
    await client.query(`INSERT INTO ccl_knowledge_changesets
      (project_id,id,request_key,request_hash,content_hash,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
      [context.scope.projectId,id,`wiki-compile:${id}`,requestHash,candidate.contentHash,
        JSON.stringify({id,projectId:context.scope.projectId,purpose:context.purpose,proposer:context.principal.id})]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

dbTest('compilation reservation is atomic and isolated by installation, scope, principal and purpose',async()=>fixture(async({pool,context,grant})=>{
  const ledger:WikiCompileOperationPort=createPgWikiCompilations(pool,grant),input=request(),key=randomUUID(),hash='a'.repeat(64);
  const [a,b]=await Promise.all([ledger.reserve(context,key,hash,input,initial(input)),
    ledger.reserve(context,key,hash,input,initial(input))]);
  assert.equal([a,b].filter(value=>value.created).length,1);
  assert.equal(a.result.id,b.result.id);
  assert.equal((await ledger.lookup(context,key))?.id,a.result.id);
  assert.equal(await ledger.lookup(context,randomUUID()),null);
  for(const foreign of [
    {...context,principal:{...context.principal,clientInstallationId:'other-installation'}},
    {...context,principal:{...context.principal,id:'other-principal'}},
    {...context,scope:{...context.scope,spaceId:'other-space'}},
    {...context,purpose:'other-purpose'},
  ]){
    assert.equal(await ledger.get(foreign,a.result.id),null);
    assert.equal(await ledger.lookup(foreign,key),null);
  }
  await assert.rejects(ledger.reserve(context,key,'b'.repeat(64),input,initial(input)),hasCode('IDEMPOTENCY_CONFLICT'));
  const changed={...input,question:'A different question'};
  await assert.rejects(ledger.reserve(context,key,hash,changed,initial(changed)),hasCode('IDEMPOTENCY_CONFLICT'));
  const changedSource={...input,sourceEventIds:[randomUUID()]};
  await assert.rejects(ledger.reserve(context,key,hash,changedSource,initial(changedSource)),hasCode('IDEMPOTENCY_CONFLICT'));
  const otherInstallation={...context,principal:{...context.principal,clientInstallationId:'other-installation'}};
  const separate=await ledger.reserve(otherInstallation,key,hash,input,initial(input));
  assert.equal(separate.created,true);assert.notEqual(separate.result.id,a.result.id);
  assert.equal((await ledger.lookup(otherInstallation,key))?.id,separate.result.id);
  await assert.rejects(ledger.checkpoint(context,a.result.id,{...a.result,state:'running'}),hasCode('WIKI_COMPILE_NOT_RUNNING'));
  await assert.rejects(ledger.finish(context,a.result.id,{...a.result,state:'failed'}),hasCode('WIKI_COMPILE_NOT_RUNNING'));
  const [first,again]=await Promise.all([ledger.start(context,a.result.id),ledger.start(context,a.result.id)]);
  assert.deepEqual([first,again].sort(),[false,true]);
  assert.equal((await ledger.get(context,a.result.id))?.cost.money.state,'unknown');
  assert.equal(await ledger.start(context,a.result.id),false);
  const running=(await ledger.get(context,a.result.id))!;
  await assert.rejects(ledger.finish(context,a.result.id,running),hasCode('WIKI_COMPILE_NOT_TERMINAL'));
  const terminal:WikiCompileResult={...running,state:'no_change',reason:'No supported change',completedAt:new Date().toISOString()};
  await ledger.finish(context,a.result.id,terminal);
  assert.equal((await ledger.get(context,a.result.id))?.state,'no_change');
  await assert.rejects(ledger.finish(context,a.result.id,terminal),hasCode('WIKI_COMPILE_NOT_RUNNING'));
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM ccl_knowledge_compilations')).rows[0].n),2);
}));

dbTest('deadline reconciles reserved and checkpointed running rows without restarting or losing cost',async()=>fixture(async({pool,context,grant})=>{
  const ledger=createPgWikiCompilations(pool,grant),input=request();
  input.budget.deadline=new Date(Date.now()+1_000).toISOString();
  const reserved=await ledger.reserve(context,'reserved','c'.repeat(64),input,initial(input));
  const running=await ledger.reserve(context,'running','d'.repeat(64),input,initial(input));
  assert.equal(await ledger.start(context,running.result.id),true);
  const current=(await ledger.get(context,running.result.id))!;
  const ref={...context.scope,domain:'knowledge' as const,objectId:randomUUID(),versionId:randomUUID(),contentDigest:'e'.repeat(64)};
  const checkpoint:WikiCompileResult={...current,evidence:[{id:'page-1',kind:'wiki_page',ref,title:'Synthetic page',
    locator:null,conditions:[],counterexamples:[],unknowns:[],actualReadCoverage:[]}],
    cost:{modelCalls:{state:'known',value:1},tokens:{state:'known',value:42},
      money:{state:'unknown',reason:'Synthetic billing receipt unavailable'}},
    readsetFingerprint:'f'.repeat(64),reason:'Exact readset and provider cost checkpointed'};
  await ledger.checkpoint(context,running.result.id,checkpoint);
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(input.budget.deadline)-Date.now()+40)));
  assert.equal(await ledger.start(context,reserved.result.id),false);
  const failed=await ledger.lookup(context,'reserved');
  assert.equal(failed?.state,'failed');assert.match(failed!.reason,/no provider was invoked/);
  assert.deepEqual(failed?.cost,reserved.result.cost);assert.ok(failed?.completedAt);
  const unknown=await ledger.get(context,running.result.id);
  assert.equal(unknown?.state,'outcome_unknown');assert.ok(unknown?.completedAt);
  assert.deepEqual(unknown?.cost,checkpoint.cost);assert.deepEqual(unknown?.evidence,checkpoint.evidence);
  assert.equal((await ledger.reserve(context,'running','d'.repeat(64),input,initial(input))).result.state,'outcome_unknown');
  assert.equal(await ledger.start(context,running.result.id),false);
  assert.deepEqual((await pool.query('SELECT state FROM ccl_knowledge_compilations ORDER BY request_key')).rows.map(row=>row.state),
    ['failed','outcome_unknown']);
}));

dbTest('checkpoint and finish reject changed identity, foreign refs and unsupported draft evidence',async()=>fixture(async({pool,context,grant})=>{
  const ledger=createPgWikiCompilations(pool,grant),input=request(),saved=await ledger.reserve(context,'identity','1'.repeat(64),input,initial(input));
  assert.equal(await ledger.start(context,saved.result.id),true);
  const running=(await ledger.get(context,saved.result.id))!;
  await assert.rejects(ledger.checkpoint(context,saved.result.id,{...running,id:randomUUID()}),hasCode('WIKI_COMPILE_IDENTITY_MISMATCH'));
  await assert.rejects(ledger.checkpoint(context,saved.result.id,{...running,state:'reserved'}),hasCode('WIKI_COMPILE_CHECKPOINT_NOT_RUNNING'));
  const foreign={...context.scope,spaceId:'other-space',domain:'knowledge' as const,
    objectId:randomUUID(),versionId:randomUUID(),contentDigest:'2'.repeat(64)};
  const bad={...running,excluded:[{ref:foreign,reason:'Unrelated'}]};
  await assert.rejects(ledger.checkpoint(context,saved.result.id,bad),hasCode('WIKI_COMPILE_SCOPE_MISMATCH'));
  const draft={targetEvidenceId:null,profile:{id:'synthetic',version:'1',digest:'3'.repeat(64)},
    identityKey:'synthetic-draft',title:'Synthetic draft',summary:'Synthetic summary',conditions:[],counterexamples:[],
    unknowns:[],nextQuestions:[],supportEvidenceIds:['missing-evidence'],rationale:'Synthetic rationale'};
  await assert.rejects(ledger.checkpoint(context,saved.result.id,{...running,drafts:[draft]}),
    hasCode('WIKI_COMPILE_EVIDENCE_MISMATCH'));
  const terminal:WikiCompileResult={...running,state:'needs_evidence',reason:'No supported draft',completedAt:new Date().toISOString()};
  await assert.rejects(ledger.finish(context,saved.result.id,{...terminal,question:'Other question'}),hasCode('WIKI_COMPILE_IDENTITY_MISMATCH'));
  await assert.rejects(ledger.finish(context,saved.result.id,{...terminal,candidate:{candidateId:randomUUID(),
    changeSetId:randomUUID(),draftRefs:[foreign],contentHash:'4'.repeat(64),published:false}}),
  hasCode('WIKI_COMPILE_SCOPE_MISMATCH'));
  await ledger.finish(context,saved.result.id,terminal);
}));

dbTest('draft-ready and staged terminal results retain exact drafts, candidate and acknowledged cost',async()=>fixture(async({pool,context,grant})=>{
  const ledger=createPgWikiCompilations(pool,grant),input=request();
  const ref={...context.scope,domain:'knowledge' as const,objectId:randomUUID(),versionId:randomUUID(),contentDigest:'5'.repeat(64)};
  const evidence={id:'wiki-1',kind:'wiki_page' as const,ref,title:'Synthetic page',locator:null,
    conditions:[],counterexamples:[],unknowns:[],actualReadCoverage:[]};
  const draft={targetEvidenceId:'wiki-1',profile:{id:'synthetic',version:'1',digest:'6'.repeat(64)},
    identityKey:'synthetic-identity',title:'Synthetic draft',summary:'A bounded draft',conditions:[],counterexamples:[],
    unknowns:[],nextQuestions:[],supportEvidenceIds:['wiki-1'],rationale:'Supported by the frozen page'};
  const cost:WikiCompileResult['cost']={modelCalls:{state:'known',value:1},tokens:{state:'known',value:54},
    money:{state:'known',amount:0.02,currency:'USD',source:'synthetic-provider-receipt'}};
  for(const [key,state] of [['draft-ready','draft_ready'],['staged','waiting_for_review']] as const){
    const saved=await ledger.reserve(context,key,key==='staged'?'7'.repeat(64):'8'.repeat(64),input,initial(input));
    assert.equal(await ledger.start(context,saved.result.id),true);
    const running:WikiCompileResult={...(await ledger.get(context,saved.result.id))!,evidence:[evidence],drafts:[draft],cost,
      provider:{id:'synthetic-provider',modelRequested:'synthetic-model',modelReturned:'synthetic-model',requestId:'receipt-1'},
      reason:'Provider proposal acknowledged'};
    await ledger.checkpoint(context,saved.result.id,running);
    const candidate=state==='waiting_for_review'?{candidateId:randomUUID(),changeSetId:randomUUID(),
      draftRefs:[ref],contentHash:'9'.repeat(64),published:false as const}:null;
    const terminal:WikiCompileResult={...running,state,candidate,
      stageStatus:state==='waiting_for_review'?'staged':'not_configured',completedAt:new Date().toISOString()};
    await ledger.finish(context,saved.result.id,terminal);
    const stored=await ledger.lookup(context,key);
    assert.deepEqual(stored?.drafts,[draft]);assert.deepEqual(stored?.candidate,candidate);
    assert.deepEqual(stored?.cost,cost);assert.equal(stored?.state,state);
  }
}));

dbTest('reconcileCandidate attaches an already staged receipt after finish failure and fences conflicts',async()=>fixture(async({pool,context,grant})=>{
  const ledger=createPgWikiCompilations(pool,grant),input=request(),id=randomUUID(),hash='a'.repeat(64);
  const saved=await ledger.reserve(context,'stage-recovery','a'.repeat(64),input,initial(input,id));
  assert.equal(await ledger.start(context,id),true);
  const ref={...context.scope,domain:'knowledge' as const,objectId:randomUUID(),versionId:randomUUID(),contentDigest:'b'.repeat(64)};
  const evidence={id:'wiki-1',kind:'wiki_page' as const,ref,title:'Exact page',locator:null,
    conditions:[],counterexamples:[],unknowns:[],actualReadCoverage:[]};
  const draft={targetEvidenceId:'wiki-1',profile:{id:'synthetic',version:'1',digest:'c'.repeat(64)},
    identityKey:'synthetic-identity',title:'Recovered draft',summary:'Exact staged proposal',conditions:[],
    counterexamples:[],unknowns:[],nextQuestions:[],supportEvidenceIds:['wiki-1'],rationale:'Exact receipt'};
  const cost:WikiCompileResult['cost']={modelCalls:{state:'known',value:1},tokens:{state:'known',value:10},
    money:{state:'known',amount:0.01,currency:'USD',source:'synthetic-provider-receipt'}};
  const checkpoint:WikiCompileResult={...(await ledger.get(context,id))!,evidence:[evidence],drafts:[draft],
    stageIntent:{requestHash:hash},cost,reason:'Provider proposal acknowledged',readsetFingerprint:'d'.repeat(64)};
  await ledger.checkpoint(context,id,checkpoint);
  await assert.rejects(ledger.checkpoint(context,id,{...checkpoint,stageIntent:{requestHash:'e'.repeat(64)}}),
    hasCode('WIKI_COMPILE_STAGE_INTENT_CHANGED'));
  await assert.rejects(ledger.checkpoint(context,id,{...checkpoint,drafts:[]}),hasCode('WIKI_COMPILE_STAGE_INTENT_CHANGED'));
  const candidate={candidateId:id,changeSetId:id,draftRefs:[ref],contentHash:'f'.repeat(64),published:false as const};
  await assert.rejects(ledger.reconcileCandidate(context,id,hash,candidate),hasCode('WIKI_COMPILE_CANDIDATE_NOT_STAGED'));
  await persistSyntheticStage(pool,context,grant,id,hash,candidate);
  await pool.query(`CREATE FUNCTION fail_compile_finish() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic finish failed after stage'; END; $$;
    CREATE TRIGGER fail_compile_finish BEFORE UPDATE ON ccl_knowledge_compilations
      FOR EACH ROW WHEN (NEW.state='waiting_for_review') EXECUTE FUNCTION fail_compile_finish()`);
  await assert.rejects(ledger.finish(context,id,{...checkpoint,state:'waiting_for_review',stageStatus:'staged',candidate,
    completedAt:new Date().toISOString()}),/synthetic finish failed after stage/);
  assert.equal((await ledger.get(context,id))?.state,'running');
  await pool.query('DROP TRIGGER fail_compile_finish ON ccl_knowledge_compilations');
  await assert.rejects(ledger.reconcileCandidate(context,id,'e'.repeat(64),candidate),hasCode('WIKI_COMPILE_STAGE_INTENT_MISMATCH'));
  await assert.rejects(ledger.reconcileCandidate(context,id,hash,{...candidate,candidateId:randomUUID()}),
    hasCode('WIKI_COMPILE_CANDIDATE_MISMATCH'));
  await assert.rejects(ledger.reconcileCandidate(context,id,hash,{...candidate,draftRefs:[{...ref,spaceId:'other-space'}]}),
    hasCode('WIKI_COMPILE_SCOPE_MISMATCH'));
  const recovered=await ledger.reconcileCandidate(context,id,hash,candidate);
  assert.equal(recovered.state,'waiting_for_review');assert.equal(recovered.stageStatus,'staged');
  assert.ok(recovered.completedAt);assert.deepEqual(recovered.candidate,candidate);
  assert.deepEqual(recovered.drafts,checkpoint.drafts);assert.deepEqual(recovered.cost,cost);
  assert.deepEqual(recovered.evidence,checkpoint.evidence);assert.deepEqual(recovered.stageIntent,checkpoint.stageIntent);
  assert.deepEqual(await ledger.reconcileCandidate(context,id,hash,candidate),recovered);
  await assert.rejects(ledger.reconcileCandidate(context,id,hash,{...candidate,contentHash:'1'.repeat(64)}),
    hasCode('WIKI_COMPILE_CANDIDATE_MISMATCH'));
  const foreign={...context,principal:{...context.principal,clientInstallationId:'other-installation'}};
  await assert.rejects(ledger.reconcileCandidate(foreign,id,hash,candidate),hasCode('WIKI_COMPILE_NOT_FOUND'));
  await rotateKnowledgeWriterAuthority(pool,context.scope.projectId,grant.generation,
    {ownerId:grant.ownerId,mode:'read_only'},grant);
  await assert.rejects(ledger.reconcileCandidate(context,id,hash,candidate),hasCode('KNOWLEDGE_WRITER_REVOKED'));
  assert.equal(saved.result.state,'reserved');
}));

dbTest('expired checkpoint with known provider cost can attach a saved candidate; unknown money cannot',async()=>fixture(async({pool,context,grant})=>{
  const ledger=createPgWikiCompilations(pool,grant),input=request();
  input.budget.deadline=new Date(Date.now()+1_000).toISOString();
  const stageHash='2'.repeat(64),ref={...context.scope,domain:'knowledge' as const,
    objectId:randomUUID(),versionId:randomUUID(),contentDigest:'3'.repeat(64)};
  const draft={targetEvidenceId:'page',profile:{id:'synthetic',version:'1',digest:'4'.repeat(64)},identityKey:'page',
    title:'Draft',summary:'Supported draft',conditions:[],counterexamples:[],unknowns:[],nextQuestions:[],
    supportEvidenceIds:['page'],rationale:'Exact read'};
  const evidence={id:'page',kind:'wiki_page' as const,ref,title:'Page',locator:null,
    conditions:[],counterexamples:[],unknowns:[],actualReadCoverage:[]};
  const entries=[];
  for(const [key,moneyKnown] of [['known',true],['unknown',false]] as const){
    const saved=await ledger.reserve(context,key,key==='known'?'5'.repeat(64):'6'.repeat(64),input,initial(input));
    assert.equal(await ledger.start(context,saved.result.id),true);
    await ledger.checkpoint(context,saved.result.id,{...(await ledger.get(context,saved.result.id))!,drafts:[draft],
      evidence:[evidence],stageIntent:{requestHash:stageHash},cost:{modelCalls:{state:'known',value:1},
        tokens:{state:'known',value:20},money:moneyKnown?{state:'known',amount:0,currency:'USD',source:'synthetic-receipt'}:
          {state:'unknown',reason:'Billing unconfirmed'}}});
    entries.push(saved.result.id);
  }
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(input.budget.deadline)-Date.now()+40)));
  const [known,unknown]=entries;
  assert.equal((await ledger.get(context,known))?.state,'outcome_unknown');
  assert.equal((await ledger.lookup(context,'unknown'))?.state,'outcome_unknown');
  const candidate=(id:string)=>({candidateId:id,changeSetId:id,draftRefs:[ref],contentHash:'7'.repeat(64),published:false as const});
  await persistSyntheticStage(pool,context,grant,known,stageHash,candidate(known));
  await persistSyntheticStage(pool,context,grant,unknown,stageHash,candidate(unknown));
  await assert.rejects(ledger.reconcileCandidate(context,unknown,stageHash,candidate(unknown)),hasCode('WIKI_COMPILE_COST_UNKNOWN'));
  assert.equal((await ledger.get(context,unknown))?.state,'outcome_unknown');
  const recovered=await ledger.reconcileCandidate(context,known,stageHash,candidate(known));
  assert.equal(recovered.state,'waiting_for_review');assert.equal(recovered.cost.money.state,'known');
  assert.deepEqual(recovered.drafts,[draft]);
}));

dbTest('writer guard blocks direct writes and lost commit acknowledgement keeps operation ID',async()=>fixture(async({pool,context,grant})=>{
  const input=request(),id=randomUUID(),key='commit-unknown';
  let loseCommit=true;
  const uncertainPool={connect:async()=>{
    const client=await pool.connect();
    return new Proxy(client,{get(target,property){
      if(property==='query')return async (...args:unknown[])=>{
        const value=await (target.query as (...values:unknown[])=>Promise<unknown>)(...args);
        if(args[0]==='COMMIT'&&loseCommit){loseCommit=false;throw new Error('Synthetic ACK lost');}
        return value;
      };
      const value=Reflect.get(target,property);
      return typeof value==='function'?value.bind(target):value;
    }});
  }} as unknown as pg.Pool;
  const uncertain=createPgWikiCompilations(uncertainPool,grant),normal=createPgWikiCompilations(pool,grant);
  await assert.rejects(uncertain.reserve(context,key,'3'.repeat(64),input,initial(input,id)),
    (error:unknown)=>error instanceof WikiCompileCommitUnknownError&&error.commitStatus==='unknown'&&error.operationId===id);
  assert.equal((await normal.lookup(context,key))?.id,id);
  assert.equal((await normal.reserve(context,key,'3'.repeat(64),input,initial(input))).created,false);
  await assert.rejects(pool.query("UPDATE ccl_knowledge_compilations SET state='running' WHERE id=$1",[id]),
    (error:unknown)=>error instanceof Error&&/KNOWLEDGE_WRITER_REVOKED/.test(error.message));
  await rotateKnowledgeWriterAuthority(pool,context.scope.projectId,grant.generation,
    {ownerId:grant.ownerId,mode:'read_only'},grant);
  assert.equal((await normal.get(context,id))?.state,'reserved');
  await assert.rejects(normal.start(context,id),hasCode('KNOWLEDGE_WRITER_REVOKED'));
}));
