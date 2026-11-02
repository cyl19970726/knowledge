import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { KnowledgeClient } from '@commerce/knowledge-client';
import type { AskRequest, AskResult, KnowledgeRef } from '@commerce/knowledge-contracts';
import { AskState, compareAskSelection, makeAskRequest } from './ask-state';

const stateName: Record<AskResult['state'], string> = {
  reserved: '已预留，待核对', running: '处理中，待核对', answered: '已有回答', needs_evidence: '需要更多依据',
  refused: '已拒答', failed: '处理失败', outcome_unknown: '结果未知，待核对',
};
const pending = new Set(['sending', 'checking', 'unknown', 'reserved', 'running', 'outcome_unknown']);
const unknownByteGap = 'An excluded exact Wiki read has unknown byte usage; further content reads were stopped';
export function askGapLabel(gap: string): string {
  return gap === unknownByteGap ? '一份被排除的准确版本可能已读取正文，但字节用量无法确认；本次已停止继续读取。' : gap;
}
function moneyFrom(input: AskRequest): string {
  const amount = input.budget.maxMoney?.amount;
  return amount === undefined ? '' : amount === 0 ? '0' : amount.toFixed(2);
}

type Props = {
  client: KnowledgeClient;
  purpose: string;
  question: string;
  onQuestionChange?: (question: string) => void;
  permitted: boolean;
  selected: readonly { ref: KnowledgeRef; title: string | null }[];
  selectionPermitted: boolean;
  recoveryScope: string | null;
  visible: boolean;
  syntheticFixture: boolean;
  onRead: (ref: KnowledgeRef) => void;
  onSource: (ref: KnowledgeRef, locator?: string | null) => void;
  onClose: () => void;
};

export function AskPanel({ client, purpose, question, onQuestionChange, permitted, selected, selectionPermitted, recoveryScope, visible, syntheticFixture, onRead, onSource, onClose }: Props) {
  const [version, setVersion] = useState(0);
  const [state] = useState(() => new AskState(() => setVersion(value => value + 1)));
  const [draft, setDraft] = useState(question);
  const [money, setMoney] = useState('0');
  const [includeSourceContent, setIncludeSourceContent] = useState(false);
  const [validation, setValidation] = useState('');
  const seededKey = useRef<string | null>(null);
  const lastScope = useRef<string | null>(null);
  const scope = JSON.stringify([client.scope.projectId, client.scope.spaceId, purpose]);
  useLayoutEffect(() => { state.bind(scope, client, permitted, recoveryScope); }, [state, scope, client, permitted, recoveryScope]);
  useEffect(() => { if (!state.view(scope, client, recoveryScope).key) setDraft(question); }, [question, state, scope, client, recoveryScope]);
  useLayoutEffect(() => { if (visible && permitted) void state.check(scope, client, recoveryScope); }, [visible, permitted, scope, client, recoveryScope, state]);
  const view = state.view(scope, client, recoveryScope);
  const locked = pending.has(view.phase);
  const invalidSelection = selectionPermitted && selected.some(({ ref }) => ref.domain !== 'knowledge' ||
    ref.projectId !== client.scope.projectId || ref.spaceId !== client.scope.spaceId || ref.contentDigest === null);
  const selectionComparison = compareAskSelection(view.input, view.result);
  useLayoutEffect(() => {
    const identity = JSON.stringify([scope, recoveryScope]);
    if (lastScope.current === identity) return;
    lastScope.current = identity;
    if (!view.key) { setMoney('0'); setIncludeSourceContent(false); }
  }, [scope, recoveryScope, view.key]);
  useLayoutEffect(() => {
    if (!view.key || !view.input) return;
    const identity = JSON.stringify([scope, recoveryScope, view.key]);
    if (seededKey.current === identity) return;
    seededKey.current = identity;
    setDraft(view.input.question);
    setMoney(moneyFrom(view.input));
    setIncludeSourceContent(view.input.includeSourceContent);
    setValidation('');
  }, [scope, recoveryScope, view.key, view.input]);
  void version;

  function submit(event: FormEvent) {
    event.preventDefault(); setValidation('');
    if (!permitted || locked) return;
    if (invalidSelection) { setValidation('联读选区含无准确摘要或跨空间的版本；请先在星图中移除后再提交。'); return; }
    try {
      const input = makeAskRequest(draft, purpose, money, includeSourceContent,
        selectionPermitted ? selected.map(item => item.ref) : []);
      if (state.start(scope, client, input, recoveryScope)) onQuestionChange?.(input.question);
    }
    catch (error) { setValidation(error instanceof Error ? error.message : String(error)); }
  }

  const evidence = new Map(view.result?.evidence.map(item => [item.id, item]));
  return <section className="ask-panel" hidden={!visible} aria-label="有据问答">
    <div className="ask-heading"><div><span className="eyebrow">问题星群 · 当前用途</span><h2>有据问答</h2><p>从当前问题和联读选区出发，核对服务实际读取的准确版本与回答引用。</p></div><button className="secondary-button" type="button" onClick={onClose}>返回星图</button></div>
    {syntheticFixture && <div className="ask-synthetic" role="status">合成工程样例 · 此处回答由合成答题器生成，无真实 LLM 调用，不代表业务结论。</div>}
    {!permitted && <div className="state-note" role="status">当前服务未配置或未开放有据问答；可继续使用探索查询与阅读。</div>}
    {permitted && !recoveryScope && <p className="minor-note">当前服务未提供会话恢复范围；刷新页面后无法核对本次问答，离开前请保存所需信息。</p>}
    <form className="ask-form" onSubmit={submit}>
      <label>问题<textarea aria-label="问答问题" value={locked ? view.input?.question ?? draft : draft} maxLength={2000} onChange={event => setDraft(event.target.value)} disabled={!permitted || locked} rows={3} /></label>
      {!locked && view.key && question.trim() && question.trim() !== draft && <button type="button" className="text-button" onClick={() => setDraft(question)}>使用工作台当前问题</button>}
      <div className="ask-options"><label>本次最高费用（USD）<input aria-label="最高费用（USD）" value={locked && view.input ? moneyFrom(view.input) : money} inputMode="decimal" onChange={event => setMoney(event.target.value)} disabled={!permitted || locked} /></label>
        <label className="ask-checkbox"><input type="checkbox" checked={locked && view.input ? view.input.includeSourceContent : includeSourceContent} onChange={event => setIncludeSourceContent(event.target.checked)} disabled={!permitted || locked} />读取来源原文</label></div>
      <p className="minor-note">默认最高费用 0 USD。来源原文需主动勾选。</p>
      {selected.length > 0 && <div className="ask-meta" aria-label="当前联读选区"><h4>{view.input ? '当前联读选区 · 下一次提交意图' : '当前联读选区 · 拟纳入 A/B（尚未读取）'}</h4>
        {selected.map(({ ref, title }, index) => <p key={`${ref.objectId}@${ref.versionId}`}>{index === 0 ? 'A' : 'B'} · {title ?? '准确版本标题未在当前范围加载'}{ref.contentDigest === null ? ' · 缺少准确摘要' : ''}</p>)}
        {!selectionPermitted ? <p>当前服务未开放选区问答；本次只按问题检索，联读选区尚未自动纳入。</p>
          : invalidSelection ? <p>选区包含无法提交的准确版本，请先回星图调整。</p>
            : <p>提交时固定这些准确版本；实际能否读取，以服务返回的依据与排除项为准。</p>}
      </div>}
      {validation && <p className="inline-error" role="alert">{validation}</p>}
      <button className="primary-button" type="submit" disabled={!permitted || locked || invalidSelection || !draft.trim()}>提交有据问答</button>
    </form>
    {permitted && selectionComparison.length > 0 && <section className="ask-meta" aria-label="提交选区与实际读取"><h4>本次提交的 A/B · 对照实际读取</h4>
      {selectionComparison.map(({ ref, status, reason }, index) => {
        const title = view.result?.evidence.find(item => item.kind === 'wiki_page' && item.ref.objectId === ref.objectId &&
          item.ref.versionId === ref.versionId && item.ref.contentDigest === ref.contentDigest)?.title ??
          selected.find(item => item.ref.objectId === ref.objectId && item.ref.versionId === ref.versionId &&
            item.ref.contentDigest === ref.contentDigest)?.title ?? '提交时所选认识';
        return <div key={`${ref.objectId}@${ref.versionId}`}><p><strong>{index === 0 ? 'A' : 'B'} · {title}</strong> · {status === 'read' ? '已实际读取 Wiki 正文' : status === 'excluded' ? '已排除，未纳入回答依据' : status === 'pending' ? '尚待服务核对，未确认读取' : '未见于实际依据'}</p>
          {reason && <p className="minor-note">排除原因：{reason}</p>}
          <details className="ask-record"><summary>准确版本</summary><p>{ref.objectId}@{ref.versionId} · 摘要 {ref.contentDigest}</p></details></div>;
      })}
      <p className="minor-note">这是原操作冻结的选区；之后在星图调整 A/B，不会改变此操作的键、输入或服务读集。</p>
    </section>}
    {view.key && <div className="ask-intent" role="status"><strong>{view.phase === 'sending' ? '提交中' : view.phase === 'checking' ? '核对中' : view.result ? stateName[view.result.state] : '提交结果待核对'}</strong>{locked && <p>此问题已锁定。只读核对原操作，不会再次提交或产生第二次付费请求。</p>}{locked && view.phase !== 'sending' && view.phase !== 'checking' && permitted && <button type="button" className="secondary-button" onClick={() => void state.check(scope, client, recoveryScope)}>只读核对</button>}</div>}
    {view.error && <p className="inline-error" role="alert">{view.error}</p>}
    {view.result && permitted && <div className="ask-result"><h3>回答 · {stateName[view.result.state]}</h3><p className="ask-reason">{view.result.reason}</p>
      {view.result.claims.map((claim, index) => <article className="ask-claim" key={index}><h4>结论 {index + 1}</h4><p>{claim.text}</p><div className="ask-citations">{claim.evidenceIds.map(id => { const item = evidence.get(id); return item && <button key={id} type="button" onClick={() => item.kind === 'wiki_page' ? onRead(item.ref) : onSource(item.ref, item.locator)}>{item.kind === 'wiki_page' ? '认识' : '来源'} · {item.title}</button>; })}</div></article>)}
      <h4>本次依据（{view.result.evidence.length}）</h4>{view.result.evidence.map(item => <article className="ask-evidence" key={item.id}><div><strong>{item.title}</strong><span> · {item.kind === 'wiki_page' ? '认识' : '来源'}</span></div>{item.locator && <p className="minor-note">定位：{item.locator}</p>}<button type="button" className="text-button" onClick={() => item.kind === 'wiki_page' ? onRead(item.ref) : onSource(item.ref, item.locator)}>打开这份依据</button><EvidenceList title="成立条件" items={item.conditions} /><EvidenceList title="反例与边界" items={item.counterexamples} /><EvidenceList title="尚不确定" items={item.unknowns} /><p className="minor-note">{item.kind === 'wiki_page' ? '已读取准确 Wiki 正文；来源原文是否回查见下方记录。' : item.actualReadCoverage.length ? '来源原文已有读取记录，详情见下方。' : '来源原文读取范围见下方记录。'}</p><details className="ask-record"><summary>查看读取记录</summary><p>依据 ID：{item.id} · 准确版本：{item.ref.versionId} · 内容摘要：{item.ref.contentDigest}</p>{item.actualReadCoverage.map((read, index) => <p key={index}>{read.coverage} · {read.byteCount} 字节 · 来源版本 {read.sourceRef.versionId} · {read.exclusions.join('、') || '无排除说明'}</p>)}</details></article>)}
      <div className="ask-meta"><h4>范围与缺口</h4><p>实际依据 {view.result.evidence.length} 份 · 检索候选 {view.result.coverage.loaded} 条 · {view.result.coverage.completeness === 'complete' ? '范围完整' : view.result.coverage.completeness === 'bounded' ? '有界结果' : '完整性未知'}{view.result.coverage.hasMore ? ' · 仍有后续页' : ''}</p>{view.result.coverage.omittedReasons.map((item, index) => <p key={index}>未包含：{item}</p>)}{view.result.gaps.map((item, index) => <p key={index}>缺口：{askGapLabel(item)}</p>)}{view.result.excluded.map((item, index) => <p key={index}>排除一份依据：{item.reason}</p>)}<h4>实际费用</h4><p>模型调用 {view.result.cost.modelCalls.state === 'known' ? view.result.cost.modelCalls.value : `未知：${view.result.cost.modelCalls.reason}`} · Token {view.result.cost.tokens.state === 'known' ? view.result.cost.tokens.value : `未知：${view.result.cost.tokens.reason}`} · 金额 {view.result.cost.money.state === 'known' ? `${view.result.cost.money.amount} ${view.result.cost.money.currency}` : `未知：${view.result.cost.money.reason}`}</p></div>
    </div>}
    {view.key && <details className="ask-record ask-global-record"><summary>查看读取记录</summary><p>原操作键：{view.key}</p>{view.input && <p>提交问题：{view.input.question} · 用途：{view.input.purpose} · 读取预算上限 {view.input.budget.maxReadBytes} 字节 · 最多 {view.input.budget.maxModelCalls} 次模型调用 · 截止 {view.input.budget.deadline}</p>}{view.result && <><p>范围：{view.result.coverage.scopeDescription}</p><p>读集指纹：{view.result.readsetFingerprint} · 回答 ID：{view.result.id}</p>{view.result.readUsage && <p>已确认读取（UTF-8 字节）：Wiki 正文载荷 {view.result.readUsage.wikiPayloadBytes} · 来源原文 {view.result.readUsage.sourceContentBytes}。准备的回答输入 {view.result.readUsage.preparedInputBytes} 字节 · 读取上限 {view.result.readUsage.maxReadBytes} 字节。未知字节用量另见缺口，不计入已确认数值。这些数值不是数据库磁盘 IO，也不是付费模型输入 token。</p>}{view.result.gaps.map((gap, index) => <p key={index}>原始缺口记录：{gap}</p>)}</>}</details>}
  </section>;
}

function EvidenceList({ title, items }: { title: string; items: string[] }) {
  return <div className="ask-evidence-list"><b>{title}</b>{items.length ? <ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul> : <span>未列出</span>}</div>;
}
