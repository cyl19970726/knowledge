import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {syntheticRevision, type Page} from '../../../scripts/runtime/wiki-query-baseline.ts';
import {createAskWikiService} from '../../knowledge-application/src/ask.ts';
import {createKnowledgeApplication, type ReadContext} from '../../knowledge-application/src/index.ts';
import {QueryRequestSchema, ReadReceiptSchema, type AskResult, type QueryRequest, type ReadReceipt} from '../../knowledge-contracts/src/index.ts';
import {planWikiLexicalQuery} from '../src/wiki-lexical-query.ts';
import {migrateKnowledge} from '../src/migrations.ts';
import {createKnowledgeStore} from '../src/store.ts';

const url=readTestDatabase(),dbTest=url?test:test.skip;
const id=(n:number)=>`00000000-0000-5000-8000-${String(n).padStart(12,'0')}`;
const page=(n:number,identityKey:string,aliases:string[],spaceId='knowledge'):Page=>({
  id:id(n),versionId:id(n+1000),title:'中性标题',body:'普通记录',sourceGroup:null,identityKey,aliases,spaceId});

dbTest('v2 searches structured identity once per term and keeps scope, head, validity, receipt, and cursor boundaries',
  {timeout:60_000},async()=>{
    const admin=new Pool({connectionString:url!,max:1}),schema=`wiki_v2_regression_${randomUUID().replaceAll('-','')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool=new Pool({connectionString:url!,options:`-c search_path=${schema}`,max:4});
    try{
      await migrateKnowledge(pool);
      const project='synthetic-v2-regression',foreign='synthetic-v2-foreign';
      await pool.query('INSERT INTO ccl_knowledge_projects(project_id) VALUES($1),($2)',[project,foreign]);
      const first=page(1,'Aurora Project',['Blue Harbor','Blue Harbor East']);
      const second=page(2,'Different Project',['Blue Harbor Auxiliary']);
      const otherSpace=page(3,'Aurora Project',['Blue Harbor'],'other');
      const otherProject=page(4,'Aurora Project',['Blue Harbor']);
      const old:Page={...first,versionId:id(2001),identityKey:'Obsolete Key',aliases:['Expired Alias']};
      async function seed(item:Page,projectId:string,head=true){
        const revision=syntheticRevision(item,projectId),changeId=randomUUID();
        const change={changes:[{revision:{ref:revision.ref},effect:'create',explanation:'Synthetic v2 regression'}]};
        await pool.query(`INSERT INTO ccl_knowledge_changesets(project_id,id,request_key,request_hash,content_hash,payload)
          VALUES($1,$2,$3,$4,$5,$6)`, [projectId,changeId,changeId,item.id,item.versionId,change]);
        await pool.query(`INSERT INTO ccl_knowledge_revisions(project_id,object_id,version_id,changeset_id,kind,title,body,payload,published_at)
          VALUES($1,$2,$3,$4,'wiki_page',$5,$6,$7,$8)`,[projectId,item.id,item.versionId,changeId,item.title,item.body,revision,revision.createdAt]);
        if(head)await pool.query('INSERT INTO ccl_knowledge_heads(project_id,object_id,version_id) VALUES($1,$2,$3)',
          [projectId,item.id,item.versionId]);
      }
      await seed(old,project,false);await seed(first,project);await seed(second,project);
      await seed(otherSpace,project);await seed(otherProject,foreign);
      await pool.query(`INSERT INTO ccl_knowledge_invalidities(project_id,domain,object_id,version_id,reason,state)
        VALUES($1,'knowledge',$2,$3,'synthetic_stale','stale')`,[project,first.id,first.versionId]);
      const store=createKnowledgeStore(pool,{});
      const search=(question:string,methodVersion:'wiki-lexical-v1'|'wiki-lexical-v2',spaceId='knowledge',projectId=project,limit=10,offset=0)=>
        store.search(projectId,{kinds:['wiki_page'],spaceId,lexical:planWikiLexicalQuery(question,methodVersion),limit,offset});
      assert.deepEqual(await search('Aurora','wiki-lexical-v1'),[],
        'identity key is absent from the original title/body method');
      const keyHits=await search('Aurora','wiki-lexical-v2');
      assert.deepEqual(keyHits.map(view=>view.revision.ref.objectId),[first.id]);
      assert.equal(keyHits[0]?.searchMatch?.methodVersion,'wiki-lexical-v2');
      assert.deepEqual(keyHits[0]?.searchMatch?.matchedTerms,['aurora']);
      assert.equal(keyHits[0]?.validity.valid,false,'v2 retains the stored invalidity status');
      assert.deepEqual(await search('Expired Alias','wiki-lexical-v2'),[],
        'an old version outside heads cannot reappear through an alias');
      const aliasHits=await search('Blue Harbor','wiki-lexical-v2');
      assert.deepEqual(aliasHits.map(view=>view.revision.ref.objectId),[first.id,second.id]);
      assert.equal(aliasHits[0]?.searchMatch?.score,24,
        'two matching aliases contribute only once for each four-character-capped term');
      assert.equal(aliasHits[1]?.searchMatch?.score,24);
      const textV1=await search('中性标题','wiki-lexical-v1');
      const textV2=await search('中性标题','wiki-lexical-v2');
      const status=(views:typeof textV1)=>new Map(views.map(view=>[view.revision.ref.objectId,
        {current:view.current,published:view.published,validity:view.validity}]));
      assert.deepEqual(status(textV2),status(textV1),'v2 keeps the v1 head and validity semantics');
      assert.deepEqual((await search('Aurora','wiki-lexical-v2','other')).map(view=>view.revision.ref.objectId),[otherSpace.id]);
      assert.deepEqual((await search('Aurora','wiki-lexical-v2','knowledge',foreign)).map(view=>view.revision.ref.objectId),[otherProject.id]);
      assert.deepEqual((await search('Blue Harbor','wiki-lexical-v2','knowledge',project,1,1)).map(view=>view.revision.ref.objectId),[second.id]);

      const receipts=new Map<string,ReadReceipt>();
      const reader=createKnowledgeApplication({store,receipts:{
        async save(value){receipts.set(value.id,ReadReceiptSchema.parse(value));},
        async get(_scope,_principalId,receiptId){return receipts.get(receiptId)??null;}}});
      const context=(spaceId:string):ReadContext=>({scope:{projectId:project,spaceId},
        principal:{id:'synthetic-reader',clientInstallationId:'synthetic-v2-test',projectId:project,
          spaceIds:['knowledge','other'],purposes:['exploration_reading']},purpose:'exploration_reading'});
      const scope=context('knowledge'),other=context('other');
      const request={question:'Blue Harbor',purpose:'exploration_reading',limit:1};
      assert.equal(QueryRequestSchema.safeParse({...request,retrievalMethod:'wiki-lexical-v2'}).success,true);
      assert.equal(QueryRequestSchema.safeParse({...request,retrievalMethod:'invalid'}).success,false);
      const original=await reader.query(scope,request);
      assert.equal(original.data.retrieval.methodVersion,'wiki-lexical-v1');
      assert.equal(original.data.items.length,0);
      assert.deepEqual((await reader.query(scope,{...request,retrievalMethod:'wiki-lexical-v1'})).data.items,original.data.items);
      const v2=await reader.query(scope,{...request,retrievalMethod:'wiki-lexical-v2'});
      assert.equal(v2.data.retrieval.methodVersion,'wiki-lexical-v2');
      assert.deepEqual(v2.data.items.map(item=>item.ref.objectId),[first.id]);
      assert.equal(v2.data.items[0]?.status.validity.valid,false);
      const receipt=receipts.get(v2.data.readReceiptId);
      assert.equal(receipt?.request.kind,'query');
      if(receipt?.request.kind!=='query')throw new Error('Expected query receipt');
      assert.equal(receipt.request.payload.retrievalMethod,'wiki-lexical-v2');
      const cursor=v2.coverage.nextCursor!;assert.ok(cursor);
      const next=await reader.query(scope,{...request,retrievalMethod:'wiki-lexical-v2',cursor});
      assert.deepEqual(next.data.items.map(item=>item.ref.objectId),[second.id]);
      assert.equal(next.coverage.hasMore,false);
      await assert.rejects(reader.query(scope,{...request,cursor}),/Cursor does not match/);
      await assert.rejects(reader.query(scope,{...request,retrievalMethod:'wiki-lexical-v1',cursor}),/Cursor does not match/);
      await assert.rejects(reader.query(other,{...request,retrievalMethod:'wiki-lexical-v2',cursor}),/Cursor does not match/);
      await assert.rejects(reader.query(scope,{...request,question:'Aurora',retrievalMethod:'wiki-lexical-v2',cursor}),/Cursor does not match/);
      assert.deepEqual((await reader.query(other,{...request,retrievalMethod:'wiki-lexical-v2'})).data.items.map(item=>item.ref.objectId),[otherSpace.id]);

      let askQuery:QueryRequest|undefined,finished:AskResult|undefined;
      const ask=createAskWikiService({reader:{...reader,queryCandidates:async(ctx,input)=>{
        askQuery=input;return reader.queryCandidates(ctx,input);}},operations:{
        async reserve(_ctx,_key,_digest,_request,initial){return {created:true,result:initial};},
        async start(){return true;},async checkpoint(){},
        async finish(_ctx,_id,result){finished=result;},
        async get(){return finished??null;},async lookup(){return null;},
      },provider:{id:'never-called',model:'none',async answer(){throw new Error('No eligible evidence');}}});
      const answer=await ask.ask({...scope,authorization:{actions:['ask:write'],adapterIds:[],rightsPolicyIds:[]}},
        {question:'Blue Harbor',purpose:'exploration_reading',limit:2,maxPages:1,includeSourceContent:false,
          budget:{maxModelCalls:0,maxReadBytes:50_000,deadline:new Date(Date.now()+60_000).toISOString(),maxMoney:null}},
        'synthetic-ask-v2');
      assert.equal(askQuery?.retrievalMethod,'wiki-lexical-v2');
      assert.equal(answer.state,'needs_evidence');
      assert.match(answer.coverage.scopeDescription,/wiki lexical v2/i);
      assert.equal(answer.coverage.loaded,2);
    }finally{
      await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();
    }
  });
