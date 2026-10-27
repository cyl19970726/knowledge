import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { readTestDatabase } from '../../../scripts/runtime/test-database.mjs';
import { migrateKnowledge } from '../src/migrations.ts';
import { createKnowledgeStore } from '../src/store.ts';
import { createKnowledgeService } from '../src/service.ts';
import { KnowledgeRevisionSchema } from '../src/schemas.ts';
import {
  getWikiPageProfile, isWikiPageRevision, matchesWikiPageFrozenBinding, registerWikiPageProfile, WikiPageContentSchema,
  wikiPageInputFingerprint, wikiPageProfileFingerprint, wikiPageReadsetFingerprint,
  type WikiPageRevision,
} from '../src/wiki-page.ts';
import type { Dependency } from '../src/types.ts';
import { caseRevision, mediaCitation, ref, sourceCitation, SyntheticAnalysis, SyntheticSources, timestamp } from './service-fixtures.ts';

const connectionString=readTestDatabase();
const page=(projectId:string,dependencies:Dependency[]=[],citation=sourceCitation(ref()),pageRef=ref()):WikiPageRevision=>{
  const profile=getWikiPageProfile('concept','1')!;
  const revision:WikiPageRevision={kind:'wiki_page',ref:pageRef,projectId,title:'Attention hook',body:'A short opening that earns attention.',
    scope:{applicability:{productVersionRefs:[],platforms:['douyin'],markets:[],languages:['zh'],audiences:[],goals:[],requiredProduction:[],transferRationale:null},limitations:[],unknowns:[],reviewDueAt:null},
    content:{schemaVersion:'1.0',profile:{id:'concept',version:'1'},identity:{key:'attention-hook',aliases:['开头钩子']},
      summary:'An opening device that attracts attention.',conditions:[],counterexamples:[],unknowns:[],nextQuestions:[],
      citations:[citation],navigation:[]},
    binding:{bindingKind:'wiki_page',spaceId:'douyin-creative',specificationId:'douyin-knowledge',specificationVersion:'1',
      contentVersion:'wiki_page/1.0',methodVersion:'page-method-1',policyVersion:'page-review-1',
      inputFingerprint:'0'.repeat(64),readsetFingerprint:'0'.repeat(64),profileFingerprint:wikiPageProfileFingerprint(profile)},
    dependencies,sourceGroups:[],artifactRef:null,createdAt:timestamp,analysisQuality:null};
  revision.binding!.readsetFingerprint=wikiPageReadsetFingerprint(revision);
  revision.binding!.inputFingerprint=wikiPageInputFingerprint(revision);
  return revision;
};
const change=(projectId:string,revision:WikiPageRevision,base:string|null=null)=>({
  projectId,requestKey:randomUUID(),purpose:'research',proposer:'author',rationale:'Checked evidence and exact page versions',
  methodVersion:'page-method-1',cost:{state:'unknown' as const,reason:'No model billing reported'},
  baseHeads:[{objectId:revision.ref.objectId,versionId:base}],
  changes:[{revision,effect:base?'correct' as const:'create' as const,explanation:'Versioned page update'}],
});

test('page profiles are open, versioned, deterministic, and immutable per id/version',()=>{
  const spec=registerWikiPageProfile({id:'campaign_moment',version:'1',description:'A repeatable campaign phase.',
    identityGuidance:'Keep one phase per stable key.',evidenceGuidance:'Link exact observed examples.'});
  assert.equal(getWikiPageProfile('campaign_moment','1'),spec);
  assert.equal(wikiPageProfileFingerprint(spec),wikiPageProfileFingerprint({...spec}));
  assert.throws(()=>registerWikiPageProfile({...spec,description:'Changed meaning.'}),/already registered/);
});

test('page schema rejects unknown fields, unbound profiles, and page bindings on old kinds',()=>{
  const revision=page('page-test');
  assert.equal(isWikiPageRevision(revision),true);
  assert.equal(KnowledgeRevisionSchema.safeParse(revision).success,true);
  assert.equal(WikiPageContentSchema.safeParse({...revision.content,title:'duplicated title'}).success,false);
  assert.equal(KnowledgeRevisionSchema.safeParse({...revision,binding:{...revision.binding,legacySourceRef:ref()}}).success,false);
  assert.equal(KnowledgeRevisionSchema.safeParse({...revision,scope:{...revision.scope,goalTags:['perseek_diagnosis']}}).success,false);
  const analysis=new SyntheticAnalysis();const item=analysis.add('page-test');
  const old=caseRevision('page-test',ref(),item.result,item.anchor);
  assert.equal(KnowledgeRevisionSchema.safeParse({...old,binding:revision.binding}).success,false);
});

test('page publication preserves exact dependencies, source scope, and stable identity', {skip:!connectionString,timeout:60_000},async()=>{
  const admin=new pg.Pool({connectionString,max:2});
  const schema=`ccl_wiki_page_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,max:4,options:`-c search_path=${schema}`});
  try {
    await migrateKnowledge(pool);
    const projectId=`wiki-page-${randomUUID()}`,store=createKnowledgeStore(pool),sources=new SyntheticSources(),analysis=new SyntheticAnalysis();
    const registered=sources.add(projectId,'document_rule','An exact statement about an opening.');
    const service=createKnowledgeService({store,analysis,scopedUseDecisions:analysis.scopedUseStore,sources,now:()=>new Date(timestamp),
      reviewPolicy:{version:'page-review-1',async review(){return {reviewer:'independent-reviewer',decision:'approved_for_purpose' as const,rationale:'Exact basis and limits checked'};}}});
    const publish=async(revision:WikiPageRevision,base:string|null=null,purpose='research')=>{
      const staged=await service.propose({...change(projectId,revision,base),purpose});
      await service.reviewChangeSet({projectId,changeSetId:staged.id,contentHash:staged.contentHash,purpose});
      await service.publishRevision(projectId,staged.id,staged.contentHash);return staged;
    };
    const original=page(projectId,[],sourceCitation(registered.ref));
    await publish(original);
    const first=await service.get(projectId,original.ref);
    assert.equal(first?.published,true);
    assert.ok(first?.revision.dependencies.some(dep=>dep.domain==='source'&&dep.role==='uses'&&dep.critical&&
      dep.ref.versionId===registered.ref.versionId),'Citation is a critical exact read, not a support vote');
    assert.deepEqual(first?.revision.sourceGroups,[registered.sourceGroup]);
    assert.deepEqual((await service.search(projectId,{kinds:['wiki_page'],spaceId:'douyin-creative'})).map(x=>x.revision.ref),[original.ref]);
    assert.equal(wikiPageReadsetFingerprint(first!.revision as WikiPageRevision),original.binding.readsetFingerprint,
      'a published source page must verify against its frozen normalized dependency set');

    const media=analysis.add(projectId,{adoptPurpose:'research'});
    media.snapshot.sourceContext.providerObservations[0]!.platform='douyin';
    const mediaBasis:Dependency={domain:'analysis',ref:media.result.ref,role:'derived_from',critical:true,
      useScope:{anchor:media.anchor,channels:['visual'],mediaScope:{kind:'whole'}}};
    const mediaPage=page(projectId,[mediaBasis],mediaCitation(media.anchor));
    mediaPage.content.identity={key:'video-opening',aliases:[]};
    mediaPage.binding.readsetFingerprint=wikiPageReadsetFingerprint(mediaPage);
    mediaPage.binding.inputFingerprint=wikiPageInputFingerprint(mediaPage);
    await publish(mediaPage);
    const publishedMedia=await service.get(projectId,mediaPage.ref);
    assert.equal(publishedMedia?.published,true);
    assert.ok(publishedMedia?.revision.dependencies.some(dep=>dep.domain==='evidence'&&dep.role==='uses'&&dep.critical&&
      dep.ref.versionId===media.anchor.sourceRef.versionId));
    assert.equal(wikiPageReadsetFingerprint(publishedMedia!.revision as WikiPageRevision),mediaPage.binding.readsetFingerprint);
    assert.equal(wikiPageInputFingerprint(publishedMedia!.revision as WikiPageRevision),mediaPage.binding.inputFingerprint);
    assert.equal(matchesWikiPageFrozenBinding(publishedMedia!.revision),true);
    const missingEvidence=structuredClone(publishedMedia!.revision);
    missingEvidence.dependencies=missingEvidence.dependencies.filter(dep=>dep.domain!=='evidence');
    assert.equal(matchesWikiPageFrozenBinding(missingEvidence),false,
      'readback must detect a dropped derived evidence edge even if a helper can reconstruct it');
    assert.deepEqual(publishedMedia?.revision.sourceGroups,[`media-sha256:${media.snapshot.original.sha256}`]);

    // An exact report/source object is a legitimate coarse basis. It must not
    // force the compiler to invent media citations for unselected evidence.
    const bareBasis=(dependency:Dependency,key:string)=>{
      const revision=page(projectId,[dependency]);
      revision.content.identity={key,aliases:[]};revision.content.citations=[];
      revision.binding.readsetFingerprint=wikiPageReadsetFingerprint(revision);
      revision.binding.inputFingerprint=wikiPageInputFingerprint(revision);
      return revision;
    };
    const reportOnly=bareBasis({domain:'analysis',ref:media.result.ref,role:'supports',critical:true},'report-only');
    await publish(reportOnly,null,'exploration_reading');
    const reportView=await service.get(projectId,reportOnly.ref);
    assert.equal(reportView?.published,true);
    assert.deepEqual((reportView!.revision as WikiPageRevision).content.citations,[]);
    assert.deepEqual(reportView!.revision.dependencies,[{domain:'analysis',ref:media.result.ref,role:'supports',critical:true}]);
    assert.deepEqual(reportView!.revision.sourceGroups,[`media-sha256:${media.snapshot.original.sha256}`]);
    assert.equal(matchesWikiPageFrozenBinding(reportView!.revision),true);
    const unscopedProduction=await service.propose(change(projectId,bareBasis(
      {domain:'analysis',ref:media.result.ref,role:'supports',critical:true},'report-production-unscoped')));
    await assert.rejects(service.reviewChangeSet({projectId,changeSetId:unscopedProduction.id,
      contentHash:unscopedProduction.contentHash,purpose:'research'}),
      (error:unknown)=>error instanceof Error&&'code' in error&&error.code==='ANALYSIS_SCOPE_REQUIRED');
    const sourceOnly=bareBasis({domain:'source',ref:registered.ref,role:'supports',critical:true},'source-only');
    await publish(sourceOnly);
    assert.deepEqual((await service.get(projectId,sourceOnly.ref))?.revision.sourceGroups,[registered.sourceGroup]);
    for(const dependency of [
      {domain:'analysis' as const,ref:media.result.ref,role:'uses' as const,critical:false},
      {domain:'evidence' as const,ref:media.anchor.sourceRef,role:'uses' as const,critical:true},
    ])await assert.rejects(service.propose(change(projectId,bareBasis(dependency,`insufficient-${dependency.domain}`))),
      (error:unknown)=>error instanceof Error&&'code' in error&&error.code==='WIKI_PAGE_BASIS_REQUIRED');
    await assert.rejects(service.propose(change(projectId,bareBasis(
      {domain:'analysis',ref:ref(),role:'supports',critical:true},'missing-report'))),
      (error:unknown)=>error instanceof Error&&'code' in error&&error.code==='ANALYSIS_NOT_FOUND');

    const basis:Dependency={domain:'knowledge',ref:original.ref,role:'supports',critical:true};
    const synthesis=page(projectId,[basis]);
    synthesis.content.profile={id:'synthesis',version:'1'};
    synthesis.binding!.profileFingerprint=wikiPageProfileFingerprint(getWikiPageProfile('synthesis','1')!);
    synthesis.content.citations=[];synthesis.content.identity={key:'hook-synthesis',aliases:[]};
    synthesis.content.navigation=[{ref:original.ref,label:'Attention hook',reason:'Related exact concept page'}];
    synthesis.binding!.readsetFingerprint=wikiPageReadsetFingerprint(synthesis);
    synthesis.binding!.inputFingerprint=wikiPageInputFingerprint(synthesis);
    await publish(synthesis);
    const second=await service.get(projectId,synthesis.ref);
    assert.equal(second?.published,true);
    assert.ok(second?.revision.dependencies.some(x=>x.domain==='knowledge'&&x.role==='supports'&&x.critical&&x.ref.versionId===original.ref.versionId));
    assert.deepEqual(second?.revision.sourceGroups,[registered.sourceGroup]);
    assert.deepEqual((await service.dependents(projectId,{domain:'knowledge',ref:original.ref})).map(x=>x.versionId),[synthesis.ref.versionId]);

    const next=structuredClone(original);next.ref={objectId:original.ref.objectId,versionId:randomUUID()};
    next.content.identity.key='renamed-key';next.binding!.inputFingerprint=wikiPageInputFingerprint(next);
    await assert.rejects(service.propose(change(projectId,next,original.ref.versionId)),/identity key/i);
    next.content.identity.key=original.content.identity.key;next.content.summary='A revised and bounded opening concept.';
    next.body='A revised opening device, with explicit limits.';next.binding!.inputFingerprint=wikiPageInputFingerprint(next);
    await publish(next,original.ref.versionId);
    assert.deepEqual(await store.head(projectId,original.ref.objectId),next.ref);
    assert.equal((await service.history(projectId,original.ref.objectId)).length,2);
    const unknown=page(projectId,[],sourceCitation(registered.ref));unknown.content.profile={id:'missing_profile',version:'1'};
    unknown.binding!.inputFingerprint=wikiPageInputFingerprint(unknown);
    await assert.rejects(service.propose(change(projectId,unknown)),/not registered/i);
    const mismatch=page(projectId,[],sourceCitation(registered.ref));mismatch.binding!.inputFingerprint='0'.repeat(64);
    await assert.rejects(service.propose(change(projectId,mismatch)),/binding/i);
    const foreign=sources.add('another-project','document_rule','A foreign statement');
    const wrongScope=page(projectId,[],sourceCitation(foreign.ref));
    await assert.rejects(service.propose(change(projectId,wrongScope)),/different project|mismatch/i);
    const wrongPolicy=page(projectId,[],sourceCitation(registered.ref));wrongPolicy.binding!.policyVersion='different-review';
    const stagedPolicy=await service.propose(change(projectId,wrongPolicy));
    await assert.rejects(service.reviewChangeSet({projectId,changeSetId:stagedPolicy.id,contentHash:stagedPolicy.contentHash,purpose:'research'}),/review policy/i);
    const challenged=page(projectId,[{domain:'source',ref:registered.ref,role:'challenges',critical:true}],
      sourceCitation(registered.ref));
    challenged.content.identity={key:'challenged-hook',aliases:[]};
    challenged.binding.readsetFingerprint=wikiPageReadsetFingerprint(challenged);
    challenged.binding.inputFingerprint=wikiPageInputFingerprint(challenged);
    await publish(challenged);
    const challengeView=await service.get(projectId,challenged.ref);
    const sameSource=challengeView!.revision.dependencies.filter(dep=>dep.domain==='source'&&dep.ref.versionId===registered.ref.versionId);
    assert.deepEqual(sameSource.map(dep=>dep.role).sort(),['challenges','uses'],
      'Explicit challenge stance must not be contradicted by an implicit support edge');
    assert.ok(sameSource.every(dep=>dep.critical));
    const invalidated=await store.invalidate(projectId,{domain:'source',ref:registered.ref,
      reason:'Exact source retracted',state:'withdrawn',createdAt:new Date().toISOString()});
    assert.ok(invalidated.some(ref=>ref.versionId===challenged.ref.versionId),
      'Neutral citation dependency must still invalidate the derived page');
    assert.equal((await service.get(projectId,challenged.ref))?.validity.valid,false);
  } finally {await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
