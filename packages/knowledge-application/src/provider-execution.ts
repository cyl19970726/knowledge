import {KnowledgeError} from '@commerce/knowledge-core/types';
import type {Cost} from '@commerce/knowledge-contracts';
/** The provider answered and was billed, but its output is unusable. The outcome is known: the operation failed,
 * with this cost. Only an unanswered dispatch is an unknown outcome. */
export class ProviderOutputError extends KnowledgeError{
 constructor(code:'PROVIDER_OUTPUT_INVALID'|'PROVIDER_OUTPUT_TRUNCATED',message:string,
  readonly receipt:{cost:Cost;modelReturned:string|null;requestId:string|null}){super(code,message,502);}
}
/** Only controls an injected operation; this helper contains no provider transport. */
export async function executeWithDeadline<T>(deadline:string,run:(signal:AbortSignal)=>Promise<T>,parent?:AbortSignal,now=Date.now):Promise<T>{
 parent?.throwIfAborted();const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 let onAbort:(()=>void)|undefined;
 const stopped=new Promise<never>((_,reject)=>{
  const interrupt=(message:string)=>{controller.abort();reject(new KnowledgeError('PROVIDER_OUTCOME_UNKNOWN',message,504));};
  timer=setTimeout(()=>interrupt('Provider response deadline elapsed'),Math.max(1,Date.parse(deadline)-now()));
  onAbort=()=>interrupt('Provider dispatch was interrupted; reconcile the original operation');
  parent?.addEventListener('abort',onAbort,{once:true});if(parent?.aborted)onAbort();
 });
 try{return await Promise.race([run(controller.signal),stopped]);}
 finally{if(timer)clearTimeout(timer);if(onAbort)parent?.removeEventListener('abort',onAbort);}
}
