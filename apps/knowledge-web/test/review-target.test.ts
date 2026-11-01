import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CandidateView, ResearchResult } from '@commerce/knowledge-contracts';
import { reviewTargetFor } from '../src/review-target.ts';

const candidateResult = { researchId: 'research-1', resultDigest: 'result-digest', cognitiveOutcome: 'candidate', candidateId: 'candidate-1' } as ResearchResult;
const candidate = { candidateId: 'candidate-1', contentHash: 'candidate-hash', state: 'waiting_for_review' } as CandidateView;

test('candidate review uses the loaded candidate identity and content hash, not the research result target', () => {
  assert.deepEqual(reviewTargetFor(candidateResult, candidate), { kind: 'candidate', candidateId: 'candidate-1', contentHash: 'candidate-hash' });
});

test('candidate review waits for an exact loaded candidate', () => {
  assert.equal(reviewTargetFor(candidateResult, null), null);
  assert.equal(reviewTargetFor(candidateResult, { ...candidate, candidateId: 'candidate-2' }), null);
  assert.equal(reviewTargetFor(candidateResult, { ...candidate, state: 'cancelled' }), null);
});

test('non-candidate review keeps the research result digest target', () => {
  const result = { ...candidateResult, cognitiveOutcome: 'no_change', candidateId: null } as ResearchResult;
  assert.deepEqual(reviewTargetFor(result, null), { kind: 'research_result', researchId: 'research-1', resultDigest: 'result-digest' });
  assert.deepEqual(reviewTargetFor(result, candidate), { kind: 'research_result', researchId: 'research-1', resultDigest: 'result-digest' });
  assert.equal(reviewTargetFor(null, candidate), null);
});
