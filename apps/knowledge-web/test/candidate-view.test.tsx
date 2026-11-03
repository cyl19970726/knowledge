import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement,isValidElement,type ReactElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {CandidateView,KnowledgeRef} from '../../../packages/knowledge-contracts/src/index.ts';
import {CandidatePreview} from '../src/App.tsx';

const scope={projectId:'synthetic-project',spaceId:'synthetic-space'};
const beforeRef:KnowledgeRef={...scope,domain:'knowledge',objectId:'00000000-0000-4000-8000-000000000001',
  versionId:'00000000-0000-4000-8000-000000000002',contentDigest:'a'.repeat(64)};
const afterRef:KnowledgeRef={...beforeRef,versionId:'00000000-0000-4000-8000-000000000003',contentDigest:'b'.repeat(64)};

function candidate():CandidateView{
  return {candidateId:'00000000-0000-4000-8000-000000000004',contentHash:'c'.repeat(64),purpose:'exploration_reading',
    proposer:'synthetic-reviewer',rationale:'依据准确旧页修订',createdAt:'2026-11-02T00:00:00.000Z',
    state:'waiting_for_review',reviewable:false,reviewIssues:['来源权限已撤回 <script>bad()</script>'],exactReadset:[beforeRef],
    changes:[{ref:afterRef,title:'修改后标题',body:'修改后正文\n保留换行 <img src=x onerror=bad()>',
      profile:{id:'synthetic-profile',version:'1',digest:'d'.repeat(64)},effect:'revise',
      before:{ref:beforeRef,title:'修改前标题',body:'历史正文',conditions:['旧条件'],counterexamples:['旧反例'],unknowns:['旧未知']},
      conditions:['新条件'],counterexamples:['新反例'],unknowns:['新未知'],nextQuestions:['下一步核对'],
      sourceGroups:[{id:'共享来源组-中文-very-long-identifier',status:'known',authority:'synthetic-fixture'}]}]};
}

function buttons(node:ReactNode):ReactElement[] {
  if(Array.isArray(node))return node.flatMap(buttons);
  if(!isValidElement(node))return [];
  const props=node.props as {children?:ReactNode};
  return [...node.type==='button'?[node]:[],...buttons(props.children)];
}

test('candidate shows exact before and after, review block, source groups and escaped text',()=>{
  const data=candidate(),html=renderToStaticMarkup(createElement(CandidatePreview,{candidate:data,onRead:()=>{}}));
  for(const text of ['修改前标题','修改后标题','历史正文','旧条件','旧反例','旧未知','新条件','新反例','新未知',
    '下一步核对','共享来源组-中文-very-long-identifier','打开修改前准确版本','当前候选不可批准',
    beforeRef.versionId,afterRef.versionId])assert.ok(html.includes(text),text);
  assert.match(html,/历史版本仅用于比较/);
  assert.match(html,/来源权限已撤回 &lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(html,/&lt;img src=x onerror=bad\(\)&gt;/);
  assert.doesNotMatch(html,/<script>|<img src=x/);
  assert.doesNotMatch(html,/批准候选|确认批准/);
});

test('the before-version action opens its exact historical ref',()=>{
  const opened:KnowledgeRef[]=[];
  const view=CandidatePreview({candidate:candidate(),onRead:ref=>opened.push(ref)});
  const historical=buttons(view).find(button=>button.props &&
    String((button.props as {children?:ReactNode}).children).includes('打开修改前准确版本'));
  assert.ok(historical);
  (historical.props as {onClick:()=>void}).onClick();
  assert.deepEqual(opened,[beforeRef]);
});

test('explicit null means new page while an absent before field remains unknown for legacy candidates',()=>{
  const created=candidate();created.reviewable=undefined;created.reviewIssues=undefined;
  created.changes[0].before=null;
  const newHtml=renderToStaticMarkup(createElement(CandidatePreview,{candidate:created,onRead:()=>{}}));
  assert.match(newHtml,/新建页：没有修改前版本/);
  assert.match(newHtml,/新建候选/);
  assert.match(newHtml,/服务未返回可批准判定/);
  const legacy=candidate();delete legacy.changes[0].before;
  const legacyHtml=renderToStaticMarkup(createElement(CandidatePreview,{candidate:legacy,onRead:()=>{}}));
  assert.match(legacyHtml,/旧候选未提供修改前版本/);
  assert.doesNotMatch(legacyHtml,/新建页：没有修改前版本/);
});

test('a historical reference without an exact content digest is shown without an open action',()=>{
  const data=candidate();
  data.changes[0].before={...data.changes[0].before!,ref:{...beforeRef,contentDigest:null}};
  const html=renderToStaticMarkup(createElement(CandidatePreview,{candidate:data,onRead:()=>{}}));
  assert.match(html,/历史引用缺少当前空间内的准确内容摘要/);
  assert.doesNotMatch(html,/打开修改前准确版本/);
});

test('published candidate presents reviewability as history without a new rejection alert',()=>{
  const data=candidate();data.state='published';
  const html=renderToStaticMarkup(createElement(CandidatePreview,{candidate:data,onRead:()=>{}}));
  assert.match(html,/候选已发表，可只读核对，不能再次审批/);
  assert.match(html,/修改前 · 准确版本/);
  assert.match(html,/修改后 · 候选版本/);
  assert.doesNotMatch(html,/当前候选不可批准|来源权限已撤回|role="alert"/);
});

test('repair candidate marks the old version comparison-only and lists every dependency disposition',()=>{
  const data=candidate();
  data.changes[0].repair={comparisonOnly:true,invalidityReasons:['source_superseded'],reviewDueAt:'2026-10-01T00:00:00.000Z',
    dependencies:[{domain:'source',ref:{objectId:beforeRef.objectId,versionId:beforeRef.versionId},action:'replace',replacementEvidenceId:'source:new',reason:'由当前版本替换'},
      {domain:'knowledge',ref:{objectId:afterRef.objectId,versionId:afterRef.versionId},action:'remove',replacementEvidenceId:null,reason:'上游已撤回 <b>x</b>'}],
    reviewDue:{action:'set',until:'2026-12-01T00:00:00.000Z',reason:'重新设定复核期'}};
  const html=renderToStaticMarkup(createElement(CandidatePreview,{candidate:data,onRead:()=>{}}));
  for(const text of ['修改前版本只供对照，不可采用','来源已有新版','替换来源','由当前版本替换','移除 Wiki','改为 2026-12-01T00:00:00.000Z'])assert.ok(html.includes(text),text);
  assert.match(html,/上游已撤回 &lt;b&gt;x&lt;\/b&gt;/);
});
