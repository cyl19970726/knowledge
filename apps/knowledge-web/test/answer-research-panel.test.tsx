import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { KnowledgeClient } from '@commerce/knowledge-client';
import type { AskResult } from '@commerce/knowledge-contracts';
import { AnswerResearchPanel } from '../src/answer-research-panel.tsx';

const client = { scope: { projectId: 'project', spaceId: 'space' } } as KnowledgeClient;
const answer: AskResult = {
  id: '00000000-0000-4000-8000-000000000001', answerFingerprint: 'a'.repeat(64), question: '哪些条件仍待核对？', purpose: 'reading', state: 'answered',
  claims: [{ text: '结论甲', evidenceIds: ['e1'] }, { text: '结论乙', evidenceIds: ['e1'] }], evidence: [], excluded: [],
  coverage: { scopeDescription: 'test', returned: 0, loaded: 0, hasMore: false, nextCursor: null, completeness: 'bounded', omittedReasons: [],
    snapshot: { publicationEpoch: 1, consistency: 'single_scope_snapshot' } }, readsetFingerprint: 'b'.repeat(64),
  cost: { modelCalls: { state: 'known', value: 0 }, tokens: { state: 'unknown', reason: 'pending' }, money: { state: 'unknown', reason: 'pending' } },
  provider: null, reason: 'test', gaps: [], createdAt: '2026-11-02T00:00:00Z', completedAt: null,
};
function html(value: AskResult | null, permitted: boolean, canRead = true) {
  return renderToStaticMarkup(createElement(AnswerResearchPanel, { client, purpose: 'reading', answer: value, permitted,
    canRead, recoveryScope: 'c'.repeat(64), visible: true, onCandidate: () => {} }));
}

test('answered claims are selected by default and research remains a separate explicit action', () => {
  const markup = html(answer, true);
  assert.match(markup, /结论甲/); assert.match(markup, /结论乙/);
  assert.equal((markup.match(/type="checkbox" checked=""/g) ?? []).length, 2);
  assert.match(markup, /继续研究所选结论/);
  assert.match(markup, /本次最高费用 0 USD（默认 0 USD）/);
  assert.match(markup, /<summary>查看本次预算与范围上限<\/summary>/);
  assert.doesNotMatch(markup, /打开待审候选/);
});

test('legacy response without fingerprint or capability cannot submit unsupported research', () => {
  const legacy = { ...answer, answerFingerprint: undefined };
  const markup = html(legacy, false);
  assert.match(markup, /未开放/);
  assert.doesNotMatch(markup, /继续研究所选结论/);
  assert.match(html(legacy, true), /没有可核对的指纹/);
});

test('research panel stays mounted when the original Ask result is hidden', () => {
  const markup = html(null, true);
  assert.match(markup, /aria-label="从回答继续研究"/);
  assert.match(markup, /hidden=""/);
});

test('missing compilation read permission hides read action and disables new paid research', () => {
  const markup = html(answer, true, false);
  assert.match(markup, /未开放编纂读取/);
  assert.match(markup, /继续研究所选结论<\/button>/);
  assert.match(markup, /disabled=""[^>]*>继续研究所选结论/);
  assert.doesNotMatch(markup, /只读核对研究记录/);
});
