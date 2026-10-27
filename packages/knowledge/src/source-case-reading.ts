import type { ResearchSourceProjection } from '../../contracts/src/index.ts';
import { ResearchSourceProjectionSchema } from '../../contracts/src/index.ts';

const OVERVIEW_FIELDS = new Set([
  '/oneSentence', '/corePoints', '/screening', '/structure', '/notableChoices',
  '/commonObservations', '/unknowns', '/coverageState',
]);
const FINE_FIELDS = new Set([
  '/reconstruction/knowledgeUnits', '/reconstruction/relations',
  '/reconstruction/builderLenses/finalSummary/reusableLessons',
  '/reconstruction/builderLenses/finalSummary/limits',
  '/reconstruction/viewerChange', '/reconstruction/scopeStatement',
  '/commonObservations', '/unknowns',
]);

/** Exact source records selected for a question-level reading. No field value is shortened. */
export function createSourceCaseReading(source: ResearchSourceProjection): {
  sourceProjection: ResearchSourceProjection;
  selectedSourceFieldPaths: string[];
  omittedSourceFieldPaths: string[];
} {
  source = ResearchSourceProjectionSchema.parse(source);
  const selected = source.source.profile === 'fine' ? FINE_FIELDS : OVERVIEW_FIELDS;
  const seen = new Set<string>();
  for (const field of source.fields) {
    if (seen.has(field.path)) throw new Error(`SOURCE_CASE_READING_DUPLICATE_PATH:${field.path}`);
    seen.add(field.path);
  }
  const fields = source.fields.filter(field => selected.has(field.path));
  const used = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 48) throw new Error('SOURCE_CASE_READING_NESTING_LIMIT');
    if (Array.isArray(value)) { value.forEach(item => visit(item, depth + 1)); return; }
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    if (Array.isArray(item.evidenceRefs)) for (const id of item.evidenceRefs) {
      if (typeof id !== 'string' || !id.trim()) throw new Error('SOURCE_CASE_READING_INVALID_ALIAS');
      used.add(id);
    }
    if (['frame', 'cue', 'caption', 'source_text'].includes(String(item.refType)) && typeof item.ref === 'string')
      used.add(item.ref);
    for (const [key, child] of Object.entries(item)) if (key !== 'evidenceRefs') visit(child, depth + 1);
  };
  fields.filter(field => field.presence === 'present' && field.path !== '/evidenceIndex')
    .forEach(field => visit(field.value, 0));
  const aliases = new Set<string>();
  for (const alias of source.evidenceAliases) {
    if (aliases.has(alias.localId)) throw new Error(`SOURCE_CASE_READING_DUPLICATE_ALIAS:${alias.localId}`);
    aliases.add(alias.localId);
  }
  for (const id of used) if (!aliases.has(id)) throw new Error(`SOURCE_CASE_READING_MISSING_ALIAS:${id}`);
  return {
    sourceProjection: {
      schemaVersion: source.schemaVersion,
      source: structuredClone(source.source),
      fields: structuredClone(fields),
      evidenceAliases: structuredClone(source.evidenceAliases.filter(alias => used.has(alias.localId))),
    },
    selectedSourceFieldPaths: fields.map(field => field.path),
    omittedSourceFieldPaths: source.fields.filter(field => !selected.has(field.path)).map(field => field.path),
  };
}
