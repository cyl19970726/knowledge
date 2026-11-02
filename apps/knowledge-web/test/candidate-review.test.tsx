import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement,Fragment} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {CandidateView,ResearchResult,ReviewTicket} from '../../../packages/knowledge-contracts/src/index.ts';
import {CandidateLookupPanel,ResearchTriptychWhenRelevant,candidateBelongsToResearch,
  candidateReviewRecoveryKey,showLegacyResearchContext} from '../src/App.tsx';
import {CandidateReview,hasCandidateReviewControls} from '../src/candidate-review.tsx';
import {CandidateReviewState,type CandidateReviewClient} from '../src/candidate-review-state.ts';

const id='00000000-0000-4000-8000-000000000041';
const ticketId='00000000-0000-4000-8000-000000000042';
const digest='c'.repeat(64);
function candidate(overrides:Partial<CandidateView>={}):CandidateView{
  return {candidateId:id,contentHash:digest,purpose:'exploration_reading',proposer:'synthetic-proposer',
    rationale:'准确依据',createdAt:'2026-11-02T00:00:00.000Z',state:'waiting_for_review',
    exactReadset:[],changes:[],reviewable:true,canRequestReview:true,canDecideReview:true,reviewTicketId:null,...overrides};
}
const ticket:ReviewTicket={id:ticketId,target:{kind:'candidate',candidateId:id,contentHash:digest},
  status:'pending',purpose:'exploration_reading'};
const envelope=<T,>(data:T)=>({data});
function state(client:CandidateReviewClient,data=candidate(),keys=['request-key','decide-key']){
  let index=0;
  return new CandidateReviewState(client,data,{request:true,decide:true},()=>{},()=>{},()=>keys[index++]!);
}

test('decision requests exact candidate ticket then freezes digest, purpose and distinct operation keys',async()=>{
  const calls:{kind:string;data:unknown;options:unknown}[]=[];
  let latest=candidate();
  const client={
    requestReview:async(data:unknown,options:unknown)=>{calls.push({kind:'request',data,options});return envelope(ticket);},
    candidateView:async()=>envelope(latest),
    decideReview:async(_id:string,data:unknown,options:unknown)=>{calls.push({kind:'decide',data,options});
      latest=candidate({state:'published'});return envelope({target:ticket.target});},
  } as unknown as CandidateReviewClient;
  const controller=state(client);
  assert.equal(await controller.decide('approved_for_purpose','  已核对来源  '),true);
  assert.equal(controller.view().finalized,true);
  assert.deepEqual(calls,[
    {kind:'request',data:{target:ticket.target,purpose:'exploration_reading'},
      options:{idempotencyKey:'request-key',purpose:'exploration_reading'}},
    {kind:'decide',data:{expectedDigest:digest,decision:'approved_for_purpose',reason:'已核对来源',conditions:[],gaps:[]},
      options:{idempotencyKey:'decide-key',purpose:'exploration_reading'}},
  ]);
  assert.equal(await controller.decide('rejected','再试一次'),false);
  assert.equal(calls.length,2);
});

test('existing exact ticket skips request; unreviewable candidate permits rejection only',async()=>{
  let requests=0,decisions=0;
  const client={requestReview:async()=>{requests++;return envelope(ticket);},
    reviewTicket:async()=>envelope(ticket),
    candidateView:async()=>envelope(candidate({state:'rejected',reviewable:false,reviewTicketId:ticketId})),
    decideReview:async()=>{decisions++;return envelope({target:ticket.target});}} as unknown as CandidateReviewClient;
  const controller=state(client,candidate({reviewable:false,reviewIssues:['来源权利已撤回'],reviewTicketId:ticketId}));
  assert.equal(controller.canDecide('approved_for_purpose'),false);
  assert.equal(controller.canDecide('exploration_only'),false);
  assert.equal(controller.canDecide('rejected'),true);
  assert.equal(await controller.request(),true);
  assert.equal(await controller.decide('approved_for_purpose','批准'),false);
  assert.equal(await controller.decide('rejected','来源权利已撤回'),true);
  assert.equal(requests,0);
  assert.equal(decisions,1);
});

test('lost decision ACK retains original key; unknown and committed reconciliation are read only',async()=>{
  let writes=0,lookups=0,remoteState:'waiting_for_review'|'published'='waiting_for_review';
  let lookupState:'unknown'|'committed'='unknown';
  const client={
    reviewTicket:async()=>envelope(ticket),
    decideReview:async()=>{writes++;throw new Error('response lost');},
    lookupOperation:async(data:{key:string;operation:string;purpose:string})=>{lookups++;
      assert.deepEqual(data,{operation:'review:decide',key:'request-key',purpose:'exploration_reading'});
      return envelope({state:lookupState,operation:null,reservationState:null});},
    candidateView:async()=>envelope(candidate({state:remoteState,reviewTicketId:ticketId})),
  } as unknown as CandidateReviewClient;
  const controller=state(client,candidate({reviewTicketId:ticketId}));
  assert.equal(await controller.decide('approved_for_purpose','理由'),false);
  assert.equal(controller.view().pending?.key,'request-key');
  assert.equal(controller.canDecide('rejected'),false);
  await controller.reconcile();
  assert.equal(controller.view().pending?.key,'request-key');
  lookupState='committed';remoteState='published';
  await controller.reconcile();
  assert.equal(controller.view().pending,null);
  assert.equal(controller.view().finalized,true);
  assert.equal(writes,1);
  assert.equal(lookups,2);
});

test('existing ticket with another digest or purpose cannot trigger a decision',async()=>{
  let decisions=0;
  const client={reviewTicket:async()=>envelope({...ticket,purpose:'another_purpose'}),
    decideReview:async()=>{decisions++;return envelope({target:ticket.target});}} as unknown as CandidateReviewClient;
  const controller=state(client,candidate({reviewTicketId:ticketId}));
  assert.equal(await controller.decide('rejected','准确理由'),false);
  assert.equal(decisions,0);
  assert.match(controller.view().message,/未提交决定/);
  assert.equal(controller.view().pending,null);
});

test('lost ticket ACK can be read back by exact target without another request',async()=>{
  let requests=0;
  const client={
    requestReview:async()=>{requests++;throw new Error('response lost');},
    lookupOperation:async()=>envelope({state:'unknown',operation:null,reservationState:null}),
    candidateView:async()=>envelope(candidate({reviewTicketId:ticketId})),
    reviewTicket:async()=>envelope(ticket),
  } as unknown as CandidateReviewClient;
  const controller=state(client);
  assert.equal(await controller.request(),false);
  assert.equal(controller.view().pending?.key,'request-key');
  await controller.reconcile();
  assert.equal(controller.view().ticketId,ticketId);
  assert.equal(controller.view().pending,null);
  assert.equal(requests,1);
});

test('a recovered unknown key remains locked even if the candidate now appears published',async()=>{
  let writes=0,lookups=0;
  const client={decideReview:async()=>{writes++;},
    lookupOperation:async(data:{key:string})=>{lookups++;assert.equal(data.key,'frozen-decision-key');
      return envelope({state:'unknown',operation:null,reservationState:null});},
    candidateView:async()=>envelope(candidate({state:'published',reviewTicketId:ticketId})),
  } as unknown as CandidateReviewClient;
  const controller=new CandidateReviewState(client,candidate({state:'published',reviewTicketId:ticketId}),
    {request:true,decide:true},()=>{},()=>{},()=> 'new-key',
    {action:'review:decide',key:'frozen-decision-key',decision:'approved_for_purpose'});
  assert.equal(controller.view().pending?.key,'frozen-decision-key');
  assert.equal(await controller.decide('approved_for_purpose','reason'),false);
  await controller.reconcile();
  assert.equal(controller.view().pending?.key,'frozen-decision-key');
  assert.equal(writes,0);
  assert.equal(lookups,1);
});

test('permission gates and legacy candidate compatibility render safely',()=>{
  const noRights=candidate({reviewable:false,reviewIssues:['来源 <unsafe>'],canRequestReview:false,canDecideReview:false});
  const client={} as CandidateReviewClient;
  const html=renderToStaticMarkup(createElement(CandidateReview,{candidate:noRights,client,
    actions:{request:false,decide:false},onCandidate:()=>{}}));
  assert.match(html,/请求候选独立审阅<\/button>/);
  assert.match(html,/批准或拒绝需要独立审阅者身份/);
  assert.match(html,/disabled=""/);
  assert.doesNotMatch(html,/<unsafe>/);
  const legacy=candidate();delete legacy.canRequestReview;delete legacy.canDecideReview;delete legacy.reviewTicketId;
  assert.equal(hasCandidateReviewControls(legacy),false);
  assert.equal(hasCandidateReviewControls(noRights),true);
  const controller=new CandidateReviewState(client,noRights,{request:false,decide:false},()=>{},()=>{});
  assert.equal(controller.canDecide('rejected'),false);
});

test('terminal candidates show read-only status without decision controls or permission warnings',()=>{
  const client={} as CandidateReviewClient;
  for(const [state,label] of [['published','已发表'],['rejected','已拒绝'],['cancelled','已取消']] as const){
    const data=candidate({state,reviewable:false,reviewIssues:['历史来源问题'],
      canRequestReview:false,canDecideReview:false,reviewTicketId:ticketId});
    const html=renderToStaticMarkup(createElement(CandidateReview,{candidate:data,client,
      actions:{request:false,decide:false},onCandidate:()=>{}}));
    assert.match(html,new RegExp(`候选${label}，可只读核对，不能再次审批`));
    assert.match(html,/只读刷新候选与票据/);
    assert.doesNotMatch(html,/candidate-decision-form|请求候选独立审阅|批准或拒绝需要独立审阅者身份|来源或权限问题/);
  }
});

test('candidate ID lookup is visible without a research result and shows a separately loaded candidate',()=>{
  const html=renderToStaticMarkup(createElement(CandidateLookupPanel,{value:id,onChange:()=>{},onSubmit:()=>{},
    loading:false,error:'',candidate:candidate(),result:null,onRead:()=>{}}));
  assert.match(html,/待审候选 ID/);
  assert.match(html,/只读读取候选/);
  assert.match(html,/独立读取的候选 · 修改前后/);
  assert.match(html,new RegExp(id));
  assert.doesNotMatch(html,/action=|href=|token=/);
  assert.equal(candidateBelongsToResearch(null,candidate()),false);
});

test('linked candidate shows the verified preview and folded exact IDs without a manual lookup form',()=>{
  const html=renderToStaticMarkup(createElement(CandidateLookupPanel,{value:id,onChange:()=>{},onSubmit:()=>{},
    loading:false,error:'',candidate:candidate(),result:null,onRead:()=>{},hideLookup:true}));
  assert.match(html,/候选正文 · 修改前后/);
  assert.match(html,/等待独立审阅 · 尚非正式认识/);
  assert.match(html,/<details class="candidate-exact"><summary>准确候选记录<\/summary>/);
  assert.match(html,new RegExp(id));
  assert.doesNotMatch(html,/待审候选 ID|输入候选 UUID|只读读取候选|候选读取失败/);
});

test('review card keeps exact target in details and shows a Chinese state without changing controls',()=>{
  const html=renderToStaticMarkup(createElement(CandidateReview,{candidate:candidate(),client:{} as CandidateReviewClient,
    actions:{request:true,decide:false},onCandidate:()=>{}}));
  assert.match(html,/候选独立审阅/);
  assert.match(html,/等待独立审阅/);
  assert.match(html,/<details class="candidate-exact"><summary>准确审阅目标<\/summary>/);
  assert.match(html,/请求候选独立审阅/);
  assert.match(html,new RegExp(id));
});

test('the same research candidate stays in the triptych; another ID gets its own preview',()=>{
  const research={candidateId:id,cognitiveOutcome:'candidate'} as ResearchResult;
  const props={value:'',onChange:()=>{},onSubmit:()=>{},loading:false,error:'',candidate:candidate(),onRead:()=>{}};
  const same=renderToStaticMarkup(createElement(CandidateLookupPanel,{...props,result:research}));
  assert.doesNotMatch(same,/独立读取的候选 · 修改前后/);
  assert.equal(candidateBelongsToResearch(research,candidate()),true);
  const different={...research,candidateId:'00000000-0000-4000-8000-000000000043'};
  const other=renderToStaticMarkup(createElement(CandidateLookupPanel,{...props,result:different,error:'候选未找到'}));
  assert.match(other,/独立读取的候选 · 修改前后/);
  assert.match(other,/候选读取失败：候选未找到/);
  assert.equal(candidateBelongsToResearch(different,candidate()),false);
});

test('independent candidate hides the unrelated research triptych and its empty-candidate message',()=>{
  const selected=candidate();
  const triptych={documents:[],selectedDocument:null,graph:null,candidateError:'',operation:null,
    onRead:()=>{},onSource:()=>{},onReloadCandidate:()=>{}};
  const html=renderToStaticMarkup(createElement(Fragment,null,
    createElement(CandidateLookupPanel,{value:id,onChange:()=>{},onSubmit:()=>{},loading:false,error:'',
      candidate:selected,result:null,onRead:()=>{}}),
    createElement(ResearchTriptychWhenRelevant,{...triptych,result:null,candidate:selected})));
  assert.match(html,/独立读取的候选 · 修改前后/);
  assert.doesNotMatch(html,/research-triptych|尚未提交研究，也没有候选正文/);
  assert.equal(showLegacyResearchContext(null,selected),false);
  const old=renderToStaticMarkup(createElement(ResearchTriptychWhenRelevant,{...triptych,result:null,candidate:null}));
  assert.match(old,/尚未提交研究，也没有候选正文/);
  const different={candidateId:'00000000-0000-4000-8000-000000000043',cognitiveOutcome:'candidate'} as ResearchResult;
  assert.equal(showLegacyResearchContext(different,selected),false);
  assert.equal(showLegacyResearchContext({...different,candidateId:id},selected),true);
});

test('candidate recovery key binds the actual core base URL without storing the token',()=>{
  const config={baseUrl:'http://127.0.0.1:4101',projectId:'project',spaceId:'space',purpose:'exploration_reading',token:'secret-token'};
  const first=candidateReviewRecoveryKey(config,'a'.repeat(64),candidate());
  const otherService=candidateReviewRecoveryKey({...config,baseUrl:'http://127.0.0.1:4102'},'a'.repeat(64),candidate());
  const rotatedConfig={...config,token:'rotated-secret'};
  const rotatedToken=candidateReviewRecoveryKey(rotatedConfig,'a'.repeat(64),candidate());
  assert.notEqual(first,otherService);
  assert.equal(first,rotatedToken);
  assert.ok(first.includes(config.baseUrl));
  assert.ok(!first.includes(config.token));
});
