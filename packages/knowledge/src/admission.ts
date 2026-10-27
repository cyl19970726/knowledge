import { z } from 'zod';
import type { Pool } from 'pg';
import { EvidenceAnchorSchema, IdSchema, MediaScopeSchema, ProjectIdSchema, TimestampSchema, VersionRefSchema, type EvidenceAnchor, type MediaScope, type VersionRef } from '../../contracts/src/index.ts';
import { canonical, sameRef } from './utils.ts';

const channel = z.enum(['visual', 'audio', 'captions']);
export const ScopedUseDecisionSchema = z.strictObject({
  id: IdSchema, projectId: ProjectIdSchema, reportRef: VersionRefSchema, purpose: z.string().trim().min(1),
  claimRef: VersionRefSchema.optional(), anchor: EvidenceAnchorSchema.optional(),
  channels: z.array(channel).min(1).max(3), mediaScope: MediaScopeSchema,
  decision: z.enum(['approved', 'exploration_only', 'rejected']),
  reviewer: z.string().trim().min(1), rationale: z.string().trim().min(1), decidedAt: TimestampSchema,
});
export type ScopedUseDecision = z.infer<typeof ScopedUseDecisionSchema>;
export type ScopedUseRequest = { claimRef?: VersionRef; anchor?: EvidenceAnchor; channels: Array<z.infer<typeof channel>>; mediaScope: MediaScope };
export interface ScopedUseDecisionStore {
  append(record: ScopedUseDecision): Promise<ScopedUseDecision>;
  current(projectId: string, reportRef: VersionRef, purpose: string): Promise<ScopedUseDecision[]>;
}

/** Included by the host in the knowledge migration batch; no global schema writes here. */
export const scopedUseDecisionMigrations = [
  `CREATE TABLE IF NOT EXISTS ccl_knowledge_scoped_use_decisions (
    id uuid PRIMARY KEY, project_id text NOT NULL, report_object_id uuid NOT NULL,
    report_version_id uuid NOT NULL, purpose text NOT NULL, payload jsonb NOT NULL,
    recorded_seq bigint GENERATED ALWAYS AS IDENTITY,
    UNIQUE(project_id, report_object_id, report_version_id, purpose, recorded_seq)
  )`,
  `CREATE INDEX IF NOT EXISTS ccl_knowledge_scoped_use_lookup ON ccl_knowledge_scoped_use_decisions
    (project_id, report_object_id, report_version_id, purpose, recorded_seq DESC)`,
];
export async function migrateKnowledgeAdmission(pool: Pick<Pool,'query'>): Promise<void> {
  for(const statement of scopedUseDecisionMigrations) await pool.query(statement);
}

export function createScopedUseDecisionStore(pool: Pool): ScopedUseDecisionStore {
  return {
    async append(raw) {
      const record = ScopedUseDecisionSchema.parse(raw);
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('INSERT INTO ccl_knowledge_projects(project_id) VALUES($1) ON CONFLICT DO NOTHING',[record.projectId]);
        await client.query('SELECT epoch FROM ccl_knowledge_projects WHERE project_id=$1 FOR UPDATE',[record.projectId]);
        const prior = await client.query<{payload:ScopedUseDecision}>('SELECT payload FROM ccl_knowledge_scoped_use_decisions WHERE id=$1',[record.id]);
        if (prior.rows[0]) {
          if (canonical(prior.rows[0].payload) !== canonical(record)) throw new Error('SCOPED_USE_DECISION_CONFLICT');
          await client.query('COMMIT');
          return prior.rows[0].payload;
        }
        await client.query(`INSERT INTO ccl_knowledge_scoped_use_decisions(id,project_id,report_object_id,report_version_id,purpose,payload)
          VALUES($1,$2,$3,$4,$5,$6)`,[record.id,record.projectId,record.reportRef.objectId,record.reportRef.versionId,record.purpose,record]);
        await client.query('UPDATE ccl_knowledge_projects SET epoch=epoch+1 WHERE project_id=$1',[record.projectId]);
        await client.query('INSERT INTO ccl_knowledge_events(project_id,kind,data) VALUES($1,$2,$3)',[record.projectId,'ScopedUseDecisionRecorded',{decisionId:record.id,reportRef:record.reportRef,purpose:record.purpose,decision:record.decision}]);
        await client.query('COMMIT');
        return record;
      } catch(error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async current(projectId, reportRef, purpose) {
      const rows = await pool.query<{payload:ScopedUseDecision}>(`SELECT payload FROM ccl_knowledge_scoped_use_decisions
        WHERE project_id=$1 AND report_object_id=$2 AND report_version_id=$3 AND purpose=$4 ORDER BY recorded_seq DESC`,
        [projectId,reportRef.objectId,reportRef.versionId,purpose]);
      // Latest decision for the same exact scope supersedes that scope only.
      const seen = new Set<string>();
      return rows.rows.map(r=>ScopedUseDecisionSchema.parse(r.payload)).filter(record=>{
        const key=canonical({claimRef:record.claimRef,anchor:record.anchor,channels:record.channels.slice().sort(),mediaScope:record.mediaScope});
        if(seen.has(key)) return false;
        seen.add(key); return true;
      });
    },
  };
}

function contains(outer: MediaScope, inner: MediaScope): boolean {
  return outer.kind === 'whole' || inner.kind === 'segment' && outer.startMs <= inner.startMs && outer.endMs >= inner.endMs;
}
function overlaps(a: MediaScope, b: MediaScope): boolean {
  return a.kind === 'whole' || b.kind === 'whole' || a.startMs < b.endMs && b.startMs < a.endMs;
}
function identityMatches(record: ScopedUseDecision, use: ScopedUseRequest, rejecting: boolean): boolean {
  if(record.claimRef && (!use.claimRef || !sameRef(record.claimRef,use.claimRef))) return false;
  if(record.anchor && (!use.anchor || canonical(record.anchor)!==canonical(use.anchor))) return false;
  // A broad approval cannot silently grant an unidentified claim or anchor.
  if(!rejecting && (use.claimRef && !record.claimRef || use.anchor && !record.anchor)) return false;
  return true;
}
export function evaluateScopedUse(records: ScopedUseDecision[], use: ScopedUseRequest, exploration: boolean): 'approved' | 'exploration_only' | 'rejected' | 'unknown' {
  if(!use.channels.length) return 'unknown';
  const rejected=records.some(r=>r.decision==='rejected' && identityMatches(r,use,true) && overlaps(r.mediaScope,use.mediaScope) && r.channels.some(c=>use.channels.includes(c)));
  if(rejected) return 'rejected';
  const covering=records.filter(r=>r.decision!=='rejected' && identityMatches(r,use,false) && contains(r.mediaScope,use.mediaScope));
  const allApproved=use.channels.every(channel=>covering.some(r=>r.decision==='approved' && r.channels.includes(channel)));
  if(allApproved) return 'approved';
  if(exploration && use.channels.every(channel=>covering.some(r=>r.channels.includes(channel)))) return 'exploration_only';
  return 'unknown';
}
