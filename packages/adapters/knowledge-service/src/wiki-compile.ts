import type {Pool,PoolClient} from 'pg';
import type {ReadContext} from '@commerce/knowledge-application';
import {CandidateReceiptSchema,WikiCompileRequestSchema,WikiCompileResultSchema,
  type CandidateReceipt,type WikiCompileRequest,type WikiCompileResult} from '@commerce/knowledge-contracts';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {assertKnowledgeWriterAuthority,type KnowledgeWriterGrant} from '@commerce/knowledge-core/writer-authority';
import {canonical} from '@commerce/knowledge-core/utils';

type CompilationRow={id:string;input_digest:string;request:WikiCompileRequest;result:WikiCompileResult;state:WikiCompileResult['state']};
type Operations={
  reserve(context:ReadContext,key:string,inputDigest:string,request:WikiCompileRequest,initial:WikiCompileResult):Promise<{created:boolean;result:WikiCompileResult}>;
  start(context:ReadContext,id:string):Promise<boolean>;
  checkpoint(context:ReadContext,id:string,result:WikiCompileResult):Promise<void>;
  finish(context:ReadContext,id:string,result:WikiCompileResult):Promise<void>;
  get(context:ReadContext,id:string):Promise<WikiCompileResult|null>;
  lookup(context:ReadContext,key:string):Promise<WikiCompileResult|null>;
  reconcileCandidate(context:ReadContext,id:string,requestHash:string,candidate:CandidateReceipt):Promise<WikiCompileResult>;
};

export class WikiCompileCommitUnknownError extends KnowledgeError {
  readonly commitStatus='unknown';
  readonly operationId:string;
  constructor(id:string){
    super('COMMIT_OUTCOME_UNKNOWN','Wiki compilation commit acknowledgement was lost; reconcile this operation before retrying',503);
    this.operationId=id;
  }
}

export async function migrateWikiCompilations(pool:Pool):Promise<void>{
  await pool.query(`CREATE TABLE IF NOT EXISTS ccl_knowledge_compilations (
    id uuid PRIMARY KEY,
    project_id text NOT NULL,space_id text NOT NULL,principal_id text NOT NULL,installation_id text NOT NULL,
    purpose text NOT NULL,request_key text NOT NULL,input_digest text NOT NULL,
    request jsonb NOT NULL,result jsonb NOT NULL,state text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(project_id,space_id,principal_id,installation_id,purpose,request_key)
  )`);
  await pool.query(`DROP TRIGGER IF EXISTS ccl_writer_guard ON ccl_knowledge_compilations;
    CREATE TRIGGER ccl_writer_guard BEFORE INSERT OR UPDATE OR DELETE ON ccl_knowledge_compilations
    FOR EACH ROW EXECUTE FUNCTION ccl_assert_knowledge_writer()`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ccl_knowledge_compilations_deadline_idx
    ON ccl_knowledge_compilations(project_id,space_id,principal_id,installation_id,purpose,state)`);
}

function assertContext(context:ReadContext):void{
  if(context.scope.projectId!==context.principal.projectId||!context.principal.spaceIds.includes(context.scope.spaceId))
    throw new KnowledgeError('SCOPE_FORBIDDEN','Wiki compilation scope is not authorized',403);
  if(!context.principal.purposes.includes(context.purpose))
    throw new KnowledgeError('PURPOSE_FORBIDDEN','Wiki compilation purpose is not authorized',403);
  if(!context.principal.clientInstallationId?.trim())
    throw new KnowledgeError('INSTALLATION_REQUIRED','Wiki compilation requires a client installation',403);
}

function assertResult(context:ReadContext,result:WikiCompileResult,id:string,request:WikiCompileRequest,prior?:WikiCompileResult):void{
  WikiCompileResultSchema.parse(result);
  if(result.id!==id||result.question!==request.question||result.purpose!==context.purpose||
    (prior&&(result.question!==prior.question||result.purpose!==prior.purpose||result.createdAt!==prior.createdAt)))
    throw new KnowledgeError('WIKI_COMPILE_IDENTITY_MISMATCH','Wiki compilation identity changed',409);
  if(prior?.stageIntent&&(canonical(result.stageIntent)!==canonical(prior.stageIntent)||
    canonical(result.drafts)!==canonical(prior.drafts)))
    throw new KnowledgeError('WIKI_COMPILE_STAGE_INTENT_CHANGED','Acknowledged draft or stage intent changed',409);
  const assertRef=(ref:{projectId:string;spaceId:string}):void=>{
    if(ref.projectId!==context.scope.projectId||ref.spaceId!==context.scope.spaceId)
      throw new KnowledgeError('WIKI_COMPILE_SCOPE_MISMATCH','Wiki compilation contains a reference outside its scope',403);
  };
  for(const evidence of result.evidence){
    assertRef(evidence.ref);
    for(const coverage of evidence.actualReadCoverage)assertRef(coverage.sourceRef);
  }
  for(const excluded of result.excluded)assertRef(excluded.ref);
  if(result.candidate)for(const ref of result.candidate.draftRefs)assertRef(ref);
  const evidenceIds=new Set(result.evidence.map(item=>item.id));
  for(const draft of result.drafts){
    if((draft.targetEvidenceId!==null&&!evidenceIds.has(draft.targetEvidenceId))||
      draft.supportEvidenceIds.some(evidenceId=>!evidenceIds.has(evidenceId)))
      throw new KnowledgeError('WIKI_COMPILE_EVIDENCE_MISMATCH','Wiki draft cites evidence outside this compilation',409);
  }
}

export function createPgWikiCompilations(pool:Pool,grant:KnowledgeWriterGrant):Operations{
  const scope=(context:ReadContext)=>[context.scope.projectId,context.scope.spaceId,context.principal.id,
    context.principal.clientInstallationId,context.purpose];
  const deadline=(request:WikiCompileRequest)=>Date.parse(request.budget.deadline);
  async function requireActive(client:PoolClient,context:ReadContext):Promise<void>{
    await assertKnowledgeWriterAuthority(client,context.scope.projectId,grant);
    const row=await client.query<{mode:string}>('SELECT mode FROM ccl_knowledge_writer_authority WHERE project_id=$1',
      [context.scope.projectId]);
    if(row.rows[0]?.mode!=='active')
      throw new KnowledgeError('WRITER_AUTHORITY_REQUIRED','Explicit active knowledge writer authority is required',503);
  }
  async function transaction<T>(context:ReadContext,id:string,work:(client:PoolClient)=>Promise<T>):Promise<T>{
    const client=await pool.connect();let committing=false;
    try{
      await client.query('BEGIN');await requireActive(client,context);
      const value=await work(client);
      committing=true;await client.query('COMMIT');return value;
    }catch(error){
      if(committing)throw new WikiCompileCommitUnknownError(id);
      await client.query('ROLLBACK');throw error;
    }finally{client.release();}
  }
  async function expire(client:PoolClient,context:ReadContext,row:CompilationRow):Promise<CompilationRow>{
    if(!['reserved','running'].includes(row.state)||deadline(row.request)>Date.now())return row;
    const state=row.state==='reserved'?'failed':'outcome_unknown';
    const reason=row.state==='reserved'
      ?'Wiki compilation deadline elapsed before execution; no provider was invoked'
      :'Wiki compilation deadline elapsed while running; external outcome requires reconciliation';
    const result=WikiCompileResultSchema.parse({...row.result,state,reason,completedAt:new Date().toISOString()});
    await client.query(`UPDATE ccl_knowledge_compilations SET state=$2,result=$3,updated_at=now()
      WHERE id=$1 AND project_id=$4 AND space_id=$5 AND principal_id=$6 AND installation_id=$7 AND purpose=$8 AND state=$9`,
      [row.id,state,result,...scope(context),row.state]);
    return {...row,state,result};
  }
  const select=`SELECT id,input_digest,request,result,state FROM ccl_knowledge_compilations
    WHERE id=$1 AND project_id=$2 AND space_id=$3 AND principal_id=$4 AND installation_id=$5 AND purpose=$6`;
  const ledger:Operations={
    async reserve(context,key,inputDigest,request,initial){
      assertContext(context);WikiCompileRequestSchema.parse(request);WikiCompileResultSchema.parse(initial);
      if(!key.trim()||key.length>200||!/^[0-9a-f]{64}$/.test(inputDigest))
        throw new KnowledgeError('WIKI_COMPILE_RESERVATION_INVALID','Bounded request key and input digest required',422);
      if(request.purpose!==context.purpose)
        throw new KnowledgeError('PURPOSE_MISMATCH','Wiki compilation purpose differs from context',403);
      if(initial.state!=='reserved')
        throw new KnowledgeError('WIKI_COMPILE_RESERVATION_INVALID','Initial compilation must be reserved',422);
      if(initial.stageIntent||initial.drafts.length||initial.candidate)
        throw new KnowledgeError('WIKI_COMPILE_RESERVATION_INVALID','A reserved compilation cannot contain staged work',422);
      assertResult(context,initial,initial.id,request);
      return transaction(context,initial.id,async client=>{
        const inserted=await client.query<CompilationRow>(`INSERT INTO ccl_knowledge_compilations
          (id,project_id,space_id,principal_id,installation_id,purpose,request_key,input_digest,request,result,state)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'reserved')
          ON CONFLICT(project_id,space_id,principal_id,installation_id,purpose,request_key) DO NOTHING
          RETURNING id,input_digest,request,result,state`,
          [initial.id,...scope(context),key,inputDigest,request,initial]);
        if(inserted.rows[0])return {created:true,result:(await expire(client,context,inserted.rows[0])).result};
        const prior=await client.query<CompilationRow>(`SELECT id,input_digest,request,result,state FROM ccl_knowledge_compilations
          WHERE project_id=$1 AND space_id=$2 AND principal_id=$3 AND installation_id=$4 AND purpose=$5 AND request_key=$6 FOR UPDATE`,
          [...scope(context),key]);
        const row=prior.rows[0];
        if(!row)throw new KnowledgeError('WIKI_COMPILE_RESERVATION_UNKNOWN','Compilation reservation requires reconciliation',503);
        if(row.input_digest!==inputDigest||canonical(row.request)!==canonical(request))
          throw new KnowledgeError('IDEMPOTENCY_CONFLICT','Same compilation key has different input',409);
        return {created:false,result:(await expire(client,context,row)).result};
      });
    },
    async start(context,id){
      assertContext(context);
      return transaction(context,id,async client=>{
        const found=await client.query<CompilationRow>(`${select} FOR UPDATE`,[id,...scope(context)]);
        const row=found.rows[0];if(!row||row.state!=='reserved')return false;
        if(deadline(row.request)<=Date.now()){await expire(client,context,row);return false;}
        const result=WikiCompileResultSchema.parse({...row.result,state:'running',cost:{
          modelCalls:{state:'unknown',reason:'Execution started; provider invocation acknowledgement is unavailable'},
          tokens:{state:'unknown',reason:'Execution started; provider usage is unavailable'},
          money:{state:'unknown',reason:'Execution started; billing receipt is unavailable'},
        }});
        await client.query(`UPDATE ccl_knowledge_compilations SET state='running',result=$2,updated_at=now()
          WHERE id=$1 AND project_id=$3 AND space_id=$4 AND principal_id=$5 AND installation_id=$6 AND purpose=$7 AND state='reserved'`,
          [id,result,...scope(context)]);
        return true;
      });
    },
    async checkpoint(context,id,result){
      assertContext(context);
      await transaction(context,id,async client=>{
        const found=await client.query<CompilationRow>(`${select} FOR UPDATE`,[id,...scope(context)]);
        const row=found.rows[0];
        if(!row||row.state!=='running')throw new KnowledgeError('WIKI_COMPILE_NOT_RUNNING','Only a running compilation may be checkpointed',409);
        assertResult(context,result,id,row.request,row.result);
        if(result.state!=='running')
          throw new KnowledgeError('WIKI_COMPILE_CHECKPOINT_NOT_RUNNING','Compilation checkpoint requires running state',422);
        await client.query(`UPDATE ccl_knowledge_compilations SET result=$2,updated_at=now()
          WHERE id=$1 AND project_id=$3 AND space_id=$4 AND principal_id=$5 AND installation_id=$6 AND purpose=$7 AND state='running'`,
          [id,result,...scope(context)]);
      });
    },
    async finish(context,id,result){
      assertContext(context);
      await transaction(context,id,async client=>{
        const found=await client.query<CompilationRow>(`${select} FOR UPDATE`,[id,...scope(context)]);
        const row=found.rows[0];
        if(!row||row.state!=='running')throw new KnowledgeError('WIKI_COMPILE_NOT_RUNNING','Only a running compilation may finish',409);
        assertResult(context,result,id,row.request,row.result);
        if(!['draft_ready','waiting_for_review','no_change','needs_evidence','refused','failed','outcome_unknown'].includes(result.state))
          throw new KnowledgeError('WIKI_COMPILE_NOT_TERMINAL','A finished compilation requires a terminal result',422);
        await client.query(`UPDATE ccl_knowledge_compilations SET state=$2,result=$3,updated_at=now()
          WHERE id=$1 AND project_id=$4 AND space_id=$5 AND principal_id=$6 AND installation_id=$7 AND purpose=$8 AND state='running'`,
          [id,result.state,result,...scope(context)]);
      });
    },
    async get(context,id){
      assertContext(context);
      const found=await pool.query<CompilationRow>(select,[id,...scope(context)]);
      const row=found.rows[0];if(!row)return null;
      if(!['reserved','running'].includes(row.state)||deadline(row.request)>Date.now())return row.result;
      return transaction(context,id,async client=>{
        const locked=await client.query<CompilationRow>(`${select} FOR UPDATE`,[id,...scope(context)]);
        return locked.rows[0]?(await expire(client,context,locked.rows[0])).result:null;
      });
    },
    async lookup(context,key){
      assertContext(context);
      if(!key.trim()||key.length>200)
        throw new KnowledgeError('WIKI_COMPILE_LOOKUP_INVALID','Bounded request key required',422);
      const found=await pool.query<{id:string}>(`SELECT id FROM ccl_knowledge_compilations
        WHERE project_id=$1 AND space_id=$2 AND principal_id=$3 AND installation_id=$4 AND purpose=$5 AND request_key=$6`,
        [...scope(context),key]);
      return found.rows[0]?ledger.get(context,found.rows[0].id):null;
    },
    async reconcileCandidate(context,id,requestHash,candidate){
      assertContext(context);
      if(!/^[0-9a-f]{64}$/.test(requestHash))
        throw new KnowledgeError('WIKI_COMPILE_STAGE_HASH_INVALID','Exact stage request hash required',422);
      CandidateReceiptSchema.parse(candidate);
      if(candidate.candidateId!==id||candidate.changeSetId!==id||candidate.published)
        throw new KnowledgeError('WIKI_COMPILE_CANDIDATE_MISMATCH','Staged candidate identity differs from compilation',409);
      return transaction(context,id,async client=>{
        const found=await client.query<CompilationRow>(`${select} FOR UPDATE`,[id,...scope(context)]);
        const row=found.rows[0];
        if(!row)throw new KnowledgeError('WIKI_COMPILE_NOT_FOUND','Compilation is unavailable in this scope',404);
        if(row.result.stageIntent?.requestHash!==requestHash||!row.result.drafts.length)
          throw new KnowledgeError('WIKI_COMPILE_STAGE_INTENT_MISMATCH','No matching acknowledged draft stage intent',409);
        if(row.result.cost.modelCalls.state!=='known'||row.result.cost.money.state!=='known')
          throw new KnowledgeError('WIKI_COMPILE_COST_UNKNOWN','Candidate reconciliation requires acknowledged model and money cost',409);
        if(row.result.candidate&&canonical(row.result.candidate)!==canonical(candidate))
          throw new KnowledgeError('WIKI_COMPILE_CANDIDATE_MISMATCH','Another candidate is already associated with this compilation',409);
        const staged=await client.query(`SELECT 1 FROM ccl_knowledge_changesets
          WHERE project_id=$1 AND id=$2 AND request_key=$3 AND request_hash=$4 AND content_hash=$5
            AND payload->>'purpose'=$6 AND payload->>'proposer'=$7`,
          [context.scope.projectId,id,`wiki-compile:${id}`,requestHash,candidate.contentHash,
            context.purpose,context.principal.id]);
        if(staged.rowCount!==1)
          throw new KnowledgeError('WIKI_COMPILE_CANDIDATE_NOT_STAGED','Exact staged candidate is unavailable',409);
        const result=WikiCompileResultSchema.parse({...row.result,state:'waiting_for_review',stageStatus:'staged',
          candidate,completedAt:row.state==='waiting_for_review'?row.result.completedAt:new Date().toISOString()});
        assertResult(context,result,id,row.request,row.result);
        if(row.state==='waiting_for_review'){
          if(row.result.stageStatus!=='staged'||!row.result.candidate)
            throw new KnowledgeError('WIKI_COMPILE_CANDIDATE_MISMATCH','Waiting compilation has no matching staged receipt',409);
          return row.result;
        }
        if(!['running','outcome_unknown'].includes(row.state))
          throw new KnowledgeError('WIKI_COMPILE_NOT_RECOVERABLE','Only running or uncertain compilations may attach a staged candidate',409);
        const changed=await client.query(`UPDATE ccl_knowledge_compilations SET state='waiting_for_review',result=$2,updated_at=now()
          WHERE id=$1 AND project_id=$3 AND space_id=$4 AND principal_id=$5 AND installation_id=$6 AND purpose=$7
            AND state IN ('running','outcome_unknown')`,[id,result,...scope(context)]);
        if(changed.rowCount!==1)throw new KnowledgeError('WIKI_COMPILE_NOT_RECOVERABLE','Compilation state changed during reconciliation',409);
        return result;
      });
    },
  };
  return ledger;
}
