import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createReferencePackService } from '../src/reference-pack.ts';
import { KnowledgeError } from '../src/types.ts';
import type { KnowledgeChangeSet, KnowledgeReview, KnowledgeStore, RevisionView } from '../src/types.ts';
import type { KnowledgeService } from '../src/service.ts';
import { caseRevision, ref, SyntheticAnalysis, SyntheticSources, task, timestamp } from './service-fixtures.ts';

function environment(decision: KnowledgeReview['decision'] = 'exploration_only', purpose = 'exploration_reading') {
  const projectId = `exploration-${randomUUID()}`, product = ref();
  const synthetic = new SyntheticAnalysis().add(projectId);
  const caseItem = caseRevision(projectId, product, synthetic.result, synthetic.anchor, 'hook structure');
  const review = (value: KnowledgeReview['decision'], p = purpose): KnowledgeReview => ({ id: randomUUID(), projectId, changeSetId: randomUUID(), contentHash: 'a'.repeat(64), reviewer: 'independent', policyVersion: 'test', purpose: p, decision: value, rationale: 'test', createdAt: timestamp });
  const caseView: RevisionView = { revision: caseItem, current: true, published: true, review: review(decision), validity: { valid: true, issues: [] } };
  const caseViews:RevisionView[]=[caseView];
  const extraViews = new Map<string, RevisionView>();
  const wikiViews:RevisionView[]=[];
  const containerViews:RevisionView[]=[];
  const searchKinds:string[]=[];
  const sources=new SyntheticSources();
  const changes=new Map<string,KnowledgeChangeSet>();
  const packViews=new Map<string,RevisionView>();
  const recorded: KnowledgeReview[] = [];
  const store = {
    search: async (_project: string, opts: { query?: string;kinds?:string[] }) => {
      searchKinds.push(opts.kinds?.join(',')??'');
      return opts.kinds?.includes('wiki')?wikiViews:
        opts.kinds?.includes('case')?caseViews:opts.kinds?.includes('collection')?containerViews:[];
    },
    get: async (_project: string, exact: typeof product) => caseViews.find(row=>row.revision.ref.objectId===exact.objectId) ?? extraViews.get(exact.objectId) ?? packViews.get(exact.objectId) ?? null,
    getByRequestKey: async (_project:string,key:string) => changes.get(key)??null,
    stage: async (value: KnowledgeChangeSet) => { changes.set(value.requestKey,value); return value; },
    recordReview: async (value: KnowledgeReview) => { recorded.push(value); return value; },
    publish: async (_project:string,changeSetId:string) => { const change=[...changes.values()].find(value=>value.id===changeSetId);
      if (!change) throw Error('not staged');
      const packView:RevisionView={ revision: change.changes[0].revision, current: true, published: true, review: recorded.at(-1)!, validity: {valid:true,issues:[]} };
      packViews.set(packView.revision.ref.objectId,packView);
      return {changeSetId:change.id,projectId,refs:[packView.revision.ref],epoch:1,publishedAt:timestamp}; },
    epoch: async () => 0,
  } as unknown as KnowledgeStore;
  const revalidations:Array<{purpose:string|undefined;exploration:boolean}> = [];
  const knowledge = {
    revalidate: async (_project:string,_deps:unknown,purpose?:string,policy?:{allowExplorationKnowledge?:boolean}) => {revalidations.push({purpose,exploration:!!policy?.allowExplorationKnowledge});},
    readSource: async (_project:string,sourceRef:typeof product)=>sources.records.get(sourceRef.versionId)??null,
  } as unknown as KnowledgeService;
  const packs = createReferencePackService({ store, knowledge, now: () => new Date(timestamp) });
  return { projectId, product, caseItem, caseView, caseViews, containerViews, searchKinds, sources,
    packs, recorded, extraViews, wikiViews, packViews, revalidations };
}

function addWiki(e:ReturnType<typeof environment>,relatedRefs:Array<typeof e.caseItem.ref>,body='对开场关系的有限综合。') {
  const wikiRef=ref();
  const wiki={...e.caseItem,kind:'wiki' as const,ref:wikiRef,title:'开场研究专题',body,
    scope:{...e.caseItem.scope,limitations:['Wiki 限制：来源仅覆盖一个市场'],unknowns:['Wiki 未知：跨市场效果']},
    sourceGroups:[],content:{ref:wikiRef,projectId:e.projectId,title:'开场研究专题',question:'开场关系如何推进？',
      claimRefs:[],patternRefs:[],relatedRefs,disputes:['另一种开场顺序尚无依据'],
      nextQuestions:['能否在别的原片复现？'],citations:e.caseItem.kind==='case'?e.caseItem.content.citations:[]}};
  const view:RevisionView={revision:wiki,current:true,published:true,review:{...e.caseView.review!,id:randomUUID()},validity:{valid:true,issues:[]}};
  e.wikiViews.push(view);e.extraViews.set(wikiRef.objectId,view);
  return view;
}

function addCase(e:ReturnType<typeof environment>,title:string) {
  const analysis=new SyntheticAnalysis().add(e.projectId);
  const revision=caseRevision(e.projectId,e.product,analysis.result,analysis.anchor,title);
  const view:RevisionView={revision,current:true,published:true,review:{...e.caseView.review!,id:randomUUID()},validity:{valid:true,issues:[]}};
  e.caseViews.push(view);
  return view;
}

test('target platform excludes legacy TikTok and unknown cases, while exact transfer stays visible',async()=>{
  const e=environment();
  const douyin=addCase(e,'抖音单独开场');
  douyin.revision.scope.applicability.platforms=['douyin'];
  const unknown=addCase(e,'来源平台未识别');
  unknown.revision.scope.applicability.platforms=['unknown'];
  const target=task(e.product,{platform:'douyin',purpose:'exploration_reading',query:'开场'});
  const first=await e.packs.buildReferencePack({projectId:e.projectId,requestKey:'douyin-scope',task:target,
    sourceRefs:[],includeExploration:true,candidateRefs:[e.caseItem.ref,douyin.revision.ref,unknown.revision.ref],includeResearchWiki:true});
  assert.deepEqual(first.pack.selectedCases.map(item=>item.ref),[douyin.revision.ref]);
  assert.match(first.decisions.find(item=>item.ref.versionId===e.caseItem.ref.versionId)?.reason??'',/平台不匹配/);
  e.caseItem.scope.applicability.platformTransfers=[{to:'douyin',rationale:'开场信息次序可作原创迁移假设，仍须在抖音测试。'}];
  const second=await e.packs.buildReferencePack({projectId:e.projectId,requestKey:'douyin-transfer',task:target,
    sourceRefs:[],includeExploration:true,candidateRefs:[e.caseItem.ref],includeResearchWiki:true});
  assert.deepEqual(second.pack.selectedCases.map(item=>item.ref),[e.caseItem.ref]);
  assert.match(second.pack.selectedCases[0].reason,/明确迁移依据/);
  await assert.rejects(e.packs.buildReferencePack({projectId:e.projectId,requestKey:'unknown-target',
    task:{...target,platform:'unknown'},sourceRefs:[],includeExploration:true}),
    (error:unknown)=>error instanceof Error&&error.message.includes('verified target platform'));
});

test('platform rules require both exact platform and registered market scope',async()=>{
  const e=environment();
  const rule=e.sources.add(e.projectId,'platform_rule','TikTok US rule');
  rule.ruleScope={platforms:['tiktok'],markets:['US']};
  const douyin=task(e.product,{platform:'douyin',purpose:'exploration_reading'});
  await assert.rejects(e.packs.buildReferencePack({projectId:e.projectId,requestKey:'wrong-platform',
    task:douyin,sourceRefs:[rule.ref],includeExploration:true}),
    (error:unknown)=>error instanceof KnowledgeError&&error.code==='PLATFORM_RULE_SCOPE_MISMATCH');
  const tiktok=task(e.product,{platform:'tiktok',market:'CN',purpose:'exploration_reading'});
  await assert.rejects(e.packs.buildReferencePack({projectId:e.projectId,requestKey:'wrong-market',
    task:tiktok,sourceRefs:[rule.ref],includeExploration:true}),
    (error:unknown)=>error instanceof KnowledgeError&&error.code==='PLATFORM_RULE_SCOPE_MISMATCH');
  const legacy=task(e.product,{purpose:'exploration_reading'});
  const pack=await e.packs.buildReferencePack({projectId:e.projectId,requestKey:'legacy-tiktok-rule',
    task:legacy,sourceRefs:[rule.ref],includeExploration:true});
  assert.ok(pack.pack.restrictions.includes('TikTok US rule'));
});

test('navigation-only parent Wiki is omitted without taking a research-page slot',async()=>{
  const e=environment();
  const navigation=addWiki(e,[e.caseItem.ref],'仅列出子专题入口');
  if(navigation.revision.kind!=='wiki')throw Error('expected Wiki fixture');
  navigation.revision.content.navigationOnly=true;
  navigation.revision.content.citations=[];
  navigation.revision.content.disputes=[];
  navigation.revision.scope.limitations=['导航范围限制：仅覆盖当前入口'];
  navigation.revision.scope.unknowns=['导航范围未知：遗漏的子专题'];
  const pages=[addWiki(e,[e.caseItem.ref],'研究页甲的综合'),addWiki(e,[e.caseItem.ref],'研究页乙的综合'),
    addWiki(e,[e.caseItem.ref],'研究页丙的综合')];
  const expected=pages.map(row=>row.revision.ref);
  const research=task(e.product,{purpose:'exploration_reading'});
  for(const exact of [true,false]) {
    const pack=await e.packs.buildReferencePack({projectId:e.projectId,requestKey:`nav-${exact}`,task:research,
      sourceRefs:[],includeExploration:true,includeResearchWiki:true,
      ...(exact?{researchWikiRefs:[navigation.revision.ref,...expected],candidateRefs:[e.caseItem.ref]}:{})});
    assert.deepEqual(pack.pack.researchContext?.map(item=>item.ref),expected);
    assert.match(pack.pack.omissions.join(' '),/仅供导航的父专题页不含可引用研究综合/);
    assert.doesNotMatch(pack.pack.restrictions.join(' '),/导航范围限制：仅覆盖当前入口/);
    assert.doesNotMatch(pack.pack.unknowns.join(' '),/导航范围未知：遗漏的子专题/);
    assert.ok(!pack.pack.omissions.some(item=>item.includes('探索专题数量达到本包上限')));
  }
});

test('bounded exploration keeps a Wiki and one linked Case before lower-ranked support',async()=>{
  const e=environment();
  const research=task(e.product,{purpose:'exploration_reading',maxItems:2});
  const wiki=addWiki(e,[e.caseItem.ref]);
  const pair=await e.packs.buildReferencePack({projectId:e.projectId,requestKey:'minimum-pair',task:research,
    sourceRefs:[],includeExploration:true,includeResearchWiki:true,researchWikiRefs:[wiki.revision.ref]});
  const extra=addCase(e,`secondary ${'Z'.repeat(1800)}`);
  if(wiki.revision.kind==='wiki')wiki.revision.content.relatedRefs.push(extra.revision.ref);
  extra.revision.scope.applicability.markets=[];
  extra.revision.scope.limitations=[`Case 限制：样本只有一条 ${'L'.repeat(1200)}`];
  extra.revision.scope.unknowns=[`Case 未知：转化结果 ${'U'.repeat(1200)}`];
  const full=await e.packs.buildReferencePack({projectId:e.projectId,requestKey:'full-pair',task:research,
    sourceRefs:[],includeExploration:true,includeResearchWiki:true,researchWikiRefs:[wiki.revision.ref]});
  assert.equal(full.pack.selectedCases.length,2);
  assert.ok(full.pack.tokenUsed>pair.pack.tokenUsed+500);
  const budget=pair.pack.tokenUsed+500;
  const bounded=await e.packs.buildReferencePack({projectId:e.projectId,requestKey:'bounded-pair',
    task:{...research,tokenBudget:budget},sourceRefs:[],includeExploration:true,includeResearchWiki:true,
    researchWikiRefs:[wiki.revision.ref]});
  assert.deepEqual(bounded.pack.selectedCases.map(item=>item.ref),[e.caseItem.ref]);
  assert.deepEqual(bounded.pack.researchContext?.map(item=>item.ref),[wiki.revision.ref]);
  assert.ok(bounded.pack.tokenUsed<=budget);
  assert.doesNotMatch(bounded.pack.restrictions.join(' '),/Case 限制：样本只有一条/);
  assert.doesNotMatch(bounded.pack.unknowns.join(' '),/Case 未知：转化结果/);
  assert.doesNotMatch(bounded.pack.restrictions.join(' '),new RegExp(extra.revision.ref.versionId));
  assert.match(bounded.pack.restrictions.join(' '),/不得直接用于生产执行/);
  assert.match(bounded.pack.omissions.join(' '),/上下文预算不足/);
  assert.match(bounded.pack.selectedCases[0].reason,/问题「hook」/);
  assert.match(bounded.pack.selectedCases[0].reason,/目标「awareness」在已记录适用范围内/);
  assert.equal(bounded.pack.selectedCases[0].reason,
    bounded.decisions.find(item=>item.selected&&item.ref.versionId===bounded.pack.selectedCases[0].ref.versionId)?.reason);
  const saved=e.packViews.get(bounded.pack.ref.objectId);
  assert.match(saved?.revision.title??'',/开场研究专题/);
});

test('a Wiki cannot survive without its linked Case when the minimum pair exceeds the byte budget',async()=>{
  const e=environment();
  const research=task(e.product,{purpose:'exploration_reading',maxItems:2});
  const base=await e.packs.buildReferencePack({projectId:e.projectId,requestKey:'case-only',task:research,
    sourceRefs:[],includeExploration:true,includeResearchWiki:true});
  const linked=addCase(e,`secondary ${'L'.repeat(1700)}`);
  linked.revision.scope.limitations=['裁掉的案例仍限定人群'];
  linked.revision.scope.unknowns=['裁掉的案例未知转化'];
  const wiki=addWiki(e,[linked.revision.ref],`专题正文 ${'W'.repeat(1700)}`);
  const budget=base.pack.tokenUsed+650;
  const bounded=await e.packs.buildReferencePack({projectId:e.projectId,requestKey:'orphan-prevented',
    task:{...research,tokenBudget:budget},sourceRefs:[],includeExploration:true,includeResearchWiki:true,
    researchWikiRefs:[wiki.revision.ref]});
  assert.deepEqual(bounded.pack.selectedCases.map(item=>item.ref),[e.caseItem.ref]);
  assert.deepEqual(bounded.pack.researchContext,[]);
  assert.ok(bounded.pack.tokenUsed<=budget);
  assert.match(bounded.pack.omissions.join(' '),/最小关联案例与探索专题仍超出预算/);
  assert.doesNotMatch(bounded.pack.restrictions.join(' '),/Wiki 限制：来源仅覆盖一个市场/);
  assert.doesNotMatch(bounded.pack.restrictions.join(' '),/裁掉的案例仍限定人群/);
  assert.doesNotMatch(bounded.pack.unknowns.join(' '),/Wiki 未知：跨市场效果/);
  assert.doesNotMatch(bounded.pack.unknowns.join(' '),/裁掉的案例未知转化/);
});

test('budget pressure cannot discard a related counterexample or product fact',async()=>{
  const e=environment();
  const counter=addCase(e,'challenging alternative');
  const collectionRef=ref();
  const collection:RevisionView={revision:{...e.caseItem,kind:'collection',ref:collectionRef,title:'hook alternatives',body:'两条素材的挑战关系',
    content:{ref:collectionRef,projectId:e.projectId,title:'hook alternatives',question:'开场证据是否一致？',
      members:[{ref:e.caseItem.ref,role:'support',reason:'基线'},{ref:counter.revision.ref,role:'counterexample',reason:'挑战'}],
      exclusions:[],samplingFrame:'two exact source clips',window:null}},current:true,published:true,
    review:{...e.caseView.review!,id:randomUUID()},validity:{valid:true,issues:[]}};
  e.containerViews.push(collection);e.extraViews.set(collectionRef.objectId,collection);
  const fact=e.sources.add(e.projectId,'product_fact','经登记的产品成分事实',e.product);
  const research=task(e.product,{purpose:'exploration_reading',maxItems:2});
  const base=await e.packs.buildReferencePack({projectId:e.projectId,requestKey:'protected-base',task:research,
    sourceRefs:[fact.ref],includeExploration:true,includeResearchWiki:true,candidateRefs:[e.caseItem.ref]});
  assert.equal(base.pack.counterexamples.length,1);
  const wiki=addWiki(e,[e.caseItem.ref],`专题正文 ${'W'.repeat(1800)}`);
  const budget=base.pack.tokenUsed+300;
  const bounded=await e.packs.buildReferencePack({projectId:e.projectId,requestKey:'protected-bounded',
    task:{...research,tokenBudget:budget},sourceRefs:[fact.ref],includeExploration:true,includeResearchWiki:true,
    researchWikiRefs:[wiki.revision.ref],candidateRefs:[e.caseItem.ref]});
  assert.deepEqual(bounded.pack.counterexamples.map(item=>item.ref),[counter.revision.ref]);
  assert.deepEqual(bounded.pack.productFacts.map(item=>item.statement),[fact.statement]);
  assert.deepEqual(bounded.pack.researchContext,[]);
  assert.doesNotMatch(bounded.pack.restrictions.join(' '),/Wiki 限制：来源仅覆盖一个市场/);
  assert.doesNotMatch(bounded.pack.unknowns.join(' '),/Wiki 未知：跨市场效果/);
  assert.ok(bounded.pack.tokenUsed<=budget);
  assert.ok(!e.searchKinds.includes('case,pattern'),'Exact candidates must bypass the global case/pattern search');
});

test('exact candidates are deduplicated, scoped and fail closed for missing or wrong-kind versions',async()=>{
  const e=environment();
  const wiki=addWiki(e,[e.caseItem.ref]);
  const research=task(e.product,{purpose:'exploration_reading'});
  await assert.rejects(e.packs.buildReferencePack({projectId:e.projectId,requestKey:'not-exploration',task:research,
    sourceRefs:[],candidateRefs:[e.caseItem.ref]}),/explicit bounded exploration/i);
  await assert.rejects(e.packs.buildReferencePack({projectId:e.projectId,requestKey:'missing-candidate',task:research,
    sourceRefs:[],includeExploration:true,includeResearchWiki:true,candidateRefs:[ref()]}),/candidate version is unavailable/i);
  await assert.rejects(e.packs.buildReferencePack({projectId:e.projectId,requestKey:'wrong-kind',task:research,
    sourceRefs:[],includeExploration:true,includeResearchWiki:true,candidateRefs:[wiki.revision.ref]}),/cases or patterns/i);
  await assert.rejects(e.packs.buildReferencePack({projectId:e.projectId,requestKey:'too-many-candidates',task:research,
    sourceRefs:[],includeExploration:true,includeResearchWiki:true,
    candidateRefs:Array.from({length:201},()=>ref())}),/200-version bound/i);
  const input={projectId:e.projectId,requestKey:'exact-dedup',task:research,sourceRefs:[],includeExploration:true,
    includeResearchWiki:true,researchWikiRefs:[wiki.revision.ref],candidateRefs:[e.caseItem.ref,e.caseItem.ref]};
  const pack=await e.packs.buildReferencePack(input);
  assert.deepEqual(pack.pack.selectedCases.map(item=>item.ref),[e.caseItem.ref]);
  assert.deepEqual(pack.pack.researchContext?.map(item=>item.ref),[wiki.revision.ref]);
  assert.match(pack.pack.omissions.join(' '),/仅限指定的 1 个准确案例或模式版本；未检索全历史知识库/);
  assert.ok(!e.searchKinds.includes('case,pattern'));
  assert.deepEqual(await e.packs.buildReferencePack({...input,candidateRefs:[e.caseItem.ref]}),pack,
    'Deduplicated exact inputs must retain the same request hash');
});

test('research Wiki enters only exploration context with exact dependency and limitations',async()=>{
  const e=environment();
  const wikiRef=ref();
  const wiki={...e.caseItem,kind:'wiki' as const,ref:wikiRef,title:'开场研究专题',body:'对开场关系的有限综合。',
    scope:{...e.caseItem.scope,limitations:['音轨未核查'],unknowns:['观众反应未知']},
    sourceGroups:[],content:{ref:wikiRef,projectId:e.projectId,title:'开场研究专题',question:'开场关系如何推进？',
      claimRefs:[],patternRefs:[],relatedRefs:[e.caseItem.ref],disputes:['另一种开场顺序尚无依据'],
      nextQuestions:['能否在别的原片复现？'],citations:e.caseItem.kind==='case'?e.caseItem.content.citations:[]}};
  const wikiView:RevisionView={revision:wiki,current:true,published:true,review:{...e.caseView.review!,id:randomUUID()},validity:{valid:true,issues:[]}};
  e.wikiViews.push(wikiView);e.extraViews.set(wikiRef.objectId,wikiView);
  const unrelatedRef=ref();
  const unrelated:RevisionView={...wikiView,revision:{...wiki,ref:unrelatedRef,
    content:{...wiki.content,ref:unrelatedRef,relatedRefs:[ref()]}}};
  e.wikiViews.push(unrelated);e.extraViews.set(unrelatedRef.objectId,unrelated);
  const research=task(e.product,{purpose:'exploration_reading'});
  await assert.rejects(e.packs.buildReferencePack({projectId:e.projectId,requestKey:'wiki-no-opt-in',task:research,
    sourceRefs:[],includeResearchWiki:true}),/explicit exploration/i);
  const pack=await e.packs.buildReferencePack({projectId:e.projectId,requestKey:'wiki-explore',task:research,
    sourceRefs:[],includeExploration:true,includeResearchWiki:true});
  assert.equal(pack.pack.selectedCases.length,1);
  assert.deepEqual(pack.pack.researchContext?.map(item=>item.ref),[wikiRef]);
  assert.match(pack.contextText,/对开场关系的有限综合/);
  assert.match(pack.contextText,/另一种开场顺序尚无依据/);
  assert.match(pack.contextText,/能否在别的原片复现/);
  assert.match(pack.pack.restrictions.join(' '),/音轨未核查/);
  assert.ok(e.recorded.at(-1)?.decision==='exploration_only');
  assert.ok(e.revalidations.some(call=>call.exploration));
  assert.deepEqual(await e.packs.validateForExecution(e.projectId,pack.pack.ref,research),pack);
  wikiView.validity.valid=false;
  await assert.rejects(e.packs.validateForExecution(e.projectId,pack.pack.ref,research),/invalid|dependency/i);
  wikiView.validity.valid=true;
  wikiView.review={...wikiView.review!,decision:'rejected'};
  const excluded=await e.packs.buildReferencePack({projectId:e.projectId,requestKey:'wiki-rejected',task:research,
    sourceRefs:[],includeExploration:true,includeResearchWiki:true});
  assert.deepEqual(excluded.pack.researchContext,[],'A rejected Wiki cannot enter the research context');
  wikiView.review={...wikiView.review!,decision:'exploration_only'};
  const bounded=await e.packs.buildReferencePack({projectId:e.projectId,requestKey:'wiki-budget',
    task:{...research,tokenBudget:excluded.pack.tokenUsed+300},sourceRefs:[],includeExploration:true,includeResearchWiki:true});
  assert.deepEqual(bounded.pack.researchContext,[],'Optional Wiki context yields before the source-bound case');
  assert.equal(bounded.pack.selectedCases.length,1);
  assert.match(bounded.pack.omissions.join(' '),/探索专题总结未纳入/);
});

test('a source-cited Wiki decision guide is frozen in context and counted against the byte budget',async()=>{
  const e=environment();
  const wiki=addWiki(e,[e.caseItem.ref]);
  const research=task(e.product,{purpose:'exploration_reading'});
  const input={projectId:e.projectId,task:research,sourceRefs:[],includeExploration:true,
    includeResearchWiki:true,researchWikiRefs:[wiki.revision.ref],candidateRefs:[e.caseItem.ref]};
  const without=await e.packs.buildReferencePack({...input,requestKey:'guide-absent',researchWikiRefs:[]});
  const legacy=await e.packs.buildReferencePack({...input,requestKey:'guide-legacy'});
  assert.match(legacy.contextText,/"decisionGuide":null/);
  if(wiki.revision.kind!=='wiki')throw Error('expected Wiki fixture');
  wiki.revision.content.decisionGuide={
    judgment:`开场问题先出现，效果仍待验证 ${'J'.repeat(1800)}〔引证 1〕`,
    applicableWhen:['仅在类似开场问题下考虑〔引证 1〕'],
    avoidWhen:['不能推断真实成交〔引证 1〕'],
    adaptationIdeas:['原创地测试另一种提问顺序〔引证 1〕'],
    validationPlan:['比较完播并记录无改善的结果〔引证 1〕'],
  };
  const full=await e.packs.buildReferencePack({...input,requestKey:'guide-full'});
  assert.match(full.contextText,/"decisionGuide":\{"adaptationIdeas"/);
  assert.match(full.contextText,/原创地测试另一种提问顺序〔引证 1〕/);
  assert.match(full.contextText,/不能推断真实成交〔引证 1〕/);
  assert.match(full.pack.researchContext?.[0].reason??'',/开场问题先出现，效果仍待验证/);
  assert.ok(full.pack.tokenUsed>without.pack.tokenUsed+300);
  const bounded=await e.packs.buildReferencePack({...input,requestKey:'guide-bounded',
    task:{...research,tokenBudget:without.pack.tokenUsed+300}});
  assert.deepEqual(bounded.pack.researchContext,[]);
  assert.doesNotMatch(bounded.contextText,/原创地测试另一种提问顺序/);
  assert.match(bounded.pack.omissions.join(' '),/探索专题总结未纳入/);
  assert.ok(bounded.pack.tokenUsed<=bounded.pack.tokenBudget);
});

test('exploration requires explicit purpose and opt-in; frozen pack stays exploration only', async () => {
  const e=environment();
  const research=task(e.product,{purpose:'exploration_reading'});
  await assert.rejects(e.packs.buildReferencePack({projectId:e.projectId,requestKey:'formal',task:research,sourceRefs:[]}),/adopted applicable|usable references/i);
  await assert.rejects(e.packs.buildReferencePack({projectId:e.projectId,requestKey:'wrong-purpose',task:task(e.product),sourceRefs:[],includeExploration:true}),/exploration_reading/i);
  const pack=await e.packs.buildReferencePack({projectId:e.projectId,requestKey:'explore',task:research,sourceRefs:[],includeExploration:true});
  assert.deepEqual(pack.explorationRefs,[e.caseItem.ref]);
  assert.ok(e.revalidations.every(call=>call.purpose==='exploration_reading' && call.exploration));
  assert.equal(pack.pack.selectedCases.length,1);
  assert.match(pack.pack.restrictions.join(' '),/不得直接用于生产执行/);
  assert.equal(e.recorded.at(-1)?.decision,'exploration_only');
  assert.deepEqual(await e.packs.validateForExecution(e.projectId,pack.pack.ref,research),pack);
  await assert.rejects(e.packs.validateForExecution(e.projectId,pack.pack.ref,task(e.product)),/different task|restricted|production/i);
  e.caseView.validity.valid=false;
  await assert.rejects(e.packs.validateForExecution(e.projectId,pack.pack.ref,research),/dependency|invalid/i);
});

test('unknown applicability can enter only an explicit exploration reading with a visible restriction',async()=>{
  const e=environment('approved_for_purpose');
  e.caseItem.scope.applicability.markets=[];
  const research=task(e.product,{purpose:'exploration_reading'});
  await assert.rejects(e.packs.buildReferencePack({projectId:e.projectId,requestKey:'ordinary',task:research,sourceRefs:[]}),/applicable case/i);
  const pack=await e.packs.buildReferencePack({projectId:e.projectId,requestKey:'unknown-explore',task:research,sourceRefs:[],includeExploration:true});
  assert.deepEqual(pack.explorationRefs,[e.caseItem.ref]);
  assert.match(pack.pack.restrictions.join(' '),/适用范围未知|市场.*未知/);
  assert.equal(e.recorded.at(-1)?.decision,'exploration_only');
  assert.match(pack.pack.selectedCases[0].reason,/市场「US」适用性未核实/);
  assert.match(pack.contextText,/未知适用范围仅供探索阅读/);
});

test('rejected and other-purpose versions cannot enter exploration packs', async () => {
  for(const [decision,purpose] of [['rejected','exploration_reading'],['exploration_only','creative_reference']] as const) {
    const e=environment(decision,purpose);
    await assert.rejects(e.packs.buildReferencePack({projectId:e.projectId,requestKey:'explore',task:task(e.product,{purpose:'exploration_reading'}),sourceRefs:[],includeExploration:true}),/adopted applicable|usable references/i);
    assert.deepEqual(e.recorded,[]);
  }
});

test('an eligible case cannot hide a rejected transitive knowledge dependency', async () => {
  const e=environment();
  const evidence=new SyntheticAnalysis().add(e.projectId);
  const upstream=caseRevision(e.projectId,e.product,evidence.result,evidence.anchor,'earlier observation');
  const other:RevisionView={revision:upstream,current:true,published:true,review:{...e.caseView.review!,decision:'rejected'},validity:{valid:true,issues:[]}};
  e.extraViews.set(upstream.ref.objectId,other);
  e.caseItem.dependencies.push({domain:'knowledge',ref:upstream.ref,role:'derived_from',critical:true});
  await assert.rejects(e.packs.buildReferencePack({projectId:e.projectId,requestKey:'transitive',task:task(e.product,{purpose:'exploration_reading'}),sourceRefs:[],includeExploration:true}),/adopted applicable|usable references/i);
  assert.deepEqual(e.recorded,[]);
});
