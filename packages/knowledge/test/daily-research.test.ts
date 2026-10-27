import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { readTestDatabase } from '../../../scripts/runtime/test-database.mjs';
import type { DailyResearchManifest } from '../../contracts/src/daily-research.ts';
import { buildDailyResearch } from '../../discovery/src/index.ts';
import { createDailyResearchStore, DailyResearchConflictError, migrateDailyResearch } from '../src/daily-research.ts';

const connectionString = readTestDatabase();
const dbTest = connectionString ? test : test.skip;

const manifest = (): DailyResearchManifest => ({
  schemaVersion: 'daily-research@1', projectId: 'synthetic-project', date: '2026-10-16', timeZone: 'Asia/Taipei',
  cutoffAt: '2026-10-16T16:00:00Z', policyVersion: 'synthetic-policy@1', selection: null,
  materials: [], currentFacts: [], historyFacts: [], analyses: [], knowledge: [], gaps: [],
});

dbTest('daily report versions are atomic, immutable, idempotent, and isolated', { timeout: 60_000 }, async () => {
  const admin = new pg.Pool({ connectionString, max: 2 });
  const schema = `ccl_daily_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new pg.Pool({ connectionString, max: 5, options: `-c search_path=${schema}` });
  try {
    await migrateDailyResearch(pool); await migrateDailyResearch(pool);
    const store = createDailyResearchStore(pool);
    const frozen = manifest();
    const sourceRef = { objectId: randomUUID(), versionId: randomUUID() };
    frozen.materials.push({ materialId: sourceRef.objectId, title: 'Original frozen title', postId: 'synthetic-post',
      sourceGroup: 'synthetic-source', publisher: 'Synthetic publisher', publishedAt: null,
      discoveredAt: '2026-10-16T12:00:00Z', lanes: ['creative'], refs: [{ domain: 'source', ref: sourceRef }] });
    const prepared = await store.prepare({ projectId: frozen.projectId, requestKey: 'daily-1', manifest: frozen });
    assert.equal(prepared.status, 'pending');
    assert.equal(prepared.revision, 1);
    assert.equal(prepared.report, null);
    assert.equal((await store.getByRequestKey(frozen.projectId, 'daily-1'))?.id, prepared.id);
    assert.deepEqual(await store.readSourceVersion(frozen.projectId, sourceRef), frozen.materials[0]);
    assert.equal(await store.readSourceVersion('another-project', sourceRef), null);
    assert.equal(await store.readSourceVersion(frozen.projectId, { ...sourceRef, versionId: randomUUID() }), null);
    const retry = await store.prepare({ projectId: frozen.projectId, requestKey: 'daily-1', manifest: { ...frozen } });
    assert.equal(retry.id, prepared.id);
    await assert.rejects(store.prepare({ projectId: frozen.projectId, requestKey: 'daily-1', manifest: { ...frozen, gaps: ['New gap'] } }), DailyResearchConflictError);
    const report = buildDailyResearch(frozen);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await store.complete(prepared.id, prepared.manifestHash, report, client);
      await client.query('ROLLBACK');
    } finally { client.release(); }
    assert.equal((await store.get(frozen.projectId, prepared.id))?.status, 'pending');
    await assert.rejects(store.complete(prepared.id, prepared.manifestHash, {
      ...report, sections: { ...report.sections, discoveries: [{ lane: null, sourceGroup: null, text: 'Synthetic unsupported citation', stance: 'observation',
        references: [{ domain: 'source', ref: { objectId: randomUUID(), versionId: randomUUID() } }] }] },
    }), DailyResearchConflictError);
    const completed = await store.complete(prepared.id, prepared.manifestHash, report);
    assert.equal(completed.status, 'complete');
    assert.equal((await store.complete(prepared.id, prepared.manifestHash, report)).id, prepared.id);
    await assert.rejects(store.complete(prepared.id, 'a'.repeat(64), report), DailyResearchConflictError);
    await assert.rejects(store.complete(prepared.id, prepared.manifestHash, {
      ...report, status: report.status === 'research_digest' ? 'partial' : 'research_digest',
    }), DailyResearchConflictError);
    const variants = await Promise.all(Array.from({ length: 3 }, (_, n) => store.prepare({ projectId: frozen.projectId, requestKey: `daily-${n + 2}`, manifest: { ...frozen, gaps: [`gap-${n}`] } })));
    assert.deepEqual(variants.map(x => x.revision).sort(), [2, 3, 4]);
    assert.equal((await store.previousCompleted(frozen.projectId,frozen.date,5))?.id,prepared.id,
      'pending revisions must not displace the previous completed comparison');
    assert.equal(await store.previousCompleted(frozen.projectId,frozen.date,1),null);
    assert.equal(await store.previousCompleted('another-project',frozen.date,5),null);
    assert.equal((await store.list(frozen.projectId, { date: frozen.date, limit: 2 })).items.length, 2);
    const firstPage = await store.list(frozen.projectId, { limit: 2 });
    const secondPage = await store.list(frozen.projectId, { limit: 2, cursor: firstPage.nextCursor! });
    assert.equal(new Set([...firstPage.items, ...secondPage.items].map(x => x.id)).size, 4);
    assert.equal(await store.get('another-project', prepared.id), null);
    const updatedSourceRef = { ...sourceRef, versionId: randomUUID() };
    await store.prepare({ projectId: frozen.projectId, requestKey: 'updated-source', manifest: {
      ...frozen, materials: [{ ...frozen.materials[0]!, title: 'Revised catalog title', refs: [{ domain: 'source', ref: updatedSourceRef }] }],
    } });
    assert.equal((await store.readSourceVersion(frozen.projectId, sourceRef))?.title, 'Original frozen title');
    assert.equal((await store.readSourceVersion(frozen.projectId, updatedSourceRef))?.title, 'Revised catalog title');
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});

dbTest('semantic report completion requires the exact frozen question, source and successful method receipt', {timeout:60_000},async()=>{
  const admin=new pg.Pool({connectionString,max:2});
  const schema=`ccl_daily_semantic_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,max:3,options:`-c search_path=${schema}`});
  try {
    await migrateDailyResearch(pool);
    await pool.query('CREATE TABLE aw_runs(workspace_id text NOT NULL,id text NOT NULL,document jsonb NOT NULL,PRIMARY KEY(workspace_id,id))');
    const frozen=manifest();
    const resultRef={objectId:randomUUID(),versionId:randomUUID()},sourceGroup='synthetic-original-group';
    frozen.method={version:'daily-semantic-research@1',maxModelCalls:4,maxToolReads:12};
    frozen.questions=[{id:'creative',question:'Which synthetic structure is visible?',dimensions:['creative']}];
    frozen.sourceProjections=[{schemaVersion:'research-source-projection@1',source:{projectId:frozen.projectId,sourceGroup,
      analysisRef:resultRef,assetVersionId:randomUUID(),profile:'fine',payloadSchemaVersion:'video-fine@1',
      createdAt:'2026-10-16T12:00:00Z',question:'Synthetic analysis question',purpose:'exploration_reading',
      quality:{candidate:'original_reviewed',review:'completed_no_findings'},
      coverage:{requested:{kind:'whole'},observed:[{kind:'whole'}],gaps:['Audio semantics not independently checked'],channels:['visual']}},
      fields:[],evidenceAliases:[]}];
    frozen.queryLog=[{questionId:'creative',query:'Synthetic exact source',considered:1,
      included:[{domain:'analysis',ref:resultRef}],excluded:[],limit:200,truncated:false}];
    const prepared=await createDailyResearchStore(pool).prepare({projectId:frozen.projectId,requestKey:'semantic-fixture',manifest:frozen});
    const workflowRunId=randomUUID();
    const semantic={workflowRunId,methodVersion:frozen.method.version,status:'reviewed' as const,
      review:{passed:true,issues:[]},findings:[{questionId:'creative',form:'Visible synthetic demonstration',
        structure:'Task then obstacle',conditions:'Only a similar visible task',
        priorUnderstanding:'No comparable previous understanding',currentUnderstanding:'One synthetic report describes the sequence',
        relationship:'unknown' as const,whyItMatters:'Storyboard question',watchFor:'Visible obstacle',
        unknown:'Performance unknown',nextAction:'Test a storyboard',references:[{domain:'analysis' as const,ref:resultRef}],sourceGroups:[sourceGroup]}],
      limitations:['Only one synthetic source group']};
    const {workflowRunId:_,...output}=semantic;
    await pool.query(`INSERT INTO aw_runs(workspace_id,id,document) VALUES($1,$2,$3)`,[frozen.projectId,workflowRunId,{
      id:workflowRunId,workflowId:'commerce.daily-research',workflowRevision:frozen.method.version,state:'succeeded',output,
      metadata:{commerce:{projectId:frozen.projectId,workflowRevision:frozen.method.version},caller:{manifestCutoffAt:frozen.cutoffAt}}}]);
    const report={...buildDailyResearch(frozen),semanticResearch:semantic};
    const store=createDailyResearchStore(pool);
    await assert.rejects(store.complete(prepared.id,prepared.manifestHash,{...report,semanticResearch:{...semantic,
      findings:[{...semantic.findings[0]!,references:[{domain:'analysis' as const,ref:{objectId:randomUUID(),versionId:randomUUID()}}]}]}}),
      /frozen read set/);
    await assert.rejects(store.complete(prepared.id,prepared.manifestHash,{...report,semanticResearch:{...semantic,
      findings:[{...semantic.findings[0]!,sourceGroups:['invented-source-group']}]}}),/frozen read set/);
    await assert.rejects(store.complete(prepared.id,prepared.manifestHash,{...report,semanticResearch:{...semantic,
      findings:[{...semantic.findings[0]!,questionId:'other'}]}}),/frozen read set/);
    await assert.rejects(store.complete(prepared.id,prepared.manifestHash,{...report,semanticResearch:{...semantic,
      workflowRunId:randomUUID()}}),/workflow receipt/);
    await assert.rejects(store.complete(prepared.id,prepared.manifestHash,{...report,semanticResearch:{...semantic,
      findings:[{...semantic.findings[0]!,currentUnderstanding:'Invented reviewed conclusion'}]}}),/workflow receipt/);
    await assert.rejects(store.complete(prepared.id,prepared.manifestHash,{...report,semanticResearch:{...semantic,
      review:{passed:false,issues:['Failed']}}}),/matching reviewed method/);
    const completed=await store.complete(prepared.id,prepared.manifestHash,report);
    assert.equal(completed.report?.semanticResearch?.workflowRunId,workflowRunId);
  } finally {await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
