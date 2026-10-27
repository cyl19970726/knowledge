import type {Pool} from 'pg';
import type {ReadReceipt,Scope} from '@commerce/knowledge-contracts';
import type {ReceiptPort} from '@commerce/knowledge-application';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {digest} from '@commerce/knowledge-core/utils';

/** Same PostgreSQL authority as ccl_knowledge_revisions; no copy of revisions or heads. */
export async function migrateKnowledgeReadReceipts(pool:Pool):Promise<void>{
  await pool.query(`CREATE TABLE IF NOT EXISTS ccl_knowledge_read_receipts (
    project_id text NOT NULL, space_id text NOT NULL, id text NOT NULL,
    principal_id text NOT NULL, purpose text NOT NULL, policy_version text NOT NULL,
    publication_epoch bigint NOT NULL, readset_fingerprint text NOT NULL,
    page_fingerprint text NOT NULL, payload jsonb NOT NULL,
    created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
    PRIMARY KEY(project_id,space_id,id)
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ccl_knowledge_read_receipts_expiry_idx ON ccl_knowledge_read_receipts(expires_at)`);
}

export function createPgKnowledgeReceiptPort(pool:Pool):ReceiptPort{
  return {
    async save(receipt,expectedEpoch){
      if(receipt.coverage.snapshot.publicationEpoch!==expectedEpoch)throw new KnowledgeError('READSET_EPOCH_MISMATCH','Receipt epoch differs from page epoch',409);
      const client=await pool.connect();
      try{
        await client.query('BEGIN');
        await client.query('INSERT INTO ccl_knowledge_projects(project_id) VALUES($1) ON CONFLICT DO NOTHING',[receipt.effectiveScope.projectId]);
        const state=await client.query<{epoch:string}>('SELECT epoch FROM ccl_knowledge_projects WHERE project_id=$1 FOR SHARE',[receipt.effectiveScope.projectId]);
        if(Number(state.rows[0]?.epoch)!==expectedEpoch)throw new KnowledgeError('READSET_CHANGED','Knowledge changed during this read; retry the whole request',409);
        for(const item of receipt.orderedItems){
          if(item.ref.projectId!==receipt.effectiveScope.projectId||item.ref.spaceId!==receipt.effectiveScope.spaceId||item.ref.domain!=='knowledge')
            throw new KnowledgeError('READSET_SCOPE_MISMATCH','Receipt item crosses knowledge scope',403);
          const row=await client.query<{payload:unknown}>(`SELECT payload FROM ccl_knowledge_revisions
            WHERE project_id=$1 AND object_id=$2 AND version_id=$3 AND published_at IS NOT NULL`,
            [receipt.effectiveScope.projectId,item.ref.objectId,item.ref.versionId]);
          if(!row.rows[0]||digest(row.rows[0].payload)!==item.revisionDigest||item.ref.contentDigest!==item.revisionDigest)
            throw new KnowledgeError('READSET_VERSION_MISMATCH','Exact read revision changed or is unavailable',409);
        }
        await client.query(`INSERT INTO ccl_knowledge_read_receipts(project_id,space_id,id,principal_id,purpose,policy_version,publication_epoch,readset_fingerprint,page_fingerprint,payload,created_at,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [receipt.effectiveScope.projectId,receipt.effectiveScope.spaceId,receipt.id,receipt.principalId,receipt.purpose,receipt.policyVersion,
            expectedEpoch,receipt.readsetFingerprint,receipt.pageFingerprint,receipt,receipt.createdAt,receipt.expiresAt]);
        await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    },
    async get(scope:Scope,principalId:string,id:string){
      const row=await pool.query<{payload:ReadReceipt}>(`SELECT payload FROM ccl_knowledge_read_receipts
        WHERE project_id=$1 AND space_id=$2 AND principal_id=$3 AND id=$4 AND expires_at>now()`,
        [scope.projectId,scope.spaceId,principalId,id]);
      return row.rows[0]?.payload??null;
    }
  };
}
export * from './operations.ts';
export * from './sources.ts';
export * from './source-owner.ts';
export * from './uses.ts';
export * from './reviews.ts';
export * from './feedback-source.ts';
export * from './feedback-research.ts';
export {lookupCapabilityOperation,getCapabilityOperation} from './transaction.ts';
