import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SyntheticAnalysis } from './service-fixtures.ts';
import { createKnowledgeService } from '../src/service.ts';
import type { KnowledgeChangeSet, KnowledgeStore } from '../src/types.ts';
import { platformOfAnalysis } from '../src/platform-applicability.ts';
import { buildAnalysisSourceRecord, analysisSourceRecordObjectId,
  analysisSourceProjectionFingerprint } from '../src/analysis-source-record.ts';
import { verifyAnalysisSourceAdmission } from '../src/analysis-source-admission.ts';
import { digest } from '../src/utils.ts';

const projectId = `source-admission-${randomUUID()}`;

async function registeredChange() {
  const analysis = new SyntheticAnalysis();
  const { result, snapshot } = analysis.add(projectId, { adoptPurpose: null });
  const payload = { profile: 'overview', schemaVersion: 'video-overview@1', evidenceIndex: [],
    oneSentence: '原报告观测。', screening: { decision: 'candidate', reasons: ['进一步读取'], confidence: 'low' },
    corePoints: ['展示起点'], structure: [], notableChoices: [], unknowns: [],
    coverageState: { status: 'partial' } };
  const reader = { readPayload: async () => payload };
  const sourceGroup = `media-sha256:${snapshot.original.sha256}`;
  const platform = platformOfAnalysis(snapshot);
  const source = buildAnalysisSourceRecord({ result, payload, sourceGroup, platform, contentType: 'video' });
  const fingerprint = analysisSourceProjectionFingerprint(source.sourceProjection);
  const objectId = analysisSourceRecordObjectId(projectId, result.ref);
  const caseRef = { objectId, versionId: analysisSourceRecordObjectId(projectId,
    { objectId, versionId: digest({ fingerprint, base: null }) }) };
  const store = new Proxy({
    getByRequestKey: async () => null,
    get: async () => null,
    validate: async () => ({ valid: true, issues: [] }),
    stage: async (change: KnowledgeChangeSet) => change,
  }, { get(target, key) { return Reflect.get(target, key) ?? (async () => null); } }) as unknown as KnowledgeStore;
  const service = createKnowledgeService({ store, analysis, sourceProjectionReader: reader });
  const change = await service.proposeCase({ projectId,
    requestKey: `source-register-v1:${result.ref.versionId}:${fingerprint}`,
    purpose: 'exploration_reading', proposer: 'irrelevant-proposer-label',
    analysisResultRef: result.ref, ref: caseRef, baseHead: null,
    title: `粗拉 · 原片结构与条件参考`, summary: source.summary, body: source.body,
    sourceProjection: source.sourceProjection,
    citations: result.evidence.slice(0, 100).map(anchor => ({ kind: 'media' as const, anchor,
      supports: '原报告登记锚点，仅作原始资料导航，不代表本模块重新观看或语义批准。' })),
    scope: { applicability: { productVersionRefs: [], platforms: [platform], markets: [], languages: [],
      audiences: [], goals: [], requiredProduction: [], transferRationale: null },
      limitations: ['程序保全原报告；原质量、覆盖、未解析别名保持。登记未验证解释、医疗功效或经营效果。'],
      unknowns: result.coverage.gaps, goalTags: ['testing_learning'], reviewDueAt: null },
  });
  return { change, reads: { analysis, sourceProjectionReader: reader } };
}

test('only the service-normalized exact Case 1.1 source admission is exempt', async () => {
  const { change, reads } = await registeredChange();
  assert.equal(await verifyAnalysisSourceAdmission(change, reads), true);
  const copy = () => structuredClone(change);
  const changedId = copy(); changedId.changes[0]!.revision.ref.versionId = randomUUID();
  assert.equal(await verifyAnalysisSourceAdmission(changedId, reads), false);
  const changedBody = copy(); changedBody.changes[0]!.revision.body += ' fabricated meaning';
  assert.equal(await verifyAnalysisSourceAdmission(changedBody, reads), false);
  const changedSummary = copy();
  if (changedSummary.changes[0]!.revision.kind !== 'case') throw new Error('fixture');
  changedSummary.changes[0]!.revision.content.summary = 'fabricated semantic summary';
  assert.equal(await verifyAnalysisSourceAdmission(changedSummary, reads), false);
  const changedProjection = copy();
  if (changedProjection.changes[0]!.revision.kind !== 'case') throw new Error('fixture');
  changedProjection.changes[0]!.revision.content.sourceProjection!.source.sourceGroup = 'media-sha256:forged';
  assert.equal(await verifyAnalysisSourceAdmission(changedProjection, reads), false);
  const extraDependency = copy(); extraDependency.changes[0]!.revision.dependencies.push({
    domain: 'knowledge', ref: { objectId: randomUUID(), versionId: randomUUID() }, role: 'uses', critical: true });
  assert.equal(await verifyAnalysisSourceAdmission(extraDependency, reads), false);
  const mixed = copy(); mixed.changes.push(structuredClone(mixed.changes[0]!));
  assert.equal(await verifyAnalysisSourceAdmission(mixed, reads), false);
  const withdrawn = copy(); withdrawn.changes[0]!.effect = 'withdraw';
  assert.equal(await verifyAnalysisSourceAdmission(withdrawn, reads), false);
  const forgedMethod = copy(); forgedMethod.methodVersion = 'other';
  assert.equal(await verifyAnalysisSourceAdmission(forgedMethod, reads), false);
  await assert.rejects(verifyAnalysisSourceAdmission(change, {
    analysis: reads.analysis, sourceProjectionReader: { readPayload: async () => { throw new Error('source unavailable'); } },
  }), /source unavailable/);
});
