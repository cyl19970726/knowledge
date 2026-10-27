import test from 'node:test';
import assert from 'node:assert/strict';
import {planWikiLexicalQuery,WIKI_LEXICAL_METHOD_VERSION} from '../src/wiki-lexical-query.ts';

test('Wiki lexical plan preserves informative Chinese and normalized Latin terms without task aliases',()=>{
  const plan=planWikiLexicalQuery('大白鹅回家剧情里，怎样分别判断故事是否看懂、商品是否认出，制作前需要什么反馈？');
  assert.equal(plan.methodVersion,WIKI_LEXICAL_METHOD_VERSION);
  assert.ok(plan.terms.includes('故事'));
  assert.ok(plan.terms.includes('商品'));
  assert.ok(plan.terms.includes('反馈'));
  assert.ok(!plan.terms.includes('怎样'));
  assert.deepEqual(planWikiLexicalQuery('ＭＯＤＥＬ型号 ABC123').terms,['model','型号','abc123']);
  assert.deepEqual(planWikiLexicalQuery('model 型号 abc123').terms,['model','型号','abc123']);
});

test('uninformative input has zero terms, and long inputs disclose the bound',()=>{
  for(const query of ['！？','我们应该如何？','the and for'])
    assert.deepEqual(planWikiLexicalQuery(query).terms,[]);
  const long=planWikiLexicalQuery(Array.from({length:100},(_,index)=>`term${index}`).join(' '));
  assert.equal(long.terms.length,64);
  assert.equal(long.termsTruncated,true);
  assert.deepEqual(long,planWikiLexicalQuery(Array.from({length:100},(_,index)=>`term${index}`).join(' ')));
  const overlong=planWikiLexicalQuery(`${'x'.repeat(80)} usable`);
  assert.deepEqual(overlong.terms,['usable']);
  assert.equal(overlong.termsTruncated,true,'an oversized token is disclosed, not sent to the store or silently shortened');
});
