import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HistoryResult, KnowledgeRef } from '@commerce/knowledge-contracts';
import { refKey } from '../src/graph/view-model.ts';
import { publishedPair, versionDate, versionDateParts } from '../src/evolution/versions.ts';

const ref = (versionId: string): KnowledgeRef => ({ projectId: 'project', spaceId: 'space', domain: 'knowledge', objectId: 'C', versionId, contentDigest: versionId.padEnd(64, 'a') });
const history: HistoryResult['versions'] = [
  { ref: ref('v2'), publishedAt: '2026-11-01T10:00:00.000Z', reason: 'reviewed revision' },
  { ref: ref('v1'), publishedAt: null, reason: 'not_recorded' },
];

test('compare receives two exact references from published history', () => {
  assert.deepEqual(publishedPair(history, refKey(ref('v1')), refKey(ref('v2'))), { before: history[1].ref, after: history[0].ref });
});

test('candidate or unrelated reference cannot enter published compare', () => {
  assert.equal(publishedPair(history, refKey(ref('candidate-C2')), refKey(ref('v2'))), null);
  assert.equal(publishedPair(history, refKey(ref('v1')), refKey(ref('v1'))), null);
  assert.equal(publishedPair(history.slice(0, 1), refKey(ref('v1')), refKey(ref('v2'))), null);
});

test('publication time is explicit and missing time stays unknown', () => {
  assert.match(versionDate('2026-11-01T10:00:00.000Z'), /2026.*11.*01.*18:00.*台北/);
  assert.deepEqual(versionDateParts('2026-11-01T10:00:00.000Z'), { date: '2026/11/01', time: '18:00', zone: '台北' });
  assert.equal(versionDate(null), '发表时间未记录');
  assert.equal(versionDate('invalid'), '发表时间无效');
});
