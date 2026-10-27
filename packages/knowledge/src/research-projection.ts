import { z } from 'zod';
import type { AnalysisResult, ContentPlatform, ContentType, ResearchSourceProjection, VerifiedResearchEvidenceEntry } from '../../contracts/src/index.js';
import { AnalysisResultSchema, ResearchSourceFieldSchema, ResearchSourceProjectionSchema,
  VerifiedResearchEvidenceEntrySchema } from '../../contracts/src/index.js';

const MAX_INPUT_BYTES = 1_000_000;
const MAX_OUTPUT_BYTES = 1_500_000;
const MAX_DEPTH = 48;
const MAX_REFERENCES = 10_000;

const finePaths = [
  '/reconstruction/schemaVersion', '/reconstruction/summaryContractVersion',
  '/reconstruction/depthContractVersion', '/reconstruction/scopeStatement',
  '/reconstruction/transcript', '/reconstruction/knowledgeUnits',
  '/reconstruction/relations', '/reconstruction/viewerChange',
  '/reconstruction/coverageMatrix', '/reconstruction/metaGate',
  '/reconstruction/derivedSources', '/reconstruction/builderLenses/contentRestoration',
  '/reconstruction/builderLenses/directingLogic', '/reconstruction/builderLenses/visualEditing',
  '/reconstruction/builderLenses/finalSummary/conclusion',
  '/reconstruction/builderLenses/finalSummary/contentSynthesis',
  '/reconstruction/builderLenses/finalSummary/directingSynthesis',
  '/reconstruction/builderLenses/finalSummary/editingSynthesis',
  '/reconstruction/builderLenses/finalSummary/reusableLessons',
  '/reconstruction/builderLenses/finalSummary/limits',
  '/reconstruction/builderLenses/finalSummary/performance',
  '/evidenceIndex',
] as const;
const overviewV2Paths = [
  '/rubricVersion', '/screening', '/commonObservations', '/coverageState',
  '/originalOverview', '/originalCandidateSha256', '/review', '/revisionResponse',
  '/evidenceIndex',
] as const;
const overviewV1Paths = [
  '/oneSentence', '/screening', '/corePoints', '/structure', '/notableChoices',
  '/unknowns', '/coverageState', '/evidenceIndex',
] as const;

const PayloadHeaderSchema = z.object({
  schemaVersion: z.enum(['video-fine@1', 'video-overview@1', 'video-overview@2']),
  profile: z.enum(['fine', 'overview']),
  evidenceIndex: z.array(z.object({ id: z.string().min(1), kind: z.enum(['frame', 'caption', 'source_text']),
    atMs: z.int().nonnegative(), endMs: z.int().nonnegative().nullable(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), mimeType: z.string().min(3) }).passthrough()).max(MAX_REFERENCES),
}).passthrough();

function boundedJson(value: unknown, limit: number): string {
  // z.json rejects undefined, functions, non-finite numbers and cyclic objects.
  z.json().parse(value);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > limit) throw new Error(`Research source exceeds ${limit} bytes`);
  return json;
}

function atPath(root: Record<string, unknown>, path: string): { presence: 'present'; value: unknown } | { presence: 'absent' } {
  let node: unknown = root;
  for (const part of path.slice(1).split('/')) {
    if (typeof node !== 'object' || node === null || Array.isArray(node) || !Object.hasOwn(node, part))
      return { presence: 'absent' };
    node = (node as Record<string, unknown>)[part];
  }
  return { presence: 'present', value: node };
}

function referencedLocalIds(fields: ResearchSourceProjection['fields']): string[] {
  const ids = new Set<string>();
  function visit(value: unknown, depth: number): void {
    if (depth > MAX_DEPTH) throw new Error('Research source nesting exceeds limit');
    if (Array.isArray(value)) { value.forEach(item => visit(item, depth + 1)); return; }
    if (typeof value !== 'object' || value === null) return;
    const item = value as Record<string, unknown>;
    if (Array.isArray(item.evidenceRefs)) for (const id of item.evidenceRefs) {
      if (typeof id !== 'string' || !id.trim()) throw new Error('Invalid local evidence reference');
      ids.add(id);
    }
    if (['frame', 'cue', 'caption', 'source_text'].includes(String(item.refType)) && typeof item.ref === 'string')
      ids.add(item.ref);
    for (const [key, child] of Object.entries(item)) if (key !== 'evidenceRefs') visit(child, depth + 1);
  }
  fields.filter(field => field.presence === 'present' && field.path !== '/evidenceIndex')
    .forEach(field => visit(field.value, 0));
  if (ids.size > MAX_REFERENCES) throw new Error('Research references exceed limit');
  return [...ids].sort();
}

/**
 * The host supplies entries returned by readEvidenceCatalog, after its immutable manifest join.
 * Omission leaves aliases unresolved. This function never guesses from FRAME order or time.
 */
export function createResearchSourceProjection(input: {
  result: AnalysisResult; payload: unknown; sourceGroup: string;
  platform?: ContentPlatform; contentType?: ContentType;
  registeredEvidence?: readonly VerifiedResearchEvidenceEntry[];
}): ResearchSourceProjection {
  const result = AnalysisResultSchema.parse(input.result);
  const sourceGroup = z.string().trim().min(1).max(300).parse(input.sourceGroup);
  const payload = JSON.parse(boundedJson(input.payload, MAX_INPUT_BYTES)) as Record<string, unknown>;
  const header = PayloadHeaderSchema.parse(payload);
  if (header.profile !== result.profile || (result.profile === 'fine') !== (header.schemaVersion === 'video-fine@1'))
    throw new Error('Payload profile differs from analysis result');
  if (header.profile === 'fine' && (typeof payload.reconstruction !== 'object' || payload.reconstruction === null || Array.isArray(payload.reconstruction)))
    throw new Error('Fine reconstruction is absent');
  const paths = header.schemaVersion === 'video-fine@1' ? finePaths
    : header.schemaVersion === 'video-overview@2' ? overviewV2Paths : overviewV1Paths;
  const fields = paths.map(path => ResearchSourceFieldSchema.parse({ path, ...atPath(payload, path) }));
  const receipts = new Map<string, typeof header.evidenceIndex[number]>();
  for (const receipt of header.evidenceIndex) {
    if (receipts.has(receipt.id)) throw new Error('Ambiguous local evidence identity');
    receipts.set(receipt.id, receipt);
  }
  const catalog = input.registeredEvidence?.map(item => VerifiedResearchEvidenceEntrySchema.parse(item));
  const byLocalId = new Map<string, VerifiedResearchEvidenceEntry>();
  if (catalog) {
    if (catalog.length !== result.evidence.length) throw new Error('Incomplete verified evidence catalog');
    const seenIndexes = new Set<number>();
    for (const entry of catalog) {
      if (entry.evidenceIndex >= result.evidence.length || seenIndexes.has(entry.evidenceIndex))
        throw new Error('Ambiguous registered evidence index');
      seenIndexes.add(entry.evidenceIndex);
      if (entry.sourceEvidenceId === null) continue;
      const receipt = receipts.get(entry.sourceEvidenceId);
      if (!receipt || entry.kind !== receipt.kind || entry.atMs !== receipt.atMs ||
        entry.endMs !== receipt.endMs || entry.sha256 !== receipt.sha256 ||
        byLocalId.has(entry.sourceEvidenceId)) throw new Error('Unverified or ambiguous evidence alias');
      byLocalId.set(entry.sourceEvidenceId, entry);
    }
  }
  const evidenceAliases = referencedLocalIds(fields).map(localId => {
    const entry = byLocalId.get(localId);
    return entry ? { localId, status: 'resolved' as const, evidenceIndex: entry.evidenceIndex,
      anchor: result.evidence[entry.evidenceIndex]! }
      : { localId, status: 'unresolved' as const,
        reason: catalog ? 'not_registered' as const : 'catalog_unavailable' as const };
  });
  const projection = {
    schemaVersion: 'research-source-projection@1' as const,
    source: { projectId: result.projectId, sourceGroup, analysisRef: result.ref,
      ...(input.platform!==undefined?{platform:input.platform}:{}),
      ...(input.contentType!==undefined?{contentType:input.contentType}:{}),
      assetVersionId: result.assetVersionId, profile: result.profile,
      payloadSchemaVersion: header.schemaVersion, createdAt: result.createdAt,
      question: result.question, purpose: result.purpose,
      quality: result.quality, coverage: result.coverage },
    fields, evidenceAliases,
  };
  boundedJson(projection, MAX_OUTPUT_BYTES);
  return ResearchSourceProjectionSchema.parse(projection);
}

/** Fetch a value while keeping a legacy absence distinct from a present null. */
export function researchSourceField(projection: ResearchSourceProjection, path: string) {
  return projection.fields.find(field => field.path === path);
}
