import test from 'node:test';
import assert from 'node:assert/strict';
import {executeWithDeadline} from '../src/provider-execution.ts';

test('parent cancellation before execution never enters the injected provider',async()=>{
 const abort=new AbortController();abort.abort();let calls=0;
 await assert.rejects(executeWithDeadline(new Date(Date.now()+1000).toISOString(),async()=>{calls++;},abort.signal));assert.equal(calls,0);
});
test('parent cancellation reaches an in-flight provider and leaves its result uncertain',async()=>{
 const abort=new AbortController();let entered!:()=>void,providerSignal:AbortSignal|undefined;
 const started=new Promise<void>(resolve=>{entered=resolve;});
 const running=executeWithDeadline(new Date(Date.now()+1000).toISOString(),async signal=>{providerSignal=signal;entered();return new Promise<never>(()=>{});},abort.signal);
 const rejected=assert.rejects(running,(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code==='PROVIDER_OUTCOME_UNKNOWN');
 await started;abort.abort();await rejected;assert.equal(providerSignal?.aborted,true);
});
test('an acknowledged provider result is returned before later parent cancellation',async()=>{
 const abort=new AbortController();const result=await executeWithDeadline(new Date(Date.now()+1000).toISOString(),async()=>({receipt:'synthetic'}),abort.signal);abort.abort();assert.deepEqual(result,{receipt:'synthetic'});
});
