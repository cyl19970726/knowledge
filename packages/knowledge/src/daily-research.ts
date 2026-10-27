import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { DailyResearchEntry, DailyResearchManifest, DailyResearchReport, DailyMaterialObservation, VersionRef } from '../../contracts/src/index.ts';
import { DailyResearchManifestSchema, DailyResearchReportSchema, IdSchema, validateDailyResearchDraft } from '../../contracts/src/index.ts';
import { stableHash } from './learning-schemas.ts';
import { KnowledgeError } from './types.ts';

type Db = Pick<PoolClient, 'query'>;

export class DailyResearchConflictError extends Error {
  readonly status = 409;
  constructor(message: string) { super(message); this.name = 'DailyResearchConflictError'; }
}

export async function migrateDailyResearch(pool: Pick<Pool, 'query'>): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS ccl_daily_research (
    id uuid PRIMARY KEY,
    project_id text NOT NULL,
    research_date date NOT NULL,
    revision integer NOT NULL CHECK (revision > 0),
    request_key text NOT NULL,
    manifest_hash char(64) NOT NULL,
    manifest jsonb NOT NULL,
    report jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    UNIQUE(project_id, request_key),
    UNIQUE(project_id, research_date, revision),
    CHECK ((report IS NULL AND completed_at IS NULL) OR (report IS NOT NULL AND completed_at IS NOT NULL))
  )`);
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS ccl_daily_research_project_id_idx ON ccl_daily_research(project_id,id)');
  await pool.query('CREATE INDEX IF NOT EXISTS ccl_daily_research_list_idx ON ccl_daily_research(project_id, research_date DESC, revision DESC, id DESC)');
}

function entry(row: Record<string, unknown>): DailyResearchEntry {
  const manifest = row.manifest as DailyResearchManifest;
  return {
    id: String(row.id), projectId: String(row.project_id), date: manifest.date,
    revision: Number(row.revision), requestKey: String(row.request_key), manifestHash: String(row.manifest_hash).trim(),
    manifest, status: row.report === null ? 'pending' : 'complete', report: (row.report as DailyResearchReport | null),
    createdAt: new Date(String(row.created_at)).toISOString(),
    completedAt: row.completed_at === null ? null : new Date(String(row.completed_at)).toISOString(),
  };
}

async function transaction<T>(pool: Pool, action: (db: Db) => Promise<T>, external?: Db): Promise<T> {
  if (external) return action(external);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

function encodeCursor(value: DailyResearchEntry): string {
  return Buffer.from(JSON.stringify([value.date, value.revision, value.id])).toString('base64url');
}
function decodeCursor(cursor: string): [string, number, string] {
  try {
    if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const decoded = Buffer.from(cursor, 'base64url');
    if (decoded.toString('base64url') !== cursor) throw new Error();
    const value: unknown = JSON.parse(decoded.toString('utf8'));
    // Match PostgreSQL date/integer domains before constructing a query.
    return z.tuple([z.iso.date().refine(date => date >= '0001-01-01'),
      z.int().positive().max(2_147_483_647), IdSchema]).parse(value);
  } catch { throw new KnowledgeError('INVALID_CURSOR', 'Invalid daily research cursor', 400); }
}

function evidenceKey(ref: { domain: string; ref: { objectId: string; versionId: string } }): string {
  return `${ref.domain}:${ref.ref.objectId}:${ref.ref.versionId}`;
}
function assertReportProvenance(manifest: DailyResearchManifest, report: DailyResearchReport): void {
  if(!!manifest.cognition!==!!report.cognition||manifest.cognition&&stableHash(manifest.cognition)!==stableHash(report.cognition))
    throw new DailyResearchConflictError('Cognition aggregation must equal its frozen snapshot');
  if(manifest.cognition&&(manifest.method||report.semanticResearch||manifest.cognition.projectId!==manifest.projectId||manifest.cognition.cutoffAt!==manifest.cutoffAt||manifest.cognition.date!==manifest.date||manifest.cognition.timeZone!==manifest.timeZone))
    throw new DailyResearchConflictError('Cognition aggregation boundary or method mismatch');
  const allowed = new Set<string>();
  for (const material of manifest.materials) for (const ref of material.refs) allowed.add(evidenceKey(ref));
  for (const fact of [...manifest.currentFacts, ...manifest.historyFacts]) allowed.add(evidenceKey(fact.ref));
  for (const analysis of manifest.analyses) {
    allowed.add(evidenceKey(analysis.resultRef));
    if (analysis.adoptionRef) allowed.add(evidenceKey(analysis.adoptionRef));
  }
  for (const knowledge of manifest.knowledge) allowed.add(evidenceKey(knowledge.ref));
  for (const items of Object.values(report.sections)) for (const item of items) for (const ref of item.references)
    if (!allowed.has(evidenceKey(ref))) throw new DailyResearchConflictError('Report cites evidence outside frozen manifest');
  if (!manifest.method) {
    if (report.semanticResearch) throw new DailyResearchConflictError('Legacy manifest cannot publish semantic research');
    return;
  }
  const semantic=report.semanticResearch;
  if (!semantic || semantic.methodVersion!==manifest.method.version || semantic.status!=='reviewed' ||
      semantic.review.passed!==true || semantic.review.issues.length>0)
    throw new DailyResearchConflictError('Semantic research lacks a matching reviewed method result');
  const validation=validateDailyResearchDraft(manifest,{findings:semantic.findings,limitations:semantic.limitations});
  if(!validation.valid)throw new DailyResearchConflictError(`Semantic research violates frozen read set: ${validation.details.join('; ')}`);
}

async function assertWorkflowReceipt(db:Db,manifest:DailyResearchManifest,report:DailyResearchReport):Promise<void> {
  if(!manifest.method)return;
  const semantic=report.semanticResearch!;
  const found=await db.query<{document:Record<string,unknown>}>(`SELECT document FROM aw_runs
    WHERE workspace_id=$1 AND id=$2`,[manifest.projectId,semantic.workflowRunId]);
  const run=found.rows[0]?.document;
  const metadata=run?.metadata as {commerce?:{projectId?:unknown;workflowRevision?:unknown};caller?:{manifestCutoffAt?:unknown}}|undefined;
  const {workflowRunId:_,...expectedOutput}=semantic;
  if(!run || run.workflowId!=='commerce.daily-research' || run.workflowRevision!==manifest.method!.version ||
    run.state!=='succeeded' || metadata?.commerce?.projectId!==manifest.projectId ||
    metadata?.commerce?.workflowRevision!==manifest.method!.version || metadata?.caller?.manifestCutoffAt!==manifest.cutoffAt ||
    stableHash(run.output)!==stableHash(expectedOutput))
    throw new DailyResearchConflictError('Semantic research does not match the successful frozen workflow receipt');
}

export interface DailyResearchStore {
  readSourceVersion(projectId:string,ref:VersionRef):Promise<DailyMaterialObservation|null>;
  prepare(input: { projectId: string; requestKey: string; manifest: DailyResearchManifest }): Promise<DailyResearchEntry>;
  get(projectId: string, id: string): Promise<DailyResearchEntry | null>;
  getByRequestKey(projectId: string, requestKey: string): Promise<DailyResearchEntry | null>;
  previousCompleted(projectId: string, date: string, revision: number): Promise<DailyResearchEntry | null>;
  list(projectId: string, options?: { date?: string; limit?: number; cursor?: string }): Promise<{ items: DailyResearchEntry[]; nextCursor: string | null }>;
  complete(id: string, manifestHash: string, report: DailyResearchReport, client?: Db): Promise<DailyResearchEntry>;
}

export function createDailyResearchStore(pool: Pool): DailyResearchStore {
  return {
    async readSourceVersion(projectId,ref) {
      // The frozen material projection is persisted before its learning event. Reading
      // it must never fall back to the mutable library or invent an archived provider record.
      const result=await pool.query(`SELECT material FROM ccl_daily_research d,
        LATERAL jsonb_array_elements(d.manifest->'materials') material
        WHERE d.project_id=$1 AND material->'refs' @> $2::jsonb ORDER BY d.created_at,d.id LIMIT 1`,
        [projectId,JSON.stringify([{domain:'source',ref}])]);
      return result.rows[0]?.material??null;
    },
    async prepare(input) {
      const manifest = DailyResearchManifestSchema.parse(input.manifest);
      if (input.projectId !== manifest.projectId) throw new Error('Manifest belongs to another project');
      if (!input.requestKey.trim()) throw new Error('requestKey is required');
      const hash = stableHash(manifest);
      return transaction(pool, async db => {
        // Serializes revision allocation, while the unique request key independently enforces idempotency.
        await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`daily-research-request:${input.projectId}:${input.requestKey}`]);
        await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`daily-research:${input.projectId}:${manifest.date}`]);
        const prior = await db.query('SELECT * FROM ccl_daily_research WHERE project_id=$1 AND request_key=$2 FOR UPDATE', [input.projectId, input.requestKey]);
        if (prior.rows[0]) {
          const found = entry(prior.rows[0]);
          if (found.manifestHash !== hash) throw new DailyResearchConflictError('requestKey already has different frozen inputs');
          return found;
        }
        const revisionResult = await db.query('SELECT COALESCE(MAX(revision),0)+1 AS next FROM ccl_daily_research WHERE project_id=$1 AND research_date=$2', [input.projectId, manifest.date]);
        const revision = Number(revisionResult.rows[0].next);
        const inserted = await db.query(`INSERT INTO ccl_daily_research(id,project_id,research_date,revision,request_key,manifest_hash,manifest)
          VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [randomUUID(), input.projectId, manifest.date, revision, input.requestKey, hash, manifest]);
        return entry(inserted.rows[0]);
      });
    },
    async get(projectId, id) {
      const found = await pool.query('SELECT * FROM ccl_daily_research WHERE project_id=$1 AND id=$2', [projectId, id]);
      return found.rows[0] ? entry(found.rows[0]) : null;
    },
    async getByRequestKey(projectId, requestKey) {
      const found = await pool.query('SELECT * FROM ccl_daily_research WHERE project_id=$1 AND request_key=$2', [projectId, requestKey]);
      return found.rows[0] ? entry(found.rows[0]) : null;
    },
    async previousCompleted(projectId, date, revision) {
      const found = await pool.query(`SELECT * FROM ccl_daily_research WHERE project_id=$1 AND research_date=$2::date
        AND revision<$3 AND report IS NOT NULL ORDER BY revision DESC LIMIT 1`, [projectId, date, revision]);
      return found.rows[0] ? entry(found.rows[0]) : null;
    },
    async list(projectId, options = {}) {
      const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)));
      const values: unknown[] = [projectId];
      const where = ['project_id=$1'];
      if (options.date !== undefined) { values.push(options.date); where.push(`research_date=$${values.length}::date`); }
      if (options.cursor) {
        const [date, revision, id] = decodeCursor(options.cursor);
        values.push(date, revision, id);
        where.push(`(research_date,revision,id)<($${values.length - 2}::date,$${values.length - 1}::integer,$${values.length}::uuid)`);
      }
      values.push(limit + 1);
      const found = await pool.query(`SELECT * FROM ccl_daily_research WHERE ${where.join(' AND ')}
        ORDER BY research_date DESC,revision DESC,id DESC LIMIT $${values.length}`, values);
      const items = found.rows.slice(0, limit).map(entry);
      return { items, nextCursor: found.rows.length > limit ? encodeCursor(items[items.length - 1]) : null };
    },
    async complete(id, manifestHash, inputReport, client) {
      const report = DailyResearchReportSchema.parse(inputReport);
      return transaction(pool, async db => {
        const found = await db.query('SELECT * FROM ccl_daily_research WHERE id=$1 FOR UPDATE', [id]);
        if (!found.rows[0]) throw new Error('Daily research report not found');
        const old = entry(found.rows[0]);
        if (old.manifestHash !== manifestHash) throw new DailyResearchConflictError('Manifest hash changed');
        if (old.date !== report.date || old.manifest.timeZone !== report.timeZone || old.manifest.cutoffAt !== report.cutoffAt)
          throw new DailyResearchConflictError('Report boundary differs from frozen manifest');
        assertReportProvenance(old.manifest, report);
        await assertWorkflowReceipt(db,old.manifest,report);
        if (old.report) {
          if (stableHash(old.report) !== stableHash(report)) throw new DailyResearchConflictError('Completed report is immutable');
          return old;
        }
        const updated = await db.query('UPDATE ccl_daily_research SET report=$2,completed_at=now() WHERE id=$1 RETURNING *', [id, report]);
        return entry(updated.rows[0]);
      }, client);
    },
  };
}
