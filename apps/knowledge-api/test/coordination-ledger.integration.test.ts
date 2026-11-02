import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import type {ReadContext} from '../../../packages/knowledge-application/src/index.ts';
import type {CoordinationRun,CoordinationStep,MaintenanceTask} from '../../../packages/knowledge-contracts/src/index.ts';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {migrateKnowledge} from '../../../packages/knowledge/src/migrations.ts';
import {rotateKnowledgeWriterAuthority} from '../../../packages/knowledge/src/writer-authority.ts';
import {migrateSourceIntake} from '../../../packages/adapters/knowledge-service/src/source-intake.ts';
import {createPgMaintenanceTasks,migrateMaintenanceTasks} from '../../../packages/adapters/knowledge-service/src/maintenance-tasks.ts';
import {createPgCoordinationRuns,migrateCoordinationRuns,CoordinationCommitUnknownError} from '../../../packages/adapters/knowledge-service/src/coordination.ts';

const databaseUrl=readTestDatabase(),dbTest=databaseUrl?test:test.skip;
const hasCode=(code:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&error.code===code;
const zero:CoordinationRun['cost']={modelCalls:{state:'known',value:0},tokens:{state:'known',value:0},
  money:{state:'known',amount:0,currency:'USD',source:'no_provider_call'}};
const known=(amount:number):CoordinationRun['cost']=>({modelCalls:{state:'known',value:1},tokens:{state:'known',value:30},
  money:{state:'known',amount,currency:'USD',source:'synthetic-receipt'}});
const pending:CoordinationRun['cost']={modelCalls:{state:'unknown',reason:'Dispatch prepared'},
  tokens:{state:'unknown',reason:'Usage pending'},money:{state:'unknown',reason:'Billing pending'}};

async function fixture(run:(scope:{pool:pg.Pool;context:ReadContext;grant:Awaited<ReturnType<typeof rotateKnowledgeWriterAuthority>>;
  task:MaintenanceTask})=>Promise<void>){
  const admin=new pg.Pool({connectionString:databaseUrl!,max:2}),schema=`ccl_coordination_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString:databaseUrl!,max:8,options:`-c search_path=${schema}`});
  try{
    await migrateKnowledge(pool);await migrateSourceIntake(pool);await migrateMaintenanceTasks(pool);await migrateCoordinationRuns(pool);
    const projectId=`synthetic-${randomUUID()}`;
    const grant=await rotateKnowledgeWriterAuthority(pool,projectId,null,{ownerId:'coordination-test',mode:'active'});
    const context:ReadContext={scope:{projectId,spaceId:'coordination-space'},purpose:'exploration_reading',
      principal:{id:'coordinator',clientInstallationId:'coordination-installation',projectId,
        spaceIds:['coordination-space','other-space'],purposes:['exploration_reading','other-purpose']}};
    const task=await createPgMaintenanceTasks(pool,grant).enqueue(context,
      {kind:'lint_page',subjectRef:null,sourceEventIds:[],relatedRefs:[],reason:'Synthetic coordination parent',
        methodVersion:'synthetic-maint/1',rubricVersion:'synthetic-rubric/1'},
      {stream:'manual',eventKey:`coordination:${randomUUID()}`,sequence:0,ref:null,sourceEventId:null});
    await run({pool,context,grant,task});
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
}

function initial(task:MaintenanceTask,deadline=Date.now()+120_000,id=randomUUID()):CoordinationRun{
  return {id,request:{taskId:task.id,taskInputDigest:task.inputDigest,purpose:'exploration_reading',
    policyVersion:'synthetic-policy/1',sourceEventId:null,
    budget:{maxModelCalls:2,maxReadBytes:60_000,deadline:new Date(deadline).toISOString(),
      maxMoney:{amount:1,currency:'USD'}}},state:'reserved',sourcePlanId:null,candidateRefs:[],judgmentIds:[],
    compilationId:null,steps:[],cost:zero,readBytes:0,reason:'Reserved',gaps:[],createdAt:new Date().toISOString(),
    completedAt:null};
}
function step(key:string):CoordinationStep{return {kind:'planning',key,request:{sourceEventId:'synthetic'},resultId:null,
  state:'running',cost:pending,readBytes:25};}

dbTest('coordination binds one task per namespace, appends steps and preserves acknowledged results and costs',async()=>fixture(async({pool,context,grant,task})=>{
  const ledger=createPgCoordinationRuns(pool,grant),base=initial(task),hash='a'.repeat(64);
  const first=await ledger.reserve(context,hash,base);assert.equal(first.created,true);
  const replay={...base,id:randomUUID(),request:{...base.request,budget:{...base.request.budget,
    deadline:new Date(Date.parse(base.request.budget.deadline)+10_000).toISOString()}}};
  const same=await ledger.reserve(context,hash,replay);
  assert.equal(same.result.id,base.id);
  assert.equal(same.result.request.budget.deadline,base.request.budget.deadline,'first reservation fixes the deadline');
  await assert.rejects(ledger.reserve(context,'b'.repeat(64),initial(task)),hasCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(ledger.reserve(context,hash,{...initial(task),request:{...base.request,taskInputDigest:'c'.repeat(64)}}),hasCode('COORDINATION_TASK_MISMATCH'));
  const other={...context,principal:{...context.principal,clientInstallationId:'another-installation'}};
  assert.equal(await ledger.byTask(other,task.id),null);
  await assert.rejects(ledger.reserve(other,hash,initial(task)),hasCode('COORDINATION_TASK_MISMATCH'));
  const otherPrincipal={...context,principal:{...context.principal,id:'another-principal'}};
  assert.equal(await ledger.byTask(otherPrincipal,task.id),null);
  await assert.rejects(ledger.reserve(otherPrincipal,hash,initial(task)),hasCode('COORDINATION_TASK_MISMATCH'));
  const otherSpace={...context,scope:{...context.scope,spaceId:'other-space'}};
  assert.equal(await ledger.byTask(otherSpace,task.id),null);
  await assert.rejects(ledger.reserve(otherSpace,hash,initial(task)),hasCode('COORDINATION_TASK_MISMATCH'));
  const running:CoordinationRun={...base,state:'running',cost:pending,steps:[step('original-key')]};
  await ledger.checkpoint(context,base.id,running);
  await assert.rejects(ledger.checkpoint(context,base.id,{...running,steps:[]}),hasCode('COORDINATION_STEPS_CHANGED'));
  await assert.rejects(ledger.checkpoint(context,base.id,{...running,steps:[{...running.steps[0],request:{other:'input'}}]}),hasCode('COORDINATION_STEP_CHANGED'));
  const resultId=randomUUID(),acknowledged:CoordinationRun={...running,sourcePlanId:resultId,
    steps:[{...running.steps[0],state:'known',resultId,cost:known(0.1)}],cost:known(0.1),readBytes:25};
  await ledger.checkpoint(context,base.id,acknowledged);
  await assert.rejects(ledger.checkpoint(context,base.id,{...acknowledged,sourcePlanId:null}),hasCode('COORDINATION_RESULT_CHANGED'));
  await assert.rejects(ledger.checkpoint(context,base.id,{...acknowledged,steps:[{...acknowledged.steps[0],resultId:randomUUID()}]}),hasCode('COORDINATION_STEP_CHANGED'));
  await assert.rejects(ledger.checkpoint(context,base.id,{...acknowledged,cost:pending}),hasCode('COORDINATION_COST_REGRESSION'));
  await assert.rejects(ledger.checkpoint(context,base.id,{...acknowledged,steps:[{...acknowledged.steps[0],cost:pending}]}),hasCode('COORDINATION_COST_REGRESSION'));
  await assert.rejects(ledger.checkpoint(context,base.id,{...acknowledged,readBytes:60_001}),hasCode('COORDINATION_READ_BUDGET_EXCEEDED'));
  const terminal:CoordinationRun={...acknowledged,state:'needs_evidence',reason:'Synthetic research is incomplete',completedAt:new Date().toISOString()};
  await ledger.finish(context,base.id,terminal);
  await ledger.finish(context,base.id,terminal);
  await assert.rejects(ledger.finish(context,base.id,{...terminal,reason:'Changed'}),hasCode('COORDINATION_ALREADY_FINISHED'));
  assert.equal((await ledger.byTask(context,task.id))?.sourcePlanId,resultId);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM ccl_knowledge_publications')).rows[0].n),0);
}));

dbTest('planned zero-cost child may dispatch with unknown cost, then freeze its acknowledged receipt',async()=>fixture(async({context,grant,pool,task})=>{
  const ledger=createPgCoordinationRuns(pool,grant),base={...initial(task),readAccounting:'acknowledged_steps' as const,
    cost:{...zero,money:{state:'known' as const,amount:0,currency:'USD',source:'no_model_step'}}};
  await ledger.reserve(context,'1'.repeat(64),base);
  const empty:CoordinationRun={...base,state:'running',cost:{...base.cost,money:{...base.cost.money,source:'sum_of_child_operation_receipts'}}};
  await ledger.checkpoint(context,base.id,empty);
  const planned:CoordinationStep={...step('paid-child'),state:'planned',cost:{...base.cost},readBytes:0};
  const beforeDispatch:CoordinationRun={...empty,steps:[planned]};
  await ledger.checkpoint(context,base.id,beforeDispatch);
  const dispatch:CoordinationRun={...beforeDispatch,steps:[{...planned,state:'running',cost:pending}],cost:pending};
  await ledger.checkpoint(context,base.id,dispatch);
  const childId=randomUUID(),acknowledged:CoordinationRun={...dispatch,steps:[{...dispatch.steps[0],state:'known',
    resultId:childId,cost:known(0.05),readBytes:18}],cost:{...known(0.05),money:{state:'known',amount:0.05,
      currency:'USD',source:'sum_of_child_operation_receipts'}},readBytes:18};
  await ledger.checkpoint(context,base.id,acknowledged);
  await assert.rejects(ledger.checkpoint(context,base.id,{...acknowledged,steps:[{...acknowledged.steps[0],cost:pending}],
    cost:pending}),hasCode('COORDINATION_COST_REGRESSION'));
  assert.equal((await ledger.get(context,base.id))?.steps[0].resultId,childId);
}));

dbTest('known budget overspend is checkpointed but only failed terminal state may retain it',async()=>fixture(async({context,grant,pool,task})=>{
  const ledger=createPgCoordinationRuns(pool,grant),base=initial(task);
  await ledger.reserve(context,'d'.repeat(64),base);
  const excess:CoordinationRun={...base,state:'running',cost:{modelCalls:{state:'known',value:3},
    tokens:{state:'known',value:60},money:{state:'known',amount:1.5,currency:'USD',source:'synthetic-overage'}}};
  await ledger.checkpoint(context,base.id,excess);
  await assert.rejects(ledger.finish(context,base.id,{...excess,state:'completed',completedAt:new Date().toISOString()}),hasCode('COORDINATION_COST_EXCEEDED'));
  await ledger.finish(context,base.id,{...excess,state:'failed',reason:'Actual provider overage',completedAt:new Date().toISOString()});
  const saved=await ledger.get(context,base.id);
  assert.equal(saved?.cost.money.state,'known');
  assert.equal(saved?.cost.money.state==='known'?saved.cost.money.amount:null,1.5);
}));

dbTest('deadline expires reserved at zero and running at unknown while retaining step receipts and cost',async()=>fixture(async({context,grant,pool,task})=>{
  const ledger=createPgCoordinationRuns(pool,grant),waiting=initial(task,Date.now()+700);
  await ledger.reserve(context,'e'.repeat(64),waiting);
  const task2=await createPgMaintenanceTasks(pool,grant).enqueue(context,
    {kind:'lint_page',subjectRef:null,sourceEventIds:[],relatedRefs:[],reason:'Second synthetic parent',
      methodVersion:'synthetic-maint/1',rubricVersion:'synthetic-rubric/1'},
    {stream:'manual',eventKey:`second:${randomUUID()}`,sequence:0,ref:null,sourceEventId:null});
  const active=initial(task2,Date.parse(waiting.request.budget.deadline));
  await ledger.reserve(context,'f'.repeat(64),active);
  const running:CoordinationRun={...active,state:'running',cost:pending,steps:[step('paid-key')]};
  await ledger.checkpoint(context,active.id,running);
  const costed:CoordinationRun={...running,cost:known(0.2),steps:[{...running.steps[0],state:'known',
    resultId:randomUUID(),cost:known(0.2)}]};
  await ledger.checkpoint(context,active.id,costed);
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(waiting.request.budget.deadline)-Date.now()+40)));
  assert.equal((await ledger.get(context,waiting.id))?.state,'failed');
  assert.deepEqual((await ledger.get(context,waiting.id))?.cost,zero);
  const expired=await ledger.byTask(context,task2.id);
  assert.equal(expired?.state,'outcome_unknown');assert.deepEqual(expired?.steps,costed.steps);
  assert.deepEqual(expired?.cost,costed.cost);
  assert.equal((await ledger.reserve(context,'f'.repeat(64),initial(task2,Date.parse(waiting.request.budget.deadline)))).result.state,'outcome_unknown');
}));

dbTest('unknown run reconciles only its original child key and exact request without dispatching it',async()=>fixture(async({context,grant,pool,task})=>{
  const ledger=createPgCoordinationRuns(pool,grant),base=initial(task,Date.now()+650);
  await ledger.reserve(context,'2'.repeat(64),base);
  const running:CoordinationRun={...base,state:'running',cost:pending,steps:[step('original-paid-key')],readBytes:25};
  await ledger.checkpoint(context,base.id,running);
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(base.request.budget.deadline)-Date.now()+40)));
  const expired=await ledger.get(context,base.id);assert.equal(expired?.state,'outcome_unknown');
  const childId=randomUUID(),recovered:CoordinationRun={...expired!,state:'outcome_unknown',sourcePlanId:childId,
    steps:[{...expired!.steps[0],state:'known',resultId:childId,cost:known(0.04)}],cost:known(0.04),
    reason:'Original child key returned an acknowledged receipt'};
  await assert.rejects(ledger.reconcile!(context,base.id,{...recovered,request:{...recovered.request,
    budget:{...recovered.request.budget,deadline:new Date(Date.now()+30_000).toISOString()}}}),hasCode('COORDINATION_BINDING_CHANGED'));
  await assert.rejects(ledger.reconcile!(context,base.id,{...recovered,steps:[...recovered.steps,step('new-child')]}),hasCode('COORDINATION_RECONCILE_INVALID'));
  await assert.rejects(ledger.reconcile!(context,base.id,{...recovered,steps:[{...recovered.steps[0],key:'different-child'}]}),hasCode('COORDINATION_STEP_CHANGED'));
  assert.equal((await ledger.reconcile!(context,base.id,recovered)).sourcePlanId,childId);
  const terminal:CoordinationRun={...recovered,state:'no_change',reason:'Known child found no additional work'};
  await ledger.reconcile!(context,base.id,terminal);
  assert.equal((await ledger.reconcile!(context,base.id,terminal)).state,'no_change');
  await assert.rejects(ledger.reconcile!(context,base.id,{...terminal,sourcePlanId:randomUUID()}),hasCode('COORDINATION_ALREADY_FINISHED'));
  assert.equal((await ledger.byTask(context,task.id))?.steps[0].resultId,childId);
}));

dbTest('lost COMMIT acknowledgement is typed unknown and original task is reconcilable',async()=>fixture(async({pool,context,grant,task})=>{
  const original=pool.connect.bind(pool),id=randomUUID(),base=initial(task,Date.now()+120_000,id);
  const interrupted={connect:async()=>{
    const client=await original(),query=client.query.bind(client);let lost=false;
    return {query:async(...args:Parameters<typeof query>)=>{
      const value=await query(...args);
      if(args[0]==='COMMIT'&&!lost){lost=true;throw new Error('Synthetic commit acknowledgement lost');}
      return value;
    },release:()=>client.release()};
  }} as unknown as pg.Pool;
  await assert.rejects(createPgCoordinationRuns(interrupted,grant).reserve(context,'9'.repeat(64),base),error=>
    error instanceof CoordinationCommitUnknownError&&error.operationId===id&&error.commitStatus==='unknown');
  assert.equal((await createPgCoordinationRuns(pool,grant).byTask(context,task.id))?.id,id);
}));

dbTest('read-only writer authority blocks new coordination writes',async()=>fixture(async({pool,context,grant,task})=>{
  const ledger=createPgCoordinationRuns(pool,grant),base=initial(task);
  await ledger.reserve(context,'8'.repeat(64),base);
  await rotateKnowledgeWriterAuthority(pool,context.scope.projectId,grant.generation,{ownerId:'read-only-coordinator',mode:'read_only'},grant);
  await assert.rejects(ledger.checkpoint(context,base.id,{...base,state:'running',cost:pending}),hasCode('KNOWLEDGE_WRITER_REVOKED'));
  assert.equal((await ledger.byTask(context,task.id))?.state,'reserved');
}));
