import { z } from 'zod';
import { ProjectIdSchema, TimestampSchema, VersionRefSchema } from './primitives.js';
import { ResearchSourceProjectionSchema } from './research-source.js';

const TextSchema = z.string().trim().min(1).max(4000);
const SourceGroupSchema = z.string().trim().min(1).max(300);
const BasisSchema = z.strictObject({
  caseRef: VersionRefSchema,
  fieldPath: z.string().startsWith('/').max(300),
  recordPointer: z.string().max(1000),
});
const FindingSchema = z.strictObject({
  text: TextSchema,
  conditions: z.array(TextSchema).max(20),
  basis: z.array(BasisSchema).min(1).max(100),
});
export const CognitionDailyRecognitionSchema = z.strictObject({
  ref: VersionRefSchema,
  problemId: TextSchema,
  unitKey: TextSchema,
  title: TextSchema,
  question: TextSchema,
  publishedAt: TimestampSchema,
  findings: z.array(FindingSchema).max(30),
  limitations: z.array(TextSchema).max(30),
  unknowns: z.array(TextSchema).max(30),
  sourceGroups: z.array(SourceGroupSchema).max(100),
  changeKind: TextSchema,
});
export const CognitionDailyChangeSchema = z.strictObject({
  ref: VersionRefSchema,
  previousRef: VersionRefSchema.nullable(),
  kind: z.enum(['initial', 'recognition_changed', 'basis_added', 'format_only', 'maintained', 'invalidated']),
  title: TextSchema.optional(),
  reason: TextSchema,
  at: TimestampSchema,
});
export const CognitionDailyMaterialSchema = z.strictObject({
  caseRef: VersionRefSchema,
  analysisRef: VersionRefSchema,
  sourceGroup: SourceGroupSchema,
  title: TextSchema,
  profile: z.enum(['overview', 'fine']),
  registeredAt: TimestampSchema,
  originalPublishedAt: TimestampSchema.nullable(),
  sourceProjection: ResearchSourceProjectionSchema,
});
export const CognitionDailyGapSchema = z.strictObject({
  problemId: TextSchema,
  reason: TextSchema,
  status: z.enum(['restricted', 'pending', 'outcome_unknown', 'missing']),
});
const WikiExperienceSourceSchema = z.strictObject({
  ref: VersionRefSchema,
  resolution: z.enum(['resolved', 'missing']),
  kind: z.enum(['product_fact', 'platform_rule', 'business_record', 'client_statement', 'third_party_estimate', 'document_rule', 'experience_record', 'unresolved']),
  sourceGroup: SourceGroupSchema.nullable(),
  statement: TextSchema.nullable(),
  domain: z.enum(['technical_workflow', 'creative_production']).nullable(),
  provenance: z.enum(['registered_run', 'synthetic_fixture']).nullable(),
  quality: z.enum(['verified', 'revised_unverified', 'synthetic']).nullable(),
  task: TextSchema.nullable(),
  method: TextSchema.nullable(),
  steps: z.array(z.strictObject({ action: TextSchema, observation: TextSchema, condition: TextSchema.nullable() })).max(30),
  observedOutcome: TextSchema.nullable(),
  outcomeStatus: z.enum(['complete', 'partial', 'failed']).nullable(),
  conditions: z.array(TextSchema).max(30),
  counterexamples: z.array(TextSchema).max(30),
  unknowns: z.array(TextSchema).max(30),
  limitations: z.array(TextSchema).max(30),
  /** Added for new freezes; older source snapshots did not record live source validity. */
  validAtCutoff: z.boolean().optional(),
  /** RegisteredSource has no acquisition timestamp; null is explicit and never inferred from publication. */
  sourceCollectedAt: TimestampSchema.nullable(),
}).superRefine((source, ctx) => {
  if (source.resolution === 'missing' && (source.kind !== 'unresolved' || source.sourceGroup !== null || source.statement !== null))
    ctx.addIssue({ code: 'custom', path: ['resolution'], message: 'Missing source metadata must remain explicitly unresolved' });
  if (source.resolution === 'resolved' && (source.kind === 'unresolved' || !source.sourceGroup || source.statement === null))
    ctx.addIssue({ code: 'custom', path: ['resolution'], message: 'Resolved source navigation requires its exact registered identity' });
  if (source.kind === 'experience_record' && source.resolution === 'resolved' &&
      (!source.domain || !source.provenance || !source.quality || !source.task || !source.method ||
       !source.steps.length || !source.observedOutcome || !source.outcomeStatus))
    ctx.addIssue({ code: 'custom', path: ['experience'], message: 'Resolved experience records require their exact execution details' });
});
export const CognitionDailyWikiUpdateSchema = z.strictObject({
  ref: VersionRefSchema,
  previousRef: VersionRefSchema.nullable(),
  title: TextSchema,
  body: z.string().max(100_000),
  publishedAt: TimestampSchema,
  effect: z.enum(['create', 'support', 'narrow', 'dispute', 'correct', 'withdraw']),
  /** Derived pages cite knowledge versions; they are never a new independent raw source. */
  compilationKind: z.enum(['experience_integration', 'cross_domain_synthesis', 'wiki_page']).optional(),
  page: z.strictObject({profile:z.strictObject({id:TextSchema,version:TextSchema}),
    identity:z.strictObject({key:TextSchema,aliases:z.array(TextSchema).max(30)}),summary:TextSchema}).optional(),
  pageBasis:z.array(z.strictObject({domain:z.enum(['analysis','source','knowledge','evidence','context']),
    ref:VersionRefSchema,role:z.enum(['derived_from','supports','challenges','uses']),critical:z.boolean()})).max(500).optional(),
  knowledgeBasis: z.array(z.strictObject({
    ref: VersionRefSchema, spaceId: TextSchema, title: TextSchema, body: z.string().max(100_000),
    revisionSha256: z.string().regex(/^[a-f0-9]{64}$/),
    conditions: z.array(TextSchema).max(100), limitations: z.array(TextSchema).max(100),
    unknowns: z.array(TextSchema).max(100), sourceGroups: z.array(SourceGroupSchema).max(100),
    validAtCutoff: z.boolean(),
    /** Exact Pattern content, when this basis is a Pattern; absent in earlier archives. */
    pattern: z.strictObject({
      problem: TextSchema, mechanism: TextSchema, sequence: z.array(TextSchema).max(100),
      requiredElements: z.array(TextSchema).max(100), variableSlots: z.array(TextSchema).max(100),
      applicability: z.array(TextSchema).max(100), exclusions: z.array(TextSchema).max(100),
      prediction: TextSchema, evidenceLevel: z.enum(['single_case', 'repeated_observation', 'inconclusive']),
    }).optional(),
  })).max(100).optional(),
  reason: TextSchema,
  compilationReason: TextSchema,
  conditions: z.array(TextSchema).max(100),
  counterexamples: z.array(TextSchema).max(100),
  unknowns: z.array(TextSchema).max(100),
  /** Added after the original archive shape; absent in older immutable snapshots. */
  nextQuestions: z.array(TextSchema).max(100).optional(),
  limitations: z.array(TextSchema).max(100),
  validAtCutoff: z.boolean(),
  sourceRefs: z.array(VersionRefSchema).max(100),
  sourceGroups: z.array(SourceGroupSchema).max(100),
  sources: z.array(WikiExperienceSourceSchema).max(100),
}).superRefine((update, ctx) => {
  const keyOf = (ref: z.infer<typeof VersionRefSchema>) => `${ref.objectId}:${ref.versionId}`;
  if (update.previousRef && update.previousRef.objectId !== update.ref.objectId)
    ctx.addIssue({ code: 'custom', path: ['previousRef'], message: 'Previous Wiki revision must belong to the same target object' });
  const basis = update.knowledgeBasis ?? [];
  if(update.compilationKind!=='wiki_page'&&basis.length>20)
    ctx.addIssue({code:'custom',path:['knowledgeBasis'],message:'Legacy Wiki synthesis allows at most 20 basis pages'});
  if (update.compilationKind === 'cross_domain_synthesis' &&
      (basis.length < 2 || new Set(basis.map(item=>item.spaceId)).size < 2 ||
       new Set(basis.map(item=>keyOf(item.ref))).size !== basis.length))
    ctx.addIssue({ code: 'custom', path: ['knowledgeBasis'], message: 'Cross-domain synthesis requires distinct exact basis versions from at least two spaces' });
  if (update.effect === 'create' && update.compilationKind !== 'cross_domain_synthesis' && update.compilationKind !== 'wiki_page')
    ctx.addIssue({ code: 'custom', path: ['effect'], message: 'Only an explicitly derived synthesis may create a Wiki in this update stream' });
  const refs = update.sourceRefs.map(keyOf);
  if (new Set(refs).size !== refs.length)
    ctx.addIssue({ code: 'custom', path: ['sourceRefs'], message: 'Duplicate source ref' });
  const sourceRefs = update.sources.map(source => keyOf(source.ref));
  if (new Set(sourceRefs).size !== sourceRefs.length || sourceRefs.length !== refs.length || refs.some(ref => !sourceRefs.includes(ref)))
    ctx.addIssue({ code: 'custom', path: ['sources'], message: 'Resolved source navigation must exactly match sourceRefs' });
  if(update.compilationKind==='wiki_page') {
    if(!update.page || !update.pageBasis?.length)
      ctx.addIssue({code:'custom',path:['pageBasis'],message:'Wiki page changes require their profile, identity and exact basis projection'});
    if(new Set(update.sourceGroups).size!==update.sourceGroups.length)
      ctx.addIssue({code:'custom',path:['sourceGroups'],message:'Inherited source groups must be unique, never counted per derived page'});
    const basisKeys=(update.pageBasis??[]).map(item=>`${item.domain}:${keyOf(item.ref)}:${item.role}:${item.critical}`);
    if(new Set(basisKeys).size!==basisKeys.length)
      ctx.addIssue({code:'custom',path:['pageBasis'],message:'Exact page basis edges must be unique'});
    const pageRefs=new Set((update.pageBasis??[]).filter(item=>item.domain==='knowledge').map(item=>keyOf(item.ref)));
    const readRefs=basis.map(item=>keyOf(item.ref));
    if(new Set(readRefs).size!==readRefs.length||readRefs.length!==pageRefs.size||readRefs.some(ref=>!pageRefs.has(ref)))
      ctx.addIssue({code:'custom',path:['knowledgeBasis'],message:'Knowledge body projections must exactly match distinct page dependency versions'});
  } else {
    if(update.page || update.pageBasis)
      ctx.addIssue({code:'custom',path:['page'],message:'Page metadata belongs only to a wiki_page change'});
    const groups = new Set(update.sources.flatMap(source => source.sourceGroup ? [source.sourceGroup] : []));
    if (groups.size !== update.sourceGroups.length || update.sourceGroups.some(group => !groups.has(group)))
      ctx.addIssue({ code: 'custom', path: ['sourceGroups'], message: 'Source groups must match exact navigable sources' });
  }
});
export type CognitionDailyWikiUpdate = z.infer<typeof CognitionDailyWikiUpdateSchema>;

/** A reviewed research activity, not a publication or a claim of present validity. */
export const CognitionDailyResearchCheckSchema = z.strictObject({
  buildId: z.uuid(), topicId: z.uuid(),
  question: z.string().trim().min(1).max(12_000),
  finishedAt: TimestampSchema,
  outcome: z.literal('no_change'),
  reason: z.string().trim().min(1).max(12_000),
  reviewRationale: z.string().trim().min(1).max(12_000),
  methodVersion: TextSchema, policyVersion: TextSchema,
  modelCalls: z.number().int().min(0).max(300),
  readset: z.array(z.strictObject({domain:z.enum(['analysis','source','knowledge']),ref:VersionRefSchema,
    title:z.string().trim().min(1).max(12_000)})).min(1).max(20),
});
export type CognitionDailyResearchCheck = z.infer<typeof CognitionDailyResearchCheckSchema>;

const key = (ref: z.infer<typeof VersionRefSchema>) => `${ref.objectId}:${ref.versionId}`;
const dayFormatter = (timeZone: string) => new Intl.DateTimeFormat('en-US', {
  timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
});
const dayInZone = (at: number, formatter: Intl.DateTimeFormat) => {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(at)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
/** First UTC millisecond whose local calendar date is the requested business date, including DST transitions. */
function businessDayStart(date: string, formatter: Intl.DateTimeFormat): number | null {
  const target = Date.parse(`${date}T00:00:00Z`);
  let low = target - 2 * 86_400_000, high = target + 2 * 86_400_000;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (dayInZone(mid, formatter) < date) low = mid + 1;
    else high = mid;
  }
  return dayInZone(low, formatter) === date ? low : null;
}
export function cognitionBusinessDayStart(date: string, timeZone: string): string {
  z.iso.date().parse(date);
  const start = businessDayStart(date, dayFormatter(timeZone));
  if (start === null) throw new RangeError(`Business date does not exist in ${timeZone}: ${date}`);
  return new Date(start).toISOString();
}

/** One immutable adoption-time view. Events fall in [fromAt, eventThrough], within the business-day [fromAt, cutoffAt]. */
export const CognitionDailySnapshotSchema = z.strictObject({
  schemaVersion: z.literal('cognition-daily@1'),
  projectId: ProjectIdSchema,
  date: z.iso.date(),
  timeZone: z.string().trim().min(1).max(100),
  fromAt: TimestampSchema,
  cutoffAt: TimestampSchema,
  eventThrough: TimestampSchema,
  recognitions: z.array(CognitionDailyRecognitionSchema).max(1000),
  changes: z.array(CognitionDailyChangeSchema).max(2000),
  materials: z.array(CognitionDailyMaterialSchema).max(2000),
  gaps: z.array(CognitionDailyGapSchema).max(1000),
  /** Optional so archived cognition-daily@1 snapshots remain readable. */
  wikiUpdates: z.array(CognitionDailyWikiUpdateSchema).max(1000).optional(),
  researchChecks: z.array(CognitionDailyResearchCheckSchema).max(1000).optional(),
}).superRefine((snapshot, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  const from = Date.parse(snapshot.fromAt), cutoff = Date.parse(snapshot.cutoffAt), through = Date.parse(snapshot.eventThrough);
  if (from >= cutoff) issue(['fromAt'], 'fromAt must precede cutoffAt');
  if (through < from || through > cutoff) issue(['eventThrough'], 'eventThrough must be inside the snapshot window');
  try {
    const formatter = dayFormatter(snapshot.timeZone);
    if (dayInZone(cutoff, formatter) !== snapshot.date)
      issue(['date'], 'date must be the cutoff date in timeZone');
    const start = businessDayStart(snapshot.date, formatter);
    if (start === null || from !== start)
      issue(['fromAt'], 'fromAt must be midnight at the start of date in timeZone');
  } catch { issue(['timeZone'], 'Invalid IANA time zone'); }
  const recognitionRefs = new Set<string>(), units = new Set<string>(), materialRefs = new Set<string>();
  const materialsByCase = new Map<string, typeof snapshot.materials[number]>();
  for (const [i, material] of snapshot.materials.entries()) {
    const ref = key(material.caseRef);
    if (materialRefs.has(ref)) issue(['materials', i, 'caseRef'], 'Duplicate material case ref');
    materialRefs.add(ref); materialsByCase.set(ref, material);
    if (Date.parse(material.registeredAt) > through)
      issue(['materials', i, 'registeredAt'], 'Material registration is after eventThrough');
    if (Date.parse(material.sourceProjection.source.createdAt) > cutoff)
      issue(['materials', i, 'sourceProjection'], 'Source projection is after cutoff');
    const source = material.sourceProjection.source;
    if (source.projectId !== snapshot.projectId || source.sourceGroup !== material.sourceGroup ||
        source.profile !== material.profile || key(source.analysisRef) !== key(material.analysisRef))
      issue(['materials', i, 'sourceProjection'], 'Source projection identity differs from material');
  }
  for (const [i, recognition] of snapshot.recognitions.entries()) {
    const ref = key(recognition.ref), unit = `${recognition.problemId}\0${recognition.unitKey}`;
    if (recognitionRefs.has(ref)) issue(['recognitions', i, 'ref'], 'Duplicate recognition ref');
    if (units.has(unit)) issue(['recognitions', i, 'unitKey'], 'Duplicate recognition problem and unit');
    recognitionRefs.add(ref); units.add(unit);
    if (Date.parse(recognition.publishedAt) > through)
      issue(['recognitions', i, 'publishedAt'], 'Recognition publication is after eventThrough');
    const groups = new Set(recognition.sourceGroups);
    if (groups.size !== recognition.sourceGroups.length)
      issue(['recognitions', i, 'sourceGroups'], 'Duplicate source group');
    const citedGroups = new Set<string>();
    for (const [j, finding] of recognition.findings.entries()) {
      for (const [k, basis] of finding.basis.entries()) {
        const material = materialsByCase.get(key(basis.caseRef));
        if (!material) { issue(['recognitions', i, 'findings', j, 'basis', k], 'Basis case absent from frozen materials'); continue; }
        citedGroups.add(material.sourceGroup);
        if (!resolveCognitionBasisRecord(snapshot, basis).found)
          issue(['recognitions', i, 'findings', j, 'basis', k], 'Basis record absent from source projection');
      }
    }
    if (groups.size !== citedGroups.size || [...groups].some(group => !citedGroups.has(group)))
      issue(['recognitions', i, 'sourceGroups'], 'Source groups must equal the cited original groups');
  }
  const changeRefs = new Set<string>();
  for (const [i, change] of snapshot.changes.entries()) {
    if (Date.parse(change.at) < from || Date.parse(change.at) > through)
      issue(['changes', i, 'at'], 'Change is outside the event window');
    const changeKey = `${key(change.ref)}:${change.kind}`;
    if (changeRefs.has(changeKey)) issue(['changes', i], 'Duplicate change');
    changeRefs.add(changeKey);
    if (change.kind !== 'invalidated' && !recognitionRefs.has(key(change.ref)))
      issue(['changes', i, 'ref'], 'Change refers to missing recognition');
    if (change.kind === 'initial' && change.previousRef !== null)
      issue(['changes', i, 'previousRef'], 'Initial change cannot have previousRef');
  }
  const wikiRefs = new Set<string>();
  for (const [i, update] of (snapshot.wikiUpdates ?? []).entries()) {
    const ref = key(update.ref);
    if (wikiRefs.has(ref)) issue(['wikiUpdates', i, 'ref'], 'Duplicate Wiki experience revision');
    wikiRefs.add(ref);
    const publishedAt = Date.parse(update.publishedAt);
    if (publishedAt < from || publishedAt > through)
      issue(['wikiUpdates', i, 'publishedAt'], 'Wiki publication is outside the business-date window');
  }
  const checks = new Set<string>();
  for (const [i, check] of (snapshot.researchChecks ?? []).entries()) {
    if (checks.has(check.buildId)) issue(['researchChecks', i, 'buildId'], 'Duplicate research check');
    checks.add(check.buildId);
    if (Date.parse(check.finishedAt) < from || Date.parse(check.finishedAt) > through)
      issue(['researchChecks', i, 'finishedAt'], 'Research check is outside the event window');
    const refs = check.readset.map(item=>`${item.domain}:${key(item.ref)}`);
    if (!refs.length || new Set(refs).size !== refs.length)
      issue(['researchChecks', i], 'Research check requires distinct exact read references');
  }
});

export type CognitionDailySnapshot = z.infer<typeof CognitionDailySnapshotSchema>;
export type CognitionDailyRecognition = CognitionDailySnapshot['recognitions'][number];
export type CognitionDailyMaterial = CognitionDailySnapshot['materials'][number];
export function validateCognitionDailySnapshot(value: unknown): CognitionDailySnapshot {
  return CognitionDailySnapshotSchema.parse(value);
}

export type CognitionDailyBasis = CognitionDailyRecognition['findings'][number]['basis'][number];
const escapePointer = (token: string) => token.replaceAll('~', '~0').replaceAll('/', '~1');
function sourceRecords(value: unknown): Array<{recordPointer: string; originalRecord: unknown}> {
  const records: Array<{recordPointer: string; originalRecord: unknown}> = [];
  const emit = (recordPointer: string, originalRecord: unknown) => records.push({ recordPointer, originalRecord });
  const visit = (pointer: string, item: unknown): void => {
    if (Array.isArray(item)) { item.forEach((child, index) => emit(`${pointer}/${index}`, child)); return; }
    if (item === null || typeof item !== 'object') { emit(pointer, item); return; }
    if (Object.hasOwn(item, 'evidenceRefs')) { emit(pointer, item); return; }
    const children = Object.entries(item);
    if (!children.length || children.some(([, child]) => child === null || typeof child !== 'object')) {
      emit(pointer, item); return;
    }
    for (const [name, child] of children) visit(`${pointer}/${escapePointer(name)}`, child);
  };
  visit('', value);
  return records;
}
function pointerValue(value: unknown, pointer: string): {found:true;value:unknown}|{found:false} {
  if (pointer === '') return {found:true,value};
  if (!pointer.startsWith('/')) return {found:false};
  let current: unknown = value;
  for (const raw of pointer.slice(1).split('/')) {
    if (/~(?![01])/.test(raw)) return {found:false};
    const segment = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(segment) || Number(segment) >= current.length) return {found:false};
      current = current[Number(segment)];
    } else if (current !== null && typeof current === 'object' && Object.hasOwn(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
    } else return {found:false};
  }
  return {found:true,value:current};
}
/** Reads one exact source record. Unknown or non-record pointers never fall back to a nearby value. */
export function resolveCognitionBasisRecord(snapshot: CognitionDailySnapshot, basis: CognitionDailyBasis):
  {found:true;originalRecord:unknown}|{found:false} {
  const material = snapshot.materials.find(item => key(item.caseRef) === key(basis.caseRef));
  if (!material) return {found:false};
  const fields = material.sourceProjection.fields.filter(item => item.path === basis.fieldPath);
  let source: unknown;
  if (fields.length === 1 && fields[0]?.presence === 'present') source = fields[0].value;
  else if (fields.length === 0 && basis.fieldPath === '/source/coverage/channels') source = material.sourceProjection.source.coverage.channels;
  else if (fields.length === 0 && basis.fieldPath === '/source/coverage/gaps') source = material.sourceProjection.source.coverage.gaps;
  else if (fields.length === 0 && basis.fieldPath === '/source/quality') source = material.sourceProjection.source.quality;
  else return {found:false};
  const permitted = basis.fieldPath.startsWith('/source/') ? basis.recordPointer === '' :
    sourceRecords(source).some(item => item.recordPointer === basis.recordPointer);
  if (!permitted) return {found:false};
  const resolved = pointerValue(source, basis.recordPointer);
  return resolved.found ? {found:true,originalRecord:structuredClone(resolved.value)} : {found:false};
}
type Ref = CognitionDailySnapshot['materials'][number]['caseRef'];
type SourcePractice = { kind: 'reusable_lesson' | 'transfer_condition'; lane: 'product' | 'creative' | null;
  lesson: string | null; conditions: string | null; action: string | null; originalRecord: unknown };
type SourceReading = { section: 'sequence'|'observation'|'relation'|'viewer_change'|'scope'|'unknown'|'channel';
  fieldPath: string; recordPointer: string; originalRecord: unknown };
type SourceNavigation = { caseRef: Ref; title: string; profile: 'overview' | 'fine';
  linkedRecognitionRefs: Ref[]; screening: Array<{ lane: 'product' | 'creative'; verdict: string; priority: string | null;
    fineQuestion: string | null; reasons: string[] }>;
  practices: SourcePractice[]; originalReadings: SourceReading[] };

export type CognitionDailyReport = {
  schemaVersion: 'cognition-daily-report@1';
  snapshot: CognitionDailySnapshot;
  status: 'complete' | 'partial';
  activity: 'changed' | 'basis_only' | 'format_only' | 'maintained' | 'no_changes';
  sourceGroupCount: number;
  newSourceGroupCount: number;
  newReportCount: number;
  qualityCounts: { reviewed: number; unverified: number; incomplete: number };
  sourceNavigation: SourceNavigation[];
  wikiUpdates?: CognitionDailyWikiUpdate[];
};

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const originalText = (value: unknown): string | null => typeof value === 'string' ? value : value === undefined || value === null ? null : JSON.stringify(value);
const refKey = (ref: Ref) => `${ref.objectId}:${ref.versionId}`;
const readingSections = new Map<SourceReading['fieldPath'], SourceReading['section']>([
  ['/structure', 'sequence'], ['/reconstruction/knowledgeUnits', 'sequence'],
  ['/corePoints', 'observation'], ['/commonObservations', 'observation'], ['/notableChoices', 'observation'],
  ['/reconstruction/relations', 'relation'], ['/reconstruction/viewerChange', 'viewer_change'],
  ['/reconstruction/scopeStatement', 'scope'], ['/unknowns', 'unknown'],
]);

function sourceNavigation(snapshot: CognitionDailySnapshot): SourceNavigation[] {
  return snapshot.materials.map(material => {
    const fields = material.sourceProjection.fields.filter(field => field.presence === 'present');
    const field = (path: string) => fields.find(item => item.path === path)?.value;
    const lessons = field('/reconstruction/builderLenses/finalSummary/reusableLessons');
    const practices: SourcePractice[] = Array.isArray(lessons) ? lessons.map(record => {
      const value = object(record);
      return { kind: 'reusable_lesson', lane: null, lesson: originalText(value?.lesson ?? record),
        conditions: originalText(value?.conditions), action: originalText(value?.action), originalRecord: structuredClone(record) };
    }) : [];
    const screeningRoot = object(field('/screening'));
    const screening: SourceNavigation['screening'] = [];
    for (const lane of ['product', 'creative'] as const) {
      const value = object(field(`/screening/${lane}`)) ?? object(screeningRoot?.[lane]);
      if (!value) continue;
      screening.push({ lane, verdict: originalText(value.verdict) ?? '未记录',
        priority: originalText(value.priority), fineQuestion: originalText(value.fineQuestion),
        reasons: Array.isArray(value.reasons) ? value.reasons.map(reason => originalText(object(reason)?.assessment ?? reason) ?? '').filter(Boolean) : [] });
      if (Array.isArray(value.transferConditions)) for (const record of value.transferConditions) {
        const item = object(record);
        practices.push({ kind: 'transfer_condition', lane, lesson: null,
          conditions: originalText(item?.condition), action: originalText(item?.action), originalRecord: structuredClone(record) });
      }
    }
    const linkedRecognitionRefs = snapshot.recognitions.filter(recognition => recognition.findings.some(finding =>
      finding.basis.some(basis => refKey(basis.caseRef) === refKey(material.caseRef)))).map(recognition => recognition.ref);
    const originalReadings: SourceReading[] = [];
    for (const field of fields) {
      const section = readingSections.get(field.path);
      if (section) for (const record of sourceRecords(field.value)) originalReadings.push({
        section, fieldPath: field.path, recordPointer: record.recordPointer,
        originalRecord: structuredClone(record.originalRecord),
      });
    }
    originalReadings.push({ section: 'channel', fieldPath: '/source/coverage/channels', recordPointer: '',
      originalRecord: structuredClone(material.sourceProjection.source.coverage.channels) });
    originalReadings.push({ section: 'unknown', fieldPath: '/source/coverage/gaps', recordPointer: '',
      originalRecord: structuredClone(material.sourceProjection.source.coverage.gaps) });
    return { caseRef: material.caseRef, title: material.title, profile: material.profile,
      linkedRecognitionRefs, screening, practices, originalReadings };
  });
}

/** Organizes approved, frozen recognitions. It makes no new cross-case judgment. */
export function buildCognitionDailyReport(value: unknown): CognitionDailyReport {
  const snapshot = CognitionDailySnapshotSchema.parse(value);
  const kinds = new Set(snapshot.changes.map(change => change.kind));
  const activity = (snapshot.wikiUpdates?.length ?? 0) > 0 ||
    ['initial', 'recognition_changed', 'invalidated'].some(kind => kinds.has(kind as typeof snapshot.changes[number]['kind']))
    ? 'changed' : kinds.has('basis_added') ? 'basis_only' : kinds.has('format_only') ? 'format_only'
      : kinds.has('maintained') ? 'maintained' : 'no_changes';
  const qualityCounts = { reviewed: 0, unverified: 0, incomplete: 0 };
  for (const material of snapshot.materials) {
    const quality = material.sourceProjection.source.quality;
    const candidate = quality.candidate;
    if (candidate === 'original_reviewed') qualityCounts.reviewed++;
    else if (candidate === 'review_incomplete') qualityCounts.incomplete++;
    else qualityCounts.unverified++;
  }
  const newReports = snapshot.materials.filter(material => Date.parse(material.registeredAt) >= Date.parse(snapshot.fromAt));
  const firstRegistrationByGroup = new Map<string, number>();
  for (const material of snapshot.materials) {
    const registeredAt = Date.parse(material.registeredAt);
    const previous = firstRegistrationByGroup.get(material.sourceGroup);
    if (previous === undefined || registeredAt < previous) firstRegistrationByGroup.set(material.sourceGroup, registeredAt);
  }
  return {
    schemaVersion: 'cognition-daily-report@1', snapshot,
    status: snapshot.gaps.length ? 'partial' : 'complete', activity,
    sourceGroupCount: new Set(snapshot.materials.map(material => material.sourceGroup)).size,
    newSourceGroupCount: [...firstRegistrationByGroup.values()].filter(at => at >= Date.parse(snapshot.fromAt)).length,
    newReportCount: newReports.length,
    qualityCounts, sourceNavigation: sourceNavigation(snapshot),
    ...(snapshot.wikiUpdates ? { wikiUpdates: snapshot.wikiUpdates } : {}),
  };
}
