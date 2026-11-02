import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { KnowledgeClient } from '@commerce/knowledge-client';
import type { AskResult, CandidateView, WikiCompileResult } from '@commerce/knowledge-contracts';
import { AnswerResearchState, actualCandidateId, isKnownResearchResult, makeAnswerResearchIntent } from './answer-research-state';
import { verifiedCandidateView } from './candidate-scope';

const stateLabel: Record<WikiCompileResult['state'], string> = {
  reserved: '已预留，待核对', running: '研究中', draft_ready: '草案待保证', waiting_for_review: '等待独立审阅',
  no_change: '提案无变化，仍需独立审阅', needs_evidence: '仍需补证', refused: '已拒绝', failed: '处理失败',
  outcome_unknown: '结果未知，待核对', published: '已发表', rejected: '独立审阅拒绝',
};
const pending = new Set(['sending', 'checking', 'unknown', 'reserved', 'running', 'outcome_unknown']);
type Props = { client: KnowledgeClient; purpose: string; answer: AskResult | null; permitted: boolean; canRead: boolean; recoveryScope: string | null;
  visible: boolean; openChooserSignal?: number; onCandidate: (candidateId: string, frozenQuestion: string) => void };

/** A continuation of the answer's evidence trail, mounted even while the original Ask is no longer readable. */
export function AnswerResearchPanel({ client, purpose, answer, permitted, canRead, recoveryScope, visible, openChooserSignal = 0, onCandidate }: Props) {
  const [, update] = useState(0);
  const [state] = useState(() => new AnswerResearchState(() => update(value => value + 1)));
  const [question, setQuestion] = useState(answer?.question ?? '');
  const [selected, setSelected] = useState<number[]>(answer?.claims.map((_, index) => index) ?? []);
  const [money, setMoney] = useState('0');
  const [formOpened, setFormOpened] = useState(false);
  const [validation, setValidation] = useState('');
  const [candidatePreview, setCandidatePreview] = useState<CandidateView | null>(null);
  const [previewError, setPreviewError] = useState('');
  const seeded = useRef<string | null>(null);
  const lastChooserSignal = useRef(openChooserSignal);
  const scope = JSON.stringify([client.scope.projectId, client.scope.spaceId, purpose]);
  useLayoutEffect(() => { state.bind(scope, client, permitted, recoveryScope, canRead); }, [state, scope, client, permitted, recoveryScope, canRead]);
  const view = state.view(scope, client, recoveryScope);
  const answerIdentity = answer?.state === 'answered' && answer.answerFingerprint ? `${answer.id}:${answer.answerFingerprint}` : null;
  const originalIsCurrent = !!answerIdentity && !!answer && !!view.intent && view.intent.answerId === answer.id &&
    view.intent.input.expectedAnswerFingerprint === answer.answerFingerprint;
  useEffect(() => {
    if (!answerIdentity || !answer || seeded.current === `${answerIdentity}:${originalIsCurrent ? view.key : ''}`) return;
    seeded.current = `${answerIdentity}:${originalIsCurrent ? view.key : ''}`;
    setQuestion(originalIsCurrent ? view.intent!.input.question : answer.question);
    setSelected(originalIsCurrent ? [...view.intent!.input.claimIndexes] : answer.claims.map((_, index) => index));
    setMoney(originalIsCurrent ? String(view.intent!.input.budget.maxMoney?.amount ?? 0) : '0');
    setValidation('');
  }, [answerIdentity, answer, originalIsCurrent, view.key, view.intent]);
  useLayoutEffect(() => { if (visible && canRead && view.key) void state.check(scope, client, recoveryScope); }, [visible, canRead, view.key, answerIdentity, scope, client, recoveryScope, state]);

  const canUseAnswer = answer?.state === 'answered' && !!answer.answerFingerprint && answer.claims.length > 0;
  const canStart = permitted && canRead && canUseAnswer && !!recoveryScope && !view.blocked && !pending.has(view.phase);
  const knownResult = isKnownResearchResult(view.result);
  useEffect(() => {
    if (lastChooserSignal.current === openChooserSignal) return;
    lastChooserSignal.current = openChooserSignal;
    if (canStart && (!view.key || knownResult)) setFormOpened(true);
  }, [openChooserSignal, canStart, view.key, knownResult]);
  useEffect(() => { if (knownResult) setFormOpened(false); }, [knownResult, view.result?.id, view.result?.state]);
  const candidateId = actualCandidateId(view);
  const candidateQuestion = view.intent?.input.question ?? view.result?.question;
  useEffect(() => {
    let active = true;
    setCandidatePreview(null); setPreviewError('');
    if (!visible || !canRead || !candidateId) return () => { active = false; };
    void client.candidateView(candidateId, purpose).then(response => {
      if (!active) return;
      const candidate = response.data;
      if (verifiedCandidateView(candidate, candidateId, purpose, client.scope.projectId, client.scope.spaceId)) setCandidatePreview(candidate);
      else setPreviewError('候选回执与本次编纂不一致，已隐藏摘要。');
    }).catch(() => { if (active) setPreviewError('候选摘要暂不可读取；可从完整入口核对。'); });
    return () => { active = false; };
  }, [client, purpose, candidateId, canRead, visible]);
  function submit(event: FormEvent) {
    event.preventDefault(); setValidation('');
    if (!canStart || !answer?.answerFingerprint) return;
    try {
      const frozen = makeAnswerResearchIntent(answer.id, answer.answerFingerprint, selected, question, money, purpose);
      if (state.start(scope, client, frozen, recoveryScope)) setFormOpened(false);
      else setValidation(state.view(scope, client, recoveryScope).error || '当前研究操作尚待核对。');
    } catch (error) { setValidation(error instanceof Error ? error.message : '研究输入无效。'); }
  }
  function toggle(index: number) {
    setSelected(indices => indices.includes(index) ? indices.filter(item => item !== index) : [...indices, index].sort((a, b) => a - b));
  }

  return <section className="answer-research" hidden={!visible || (!answer && !view.key)} aria-label="从回答继续研究">
    <div className="section-heading"><div><span className="eyebrow">问题 · 依据 · 待审提案</span><h3>从回答继续研究</h3></div></div>
    <p className="minor-note">选择结论补证；原回答只作研究提示，候选仍须独立审阅。</p>
    {answer && !permitted && <p className="state-note">当前服务未开放“从回答继续研究”；可继续阅读原回答与依据。</p>}
    {!canRead && <p className="state-note">当前身份未开放编纂读取；已有研究结果已隐藏。新研究也需可读取回执，以便用原键核对。</p>}
    {answer && permitted && !answer.answerFingerprint && <p className="state-note">这份回答没有可核对的指纹，暂不能继续研究。</p>}
    {!answer && view.key && <p className="state-note">原回答当前不可读；已保留原研究键，仍可只读核对编纂历史。不会据此发起新研究。</p>}
    {permitted && canUseAnswer && !recoveryScope && <p className="state-note">当前连接没有可恢复的会话范围，为避免重复提交，研究入口暂不可用。</p>}
    {canStart && !formOpened && !view.key && <button type="button" className="secondary-button answer-research-open" onClick={() => setFormOpened(true)}>选择结论继续研究</button>}
    {canUseAnswer && formOpened && <form className="answer-research-form" onSubmit={submit}>
      <fieldset disabled={!canStart}><legend>本次要核对的结论（至少一条）</legend>
        {answer.claims.map((claim, index) => <label className="answer-research-claim" key={index}><input type="checkbox" checked={selected.includes(index)}
          disabled={!canStart || (selected.includes(index) && selected.length === 1)} onChange={() => toggle(index)} />
          <span><strong>结论 {index + 1}</strong> · {claim.text}</span></label>)}
      </fieldset>
      <label>继续研究的问题<textarea value={question} maxLength={2000} rows={2} onChange={event => setQuestion(event.target.value)} disabled={!canStart} /></label>
      <label>本次研究最高费用（USD）<input value={money} inputMode="decimal" onChange={event => setMoney(event.target.value)} disabled={!canStart} /></label>
      <p className="minor-note">本次最高费用 {money || '—'} USD（默认 0 USD）；只有主动点击才会提交。勾选、问题与预算会冻结到原操作键。</p>
      <details className="ask-record"><summary>查看本次预算与范围上限</summary><p>最多 1 次模型调用 · 读取预算上限 500000 字节 · 120 秒截止 · 最多 100 条候选、1 页。</p></details>
      {validation && <p className="inline-error" role="alert">{validation}</p>}
      <button className="primary-button" type="submit" disabled={!canStart || selected.length === 0 || !question.trim()}>继续研究所选结论</button>
    </form>}
    {view.key && !knownResult && <div className="answer-research-outcome" role="status" aria-live="polite"><strong>{view.phase === 'sending' ? '提交中' : view.phase === 'checking' ? '核对中' : view.result ? stateLabel[view.result.state] : '原研究结果待核对'}</strong>
      {view.error && <p className="inline-error">{view.error}</p>}
      <p className="minor-note">原操作已固定；结果未知时只读核对原键，不会自动重提或换键。</p>
      {canRead && view.phase !== 'sending' && view.phase !== 'checking' && <button className="secondary-button" type="button" onClick={() => void state.check(scope, client, recoveryScope)}>只读核对研究记录</button>}
    </div>}
    {view.result && knownResult && <div className="answer-research-result">
      <h4 role="status" aria-live="polite">{stateLabel[view.result.state]}</h4>
      {candidateId && candidateQuestion && <div className="answer-research-actions"><button className="primary-button" type="button" onClick={() => onCandidate(candidateId, candidateQuestion)}>打开待审候选</button></div>}
      {candidateId && candidatePreview?.candidateId === candidateId && <div className="answer-research-candidate" aria-label="已读取的候选摘要"><strong>编纂关联候选 · {candidatePreview.state === 'waiting_for_review' ? '等待独立审阅，尚未发表' : candidatePreview.state === 'cancelled' ? '已取消' : stateLabel[candidatePreview.state]}</strong>
        {candidatePreview.changes.map(change => {
          const added = change.before ? change.conditions.filter(condition => !change.before!.conditions.includes(condition)) : [];
          const conditions = (added.length ? added : change.conditions).slice(0, 2);
          return <p key={`${change.ref.objectId}@${change.ref.versionId}`}><b>{change.title}</b>{conditions.length ? ` · ${added.length ? '新增条件' : '成立条件'}：${conditions.join('；')}` : ''}</p>;
        })}
        <small>摘要来自准确候选读取；候选没有加入正式星图。</small></div>}
      {candidateId && previewError && <p className="minor-note" role="status">{previewError}</p>}
      <p>{view.result.reason}</p>
      {view.result.answerOrigin && <p>本次研究问题「{view.result.question}」· 源于原回答问题「{view.result.answerOrigin.question}」· 所选结论 {view.result.answerOrigin.claimIndexes.map(index => index + 1).join('、')}。{answer && !originalIsCurrent ? '当前打开的回答与这份研究记录不同。' : ''}</p>}
      <p>本次最高费用 {view.intent?.input.budget.maxMoney?.amount ?? '未知'} USD；实际用量见下方记录。</p>
      <details className="ask-record"><summary>查看实际模型调用与费用</summary><p>模型调用 {view.result.cost.modelCalls.state === 'known' ? view.result.cost.modelCalls.value : `未知：${view.result.cost.modelCalls.reason}`}；Token {view.result.cost.tokens.state === 'known' ? view.result.cost.tokens.value : `未知：${view.result.cost.tokens.reason}`}；金额 {view.result.cost.money.state === 'known' ? `${view.result.cost.money.amount} ${view.result.cost.money.currency}` : `未知：${view.result.cost.money.reason}`}。</p></details>
      {view.result.gaps.length > 0 && <p>仍需补证 {view.result.gaps.length} 项，展开下方记录核对。</p>}
      {canRead && <button className="secondary-button" type="button" onClick={() => void state.check(scope, client, recoveryScope)}>只读刷新研究记录</button>}
      <details className="ask-record"><summary>查看实际依据与缺口（{view.result.evidence.length} 份依据）</summary>
        <p>已确认 Wiki 正文 {view.result.readUsage.wikiPayloadBytes} 字节 · 已确认来源原文 {view.result.readUsage.sourceContentBytes} 字节。</p>
        {view.result.evidence.map(item => <p key={item.id}>已读 · {item.kind === 'wiki_page' ? '认识' : '来源'} · {item.title}</p>)}
        {view.result.excluded.map((item, index) => <p key={index}>未纳入 · {item.reason}</p>)}
        {view.result.gaps.map((gap, index) => <p key={index}>仍需补证 · {gap}</p>)}
      </details>
      <details className="ask-record"><summary>准确引用与原操作</summary><p>编纂 ID：{view.result.id} · 读集指纹：{view.result.readsetFingerprint}</p>
        {view.result.answerOrigin && <p>回答 ID：{view.result.answerOrigin.answerId} · 回答指纹：{view.result.answerOrigin.answerFingerprint} · 结论索引：{view.result.answerOrigin.claimIndexes.join('、')}</p>}
        {view.intent && <p>原操作键：{view.key} · 预算截止：{view.intent.input.budget.deadline} · 最多 {view.intent.input.budget.maxModelCalls} 次模型调用 · 读取上限 {view.intent.input.budget.maxReadBytes} 字节 · 候选上限 {view.intent.input.limit} · 页数上限 {view.intent.input.maxPages}</p>}
        {view.result.evidence.map(item => <p key={item.id}>{item.title} · {item.ref.objectId}@{item.ref.versionId} · {item.ref.contentDigest}</p>)}
      </details>
    </div>}
    {canUseAnswer && knownResult && !formOpened && canStart && <button type="button" className="text-button answer-research-another" onClick={() => setFormOpened(true)}>发起另一份研究</button>}
  </section>;
}
