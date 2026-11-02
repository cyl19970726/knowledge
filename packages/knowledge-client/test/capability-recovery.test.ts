import test from 'node:test';
import assert from 'node:assert/strict';
import {createKnowledgeClient} from '../src/index.ts';

test('recovery identity is explicitly negotiated; legacy capability requests remain unchanged',async()=>{
  const scope={projectId:'test-project',spaceId:'test-space'},seen:URL[]=[];
  const client=createKnowledgeClient({baseUrl:'http://127.0.0.1:1234',scope,fetch:async(input)=>{
    const url=new URL(String(input));seen.push(url);
    return new Response(JSON.stringify({contractVersion:'1.0.0',requestId:'test',effectiveScope:scope,observedAt:'2026-11-02T00:00:00Z',warnings:[],
      data:{permittedActions:['query'],purposes:['exploration_reading'],profiles:[],mode:'read_only',contractVersion:'1.0.0',policyVersion:'test',limits:{},
        ...url.searchParams.get('recovery')==='1'?{recoveryScope:'a'.repeat(64)}:{}}}),{status:200});
  }});
  assert.equal((await client.capabilities()).data.recoveryScope,undefined);
  assert.equal(seen[0].search,'');
  assert.equal((await client.capabilities({includeRecoveryScope:true,purpose:'exploration_reading'})).data.recoveryScope,'a'.repeat(64));
  assert.equal(seen[1].searchParams.get('recovery'),'1');
  assert.equal(seen[1].searchParams.get('purpose'),'exploration_reading');
});

test('an older server may ignore recovery negotiation without breaking ordinary reads',async()=>{
  const scope={projectId:'test-project',spaceId:'test-space'};
  const client=createKnowledgeClient({baseUrl:'http://127.0.0.1:1234',scope,fetch:async()=>new Response(JSON.stringify({
    contractVersion:'1.0.0',requestId:'test',effectiveScope:scope,observedAt:'2026-11-02T00:00:00Z',warnings:[],
    data:{permittedActions:['query'],purposes:['exploration_reading'],profiles:[],mode:'read_only',contractVersion:'1.0.0',policyVersion:'test',limits:{}}}),{status:200})});
  assert.equal((await client.capabilities({includeRecoveryScope:true})).data.recoveryScope,undefined);
});
