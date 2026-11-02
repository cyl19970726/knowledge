import assert from 'node:assert/strict';
import test from 'node:test';
import { KnowledgeClientError, type KnowledgeClient } from '@commerce/knowledge-client';
import { CONTRACT_VERSION, type Envelope, type WikiCompileResult } from '@commerce/knowledge-contracts';
import { AnswerResearchState, actualCandidateId, isKnownResearchResult, makeAnswerResearchIntent, type AnswerResearchStorage } from '../src/answer-research-state.ts';

const scope = JSON.stringify(['project', 'space', 'reading']);
const otherScope = JSON.stringify(['project', 'other-space', 'reading']);
const recovery = 'c'.repeat(64);
const answerId = '00000000-0000-4000-8000-000000000001';
const compilationId = '00000000-0000-4000-8000-000000000002';
const candidateId = '00000000-0000-4000-8000-000000000003';
const fingerprint = 'a'.repeat(64);
const intent = () => makeAnswerResearchIntent(answerId, fingerprint, [0, 2], '原回答的问题', '0', 'reading', Date.parse('2026-11-02T00:00:00Z'));
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function session(): AnswerResearchStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}
function envelope<T>(data: T): Envelope<T> { return { contractVersion: CONTRACT_VERSION, requestId: 'test', effectiveScope: { projectId: 'project', spaceId: 'space' }, observedAt: '2026-11-02T00:00:00Z', data, warnings: [] }; }
function result(origin = intent(), withCandidate = false): WikiCompileResult {
  return { id: compilationId, answerOrigin: { answerId: origin.answerId, answerFingerprint: origin.input.expectedAnswerFingerprint,
    claimIndexes: origin.input.claimIndexes, question: origin.input.question }, question: origin.input.question, purpose: 'reading', state: 'draft_ready',
    drafts: [], candidate: withCandidate ? { candidateId, changeSetId: '00000000-0000-4000-8000-000000000004', draftRefs: [], contentHash: 'b'.repeat(64), published: false } : null,
    stageStatus: 'not_requested', evidence: [], excluded: [], readUsage: { wikiPayloadBytes: 7, sourceContentBytes: 0, preparedInputBytes: 7, maxReadBytes: 500000 },
    readsetFingerprint: 'd'.repeat(64), coverage: { scopeDescription: 'test', returned: 0, loaded: 0, hasMore: false, nextCursor: null,
      completeness: 'bounded', omittedReasons: [], snapshot: { publicationEpoch: 1, consistency: 'single_scope_snapshot' } },
    cost: { modelCalls: { state: 'known', value: 0 }, tokens: { state: 'unknown', reason: 'awaiting receipt' }, money: { state: 'unknown', reason: 'awaiting receipt' } },
    provider: null, reason: '待保证', gaps: ['仍需核对来源'], createdAt: '2026-11-02T00:00:00Z', completedAt: null };
}
function client(api: Record<string, unknown> = {}, spaceId = 'space'): KnowledgeClient {
  return { scope: { projectId: 'project', spaceId }, ...api } as KnowledgeClient;
}

test('intent freezes selected claim indexes, question, independent zero USD budget, and rejects invalid selection or money', () => {
  const selected = [0, 2];
  const value = makeAnswerResearchIntent(answerId, fingerprint, selected, ' 原回答的问题 ', '0', 'reading', Date.parse('2026-11-02T00:00:00Z'));
  selected[0] = 4;
  assert.deepEqual(value.input.claimIndexes, [0, 2]);
  assert.equal(value.input.question, '原回答的问题');
  assert.deepEqual(value.input.budget, { maxModelCalls: 1, maxReadBytes: 500000, deadline: '2026-11-02T00:02:00.000Z', maxMoney: { amount: 0, currency: 'USD' } });
  assert.equal(value.input.limit, 100); assert.equal(value.input.maxPages, 1);
  for (const money of ['', '-1', '1.234', 'Infinity', '1e3', ' 2']) assert.throws(() => makeAnswerResearchIntent(answerId, fingerprint, [0], 'x', money, 'reading'), /预算/);
  assert.throws(() => makeAnswerResearchIntent(answerId, fingerprint, [], 'x', '0', 'reading'));
  assert.throws(() => makeAnswerResearchIntent(answerId, fingerprint, [0, 0], 'x', '0', 'reading'));
});

test('settled research folds the new-write form while uncertain work stays available for original-key recovery', () => {
  assert.equal(isKnownResearchResult(result()), true);
  for (const state of ['reserved', 'running', 'outcome_unknown'] as const) assert.equal(isKnownResearchResult({ ...result(), state }), false);
  assert.equal(isKnownResearchResult(null), false);
});

test('storage failure prevents POST and restores no answer content', async () => {
  let posts = 0;
  const api = client({ researchAnswer: async () => { posts++; return envelope(result()); } });
  const state = new AnswerResearchState(() => {}, () => 'key', { getItem: () => null, setItem: () => { throw new Error('quota'); } });
  state.bind(scope, api, true, recovery, true);
  assert.equal(state.start(scope, api, intent(), recovery), false);
  await tick(); assert.equal(posts, 0);
  assert.match(state.view(scope, api, recovery).error, /没有提交/);
  const storage = session(); const valid = new AnswerResearchState(() => {}, () => 'original-key', storage);
  valid.bind(scope, api, true, recovery, true); assert.equal(valid.start(scope, api, intent(), recovery), true);
  const raw = [...storage.values.values()][0]!;
  assert.match(raw, /original-key/); assert.doesNotMatch(raw, /claims|evidence|token|sourceContent|正文/);
  await tick();
});

test('frozen POST, unknown outcome and refresh use only original GET key; historical compilation stays available without Ask', async () => {
  const calls: string[] = []; const storage = session();
  const api = client({ researchAnswer: async (id: string, input: ReturnType<typeof intent>['input'], opts: { idempotencyKey: string }) => {
    calls.push(`POST:${id}:${input.claimIndexes.join(',')}:${input.question}:${opts.idempotencyKey}`);
    throw new KnowledgeClientError({ code: 'TRANSPORT_OUTCOME_UNKNOWN', message: 'lost', commitStatus: 'unknown' });
  }, compilationLookup: async (key: string) => { calls.push(`GET:${key}`); return envelope({ state: 'known', compilation: result() }); },
  compilation: async (id: string) => { calls.push(`GET-ID:${id}`); return envelope(result()); } });
  const state = new AnswerResearchState(() => {}, () => 'original-key', storage);
  state.bind(scope, api, true, recovery, true);
  const submitted = intent(); assert.equal(state.start(scope, api, submitted, recovery), true);
  submitted.input.question = 'later edit'; submitted.input.claimIndexes[0] = 9;
  await tick();
  assert.equal(state.view(scope, api, recovery).phase, 'unknown');
  assert.equal(state.start(scope, api, intent(), recovery), false);
  assert.equal(await state.check(scope, api, recovery), true);
  assert.equal(state.view(scope, api, recovery).result?.answerOrigin?.question, '原回答的问题');
  const reloaded = new AnswerResearchState(() => {}, () => 'new-key', storage);
  reloaded.bind(scope, api, false, recovery, true); // The original Ask can be hidden, and new research can be disabled.
  assert.equal(reloaded.view(scope, api, recovery).result, null);
  assert.equal(await reloaded.check(scope, api, recovery), true);
  assert.equal(reloaded.view(scope, api, recovery).result?.id, compilationId);
  assert.deepEqual(calls, [`POST:${answerId}:0,2:原回答的问题:original-key`, 'GET:original-key', 'GET:original-key']);
  assert.equal(await reloaded.check(scope, api, recovery), true);
  assert.equal(calls.at(-1), `GET-ID:${compilationId}`);
});

test('403 after a known result hides it and locks the original key', async () => {
  const api = client({ researchAnswer: async () => envelope(result(intent(), true)),
    compilation: async () => { throw new KnowledgeClientError({ code: 'FORBIDDEN', message: 'revoked', httpStatus: 403 }); } });
  const state = new AnswerResearchState(() => {}, () => 'key', session());
  state.bind(scope, api, true, recovery, true); assert.equal(state.start(scope, api, intent(), recovery), true); await tick();
  assert.equal(actualCandidateId(state.view(scope, api, recovery)), candidateId);
  await state.check(scope, api, recovery);
  const view = state.view(scope, api, recovery);
  assert.equal(view.result, null); assert.equal(actualCandidateId(view), null);
  assert.equal(view.blocked, true); assert.equal(view.key, 'key'); assert.equal(state.start(scope, api, intent(), recovery), false);
});

test('write capability loss keeps original-key compilation GET available under read capability', async () => {
  let posts = 0; let reads = 0;
  const api = client({ researchAnswer: async () => { posts++; return envelope(result()); },
    compilationLookup: async (key: string) => { assert.equal(key, 'original-key'); reads++; return envelope({ state: 'known', compilation: result() }); } });
  const state = new AnswerResearchState(() => {}, () => 'original-key', session());
  state.bind(scope, api, true, recovery, true); state.start(scope, api, intent(), recovery); await tick();
  state.bind(scope, api, false, recovery, true);
  assert.equal(state.view(scope, api, recovery).result, null);
  assert.equal(state.start(scope, api, intent(), recovery), false);
  assert.equal(await state.check(scope, api, recovery), true);
  assert.equal(state.view(scope, api, recovery).result?.id, compilationId);
  assert.equal(posts, 1); assert.equal(reads, 1);
});

test('read capability loss hides a compilation and discards a late GET response', async () => {
  const pending = deferred<Envelope<{ state: 'known'; compilation: WikiCompileResult }>>();
  let reads = 0;
  const api = client({ researchAnswer: async () => envelope(result()),
    compilationLookup: async () => { reads++; return pending.promise; } });
  const state = new AnswerResearchState(() => {}, () => 'original-key', session());
  state.bind(scope, api, true, recovery, true); state.start(scope, api, intent(), recovery); await tick();
  state.bind(scope, api, false, recovery, true);
  const checking = state.check(scope, api, recovery);
  state.bind(scope, api, false, recovery, false);
  assert.equal(state.view(scope, api, recovery).result, null);
  assert.equal(await state.check(scope, api, recovery), false);
  assert.equal(state.start(scope, api, intent(), recovery), false);
  pending.resolve(envelope({ state: 'known', compilation: result() })); await checking;
  assert.equal(state.view(scope, api, recovery).result, null);
  assert.equal(reads, 1);
});

test('read capability loss also discards a late POST result', async () => {
  const pending = deferred<Envelope<WikiCompileResult>>();
  const api = client({ researchAnswer: async () => pending.promise });
  const state = new AnswerResearchState(() => {}, () => 'original-key', session());
  state.bind(scope, api, true, recovery, true);
  assert.equal(state.start(scope, api, intent(), recovery), true); await tick();
  state.bind(scope, api, true, recovery, false);
  pending.resolve(envelope(result())); await tick();
  const view = state.view(scope, api, recovery);
  assert.equal(view.result, null); assert.equal(view.key, 'original-key');
  assert.equal(await state.check(scope, api, recovery), false);
});

test('late response from previous scope cannot show in the new scope', async () => {
  const pending = deferred<Envelope<WikiCompileResult>>();
  const api = client({ researchAnswer: async () => pending.promise });
  const other = client({}, 'other-space');
  const state = new AnswerResearchState(() => {}, () => 'key', session());
  state.bind(scope, api, true, recovery, true); state.start(scope, api, intent(), recovery); await tick();
  state.bind(otherScope, other, false, recovery, true);
  pending.resolve(envelope(result())); await tick();
  assert.equal(state.view(otherScope, other, recovery).result, null);
  assert.equal(state.view(scope, api, recovery).result, null);
});

test('only a returned candidate receipt exposes a candidate link, and mismatched origin is hidden', async () => {
  const api = client({ researchAnswer: async () => envelope(result()), compilationLookup: async () => envelope({ state: 'unknown', compilation: null }) });
  const state = new AnswerResearchState(() => {}, () => 'key', session());
  state.bind(scope, api, true, recovery, true); state.start(scope, api, intent(), recovery); await tick();
  assert.equal(actualCandidateId(state.view(scope, api, recovery)), null);
  const wrong = result(); wrong.answerOrigin = { ...wrong.answerOrigin!, answerFingerprint: 'f'.repeat(64) };
  const bad = client({ researchAnswer: async () => envelope(wrong) });
  const blocked = new AnswerResearchState(() => {}, () => 'bad-key', session());
  blocked.bind(scope, bad, true, recovery, true); blocked.start(scope, bad, intent(), recovery); await tick();
  assert.equal(blocked.view(scope, bad, recovery).result, null);
  assert.equal(blocked.view(scope, bad, recovery).blocked, true);
});

test('edited follow-up accepts the original Ask question in origin and opens its real candidate', async () => {
  const originalAskQuestion = '原问';
  const followup = makeAnswerResearchIntent(answerId, fingerprint, [0, 2], '后续问', '0', 'reading');
  const receipt = result(followup, true);
  receipt.answerOrigin!.question = originalAskQuestion;
  const api = client({ researchAnswer: async () => envelope(receipt) });
  const state = new AnswerResearchState(() => {}, () => 'followup-key', session());
  state.bind(scope, api, true, recovery, true);
  assert.equal(state.start(scope, api, followup, recovery), true); await tick();
  const view = state.view(scope, api, recovery);
  assert.equal(actualCandidateId(view), candidateId);
  assert.equal(view.intent?.input.question, '后续问'); // Candidate navigation carries this frozen follow-up.
  assert.equal(view.result?.answerOrigin?.question, originalAskQuestion); // Returning to Ask keeps its original question.
});

test('matching origin id and fingerprint cannot mask a tampered follow-up question', async () => {
  const followup = makeAnswerResearchIntent(answerId, fingerprint, [0, 2], '后续问', '0', 'reading');
  const receipt = result(followup, true);
  receipt.answerOrigin!.question = '原问';
  receipt.question = '另一个研究问题';
  const api = client({ researchAnswer: async () => envelope(receipt) });
  const state = new AnswerResearchState(() => {}, () => 'tampered-key', session());
  state.bind(scope, api, true, recovery, true);
  assert.equal(state.start(scope, api, followup, recovery), true); await tick();
  const view = state.view(scope, api, recovery);
  assert.equal(actualCandidateId(view), null);
  assert.equal(view.result, null); assert.equal(view.blocked, true);
  assert.equal(view.key, 'tampered-key');
});
