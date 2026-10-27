import {
  AnalysisContextSnapshotSchema, AnalysisResultSchema,
  type AnalysisReadPort, type AnalysisResult, type VerifiedResearchEvidenceEntry,
} from '../../contracts/src/index.ts';
import type { Dependency, KnowledgeChangeSet, KnowledgeScope } from './types.ts';
import { buildAnalysisSourceRecord, analysisSourceRecordObjectId,
  analysisSourceProjectionFingerprint } from './analysis-source-record.ts';
import { platformOfAnalysis } from './platform-applicability.ts';
import { canonical, digest, uniqueDeps } from './utils.ts';

export interface AnalysisSourceAdmissionReads {
  analysis: AnalysisReadPort;
  sourceProjectionReader: {
    readPayload(projectId: string, result: AnalysisResult): Promise<unknown>;
    readEvidenceCatalog?(projectId: string, result: AnalysisResult): Promise<readonly VerifiedResearchEvidenceEntry[]>;
  };
}

/**
 * The only Case 1.1 publication exemption: exact deterministic source registration.
 * A false result denies the exemption. Reader failures propagate so a missing source
 * cannot silently turn into an accepted registration.
 */
export async function verifyAnalysisSourceAdmission(
  change: KnowledgeChangeSet, reads: AnalysisSourceAdmissionReads,
): Promise<boolean> {
  if (change.purpose !== 'exploration_reading' || change.methodVersion !== 'knowledge-case-v1' ||
      change.changes.length !== 1 || change.baseHeads.length !== 1) return false;
  const entry = change.changes[0]!;
  const rev = entry.revision;
  if (rev.kind !== 'case' || rev.content.schemaVersion !== '1.1' || !rev.content.sourceProjection ||
      rev.binding !== undefined || (entry.effect !== 'create' && entry.effect !== 'correct')) return false;
  const base = change.baseHeads[0]!;
  if (base.objectId !== rev.ref.objectId || (entry.effect === 'create') !== (base.versionId === null)) return false;
  if (rev.projectId !== change.projectId || rev.content.projectId !== change.projectId ||
      canonical(rev.content.ref) !== canonical(rev.ref) ||
      rev.content.createdAt !== rev.createdAt) return false;

  const rawResult = await reads.analysis.getResult(change.projectId, rev.content.analysisResultRef);
  if (!rawResult) return false;
  const result = AnalysisResultSchema.parse(rawResult);
  if (result.projectId !== change.projectId || canonical(result.ref) !== canonical(rev.content.analysisResultRef)) return false;
  const rawSnapshot = await reads.analysis.getContextSnapshot(change.projectId, result.contextSnapshotId);
  if (!rawSnapshot) return false;
  const snapshot = AnalysisContextSnapshotSchema.parse(rawSnapshot);
  if (snapshot.projectId !== change.projectId || snapshot.ref.versionId !== result.contextSnapshotId ||
      snapshot.assetVersionId !== result.assetVersionId) return false;
  if (snapshot.durationMs !== null && result.evidence.some(anchor =>
    anchor.scope.kind === 'segment' && anchor.scope.endMs > snapshot.durationMs!)) return false;

  const sourceGroup = `media-sha256:${snapshot.original.sha256}`;
  const platform = snapshot.original.mimeType.startsWith('video/') ? platformOfAnalysis(snapshot) : 'unknown';
  const contentType = snapshot.original.mimeType.startsWith('video/') ? 'video' as const :
    snapshot.original.mimeType.startsWith('image/') ? 'image_post' as const : 'unknown' as const;
  const source = buildAnalysisSourceRecord({ result,
    payload: await reads.sourceProjectionReader.readPayload(change.projectId, result), sourceGroup, platform, contentType,
    registeredEvidence: await reads.sourceProjectionReader.readEvidenceCatalog?.(change.projectId, result) });
  const objectId = analysisSourceRecordObjectId(change.projectId, result.ref);
  const fingerprint = analysisSourceProjectionFingerprint(source.sourceProjection);
  const versionId = analysisSourceRecordObjectId(change.projectId,
    { objectId, versionId: digest({ fingerprint, base: base.versionId }) });
  if (rev.ref.objectId !== objectId || rev.ref.versionId !== versionId ||
      change.requestKey !== `source-register-v1:${result.ref.versionId}:${fingerprint}` ||
      canonical(rev.content.sourceProjection) !== canonical(source.sourceProjection)) return false;

  const title = `${result.profile === 'fine' ? '精拉' : '粗拉'} · ${snapshot.sourceContext.post?.title?.text?.slice(0, 160) ?? '原片结构与条件参考'}`;
  const citations = result.evidence.slice(0, 100).map(anchor => ({ kind: 'media' as const, anchor,
    supports: '原报告登记锚点，仅作原始资料导航，不代表本模块重新观看或语义批准。' }));
  const expectedContent = { schemaVersion: '1.1', sourceProjection: source.sourceProjection,
    ref: rev.ref, projectId: change.projectId, analysisResultRef: result.ref,
    title, summary: source.summary, citations, createdAt: rev.createdAt };
  const expectedScope: KnowledgeScope = {
    applicability: { productVersionRefs: [], platforms: [platform], markets: [], languages: [],
      audiences: [], goals: [], requiredProduction: [], transferRationale: null },
    limitations: [
      '程序保全原报告；原质量、覆盖、未解析别名保持。登记未验证解释、医疗功效或经营效果。',
      `仅覆盖 ${result.coverage.channels.join('/')} 通道；${result.profile} 结果不证明商业效果`,
      '同源去重目前依据原片 SHA-256；剪辑变体或共同作者关系仍需来源核查',
    ],
    unknowns: [...new Set([...result.coverage.gaps, ...snapshot.unknowns])],
    goalTags: ['testing_learning'], reviewDueAt: null,
  };
  const mediaUses: Dependency[] = citations.map(citation => ({
    domain: 'analysis', ref: result.ref, role: 'derived_from', critical: true,
    ...(result.coverage.channels.length ? { useScope: { anchor: citation.anchor,
      channels: result.coverage.channels, mediaScope: citation.anchor.scope } } : {}),
  }));
  const dependencies = uniqueDeps([
    { domain: 'analysis', ref: result.ref, role: 'derived_from', critical: true },
    ...mediaUses,
    { domain: 'context', ref: snapshot.ref, role: 'uses', critical: true },
    ...citations.map(citation => ({ domain: 'evidence' as const, ref: citation.anchor.sourceRef,
      role: 'supports' as const, critical: true })),
  ]);
  return rev.title === title && rev.body === source.body &&
    canonical(rev.content) === canonical(expectedContent) &&
    canonical(rev.scope) === canonical(expectedScope) &&
    canonical(rev.dependencies) === canonical(dependencies) &&
    canonical(change.inputManifest) === canonical(dependencies) &&
    canonical(rev.sourceGroups) === canonical([sourceGroup]) &&
    canonical(rev.analysisQuality) === canonical(result.quality);
}
