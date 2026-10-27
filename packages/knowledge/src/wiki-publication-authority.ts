import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { KnowledgeError } from './types.ts';

type QueryClient = Pick<PoolClient, 'query'>;

/** One protected range in a project's existing configuration row. */
export interface PublicationAuthorityScopeV1 {
  scopeId: string;
  generation: number;
  mode: 'active' | 'read_only';
  allowedMethodVersions: string[];
  topicIds: string[];
  sourceObjectIds: string[];
  sourceGroups: string[];
  targetObjectIds: string[];
}

export interface PublicationScopeFacts {
  /** Trusted, normalized facts for every revision in the candidate change set. */
  topicIds: string[];
  sourceObjectIds: string[];
  sourceGroups: string[];
  targetObjectIds: string[];
  /** Include knowledge dependencies and their resolved ancestors, not just direct refs. */
  knowledgeObjectIds: string[];
}

export const PublicationPermitSchema = z.strictObject({
  schemaVersion: z.literal('wiki-publication-permit@1'),
  projectId: z.string().trim().min(1),
  methodVersion: z.string().trim().min(1),
  grants: z.array(z.strictObject({ scopeId: z.string().trim().min(1), generation: z.int().min(1) })).min(1),
});
export type PublicationPermit = z.infer<typeof PublicationPermitSchema>;

interface AuthorityConfig { scopes: PublicationAuthorityScopeV1[] }
const emptyConfig = (): AuthorityConfig => ({ scopes: [] });
const deny = (code: string, message: string): never => { throw new KnowledgeError(code, message); };
const validName = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value === value.trim();
const validNames = (value: unknown): value is string[] => Array.isArray(value) && value.every(validName) && new Set(value).size === value.length;
const selectors = ['topicIds', 'sourceObjectIds', 'sourceGroups', 'targetObjectIds'] as const;

function parseConfig(value: unknown): AuthorityConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray((value as AuthorityConfig).scopes))
    return deny('PUBLICATION_AUTHORITY_CONFIG_INVALID', 'Publication authority configuration is invalid');
  const scopes = (value as AuthorityConfig).scopes;
  const ids = new Set<string>();
  for (const scope of scopes) {
    if (!scope || !validName(scope.scopeId) || ids.has(scope.scopeId) ||
        !Number.isSafeInteger(scope.generation) || scope.generation < 1 ||
        (scope.mode !== 'active' && scope.mode !== 'read_only') ||
        !validNames(scope.allowedMethodVersions) ||
        selectors.some(field => !validNames(scope[field])) ||
        selectors.every(field => scope[field].length === 0))
      return deny('PUBLICATION_AUTHORITY_CONFIG_INVALID', 'Publication authority scope is invalid');
    ids.add(scope.scopeId);
  }
  return { scopes };
}

function validFacts(facts: PublicationScopeFacts): void {
  if (!facts || [...selectors, 'knowledgeObjectIds' as const].some(field => !validNames(facts[field])))
    deny('PUBLICATION_AUTHORITY_FACTS_INVALID', 'Trusted publication scope facts are invalid');
}

/** A scope is protected when any trusted topic, source, target, or knowledge dependency touches it. */
export function matchPublicationScopes(config: AuthorityConfig, facts: PublicationScopeFacts): PublicationAuthorityScopeV1[] {
  const parsed = parseConfig(config);
  validFacts(facts);
  const topics = new Set(facts.topicIds);
  const sources = new Set(facts.sourceObjectIds);
  const groups = new Set(facts.sourceGroups);
  const objects = new Set([...facts.targetObjectIds, ...facts.knowledgeObjectIds]);
  return parsed.scopes.filter(scope => scope.topicIds.some(id => topics.has(id)) ||
    scope.sourceObjectIds.some(id => sources.has(id)) ||
    scope.sourceGroups.some(group => groups.has(group)) ||
    scope.targetObjectIds.some(id => objects.has(id)));
}

/** Called by the existing knowledge migration; this adds no separate run or publication ledger. */
export async function migratePublicationAuthority(pool: Pick<Pool, 'query'>): Promise<void> {
  await pool.query("ALTER TABLE ccl_knowledge_projects ADD COLUMN IF NOT EXISTS wiki_publication_authority jsonb NOT NULL DEFAULT '{\"scopes\":[]}'::jsonb");
}

/** Used by the legacy scheduler to keep raw registration while stopping migrated cognition writes. */
export async function isPublicationScopeProtected(pool: Pool, projectId: string, facts: PublicationScopeFacts): Promise<boolean> {
  return transaction(pool, async client => matchPublicationScopes(await lockedConfig(client, projectId), facts).length > 0);
}

async function lockedConfig(client: QueryClient, projectId: string): Promise<AuthorityConfig> {
  await client.query('INSERT INTO ccl_knowledge_projects(project_id) VALUES($1) ON CONFLICT DO NOTHING', [projectId]);
  const rows = await client.query<{ wiki_publication_authority: AuthorityConfig }>(
    'SELECT wiki_publication_authority FROM ccl_knowledge_projects WHERE project_id=$1 FOR UPDATE', [projectId]);
  return parseConfig(rows.rows[0]?.wiki_publication_authority ?? emptyConfig());
}

/** Fast path for projects which have not enabled any protected publication scope. */
export async function hasPublicationAuthorityScopes(client: QueryClient, projectId: string): Promise<boolean> {
  return (await lockedConfig(client, projectId)).scopes.length > 0;
}

async function transaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

/** Adds or changes a scope under the same project row lock as knowledge publication. */
export async function setPublicationAuthorityScope(
  pool: Pool, projectId: string, expectedGeneration: number | null,
  scope: Omit<PublicationAuthorityScopeV1, 'generation'>,
): Promise<PublicationAuthorityScopeV1> {
  return transaction(pool, async client => {
    const config = await lockedConfig(client, projectId);
    const previous = config.scopes.find(item => item.scopeId === scope.scopeId);
    if ((previous?.generation ?? null) !== expectedGeneration)
      return deny('PUBLICATION_AUTHORITY_CONFLICT', 'Publication authority generation changed');
    const next = { ...scope, generation: (previous?.generation ?? 0) + 1 };
    const scopes = config.scopes.filter(item => item.scopeId !== scope.scopeId).concat(next);
    parseConfig({ scopes });
    await client.query('UPDATE ccl_knowledge_projects SET wiki_publication_authority=$2 WHERE project_id=$1',
      [projectId, { scopes }]);
    return next;
  });
}

/** Freeze a permit at task admission. A later switch invalidates it even before any head changes. */
export async function capturePublicationPermit(
  pool: Pool, projectId: string, facts: PublicationScopeFacts, methodVersion: string,
): Promise<PublicationPermit | null> {
  return transaction(pool, async client => {
    const scopes = matchPublicationScopes(await lockedConfig(client, projectId), facts);
    if (!scopes.length) return null;
    if (!validName(methodVersion) || scopes.some(scope => scope.mode !== 'active' || !scope.allowedMethodVersions.includes(methodVersion)))
      return deny('PUBLICATION_AUTHORITY_DENIED', 'Publication authority is read-only or does not allow this method');
    return { schemaVersion: 'wiki-publication-permit@1', projectId, methodVersion,
      grants: scopes.map(({ scopeId, generation }) => ({ scopeId, generation })) };
  });
}

/** Call inside store.publish's transaction after its project lock, before any publication/head write. */
export async function assertPublicationPermit(
  client: QueryClient, projectId: string, facts: PublicationScopeFacts, methodVersion: string,
  permit: PublicationPermit | null | undefined,
): Promise<void> {
  const scopes = matchPublicationScopes(await lockedConfig(client, projectId), facts);
  if (!scopes.length && !permit) return;
  if (!permit || !PublicationPermitSchema.safeParse(permit).success ||
      !validName(methodVersion) || permit.projectId !== projectId || permit.methodVersion !== methodVersion ||
      permit.grants.length !== scopes.length)
    return deny('PUBLICATION_AUTHORITY_PERMIT_REQUIRED', 'A frozen publication permit is required for this protected scope');
  const granted = new Map(permit.grants.map(item => [item.scopeId, item.generation]));
  if (granted.size !== permit.grants.length || scopes.some(scope =>
    granted.get(scope.scopeId) !== scope.generation || scope.mode !== 'active' ||
    !scope.allowedMethodVersions.includes(methodVersion)))
    deny('PUBLICATION_AUTHORITY_DENIED', 'Publication permit no longer authorizes this scope and method');
}
