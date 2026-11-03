import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {syntheticRevision,type Page} from '../../../scripts/runtime/wiki-query-baseline.ts';
import {createKnowledgeStore} from '../src/store.ts';
import {migrateKnowledge} from '../src/migrations.ts';
import {planWikiLexicalQuery} from '../src/wiki-lexical-query.ts';
import {digest} from '../src/utils.ts';
import {KnowledgeError,type KnowledgeRevision} from '../src/types.ts';

const url=readTestDatabase(),dbTest=url?test:test.skip;
const id=(n:number)=>`00000000-0000-5000-8000-${String(n).padStart(12,'0')}`;
const page=(n:number,title:string,identityKey:string,aliases:string[],spaceId='knowledge'):Page=>({
  id:id(n),versionId:id(n+1000),title,body:'合成正文：中文与 English。',sourceGroup:null,identityKey,aliases,spaceId});

dbTest('bounded Wiki reads preserve lexical order and policy while keeping full oversized and dependency payloads out of Node',
  {timeout:60_000},async()=>{
    const admin=new Pool({connectionString:url!,max:1}),schema=`wiki_bounded_${randomUUID().replaceAll('-','')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool=new Pool({connectionString:url!,options:`-c search_path=${schema}`,max:4});
    try{
      await migrateKnowledge(pool);
      const project='synthetic-bounded',foreign='synthetic-bounded-foreign';
      await pool.query('INSERT INTO ccl_knowledge_projects(project_id) VALUES($1),($2)',[project,foreign]);
      const root=page(1,'中性标题','Aurora Project',['Blue Harbor','Blue Harbor East']);
      const peer=page(2,'中性标题','Different Project',['Blue Harbor Auxiliary']);
      const other=page(3,'中性标题','Aurora Project',['Blue Harbor'],'other');
      const outsider=page(4,'中性标题','Aurora Project',['Blue Harbor']);
      const old:Page={...root,versionId:id(2001),identityKey:'Obsolete Key',aliases:['Expired Alias']};
      const dependency=page(5,'关键依赖','Dependency Key',[]);
      const legacy=page(6,'旧空间','Legacy Key',[]);
      const marker='DEPENDENCY_BODY_MUST_NOT_RETURN_';
      const originalReport={objectId:id(801),versionId:id(1801)};
      async function seed(item:Page,projectId:string,options:{head?:boolean;huge?:boolean;dependsOn?:Page;legacy?:boolean;review?:boolean}={}){
        const revision=syntheticRevision(item,projectId),changeId=randomUUID();
        if(options.huge)revision.body=marker+'汉'.repeat(90_000);
        if(options.dependsOn)revision.dependencies=[{domain:'knowledge',ref:{objectId:options.dependsOn.id,versionId:options.dependsOn.versionId},
          role:'uses',critical:true}];
        if(item===dependency){revision.scope.reviewDueAt='2020-01-01T00:00:00.000Z';revision.dependencies=[{domain:'analysis',ref:originalReport,role:'uses',critical:true}];}
        if(options.legacy)delete (revision as Partial<KnowledgeRevision>).binding;
        const change={changes:[{revision:{ref:revision.ref},effect:'create',explanation:'Synthetic bounded read'}]};
        await pool.query(`INSERT INTO ccl_knowledge_changesets(project_id,id,request_key,request_hash,content_hash,payload)
          VALUES($1,$2,$3,$4,$5,$6)`,[projectId,changeId,changeId,item.id,item.versionId,change]);
        await pool.query(`INSERT INTO ccl_knowledge_revisions(project_id,object_id,version_id,changeset_id,kind,title,body,payload,published_at)
          VALUES($1,$2,$3,$4,'wiki_page',$5,$6,$7,$8)`,[projectId,item.id,item.versionId,changeId,
            revision.title,revision.body,revision,revision.createdAt]);
        if(options.head!==false)await pool.query('INSERT INTO ccl_knowledge_heads(project_id,object_id,version_id) VALUES($1,$2,$3)',
          [projectId,item.id,item.versionId]);
        if(options.review){const review={id:randomUUID(),projectId,changeSetId:changeId,contentHash:item.versionId,
          reviewer:'synthetic-reviewer',policyVersion:'synthetic',purpose:'exploration_reading',
          decision:'approved_for_purpose',rationale:'Synthetic test',createdAt:revision.createdAt};
          await pool.query('INSERT INTO ccl_knowledge_reviews(project_id,id,changeset_id,content_hash,payload) VALUES($1,$2,$3,$4,$5)',
            [projectId,review.id,changeId,review.contentHash,review]);}
        return revision;
      }
      await seed(old,project,{head:false});
      await seed(dependency,project,{huge:true});
      await seed(root,project,{dependsOn:dependency,review:true});
      await seed(peer,project);await seed(other,project);await seed(outsider,foreign);
      await seed(legacy,project,{legacy:true});

      const observed:Array<{sql:string;rows:unknown[]}> = [];
      const trackedPool={connect:async()=>{
        const client=await pool.connect();
        return {query:async(sql:string,params?:unknown[])=>{
          const result=await client.query(sql,params??[]);
          observed.push({sql,rows:result.rows});return result;
        },release:()=>client.release()};
      }} as unknown as Pool;
      const store=createKnowledgeStore(trackedPool);
      const bounded=store.getBounded!,candidates=store.wikiCandidates!,inspect=store.inspectFrozen!;
      const ref=(item:Page)=>({objectId:item.id,versionId:item.versionId});
      const plan=planWikiLexicalQuery('Blue Harbor','wiki-lexical-v2');
      const options={spaceId:'knowledge',lexical:plan,limit:10,offset:0};
      const matches=await candidates(project,options);
      const full=await store.search(project,{kinds:['wiki_page'],spaceId:'knowledge',lexical:plan,limit:10,offset:0});
      assert.deepEqual(matches.map(item=>item.ref),full.map(item=>item.revision.ref));
      assert.deepEqual(matches.map(item=>item.ref),[ref(root),ref(peer)]);
      assert.ok(matches.every(item=>!('body' in item)&&!('payload' in item)));
      assert.deepEqual((await candidates(project,{...options,limit:1,offset:1})).map(item=>item.ref),[ref(peer)]);
      assert.deepEqual((await candidates(project,{...options,spaceId:'other'})).map(item=>item.ref),[ref(other)]);
      assert.deepEqual((await candidates(foreign,options)).map(item=>item.ref),[ref(outsider)]);
      assert.deepEqual(await candidates(project,{...options,lexical:planWikiLexicalQuery('Expired Alias','wiki-lexical-v2')}),[]);
      const v1=planWikiLexicalQuery('Blue Harbor');
      assert.deepEqual((await candidates(project,{...options,lexical:v1})).map(item=>item.ref),
        (await store.search(project,{kinds:['wiki_page'],spaceId:'knowledge',lexical:v1})).map(item=>item.revision.ref));
      assert.deepEqual(await candidates(project,{...options,lexical:{...plan,terms:[]}}),[]);

      const stored=await pool.query<{payload_text:string;payload_bytes:number;storage_digest:string}>(
        `SELECT payload::text AS payload_text,octet_length(payload::text) AS payload_bytes,
          encode(sha256(convert_to(payload::text,'UTF8')),'hex') AS storage_digest
         FROM ccl_knowledge_revisions WHERE project_id=$1 AND object_id=$2 AND version_id=$3`,
        [project,root.id,root.versionId]);
      const exact=stored.rows[0]!;
      assert.equal(exact.payload_bytes,Buffer.byteLength(exact.payload_text,'utf8'));
      assert.ok(exact.payload_bytes>exact.payload_text.length,'UTF8 bytes exceed characters for the Chinese payload');
      assert.equal(exact.storage_digest,createHash('sha256').update(exact.payload_text,'utf8').digest('hex'));
      assert.notEqual(exact.storage_digest,digest(JSON.parse(exact.payload_text)),
        'the internal storage fingerprint is distinct from the public canonical digest');
      assert.equal(matches[0]?.payloadBytes,exact.payload_bytes);
      assert.equal(matches[0]?.storageDigest,exact.storage_digest);

      observed.length=0;
      const frozen=await inspect(project,ref(root));
      assert.equal(frozen?.kind,'wiki_page');assert.equal(frozen?.spaceId,'knowledge');
      assert.equal(frozen?.published,true);assert.equal(frozen?.current,true);
      assert.equal(frozen?.review?.decision,'approved_for_purpose');
      assert.equal(frozen?.validity.valid,false);
      assert.ok(frozen?.validity.issues.some(issue=>issue.reason==='review_due'));
      assert.equal(frozen?.payloadBytes,exact.payload_bytes);
      assert.equal(frozen?.storageDigest,exact.storage_digest);
      assert.equal(frozen?.criticalSourcesComplete,true);
      assert.deepEqual(frozen?.criticalSources,[{domain:'analysis',ref:originalReport}],'authorization includes transitive raw sources without transferring the dependency body');
      assert.ok(!JSON.stringify(observed.map(row=>row.rows)).includes(marker));
      assert.ok(observed.some(row=>row.sql.includes("payload->'scope'->>'reviewDueAt'")),
        'critical dependencies use the metadata assessment projection');
      assert.equal((await inspect(project,ref(legacy)))?.spaceId,'legacy:knowledge');
      assert.equal((await inspect(project,ref(old)))?.current,false);
      assert.equal(await inspect(project,{objectId:id(999),versionId:id(1999)}),null);

      observed.length=0;
      const loaded=await bounded(project,ref(root),exact.payload_bytes);
      assert.equal(loaded?.payloadBytes,exact.payload_bytes);
      assert.equal(loaded?.storageDigest,exact.storage_digest);
      assert.deepEqual(loaded?.view.revision.ref,ref(root));
      assert.equal(loaded?.view.validity.valid,frozen?.validity.valid);
      assert.deepEqual(loaded?.view.validity.issues.map(issue=>({ref:issue.ref,reason:issue.reason,state:issue.state})),
        frozen?.validity.issues.map(issue=>({ref:issue.ref,reason:issue.reason,state:issue.state})));
      assert.ok(!JSON.stringify(observed.map(row=>row.rows)).includes(marker),
        'recursive validity must not transmit the huge critical dependency body');
      observed.length=0;
      await assert.rejects(bounded(project,ref(root),exact.payload_bytes-1),error=>
        error instanceof KnowledgeError&&error.code==='KNOWLEDGE_READ_BUDGET_EXCEEDED'&&error.status===422);
      assert.ok(!observed.some(row=>row.rows.some(value=>value&&typeof value==='object'&&'payload' in value)),
        'oversize query must return no full payload row');
      assert.ok(observed.some(row=>row.sql.includes('octet_length(r.payload::text)::bigint<=$4::bigint')));
      await assert.rejects(bounded(project,ref(root),0),error=>
        error instanceof KnowledgeError&&error.code==='KNOWLEDGE_READ_BUDGET_EXCEEDED'&&error.status===422);
      assert.equal(await bounded(project,{objectId:id(999),versionId:id(1999)},0),null);

      await pool.query(`UPDATE ccl_knowledge_revisions SET payload=jsonb_set(payload,'{content,identity,key}',to_jsonb('Changed Key'::text))
        WHERE project_id=$1 AND object_id=$2 AND version_id=$3`,[project,root.id,root.versionId]);
      const changed=await inspect(project,ref(root));
      assert.notEqual(changed?.storageDigest,frozen?.storageDigest,'storage mutation changes the frozen fingerprint');
      assert.notEqual(changed?.payloadBytes,frozen?.payloadBytes);
    }finally{
      await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();
    }
  });
