import { readTestDatabase } from '../../../scripts/runtime/test-database.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrateKnowledge } from '../src/migrations.ts';
import { createKnowledgeStore } from '../src/store.ts';
import { createKnowledgeService, type KnowledgeReviewPolicy } from '../src/service.ts';
import { createReferencePackService } from '../src/reference-pack.ts';
import { navigationWikiScope, renderNavigationWiki } from '../src/navigation-wiki.ts';
import type { KnowledgeRevision, KnowledgeStore } from '../src/types.ts';
import { caseRevision, claimRevision, mediaCitation, proposal, ref, scope, sha, sourceCitation, SyntheticAnalysis, SyntheticSources, task, timestamp } from './service-fixtures.ts';

const connectionString=readTestDatabase();

const dbTest=connectionString?test:test.skip;

async function withKnowledge(run:(env:ReturnType<typeof environment>)=>Promise<void>) {
  const admin=new pg.Pool({connectionString,max:2});
  const schema=`ccl_knowledge_service_test_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,max:8,options:`-c search_path=${schema}`});
  try { await migrateKnowledge(pool);await run(environment(createKnowledgeStore(pool),pool)); }
  finally { await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end(); }
}
function environment(store:KnowledgeStore,pool:pg.Pool) {
  const projectId=`knowledge-test-${randomUUID()}`;
  const product=ref();const analysis=new SyntheticAnalysis();const sources=new SyntheticSources();
  let decision:'approved_for_purpose'|'exploration_only'|'rejected'='approved_for_purpose';
  const policy:KnowledgeReviewPolicy={version:'independent-test-review-v1',async review(){return {reviewer:'independent-reviewer',decision,rationale:'Exact versions checked for the stated purpose'};}};
  const knowledge=createKnowledgeService({store,analysis,scopedUseDecisions:analysis.scopedUseStore,sources,reviewPolicy:policy,now:()=>new Date(timestamp)});
  const packs=createReferencePackService({store,knowledge,now:()=>new Date(timestamp)});
  const publish=async(revisions:KnowledgeRevision[],effect:'create'|'narrow'|'dispute'|'withdraw'|'correct'='create',baseVersions:Record<string,string|null>={})=>{
    const change=await knowledge.propose(proposal(projectId,revisions,effect,baseVersions));
    await knowledge.reviewChangeSet({projectId,changeSetId:change.id,contentHash:change.contentHash,purpose:change.purpose});
    await knowledge.publishRevision(projectId,change.id,change.contentHash);return change;
  };
  return {projectId,product,analysis,sources,store,pool,knowledge,packs,publish,setDecision:(next:typeof decision)=>{decision=next;}};
}

dbTest('overview case is reviewed, selected in a bounded pack, then source invalidation blocks execution while history remains', {timeout:60_000}, async()=>withKnowledge(async e=>{
  const a=e.analysis.add(e.projectId);
  const c=caseRevision(e.projectId,e.product,a.result,a.anchor);
  const change=await e.knowledge.proposeCase({projectId:e.projectId,requestKey:randomUUID(),purpose:'creative_reference',proposer:'researcher',analysisResultRef:a.result.ref,title:c.title,summary:'hook case',citations:[mediaCitation(a.anchor)],scope:c.scope,ref:c.ref,baseHead:null});
  await assert.rejects(e.knowledge.publishRevision(e.projectId,change.id,change.contentHash),/review/i);
  await e.knowledge.reviewChangeSet({projectId:e.projectId,changeSetId:change.id,contentHash:change.contentHash,purpose:change.purpose});
  const publication=await e.knowledge.publishRevision(e.projectId,change.id,change.contentHash);
  const input={projectId:e.projectId,requestKey:randomUUID(),task:task(e.product),sourceRefs:[]};
  const first=await e.packs.buildReferencePack(input);
  assert.equal(first.pack.selectedCases.length,1);
  assert.deepEqual(first.pack.selectedCases[0].ref,c.ref);
  assert.equal(first.pack.productFacts.length,0);
  assert.match(first.pack.unknowns.join(' '),/产品事实/);
  assert.ok(first.pack.tokenUsed<=first.pack.tokenBudget);
  assert.deepEqual(await e.packs.buildReferencePack(input),first);
  assert.deepEqual(await e.packs.validateForExecution(e.projectId,first.pack.ref,input.task),first);
  await assert.rejects(e.packs.validateForExecution(e.projectId,first.pack.ref,task(e.product,{market:'CA'})),/different task|task mismatch/i);
  await e.store.invalidate(e.projectId,{domain:'analysis',ref:a.result.ref,reason:'source analysis withdrawn',state:'withdrawn',createdAt:timestamp});
  await assert.rejects(e.packs.validateForExecution(e.projectId,first.pack.ref,input.task),/invalid|revalid|withdraw|rebuilding/i);
  const epoch=await e.store.epoch(e.projectId);
  assert.deepEqual(await e.knowledge.publishRevision(e.projectId,change.id,change.contentHash),publication);
  assert.equal(await e.store.epoch(e.projectId),epoch);
  assert.deepEqual(await e.store.head(e.projectId,c.ref.objectId),c.ref);
  assert.equal((await e.knowledge.get(e.projectId,c.ref))?.published,true);
  assert.equal((await e.knowledge.history(e.projectId,c.ref.objectId)).length,1);
}));

dbTest('source review deadline compares instants, including timezone offsets', {timeout:60_000}, async()=>withKnowledge(async e=>{
  const source=e.sources.add(e.projectId,'product_fact','Timezone-sensitive source',e.product);
  source.reviewDueAt='2026-10-14T16:00:00+08:00';
  const clocked=createKnowledgeService({store:e.store,analysis:e.analysis,sources:e.sources,now:()=>new Date('2026-10-14T09:00:00Z')});
  await assert.rejects(clocked.readSource(e.projectId,source.ref),/revalid|invalid|source/i);
}));

dbTest('published case can be withdrawn after its analysis source becomes invalid', {timeout:60_000}, async()=>withKnowledge(async e=>{
  const a=e.analysis.add(e.projectId);const original=caseRevision(e.projectId,e.product,a.result,a.anchor,'withdrawn hook');
  if(original.kind!=='case') throw new Error('Synthetic case fixture changed kind');
  await e.publish([original]);
  await e.store.invalidate(e.projectId,{domain:'analysis',ref:a.result.ref,reason:'upstream result retracted',state:'withdrawn',createdAt:timestamp});
  const nextRef={objectId:original.ref.objectId,versionId:randomUUID()};
  const candidate=structuredClone(original);
  candidate.ref=nextRef;candidate.content.ref=nextRef;candidate.body='forged replacement';candidate.content.summary='forged replacement';
  await assert.rejects(e.knowledge.propose(proposal(e.projectId,[candidate],'correct',{[nextRef.objectId]:original.ref.versionId})),/invalid|withdraw|revalid|dependency|retracted/i);
  const withdrawal=await e.knowledge.propose(proposal(e.projectId,[candidate],'withdraw',{[nextRef.objectId]:original.ref.versionId}));
  assert.equal(withdrawal.changes[0].revision.body,original.body);
  assert.deepEqual(withdrawal.changes[0].revision.dependencies,(await e.knowledge.get(e.projectId,original.ref))?.revision.dependencies);
  await assert.rejects(e.knowledge.publishRevision(e.projectId,withdrawal.id,withdrawal.contentHash),/review/i);
  await e.knowledge.reviewChangeSet({projectId:e.projectId,changeSetId:withdrawal.id,contentHash:withdrawal.contentHash,purpose:withdrawal.purpose});
  await e.knowledge.publishRevision(e.projectId,withdrawal.id,withdrawal.contentHash);
  assert.deepEqual(await e.store.head(e.projectId,nextRef.objectId),nextRef);
  assert.equal((await e.knowledge.get(e.projectId,nextRef))?.validity.valid,false);
  assert.equal((await e.knowledge.history(e.projectId,nextRef.objectId)).length,2);
}));

dbTest('generic proposal cannot create a reference pack from frozen selector content', {timeout:60_000}, async()=>withKnowledge(async e=>{
  const a=e.analysis.add(e.projectId);const c=caseRevision(e.projectId,e.product,a.result,a.anchor);
  await e.publish([c]);
  const frozen=await e.packs.buildReferencePack({projectId:e.projectId,requestKey:randomUUID(),task:task(e.product),sourceRefs:[]});
  const selected=await e.knowledge.get(e.projectId,frozen.pack.ref);
  assert.ok(selected?.revision.kind==='reference_pack');
  const forged=structuredClone(selected.revision);
  const forgedRef=ref();forged.ref=forgedRef;forged.content.pack.ref=forgedRef;
  await assert.rejects(e.knowledge.propose(proposal(e.projectId,[forged])),/pack|builder|task selection/i);
  assert.equal(await e.store.head(e.projectId,forgedRef.objectId),null);
}));

dbTest('wiki navigation rejects missing and cross-project exact revisions', {timeout:60_000}, async()=>withKnowledge(async e=>{
  const a=e.analysis.add(e.projectId);const parent=caseRevision(e.projectId,e.product,a.result,a.anchor);
  await e.publish([parent]);
  const wikiRef=ref();
  const wiki:KnowledgeRevision={kind:'wiki',ref:wikiRef,projectId:e.projectId,title:'navigation wiki',body:'navigation wiki',scope:scope(e.product),dependencies:[],sourceGroups:[],artifactRef:null,createdAt:timestamp,analysisQuality:null,
    content:{ref:wikiRef,projectId:e.projectId,title:'navigation wiki',question:'Where is the evidence?',claimRefs:[],patternRefs:[],relatedRefs:[ref()],disputes:[],nextQuestions:[],citations:[mediaCitation(a.anchor)]}};
  await assert.rejects(e.knowledge.propose(proposal(e.projectId,[wiki])),/related|navigation|version/i);
  const foreignProject=`foreign-${randomUUID()}`;
  const b=e.analysis.add(foreignProject);const foreign=caseRevision(foreignProject,e.product,b.result,b.anchor);
  const foreignChange=await e.knowledge.propose(proposal(foreignProject,[foreign]));
  await e.knowledge.reviewChangeSet({projectId:foreignProject,changeSetId:foreignChange.id,contentHash:foreignChange.contentHash,purpose:foreignChange.purpose});
  await e.knowledge.publishRevision(foreignProject,foreignChange.id,foreignChange.contentHash);
  wiki.content.relatedRefs=[foreign.ref];
  await assert.rejects(e.knowledge.propose(proposal(e.projectId,[wiki])),/related|navigation|version/i);
}));

dbTest('comparison context preserves exact earlier Case and Wiki versions without creating replacement dependency cycles', {timeout:60_000}, async()=>withKnowledge(async e=>{
  const a=e.analysis.add(e.projectId);const parent=caseRevision(e.projectId,e.product,a.result,a.anchor);
  await e.publish([parent]);
  const wikiRef=ref();
  const wiki:KnowledgeRevision={kind:'wiki',ref:wikiRef,projectId:e.projectId,title:'Original exploration',body:'Original exploration',scope:scope(e.product),dependencies:[],sourceGroups:[],artifactRef:null,createdAt:timestamp,analysisQuality:null,
    content:{ref:wikiRef,projectId:e.projectId,title:'Original exploration',question:'What changed?',claimRefs:[],patternRefs:[],relatedRefs:[parent.ref],disputes:[],nextQuestions:[],citations:[mediaCitation(a.anchor)]}};
  await e.publish([wiki]);
  const nextCase=structuredClone(parent),nextWiki=structuredClone(wiki);
  if(nextCase.kind!=='case')throw new Error('Synthetic Case expected');
  nextCase.ref={objectId:parent.ref.objectId,versionId:randomUUID()};nextCase.content.ref=nextCase.ref;
  nextWiki.ref={objectId:wiki.ref.objectId,versionId:randomUUID()};nextWiki.content.ref=nextWiki.ref;
  if(nextWiki.kind!=='wiki')throw new Error('Synthetic Wiki expected');
  nextWiki.content.relatedRefs=[nextCase.ref];
  nextWiki.content.comparisonContext=[parent.ref,wiki.ref].map(ref=>({ref,rationale:'Exact prior reading only',countsAsIndependentSupport:false}));
  const missing=structuredClone(nextWiki);missing.content.comparisonContext![0]!.ref=ref();
  await assert.rejects(e.knowledge.propose(proposal(e.projectId,[missing],'correct',{[wiki.ref.objectId]:wiki.ref.versionId})),/comparison|historical/i);
  const updated=await e.publish([nextCase,nextWiki],'correct',{[parent.ref.objectId]:parent.ref.versionId,[wiki.ref.objectId]:wiki.ref.versionId});
  const page=updated.changes.find(item=>item.revision.kind==='wiki')!.revision;
  assert.equal(page.kind,'wiki');
  if(page.kind!=='wiki')throw new Error('Synthetic Wiki expected');
  assert.deepEqual(page.content.comparisonContext,nextWiki.content.comparisonContext);
  assert.equal(page.dependencies.some(dep=>dep.domain==='knowledge'&&[parent.ref,wiki.ref].some(old=>dep.ref.versionId===old.versionId)),false);
  assert.equal((await e.store.get(e.projectId,nextWiki.ref))?.validity.valid,true);
}));

dbTest('navigation Wiki is deterministic, exploration-only and cannot bypass review through prepared publication', {timeout:60_000}, async()=>withKnowledge(async e=>{
  const analysis=e.analysis.add(e.projectId,{adoptPurpose:'exploration_reading'});
  const pageRef=ref();
  const page:KnowledgeRevision={kind:'wiki',ref:pageRef,projectId:e.projectId,title:'已审研究页',body:'准确分析锚点的有限综合。',
    scope:scope(e.product),dependencies:[{domain:'analysis',ref:analysis.result.ref,role:'derived_from',critical:true}],
    sourceGroups:[],artifactRef:null,createdAt:timestamp,analysisQuality:null,
    content:{ref:pageRef,projectId:e.projectId,title:'已审研究页',question:'已审证据是什么？',claimRefs:[],patternRefs:[],relatedRefs:[],
      disputes:[],nextQuestions:[],citations:[mediaCitation(analysis.anchor)]}};
  const metadata={total:2,covered:1,pending:1,recentPages:[{ref:pageRef,title:page.title}],omittedPages:0};
  const navigation=(navigationRef=ref()):KnowledgeRevision=>({kind:'wiki',ref:navigationRef,projectId:e.projectId,
    title:'研究页导航',body:renderNavigationWiki(metadata),scope:navigationWikiScope(),dependencies:[{domain:'knowledge',ref:pageRef,role:'uses',critical:true}],
    sourceGroups:[],artifactRef:null,createdAt:timestamp,analysisQuality:null,
    content:{ref:navigationRef,projectId:e.projectId,title:'研究页导航',question:'从哪里阅读？',navigationOnly:true,navigation:metadata,
      claimRefs:[],patternRefs:[],relatedRefs:[pageRef],disputes:[],nextQuestions:[],citations:[]}});
  const good=navigation();
  const generic=proposal(e.projectId,[page,good]);generic.purpose='exploration_reading';
  await assert.rejects(e.knowledge.propose(generic),/internal topic navigation builder/i);
  assert.equal(await e.store.head(e.projectId,good.ref.objectId),null);
  const badBody={...good,body:'本产品的效果已被证明。'};
  const badInput=proposal(e.projectId,[page,badBody]);badInput.purpose='exploration_reading';
  await assert.rejects(e.knowledge.proposeTopicNavigation(badInput),/deterministic renderer/i);
  const wrongPurpose=proposal(e.projectId,[page,good]);
  await assert.rejects(e.knowledge.proposeTopicNavigation(wrongPurpose),/exploration_reading purpose/i);
  const valid=proposal(e.projectId,[page,good]);valid.purpose='exploration_reading';
  const staged=await e.knowledge.proposeTopicNavigation(valid);
  const stagedNavigation=staged.changes.find(change=>change.revision.ref.objectId===good.ref.objectId)!.revision;
  assert.deepEqual(stagedNavigation.sourceGroups,[],'Navigation must not inherit the page media source group');
  e.setDecision('exploration_only');
  await e.knowledge.reviewChangeSet({projectId:e.projectId,changeSetId:staged.id,contentHash:staged.contentHash,purpose:staged.purpose});
  await e.knowledge.publishRevision(e.projectId,staged.id,staged.contentHash);
  assert.equal((await e.store.get(e.projectId,pageRef))?.published,true);
  assert.equal((await e.store.get(e.projectId,good.ref))?.published,true);
  const second=navigation();
  const approvedInput=proposal(e.projectId,[second]);approvedInput.purpose='exploration_reading';
  const approved=await e.knowledge.proposeTopicNavigation(approvedInput);
  e.setDecision('approved_for_purpose');
  await assert.rejects(e.knowledge.reviewChangeSet({projectId:e.projectId,changeSetId:approved.id,
    contentHash:approved.contentHash,purpose:approved.purpose}),/cannot be approved/i);
  await e.store.recordReview({id:randomUUID(),projectId:e.projectId,changeSetId:approved.id,contentHash:approved.contentHash,
    purpose:approved.purpose,reviewer:'independent-reviewer',policyVersion:'test',decision:'approved_for_purpose',
    rationale:'Synthetic direct review for bypass regression',createdAt:timestamp});
  await assert.rejects(e.knowledge.preparePublication(e.projectId,approved.id,approved.contentHash),/cannot be approved/i);
  const client=await e.pool.connect();
  try {
    await assert.rejects(e.knowledge.publishPrepared({projectId:e.projectId,changeSetId:approved.id,
      contentHash:approved.contentHash,knowledgeEpoch:await e.store.epoch(e.projectId)},client),/cannot be approved/i);
  } finally {client.release();}
  assert.equal((await e.store.get(e.projectId,second.ref))?.published,false);
}));

dbTest('exact analysis result, snapshot and registered citation are required; analysis success alone is not adoption', {timeout:60_000}, async()=>withKnowledge(async e=>{
  const a=e.analysis.add(e.projectId,{quality:{candidate:'unreviewed',review:'not_run'},adoptPurpose:null});
  const c=caseRevision(e.projectId,e.product,a.result,a.anchor);
  const wrongResult=caseRevision(e.projectId,e.product,{...a.result,ref:ref()},a.anchor);
  await assert.rejects(e.knowledge.propose(proposal(e.projectId,[wrongResult])),/analysis result|registered/i);
  const oldSnapshot=e.analysis.snapshots.get(a.snapshot.ref.versionId)!;
  e.analysis.snapshots.set(a.snapshot.ref.versionId,{...oldSnapshot,assetVersionId:randomUUID()});
  await assert.rejects(e.knowledge.propose(proposal(e.projectId,[c])),/context|snapshot|identity/i);
  e.analysis.snapshots.set(a.snapshot.ref.versionId,oldSnapshot);
  const wrongAnchor=caseRevision(e.projectId,e.product,a.result,{...a.anchor,sourceRef:ref()});
  await assert.rejects(e.knowledge.propose(proposal(e.projectId,[wrongAnchor])),/citation|registered/i);
  const staged=await e.knowledge.propose(proposal(e.projectId,[c]));
  assert.equal((await e.knowledge.get(e.projectId,c.ref))?.published,false);
  await assert.rejects(e.knowledge.reviewChangeSet({projectId:e.projectId,changeSetId:staged.id,contentHash:staged.contentHash,purpose:staged.purpose}),/adoption|adopted/i);
  await assert.rejects(e.packs.buildReferencePack({projectId:e.projectId,requestKey:randomUUID(),task:task(e.product),sourceRefs:[]}),/adopted applicable|usable references/i);
  e.analysis.decide(e.projectId,a.result.ref,'creative_reference','approved');
  e.setDecision('exploration_only');
  await e.knowledge.reviewChangeSet({projectId:e.projectId,changeSetId:staged.id,contentHash:staged.contentHash,purpose:staged.purpose});
  await e.knowledge.publishRevision(e.projectId,staged.id,staged.contentHash);
  await assert.rejects(e.packs.buildReferencePack({projectId:e.projectId,requestKey:randomUUID(),task:task(e.product),sourceRefs:[]}),/adopted applicable|usable references/i);
}));

dbTest('revised but unverified analysis remains exploration only after independent purpose review', {timeout:60_000}, async()=>withKnowledge(async e=>{
  const a=e.analysis.add(e.projectId,{quality:{candidate:'revised_unverified',review:'completed_with_findings'}});
  const c=caseRevision(e.projectId,e.product,a.result,a.anchor,'revised hook candidate');
  const change=await e.knowledge.propose(proposal(e.projectId,[c]));
  assert.equal(change.changes[0].revision.analysisQuality?.candidate,'revised_unverified');
  e.setDecision('exploration_only');
  const review=await e.knowledge.reviewChangeSet({projectId:e.projectId,changeSetId:change.id,contentHash:change.contentHash,purpose:change.purpose});
  assert.equal(review.decision,'exploration_only');
  await e.knowledge.publishRevision(e.projectId,change.id,change.contentHash);
  const frozen=await e.knowledge.get(e.projectId,c.ref);
  assert.equal(frozen?.review?.decision,'exploration_only');
  await assert.rejects(e.packs.buildReferencePack({projectId:e.projectId,requestKey:randomUUID(),task:task(e.product),sourceRefs:[]}),/adopted applicable|usable references/i);
}));

dbTest('a conditional pattern can cite an exact report anchor beyond its Case summary without counting another source', {timeout:60_000}, async()=>withKnowledge(async e=>{
  const a=e.analysis.add(e.projectId),secondAnchor={...a.anchor,sourceRef:ref()};
  a.result.evidence.push(secondAnchor);
  const parent=caseRevision(e.projectId,e.product,a.result,a.anchor,'Bounded summary uses only its first anchor');
  e.setDecision('exploration_only');await e.publish([parent]);
  const patternRef=ref();
  const pattern:KnowledgeRevision={kind:'pattern',ref:patternRef,projectId:e.projectId,title:'Conditional single-source hypothesis',body:'Second registered observation; candidate only',scope:scope(e.product),dependencies:[],sourceGroups:[],artifactRef:null,createdAt:timestamp,analysisQuality:null,
    content:{ref:patternRef,projectId:e.projectId,title:'Conditional single-source hypothesis',problem:'Uncertain step',mechanism:'Untested',sequence:['Observe second anchor'],requiredElements:['Untested requirement'],variableSlots:[],applicability:['Exploration'],exclusions:['Unknown outcomes'],supportRefs:[parent.ref],counterexampleRefs:[],prediction:'Needs a test',evidenceLevel:'single_case',citations:[mediaCitation(secondAnchor)]}};
  await assert.rejects(e.knowledge.propose(proposal(e.projectId,[pattern])),/citation|registered/i);
  pattern.dependencies=[{domain:'analysis',ref:a.result.ref,role:'derived_from',critical:true}];
  const staged=await e.knowledge.propose(proposal(e.projectId,[pattern]));
  const normalized=staged.changes[0].revision;
  assert.equal(normalized.sourceGroups.length,1);
  assert.ok(normalized.dependencies.some(dep=>dep.domain==='analysis'&&dep.ref.versionId===a.result.ref.versionId));
  assert.ok(normalized.dependencies.some(dep=>dep.domain==='knowledge'&&dep.ref.versionId===parent.ref.versionId));
  assert.equal(normalized.kind==='pattern'&&normalized.content.evidenceLevel,'single_case');
}));

dbTest('approved pattern cannot launder an exploration-only supporting case into production use', {timeout:60_000}, async()=>withKnowledge(async e=>{
  const a=e.analysis.add(e.projectId);const caseOnly=caseRevision(e.projectId,e.product,a.result,a.anchor,'hook exploration');
  e.setDecision('exploration_only');await e.publish([caseOnly]);
  assert.equal((await e.knowledge.get(e.projectId,caseOnly.ref))?.review?.decision,'exploration_only');
  const patternRef=ref();
  const pattern:KnowledgeRevision={kind:'pattern',ref:patternRef,projectId:e.projectId,title:'hook derived pattern',body:'hook derived pattern',scope:scope(e.product),dependencies:[],sourceGroups:[],artifactRef:null,createdAt:timestamp,analysisQuality:null,
    content:{ref:patternRef,projectId:e.projectId,title:'hook derived pattern',problem:'weak opening',mechanism:'show the item',sequence:['show item'],requiredElements:['item'],variableSlots:[],applicability:['US'],exclusions:[],supportRefs:[caseOnly.ref],counterexampleRefs:[],prediction:'recognition',evidenceLevel:'single_case',citations:[mediaCitation(a.anchor)]}};
  const staged=await e.knowledge.propose(proposal(e.projectId,[pattern]));
  e.setDecision('approved_for_purpose');
  await assert.rejects(e.knowledge.reviewChangeSet({projectId:e.projectId,changeSetId:staged.id,contentHash:staged.contentHash,purpose:staged.purpose}),/adopt|approval|exploration|purpose/i);
  assert.equal((await e.knowledge.get(e.projectId,patternRef))?.published,false);
  e.setDecision('exploration_only');
  await assert.rejects(e.knowledge.reviewChangeSet({projectId:e.projectId,changeSetId:staged.id,contentHash:staged.contentHash,purpose:staged.purpose}),/adopt|purpose/i);
  assert.equal((await e.knowledge.get(e.projectId,patternRef))?.published,false);
}));

dbTest('challenge collection outside keyword results preserves its counterexample', {timeout:60_000}, async()=>withKnowledge(async e=>{
  const a=e.analysis.add(e.projectId,{hash:sha('3')});const b=e.analysis.add(e.projectId,{hash:sha('4')});
  const support=caseRevision(e.projectId,e.product,a.result,a.anchor,'hook opening');
  const challenge=caseRevision(e.projectId,e.product,b.result,b.anchor,'quiet caution');
  await e.publish([support,challenge]);
  const collectionRef=ref();
  const collection:KnowledgeRevision={kind:'collection',ref:collectionRef,projectId:e.projectId,title:'alternative set',body:'alternative set',scope:scope(e.product),dependencies:[],sourceGroups:[],artifactRef:null,createdAt:timestamp,analysisQuality:null,
    content:{ref:collectionRef,projectId:e.projectId,title:'alternative set',question:'Which alternatives are relevant?',members:[{ref:support.ref,role:'support',reason:'opening'},{ref:challenge.ref,role:'counterexample',reason:'caution'}],exclusions:[],samplingFrame:'two registered clips',window:null}};
  await e.publish([collection]);
  const queried:string[]=[];
  const observingStore:KnowledgeStore={...e.store,search:(project,options)=>{queried.push(options.query??'');return e.store.search(project,options);}};
  const packs=createReferencePackService({store:observingStore,knowledge:e.knowledge,now:()=>new Date(timestamp)});
  const pack=await packs.buildReferencePack({projectId:e.projectId,requestKey:randomUUID(),task:task(e.product,{query:'hook'}),sourceRefs:[]});
  assert.ok(queried.includes('hook'));
  assert.ok(queried.includes(''));
  assert.ok(pack.pack.selectedCases.some(x=>x.ref.versionId===support.ref.versionId));
  assert.ok(pack.pack.counterexamples.some(x=>x.ref.versionId===challenge.ref.versionId));
  assert.equal(pack.pack.unknowns.some(x=>x.includes('没有可用的相关反例')),false);
}));

dbTest('exact exploration candidates bypass the corpus scan but still load a mandatory counterexample', {timeout:60_000}, async()=>withKnowledge(async e=>{
  const a=e.analysis.add(e.projectId,{hash:sha('5'),adoptPurpose:'exploration_reading'});
  const b=e.analysis.add(e.projectId,{hash:sha('6'),adoptPurpose:'exploration_reading'});
  const support=caseRevision(e.projectId,e.product,a.result,a.anchor,'hook source');
  const challenge=caseRevision(e.projectId,e.product,b.result,b.anchor,'quiet challenge');
  const publishExploration=async(revisions:KnowledgeRevision[])=>{
    const input=proposal(e.projectId,revisions);input.purpose='exploration_reading';
    const change=await e.knowledge.propose(input);
    await e.knowledge.reviewChangeSet({projectId:e.projectId,changeSetId:change.id,contentHash:change.contentHash,purpose:change.purpose});
    await e.knowledge.publishRevision(e.projectId,change.id,change.contentHash);
  };
  await publishExploration([support,challenge]);
  const collectionRef=ref();
  const collection:KnowledgeRevision={kind:'collection',ref:collectionRef,projectId:e.projectId,title:'hook alternatives',body:'challenge relation',scope:scope(e.product),dependencies:[],sourceGroups:[],artifactRef:null,createdAt:timestamp,analysisQuality:null,
    content:{ref:collectionRef,projectId:e.projectId,title:'hook alternatives',question:'Which opening is supported?',
      members:[{ref:support.ref,role:'support',reason:'source'},{ref:challenge.ref,role:'counterexample',reason:'challenge'}],
      exclusions:[],samplingFrame:'two exact source clips',window:null}};
  await publishExploration([collection]);
  const fact=e.sources.add(e.projectId,'product_fact','exact product fact',e.product);
  const searched:string[]=[];
  const observingStore:KnowledgeStore={...e.store,search:(project,options)=>{
    searched.push(options.kinds?.join(',')??'');return e.store.search(project,options);
  }};
  const packs=createReferencePackService({store:observingStore,knowledge:e.knowledge,now:()=>new Date(timestamp)});
  const pack=await packs.buildReferencePack({projectId:e.projectId,requestKey:randomUUID(),
    task:task(e.product,{purpose:'exploration_reading'}),sourceRefs:[fact.ref],includeExploration:true,
    includeResearchWiki:true,candidateRefs:[support.ref]});
  assert.deepEqual(pack.pack.selectedCases.map(item=>item.ref),[support.ref]);
  assert.deepEqual(pack.pack.counterexamples.map(item=>item.ref),[challenge.ref]);
  assert.deepEqual(pack.pack.productFacts.map(item=>item.statement),[fact.statement]);
  assert.ok(searched.includes('pattern,collection'));
  assert.ok(!searched.includes('case,pattern'));
  assert.match(pack.pack.omissions.join(' '),/未检索全历史知识库/);
}));

dbTest('task filters and product facts reject unrelated source and SKU; protected context enforces budget', {timeout:60_000}, async()=>withKnowledge(async e=>{
  const valid=e.analysis.add(e.projectId,{hash:sha('a')});
  const base=caseRevision(e.projectId,e.product,valid.result,valid.anchor,'hook matching');
  // Use each registered anchor, then vary exactly one applicability dimension per case.
  const filtered:KnowledgeRevision[]=[];
  for(const [key,value] of [['markets',['DE']],['languages',['de']],['goals',['conversion']],['requiredProduction',['studio']],['productVersionRefs',[ref()]]] as const) {
    const a=e.analysis.add(e.projectId);const c=caseRevision(e.projectId,e.product,a.result,a.anchor,`hook filtered ${key}`);
    c.scope=scope(e.product,{[key]:value});filtered.push(c);
  }
  await e.publish([base,...filtered]);
  const otherPurposeAnalysis=e.analysis.add(e.projectId,{hash:sha('9'),adoptPurpose:'market_research'});
  const otherPurpose=caseRevision(e.projectId,e.product,otherPurposeAnalysis.result,otherPurposeAnalysis.anchor,'hook different purpose');
  const otherPurposeInput=proposal(e.projectId,[otherPurpose]);otherPurposeInput.purpose='market_research';
  const otherPurposeChange=await e.knowledge.propose(otherPurposeInput);
  await e.knowledge.reviewChangeSet({projectId:e.projectId,changeSetId:otherPurposeChange.id,contentHash:otherPurposeChange.contentHash,purpose:otherPurposeChange.purpose});
  await e.knowledge.publishRevision(e.projectId,otherPurposeChange.id,otherPurposeChange.contentHash);
  const own=e.sources.add(e.projectId,'product_fact','Perseek NAD+ ingredient statement',e.product);
  const other=e.sources.add(e.projectId,'product_fact','Other SKU fact',ref());
  const competitor=e.sources.add(e.projectId,'client_statement','Competitor media claim',null);
  await assert.rejects(e.knowledge.propose(proposal(e.projectId,[claimRevision(e.projectId,e.product,'Other SKU fact',sourceCitation(other.ref))])),/product source|same SKU/i);
  await assert.rejects(e.knowledge.propose(proposal(e.projectId,[claimRevision(e.projectId,e.product,'Competitor media claim',sourceCitation(competitor.ref))])),/product source|product fact/i);
  await assert.rejects(e.packs.buildReferencePack({projectId:e.projectId,requestKey:randomUUID(),task:task(e.product),sourceRefs:[other.ref]}),/product.*version|SKU/i);
  const exact=await e.packs.buildReferencePack({projectId:e.projectId,requestKey:randomUUID(),task:task(e.product),sourceRefs:[own.ref,competitor.ref]});
  assert.deepEqual(exact.pack.selectedCases.map(x=>x.ref),[base.ref]);
  assert.deepEqual(exact.pack.productFacts.map(x=>x.statement),[own.statement]);
  assert.match(exact.pack.unknowns.join(' '),/client_statement/);
  assert.ok(filtered.every(c=>exact.decisions.some(d=>d.ref.versionId===c.ref.versionId&&!d.selected)));
  assert.ok(exact.decisions.some(d=>d.ref.versionId===otherPurpose.ref.versionId&&!d.selected));
  await assert.rejects(e.packs.buildReferencePack({projectId:e.projectId,requestKey:randomUUID(),task:task(e.product,{tokenBudget:1}),sourceRefs:[own.ref]}),/budget|overflow|references/i);
}));

dbTest('same raw SHA across profiles and providers remains one support group; D3 revisions preserve old history and alter next pack', {timeout:60_000}, async()=>withKnowledge(async e=>{
  const shared=sha('e');
  const a=e.analysis.add(e.projectId,{hash:shared,profile:'overview',providerCount:3});
  const b=e.analysis.add(e.projectId,{hash:shared,profile:'fine',providerCount:3});
  const one=caseRevision(e.projectId,e.product,a.result,a.anchor,'hook first');
  const two=caseRevision(e.projectId,e.product,b.result,b.anchor,'unrelated caution');
  await e.publish([one,two]);
  const patternRef=ref();
  const pattern:KnowledgeRevision={kind:'pattern',ref:patternRef,projectId:e.projectId,title:'hook pattern',body:'hook pattern',scope:scope(e.product,{markets:['US','CA']}),dependencies:[],sourceGroups:[],artifactRef:null,createdAt:timestamp,analysisQuality:null,
    content:{ref:patternRef,projectId:e.projectId,title:'hook pattern',problem:'weak opening',mechanism:'show the product',sequence:['show product'],requiredElements:['product'],variableSlots:[],applicability:['US'],exclusions:[],supportRefs:[one.ref,two.ref],counterexampleRefs:[],prediction:'better comprehension',evidenceLevel:'repeated_observation',citations:[mediaCitation(a.anchor)]}};
  await assert.rejects(e.knowledge.propose(proposal(e.projectId,[pattern])),/independent|repeated|evidence level/i);
  pattern.content.evidenceLevel='single_case';
  const collectionRef=ref();
  const collection:KnowledgeRevision={kind:'collection',ref:collectionRef,projectId:e.projectId,title:'hook collection',body:'hook collection',scope:scope(e.product),dependencies:[],sourceGroups:[],artifactRef:null,createdAt:timestamp,analysisQuality:null,
    content:{ref:collectionRef,projectId:e.projectId,title:'hook collection',question:'How is the hook framed?',members:[{ref:one.ref,role:'support',reason:'opening'},{ref:two.ref,role:'counterexample',reason:'alternative'}],exclusions:[],samplingFrame:'two exact analyzed assets',window:null}};
  const comparisonRef=ref();
  const comparison:KnowledgeRevision={kind:'comparison',ref:comparisonRef,projectId:e.projectId,title:'hook comparison',body:'hook comparison',scope:scope(e.product),dependencies:[],sourceGroups:[],artifactRef:null,createdAt:timestamp,analysisQuality:null,
    content:{ref:comparisonRef,projectId:e.projectId,title:'hook comparison',collectionRef,dimensions:[{name:'opening',observations:[{memberRef:one.ref,observation:'product visible',citations:[mediaCitation(a.anchor)]}]}],incomparable:[],unresolved:[]}};
  const wikiRef=ref();
  const wiki:KnowledgeRevision={kind:'wiki',ref:wikiRef,projectId:e.projectId,title:'hook wiki',body:'hook wiki',scope:scope(e.product),dependencies:[],sourceGroups:[],artifactRef:null,createdAt:timestamp,analysisQuality:null,
    content:{ref:wikiRef,projectId:e.projectId,title:'hook wiki',question:'What can be reused?',claimRefs:[],patternRefs:[patternRef],relatedRefs:[comparisonRef],disputes:[],nextQuestions:['test on own product'],citations:[mediaCitation(a.anchor)]}};
  await e.publish([collection,comparison,pattern,wiki]);
  const queried:string[]=[];
  const observingStore:KnowledgeStore={...e.store,search:(project,options)=>{queried.push(options.query??'');return e.store.search(project,options);}};
  const packs=createReferencePackService({store:observingStore,knowledge:e.knowledge,now:()=>new Date(timestamp)});
  const oldPack=await packs.buildReferencePack({projectId:e.projectId,requestKey:randomUUID(),task:task(e.product),sourceRefs:[]});
  assert.ok(queried.includes('hook'));
  assert.ok(queried.includes(''));
  assert.ok(oldPack.pack.counterexamples.some(x=>x.ref.versionId===two.ref.versionId));
  assert.equal(oldPack.pack.selectedCases.some(x=>x.ref.versionId===two.ref.versionId),false);
  assert.equal((await e.knowledge.get(e.projectId,patternRef))?.revision.sourceGroups.length,1);
  const narrowedRef={objectId:patternRef.objectId,versionId:randomUUID()};
  const narrowed:KnowledgeRevision=structuredClone(pattern);
  narrowed.ref=narrowedRef;narrowed.content.ref=narrowedRef;
  narrowed.scope=scope(e.product,{markets:['CA']});
  const c=e.analysis.add(e.projectId,{hash:sha('f')});
  const newCounterexample=caseRevision(e.projectId,e.product,c.result,c.anchor,'new counterexample');
  await e.publish([newCounterexample]);
  narrowed.content.counterexampleRefs.push(newCounterexample.ref);
  await e.publish([narrowed],'narrow',{[patternRef.objectId]:patternRef.versionId});
  const widened:KnowledgeRevision=structuredClone(narrowed);
  widened.ref={objectId:patternRef.objectId,versionId:randomUUID()};widened.content.ref=widened.ref;
  widened.scope=scope(e.product,{markets:['US','CA']});
  const widerEvidence=e.analysis.add(e.projectId,{hash:sha('2')});
  const widerCase=caseRevision(e.projectId,e.product,widerEvidence.result,widerEvidence.anchor,'widening evidence');
  await e.publish([widerCase]);widened.content.counterexampleRefs.push(widerCase.ref);
  await assert.rejects(e.knowledge.propose(proposal(e.projectId,[widened],'narrow',{[patternRef.objectId]:narrowedRef.versionId})),/narrow|scope|applicab/i);
  assert.equal((await e.knowledge.history(e.projectId,patternRef.objectId)).length,2);
  assert.equal((await e.knowledge.get(e.projectId,patternRef))?.published,true);
  const nextPack=await e.packs.buildReferencePack({projectId:e.projectId,requestKey:randomUUID(),task:task(e.product),sourceRefs:[]});
  assert.equal(nextPack.pack.selectedPatterns.some(x=>x.ref.versionId===patternRef.versionId),false);
  assert.equal(nextPack.pack.selectedPatterns.some(x=>x.ref.versionId===narrowedRef.versionId),false);
  const disputed:KnowledgeRevision=structuredClone(narrowed);
  disputed.ref={objectId:patternRef.objectId,versionId:randomUUID()};disputed.content.ref=disputed.ref;
  const d=e.analysis.add(e.projectId,{hash:sha('1')});
  const disputeEvidence=caseRevision(e.projectId,e.product,d.result,d.anchor,'dispute evidence');
  await e.publish([disputeEvidence]);
  disputed.content.counterexampleRefs.push(disputeEvidence.ref);
  e.setDecision('exploration_only');
  await e.publish([disputed],'dispute',{[patternRef.objectId]:narrowedRef.versionId});
  assert.equal((await e.knowledge.get(e.projectId,disputed.ref))?.review?.decision,'exploration_only');
  const withdrawn:KnowledgeRevision=structuredClone(disputed);
  withdrawn.ref={objectId:patternRef.objectId,versionId:randomUUID()};withdrawn.content.ref=withdrawn.ref;
  await e.publish([withdrawn],'withdraw',{[patternRef.objectId]:disputed.ref.versionId});
  assert.equal((await e.knowledge.history(e.projectId,patternRef.objectId)).length,4);
  assert.equal((await e.knowledge.get(e.projectId,patternRef))?.published,true);
  assert.equal((await e.knowledge.get(e.projectId,withdrawn.ref))?.validity.valid,false);
}));
