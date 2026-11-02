import { useEffect, useRef, useState } from 'react';
import type { CandidateView, KnowledgeRef, ResearchResult } from '@commerce/knowledge-contracts';
import type { KnowledgeClient } from '@commerce/knowledge-client';
import { refKey } from '../graph/view-model';
import { publishedPair, versionDate, versionDateParts } from './versions';

type History = Awaited<ReturnType<KnowledgeClient['history']>>['data'];
type Comparison = Awaited<ReturnType<KnowledgeClient['compare']>>['data'];

const fieldNames: Record<string, string> = { title: '标题', body: '认识正文', conditions: '成立条件', counterexamples: '反例与边界', unknowns: '尚不确定', nextQuestions: '接下来可问', sourceGroups: '来源组', citations: '引用' };
export function recordedReason(value: string | null | undefined): string { return value && value !== 'not_recorded' ? value : '原因未记录'; }
export function fieldText(value: unknown): string {
  if (value === null || value === undefined) return '未记录';
  if (typeof value === 'string') return value || '空文本';
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value.length ? value.join('\n• ') : '未列出';
  if (Array.isArray(value) && value.every(item => item && typeof item === 'object' && typeof item.id === 'string' && typeof item.status === 'string')) return value.length ? value.map(item => `${item.id} · ${item.status === 'known' ? '状态已知' : item.status} · ${item.authority ?? '权威未记录'}`).join('\n') : '未列出';
  return JSON.stringify(value, null, 2);
}

export function EvolutionPanel({ client, purpose, selected, title, candidate, research, onRead, onBack }: {
  client: KnowledgeClient; purpose: string; selected: KnowledgeRef | null; title: string | null;
  candidate: CandidateView | null; research: ResearchResult | null;
  onRead: (ref: KnowledgeRef) => void; onBack: () => void;
}) {
  const [history, setHistory] = useState<History | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [moreLoading, setMoreLoading] = useState(false);
  const [before, setBefore] = useState('');
  const [after, setAfter] = useState('');
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [compareError, setCompareError] = useState('');
  const [compareLoading, setCompareLoading] = useState(false);
  const historyRequest = useRef(0);
  const compareRequest = useRef(0);

  useEffect(() => {
    const sequence = ++historyRequest.current;
    compareRequest.current += 1;
    setHistory(null); setHistoryError(''); setComparison(null); setCompareError(''); setBefore(''); setAfter(''); setNextCursor(null); setMoreLoading(false);
    if (!selected) { setHistoryLoading(false); return; }
    setHistoryLoading(true);
    void client.history({ objectId: selected.objectId, purpose, limit: 50 }).then(response => {
      if (sequence !== historyRequest.current) return;
      const versions = response.data.versions;
      setHistory(response.data);
      setNextCursor(response.coverage?.nextCursor ?? null);
      setAfter(refKey(versions.find(item => refKey(item.ref) === refKey(selected))?.ref ?? versions[0]?.ref ?? selected));
      setBefore(refKey(versions.find(item => refKey(item.ref) !== refKey(selected))?.ref ?? versions[1]?.ref ?? selected));
    }).catch(error => { if (sequence === historyRequest.current) setHistoryError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (sequence === historyRequest.current) setHistoryLoading(false); });
    return () => { historyRequest.current += 1; compareRequest.current += 1; };
  }, [client, purpose, selected?.projectId, selected?.spaceId, selected?.objectId, selected?.versionId]);

  const versions = history?.versions ?? [];
  async function loadMore() {
    if (!selected || !nextCursor) return;
    const sequence = ++historyRequest.current;
    setMoreLoading(true); setHistoryError('');
    try {
      const response = await client.history({ objectId: selected.objectId, purpose, limit: 50, cursor: nextCursor });
      if (sequence !== historyRequest.current) return;
      setHistory(current => ({ versions: [...(current?.versions ?? []), ...response.data.versions] }));
      setNextCursor(response.coverage?.nextCursor ?? null);
    } catch (error) { if (sequence === historyRequest.current) setHistoryError(error instanceof Error ? error.message : String(error)); }
    finally { if (sequence === historyRequest.current) setMoreLoading(false); }
  }
  async function compare() {
    const pair = publishedPair(versions, before, after);
    if (!pair) return;
    const sequence = ++compareRequest.current;
    setCompareLoading(true); setCompareError(''); setComparison(null);
    try {
      const response = await client.compare({ ...pair, purpose });
      if (sequence === compareRequest.current) setComparison(response.data);
    } catch (error) { if (sequence === compareRequest.current) setCompareError(error instanceof Error ? error.message : String(error)); }
    finally { if (sequence === compareRequest.current) setCompareLoading(false); }
  }
  function changePair(which: 'before' | 'after', key: string) {
    compareRequest.current += 1; setCompareLoading(false); setComparison(null); setCompareError('');
    if (which === 'before') setBefore(key); else setAfter(key);
  }

  return <div className="evolution-view">
    <div className="evolution-intro"><div><span className="eyebrow">认知演化 / 单对象</span><h2>{title ?? '选择一条认识查看演化'}</h2></div><p>每层是一条已发表的准确版本，位置表示历史返回顺序；时间标注是该版的发表时间。层次不表示可信度或整网快照。</p></div>
    {!selected && <div className="state-note">从星群或问题视角选一条认识，再查看它的版本。</div>}
    {historyLoading && <div className="state-note" role="status">正在读取这条认识的准确历史…</div>}
    {historyError && <div className="inline-error" role="alert">历史读取失败：{historyError}</div>}
    {selected && !historyLoading && !historyError && versions.length === 0 && <div className="state-note">当前用途下没有可读的已发表历史版本。</div>}
    {versions.length > 0 && <section className="evolution-strata" aria-label="单对象已发表版本剖面"><div className="evolution-strata-heading"><div><span className="eyebrow">PUBLISHED HISTORY</span><h3>发表版本剖面</h3></div><span>{versions.length} 层已读取{nextCursor ? ' · 后续历史待读取' : ''}</span></div><div className="evolution-timeline" aria-label="准确版本线">{versions.map((version, index) => {
      const key = refKey(version.ref);
      const active = key === refKey(selected!);
      const published = versionDateParts(version.publishedAt);
      return <article className={`evolution-version${active ? ' active' : ''}${before === key ? ' is-before' : ''}${after === key ? ' is-after' : ''}`} key={key}><div className="evolution-layer-axis"><span className="version-marker">{String(index + 1).padStart(2, '0')}</span><time className="evolution-layer-time" dateTime={version.publishedAt ?? undefined}><strong>{published.date}</strong><small>{published.time ? `${published.time} · ${published.zone}` : '时间状态见正文'}</small></time></div><div className="evolution-plane"><div className="evolution-plane-grid" aria-hidden="true" /><div className="evolution-version-card"><div className="evolution-version-top"><span className="evolution-status">已发表</span><span className="evolution-version-id">版本 {version.ref.versionId}</span>{active && <span className="evolution-selected">当前选择</span>}</div><h3>{active ? title ?? '当前选择的准确版本' : `历史版本 ${index + 1}`}</h3><p className={`evolution-reason${active ? ' primary-change' : ''}`}>{recordedReason(version.reason)}</p><div className="evolution-version-actions"><button className="text-button" type="button" onClick={() => onRead(version.ref)}>阅读正文与来源 →</button>{versions.length > 1 && <><button type="button" className={before === key ? 'evolution-pick selected' : 'evolution-pick'} onClick={() => changePair('before', key)} aria-pressed={before === key}>设为基准</button><button type="button" className={after === key ? 'evolution-pick selected' : 'evolution-pick'} onClick={() => changePair('after', key)} aria-pressed={after === key}>设为对照</button></>}</div><details><summary>准确版本引用</summary><code>{key}</code></details></div></div></article>;
    })}</div><p className="evolution-hint">剖面仅含这条认识的可读历史；层与层之间的视觉连接仅表示同一对象的版本顺序，不证明变更原因或研究支持。</p></section>}
    {nextCursor && <button className="secondary-button evolution-more" onClick={() => void loadMore()} disabled={moreLoading}>{moreLoading ? '继续读取中…' : '读取更多历史版本'}</button>}
    {versions.length === 1 && <p className="evolution-hint">目前只有一版可读；还没有两个已发表版本可比较。</p>}
    {versions.length > 1 && <section className="evolution-compare"><h3>比较两版已发表认识</h3><div className="evolution-pickers"><label>基准版<select value={before} onChange={event => changePair('before', event.target.value)}>{versions.map((item, index) => <option key={refKey(item.ref)} value={refKey(item.ref)}>版本 {index + 1} · {versionDate(item.publishedAt)}</option>)}</select></label><label>对照版<select value={after} onChange={event => changePair('after', event.target.value)}>{versions.map((item, index) => <option key={refKey(item.ref)} value={refKey(item.ref)}>版本 {index + 1} · {versionDate(item.publishedAt)}</option>)}</select></label><button className="secondary-button" onClick={() => void compare()} disabled={!publishedPair(versions, before, after) || compareLoading}>{compareLoading ? '比较中…' : '读取准确差异'}</button></div>{before === after && <p className="minor-note">请选择两个不同的已发表版本。</p>}{compareError && <div className="inline-error" role="alert">比较失败：{compareError}</div>}{comparison && <div className="evolution-differences"><div className="evolution-comparison-head"><div><span className="eyebrow">基准版</span><h4>{comparison.before.title}</h4><button className="text-button" onClick={() => onRead(comparison.before.ref)}>打开正文</button></div><div><span className="eyebrow">对照版</span><h4>{comparison.after.title}</h4><button className="text-button" onClick={() => onRead(comparison.after.ref)}>打开正文</button></div></div>{comparison.differences.length ? comparison.differences.map((difference, index) => <article key={`${difference.field}-${index}`}><h4>{fieldNames[difference.field] ?? difference.field}</h4><div className="evolution-columns"><pre>{fieldText(difference.before)}</pre><pre>{fieldText(difference.after)}</pre></div><p className="minor-note">{difference.reason ? `记录的理由：${difference.reason}` : '此字段的变化原因未记录。'}</p></article>) : <p className="minor-note">这两个版本没有结构化差异。</p>}</div>}</section>}
    {research?.cognitiveOutcome === 'candidate' && selected && (!candidate || candidate.candidateId !== research.candidateId || candidate.state !== 'published') && research.exactReadset.some(item => item.objectId === selected.objectId && item.spaceId === selected.spaceId) && <section className="evolution-candidate"><span className="eyebrow">独立候选投影 · 未发表</span><h3>当前研究的候选认识</h3>{candidate && candidate.candidateId === research.candidateId && <p className="minor-note">候选创建：{new Date(candidate.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Taipei' })}（台北）；这不是发表时间。</p>}{candidate && candidate.candidateId === research.candidateId ? candidate.changes.filter(change => change.ref.projectId === selected.projectId && change.ref.spaceId === selected.spaceId && change.ref.objectId === selected.objectId).map(change => <article key={refKey(change.ref)}><h4>{change.title}</h4><p>{change.body}</p><details><summary>条件与边界</summary><p>{change.conditions.join('；') || '未列出条件'}</p><p>{change.counterexamples.join('；') || '未列出反例'}</p></details></article>) : <p>候选正文尚未读取。到研究视图核对结果与审阅状态。</p>}<p className="minor-note">候选不在已发表版本线上，也不传入准确版本比较。研究读集不证明每一条材料支持这项候选。</p></section>}
    <button className="back-link" onClick={onBack}>← 返回原图与选择</button><p className="evolution-hint">当前图接口没有 asOf 或 cursor；这里不展示整网历史快照。使用与反馈活动另见「变化」。</p>
  </div>;
}
