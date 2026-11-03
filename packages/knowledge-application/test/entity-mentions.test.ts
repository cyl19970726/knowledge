import assert from 'node:assert/strict';
import test from 'node:test';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {validateEntityMentionSpans} from '../src/entity-mentions.ts';

const extraction=(mentions:unknown[])=>({methodVersion:'synthetic-span-test/1',mentions});
const mention=(entityType:string,surface:string,startByte:number,endByte:number)=>({entityType,surface,startByte,endByte});
const rejects=(content:string,raw:unknown,code:string)=>assert.throws(()=>validateEntityMentionSpans(content,raw),
  error=>error instanceof KnowledgeError&&error.code===code&&error.status===422);

test('CJK, emoji, whitespace and nested byte spans retain exact original surfaces',()=>{
  const content='甲 🦊乙 甲';
  assert.equal(Buffer.byteLength(content,'utf8'),15);
  const input=extraction([
    mention('concept','甲',0,3),mention('entity',' 🦊',3,8),mention('entity','🦊',4,8),
    mention('place','🦊乙',4,11),mention('entity','乙',8,11),mention('concept','甲',12,15),
  ]);
  assert.deepEqual(validateEntityMentionSpans(content,input),input);
  assert.equal(validateEntityMentionSpans('\uFEFF甲',extraction([mention('marker','\uFEFF',0,3)])).mentions[0]?.surface,'\uFEFF');
});

test('hallucinated or normalized surface cannot substitute for exact bytes',()=>{
  rejects('北京',extraction([mention('place','上海',0,6)]),'ENTITY_MENTION_SURFACE_MISMATCH');
  rejects('ＡＢＣ',extraction([mention('name','ABC',0,9)]),'ENTITY_MENTION_SURFACE_MISMATCH');
  rejects(' 甲 ',extraction([mention('name','甲',0,4)]),'ENTITY_MENTION_SURFACE_MISMATCH');
  const exact=validateEntityMentionSpans(' 甲 ',extraction([mention('name',' 甲',0,4)]));
  assert.equal(exact.mentions[0]?.surface,' 甲');
});

test('zero, reverse, out-of-source and partial UTF-8 ranges fail closed',()=>{
  for(const [start,end] of [[0,0],[3,2],[0,7]])
    rejects('甲乙',extraction([mention('entity','甲',start,end)]),'ENTITY_MENTION_SPAN_INVALID');
  for(const [start,end] of [[1,3],[0,2],[3,4],[3,6]])
    rejects('甲🦊',extraction([mention('entity','甲',start,end)]),'ENTITY_MENTION_SPAN_INVALID');
  for(const [start,end] of [[-1,3],[0,1.5],[0,1_000_001]])
    rejects('甲',extraction([mention('entity','甲',start,end)]),'ENTITY_MENTION_EXTRACTION_INVALID');
  rejects('\uD800',extraction([]),'ENTITY_MENTION_CONTENT_INVALID');
});

test('same type and byte range is duplicate; distinct types and distinct occurrences are allowed',()=>{
  const content='甲甲';
  rejects(content,extraction([mention('person','甲',0,3),mention('person','甲',0,3)]),'ENTITY_MENTION_DUPLICATE');
  const distinct=extraction([mention('person','甲',0,3),mention('place','甲',0,3),mention('person','甲',3,6)]);
  assert.deepEqual(validateEntityMentionSpans(content,distinct),distinct);
});

test('empty extraction is valid and the public maximum is exactly 100 mentions',()=>{
  assert.deepEqual(validateEntityMentionSpans('',extraction([])),extraction([]));
  const content='x'.repeat(101);
  const mentions=Array.from({length:101},(_,index)=>mention('entity','x',index,index+1));
  assert.equal(validateEntityMentionSpans(content,extraction(mentions.slice(0,100))).mentions.length,100);
  rejects(content,extraction(mentions),'ENTITY_MENTION_EXTRACTION_INVALID');
  rejects('x',{methodVersion:'test',mentions:[{entityType:'entity',surface:'x',startByte:0,endByte:1,canonicalId:'invented'}]},
    'ENTITY_MENTION_EXTRACTION_INVALID');
});
