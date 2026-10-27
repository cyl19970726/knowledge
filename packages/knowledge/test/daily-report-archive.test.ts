import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { PoolClient } from 'pg';
import { readTestDatabase } from '../../../scripts/runtime/test-database.mjs';
import type { DailyResearchEntry, DailyResearchManifest } from '../../contracts/src/index.ts';
import { buildDailyResearch } from '../../discovery/src/index.ts';
import { stableHash } from '../src/learning-schemas.ts';
import { createDailyReportArchiveStore, migrateDailyReportArchive, selectDailyReportContext } from '../src/daily-report-archive.ts';
import { createDailyResearchStore, migrateDailyResearch } from '../src/daily-research.ts';
import { migrateKnowledgeLearning } from '../src/learning-migrations.ts';
import { createKnowledgeLearningStore } from '../src/learning-store.ts';

const connectionString = readTestDatabase();
const dbTest = connectionString ? test : test.skip;

function entry(revision = 1): DailyResearchEntry {
  const analysisRef = { domain: 'analysis' as const, ref: { objectId: randomUUID(), versionId: randomUUID() } };
  const sourceRef = { domain: 'source' as const, ref: { objectId: randomUUID(), versionId: randomUUID() } };
  const metricRef = { domain: 'metric' as const, ref: { objectId: randomUUID(), versionId: randomUUID() } };
  const manifest: DailyResearchManifest = {
    schemaVersion: 'daily-research@1', projectId: 'synthetic-project', date: '2026-10-16', timeZone: 'Asia/Taipei',
    cutoffAt: '2026-10-16T16:00:00Z', policyVersion: 'synthetic-policy@1', selection: null,
    materials: [{ materialId: randomUUID(), postId: 'external-1', title: 'Synthetic clip', sourceGroup: 'media-sha256:original-a',
      publisher: null, publishedAt: null, discoveredAt: '2026-10-16T12:00:00Z', lanes: ['creative'], refs: [sourceRef] }],
    currentFacts: [{ postId: 'external-1', sourceGroup: 'media-sha256:original-a', metric: 'likes', value: 1200,
      capturedAt: '2026-10-16T12:00:00Z', provider: 'synthetic', scope: 'post', comparabilityKey: 'synthetic-v1', ref: metricRef }],
    historyFacts: [],
    analyses: [{ resultRef: analysisRef, assetVersionId: randomUUID(), createdAt: '2026-10-16T12:00:00Z',
      sourceGroup: 'media-sha256:original-a', profile: 'overview', lanes: ['creative'], observations: ['切镜观察'], hypotheses: [], unknowns: [],
      quality: 'original_reviewed', adoption: 'exploration_only', adoptionRef: null,
      screening: { product: { verdict: 'defer', priority: 'low', reasons: ['产品关联不足'] },
        creative: { verdict: 'recommend_watch', priority: 'high', reasons: ['表达值得再看'] } } }],
    knowledge: [], gaps: ['三平台自动采集未启用'],
  };
  const report = buildDailyResearch(manifest);
  return { id: randomUUID(), projectId: manifest.projectId, date: manifest.date, revision, requestKey: `daily-${revision}`,
    manifestHash: stableHash(manifest), manifest, status: 'complete', report,
    createdAt: '2026-10-16T15:00:00Z', completedAt: '2026-10-16T15:00:01Z' };
}

test('topic context keeps exact analysis lines and drops metric-only or global digest claims', () => {
  const completed = entry();
  const archive = {
    sequence: 1, reportId: completed.id, projectId: completed.projectId, date: completed.date, revision: completed.revision,
    manifestHash: completed.manifestHash, reportHash: stableHash(completed.report), sourceGroups: ['media-sha256:original-a'],
    sourceRefs: completed.manifest.materials[0].refs, analysisRefs: [completed.manifest.analyses[0].resultRef],
    analysisSources: [{ ref: completed.manifest.analyses[0].resultRef.ref, sourceGroup: 'media-sha256:original-a' }],
    report: completed.report!, archivedAt: completed.completedAt!,
  };
  const context = selectDailyReportContext(archive, [completed.manifest.analyses[0].resultRef.ref]);
  assert.equal(context.reportId, completed.id);
  assert.equal(context.sections.creative.length, 2);
  assert.equal(context.sections.product.length, 0);
  assert.equal(context.sections.discoveries.length, 0);
  assert.ok(context.sections.counterexamplesAndGaps.every(item => item.references.some(ref => ref.domain === 'analysis')));
  assert.equal(selectDailyReportContext(archive, [{ objectId: randomUUID(), versionId: randomUUID() }]).sections.creative.length, 0);
});

dbTest('daily archive is idempotent, paged, exact-version searchable and transaction-bound', { timeout: 60_000 }, async () => {
  const admin = new pg.Pool({ connectionString, max: 2 });
  const schema = `ccl_daily_archive_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new pg.Pool({ connectionString, max: 5, options: `-c search_path=${schema}` });
  try {
    await migrateDailyResearch(pool); await migrateDailyReportArchive(pool); await migrateDailyReportArchive(pool); await migrateKnowledgeLearning(pool);
    const store = createDailyReportArchiveStore(pool);
    const daily = createDailyResearchStore(pool);
    const makeCommitted = async (revision: number) => {
      const sample = entry(revision);
      const prepared = await daily.prepare({ projectId: sample.projectId, requestKey: sample.requestKey, manifest: sample.manifest });
      return daily.complete(prepared.id, prepared.manifestHash, sample.report!);
    };
    const first = await makeCommitted(1);
    await assert.rejects(store.archive({ ...first, status: 'pending', report: null, completedAt: null }), /completed/i);
    const client = await pool.connect();
    try { await client.query('BEGIN'); await store.archive(first, client); await client.query('ROLLBACK'); }
    finally { client.release(); }
    assert.equal(await store.get(first.projectId, first.id), null);
    const archived = await store.archive(first);
    assert.equal(archived.reportId, first.id);
    assert.deepEqual(archived.sourceGroups, ['media-sha256:original-a']);
    assert.deepEqual(archived.analysisSources, [{ ref: first.manifest.analyses[0].resultRef.ref, sourceGroup: 'media-sha256:original-a' }]);
    const learning = createKnowledgeLearningStore(pool);
    const topic = await learning.createTopic({ projectId: first.projectId, title: 'Synthetic expression topic', question: 'What did the clip show?', method: 'synthetic', status: 'confirmed' });
    const original = { domain: 'analysis' as const, ref: archived.analysisSources[0].ref, sourceGroup: archived.analysisSources[0].sourceGroup };
    await learning.assignMembership({ projectId: first.projectId, source: original, topicId: topic.id, state: 'confirmed', reason: 'Synthetic navigation', methodVersion: 'synthetic' });
    await learning.registerInput({ projectId: first.projectId, eventKey: 'analysis-original', type: 'report', sources: [original], reason: 'Original analysis registered' });
    await learning.registerInput({ projectId: first.projectId, eventKey: `daily-archive:${archived.reportId}`, type: 'report', sources: [original], reason: 'Daily context archived' });
    assert.equal((await learning.snapshot(first.projectId)).pending.find(x => x.topicId === topic.id)?.count, 1);
    assert.equal((await store.archive(first)).sequence, archived.sequence);
    await assert.rejects(store.archive({ ...first, report: { ...first.report!, status: 'research_digest' } }), /matching completed daily report/);
    const invalidCursor = Buffer.from(JSON.stringify(['not-a-date', 1, 'not-a-uuid'])).toString('base64url');
    await assert.rejects(store.list(first.projectId, { cursor: invalidCursor }), (error: unknown) =>
      error instanceof Error && 'status' in error && error.status === 400);
    const second = await makeCommitted(2); await store.archive(second);
    assert.equal((await store.list(first.projectId, { limit: 1 })).items.length, 1);
    const page = await store.list(first.projectId, { limit: 1 });
    assert.equal((await store.list(first.projectId, { limit: 1, cursor: page.nextCursor! })).items.length, 1);
    assert.equal((await store.listRelevant(first.projectId, [first.manifest.analyses[0].resultRef.ref])).length, 1);
    assert.deepEqual((await store.listAfter(first.projectId, archived.sequence)).map(x => x.reportId), [second.id]);
    assert.equal(await store.get('another-project', first.id), null);
  } finally {
    await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end();
  }
});

dbTest('concurrent archives commit in cursor order without hiding an earlier transaction', { timeout: 60_000 }, async () => {
  const admin = new pg.Pool({ connectionString, max: 2 });
  const schema = `ccl_archive_order_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new pg.Pool({ connectionString, max: 5, options: `-c search_path=${schema}` });
  let firstDb: PoolClient | undefined;
  let secondDb: PoolClient | undefined;
  let second: Promise<unknown> | undefined;
  try {
    await migrateDailyResearch(pool); await migrateDailyReportArchive(pool);
    const daily = createDailyResearchStore(pool), archives = createDailyReportArchiveStore(pool);
    const completed = [];
    for (const revision of [1, 2]) {
      const sample = entry(revision);
      const prepared = await daily.prepare({ projectId: sample.projectId, requestKey: sample.requestKey, manifest: sample.manifest });
      completed.push(await daily.complete(prepared.id, prepared.manifestHash, sample.report!));
    }
    firstDb = await pool.connect(); secondDb = await pool.connect();
    await firstDb.query('BEGIN'); await secondDb.query('BEGIN');
    const pid = Number((await secondDb.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    await archives.archive(completed[0]!, firstDb);
    let secondCommitted = false;
    second = archives.archive(completed[1]!, secondDb).then(async () => {
      await secondDb!.query('COMMIT'); secondCommitted = true;
    });
    let waiting = false;
    for (let attempt = 0; attempt < 200 && !secondCommitted; attempt++) {
      const state = await pool.query('SELECT wait_event FROM pg_stat_activity WHERE pid=$1', [pid]);
      if (state.rows[0]?.wait_event === 'advisory') { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(waiting, true, 'the later archive must wait for the earlier transaction to commit');
    assert.deepEqual(await archives.listAfter(completed[0]!.projectId, 0), []);
    await firstDb.query('COMMIT');
    await second;
    const visible = await archives.listAfter(completed[0]!.projectId, 0);
    assert.deepEqual(visible.map(row => row.reportId), completed.map(row => row.id));
    assert.deepEqual((await archives.listAfter(completed[0]!.projectId, visible[0]!.sequence)).map(row => row.reportId), [completed[1]!.id]);
  } finally {
    await firstDb?.query('ROLLBACK');
    await second?.catch(() => {});
    await secondDb?.query('ROLLBACK');
    firstDb?.release(); secondDb?.release();
    await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end();
  }
});
