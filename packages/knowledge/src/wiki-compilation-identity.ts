import type { VersionRef } from '../../contracts/src/index.ts';
import { canonical, digest, refKey } from './utils.ts';

/** A source resolved by the host, including the exact content observed by compilation. */
export interface WikiCompilationSourceIdentity {
  ref: VersionRef;
  sourceGroup: string | null;
  capability: string;
  contentDigest: string;
}

export interface WikiCompilationIdentityInput {
  projectId: string;
  topicId: string;
  questionVersion: VersionRef;
  intent: string;
  purpose: string;
  scope: Readonly<Record<string, unknown>>;
  sources: readonly WikiCompilationSourceIdentity[];
  externalReadingRefs: readonly VersionRef[];
  methodVersion: string;
  contractVersions: Readonly<Record<string, string>>;
  limits: Readonly<Record<string, unknown>>;
}

/** Semantic inputs only. Target heads are frozen separately in the execution snapshot. */
export interface WikiCompilationIdentity extends WikiCompilationIdentityInput {
  fingerprint: string;
}

export interface WikiCompilationTargetHead {
  targetId: string;
  ref: VersionRef | null;
}

export interface WikiCompilationExecutionSnapshot {
  currentTargetHeads: readonly WikiCompilationTargetHead[];
}

export interface PriorWikiCompilation {
  identity: WikiCompilationIdentity;
  executionSnapshot: WikiCompilationExecutionSnapshot;
  resultHeads: readonly VersionRef[];
}

export interface CurrentWikiCompilation {
  identity: WikiCompilationIdentity;
  executionSnapshot: WikiCompilationExecutionSnapshot;
}

function compareRefs(a: VersionRef, b: VersionRef): number {
  return refKey(a).localeCompare(refKey(b));
}

function normalizeSources(sources: readonly WikiCompilationSourceIdentity[]): WikiCompilationSourceIdentity[] {
  return sources.map(source => ({ ...source }))
    .sort((a, b) => canonical(a).localeCompare(canonical(b)));
}

function normalizeRefs(refs: readonly VersionRef[]): VersionRef[] {
  const byKey = new Map(refs.map(ref => [refKey(ref), { ...ref }]));
  return [...byKey.values()].sort(compareRefs);
}

/**
 * Creates a stable identity from host-resolved inputs. Caller request keys and timestamps
 * deliberately have no place in this contract.
 */
export function createWikiCompilationIdentity(input: WikiCompilationIdentityInput): WikiCompilationIdentity {
  const normalized = {
    ...input,
    sources: normalizeSources(input.sources),
    externalReadingRefs: normalizeRefs(input.externalReadingRefs),
  };
  return { ...normalized, fingerprint: digest(normalized) };
}

/** Freeze the actual heads observed by the host, including targets this run may publish. */
export function createWikiCompilationExecutionSnapshot(input: {
  currentTargetHeads: readonly WikiCompilationTargetHead[];
}): WikiCompilationExecutionSnapshot {
  return {
    currentTargetHeads: input.currentTargetHeads.map(head => ({
      targetId: head.targetId,
      ref: head.ref ? { ...head.ref } : null,
    })).sort((a, b) => a.targetId.localeCompare(b.targetId)),
  };
}

/**
 * Checks whether a prior result can be reused. A prior result head is self-output only
 * for the matching target object; it cannot mask a changed head on another target.
 */
export function wikiCompilationEquivalent(prior: PriorWikiCompilation, current: CurrentWikiCompilation): boolean {
  if (prior.identity.fingerprint !== current.identity.fingerprint) return false;

  const priorHeads = new Map(prior.executionSnapshot.currentTargetHeads.map(head => [head.targetId, head.ref]));
  const currentHeads = new Map(current.executionSnapshot.currentTargetHeads.map(head => [head.targetId, head.ref]));
  if (priorHeads.size !== currentHeads.size) return false;

  for (const [targetId, currentRef] of currentHeads) {
    if (!priorHeads.has(targetId)) return false;
    const isOwnOutput = currentRef !== null && currentRef.objectId === targetId &&
      prior.resultHeads.some(result => result.objectId === targetId && refKey(result) === refKey(currentRef));
    if (isOwnOutput) continue;
    const previousRef = priorHeads.get(targetId) ?? null;
    if (previousRef === null || currentRef === null) {
      if (previousRef !== currentRef) return false;
    } else if (refKey(previousRef) !== refKey(currentRef)) {
      return false;
    }
  }
  return true;
}

/** Unknown grouping is visible and never counted as independent support. */
export function inspectWikiSourceGroups(sources: readonly WikiCompilationSourceIdentity[]): {
  knownGroupCount: number; unknownGroupRefs: VersionRef[];
} {
  const known=new Set<string>(),unknown:VersionRef[]=[];
  for(const source of sources) {
    if(source.sourceGroup)known.add(source.sourceGroup);
    else unknown.push(source.ref);
  }
  return {knownGroupCount:known.size,unknownGroupRefs:normalizeRefs(unknown)};
}

/** Only known, source-verified groups satisfy an independence threshold. */
export function countIndependentWikiSourceGroups(sources: readonly WikiCompilationSourceIdentity[]): number {
  return inspectWikiSourceGroups(sources).knownGroupCount;
}
