import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import pg from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {seedKnowledgeSyntheticFixture} from '../../../scripts/runtime/knowledge-synthetic-fixture.ts';
import {createKnowledgeApi} from '../src/index.ts';
import {createKnowledgeClient} from '../../../packages/knowledge-client/src/index.ts';
import type {DecisionProvider,WikiCompiler,QueryAnswerer} from '@commerce/knowledge-application';

const url=readTestDatabase(),dbTest=url?test:test.skip;
const zero={modelCalls:{state:'known' as const,value:0},tokens:{state:'known' as const,value:0},
  money:{state:'known' as const,amount:0,currency:'USD',source:'synthetic_no_model'}};

dbTest('periodic Wiki discovery reaches independent review and an exact Ask answer without source events or paid calls',
  {timeout:120_000},async()=>{
  const admin=new pg.Pool({connectionString:url!,max:2});
  const schema=`periodic_coord_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString:url!,max:12,options:`-c search_path=${schema}`});
  const servers:Server[]=[];
  try{
    const reviewerId=`periodic-reviewer-${randomUUID()}`;
    const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-periodic-${randomUUID()}`,
      'periodic-space',{readerIds:[reviewerId]});
    const purpose='exploration_reading',scope={projectId:seed.projectId,spaceId:seed.spaceId};
    const title='周期关系合成认识',identity=`periodicfixture${randomUUID().replaceAll('-','')}`;
    let decisions=0,compilations=0,answers=0,judgedRefs:string[]=[];
    const decision:DecisionProvider={id:'synthetic-periodic-decision',version:'1',model:'synthetic-no-model',
      execution:'local_deterministic',async decide(input){
        decisions++;
        assert.equal(input.state.left.kind,'wiki_page');assert.equal(input.state.right.kind,'wiki_page');
        const left=(input.state.left.sourceGroups??[]).map(group=>group.id);
        const right=(input.state.right.sourceGroups??[]).map(group=>group.id);
        assert.ok(left.some(id=>right.includes(id)),'shared original group is visible to the provider');
        judgedRefs=[input.state.left.ref.objectId,input.state.right.ref.objectId];
        return {cost:zero,result:{modelReturned:'synthetic-no-model',inputTokens:0,outputTokens:0,
          requestId:`periodic-decision-${decisions}`,raw:{syntheticFixture:true},
          answers:input.questions.map(question=>question.type==='predicate'?
            {id:question.id,type:question.type,state:'answered' as const,value:null,probability:0.5,
              distribution:null,confidence:null,reason:'Synthetic comparison only'}:
            question.type==='choice'?
              {id:question.id,type:question.type,state:'answered' as const,value:'context',probability:null,
                distribution:Object.fromEntries(question.options.map(option=>[option.value,option.value==='context'?1:0])),
                confidence:null,reason:'Shared origin is not independent support'}:
              {id:question.id,type:question.type,state:'not_evaluated' as const,value:null,probability:null,
                distribution:null,confidence:null,reason:'Synthetic comparison only'})}};
      }};
    const compiler:WikiCompiler={id:'synthetic-periodic-compiler',model:'synthetic-no-model',
      methodVersion:'periodic-fixture/1',execution:'local_deterministic',async compile(input){
        compilations++;
        assert.ok(input.evidence.length>=2&&input.evidence.every(item=>item.kind==='wiki_page'),
          'Wiki-only compilation never receives source content');
        assert.equal(input.relationHints?.length,1);
        assert.equal(input.relationHints?.[0].sourceRelation,'same_original',
          'two Wiki pages derived from one source are not independent votes');
        assert.ok(judgedRefs.every(objectId=>input.evidence.some(item=>item.ref.objectId===objectId)),
          'both exact judged Wiki endpoints were read into the compiler');
        const selected=input.evidence.slice(0,2);
        assert.ok(selected.every(item=>item.ref.contentDigest&&item.storageDigest&&item.body.length>0));
        assert.notEqual(selected[0].ref.objectId,selected[1].ref.objectId);
        const profile=input.profiles.find(item=>item.id==='synthesis');assert.ok(profile);
        return {proposal:{outcome:'proposed',drafts:[{targetEvidenceId:null,profile,identityKey:identity,title,
          summary:'两份合成 Wiki 可作有条件的关系研究，尚不能证明独立支持。',
          conditions:['仅限合成工程资料和同一研究目的'],
          counterexamples:['相同来源的重复表述不是独立证据'],
          unknowns:['真实语义关系尚未验证'],nextQuestions:['能否取得不同原始来源的观察？'],
          supportEvidenceIds:selected.map(item=>item.id),
          rationale:'Two exact Wiki versions were read; relation judgment is advisory and sources share one origin'}],
          reason:'Synthetic Wiki-only proposal for independent review',gaps:['No real semantic acceptance']},
          cost:zero,modelReturned:'synthetic-no-model',requestId:`periodic-compile-${compilations}`};
      }};
    const answerer:QueryAnswerer={id:'synthetic-periodic-answerer',model:'synthetic-no-model',
      supportsMoneyLimit:true,async answer(input){answers++;
        const selected=input.evidence.find(item=>item.kind==='wiki_page'&&item.title===title);
        assert.ok(selected,'Ask reads the newly published exact Wiki');
        return {answer:{outcome:'answered',claims:[{text:'合成条目仅记录待验证的条件关系',
          evidenceIds:[selected.id]}],reason:'Synthetic no-model answer',gaps:['No real semantic acceptance']},
          cost:zero,modelReturned:'synthetic-no-model',requestId:`periodic-answer-${answers}`};
      }};
    const actions=[...new Set([...seed.authorization.actions,'maintenance:read','maintenance:write',
      'compile:read','compile:write','judgments:read','judgments:write','ask:write',
      'review:request','review:decide','review:read'])];
    assert.equal(actions.includes('ingest:read'),false,'Wiki-only path needs no source-event read action');
    const auth={...seed.authorization,actions};
    async function start(id:string,installation:string,coordinated:boolean){
      const token=`synthetic-${randomUUID()}-${randomUUID()}`;
      const api=await createKnowledgeApi({pool,token,port:0,
        principal:{...seed.principal,id,clientInstallationId:installation},writerGrant:seed.writerGrant,
        enableSourceIngest:true,enableMaintenance:true,compiler,decisionProvider:decision,answerer,
        capabilities:auth,sourceReaderIds:[seed.principal.id,reviewerId],syntheticFixture:true,
        ...coordinated?{coordinationPolicy:{version:'periodic-fixture/1',maxCandidates:3,maxPairs:1,
          queryLimit:5,budget:{maxModelCalls:0,maxReadBytes:10_000_000,maxMoney:{amount:0,currency:'USD'},
            timeoutMs:120_000}}}:{}});
      const server=await api.listen();servers.push(server);
      const address=server.address();assert.ok(address&&typeof address!=='string');
      return createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope,
        headers:{Authorization:`Bearer ${token}`}});
    }
    const owner=await start(seed.principal.id,seed.principal.clientInstallationId!,true);
    const reviewer=await start(reviewerId,'periodic-reviewer-install',false);
    const capabilities=(await owner.capabilities()).data;
    assert.ok(capabilities.permittedActions.includes('runSemanticSweep'));
    assert.ok(capabilities.permittedActions.includes('compileWiki'),
      'Wiki-only compilation is advertised without ingest:read');
    assert.ok(!capabilities.permittedActions.includes('sourceEvent'));
    const sourceEvents=()=>pool.query<{n:number}>('SELECT count(*)::int n FROM ccl_knowledge_source_events');
    // A seed source may exist, but no source-intake event is registered for this periodic path.
    assert.equal((await sourceEvents()).rows[0].n,0);
    const sweepRequest={purpose,cycleKey:`periodic-${randomUUID()}`,shard:0,shardCount:1,limit:10,
      maxTasksPerShard:64,methodVersion:'periodic-fixture/1',rubricVersion:'periodic-relations/1'};
    const key=`periodic-sweep-${randomUUID()}`;
    let pass=(await owner.runSemanticSweep(sweepRequest,{idempotencyKey:key,purpose})).data;
    while(!pass.complete){assert.equal(pass.limitReached,false);
      pass=(await owner.runSemanticSweep(sweepRequest,{idempotencyKey:key,purpose})).data;}
    assert.equal(pass.taskCount,32,'the synthetic fixture exposes 32 current Wiki pages');
    assert.equal(pass.scanned,32);
    const taskPage=(await owner.maintenanceTasks(purpose,{limit:100})).data;
    const periodic=taskPage.items.filter(task=>task.trigger.stream==='periodic');
    assert.equal(periodic.length,32);
    assert.ok(periodic.every(task=>task.request.kind==='relation_check'&&
      task.request.sourceEventIds.length===0&&task.request.subjectRef?.domain==='knowledge'&&
      task.request.subjectRef.contentDigest===null&&task.trigger.sourceEventId===null&&
      JSON.stringify(task.trigger.ref)===JSON.stringify(task.request.subjectRef)));
    const cancelled=await owner.cancelMaintenance(periodic.at(-1)!.id,purpose,
      {idempotencyKey:`cancel-${randomUUID()}`,purpose});
    assert.equal(cancelled.data.state,'cancelled');
    let selectedTask:typeof periodic[number]|null=null;
    let selectedRunId:string|null=null;
    let sawNeedsEvidence=false;
    for(let attempt=0;attempt<32;attempt++){
      const processed=(await owner.processMaintenance(purpose,
        {idempotencyKey:`periodic-process-${attempt}`,purpose})).data;
      if(!processed)break;
      assert.ok(['waiting_for_review','needs_evidence'].includes(processed.state),JSON.stringify(processed));
      const run=(await owner.coordinationForTask(processed.id,purpose)).data;
      assert.ok(run);assert.equal(run.request.sourceEventId,null);
      assert.deepEqual(run.request.subjectRef,processed.request.subjectRef);
      assert.equal(run.sourcePlanId,null);
      if(processed.state==='needs_evidence'){
        sawNeedsEvidence=true;
        assert.equal(run.candidateRefs.length,1,'a single readable anchor is not promoted to a relation');
        assert.deepEqual(run.judgmentIds,[]);assert.equal(run.compilationId,null);
        continue;
      }
      selectedTask=processed;selectedRunId=run.id;break;
    }
    assert.ok(selectedTask&&selectedRunId,'a bounded Wiki pair should reach independent review');
    const task=selectedTask!,run=(await owner.coordinationRun(selectedRunId!,purpose)).data;
    assert.equal(run.state,'waiting_for_review');assert.equal(run.steps.length,3);
    assert.ok(run.candidateRefs.length>=2&&run.candidateRefs.length<=3);
    assert.equal(run.judgmentIds.length,1);
    const judgment=(await owner.judgment(run.judgmentIds[0],purpose)).data;
    assert.equal(judgment.sourceRelation,'same_original');
    assert.equal(judgment.evidence.length,2);
    assert.deepEqual(judgment.cost.modelCalls,{state:'known',value:0});
    const compilation=(await owner.compilation(run.compilationId!,purpose)).data;
    assert.equal(compilation.state,'waiting_for_review',JSON.stringify(compilation));
    assert.deepEqual(compilation.cost.modelCalls,{state:'known',value:0});
    assert.ok(compilation.evidence.length>=2&&compilation.evidence.every(item=>item.kind==='wiki_page'));
    assert.ok(compilation.drafts[0].supportEvidenceIds.every(id=>compilation.evidence.some(item=>item.id===id)));
    assert.equal((await sourceEvents()).rows[0].n,0);
    const candidate=compilation.candidate!;
    const ticket=(await owner.requestReview({target:{kind:'candidate',candidateId:candidate.candidateId,
      contentHash:candidate.contentHash},purpose},{idempotencyKey:`periodic-ticket-${task.id}`,purpose})).data;
    const approved=(await reviewer.decideReview(ticket.id,{expectedDigest:candidate.contentHash,
      decision:'exploration_only',reason:'Independent approval of a synthetic engineering fixture only',
      conditions:[],gaps:[]},{idempotencyKey:`periodic-approve-${task.id}`,purpose})).data;
    const published=approved.publication!.refs[0];
    assert.equal((await owner.compilation(compilation.id,purpose)).data.state,'published');
    assert.equal((await owner.coordinationForTask(task.id,purpose)).data!.state,'completed');
    assert.equal((await owner.maintenanceTask(task.id,purpose)).data.state,'completed');
    assert.equal((await owner.maintenanceTask(cancelled.data.id,purpose)).data.state,'cancelled');
    assert.equal((await owner.coordinationForTask(cancelled.data.id,purpose)).data,null);
    const found=(await owner.query({question:title,purpose,limit:5,retrievalMethod:'wiki-lexical-v2'})).data;
    const current=found.items.find(item=>item.ref.objectId===published.objectId&&item.ref.versionId===published.versionId);
    assert.ok(current,'published candidate is visible as the current exact Wiki');
    const askRequest={question:title,purpose,limit:5,maxPages:1,includeSourceContent:false,
      selectedRefs:[current.ref],budget:{maxModelCalls:1,maxReadBytes:500_000,
        maxMoney:{amount:0,currency:'USD' as const},deadline:new Date(Date.now()+60_000).toISOString()}};
    const askKey=`periodic-ask-${randomUUID()}`;
    const answered=(await owner.ask(askRequest,{idempotencyKey:askKey,purpose})).data;
    assert.equal(answered.state,'answered');
    assert.ok(answered.evidence.some(item=>item.ref.objectId===published.objectId&&
      item.ref.versionId===published.versionId));
    assert.equal(answered.cost.modelCalls.state,'known');
    assert.deepEqual(answered.cost.modelCalls,{state:'known',value:0});
    assert.equal((await owner.ask(askRequest,{idempotencyKey:askKey,purpose})).data.id,answered.id);
    assert.equal((await owner.lookupAnswer(askKey,purpose)).data.answer?.id,answered.id);
    const before={decisions,compilations,answers};
    assert.equal((await owner.runSemanticSweep(sweepRequest,{idempotencyKey:key,purpose})).data.id,pass.id);
    assert.equal((await owner.semanticSweep(pass.id,purpose)).data.taskCount,32);
    assert.equal((await owner.coordinationForTask(task.id,purpose)).data!.state,'completed');
    assert.deepEqual({decisions,compilations,answers},before,'GET and cycle replay do not dispatch providers');
    assert.equal((await sourceEvents()).rows[0].n,0);
    assert.ok(sawNeedsEvidence||run.gaps.length>0,'bounded discovery records its retrieval limit');
  }finally{
    for(const server of servers)await new Promise<void>(resolve=>server.close(()=>resolve()));
    await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();
  }
});
