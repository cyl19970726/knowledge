import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { KnowledgeClient } from '@commerce/knowledge-client';
import type { AskResult, CandidateView } from '@commerce/knowledge-contracts';
import { AnswerResearchPanel } from '../src/answer-research-panel.tsx';
import { verifiedCandidateView } from '../src/candidate-scope.ts';

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

test('answered research starts as a compact explicit chooser, keeping paid preparation out of the initial reading', () => {
  const markup = html(answer, true);
  assert.match(markup, /选择结论继续研究/);
  assert.doesNotMatch(markup, /class="answer-research-form"|type="checkbox"|继续研究所选结论<\/button>/);
  assert.match(markup, /候选仍须独立审阅/);
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
  assert.doesNotMatch(markup, /class="answer-research-form"|继续研究所选结论<\/button>/);
  assert.doesNotMatch(markup, /只读核对研究记录/);
});

test('only the candidate GET for the same ID, purpose and scope can supply the summary', () => {
  const candidate = { candidateId: 'candidate-1', purpose: 'reading', changes: [
    { ref: { projectId: 'project', spaceId: 'space', objectId: 'one', versionId: 'v2' } },
    { ref: { projectId: 'project', spaceId: 'space', objectId: 'two', versionId: 'v1' } },
  ] } as CandidateView;
  assert.equal(verifiedCandidateView(candidate, 'candidate-1', 'reading', 'project', 'space'), candidate);
  assert.equal(verifiedCandidateView(candidate, 'other', 'reading', 'project', 'space'), null);
  assert.equal(verifiedCandidateView(candidate, 'candidate-1', 'write', 'project', 'space'), null);
  assert.equal(verifiedCandidateView({ ...candidate, changes: [candidate.changes[0],
    { ...candidate.changes[1], ref: { ...candidate.changes[1].ref, spaceId: 'other' } }] }, 'candidate-1', 'reading', 'project', 'space'), null);
});
