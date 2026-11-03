import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createMaintenanceApplication,type MaintenanceTaskPort} from '../src/maintenance.ts';
import type {CapabilityContext} from '../src/sources.ts';
import type {MaintenanceOutcome,MaintenanceTask} from '../../knowledge-contracts/src/index.ts';
const cost={modelCalls:{state:'known' as const,value:1},tokens:{state:'known' as const,value:25},money:{state:'known' as const,amount:0.1,currency:'USD',source:'synthetic-observed-fixture'}};
const context:CapabilityContext={scope:{projectId:'synthetic-maintenance',spaceId:'space'},purpose:'exploration_reading',principal:{id:'synthetic',clientInstallationId:'test',projectId:'synthetic-maintenance',spaceIds:['space'],purposes:['exploration_reading']},authorization:{actions:['maintenance:write'],adapterIds:[],rightsPolicyIds:[]}};
function fixture(){const now=new Date().toISOString(),task:MaintenanceTask={id:randomUUID(),request:{kind:'relation_check',subjectRef:null,sourceEventIds:[],relatedRefs:[],reason:'Synthetic',methodVersion:'test/1',rubricVersion:'test/1'},trigger:{stream:'manual',eventKey:'synthetic',sequence:0,ref:null,sourceEventId:null},inputDigest:'a'.repeat(64),state:'running',attempts:1,attemptId:randomUUID(),leaseToken:1,cancelRequested:false,dispatchState:'not_dispatched',outcome:null,createdAt:now,updatedAt:now};
 let finished:MaintenanceOutcome|undefined,recorded:MaintenanceOutcome|undefined;const dispatches:string[]=[];
 const tasks:MaintenanceTaskPort={async enqueue(){return task;},async collectEvents(){return {taskIds:[],sourceThrough:0,knowledgeThrough:0,hasMore:false,skipped:0};},async claim(){return task;},async heartbeat(){return true;},async markDispatch(_c,_id,_attempt,_token,state,outcome){dispatches.push(state);if(outcome)recorded=outcome;},async finish(_c,_id,_attempt,_token,outcome){finished=outcome;return {...task,state:outcome.state,outcome};},async cancel(){return task;},async get(){return task;},async list(){return {items:[task],hasMore:false,nextCursor:null};}};
 return {task,tasks,dispatches,get finished(){return finished;},get recorded(){return recorded;}};}
test('acknowledged processor result survives late cancellation with exact references and observed cost',async()=>{
 const f=fixture(),abort=new AbortController(),compilationId=randomUUID();
 const app=createMaintenanceApplication({tasks:f.tasks,lint:{async runPass(){assert.fail();},async findings(){return {items:[],hasMore:false,nextCursor:null};}},processor:{execution:'external',kinds:['relation_check'],async process(){abort.abort();return {state:'waiting_for_review',findingIds:[],compilationId,judgmentId:null,reason:'Synthetic acknowledged proposal',cost};}}});
 const result=await app.runOne(context,abort.signal);assert.equal(result?.state,'waiting_for_review');assert.equal(f.finished?.compilationId,compilationId);assert.deepEqual(f.finished?.cost,cost);assert.deepEqual(f.recorded?.cost,cost);assert.deepEqual(f.dispatches,['dispatch_prepared','response_recorded']);
});
test('unacknowledged external interruption stays unknown and never invents zero money',async()=>{
 const f=fixture();const app=createMaintenanceApplication({tasks:f.tasks,lint:{async runPass(){assert.fail();},async findings(){return {items:[],hasMore:false,nextCursor:null};}},processor:{execution:'external',kinds:['relation_check'],async process(){throw new Error('Synthetic transport loss');}}});
 assert.equal((await app.runOne(context))?.state,'outcome_unknown');assert.equal(f.finished?.cost.money.state,'unknown');assert.deepEqual(f.dispatches,['dispatch_prepared']);
});
