import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KnowledgeClientError } from '@commerce/knowledge-client';
import type { Operation } from '@commerce/knowledge-contracts';
import { WriteIntents, type ReconciliationRead } from '../src/write-intents.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
const lost = () => new KnowledgeClientError({ code: 'TRANSPORT_OUTCOME_UNKNOWN', message: 'response lost', commitStatus: 'unknown' });
const OP_ID = '00000000-0000-4000-8000-000000000001';
const RESEARCH_ID = '00000000-0000-4000-8000-000000000002';
function committedOperation(overrides: Partial<Operation> = {}): Operation {
  return { id: OP_ID, state: 'succeeded', inputDigest: 'a'.repeat(64), commitStatus: 'committed', statusUrl: `operations/${OP_ID}`,
    attemptId: null, reason: null, cost: { modelCalls: { state: 'known', value: 0 }, tokens: { state: 'known', value: 0 }, money: { state: 'unknown', reason: 'No billed work in this test' } }, ...overrides };
}

test('lost response holds the synchronous lock; unknown lookup never replays or creates a new intent', async () => {
  const writes: Array<{ key: string; question: string; deadline: string }> = [];
  const input = { question: 'original', deadline: '2026-10-26T10:00:00.000Z' };
  const intents = new WriteIntents(() => {}, () => `key-${writes.length + 1}`);
  assert.equal(intents.start({ scope: 'p/s/purpose', purpose: 'purpose', action: 'research', label: 'research', input,
    send: async (frozen, key) => { writes.push({ ...frozen, key }); throw lost(); }, complete: () => {}, operationIsResult: true }), true);
  input.question = 'edited'; input.deadline = '2026-10-26T11:00:00.000Z';
  assert.equal(intents.start({ scope: 'p/s/purpose', purpose: 'purpose', action: 'research', label: 'research', input, send: async () => {}, complete: () => {} }), false);
  await tick();
  assert.equal(intents.view('p/s/purpose')?.phase, 'unknown');
  const client: ReconciliationRead = { lookup: async () => ({ state: 'unknown', operation: null, reservationState: null }), operation: async () => { throw new Error('must not read operation'); } };
  await intents.reconcile('p/s/purpose', client);
  assert.equal(intents.view('p/s/purpose')?.phase, 'unknown');
  assert.deepEqual(writes, [{ key: 'key-1', question: 'original', deadline: '2026-10-26T10:00:00.000Z' }]);
});

test('committed lookup reads operation and recovers the exact synchronous write with its original key and input', async () => {
  const sent: Array<{ key: string; value: string }> = [];
  const received: unknown[] = [];
  const intents = new WriteIntents(() => {}, () => 'fixed-key');
  const input = { value: 'first' };
  intents.start({ scope: 'p/s/use', purpose: 'use', action: 'uses:write', label: 'use', input,
    send: async (frozen, key) => { sent.push({ ...frozen, key }); if (sent.length === 1) throw lost(); return { data: { id: 'same-record' } }; },
    complete: result => received.push(result),
  });
  input.value = 'second'; await tick();
  const operation = committedOperation();
  const reads: string[] = [];
  const client: ReconciliationRead = {
    lookup: async (action: string, key: string, purpose: string) => { assert.deepEqual({ action, key, purpose }, { action: 'uses:write', key: 'fixed-key', purpose: 'use' }); return { state: 'committed', operation, reservationState: 'committed' }; },
    operation: async (id: string, purpose: string) => { assert.equal(purpose, 'use'); reads.push(id); return operation; },
  };
  await intents.reconcile('p/s/use', client);
  assert.deepEqual(reads, [OP_ID]);
  assert.deepEqual(sent, [{ key: 'fixed-key', value: 'first' }]);
  assert.equal(intents.view('p/s/use')?.phase, 'committed_needs_result');
  await intents.reconcile('p/s/use', client);
  assert.deepEqual(sent, [{ key: 'fixed-key', value: 'first' }, { key: 'fixed-key', value: 'first' }]);
  assert.deepEqual(received, [{ data: { id: 'same-record' } }]);
  assert.equal(intents.view('p/s/use'), null);
});

test('only a definitive not committed lookup releases the old intent without resending', async () => {
  let sends = 0;
  const received: unknown[] = [];
  const intents = new WriteIntents(() => {}, () => 'fixed-key');
  intents.start({ scope: 'p/s/feedback', purpose: 'feedback', action: 'feedback:write', label: 'feedback', input: { observation: 'fact' },
    send: async () => { sends++; throw lost(); }, complete: result => received.push(result) });
  await tick();
  await intents.reconcile('p/s/feedback', { lookup: async () => ({ state: 'definitively_not_committed', operation: null, reservationState: null }), operation: async () => { throw new Error('must not read operation'); } });
  assert.equal(sends, 1);
  assert.equal(intents.view('p/s/feedback'), null);
  assert.match((received[0] as Error).message, /未提交/);
});

test('different scopes do not receive an unresolved write from the prior scope', async () => {
  const intents = new WriteIntents(() => {}, () => 'key');
  intents.start({ scope: 'old', purpose: 'old', action: 'research', label: 'research', input: {}, send: async () => { throw lost(); }, complete: () => {} });
  await tick();
  assert.equal(intents.view('new'), null);
  assert.equal(intents.view('old')?.phase, 'unknown');
});

test('committed research is recovered from the operation read without another POST', async () => {
  let writes = 0;
  const received: unknown[] = [];
  const intents = new WriteIntents(() => {}, () => 'research-key');
  intents.start({ scope: 'scope', purpose: 'exploration', action: 'research', label: 'research', input: { deadline: 'fixed' },
    send: async () => { writes++; throw lost(); }, complete: result => received.push(result), operationIsResult: true });
  await tick();
  const operation = committedOperation({ state: 'queued', researchId: RESEARCH_ID });
  await intents.reconcile('scope', {
    lookup: async (action, key, purpose) => { assert.deepEqual([action, key, purpose], ['research', 'research-key', 'exploration']); return { state: 'committed', operation, reservationState: 'queued' }; },
    operation: async (id, purpose) => { assert.deepEqual([id, purpose], [OP_ID, 'exploration']); return operation; },
  });
  assert.equal(writes, 1);
  assert.deepEqual(received, [operation]);
  assert.equal(intents.view('scope'), null);
});

test('a lost result replay remains locked and later recovery keeps the same key', async () => {
  const keys: string[] = [];
  const intents = new WriteIntents(() => {}, () => 'one-key');
  intents.start({ scope: 'scope', purpose: 'p', action: 'feedback:write', label: 'feedback', input: { fact: 'frozen' },
    send: async (_input, key) => { keys.push(key); if (keys.length < 3) throw lost(); return { data: { id: 'original' } }; }, complete: () => {} });
  await tick();
  const operation = committedOperation();
  let lookups = 0;
  const reads: ReconciliationRead = { lookup: async () => { lookups++; return { state: 'committed', operation, reservationState: 'committed' }; }, operation: async () => operation };
  await intents.reconcile('scope', reads);
  assert.equal(intents.view('scope')?.phase, 'committed_needs_result');
  assert.deepEqual(keys, ['one-key']);
  assert.equal(intents.start({ scope: 'scope', purpose: 'p', action: 'feedback:write', label: 'feedback', input: {}, send: async () => {}, complete: () => {} }), false);
  await intents.reconcile('scope', reads);
  assert.equal(intents.view('scope')?.phase, 'committed_needs_result');
  await intents.reconcile('scope', reads);
  assert.deepEqual(keys, ['one-key', 'one-key', 'one-key']);
  assert.equal(lookups, 1);
  assert.equal(intents.view('scope'), null);
});

test('cancel reconciles by observed research state when cancellation has no key receipt', async () => {
  let posts = 0;
  const completed: unknown[] = [];
  const intents = new WriteIntents(() => {}, () => 'cancel-key');
  intents.start({ scope: 'scope', purpose: 'exploration', action: 'research:cancel', label: 'cancel', input: { operationId: OP_ID },
    send: async () => { posts++; throw lost(); },
    observe: async (reads, input, purpose) => {
      const operation = await reads.operation(input.operationId, purpose);
      return operation.state === 'cancel_requested' ? { data: { state: operation.state, operationId: operation.id } } : null;
    }, complete: result => completed.push(result) });
  await tick();
  await intents.reconcile('scope', { lookup: async () => ({ state: 'unknown', operation: null, reservationState: null }),
    operation: async (id, purpose) => { assert.deepEqual([id, purpose], [OP_ID, 'exploration']); return committedOperation({ state: 'cancel_requested' }); } });
  assert.equal(posts, 1);
  assert.deepEqual(completed, [{ data: { state: 'cancel_requested', operationId: OP_ID } }]);
  assert.equal(intents.view('scope'), null);
});
