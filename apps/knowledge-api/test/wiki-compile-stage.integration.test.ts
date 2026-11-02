import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {seedKnowledgeSyntheticFixture} from '../../../scripts/runtime/knowledge-synthetic-fixture.ts';
import {createKnowledgeStore} from '../../../packages/knowledge/src/store.ts';
import {digest} from '../../../packages/knowledge/src/utils.ts';
import {getWikiPageProfile,wikiPageProfileFingerprint} from '../../../packages/knowledge/src/wiki-page.ts';
import {createPgSourceRegistry} from '../../../packages/adapters/knowledge-service/src/sources.ts';
import {createPgWikiCompileStage} from '../../../packages/adapters/knowledge-service/src/wiki-compile-stage.ts';
import type {AskEvidence} from '../../../packages/knowledge-application/src/ask.ts';
import type {WikiCompileStageInput} from '../../../packages/knowledge-application/src/wiki-compile.ts';

const databaseUrl=readTestDatabase(),dbTest=databaseUrl?test:test.skip;
const code=(expected:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&error.code===expected;

dbTest('Wiki compile stage freezes local new/update candidates and rejects unsafe lineage',{timeout:90_000},async()=>{
  const admin=new pg.Pool({connectionString:databaseUrl!,max:2}),schema=`wiki_stage_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString:databaseUrl!,max:8,options:`-c search_path=${schema}`});
  try{
    const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-${randomUUID()}`,'wiki-stage-test');
    const context={scope:{projectId:seed.projectId,spaceId:seed.spaceId},principal:seed.principal,purpose:'exploration_reading'};
    const store=createKnowledgeStore(pool,{writerGrant:seed.writerGrant});
    const registry=createPgSourceRegistry(pool,{writerGrant:seed.writerGrant,readerIds:[seed.principal.id]});
    const target=(await store.get(seed.projectId,seed.root))!.revision;
    if(target.kind!=='wiki_page')throw new Error('Fixture target must be a Wiki page');
    const metadata=await store.inspectFrozen!(seed.projectId,seed.root);
    assert.ok(metadata);
    const page:AskEvidence={id:'page-1',kind:'wiki_page',ref:{...context.scope,domain:'knowledge',...target.ref,contentDigest:digest(target)},
      title:target.title,body:target.body,locator:null,conditions:target.content.conditions,
      counterexamples:target.content.counterexamples,unknowns:target.content.unknowns,actualReadCoverage:[],
      storageDigest:metadata.storageDigest,sourceGroups:target.sourceGroups.map(id=>({id,status:'known',authority:'knowledge-revision-lineage'})),
      wiki:{profile:{id:target.content.profile.id,version:target.content.profile.version,
        digest:wikiPageProfileFingerprint(getWikiPageProfile(target.content.profile.id,target.content.profile.version)!)},
        identity:target.content.identity}};
    const profile=getWikiPageProfile('question','1')!;
    const makeInput=(identityKey:string,targetEvidenceId:string|null=null):WikiCompileStageInput=>({
      operationId:randomUUID(),createdAt:new Date().toISOString(),methodVersion:'test-wiki-compiler-v1',
      request:{question:'合成编纂问题',purpose:context.purpose,sourceEventIds:[randomUUID()],queries:['商品'],limit:5,maxPages:1,
        budget:{maxModelCalls:1,maxReadBytes:100000,deadline:new Date(Date.now()+60000).toISOString(),maxMoney:null}},
      proposal:{outcome:'proposed',reason:'合成编纂待独立审阅',gaps:[],drafts:[{targetEvidenceId,
        profile:targetEvidenceId?page.wiki!.profile:{id:'question',version:'1',digest:wikiPageProfileFingerprint(profile)},
        identityKey,title:'合成候选',summary:'仅依据本次有界读取的合成页提出候选。',conditions:['限合成资料'],
        counterexamples:['没有真实商业验证'],unknowns:['需要独立审阅'],nextQuestions:['如何补证？'],
        supportEvidenceIds:['page-1'],rationale:'旧页提供准确范围的谱系，不代表独立票数'}]},
      evidence:[page],bases:new Map([['page-1',target]]),sourceProofs:[],
      cost:{modelCalls:{state:'known',value:1},tokens:{state:'unknown',reason:'Provider did not report tokens'},
        money:{state:'unknown',reason:'Provider billing is pending'}}});
    const withoutRegistry=createPgWikiCompileStage(pool,seed.writerGrant);
    await assert.rejects(withoutRegistry.stage(context,makeInput('新合成页')),
      code('COMPILATION_SOURCE_ASSURANCE_REQUIRED'));
    const stage=createPgWikiCompileStage(pool,seed.writerGrant,registry);
    const newInput=makeInput('新合成页');
    const receipt=await stage.stage(context,newInput);
    assert.equal(receipt.published,false);
    assert.equal(receipt.candidateId,newInput.operationId);
    const change=await store.getChangeSet(seed.projectId,receipt.changeSetId);
    assert.ok(change);
    assert.equal(change.methodVersion,'test-wiki-compiler-v1');
    assert.equal(change.cost.state,'unknown');
    assert.equal(change.changes[0].effect,'create');
    assert.deepEqual(change.changes[0].revision.sourceGroups,['synthetic:shared-notes']);
    assert.equal((await store.head(seed.projectId,change.changes[0].revision.ref.objectId)),null,'stage cannot publish');
    assert.deepEqual(await stage.stage(context,newInput),receipt,'same operation replays one candidate');
    const requestHash=change.requestHash;
    assert.deepEqual(await stage.lookup!(context,newInput.operationId,requestHash),receipt,'lookup reads the exact staged candidate');
    assert.equal(await stage.lookup!(context,randomUUID(),requestHash),null,'lookup never stages a missing operation');
    await assert.rejects(stage.lookup!(context,newInput.operationId,'0'.repeat(64)),code('COMPILE_STAGE_LOOKUP_MISMATCH'));
    await assert.rejects(stage.lookup!({...context,principal:{...context.principal,id:'other-principal'}},newInput.operationId,requestHash),
      code('COMPILE_STAGE_LOOKUP_MISMATCH'));
    await assert.rejects(stage.lookup!({...context,purpose:'other-purpose',principal:{...context.principal,purposes:[...context.principal.purposes,'other-purpose']}},newInput.operationId,requestHash),
      code('COMPILE_STAGE_LOOKUP_MISMATCH'));
    const unavailableLookup={query:async()=>{throw new Error('Simulated lookup connection loss');}} as unknown as pg.Pool;
    await assert.rejects(createPgWikiCompileStage(unavailableLookup,seed.writerGrant).lookup!(context,newInput.operationId,requestHash),
      (error:unknown)=>!!error&&typeof error==='object'&&'commitStatus'in error&&error.commitStatus==='unknown');
    const loseStageCommit=(mode:'before'|'after')=>{
      let lost=false;
      return {query:pool.query.bind(pool),connect:async()=>{
        const client=await pool.connect();let staged=false;
        return new Proxy(client,{get(target,property){
          if(property==='release')return target.release.bind(target);
          if(property!=='query')return Reflect.get(target,property);
          return async(...args:unknown[])=>{
            const sql=typeof args[0]==='string'?args[0]:'';
            if(sql.includes('INSERT INTO ccl_knowledge_changesets'))staged=true;
            if(sql==='COMMIT'&&staged&&!lost&&mode==='before'){
              lost=true;throw new Error('Simulated lost stage commit acknowledgement');
            }
            const result=await Reflect.apply(target.query,target,args);
            if(sql==='COMMIT'&&staged&&!lost&&mode==='after'){
              lost=true;throw new Error('Simulated lost stage commit acknowledgement');
            }
            return result;
          };
        }});
      }} as unknown as pg.Pool;
    };
    const acknowledged=makeInput('提交后回执丢失');
    const recovered=await createPgWikiCompileStage(loseStageCommit('after'),seed.writerGrant,registry).stage(context,acknowledged);
    assert.equal(recovered.candidateId,acknowledged.operationId,'exact committed change is recovered without a second stage');
    assert.equal((await pool.query('SELECT count(*)::int AS total FROM ccl_knowledge_changesets WHERE id=$1',[acknowledged.operationId])).rows[0].total,1);
    const unresolved=makeInput('提交前连接丢失');
    await assert.rejects(createPgWikiCompileStage(loseStageCommit('before'),seed.writerGrant,registry).stage(context,unresolved),
      (error:unknown)=>!!error&&typeof error==='object'&&'commitStatus'in error&&error.commitStatus==='unknown'&&
        'operationId'in error&&error.operationId===unresolved.operationId);
    assert.equal(await store.getChangeSet(seed.projectId,unresolved.operationId),null);
    const sourceContent=await registry.readContent(context.scope,seed.source.ref,null,context);
    const sourceRecord=await registry.readRecord(context.scope,seed.source.ref,context);
    assert.ok(sourceContent&&sourceRecord);
    const direct:AskEvidence={id:'source-1',kind:'source_content',ref:sourceContent.ref,title:'合成来源',
      body:sourceContent.content,locator:null,conditions:[],counterexamples:[],unknowns:[],
      actualReadCoverage:[sourceContent.actualCoverage],sourceGroups:sourceRecord.sourceGroups};
    const directInput=makeInput('直接来源候选');directInput.evidence=[direct];directInput.bases=new Map();
    directInput.sourceProofs=[await registry.proof(context,sourceContent.ref)];
    directInput.proposal.drafts[0].supportEvidenceIds=['source-1'];
    const directReceipt=await stage.stage(context,directInput);
    const directChange=await store.getChangeSet(seed.projectId,directReceipt.changeSetId);
    assert.ok(directChange);
    assert.ok(directChange.changes[0].revision.dependencies.some(dep=>dep.domain==='source'&&dep.ref.objectId===sourceContent.ref.objectId));
    assert.equal(directReceipt.published,false);
    const expired=makeInput('过期proof可刷新');expired.evidence=[direct];expired.bases=new Map();
    expired.proposal.drafts[0].supportEvidenceIds=['source-1'];
    expired.sourceProofs=[{...(await registry.proof(context,sourceContent.ref)),validUntil:new Date(Date.now()-1000).toISOString()}];
    await assert.rejects(withoutRegistry.stage(context,expired),code('COMPILATION_SOURCE_ASSURANCE_REQUIRED'));
    assert.equal((await stage.stage(context,expired)).published,false,'same-generation local proof can renew expiry');
    const changedGeneration=makeInput('proof代次变化');changedGeneration.evidence=[direct];changedGeneration.bases=new Map();
    changedGeneration.proposal.drafts[0].supportEvidenceIds=['source-1'];
    changedGeneration.sourceProofs=[{...(await registry.proof(context,sourceContent.ref)),ownerGeneration:'0'}];
    await assert.rejects(stage.stage(context,changedGeneration),code('COMPILATION_SOURCE_ASSURANCE_REQUIRED'));
    const update=makeInput(target.content.identity.key,'page-1');
    const updated=await stage.stage(context,update);
    const updateChange=await store.getChangeSet(seed.projectId,updated.changeSetId);
    assert.ok(updateChange);
    assert.equal(updateChange.changes[0].effect,'correct');
    assert.equal(updateChange.baseHeads[0].versionId,target.ref.versionId);
    const updatedRevision=updateChange.changes[0].revision;
    if(updatedRevision.kind!=='wiki_page')throw new Error('Staged revision must be a Wiki page');
    assert.ok(updatedRevision.content.citations.length>0,'old source citations remain');
    assert.ok(!updateChange.changes[0].revision.dependencies.some(dep=>dep.domain==='knowledge'&&dep.ref.objectId===target.ref.objectId),
      'an update never depends critically on its own old version');
    const unread=makeInput('未读支持');unread.proposal.drafts[0].supportEvidenceIds=['missing'];
    await assert.rejects(stage.stage(context,unread),code('COMPILE_SUPPORT_UNREAD'));
    const duplicate=makeInput(target.content.identity.key);duplicate.proposal.drafts[0].profile=page.wiki!.profile;
    await assert.rejects(stage.stage(context,duplicate),code('COMPILE_IDENTITY_CONFLICT'));
    const wrongIdentity=makeInput('另一身份','page-1');
    await assert.rejects(stage.stage(context,wrongIdentity),code('COMPILE_IDENTITY_CHANGED'));
    const badProof=makeInput('坏证明');badProof.sourceProofs=[{...(await registry.proof(context,seed.source.ref)),assurance:'read_time_only'}];
    await assert.rejects(stage.stage(context,badProof),code('COMPILATION_SOURCE_ASSURANCE_REQUIRED'));
    const external=makeInput('外部正文');external.evidence=[{...page,id:'external-1',kind:'source_content',ref:{...page.ref,domain:'analysis'}}];
    external.proposal.drafts[0].supportEvidenceIds=['external-1'];
    await assert.rejects(stage.stage(context,external),code('COMPILATION_SOURCE_ASSURANCE_REQUIRED'));
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
