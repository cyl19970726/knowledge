import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KnowledgeClientError } from '@commerce/knowledge-client';
import { CONTRACT_VERSION, RelationJudgmentSchema, WikiCompileResultSchema, type CoordinationRun, type Envelope, type MaintenanceFinding, type MaintenanceTask, type RelationJudgment, type WikiCompileResult } from '@commerce/knowledge-contracts';
import { MaintenanceInboxContent, findingReasonLabel, projectionLabel, taskReasonLabel } from '../src/maintenance-inbox.tsx';
import { MaintenanceInboxState, type MaintenanceClient } from '../src/maintenance-inbox-state.ts';

const id = (digit: number) => `00000000-0000-4000-8000-${String(digit).padStart(12, '0')}`;
const cost = { modelCalls: { state: 'known', value: 1 }, tokens: { state: 'unknown', reason: '未计量' },
  money: { state: 'unknown', reason: '未提供费用' } } as const;
const task = (digit: number, state: MaintenanceTask['state'] = 'queued'): MaintenanceTask => ({
  id: id(digit), request: { kind: 'recompile', subjectRef: null, sourceEventIds: [], relatedRefs: [],
    reason: `核对来源 <${digit}>`, methodVersion: 'wiki-v1', rubricVersion: 'rules-v1' },
  trigger: { stream: 'source_intake', eventKey: `source:${digit}`, sequence: digit, ref: null, sourceEventId: null },
  inputDigest: 'a'.repeat(64), state, attempts: 0, attemptId: null, leaseToken: 0, cancelRequested: false,
  dispatchState: 'not_dispatched', outcome: null, createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z',
});
const finding = (digit: number): MaintenanceFinding => ({ id: id(digit), taskId: id(1), kind: 'missing_citation',
  subjectRef: { projectId: 'p', spaceId: 's', domain: 'knowledge', objectId: id(50), versionId: id(51), contentDigest: null },
  relatedRefs: [], reason: '仍需出处', methodVersion: 'lint-v1', status: 'open', createdAt: '2026-11-02T00:00:00.000Z' });
const run = (taskId = id(1)): CoordinationRun => ({ id: id(70), request: { taskId, taskInputDigest: 'a'.repeat(64),
  purpose: 'reading', policyVersion: 'coord-v1', sourceEventId: id(71), budget: { maxModelCalls: 2, maxReadBytes: 1000,
    maxMoney: null, deadline: '2026-11-03T00:00:00.000Z' } }, state: 'no_change', sourcePlanId: id(72),
  candidateRefs: [finding(2).subjectRef], judgmentIds: [id(73)], compilationId: id(74), steps: [], cost,
  readBytes: 500, reason: '编纂提出无变化', gaps: ['仍需独立审阅'], createdAt: '2026-11-02T00:00:00.000Z', completedAt: null });
const readUsage = { wikiPayloadBytes: 0, sourceContentBytes: 0, preparedInputBytes: 0, maxReadBytes: 1000 };
const coverage = { scopeDescription: '测试空间', returned: 0, loaded: 0, hasMore: false, nextCursor: null,
  completeness: 'bounded' as const, omittedReasons: [], snapshot: { publicationEpoch: 0, consistency: 'single_scope_snapshot' as const } };
const compilation = (compilationId = id(74), candidateId = id(80)): WikiCompileResult => ({ id: compilationId,
  question: '来源是否改变认识？', purpose: 'reading', state: 'waiting_for_review', publication: null,
  drafts: [], candidate: { candidateId, changeSetId: id(81), draftRefs: [], contentHash: 'b'.repeat(64), published: false },
  stageStatus: 'staged', evidence: [], excluded: [], readUsage, readsetFingerprint: 'c'.repeat(64), coverage,
  cost, provider: null, reason: '等待审阅', gaps: [], createdAt: '2026-11-02T00:00:00.000Z', completedAt: null });
const judgment = (): RelationJudgment => ({ id: id(9), request: { left: finding(2).subjectRef, right: finding(2).subjectRef,
  purpose: 'reading', rubricVersion: 'rules-v1', questions: [
    { id: 'predicate', type: 'predicate', instructions: '是否同源？' },
    { id: 'choice', type: 'choice', instructions: '是否有反例？', options: [
      { value: 'insufficient_evidence', description: '证据不足' }, { value: 'related', description: '有关系' }] },
    { id: 'score', type: 'score', instructions: '相关程度？', levels: [
      { value: 0, description: '无关' }, { value: 1, description: '相关' }] }],
  budget: { maxModelCalls: 1, maxReadBytes: 1000, maxMoney: null, deadline: '2026-11-03T00:00:00.000Z' } },
  state: 'needs_evidence', evidence: [], readUsage, inputFingerprint: 'd'.repeat(64),
  batch: { modelReturned: 'synthetic', inputTokens: null, outputTokens: null, requestId: null, raw: {}, answers: [
    { id: 'predicate', type: 'predicate', state: 'answered', value: null, probability: 0.72,
      distribution: null, confidence: null, reason: null },
    { id: 'choice', type: 'choice', state: 'insufficient_evidence', value: 'insufficient_evidence',
      probability: null, distribution: null, confidence: null, reason: null },
    { id: 'score', type: 'score', state: 'refused', value: null, probability: null,
      distribution: null, confidence: null, reason: '证据不够' }] },
  cost, provider: null, sourceRelation: 'unknown', resolution: 'needs_evidence', reason: '仍有分歧',
  createdAt: '2026-11-02T00:00:00.000Z', completedAt: '2026-11-02T00:00:00.000Z' });
const envelope = <T,>(data: T): Envelope<T> => ({ contractVersion: CONTRACT_VERSION, requestId: 'maintenance-test',
  effectiveScope: { projectId: 'p', spaceId: 's' }, observedAt: '2026-11-02T00:00:00.000Z', data, warnings: [] });
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function client(overrides: Partial<MaintenanceClient> = {}): MaintenanceClient {
  return { maintenanceTasks: async () => envelope({ items: [task(1)], hasMore: false, nextCursor: null }),
    maintenanceFindings: async () => envelope({ items: [finding(2)], hasMore: false, nextCursor: null }),
    maintenanceTask: async () => envelope(task(1)), cancelMaintenance: async () => envelope(task(1, 'cancelled')),
    searchProjectionStatus: async () => envelope(null), compilation: async () => { throw new Error('Unexpected compilation read'); },
    judgment: async () => { throw new Error('Unexpected judgment read'); }, ...overrides } satisfies MaintenanceClient;
}

test('bounded independent pagination merges overlapping rows and sends cursor only for the next page', async () => {
  const calls: string[] = [];
  const api = client({ maintenanceTasks: async (_purpose, params) => { calls.push(`tasks:${params?.limit}:${params?.cursor ?? ''}`);
    return envelope(params?.cursor ? { items: [task(1), task(3)], hasMore: false, nextCursor: null }
      : { items: [task(1)], hasMore: true, nextCursor: 'task-next' }); },
  maintenanceFindings: async (_purpose, params) => { calls.push(`findings:${params?.limit}:${params?.cursor ?? ''}`);
    return envelope(params?.cursor ? { items: [finding(2), finding(4)], hasMore: false, nextCursor: null }
      : { items: [finding(2)], hasMore: true, nextCursor: 'finding-next' }); } });
  const state = new MaintenanceInboxState(api, 'reading', () => {});
  state.start(false); await tick();
  assert.equal(state.view().tasksMore, true); assert.equal(state.view().findingsMore, true);
  await Promise.all([state.loadTasks(), state.loadFindings()]);
  assert.deepEqual(state.view().tasks.map(item => item.id), [id(1), id(3)]);
  assert.deepEqual(state.view().findings.map(item => item.id), [id(2), id(4)]);
  assert.deepEqual(calls, ['tasks:20:', 'findings:20:', 'tasks:20:task-next', 'findings:20:finding-next']);
  state.dispose();
});

test('scope disposal aborts pending reads and old detail cannot appear in a fresh scope', async () => {
  const oldPage = deferred<ReturnType<typeof envelope<{ items: MaintenanceTask[]; hasMore: boolean; nextCursor: null }>>>();
  let aborted = false;
  const stale = new MaintenanceInboxState(client({ maintenanceTasks: async (_purpose, _params, opts) => {
    opts?.signal?.addEventListener('abort', () => { aborted = true; }); return oldPage.promise;
  } }), 'old', () => {});
  stale.start(false); stale.dispose();
  const fresh = new MaintenanceInboxState(client({ maintenanceTasks: async () => envelope({ items: [task(8)], hasMore: false, nextCursor: null }) }), 'new', () => {});
  fresh.start(false); await tick();
  oldPage.resolve(envelope({ items: [task(1)], hasMore: false, nextCursor: null })); await tick();
  assert.equal(aborted, true); assert.deepEqual(stale.view().tasks, []);
  assert.deepEqual(fresh.view().tasks.map(item => item.id), [id(8)]);
  fresh.dispose();
});

test('a late task detail cannot replace the newly selected task', async () => {
  const first = deferred<ReturnType<typeof envelope<MaintenanceTask>>>();
  let firstAborted = false;
  const api = client({ maintenanceTasks: async () => envelope({ items: [task(1), task(2)], hasMore: false, nextCursor: null }),
    maintenanceTask: async (taskId, _purpose, opts) => {
      if (taskId === id(1)) { opts?.signal?.addEventListener('abort', () => { firstAborted = true; }); return first.promise; }
      return envelope(task(2, 'running'));
    } });
  const state = new MaintenanceInboxState(api, 'reading', () => {});
  state.start(false); await tick(); state.select(id(1)); state.select(id(2)); await tick();
  first.resolve(envelope(task(1, 'completed'))); await tick();
  assert.equal(firstAborted, true); assert.equal(state.view().selected?.id, id(2));
  assert.equal(state.view().selected?.state, 'running');
  state.dispose();
});

test('403 on a derived read revokes task, detail, and all related data', async () => {
  // A task detail can point to a compilation without making it a publication.
  const withOutcome: MaintenanceTask = { ...task(1), outcome: { state: 'completed', findingIds: [], compilationId: id(7),
    judgmentId: null, reason: '完成候选编纂', cost } };
  const api2 = client({ maintenanceTask: async () => envelope(withOutcome),
    compilation: async () => { throw new KnowledgeClientError({ message: 'forbidden', code: 'FORBIDDEN', httpStatus: 403 }); } });
  const revoked = new MaintenanceInboxState(api2, 'reading', () => {});
  revoked.start(false); await tick(); revoked.select(id(1)); await tick();
  await revoked.loadRelated('compilation');
  assert.equal(revoked.view().denied, true); assert.equal(revoked.view().selected, null);
  assert.deepEqual(revoked.view().tasks, []); assert.deepEqual(revoked.view().findings, []);
  assert.equal(revoked.view().compilation, null); assert.equal(revoked.view().judgment, null);
});

test('unknown cancel preserves its original key and reconciliation never repeats POST', async () => {
  let writes = 0, gets = 0, keys: string[] = [];
  const api = client({ cancelMaintenance: async (_id, _purpose, opts) => {
    writes++; keys.push(opts.idempotencyKey); throw new KnowledgeClientError({ message: 'response lost', code: 'TRANSPORT_ERROR' }); },
  maintenanceTask: async () => { gets++; return envelope(task(1)); } });
  const state = new MaintenanceInboxState(api, 'reading', () => {}, () => 'fixed-cancel-key');
  state.start(false); await tick(); state.select(id(1)); await tick();
  await state.cancel(); assert.equal(state.view().cancel?.phase, 'unknown');
  await state.reconcileCancel(); await state.cancel();
  assert.equal(state.view().cancel?.key, 'fixed-cancel-key'); assert.deepEqual(keys, ['fixed-cancel-key']);
  assert.equal(writes, 1); assert.equal(gets, 2);
  state.dispose();
});

test('coordination reads only with capability and rejects a mismatched task or purpose', async () => {
  let reads = 0;
  const api = client({ coordinationForTask: async () => { reads++; return envelope(run(id(2))); } });
  const denied = new MaintenanceInboxState(api, 'reading', () => {});
  denied.start(false); await tick(); denied.select(id(1)); await tick(); await denied.loadCoordination();
  assert.equal(reads, 0); assert.equal(denied.view().coordinationLoaded, false); denied.dispose();
  const allowed = new MaintenanceInboxState(api, 'reading', () => {}, undefined, true);
  allowed.start(false); await tick(); allowed.select(id(1)); await tick(); await allowed.loadCoordination();
  assert.equal(reads, 1); assert.equal(allowed.view().coordination, null);
  assert.match(allowed.view().detailError, /任务或用途不一致/); allowed.dispose();
});

test('coordination summary stays read-only and links compilation to the existing candidate view', async () => {
  let reads = 0;
  const compiled = compilation();
  const api = client({ coordinationForTask: async () => { reads++; return envelope(run()); },
    compilation: async () => envelope(compiled) });
  const state = new MaintenanceInboxState(api, 'reading', () => {}, undefined, true);
  state.start(false); await tick(); state.select(id(1)); await tick();
  await state.loadCoordination(); assert.equal(reads, 1);
  assert.equal(state.view().coordination?.sourcePlanId, id(72));
  await state.loadRelated('compilation'); assert.equal(state.view().compilation?.candidate?.candidateId, id(80));
  const html = renderToStaticMarkup(createElement(MaintenanceInboxContent, { view: state.view(), state,
    canCancel: false, canReadProjection: false, canReadCoordination: true, onCandidate: () => {} }));
  assert.match(html, /协调记录 · 提案无变化/); assert.match(html, /仍需独立审阅/);
  assert.match(html, /来源规划及提及仅是模型提案，不自动消歧或发表/);
  assert.match(html, /总费用/); assert.match(html, /参与比较的页面/);
  assert.match(html, /前往候选审阅/); assert.doesNotMatch(html, /自动处理任务/);
  state.dispose();
});

test('coordination 403 clears selected task and any derived records', async () => {
  const api = client({ coordinationForTask: async () => { throw new KnowledgeClientError({
    message: 'permission revoked', code: 'FORBIDDEN', httpStatus: 403 }); } });
  const state = new MaintenanceInboxState(api, 'reading', () => {}, undefined, true);
  state.start(false); await tick(); state.select(id(1)); await tick();
  await state.loadCoordination();
  assert.equal(state.view().denied, true); assert.equal(state.view().selected, null);
  assert.equal(state.view().coordination, null); assert.equal(state.view().coordinationLoaded, false);
  assert.deepEqual(state.view().tasks, []); assert.deepEqual(state.view().findings, []);
  state.dispose();
});

test('server rendered maintenance detail distinguishes candidate, missing evidence and model probability', () => {
  const api = client(); const state = new MaintenanceInboxState(api, 'reading', () => {});
  WikiCompileResultSchema.parse(compilation(id(7), id(6)));
  RelationJudgmentSchema.parse(judgment());
  const selected: MaintenanceTask = { ...task(1, 'completed'), outcome: { state: 'completed', findingIds: [], compilationId: id(7),
    judgmentId: id(9), reason: '产生候选', cost } };
  const view = { ...state.view(), selectedId: id(1), selected, tasks: [selected], findings: [finding(2)],
    compilation: compilation(id(7), id(6)), judgment: judgment() };
  const html = renderToStaticMarkup(createElement(MaintenanceInboxContent, { view, state, canCancel: false,
    canReadProjection: true, canReadCoordination: false, onCandidate: () => {} }));
  assert.match(html, /维护收件箱/); assert.match(html, /任务完成不代表 Wiki 已正式发表/);
  assert.match(html, /前往候选审阅/); assert.match(html, /缺少足够依据（选项：insufficient_evidence）/);
  assert.match(html, /是非判断 · 已回答/); assert.match(html, /模型判断概率：0.72/);
  assert.match(html, /分值判断 · 拒答/); assert.match(html, /模型拒答/);
  assert.match(html, /不会自动成为正式关系/); assert.match(html, /<details/);
  assert.match(html, /<h3>编纂记录 · 等待独立审阅<\/h3>/);
  assert.doesNotMatch(html, /<h3>编纂记录 · waiting_for_review<\/h3>/);
  assert.match(html, /&quot;state&quot;: &quot;waiting_for_review&quot;/);
  assert.doesNotMatch(html, /<1>/); assert.doesNotMatch(html, /请求取消任务/);
  assert.equal(projectionLabel({ ready: false, complete: false, blockedRows: 1 } as never, true), '索引覆盖阻塞，检索回退');
});

test('system task reasons are friendly on cards while exact originals remain in detail', () => {
  const api = client(); const state = new MaintenanceInboxState(api, 'reading', () => {});
  const originalReason = 'source_registered event 1; original batch none';
  const selected: MaintenanceTask = { ...task(1), request: { ...task(1).request, kind: 'source_research', reason: originalReason } };
  const view = { ...state.view(), selectedId: selected.id, selected, tasks: [selected] };
  const html = renderToStaticMarkup(createElement(MaintenanceInboxContent, { view, state, canCancel: false,
    canReadProjection: false, canReadCoordination: false, onCandidate: () => {} }));
  const card = html.match(/<button[^>]*class="maintenance-item selected"[^>]*>.*?<\/button>/)?.[0];
  assert.ok(card);
  assert.match(card, /新来源已登记，等待研究/);
  assert.doesNotMatch(card, /source_registered/);
  assert.match(html, /<details[^>]*><summary>查看准确引用<\/summary><pre>[\s\S]*?&quot;originalReason&quot;: &quot;source_registered event 1; original batch none&quot;/);
  assert.equal(taskReasonLabel({ ...selected, request: { ...selected.request, reason: 'mentions_recorded event 1; original batch none' } }),
    '提及已更新，等待关联核查');
  assert.equal(taskReasonLabel({ ...selected, trigger: { ...selected.trigger, stream: 'knowledge' },
    request: { ...selected.request, kind: 'recompile', reason: 'KnowledgePublished event 1 for exact Wiki revision' } }),
    '知识版本已变化，等待核查');
  assert.equal(taskReasonLabel({ ...selected, trigger: { ...selected.trigger, stream: 'manual' } }), originalReason);
  assert.equal(taskReasonLabel({ ...selected, request: { ...selected.request, reason: '请核对新来源的发布日期' } }),
    '请核对新来源的发布日期');
  state.dispose();
});

test('seven known metadata finding templates read in Chinese with exact English retained in details', () => {
  const reasons: Array<[MaintenanceFinding['kind'], string, string]> = [
    ['review_due', 'Current Wiki reviewDueAt has elapsed.', '当前 Wiki 已到复核时间'],
    ['orphan', 'Current Wiki has no normalized knowledge edge; inspect its intended links.', '当前 Wiki 尚无页面关联记录，需核对预期链接'],
    ['broken_link', `Knowledge dependency points to a missing or unpublished exact version: ${id(20)}/${id(21)}.`,
      '关联的知识版本缺失或尚未发表，需核对'],
    ['invalid_critical_basis', `Critical frozen basis has invalid metadata: source:${id(22)}/${id(23)} (review_due).`,
      '关键依据的有效性记录存在问题，需核对'],
    ['missing_citation', 'No structured Wiki citation is recorded; this is a review prompt, not proof of an incorrect claim.',
      '当前 Wiki 尚无可核对的页面引用记录，需人工检查'],
    ['duplicate_source_group', 'A source group identifier occurs more than once in this exact revision.',
      '同一来源组在当前页面重复出现，需核对'],
    ['suspected_duplicate', 'Another current Wiki has the same exact profile and identity key; manual review is required.',
      '另一当前页面的类型与身份标识相同，需人工核对是否重复'],
  ];
  const findings = reasons.map(([kind, reason], index): MaintenanceFinding => ({
    ...finding(index + 10), taskId: null, kind, reason,
  }));
  const state = new MaintenanceInboxState(client(), 'reading', () => {});
  const html = renderToStaticMarkup(createElement(MaintenanceInboxContent, { view: { ...state.view(), findings }, state,
    canCancel: false, canReadProjection: false, canReadCoordination: false, onCandidate: () => {} }));
  for (const [kind, reason, label] of reasons) {
    const item = findings.find(row => row.kind === kind);
    assert.ok(item);
    assert.equal(findingReasonLabel(item), label);
    assert.match(html, new RegExp(`<p>${label}</p>`));
    assert.ok(html.includes(`&quot;originalReason&quot;: &quot;${reason}&quot;`));
  }
  const visible = html.replace(/<details[\s\S]*?<\/details>/g, '');
  assert.doesNotMatch(visible, /reviewDueAt|Current Wiki has no normalized|Critical frozen basis/);
  const caller = { ...finding(30), taskId: null, kind: 'semantic_relation' as const, reason: '请核对这两个品牌的关系' };
  assert.equal(findingReasonLabel(caller), caller.reason);
  assert.equal(findingReasonLabel({ ...caller, kind: 'source_unavailable', reason: '来源暂时无法访问' }), '来源暂时无法访问');
  assert.equal(findingReasonLabel({ ...caller, kind: 'review_due', reason: '人工要求本周复核' }), '人工要求本周复核');
  assert.equal(findingReasonLabel({ ...findings[0]!, taskId: id(1) }), reasons[0]![1]);
  state.dispose();
});

test('compilation status is Chinese in its heading and exact state remains in the folded record', () => {
  const state = new MaintenanceInboxState(client(), 'reading', () => {});
  for (const [raw, label] of [
    ['published', '已发表'], ['rejected', '审阅未通过'], ['needs_evidence', '需要补证'],
    ['outcome_unknown', '结果待核对'],
  ] as const) {
    const html = renderToStaticMarkup(createElement(MaintenanceInboxContent, { view: {
      ...state.view(), selectedId: id(1), selected: task(1), compilation: { ...compilation(), state: raw },
    }, state, canCancel: false, canReadProjection: false, canReadCoordination: false, onCandidate: () => {} }));
    assert.match(html, new RegExp(`<h3>编纂记录 · ${label}</h3>`));
    assert.doesNotMatch(html, new RegExp(`<h3>编纂记录 · ${raw}</h3>`));
    assert.ok(html.includes(`&quot;state&quot;: &quot;${raw}&quot;`));
  }
  state.dispose();
});

test('known unknown-outcome and cost templates read in Chinese while raw receipts remain folded', () => {
  const state = new MaintenanceInboxState(client(), 'reading', () => {});
  const original = 'Lease expired after dispatch preparation; reconcile the original response';
  const unknownCost = { modelCalls: { state: 'unknown', reason: 'Dispatch outcome was not acknowledged' },
    tokens: { state: 'unknown', reason: 'Provider usage is not acknowledged' },
    money: { state: 'unknown', reason: 'Billing outcome requires reconciliation' } } as const;
  const selected: MaintenanceTask = { ...task(1, 'outcome_unknown'), outcome: { state: 'outcome_unknown',
    findingIds: [], compilationId: null, judgmentId: null, reason: original, cost: unknownCost } };
  const render = (item: MaintenanceTask) => renderToStaticMarkup(createElement(MaintenanceInboxContent, {
    view: { ...state.view(), selectedId: item.id, selected: item, tasks: [item] }, state,
    canCancel: false, canReadProjection: false, canReadCoordination: false, onCandidate: () => {},
  }));
  const html = render(selected);
  const visible = html.replace(/<details[\s\S]*?<\/details>/g, '');
  assert.match(visible, /<h3>处理结果<\/h3><p>请求结果尚未核对，请先刷新原任务<\/p>/);
  assert.equal((visible.match(/未知（尚未收到可核对的用量\/账单回执）/g) ?? []).length, 3);
  assert.doesNotMatch(visible, /Lease expired|Dispatch outcome|Provider usage|Billing outcome/);
  const visibleCost = visible.match(/<dl class="maintenance-cost">[\s\S]*?<\/dl>/)?.[0];
  assert.ok(visibleCost);
  assert.doesNotMatch(visibleCost, /<dd>0<\/dd>/);
  assert.ok(html.includes(`&quot;originalReason&quot;: &quot;${original}&quot;`));
  assert.ok(html.includes('&quot;originalCost&quot;: {'));
  assert.ok(html.includes('&quot;reason&quot;: &quot;Dispatch outcome was not acknowledged&quot;'));
  assert.ok(html.includes('&quot;reason&quot;: &quot;Provider usage is not acknowledged&quot;'));
  assert.ok(html.includes('&quot;reason&quot;: &quot;Billing outcome requires reconciliation&quot;'));
  const custom = render({ ...selected, outcome: { ...selected.outcome!, reason: '请先联系原始来源负责人',
    cost: { ...unknownCost, money: { state: 'unknown', reason: '业务账单尚待人工确认' } } } });
  assert.match(custom, /<h3>处理结果<\/h3><p>请先联系原始来源负责人<\/p>/);
  assert.match(custom, /未知（业务账单尚待人工确认）/);
  state.dispose();
});
