import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import express from 'express';
import type {Server} from 'node:http';
import pg from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {migrateKnowledge} from '../../../packages/knowledge/src/migrations.ts';
import {createAnalysisRepository,migrateAnalysis} from '../../../packages/analysis/src/index.ts';
import {createKnowledgeStore} from '../../../packages/knowledge/src/store.ts';
import type {KnowledgeRevision,KnowledgeChangeSet} from '../../../packages/knowledge/src/types.ts';
import {digest} from '../../../packages/knowledge/src/utils.ts';
import {createKnowledgeClient} from '../../../packages/knowledge-client/src/index.ts';
import {createKnowledgeApi} from '../src/index.ts';
import {createPgSourceRegistry,migrateManagedSources} from '../../../packages/adapters/knowledge-service/src/sources.ts';
import {createHttpSourceOwner} from '../../../packages/adapters/knowledge-service/src/source-owner.ts';
import {businessSourceFixture} from '../../api/test/fixtures/business-source.ts';
import {businessSourceOwnerRouter,migrateBusinessSourceReads,pgBusinessSourceReads,createBusinessSourceOwner} from '../../api/src/knowledge-source-owner.ts';
const url=readTestDatabase(),dbTest=url?test:test.skip;
const close=(server:Server)=>new Promise<void>(done=>server.close(()=>done()));
const code=(value:string)=>(error:unknown)=>typeof error==='object'&&error!==null&&'code' in error&&error.code===value;

dbTest('standalone HTTP/client bridge reads actual exact report/frame without rewriting old ledgers or counting graph metadata as reads',async()=>{
  const admin=new pg.Pool({connectionString:url!,max:2}),schema=`ccl_business_bridge_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);const pool=new pg.Pool({connectionString:url!,max:8,options:`-c search_path=${schema}`});
  const f=await businessSourceFixture(pgBusinessSourceReads(pool));let business:Server|undefined,apiServer:Server|undefined,unconnected:Server|undefined;
  try{
    await migrateKnowledge(pool);await migrateBusinessSourceReads(pool);await migrateAnalysis(pool);
    const storedReport=f.report,storedEvidence=f.evidence;
    await pool.query('INSERT INTO ccl_analysis_contexts(project_id,object_id,version_id,asset_version_id,digest,document) VALUES($1,$2,$3,$4,$5,$6)',[f.projectId,randomUUID(),storedReport.contextSnapshotId,f.assetVersionId,'a'.repeat(64),{synthetic:true}]);
    await pool.query('INSERT INTO ccl_analysis_runs(project_id,run_id,request_digest,request,execution_grant,deadline_at) VALUES($1,$2,$3,$4,$5,$6)',[f.projectId,storedReport.runId,'a'.repeat(64),{synthetic:true},{synthetic:true},'2020-01-01']);
    await pool.query('INSERT INTO ccl_analysis_results(project_id,object_id,version_id,run_id,attempt_id,context_version_id,digest,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[f.projectId,storedReport.ref.objectId,storedReport.ref.versionId,storedReport.runId,storedReport.attemptId,storedReport.contextSnapshotId,digest(storedReport),storedReport]);
    await pool.query('INSERT INTO ccl_analysis_evidence(project_id,object_id,version_id,digest,document) VALUES($1,$2,$3,$4,$5)',[f.projectId,storedEvidence.ref.objectId,storedEvidence.ref.versionId,digest(storedEvidence),storedEvidence]);
    const repository=createAnalysisRepository(pool,{withActiveAttempt:async()=>{throw new Error('Read-only owner must not execute an analysis mutation');}});
    f.options.analysis.repository=repository;
    const sourceLedger=async()=>({results:(await pool.query('SELECT to_jsonb(r) row FROM ccl_analysis_results r')).rows,evidence:(await pool.query('SELECT to_jsonb(r) row FROM ccl_analysis_evidence r')).rows});
    const originalAnalysis=await sourceLedger();
    const ref={objectId:randomUUID(),versionId:randomUUID()},now='2020-01-01T00:00:00.000Z';
    const revision:KnowledgeRevision={kind:'pattern',projectId:f.projectId,ref,title:'Synthetic source bridge pattern',body:'A synthetic published pattern retains its original exact citations.',
      scope:{applicability:{productVersionRefs:[],markets:[],languages:[],audiences:[],goals:[],requiredProduction:[],transferRationale:null},limitations:[],unknowns:[],reviewDueAt:null},
      dependencies:[f.reportRef,f.frameRef].map(value=>({domain:value.domain as 'analysis'|'evidence',ref:{objectId:value.objectId,versionId:value.versionId},role:'supports',critical:true})),sourceGroups:[f.frameObject.objectId],artifactRef:null,createdAt:now,analysisQuality:null,
      content:{ref,projectId:f.projectId,title:'Synthetic source bridge pattern',problem:'test',mechanism:'test',sequence:[],requiredElements:[],variableSlots:[],applicability:[],exclusions:[],supportRefs:[],counterexampleRefs:[],prediction:'test',evidenceLevel:'inconclusive',citations:[
        {kind:'source',sourceRef:{objectId:f.reportRef.objectId,versionId:f.reportRef.versionId},locator:`record:analysis:${f.reportRef.objectId}/${f.reportRef.versionId}`,supports:'Synthetic report pointer'},
        {kind:'media',anchor:{assetVersionId:f.assetVersionId,scope:{kind:'segment',startMs:1000,endMs:1001},sourceRef:{objectId:f.frameRef.objectId,versionId:f.frameRef.versionId}},supports:'Synthetic exact frame pointer'}]}};
    const change:KnowledgeChangeSet={id:randomUUID(),projectId:f.projectId,requestKey:randomUUID(),requestHash:digest(revision),contentHash:digest(revision),purpose:'exploration_reading',proposer:'synthetic-builder',rationale:'Synthetic bridge fixture',methodVersion:'test-v1',cost:{state:'unknown',reason:'No real calls'},baseHeads:[{objectId:ref.objectId,versionId:null}],inputManifest:[],changes:[{revision,effect:'create',explanation:'Synthetic fixture'}],createdAt:now};
    const store=createKnowledgeStore(pool);await store.stage(change);await store.recordReview({id:randomUUID(),projectId:f.projectId,changeSetId:change.id,contentHash:change.contentHash,reviewer:'independent-synthetic-reviewer',policyVersion:'test-v1',purpose:change.purpose,decision:'exploration_only',rationale:'Engineering fixture',createdAt:now});await store.publish(f.projectId,change.id,change.contentHash);
    async function ledger(){const snapshot:Record<string,unknown>={};for(const table of ['projects','changesets','revisions','heads','reviews','publications','deps','invalidities','events'])snapshot[table]=(await pool.query(`SELECT to_jsonb(r) row FROM ccl_knowledge_${table} r ORDER BY to_jsonb(r)::text`)).rows;return snapshot;}
    await migrateManagedSources(pool);
    const registry=createPgSourceRegistry(pool),managedText='Synthetic existing source remains byte-for-byte intact';
    const managedDigest=(await import('node:crypto')).createHash('sha256').update(managedText).digest('hex');
    await registry.upsert({...f.context,authorization:{actions:['sources:write'],adapterIds:['manual'],rightsPolicyIds:['synthetic']}},
      {externalIdentity:{adapterId:'manual',externalObjectId:'existing',externalVersion:'v1'},expectedSourceHead:null,sourceSchemaVersion:'text/1',contentDigest:managedDigest,
       custody:{mode:'managed_copy',text:managedText},sourceKind:'document',author:null,publisher:null,acquirer:'synthetic',publishedAt:null,obtainedAt:now,
       assertionKind:'source_claim',sourceGroups:[],anchors:[],actualCoverage:[],limitations:[],rightsPolicyRef:'synthetic'},'existing-source');
    async function sourceRows(){return {heads:(await pool.query('SELECT to_jsonb(r) row FROM ccl_knowledge_source_heads r ORDER BY to_jsonb(r)::text')).rows,
      versions:(await pool.query('SELECT to_jsonb(r) row FROM ccl_knowledge_source_versions r ORDER BY to_jsonb(r)::text')).rows};}
    const oldSources=await sourceRows(),before=await ledger(),token=`synthetic-${randomUUID()}`;
    const app=express();app.use('/owner',businessSourceOwnerRouter(createBusinessSourceOwner(f.options),token,f.subjectId));business=app.listen(0,'127.0.0.1');await new Promise<void>(done=>business!.once('listening',done));
    const address=business.address();assert.ok(address&&typeof address!=='string');
    const settings={pool,port:0,token,principal:f.context.principal};
    const api=await createKnowledgeApi({...settings,sourceOwner:createHttpSourceOwner({baseUrl:`http://127.0.0.1:${address.port}/owner`,token})});apiServer=await api.listen();
    const clientFor=(server:Server)=>{const value=server.address();assert.ok(value&&typeof value!=='string');return createKnowledgeClient({baseUrl:`http://127.0.0.1:${value.port}`,scope:f.context.scope,headers:{Authorization:`Bearer ${token}`}});};
    const client=clientFor(apiServer),catalog=await client.catalog({purpose:'exploration_reading',limit:10});
    const exact=catalog.data.items[0].ref;const graph=await client.graph({root:{ref:exact},purpose:'exploration_reading',maxNodes:20,maxDepth:2,maxBytes:100_000,relationKinds:['supports','context']});
    assert.equal(graph.data.externalNodes.length,2);assert.ok(graph.data.externalNodes.every(node=>node.availability==='content_readable'));
    assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_business_source_reads')).rows[0].n,0);
    assert.deepEqual(f.stats(),{reads:0,cleanups:0});
    const report=await client.source({...f.reportRef,contentDigest:null},'exploration_reading');assert.deepEqual(report.data.ref,f.reportRef);
    const body=await client.sourceContent(report.data.ref,'exploration_reading');assert.equal(body.data.content,f.reportBytes.toString());
    const frame=await client.sourceContent(f.frameRef,'exploration_reading');assert.deepEqual(Buffer.from(frame.data.media!.base64,'base64'),f.frameBytes);
    assert.equal(frame.data.actualCoverage.exclusions.some(item=>item.includes('continuous video')),true);
    assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_business_source_reads')).rows[0].n,2);
    assert.deepEqual((await client.document(exact,'exploration_reading')).data.citations!.map(item=>item.ref.domain),['analysis','evidence']);
    assert.deepEqual(await sourceRows(),oldSources,'existing source rows are unchanged and no managed projection is inserted');
    const deniedPolicy={...f.policy(),generation:'2',grants:[]};f.setPolicy(deniedPolicy);
    await assert.rejects(client.sourceContent(f.frameRef,'exploration_reading'),code('SOURCE_FORBIDDEN'));
    const blocked=await client.graph({root:{ref:exact},purpose:'exploration_reading',maxNodes:20,maxDepth:2,maxBytes:100_000,relationKinds:['supports','context']});
    assert.ok(blocked.data.externalNodes.every(node=>node.availability==='forbidden'&&node.ref.contentDigest===null));
    assert.equal((await pool.query('SELECT count(*)::int n FROM ccl_business_source_reads')).rows[0].n,2);
    const disconnected=await createKnowledgeApi(settings);unconnected=await disconnected.listen();
    await assert.rejects(clientFor(unconnected).source(f.frameRef,'exploration_reading'),code('SOURCE_OWNER_UNCONNECTED'));
    assert.deepEqual(await ledger(),before,'all original revisions, heads, source refs, keys, publication timestamps and epochs are preserved');
    assert.equal(f.originalRowsUnchanged(),true);assert.deepEqual(await sourceLedger(),originalAnalysis);
  }finally{if(unconnected)await close(unconnected);if(apiServer)await close(apiServer);if(business)await close(business);await f.cleanup();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
