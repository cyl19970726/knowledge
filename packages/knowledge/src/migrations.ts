import type { Pool } from 'pg';
import { migrateKnowledgeWriterAuthority } from './writer-authority.ts';
import { migratePublicationAuthority } from './wiki-publication-authority.ts';

/** Additive, idempotent knowledge storage. All records are project scoped. */
export async function migrateKnowledge(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS ccl_knowledge_projects (
        project_id text PRIMARY KEY, epoch bigint NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS ccl_knowledge_changesets (
        project_id text NOT NULL, id text NOT NULL, request_key text NOT NULL,
        request_hash text NOT NULL, content_hash text NOT NULL, payload jsonb NOT NULL,
        PRIMARY KEY(project_id,id), UNIQUE(project_id,request_key)
      );
      CREATE TABLE IF NOT EXISTS ccl_knowledge_revisions (
        project_id text NOT NULL, object_id text NOT NULL, version_id text NOT NULL,
        changeset_id text NOT NULL, kind text NOT NULL, title text NOT NULL,
        body text NOT NULL, payload jsonb NOT NULL, published_at timestamptz,
        PRIMARY KEY(project_id,object_id,version_id),
        UNIQUE(project_id,version_id),
        FOREIGN KEY(project_id,changeset_id) REFERENCES ccl_knowledge_changesets(project_id,id)
      );
      CREATE TABLE IF NOT EXISTS ccl_knowledge_reviews (
        project_id text NOT NULL, id text NOT NULL, changeset_id text NOT NULL,
        content_hash text NOT NULL, recorded_seq bigserial UNIQUE, payload jsonb NOT NULL,
        PRIMARY KEY(project_id,id),
        FOREIGN KEY(project_id,changeset_id) REFERENCES ccl_knowledge_changesets(project_id,id)
      );
      CREATE TABLE IF NOT EXISTS ccl_knowledge_publications (
        project_id text NOT NULL, changeset_id text NOT NULL, review_id text NOT NULL, payload jsonb NOT NULL,
        PRIMARY KEY(project_id,changeset_id),
        FOREIGN KEY(project_id,changeset_id) REFERENCES ccl_knowledge_changesets(project_id,id)
      );
      CREATE TABLE IF NOT EXISTS ccl_knowledge_heads (
        project_id text NOT NULL, object_id text NOT NULL, version_id text NOT NULL,
        PRIMARY KEY(project_id,object_id),
        FOREIGN KEY(project_id,object_id,version_id) REFERENCES ccl_knowledge_revisions(project_id,object_id,version_id)
      );
      CREATE TABLE IF NOT EXISTS ccl_knowledge_deps (
        project_id text NOT NULL, object_id text NOT NULL, version_id text NOT NULL,
        domain text NOT NULL, dep_object_id text NOT NULL, dep_version_id text NOT NULL,
        role text NOT NULL, critical boolean NOT NULL,
        PRIMARY KEY(project_id,object_id,version_id,domain,dep_object_id,dep_version_id,role),
        FOREIGN KEY(project_id,object_id,version_id) REFERENCES ccl_knowledge_revisions(project_id,object_id,version_id)
      );
      CREATE INDEX IF NOT EXISTS ccl_knowledge_deps_reverse_idx
        ON ccl_knowledge_deps(project_id,domain,dep_object_id,dep_version_id);
      CREATE TABLE IF NOT EXISTS ccl_knowledge_invalidities (
        project_id text NOT NULL, domain text NOT NULL, object_id text NOT NULL,
        version_id text NOT NULL, reason text NOT NULL, state text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(project_id,domain,object_id,version_id,reason,state)
      );
      CREATE TABLE IF NOT EXISTS ccl_knowledge_events (
        sequence bigserial PRIMARY KEY, project_id text NOT NULL, kind text NOT NULL,
        data jsonb NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS ccl_knowledge_events_project_idx
        ON ccl_knowledge_events(project_id,sequence);
      CREATE INDEX IF NOT EXISTS ccl_knowledge_revisions_search_idx
        ON ccl_knowledge_revisions(project_id,kind,published_at);
    `);
    await migratePublicationAuthority(client);
    await migrateKnowledgeWriterAuthority(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
