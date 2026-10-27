import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { KnowledgeError } from './types.ts';

type QueryClient = Pick<PoolClient, 'query'>;
/** Server-held capability. Never accept this from HTTP input or persist its token in documents. */
export interface KnowledgeWriterGrant { ownerId: string; generation: number; token: string }
export interface KnowledgeWriterAuthority { ownerId: string; generation: number; mode: 'active' | 'read_only' }
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const invalid = (message: string): never => { throw new KnowledgeError('KNOWLEDGE_WRITER_REVOKED', message, 409); };

/** Called in the same knowledge migration transaction. Triggers also reject an old binary's writes. */
export async function migrateKnowledgeWriterAuthority(client: QueryClient): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS ccl_knowledge_writer_authority (
    project_id text PRIMARY KEY REFERENCES ccl_knowledge_projects(project_id),
    generation bigint NOT NULL CHECK(generation > 0), owner_id text NOT NULL,
    mode text NOT NULL CHECK(mode IN ('active','read_only')), token_hash text NOT NULL
  );
  CREATE OR REPLACE FUNCTION ccl_assert_knowledge_writer() RETURNS trigger LANGUAGE plpgsql AS $guard$
  DECLARE identity text; authority ccl_knowledge_writer_authority%ROWTYPE; grant_value jsonb;
  BEGIN
    identity := CASE WHEN TG_OP='DELETE' THEN OLD.project_id ELSE NEW.project_id END;
    IF TG_OP='UPDATE' AND OLD.project_id IS DISTINCT FROM NEW.project_id THEN
      RAISE EXCEPTION 'KNOWLEDGE_PROJECT_IMMUTABLE' USING ERRCODE='42501';
    END IF;
    PERFORM 1 FROM ccl_knowledge_projects WHERE project_id=identity FOR UPDATE;
    SELECT * INTO authority FROM ccl_knowledge_writer_authority WHERE project_id=identity;
    IF FOUND THEN
      BEGIN grant_value := NULLIF(current_setting('ccl.knowledge_writer_grant',true),'')::jsonb;
      EXCEPTION WHEN OTHERS THEN grant_value := NULL; END;
      IF authority.mode <> 'active' OR grant_value IS NULL
        OR grant_value->>'ownerId' IS DISTINCT FROM authority.owner_id
        OR grant_value->>'generation' IS DISTINCT FROM authority.generation::text
        OR encode(sha256(convert_to(COALESCE(grant_value->>'token',''),'UTF8')),'hex') IS DISTINCT FROM authority.token_hash THEN
        RAISE EXCEPTION 'KNOWLEDGE_WRITER_REVOKED: knowledge writer capability is absent or revoked' USING ERRCODE='42501';
      END IF;
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END $guard$;`);
  // Every stored knowledge authority mutation, including legacy direct store.publish, is fenced.
  // Explicit DB roles/ACL and prevention of privileged DDL bypass remain a deployment prerequisite.
  for (const table of ['changesets','revisions','reviews','publications','heads','deps','invalidities','events']) {
    const name = `ccl_knowledge_${table}`;
    await client.query(`DROP TRIGGER IF EXISTS ccl_writer_guard ON ${name};
      CREATE TRIGGER ccl_writer_guard BEFORE INSERT OR UPDATE OR DELETE ON ${name}
      FOR EACH ROW EXECUTE FUNCTION ccl_assert_knowledge_writer()`);
  }
  await client.query(`DROP TRIGGER IF EXISTS ccl_writer_guard ON ccl_knowledge_projects;
    CREATE TRIGGER ccl_writer_guard BEFORE UPDATE OF epoch ON ccl_knowledge_projects
    FOR EACH ROW EXECUTE FUNCTION ccl_assert_knowledge_writer()`);
}

/** Must run inside the caller's BEGIN/COMMIT and before publication or operation finalization. */
export async function assertKnowledgeWriterAuthority(client: QueryClient, projectId: string,
  grant?: KnowledgeWriterGrant): Promise<void> {
  await client.query('INSERT INTO ccl_knowledge_projects(project_id) VALUES($1) ON CONFLICT DO NOTHING',[projectId]);
  await client.query('SELECT 1 FROM ccl_knowledge_projects WHERE project_id=$1 FOR UPDATE',[projectId]);
  const rows = await client.query<{generation: string;owner_id:string;mode:string;token_hash:string}>(
    'SELECT generation,owner_id,mode,token_hash FROM ccl_knowledge_writer_authority WHERE project_id=$1',[projectId]);
  const authority=rows.rows[0];
  if (grant && !authority) invalid('Explicit writer capability requires activated project authority');
  if (authority && (!grant || authority.mode!=='active' || authority.owner_id!==grant.ownerId ||
      Number(authority.generation)!==grant.generation || authority.token_hash!==hash(grant.token)))
    invalid('Knowledge writer capability is absent or revoked');
  // Always reset the transaction-local value: a pooled connection cannot retain an earlier grant.
  await client.query("SELECT set_config('ccl.knowledge_writer_grant',$1,true)",[grant ? JSON.stringify(grant) : '']);
}

/** Trusted local operator operation; not exposed by knowledge HTTP capabilities. CAS never resets generations. */
export async function rotateKnowledgeWriterAuthority(pool: Pool, projectId: string,
  expectedGeneration: number | null, next: {ownerId:string;mode:'active'|'read_only'},
  previousGrant?: KnowledgeWriterGrant): Promise<KnowledgeWriterGrant> {
  if (!next.ownerId.trim() || next.ownerId.length>200 || !['active','read_only'].includes(next.mode))
    throw new KnowledgeError('WRITER_AUTHORITY_INPUT','Explicit writer identity and mode required',422);
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO ccl_knowledge_projects(project_id) VALUES($1) ON CONFLICT DO NOTHING',[projectId]);
    await client.query('SELECT 1 FROM ccl_knowledge_projects WHERE project_id=$1 FOR UPDATE',[projectId]);
    const prior=(await client.query<{generation:string;owner_id:string;token_hash:string}>(
      'SELECT generation,owner_id,token_hash FROM ccl_knowledge_writer_authority WHERE project_id=$1',[projectId])).rows[0];
    if ((prior?Number(prior.generation):null)!==expectedGeneration)
      throw new KnowledgeError('WRITER_AUTHORITY_CAS','Writer authority generation changed',409);
    if (prior && (!previousGrant || previousGrant.generation!==Number(prior.generation) ||
      previousGrant.ownerId!==prior.owner_id || hash(previousGrant.token)!==prior.token_hash))
      invalid('Current owner capability required for authority rotation');
    const grant={ownerId:next.ownerId,generation:(expectedGeneration??0)+1,token:randomBytes(32).toString('hex')};
    await client.query(`INSERT INTO ccl_knowledge_writer_authority(project_id,generation,owner_id,mode,token_hash)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(project_id) DO UPDATE
      SET generation=EXCLUDED.generation,owner_id=EXCLUDED.owner_id,mode=EXCLUDED.mode,token_hash=EXCLUDED.token_hash`,
      [projectId,grant.generation,grant.ownerId,next.mode,hash(grant.token)]);
    await client.query('COMMIT');return grant;
  } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
}
