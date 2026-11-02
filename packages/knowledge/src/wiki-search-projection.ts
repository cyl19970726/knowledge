import type {Pool,PoolClient} from 'pg';
import {KnowledgeError} from './types.ts';
import {assertKnowledgeWriterAuthority,type KnowledgeWriterGrant} from './writer-authority.ts';

const FORMAT='wiki-bigram-v1' as const;
type Db=Pick<PoolClient,'query'>;
export interface WikiSearchProjectionStatus {
  formatVersion:typeof FORMAT;ready:boolean;complete:boolean;lastObjectId:string|null;
  scanned:number;blockedRows:number;updatedAt:string;
}
type ScopeRow={format_version:string;ready:boolean;complete:boolean;last_object_id:string|null;
  scanned:string;blocked_rows:string;updated_at:Date};
export class WikiSearchProjectionCommitUnknownError extends KnowledgeError {
  readonly commitStatus='unknown';
  constructor(readonly projectId:string,readonly spaceId:string){super('COMMIT_OUTCOME_UNKNOWN',
    'Wiki search projection commit is uncertain; inspect scope status before another batch',503);}
}

/** Called after migrateKnowledgeWriterAuthority, inside the caller's migration transaction. */
export async function migrateWikiSearchProjection(client:Db):Promise<void>{
  await client.query(`CREATE TABLE IF NOT EXISTS ccl_knowledge_wiki_search_heads (
    project_id text NOT NULL,space_id text NOT NULL,object_id text NOT NULL,version_id text NOT NULL,
    format_version text NOT NULL,grams_v1 text[] NOT NULL,grams_v2 text[] NOT NULL,
    indexable boolean NOT NULL,
    PRIMARY KEY(project_id,object_id));
    CREATE INDEX IF NOT EXISTS ccl_wiki_search_v1_gin
      ON ccl_knowledge_wiki_search_heads USING gin (grams_v1 array_ops);
    CREATE INDEX IF NOT EXISTS ccl_wiki_search_v2_gin
      ON ccl_knowledge_wiki_search_heads USING gin (grams_v2 array_ops);
    CREATE TABLE IF NOT EXISTS ccl_knowledge_wiki_search_scopes (
      project_id text NOT NULL,space_id text NOT NULL,format_version text NOT NULL,
      ready boolean NOT NULL DEFAULT false,complete boolean NOT NULL DEFAULT false,
      last_object_id text,scanned bigint NOT NULL DEFAULT 0,blocked_rows bigint NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(project_id,space_id));`);
  await client.query(`CREATE OR REPLACE FUNCTION ccl_wiki_search_bigrams(raw_term text)
    RETURNS text[] LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $fn$
      SELECT COALESCE(array_agg(gram ORDER BY gram),'{}'::text[]) FROM (
        SELECT DISTINCT substr(raw_term,n,2) AS gram
        FROM generate_series(1,greatest(char_length(raw_term)-1,0)) AS n
      ) g
    $fn$;`);
  await client.query(`CREATE OR REPLACE FUNCTION ccl_wiki_search_adjust_scope(
      p_project text,p_space text,p_blocked_delta bigint) RETURNS void LANGUAGE plpgsql AS $fn$
    DECLARE inserted integer;
    BEGIN
      INSERT INTO ccl_knowledge_wiki_search_scopes
        (project_id,space_id,format_version,ready,complete,blocked_rows)
      VALUES (p_project,p_space,'${FORMAT}',false,false,0) ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS inserted=ROW_COUNT;
      IF inserted=1 THEN
        UPDATE ccl_knowledge_wiki_search_scopes s SET blocked_rows=(
          SELECT count(*) FROM ccl_knowledge_wiki_search_heads h
          WHERE h.project_id=p_project AND h.space_id=p_space AND NOT h.indexable),
          updated_at=clock_timestamp()
        WHERE s.project_id=p_project AND s.space_id=p_space;
      ELSIF p_blocked_delta=0 AND EXISTS(SELECT 1 FROM ccl_knowledge_wiki_search_scopes
        WHERE project_id=p_project AND space_id=p_space AND format_version='${FORMAT}') THEN
        -- Per-head writes keep the derived row current. A zero change to coverage
        -- must not create thousands of versions of the same scope row in a batch.
        RETURN;
      ELSE
        UPDATE ccl_knowledge_wiki_search_scopes SET
          blocked_rows=greatest(0,blocked_rows+p_blocked_delta),
          ready=ready AND blocked_rows+p_blocked_delta<=0 AND format_version='${FORMAT}',
          complete=complete AND blocked_rows+p_blocked_delta<=0 AND format_version='${FORMAT}',
          updated_at=clock_timestamp()
        WHERE project_id=p_project AND space_id=p_space;
      END IF;
    END $fn$;`);
  await client.query(`CREATE OR REPLACE FUNCTION ccl_wiki_search_invalidate_scope(
      p_project text,p_space text) RETURNS void LANGUAGE plpgsql AS $fn$
    BEGIN
      INSERT INTO ccl_knowledge_wiki_search_scopes
        (project_id,space_id,format_version,ready,complete,last_object_id,scanned,blocked_rows)
      SELECT p_project,p_space,'${FORMAT}',false,false,NULL,0,count(*)
      FROM ccl_knowledge_wiki_search_heads
      WHERE project_id=p_project AND space_id=p_space AND NOT indexable
      ON CONFLICT(project_id,space_id) DO UPDATE SET ready=false,complete=false,
        last_object_id=NULL,scanned=0,blocked_rows=EXCLUDED.blocked_rows,
        updated_at=clock_timestamp();
    END $fn$;`);
  await client.query(`CREATE OR REPLACE FUNCTION ccl_wiki_search_projection_mutated()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF current_setting('ccl.wiki_search_internal',true)='1' THEN RETURN NULL; END IF;
      IF TG_OP='INSERT' THEN
        PERFORM ccl_wiki_search_invalidate_scope(NEW.project_id,NEW.space_id);
      ELSIF TG_OP='DELETE' THEN
        PERFORM ccl_wiki_search_invalidate_scope(OLD.project_id,OLD.space_id);
      ELSE
        IF OLD.project_id IS DISTINCT FROM NEW.project_id OR OLD.space_id IS DISTINCT FROM NEW.space_id THEN
          PERFORM ccl_wiki_search_invalidate_scope(OLD.project_id,OLD.space_id);
        END IF;
        PERFORM ccl_wiki_search_invalidate_scope(NEW.project_id,NEW.space_id);
      END IF;
      RETURN NULL;
    END $fn$;`);
  await client.query(`CREATE OR REPLACE FUNCTION ccl_wiki_search_refresh_head(
      p_project text,p_object text) RETURNS void LANGUAGE plpgsql AS $fn$
    DECLARE old_space text;old_blocked integer:=0;new_space text;new_blocked integer:=0;
      row_kind text;title_norm text;body_norm text;key_norm text;alias_json jsonb;
      alias_bytes bigint;total_bytes bigint;v1 text[];v2 text[];new_version text;
      previous_flag text;
    BEGIN
      SELECT space_id,CASE WHEN indexable THEN 0 ELSE 1 END
        INTO old_space,old_blocked FROM ccl_knowledge_wiki_search_heads
        WHERE project_id=p_project AND object_id=p_object;
      SELECT r.kind,r.version_id,COALESCE(r.payload->'binding'->>'spaceId','legacy:knowledge'),
        lower(normalize(r.title,NFKC)),lower(normalize(r.body,NFKC)),
        lower(normalize(COALESCE(r.payload->'content'->'identity'->>'key',''),NFKC)),
        CASE WHEN jsonb_typeof(r.payload->'content'->'identity'->'aliases')='array'
          THEN r.payload->'content'->'identity'->'aliases' ELSE '[]'::jsonb END
      INTO row_kind,new_version,new_space,title_norm,body_norm,key_norm,alias_json
      FROM ccl_knowledge_heads h JOIN ccl_knowledge_revisions r
        ON r.project_id=h.project_id AND r.object_id=h.object_id AND r.version_id=h.version_id
      WHERE h.project_id=p_project AND h.object_id=p_object;
      previous_flag:=current_setting('ccl.wiki_search_internal',true);
      PERFORM set_config('ccl.wiki_search_internal','1',true);
      IF FOUND AND row_kind='wiki_page' THEN
        SELECT COALESCE(sum(octet_length(lower(normalize(a.value,NFKC)))),0)
          INTO alias_bytes FROM jsonb_array_elements_text(alias_json) AS a(value)
          WHERE a.value IS NOT NULL;
        total_bytes:=octet_length(title_norm)+octet_length(body_norm)+
          octet_length(key_norm)+alias_bytes;
        new_blocked:=CASE WHEN total_bytes>200000 THEN 1 ELSE 0 END;
        IF new_blocked=0 THEN
          SELECT ARRAY(SELECT gram FROM (
            SELECT unnest(ccl_wiki_search_bigrams(title_norm)) AS gram
            UNION SELECT unnest(ccl_wiki_search_bigrams(body_norm)) AS gram
          ) g ORDER BY gram) INTO v1;
          SELECT ARRAY(SELECT gram FROM (
            SELECT unnest(v1) AS gram
            UNION SELECT unnest(ccl_wiki_search_bigrams(key_norm)) AS gram
            UNION SELECT unnest(ccl_wiki_search_bigrams(lower(normalize(a.value,NFKC)))) AS gram
              FROM jsonb_array_elements_text(alias_json) AS a(value) WHERE a.value IS NOT NULL
          ) g ORDER BY gram) INTO v2;
        ELSE v1:='{}'::text[];v2:='{}'::text[];END IF;
        INSERT INTO ccl_knowledge_wiki_search_heads
          (project_id,space_id,object_id,version_id,format_version,grams_v1,grams_v2,indexable)
        VALUES(p_project,new_space,p_object,new_version,'${FORMAT}',v1,v2,new_blocked=0)
        ON CONFLICT(project_id,object_id) DO UPDATE SET
          space_id=EXCLUDED.space_id,version_id=EXCLUDED.version_id,
          format_version=EXCLUDED.format_version,grams_v1=EXCLUDED.grams_v1,
          grams_v2=EXCLUDED.grams_v2,indexable=EXCLUDED.indexable
        WHERE (ccl_knowledge_wiki_search_heads.space_id,ccl_knowledge_wiki_search_heads.version_id,
          ccl_knowledge_wiki_search_heads.format_version,ccl_knowledge_wiki_search_heads.grams_v1,
          ccl_knowledge_wiki_search_heads.grams_v2,ccl_knowledge_wiki_search_heads.indexable)
          IS DISTINCT FROM (EXCLUDED.space_id,EXCLUDED.version_id,EXCLUDED.format_version,
            EXCLUDED.grams_v1,EXCLUDED.grams_v2,EXCLUDED.indexable);
      ELSE
        new_space:=NULL;new_blocked:=0;
        DELETE FROM ccl_knowledge_wiki_search_heads
          WHERE project_id=p_project AND object_id=p_object;
      END IF;
      IF old_space IS NOT NULL THEN
        PERFORM ccl_wiki_search_adjust_scope(p_project,old_space,
          CASE WHEN old_space IS NOT DISTINCT FROM new_space THEN new_blocked-old_blocked
            ELSE -old_blocked END);
      END IF;
      IF new_space IS NOT NULL AND new_space IS DISTINCT FROM old_space THEN
        PERFORM ccl_wiki_search_adjust_scope(p_project,new_space,new_blocked);
      END IF;
      PERFORM set_config('ccl.wiki_search_internal',COALESCE(previous_flag,''),true);
    EXCEPTION WHEN OTHERS THEN
      PERFORM set_config('ccl.wiki_search_internal',COALESCE(previous_flag,''),true);
      RAISE;
    END $fn$;`);
  await client.query(`CREATE OR REPLACE FUNCTION ccl_wiki_search_head_changed()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP='DELETE' THEN PERFORM ccl_wiki_search_refresh_head(OLD.project_id,OLD.object_id);
      ELSIF TG_OP='INSERT' THEN PERFORM ccl_wiki_search_refresh_head(NEW.project_id,NEW.object_id);
      ELSE
        IF OLD.project_id IS DISTINCT FROM NEW.project_id OR OLD.object_id IS DISTINCT FROM NEW.object_id THEN
          PERFORM ccl_wiki_search_refresh_head(OLD.project_id,OLD.object_id);
        END IF;
        PERFORM ccl_wiki_search_refresh_head(NEW.project_id,NEW.object_id);
      END IF;
      RETURN NULL;
    END $fn$;`);
  await client.query(`CREATE OR REPLACE FUNCTION ccl_wiki_search_revision_changed()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP='UPDATE' THEN
        IF EXISTS(SELECT 1 FROM ccl_knowledge_heads h WHERE h.project_id=OLD.project_id
          AND h.object_id=OLD.object_id AND h.version_id=OLD.version_id) THEN
          PERFORM ccl_wiki_search_refresh_head(OLD.project_id,OLD.object_id);
        END IF;
        IF (OLD.project_id,OLD.object_id,OLD.version_id) IS DISTINCT FROM
           (NEW.project_id,NEW.object_id,NEW.version_id) AND
           EXISTS(SELECT 1 FROM ccl_knowledge_heads h WHERE h.project_id=NEW.project_id
             AND h.object_id=NEW.object_id AND h.version_id=NEW.version_id) THEN
          PERFORM ccl_wiki_search_refresh_head(NEW.project_id,NEW.object_id);
        END IF;
      ELSIF TG_OP='INSERT' THEN
        IF EXISTS(SELECT 1 FROM ccl_knowledge_heads h WHERE h.project_id=NEW.project_id
          AND h.object_id=NEW.object_id AND h.version_id=NEW.version_id) THEN
          PERFORM ccl_wiki_search_refresh_head(NEW.project_id,NEW.object_id);
        END IF;
      ELSIF EXISTS(SELECT 1 FROM ccl_knowledge_heads h WHERE h.project_id=OLD.project_id
        AND h.object_id=OLD.object_id AND h.version_id=OLD.version_id) THEN
        PERFORM ccl_wiki_search_refresh_head(OLD.project_id,OLD.object_id);
      END IF;
      RETURN NULL;
    END $fn$;`);
  for(const table of ['ccl_knowledge_wiki_search_heads','ccl_knowledge_wiki_search_scopes']){
    await client.query(`DROP TRIGGER IF EXISTS ccl_writer_guard ON ${table};
      CREATE TRIGGER ccl_writer_guard BEFORE INSERT OR UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION ccl_assert_knowledge_writer()`);
  }
  await client.query(`DROP TRIGGER IF EXISTS ccl_wiki_search_projection_mutated ON ccl_knowledge_wiki_search_heads;
    CREATE TRIGGER ccl_wiki_search_projection_mutated AFTER INSERT OR UPDATE OR DELETE
      ON ccl_knowledge_wiki_search_heads FOR EACH ROW EXECUTE FUNCTION ccl_wiki_search_projection_mutated();
    DROP TRIGGER IF EXISTS ccl_wiki_search_head_changed ON ccl_knowledge_heads;
    CREATE TRIGGER ccl_wiki_search_head_changed AFTER INSERT OR UPDATE OR DELETE
      ON ccl_knowledge_heads FOR EACH ROW EXECUTE FUNCTION ccl_wiki_search_head_changed();
    DROP TRIGGER IF EXISTS ccl_wiki_search_revision_changed ON ccl_knowledge_revisions;
    CREATE TRIGGER ccl_wiki_search_revision_changed AFTER INSERT OR UPDATE OR DELETE
      ON ccl_knowledge_revisions FOR EACH ROW EXECUTE FUNCTION ccl_wiki_search_revision_changed();`);
}

const statusOf=(row:ScopeRow):WikiSearchProjectionStatus=>({formatVersion:FORMAT,
  ready:row.format_version===FORMAT&&row.ready,complete:row.format_version===FORMAT&&row.complete,
  lastObjectId:row.last_object_id,scanned:Number(row.scanned),blockedRows:Number(row.blocked_rows),
  updatedAt:row.updated_at.toISOString()});

export function createWikiSearchProjection(pool:Pool,{writerGrant}:{writerGrant?:KnowledgeWriterGrant}={}){
  async function status(projectId:string,spaceId:string):Promise<WikiSearchProjectionStatus|null>{
    const row=(await pool.query<ScopeRow>(`SELECT * FROM ccl_knowledge_wiki_search_scopes
      WHERE project_id=$1 AND space_id=$2`,[projectId,spaceId])).rows[0];
    return row?statusOf(row):null;
  }
  async function runBatch(projectId:string,spaceId:string,{limit=100,restart=false}:{limit?:number;restart?:boolean}={}):
    Promise<WikiSearchProjectionStatus>{
    if(!projectId.trim()||!spaceId.trim()||!Number.isSafeInteger(limit)||limit<1||limit>5000)
      throw new KnowledgeError('WIKI_SEARCH_REBUILD_INPUT','Project, space and limit 1..5000 are required',422);
    const client=await pool.connect();let committing=false;
    try{
      await client.query('BEGIN');
      await assertKnowledgeWriterAuthority(client,projectId,writerGrant);
      await client.query(`INSERT INTO ccl_knowledge_wiki_search_scopes
        (project_id,space_id,format_version,ready,complete) VALUES($1,$2,$3,false,false)
        ON CONFLICT DO NOTHING`,[projectId,spaceId,FORMAT]);
      let state=(await client.query<ScopeRow>(`SELECT * FROM ccl_knowledge_wiki_search_scopes
        WHERE project_id=$1 AND space_id=$2 FOR UPDATE`,[projectId,spaceId])).rows[0];
      if(restart||state.format_version!==FORMAT){
        await client.query(`UPDATE ccl_knowledge_wiki_search_scopes SET format_version=$3,
          ready=false,complete=false,last_object_id=NULL,scanned=0,
          updated_at=clock_timestamp() WHERE project_id=$1 AND space_id=$2`,[projectId,spaceId,FORMAT]);
        state={...state,last_object_id:null,scanned:'0',ready:false,complete:false,format_version:FORMAT};
      }
      if(state.ready&&state.complete){
        committing=true;await client.query('COMMIT');return statusOf(state);
      }
      const ids=(await client.query<{object_id:string}>(`SELECT h.object_id
        FROM ccl_knowledge_heads h JOIN ccl_knowledge_revisions r
          ON r.project_id=h.project_id AND r.object_id=h.object_id AND r.version_id=h.version_id
        WHERE h.project_id=$1 AND r.kind='wiki_page'
          AND COALESCE(r.payload->'binding'->>'spaceId','legacy:knowledge')=$2
          AND ($3::text IS NULL OR h.object_id>$3)
        ORDER BY h.object_id LIMIT $4`,[projectId,spaceId,state.last_object_id,limit])).rows;
      if(ids.length){
        await client.query(`SELECT ccl_wiki_search_refresh_head($1,x.object_id)
          FROM unnest($2::text[]) AS x(object_id)`,[projectId,ids.map(row=>row.object_id)]);
      }
      const last=ids.at(-1)?.object_id??state.last_object_id;
      if(ids.length){
        await client.query(`UPDATE ccl_knowledge_wiki_search_scopes
          SET last_object_id=$3,scanned=scanned+$4,updated_at=clock_timestamp()
          WHERE project_id=$1 AND space_id=$2`,[projectId,spaceId,last,ids.length]);
      }else if(Number(state.blocked_rows)>0&&state.last_object_id!==null){
        // A blocked page needs an explicit content change. Its revision trigger will
        // lower blocked_rows; repeating the full coverage scan cannot unblock it.
        committing=true;await client.query('COMMIT');return statusOf(state);
      }
      const more=(await client.query(`SELECT 1 FROM ccl_knowledge_heads h
        JOIN ccl_knowledge_revisions r ON r.project_id=h.project_id
          AND r.object_id=h.object_id AND r.version_id=h.version_id
        WHERE h.project_id=$1 AND r.kind='wiki_page'
          AND COALESCE(r.payload->'binding'->>'spaceId','legacy:knowledge')=$2
          AND ($3::text IS NULL OR h.object_id>$3) LIMIT 1`,[projectId,spaceId,last])).rowCount;
      if(!more){
        // Cache-only keys must not prevent rebuild from converging. The project
        // lock keeps the authority stable while pruning and verifying coverage.
        const priorFlag=(await client.query<{value:string|null}>(
          "SELECT current_setting('ccl.wiki_search_internal',true) AS value")).rows[0].value;
        await client.query("SELECT set_config('ccl.wiki_search_internal','1',true)");
        await client.query(`DELETE FROM ccl_knowledge_wiki_search_heads p
          WHERE p.project_id=$1 AND p.space_id=$2 AND NOT EXISTS (
            SELECT 1 FROM ccl_knowledge_heads h JOIN ccl_knowledge_revisions r
              ON r.project_id=h.project_id AND r.object_id=h.object_id AND r.version_id=h.version_id
            WHERE h.project_id=p.project_id AND h.object_id=p.object_id
              AND h.version_id=p.version_id AND r.kind='wiki_page'
              AND COALESCE(r.payload->'binding'->>'spaceId','legacy:knowledge')=$2)`,[projectId,spaceId]);
        await client.query("SELECT set_config('ccl.wiki_search_internal',$1,true)",[priorFlag??'']);
        const check=(await client.query<{bad:boolean;blocked:string}>(`
          WITH actual AS (
            SELECT h.object_id,h.version_id FROM ccl_knowledge_heads h
            JOIN ccl_knowledge_revisions r ON r.project_id=h.project_id
              AND r.object_id=h.object_id AND r.version_id=h.version_id
            WHERE h.project_id=$1 AND r.kind='wiki_page'
              AND COALESCE(r.payload->'binding'->>'spaceId','legacy:knowledge')=$2
          ), missing AS (
            SELECT 1 FROM actual a LEFT JOIN ccl_knowledge_wiki_search_heads p
              ON p.project_id=$1 AND p.object_id=a.object_id
            WHERE p.object_id IS NULL OR p.space_id<>$2 OR p.version_id<>a.version_id
              OR p.format_version<>$3
            UNION ALL
            SELECT 1 FROM ccl_knowledge_wiki_search_heads p LEFT JOIN actual a
              ON a.object_id=p.object_id
            WHERE p.project_id=$1 AND p.space_id=$2 AND a.object_id IS NULL
          ) SELECT EXISTS(SELECT 1 FROM missing) AS bad,
            (SELECT count(*) FROM ccl_knowledge_wiki_search_heads p
              WHERE p.project_id=$1 AND p.space_id=$2 AND NOT p.indexable)::text AS blocked`,
          [projectId,spaceId,FORMAT])).rows[0];
        const ready=!check.bad&&Number(check.blocked)===0;
        await client.query(`UPDATE ccl_knowledge_wiki_search_scopes SET ready=$3,complete=$3,
          blocked_rows=$4,last_object_id=CASE WHEN $5::boolean THEN NULL ELSE last_object_id END,
          scanned=CASE WHEN $5::boolean THEN 0 ELSE scanned END,updated_at=clock_timestamp()
          WHERE project_id=$1 AND space_id=$2 AND (
            ready IS DISTINCT FROM $3 OR complete IS DISTINCT FROM $3 OR
            blocked_rows IS DISTINCT FROM $4::bigint OR
            ($5::boolean AND (last_object_id IS NOT NULL OR scanned<>0)))`,
        [projectId,spaceId,ready,check.blocked,check.bad]);
      }
      const row=(await client.query<ScopeRow>(`SELECT * FROM ccl_knowledge_wiki_search_scopes
        WHERE project_id=$1 AND space_id=$2`,[projectId,spaceId])).rows[0];
      committing=true;await client.query('COMMIT');return statusOf(row);
    }catch(error){if(committing)throw new WikiSearchProjectionCommitUnknownError(projectId,spaceId);
      await client.query('ROLLBACK').catch(()=>{});throw error;
    }finally{client.release();}
  }
  return {status,runBatch};
}
