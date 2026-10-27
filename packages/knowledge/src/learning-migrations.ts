import type { Pool } from 'pg';

/** Additive, project-scoped learning ledger. Safe to rerun. */
export async function migrateKnowledgeLearning(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS ccl_learning_topics (
        project_id text NOT NULL, id text NOT NULL, question_key text NOT NULL,
        payload jsonb NOT NULL, PRIMARY KEY(project_id,id), UNIQUE(project_id,question_key)
      );
      CREATE TABLE IF NOT EXISTS ccl_learning_topic_history (
        project_id text NOT NULL, topic_id text NOT NULL, version integer NOT NULL,
        reason text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY(project_id,topic_id,version)
      );
      CREATE TABLE IF NOT EXISTS ccl_learning_topic_relations (
        project_id text NOT NULL, id text NOT NULL, payload jsonb NOT NULL,
        PRIMARY KEY(project_id,id)
      );
      CREATE TABLE IF NOT EXISTS ccl_learning_memberships (
        project_id text NOT NULL, member_key text NOT NULL, id text NOT NULL,
        source_key text NOT NULL, topic_id text, payload jsonb NOT NULL,
        PRIMARY KEY(project_id,member_key), UNIQUE(project_id,id)
      );
      CREATE INDEX IF NOT EXISTS ccl_learning_memberships_source_idx
        ON ccl_learning_memberships(project_id,source_key);
      CREATE INDEX IF NOT EXISTS ccl_learning_memberships_topic_page_idx
        ON ccl_learning_memberships(project_id,topic_id,id);
      CREATE TABLE IF NOT EXISTS ccl_learning_membership_history (
        project_id text NOT NULL, member_key text NOT NULL, version integer NOT NULL,
        payload jsonb NOT NULL, PRIMARY KEY(project_id,member_key,version)
      );
      CREATE TABLE IF NOT EXISTS ccl_learning_events (
        sequence bigserial PRIMARY KEY, project_id text NOT NULL, event_key text NOT NULL,
        payload jsonb NOT NULL, UNIQUE(project_id,event_key)
      );
      CREATE TABLE IF NOT EXISTS ccl_learning_dirty (
        project_id text NOT NULL, topic_id text NOT NULL, latest_sequence bigint NOT NULL DEFAULT 0,
        processed_sequence bigint NOT NULL DEFAULT 0, PRIMARY KEY(project_id,topic_id)
      );
      CREATE TABLE IF NOT EXISTS ccl_learning_event_topics (
        project_id text NOT NULL, sequence bigint NOT NULL, topic_id text NOT NULL,
        PRIMARY KEY(project_id,sequence,topic_id)
      );
      CREATE TABLE IF NOT EXISTS ccl_learning_builds (
        project_id text NOT NULL, id text NOT NULL, topic_id text NOT NULL,
        through_sequence bigint NOT NULL, manifest_hash text NOT NULL,
        payload jsonb NOT NULL, PRIMARY KEY(project_id,id),
        UNIQUE(project_id,topic_id,through_sequence,manifest_hash)
      );
      CREATE INDEX IF NOT EXISTS ccl_learning_builds_topic_idx
        ON ccl_learning_builds(project_id,topic_id,through_sequence DESC);
      CREATE INDEX IF NOT EXISTS ccl_learning_builds_batch_finish_idx
        ON ccl_learning_builds(project_id,topic_id,(payload->>'finishedAt') DESC)
        WHERE payload->'manifest'->'batch' IS NOT NULL AND payload->>'outcome' IN ('changed','no_change');
      CREATE TABLE IF NOT EXISTS ccl_learning_report_coverage (
        project_id text NOT NULL,topic_id text NOT NULL,
        report_object_id text NOT NULL,report_version_id text NOT NULL,
        processing_fingerprint text NOT NULL,accepted_build_id text NOT NULL,
        published_ref jsonb,accepted_at timestamptz NOT NULL,
        PRIMARY KEY(project_id,topic_id,report_object_id,report_version_id)
      );
      CREATE INDEX IF NOT EXISTS ccl_learning_report_coverage_build_idx
        ON ccl_learning_report_coverage(project_id,topic_id,accepted_build_id);
      CREATE TABLE IF NOT EXISTS ccl_learning_needs (
        project_id text NOT NULL, id text NOT NULL, topic_id text,
        payload jsonb NOT NULL, PRIMARY KEY(project_id,id)
      );
      CREATE TABLE IF NOT EXISTS ccl_learning_need_history (
        project_id text NOT NULL, need_id text NOT NULL, version integer NOT NULL,
        payload jsonb NOT NULL, PRIMARY KEY(project_id,need_id,version)
      );
      CREATE TABLE IF NOT EXISTS ccl_learning_requests (
        project_id text NOT NULL, id text NOT NULL, need_id text NOT NULL,
        request_key text NOT NULL, payload jsonb NOT NULL,
        PRIMARY KEY(project_id,id), UNIQUE(project_id,request_key)
      );
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
