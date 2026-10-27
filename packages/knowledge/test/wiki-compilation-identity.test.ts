import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { VersionRef } from '../../contracts/src/index.ts';
import {
  countIndependentWikiSourceGroups,
  inspectWikiSourceGroups,
  createWikiCompilationExecutionSnapshot,
  createWikiCompilationIdentity,
  wikiCompilationEquivalent,
  type WikiCompilationIdentityInput,
  type WikiCompilationSourceIdentity,
} from '../src/wiki-compilation-identity.ts';

const ref = (): VersionRef => ({ objectId: randomUUID(), versionId: randomUUID() });
const source = (sourceGroup: string | null = 'video-a', contentDigest = 'digest-a'): WikiCompilationSourceIdentity => ({
  ref: ref(), sourceGroup, capability: 'source.read', contentDigest,
});

function identityInput(overrides: Partial<WikiCompilationIdentityInput> = {}): WikiCompilationIdentityInput {
  return {
    projectId: 'project-a', topicId: 'topic-a', questionVersion: ref(), intent: 'maintain', purpose: 'research',
    scope: { market: 'US', window: '2026-Q3' }, sources: [source()], externalReadingRefs: [ref()],
    methodVersion: 'wiki.compile@1', contractVersions: { source: '2', wiki: '1' }, limits: { maxSources: 20 },
    ...overrides,
  };
}

function snapshot(targets: readonly { targetId: string; ref: VersionRef | null }[]) {
  return createWikiCompilationExecutionSnapshot({ currentTargetHeads: targets });
}

test('same semantic input remains equivalent after its own result head becomes current', () => {
  const identity = createWikiCompilationIdentity(identityInput());
  const targetId = randomUUID();
  const before = ref();
  const result = { objectId: targetId, versionId: randomUUID() };
  assert.equal(wikiCompilationEquivalent({
    identity, executionSnapshot: snapshot([{ targetId, ref: before }]), resultHeads: [result],
  }, {
    identity, executionSnapshot: snapshot([{ targetId, ref: result }]),
  }), true);
});

test('changed external target head is not hidden by a result head for another target', () => {
  const identity = createWikiCompilationIdentity(identityInput());
  const outputTarget = randomUUID(), externalTarget = randomUUID();
  const result = { objectId: outputTarget, versionId: randomUUID() };
  const externalBefore = ref(), externalAfter = ref();
  assert.equal(wikiCompilationEquivalent({
    identity,
    executionSnapshot: snapshot([{ targetId: outputTarget, ref: null }, { targetId: externalTarget, ref: externalBefore }]),
    resultHeads: [result],
  }, {
    identity,
    executionSnapshot: snapshot([{ targetId: outputTarget, ref: result }, { targetId: externalTarget, ref: externalAfter }]),
  }), false);
});

test('changed source digest or context changes the identity', () => {
  const base = identityInput();
  const identity = createWikiCompilationIdentity(base);
  const changedSource = { ...base.sources[0]!, contentDigest: 'digest-b' };
  const changedContext = { ...base.scope, market: 'GB' };
  assert.notEqual(createWikiCompilationIdentity({ ...base, sources: [changedSource] }).fingerprint, identity.fingerprint);
  assert.notEqual(createWikiCompilationIdentity({ ...base, scope: changedContext }).fingerprint, identity.fingerprint);
  assert.notEqual(createWikiCompilationIdentity({ ...base, questionVersion: ref() }).fingerprint, identity.fingerprint);
  assert.notEqual(createWikiCompilationIdentity({ ...base, methodVersion: 'wiki.compile@2' }).fingerprint, identity.fingerprint);
});

test('a different frozen model route cannot reuse an earlier Wiki build', () => {
  const base=identityInput({contractVersions:{manifest:'wiki-experience@1',policy:'review@5',modelRoute:'luna-medium-digest'}});
  const prior=createWikiCompilationIdentity(base);
  const next=createWikiCompilationIdentity({...base,contractVersions:{...base.contractVersions,modelRoute:'sol-medium-digest'}});
  const targetHeads=[{targetId:randomUUID(),ref:ref()}];
  assert.notEqual(prior.fingerprint,next.fingerprint);
  assert.equal(wikiCompilationEquivalent({identity:prior,executionSnapshot:snapshot(targetHeads),resultHeads:[]},
    {identity:next,executionSnapshot:snapshot(targetHeads)}),false);
});

test('without result heads, an unchanged execution snapshot remains equivalent', () => {
  const identity = createWikiCompilationIdentity(identityInput());
  const targetHeads = [{ targetId: randomUUID(), ref: ref() }];
  assert.equal(wikiCompilationEquivalent({
    identity, executionSnapshot: snapshot(targetHeads), resultHeads: [],
  }, {
    identity, executionSnapshot: snapshot(targetHeads),
  }), true);
});

test('source and external reference ordering does not affect identity', () => {
  const base = identityInput({ sources: [source('g1', 'a'), source('g2', 'b')], externalReadingRefs: [ref(), ref()] });
  const reordered = { ...base, sources: [...base.sources].reverse(), externalReadingRefs: [...base.externalReadingRefs].reverse() };
  assert.equal(createWikiCompilationIdentity(base).fingerprint, createWikiCompilationIdentity(reordered).fingerprint);
});

test('two sources in one source group count as one independent group', () => {
  const first = source('same-group');
  const second = source('same-group');
  assert.equal(countIndependentWikiSourceGroups([first, second]), 1);
  assert.equal(countIndependentWikiSourceGroups([first, source('other-group')]), 2);
});

test('sources without a verified group do not count as independent support', () => {
  const missing=[source(null),source(null)];
  assert.equal(countIndependentWikiSourceGroups(missing),0);
  assert.equal(inspectWikiSourceGroups(missing).unknownGroupRefs.length,2);
  assert.equal(countIndependentWikiSourceGroups([source('known'),...missing]),1);
});
