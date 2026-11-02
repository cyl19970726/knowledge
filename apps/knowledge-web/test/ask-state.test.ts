import assert from 'node:assert/strict';
import test from 'node:test';
import { KnowledgeClientError, type KnowledgeClient } from '@commerce/knowledge-client';
import { CONTRACT_VERSION, AskResultSchema, type AskResult, type Envelope } from '@commerce/knowledge-contracts';
import { AskState, compareAskSelection, makeAskRequest, type AskSessionStorage } from '../src/ask-state.ts';

const scope = 'project/space/reading';
const input = () => makeAskRequest('原始问题', 'reading', '0', false, Date.parse('2026-11-02T00:00:00Z'));
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const exactWiki = { projectId: 'project', spaceId: 'space', domain: 'knowledge' as const, objectId: '00000000-0000-4000-8000-000000000002', versionId: '00000000-0000-4000-8000-000000000003', contentDigest: 'b'.repeat(64) };
const fixture = (state: AskResult['state']): AskResult => ({
  id: '00000000-0000-4000-8000-000000000001', question: '原始问题', purpose: 'reading', state,
  claims: state === 'answered' ? [{ text: '有依据的测试回答', evidenceIds: ['e1'] }] : [],
  evidence: state === 'answered' ? [{ id: 'e1', kind: 'wiki_page', ref: exactWiki, title: '测试认识', locator: null, conditions: [], counterexamples: [], unknowns: [], actualReadCoverage: [] }] : [],
  excluded: [], coverage: { scopeDescription: 'test', returned: state === 'answered' ? 1 : 0, loaded: state === 'answered' ? 1 : 0, hasMore: false, nextCursor: null, completeness: 'bounded', omittedReasons: [], snapshot: { publicationEpoch: 1, consistency: 'single_scope_snapshot' } },
  readsetFingerprint: 'a'.repeat(64), cost: { modelCalls: { state: 'known', value: 0 }, tokens: { state: 'known', value: 0 }, money: { state: 'known', amount: 0, currency: 'USD', source: 'test' } }, provider: null, reason: 'test', gaps: [], createdAt: '2026-11-02T00:00:00Z', completedAt: null,
});
type Api = Pick<KnowledgeClient, 'ask' | 'answer' | 'lookupAnswer'>;
function client(api: Partial<Api>): KnowledgeClient { return api as KnowledgeClient; }
function envelope<T>(data: T):Envelope<T> { return { contractVersion:CONTRACT_VERSION,requestId:'test-request',effectiveScope:{projectId:'project',spaceId:'space'},
  observedAt:'2026-11-02T00:00:00Z',data,warnings:[] }; }
const recovery = 'c'.repeat(64);
const recoverableScope = JSON.stringify(['project', 'space', 'reading']);
function session(): AskSessionStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
}
function scopedClient(api: Partial<Api>): KnowledgeClient { return { scope: { projectId: 'project', spaceId: 'space' }, ...api } as KnowledgeClient; }

test('default budget is frozen, invalid money never starts a paid request', () => {
  assert.equal(AskResultSchema.parse(fixture('answered')).claims[0]?.evidenceIds[0], 'e1');
  assert.deepEqual(input().budget, { maxModelCalls: 1, maxReadBytes: 60000, deadline: '2026-11-02T00:01:00.000Z', maxMoney: { amount: 0, currency: 'USD' } });
  assert.equal(input().limit, 10); assert.equal(input().maxPages, 2); assert.equal(input().includeSourceContent, false);
  for (const value of ['', '-1', '1.234', 'Infinity', '1e3', ' 2', 'NaN']) assert.throws(() => makeAskRequest('x', 'reading', value, false), /预算/);
  assert.equal(makeAskRequest('x', 'reading', '2.50', true).budget.maxMoney?.amount, 2.5);
});

test('selected exact Wiki refs are frozen in the request; legacy request omits the field', () => {
  const selected = [{ ...exactWiki }];
  const request = makeAskRequest(' 比较 A/B ', 'reading', '0', false, selected, Date.parse('2026-11-02T00:00:00Z'));
  assert.equal(request.question, '比较 A/B');
  assert.deepEqual(request.selectedRefs, [exactWiki]);
  selected[0]!.contentDigest = 'c'.repeat(64);
  assert.equal(request.selectedRefs?.[0]?.contentDigest, exactWiki.contentDigest);
  assert.equal(Object.hasOwn(input(), 'selectedRefs'), false);
  assert.throws(() => makeAskRequest('x', 'reading', '0', false, [{ ...exactWiki, contentDigest: null }]), /selectedRefs|digest/i);
});

test('selection comparison distinguishes actual exact Wiki reads, exclusion, and pending evidence', () => {
  const second = { ...exactWiki, objectId: '00000000-0000-4000-8000-000000000004' };
  const request = makeAskRequest('A/B', 'reading', '0', false, [exactWiki, second]);
  const result = fixture('answered');
  result.excluded = [{ ref: { ...second, contentDigest: null }, reason: 'Too large; body not fetched' }];
  assert.deepEqual(compareAskSelection(request, result).map(item => item.status), ['read', 'excluded']);
  assert.equal(compareAskSelection(request, result)[1]?.reason, 'Too large; body not fetched');
  assert.deepEqual(compareAskSelection(request, null).map(item => item.status), ['pending', 'pending']);
  assert.deepEqual(compareAskSelection(request, fixture('running')).map(item => item.status), ['pending', 'pending']);
  result.evidence = [{ ...result.evidence[0]!, ref: { ...exactWiki, contentDigest: 'c'.repeat(64) } }];
  assert.equal(compareAskSelection(request, result)[0]?.status, 'not_read');
});

test('graph choice changes after submission cannot rewrite the key, POST input, or read comparison', async () => {
  const response = deferred<Awaited<ReturnType<KnowledgeClient['ask']>>>();
  const sent: { key: string; selected: string | null }[] = [];
  const api = client({ ask: async (data, opts) => {
    sent.push({ key: opts.idempotencyKey, selected: data.selectedRefs?.[0]?.contentDigest ?? null });
    return response.promise;
  } });
  const state = new AskState(() => {}, () => 'frozen-key');
  state.bind(scope, api, true);
  const graphChoice = [{ ...exactWiki }];
  assert.equal(state.start(scope, api, makeAskRequest('A/B', 'reading', '0', false, graphChoice)), true);
  graphChoice[0] = { ...exactWiki, contentDigest: 'c'.repeat(64) };
  await tick();
  assert.deepEqual(sent, [{ key: 'frozen-key', selected: exactWiki.contentDigest }]);
  assert.equal(state.view(scope, api).input?.selectedRefs?.[0]?.contentDigest, exactWiki.contentDigest);
  assert.equal(compareAskSelection(state.view(scope, api).input, state.view(scope, api).result)[0]?.status, 'pending');
  response.resolve(envelope(fixture('answered'))); await tick();
  assert.equal(compareAskSelection(state.view(scope, api).input, state.view(scope, api).result)[0]?.status, 'read');
});

test('lost response locks original key and input; unknown lookup is GET only and never posts again', async () => {
  const calls: string[] = [];
  const api = client({ ask: async (data, opts) => { calls.push(`POST:${opts.idempotencyKey}:${data.question}`); throw new KnowledgeClientError({ code: 'TRANSPORT_OUTCOME_UNKNOWN', message: 'lost', commitStatus: 'unknown' }); },
    lookupAnswer: async (key, purpose) => { calls.push(`GET:${key}:${purpose}`); return envelope({ state: 'unknown' as const, answer: null }); } });
  const state = new AskState(() => {}, () => 'fixed-key'); state.bind(scope, api, true);
  const request = input(); assert.equal(state.start(scope, api, request), true); request.question = 'changed';
  assert.equal(state.start(scope, api, input()), false); await tick();
  assert.equal(state.view(scope, api).phase, 'unknown'); assert.equal(state.view(scope, api).input?.question, '原始问题');
  assert.equal(await state.check(scope, api), true); assert.equal(state.view(scope, api).phase, 'unknown');
  assert.deepEqual(calls, ['POST:fixed-key:原始问题', 'GET:fixed-key:reading']); assert.equal(state.start(scope, api, input()), false);
});

test('reserved result uses answer GET, holds concurrent submissions and unlocks only on a terminal response', async () => {
  const pending = deferred<Awaited<ReturnType<KnowledgeClient['answer']>>>(); let posts = 0; let reads = 0;
  const api = client({ ask: async () => { posts++; return envelope(fixture('reserved')); }, answer: async (id, purpose) => { assert.equal(id, fixture('reserved').id); assert.equal(purpose, 'reading'); reads++; return pending.promise; } });
  const state = new AskState(() => {}, () => 'key'); state.bind(scope, api, true); state.start(scope, api, input()); await tick();
  assert.equal(state.view(scope, api).phase, 'reserved'); const checking = state.check(scope, api);
  assert.equal(state.view(scope, api).result, null); assert.equal(state.start(scope, api, input()), false); assert.equal(await state.check(scope, api), false);
  pending.resolve(envelope(fixture('needs_evidence'))); await checking;
  assert.equal(state.view(scope, api).phase, 'needs_evidence'); assert.equal(posts, 1); assert.equal(reads, 1);
});

test('answered refresh hides cached answer; 409 invalidation clears evidence and keeps key locked', async () => {
  const pending = deferred<Awaited<ReturnType<KnowledgeClient['answer']>>>();
  const api = client({ ask: async () => envelope(fixture('answered')), answer: async () => pending.promise });
  const state = new AskState(() => {}, () => 'key'); state.bind(scope, api, true); state.start(scope, api, input()); await tick();
  assert.equal(state.view(scope, api).phase, 'answered'); const checking = state.check(scope, api);
  assert.equal(state.view(scope, api).result, null);
  pending.reject(new KnowledgeClientError({ code: 'ASK_READSET_INVALIDATED', message: 'readset revoked', httpStatus: 409, commitStatus: 'not_committed' })); await checking;
  assert.equal(state.view(scope, api).result, null); assert.equal(state.view(scope, api).phase, 'unknown'); assert.equal(state.start(scope, api, input()), false);
  assert.match(state.view(scope, api).error,/旧答案已隐藏/);
});

test('scope and client changes discard late POST and GET responses; permission loss removes old answer', async () => {
  const first = deferred<Awaited<ReturnType<KnowledgeClient['ask']>>>(); const lateRead = deferred<Awaited<ReturnType<KnowledgeClient['answer']>>>();
  const apiA = client({ ask: async () => first.promise, answer: async () => lateRead.promise });
  const apiB = client({ ask: async () => envelope(fixture('needs_evidence')), answer: async () => lateRead.promise });
  const state = new AskState(() => {}, () => 'key'); state.bind(scope, apiA, true); state.start(scope, apiA, input());
  state.bind('other', apiB, true); first.resolve(envelope(fixture('answered'))); await tick();
  assert.equal(state.view('other', apiB).result, null); state.bind(scope, apiA, true);
  assert.equal(state.view(scope, apiA).phase, 'unknown'); assert.equal(state.view(scope, apiA).result, null);
  // A fresh completed answer cannot survive a capability change.
  state.bind('other', apiB, true); state.start('other', apiB, input()); await tick();
  assert.equal(state.view('other', apiB).phase, 'needs_evidence'); state.bind('other', apiB, false);
  assert.equal(state.view('other', apiB).result, null); assert.equal(state.start('other', apiB, input()), false);
  state.bind('other', apiB, true); state.start('other', apiB, input()); await tick();
  const checking = state.check('other', apiB); state.bind(scope, apiA, true); lateRead.resolve(envelope(fixture('answered'))); await checking;
  assert.equal(state.view(scope, apiA).result, null);
});

test('reload reconstructs only the original key and strict request, then GET recovers a terminal answer', async () => {
  const storage = session(); const calls: string[] = [];
  const original = makeAskRequest('原始问题', 'reading', '2.50', true, [exactWiki], Date.parse('2026-11-02T00:00:00Z'));
  const api = scopedClient({ ask: async (data, opts) => { assert.match([...storage.values.values()][0] ?? '', /original-key/); calls.push(`POST:${opts.idempotencyKey}:${data.question}`); return envelope(fixture('answered')); },
    lookupAnswer: async (key, purpose) => { calls.push(`GET:${key}:${purpose}`); return envelope({ state: 'committed' as const, answer: fixture('answered') }); } });
  Object.assign(api, { accessToken: 'synthetic-test-secret' });
  const first = new AskState(() => {}, () => 'original-key', storage); first.bind(recoverableScope, api, true, recovery);
  assert.equal(first.start(recoverableScope, api, original, recovery), true); await tick();
  assert.equal(first.view(recoverableScope, api, recovery).phase, 'answered');
  const [[storageKey, stored]] = [...storage.values];
  assert.equal(storageKey, `knowledge:ask:v1:${recovery}:${recoverableScope}`);
  assert.deepEqual(Object.keys(JSON.parse(stored)).sort(), ['input', 'key', 'v']);
  assert.equal(stored.includes('synthetic-test-secret'), false);
  assert.equal(stored.includes('有依据的测试回答'), false); assert.equal(stored.includes('测试认识'), false);
  assert.deepEqual(JSON.parse(stored).input.selectedRefs, [exactWiki]);
  const reloaded = new AskState(() => {}, () => 'different-key', storage); reloaded.bind(recoverableScope, api, true, recovery);
  assert.equal(reloaded.view(recoverableScope, api, recovery).phase, 'unknown');
  assert.equal(reloaded.view(recoverableScope, api, recovery).result, null);
  assert.equal(reloaded.view(recoverableScope, api, recovery).input?.budget.maxMoney?.amount, 2.5);
  assert.equal(reloaded.view(recoverableScope, api, recovery).input?.includeSourceContent, true);
  assert.deepEqual(reloaded.view(recoverableScope, api, recovery).input?.selectedRefs, [exactWiki]);
  assert.equal(reloaded.start(recoverableScope, api, input(), recovery), false);
  assert.equal(await reloaded.check(recoverableScope, api, recovery), true);
  assert.equal(reloaded.view(recoverableScope, api, recovery).phase, 'answered');
  assert.equal(reloaded.view(recoverableScope, api, recovery).input?.question, '原始问题');
  assert.equal(reloaded.view(recoverableScope, api, recovery).input?.budget.maxMoney?.amount, 2.5);
  assert.equal(reloaded.view(recoverableScope, api, recovery).input?.includeSourceContent, true);
  assert.deepEqual(calls, ['POST:original-key:原始问题', 'GET:original-key:reading']);
});

test('session save failure prevents POST before any paid intent starts', async () => {
  let posts = 0;
  const storage: AskSessionStorage = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
  const api = scopedClient({ ask: async () => { posts++; return envelope(fixture('answered')); } });
  const state = new AskState(() => {}, () => 'key', storage); state.bind(recoverableScope, api, true, recovery);
  assert.equal(state.start(recoverableScope, api, input(), recovery), false); await tick();
  assert.equal(posts, 0); assert.match(state.view(recoverableScope, api, recovery).error, /没有提交/);
  assert.equal(state.view(recoverableScope, api, recovery).key, null);
});

test('unreadable session record blocks a new paid request', async () => {
  let posts = 0;
  const storage: AskSessionStorage = { getItem: () => { throw new Error('storage unavailable'); }, setItem: () => {}, removeItem: () => {} };
  const api = scopedClient({ ask: async () => { posts++; return envelope(fixture('answered')); } });
  const state = new AskState(() => {}, () => 'key', storage); state.bind(recoverableScope, api, true, recovery);
  assert.equal(state.view(recoverableScope, api, recovery).phase, 'unknown');
  assert.equal(state.start(recoverableScope, api, input(), recovery), false); await tick();
  assert.equal(posts, 0);
});

test('recovery scope separates principals and purposes; corrupt or old records block new POST', async () => {
  const storage = session(); let posts = 0;
  const api = scopedClient({ ask: async () => { posts++; return envelope(fixture('answered')); } });
  const first = new AskState(() => {}, () => 'old-key', storage); first.bind(recoverableScope, api, true, recovery);
  first.start(recoverableScope, api, input(), recovery); await tick(); assert.equal(posts, 1);
  const otherPrincipal = 'd'.repeat(64), otherPurpose = JSON.stringify(['project', 'space', 'planning']);
  const second = new AskState(() => {}, () => 'new-key', storage);
  second.bind(recoverableScope, api, true, otherPrincipal);
  assert.equal(second.view(recoverableScope, api, otherPrincipal).key, null);
  second.bind(otherPurpose, api, true, recovery);
  assert.equal(second.view(otherPurpose, api, recovery).key, null);
  const otherSpace = JSON.stringify(['project', 'another-space', 'reading']);
  const otherSpaceApi = { ...api, scope: { projectId: 'project', spaceId: 'another-space' } } as KnowledgeClient;
  second.bind(otherSpace, otherSpaceApi, true, recovery);
  assert.equal(second.view(otherSpace, otherSpaceApi, recovery).key, null);
  for (const raw of ['{"v":0,"key":"old-key","input":{}}', '{"v":1,"key":"old-key","input":{},"answer":"cached"}',
    JSON.stringify({ v: 1, key: 'old-key', input: { ...input(), purpose: 'planning' } }), 'x'.repeat(8193)]) {
    storage.values.set(`knowledge:ask:v1:${otherPrincipal}:${recoverableScope}`, raw);
    const reloaded = new AskState(() => {}, () => 'new-key', storage); reloaded.bind(recoverableScope, api, true, otherPrincipal);
    assert.equal(reloaded.view(recoverableScope, api, otherPrincipal).phase, 'unknown');
    assert.equal(reloaded.start(recoverableScope, api, input(), otherPrincipal), false);
  }
  assert.equal(posts, 1);
});

test('restored key stays hidden and locked after permission failure on GET', async () => {
  const storage = session(); let posts = 0, reads = 0;
  const api = scopedClient({ ask: async () => { posts++; return envelope(fixture('answered')); },
    lookupAnswer: async () => { reads++; throw new KnowledgeClientError({ code: 'SCOPE_FORBIDDEN', message: 'revoked', httpStatus: 403, commitStatus: 'not_committed' }); } });
  const first = new AskState(() => {}, () => 'key', storage); first.bind(recoverableScope, api, true, recovery);
  first.start(recoverableScope, api, input(), recovery); await tick();
  const reloaded = new AskState(() => {}, () => 'new-key', storage); reloaded.bind(recoverableScope, api, true, recovery);
  await reloaded.check(recoverableScope, api, recovery);
  assert.equal(reloaded.view(recoverableScope, api, recovery).result, null);
  assert.equal(reloaded.view(recoverableScope, api, recovery).phase, 'unknown');
  assert.equal(reloaded.start(recoverableScope, api, input(), recovery), false);
  assert.equal(posts, 1); assert.equal(reads, 1);
});
