import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {SourceEventRecordSchema,EntityMentionBatchSchema,type SourceEventRequest,type SourceEventRecord,type SourceRecord,
  type EntityMentionBatch} from '@commerce/knowledge-contracts';
import type {SourceIntakePort,ReadContext} from '@commerce/knowledge-application';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {canonical,digest} from '@commerce/knowledge-core/utils';
import {assertKnowledgeWriterAuthority,type KnowledgeWriterGrant} from '@commerce/knowledge-core/writer-authority';

export class SourceIntakeCommitUnknownError extends KnowledgeError {
  readonly commitStatus='unknown';
  constructor(readonly operationId:string){super('COMMIT_OUTCOME_UNKNOWN','Source intake acknowledgement was lost; reconcile the original event or method',503);}
}
export async function migrateSourceIntake(pool:Pool){
  await pool.query(`CREATE TABLE IF NOT EXISTS ccl_knowledge_source_events(
    id uuid PRIMARY KEY,project_id text NOT NULL,space_id text NOT NULL,principal_id text NOT NULL,installation_id text NOT NULL,
    purpose text NOT NULL,adapter_id text NOT NULL,event_key text NOT NULL,input_digest text NOT NULL,document jsonb NOT NULL,
    UNIQUE(project_id,space_id,principal_id,installation_id,purpose,adapter_id,event_key));
    CREATE TABLE IF NOT EXISTS ccl_knowledge_entity_mention_batches(
      id uuid PRIMARY KEY,project_id text NOT NULL,source_event_id uuid NOT NULL REFERENCES ccl_knowledge_source_events(id),
      method_version text NOT NULL,input_digest text NOT NULL,document jsonb NOT NULL,UNIQUE(source_event_id,method_version));
    CREATE TABLE IF NOT EXISTS ccl_knowledge_entity_mention_claims(
      project_id text NOT NULL,source_event_id uuid NOT NULL REFERENCES ccl_knowledge_source_events(id),method_version text NOT NULL,
      input_digest text NOT NULL,token uuid NOT NULL,lease_until timestamptz NOT NULL,PRIMARY KEY(source_event_id,method_version));
    CREATE TABLE IF NOT EXISTS ccl_knowledge_source_intake_outbox(
      sequence bigserial PRIMARY KEY,project_id text NOT NULL,space_id text NOT NULL,principal_id text NOT NULL,installation_id text NOT NULL,
      purpose text NOT NULL,kind text NOT NULL CHECK(kind IN ('source_registered','mentions_recorded')),source_event_id uuid NOT NULL REFERENCES ccl_knowledge_source_events(id),batch_id uuid REFERENCES ccl_knowledge_entity_mention_batches(id),
      CHECK((kind='source_registered' AND batch_id IS NULL) OR (kind='mentions_recorded' AND batch_id IS NOT NULL)),
      occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(source_event_id,kind,batch_id));
    CREATE INDEX IF NOT EXISTS ccl_knowledge_source_intake_order ON ccl_knowledge_source_intake_outbox(project_id,space_id,sequence);
    CREATE UNIQUE INDEX IF NOT EXISTS ccl_knowledge_source_registered_once ON ccl_knowledge_source_intake_outbox(source_event_id) WHERE kind='source_registered';
    CREATE OR REPLACE FUNCTION ccl_source_intake_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Source intake records are immutable'; END; $$;`);
  await pool.query(`DROP TRIGGER IF EXISTS ccl_writer_guard ON ccl_knowledge_entity_mention_claims;CREATE TRIGGER ccl_writer_guard
    BEFORE INSERT OR UPDATE OR DELETE ON ccl_knowledge_entity_mention_claims FOR EACH ROW EXECUTE FUNCTION ccl_assert_knowledge_writer()`);
  for(const table of ['ccl_knowledge_source_events','ccl_knowledge_entity_mention_batches','ccl_knowledge_source_intake_outbox'])
    await pool.query(`DROP TRIGGER IF EXISTS ccl_writer_guard ON ${table};CREATE TRIGGER ccl_writer_guard
      BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION ccl_assert_knowledge_writer();
      DROP TRIGGER IF EXISTS ccl_source_intake_immutable ON ${table};CREATE TRIGGER ccl_source_intake_immutable BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION ccl_source_intake_reject_mutation()`);
}
function identity(context:ReadContext){
  const installation=context.principal.clientInstallationId;
  if(!installation||context.scope.projectId!==context.principal.projectId||!context.principal.spaceIds.includes(context.scope.spaceId)||
    !context.principal.purposes.includes(context.purpose))throw new KnowledgeError('SCOPE_FORBIDDEN','Source intake identity or purpose is unavailable',403);
  return [context.scope.projectId,context.scope.spaceId,context.principal.id,installation,context.purpose];
}
const where='project_id=$1 AND space_id=$2 AND principal_id=$3 AND installation_id=$4 AND purpose=$5';
export function createPgSourceIntake(pool:Pool,grant:KnowledgeWriterGrant):SourceIntakePort {
  async function write<T>(context:ReadContext,id:string,action:(client:PoolClient)=>Promise<T>):Promise<T>{
    identity(context);const client=await pool.connect();let committing=false;
    try{await client.query('BEGIN');await assertKnowledgeWriterAuthority(client,context.scope.projectId,grant);
      const authority=await client.query('SELECT mode FROM ccl_knowledge_writer_authority WHERE project_id=$1',[context.scope.projectId]);
      if(authority.rows[0]?.mode!=='active')throw new KnowledgeError('WRITER_AUTHORITY_REQUIRED','Source intake requires an active writer authority',503);
      // Allocate outbox sequences only while holding the project commit-order lock.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`source-intake-order:${context.scope.projectId}`]);
      const value=await action(client);committing=true;await client.query('COMMIT');return value;
    }catch(error){if(committing)throw new SourceIntakeCommitUnknownError(id);
      await client.query('ROLLBACK').catch(()=>{});throw error;
    }finally{client.release();}
  }
  async function getWith(client:Pick<Pool,'query'>|PoolClient,context:ReadContext,id:string){
    const row=await client.query(`SELECT document FROM ccl_knowledge_source_events WHERE ${where} AND id=$6`,[...identity(context),id]);
    return row.rows[0]?SourceEventRecordSchema.parse(row.rows[0].document):null;
  }
  return {
    async receive(context,request:SourceEventRequest,inputDigest,source:SourceRecord){
      if(request.purpose!==context.purpose||request.sourceRef.projectId!==context.scope.projectId||request.sourceRef.spaceId!==context.scope.spaceId||
        inputDigest!==digest(request)||canonical(source.ref)!==canonical(request.sourceRef))
        throw new KnowledgeError('SOURCE_EVENT_BINDING_MISMATCH','Source event binding changed',409);
      const id=randomUUID(),record=SourceEventRecordSchema.parse({id,request,inputDigest,source,
        registeredAt:new Date().toISOString(),assurance:'read_time_only',state:'registered'});
      return write(context,id,async client=>{
        const inserted=await client.query(`INSERT INTO ccl_knowledge_source_events
          (id,project_id,space_id,principal_id,installation_id,purpose,adapter_id,event_key,input_digest,document)
          VALUES($6,$1,$2,$3,$4,$5,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
          [...identity(context),id,request.adapterId,request.eventKey,inputDigest,record]);
        if(!inserted.rowCount){
          const old=await client.query(`SELECT input_digest,document FROM ccl_knowledge_source_events WHERE ${where} AND adapter_id=$6 AND event_key=$7`,
            [...identity(context),request.adapterId,request.eventKey]);
          if(!old.rows[0]||old.rows[0].input_digest!==inputDigest)throw new KnowledgeError('IDEMPOTENCY_CONFLICT','Source event key already has different input',409);
          return SourceEventRecordSchema.parse(old.rows[0].document);
        }
        await client.query(`INSERT INTO ccl_knowledge_source_intake_outbox(project_id,space_id,principal_id,installation_id,purpose,kind,source_event_id)
          VALUES($1,$2,$3,$4,$5,'source_registered',$6)`,[...identity(context),id]);return record;
      });
    },
    get:(context,id)=>getWith(pool,context,id),
    async lookup(context,adapterId,eventKey){
      const row=await pool.query(`SELECT document FROM ccl_knowledge_source_events WHERE ${where} AND adapter_id=$6 AND event_key=$7`,[...identity(context),adapterId,eventKey]);
      return row.rows[0]?SourceEventRecordSchema.parse(row.rows[0].document):null;
    },
    async claimMentions(context,eventId,methodVersion,inputDigest){
      const token=randomUUID();return write(context,eventId,async client=>{
        if(!await getWith(client,context,eventId))throw new KnowledgeError('NOT_FOUND','Source event is unavailable',404);
        const claimed=await client.query(`INSERT INTO ccl_knowledge_entity_mention_claims(project_id,source_event_id,method_version,input_digest,token,lease_until)
          VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '60 seconds') ON CONFLICT(source_event_id,method_version) DO UPDATE
          SET token=EXCLUDED.token,lease_until=EXCLUDED.lease_until
          WHERE ccl_knowledge_entity_mention_claims.lease_until<=clock_timestamp() AND ccl_knowledge_entity_mention_claims.input_digest=EXCLUDED.input_digest
          RETURNING token`,[context.scope.projectId,eventId,methodVersion,inputDigest,token]);
        if(!claimed.rowCount){
          const old=await client.query('SELECT input_digest FROM ccl_knowledge_entity_mention_claims WHERE source_event_id=$1 AND method_version=$2',[eventId,methodVersion]);
          if(old.rows[0]?.input_digest!==inputDigest)throw new KnowledgeError('IDEMPOTENCY_CONFLICT','Extraction is claimed with different proposed mentions',409);
          throw new KnowledgeError('ENTITY_MENTIONS_IN_PROGRESS','This exact extraction is already being read; look up the original method',409);
        }return token;
      });
    },
    async releaseMentions(context,eventId,methodVersion,token){
      await write(context,eventId,async client=>{if(!await getWith(client,context,eventId))return;
        await client.query('DELETE FROM ccl_knowledge_entity_mention_claims WHERE source_event_id=$1 AND method_version=$2 AND token=$3',[eventId,methodVersion,token]);});
    },
    async putMentions(context,event,inputDigest,batch,token){
      EntityMentionBatchSchema.parse(batch);
      if(batch.sourceEventId!==event.id||batch.inputDigest!==inputDigest||canonical(batch.sourceRef)!==canonical(event.request.sourceRef)||
        batch.mentions.some(item=>canonical(item.sourceRef)!==canonical(batch.sourceRef))||canonical(batch.actualReadCoverage.sourceRef)!==canonical(batch.sourceRef))
        throw new KnowledgeError('MENTION_BINDING_MISMATCH','Entity mention batch refers to a different exact source',409);
      return write(context,event.id,async client=>{
        const claim=await client.query(`SELECT 1 FROM ccl_knowledge_entity_mention_claims WHERE source_event_id=$1 AND method_version=$2 AND token=$3 AND input_digest=$4 AND lease_until>clock_timestamp() FOR UPDATE`,[event.id,batch.methodVersion,token,inputDigest]);
        if(!claim.rowCount)throw new KnowledgeError('ENTITY_MENTION_CLAIM_LOST','Entity extraction lease expired or changed before commit',409);
        const parent=await getWith(client,context,event.id);
        if(!parent||parent.inputDigest!==event.inputDigest)throw new KnowledgeError('NOT_FOUND','Source event is unavailable',404);
        const inserted=await client.query(`INSERT INTO ccl_knowledge_entity_mention_batches(id,project_id,source_event_id,method_version,input_digest,document)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`,[batch.id,context.scope.projectId,event.id,batch.methodVersion,inputDigest,batch]);
        if(!inserted.rowCount){
          const old=await client.query('SELECT input_digest,document FROM ccl_knowledge_entity_mention_batches WHERE source_event_id=$1 AND method_version=$2',[event.id,batch.methodVersion]);
          if(!old.rows[0]||old.rows[0].input_digest!==inputDigest)throw new KnowledgeError('IDEMPOTENCY_CONFLICT','Extraction method already has different mentions',409);
          return EntityMentionBatchSchema.parse(old.rows[0].document);
        }
        await client.query(`INSERT INTO ccl_knowledge_source_intake_outbox(project_id,space_id,principal_id,installation_id,purpose,kind,source_event_id,batch_id)
          VALUES($1,$2,$3,$4,$5,'mentions_recorded',$6,$7)`,[...identity(context),event.id,batch.id]);return batch;
      });
    },
    async mentions(context,eventId,methodVersion){
      if(!await getWith(pool,context,eventId))return null;
      const row=await pool.query('SELECT document FROM ccl_knowledge_entity_mention_batches WHERE source_event_id=$1 AND method_version=$2',[eventId,methodVersion]);
      return row.rows[0]?EntityMentionBatchSchema.parse(row.rows[0].document):null;
    },
  };
}
