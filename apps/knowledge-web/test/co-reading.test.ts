import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { KnowledgeDocument, KnowledgeRef, ReadReceipt } from '@commerce/knowledge-contracts';
import { coReadingPath, matchingCoReadingReceipt, resolveCoReading, toggleCoReading } from '../src/co-reading.ts';

const ref = (objectId: string, versionId = 'v1', domain: KnowledgeRef['domain'] = 'knowledge') => ({ projectId: 'p', spaceId: 's', domain, objectId, versionId, contentDigest: null }) as KnowledgeRef;

test('co-reading holds two exact versions, removes by exact ref, and ignores non-knowledge', () => {
  const a = ref('a'), b = ref('b'), c = ref('c'), old = ref('a', 'v0');
  assert.deepEqual(toggleCoReading([a, b], c), [a, b]);
  assert.deepEqual(toggleCoReading([a, b], a), [b]);
  assert.deepEqual(toggleCoReading([a], old), [a, old]);
  assert.deepEqual(toggleCoReading([a], ref('source', 'v1', 'source')), [a]);
});

test('unloaded exact version remains visible without borrowing another version’s content', () => {
  const old = ref('a', 'v0'), current = ref('a', 'v1');
  assert.deepEqual(resolveCoReading([old, current], [{ ref: current, title: '现版' } as KnowledgeDocument]).map(item => item.document?.title ?? null), [null, '现版']);
});

test('visual route uses returned edges only and stays empty across disconnected nodes', () => {
  const graph = { nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], edges: [{ id: 'ab', from: 'a', to: 'b' }, { id: 'bc', from: 'b', to: 'c' }] } as Parameters<typeof coReadingPath>[0];
  assert.deepEqual(coReadingPath(graph, 'a', 'c'), ['ab', 'bc']);
  assert.deepEqual(coReadingPath(graph, 'a', 'd'), []);
});

test('receipt is used only when both exact refs, purpose, scope and expiry match', () => {
  const a = ref('a'), b = ref('b');
  const receipt = { id: 'read-1', purpose: 'research', effectiveScope: { projectId: 'p', spaceId: 's' }, expiresAt: '2030-01-01T00:00:00.000Z', orderedItems: [{ ref: a }, { ref: b }] } as ReadReceipt;
  assert.equal(matchingCoReadingReceipt(receipt, 'research', [a, b], 0), 'read-1');
  assert.equal(matchingCoReadingReceipt(receipt, 'other', [a, b], 0), null);
  assert.equal(matchingCoReadingReceipt(receipt, 'research', [a, ref('b', 'v2')], 0), null);
  assert.equal(matchingCoReadingReceipt(receipt, 'research', [a, { ...b, contentDigest: 'different-digest' }], 0), null);
  assert.equal(matchingCoReadingReceipt(receipt, 'research', [a, b], Date.parse(receipt.expiresAt)), null);
  assert.equal(matchingCoReadingReceipt({ ...receipt, effectiveScope: { projectId: 'p', spaceId: 'other' } }, 'research', [a, b], 0), null);
});
