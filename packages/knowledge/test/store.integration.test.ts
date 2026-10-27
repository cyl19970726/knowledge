import { readTestDatabase } from '../../../scripts/runtime/test-database.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { VersionRef } from '../../contracts/src/index.ts';
import { createKnowledgeStore } from '../src/store.ts';
import { migrateKnowledge } from '../src/migrations.ts';
import type { Dependency, KnowledgeChangeSet, KnowledgeReview, KnowledgeRevision, KnowledgeStore } from '../src/types.ts';

const connectionString = readTestDatabase();

const dbTest = connectionString ? test : test.skip;
const ref = (): VersionRef => ({objectId:randomUUID(),versionId:randomUUID()});
const now = () => new Date().toISOString();
const scope = () => ({applicability:{productVersionRefs:[],markets:[],languages:[],audiences:[],goals:[],requiredProduction:[],transferRationale:null},limitations:[],unknowns:[],goalTags:[],reviewDueAt:null});
const revision = (projectId:string, r=ref(), dependencies:Dependency[]=[]):KnowledgeRevision => ({
  kind:'pattern',ref:r,projectId,title:'Synthetic test pattern',body:'示例 multilingual text',scope:scope(),
  dependencies,sourceGroups:[],artifactRef:null,createdAt:now(),analysisQuality:null,
  content:{ref:r,projectId,title:'Synthetic test pattern',problem:'test',mechanism:'test',sequence:[],requiredElements:[],variableSlots:[],applicability:[],exclusions:[],supportRefs:[],counterexampleRefs:[],prediction:'test',evidenceLevel:'inconclusive',citations:[]},
});
const change = (projectId:string, rev:KnowledgeRevision, base:string|null=null, effect:'create'|'correct'|'withdraw'='create'):KnowledgeChangeSet => ({
  id:randomUUID(),projectId,requestKey:randomUUID(),requestHash:randomUUID().replaceAll('-','').padEnd(64,'0'),contentHash:randomUUID().replaceAll('-','').padEnd(64,'0'),purpose:'research',proposer:'proposer',rationale:'test',methodVersion:'test',cost:{state:'unknown',reason:'test'},
  baseHeads:[{objectId:rev.ref.objectId,versionId:base}],inputManifest:[],changes:[{revision:rev,effect,explanation:'test'}],createdAt:now(),
});
const review = (c:KnowledgeChangeSet, decision:KnowledgeReview['decision']='approved_for_purpose'):KnowledgeReview => ({
  id:randomUUID(),projectId:c.projectId,changeSetId:c.id,contentHash:c.contentHash,reviewer:'independent reviewer',policyVersion:'test',purpose:c.purpose,decision,rationale:'test',createdAt:now(),
});
async function adopt(store:KnowledgeStore,c:KnowledgeChangeSet) { await store.stage(c); await store.recordReview(review(c)); return store.publish(c.projectId,c.id,c.contentHash); }

dbTest('knowledge transactions, CAS, review gate, idempotency, and isolation', {timeout:60_000}, async () => {
  const admin = new pg.Pool({connectionString,max:2});
  const schema=`ccl_knowledge_test_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,max:8,options:`-c search_path=${schema}`});
  try {
    await migrateKnowledge(pool); await migrateKnowledge(pool);
    const store=createKnowledgeStore(pool); const project='project-a';
    const first=revision(project); const proposal=change(project,first);
    const [staged,retry]=await Promise.all([store.stage(proposal),store.stage(proposal)]);
    assert.equal(staged.id,retry.id);
    assert.equal((await store.stage({...proposal,contentHash:'a'.repeat(64)})).contentHash,proposal.contentHash);
    await assert.rejects(store.stage({...proposal,requestHash:'a'.repeat(64)}),/conflict/i);
    assert.equal((await store.getByRequestKey(project,proposal.requestKey))?.id,proposal.id);
    assert.equal((await store.get(project,first.ref))?.published,false);
    await assert.rejects(store.publish(project,proposal.id,proposal.contentHash),/review/i);
    await assert.rejects(store.recordReview({...review(proposal),reviewer:proposal.proposer}),/differ from proposer/i);
    await assert.rejects(store.recordReview({...review(proposal),contentHash:'b'.repeat(64)}),/hash/i);
    await assert.rejects(store.recordReview({...review(proposal),purpose:'other'}),/purpose/i);
    await store.recordReview(review(proposal));
    await assert.rejects(store.publish(project,proposal.id,proposal.contentHash,undefined,1),/changed/i);
    const publication=await store.publish(project,proposal.id,proposal.contentHash,undefined,0);
    assert.deepEqual(await store.publish(project,proposal.id,proposal.contentHash),publication);
    assert.deepEqual(await store.head(project,first.ref.objectId),first.ref);
    assert.equal(await store.head('project-b',first.ref.objectId),null);
    assert.equal(await store.get('project-b',first.ref),null);
    assert.equal((await store.search(project,{query:'示例',kinds:['pattern']})).length,1);
    assert.equal((await store.search('project-b',{query:'示例'})).length,0);
    const secondA=revision(project,{objectId:first.ref.objectId,versionId:randomUUID()});
    const secondB=revision(project,{objectId:first.ref.objectId,versionId:randomUUID()});
    const a=change(project,secondA,first.ref.versionId,'correct'); const b=change(project,secondB,first.ref.versionId,'correct');
    await store.stage(a); await store.stage(b); await store.recordReview(review(a)); await store.recordReview(review(b));
    const outcomes=await Promise.allSettled([store.publish(project,a.id,a.contentHash),store.publish(project,b.id,b.contentHash)]);
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
    assert.equal((await store.history(project,first.ref.objectId)).length,3);
    assert.equal((await store.get(project,first.ref))?.validity.valid,false);
    assert.ok((await store.events(project,0)).some(x=>x.kind==='KnowledgePublished'));
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
});

dbTest('search filters exact source groups and combines the filter with text without changing unfiltered search', {timeout:60_000},async()=>{
  const admin=new pg.Pool({connectionString,max:2});
  const schema=`ccl_knowledge_source_search_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,max:3,options:`-c search_path=${schema}`});
  try {
    await migrateKnowledge(pool);
    const store=createKnowledgeStore(pool),project='source-search-project';
    const same=revision(project);same.body='Visible sequence with a task and obstacle';same.sourceGroups=['media-sha256:aaaa'];
    const other=revision(project);other.body='Different product claim';other.sourceGroups=['media-sha256:bbbb'];
    const foreign=revision('foreign-project');foreign.sourceGroups=['media-sha256:aaaa'];
    await adopt(store,change(project,same));await adopt(store,change(project,other));await adopt(store,change('foreign-project',foreign));
    assert.deepEqual((await store.search(project,{sourceGroups:['media-sha256:aaaa']})).map(x=>x.revision.ref),[same.ref],
      'an exact source group finds its revision even when a full research question is absent from body text');
    assert.equal((await store.search(project,{sourceGroups:['media-sha256:foreign']})).length,0);
    assert.equal((await store.search(project,{query:'Visible sequence',sourceGroups:['media-sha256:bbbb']})).length,0,
      'source group and text are combined with AND');
    assert.deepEqual((await store.search(project,{query:'Visible sequence',sourceGroups:['media-sha256:aaaa']})).map(x=>x.revision.ref),[same.ref]);
    assert.equal((await store.search(project,{})).length,2);
    assert.equal((await store.search(project,{sourceGroups:[]})).length,2);
    assert.equal((await store.search('foreign-project',{sourceGroups:['media-sha256:aaaa']})).length,1);
  } finally {await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});

dbTest('platform search keeps legacy TikTok versions readable and pages only eligible revisions', {timeout:60_000},async()=>{
  const admin=new pg.Pool({connectionString,max:2});
  const schema=`ccl_knowledge_platform_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,max:3,options:`-c search_path=${schema}`});
  try {
    await migrateKnowledge(pool);
    const store=createKnowledgeStore(pool),project='platform-search';
    const old=revision(project);old.body='Legacy TikTok observation';
    const douyin=revision(project);douyin.body='Douyin observation';douyin.scope.applicability.platforms=['douyin'];
    const unknown=revision(project);unknown.body='Unknown origin';unknown.scope.applicability.platforms=['unknown'];
    const transfer=revision(project);transfer.body='TikTok structure proposed for Douyin';
    transfer.scope.applicability.platforms=['tiktok'];
    transfer.scope.applicability.platformTransfers=[{to:'douyin',rationale:'Hypothesis for format adaptation only'}];
    for(const item of [old,douyin,unknown,transfer])await adopt(store,change(project,item));
    const fullDouyin=await store.search(project,{platform:'douyin'});
    assert.deepEqual((await store.search(project,{platform:'douyin',limit:1,offset:0})).map(row=>row.revision.ref),
      fullDouyin.slice(0,1).map(row=>row.revision.ref),'platform filtering happens before pagination');
    assert.deepEqual(fullDouyin.map(row=>row.revision.ref.versionId).sort(),
      [douyin.ref.versionId,transfer.ref.versionId].sort());
    assert.deepEqual((await store.search(project,{platform:'tiktok'})).map(row=>row.revision.ref.versionId).sort(),
      [old.ref.versionId,transfer.ref.versionId].sort());
    assert.equal((await store.search(project,{platform:'unknown'})).length,0);
    const catalog=await store.catalog(project,{platform:'douyin',limit:1});
    assert.equal(catalog.pageInfo.total,2);
    assert.equal(catalog.items.length,1);
    assert.ok(catalog.pageInfo.nextCursor);
    await assert.rejects(store.catalog(project,{platform:'tiktok',cursor:catalog.pageInfo.nextCursor!}),
      (error:unknown)=>error instanceof Error&&error.message.includes('cursor'));
    assert.equal((await store.catalog(project,{platform:'douyin',cursor:catalog.pageInfo.nextCursor!})).items.length,1);
    assert.equal((await store.get(project,old.ref))?.revision.scope.applicability.platforms,undefined,
      'historical JSON is not rewritten or given a new content hash');
  } finally {await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});

dbTest('catalog pages SQL summaries and impact follows only published critical dependencies', {timeout:60_000}, async(t)=>{
  const admin=new pg.Pool({connectionString,max:2});const schema=`ccl_knowledge_read_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,max:6,options:`-c search_path=${schema}`});
  try {
    await migrateKnowledge(pool);const store=createKnowledgeStore(pool),project='read-project';
    const root=revision(project);root.body='x'.repeat(50_000);await adopt(store,change(project,root));
    const dependent=revision(project,ref(),[{domain:'knowledge',ref:root.ref,role:'derived_from',critical:true}]);
    await adopt(store,change(project,dependent));
    const exploratory=revision(project,ref(),[{domain:'knowledge',ref:root.ref,role:'uses',critical:false}]);
    await adopt(store,change(project,exploratory));
    for(let i=0;i<197;i++)await adopt(store,change(project,revision(project,ref(),
      [{domain:'knowledge',ref:root.ref,role:'supports',critical:false}])));
    let queryCount=0;
    const measured=createKnowledgeStore({
      connect:async()=>{
        const client=await pool.connect();
        return new Proxy(client,{get(target,key){
          if(key==='query')return (...args:unknown[])=>{queryCount++;return (target.query as (...values:unknown[])=>unknown)(...args);};
          const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
        }});
      },query:pool.query.bind(pool),
    } as unknown as pg.Pool);
    assert.equal((await measured.search(project,{limit:50})).length,50);
    assert.ok(queryCount<20,`bounded assessment should batch shared page reads, saw ${queryCount} queries`);
    t.diagnostic(`search 50 shared dependency: ${queryCount} SQL queries`);
    queryCount=0;
    assert.equal((await measured.search(project,{limit:200})).length,200);
    assert.ok(queryCount<20,`200 assessments with one shared dependency should reuse request reads, saw ${queryCount} queries`);
    t.diagnostic(`search 200 shared dependency: ${queryCount} SQL queries`);
    const first=await store.catalog(project,{limit:50});
    assert.equal(first.items.length,50);assert.equal(first.pageInfo.total,200);assert.equal(first.pageInfo.hasMore,true);
    assert.ok(JSON.stringify(first).length<100_000);
    assert.ok(first.items.every(item=>!('body' in item)&&!('content' in item)&&!('dependencies' in item)));
    const all=[...first.items];let cursor=first.pageInfo.nextCursor;
    while(cursor){const page=await store.catalog(project,{limit:50,cursor});all.push(...page.items);cursor=page.pageInfo.nextCursor;}
    assert.equal(all.length,200);
    assert.equal(new Set(all.map(item=>item.ref.objectId)).size,200);
    await assert.rejects(store.catalog('other',{limit:50,cursor:first.pageInfo.nextCursor!}),/cursor/i);
    await assert.rejects(store.catalog(project,{limit:50,query:'different',cursor:first.pageInfo.nextCursor!}),/cursor/i);
    assert.equal((await store.get(project,root.ref))?.revision.body.length,50_000);
    const impact=await store.impact(project,`knowledge:${root.ref.objectId}/${root.ref.versionId}`);
    assert.equal(impact.basis,'authoritative_critical_dependencies');assert.equal(impact.complete,true);
    assert.deepEqual(impact.affectedIds,[`knowledge:${dependent.ref.objectId}/${dependent.ref.versionId}`]);
    assert.deepEqual(impact.criticalEdgeIds,[`knowledge:${root.ref.objectId}/${root.ref.versionId}|derived_from|knowledge:${dependent.ref.objectId}/${dependent.ref.versionId}`]);
    assert.equal((await store.impact(project,`source:${root.ref.objectId}/${root.ref.versionId}`)).completeness,'unknown');
    assert.equal((await store.impact('other',`knowledge:${root.ref.objectId}/${root.ref.versionId}`)).complete,false);
  } finally {await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});

dbTest('external invalidation traverses case, pattern, pack and blocks future use', {timeout:60_000}, async () => {
  const admin=new pg.Pool({connectionString,max:2}); const schema=`ccl_knowledge_test_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,max:6,options:`-c search_path=${schema}`});
  try {
    await migrateKnowledge(pool); const store=createKnowledgeStore(pool); const project='p'; const external=ref();
    const dependency=(domain:Dependency['domain'],r:ReturnType<typeof ref>):Dependency=>({domain,ref:r,role:'derived_from',critical:true});
    const caseRev=revision(project,ref(),[dependency('analysis',external)]); await adopt(store,change(project,caseRev));
    const pattern=revision(project,ref(),[dependency('knowledge',caseRev.ref)]); await adopt(store,change(project,pattern));
    const pack=revision(project,ref(),[dependency('knowledge',pattern.ref)]); await adopt(store,change(project,pack));
    const affected=await store.invalidate(project,{domain:'analysis',ref:external,reason:'result withdrawn',state:'withdrawn',createdAt:now()});
    assert.equal(new Set(affected.map(x=>x.versionId)).size,3);
    assert.equal((await store.catalog(project,{limit:50})).items.filter(item=>item.invalidityRecorded).length,3);
    assert.equal((await store.validate(project,[dependency('knowledge',pack.ref)])).valid,false);
    assert.equal((await store.get(project,caseRev.ref))?.published,true);
    const downstream=revision(project,ref(),[dependency('knowledge',pack.ref)]); const proposed=change(project,downstream);
    await store.stage(proposed); await store.recordReview(review(proposed));
    await assert.rejects(store.publish(project,proposed.id,proposed.contentHash),/invalid/i);
    assert.equal(await store.head(project,downstream.ref.objectId),null);
    assert.equal(await store.head('other',pack.ref.objectId),null);
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
});

dbTest('withdrawal and review deadlines retain readable history but prevent new adoption', {timeout:60_000}, async () => {
  const admin=new pg.Pool({connectionString,max:2}); const schema=`ccl_knowledge_test_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,max:4,options:`-c search_path=${schema}`});
  try {
    await migrateKnowledge(pool); const store=createKnowledgeStore(pool); const project='p';
    const original=revision(project); await adopt(store,change(project,original));
    assert.equal((await store.get(project,original.ref))?.validity.valid,true);
    const withdrawn=revision(project,{objectId:original.ref.objectId,versionId:randomUUID()});
    await adopt(store,change(project,withdrawn,original.ref.versionId,'withdraw'));
    assert.equal((await store.get(project,original.ref))?.published,true);
    assert.equal((await store.get(project,original.ref))?.validity.valid,false);
    assert.equal((await store.get(project,withdrawn.ref))?.validity.valid,false);
    const catalog=(await store.catalog(project,{limit:50})).items.find(item=>item.ref.objectId===withdrawn.ref.objectId);
    assert.equal(catalog?.withdrawn,true);
    assert.equal(catalog?.reviewDue,false);
    assert.equal((await store.history(project,original.ref.objectId)).length,2);
    const dependent=revision(project,ref(),[{domain:'knowledge',ref:withdrawn.ref,role:'uses',critical:true}]);
    const c=change(project,dependent); await store.stage(c); await store.recordReview(review(c));
    await assert.rejects(store.publish(project,c.id,c.contentHash),/invalid/i);
    const due=revision(project); due.scope.reviewDueAt=new Date(Date.now()-1000).toISOString();
    const dueChange=change(project,due); await store.stage(dueChange); await store.recordReview(review(dueChange));
    await assert.rejects(store.publish(project,dueChange.id,dueChange.contentHash),/due for review/i);
    assert.equal(await store.head(project,due.ref.objectId),null);
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
});

dbTest('an exact revision view rechecks review expiry on each request', {timeout:30_000},async()=>{
  const admin=new pg.Pool({connectionString,max:2});const schema=`ccl_knowledge_expiry_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,max:3,options:`-c search_path=${schema}`});
  try{
    await migrateKnowledge(pool);const store=createKnowledgeStore(pool),project='expiry';
    const item=revision(project);const due=new Date(Date.now()+1500).toISOString();item.scope.reviewDueAt=due;
    await adopt(store,change(project,item));
    assert.equal((await store.get(project,item.ref))?.validity.valid,true);
    assert.equal((await store.catalog(project,{limit:50})).items.find(row=>row.ref.versionId===item.ref.versionId)?.reviewDue,false);
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(due)-Date.now()+25)));
    const expired=await store.get(project,item.ref);
    assert.equal(expired?.validity.valid,false);
    assert.ok(expired?.validity.issues.some(issue=>issue.reason==='review_due'));
    assert.equal((await store.catalog(project,{limit:50})).items.find(row=>row.ref.versionId===item.ref.versionId)?.reviewDue,true);
    assert.equal(expired?.revision.ref.versionId,item.ref.versionId);
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});

dbTest('ordered reviews and sibling DAG publish atomically; cycle rolls back', {timeout:60_000}, async () => {
  const admin=new pg.Pool({connectionString,max:2}); const schema=`ccl_knowledge_test_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,max:4,options:`-c search_path=${schema}`});
  try {
    await migrateKnowledge(pool); const store=createKnowledgeStore(pool); const project='p';
    const parent=revision(project); const child=revision(project,ref(),[{domain:'knowledge',ref:parent.ref,role:'supports',critical:true}]);
    const c=change(project,child); c.changes.unshift({revision:parent,effect:'create',explanation:'test'});
    c.baseHeads.push({objectId:parent.ref.objectId,versionId:null});
    c.inputManifest=[{domain:'knowledge',ref:parent.ref,role:'supports',critical:true}];
    await store.stage(c);
    const approved1=review(c); const rejected=review(c,'rejected'); const approved2=review(c);
    await store.recordReview(approved1); await store.recordReview(rejected);
    await assert.rejects(store.publish(project,c.id,c.contentHash),/review/i);
    assert.equal(await store.head(project,parent.ref.objectId),null);
    await store.recordReview(approved2);
    await store.publish(project,c.id,c.contentHash);
    assert.equal((await store.get(project,parent.ref))?.review?.id,approved2.id);
    assert.equal((await store.get(project,child.ref))?.validity.valid,true);
    assert.deepEqual(await store.dependents(project,{domain:'knowledge',ref:parent.ref}),[child.ref]);
    assert.deepEqual(await store.dependents(project,{domain:'knowledge',ref:child.ref}),[]);
    const x=revision(project); const y=revision(project);
    x.dependencies=[{domain:'knowledge',ref:y.ref,role:'uses',critical:true}];
    y.dependencies=[{domain:'knowledge',ref:x.ref,role:'uses',critical:true}];
    const cyclic=change(project,x); cyclic.changes.push({revision:y,effect:'create',explanation:'test'});
    cyclic.baseHeads.push({objectId:y.ref.objectId,versionId:null});
    await store.stage(cyclic); await store.recordReview(review(cyclic));
    await assert.rejects(store.publish(project,cyclic.id,cyclic.contentHash),/cycle/i);
    assert.equal(await store.head(project,x.ref.objectId),null);
    assert.equal(await store.head(project,y.ref.objectId),null);
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
});

dbTest('manifest union does not create dependencies across unrelated sibling revisions', {timeout:60_000}, async () => {
  const admin=new pg.Pool({connectionString,max:2}); const schema=`ccl_knowledge_test_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,max:4,options:`-c search_path=${schema}`});
  try {
    await migrateKnowledge(pool); const store=createKnowledgeStore(pool); const project='p';
    const a=ref(), b=ref();
    const aDep:Dependency={domain:'analysis',ref:a,role:'derived_from',critical:true};
    const bDep:Dependency={domain:'source',ref:b,role:'supports',critical:true};
    const aRevision=revision(project,ref(),[aDep]); const bRevision=revision(project,ref(),[bDep]);
    const c=change(project,aRevision); c.changes.push({revision:bRevision,effect:'create',explanation:'test'});
    c.baseHeads.push({objectId:bRevision.ref.objectId,versionId:null}); c.inputManifest=[aDep,bDep];
    await adopt(store,c);
    assert.deepEqual(await store.dependents(project,{domain:'analysis',ref:a}),[aRevision.ref]);
    assert.deepEqual(await store.dependents(project,{domain:'source',ref:b}),[bRevision.ref]);
    assert.deepEqual(await store.invalidate(project,{domain:'analysis',ref:a,reason:'withdrawn',state:'withdrawn',createdAt:now()}),[aRevision.ref]);
    assert.equal((await store.get(project,aRevision.ref))?.validity.valid,false);
    assert.equal((await store.get(project,bRevision.ref))?.validity.valid,true);
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
});

dbTest('withdrawal can close an invalid or review-due head while ordinary revisions remain gated', {timeout:60_000}, async () => {
  const admin=new pg.Pool({connectionString,max:2}); const schema=`ccl_knowledge_test_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,max:4,options:`-c search_path=${schema}`});
  try {
    await migrateKnowledge(pool); const store=createKnowledgeStore(pool); const project='p'; const external=ref();
    const dep:Dependency={domain:'source',ref:external,role:'supports',critical:true};
    const original=revision(project,ref(),[dep]); await adopt(store,change(project,original));
    await store.invalidate(project,{domain:'source',ref:external,reason:'source withdrawn',state:'withdrawn',createdAt:now()});
    const closing=revision(project,{objectId:original.ref.objectId,versionId:randomUUID()},[dep]);
    closing.scope.reviewDueAt=new Date(Date.now()-1000).toISOString();
    const withdrawal=change(project,closing,original.ref.versionId,'withdraw'); withdrawal.inputManifest=[dep];
    const staleAlternative=revision(project,{objectId:original.ref.objectId,versionId:randomUUID()},[dep]);
    const staleChange=change(project,staleAlternative,original.ref.versionId,'withdraw');
    const ordinary=revision(project,ref(),[dep]);
    const mixedClosing=revision(project,{objectId:original.ref.objectId,versionId:randomUUID()},[dep]);
    const mixed=change(project,ordinary); mixed.changes.push({revision:mixedClosing,effect:'withdraw',explanation:'close old head'});
    mixed.baseHeads.push({objectId:mixedClosing.ref.objectId,versionId:original.ref.versionId}); mixed.inputManifest=[dep];
    await store.stage(mixed); await store.recordReview(review(mixed));
    await assert.rejects(store.publish(project,mixed.id,mixed.contentHash),/invalid/i);
    assert.deepEqual(await store.head(project,original.ref.objectId),original.ref);
    const ordinaryOnly=change(project,revision(project,ref(),[dep])); await store.stage(ordinaryOnly); await store.recordReview(review(ordinaryOnly));
    await assert.rejects(store.publish(project,ordinaryOnly.id,ordinaryOnly.contentHash),/invalid/i);
    await store.stage(withdrawal); await store.recordReview(review(withdrawal));
    await store.stage(staleChange); await store.recordReview(review(staleChange));
    await store.publish(project,withdrawal.id,withdrawal.contentHash);
    assert.deepEqual(await store.head(project,closing.ref.objectId),closing.ref);
    assert.equal((await store.get(project,closing.ref))?.validity.valid,false);
    await assert.rejects(store.publish(project,staleChange.id,staleChange.contentHash),/base head changed/i);
    assert.equal((await store.history(project,original.ref.objectId)).length,4);
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
});

dbTest('source-label search and catalog count/pagination use identical exact current-version matches', {timeout:10000}, async()=>{
  const admin=new pg.Pool({connectionString});const schema=`ccl_source_catalog_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,max:1,connectionTimeoutMillis:2000,options:`-c search_path=${schema}`});
  try{
    await migrateKnowledge(pool);const plain=createKnowledgeStore(pool);
    const a=revision('source-project');const b=revision('source-project');const foreign=revision('foreign-project');
    await adopt(plain,change('source-project',a));await adopt(plain,change('source-project',b));await adopt(plain,change('foreign-project',foreign));
    const store=createKnowledgeStore(pool,{sourceMatches:async(project,query)=>{
      await pool.query('SELECT 1'); // Same-pool adapter must work even with one connection.
      assert.equal(query,'publisher-label');assert.equal(project,'source-project');
      return [a.ref,b.ref,foreign.ref];
    }});
    assert.equal((await plain.search('source-project',{query:'publisher-label'})).length,0);
    assert.equal((await store.search('source-project',{query:'publisher-label'})).length,2);
    const first=await store.catalog('source-project',{query:'publisher-label',limit:1});
    assert.equal(first.pageInfo.total,2);assert.equal(first.items.length,1);assert.ok(first.pageInfo.nextCursor);
    const second=await store.catalog('source-project',{query:'publisher-label',limit:1,cursor:first.pageInfo.nextCursor});
    assert.equal(second.pageInfo.total,2);assert.equal(second.pageInfo.hasMore,false);
    assert.notEqual(first.items[0].ref.objectId,second.items[0].ref.objectId);
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});

dbTest('historical reading selects publication-time heads and excludes later supersession and invalidity', {timeout:60_000},async()=>{
  const admin=new pg.Pool({connectionString,max:2});
  const schema=`ccl_knowledge_asof_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,max:6,options:`-c search_path=${schema}`});
  try {
    await migrateKnowledge(pool);const store=createKnowledgeStore(pool),project='synthetic-asof';
    const original=revision(project);await adopt(store,change(project,original));
    const dependent=revision(project,ref(),[{domain:'knowledge',ref:original.ref,role:'uses',critical:true}]);
    const before=await adopt(store,change(project,dependent));
    const replacement=revision(project,{objectId:original.ref.objectId,versionId:randomUUID()});
    // Deliberately keep old creation time: the freeze must use publication time, never createdAt.
    replacement.createdAt=original.createdAt;
    const after=await adopt(store,change(project,replacement,original.ref.versionId,'correct'));
    assert.ok(Date.parse(after.publishedAt)>Date.parse(before.publishedAt));
    assert.equal((await store.get(project,dependent.ref))?.validity.valid,false);
    const historical=await store.getAsOf!(project,dependent.ref,before.publishedAt);
    assert.equal(historical?.current,true);assert.equal(historical?.validity.valid,true);
    assert.equal((await store.getAsOf!(project,original.ref,before.publishedAt))?.current,true);
    assert.equal(await store.getAsOf!(project,replacement.ref,before.publishedAt),null);
    assert.equal((await store.getAsOf!(project,original.ref,after.publishedAt))?.current,false);
    assert.equal((await store.getAsOf!(project,dependent.ref,after.publishedAt))?.validity.valid,false);
    assert.equal(await store.getAsOf!('foreign',dependent.ref,before.publishedAt),null);
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
