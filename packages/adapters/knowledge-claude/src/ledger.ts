import {randomUUID} from 'node:crypto';
import {readFile,appendFile} from 'node:fs/promises';
import type {Pool} from 'pg';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import type {TokenUsage} from './pricing.ts';

/**
 * Every model call is reserved at its worst-case price before dispatch and settled afterwards.
 * A call whose outcome is unknown keeps its reservation, so the daily cap can only be over-counted, never exceeded.
 */
export interface SpendReservation {id:string;day:string;reservedUsd:number}
export interface SpendSettlement {actualUsd:number;usage:TokenUsage;modelReturned:string|null;requestId:string|null;stopReason:string|null}
export interface SpendEntry {id:string;day:string;role:string;operationId:string;model:string;state:'reserved'|'settled'|'released'|'unknown';
  reservedUsd:number;actualUsd:number|null;usage:TokenUsage|null;requestId:string|null;reason:string|null;createdAt:string}
export interface SpendLedger {
  reserve(input:{role:string;operationId:string;model:string;reservedUsd:number;dailyCapUsd:number;now:Date}):Promise<SpendReservation>;
  settle(id:string,settlement:SpendSettlement):Promise<void>;
  /** The request never reached the provider or was rejected before billing. */
  release(id:string,reason:string):Promise<void>;
  /** Dispatch happened but the outcome is unknown: the reservation stays counted. */
  markUnknown(id:string,reason:string):Promise<void>;
  spentToday(now:Date):Promise<number>;
}
export const spendDay=(now:Date)=>now.toISOString().slice(0,10);
const exceeded=(spent:number,reserved:number,cap:number)=>new KnowledgeError('MODEL_DAILY_BUDGET_EXCEEDED',
  `Daily model budget would be exceeded: ${spent.toFixed(4)} spent or reserved, ${reserved.toFixed(4)} requested, cap ${cap.toFixed(2)} USD`,429);

export function createMemorySpendLedger():SpendLedger&{entries:SpendEntry[]}{
  const entries:SpendEntry[]=[];
  const counted=(entry:SpendEntry)=>entry.state==='released'?0:entry.state==='settled'?entry.actualUsd??0:entry.reservedUsd;
  const spent=(day:string)=>entries.filter(entry=>entry.day===day).reduce((sum,entry)=>sum+counted(entry),0);
  const find=(id:string)=>{const entry=entries.find(item=>item.id===id);if(!entry)throw new Error('Unknown spend reservation');return entry;};
  return {entries,
    async reserve(input){const day=spendDay(input.now),used=spent(day);
      if(used+input.reservedUsd>input.dailyCapUsd)throw exceeded(used,input.reservedUsd,input.dailyCapUsd);
      const entry:SpendEntry={id:randomUUID(),day,role:input.role,operationId:input.operationId,model:input.model,state:'reserved',reservedUsd:input.reservedUsd,
        actualUsd:null,usage:null,requestId:null,reason:null,createdAt:input.now.toISOString()};
      entries.push(entry);return {id:entry.id,day,reservedUsd:input.reservedUsd};},
    async settle(id,settlement){Object.assign(find(id),{state:'settled',actualUsd:settlement.actualUsd,usage:settlement.usage,requestId:settlement.requestId});},
    async release(id,reason){Object.assign(find(id),{state:'released',reason});},
    async markUnknown(id,reason){Object.assign(find(id),{state:'unknown',reason});},
    async spentToday(now){return spent(spendDay(now));},
  };
}

export async function migrateModelSpend(pool:Pool):Promise<void>{
  await pool.query(`CREATE TABLE IF NOT EXISTS ccl_knowledge_model_spend (
    id uuid PRIMARY KEY,day date NOT NULL,role text NOT NULL,operation_id text NOT NULL,model text NOT NULL,
    state text NOT NULL CHECK(state IN ('reserved','settled','released','unknown')),
    reserved_usd numeric(14,6) NOT NULL CHECK(reserved_usd>=0),actual_usd numeric(14,6) CHECK(actual_usd IS NULL OR actual_usd>=0),
    usage jsonb,model_returned text,request_id text,stop_reason text,reason text,
    created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK(state<>'settled' OR actual_usd IS NOT NULL))`);
  await pool.query('CREATE INDEX IF NOT EXISTS ccl_knowledge_model_spend_day ON ccl_knowledge_model_spend(day,state)');
}

const COUNTED=`COALESCE(SUM(CASE state WHEN 'released' THEN 0 WHEN 'settled' THEN actual_usd ELSE reserved_usd END),0)::float8`;
export function createPgSpendLedger(pool:Pool):SpendLedger{
  async function transition(id:string,from:string[],set:string,values:unknown[]){
    const found=await pool.query(`UPDATE ccl_knowledge_model_spend SET ${set},updated_at=now() WHERE id=$1 AND state=ANY($2::text[]) RETURNING id`,[id,from,...values]);
    if(found.rowCount!==1)throw new KnowledgeError('MODEL_SPEND_STATE_CONFLICT','Model spend reservation is not in an expected state',409);
  }
  return {
    async reserve(input){
      const day=spendDay(input.now),client=await pool.connect();
      try{
        await client.query('BEGIN');
        // One lock per day serializes cap checks across processes.
        await client.query("SELECT pg_advisory_xact_lock(hashtext('ccl_knowledge_model_spend'),hashtext($1))",[day]);
        const used=Number((await client.query(`SELECT ${COUNTED} AS used FROM ccl_knowledge_model_spend WHERE day=$1`,[day])).rows[0].used);
        if(used+input.reservedUsd>input.dailyCapUsd)throw exceeded(used,input.reservedUsd,input.dailyCapUsd);
        const id=randomUUID();
        await client.query(`INSERT INTO ccl_knowledge_model_spend(id,day,role,operation_id,model,state,reserved_usd) VALUES($1,$2,$3,$4,$5,'reserved',$6)`,
          [id,day,input.role,input.operationId,input.model,input.reservedUsd]);
        await client.query('COMMIT');
        return {id,day,reservedUsd:input.reservedUsd};
      }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}
      finally{client.release();}
    },
    settle:(id,s)=>transition(id,['reserved'],`state='settled',actual_usd=$3,usage=$4,model_returned=$5,request_id=$6,stop_reason=$7`,
      [s.actualUsd,JSON.stringify(s.usage),s.modelReturned,s.requestId,s.stopReason]),
    release:(id,reason)=>transition(id,['reserved'],`state='released',reason=$3`,[reason.slice(0,1000)]),
    markUnknown:(id,reason)=>transition(id,['reserved'],`state='unknown',reason=$3`,[reason.slice(0,1000)]),
    async spentToday(now){return Number((await pool.query(`SELECT ${COUNTED} AS used FROM ccl_knowledge_model_spend WHERE day=$1`,[spendDay(now)])).rows[0].used);},
  };
}

/**
 * Append-only JSONL ledger for a single process without database access (the review agent).
 * Each line is a full entry snapshot; the latest line per id wins. Run one agent process per file.
 */
export function createFileSpendLedger(path:string):SpendLedger{
  let queue:Promise<unknown>=Promise.resolve();
  const serial=<T>(work:()=>Promise<T>)=>{const next=queue.then(work,work);queue=next.catch(()=>undefined);return next;};
  async function load():Promise<Map<string,SpendEntry>>{
    let text='';
    try{text=await readFile(path,'utf8');}catch(error){if((error as {code?:string}).code!=='ENOENT')throw error;}
    const entries=new Map<string,SpendEntry>();
    for(const line of text.split('\n'))if(line.trim()){const entry=JSON.parse(line) as SpendEntry;entries.set(entry.id,entry);}
    return entries;
  }
  const append=async(entry:SpendEntry)=>{await appendFile(path,`${JSON.stringify(entry)}\n`,{mode:0o600});};
  const counted=(entry:SpendEntry)=>entry.state==='released'?0:entry.state==='settled'?entry.actualUsd??0:entry.reservedUsd;
  const spent=(entries:Map<string,SpendEntry>,day:string)=>[...entries.values()].filter(entry=>entry.day===day).reduce((sum,entry)=>sum+counted(entry),0);
  const update=(id:string,change:Partial<SpendEntry>)=>serial(async()=>{const entry=(await load()).get(id);
    if(!entry||entry.state!=='reserved')throw new KnowledgeError('MODEL_SPEND_STATE_CONFLICT','Model spend reservation is not in an expected state',409);
    await append({...entry,...change});});
  return {
    reserve:input=>serial(async()=>{const entries=await load(),day=spendDay(input.now),used=spent(entries,day);
      if(used+input.reservedUsd>input.dailyCapUsd)throw exceeded(used,input.reservedUsd,input.dailyCapUsd);
      const entry:SpendEntry={id:randomUUID(),day,role:input.role,operationId:input.operationId,model:input.model,state:'reserved',reservedUsd:input.reservedUsd,
        actualUsd:null,usage:null,requestId:null,reason:null,createdAt:input.now.toISOString()};
      await append(entry);return {id:entry.id,day,reservedUsd:input.reservedUsd};}),
    settle:(id,s)=>update(id,{state:'settled',actualUsd:s.actualUsd,usage:s.usage,requestId:s.requestId}),
    release:(id,reason)=>update(id,{state:'released',reason}),
    markUnknown:(id,reason)=>update(id,{state:'unknown',reason}),
    spentToday:now=>serial(async()=>spent(await load(),spendDay(now))),
  };
}
