import type {MaintenanceTask,MaintenanceTaskRequest,MaintenanceTrigger,MaintenanceOutcome,MaintenanceFinding,LintPass,LintPassRequest,SearchProjectionStatus,SemanticSweep,SemanticSweepRequest} from '@commerce/knowledge-contracts';
import type {ReadContext} from './index.ts';
import {authorizeCapability,type CapabilityContext} from './sources.ts';
import {KnowledgeError} from '@commerce/knowledge-core/types';

export interface MaintenanceTaskPort {
 enqueue(context:ReadContext,request:MaintenanceTaskRequest,trigger:MaintenanceTrigger):Promise<MaintenanceTask>;
 collectEvents(context:ReadContext,input:{methodVersion:string;rubricVersion:string;limit:number}):Promise<{taskIds:string[];createdCount?:number;omittedReasons?:string[];sourceThrough:number;knowledgeThrough:number;hasMore:boolean;skipped:number}>;
 claim(context:ReadContext,kinds?:MaintenanceTaskRequest['kind'][],leaseMs?:number):Promise<MaintenanceTask|null>;
 heartbeat(context:ReadContext,id:string,attemptId:string,leaseToken:number,leaseMs:number):Promise<boolean>;
 markDispatch(context:ReadContext,id:string,attemptId:string,leaseToken:number,state:'dispatch_prepared'|'response_recorded',acknowledgedOutcome?:MaintenanceOutcome):Promise<void>;
 finish(context:ReadContext,id:string,attemptId:string,leaseToken:number,outcome:MaintenanceOutcome):Promise<MaintenanceTask>;
 cancel(context:ReadContext,id:string):Promise<MaintenanceTask>;
 get(context:ReadContext,id:string):Promise<MaintenanceTask|null>;
 list(context:ReadContext,input:{limit:number;cursor?:string}):Promise<{items:MaintenanceTask[];hasMore:boolean;nextCursor:string|null}>;
}
export interface WikiLintPort {
 runPass(context:ReadContext,request:LintPassRequest):Promise<LintPass>;
 findings(context:ReadContext,input:{limit:number;cursor?:string;status?:MaintenanceFinding['status']}):Promise<{items:MaintenanceFinding[];hasMore:boolean;nextCursor:string|null}>;
}
export interface SemanticSweepPort {
 runPass(context:ReadContext,request:SemanticSweepRequest):Promise<SemanticSweep>;
 get(context:ReadContext,id:string):Promise<SemanticSweep|null>;
}
export interface SearchProjectionPort {
 status(context:ReadContext):Promise<SearchProjectionStatus|null>;
 runBatch(context:ReadContext,input:{limit:number;restart:boolean}):Promise<SearchProjectionStatus>;
}
export interface MaintenanceProcessor {execution:'local_deterministic'|'external';kinds:MaintenanceTaskRequest['kind'][];
 process(context:ReadContext,task:MaintenanceTask,signal:AbortSignal):Promise<MaintenanceOutcome>}
export function createMaintenanceApplication(options:{tasks:MaintenanceTaskPort;lint:WikiLintPort;processor?:MaintenanceProcessor;searchProjection?:SearchProjectionPort;semanticSweep?:SemanticSweepPort}){
 function auth(context:CapabilityContext,action:string){authorizeCapability(context,action);if(!context.principal.clientInstallationId?.trim())throw new KnowledgeError('INSTALLATION_REQUIRED','Maintenance requires an authenticated installation',403);}
 return {
  async runSemanticSweep(context:CapabilityContext,input:SemanticSweepRequest){auth(context,'maintenance:write');if(!options.semanticSweep)throw new KnowledgeError('SEMANTIC_SWEEP_DISABLED','Periodic semantic discovery is not configured',503);return options.semanticSweep.runPass(context,input);},
  async semanticSweep(context:CapabilityContext,id:string){auth(context,'maintenance:read');if(!options.semanticSweep)throw new KnowledgeError('SEMANTIC_SWEEP_DISABLED','Periodic semantic discovery is not configured',503);const pass=await options.semanticSweep.get(context,id);if(!pass)throw new KnowledgeError('NOT_FOUND','Periodic discovery pass is unavailable',404);return pass;},
  async searchProjectionStatus(context:CapabilityContext){auth(context,'maintenance:read');if(!options.searchProjection)throw new KnowledgeError('SEARCH_PROJECTION_DISABLED','Search projection is not configured',503);return options.searchProjection.status(context);},
  async rebuildSearchProjection(context:CapabilityContext,input:{limit:number;restart:boolean}){auth(context,'maintenance:write');if(!options.searchProjection)throw new KnowledgeError('SEARCH_PROJECTION_DISABLED','Search projection is not configured',503);return options.searchProjection.runBatch(context,input);},
  async collect(context:CapabilityContext,input:{methodVersion:string;rubricVersion:string;limit:number}){auth(context,'maintenance:write');return options.tasks.collectEvents(context,input);},
  async runLint(context:CapabilityContext,input:LintPassRequest){auth(context,'maintenance:write');return options.lint.runPass(context,input);},
  async list(context:CapabilityContext,input:{limit:number;cursor?:string}){auth(context,'maintenance:read');return options.tasks.list(context,input);},
  async get(context:CapabilityContext,id:string){auth(context,'maintenance:read');const task=await options.tasks.get(context,id);if(!task)throw new KnowledgeError('NOT_FOUND','Maintenance task is unavailable',404);return task;},
  async findings(context:CapabilityContext,input:{limit:number;cursor?:string;status?:MaintenanceFinding['status']}){auth(context,'maintenance:read');return options.lint.findings(context,input);},
  async cancel(context:CapabilityContext,id:string){auth(context,'maintenance:write');return options.tasks.cancel(context,id);},
  async runOne(context:CapabilityContext,signal?:AbortSignal){
   auth(context,'maintenance:write');if(!options.processor)return null;signal?.throwIfAborted();
   const task=await options.tasks.claim(context,options.processor.kinds,60_000);if(!task)return null;
   if(!task.attemptId)throw new KnowledgeError('TASK_CLAIM_INVALID','Claimed maintenance task has no attempt',409);
   const attemptId=task.attemptId,controller=new AbortController(),abort=()=>controller.abort(signal?.reason);
   signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
   let leaseLost=false,heartbeatBusy=false,heartbeatFailure:unknown=null;let acknowledgedOutcome:MaintenanceOutcome|undefined;
   const timer=setInterval(()=>{if(heartbeatBusy)return;heartbeatBusy=true;void options.tasks.heartbeat(context,task.id,attemptId,task.leaseToken,60_000).then(async ok=>{if(!ok){const current=await options.tasks.get(context,task.id);
    if(current?.state==='running'&&current.attemptId===attemptId&&current.leaseToken===task.leaseToken&&current.cancelRequested){controller.abort(new Error('Maintenance cancellation requested'));return;}
    leaseLost=true;controller.abort(new Error('Maintenance lease lost'));}}).catch(error=>{heartbeatFailure=error;controller.abort(error);}).finally(()=>{heartbeatBusy=false;});},15_000);
   try{
    controller.signal.throwIfAborted();
    if(options.processor.execution==='external')await options.tasks.markDispatch(context,task.id,attemptId,task.leaseToken,'dispatch_prepared');
    const outcome=await options.processor.process(context,task,controller.signal);acknowledgedOutcome=outcome;
    if(options.processor.execution==='external')await options.tasks.markDispatch(context,task.id,attemptId,task.leaseToken,'response_recorded',outcome);
    // A cancellation request cannot erase an acknowledged result or its real cost.
    if(controller.signal.aborted&&!leaseLost&&!heartbeatFailure)return await options.tasks.finish(context,task.id,attemptId,task.leaseToken,{...outcome,reason:`${outcome.reason}; interruption arrived after the processor result`});
    controller.signal.throwIfAborted();if(leaseLost||heartbeatFailure)throw new KnowledgeError('TASK_LEASE_LOST','Maintenance ownership could not be confirmed',409);
    return await options.tasks.finish(context,task.id,attemptId,task.leaseToken,outcome);
   }catch(error){
    if(error&&typeof error==='object'&&'commitStatus'in error&&error.commitStatus==='unknown')throw error;
    if(acknowledgedOutcome?.compilationId){const canonical=await options.tasks.get(context,task.id);
     if(canonical?.state==='completed'&&canonical.inputDigest===task.inputDigest&&canonical.outcome?.compilationId===acknowledgedOutcome.compilationId)return canonical;}

    if(leaseLost||heartbeatFailure)throw error;
    const external=options.processor.execution==='external';
    return await options.tasks.finish(context,task.id,attemptId,task.leaseToken,{state:external?'outcome_unknown':controller.signal.aborted?'cancelled':'failed',findingIds:acknowledgedOutcome?.findingIds??[],compilationId:acknowledgedOutcome?.compilationId??null,judgmentId:acknowledgedOutcome?.judgmentId??null,
     reason:external?'Processor outcome requires original-key reconciliation':controller.signal.aborted?'Maintenance was interrupted':'Maintenance processor failed',cost:acknowledgedOutcome?.cost??(external?
      {modelCalls:{state:'unknown',reason:'External execution may have occurred'},tokens:{state:'unknown',reason:'No acknowledged usage'},money:{state:'unknown',reason:'Reconcile original task'}}:
      {modelCalls:{state:'known',value:0},tokens:{state:'known',value:0},money:{state:'known',amount:0,currency:'USD',source:'local_deterministic_no_model'}})});
   }finally{clearInterval(timer);signal?.removeEventListener('abort',abort);}
  },
 };
}
