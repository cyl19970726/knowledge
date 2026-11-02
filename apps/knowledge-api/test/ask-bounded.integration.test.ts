import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {seedKnowledgeSyntheticFixture} from '../../../scripts/runtime/knowledge-synthetic-fixture.ts';
import {createKnowledgeStore} from '../../../packages/knowledge/src/store.ts';
import {createKnowledgeApplication} from '../../../packages/knowledge-application/src/index.ts';
import {createAskWikiService,type AskOperationPort} from '../../../packages/knowledge-application/src/ask.ts';
import {createPgSourceRegistry} from '../../../packages/adapters/knowledge-service/src/sources.ts';
import {migrateKnowledgeReadReceipts,createPgKnowledgeReceiptPort} from '../../../packages/adapters/knowledge-service/src/index.ts';
import {createSyntheticQueryAnswerer} from '../../../scripts/runtime/knowledge-synthetic-answerer.ts';
import type {AskResult} from '../../../packages/knowledge-contracts/src/index.ts';

const url=readTestDatabase(),dbTest=url?test:test.skip;
dbTest('Ask accounts for bounded Wiki payloads and refuses oversized or unsupported source reads before transmission',{timeout:60_000},async()=>{
  const admin=new Pool({connectionString:url!,max:2}),schema=`ask_bounded_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new Pool({connectionString:url!,max:8,options:`-c search_path=${schema}`});
  try{
    const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-${randomUUID()}`);
    await migrateKnowledgeReadReceipts(pool);
    const store=createKnowledgeStore(pool,{writerGrant:seed.writerGrant});
    const sources=createPgSourceRegistry(pool,{writerGrant:seed.writerGrant});
    const reader=createKnowledgeApplication({store,receipts:createPgKnowledgeReceiptPort(pool),sources});
    const context={scope:{projectId:seed.projectId,spaceId:seed.spaceId},purpose:'exploration_reading',principal:seed.principal,
      authorization:{...seed.authorization,actions:[...seed.authorization.actions,'ask:write']}};
    const found=await reader.queryCandidates(context,{question:'查询 visibility',purpose:context.purpose,limit:1,retrievalMethod:'wiki-lexical-v2'});
    assert.equal(found.data.items.length,1);
    assert.equal('body' in found.data.items[0],false,'candidate metadata is not a content read');
    const firstBytes=found.data.items[0].payloadBytes;
    assert.ok(firstBytes>0);
    const completed=new Map<string,AskResult>();
    const operations:AskOperationPort={
      async reserve(_ctx,_key,_digest,_request,initial){return {created:true,result:initial};},async start(){return true;},async checkpoint(){},
      async finish(_ctx,id,result){completed.set(id,result);},async get(_ctx,id){return completed.get(id)??null;},async lookup(){return null;},
    };
    let pageReads=0,sourceReads=0,transferredWiki=0,transferredSource=0,calls=0;
    const noLegacy=()=>{throw new Error('Ask must not use an unbounded content path');};
    const guarded={...reader,query:noLegacy,exact:noLegacy,sourceContent:noLegacy,
      async readCandidate(...args:Parameters<typeof reader.readCandidate>){pageReads++;const page=await reader.readCandidate(...args);transferredWiki+=page.payloadBytes;return page;},
      async sourceContentBounded(...args:Parameters<typeof reader.sourceContentBounded>){sourceReads++;const source=await reader.sourceContentBounded(...args);transferredSource+=source.actualCoverage.byteCount;return source;},
    };
    const provider=createSyntheticQueryAnswerer();
    const service=createAskWikiService({reader:guarded,operations,provider:{...provider,async answer(input){calls++;return provider.answer(input);}}});
    const request=(maxReadBytes:number)=>({question:'查询 visibility',purpose:context.purpose,limit:1,maxPages:1,includeSourceContent:true,
      budget:{maxModelCalls:1,maxReadBytes,deadline:new Date(Date.now()+60_000).toISOString(),maxMoney:{amount:0,currency:'USD'}}});
    const tiny=await service.ask(context,request(1),randomUUID());
    assert.equal(tiny.state,'needs_evidence');assert.equal(pageReads,0);assert.equal(sourceReads,0);assert.equal(calls,0);
    assert.equal(tiny.readUsage?.wikiPayloadBytes,0);assert.equal(tiny.readUsage?.sourceContentBytes,0);
    const partial=await service.ask(context,request(firstBytes+100),randomUUID());
    assert.equal(partial.state,'answered');assert.equal(pageReads,1);assert.equal(sourceReads,1);
    assert.equal(partial.readUsage?.wikiPayloadBytes,firstBytes);assert.equal(partial.readUsage?.sourceContentBytes,0);
    assert.ok(partial.gaps.some(gap=>gap.includes('SOURCE_READ_BUDGET_EXCEEDED')));
    const full=await service.ask(context,request(firstBytes+2000),randomUUID());
    assert.equal(full.state,'answered');assert.equal(full.evidence.length,2);
    assert.equal(full.readUsage?.wikiPayloadBytes,firstBytes);assert.equal(full.readUsage?.sourceContentBytes,176);
    assert.ok(full.evidence.find(item=>item.kind==='wiki_page')?.storageDigest);
    assert.ok((full.readUsage?.preparedInputBytes??Infinity)<=firstBytes+2000);
    assert.equal(transferredWiki,firstBytes*2);assert.equal(transferredSource,176);
    await service.get(context,full.id);
    assert.equal(pageReads,2,'readset revalidation must use metadata, not re-download Wiki bodies');

    let legacySourceCalls=0;
    const legacySources={readRecord:sources.readRecord,async readContent(){legacySourceCalls++;throw new Error('Unexpected unbounded owner read');}};
    const oldReader=createKnowledgeApplication({store,receipts:createPgKnowledgeReceiptPort(pool),sources:legacySources});
    const oldService=createAskWikiService({reader:oldReader,operations,provider});
    const withoutSource=await oldService.ask(context,request(firstBytes+2000),randomUUID());
    assert.equal(withoutSource.state,'answered');assert.equal(legacySourceCalls,0);
    assert.ok(withoutSource.gaps.some(gap=>gap.includes('BOUNDED_SOURCE_READ_UNSUPPORTED')));
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
