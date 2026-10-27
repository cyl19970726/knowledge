import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {KnowledgeRef,SourceContent} from '@commerce/knowledge-contracts';
import {CitationList,SourceContentView} from '../src/source-view.tsx';
const ref:KnowledgeRef={projectId:'synthetic',spaceId:'space',domain:'evidence',objectId:'00000000-0000-4000-8000-000000000001',versionId:'00000000-0000-4000-8000-000000000002',contentDigest:'a'.repeat(64)};

test('legacy analysis and evidence citations expose exact-source actions without claiming prior content reads',()=>{
  const html=renderToStaticMarkup(createElement(CitationList,{citations:[{ref:{...ref,domain:'analysis'},locator:'record:original-report',supports:'Synthetic report claim'},
    {ref,locator:'record:original-frame',supports:'Synthetic frame pointer'}],onOpen:()=>{}}));
  assert.equal((html.match(/查看准确来源/g)??[]).length,2);assert.match(html,/准确分析报告/);assert.match(html,/准确证据原件/);
  assert.match(html,/record:original-report/);assert.match(html,/record:original-frame/);assert.match(html,/不等于本次实际读取/);
  assert.doesNotMatch(html,/当前查看器未适配|暂不能.*打开|disabled/);
});

test('frame view shows the original image bytes and bounded coverage, with no video observation claim',()=>{
  const base64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC8sAAAAASUVORK5CYII=',bytes=Buffer.from(base64,'base64').length;
  const source:SourceContent={ref,contentDigest:ref.contentDigest!,content:'',media:{kind:'image',mimeType:'image/png',base64,byteCount:bytes,digest:ref.contentDigest!},anchor:null,
    actualCoverage:{sourceRef:ref,anchors:[],byteCount:bytes,coverage:'full',exclusions:['Only the stored frame; no continuous video'],readAt:'2026-10-27T00:00:00Z',readerAuthority:'synthetic-owner',readProofId:'synthetic-read'},
    readability:{metadataVisible:true,contentReadable:true,anchorResolved:true,assurance:'read_time_only',reasons:[]}};
  const html=renderToStaticMarkup(createElement(SourceContentView,{source}));
  assert.ok(html.includes(`data:image/png;base64,${base64}`));assert.match(html,new RegExp(`内容已读.*${bytes}.*字节`));
  assert.match(html,/不表示观看连续视频或听取音频/);assert.match(html,/no continuous video/);
});
