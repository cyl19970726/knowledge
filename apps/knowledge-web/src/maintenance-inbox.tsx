import { useEffect, useMemo, useState } from 'react';
import type { KnowledgeClient } from '@commerce/knowledge-client';
import type { CoordinationRun, DecisionAnswer, MaintenanceFinding, MaintenanceTask, SearchProjectionStatus, WikiCompileResult } from '@commerce/knowledge-contracts';
import { MaintenanceInboxState, type MaintenanceSnapshot } from './maintenance-inbox-state';

const taskKind: Record<MaintenanceTask['request']['kind'], string> = {
  source_research: '来源研究', recompile: '重新编纂', lint_page: '页面检查', relation_check: '关系检查',
};
const stateName: Record<MaintenanceTask['state'], string> = {
  queued: '排队中', running: '处理中', completed: '已完成', no_change: '提案无变化',
  needs_evidence: '需要补证', waiting_for_review: '等待独立审阅', failed: '处理失败',
  outcome_unknown: '结果待核对', cancelled: '已取消', superseded: '已被后续任务取代',
};
const coordinationStateName: Record<CoordinationRun['state'], string> = {
  reserved: '已预留', running: '处理中', waiting_for_review: '等待独立审阅', no_change: '提案无变化',
  needs_evidence: '需要补证', refused: '已拒绝', failed: '处理失败', outcome_unknown: '结果待核对',
  completed: '已完成', cancelled: '已取消', superseded: '目标已更新，按过时结束',
};
const compilationStateName: Record<WikiCompileResult['state'], string> = {
  reserved: '已预留', running: '处理中', draft_ready: '草稿已就绪', waiting_for_review: '等待独立审阅',
  no_change: '提案无变化', needs_evidence: '需要补证', refused: '已拒答', failed: '处理失败',
  outcome_unknown: '结果待核对', published: '已发表', rejected: '审阅未通过',
};
const findingName: Record<MaintenanceFinding['kind'], string> = {
  review_due: '审阅到期', broken_link: '引用失效', orphan: '缺少关联', invalid_critical_basis: '关键依据无效',
  missing_citation: '缺少引用', duplicate_source_group: '同源重复', suspected_duplicate: '疑似重复',
  semantic_relation: '语义关系待核', source_unavailable: '来源不可用',
};
const answerState: Record<DecisionAnswer['state'], string> = {
  answered: '已回答', refused: '拒答', insufficient_evidence: '依据不足', not_evaluated: '未评估', provider_error: '提供方错误',
};
const answerType: Record<DecisionAnswer['type'], string> = { predicate: '是非判断', choice: '选项判断', score: '分值判断' };
const triggerName: Record<MaintenanceTask['trigger']['stream'], string> = {
  source_intake: '来源入库', knowledge: '知识变更', manual: '人工发起', periodic: '周期检查',
};
const taskStateLabel = (task: MaintenanceTask) => task.cancelRequested && ['queued', 'running'].includes(task.state) ? '已请求取消' : stateName[task.state];
/** Only the exact ledger-generated forms receive editorial labels. Caller reasons stay verbatim. */
export function taskReasonLabel(task: MaintenanceTask): string {
  const {reason,kind} = task.request, {stream,sequence} = task.trigger;
  if (stream === 'source_intake' && kind === 'source_research' &&
      /^source_registered event \d+; original batch (?:none|[0-9a-f-]{36})$/.test(reason) &&
      reason.startsWith(`source_registered event ${sequence}; `)) return '新来源已登记，等待研究';
  if (stream === 'source_intake' && kind === 'source_research' &&
      /^mentions_recorded event \d+; original batch (?:none|[0-9a-f-]{36})$/.test(reason) &&
      reason.startsWith(`mentions_recorded event ${sequence}; `)) return '提及已更新，等待关联核查';
  if (stream === 'knowledge' && kind === 'recompile' &&
      reason === `KnowledgePublished event ${sequence} for exact Wiki revision`) return '知识版本已变化，等待核查';
  if (stream === 'knowledge' && kind === 'recompile' &&
      reason === `KnowledgeInvalidated event ${sequence} for exact Wiki revision`) return '知识状态已变化，等待核查';
  return reason;
}
/** Match only the seven known Wiki lint templates; other finding reasons are caller text. */
export function findingReasonLabel(finding: MaintenanceFinding): string {
  const {kind,reason,taskId} = finding;
  if (taskId !== null) return reason;
  if (kind === 'review_due' && reason === 'Current Wiki reviewDueAt has elapsed.') return '当前 Wiki 已到复核时间';
  if (kind === 'orphan' && reason === 'Current Wiki has no normalized knowledge edge; inspect its intended links.')
    return '当前 Wiki 尚无页面关联记录，需核对预期链接';
  if (kind === 'broken_link' && /^Knowledge dependency points to a missing or unpublished exact version: [0-9a-f-]{36}\/[0-9a-f-]{36}(?:, [0-9a-f-]{36}\/[0-9a-f-]{36}){0,9}(?: \(more omitted\))?\.$/.test(reason))
    return '关联的知识版本缺失或尚未发表，需核对';
  if (kind === 'invalid_critical_basis' && (reason === 'Critical frozen basis has invalid metadata.' ||
      /^Critical frozen basis has invalid metadata: (?:knowledge|analysis|context|source|evidence):[0-9a-f-]{36}\/[0-9a-f-]{36} \([\s\S]+\)\.$/.test(reason)))
    return '关键依据的有效性记录存在问题，需核对';
  if (kind === 'missing_citation' && reason === 'No structured Wiki citation is recorded; this is a review prompt, not proof of an incorrect claim.')
    return '当前 Wiki 尚无可核对的页面引用记录，需人工检查';
  if (kind === 'duplicate_source_group' && reason === 'A source group identifier occurs more than once in this exact revision.')
    return '同一来源组在当前页面重复出现，需核对';
  if (kind === 'suspected_duplicate' && reason === 'Another current Wiki has the same exact profile and identity key; manual review is required.')
    return '另一当前页面的类型与身份标识相同，需人工核对是否重复';
  return reason;
}
const when = (value: string) => new Date(value).toLocaleString('zh-CN');
type Cost = NonNullable<MaintenanceTask['outcome']>['cost'];
const uncertainOutcomeReasons = new Set([
  'Lease expired after dispatch preparation; reconcile the original response',
  'Processor outcome requires original-key reconciliation',
]);
const uncertainCostReasons = new Set([
  'Dispatch outcome was not acknowledged', 'Provider usage is not acknowledged',
  'Billing outcome requires reconciliation', 'External execution may have occurred',
  'No acknowledged usage', 'Reconcile original task',
]);
const outcomeReasonLabel = (task: MaintenanceTask) => {
  const reason = task.outcome?.reason ?? '';
  return task.state === 'outcome_unknown' && task.outcome?.state === 'outcome_unknown' && uncertainOutcomeReasons.has(reason)
    ? '请求结果尚未核对，请先刷新原任务' : reason;
};

function CostView({ cost, maintenanceUnknown = false }: { cost: Cost; maintenanceUnknown?: boolean }) {
  const reason = (raw: string) => maintenanceUnknown && uncertainCostReasons.has(raw)
    ? '尚未收到可核对的用量/账单回执' : raw;
  const count = (value: Cost['tokens']) => value.state === 'known' ? String(value.value) : `未知（${reason(value.reason)}）`;
  const money = cost.money.state === 'known' ? `${cost.money.amount} ${cost.money.currency}` : `未知（${reason(cost.money.reason)}）`;
  return <dl className="maintenance-cost"><dt>模型调用</dt><dd>{count(cost.modelCalls)}</dd><dt>令牌</dt><dd>{count(cost.tokens)}</dd><dt>费用</dt><dd>{money}</dd></dl>;
}
function ExactRef({ value }: { value: unknown }) {
  return <details className="maintenance-exact"><summary>查看准确引用</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>;
}
export function projectionLabel(status: SearchProjectionStatus | null, loaded: boolean): string {
  if (!loaded) return '索引覆盖尚未读取';
  if (!status) return '索引覆盖未就绪，检索回退';
  if (status.blockedRows > 0) return '索引覆盖阻塞，检索回退';
  return status.ready && status.complete ? '索引覆盖就绪' : '索引覆盖未完成，检索回退';
}

type Props = { client: KnowledgeClient; purpose: string; canCancel: boolean; canReadProjection: boolean;
  canReadCoordination: boolean;
  onCandidate: (id: string) => void };

export function MaintenanceInbox({ client, purpose, canCancel, canReadProjection, canReadCoordination, onCandidate }: Props) {
  const [, setVersion] = useState(0);
  const state = useMemo(() => new MaintenanceInboxState(client, purpose, () => setVersion(value => value + 1), undefined, canReadCoordination),
    [client, purpose, canReadCoordination]);
  useEffect(() => { state.start(canReadProjection); return () => state.dispose(); }, [state, canReadProjection]);
  const view = state.view();
  return <MaintenanceInboxContent view={view} state={state} canCancel={canCancel} canReadProjection={canReadProjection}
    canReadCoordination={canReadCoordination} onCandidate={onCandidate} />;
}

export function MaintenanceInboxContent({ view, state, canCancel, canReadProjection, canReadCoordination, onCandidate }:
  { view: MaintenanceSnapshot; state: MaintenanceInboxState; canCancel: boolean; canReadProjection: boolean;
    canReadCoordination: boolean; onCandidate: (id: string) => void }) {
  return <section className="simple-page maintenance-page" aria-label="维护收件箱">
    <div className="page-heading"><h1>维护</h1><p>查看待处理事项、检查发现与处理结果。任务完成不代表 Wiki 已正式发表。</p></div>
    {view.denied ? <div className="inline-error" role="alert">{view.error}</div> : <>
      {view.error && <div className="inline-error" role="alert">{view.error}</div>}
      {canReadProjection && <div className="maintenance-projection" role="status"><strong>{projectionLabel(view.projection, view.projectionLoaded)}</strong>
        <p>这是检索覆盖状态；具体查询仍按用途、范围与现有规则核对。此处仅查看，不启动重建。</p>
        {view.projection && <ExactRef value={{ formatVersion: view.projection.formatVersion, scanned: view.projection.scanned,
          blockedRows: view.projection.blockedRows, updatedAt: view.projection.updatedAt }} />}</div>}
      <div className="maintenance-columns">
        <section className="content-card maintenance-list" aria-label="维护任务"><h2>任务</h2>
          {view.tasks.length ? <ul>{view.tasks.map(task => <li key={task.id}><button type="button"
            className={view.selectedId === task.id ? 'maintenance-item selected' : 'maintenance-item'}
            onClick={() => state.select(task.id)} aria-current={view.selectedId === task.id ? 'true' : undefined}>
            <strong>{taskKind[task.request.kind]}</strong><span>{taskStateLabel(task)}</span>
            <small>{taskReasonLabel(task)}</small><time>{when(task.updatedAt)}</time></button></li>)}</ul>
            : !view.tasksLoading && <p className="minor-note">当前页没有维护任务。</p>}
          {view.tasksLoading && <p className="minor-note" role="status">正在读取任务…</p>}
          {view.tasksMore && <button type="button" className="secondary-button" disabled={view.tasksLoading} onClick={() => void state.loadTasks()}>加载更多任务</button>}
        </section>
        <section className="content-card maintenance-detail" aria-label="任务详情"><h2>任务详情</h2>
          {!view.selectedId && <p className="minor-note">选择一项任务查看原事件与处理记录。</p>}
          {view.detailLoading && <p className="minor-note" role="status">正在读取任务详情…</p>}
          {view.detailError && <div className="inline-error" role="alert">{view.detailError}</div>}
          {view.cancel && <div className="maintenance-pending" role="status"><strong>取消请求待核对</strong><p>{view.cancel.message}</p>
            <ExactRef value={{ taskId: view.cancel.taskId, originalOperationKey: view.cancel.key }} />
            {view.cancel.phase === 'unknown' && <button type="button" className="secondary-button" onClick={() => void state.reconcileCancel()}>只读核对原任务</button>}</div>}
          {view.selected && <article>
            <div className="maintenance-detail-head"><strong>{taskKind[view.selected.request.kind]}</strong><span>{taskStateLabel(view.selected)}</span></div>
            <p>{taskReasonLabel(view.selected)}</p>
            <dl className="maintenance-facts"><dt>触发事件</dt><dd>{triggerName[view.selected.trigger.stream]}</dd>
              <dt>执行方法</dt><dd>{view.selected.request.methodVersion}</dd><dt>规则版本</dt><dd>{view.selected.request.rubricVersion}</dd>
              <dt>尝试次数</dt><dd>{view.selected.attempts}</dd><dt>更新时间</dt><dd>{when(view.selected.updatedAt)}</dd></dl>
            {view.selected.outcome && <><h3>处理结果</h3><p>{outcomeReasonLabel(view.selected)}</p><CostView cost={view.selected.outcome.cost}
              maintenanceUnknown={view.selected.state === 'outcome_unknown' && view.selected.outcome.state === 'outcome_unknown'} />
              {view.selected.outcome.compilationId && <button type="button" className="text-button" disabled={view.relatedLoading !== null}
                onClick={() => void state.loadRelated('compilation')}>只读打开编纂记录</button>}
              {view.selected.outcome.judgmentId && <button type="button" className="text-button" disabled={view.relatedLoading !== null}
                onClick={() => void state.loadRelated('judgment')}>只读打开关系判断</button>}</>}
            {!view.selected.outcome && <p className="minor-note">尚无处理结果；费用未知（尚未记录）。</p>}
            {view.selected.state === 'no_change' && <p className="minor-note">这是无变化提案，仍需独立审阅；此处不表示已批准。</p>}
            {canReadCoordination && <button type="button" className="text-button" disabled={view.relatedLoading !== null}
              onClick={() => void state.loadCoordination()}>只读查看协调记录</button>}
            {view.coordinationLoaded && !view.coordination && <p className="minor-note">这项任务没有协调记录。</p>}
            {view.coordination && <section className="maintenance-related" aria-label="协调记录"><h3>协调记录 · {coordinationStateName[view.coordination.state]}</h3>
              <p>{view.coordination.reason}</p>{view.coordination.request.subjectRef && <p className="minor-note">本轮从已有 Wiki 的准确版本出发，检查它与其他认识的关联；没有新来源入库事件。</p>}<p className="minor-note">协调记录汇总已知步骤；无变化提案仍需独立审阅，来源规划及提及仅是模型提案，不自动消歧或发表。</p>
              <dl className="maintenance-facts"><dt>来源规划</dt><dd>{view.coordination.sourcePlanId ? `已有记录 ${view.coordination.sourcePlanId.slice(0, 8)}…` : view.coordination.request.subjectRef ? '从已有 Wiki 定位，无来源规划' : '未记录'}</dd>
                <dt>参与比较的页面</dt><dd>{view.coordination.candidateRefs.length} 条准确引用</dd>
                <dt>关系判断</dt><dd>{view.coordination.judgmentIds.length} 项</dd>
                <dt>编纂</dt><dd>{view.coordination.compilationId ? `已有记录 ${view.coordination.compilationId.slice(0, 8)}…` : '未记录'}</dd></dl>
              <h4>总费用</h4><CostView cost={view.coordination.cost} />
              {view.coordination.gaps.length > 0 && <><h4>仍待补齐</h4><ul>{view.coordination.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul></>}
              {view.coordination.compilationId && <button type="button" className="text-button" disabled={view.relatedLoading !== null}
                onClick={() => void state.loadRelated('compilation')}>只读打开编纂与候选</button>}
              {view.coordination.judgmentIds.length > 0 && !view.selected.outcome?.judgmentId && <button type="button" className="text-button" disabled={view.relatedLoading !== null}
                onClick={() => void state.loadRelated('judgment')}>只读打开首项关系判断</button>}
              <ExactRef value={{ runId: view.coordination.id, sourcePlanId: view.coordination.sourcePlanId,
                candidateRefs: view.coordination.candidateRefs, judgmentIds: view.coordination.judgmentIds,
                compilationId: view.coordination.compilationId }} /></section>}
            <div className="maintenance-actions"><button type="button" className="secondary-button" disabled={view.detailLoading}
              onClick={() => void state.refreshTask()}>刷新任务状态</button>
              {canCancel && ['queued', 'running'].includes(view.selected.state) && !view.selected.cancelRequested && <button type="button" className="secondary-button"
                disabled={!!view.cancel || view.detailLoading} onClick={() => void state.cancel()}>请求取消任务</button>}</div>
            {view.compilation && <section className="maintenance-related" aria-label="编纂记录"><h3>编纂记录 · {compilationStateName[view.compilation.state]}</h3>
              <p>{view.compilation.reason}</p><p className="minor-note">候选与正式发表是不同阶段。此任务完成并不代表页面已发表。</p>
              {view.compilation.candidate && <button type="button" className="secondary-button"
                onClick={() => onCandidate(view.compilation!.candidate!.candidateId)}>前往候选审阅</button>}
              <ExactRef value={{ compilationId: view.compilation.id, state: view.compilation.state,
                candidateId: view.compilation.candidate?.candidateId ?? null,
                publication: view.compilation.publication ?? null }} /></section>}
            {view.judgment && <section className="maintenance-related" aria-label="关系判断"><h3>关系判断 · {view.judgment.state}</h3>
              <p>{view.judgment.reason}</p><p className="minor-note">判断仅供复核；概率、分布和结论均不会自动成为正式关系。</p>
              {view.judgment.request.questions.map(question => {
                const answer = view.judgment!.batch?.answers.find(item => item.id === question.id);
                return <div className="maintenance-answer" key={question.id}><strong>{answerType[question.type]} · {answer ? answerState[answer.state] : '尚无回答'}</strong>
                  <p>{question.instructions}</p>{answer && <p>{answer.state === 'refused' ? '模型拒答' : answer.state === 'insufficient_evidence' ? `缺少足够依据${answer.value === null ? '' : `（选项：${answer.value}）`}` : answer.state === 'not_evaluated' ? '未评估' : answer.state === 'provider_error' ? '提供方错误' : answer.type === 'predicate' ? `模型判断概率：${answer.probability ?? '未提供'}` : `模型结果：${answer.value ?? '未提供'}`}</p>}
                  {answer?.reason && <p className="minor-note">{answer.reason}</p>}
                  {answer?.distribution && <ExactRef value={{ distribution: answer.distribution, confidence: answer.confidence }} />}</div>;
              })}<ExactRef value={{ judgmentId: view.judgment.id, left: view.judgment.request.left, right: view.judgment.request.right }} /></section>}
            <ExactRef value={{ taskId: view.selected.id, originalReason: view.selected.request.reason,
              trigger: view.selected.trigger, subjectRef: view.selected.request.subjectRef,
              relatedRefs: view.selected.request.relatedRefs, sourceEventIds: view.selected.request.sourceEventIds,
              outcome: view.selected.outcome && { compilationId: view.selected.outcome.compilationId, judgmentId: view.selected.outcome.judgmentId,
                findingIds: view.selected.outcome.findingIds, originalReason: view.selected.outcome.reason,
                originalCost: view.selected.outcome.cost } }} />
          </article>}
        </section>
      </div>
      <section className="content-card maintenance-findings" aria-label="检查发现"><h2>检查发现</h2>
        {view.findings.length ? <ul>{view.findings.map(finding => <li key={finding.id}><strong>{findingName[finding.kind]}</strong>
          <span>{finding.status === 'open' ? '待处理' : finding.status === 'resolved' ? '已处理' : '已取代'}</span>
          <p>{findingReasonLabel(finding)}</p><small>{when(finding.createdAt)} · 方法 {finding.methodVersion}</small>
          <ExactRef value={{ findingId: finding.id, originalReason: finding.reason, taskId: finding.taskId,
            subjectRef: finding.subjectRef, relatedRefs: finding.relatedRefs }} /></li>)}</ul>
          : !view.findingsLoading && <p className="minor-note">当前页没有检查发现。</p>}
        {view.findingsLoading && <p className="minor-note" role="status">正在读取检查发现…</p>}
        {view.findingsMore && <button type="button" className="secondary-button" disabled={view.findingsLoading}
          onClick={() => void state.loadFindings()}>加载更多发现</button>}
      </section>
    </>}
  </section>;
}
