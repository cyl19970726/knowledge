import { readTestDatabase } from '../../../scripts/runtime/test-database.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { VersionRef } from '../../contracts/src/index.ts';
import { migrateKnowledge } from '../src/migrations.ts';
import { createKnowledgeStore } from '../src/store.ts';
import { createKnowledgeService } from '../src/service.ts';
import { claimRevision, SyntheticAnalysis } from './service-fixtures.ts';
import { platformOfAnalysis } from '../src/platform-applicability.ts';
import { buildAnalysisSourceRecord, analysisSourceRecordObjectId,
  analysisSourceProjectionFingerprint } from '../src/analysis-source-record.ts';
import { verifyAnalysisSourceAdmission } from '../src/analysis-source-admission.ts';
import { digest } from '../src/utils.ts';
import type { Dependency, KnowledgeChangeSet, KnowledgeReview, KnowledgeRevision, KnowledgeStore } from '../src/types.ts';
import type { PublicationScopeFacts, PublicationAuthorityScopeV1 } from '../src/wiki-publication-authority.ts';

// These revisions are synthetic store fixtures. They do not assert any business or model result.
const connectionString = readTestDatabase();
const dbTest = connectionString ? test : test.skip;
const ref = (): VersionRef => ({ objectId: randomUUID(), versionId: randomUUID() });
const now = () => new Date().toISOString();
const facts = (extra: Partial<PublicationScopeFacts> = {}): PublicationScopeFacts => ({
  topicIds: [], sourceObjectIds: [], sourceGroups: [], targetObjectIds: [], knowledgeObjectIds: [], ...extra,
});
const authorityScope = (scopeId: string, extra: Partial<Omit<PublicationAuthorityScopeV1, 'generation'>>) => ({
  scopeId, mode: 'active' as const, allowedMethodVersions: ['wiki-v1'],
  topicIds: [], sourceObjectIds: [], sourceGroups: [], targetObjectIds: [], ...extra,
});
const dependency = (domain: Dependency['domain'], target: VersionRef): Dependency =>
  ({ domain, ref: target, role: 'derived_from', critical: true });
const revision = (projectId: string, r = ref(), dependencies: Dependency[] = [], sourceGroups: string[] = []): KnowledgeRevision => ({
  kind: 'pattern', ref: r, projectId, title: 'Synthetic publication fixture', body: 'Synthetic publication fixture',
  scope: { applicability: { productVersionRefs: [], markets: [], languages: [], audiences: [], goals: [], requiredProduction: [], transferRationale: null },
    limitations: [], unknowns: [], goalTags: [], reviewDueAt: null },
  dependencies, sourceGroups, artifactRef: null, createdAt: now(), analysisQuality: null,
  content: { ref: r, projectId, title: 'Synthetic publication fixture', problem: 'test', mechanism: 'test', sequence: [],
    requiredElements: [], variableSlots: [], applicability: [], exclusions: [], supportRefs: [], counterexampleRefs: [],
    prediction: 'test', evidenceLevel: 'inconclusive', citations: [] },
});
const change = (projectId: string, rev: KnowledgeRevision, methodVersion = 'legacy-v1', base: string | null = null): KnowledgeChangeSet => ({
  id: randomUUID(), projectId, requestKey: randomUUID(), requestHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
  contentHash: randomUUID().replaceAll('-', '').padEnd(64, '0'), purpose: 'research', proposer: 'synthetic proposer',
  rationale: 'synthetic store test', methodVersion, cost: { state: 'unknown', reason: 'synthetic' },
  baseHeads: [{ objectId: rev.ref.objectId, versionId: base }], inputManifest: [],
  changes: [{ revision: rev, effect: base ? 'correct' : 'create', explanation: 'synthetic' }], createdAt: now(),
});
const review = (candidate: KnowledgeChangeSet): KnowledgeReview => ({
  id: randomUUID(), projectId: candidate.projectId, changeSetId: candidate.id, contentHash: candidate.contentHash,
  reviewer: 'independent synthetic reviewer', policyVersion: 'synthetic', purpose: candidate.purpose,
  decision: 'approved_for_purpose', rationale: 'synthetic store test', createdAt: now(),
});
async function ready(store: KnowledgeStore, candidate: KnowledgeChangeSet) {
  await store.stage(candidate);
  await store.recordReview(review(candidate));
}
async function publish(store: KnowledgeStore, candidate: KnowledgeChangeSet) {
  return store.publish(candidate.projectId, candidate.id, candidate.contentHash);
}

dbTest('store publication rejects late legacy work and stale frozen permits while preserving unrelated legacy writes and published retries',
  { timeout: 60_000 }, async () => {
    const admin = new pg.Pool({ connectionString, max: 2 });
    const schema = `ccl_store_authority_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({ connectionString, max: 6, options: `-c search_path=${schema}` });
    try {
      await migrateKnowledge(pool);
      const store = createKnowledgeStore(pool), projectId = randomUUID(), protectedSource = ref();
      const legacy = change(projectId, revision(projectId, ref(), [dependency('source', protectedSource)]));
      await ready(store, legacy); // Work was admitted and reviewed before the migration, with no published head.
      const first = await store.setPublicationAuthorityScope(projectId, null,
        authorityScope('source-range', { sourceObjectIds: [protectedSource.objectId] }));
      assert.equal(first.generation, 1);
      assert.equal(await store.isPublicationScopeProtected(projectId, facts({ sourceObjectIds: [protectedSource.objectId] })), true);
      await assert.rejects(publish(store, legacy), /frozen publication permit/i);
      assert.equal(await store.head(projectId, legacy.changes[0].revision.ref.objectId), null);

      const allowed = change(projectId, revision(projectId, ref(), [dependency('source', protectedSource)]), 'wiki-v1');
      allowed.publicationPermit = await store.capturePublicationPermit(projectId,
        facts({ sourceObjectIds: [protectedSource.objectId], targetObjectIds: [allowed.changes[0].revision.ref.objectId] }), 'wiki-v1');
      assert.deepEqual(allowed.publicationPermit?.grants, [{ scopeId: 'source-range', generation: 1 }]);
      await ready(store, allowed);
      const publication = await publish(store, allowed);
      assert.deepEqual(await store.head(projectId, allowed.changes[0].revision.ref.objectId), allowed.changes[0].revision.ref);

      const inFlight = change(projectId, revision(projectId, ref(), [dependency('source', protectedSource)]), 'wiki-v1');
      inFlight.publicationPermit = await store.capturePublicationPermit(projectId,
        facts({ sourceObjectIds: [protectedSource.objectId] }), 'wiki-v1');
      await ready(store, inFlight);
      assert.equal((await store.setPublicationAuthorityScope(projectId, 1,
        authorityScope('source-range', { sourceObjectIds: [protectedSource.objectId], mode: 'read_only' }))).generation, 2);
      await assert.rejects(publish(store, inFlight), /no longer authorizes/i);
      assert.equal(await store.head(projectId, inFlight.changes[0].revision.ref.objectId), null,
        'read-only switch cannot create a head from an in-flight task');
      assert.deepEqual(await publish(store, allowed), publication, 'an already published retry returns the same publication');
      assert.deepEqual(await store.head(projectId, allowed.changes[0].revision.ref.objectId), allowed.changes[0].revision.ref);
      await assert.rejects(store.capturePublicationPermit(projectId,
        facts({ sourceObjectIds: [protectedSource.objectId] }), 'wiki-v1'), /read-only/i);

      const outside = change(projectId, revision(projectId));
      assert.equal(await store.isPublicationScopeProtected(projectId,
        facts({ targetObjectIds: [outside.changes[0].revision.ref.objectId] })), false);
      assert.equal(await store.capturePublicationPermit(projectId,
        facts({ targetObjectIds: [outside.changes[0].revision.ref.objectId] }), 'legacy-v1'), null);
      await ready(store, outside);
      await publish(store, outside);
      assert.deepEqual(await store.head(projectId, outside.changes[0].revision.ref.objectId), outside.changes[0].revision.ref);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  });

dbTest('read-only source scope admits only exact synthetic Case 1.1 registration through the real service and store',
  { timeout: 60_000 }, async () => {
    const admin = new pg.Pool({ connectionString, max: 2 });
    const schema = `ccl_source_admission_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({ connectionString, max: 6, options: `-c search_path=${schema}` });
    try {
      await migrateKnowledge(pool);
      const projectId = randomUUID();
      const analysis = new SyntheticAnalysis();
      const { result, snapshot } = analysis.add(projectId, { adoptPurpose: null });
      const payload = { profile: 'overview', schemaVersion: 'video-overview@1', evidenceIndex: [],
        oneSentence: '合成原报告观测。', screening: { decision: 'candidate', reasons: ['仅供测试'], confidence: 'low' },
        corePoints: ['合成展示起点'], structure: [], notableChoices: [], unknowns: [],
        coverageState: { status: 'partial' } };
      const sourceProjectionReader = { readPayload: async () => payload };
      const reads = { analysis, sourceProjectionReader };
      const store = createKnowledgeStore(pool, {
        verifySourceAdmission: candidate => verifyAnalysisSourceAdmission(candidate, reads),
      });
      const service = createKnowledgeService({ store, analysis, sourceProjectionReader,
        reviewPolicy: { version: 'synthetic-independent-review', review: async () => ({
          reviewer: 'independent synthetic reviewer', decision: 'exploration_only' as const,
          rationale: 'Synthetic source registration only; no semantic or business approval',
        }) } });
      const sourceGroup = `media-sha256:${snapshot.original.sha256}`;
      const platform = platformOfAnalysis(snapshot);
      const source = buildAnalysisSourceRecord({ result, payload, sourceGroup, platform, contentType: 'video' });
      const fingerprint = analysisSourceProjectionFingerprint(source.sourceProjection);
      const objectId = analysisSourceRecordObjectId(projectId, result.ref);
      const caseRef = { objectId, versionId: analysisSourceRecordObjectId(projectId,
        { objectId, versionId: digest({ fingerprint, base: null }) }) };
      await store.setPublicationAuthorityScope(projectId, null,
        authorityScope('registered-original', { sourceGroups: [sourceGroup], mode: 'read_only' }));

      const exact = await service.proposeCase({ projectId,
        requestKey: `source-register-v1:${result.ref.versionId}:${fingerprint}`,
        purpose: 'exploration_reading', proposer: 'synthetic-source-registrar',
        analysisResultRef: result.ref, ref: caseRef, baseHead: null,
        title: '粗拉 · 原片结构与条件参考', summary: source.summary, body: source.body,
        sourceProjection: source.sourceProjection,
        citations: result.evidence.slice(0, 100).map(anchor => ({ kind: 'media' as const, anchor,
          supports: '原报告登记锚点，仅作原始资料导航，不代表本模块重新观看或语义批准。' })),
        scope: { applicability: { productVersionRefs: [], platforms: [platform], markets: [], languages: [],
          audiences: [], goals: [], requiredProduction: [], transferRationale: null },
          limitations: ['程序保全原报告；原质量、覆盖、未解析别名保持。登记未验证解释、医疗功效或经营效果。'],
          unknowns: result.coverage.gaps, goalTags: ['testing_learning'], reviewDueAt: null },
      });
      assert.equal(await verifyAnalysisSourceAdmission(exact, reads), true);
      await service.reviewChangeSet({ projectId, changeSetId: exact.id, contentHash: exact.contentHash,
        purpose: exact.purpose });
      const published = await service.publishRevision(projectId, exact.id, exact.contentHash);
      assert.deepEqual(await store.head(projectId, caseRef.objectId), caseRef);
      assert.deepEqual((await store.get(projectId, caseRef))?.revision.ref, caseRef,
        'the accurate original reference remains readable');
      assert.deepEqual(await service.publishRevision(projectId, exact.id, exact.contentHash), published);

      // These keep the registrar method and proposer labels. New IDs avoid a base-head CAS conflict,
      // so each rejection must come from the publication authority check itself.
      const forgery = () => {
        const altered = structuredClone(exact);
        altered.id = randomUUID(); altered.requestKey = randomUUID();
        altered.requestHash = randomUUID().replaceAll('-', '').padEnd(64, '0');
        altered.contentHash = randomUUID().replaceAll('-', '').padEnd(64, '0');
        const nextRef = ref();
        altered.baseHeads = [{ objectId: nextRef.objectId, versionId: null }];
        altered.changes[0]!.revision.ref = nextRef;
        if (altered.changes[0]!.revision.kind !== 'case') throw new Error('expected synthetic case');
        altered.changes[0]!.revision.content.ref = nextRef;
        return altered;
      };
      const changedBody = forgery(); changedBody.changes[0]!.revision.body += ' invented meaning';
      const changedSummary = forgery();
      if (changedSummary.changes[0]!.revision.kind !== 'case') throw new Error('expected synthetic case');
      changedSummary.changes[0]!.revision.content.summary = 'Invented semantic summary';
      const otherSource = forgery();
      if (otherSource.changes[0]!.revision.kind !== 'case') throw new Error('expected synthetic case');
      otherSource.changes[0]!.revision.content.sourceProjection!.source.sourceGroup = 'media-sha256:other-synthetic-source';
      const claim = claimRevision(projectId, ref(), 'Synthetic derived claim',
        { kind: 'media', anchor: result.evidence[0]!, supports: 'synthetic citation only' });
      claim.dependencies = [dependency('analysis', result.ref)];
      claim.sourceGroups = [sourceGroup];
      const derivedClaim = change(projectId, claim, exact.methodVersion);
      derivedClaim.proposer = exact.proposer;
      for (const candidate of [changedBody, changedSummary, otherSource, derivedClaim]) {
        assert.equal(await verifyAnalysisSourceAdmission(candidate, reads), false);
        await ready(store, candidate);
        await assert.rejects(publish(store, candidate), /frozen publication permit/i);
        assert.equal(await store.head(projectId, candidate.changes[0]!.revision.ref.objectId), null);
      }
      assert.deepEqual(await store.head(projectId, caseRef.objectId), caseRef);
      assert.deepEqual((await store.get(projectId, caseRef))?.revision.ref, caseRef);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  });

dbTest('store derives protected scope from historical base and indirect knowledge ancestors without relying on a binding or target ID',
  { timeout: 60_000 }, async () => {
    const admin = new pg.Pool({ connectionString, max: 2 });
    const schema = `ccl_store_ancestry_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({ connectionString, max: 6, options: `-c search_path=${schema}` });
    try {
      await migrateKnowledge(pool);
      const store = createKnowledgeStore(pool), projectId = randomUUID(), group = `media-sha256:${randomUUID()}`;
      const registeredSource = ref();
      const origin = revision(projectId, ref(), [dependency('source', registeredSource)], [group]);
      const originChange = change(projectId, origin);
      await ready(store, originChange); await publish(store, originChange);
      const middle = revision(projectId, ref(), [dependency('knowledge', origin.ref)]);
      const middleChange = change(projectId, middle);
      await ready(store, middleChange); await publish(store, middleChange);

      await store.setPublicationAuthorityScope(projectId, null,
        authorityScope('historical-group', { sourceGroups: [group] }));
      assert.equal(await store.isPublicationScopeProtected(projectId,
        facts({ knowledgeObjectIds: [middle.ref.objectId] })), true,
        'the public admission check resolves the published ancestor chain');

      const newObject = revision(projectId, ref(), [dependency('knowledge', middle.ref)]);
      assert.notEqual(newObject.ref.objectId, origin.ref.objectId);
      assert.equal(newObject.binding, undefined);
      const indirect = change(projectId, newObject);
      await ready(store, indirect);
      await assert.rejects(publish(store, indirect), /frozen publication permit/i);
      assert.equal(await store.head(projectId, newObject.ref.objectId), null);

      const contentLinked = revision(projectId);
      if (contentLinked.kind !== 'pattern') throw new Error('expected synthetic pattern');
      contentLinked.content.supportRefs = [middle.ref];
      assert.deepEqual(contentLinked.dependencies, []);
      assert.deepEqual(contentLinked.sourceGroups, []);
      const contentLinkChange = change(projectId, contentLinked);
      await ready(store, contentLinkChange);
      await assert.rejects(publish(store, contentLinkChange), /frozen publication permit/i,
        'a content support link inherits the protected published ancestor');
      assert.equal(await store.head(projectId, contentLinked.ref.objectId), null);

      const citedSource = revision(projectId);
      if (citedSource.kind !== 'pattern') throw new Error('expected synthetic pattern');
      citedSource.content.citations = [{ kind: 'source', sourceRef: registeredSource,
        locator: 'synthetic-record', supports: 'synthetic source citation' }];
      assert.deepEqual(citedSource.dependencies, []);
      assert.deepEqual(citedSource.sourceGroups, []);
      const citedSourceChange = change(projectId, citedSource);
      await ready(store, citedSourceChange);
      await assert.rejects(publish(store, citedSourceChange), /frozen publication permit/i,
        'a source citation resolves the published owner and its protected source group');
      assert.equal(await store.head(projectId, citedSource.ref.objectId), null);

      const corrected = revision(projectId, { objectId: origin.ref.objectId, versionId: randomUUID() });
      assert.equal(corrected.binding, undefined);
      assert.deepEqual(corrected.sourceGroups, []);
      const base = change(projectId, corrected, 'legacy-v1', origin.ref.versionId);
      await ready(store, base);
      await assert.rejects(publish(store, base), /frozen publication permit/i);
      assert.deepEqual(await store.head(projectId, origin.ref.objectId), origin.ref,
        'the protected historical head is unchanged');
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  });
