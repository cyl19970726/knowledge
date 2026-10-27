import { randomUUID } from 'node:crypto';
import { ReferencePackVersionSchema, VersionRefSchema, ProjectIdSchema, type VersionRef } from '../../contracts/src/index.ts';
import { KnowledgeError, type ArtifactWritePort, type CreativeKnowledgeTask, type Dependency, type KnowledgeChangeSet, type KnowledgeRevision, type KnowledgeScope, type KnowledgeStore, type PackContent, type RevisionView, type SelectionDecision, type TokenCounter } from './types.ts';
import { CreativeKnowledgeTaskSchema } from './schemas.ts';
import type { KnowledgeService } from './service.ts';
import { canonical, citationsOf, digest, refKey, sameRef, uniqueDeps } from './utils.ts';
import { platformFit } from './platform-applicability.ts';

/** Deliberately conservative estimate, not a provider usage/billing observation. */
export const utf8BudgetCounter: TokenCounter = { version:'utf8-byte-upper-bound-v1', count:text=>Buffer.byteLength(text,'utf8') };
export interface BuildReferencePackInput { projectId:string;requestKey:string;task:CreativeKnowledgeTask;sourceRefs:VersionRef[];
  includeExploration?:boolean;includeResearchWiki?:boolean;researchWikiRefs?:VersionRef[];candidateRefs?:VersionRef[] }
export function createReferencePackService(options:{store:KnowledgeStore;knowledge:KnowledgeService;counter?:TokenCounter;artifacts?:ArtifactWritePort;now?:()=>Date}) {
  const counter=options.counter??utf8BudgetCounter;
  async function revalidateForPack(projectId:string,deps:Dependency[],purpose:string,includeExploration:boolean):Promise<VersionRef[]> {
    if(!includeExploration) {await options.knowledge.revalidate(projectId,deps,purpose);return [];}
    await options.knowledge.revalidate(projectId,deps,purpose,{allowExplorationKnowledge:true});
    const visited=new Set<string>();
    const explorationRefs:VersionRef[]=[];
    async function visit(ref:VersionRef) {
      const key=refKey(ref);if(visited.has(key))return;visited.add(key);
      const view=await options.store.get(projectId,ref);
      if(!view?.published || !view.current || !view.validity.valid || view.revision.projectId!==projectId) throw new KnowledgeError('DEPENDENCY_INVALID','Exploration dependency is not current, published and valid');
      if(view.review?.purpose!==purpose || !['approved_for_purpose','exploration_only'].includes(view.review.decision))
        throw new KnowledgeError('DEPENDENCY_NOT_ELIGIBLE','Exploration dependency is rejected or reviewed for another purpose');
      if(view.review.decision==='exploration_only')explorationRefs.push(ref);
      for(const dep of view.revision.dependencies) if(dep.domain==='knowledge' && dep.critical) await visit(dep.ref);
    }
    for(const dep of deps) if(dep.domain==='knowledge' && dep.critical)await visit(dep.ref);
    return explorationRefs;
  }
  async function buildReferencePack(input:BuildReferencePackInput,signal?:AbortSignal):Promise<PackContent> {
    const task=CreativeKnowledgeTaskSchema.parse(input.task);
    if(task.platform==='unknown')throw new KnowledgeError('PLATFORM_UNVERIFIED','A reference pack needs a verified target platform',422);
    const includeExploration=input.includeExploration===true;
    const includeResearchWiki=input.includeResearchWiki===true;
    if(includeExploration && task.purpose!=='exploration_reading')throw new KnowledgeError('EXPLORATION_PURPOSE_REQUIRED','Exploration references require exploration_reading purpose',422);
    if(includeResearchWiki&&(!includeExploration||task.purpose!=='exploration_reading'))
      throw new KnowledgeError('RESEARCH_WIKI_PURPOSE_REQUIRED','Research Wiki context requires explicit exploration reading',422);
    if(includeResearchWiki&&!task.query.trim())throw new KnowledgeError('RESEARCH_QUERY_REQUIRED','Research Wiki context requires an explicit question query',422);
    if(input.researchWikiRefs && (!includeResearchWiki||input.researchWikiRefs.length>20))
      throw new KnowledgeError('RESEARCH_WIKI_REFS_INVALID','Exact research Wiki refs require the bounded exploration Wiki option',422);
    input.researchWikiRefs?.forEach(ref=>VersionRefSchema.parse(ref));
    if(input.candidateRefs!==undefined && (!includeExploration||!includeResearchWiki||!Array.isArray(input.candidateRefs)))
      throw new KnowledgeError('RESEARCH_CANDIDATE_REFS_INVALID','Exact candidates require explicit bounded exploration Wiki reading',422);
    const exactCandidateRefs=input.candidateRefs===undefined?null:[...new Map(input.candidateRefs.map(ref=>{
      const parsed=VersionRefSchema.parse(ref);return [refKey(parsed),parsed] as const;
    })).values()].sort((a,b)=>refKey(a).localeCompare(refKey(b)));
    if(exactCandidateRefs && exactCandidateRefs.length>200)
      throw new KnowledgeError('RESEARCH_CANDIDATE_LIMIT','Exact research candidates exceed the 200-version bound',422);
    if(!input.projectId.trim() || !input.requestKey.trim() || input.requestKey.length>200 || input.sourceRefs.length>30) throw new KnowledgeError('INVALID_INPUT','Invalid project/key/source list',400);
    ProjectIdSchema.parse(input.projectId); input.sourceRefs.forEach(ref=>VersionRefSchema.parse(ref));
    const requestHash=digest({operation:'reference-pack-v1',projectId:input.projectId,task,sourceRefs:input.sourceRefs,
      ...(includeExploration?{includeExploration:true}:{}),...(includeResearchWiki?{includeResearchWiki:true}:{}),
      ...(input.researchWikiRefs?{researchWikiRefs:input.researchWikiRefs}: {}),
      ...(exactCandidateRefs?{candidateRefs:exactCandidateRefs}: {})});
    const prior=await options.store.getByRequestKey(input.projectId,input.requestKey);
    if(prior) {
      if(prior.requestHash!==requestHash || prior.changes[0].revision.kind!=='reference_pack') throw new KnowledgeError('IDEMPOTENCY_CONFLICT','Request key belongs to another operation');
      return finish(prior,signal);
    }
    const exactWikiRows=input.researchWikiRefs?await Promise.all(input.researchWikiRefs.map(async ref=>{
      const row=await options.store.get(input.projectId,ref);
      if(!row||row.revision.kind!=='wiki')throw new KnowledgeError('RESEARCH_WIKI_MISSING','An exact research Wiki version is unavailable',422);
      return row;
    })):null;
    const linkedResearchKeys=new Set(exactWikiRows?.flatMap(row=>row.revision.kind==='wiki'
      ?[...row.revision.content.relatedRefs,...row.revision.content.patternRefs].map(refKey):[])??[]);
    const now=(options.now?.()??new Date()).toISOString();
    const facts=[] as Array<{ statement:string; sourceRef:VersionRef; citations:ReturnType<typeof citationsOf> }>;
    const sourceDeps:Dependency[]=[]; const sourceGroups=new Set<string>();
    const restrictions=['参考片中的产品台词不可继承为本产品事实；表达结构不证明转化效果'];
    if(includeExploration)restrictions.push('本参考包含探索性材料，仅供研究阅读和待验证的表达设想；不得直接用于生产执行或作为产品、效果、平台规则事实');
    const unknowns:string[]=[];
    for(const ref of input.sourceRefs) {
      const src=await options.knowledge.readSource(input.projectId,ref);
      sourceDeps.push({domain:'source',ref,role:'uses',critical:true}); sourceGroups.add(src.sourceGroup);
      restrictions.push(...src.limitations);
      if(src.kind==='product_fact') {
        if(!src.productVersionRef || !sameRef(src.productVersionRef,task.productVersionRef)) throw new KnowledgeError('PRODUCT_VERSION_MISMATCH','Product facts belong to another SKU revision',422);
        facts.push({statement:src.statement,sourceRef:src.ref,citations:src.citations});
      } else if(src.kind==='platform_rule') {
        const rule=src.ruleScope;
        if(!rule||!rule.platforms.includes(task.platform??'tiktok')||
          !rule.markets.some(market=>market==='*'||market.toLocaleLowerCase()===task.market.toLocaleLowerCase()))
          throw new KnowledgeError('PLATFORM_RULE_SCOPE_MISMATCH','Platform rule is not registered for this task platform and market',422);
        restrictions.push(src.statement);
      }
      else unknowns.push(`${src.kind} 仅作独立来源记录，不能替代产品事实：${src.statement}`);
    }
    if(!facts.length) unknowns.push('未提供经登记的本产品事实；本包仅允许表达结构参考，产品说明需另行补证');
    const decisions:SelectionDecision[]=[];
    const candidates:RevisionView[]=[];
    // Bounded metadata read. No model receives the library; returned context includes selected items only.
    const rows:RevisionView[]=[];
    if(exactCandidateRefs) for(const ref of exactCandidateRefs) {
      signal?.throwIfAborted();
      const row=await options.store.get(input.projectId,ref);
      if(!row||!sameRef(row.revision.ref,ref))
        throw new KnowledgeError('RESEARCH_CANDIDATE_MISSING','An exact research candidate version is unavailable',422);
      if(row.revision.kind!=='case'&&row.revision.kind!=='pattern')
        throw new KnowledgeError('RESEARCH_CANDIDATE_KIND_INVALID','Exact research candidates must be cases or patterns',422);
      rows.push(row);
    } else rows.push(...await options.store.search(input.projectId,{query:includeResearchWiki?'':task.query,kinds:['case','pattern'],platform:task.platform??'tiktok',limit:200,offset:0}));
    const queryTerms=task.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const relevantToResearch=(row:RevisionView)=>linkedResearchKeys.has(refKey(row.revision.ref))||
      queryTerms.some(term=>`${row.revision.title} ${row.revision.body}`.toLocaleLowerCase().includes(term));
    const matchingKeys=new Set(rows.filter(row=>exactCandidateRefs!==null||!includeResearchWiki||relevantToResearch(row)).map(row=>refKey(row.revision.ref)));
    // Challenge relationships are independent of the support text query. A differently
    // titled collection can still hold the counterexample for a matching case.
    const containers=await options.store.search(input.projectId,{query:'',kinds:['pattern','collection'],platform:task.platform??'tiktok',limit:200,offset:0});
    if(containers.length===200 && (await options.store.search(input.projectId,{query:'',kinds:['pattern','collection'],platform:task.platform??'tiktok',limit:1,offset:200})).length)
      throw new KnowledgeError('CHALLENGE_DISCOVERY_LIMIT','Challenge discovery exceeds the bounded collection/pattern scan; resolve the scope before compiling a pack',422);
    const counterexampleKeys=new Set<string>();
    for(const row of containers) {
      const revision=row.revision;
      const members=revision.kind==='collection'?revision.content.members.map(member=>member.ref):revision.kind==='pattern'?[...revision.content.supportRefs,...revision.content.counterexampleRefs]:[];
      if(!matchingKeys.has(refKey(revision.ref)) && !members.some(ref=>matchingKeys.has(refKey(ref)))) continue;
      if(applicabilityIssue(revision,task,includeExploration) || row.review?.purpose!==task.purpose) continue;
      if(row.review.decision!=='approved_for_purpose' && !(includeExploration && row.review.decision==='exploration_only')) {unknowns.push(`相关专题 ${revision.ref.versionId} 尚未按此用途采用；其中的挑战关系仍待核查`);continue;}
      if(!row.current || !row.validity.valid) throw new KnowledgeError('CHALLENGE_CONTAINER_INVALID','A relevant challenge collection or pattern needs revalidation before this pack can be used');
      await revalidateForPack(input.projectId,[{domain:'knowledge',ref:revision.ref,role:'challenges',critical:true}],task.purpose,includeExploration);
      sourceDeps.push({domain:'knowledge',ref:revision.ref,role:'challenges',critical:true});
      restrictions.push(...revision.scope.limitations);unknowns.push(...revision.scope.unknowns);
      if(revision.kind==='collection') revision.content.members.filter(m=>m.role==='counterexample').forEach(m=>counterexampleKeys.add(refKey(m.ref)));
      if(revision.kind==='pattern') revision.content.counterexampleRefs.forEach(ref=>counterexampleKeys.add(refKey(ref)));
    }
    // Expand only referenced counterexamples, within a hard supplementary lookup bound.
    if(counterexampleKeys.size>100) throw new KnowledgeError('COUNTEREXAMPLE_LOOKUP_LIMIT','Too many relevant counterexamples; narrow the research task',422);
    for(const key of counterexampleKeys) if(!rows.some(r=>refKey(r.revision.ref)===key)) {
      const [objectId,versionId]=key.split('/');const linked=await options.store.get(input.projectId,{objectId,versionId});
      if(linked)rows.push(linked);
      else if(exactCandidateRefs)throw new KnowledgeError('COUNTEREXAMPLE_NOT_USABLE','An exact candidate has a missing necessary counterexample',422);
    }
    for(const row of rows.filter(r=>r.revision.kind!=='collection')) {
      const rev=row.revision;
      if(includeResearchWiki&&exactCandidateRefs===null&&!counterexampleKeys.has(refKey(rev.ref))&&!relevantToResearch(row))continue;
      const reason=!row.current || !row.published || !row.validity.valid ? '版本已失效、被替代或待复核' :
        (row.review?.decision!=='approved_for_purpose' && !(includeExploration && row.review?.decision==='exploration_only')) || row.review.purpose!==task.purpose ? '未按本任务用途采用' : applicabilityIssue(rev,task,includeExploration);
      if(reason) {if(counterexampleKeys.has(refKey(rev.ref)))throw new KnowledgeError('COUNTEREXAMPLE_NOT_USABLE','A necessary counterexample is not valid and adopted for this task');decisions.push({ref:rev.ref,selected:false,reason,sourceGroups:rev.sourceGroups});continue;}
      try {await revalidateForPack(input.projectId,[{domain:'knowledge',ref:rev.ref,role:'uses',critical:true}],task.purpose,includeExploration);}
      catch(error) {if(!(error instanceof KnowledgeError)) throw error; decisions.push({ref:rev.ref,selected:false,reason:'准确依据需要重新核查',sourceGroups:rev.sourceGroups});continue;}
      candidates.push(row);
    }
    const ranked=candidates.sort((a,b)=>score(b.revision,task)-score(a.revision,task)||refKey(a.revision.ref).localeCompare(refKey(b.revision.ref)));
    const counterexamples=ranked.filter(r=>counterexampleKeys.has(refKey(r.revision.ref)));
    if(!counterexamples.length) unknowns.push('没有可用的相关反例；未生成替代反例');
    const selected:RevisionView[]=[];
    const expressions=new Set<string>();
    const groupsByKind=new Map<string,Set<string>>();
    // Relevant counterexamples are mandatory, not silently dropped to make support fit.
    for(const row of [...counterexamples,...ranked.filter(r=>!counterexampleKeys.has(refKey(r.revision.ref)))]) {
      signal?.throwIfAborted(); const rev=row.revision;const isCounter=counterexampleKeys.has(refKey(rev.ref));
      const groups=groupsByKind.get(rev.kind)??new Set<string>();
      const expression=rev.kind==='pattern'?canonical(rev.content.sequence).toLocaleLowerCase():rev.kind==='case'?rev.content.summary.trim().toLocaleLowerCase():rev.body;
      if(!isCounter && expressions.has(expression)) {decisions.push({ref:rev.ref,selected:false,reason:'表达内容重复，保留不同表达的空间；没有增加效果证明',sourceGroups:rev.sourceGroups});continue;}
      if(citationsOf(rev).length>20) {if(isCounter)throw new KnowledgeError('PROTECTED_CONTEXT_OVERFLOW','A necessary counterexample exceeds the per-item citation bound',422);decisions.push({ref:rev.ref,selected:false,reason:'证据条目过多，需另提保留范围与限制的精简版本',sourceGroups:rev.sourceGroups});continue;}
      if(!isCounter && rev.sourceGroups.length && rev.sourceGroups.every(g=>groups.has(g))) {decisions.push({ref:rev.ref,selected:false,reason:'同源重复支持；不增加独立依据',sourceGroups:rev.sourceGroups});continue;}
      if(selected.length>=task.maxItems && !isCounter) {decisions.push({ref:rev.ref,selected:false,reason:'已达本任务条目上限',sourceGroups:rev.sourceGroups});continue;}
      if(isCounter && selected.length>=task.maxItems) throw new KnowledgeError('PROTECTED_CONTEXT_OVERFLOW','Relevant counterexamples exceed configured item limit',422);
      selected.push(row); expressions.add(expression); rev.sourceGroups.forEach(g=>groups.add(g));groupsByKind.set(rev.kind,groups);
    }
    const researchWiki:RevisionView[]=[];
    const wikiOmissions:string[]=[];
    if(includeResearchWiki&&selected.length) {
      const wikiRows=exactWikiRows??await options.store.search(input.projectId,{query:'',kinds:['wiki'],platform:task.platform??'tiktok',limit:21,offset:0});
      if(wikiRows.length>20)throw new KnowledgeError('RESEARCH_WIKI_DISCOVERY_LIMIT','More than 20 research Wikis require exact task-scoped refs',422);
      const selectedKeys=new Set(selected.map(row=>refKey(row.revision.ref)));
      for(const row of wikiRows) {
        const wiki=row.revision;
        if(wiki.kind!=='wiki'||!row.current || !row.published)continue;
        if(![...wiki.content.relatedRefs,...wiki.content.patternRefs].some(ref=>selectedKeys.has(refKey(ref))))continue;
        if(applicabilityIssue(wiki,task,includeExploration)||!row.validity.valid||row.review?.purpose!==task.purpose||
          !['exploration_only','approved_for_purpose'].includes(row.review.decision))continue;
        if(wiki.content.navigationOnly) {
          wikiOmissions.push(`${wiki.ref.versionId}: 仅供导航的父专题页不含可引用研究综合，未纳入研究上下文`);continue;
        }
        if(citationsOf(wiki).length>20||Buffer.byteLength(wiki.body)>20000) {
          wikiOmissions.push(`${wiki.ref.versionId}: 探索专题正文或引证超过本包限额，未纳入上下文`);continue;
        }
        if(researchWiki.length>=3) {
          wikiOmissions.push(`${wiki.ref.versionId}: 探索专题数量达到本包上限`);continue;
        }
        researchWiki.push(row);
      }
    }
    const retainedRestrictions=(chosen:RevisionView[],wikis:RevisionView[])=>[...new Set([...restrictions,
      ...chosen.flatMap(r=>r.revision.scope.limitations),...wikis.flatMap(r=>r.revision.scope.limitations),
      ...chosen.filter(r=>includeExploration&&unknownApplicability(r.revision)).map(r=>
        `知识版本 ${r.revision.ref.versionId} 的市场、语言、受众或目标范围未知，仅允许探索阅读，不得据此推断适用于 ${task.market}/${task.language}`),
      ...(includeResearchWiki?['探索专题总结只是研究上下文，不能增加独立支持数或直接用于制作。']:[])])];
    const retainedUnknowns=(chosen:RevisionView[],wikis:RevisionView[])=>[...new Set([...unknowns,
      ...chosen.flatMap(r=>r.revision.scope.unknowns),...wikis.flatMap(r=>r.revision.scope.unknowns),
      ...chosen.filter(r=>includeExploration&&unknownApplicability(r.revision)).map(r=>
        `知识版本 ${r.revision.ref.versionId} 的适用范围尚需独立核查`)])];
    const contextFor=(chosen:RevisionView[],wikis:RevisionView[],omissions:string[])=>canonical({
      task, productFacts:facts, restrictions:retainedRestrictions(chosen,wikis),
      unknowns:retainedUnknowns(chosen,wikis), omissions,
      references:chosen.map(({revision:r})=>({ref:r.ref,kind:r.kind,role:counterexampleKeys.has(refKey(r.ref))?'counterexample':'support',
        evidenceStatus:includeExploration && chosen.find(row=>sameRef(row.revision.ref,r.ref))?.review?.decision==='exploration_only'?'exploration_only':'approved_for_purpose',
        title:r.title, summary:r.kind==='case'?r.content.summary:r.kind==='pattern'?{problem:r.content.problem,mechanism:r.content.mechanism,sequence:r.content.sequence,requiredElements:r.content.requiredElements,variableSlots:r.content.variableSlots,applicability:r.content.applicability,exclusions:r.content.exclusions,prediction:r.content.prediction,evidenceLevel:r.content.evidenceLevel}:r.body,
        reason:selectionReason(r,task,counterexampleKeys.has(refKey(r.ref))),citations:citationsOf(r),limitations:r.scope.limitations,unknowns:r.scope.unknowns})),
      ...(includeResearchWiki?{researchContext:wikis.map(({revision:r})=>r.kind==='wiki'?({
        ref:r.ref,kind:'wiki',role:'research_context_only',title:r.title,question:r.content.question,
        understanding:r.body,disputes:r.content.disputes,nextQuestions:r.content.nextQuestions,
        decisionGuide:r.content.decisionGuide??null,
        citations:r.content.citations,limitations:r.scope.limitations,unknowns:r.scope.unknowns,
      }):null).filter(Boolean)}:{}),
    });
    const omissions=[...decisions.filter(d=>!d.selected).map(d=>`${d.ref.versionId}: ${d.reason}`),...wikiOmissions].slice(0,45);
    if(exactCandidateRefs) omissions.push(`本包候选仅限指定的 ${exactCandidateRefs.length} 个准确案例或模式版本；未检索全历史知识库`);
    else if(rows.length>=200) omissions.push('候选检索达到 200 条上限，未读取的记录不代表不适用；请缩小专题后另查');
    let contextText=contextFor(selected,researchWiki,omissions);
    const wikiLinks=(wiki:RevisionView,chosen:RevisionView[],casesOnly:boolean)=>wiki.revision.kind==='wiki'&&
      [...wiki.revision.content.relatedRefs,...wiki.revision.content.patternRefs].some(ref=>chosen.some(row=>
        (!casesOnly||row.revision.kind==='case')&&sameRef(row.revision.ref,ref)));
    const hasWikiLink=(chosen:RevisionView[],casesOnly:boolean)=>researchWiki.some(wiki=>wikiLinks(wiki,chosen,casesOnly));
    const removeWiki=(index:number,reason:string)=>{
      const [removed]=researchWiki.splice(index,1);
      decisions.push({ref:removed.revision.ref,selected:false,reason,sourceGroups:[]});
      omissions.push(`${removed.revision.ref.versionId}: ${reason}`);
    };
    const removeSupport=(index:number)=>{
      const [removed]=selected.splice(index,1);
      const reason='上下文预算不足，移除支持例；保留全局安全限制、仍入选条目的适用限制与反例';
      decisions.push({ref:removed.revision.ref,selected:false,reason,sourceGroups:removed.revision.sourceGroups});
      omissions.push(`${removed.revision.ref.versionId}: ${reason}`);
      // A Wiki without any still-selected source must not appear as independent evidence.
      for(let i=researchWiki.length-1;i>=0;i--) if(!wikiLinks(researchWiki[i],selected,false))
        removeWiki(i,'关联案例或模式已移除，探索专题总结未纳入本包');
    };
    const casePairCouldFit=(wiki:RevisionView,chosen=selected)=>{
      const mandatory=selected.filter(row=>counterexampleKeys.has(refKey(row.revision.ref)));
      return chosen.some(row=>{
        if(row.revision.kind!=='case'||!wikiLinks(wiki,[row],true))return false;
        const retained=mandatory.includes(row)?mandatory:[...mandatory,row];
        const omitted=selected.filter(item=>!retained.includes(item));
        const omittedWikis=researchWiki.filter(item=>item!==wiki);
        const trialOmissions=[...omissions,...omitted.map(item=>`${item.revision.ref.versionId}: 上下文预算不足，移除支持例；保留全局安全限制、仍入选条目的适用限制与反例`),
          ...omittedWikis.map(item=>`${item.revision.ref.versionId}: 上下文预算不足，探索专题总结未纳入本包`)];
        return counter.count(contextFor(retained,[wiki],trialOmissions))<=task.tokenBudget;
      });
    };
    while(counter.count(contextText)>task.tokenBudget) {
      let removeIndex=selected.length-1;
      while(removeIndex>=0 && counterexampleKeys.has(refKey(selected[removeIndex].revision.ref))) removeIndex--;
      if(researchWiki.length) {
        // Spend the optional support budget before discarding the requested research context.
        // Preserve one Wiki with a cited case whenever such a pair can fit.
        const casePair=hasWikiLink(selected,true);
        let impossibleWiki=-1;
        for(let i=researchWiki.length-1;i>=0;i--) if(wikiLinks(researchWiki[i],selected,true)&&!casePairCouldFit(researchWiki[i])) {
          impossibleWiki=i;break;
        }
        if(impossibleWiki>=0) {
          removeWiki(impossibleWiki,'最小关联案例与探索专题仍超出预算，探索专题总结未纳入本包');
          contextText=contextFor(selected,researchWiki,omissions);continue;
        }
        while(removeIndex>=0) {
          const remainder=selected.filter((_,index)=>index!==removeIndex);
          if(!counterexampleKeys.has(refKey(selected[removeIndex].revision.ref)) &&
            (casePair?researchWiki.some(wiki=>casePairCouldFit(wiki,remainder)):hasWikiLink(remainder,false)))break;
          removeIndex--;
        }
        if(removeIndex>=0) {
          removeSupport(removeIndex);
          contextText=contextFor(selected,researchWiki,omissions);continue;
        }
        let wikiIndex=researchWiki.length-1;
        if(casePair) {
          let lessRelevant=-1;
          for(let i=researchWiki.length-1;i>=0;i--) if(!wikiLinks(researchWiki[i],selected,true)) {lessRelevant=i;break;}
          if(lessRelevant>=0)wikiIndex=lessRelevant;
        }
        removeWiki(wikiIndex,'上下文预算不足，探索专题总结未纳入本包');
        contextText=contextFor(selected,researchWiki,omissions);continue;
      }
      if(removeIndex<0) throw new KnowledgeError('PROTECTED_CONTEXT_OVERFLOW','Product facts, restrictions and counterexamples exceed the context budget',422);
      removeSupport(removeIndex);
      contextText=contextFor(selected,researchWiki,omissions);
    }
    if(!selected.length) throw new KnowledgeError('NO_USABLE_REFERENCES','No adopted applicable case or pattern fits this task and budget',422);
    const ref={objectId:randomUUID(),versionId:randomUUID()};
    selected.forEach(({revision:r})=>decisions.push({ref:r.ref,selected:true,sourceGroups:r.sourceGroups,
      reason:selectionReason(r,task,counterexampleKeys.has(refKey(r.ref)))}));
    researchWiki.forEach(({revision:r})=>decisions.push({ref:r.ref,selected:true,sourceGroups:[],
      reason:r.kind==='wiki'&&r.content.decisionGuide
        ?`仅作探索研究上下文；当前经引证判断：${r.content.decisionGuide.judgment}；不增加独立证据或支持数`
        :'仅作探索研究上下文；此版本未记录结构化决策指引；不增加独立证据或支持数'}));
    const item=(r:KnowledgeRevision)=>({ref:r.ref,reason:decisions.find(d=>d.selected&&sameRef(d.ref,r.ref))!.reason,citations:citationsOf(r)});
    if(omissions.length>50)throw new KnowledgeError('PROTECTED_CONTEXT_OVERFLOW','Too many exclusions to preserve in the bounded reference pack; narrow the task',422);
    const pack=ReferencePackVersionSchema.parse({schemaVersion:'1.0',ref,projectId:input.projectId,purpose:task.purpose,productVersionRef:task.productVersionRef,
      selectedCases:selected.filter(r=>r.revision.kind==='case'&&!counterexampleKeys.has(refKey(r.revision.ref))).map(r=>item(r.revision)),
      selectedPatterns:selected.filter(r=>r.revision.kind==='pattern'&&!counterexampleKeys.has(refKey(r.revision.ref))).map(r=>item(r.revision)),
      counterexamples:selected.filter(r=>counterexampleKeys.has(refKey(r.revision.ref))).map(r=>item(r.revision)),
      ...(includeResearchWiki?{researchContext:researchWiki.map(row=>item(row.revision))}:{}),productFacts:facts,
      restrictions:retainedRestrictions(selected,researchWiki),
      unknowns:retainedUnknowns(selected,researchWiki),omissions,
      tokenBudget:task.tokenBudget,tokenUsed:counter.count(contextText),createdAt:now});
    const deps=uniqueDeps([...sourceDeps,...selected.map(r=>({domain:'knowledge' as const,ref:r.revision.ref,role:'uses' as const,critical:true})),
      ...researchWiki.map(r=>({domain:'knowledge' as const,ref:r.revision.ref,role:'uses' as const,critical:true}))]);
    const explorationRefs=await revalidateForPack(input.projectId,deps,task.purpose,includeExploration);
    if(includeExploration) for(const row of [...selected,...researchWiki]) if(unknownApplicability(row.revision) && !explorationRefs.some(ref=>sameRef(ref,row.revision.ref))) explorationRefs.push(row.revision.ref);
    signal?.throwIfAborted();
    const content:PackContent={pack,task,decisions,contextText,tokenCounter:counter.version,knowledgeEpoch:await options.store.epoch(input.projectId),explorationRefs};
    let artifactRef=null;
    const bytes=Buffer.from(canonical(content));
    if(bytes.byteLength>=32768) {
      if(!options.artifacts) throw new KnowledgeError('ARTIFACT_WRITER_REQUIRED','Large packs require the shared verified R2 writer',503);
      artifactRef=await options.artifacts.writeArtifact(bytes,'application/json',signal);
    }
    const scope:KnowledgeScope={applicability:{productVersionRefs:[task.productVersionRef],platforms:[task.platform??'tiktok'],markets:[task.market],languages:[task.language],audiences:[task.audience],goals:[task.goal],requiredProduction:task.production,transferRationale:null},limitations:pack.restrictions,unknowns:pack.unknowns,goalTags:['video_business_actions'],reviewDueAt:null};
    const revision:KnowledgeRevision={kind:'reference_pack',ref,projectId:input.projectId,title:packTitle(selected,researchWiki,task),scope,dependencies:deps,sourceGroups:[...new Set([...sourceGroups,...selected.flatMap(r=>r.revision.sourceGroups)])],body:contextText,artifactRef,createdAt:now,analysisQuality:null,content};
    // Request digest intentionally excludes generated IDs/timestamps; identical retries return the frozen first pack.
    const change:KnowledgeChangeSet={id:randomUUID(),projectId:input.projectId,requestKey:input.requestKey,requestHash,contentHash:digest(revision),purpose:task.purpose,proposer:'reference-pack-builder-v1',rationale:'从已按用途采用的知识构建有限参考，不新增事实',methodVersion:'reference-selector-v2',cost:{state:'unknown',reason:'Deterministic selection; no provider billing observation'},baseHeads:[{objectId:ref.objectId,versionId:null}],inputManifest:deps,changes:[{revision,effect:'create',explanation:'冻结本任务实际上下文和选择依据'}],createdAt:now};
    const staged=await options.store.stage(change);
    return finish(staged,signal);
  }
  async function finish(staged:KnowledgeChangeSet,signal?:AbortSignal):Promise<PackContent> {
    const revision=staged.changes[0].revision;
    if(revision.kind!=='reference_pack') throw new KnowledgeError('IDEMPOTENCY_CONFLICT','Request key belongs to another operation');
    const existing=await options.store.get(staged.projectId,revision.ref);
    if(existing?.published) return revision.content;
    const exploration=Boolean(revision.content.explorationRefs?.length);
    await revalidateForPack(staged.projectId,staged.inputManifest,staged.purpose,exploration);
    await options.store.recordReview({id:randomUUID(),projectId:staged.projectId,changeSetId:staged.id,contentHash:staged.contentHash,purpose:staged.purpose,reviewer:'reference-dependency-policy-v1',policyVersion:'reference-dependency-policy-v1',decision:exploration?'exploration_only':'approved_for_purpose',rationale:exploration?'包含明确限定为探索阅读的未采用版本；全部引用、限制及预算已核查':'只组合当前有效且用途匹配的版本；事实/限制/反例与预算经过确定性检查',createdAt:(options.now?.()??new Date()).toISOString()});
    signal?.throwIfAborted(); await options.store.publish(staged.projectId,staged.id,staged.contentHash);
    return revision.content;
  }
  async function validateForExecution(projectId:string,ref:VersionRef,task:CreativeKnowledgeTask) {
    if(task.platform==='unknown')throw new KnowledgeError('PLATFORM_UNVERIFIED','A reference pack needs a verified target platform',422);
    const view=await options.store.get(projectId,ref);
    if(!view?.published || view.revision.kind!=='reference_pack') throw new KnowledgeError('PACK_NOT_FOUND','Frozen reference pack not found',404);
    const exploration=Boolean(view.revision.content.explorationRefs?.length);
    if(exploration && task.purpose!=='exploration_reading')throw new KnowledgeError('EXPLORATION_PACK_RESTRICTED','Exploration pack cannot execute a production task');
    if(canonical(view.revision.content.task)!==canonical(CreativeKnowledgeTaskSchema.parse(task))) throw new KnowledgeError('TASK_MISMATCH','Frozen pack belongs to a different task');
    if(!view.validity.valid || !view.current) throw new KnowledgeError('PACK_INVALID','Frozen pack requires rebuilding');
    if(exploration && view.review?.decision!=='exploration_only')throw new KnowledgeError('EXPLORATION_PACK_RESTRICTED','Exploration pack lacks exploration-only review');
    for(const dep of view.revision.dependencies) if(dep.domain==='source') {
      const source=await options.knowledge.readSource(projectId,dep.ref);
      if(source.kind==='platform_rule'&&(!source.ruleScope||!source.ruleScope.platforms.includes(task.platform??'tiktok')||
        !source.ruleScope.markets.some(market=>market==='*'||market.toLocaleLowerCase()===task.market.toLocaleLowerCase())))
        throw new KnowledgeError('PLATFORM_RULE_SCOPE_MISMATCH','Frozen pack contains a rule outside this platform or market',422);
    }
    await revalidateForPack(projectId,view.revision.dependencies,task.purpose,exploration);
    return view.revision.content;
  }
  return {buildReferencePack,validateForExecution};
}
function applicabilityIssue(rev:KnowledgeRevision,task:CreativeKnowledgeTask,allowUnknown=false):string|null {
  const a=rev.scope.applicability;
  if(!platformFit(a,task.platform??'tiktok'))return '平台不匹配且没有针对目标平台的迁移依据';
  if(!a.productVersionRefs.some(r=>sameRef(r,task.productVersionRef)) && !a.transferRationale) return '产品版本不匹配且没有跨产品借鉴依据';
  for(const [values,target,label] of [[a.markets,task.market,'市场'],[a.languages,task.language,'语言'],[a.audiences,task.audience,'受众'],[a.goals,task.goal,'目标']] as const)
    if(!values.some(v=>v==='*'||v.toLocaleLowerCase()===target.toLocaleLowerCase()) && !(allowUnknown && values.length===0)) return `${label}适用性未知或不匹配`;
  if(a.requiredProduction.some(p=>!task.production.includes(p))) return '制作条件不满足';
  return null;
}
function unknownApplicability(rev:KnowledgeRevision):boolean {
  const a=rev.scope.applicability;
  return a.platforms?.length===0 || a.platforms?.includes('unknown') || [a.markets,a.languages,a.audiences,a.goals].some(values=>values.length===0);
}
function score(rev:KnowledgeRevision,task:CreativeKnowledgeTask):number {
  const text=`${rev.title} ${rev.body}`.toLocaleLowerCase();
  const terms=task.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return terms.reduce((sum,t)=>sum+(text.includes(t)?1:0),0) + (rev.scope.applicability.productVersionRefs.some(r=>sameRef(r,task.productVersionRef))?2:0);
}
function selectionReason(rev:KnowledgeRevision,task:CreativeKnowledgeTask,isCounterexample:boolean):string {
  const text=`${rev.title} ${rev.body}`.toLocaleLowerCase();
  const hits=[...new Set(task.query.split(/\s+/).filter(Boolean).filter(term=>text.includes(term.toLocaleLowerCase())))].slice(0,3);
  const a=rev.scope.applicability;
  const scopeFit=(values:string[],target:string,label:string)=>values.length===0?`${label}「${target}」适用性未核实`:
    values.includes('*')?`${label}范围标为通用，任务值「${target}」仍需实测`:
      `${label}「${target}」在已记录适用范围内`;
  const fit=hits.length?`问题「${task.query}」与标题或正文中的「${hits.join('、')}」有词项关联`:
    `问题「${task.query}」未在标题或正文找到直接词项`;
  return [`用途 ${task.purpose}`,fit,scopeFit(a.goals,task.goal,'目标'),
    `平台「${task.platform??'tiktok'}」${platformFit(a,task.platform??'tiktok')==='transfer'?'有明确迁移依据':'在已记录适用范围内'}`,
    scopeFit(a.audiences,task.audience,'受众'),scopeFit(a.markets,task.market,'市场'),
    scopeFit(a.languages,task.language,'语言'),
    isCounterexample?'作为已核查挑战关系中的反例保留':'经用途审核和适用范围核查后作为限定参考入选',
    ...(unknownApplicability(rev)?['未知适用范围仅供探索阅读，不能据此推断有效性']:[])].join('；');
}
function packTitle(selected:RevisionView[],wikis:RevisionView[],task:CreativeKnowledgeTask):string {
  const focus=wikis[0]?.revision.title??selected.find(row=>row.revision.kind==='case')?.revision.title??selected[0]?.revision.title??task.query;
  const anchor=selected.find(row=>row.revision.title!==focus)?.revision.title;
  return `${task.purpose==='exploration_reading'?'探索研究':'创意参考'}：${focus}${anchor?` · ${anchor}`:''}`.slice(0,300);
}
