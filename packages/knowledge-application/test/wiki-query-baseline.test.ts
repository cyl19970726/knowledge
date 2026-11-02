import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lexicalScore, lexicalV2Score, loadCorpus, rankPages, rankV2Pages, runBaseline, runSqlValidation } from '../../../scripts/runtime/wiki-query-baseline.ts';
import { planWikiLexicalQuery } from '../../knowledge/src/wiki-lexical-query.ts';

test('fixed synthetic corpus covers three query tasks and known blind spots', () => {
  const corpus = loadCorpus();
  const result = runBaseline(corpus);
  assert.equal(corpus.pages.length, 119);
  assert.equal(corpus.questions.length, 30);
  assert.deepEqual(Object.values(result.byCategory).map(category => category.questions), [10, 10, 10]);
  assert.ok(result.questions.some(question => question.requiredPageIds.length === 0 && question.answerability === 'unanswerable'));
  assert.ok(result.questions.some(question => question.outsideDirectory100.length > 0));
  assert.equal(corpus.pages[2]?.title, corpus.pages[3]?.title, 'Different objects share the same visible name');
  assert.equal(corpus.pages.find(page => page.title === '同源报告甲')?.sourceGroup,
    corpus.pages.find(page => page.title === '同源报告乙')?.sourceGroup);
  assert.ok(corpus.pages.find(page => page.title === '跨语种别名表')?.aliases.includes('Blue Harbor'));
  assert.ok(result.questions.some(question => question.missingAt10.length > 0));
});

test('reference reproduces SQL title/body weights, normalization, and tie order', () => {
  const corpus = loadCorpus();
  const apple = corpus.pages[3]!;
  const plan = planWikiLexicalQuery('Ａｐｐｌｅ 科技品牌');
  assert.ok(plan.terms.includes('apple'));
  assert.equal(lexicalScore(apple, ['apple']), 4);
  assert.equal(rankPages(corpus.pages, '远窗术语表')[0]?.title, '远窗术语表');
  assert.deepEqual(runBaseline(corpus), runBaseline(corpus));
});

test('frozen v1 remains 46/48 while structured aliases recover the two locate pages in v2', () => {
  const corpus = loadCorpus(),v1=runBaseline(corpus),v2=runBaseline(corpus,'wiki-lexical-v2');
  assert.equal(v1.overall.foundAt10,46);
  assert.equal(v1.overall.requiredPages,48);
  assert.equal(v2.overall.requiredPages,48);
  assert.equal(v2.overall.foundAt10,48);
  assert.deepEqual(v1.questions.filter(question=>question.missingAt10.length).map(question=>question.id),['L08','L09']);
  assert.deepEqual(v2.questions.filter(question=>question.missingAt10.length).map(question=>question.id),[]);
  const aliasOnly=corpus.pages.find(page=>page.title==='跨语种别名表')!;
  assert.equal(lexicalScore(aliasOnly,['blue']),0);
  assert.equal(lexicalV2Score(aliasOnly,['blue']),12);
  assert.equal(rankV2Pages(corpus.pages,'Blue Harbor')[0]?.id,aliasOnly.id);
});

test('real store.search matches the reference in an isolated schema when a test database is provided',
  {skip: !process.env.TEST_DATABASE_URL}, async () => {
    const result = await runSqlValidation(loadCorpus());
    assert.equal(result.state, 'passed', JSON.stringify(result.mismatches));
    assert.equal(result.questionsCompared, 30);
  });

test('real v2 store.search matches all 30 frozen synthetic questions in an isolated schema',
  {skip: !process.env.TEST_DATABASE_URL}, async () => {
    const result = await runSqlValidation(loadCorpus(),'wiki-lexical-v2');
    assert.equal(result.state,'passed',JSON.stringify(result.mismatches));
    assert.equal(result.questionsCompared,30);
  });
