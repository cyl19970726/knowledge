import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {promisify} from 'node:util';
import pg from 'pg';
import {readTestDatabase} from './test-database.mjs';
import {seedKnowledgeSyntheticFixture} from './knowledge-synthetic-fixture.ts';
import {createKnowledgeApi} from '../../apps/knowledge-api/src/index.ts';
import {createKnowledgeClient, KnowledgeClientError} from '../../packages/knowledge-client/src/index.ts';
import {createDocumentKnowledgeAdapter} from '../../packages/adapters/knowledge-document/src/index.ts';
import type {FeedbackInput, UseInput} from '../../packages/knowledge-contracts/src/index.ts';

const execute = promisify(execFile);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const cost = {
  modelCalls: {state: 'unknown' as const, reason: 'not measured'},
  tokens: {state: 'unknown' as const, reason: 'not measured'},
  money: {state: 'unknown' as const, reason: 'not measured'},
};
const errorCode = (code: string) => (error: unknown) => error instanceof KnowledgeClientError && error.code === code;
const url = readTestDatabase({...process.env, TEST_DATABASE_REQUIRED: '1'}, {required: true});
const admin = new pg.Pool({connectionString: url, max: 2});
const schema = `ccl_document_onboarding_${randomUUID().replaceAll('-', '')}`;
await admin.query(`CREATE SCHEMA "${schema}"`);
const pool = new pg.Pool({connectionString: url, max: 8, options: `-c search_path=${schema}`});
let server: import('node:http').Server | undefined;
let cleaned = false;

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  await new Promise<void>(done => server?.close(() => done()) ?? done());
  await pool.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
}

try {
  const seed = await seedKnowledgeSyntheticFixture(pool);
  const token = `document-onboarding-${randomUUID()}-${randomUUID()}`;
  const api = await createKnowledgeApi({pool, token, principal: seed.principal, capabilities: seed.authorization, writerGrant: seed.writerGrant, port: 0});
  server = await api.listen();
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = createKnowledgeClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    scope: {projectId: seed.projectId, spaceId: seed.spaceId},
    headers: {Authorization: `Bearer ${token}`},
  });
  const documents = createDocumentKnowledgeAdapter(client);
  const [text, version] = await Promise.all([
    readFile('AGENTS.md', 'utf8'),
    execute('git', ['rev-parse', 'HEAD']).then(result => result.stdout.trim()),
  ]);
  const digest = sha(text);
  const contribution = {
    externalId: 'repo:AGENTS.md', version, text,
    author: null, publisher: 'cyl19970726', acquirer: 'document-onboarding-demo',
    obtainedAt: new Date().toISOString(), rightsPolicyRef: 'synthetic-local-only',
    expectedSourceHead: null,
    sourceGroups: [{id: `repo:${version}`, status: 'known' as const, authority: 'git'}],
    limitations: ['Public repository document; task and feedback are synthetic'],
  };
  const key = `document-onboarding:${version}`;
  const [first, replay] = await Promise.all([
    documents.contribute(contribution, {idempotencyKey: key}),
    documents.contribute(contribution, {idempotencyKey: key}),
  ]);
  assert.deepEqual(replay.data.ref, first.data.ref);
  assert.equal(first.data.ref.contentDigest, digest);
  const record = await client.source(first.data.ref, 'exploration_reading');
  assert.equal(record.data.provenance?.externalIdentity.externalVersion, version);
  assert.equal(record.data.provenance?.publisher, 'cyl19970726');
  assert.equal('text' in record.data.provenance!.custody, false);
  const original = await client.sourceContent(first.data.ref, 'exploration_reading');
  assert.equal(original.data.content, text, 'the exact public document bytes must round-trip');
  assert.equal(original.data.contentDigest, digest);
  assert.equal(original.data.actualCoverage.byteCount, Buffer.byteLength(text));
  const operation = await client.lookupOperation({purpose: 'exploration_reading', operation: 'sources:upsert', key});
  assert.equal(operation.data.state, 'committed');

  const query = await documents.query({question: '合成', purpose: 'exploration_reading', limit: 10});
  assert.ok(query.data.items.length >= 2);
  const refs = query.data.items.slice(0, 2).map(item => item.ref);
  const receipt = await client.receipt(query.data.readReceiptId);
  const context = documents.context(`document-onboarding:${version}`, version, sha(`document-onboarding:${version}`), 'Synthetic task using a real public document');
  const useInput: UseInput = {
    context, readReceiptId: receipt.data.id, purpose: 'exploration_reading',
    considered: [
      {ref: refs[0], decision: 'adopted', reason: 'Synthetic task choice only', before: null, after: null},
      {ref: refs[1], decision: 'deferred', reason: 'Synthetic task needs more evidence', before: null, after: null},
    ],
    gaps: ['No real business outcome is observed'], cost,
  };
  const useKey = `document-use:${version}`;
  const [use, useReplay] = await Promise.all([
    documents.use(useInput, {idempotencyKey: useKey}),
    documents.use(useInput, {idempotencyKey: useKey}),
  ]);
  assert.equal(useReplay.data.id, use.data.id);
  assert.equal(use.data.snapshot.id, receipt.data.id);
  const feedback: FeedbackInput = {
    purpose: 'exploration_reading', useId: use.data.id, context, knowledgeRefs: [refs[0]],
    feedbackKey: `document-feedback:${version}`, status: 'observed', observedAt: new Date().toISOString(),
    observation: 'Synthetic operator observed the demo output.',
    rawQuotation: 'Synthetic demo observation', interpretation: 'Engineering evidence only.',
    recommendation: 'Evaluate a real business separately.', artifactDigest: null,
    measurementScope: 'One synthetic operator run', cost, gaps: ['No real business outcome is observed'],
  };
  const feedbackRecord = await documents.feedback(feedback, {idempotencyKey: `document-feedback:${version}`});
  assert.equal(feedbackRecord.data.observation, 'Synthetic operator observed the demo output.');

  await client.revokeSource(first.data.ref, {contentDigest: first.data.ref.contentDigest, expectedGeneration: 1}, {idempotencyKey: `document-revoke:${version}`});
  await assert.rejects(client.sourceContent(first.data.ref, 'exploration_reading'), errorCode('SOURCE_UNREADABLE'));
  const evidence = {
    document: {path: 'AGENTS.md', version, digest, byteCount: Buffer.byteLength(text)},
    sourceRef: first.data.ref,
    query: {count: query.data.items.length, readReceiptId: receipt.data.id},
    use: {id: use.data.id, replayedSameId: useReplay.data.id === use.data.id},
    feedback: {id: feedbackRecord.data.id, synthetic: true},
    revoked: true,
    schemaDropped: true,
    boundary: 'Real public document bytes with synthetic task and feedback; no business-effect acceptance',
  };
  await cleanup();
  const output = resolve('local/document-onboarding');
  await mkdir(output, {recursive: true});
  await writeFile(resolve(output, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
} finally {
  await cleanup();
}
