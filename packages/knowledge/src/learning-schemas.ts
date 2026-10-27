import { createHash } from 'node:crypto';
import type { LearningManifest, LearningSourceRef } from './learning-types.ts';

export function questionKey(question: string): string {
  return question.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/gu, ' ');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, canonical(v)]));
  return value;
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function sourceKey(source: LearningSourceRef): string {
  return `${source.domain}:${source.ref.objectId}:${source.ref.versionId}`;
}

export function manifestHash(manifest: LearningManifest): string { return stableHash(manifest); }

export function assertText(value: string, name: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
}

export function assertSource(source: LearningSourceRef): void {
  if (!['analysis', 'source', 'knowledge'].includes(source.domain)) throw new Error('invalid source domain');
  assertText(source.ref.objectId, 'source objectId');
  assertText(source.ref.versionId, 'source versionId');
}
