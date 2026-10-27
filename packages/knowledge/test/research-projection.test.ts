import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AnalysisResult } from '../../contracts/src/analysis.ts';
import { createResearchSourceProjection } from '../src/research-projection.ts';

const hash = (digit: string) => digit.repeat(64);
const receipt = { id: 'FRAME-007', kind: 'frame' as const, atMs: 7000, endMs: null,
  sha256: hash('a'), mimeType: 'image/jpeg' };
function result(profile: 'fine' | 'overview' = 'fine'): AnalysisResult {
  const assetVersionId = randomUUID();
  return { schemaVersion: '1.0', ref: { objectId: randomUUID(), versionId: randomUUID() },
    projectId: 'synthetic-project', contextSnapshotId: randomUUID(), runId: randomUUID(),
    attemptId: randomUUID(), assetVersionId, profile, question: 'Synthetic research question',
    purpose: 'exploration', methodDigest: hash('b'), inputDigest: hash('c'),
    coverage: { requested: { kind: 'whole' }, observed: [{ kind: 'whole' }],
      gaps: ['audio unverified'], channels: ['visual'] },
    payloadRef: { objectId: randomUUID(), sha256: hash('d'), bytes: 100,
      mimeType: 'application/json', storage: 'r2' },
    evidence: [{ assetVersionId, scope: { kind: 'whole' },
      sourceRef: { objectId: randomUUID(), versionId: randomUUID() } }],
    quality: { candidate: 'revised_unverified', review: 'completed_with_findings' },
    cost: { state: 'unknown', reason: 'synthetic' }, createdAt: '2026-10-20T00:00:00.000Z' };
}
function finePayload() {
  return { schemaVersion: 'video-fine@1', profile: 'fine', evidenceIndex: [receipt],
    reconstruction: { schemaVersion: 'video-reconstruction-2.0',
      summaryContractVersion: 'single-post-summary@1',
      knowledgeUnits: [{ id: 'KU1', text: 'A visible action',
        evidence: [{ refType: 'frame', ref: 'FRAME-007', supports: 'visible action' }] }],
      relations: [{ from: 'KU1', to: 'KU2', relation: 'prepares' }],
      viewerChange: { before: 'uncertain', after: 'curious' },
      coverageMatrix: { visual: 'sampled', audio: 'unknown' },
      metaGate: { result: 'limited' },
      builderLenses: { contentRestoration: { summary: 'content' },
        directingLogic: { summary: 'direction' }, visualEditing: { summary: 'editing' },
        finalSummary: { conclusion: 'conditional', contentSynthesis: 'content',
          directingSynthesis: 'direction', editingSynthesis: 'editing',
          reusableLessons: [{ id: 'L1', condition: 'real product demonstration',
            action: 'shoot a genuine demonstration', evidenceRefs: ['FRAME-007'] }],
          limits: ['outcome unknown'], performance: { known: false } } } } };
}
const field = (projection: ReturnType<typeof createResearchSourceProjection>, path: string) =>
  projection.fields.find(item => item.path === path);

test('fine projection preserves original paths, KU relations, conditional lessons and source quality', () => {
  const source = result(); const payload = finePayload();
  const projection = createResearchSourceProjection({ result: source, payload,platform:'douyin',contentType:'video',
    sourceGroup: 'synthetic-original-one', registeredEvidence: [{ evidenceIndex: 0,
      sourceEvidenceId: receipt.id, kind: receipt.kind, atMs: receipt.atMs,
      endMs: receipt.endMs, sha256: receipt.sha256 }] });
  for (const path of ['/reconstruction/knowledgeUnits', '/reconstruction/relations',
    '/reconstruction/viewerChange', '/reconstruction/coverageMatrix', '/reconstruction/metaGate',
    '/reconstruction/builderLenses/finalSummary/reusableLessons',
    '/reconstruction/builderLenses/finalSummary/limits',
    '/reconstruction/builderLenses/finalSummary/performance',
    '/reconstruction/builderLenses/contentRestoration',
    '/reconstruction/builderLenses/directingLogic',
    '/reconstruction/builderLenses/visualEditing']) {
    assert.deepEqual(field(projection, path), { path, presence: 'present',
      value: path.slice(1).split('/').reduce((node: any, key) => node[key], payload as any) });
  }
  assert.deepEqual(projection.source.analysisRef, source.ref);
  assert.equal(projection.source.sourceGroup, 'synthetic-original-one');
  assert.equal(projection.source.platform,'douyin');
  assert.equal(projection.source.contentType,'video');
  assert.deepEqual(projection.source.quality, source.quality);
  assert.deepEqual(projection.source.coverage, source.coverage);
  assert.deepEqual(projection.evidenceAliases, [{ localId: 'FRAME-007', status: 'resolved',
    evidenceIndex: 0, anchor: source.evidence[0] }]);
});

test('legacy absent fields remain explicitly absent and local IDs are report scoped', () => {
  const first = result(); const second = result();
  const payload = finePayload(); delete (payload.reconstruction as Record<string, unknown>).relations;
  const a = createResearchSourceProjection({ result: first, payload, sourceGroup: 'one' });
  const b = createResearchSourceProjection({ result: second, payload, sourceGroup: 'two' });
  assert.equal(a.source.platform,undefined,'unchanged historical projection keeps its original JSON shape');
  assert.deepEqual(field(a, '/reconstruction/relations'),
    { path: '/reconstruction/relations', presence: 'absent' });
  assert.notDeepEqual(a.source.analysisRef, b.source.analysisRef);
  assert.deepEqual(a.evidenceAliases, [{ localId: 'FRAME-007', status: 'unresolved',
    reason: 'catalog_unavailable' }]);
});

test('cue references retain their local ID and resolve only with the verified catalog', () => {
  const source = result(); const payload = finePayload();
  payload.reconstruction.knowledgeUnits[0]!.evidence[0] =
    { refType: 'cue', ref: 'CUE-0002', supports: 'source-bound caption' };
  (payload.evidenceIndex as Array<{ id: string; kind: 'frame' | 'caption'; atMs: number;
    endMs: number | null; sha256: string; mimeType: string }>)[0] =
    { ...receipt, id: 'CUE-0002', kind: 'caption' };
  const projected = createResearchSourceProjection({ result: source, payload,
    sourceGroup: 'one', registeredEvidence: [{ evidenceIndex: 0,
      sourceEvidenceId: 'CUE-0002', kind: 'caption', atMs: receipt.atMs,
      endMs: receipt.endMs, sha256: receipt.sha256 }] });
  assert.deepEqual(projected.evidenceAliases, [{ localId: 'CUE-0002', status: 'resolved',
    evidenceIndex: 0, anchor: source.evidence[0] },
    { localId: 'FRAME-007', status: 'unresolved', reason: 'not_registered' }]);
});

test('V2 overview retains both screening lanes and their conditions and watch segments', () => {
  const source = result('overview');
  const lane = { verdict: 'recommend_watch', priority: 'medium', reasons: [], unknowns: ['result unknown'],
    fineQuestion: 'How?', watchSegments: [{ startMs: 0, endMs: 8000,
      why: 'revisit', evidenceRefs: ['FRAME-007'] }],
    transferConditions: [{ condition: 'same product constraint', action: 'test a real demonstration',
      evidenceRefs: ['FRAME-007'] }] };
  const payload = { schemaVersion: 'video-overview@2', profile: 'overview',
    rubricVersion: 'dual-screening@1', screening: { product: lane, creative: lane },
    commonObservations: [{ startMs: 7000, endMs: 7001, text: 'visible action', evidenceRefs: ['FRAME-007'] }],
    coverageState: 'partial', evidenceIndex: [receipt] };
  const projection = createResearchSourceProjection({ result: source, payload, sourceGroup: 'one' });
  assert.deepEqual(field(projection, '/screening')?.value, payload.screening);
  assert.deepEqual(field(projection, '/commonObservations')?.value, payload.commonObservations);
  assert.deepEqual(field(projection, '/originalOverview'),
    { path: '/originalOverview', presence: 'absent' });
});

test('rejects duplicate, guessed and inconsistent evidence mappings; never infers ordinal aliases', () => {
  const source = result(); const payload = finePayload();
  const verified = { evidenceIndex: 0, sourceEvidenceId: receipt.id,
    kind: receipt.kind, atMs: receipt.atMs, endMs: receipt.endMs, sha256: receipt.sha256 };
  assert.throws(() => createResearchSourceProjection({ result: source, payload,
    sourceGroup: 'one', registeredEvidence: [{ ...verified, sourceEvidenceId: 'FRAME-001' }] }),
  /Unverified or ambiguous/);
  assert.throws(() => createResearchSourceProjection({ result: source, payload: {
    ...payload, evidenceIndex: [receipt, receipt] }, sourceGroup: 'one' }), /Ambiguous local/);
  assert.throws(() => createResearchSourceProjection({ result: source, payload,
    sourceGroup: 'one', registeredEvidence: [{ ...verified, atMs: 9000 }] }),
  /Unverified or ambiguous/);
  assert.equal(createResearchSourceProjection({ result: source, payload,
    sourceGroup: 'one' }).evidenceAliases[0]?.status, 'unresolved');
});

test('oversized sources fail instead of silently truncating', () => {
  const payload = finePayload();
  payload.reconstruction.builderLenses.contentRestoration.summary = 'x'.repeat(1_000_001);
  assert.throws(() => createResearchSourceProjection({ result: result(), payload,
    sourceGroup: 'one' }), /exceeds/);
});
