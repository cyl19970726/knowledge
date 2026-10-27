import { createHash } from 'node:crypto';
import type { AnalysisResult, ContentPlatform, ContentType, ResearchSourceProjection, VerifiedResearchEvidenceEntry } from '../../contracts/src/index.ts';
import { createResearchSourceProjection } from './research-projection.ts';
import { digest } from './utils.ts';

const MAX_CASE_BODY_BYTES = 1_000_000;

/** Distinct from historical derived Case heads; exact analysis versions never share a source identity. */
export function analysisSourceRecordObjectId(projectId: string, analysisRef: AnalysisResult['ref']): string {
  const hex = createHash('sha256').update(`${projectId}:source-case:${analysisRef.objectId}:${analysisRef.versionId}`).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}

/** Exact registration rendering, without any semantic interpretation or model call. */
export function buildAnalysisSourceRecord(input: {
  result: AnalysisResult;
  payload: unknown;
  sourceGroup: string;
  platform?: ContentPlatform; contentType?: ContentType;
  registeredEvidence?: readonly VerifiedResearchEvidenceEntry[];
}): { sourceProjection: ResearchSourceProjection; summary: string; body: string } {
  const sourceProjection = createResearchSourceProjection(input);
  const lines = [
    '原始分析报告登记副本。下列字段按准确报告原值呈现；本 Case 尚未形成派生理解、可复用规律或业务结论。',
    `分析版本：${sourceProjection.source.analysisRef.objectId}/${sourceProjection.source.analysisRef.versionId}`,
    `来源组：${sourceProjection.source.sourceGroup}`,
    `报告类型：${sourceProjection.source.profile} / ${sourceProjection.source.payloadSchemaVersion}`,
    `质量状态（仅原报告记录）：${JSON.stringify(sourceProjection.source.quality)}`,
    `覆盖状态（仅原报告记录）：${JSON.stringify(sourceProjection.source.coverage)}`,
    '原始选定字段：',
    ...sourceProjection.fields.map(field => `${field.path} = ${field.presence === 'present' ? JSON.stringify(field.value) : '[原报告中缺失]'}`),
    `证据别名映射状态：${JSON.stringify(sourceProjection.evidenceAliases)}`,
  ];
  const body = lines.join('\n');
  if (Buffer.byteLength(body, 'utf8') > MAX_CASE_BODY_BYTES)
    throw new Error(`Registered analysis source body exceeds ${MAX_CASE_BODY_BYTES} bytes; refusing to omit source fields`);
  const summary = `准确分析版本的原始字段登记副本（${sourceProjection.source.profile}/${sourceProjection.source.payloadSchemaVersion}）；尚无派生理解或语义审查。`;
  return { sourceProjection, summary, body };
}

export function analysisSourceProjectionFingerprint(projection: ResearchSourceProjection): string {
  return digest(projection);
}
