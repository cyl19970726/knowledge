import { z } from 'zod';
import type { Pool } from 'pg';
import { CostObservationSchema, IdSchema, ProjectIdSchema, Sha256Schema, VersionRefSchema, type AnalysisContextSnapshot, type AnalysisResult, type CostObservation } from '../../contracts/src/index.ts';
import { KnowledgeScopeSchema, ProposeChangeSchema, type ProposeChange } from './schemas.ts';
import { KnowledgeError, type KnowledgeChangeSet, type KnowledgeRevision } from './types.ts';
import type { KnowledgeService } from './service.ts';
import { canonical, digest } from './utils.ts';

/** Proposed public upgrade. Deliberately rejects the baseline's reserved version-ID list. */
export const KnowledgeCompileCommandSchema = z.strictObject({
  commandVersion:z.literal('knowledge.compile.v1'), projectId:ProjectIdSchema,
  analysisResultRefs:z.array(VersionRefSchema).min(1).max(20),
  purpose:z.string().trim().min(1).max(500), scope:KnowledgeScopeSchema,
  baseHeads:z.array(z.strictObject({objectId:IdSchema,versionId:IdSchema.nullable()})).min(1).max(20),
  mode:z.enum(['case','topic']), question:z.string().trim().min(1).max(2000),
  methodDigest:Sha256Schema,
  limits:z.strictObject({maxInputBytes:z.int().min(1024).max(2_000_000),maxOutputBytes:z.int().min(1024).max(1_000_000),maxModelCalls:z.int().min(1).max(10),maxRunMs:z.int().min(100).max(600000),spendLimit:z.strictObject({amount:z.number().nonnegative(),currency:z.string().regex(/^[A-Z]{3}$/)}).nullable()}),
  publishMode:z.literal('proposal_only'),
});
export type KnowledgeCompileCommand=z.infer<typeof KnowledgeCompileCommandSchema>;
export interface KnowledgeCompileBundle { command:KnowledgeCompileCommand; analyses:Array<{result:AnalysisResult;snapshot:AnalysisContextSnapshot}>; existing:KnowledgeRevision[] }
export interface KnowledgeProposerPort { methodDigest:string; propose(bundle:KnowledgeCompileBundle,signal:AbortSignal):Promise<{changes:ProposeChange['changes'];proposer:string;methodVersion:string;cost:CostObservation;noChangeReason?:string}> }
export type KnowledgeCompileOutcome =
  | {kind:'changed'; requestHash:string; changeSet:KnowledgeChangeSet; cost:CostObservation}
  | {kind:'no_change'; projectId:string; requestKey:string; requestHash:string; reason:string; cost:CostObservation; baseHeads:KnowledgeCompileCommand['baseHeads']}
  | {kind:'restricted'; projectId:string; requestKey:string; requestHash:string; reason:string; recovery:string; cost:CostObservation}
  | {kind:'failed'; projectId:string; requestKey:string; requestHash:string; stage:string; reason:string; retryable:boolean; cost:CostObservation};
export interface KnowledgeOutcomeLedger {
  get(projectId:string,requestKey:string):Promise<KnowledgeCompileOutcome|null>;
  record(outcome:Extract<KnowledgeCompileOutcome,{kind:'no_change'|'restricted'|'failed'}>):Promise<KnowledgeCompileOutcome>;
}
export async function migrateKnowledgeCompileOutcomes(pool:Pick<Pool,'query'>):Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS ccl_knowledge_compile_outcomes (
    project_id text NOT NULL, request_key text NOT NULL, request_hash text NOT NULL,
    kind text NOT NULL CHECK(kind IN ('no_change','restricted','failed')),
    payload jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(project_id,request_key)
  )`);
}
export function createPgKnowledgeOutcomeLedger(pool:Pick<Pool,'query'>):KnowledgeOutcomeLedger {
  return {
    async get(projectId,requestKey) {
      const row=await pool.query<{payload:KnowledgeCompileOutcome}>('SELECT payload FROM ccl_knowledge_compile_outcomes WHERE project_id=$1 AND request_key=$2',[projectId,requestKey]);
      return row.rows[0]?.payload??null;
    },
    async record(outcome) {
      await pool.query(`INSERT INTO ccl_knowledge_compile_outcomes(project_id,request_key,request_hash,kind,payload)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(project_id,request_key) DO NOTHING`,[outcome.projectId,outcome.requestKey,outcome.requestHash,outcome.kind,outcome]);
      const existing=await this.get(outcome.projectId,outcome.requestKey);
      if(!existing || existing.requestHash!==outcome.requestHash || existing.kind!==outcome.kind) throw new KnowledgeError('IDEMPOTENCY_CONFLICT','Compile outcome key belongs to another command or result');
      return existing;
    },
  };
}
const unknownCost=(reason:string):CostObservation=>({state:'unknown',reason});
export function createKnowledgeCompiler(options:{knowledge:KnowledgeService;proposer:KnowledgeProposerPort;outcomeLedger?:KnowledgeOutcomeLedger}) {
  return async (raw:KnowledgeCompileCommand,requestKey:string,signal:AbortSignal):Promise<KnowledgeCompileOutcome>=>{
    const command=KnowledgeCompileCommandSchema.parse(raw);signal.throwIfAborted();
    if(command.methodDigest!==options.proposer.methodDigest)throw new KnowledgeError('METHOD_MISMATCH','Configured compiler method differs from frozen command',422);
    const requestIdentity={operation:'compile-v1',command};
    const requestHash=digest(requestIdentity);
    const prior=await options.knowledge.getByRequestKey(command.projectId,requestKey);
    const previousOutcome=await options.outcomeLedger?.get(command.projectId,requestKey);
    if(prior && previousOutcome) throw new KnowledgeError('IDEMPOTENCY_CONFLICT','Compile key has both a staged change and a terminal non-change record');
    if(previousOutcome) {if(previousOutcome.requestHash!==requestHash)throw new KnowledgeError('IDEMPOTENCY_CONFLICT','Compile request key belongs to another command');return previousOutcome;}
    if(prior) {if(prior.requestHash!==requestHash)throw new KnowledgeError('IDEMPOTENCY_CONFLICT','Compile request key belongs to another command');return {kind:'changed',requestHash,changeSet:prior,cost:prior.cost};}
    const analyses=[] as KnowledgeCompileBundle['analyses'];
    for(const ref of command.analysisResultRefs) {
      signal.throwIfAborted();analyses.push(await options.knowledge.readAnalysis(command.projectId,ref));
      try { await options.knowledge.revalidate(command.projectId,[{domain:'analysis',ref,role:'uses',critical:true}],command.purpose); }
      catch(error) {
        if(!(error instanceof KnowledgeError) || !['ANALYSIS_REJECTED','ANALYSIS_NOT_ADOPTED','SCOPED_USE_REJECTED','SCOPED_USE_NOT_APPROVED'].includes(error.code)) throw error;
        const restricted:Extract<KnowledgeCompileOutcome,{kind:'restricted'}>={kind:'restricted',projectId:command.projectId,requestKey,requestHash,reason:error.message,recovery:'Obtain an independent decision for this exact report, purpose and scope',cost:{state:'known',amount:0,currency:command.limits.spendLimit?.currency??'USD'}};
        if(!options.outcomeLedger) throw new KnowledgeError('KNOWLEDGE_OUTCOME_LEDGER_REQUIRED','Restricted results require a durable outcome ledger',503);
        return options.outcomeLedger.record(restricted);
      }
    }
    const existing:KnowledgeRevision[]=[];
    for(const head of command.baseHeads) if(head.versionId) {
      const view=await options.knowledge.get(command.projectId,{objectId:head.objectId,versionId:head.versionId});
      if(!view?.published || !view.current) throw new KnowledgeError('HEAD_CONFLICT','Compile base is not the current published version');
      existing.push(view.revision);
    }
    const bundle={command,analyses,existing};
    if(Buffer.byteLength(JSON.stringify(bundle))>command.limits.maxInputBytes) throw new KnowledgeError('COMPILE_INPUT_LIMIT','Frozen compiler bundle exceeds configured input bound',422);
    let proposed:Awaited<ReturnType<KnowledgeProposerPort['propose']>>;
    try { proposed=await options.proposer.propose(bundle,signal); }
    catch(error) {
      signal.throwIfAborted();
      const failed:Extract<KnowledgeCompileOutcome,{kind:'failed'}>={kind:'failed',projectId:command.projectId,requestKey,requestHash,stage:'proposal',reason:error instanceof Error?error.message:String(error),retryable:false,cost:unknownCost('External model outcome or billing may be unknown; reconcile before retry')};
      if(!options.outcomeLedger) throw new KnowledgeError('KNOWLEDGE_OUTCOME_LEDGER_REQUIRED','Failed results require a durable outcome ledger',503);
      return options.outcomeLedger.record(failed);
    }
    signal.throwIfAborted();
    if(Buffer.byteLength(JSON.stringify(proposed))>command.limits.maxOutputBytes) throw new KnowledgeError('COMPILE_OUTPUT_LIMIT','Compiler output exceeds configured output bound',422);
    if(!proposed.changes.length) {
      if(!proposed.noChangeReason?.trim()) throw new KnowledgeError('NO_CHANGE_REASON_REQUIRED','A no-change proposal needs a concrete reason',422);
      if(!options.outcomeLedger) throw new KnowledgeError('KNOWLEDGE_OUTCOME_LEDGER_REQUIRED','No-change results require a durable outcome ledger',503);
      return options.outcomeLedger.record({kind:'no_change',projectId:command.projectId,requestKey,requestHash,reason:proposed.noChangeReason,cost:proposed.cost,baseHeads:command.baseHeads});
    }
    const allowed=new Set(command.analysisResultRefs.map(r=>`${r.objectId}/${r.versionId}`));
    for(const change of proposed.changes) {
      const rev=change.revision;
      if(command.mode==='case' && !['case','claim'].includes(rev.kind))throw new KnowledgeError('COMPILE_MODE_MISMATCH','Case compilation may propose only cases and their claims',422);
      if(rev.kind==='case' && !allowed.has(`${rev.content.analysisResultRef.objectId}/${rev.content.analysisResultRef.versionId}`)) throw new KnowledgeError('UNSELECTED_ANALYSIS','Compiler introduced an unselected analysis result',422);
      if(rev.dependencies.some(d=>d.domain==='analysis'&&!allowed.has(`${d.ref.objectId}/${d.ref.versionId}`))) throw new KnowledgeError('UNSELECTED_ANALYSIS','Compiler introduced an unselected analysis dependency',422);
      if(canonical(rev.scope.applicability)!==canonical(command.scope.applicability)) throw new KnowledgeError('COMPILE_SCOPE_MISMATCH','Compiler must preserve the admitted product and applicability scope',422);
      if(command.scope.reviewDueAt && (!rev.scope.reviewDueAt || Date.parse(rev.scope.reviewDueAt)>Date.parse(command.scope.reviewDueAt))) throw new KnowledgeError('COMPILE_SCOPE_MISMATCH','Compiler cannot postpone the configured review deadline',422);
      rev.scope={...rev.scope,limitations:[...new Set([...command.scope.limitations,...rev.scope.limitations])],unknowns:[...new Set([...command.scope.unknowns,...rev.scope.unknowns])],goalTags:command.scope.goalTags};
    }
    const changeSet=await options.knowledge.propose({projectId:command.projectId,requestKey,purpose:command.purpose,proposer:proposed.proposer,rationale:command.question,methodVersion:proposed.methodVersion,cost:proposed.cost,baseHeads:command.baseHeads,changes:proposed.changes},signal,requestIdentity);
    return {kind:'changed',requestHash,changeSet,cost:proposed.cost};
  };
}

export const KnowledgeProposalSchema = z.strictObject({
  changes: z.array(ProposeChangeSchema.shape.changes.element).max(100), proposer:z.string().min(1), methodVersion:z.string().min(1), cost:CostObservationSchema,
  noChangeReason:z.string().trim().min(1).optional(),
}).refine(p=>p.changes.length>0 || !!p.noChangeReason,{message:'No-change proposals require a reason'});

export function parseKnowledgeProposal(raw:unknown) { return KnowledgeProposalSchema.parse(raw); }
