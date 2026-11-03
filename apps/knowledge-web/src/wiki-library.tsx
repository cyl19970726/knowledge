import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, RefreshCw, Search } from 'lucide-react';
import type { KnowledgeClient } from '@commerce/knowledge-client';
import type { KnowledgeDocument, KnowledgeRef } from '@commerce/knowledge-contracts';
import { CitationList } from './source-view';
import { WikiLibraryState, type WikiLibraryItem, type WikiLibraryView } from './wiki-library-state';

export function wikiStatus(item: WikiLibraryItem): { label: string; tone: 'ready' | 'review' | 'invalid' } {
  const status = item.status;
  const flagged = (label: string, tone: 'review' | 'invalid') => ({ label: [label,
    !status.contentSupported && label !== '正文格式暂不支持' ? '正文格式暂不支持' : '',
    status.purpose.admitted ? '' : '用途未获准采用'].filter(Boolean).join(' · '), tone });
  if (!status.current) return flagged('已非当前版本', 'review');
  if (!status.published) return flagged('未发表', 'review');
  const due = status.validity.issues.includes('review_due') || !!status.validity.reviewDueAt &&
    Date.parse(status.validity.reviewDueAt) <= Date.parse(status.validity.checkedAt);
  if (!status.validity.valid && status.validity.issues.some(issue => issue !== 'review_due'))
    return flagged(due ? '依据失效 · 待复核' : '依据失效', 'invalid');
  if (due) return flagged('待复核', 'review');
  if (!status.validity.valid) return flagged('有效性待核对', 'invalid');
  if (!status.contentSupported) return flagged('正文格式暂不支持', 'review');
  if (!status.purpose.admitted) return { label: '用途未获准采用', tone: 'review' };
  return { label: '当前可用', tone: 'ready' };
}
/** Labels for the five built-in profiles registered in knowledge/src/wiki-page.ts. */
export function wikiProfileName(id: string): string {
  const names: Record<string, string> = { entity: '实体', concept: '概念', question: '问题', method: '方法', synthesis: '综合' };
  return Object.hasOwn(names, id) ? names[id] : id;
}
const exactKey = (ref: KnowledgeRef) => `${ref.projectId}/${ref.spaceId}/${ref.domain}/${ref.objectId}@${ref.versionId}/${ref.contentDigest}`;
const issueLabel = (issue: string) => ({ review_due: '已到复核期限', superseded: '关键依据已有新版本',
  withdrawn: '关键依据已撤回', missing_or_unpublished: '关键依据缺失或尚未发表' } as Record<string, string>)[issue] ?? issue;

type Props = { client: KnowledgeClient; purpose: string; permitted: boolean; recoveryScope: string | null;
  visible: boolean; graphExpanded: boolean; onRead: (ref: KnowledgeRef) => void;
  onSource: (ref: KnowledgeRef, locator: string | null) => void;
  onLocate: (ref: KnowledgeRef, signal: AbortSignal) => Promise<boolean>;
};
export function WikiLibrary({ client, purpose, permitted, recoveryScope, visible, graphExpanded, onRead, onSource, onLocate }: Props) {
  const [, update] = useState(0);
  const state = useMemo(() => new WikiLibraryState(client, purpose, permitted, () => update(value => value + 1)),
    [client, purpose, permitted, recoveryScope]);
  const panel = useRef<HTMLElement>(null);
  const locate = useRef(onLocate);
  useLayoutEffect(() => { locate.current = onLocate; }, [onLocate]);
  const [location, setLocation] = useState<{ document: KnowledgeDocument; message: string } | null>(null);
  useLayoutEffect(() => { state.activate(); return () => state.dispose(); }, [state]);
  useLayoutEffect(() => { if (visible && permitted) void state.ensureLoaded(); }, [state, visible, permitted]);
  const view = state.view(), selectedKey = view.selectedRef ? exactKey(view.selectedRef) : '';
  useLayoutEffect(() => {
    if (!visible || graphExpanded) return;
    const current = state.view();
    if (panel.current) panel.current.scrollTop = current.selectedRef ? current.documentPosition : current.listPosition;
    if (window.matchMedia('(max-width:980px)').matches)
      window.scrollTo(0, current.selectedRef ? current.documentWindowPosition : current.listWindowPosition);
  }, [state, visible, graphExpanded, selectedKey, view.query, view.loaded]);
  useEffect(() => {
    if (!visible || graphExpanded) return;
    const remember = () => state.rememberWindowPosition(window.scrollY);
    window.addEventListener('scroll', remember, { passive: true });
    return () => window.removeEventListener('scroll', remember);
  }, [state, visible, graphExpanded]);
  useEffect(() => {
    if (!visible || !permitted || !view.document) return;
    const controller = new AbortController(), document = view.document;
    void locate.current(document.ref, controller.signal).then(found => {
      if (!controller.signal.aborted) setLocation({ document, message: found ? '右侧星图已定位这份准确版本。' : '当前星图无法显示这份准确版本；正文仍以准确读取为准。' });
    }).catch(() => { if (!controller.signal.aborted) setLocation({ document, message: '星图暂时无法定位；没有按同名页或其他版本替代。' }); });
    return () => controller.abort();
  }, [view.document, visible, permitted]);
  return <section id="workbench-wiki" ref={panel} className="wiki-library" hidden={!visible} aria-label="Wiki页库"
    onScroll={event => { if (visible && !graphExpanded) state.rememberPosition(event.currentTarget.scrollTop); }}>
    <WikiLibraryContent view={view} permitted={permitted} onDraft={value => state.setDraft(value)}
      onSearch={event => { event.preventDefault(); void state.search(); }} onReload={() => void state.search(view.query)}
      onMore={() => void state.loadMore()} onOpen={ref => void state.open(ref)} onBack={() => state.backToList()}
      onRead={onRead} onSource={onSource} location={location?.document === view.document ? location.message : ''} />
  </section>;
}

type ContentProps = { view: WikiLibraryView; permitted: boolean; onDraft: (value: string) => void;
  onSearch: (event: FormEvent) => void; onReload: () => void; onMore: () => void; onOpen: (ref: KnowledgeRef) => void;
  onBack: () => void; onRead: (ref: KnowledgeRef) => void; onSource: Props['onSource']; location: string };
export function WikiLibraryContent({ view, permitted, onDraft, onSearch, onReload, onMore, onOpen, onBack, onRead, onSource, location }: ContentProps) {
  if (!permitted) return <><div className="eyebrow">Wiki页库</div><h2>当前服务未开放 Wiki 页目录</h2>
    <p className="minor-note">此入口需要服务提供 Wiki 目录能力。现有星图只覆盖已加载范围，不能代替全库目录。</p></>;
  if (view.denied) return <p className="inline-error" role="alert">{view.error}</p>;
  const document = view.document;
  const openReference = (ref: KnowledgeRef, locator: string | null = null) => ref.domain === 'knowledge' ? onRead(ref) : onSource(ref, locator);
  return <>
    {!view.selectedRef ? <>
      <div className="wiki-library-heading"><div><span className="eyebrow">当前空间 · 当前 Wiki 版本</span><h2>浏览 Wiki 页</h2></div><BookOpen size={23} aria-hidden="true" /></div>
      <p className="minor-note">逐页浏览当前 Wiki，包括待复核与依据失效的页面。目录浏览不会调用模型或产生知识。</p>
      <form className="wiki-library-search" onSubmit={onSearch}><label htmlFor="wiki-library-query">搜索 Wiki 页</label>
        <div><Search size={17} aria-hidden="true" /><input id="wiki-library-query" value={view.draft} maxLength={2000} onChange={event => onDraft(event.target.value)} placeholder="搜索标题或内容…" />
          <button className="secondary-button" type="submit">搜索</button></div></form>
      <div className="wiki-library-summary"><p aria-live="polite">已加载 {view.items.length} 页{view.query ? ` · 搜索「${view.query}」` : ''}</p>
        <button className="text-button" type="button" onClick={onReload} disabled={view.loading}><RefreshCw size={14} />重新加载</button></div>
      {view.error && <p className="inline-error" role="alert">{view.error}</p>}
      <ul className="wiki-library-list">{view.items.map(item => { const status = wikiStatus(item); return <li key={exactKey(item.ref)}>
        <button type="button" onClick={() => onOpen(item.ref)} disabled={!item.ref.contentDigest}>
          <strong>{item.title}</strong><span className="wiki-library-row-meta"><span>类型 · {wikiProfileName(item.profile.id)}</span><span className={`wiki-status wiki-status-${status.tone}`}>{status.label}</span></span>
          {!item.ref.contentDigest && <small>缺少准确版本摘要，暂不能打开正文。</small>}
        </button></li>; })}</ul>
      {view.loading && <p className="minor-note" role="status">正在读取这一页 Wiki 目录…</p>}
      {view.loaded && !view.items.length && !view.error && <p className="wiki-library-empty">{view.query ? '当前空间没有匹配这次搜索的 Wiki 页。' : '当前空间尚无可返回的当前 Wiki 页。'}</p>}
      {view.hasMore && <button className="secondary-button wiki-library-more" type="button" disabled={view.loading} onClick={onMore}>加载更多 Wiki 页 <ArrowRight size={16} /></button>}
      {view.loaded && !view.loading && !view.hasMore && view.coverage && <p className="minor-note">本次目录分页已到末页；上方只统计实际加载的页面。</p>}
      {view.loaded && !view.coverage && <p className="minor-note">服务未提供分页范围说明，无法确认是否还有后续页。</p>}
      {view.coverage && <details className="wiki-library-record"><summary>本次目录范围</summary><p>{view.coverage.scopeDescription}</p>
        <p>这是目录读取记录，不是问答的实际依据。</p>{view.coverage.omittedReasons.map((reason, index) => <p key={index}>{reason}</p>)}</details>}
    </> : <>
      <button className="back-link" type="button" onClick={onBack}><ArrowLeft size={16} />返回 Wiki 列表</button>
      {view.documentLoading && <p role="status" className="minor-note">正在读取所选准确版本的正文…</p>}
      {view.documentError && <p className="inline-error" role="alert">{view.documentError}</p>}
      {document && <article className="wiki-library-document">
        <div className="eyebrow">类型 · {wikiProfileName(document.profile.id)}</div><h2>{document.title}</h2>
        <p className={`wiki-status wiki-status-${wikiStatus(document).tone}`}>{wikiStatus(document).label}</p>
        {!document.status.purpose.admitted && <p className="minor-note">本页原文可供核对，当前用途未获准采用；阅读不表示它已成为问答支持依据。</p>}
        {location && <p className="minor-note" role="status">{location}</p>}
        <button type="button" className="text-button" onClick={() => onRead(document.ref)}>打开完整阅读与版本记录 <ArrowRight size={15} /></button>
        {!document.status.contentSupported && <p className="minor-note">此版本格式暂不支持结构化解释，以下按原文纯文本展示。</p>}
        <div className="wiki-library-prose">{document.body.split(/\n\n+/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
        <WikiFacts title="成立条件" items={document.conditions} /><WikiFacts title="反例与边界" items={document.counterexamples} />
        <WikiFacts title="尚不确定" items={document.unknowns} /><WikiFacts title="接下来可问" items={document.nextQuestions} />
        <CitationList citations={document.citations} onOpen={openReference} />
        {document.inheritedBasis.length > 0 && <section className="wiki-library-basis"><h3>继承依据</h3><p className="minor-note">页面引用了这些依据；未在此处读取原文。</p>
          {document.inheritedBasis.map((ref, index) => <button type="button" className="text-button" key={exactKey(ref)} onClick={() => openReference(ref)}>打开准确依据 {index + 1} <ArrowRight size={14} /></button>)}</section>}
        <details className="wiki-library-record"><summary>准确版本与读取状态</summary><p>项目 {document.ref.projectId} · 空间 {document.ref.spaceId}</p>
          <p>页面类型 {document.profile.id}@{document.profile.version} · 类型摘要 {document.profile.digest}</p>
          <p>对象 {document.ref.objectId} · 版本 {document.ref.versionId} · 内容摘要 {document.ref.contentDigest}</p>
          <p>用途 {document.status.purpose.requested} · 检查时间 {document.status.validity.checkedAt} · 复核期限 {document.status.validity.reviewDueAt ?? '未提供'}</p>
          <p>审阅记录 {document.status.reviewDecision ?? '未提供'} · 正文回执 {view.documentReceiptId ?? '未提供'}</p>
          {document.status.validity.issues.map((issue, index) => <p key={index}>{issueLabel(issue)}（{issue}）</p>)}
          {document.status.purpose.reasons.map((reason, index) => <p key={index}>{reason}</p>)}
          <p>此处正文来自准确版本读取，目录元数据没有加入问答读集。</p>
        </details>
      </article>}
    </>}
  </>;
}
function WikiFacts({ title, items }: { title: string; items: string[] }) {
  return <section className="wiki-library-facts"><h3>{title}</h3>{items.length ? <ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p className="minor-note">此版本未列出。</p>}</section>;
}
