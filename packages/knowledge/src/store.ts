import { assertKnowledgeWriterAuthority, type KnowledgeWriterGrant } from './writer-authority.ts';
import type { Pool, PoolClient } from 'pg';
type QueryClient = Pick<PoolClient,'query'>;
import type { VersionRef } from '../../contracts/src/index.ts';
import { KnowledgeError } from './types.ts';
import type { Dependency, DependencyDomain, Invalidity, KnowledgeCatalogSummary, KnowledgeChangeSet, KnowledgeEvent, KnowledgeImpactResult, KnowledgeReview, KnowledgeRevision, KnowledgeStore, Publication, RevisionView, Validity } from './types.ts';
import { assertPublicationPermit, capturePublicationPermit, hasPublicationAuthorityScopes, isPublicationScopeProtected, setPublicationAuthorityScope, type PublicationScopeFacts } from './wiki-publication-authority.ts';
import { citationsOf } from './utils.ts';

const fail = (code: string, message: string): never => { throw new KnowledgeError(code, message); };
const refKey = (ref: VersionRef) => `${ref.objectId}:${ref.versionId}`;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])) : value;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

async function tx<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const value = await action(client); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function lockProject(client: QueryClient, projectId: string): Promise<number> {
  await client.query('INSERT INTO ccl_knowledge_projects(project_id) VALUES($1) ON CONFLICT DO NOTHING', [projectId]);
  const row = await client.query<{ epoch: string }>('SELECT epoch FROM ccl_knowledge_projects WHERE project_id=$1 FOR UPDATE', [projectId]);
  return Number(row.rows[0].epoch);
}
async function event(client: QueryClient, projectId: string, kind: string, data: Record<string, unknown>) {
  await client.query('INSERT INTO ccl_knowledge_events(project_id,kind,data) VALUES($1,$2,$3)', [projectId, kind, data]);
}
async function changeRow(client: QueryClient, projectId: string, id: string): Promise<KnowledgeChangeSet | null> {
  const r = await client.query<{ payload: KnowledgeChangeSet }>('SELECT payload FROM ccl_knowledge_changesets WHERE project_id=$1 AND id=$2', [projectId,id]);
  return r.rows[0]?.payload ?? null;
}

/** Resolve persisted ancestry as well as the candidate's normalized facts. A new ID or absent binding is not an escape. */
async function publicationFacts(client: QueryClient, projectId: string, seed: PublicationScopeFacts,
  revisions: KnowledgeRevision[] = [], exactRefs: VersionRef[] = []): Promise<PublicationScopeFacts> {
  const facts = Object.fromEntries(Object.entries(seed).map(([key, values]) => [key, new Set(values)])) as Record<keyof PublicationScopeFacts, Set<string>>;
  const queue = [...revisions];
  const refs = [...exactRefs];
  const citedSources: Array<{domain:'source'|'evidence';ref:VersionRef}> = [];
  const lookedUp = new Set<string>();
  const seen = new Set<string>();
  const add = (revision: KnowledgeRevision) => {
    facts.knowledgeObjectIds.add(revision.ref.objectId);
    // Legacy topic Wikis used the topic object itself. New cross-domain pages name their question explicitly.
    facts.topicIds.add(revision.ref.objectId);
    if (revision.binding && 'bindingKind' in revision.binding && revision.binding.bindingKind === 'cross_domain_wiki') {
      facts.topicIds.add(revision.binding.questionRef.objectId);
      refs.push(...revision.binding.basis.map(item=>item.ref));
    } else if (revision.binding && 'sourceRef' in revision.binding)
      facts.sourceObjectIds.add(revision.binding.sourceRef.objectId);
    revision.sourceGroups.forEach(group => facts.sourceGroups.add(group));
    if (revision.kind === 'case') facts.sourceObjectIds.add(revision.content.analysisResultRef.objectId);
    // Content links are still scope facts if an old direct store writer omitted normalized dependencies.
    if (revision.kind === 'wiki') refs.push(...revision.content.claimRefs,...revision.content.patternRefs,...revision.content.relatedRefs);
    if (revision.kind === 'wiki_page') refs.push(...revision.content.navigation.map(link=>link.ref));
    if (revision.kind === 'pattern') refs.push(...revision.content.supportRefs,...revision.content.counterexampleRefs);
    if (revision.kind === 'collection') refs.push(...revision.content.members.map(item=>item.ref));
    if (revision.kind === 'comparison') refs.push(revision.content.collectionRef,...revision.content.dimensions.flatMap(d=>d.observations.map(item=>item.memberRef)));
    if (revision.kind === 'reference_pack') refs.push(...revision.content.decisions.filter(item=>item.selected).map(item=>item.ref));
    for (const citation of citationsOf(revision)) {
      const ref = citation.kind==='source'?citation.sourceRef:citation.anchor.sourceRef;
      facts.sourceObjectIds.add(ref.objectId);
      citedSources.push({domain:citation.kind==='source'?'source':'evidence',ref});
    }
    for (const dep of revision.dependencies) {
      if (dep.domain === 'knowledge') refs.push(dep.ref);
      else if (dep.domain === 'source' || dep.domain === 'analysis') facts.sourceObjectIds.add(dep.ref.objectId);
    }
  };
  for (const id of seed.knowledgeObjectIds) {
    const head = await headRow(client, projectId, id);
    if (head) refs.push({objectId: id, versionId: head});
  }
  while (queue.length || refs.length || citedSources.length) {
    if (seen.size > 10_000) return fail('PUBLICATION_AUTHORITY_ANCESTRY_LIMIT', 'Publication ancestry exceeds the bounded verification limit');
    const revision = queue.pop();
    if (revision) {
      const key = refKey(revision.ref);
      if (!seen.has(key)) { seen.add(key); add(revision); }
      continue;
    }
    if (!refs.length) {
      const cited = citedSources.pop()!, key = `${cited.domain}:${refKey(cited.ref)}`;
      if (lookedUp.has(key)) continue;
      lookedUp.add(key);
      // Existing source registrations own the exact source-group mapping; caller-supplied omissions do not erase it.
      const owners = await client.query<{object_id:string;version_id:string}>(
        `SELECT d.object_id,d.version_id FROM ccl_knowledge_deps d JOIN ccl_knowledge_revisions r
         ON r.project_id=d.project_id AND r.object_id=d.object_id AND r.version_id=d.version_id
         WHERE d.project_id=$1 AND d.domain=$2 AND d.dep_object_id=$3 AND d.dep_version_id=$4
           AND r.published_at IS NOT NULL LIMIT 10001`, [projectId,cited.domain,cited.ref.objectId,cited.ref.versionId]);
      if (owners.rows.length>10000) return fail('PUBLICATION_AUTHORITY_ANCESTRY_LIMIT','Source ownership exceeds the bounded verification limit');
      refs.push(...owners.rows.map(row=>({objectId:row.object_id,versionId:row.version_id})));
      continue;
    }
    const ref = refs.pop()!;
    facts.knowledgeObjectIds.add(ref.objectId);
    if (seen.has(refKey(ref))) continue;
    const row = await client.query<{payload: KnowledgeRevision}>(
      'SELECT payload FROM ccl_knowledge_revisions WHERE project_id=$1 AND object_id=$2 AND version_id=$3',
      [projectId, ref.objectId, ref.versionId]);
    if (row.rows[0]) queue.push(row.rows[0].payload);
    else seen.add(refKey(ref));
  }
  return Object.fromEntries(Object.entries(facts).map(([key, values]) => [key, [...values].sort()])) as unknown as PublicationScopeFacts;
}
interface ReadContext {
  at?:string;
  heads:Map<string,string|null>; invalidities:Map<string,Invalidity[]>;
  revisions:Map<string,{payload:KnowledgeRevision;published_at:Date|null}|null>;
  effects:Map<string,string|null>; reviews:Map<string,KnowledgeReview|null>;
}
const readContext=():ReadContext=>({heads:new Map(),invalidities:new Map(),revisions:new Map(),effects:new Map(),reviews:new Map()});
async function headRow(client: QueryClient, projectId: string, objectId: string, context?:ReadContext): Promise<string | null> {
  if(context?.heads.has(objectId))return context.heads.get(objectId)!;
  const r = context?.at ? await client.query<{version_id:string}>(`SELECT version_id FROM ccl_knowledge_revisions WHERE project_id=$1 AND object_id=$2 AND published_at<=$3::timestamptz ORDER BY published_at DESC,version_id DESC LIMIT 1`,[projectId,objectId,context.at]) :
    await client.query<{ version_id: string }>('SELECT version_id FROM ccl_knowledge_heads WHERE project_id=$1 AND object_id=$2', [projectId,objectId]);
  const value=r.rows[0]?.version_id??null;context?.heads.set(objectId,value);return value;
}
async function invalidityRows(client: QueryClient, projectId: string, domain: DependencyDomain, ref: VersionRef, context?:ReadContext): Promise<Invalidity[]> {
  const key=`${domain}:${refKey(ref)}`;if(context?.invalidities.has(key))return context.invalidities.get(key)!;
  const r = await client.query<{reason:string;state:Invalidity['state'];created_at:Date}>(
    'SELECT reason,state,created_at FROM ccl_knowledge_invalidities WHERE project_id=$1 AND domain=$2 AND object_id=$3 AND version_id=$4 AND ($5::timestamptz IS NULL OR created_at<=$5::timestamptz)',
    [projectId,domain,ref.objectId,ref.versionId,context?.at??null]);
  const value=r.rows.map(x => ({ domain, ref, reason:x.reason, state:x.state, createdAt:x.created_at.toISOString() }));
  context?.invalidities.set(key,value);return value;
}
async function assess(client: QueryClient, projectId: string, deps: Dependency[], seen = new Set<string>(),context?:ReadContext): Promise<Validity> {
  const issues: Invalidity[] = [];
  for (const dep of deps) {
    if (!dep.critical) continue;
    const key = `${dep.domain}:${refKey(dep.ref)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push(...await invalidityRows(client, projectId, dep.domain, dep.ref,context));
    if (dep.domain !== 'knowledge') continue;
    let record=context?.revisions.get(refKey(dep.ref));
    if(record===undefined){const r = await client.query<{payload:KnowledgeRevision;published_at:Date|null}>(
      'SELECT payload,published_at FROM ccl_knowledge_revisions WHERE project_id=$1 AND object_id=$2 AND version_id=$3',
      [projectId,dep.ref.objectId,dep.ref.versionId]);record=r.rows[0]??null;context?.revisions.set(refKey(dep.ref),record);}
    if (!record?.published_at || (context?.at&&Date.parse(String(record.published_at))>Date.parse(context.at))) {
      issues.push({ domain:'knowledge',ref:dep.ref,reason:'missing_or_unpublished',state:'stale',createdAt:new Date().toISOString() });
      continue;
    }
    const rev = record.payload;
    if (await headRow(client,projectId,dep.ref.objectId,context) !== dep.ref.versionId)
      issues.push({ domain:'knowledge',ref:dep.ref,reason:'superseded',state:'stale',createdAt:new Date().toISOString() });
    if (rev.scope.reviewDueAt && Date.parse(rev.scope.reviewDueAt) <= (context?.at?Date.parse(context.at):Date.now()))
      issues.push({ domain:'knowledge',ref:dep.ref,reason:'review_due',state:'review_due',createdAt:new Date().toISOString() });
    let effect=context?.effects.get(refKey(dep.ref));
    if(effect===undefined){const rows = await client.query<{effect:string}>(
      `SELECT x.effect FROM ccl_knowledge_revisions r
       JOIN ccl_knowledge_changesets c ON c.project_id=r.project_id AND c.id=r.changeset_id
       CROSS JOIN LATERAL jsonb_to_recordset(c.payload->'changes') AS x(revision jsonb,effect text,explanation text)
       WHERE r.project_id=$1 AND r.object_id=$2 AND r.version_id=$3 AND x.revision->'ref'->>'versionId'=$3`,
      [projectId,dep.ref.objectId,dep.ref.versionId]);effect=rows.rows[0]?.effect??null;context?.effects.set(refKey(dep.ref),effect);}
    if (effect === 'withdraw')
      issues.push({ domain:'knowledge',ref:dep.ref,reason:'withdrawn',state:'withdrawn',createdAt:new Date().toISOString() });
    const nested = await assess(client,projectId,rev.dependencies.filter(d=>d.critical),seen,context);
    issues.push(...nested.issues);
  }
  return { valid:issues.length === 0, issues };
}
async function revisionView(client: QueryClient, projectId: string, rev: KnowledgeRevision, publishedAt: Date|null,context?:ReadContext): Promise<RevisionView> {
  const published=publishedAt!==null,shared=context??readContext();shared.revisions.set(refKey(rev.ref),{payload:rev,published_at:publishedAt});
  const current = published && await headRow(client,projectId,rev.ref.objectId,shared) === rev.ref.versionId;
  let review=shared.reviews.get(refKey(rev.ref));
  if(review===undefined){const reviewRows = await client.query<{payload:KnowledgeReview}>(
    `SELECT v.payload FROM ccl_knowledge_revisions r
      LEFT JOIN ccl_knowledge_publications p ON p.project_id=r.project_id AND p.changeset_id=r.changeset_id
      JOIN ccl_knowledge_reviews v ON v.project_id=r.project_id AND v.changeset_id=r.changeset_id
        AND (p.review_id IS NULL OR p.review_id=v.id)
     WHERE r.project_id=$1 AND r.object_id=$2 AND r.version_id=$3 ORDER BY v.recorded_seq DESC LIMIT 1`,
    [projectId,rev.ref.objectId,rev.ref.versionId]);review=reviewRows.rows[0]?.payload??null;shared.reviews.set(refKey(rev.ref),review);}
  const validity = await assess(client,projectId,[{domain:'knowledge',ref:rev.ref,role:'uses',critical:true}],new Set(),shared);
  return {revision:rev,current,published,publishedAt:publishedAt?.toISOString()??null,review,validity};
}
async function cascade(client: QueryClient, projectId: string, domain: DependencyDomain, ref: VersionRef, reason: string, state: Invalidity['state'], createdAt: string): Promise<VersionRef[]> {
  const affected: VersionRef[] = [];
  const queue: Array<{domain:DependencyDomain;ref:VersionRef}> = [{domain,ref}];
  const seen = new Set<string>();
  const reported = new Set<string>();
  while (queue.length) {
    const item = queue.shift()!;
    const key = `${item.domain}:${refKey(item.ref)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await client.query(`INSERT INTO ccl_knowledge_invalidities(project_id,domain,object_id,version_id,reason,state,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [projectId,item.domain,item.ref.objectId,item.ref.versionId,reason,state,createdAt]);
    const r = await client.query<{object_id:string;version_id:string}>(
      `SELECT d.object_id,d.version_id FROM ccl_knowledge_deps d
       JOIN ccl_knowledge_revisions r ON r.project_id=d.project_id AND r.object_id=d.object_id AND r.version_id=d.version_id
       WHERE d.project_id=$1 AND d.domain=$2 AND d.dep_object_id=$3 AND d.dep_version_id=$4 AND d.critical=true AND r.published_at IS NOT NULL`,
      [projectId,item.domain,item.ref.objectId,item.ref.versionId]);
    for (const row of r.rows) {
      const child = {objectId:row.object_id,versionId:row.version_id};
      if (!reported.has(refKey(child))) { affected.push(child); reported.add(refKey(child)); }
      queue.push({domain:'knowledge',ref:child});
    }
  }
  return affected;
}

/** Optional source-label lookup is navigation only; it cannot alter immutable knowledge. */
export function createKnowledgeStore(pool: Pool, options: {
  writerGrant?: KnowledgeWriterGrant;
  sourceMatches?: (projectId: string, query: string) => Promise<VersionRef[]>;
  /** Trusted host verifier reconstructs the entire original registration; no caller-provided exemption flag. */
  verifySourceAdmission?: (change: KnowledgeChangeSet) => Promise<boolean>;
} = {}): KnowledgeStore {
  const sourceMatches=options.sourceMatches;
  return {
    async capturePublicationPermit(projectId, facts, methodVersion) {
      return capturePublicationPermit(pool, projectId, await publicationFacts(pool, projectId, facts), methodVersion);
    },
    async isPublicationScopeProtected(projectId, facts) {
      return isPublicationScopeProtected(pool, projectId, await publicationFacts(pool, projectId, facts));
    },
    async setPublicationAuthorityScope(projectId, expectedGeneration, scope) {
      return setPublicationAuthorityScope(pool, projectId, expectedGeneration, scope);
    },
    async stage(change) { return tx(pool,async client => {
      await lockProject(client,change.projectId);
      await assertKnowledgeWriterAuthority(client,change.projectId,options.writerGrant);
      const existing = await client.query<{payload:KnowledgeChangeSet}>(
        'SELECT payload FROM ccl_knowledge_changesets WHERE project_id=$1 AND (request_key=$2 OR id=$3)',
        [change.projectId,change.requestKey,change.id]);
      if (existing.rows.length) {
        const original = existing.rows[0].payload;
        if (original.requestKey === change.requestKey && original.requestHash === change.requestHash) return original;
        return fail('STAGE_CONFLICT','Request key, change set ID, or request hash conflicts with an existing proposal');
      }
      if (!change.changes.length) return fail('EMPTY_CHANGESET','A change set must contain revisions');
      const objects = new Set<string>(); const versions = new Set<string>();
      for (const entry of change.changes) {
        const rev = entry.revision;
        const contentRef = rev.kind === 'wiki_page' ? rev.ref : rev.kind === 'reference_pack' ? rev.content.pack.ref : rev.content.ref;
        const contentProjectId = rev.kind === 'wiki_page' ? rev.projectId : rev.kind === 'reference_pack' ? rev.content.pack.projectId : rev.content.projectId;
        if (rev.projectId !== change.projectId || contentProjectId !== change.projectId ||
            rev.ref.objectId !== contentRef.objectId || rev.ref.versionId !== contentRef.versionId)
          return fail('REVISION_IDENTITY','Revision identity and project must agree');
        if (objects.has(rev.ref.objectId) || versions.has(rev.ref.versionId)) return fail('DUPLICATE_REVISION','One revision per object and unique versions are required');
        objects.add(rev.ref.objectId); versions.add(rev.ref.versionId);
        if (rev.dependencies.some(d => d.domain === 'knowledge' && refKey(d.ref) === refKey(rev.ref))) return fail('DEPENDENCY_CYCLE','A revision cannot depend on itself');
      }
      if (change.baseHeads.length !== objects.size || new Set(change.baseHeads.map(x=>x.objectId)).size !== objects.size ||
          change.baseHeads.some(x=>!objects.has(x.objectId))) return fail('BASE_HEADS','Base heads must cover each changed object exactly once');
      await client.query('INSERT INTO ccl_knowledge_changesets(project_id,id,request_key,request_hash,content_hash,payload) VALUES($1,$2,$3,$4,$5,$6)',
        [change.projectId,change.id,change.requestKey,change.requestHash,change.contentHash,change]);
      for (const {revision:rev} of change.changes) {
        await client.query(`INSERT INTO ccl_knowledge_revisions(project_id,object_id,version_id,changeset_id,kind,title,body,payload)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [change.projectId,rev.ref.objectId,rev.ref.versionId,change.id,rev.kind,rev.title,rev.body,rev]);
      }
      await event(client,change.projectId,'KnowledgeStaged',{changeSetId:change.id});
      return change;
    }); },
    async getChangeSet(projectId,id) { return tx(pool,c=>changeRow(c,projectId,id)); },
    async getByRequestKey(projectId,key) { const r=await pool.query<{payload:KnowledgeChangeSet}>(
      'SELECT payload FROM ccl_knowledge_changesets WHERE project_id=$1 AND request_key=$2',[projectId,key]);
      return r.rows[0]?.payload ?? null; },
    async recordReview(review,externalClient) { const action=async (client:QueryClient) => {
      await lockProject(client,review.projectId);
      await assertKnowledgeWriterAuthority(client,review.projectId,options.writerGrant);
      const change = await changeRow(client,review.projectId,review.changeSetId);
      if (!change) return fail('CHANGESET_MISSING','Change set does not exist');
      if (review.contentHash !== change.contentHash || review.purpose !== change.purpose) return fail('REVIEW_MISMATCH','Review must match the exact hash and purpose');
      if(review.inputReceipt&&review.inputReceipt.fullChangeContentHash!==change.contentHash)
        return fail('REVIEW_PROJECTION_MISMATCH','Semantic review receipt must bind the complete staged change hash');
      if (review.reviewer === change.proposer) return fail('REVIEW_NOT_INDEPENDENT','Reviewer must differ from proposer');
      const existing = await client.query<{payload:KnowledgeReview}>('SELECT payload FROM ccl_knowledge_reviews WHERE project_id=$1 AND id=$2',[review.projectId,review.id]);
      if (existing.rows.length) return same(existing.rows[0].payload,review) ? existing.rows[0].payload : fail('REVIEW_CONFLICT','Review ID already exists');
      if (await client.query('SELECT 1 FROM ccl_knowledge_publications WHERE project_id=$1 AND changeset_id=$2',[review.projectId,review.changeSetId]).then(r=>r.rowCount))
        return fail('ALREADY_PUBLISHED','Reviews cannot change after publication');
      await client.query('INSERT INTO ccl_knowledge_reviews(project_id,id,changeset_id,content_hash,payload) VALUES($1,$2,$3,$4,$5)',
        [review.projectId,review.id,review.changeSetId,review.contentHash,review]);
      await event(client,review.projectId,'KnowledgeReviewed',{changeSetId:review.changeSetId,reviewId:review.id,decision:review.decision});
      return review;
    }; return externalClient ? action(externalClient) : tx(pool,action); },
    async publish(projectId,changeSetId,contentHash,externalClient,expectedEpoch) { const action=async (client:QueryClient) => {
      const oldEpoch = await lockProject(client,projectId);
      await assertKnowledgeWriterAuthority(client,projectId,options.writerGrant);
      if(expectedEpoch!==undefined && oldEpoch!==expectedEpoch) return fail('BUILD_INPUT_CHANGED','Knowledge or scoped use decisions changed after publication preflight');
      const change = await changeRow(client,projectId,changeSetId);
      if (!change || change.contentHash !== contentHash) return fail('CHANGESET_MISMATCH','Change set and exact hash are required');
      const prior = await client.query<{payload:Publication}>('SELECT payload FROM ccl_knowledge_publications WHERE project_id=$1 AND changeset_id=$2',[projectId,changeSetId]);
      if (prior.rows[0]) return prior.rows[0].payload;
      const reviews = await client.query<{payload:KnowledgeReview}>(
        'SELECT payload FROM ccl_knowledge_reviews WHERE project_id=$1 AND changeset_id=$2 ORDER BY recorded_seq DESC LIMIT 1',[projectId,changeSetId]);
      const approved = reviews.rows[0]?.payload;
      if (!approved || approved.contentHash!==contentHash || approved.purpose!==change.purpose ||
          approved.reviewer===change.proposer || !['approved_for_purpose','exploration_only'].includes(approved.decision))
        return fail('REVIEW_REQUIRED','The latest independent matching adoption review must approve this purpose');
      if (change.publicationPermit || await hasPublicationAuthorityScopes(client, projectId)) {
        const facts = await publicationFacts(client, projectId, {
          topicIds: [], sourceObjectIds: [], sourceGroups: [],
          targetObjectIds: change.changes.map(entry => entry.revision.ref.objectId), knowledgeObjectIds: [],
        }, change.changes.map(entry => entry.revision), change.baseHeads.flatMap(base =>
          base.versionId ? [{objectId: base.objectId, versionId: base.versionId}] : []));
        if (!await options.verifySourceAdmission?.(change))
          await assertPublicationPermit(client, projectId, facts, change.methodVersion, change.publicationPermit);
      }
      for (const base of change.baseHeads) if (await headRow(client,projectId,base.objectId) !== base.versionId)
        return fail('HEAD_CONFLICT','A base head changed after this proposal was staged');
      // A withdrawal closes an existing head even when the evidence it cited has become
      // invalid. The manifest is a change-set audit union, not every revision's use set.
      const allDeps = change.changes.flatMap(x=>x.revision.dependencies);
      const activeDeps = change.changes.filter(x=>x.effect!=='withdraw').flatMap(x=>x.revision.dependencies);
      if (change.changes.some(x=>x.effect!=='withdraw' && x.revision.scope.reviewDueAt && Date.parse(x.revision.scope.reviewDueAt) <= Date.now()))
        return fail('REVIEW_DUE','A candidate is already due for review');
      const batchRefs = new Set(change.changes.map(x=>refKey(x.revision.ref)));
      const changedObjects = new Set(change.changes.map(x=>x.revision.ref.objectId));
      if (allDeps.some(dep=>dep.domain==='knowledge' && changedObjects.has(dep.ref.objectId) && !batchRefs.has(refKey(dep.ref))))
        return fail('DEPENDENCY_CYCLE','A new revision cannot depend on a version of its own changed object');
      const withdrawalRefs = new Set(change.changes.filter(x=>x.effect==='withdraw').map(x=>refKey(x.revision.ref)));
      if (activeDeps.some(dep=>dep.domain==='knowledge' && withdrawalRefs.has(refKey(dep.ref))))
        return fail('STALE_DEPENDENCY','An active revision cannot depend on a withdrawal in the same change set');
      const validity = await assess(client,projectId,activeDeps.filter(d=>d.domain!=='knowledge' || !batchRefs.has(refKey(d.ref))));
      if (!validity.valid) return fail('STALE_DEPENDENCY',`Dependencies are invalid: ${validity.issues.map(x=>x.reason).join(',')}`);
      const ordered: typeof change.changes = [];
      const waiting = new Map(change.changes.map(x=>[refKey(x.revision.ref),x]));
      while (waiting.size) {
        const ready=[...waiting].find(([,entry])=>entry.revision.dependencies.every(d=>d.domain!=='knowledge' || !waiting.has(refKey(d.ref))));
        if (!ready) return fail('DEPENDENCY_CYCLE','Candidate revisions form a dependency cycle');
        ordered.push(ready[1]); waiting.delete(ready[0]);
      }
      const publishedAt = new Date().toISOString(); const epoch = oldEpoch+1;
      const superseded: {objectId:string;versionId:string}[]=[];
      for (const {revision:rev} of ordered) {
        const previous = await headRow(client,projectId,rev.ref.objectId);
        await client.query('UPDATE ccl_knowledge_revisions SET published_at=$4 WHERE project_id=$1 AND object_id=$2 AND version_id=$3',
          [projectId,rev.ref.objectId,rev.ref.versionId,publishedAt]);
        await client.query(`INSERT INTO ccl_knowledge_heads(project_id,object_id,version_id) VALUES($1,$2,$3)
          ON CONFLICT(project_id,object_id) DO UPDATE SET version_id=EXCLUDED.version_id`,
          [projectId,rev.ref.objectId,rev.ref.versionId]);
        for (const dep of rev.dependencies) await client.query(`INSERT INTO ccl_knowledge_deps
          (project_id,object_id,version_id,domain,dep_object_id,dep_version_id,role,critical)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT(project_id,object_id,version_id,domain,dep_object_id,dep_version_id,role)
          DO UPDATE SET critical=ccl_knowledge_deps.critical OR EXCLUDED.critical`,
          [projectId,rev.ref.objectId,rev.ref.versionId,dep.domain,dep.ref.objectId,dep.ref.versionId,dep.role,dep.critical]);
        if (previous) {
          superseded.push({objectId:rev.ref.objectId,versionId:previous});
          await cascade(client,projectId,'knowledge',{objectId:rev.ref.objectId,versionId:previous},'superseded','stale',publishedAt);
        }
      }
      const postValidity = await assess(client,projectId,activeDeps);
      if (!postValidity.valid) return fail('STALE_DEPENDENCY',`Dependencies are invalid: ${postValidity.issues.map(x=>x.reason).join(',')}`);
      const publication: Publication = {changeSetId,projectId,refs:change.changes.map(x=>x.revision.ref),epoch,publishedAt};
      await client.query('INSERT INTO ccl_knowledge_publications(project_id,changeset_id,review_id,payload) VALUES($1,$2,$3,$4)',[projectId,changeSetId,approved.id,publication]);
      await client.query('UPDATE ccl_knowledge_projects SET epoch=$2 WHERE project_id=$1',[projectId,epoch]);
      await event(client,projectId,'KnowledgePublished',{changeSetId,refs:publication.refs,superseded,epoch});
      for (const entry of change.changes) if (entry.effect==='withdraw')
        await cascade(client,projectId,'knowledge',entry.revision.ref,'withdrawn','withdrawn',publishedAt);
      return publication;
    }; return externalClient ? action(externalClient) : tx(pool,action); },
    async get(projectId,ref) { return tx(pool,async client => {
      const r = await client.query<{payload:KnowledgeRevision;published_at:Date|null}>(
        'SELECT payload,published_at FROM ccl_knowledge_revisions WHERE project_id=$1 AND object_id=$2 AND version_id=$3',[projectId,ref.objectId,ref.versionId]);
      return r.rows[0] ? revisionView(client,projectId,r.rows[0].payload,r.rows[0].published_at) : null;
    }); },
    async getAsOf(projectId,ref,cutoffAt) {
      if(!Number.isFinite(Date.parse(cutoffAt)))throw new KnowledgeError('INVALID_CUTOFF','Valid historical cutoff required',422);
      return tx(pool,async client=>{
        const r=await client.query<{payload:KnowledgeRevision;published_at:Date|null}>(
          'SELECT payload,published_at FROM ccl_knowledge_revisions WHERE project_id=$1 AND object_id=$2 AND version_id=$3 AND published_at<=$4::timestamptz',
          [projectId,ref.objectId,ref.versionId,cutoffAt]);
        if(!r.rows[0])return null;
        const context={...readContext(),at:cutoffAt};
        return revisionView(client,projectId,r.rows[0].payload,r.rows[0].published_at,context);
      });
    },
    async head(projectId,objectId) { return tx(pool,async c => { const versionId=await headRow(c,projectId,objectId); return versionId ? {objectId,versionId} : null; }); },
    async history(projectId,objectId) { return tx(pool,async client => {
      const r = await client.query<{payload:KnowledgeRevision;published_at:Date|null}>(
        'SELECT payload,published_at FROM ccl_knowledge_revisions WHERE project_id=$1 AND object_id=$2 ORDER BY published_at NULLS LAST,version_id',[projectId,objectId]);
      const views: RevisionView[] = [],context=readContext();
      for (const x of r.rows) views.push(await revisionView(client,projectId,x.payload,x.published_at,context));
      return views;
    }); },
    async search(projectId,options) {
      const query=options.query?.trim() ?? '';
      const lexical=options.lexical;
      if(lexical&&(lexical.methodVersion!=='wiki-lexical-v1'||lexical.terms.length>64||
        lexical.terms.some(term=>term.length<2||term.length>64)||
        !options.kinds?.length||options.kinds.some(kind=>kind!=='wiki_page')))
        throw new KnowledgeError('WIKI_LEXICAL_PLAN_INVALID','Bounded WikiPage lexical plan required',422);
      if(lexical&&!lexical.terms.length)return [];
      // Resolve navigation matches before taking a transaction client. The adapter may share this pool.
      const sourceRefs=!lexical&&query&&sourceMatches ? await sourceMatches(projectId,query) : [];
      return tx(pool,async client => {
      const kinds=options.kinds?.length ? options.kinds : null;
      const sourceGroups=options.sourceGroups?.length ? [...new Set(options.sourceGroups.filter(group=>group.trim().length>0))] : null;
      const sourceGroupParam=lexical?'$6':'$7',platformParam=lexical?'$7':'$8',spaceParam=lexical?'$8':'$9';
      const lexicalJoin=lexical?`CROSS JOIN LATERAL (SELECT lower(normalize(r.title,NFKC)) AS title,
          lower(normalize(r.body,NFKC)) AS body) n
        CROSS JOIN LATERAL (SELECT COALESCE(SUM((
          CASE WHEN position(t.term in n.title)>0 THEN 4 ELSE 0 END+
          CASE WHEN position(t.term in n.body)>0 THEN 1 ELSE 0 END)*LEAST(char_length(t.term),4)),0)::int AS score,
          COALESCE(array_agg(t.term ORDER BY t.ord) FILTER (WHERE
            position(t.term in n.title)>0 OR position(t.term in n.body)>0),'{}'::text[]) AS matched_terms
          FROM unnest($3::text[]) WITH ORDINALITY AS t(term,ord)) lex`:'';
      const r=await client.query<{payload:KnowledgeRevision;published_at:Date;score:number|null;matched_terms:string[]|null}>(
        `SELECT r.payload,r.published_at,${lexical?'lex.score,lex.matched_terms':'NULL::int AS score,NULL::text[] AS matched_terms'}
        FROM ccl_knowledge_revisions r
        JOIN ccl_knowledge_heads h ON h.project_id=r.project_id AND h.object_id=r.object_id AND h.version_id=r.version_id
        ${lexicalJoin}
        WHERE r.project_id=$1 AND ($2::text[] IS NULL OR r.kind=ANY($2))
          AND ${lexical?'lex.score>0':`($3='' OR position(lower($3) in lower(r.title || ' ' || r.body))>0 OR EXISTS (SELECT 1 FROM jsonb_to_recordset($6::jsonb) AS src("objectId" text,"versionId" text) WHERE src."objectId"=r.object_id AND src."versionId"=r.version_id))`}
          AND (${sourceGroupParam}::text[] IS NULL OR r.payload->'sourceGroups' ?| ${sourceGroupParam}::text[])
          AND (${spaceParam}::text IS NULL OR COALESCE(r.payload->'binding'->>'spaceId',
            CASE WHEN r.kind=ANY(ARRAY['case','collection','comparison','pattern'])
              THEN 'legacy:video-research' ELSE 'legacy:knowledge' END)=${spaceParam})
          AND (${platformParam}::text IS NULL OR (${platformParam}<>'unknown' AND (
            COALESCE(r.payload->'scope'->'applicability'->'platforms','["tiktok"]'::jsonb) ? ${platformParam}
            OR (COALESCE(r.payload->'scope'->'applicability'->'platforms','["tiktok"]'::jsonb) ?| ARRAY['tiktok','douyin','xiaohongshu'])
              AND EXISTS (SELECT 1 FROM jsonb_to_recordset(COALESCE(r.payload->'scope'->'applicability'->'platformTransfers','[]'::jsonb)) AS transfer("to" text,rationale text)
              WHERE transfer."to"=${platformParam} AND length(trim(transfer.rationale))>0))))
        ORDER BY ${lexical?'lex.score DESC,':''}r.object_id,r.version_id LIMIT $4 OFFSET $5`,
        lexical?[projectId,kinds,lexical.terms,Math.min(Math.max(options.limit??50,0),200),Math.max(options.offset??0,0),
          sourceGroups?.length?sourceGroups:null,options.platform??null,options.spaceId??null]:
          [projectId,kinds,query,Math.min(Math.max(options.limit??50,0),200),Math.max(options.offset??0,0),JSON.stringify(sourceRefs),
            sourceGroups?.length?sourceGroups:null,options.platform??null,options.spaceId??null]);
      const views: RevisionView[] = [],context=readContext();
      for (const x of r.rows) {context.heads.set(x.payload.ref.objectId,x.payload.ref.versionId);context.revisions.set(refKey(x.payload.ref),{payload:x.payload,published_at:x.published_at});}
      if(r.rows.length){
        const ids=r.rows.map(x=>x.payload.ref.versionId);
        const reviews=await client.query<{version_id:string;payload:KnowledgeReview}>(`SELECT DISTINCT ON (r.version_id) r.version_id,v.payload
            FROM ccl_knowledge_revisions r
            LEFT JOIN ccl_knowledge_publications p ON p.project_id=r.project_id AND p.changeset_id=r.changeset_id
            JOIN ccl_knowledge_reviews v ON v.project_id=r.project_id AND v.changeset_id=r.changeset_id
              AND (p.review_id IS NULL OR p.review_id=v.id)
            WHERE r.project_id=$1 AND r.version_id=ANY($2::text[]) ORDER BY r.version_id,v.recorded_seq DESC`,[projectId,ids]);
        const invalidities=await client.query<{domain:DependencyDomain;object_id:string;version_id:string;reason:string;state:Invalidity['state'];created_at:Date}>(
            `SELECT domain,object_id,version_id,reason,state,created_at FROM ccl_knowledge_invalidities
             WHERE project_id=$1 AND domain='knowledge' AND version_id=ANY($2::text[])`,[projectId,ids]);
        const effects=await client.query<{version_id:string;effect:string}>(`SELECT r.version_id,x.effect FROM ccl_knowledge_revisions r
            JOIN ccl_knowledge_changesets c ON c.project_id=r.project_id AND c.id=r.changeset_id
            CROSS JOIN LATERAL jsonb_to_recordset(c.payload->'changes') AS x(revision jsonb,effect text,explanation text)
            WHERE r.project_id=$1 AND r.version_id=ANY($2::text[]) AND x.revision->'ref'->>'versionId'=r.version_id`,[projectId,ids]);
        const refs=new Map(r.rows.map(x=>[x.payload.ref.versionId,x.payload.ref]));
        for(const x of r.rows){context.reviews.set(refKey(x.payload.ref),null);context.invalidities.set(`knowledge:${refKey(x.payload.ref)}`,[]);context.effects.set(refKey(x.payload.ref),null);}
        for(const row of reviews.rows){const ref=refs.get(row.version_id);if(ref)context.reviews.set(refKey(ref),row.payload);}
        for(const row of invalidities.rows){const ref=refs.get(row.version_id);if(ref)context.invalidities.get(`knowledge:${refKey(ref)}`)!.push({domain:row.domain,ref,reason:row.reason,state:row.state,createdAt:row.created_at.toISOString()});}
        for(const row of effects.rows){const ref=refs.get(row.version_id);if(ref)context.effects.set(refKey(ref),row.effect);}
      }
      for (const x of r.rows) {
        const view=await revisionView(client,projectId,x.payload,x.published_at,context);
        if(lexical)view.searchMatch={methodVersion:lexical.methodVersion,matchedTerms:x.matched_terms??[],score:x.score??0};
        views.push(view);
      }
      return views;
    }); },
    async countCurrent(projectId) {
      const r=await pool.query('SELECT count(*)::int total FROM ccl_knowledge_heads WHERE project_id=$1',[projectId]);
      return Number(r.rows[0].total);
    },
    async catalog(projectId,options) {
      const query=options.query?.trim()??'',kinds=options.kinds?.length?options.kinds:null;
      const platform=options.platform??null;
      const limit=Math.min(Math.max(options.limit??50,1),50);
      const sourceRefs=query && sourceMatches ? await sourceMatches(projectId,query) : [];
      const binding={projectId,query,kinds,...(platform?{platform}:{})};let after:string|null=null;
      if(options.cursor)try {
        if(!/^[A-Za-z0-9_-]{1,2000}$/.test(options.cursor))throw new Error('malformed');
        const bytes=Buffer.from(options.cursor,'base64url');if(bytes.toString('base64url')!==options.cursor)throw new Error('malformed');
        const parsed=JSON.parse(bytes.toString('utf8'));
        if(!same(parsed.binding,binding)||typeof parsed.after!=='string'||!parsed.after)throw new Error('binding');
        after=parsed.after;
      }catch {throw new KnowledgeError('INVALID_CURSOR','Catalog cursor does not match this project and filter',400);}
      const count=await pool.query(`SELECT count(*)::int total FROM ccl_knowledge_revisions r
        JOIN ccl_knowledge_heads h ON h.project_id=r.project_id AND h.object_id=r.object_id AND h.version_id=r.version_id
        WHERE r.project_id=$1 AND ($2::text[] IS NULL OR r.kind=ANY($2))
          AND ($3='' OR position(lower($3) in lower(r.title || ' ' || r.body))>0 OR EXISTS (SELECT 1 FROM jsonb_to_recordset($4::jsonb) AS src("objectId" text,"versionId" text) WHERE src."objectId"=r.object_id AND src."versionId"=r.version_id))
          AND ($5::text IS NULL OR ($5<>'unknown' AND (
            COALESCE(r.payload->'scope'->'applicability'->'platforms','["tiktok"]'::jsonb) ? $5
            OR (COALESCE(r.payload->'scope'->'applicability'->'platforms','["tiktok"]'::jsonb) ?| ARRAY['tiktok','douyin','xiaohongshu'])
              AND EXISTS (SELECT 1 FROM jsonb_to_recordset(COALESCE(r.payload->'scope'->'applicability'->'platformTransfers','[]'::jsonb)) AS transfer("to" text,rationale text)
              WHERE transfer."to"=$5 AND length(trim(transfer.rationale))>0))))`,[projectId,kinds,query,JSON.stringify(sourceRefs),platform]);
      const rows=await pool.query<{object_id:string;version_id:string;kind:KnowledgeCatalogSummary['kind'];title:string;summary:string;created_at:string;review_due_at:string|null;review_due:boolean;withdrawn:boolean;review_decision:KnowledgeReview['decision']|null;invalidity_recorded:boolean}>(`
        SELECT r.object_id,r.version_id,r.kind,r.title,
          left(COALESCE(r.payload->'content'->>'summary',r.payload->'content'->>'statement',r.payload->'content'->'decisionGuide'->>'judgment',r.payload->'content'->'task'->>'goal',r.body),240) summary,
          r.payload->>'createdAt' created_at,r.payload->'scope'->>'reviewDueAt' review_due_at,
          COALESCE((r.payload->'scope'->>'reviewDueAt')::timestamptz<=now(),false) review_due,
          EXISTS (SELECT 1 FROM jsonb_array_elements(c.payload->'changes') change
            WHERE change->>'effect'='withdraw' AND change->'revision'->'ref'->>'versionId'=r.version_id) withdrawn,
          review.payload->>'decision' review_decision,
          EXISTS (SELECT 1 FROM ccl_knowledge_invalidities i WHERE i.project_id=r.project_id AND i.domain='knowledge' AND i.object_id=r.object_id AND i.version_id=r.version_id) invalidity_recorded
        FROM ccl_knowledge_revisions r
        JOIN ccl_knowledge_heads h ON h.project_id=r.project_id AND h.object_id=r.object_id AND h.version_id=r.version_id
        JOIN ccl_knowledge_changesets c ON c.project_id=r.project_id AND c.id=r.changeset_id
        LEFT JOIN ccl_knowledge_publications p ON p.project_id=r.project_id AND p.changeset_id=r.changeset_id
        LEFT JOIN ccl_knowledge_reviews review ON review.project_id=r.project_id AND review.id=p.review_id
        WHERE r.project_id=$1 AND ($2::text[] IS NULL OR r.kind=ANY($2))
          AND ($3='' OR position(lower($3) in lower(r.title || ' ' || r.body))>0 OR EXISTS (SELECT 1 FROM jsonb_to_recordset($6::jsonb) AS src("objectId" text,"versionId" text) WHERE src."objectId"=r.object_id AND src."versionId"=r.version_id))
          AND ($4::text IS NULL OR r.object_id>$4)
          AND ($7::text IS NULL OR ($7<>'unknown' AND (
            COALESCE(r.payload->'scope'->'applicability'->'platforms','["tiktok"]'::jsonb) ? $7
            OR (COALESCE(r.payload->'scope'->'applicability'->'platforms','["tiktok"]'::jsonb) ?| ARRAY['tiktok','douyin','xiaohongshu'])
              AND EXISTS (SELECT 1 FROM jsonb_to_recordset(COALESCE(r.payload->'scope'->'applicability'->'platformTransfers','[]'::jsonb)) AS transfer("to" text,rationale text)
              WHERE transfer."to"=$7 AND length(trim(transfer.rationale))>0))))
        ORDER BY r.object_id LIMIT $5`,[projectId,kinds,query,after,limit+1,JSON.stringify(sourceRefs),platform]);
      const visible=rows.rows.slice(0,limit),last=visible.at(-1),hasMore=rows.rows.length>limit;
      return {schemaVersion:'1.0',items:visible.map(row=>({ref:{objectId:row.object_id,versionId:row.version_id},kind:row.kind,title:row.title.slice(0,240),summary:row.summary,
        createdAt:row.created_at,reviewDecision:row.review_decision,reviewDueAt:row.review_due_at,
        reviewDue:row.review_due,withdrawn:row.withdrawn,invalidityRecorded:row.invalidity_recorded})),
        pageInfo:{total:Number(count.rows[0].total),hasMore,nextCursor:hasMore&&last?Buffer.from(JSON.stringify({binding,after:last.object_id})).toString('base64url'):null}};
    },
    async impact(projectId,rootId) {
      const match=/^knowledge:([^/]+)\/([^/]+)$/.exec(rootId),limit=1000;
      const unknown=():KnowledgeImpactResult=>({schemaVersion:'1.0',basis:'authoritative_critical_dependencies',rootId,affectedIds:[],criticalEdgeIds:[],complete:false,completeness:'unknown',limit});
      if(!match)return unknown();
      const root={objectId:match[1],versionId:match[2]};
      const exists=await pool.query('SELECT 1 FROM ccl_knowledge_revisions WHERE project_id=$1 AND object_id=$2 AND version_id=$3 AND published_at IS NOT NULL',[projectId,root.objectId,root.versionId]);
      if(!exists.rowCount)return unknown();
      const rows=await pool.query<{source:string;target:string;role:string}>(`WITH RECURSIVE walk(source,target,role,path) AS (
        SELECT 'knowledge:'||$2||'/'||$3 AS source,'knowledge:'||d.object_id||'/'||d.version_id AS target,d.role,
          ARRAY[$2||':'||$3,d.object_id||':'||d.version_id]::text[] AS path
        FROM ccl_knowledge_deps d JOIN ccl_knowledge_revisions r ON r.project_id=d.project_id AND r.object_id=d.object_id AND r.version_id=d.version_id
        WHERE d.project_id=$1 AND d.domain='knowledge' AND d.dep_object_id=$2 AND d.dep_version_id=$3 AND d.critical AND r.published_at IS NOT NULL
        UNION ALL
        SELECT w.target,'knowledge:'||d.object_id||'/'||d.version_id,d.role,w.path||(d.object_id||':'||d.version_id)
        FROM walk w JOIN ccl_knowledge_deps d ON d.project_id=$1 AND d.domain='knowledge' AND d.critical
          AND d.dep_object_id=split_part(split_part(w.target,':',2),'/',1) AND d.dep_version_id=split_part(w.target,'/',2)
        JOIN ccl_knowledge_revisions r ON r.project_id=d.project_id AND r.object_id=d.object_id AND r.version_id=d.version_id AND r.published_at IS NOT NULL
        WHERE cardinality(w.path)<$4 AND NOT ((d.object_id||':'||d.version_id)=ANY(w.path))
      ) SELECT source,target,role FROM walk LIMIT $5`,[projectId,root.objectId,root.versionId,limit+1,limit+1]);
      const truncated=rows.rows.length>=limit;const edges=rows.rows.slice(0,limit),affectedIds=[...new Set(edges.map(row=>row.target))];
      return {schemaVersion:'1.0',basis:'authoritative_critical_dependencies',rootId,affectedIds,
        criticalEdgeIds:edges.map(row=>`${row.source}|${row.role}|${row.target}`),complete:!truncated,completeness:truncated?'truncated':'complete',limit};
    },
    async validate(projectId,dependencies) { return tx(pool,c=>assess(c,projectId,dependencies)); },
    async invalidate(projectId,invalidity) { return tx(pool,async client => {
      await assertKnowledgeWriterAuthority(client,projectId,options.writerGrant);
      await lockProject(client,projectId);
      const affected=await cascade(client,projectId,invalidity.domain,invalidity.ref,invalidity.reason,invalidity.state,invalidity.createdAt);
      await client.query('UPDATE ccl_knowledge_projects SET epoch=epoch+1 WHERE project_id=$1',[projectId]);
      await event(client,projectId,'KnowledgeInvalidated',{invalidity,affected});
      return affected;
    }); },
    async dependents(projectId,dependency) { return tx(pool,async client => {
      const r=await client.query<{object_id:string;version_id:string}>(`SELECT DISTINCT d.object_id,d.version_id FROM ccl_knowledge_deps d
        JOIN ccl_knowledge_revisions r ON r.project_id=d.project_id AND r.object_id=d.object_id AND r.version_id=d.version_id
        WHERE d.project_id=$1 AND d.domain=$2 AND d.dep_object_id=$3 AND d.dep_version_id=$4 AND r.published_at IS NOT NULL
        ORDER BY d.object_id,d.version_id`,[projectId,dependency.domain,dependency.ref.objectId,dependency.ref.versionId]);
      return r.rows.map(x=>({objectId:x.object_id,versionId:x.version_id}));
    }); },
    async epoch(projectId) { const r=await pool.query<{epoch:string}>('SELECT epoch FROM ccl_knowledge_projects WHERE project_id=$1',[projectId]); return Number(r.rows[0]?.epoch??0); },
    async events(projectId,after,limit=100) { const r=await pool.query<{sequence:string;project_id:string;kind:string;data:Record<string,unknown>;occurred_at:Date}>(
      'SELECT sequence,project_id,kind,data,occurred_at FROM ccl_knowledge_events WHERE project_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3',
      [projectId,after,Math.min(Math.max(limit,0),500)]);
      return r.rows.map(x=>({sequence:Number(x.sequence),projectId:x.project_id,kind:x.kind,data:x.data,occurredAt:x.occurred_at.toISOString()} satisfies KnowledgeEvent));
    },
  };
}
