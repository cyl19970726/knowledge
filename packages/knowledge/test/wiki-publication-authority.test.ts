import { readTestDatabase } from '../../../scripts/runtime/test-database.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrateKnowledge } from '../src/migrations.ts';
import {
  assertPublicationPermit, capturePublicationPermit, matchPublicationScopes,
  migratePublicationAuthority, setPublicationAuthorityScope,
  type PublicationAuthorityScopeV1, type PublicationScopeFacts,
} from '../src/wiki-publication-authority.ts';

const facts = (overrides: Partial<PublicationScopeFacts> = {}): PublicationScopeFacts => ({
  topicIds: [], sourceObjectIds: [], sourceGroups: [], targetObjectIds: [], knowledgeObjectIds: [], ...overrides,
});
const scope = (scopeId: string, overrides: Partial<Omit<PublicationAuthorityScopeV1, 'generation'>> = {}) => ({
  scopeId, mode: 'active' as const, allowedMethodVersions: ['new-method-v1'],
  topicIds: [], sourceObjectIds: [], sourceGroups: [], targetObjectIds: [], ...overrides,
});

test('matching covers changed target IDs, source dependencies, old binding absence, and overlapping scopes', () => {
  const scopes: PublicationAuthorityScopeV1[] = [
    { ...scope('topic', { topicIds: ['topic-a'] }), generation: 1 },
    { ...scope('source', { sourceObjectIds: ['source-a'] }), generation: 3 },
    { ...scope('group', { sourceGroups: ['media-sha256:a'] }), generation: 2 },
    { ...scope('target', { targetObjectIds: ['old-object'] }), generation: 1 },
  ];
  const config = { scopes };
  assert.deepEqual(matchPublicationScopes(config, facts({ targetObjectIds: ['unrelated'] })), []);
  assert.deepEqual(matchPublicationScopes(config, facts({ targetObjectIds: ['new-object'], sourceObjectIds: ['source-a'] }))
    .map(item => item.scopeId), ['source']);
  assert.deepEqual(matchPublicationScopes(config, facts({ targetObjectIds: ['new-object'], knowledgeObjectIds: ['old-object'] }))
    .map(item => item.scopeId), ['target']);
  assert.deepEqual(matchPublicationScopes(config, facts({ targetObjectIds: ['new-object'], topicIds: ['topic-a'],
    sourceGroups: ['media-sha256:a'], sourceObjectIds: ['source-a'] })).map(item => item.scopeId),
  ['topic', 'source', 'group']);
});

const connectionString = readTestDatabase();
const dbTest = connectionString ? test : test.skip;

dbTest('frozen permits, generation switches, overlap, and read-only mode share the project publication lock',
  { timeout: 60_000 }, async () => {
    const admin = new pg.Pool({ connectionString, max: 2 });
    const schema = `ccl_wiki_authority_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({ connectionString, max: 5, options: `-c search_path=${schema}` });
    const projectId = randomUUID();
    try {
      await migrateKnowledge(pool);
      await migratePublicationAuthority(pool);
      await migratePublicationAuthority(pool);
      const touched = facts({ sourceObjectIds: ['source-a'], sourceGroups: ['group-a'], targetObjectIds: ['new-object'] });
      const untouched = facts({ targetObjectIds: ['elsewhere'] });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await assertPublicationPermit(client, projectId, untouched, 'legacy-method', undefined);
        await client.query('COMMIT');
      } finally { client.release(); }

      const first = await setPublicationAuthorityScope(pool, projectId, null,
        scope('source-scope', { sourceObjectIds: ['source-a'] }));
      const second = await setPublicationAuthorityScope(pool, projectId, null,
        scope('group-scope', { sourceGroups: ['group-a'] }));
      assert.equal(first.generation, 1);
      assert.equal(second.generation, 1);
      assert.equal(await capturePublicationPermit(pool, projectId, untouched, 'legacy-method'), null);
      await assert.rejects(capturePublicationPermit(pool, projectId, touched, 'legacy-method'),
        /does not allow this method/);
      const oldPermit = await capturePublicationPermit(pool, projectId, touched, 'new-method-v1');
  assert.deepEqual(oldPermit?.grants.map(item => item.scopeId), ['source-scope', 'group-scope']);
  assert.equal(oldPermit?.schemaVersion, 'wiki-publication-permit@1');
  assert.equal(oldPermit?.projectId, projectId);

      const checked = await pool.connect();
      try {
        await checked.query('BEGIN');
        await assert.rejects(assertPublicationPermit(checked, projectId, touched, 'new-method-v1', null),
          /frozen publication permit/);
        await assert.rejects(assertPublicationPermit(checked, projectId, touched, 'new-method-v1',
          { ...oldPermit!, grants: oldPermit!.grants.slice(0, 1) }), /frozen publication permit/);
        await assertPublicationPermit(checked, projectId, touched, 'new-method-v1', oldPermit);
        await checked.query('COMMIT');
      } finally { checked.release(); }

      const blocking = await pool.connect();
      try {
        await blocking.query('BEGIN');
        await blocking.query('SELECT 1 FROM ccl_knowledge_projects WHERE project_id=$1 FOR UPDATE', [projectId]);
        let switched = false;
        const pending = setPublicationAuthorityScope(pool, projectId, 1,
          scope('source-scope', { sourceObjectIds: ['source-a'] })).then(value => { switched = true; return value; });
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(switched, false, 'switch waits for an in-flight publication project lock');
        await blocking.query('COMMIT');
        assert.equal((await pending).generation, 2);
      } finally { blocking.release(); }

      const afterSwitch = await pool.connect();
      try {
        await afterSwitch.query('BEGIN');
        await assert.rejects(assertPublicationPermit(afterSwitch, projectId, touched, 'new-method-v1', oldPermit),
          /no longer authorizes/);
        await afterSwitch.query('ROLLBACK');
      } finally { afterSwitch.release(); }
      const freshPermit = await capturePublicationPermit(pool, projectId, touched, 'new-method-v1');
      await setPublicationAuthorityScope(pool, projectId, 2,
        scope('source-scope', { sourceObjectIds: ['source-a'], mode: 'read_only' }));
      await assert.rejects(capturePublicationPermit(pool, projectId, touched, 'new-method-v1'), /read-only/);
      const stopped = await pool.connect();
      try {
        await stopped.query('BEGIN');
        await assert.rejects(assertPublicationPermit(stopped, projectId, touched, 'new-method-v1', freshPermit),
          /no longer authorizes/);
        await stopped.query('ROLLBACK');
      } finally { stopped.release(); }
      const unchanged = await pool.query<{ epoch: string }>(
        'SELECT epoch FROM ccl_knowledge_projects WHERE project_id=$1', [projectId]);
      assert.equal(Number(unchanged.rows[0].epoch), 0, 'configuration switches never advance knowledge epoch');
      assert.equal((await pool.query('SELECT 1 FROM ccl_knowledge_heads WHERE project_id=$1', [projectId])).rowCount, 0);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  });
