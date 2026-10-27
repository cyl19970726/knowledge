import { readTestDatabase } from '../../../scripts/runtime/test-database.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createScopedUseDecisionStore, migrateKnowledgeAdmission, type ScopedUseDecision } from '../src/admission.ts';
import { createPgKnowledgeOutcomeLedger, migrateKnowledgeCompileOutcomes } from '../src/compiler.ts';
import { migrateKnowledge } from '../src/migrations.ts';
import { createKnowledgeStore } from '../src/store.ts';
import { ref, timestamp } from './service-fixtures.ts';

const connectionString=readTestDatabase();

const dbTest=connectionString?test:test.skip;

dbTest('scoped decisions append in a local transaction, advance epoch and replay the latest exact scope', {timeout:60_000}, async()=>{
  const admin=new pg.Pool({connectionString,max:1});const schema=`ccl_admission_test_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,max:3,options:`-c search_path=${schema}`});
  try {
    await migrateKnowledge(pool);await migrateKnowledgeAdmission(pool);await migrateKnowledgeCompileOutcomes(pool);
    const projectId='admission-test';const reportRef=ref();const store=createKnowledgeStore(pool);const decisions=createScopedUseDecisionStore(pool);
    const first:ScopedUseDecision={id:randomUUID(),projectId,reportRef,purpose:'creative_reference',channels:['visual'],mediaScope:{kind:'segment',startMs:0,endMs:2000},decision:'approved',reviewer:'independent',rationale:'synthetic approval',decidedAt:timestamp};
    assert.equal(await store.epoch(projectId),0);
    await decisions.append(first);
    assert.equal(await store.epoch(projectId),1);
    await decisions.append(first);
    assert.equal(await store.epoch(projectId),1);
    const second={...first,id:randomUUID(),decision:'rejected' as const,rationale:'synthetic withdrawal'};
    await decisions.append(second);
    assert.equal(await store.epoch(projectId),2);
    assert.deepEqual(await decisions.current(projectId,reportRef,first.purpose),[second]);
    assert.deepEqual(await decisions.current(projectId,reportRef,'exploration_reading'),[]);
    const ledger=createPgKnowledgeOutcomeLedger(pool);
    const noChange={kind:'no_change' as const,projectId,requestKey:'noop-1',requestHash:'a'.repeat(64),reason:'Exact evidence unchanged',cost:{state:'known' as const,amount:.03,currency:'USD'},baseHeads:[]};
    await ledger.record(noChange);
    assert.deepEqual(await createPgKnowledgeOutcomeLedger(pool).get(projectId,'noop-1'),noChange);
    await assert.rejects(ledger.record({...noChange,requestHash:'b'.repeat(64)}),/another command|result/i);
  } finally {await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
