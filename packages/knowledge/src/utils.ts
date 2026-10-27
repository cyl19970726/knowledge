import { createHash } from 'node:crypto';
import type { Dependency, KnowledgeRevision } from './types.ts';
import type { VersionRef, Citation } from '../../contracts/src/index.ts';
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function refKey(ref: VersionRef): string { return `${ref.objectId}/${ref.versionId}`; }
export function sameRef(a: VersionRef, b: VersionRef): boolean { return refKey(a) === refKey(b); }
export function uniqueDeps(deps: Dependency[]): Dependency[] {
  return [...new Map(deps.map(d => [`${d.domain}:${refKey(d.ref)}:${d.role}:${d.critical}:${canonical(d.useScope ?? null)}`, d])).values()];
}
export function citationsOf(revision: KnowledgeRevision): Citation[] {
  switch(revision.kind) {
    case 'case': case 'claim': case 'pattern': case 'wiki': case 'wiki_page': return revision.content.citations;
    case 'comparison': return revision.content.dimensions.flatMap(d => d.observations.flatMap(o => o.citations));
    case 'collection': return [];
    case 'reference_pack': return [...revision.content.pack.selectedCases, ...revision.content.pack.selectedPatterns, ...revision.content.pack.counterexamples].flatMap(i=>i.citations);
  }
}
