import type {KnowledgeClient} from '@commerce/knowledge-client';
import type {CandidateView,ReviewDecision,ReviewTicket} from '@commerce/knowledge-contracts';

export type CandidateReviewClient=Pick<KnowledgeClient,'requestReview'|'reviewTicket'|'decideReview'|'lookupOperation'|'candidateView'>;
export type ReviewChoice=ReviewDecision['decision'];
export type ReviewActions={request:boolean;decide:boolean};
export type CandidateReviewPending={action:'review:request'|'review:decide';key:string;decision?:ReviewChoice};
type Pending=CandidateReviewPending;
export type CandidateReviewSnapshot={phase:'idle'|'sending'|'unknown'|'checking'|'confirmed';ticketId:string|null;
  pending:Pending|null;message:string;finalized:boolean};

/** Keeps each submitted key frozen. Reconciliation only reads; it never sends another decision. */
export class CandidateReviewState {
  private pending:Pending|null=null;
  private ticketId:string|null;
  private phase:CandidateReviewSnapshot['phase']='idle';
  private message='';
  private finalized=false;
  private readonly target:{candidateId:string;contentHash:string;purpose:string};
  constructor(private client:CandidateReviewClient,private candidate:CandidateView,private actions:ReviewActions,
    private changed:(view:CandidateReviewSnapshot)=>void,private loaded:(value:CandidateView)=>void,
    private newKey:()=>string=()=>crypto.randomUUID(),recovered?:CandidateReviewPending){
    this.target={candidateId:candidate.candidateId,contentHash:candidate.contentHash,purpose:candidate.purpose};
    this.ticketId=candidate.reviewTicketId??null;
    this.finalized=['published','rejected','cancelled'].includes(candidate.state);
    if(recovered){this.pending={...recovered};this.phase='unknown';
      this.message=`上次操作 ${recovered.key} 的提交结果待核对；不会自动重发。`;}
  }
  view():CandidateReviewSnapshot{return {phase:this.phase,ticketId:this.ticketId,pending:this.pending&&{...this.pending},
    message:this.message,finalized:this.finalized};}
  update(candidate:CandidateView,client:CandidateReviewClient,actions:ReviewActions,loaded:(value:CandidateView)=>void):void{
    if(candidate.candidateId!==this.target.candidateId||candidate.contentHash!==this.target.contentHash||
      candidate.purpose!==this.target.purpose)throw new Error('Candidate review target changed');
    this.candidate=candidate;this.client=client;this.actions=actions;this.loaded=loaded;
    if(candidate.reviewTicketId)this.ticketId=candidate.reviewTicketId;
    if(['published','rejected','cancelled'].includes(candidate.state))this.finalized=true;
  }
  private emit():void{this.changed(this.view());}
  private begin(action:Pending['action'],decision?:ReviewChoice):string|null{
    if(this.pending||this.finalized)return null;
    const key=this.newKey();this.pending={action,key,...decision?{decision}:{}};
    this.phase='sending';this.message='正在提交准确目标…';this.emit();return key;
  }
  private fail(error:unknown):void{
    this.phase='unknown';this.message=`${error instanceof Error?error.message:String(error)}。请用原操作键只读核对；不会自动重发。`;
    this.emit();
  }
  private sameTicket(ticket:ReviewTicket):boolean{
    return ticket.purpose===this.target.purpose&&ticket.target.kind==='candidate'&&
      ticket.target.candidateId===this.target.candidateId&&ticket.target.contentHash===this.target.contentHash;
  }
  private async refreshCandidate():Promise<CandidateView>{
    const response=await this.client.candidateView(this.target.candidateId,this.target.purpose);
    const value=response.data as CandidateView;
    if(value.candidateId!==this.target.candidateId||value.contentHash!==this.target.contentHash||value.purpose!==this.target.purpose)
      throw new Error('刷新返回了另一候选目标');
    this.candidate=value;if(value.reviewTicketId)this.ticketId=value.reviewTicketId;
    if(['published','rejected','cancelled'].includes(value.state))this.finalized=true;
    this.loaded(value);this.emit();return value;
  }
  private async refreshAfterWrite():Promise<void>{
    try{await this.refreshCandidate();}catch(error){this.message=`写入回执已返回，候选刷新失败：${error instanceof Error?error.message:String(error)}。请只读刷新。`;this.emit();}
  }
  async refresh():Promise<void>{
    if(this.phase==='sending'||this.phase==='checking')return;
    try{
      await this.refreshCandidate();
      if(this.ticketId){const response=await this.client.reviewTicket(this.ticketId,{purpose:this.target.purpose});
        if(!this.sameTicket(response.data))throw new Error('审阅票据指向另一候选');}
      this.message='已刷新候选与准确审阅状态。';this.emit();
    }catch(error){this.message=`只读刷新失败：${error instanceof Error?error.message:String(error)}`;this.emit();}
  }
  private async requestTicket(forDecision=false):Promise<string|null>{
    if(this.ticketId)return this.ticketId;
    if(!this.actions.request||!(this.candidate.canRequestReview===true||forDecision&&this.candidate.canDecideReview===true))return null;
    const key=this.begin('review:request');if(!key)return null;
    try{
      const response=await this.client.requestReview({target:{kind:'candidate',candidateId:this.target.candidateId,
        contentHash:this.target.contentHash},purpose:this.target.purpose},{idempotencyKey:key,purpose:this.target.purpose});
      if(!this.sameTicket(response.data))throw new Error('审阅请求返回了另一候选票据');
      this.ticketId=response.data.id;this.pending=null;this.phase='confirmed';this.message='独立审阅票据已返回。';this.emit();
      await this.refreshAfterWrite();return response.data.id;
    }catch(error){this.fail(error);return null;}
  }
  async request():Promise<boolean>{return !!await this.requestTicket();}
  canDecide(decision:ReviewChoice):boolean{
    return this.actions.decide&&this.candidate.canDecideReview===true&&!this.pending&&!this.finalized&&
      (this.ticketId!==null||this.actions.request)&&
      (decision==='rejected'||this.candidate.reviewable===true);
  }
  async decide(decision:ReviewChoice,reason:string):Promise<boolean>{
    if(!reason.trim()||!this.canDecide(decision))return false;
    let ticketId=this.ticketId;
    if(!ticketId){ticketId=await this.requestTicket(true);if(!ticketId||!this.canDecide(decision))return false;}
    else{
      try{const found=(await this.client.reviewTicket(ticketId,{purpose:this.target.purpose})).data;
        if(!this.sameTicket(found))throw new Error('审阅票据指向另一候选或用途');}
      catch(error){this.message=`准确审阅票据核对失败：${error instanceof Error?error.message:String(error)}。未提交决定。`;
        this.emit();return false;}
    }
    const key=this.begin('review:decide',decision);if(!key)return false;
    try{
      const response=await this.client.decideReview(ticketId,{expectedDigest:this.target.contentHash,decision,
        reason:reason.trim(),conditions:[],gaps:[]},{idempotencyKey:key,purpose:this.target.purpose});
      if(response.data.target.kind!=='candidate'||response.data.target.candidateId!==this.target.candidateId||
        response.data.target.contentHash!==this.target.contentHash)
        throw new Error('审阅决定返回了另一候选目标');
      this.pending=null;this.finalized=true;this.phase='confirmed';
      this.message=decision==='rejected'?'拒绝回执已返回；请核对候选最终状态。':'批准回执已返回；请核对发表状态。';
      this.emit();await this.refreshAfterWrite();return true;
    }catch(error){this.fail(error);return false;}
  }
  async reconcile():Promise<void>{
    const pending=this.pending;if(!pending||this.phase==='sending'||this.phase==='checking')return;
    this.phase='checking';this.message='正在按原操作键只读核对…';this.emit();
    try{
      const lookup=(await this.client.lookupOperation({operation:pending.action,key:pending.key,purpose:this.target.purpose},
        {purpose:this.target.purpose})).data;
      const candidate=await this.refreshCandidate();
      if(pending.action==='review:request'&&this.ticketId){
        const ticket=(await this.client.reviewTicket(this.ticketId,{purpose:this.target.purpose})).data;
        if(!this.sameTicket(ticket))throw new Error('审阅票据指向另一候选');
        this.pending=null;this.phase='confirmed';this.message='已只读核对准确候选审阅票据。';this.emit();return;
      }
      if(pending.action==='review:decide'&&lookup.state==='committed'&&
        (pending.decision==='rejected'?candidate.state==='rejected':candidate.state==='published')){
        this.pending=null;this.finalized=true;this.phase='confirmed';this.message='已只读核对审阅决定及候选最终状态。';this.emit();return;
      }
      if(lookup.state==='definitively_not_committed'){
        this.pending=null;this.phase='idle';this.message='服务确认原操作未提交；如需继续，请明确重新操作。';this.emit();return;
      }
      this.phase='unknown';this.message=`原操作键仍待核对（${pending.key}）；候选当前为 ${candidate.state}。不会自动重发。`;this.emit();
    }catch(error){this.phase='unknown';this.message=`只读核对未完成：${error instanceof Error?error.message:String(error)}。保留原操作键，不会自动重发。`;this.emit();}
  }
}
