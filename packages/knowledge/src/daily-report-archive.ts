import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { DailyEvidenceRef, DailyResearchEntry, DailyResearchReport, DailyReportItem, VersionRef } from '../../contracts/src/index.ts';
import { DailyResearchEntrySchema, IdSchema } from '../../contracts/src/index.ts';
import { stableHash } from './learning-schemas.ts';
import { KnowledgeError } from './types.ts';

type Db = Pick<PoolClient, 'query'>;
const refKey = (ref: VersionRef) => `${ref.objectId}/${ref.versionId}`;

/** Readable research context. It never becomes an independent learning source. */
export interface DailyReportArchive {
  sequence: number;
  reportId: string;
  projectId: string;
  date: string;
  revision: number;
  manifestHash: string;
  reportHash: string;
  sourceGroups: string[];
  sourceRefs: DailyEvidenceRef[];
  analysisRefs: DailyEvidenceRef[];
  analysisSources: Array<{ ref: VersionRef; sourceGroup: string }>;
  report: DailyResearchReport;
  archivedAt: string;
}

/** Topic context includes only report lines tied to exact admitted analysis versions. */
export function selectDailyReportContext(archive: DailyReportArchive, analysisRefs: VersionRef[]) {
  const allowed = new Set(analysisRefs.map(refKey));
  const relevant = (items: DailyReportItem[]) => items.filter(item =>
    item.references.some(reference => reference.domain === 'analysis' && allowed.has(refKey(reference.ref))));
  return {
    reportId: archive.reportId, date: archive.date, revision: archive.revision, status: archive.report.status,
    sourceGroups: archive.analysisSources.filter(source => allowed.has(refKey(source.ref))).map(source => source.sourceGroup),
    // Metric-only and uncited global statements are omitted: this build has no such evidence reader.
    sections: {
      discoveries: relevant(archive.report.sections.discoveries),
      product: relevant(archive.report.sections.product),
      creative: relevant(archive.report.sections.creative),
      counterexamplesAndGaps: relevant(archive.report.sections.counterexamplesAndGaps),
      tomorrowActions: relevant(archive.report.sections.tomorrowActions),
    },
  };
}

export async function migrateDailyReportArchive(pool: Pick<Pool, 'query'>): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS ccl_daily_report_archives (
    archive_sequence bigserial UNIQUE,
    project_id text NOT NULL,
    report_id uuid NOT NULL,
    research_date date NOT NULL,
    revision integer NOT NULL CHECK (revision > 0),
    manifest_hash char(64) NOT NULL,
    report_hash char(64) NOT NULL,
    analysis_keys text[] NOT NULL,
    source_groups text[] NOT NULL,
    payload jsonb NOT NULL,
    archived_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(project_id,report_id),
    FOREIGN KEY(project_id,report_id) REFERENCES ccl_daily_research(project_id,id) ON DELETE RESTRICT
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS ccl_daily_report_archives_analysis_idx ON ccl_daily_report_archives USING gin(analysis_keys)');
  await pool.query('CREATE INDEX IF NOT EXISTS ccl_daily_report_archives_list_idx ON ccl_daily_report_archives(project_id,research_date DESC,revision DESC,report_id DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS ccl_daily_report_archives_events_idx ON ccl_daily_report_archives(project_id,archive_sequence)');
}

function fromRow(row: Record<string, unknown>): DailyReportArchive {
  const payload = row.payload as Omit<DailyReportArchive, 'sequence' | 'archivedAt'>;
  return { ...payload, sequence: Number(row.archive_sequence), archivedAt: new Date(String(row.archived_at)).toISOString() };
}

function encodeCursor(value: DailyReportArchive): string {
  return Buffer.from(JSON.stringify([value.date, value.revision, value.reportId])).toString('base64url');
}
function decodeCursor(cursor: string): [string, number, string] {
  try {
    if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const decoded = Buffer.from(cursor, 'base64url');
    if (decoded.toString('base64url') !== cursor) throw new Error();
    const parsed: unknown = JSON.parse(decoded.toString('utf8'));
    return z.tuple([z.iso.date().refine(date => date >= '0001-01-01'),
      z.int().positive().max(2_147_483_647), IdSchema]).parse(parsed);
  } catch { throw new KnowledgeError('INVALID_ARCHIVE_CURSOR', 'Invalid daily archive cursor', 400); }
}

async function transaction<T>(pool: Pool, action: (db: Db) => Promise<T>, client?: Db): Promise<T> {
  if (client) return action(client);
  const db = await pool.connect();
  try { await db.query('BEGIN'); const result = await action(db); await db.query('COMMIT'); return result; }
  catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

export interface DailyReportArchiveStore {
  archive(entry: DailyResearchEntry, client?: Db): Promise<DailyReportArchive>;
  get(projectId: string, reportId: string): Promise<DailyReportArchive | null>;
  list(projectId: string, options?: { limit?: number; cursor?: string }): Promise<{ items: DailyReportArchive[]; nextCursor: string | null }>;
  listAfter(projectId: string, sequence: number, limit?: number): Promise<DailyReportArchive[]>;
  /** Exact overlap with analysis versions already admitted to this topic. */
  listRelevant(projectId: string, analysisRefs: VersionRef[], limit?: number): Promise<DailyReportArchive[]>;
}

export function createDailyReportArchiveStore(pool: Pool): DailyReportArchiveStore {
  return {
    async archive(raw, client) {
      const entry = DailyResearchEntrySchema.parse(raw);
      if (entry.status !== 'complete' || !entry.report || !entry.completedAt)
        throw new KnowledgeError('DAILY_REPORT_INCOMPLETE', 'Only completed daily reports can enter the knowledge archive', 422);
      if (stableHash(entry.manifest) !== entry.manifestHash)
        throw new KnowledgeError('DAILY_MANIFEST_MISMATCH', 'Daily report manifest no longer matches its frozen hash', 422);
      const groups = new Set<string>();
      for (const material of entry.manifest.materials) groups.add(material.sourceGroup);
      for (const fact of [...entry.manifest.currentFacts, ...entry.manifest.historyFacts]) groups.add(fact.sourceGroup);
      for (const analysis of entry.manifest.analyses) groups.add(analysis.sourceGroup);
      for(const source of entry.manifest.cognition?.materials??[])groups.add(source.sourceGroup);
      const sourceRefs = entry.manifest.materials.flatMap(material => material.refs.filter(ref => ref.domain === 'source'));
      const analysisRefs = [...entry.manifest.analyses.map(analysis => analysis.resultRef),
        ...(entry.manifest.cognition?.materials??[]).map(source=>({domain:'analysis' as const,ref:source.analysisRef}))];
      const analysisSources = [...new Map([...entry.manifest.analyses.map(analysis =>
        [`${refKey(analysis.resultRef.ref)}:${analysis.sourceGroup}`, { ref: analysis.resultRef.ref, sourceGroup: analysis.sourceGroup }] as const),
        ...(entry.manifest.cognition?.materials??[]).map(source=>[`${refKey(source.analysisRef)}:${source.sourceGroup}`,{ref:source.analysisRef,sourceGroup:source.sourceGroup}] as const)]).values()];
      const payload: Omit<DailyReportArchive, 'sequence' | 'archivedAt'> = {
        reportId: entry.id, projectId: entry.projectId, date: entry.date, revision: entry.revision,
        manifestHash: entry.manifestHash, reportHash: stableHash(entry.report), sourceGroups: [...groups].sort(),
        sourceRefs: [...new Map(sourceRefs.map(ref => [`${ref.domain}:${refKey(ref.ref)}`, ref])).values()],
        analysisRefs: [...new Map(analysisRefs.map(ref => [`${ref.domain}:${refKey(ref.ref)}`, ref])).values()],
        analysisSources,
        report: entry.report,
      };
      return transaction(pool, async db => {
        const origin = await db.query('SELECT manifest_hash,report FROM ccl_daily_research WHERE project_id=$1 AND id=$2 FOR SHARE', [entry.projectId, entry.id]);
        if (!origin.rows[0] || !origin.rows[0].report || String(origin.rows[0].manifest_hash).trim() !== payload.manifestHash ||
          stableHash(origin.rows[0].report) !== payload.reportHash)
          throw new KnowledgeError('DAILY_REPORT_NOT_COMMITTED', 'Knowledge archive requires the matching completed daily report', 422);
        // Hold through commit so ingest cannot advance past an earlier uncommitted sequence.
        // Lock the report first, matching the worker's complete-then-archive order.
        await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`daily-archive:${entry.projectId}`]);
        await db.query(`INSERT INTO ccl_daily_report_archives
          (project_id,report_id,research_date,revision,manifest_hash,report_hash,analysis_keys,source_groups,payload)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(project_id,report_id) DO NOTHING`,
        [entry.projectId, entry.id, entry.date, entry.revision, entry.manifestHash, payload.reportHash,
          payload.analysisRefs.map(ref => refKey(ref.ref)), payload.sourceGroups, payload]);
        const row = await db.query('SELECT * FROM ccl_daily_report_archives WHERE project_id=$1 AND report_id=$2', [entry.projectId, entry.id]);
        const actual = fromRow(row.rows[0]);
        if (actual.manifestHash !== payload.manifestHash || actual.reportHash !== payload.reportHash)
          throw new KnowledgeError('DAILY_ARCHIVE_CONFLICT', 'Report ID already has different immutable inputs or output');
        return actual;
      }, client);
    },
    async get(projectId, reportId) {
      const row = await pool.query('SELECT * FROM ccl_daily_report_archives WHERE project_id=$1 AND report_id=$2', [projectId, reportId]);
      return row.rows[0] ? fromRow(row.rows[0]) : null;
    },
    async list(projectId, options = {}) {
      const n = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)));
      const values: unknown[] = [projectId];
      const where = ['project_id=$1'];
      if (options.cursor) {
        const [date, revision, reportId] = decodeCursor(options.cursor);
        values.push(date, revision, reportId);
        where.push(`(research_date,revision,report_id)<($${values.length - 2}::date,$${values.length - 1}::integer,$${values.length}::uuid)`);
      }
      values.push(n + 1);
      const rows = await pool.query(`SELECT * FROM ccl_daily_report_archives WHERE ${where.join(' AND ')}
        ORDER BY research_date DESC,revision DESC,report_id DESC LIMIT $${values.length}`, values);
      const items = rows.rows.slice(0, n).map(fromRow);
      return { items, nextCursor: rows.rows.length > n ? encodeCursor(items[items.length - 1]) : null };
    },
    async listAfter(projectId, sequence, limit = 500) {
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw new KnowledgeError('INVALID_ARCHIVE_SEQUENCE', 'Invalid archive sequence', 400);
      const n = Math.max(1, Math.min(500, Math.floor(limit)));
      const rows = await pool.query(`SELECT * FROM ccl_daily_report_archives WHERE project_id=$1 AND archive_sequence>$2
        ORDER BY archive_sequence ASC LIMIT $3`, [projectId, sequence, n]);
      return rows.rows.map(fromRow);
    },
    async listRelevant(projectId, analysisRefs, limit = 8) {
      if (!analysisRefs.length) return [];
      const keys = [...new Set(analysisRefs.map(refKey))];
      const n = Math.max(1, Math.min(20, Math.floor(limit)));
      const rows = await pool.query(`SELECT * FROM ccl_daily_report_archives
        WHERE project_id=$1 AND analysis_keys && $2::text[]
        ORDER BY research_date DESC,revision DESC,report_id DESC LIMIT $3`, [projectId, keys, n]);
      return rows.rows.map(fromRow);
    },
  };
}
