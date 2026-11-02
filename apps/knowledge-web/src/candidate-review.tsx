import {useState,type FormEvent} from 'react';
import type {CandidateView} from '@commerce/knowledge-contracts';
import {CandidateReviewState,type CandidateReviewClient,type CandidateReviewPending,type ReviewActions,type ReviewChoice} from './candidate-review-state';

export function hasCandidateReviewControls(candidate:CandidateView):boolean{
  return candidate.canRequestReview!==undefined||candidate.canDecideReview!==undefined||candidate.reviewTicketId!==undefined;
}
export function candidateTerminalMessage(state:CandidateView['state']):string|null{
  if(state==='published')return '候选已发表，可只读核对，不能再次审批。';
  if(state==='rejected')return '候选已拒绝，可只读核对，不能再次审批。';
  if(state==='cancelled')return '候选已取消，可只读核对，不能再次审批。';
  return null;
}

function readPending(key:string|undefined):CandidateReviewPending|undefined{
  if(!key||typeof sessionStorage==='undefined')return undefined;
  try{const value=JSON.parse(sessionStorage.getItem(key)??'null') as Record<string,unknown>|null;
    if(!value||!['review:request','review:decide'].includes(String(value.action))||
      typeof value.key!=='string'||!value.key||value.key.length>200||
      (value.action==='review:request'&&value.decision!==undefined)||
      (value.action==='review:decide'&&!['approved_for_purpose','exploration_only','rejected'].includes(String(value.decision))))return undefined;
    return value as CandidateReviewPending;
  }catch{return undefined;}
}
function savePending(key:string|undefined,pending:CandidateReviewPending|null):void{
  if(!key||typeof sessionStorage==='undefined')return;
  try{if(pending)sessionStorage.setItem(key,JSON.stringify(pending));else sessionStorage.removeItem(key);}catch{/* Storage may be disabled. */}
}

export function CandidateReview({candidate,client,scope,actions,onCandidate,recoveryKey}: {candidate:CandidateView;client:CandidateReviewClient;
  scope:{projectId:string;spaceId:string};actions:ReviewActions;onCandidate:(value:CandidateView)=>void;recoveryKey?:string}){
  const [,setVersion]=useState(0);
  const [controller]=useState(()=>new CandidateReviewState(client,candidate,scope,actions,view=>{
    savePending(recoveryKey,view.pending);setVersion(value=>value+1);
  },onCandidate,undefined,readPending(recoveryKey)));
  controller.update(candidate,client,actions,onCandidate);
  const [decision,setDecision]=useState<ReviewChoice>('rejected');
  const [reason,setReason]=useState('');
  const view=controller.view(),busy=view.phase==='sending'||view.phase==='checking';
  const terminalMessage=candidateTerminalMessage(candidate.state);
  const stateLabel:Record<CandidateView['state'],string>={waiting_for_review:'等待独立审阅',cancelled:'已取消',published:'曾发表',rejected:'已拒绝',outcome_unknown:'状态待核对'};
  const requestAllowed=view.trusted&&actions.request&&candidate.canRequestReview===true&&!view.ticketId&&!view.pending&&!view.finalized;
  const decideAllowed=controller.canDecide(decision)&&reason.trim().length>0&&!busy;
  const decisionLabel=decision==='rejected'?'拒绝':decision==='exploration_only'?'仅探索用途批准并发表':'批准并发表';
  const submit=(event:FormEvent)=>{event.preventDefault();void controller.decide(decision,reason);};
  return <section className="content-card candidate-review-panel" aria-label="候选独立审阅">
    <div className="section-heading"><h2>候选独立审阅</h2><span>{stateLabel[candidate.state]}</span></div>
    <details className="candidate-exact"><summary>准确审阅目标</summary><p>候选 ID {candidate.candidateId} · 内容摘要 {candidate.contentHash} · 用途 {candidate.purpose} · 原始状态 {candidate.state}</p></details>
    {terminalMessage ? <>
      <p className="minor-note" role="status">{terminalMessage}</p>
      <button className="text-button" type="button" disabled={busy} onClick={()=>void controller.refresh()}>只读刷新候选与票据</button>
      {view.ticketId&&<p className="minor-note">准确审阅票据 {view.ticketId}</p>}
    </> : candidate.state!=='waiting_for_review' ? <>
      <p className="minor-note" role="status">候选状态待核对；当前仅可只读刷新，不能审批。</p>
      <button className="text-button" type="button" disabled={busy} onClick={()=>void controller.refresh()}>只读刷新候选与票据</button>
    </> : candidate.canRequestReview===undefined&&candidate.canDecideReview===undefined
      ? <p className="minor-note">旧候选未提供审阅权限信息；此界面不推断可发起或批准。</p>
      : <>
        <div className="button-row">
          <button className="secondary-button" type="button" disabled={!requestAllowed||busy}
            onClick={()=>void controller.request()}>请求候选独立审阅</button>
          <button className="text-button" type="button" disabled={busy}
            onClick={()=>void controller.refresh()}>只读刷新候选与票据</button>
        </div>
        {!actions.request&&candidate.canRequestReview&&<p className="minor-note">当前身份缺少请求审阅权限。</p>}
        {!candidate.canDecideReview&&<p className="minor-note">批准或拒绝需要独立审阅者身份；提出者不能审核自己的候选。</p>}
        {candidate.reviewable===false&&<p className="candidate-review-caution">当前候选不可批准。来源或权限问题须由服务核对；有独立审阅权限时仍可记录拒绝。</p>}
        <p className="minor-note">{view.ticketId?`准确审阅票据 ${view.ticketId}`:'尚无已核对的审阅票据。决定时会先请求当前准确候选的票据。'}</p>
        <form onSubmit={submit} className="candidate-decision-form">
          <label>审阅决定<select value={decision} onChange={event=>setDecision(event.target.value as ReviewChoice)}>
            <option value="rejected">拒绝</option><option value="exploration_only">仅探索用途批准并发表</option>
            <option value="approved_for_purpose">批准并发表</option>
          </select></label>
          <label>独立审阅理由<textarea value={reason} onChange={event=>setReason(event.target.value)}
            placeholder="写明准确依据、适用条件与不能确认之处" required maxLength={5000} /></label>
          <button className="primary-button" disabled={!decideAllowed} title={!controller.canDecide(decision)?'当前身份、审阅状态或来源条件不允许此决定':undefined}>{decisionLabel}</button>
        </form>
      </>}
    {view.message&&<div className="candidate-review-message" role="status">{view.message}</div>}
    {view.pending&&<div className="candidate-review-pending" role="status">
      <p>原操作键 {view.pending.key} · {view.pending.action}。提交结果尚未核对，不能发起另一项决定。</p>
      <button className="secondary-button" type="button" disabled={busy} onClick={()=>void controller.reconcile()}>用原键只读核对</button>
    </div>}
  </section>;
}
