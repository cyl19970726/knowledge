import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KnowledgeClientError } from '@commerce/knowledge-client';
import { CONTRACT_VERSION, type CatalogResult, type Coverage, type Envelope, type KnowledgeDocument } from '@commerce/knowledge-contracts';
import { App } from '../src/App.tsx';
import { WikiLibraryState, type WikiLibraryClient, type WikiLibraryView } from '../src/wiki-library-state.ts';
import { WikiLibraryContent, wikiProfileName, wikiStatus } from '../src/wiki-library.tsx';

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const scope = { projectId: 'project', spaceId: 'space' };
const purpose = 'reading';
const document = (number: number): KnowledgeDocument => ({
  ref: { ...scope, domain: 'knowledge', objectId: id(number), versionId: id(number + 100), contentDigest: 'a'.repeat(64) },
  title: `认识 ${number}`, body: `目录返回的正文 ${number}`, contentSchemaVersion: '1', profile: { id: 'concept', version: '1', digest: 'b'.repeat(64) },
  status: { current: true, currentRef: null, published: true, reviewDecision: 'approved_for_purpose', policyVersion: 'test',
    validity: { valid: true, issues: [], checkedAt: '2026-11-02T12:00:00Z', reviewDueAt: null },
    purpose: { requested: purpose, admitted: true, reasons: [] }, contentSupported: true, historicalAt: null },
  conditions: ['条件成立'], counterexamples: ['存在反例'], unknowns: ['仍需核对'], nextQuestions: [], sourceGroups: [],
  inheritedBasis: [], actualReadCoverage: [], citations: [],
});
const envelope = <T,>(data: T, coverage?: Coverage): Envelope<T> => ({ contractVersion: CONTRACT_VERSION, requestId: 'library-test',
  effectiveScope: scope, observedAt: '2026-11-02T12:00:00Z', data, warnings: [], ...(coverage ? { coverage } : {}) });
const page = (items: KnowledgeDocument[], cursor: string | null = null): Envelope<CatalogResult> => envelope({ items, readReceiptId: id(999), emptyState: items.length ? null : 'no_matches_in_scope' },
  { scopeDescription: '合成测试空间', returned: items.length, loaded: items.length, hasMore: cursor !== null, nextCursor: cursor,
    completeness: 'bounded', omittedReasons: [], snapshot: { publicationEpoch: 1, consistency: 'single_scope_snapshot' } });
const client = (overrides: Partial<WikiLibraryClient> = {}): WikiLibraryClient => ({ scope,
  catalog: async () => page([document(1)]), document: async ref => envelope({ ...document(1), ref, body: '准确 GET 的正文' }), ...overrides });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test('catalog sends the Wiki filter, trimmed query and bounded cursor; exact reading and list return preserve loaded metadata and position', async () => {
  const requests: unknown[] = [], exactRequests: unknown[] = [];
  const state = new WikiLibraryState(client({ catalog: async data => { requests.push(data);
    return data.cursor ? page([document(1), document(2)]) : page([document(1)], 'next'); },
  document: async (ref, readPurpose) => { exactRequests.push({ ref, purpose: readPurpose }); return envelope({ ...document(1), body: '准确 GET 的正文' }); } }), purpose, true, () => {});
  await state.search('  条件冲突  '); await state.loadMore();
  assert.deepEqual(requests, [
    { purpose, limit: 24, kinds: ['wiki_page'], query: '条件冲突', cursor: undefined },
    { purpose, limit: 24, kinds: ['wiki_page'], query: '条件冲突', cursor: 'next' },
  ]);
  assert.equal(state.view().items.length, 2); assert.equal('body' in state.view().items[0], false);
  assert.equal(state.view().document, null);
  state.rememberPosition(340); state.rememberWindowPosition(640); await state.open(document(1).ref);
  assert.equal(state.view().document?.body, '准确 GET 的正文');
  assert.deepEqual(exactRequests, [{ ref: document(1).ref, purpose }]);
  state.backToList(); assert.equal(state.view().query, '条件冲突'); assert.equal(state.view().items.length, 2);
  assert.equal(state.view().listPosition, 340); assert.equal(state.view().hasMore, false);
  assert.equal(state.view().listWindowPosition, 640); assert.equal(state.view().documentWindowPosition, 0);
  await state.loadMore(); assert.equal(requests.length, 2);
});

test('new search aborts old pagination and rejects a late result without mixing the searches', async () => {
  const late = deferred<Envelope<CatalogResult>>(); let aborted = false;
  const state = new WikiLibraryState(client({ catalog: async (request, options) => {
    if (request.query === '旧搜索') { options?.signal?.addEventListener('abort', () => { aborted = true; }); return late.promise; }
    return page([document(2)]);
  } }), purpose, true, () => {});
  const old = state.search('旧搜索'); await state.search('新搜索'); late.resolve(page([document(1)], 'old-cursor')); await old;
  assert.equal(aborted, true); assert.equal(state.view().query, '新搜索');
  assert.deepEqual(state.view().items.map(item => item.title), ['认识 2']); assert.equal(state.view().nextCursor, null);
});

test('scope or identity disposal clears everything and capability absence never requests a catalog', async () => {
  const late = deferred<Envelope<CatalogResult>>(); let aborted = false, forbiddenCalls = 0;
  const old = new WikiLibraryState(client({ catalog: async (_request, options) => {
    options?.signal?.addEventListener('abort', () => { aborted = true; }); return late.promise;
  } }), purpose, true, () => {});
  const pending = old.ensureLoaded(); old.dispose();
  const denied = new WikiLibraryState(client({ catalog: async () => { forbiddenCalls++; return page([document(3)]); } }), 'other', false, () => {});
  await denied.ensureLoaded(); await denied.search('anything');
  late.resolve(page([document(1)])); await pending;
  assert.equal(aborted, true); assert.equal(forbiddenCalls, 0); assert.deepEqual(old.view().items, []);
  assert.equal(old.view().document, null); assert.deepEqual(denied.view().items, []);
});

test('foreign or non-current catalog rows cannot be presented as this scope current Wiki library', async () => {
  for (const invalid of [
    { ...document(1), ref: { ...document(1).ref, spaceId: 'other' } },
    { ...document(1), status: { ...document(1).status, current: false } },
    { ...document(1), status: { ...document(1).status, purpose: { requested: 'other', admitted: true, reasons: [] } } },
  ]) {
    const state = new WikiLibraryState(client({ catalog: async () => page([invalid]) }), purpose, true, () => {});
    await state.ensureLoaded(); assert.deepEqual(state.view().items, []); assert.match(state.view().error, /不一致/);
  }
  const envelopeMismatch = new WikiLibraryState(client({ catalog: async () => ({ ...page([document(1)]), effectiveScope: { ...scope, projectId: 'other' } }) }), purpose, true, () => {});
  await envelopeMismatch.ensureLoaded(); assert.deepEqual(envelopeMismatch.view().items, []); assert.match(envelopeMismatch.view().error, /不一致/);
});

test('exact document mismatches in scope, object, version, digest or purpose are never displayed', async () => {
  for (const changed of [{ spaceId: 'other' }, { projectId: 'other' }, { objectId: id(2) }, { versionId: id(200) }, { contentDigest: 'c'.repeat(64) }]) {
    const state = new WikiLibraryState(client({ document: async () => envelope({ ...document(1), ref: { ...document(1).ref, ...changed }, body: '错配私有正文' }) }), purpose, true, () => {});
    await state.ensureLoaded(); await state.open(document(1).ref);
    assert.equal(state.view().document, null); assert.deepEqual(state.view().items, []); assert.match(state.view().error, /准确版本/);
  }
  const wrongPurpose = new WikiLibraryState(client({ document: async () => envelope({ ...document(1),
    status: { ...document(1).status, purpose: { requested: 'other', admitted: true, reasons: [] } } }) }), purpose, true, () => {});
  await wrongPurpose.ensureLoaded(); await wrongPurpose.open(document(1).ref); assert.equal(wrongPurpose.view().document, null);
});

test('late exact reads cannot replace a newer selection or reappear after returning to the list', async () => {
  const late = deferred<Envelope<KnowledgeDocument>>(); let aborted = false;
  const state = new WikiLibraryState(client({ catalog: async () => page([document(1), document(2)]), document: async (ref, _purpose, options) => {
    if (ref.objectId === id(1)) { options?.signal?.addEventListener('abort', () => { aborted = true; }); return late.promise; }
    return envelope(document(2));
  } }), purpose, true, () => {});
  await state.ensureLoaded(); const first = state.open(document(1).ref); await state.open(document(2).ref);
  late.resolve(envelope(document(1))); await first;
  assert.equal(aborted, true); assert.equal(state.view().document?.ref.objectId, id(2));
  state.backToList(); assert.equal(state.view().document, null); assert.equal(state.view().selectedRef, null);
});

test('identity change during an exact read aborts it and clears metadata, body and positions', async () => {
  const late = deferred<Envelope<KnowledgeDocument>>(); let aborted = false;
  const state = new WikiLibraryState(client({ document: async (_ref, _purpose, options) => {
    options?.signal?.addEventListener('abort', () => { aborted = true; }); return late.promise;
  } }), purpose, true, () => {});
  await state.ensureLoaded(); state.rememberPosition(500); const pending = state.open(document(1).ref); state.dispose();
  late.resolve(envelope(document(1))); await pending;
  assert.equal(aborted, true); assert.equal(state.view().document, null); assert.deepEqual(state.view().items, []);
  assert.equal(state.view().listPosition, 0);
});

test('real 401/403 removes catalog and exact content; stale cursor clears the page set and requires explicit reload', async () => {
  for (const httpStatus of [401, 403]) {
    const denied = new WikiLibraryState(client({ document: async () => { throw new KnowledgeClientError({ code: 'FORBIDDEN', message: 'denied', httpStatus, commitStatus: 'not_committed' }); } }), purpose, true, () => {});
    await denied.ensureLoaded(); await denied.open(document(1).ref);
    assert.equal(denied.view().denied, true); assert.equal(denied.view().document, null); assert.deepEqual(denied.view().items, []);
  }
  let calls = 0;
  const stale = new WikiLibraryState(client({ catalog: async request => { calls++; if (request.cursor)
    throw new KnowledgeClientError({ code: 'CURSOR_EXPIRED', message: 'epoch changed', httpStatus: 409, commitStatus: 'not_committed' });
    return page([document(1)], 'next'); } }), purpose, true, () => {});
  await stale.ensureLoaded(); await stale.loadMore();
  assert.deepEqual(stale.view().items, []); assert.equal(stale.view().hasMore, false); assert.match(stale.view().error, /目录已变化/);
  assert.equal(calls, 2); await stale.search(); assert.equal(calls, 3);
});

test('empty and failed searches stay distinct and a repeated cursor cannot loop', async () => {
  const empty = new WikiLibraryState(client({ catalog: async () => page([]) }), purpose, true, () => {});
  await empty.ensureLoaded(); assert.equal(empty.view().loaded, true); assert.equal(empty.view().error, '');
  const failed = new WikiLibraryState(client({ catalog: async () => { throw new Error('目录暂不可读'); } }), purpose, true, () => {});
  await failed.search('new'); assert.equal(failed.view().loaded, false); assert.match(failed.view().error, /暂不可读/);
  const repeated = new WikiLibraryState(client({ catalog: async () => page([document(1)], 'same') }), purpose, true, () => {});
  await repeated.ensureLoaded(); await repeated.loadMore(); assert.equal(repeated.view().hasMore, false); assert.match(repeated.view().error, /分页位置/);
});

function content(view: WikiLibraryView, permitted = true) {
  return renderToStaticMarkup(createElement(WikiLibraryContent, { view, permitted, onDraft: () => {}, onSearch: () => {}, onReload: () => {},
    onMore: () => {}, onOpen: () => {}, onBack: () => {}, onRead: () => {}, onSource: () => {}, location: '' }));
}
test('library entry exists independently and old servers show capability limits instead of graph rows', () => {
  const app = renderToStaticMarkup(createElement(App)); assert.match(app, /aria-label="Wiki页库"/); assert.match(app, /Wiki页/);
  const state = new WikiLibraryState(client(), purpose, false, () => {});
  const markup = content(state.view(), false); assert.match(markup, /未开放 Wiki 页目录/); assert.match(markup, /不能代替全库目录/);
  assert.doesNotMatch(markup, /wiki-library-list|目录返回的正文/);
});
test('library renders real loaded counts and validity, and only the exact GET body enters the reading surface', async () => {
  const invalid = document(2); invalid.status.validity = { ...invalid.status.validity, valid: false, issues: ['superseded'] };
  const due = document(3); due.status.validity = { ...due.status.validity, valid: false, issues: ['review_due'] };
  assert.equal(wikiStatus(invalid).label, '依据失效'); assert.equal(wikiStatus(due).label, '待复核');
  const state = new WikiLibraryState(client({ catalog: async () => page([document(1), invalid, due], 'next') }), purpose, true, () => {});
  await state.ensureLoaded(); const list = content(state.view());
  assert.match(list, /已加载 3 页/); assert.match(list, /加载更多 Wiki 页/); assert.match(list, /依据失效/); assert.match(list, /待复核/);
  assert.match(list, /类型 · 概念/); assert.doesNotMatch(list, /类型 · concept/);
  assert.doesNotMatch(list, /目录返回的正文|共计|总计/);
  await state.open(document(1).ref); const reading = content(state.view());
  for (const text of ['准确 GET 的正文', '成立条件', '反例与边界', '直接引用与来源主张', '准确版本与读取状态', '返回 Wiki 列表']) assert.ok(reading.includes(text), text);
  assert.doesNotMatch(reading, /目录返回的正文/);
});

test('known profile labels stay concise and unknown registered profile IDs remain identifiable', () => {
  assert.deepEqual(['entity', 'concept', 'question', 'method', 'synthesis'].map(wikiProfileName), ['实体', '概念', '问题', '方法', '综合']);
  assert.equal(wikiProfileName('specialized_profile'), 'specialized_profile');
  assert.equal(wikiProfileName('constructor'), 'constructor');
  const row = document(1); row.status.validity = { ...row.status.validity, valid: false, issues: ['review_due'] };
  row.status.contentSupported = false; row.status.purpose.admitted = false;
  assert.equal(wikiStatus(row).label, '待复核 · 正文格式暂不支持 · 用途未获准采用');
});

test('adoption status never substitutes for read authorization: invalid and review-due Wiki remain readable without clearing the catalog', async () => {
  for (const [issue, label] of [['superseded', '依据失效'], ['review_due', '待复核']] as const) {
    const readable = document(1);
    readable.body = '可核对的失效原文';
    readable.status.validity = { ...readable.status.validity, valid: false, issues: [issue] };
    readable.status.purpose = { requested: purpose, admitted: false, reasons: ['not_admitted_for_use'] };
    const state = new WikiLibraryState(client({ catalog: async () => page([readable, document(2)]), document: async () => envelope(readable) }), purpose, true, () => {});
    await state.ensureLoaded(); await state.open(readable.ref);
    assert.equal(state.view().denied, false); assert.equal(state.view().items.length, 2);
    assert.equal(state.view().document?.body, readable.body);
    const markup = content(state.view()); assert.match(markup, new RegExp(label)); assert.match(markup, /用途未获准采用/);
    assert.match(markup, /可核对的失效原文/); assert.doesNotMatch(markup, /目录与正文已清空/);
  }
});

test('a successfully read historical or unsupported document retains its escaped raw text and clear limits', async () => {
  const readable = document(1);
  readable.body = '历史原文 <script>not executable</script>';
  readable.status = { ...readable.status, current: false, contentSupported: false,
    purpose: { requested: purpose, admitted: false, reasons: ['unsupported_binding'] } };
  const state = new WikiLibraryState(client({ document: async () => envelope(readable) }), purpose, true, () => {});
  await state.ensureLoaded(); await state.open(readable.ref);
  assert.equal(state.view().document?.body, readable.body); assert.equal(state.view().items.length, 1);
  const markup = content(state.view());
  assert.match(markup, /已非当前版本/); assert.match(markup, /用途未获准采用/); assert.match(markup, /原文纯文本/);
  assert.match(markup, /历史原文 &lt;script&gt;not executable&lt;\/script&gt;/); assert.doesNotMatch(markup, /<script>/);
});
