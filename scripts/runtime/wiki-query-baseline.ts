/** Synthetic, in-memory reference for store.search's Wiki lexical SQL branches. */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { planWikiLexicalQuery, type WikiLexicalMethodVersion } from '../../packages/knowledge/src/wiki-lexical-query.ts';
import { migrateKnowledge } from '../../packages/knowledge/src/migrations.ts';
import { createKnowledgeStore } from '../../packages/knowledge/src/store.ts';
import { getWikiPageProfile, wikiPageInputFingerprint, wikiPageProfileFingerprint,
  wikiPageReadsetFingerprint, WikiPageContentSchema } from '../../packages/knowledge/src/wiki-page.ts';
import type { KnowledgeRevision } from '../../packages/knowledge/src/types.ts';
import { readTestDatabase } from './test-database.mjs';

export type Category = 'locate' | 'cross_page' | 'conditions_evidence';
export type Page = { id: string; versionId: string; title: string; body: string; sourceGroup: string | null; aliases: string[];
  identityKey?: string; spaceId?: string };
export type Question = { id: string; category: Category; question: string; requiredPageIds: string[];
  answerability: 'answerable' | 'missing_evidence' | 'unanswerable'; evidenceIssue: string | null };
export type Corpus = { schemaVersion: 'wiki-query-corpus/1'; provenance: string; pages: Page[]; questions: Question[] };

const normalize = (value: string) => value.normalize('NFKC').toLowerCase();
/** Mirrors position(term in lower(normalize(title/body,NFKC))) and the SQL weights. */
export function lexicalScore(page: Page, terms: readonly string[]): number {
  const title = normalize(page.title), body = normalize(page.body);
  return terms.reduce((sum, term) => sum +
    ((title.includes(term) ? 4 : 0) + (body.includes(term) ? 1 : 0)) * Math.min(Array.from(term).length, 4), 0);
}

/** v2 adds one identity signal per term: key wins over any matching aliases. */
export function lexicalV2Score(page: Page, terms: readonly string[]): number {
  const key = normalize(page.identityKey ?? page.title), aliases = page.aliases.map(normalize);
  return lexicalScore(page, terms) + terms.reduce((sum, term) => sum +
    (key.includes(term) ? 4 : aliases.some(alias => alias.includes(term)) ? 3 : 0) *
    Math.min(Array.from(term).length, 4), 0);
}

/** Mirrors score DESC, object_id ASC, version_id ASC; only positive scores survive. */
export function rankPages(pages: readonly Page[], question: string): Page[] {
  const { terms } = planWikiLexicalQuery(question);
  if (!terms.length) return [];
  return pages.map(page => ({ page, score: lexicalScore(page, terms) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.page.id.localeCompare(b.page.id, 'en') ||
      a.page.versionId.localeCompare(b.page.versionId, 'en'))
    .map(item => item.page);
}

export function rankV2Pages(pages: readonly Page[], question: string): Page[] {
  const { terms } = planWikiLexicalQuery(question, 'wiki-lexical-v2');
  if (!terms.length) return [];
  return pages.map(page => ({ page, score: lexicalV2Score(page, terms) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.page.id.localeCompare(b.page.id, 'en') ||
      a.page.versionId.localeCompare(b.page.versionId, 'en'))
    .map(item => item.page);
}

export function validateCorpus(corpus: Corpus): void {
  if (corpus.schemaVersion !== 'wiki-query-corpus/1') throw new Error('Unsupported corpus version');
  const ids = new Set(corpus.pages.map(page => page.id));
  if (ids.size !== corpus.pages.length) throw new Error('Duplicate page ID');
  if (new Set(corpus.questions.map(question => question.id)).size !== corpus.questions.length) throw new Error('Duplicate question ID');
  for (const category of ['locate', 'cross_page', 'conditions_evidence'] as const)
    if (corpus.questions.filter(question => question.category === category).length < 10)
      throw new Error(`Fewer than ten ${category} questions`);
  for (const question of corpus.questions) {
    if (new Set(question.requiredPageIds).size !== question.requiredPageIds.length ||
        question.requiredPageIds.some(id => !ids.has(id))) throw new Error(`Invalid required pages: ${question.id}`);
    if (question.answerability !== 'answerable' && !question.evidenceIssue)
      throw new Error(`Missing evidence marker: ${question.id}`);
  }
}

type QuestionResult = { id: string; category: Category; answerability: Question['answerability'];
  evidenceIssue: string | null; requiredPageIds: string[]; top10: string[]; recallAt10: number | null;
  missingAt10: string[]; directory100Top10: string[]; first20ProxyTop10: string[];
  missingInDirectory100At10: string[]; missingInFirst20ProxyAt10: string[];
  outsideDirectory100: string[]; outsideFirst20Proxy: string[];
  terms: string[]; termsTruncated: boolean };

export function runBaseline(corpus: Corpus, methodVersion: WikiLexicalMethodVersion = 'wiki-lexical-v1') {
  validateCorpus(corpus);
  const rank = methodVersion === 'wiki-lexical-v2' ? rankV2Pages : rankPages;
  const directory = [...corpus.pages].sort((a, b) => a.id.localeCompare(b.id, 'en') ||
    a.versionId.localeCompare(b.versionId, 'en'));
  const first100 = new Set(directory.slice(0, 100).map(page => page.id));
  const first20 = new Set(directory.slice(0, 20).map(page => page.id));
  const questions: QuestionResult[] = corpus.questions.map(item => {
    const plan = planWikiLexicalQuery(item.question, methodVersion);
    const top10 = rank(corpus.pages, item.question).slice(0, 10).map(page => page.id);
    const directory100Top10 = rank(directory.slice(0, 100), item.question).slice(0, 10).map(page => page.id);
    const first20ProxyTop10 = rank(directory.slice(0, 20), item.question).slice(0, 10).map(page => page.id);
    const hits = item.requiredPageIds.filter(id => top10.includes(id));
    return { id: item.id, category: item.category, answerability: item.answerability,
      evidenceIssue: item.evidenceIssue, requiredPageIds: item.requiredPageIds, top10,
      directory100Top10, first20ProxyTop10,
      recallAt10: item.requiredPageIds.length ? hits.length / item.requiredPageIds.length : null,
      missingAt10: item.requiredPageIds.filter(id => !hits.includes(id)),
      missingInDirectory100At10: item.requiredPageIds.filter(id => !directory100Top10.includes(id)),
      missingInFirst20ProxyAt10: item.requiredPageIds.filter(id => !first20ProxyTop10.includes(id)),
      outsideDirectory100: item.requiredPageIds.filter(id => !first100.has(id)),
      outsideFirst20Proxy: item.requiredPageIds.filter(id => !first20.has(id)),
      terms: plan.terms, termsTruncated: plan.termsTruncated };
  });
  const summarize = (rows: QuestionResult[]) => {
    const relevant = rows.filter(row => row.requiredPageIds.length);
    const required = relevant.reduce((n, row) => n + row.requiredPageIds.length, 0);
    const found = relevant.reduce((n, row) => n + row.requiredPageIds.length - row.missingAt10.length, 0);
    const windowFound = (field: 'missingInDirectory100At10' | 'missingInFirst20ProxyAt10') =>
      relevant.reduce((n, row) => n + row.requiredPageIds.length - row[field].length, 0);
    return { questions: rows.length, questionsWithRequiredPages: relevant.length,
      noRelevantPageQuestions: rows.length - relevant.length, requiredPages: required, foundAt10: found,
      recallAt10: required ? found / required : null,
      directory100RecallAt10: required ? windowFound('missingInDirectory100At10') / required : null,
      first20ProxyRecallAt10: required ? windowFound('missingInFirst20ProxyAt10') / required : null,
      completeAt10: relevant.filter(row => !row.missingAt10.length).length,
      questionsMissingInDirectory100: rows.filter(row => row.missingInDirectory100At10.length).length,
      questionsMissingInFirst20Proxy: rows.filter(row => row.missingInFirst20ProxyAt10.length).length,
      outsideDirectory100: rows.filter(row => row.outsideDirectory100.length).length,
      outsideFirst20Proxy: rows.filter(row => row.outsideFirst20Proxy.length).length };
  };
  return { label: 'in-memory lexical reference; not SQL/store.search integration',
    provenance: corpus.provenance, methodVersion,
    scoring: methodVersion === 'wiki-lexical-v2'
      ? 'SQL-equivalent NFKC lowercase substring; title 4, body 1, identity key 4 or any alias 3 once per term; term length capped at 4; score DESC then object/version ID'
      : 'SQL-equivalent NFKC lowercase title/body substring; title 4, body 1, term length capped at 4; score DESC then object/version ID',
    windowNote: 'directory100 is first 100 current page IDs; first20Proxy is first 20 of that directory, NOT the LLM planner selection',
    coverage: { pages: corpus.pages.length, questions: corpus.questions.length,
      answerable: questions.filter(q => q.answerability === 'answerable').length,
      missingEvidence: questions.filter(q => q.answerability === 'missing_evidence').length,
      unanswerable: questions.filter(q => q.answerability === 'unanswerable').length },
    overall: summarize(questions), byCategory: Object.fromEntries((['locate', 'cross_page', 'conditions_evidence'] as const)
      .map(category => [category, summarize(questions.filter(question => question.category === category))])),
    failures: questions.filter(q => q.missingAt10.length || q.missingInDirectory100At10.length || q.missingInFirst20ProxyAt10.length ||
      q.answerability !== 'answerable' || !q.requiredPageIds.length), questions };
}

export function loadCorpus(): Corpus {
  const path = fileURLToPath(new URL('../../packages/knowledge-application/test/fixtures/wiki-query-corpus.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as Corpus;
}

export function syntheticRevision(page: Page, projectId: string): KnowledgeRevision {
  const content = WikiPageContentSchema.parse({schemaVersion: '1.0', profile: {id: 'concept', version: '1'},
    identity: {key: page.identityKey ?? page.title, aliases: page.aliases}, summary: page.body,
    conditions: [], counterexamples: [], unknowns: [], nextQuestions: [], citations: [], navigation: []});
  const scope = {applicability: {productVersionRefs: [], markets: [], languages: [], audiences: [], goals: [],
    requiredProduction: [], transferRationale: null}, limitations: ['Synthetic baseline fixture'], unknowns: [], reviewDueAt: null};
  const base = {kind: 'wiki_page' as const, ref: {objectId: page.id, versionId: page.versionId}, projectId,
    title: page.title, body: page.body, content, scope, dependencies: [],
    sourceGroups: page.sourceGroup ? [page.sourceGroup] : [], artifactRef: null,
    createdAt: '2026-11-02T00:00:00.000Z', analysisQuality: null};
  const profile = getWikiPageProfile('concept', '1');
  if (!profile) throw new Error('Concept profile unavailable');
  return {...base, binding: {bindingKind: 'wiki_page', spaceId: page.spaceId ?? 'knowledge', specificationId: 'synthetic-query-baseline',
    specificationVersion: '1', contentVersion: 'wiki_page/1.0', methodVersion: 'wiki-lexical-v1',
    policyVersion: 'synthetic-baseline-v1', inputFingerprint: wikiPageInputFingerprint(base),
    readsetFingerprint: wikiPageReadsetFingerprint(base), profileFingerprint: wikiPageProfileFingerprint(profile)}};
}

/** Validates actual store.search against the reference in a disposable, isolated schema. */
export async function runSqlValidation(corpus: Corpus, methodVersion: WikiLexicalMethodVersion = 'wiki-lexical-v1') {
  validateCorpus(corpus);
  const url = readTestDatabase(process.env, {required: true})!;
  const schema = `wiki_query_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({connectionString: url, max: 1});
  let pool: Pool | undefined;
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    pool = new Pool({connectionString: url, options: `-c search_path=${schema}`, max: 4});
    await migrateKnowledge(pool);
    const projectId = `synthetic-${schema}`;
    await pool.query('INSERT INTO ccl_knowledge_projects(project_id) VALUES($1)', [projectId]);
    for (const page of corpus.pages) {
      const revision = syntheticRevision(page, projectId);
      const change = {changes: [{revision: {ref: revision.ref}, effect: 'create', explanation: 'Synthetic baseline'}]};
      await pool.query(`INSERT INTO ccl_knowledge_changesets(project_id,id,request_key,request_hash,content_hash,payload)
        VALUES($1,$2,$3,$4,$5,$6)`, [projectId, page.id, `fixture:${page.id}`, page.id, page.versionId, change]);
      await pool.query(`INSERT INTO ccl_knowledge_revisions(project_id,object_id,version_id,changeset_id,kind,title,body,payload,published_at)
        VALUES($1,$2,$3,$4,'wiki_page',$5,$6,$7,$8)`, [projectId, page.id, page.versionId, page.id,
        page.title, page.body, revision, revision.createdAt]);
      await pool.query('INSERT INTO ccl_knowledge_heads(project_id,object_id,version_id) VALUES($1,$2,$3)',
        [projectId, page.id, page.versionId]);
    }
    const store = createKnowledgeStore(pool, {});
    const mismatches: Array<{id: string; expected: string[]; actual: string[]}> = [];
    for (const item of corpus.questions) {
      const plan = planWikiLexicalQuery(item.question, methodVersion);
      const expected = (methodVersion === 'wiki-lexical-v2' ? rankV2Pages : rankPages)(corpus.pages, item.question).slice(0, 10).map(page => page.id);
      const actual = (await store.search(projectId, {kinds: ['wiki_page'], spaceId: 'knowledge',
        lexical: plan, limit: 10, offset: 0})).map(view => view.revision.ref.objectId);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) mismatches.push({id: item.id, expected, actual});
    }
    const server = await pool.query<{server_version: string; database_name: string}>(
      "SELECT current_setting('server_version') AS server_version, current_database() AS database_name");
    return {state: mismatches.length ? 'mismatch' : 'passed', methodVersion, mode: 'real store.search in isolated PostgreSQL schema',
      environment: {nodeVersion: process.version, postgresVersion: server.rows[0]?.server_version,
        databaseName: server.rows[0]?.database_name, connection: 'explicit loopback disposable TEST_DATABASE_URL',
        schema: 'unique temporary schema, dropped in finally'},
      questionsCompared: corpus.questions.length, seededPages: corpus.pages.length, mismatches};
  } finally {
    if (pool) await pool.end();
    if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const corpus = loadCorpus();
  const withSql = process.argv.includes('--sql');
  const withV2 = process.argv.includes('--v2');
  const result = {...runBaseline(corpus, withV2 ? 'wiki-lexical-v2' : 'wiki-lexical-v1'),
    ...(withSql ? {label: 'in-memory lexical reference validated against real store.search; not full /query integration'} : {}),
    evidenceScope: 'developer-authored synthetic Wiki pages and questions; no real business gold labels, model answers, business database, or credentials',
    execution: {nodeVersion: process.version, retrieval: withSql ? 'in-memory reference plus real store.search parity' : 'in-memory lexical reference only'},
    sqlValidation: withSql
    ? await runSqlValidation(corpus, withV2 ? 'wiki-lexical-v2' : 'wiki-lexical-v1')
    : {state: 'not_run', reason: 'Use --sql with an explicit disposable TEST_DATABASE_URL'},
    ...withV2 ? {v1Comparison: {overall: runBaseline(corpus).overall,
      sqlValidation: withSql ? await runSqlValidation(corpus) : {state: 'not_run', reason: 'Use --sql with an explicit disposable TEST_DATABASE_URL'}}} : {}};
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.sqlValidation.state === 'mismatch') process.exitCode = 1;
}
