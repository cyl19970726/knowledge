import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {readTestDatabase} from '../../../scripts/runtime/test-database.mjs';
import {migrateKnowledge} from '../../../packages/knowledge/src/migrations.ts';
import {createKnowledgeStore} from '../../../packages/knowledge/src/store.ts';
import {digest} from '../../../packages/knowledge/src/utils.ts';
import type {KnowledgeChangeSet,KnowledgeReview,KnowledgeRevision} from '../../../packages/knowledge/src/types.ts';
import {createKnowledgeClient,KnowledgeClientError} from '../../../packages/knowledge-client/src/index.ts';
import {createKnowledgeApi} from '../src/index.ts';
import {createKnowledgeWorker} from '../../knowledge-worker/src/index.ts';
import {rotateKnowledgeWriterAuthority} from '../../../packages/knowledge/src/writer-authority.ts';
import {seedKnowledgeSyntheticFixture} from '../../../scripts/runtime/knowledge-synthetic-fixture.ts';

const url=readTestDatabase();const dbTest=url?test:test.skip;
function revision(projectId:string):KnowledgeRevision{
  const ref={objectId:randomUUID(),versionId:randomUUID()},createdAt=new Date().toISOString();
  return {kind:'pattern',ref,projectId,title:'Synthetic read integration pattern',body:'A bounded synthetic test document',
    scope:{applicability:{productVersionRefs:[],markets:[],languages:[],audiences:[],goals:[],requiredProduction:[],transferRationale:null},
      limitations:[],unknowns:[],reviewDueAt:null},dependencies:[],sourceGroups:['synthetic:read-api'],artifactRef:null,createdAt,analysisQuality:null,
    content:{ref,projectId,title:'Synthetic read integration pattern',problem:'test',mechanism:'test',sequence:[],requiredElements:[],variableSlots:[],
      applicability:[],exclusions:[],supportRefs:[],counterexampleRefs:[],prediction:'test',evidenceLevel:'inconclusive',citations:[]}};
}
function change(rev:KnowledgeRevision):KnowledgeChangeSet{
  return {id:randomUUID(),projectId:rev.projectId,requestKey:randomUUID(),requestHash:'a'.repeat(64),contentHash:'b'.repeat(64),
    purpose:'exploration_reading',proposer:'synthetic-proposer',rationale:'Synthetic API test',methodVersion:'test-v1',
    cost:{state:'unknown',reason:'synthetic test'},baseHeads:[{objectId:rev.ref.objectId,versionId:null}],inputManifest:[],
    changes:[{revision:rev,effect:'create',explanation:'Synthetic test'}],createdAt:new Date().toISOString()};
}
function review(value:KnowledgeChangeSet):KnowledgeReview{
  return {id:randomUUID(),projectId:value.projectId,changeSetId:value.id,contentHash:value.contentHash,
    reviewer:'independent-synthetic-reviewer',policyVersion:'test-v1',purpose:value.purpose,decision:'exploration_only',
    rationale:'Synthetic independent review',createdAt:new Date().toISOString()};
}

dbTest('standalone API reads authoritative exact versions and stores scoped receipts', {timeout:60_000},async()=>{
  const admin=new pg.Pool({connectionString:url!,max:2}),schema=`ccl_knowledge_api_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString:url!,max:8,options:`-c search_path=${schema}`});
  let server:import('node:http').Server|undefined;
  try{
    await migrateKnowledge(pool);const store=createKnowledgeStore(pool),projectId=`synthetic-${randomUUID()}`,spaceId='legacy:video-research';
    const item=revision(projectId),proposal=change(item);
    await store.stage(proposal);await store.recordReview(review(proposal));await store.publish(projectId,proposal.id,proposal.contentHash);
    const token=`test-${randomUUID()}-${randomUUID()}`;
    const api=await createKnowledgeApi({pool,token,principal:{id:'synthetic-reader',clientInstallationId:'integration',projectId,spaceIds:[spaceId],purposes:['exploration_reading']},port:0});
    server=await api.listen();const address=server.address();assert.ok(address&&typeof address!=='string');
    const baseUrl=`http://127.0.0.1:${address.port}`;
    const client=createKnowledgeClient({baseUrl,scope:{projectId,spaceId},headers:{Authorization:`Bearer ${token}`}});
    const capabilities=await client.capabilities();assert.equal(capabilities.data.mode,'read_only');
    const profiles=await client.profiles();assert.equal(profiles.data.length,5);
    assert.deepEqual(capabilities.data.profiles,profiles.data);
    assert.ok(profiles.data.some(profile=>profile.id==='question'&&profile.version==='1'&&profile.digest.length===64));
    const catalog=await client.catalog({purpose:'exploration_reading',limit:10});
    assert.equal(catalog.data.items.length,1);assert.equal(catalog.data.items[0].ref.objectId,item.ref.objectId);
    assert.equal(catalog.data.items[0].ref.contentDigest,digest(item));
    const exact=await client.document(catalog.data.items[0].ref,'exploration_reading');assert.equal(exact.data.body,item.body);
    assert.ok(exact.readReceiptId);assert.equal((await client.receipt(exact.readReceiptId!)).data.orderedItems[0].ref.versionId,item.ref.versionId);
    const history=await client.history({objectId:item.ref.objectId,purpose:'exploration_reading',limit:10});assert.equal(history.data.versions.length,1);
    const graph=await client.graph({root:{ref:exact.data.ref},purpose:'exploration_reading',relationKinds:['supports'],maxDepth:2,maxNodes:10,maxBytes:100_000});
    assert.equal(graph.data.nodes.length,1);
    const query=await client.query({question:'unmatched synthetic question',purpose:'exploration_reading',limit:10});
    assert.equal(query.data.emptyState,'no_matches_in_scope');
    const receipt=await client.receipt(query.data.readReceiptId);assert.equal(receipt.data.principalId,'synthetic-reader');
    const saved=await pool.query('SELECT count(*)::int n FROM ccl_knowledge_read_receipts WHERE project_id=$1',[projectId]);assert.ok(saved.rows[0].n>=3);
    const alien=createKnowledgeClient({baseUrl,scope:{projectId,spaceId:'other-space'},headers:{Authorization:`Bearer ${token}`}});
    await assert.rejects(alien.catalog({purpose:'exploration_reading',limit:10}),error=>error instanceof KnowledgeClientError&&error.code==='SCOPE_FORBIDDEN');
    const bad=createKnowledgeClient({baseUrl,scope:{projectId,spaceId},headers:{Authorization:'Bearer wrong-token-value'}});
    await assert.rejects(bad.catalog({purpose:'exploration_reading',limit:10}),error=>error instanceof KnowledgeClientError&&error.code==='UNAUTHORIZED');
  }finally{await new Promise<void>(resolve=>server?.close(()=>resolve())??resolve());await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});

dbTest('managed source research publishes only with owner proof and fails after revocation', {timeout:90_000},async()=>{
  const admin=new pg.Pool({connectionString:url!,max:2}),schema=`ccl_knowledge_source_research_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);const pool=new pg.Pool({connectionString:url!,max:8,options:`-c search_path=${schema}`});
  let authorServer:import('node:http').Server|undefined,reviewerServer:import('node:http').Server|undefined;
  try{
    const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-${randomUUID()}`),token=`test-${randomUUID()}-${randomUUID()}`;
    const author=await createKnowledgeApi({pool,token,principal:seed.principal,capabilities:{...seed.authorization,
      actions:[...seed.authorization.actions,'review:request','review:decide']},writerGrant:seed.writerGrant,enableSyntheticResearch:true,port:0});
    authorServer=await author.listen();let address=authorServer.address();assert.ok(address&&typeof address!=='string');
    const authorClient=createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope:{projectId:seed.projectId,spaceId:seed.spaceId},headers:{Authorization:`Bearer ${token}`}});
    const published=await authorClient.catalog({purpose:'exploration_reading',limit:1});
    const citedPage=await authorClient.document(published.data.items[0].ref,'exploration_reading');
    const registeredProfile=(await authorClient.capabilities()).data.profiles.find(profile=>
      profile.id===citedPage.data.profile.id&&profile.version===citedPage.data.profile.version);
    assert.deepEqual(citedPage.data.profile,registeredProfile);
    const directCitation=citedPage.data.citations?.find(item=>item.ref.domain==='source');assert.ok(directCitation);
    assert.deepEqual(directCitation.ref,seed.source.ref);
    assert.equal(directCitation.locator,'paragraph:1');
    assert.equal(directCitation.supports,'合成来源主张');
    assert.deepEqual(citedPage.data.actualReadCoverage,[],'metadata citation resolution is not a source content read');
    assert.deepEqual((await authorClient.source(directCitation.ref,'exploration_reading')).data.ref,seed.source.ref);
    const sourceOperation=await authorClient.lookupOperation({purpose:'exploration_reading',operation:'sources:upsert',key:'synthetic-source-v1'});
    assert.equal(sourceOperation.data.state,'committed');
    assert.equal(sourceOperation.data.operation?.id,seed.source.receiptId);
    assert.equal((await authorClient.lookupOperation({purpose:'exploration_reading',operation:'sources:upsert',key:randomUUID()})).data.state,'unknown');
    const reviewerToken=`test-${randomUUID()}-${randomUUID()}`;
    const reviewer=await createKnowledgeApi({pool,token:reviewerToken,principal:{...seed.principal,id:'independent-reviewer'},
      capabilities:{...seed.authorization,actions:['review:decide']},writerGrant:seed.writerGrant,enableSyntheticResearch:true,port:0});
    reviewerServer=await reviewer.listen();address=reviewerServer.address();assert.ok(address&&typeof address!=='string');
    const reviewerClient=createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope:{projectId:seed.projectId,spaceId:seed.spaceId},headers:{Authorization:`Bearer ${reviewerToken}`}});
    const createRequest=(question:string)=>({question,purpose:'exploration_reading',sourceRefs:[seed.source.ref],knowledgeRefs:[],baseHeads:[],
      budget:{maxModelCalls:0,maxReadBytes:10000,deadline:new Date(Date.now()+60_000).toISOString(),maxMoney:null},allowExternalAcquisition:false as const});
    const first=await authorClient.research(createRequest('Synthetic source backed candidate A'),{idempotencyKey:randomUUID()});
    const second=await authorClient.research(createRequest('Synthetic source backed candidate B'),{idempotencyKey:randomUUID()});
    const worker=await createKnowledgeWorker({pool,projectId:seed.projectId,writerGrant:seed.writerGrant,provider:{async generate(){return {outcome:'candidate',
      summary:'Synthetic source-backed candidate only',conditions:['Engineering test'],counterexamples:[],unknowns:['Business meaning unverified'],nextQuestions:['What independent evidence?']};}}});
    assert.equal(await worker.runOne(),true);assert.equal(await worker.runOne(),true);
    const store=createKnowledgeStore(pool,{writerGrant:seed.writerGrant});
    async function ticketFor(id:string){const result=await authorClient.researchResult(id);assert.equal(result.data.cognitiveOutcome,'candidate');
      const change=await store.getChangeSet(seed.projectId,result.data.candidateId!);assert.ok(change);
      const ticket=await authorClient.requestReview({target:{kind:'candidate',candidateId:change.id,contentHash:change.contentHash},purpose:'exploration_reading'},
        {idempotencyKey:randomUUID()});return {change,ticket};}
    const accepted=await ticketFor(first.data.id),toRevoke=await ticketFor(second.data.id);
    const final=await reviewerClient.decideReview(accepted.ticket.data.id,{expectedDigest:accepted.change.contentHash,decision:'exploration_only',
      reason:'Synthetic source content and owner proof checked under publication lock',conditions:[],gaps:['No real semantic review']},{idempotencyKey:randomUUID()});
    assert.equal(final.data.publication?.changeSetId,accepted.change.id);
    await authorClient.revokeSource(seed.source.ref,{contentDigest:seed.source.ref.contentDigest,expectedGeneration:1},{idempotencyKey:randomUUID()});
    await assert.rejects(reviewerClient.decideReview(toRevoke.ticket.data.id,{expectedDigest:toRevoke.change.contentHash,decision:'exploration_only',
      reason:'Should be blocked after rights revocation',conditions:[],gaps:[]},{idempotencyKey:randomUUID()}),
      error=>error instanceof KnowledgeClientError&&['SOURCE_PROOF_UNAVAILABLE','SOURCE_PROOF_REVOKED'].includes(error.code));
    assert.equal(await store.head(seed.projectId,toRevoke.change.changes[0].revision.ref.objectId),null);
  }finally{await new Promise<void>(resolve=>authorServer?.close(()=>resolve())??resolve());await new Promise<void>(resolve=>reviewerServer?.close(()=>resolve())??resolve());
    await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});

dbTest('caller feedback registers an exact source atomically and can enter bounded research', {timeout:90_000},async()=>{
  const admin=new pg.Pool({connectionString:url!,max:2}),schema=`ccl_knowledge_feedback_source_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);const pool=new pg.Pool({connectionString:url!,max:8,options:`-c search_path=${schema}`});
  let server:import('node:http').Server|undefined,reviewerServer:import('node:http').Server|undefined;
  try{
    const seed=await seedKnowledgeSyntheticFixture(pool,`synthetic-${randomUUID()}`),token=`test-${randomUUID()}-${randomUUID()}`;
    const api=await createKnowledgeApi({pool,token,principal:seed.principal,writerGrant:seed.writerGrant,enableSyntheticResearch:true,port:0,
      capabilities:{...seed.authorization,actions:[...seed.authorization.actions,'feedback:source','review:request']},
      feedbackSourceRightsPolicyRef:'synthetic-local-only'});
    server=await api.listen();const address=server.address();assert.ok(address&&typeof address!=='string');
    const client=createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope:{projectId:seed.projectId,spaceId:seed.spaceId},headers:{Authorization:`Bearer ${token}`}});
    const externalContext={adapterId:'document',externalId:`feedback-${randomUUID()}`,contextVersion:'1',inputDigest:'a'.repeat(64),
      authority:'caller_reported' as const,description:'Synthetic observed label only'};
    const feedback=await client.recordFeedback({purpose:'exploration_reading',useId:null,context:externalContext,knowledgeRefs:[],feedbackKey:randomUUID(),status:'observed',
      observedAt:new Date().toISOString(),observation:'Synthetic caller saw a label.',rawQuotation:'Visible label',
      interpretation:'The label may help identification; unverified.',recommendation:'Test with actual readers.',artifactDigest:null,
      measurementScope:'One synthetic observation',cost:{modelCalls:{state:'known',value:0},tokens:{state:'known',value:0},
        money:{state:'unknown',reason:'No bill checked'}},gaps:['No real audience data']},{idempotencyKey:randomUUID()});
    assert.equal(feedback.data.sourceRef,null);
    await assert.rejects(client.registerFeedbackSource(feedback.data.id,{purpose:'exploration_reading',expectedFeedbackDigest:'b'.repeat(64)},{idempotencyKey:randomUUID()}),
      error=>error instanceof KnowledgeClientError&&error.code==='FEEDBACK_DIGEST_MISMATCH');
    assert.equal((await client.feedback(feedback.data.id,'exploration_reading')).data.sourceRef,null,'failed source admission must not link feedback');
    const key=randomUUID(),linked=await client.registerFeedbackSource(feedback.data.id,{purpose:'exploration_reading',expectedFeedbackDigest:feedback.data.digest},{idempotencyKey:key});
    assert.equal(linked.data.assertionKind,'caller_reported');
    assert.equal(linked.data.readability.assurance,'local_transaction');
    assert.equal((await client.registerFeedbackSource(feedback.data.id,{purpose:'exploration_reading',expectedFeedbackDigest:feedback.data.digest},{idempotencyKey:key})).data.ref.versionId,
      linked.data.ref.versionId);
    const latest=await client.feedback(feedback.data.id,'exploration_reading');assert.equal(latest.data.sourceRef?.versionId,linked.data.ref.versionId);
    assert.equal(latest.data.maintenanceState,'linked');
    const sourceContent=await client.sourceContent(linked.data.ref,'exploration_reading');
    const sourceJson=JSON.parse(sourceContent.data.content);assert.equal(sourceJson.rawQuotation,'Visible label');
    assert.equal(sourceJson.interpretation,'The label may help identification; unverified.');
    const changes=await client.feedbackResolutions(feedback.data.id,{purpose:'exploration_reading',limit:10});
    assert.ok(changes.data.items.some(item=>item.kind==='feedback_source_registered'));
    const op=await client.research({question:'What can this reported observation tell us?',purpose:'exploration_reading',sourceRefs:[linked.data.ref],knowledgeRefs:[],baseHeads:[],
      budget:{maxModelCalls:0,maxReadBytes:10000,deadline:new Date(Date.now()+60_000).toISOString(),maxMoney:null},allowExternalAcquisition:false,
      feedbackIds:[feedback.data.id]},
      {idempotencyKey:randomUUID()});
    const worker=await createKnowledgeWorker({pool,projectId:seed.projectId,writerGrant:seed.writerGrant});assert.equal(await worker.runOne(),true);
    const result=await client.researchResult(op.data.id);assert.equal(result.data.cognitiveOutcome,'no_change');
    assert.equal(result.data.exactReadset[0].versionId,linked.data.ref.versionId);
    assert.equal(result.data.actualReadCoverage[0].coverage,'full');
    const ticket=await client.requestReview({target:{kind:'research_result',researchId:op.data.id,resultDigest:result.data.resultDigest},
      purpose:'exploration_reading'},{idempotencyKey:randomUUID()});
    const reviewerToken=`test-${randomUUID()}-${randomUUID()}`;
    const reviewer=await createKnowledgeApi({pool,token:reviewerToken,principal:{...seed.principal,id:'independent-feedback-reviewer'},
      writerGrant:seed.writerGrant,enableSyntheticResearch:true,port:0,
      capabilities:{...seed.authorization,actions:['review:decide']}});
    reviewerServer=await reviewer.listen();const reviewerAddress=reviewerServer.address();assert.ok(reviewerAddress&&typeof reviewerAddress!=='string');
    const reviewerClient=createKnowledgeClient({baseUrl:`http://127.0.0.1:${reviewerAddress.port}`,scope:{projectId:seed.projectId,spaceId:seed.spaceId},
      headers:{Authorization:`Bearer ${reviewerToken}`}});
    const final=await reviewerClient.decideReview(ticket.data.id,{expectedDigest:result.data.resultDigest,decision:'exploration_only',
      reason:'Synthetic caller feedback source and no-change result reviewed independently',conditions:[],gaps:[]},{idempotencyKey:randomUUID()});
    assert.equal(final.data.result,'no_change');
    const resolutions=await client.feedbackResolutions(feedback.data.id,{purpose:'exploration_reading',limit:10});
    assert.ok(resolutions.data.items.some(item=>item.kind==='feedback_research_reviewed'&&item.researchId===op.data.id));
  }finally{await new Promise<void>(resolve=>reviewerServer?.close(()=>resolve())??resolve());await new Promise<void>(resolve=>server?.close(()=>resolve())??resolve());
    await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});

dbTest('isolated synthetic research reserves once, survives restart, and never infers missing operation absence', {timeout:60_000},async()=>{
  const admin=new pg.Pool({connectionString:url!,max:2}),schema=`ccl_knowledge_ops_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString:url!,max:8,options:`-c search_path=${schema}`});
  let server:import('node:http').Server|undefined;
  try{
    await migrateKnowledge(pool);
    const projectId=`synthetic-${randomUUID()}`,spaceId='legacy:knowledge';
    const grant=await rotateKnowledgeWriterAuthority(pool,projectId,null,{ownerId:'local-synthetic-worker',mode:'active'});
    const token=`test-${randomUUID()}-${randomUUID()}`;
    const config={pool,token,principal:{id:'synthetic-reader',clientInstallationId:'integration',projectId,spaceIds:[spaceId],purposes:['exploration_reading']},
      capabilities:{actions:['research:write','review:request'],adapterIds:[],rightsPolicyIds:[]},
      writerGrant:grant,enableSyntheticResearch:true,port:0};
    const api=await createKnowledgeApi(config);server=await api.listen();
    let address=server.address();assert.ok(address&&typeof address!=='string');
    let client=createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope:{projectId,spaceId},headers:{Authorization:`Bearer ${token}`}});
    const input={question:'What evidence is available?',purpose:'exploration_reading',sourceRefs:[],knowledgeRefs:[],baseHeads:[],
      budget:{maxModelCalls:0,maxReadBytes:0,deadline:new Date(Date.now()+60_000).toISOString(),maxMoney:null},allowExternalAcquisition:false as const};
    const key=randomUUID();const [first,replayed]=await Promise.all([client.research(input,{idempotencyKey:key}),client.research(input,{idempotencyKey:key})]);
    assert.equal(first.data.id,replayed.data.id);assert.equal(first.data.state,'queued');
    await assert.rejects(pool.query(`UPDATE ccl_knowledge_operations SET reason='unguarded direct writer' WHERE id=$1`,[first.data.id]),
      /KNOWLEDGE_WRITER_REVOKED/,'old or bypassing writers cannot alter activated operation authority');
    await assert.rejects(client.research({...input,question:'Different question'},{idempotencyKey:key}),error=>error instanceof KnowledgeClientError&&error.code==='IDEMPOTENCY_CONFLICT');
    assert.equal((await client.lookupOperation({purpose:'exploration_reading',operation:'research',key:randomUUID()})).data.state,'unknown');
    await new Promise<void>(resolve=>server!.close(()=>resolve()));server=undefined;
    const restarted=await createKnowledgeApi(config);server=await restarted.listen();address=server.address();assert.ok(address&&typeof address!=='string');
    client=createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope:{projectId,spaceId},headers:{Authorization:`Bearer ${token}`}});
    assert.equal((await client.lookupOperation({purpose:'exploration_reading',operation:'research',key})).data.operation?.id,first.data.id);
    const worker=await createKnowledgeWorker({pool,projectId,writerGrant:grant});assert.equal(await worker.runOne(),true);
    const result=await client.researchResult(first.data.id);assert.equal(result.data.cognitiveOutcome,'needs_evidence');
    assert.match(result.data.reason,/Synthetic engineering provider/);
    assert.equal((await client.researchOperation(first.data.id)).data.state,'waiting_for_review');
    assert.equal(await worker.runOne(),false);
    const cancelled=await client.cancelResearch(first.data.id,{reason:'Do not review this synthetic result'},{idempotencyKey:randomUUID()});
    assert.equal(cancelled.data.state,'cancelled');assert.equal(cancelled.data.publication,null);
    assert.equal((await client.researchOperation(first.data.id)).data.state,'cancelled');
    await assert.rejects(client.requestReview({target:{kind:'research_result',researchId:first.data.id,resultDigest:result.data.resultDigest},
      purpose:'exploration_reading'},{idempotencyKey:randomUUID()}),error=>error instanceof KnowledgeClientError&&error.code==='REVIEW_TARGET_INVALID');
    const deniedToken=`test-${randomUUID()}-${randomUUID()}`;
    const deniedApi=await createKnowledgeApi({...config,token:deniedToken,capabilities:{actions:[],adapterIds:[],rightsPolicyIds:[]}});
    const deniedServer=await deniedApi.listen();
    try{const deniedAddress=deniedServer.address();assert.ok(deniedAddress&&typeof deniedAddress!=='string');
      const deniedClient=createKnowledgeClient({baseUrl:`http://127.0.0.1:${deniedAddress.port}`,scope:{projectId,spaceId},headers:{Authorization:`Bearer ${deniedToken}`}});
      await assert.rejects(deniedClient.research(input,{idempotencyKey:randomUUID()}),error=>error instanceof KnowledgeClientError&&error.code==='CAPABILITY_FORBIDDEN');
      assert.equal((await deniedClient.capabilities()).data.permittedActions.includes('research'),false);
    }finally{await new Promise<void>(resolve=>deniedServer.close(()=>resolve()));}
  }finally{await new Promise<void>(resolve=>server?.close(()=>resolve())??resolve());await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});

dbTest('synthetic candidate needs independent review before exact KnowledgeStore publication', {timeout:60_000},async()=>{
  const admin=new pg.Pool({connectionString:url!,max:2}),schema=`ccl_knowledge_review_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);const pool=new pg.Pool({connectionString:url!,max:8,options:`-c search_path=${schema}`});
  let proposerServer:import('node:http').Server|undefined,reviewerServer:import('node:http').Server|undefined;
  try{
    const projectId=`synthetic-${randomUUID()}`,spaceId='synthetic-research';
    const seed=await seedKnowledgeSyntheticFixture(pool,projectId,spaceId),grant=seed.writerGrant,store=createKnowledgeStore(pool);
    const proposerToken=`test-${randomUUID()}-${randomUUID()}`,reviewerToken=`test-${randomUUID()}-${randomUUID()}`;
    const proposer=await createKnowledgeApi({pool,token:proposerToken,principal:{id:'proposer',clientInstallationId:'engineering',projectId,spaceIds:[spaceId],purposes:['exploration_reading']},
      capabilities:{actions:['research:write','review:request','review:decide'],adapterIds:[],rightsPolicyIds:[]},writerGrant:grant,enableSyntheticResearch:true,port:0});
    proposerServer=await proposer.listen();let address=proposerServer.address();assert.ok(address&&typeof address!=='string');
    const proposerClient=createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope:{projectId,spaceId},headers:{Authorization:`Bearer ${proposerToken}`}});
    const catalog=await proposerClient.catalog({purpose:'exploration_reading',limit:10});assert.equal(catalog.data.items[0].status.purpose.admitted,true,'candidate fixture must use a supported frozen reviewed basis');const basisRef=catalog.data.items[0].ref;
    const op=await proposerClient.research({question:'Synthetic candidate question',purpose:'exploration_reading',sourceRefs:[],knowledgeRefs:[basisRef],
      baseHeads:[],budget:{maxModelCalls:0,maxReadBytes:10000,deadline:new Date(Date.now()+60_000).toISOString(),maxMoney:null},allowExternalAcquisition:false},
      {idempotencyKey:randomUUID()});
    const worker=await createKnowledgeWorker({pool,projectId,writerGrant:grant,provider:{async generate(){return {outcome:'candidate',summary:'Synthetic candidate summary only',
      conditions:['Engineering fixture only'],counterexamples:[],unknowns:['Semantic accuracy unverified'],nextQuestions:['What evidence is still needed?']};}}});
    assert.equal(await worker.runOne(),true);
    const result=await proposerClient.researchResult(op.data.id);assert.equal(result.data.cognitiveOutcome,'candidate');assert.ok(result.data.candidateId);
    const staged=await store.getChangeSet(projectId,result.data.candidateId!);assert.ok(staged);
    const authorView=await proposerClient.candidateView(staged.id);
    assert.equal(authorView.data.state,'waiting_for_review');
    assert.equal(authorView.data.contentHash,staged.contentHash);
    assert.equal(authorView.data.changes[0].body,'Synthetic candidate summary only');
    assert.deepEqual(authorView.data.exactReadset,[basisRef]);
    assert.equal((await store.head(projectId,staged.changes[0].revision.ref.objectId)),null,'candidate must remain unpublished until independent review');
    const ticket=await proposerClient.requestReview({target:{kind:'candidate',candidateId:staged.id,contentHash:staged.contentHash},purpose:'exploration_reading'},
      {idempotencyKey:randomUUID()});
    await assert.rejects(proposerClient.decideReview(ticket.data.id,{expectedDigest:staged.contentHash,decision:'exploration_only',reason:'Synthetic review',conditions:[],gaps:[]},
      {idempotencyKey:randomUUID()}),error=>error instanceof KnowledgeClientError&&error.code==='SELF_REVIEW_FORBIDDEN');
    const reviewer=await createKnowledgeApi({pool,token:reviewerToken,principal:{id:'independent-reviewer',clientInstallationId:'engineering',projectId,spaceIds:[spaceId],purposes:['exploration_reading']},
      capabilities:{actions:['review:decide'],adapterIds:[],rightsPolicyIds:[]},writerGrant:grant,enableSyntheticResearch:true,port:0});
    reviewerServer=await reviewer.listen();address=reviewerServer.address();assert.ok(address&&typeof address!=='string');
    const reviewerClient=createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope:{projectId,spaceId},headers:{Authorization:`Bearer ${reviewerToken}`}});
    const reviewerView=await reviewerClient.candidateView(staged.id);
    assert.equal(reviewerView.data.contentHash,staged.contentHash);
    assert.equal(reviewerView.data.proposer,'proposer');
    assert.equal(reviewerView.data.changes[0].body,'Synthetic candidate summary only');
    assert.equal(reviewerView.data.changes[0].profile.id,'question');
    assert.equal(reviewerView.data.changes[0].unknowns[0],'Semantic accuracy unverified');
    const wrongSpace=createKnowledgeClient({baseUrl:`http://127.0.0.1:${address.port}`,scope:{projectId,spaceId:'unrelated-space'},
      headers:{Authorization:`Bearer ${reviewerToken}`}});
    await assert.rejects(wrongSpace.candidateView(staged.id),error=>error instanceof KnowledgeClientError&&error.code==='SCOPE_FORBIDDEN');
    const unprivilegedToken=`test-${randomUUID()}-${randomUUID()}`;
    const unprivileged=await createKnowledgeApi({pool,token:unprivilegedToken,principal:{id:'unprivileged-reader',clientInstallationId:'engineering',
      projectId,spaceIds:[spaceId],purposes:['exploration_reading']},capabilities:{actions:[],adapterIds:[],rightsPolicyIds:[]},
      writerGrant:grant,enableSyntheticResearch:true,port:0});
    const unprivilegedServer=await unprivileged.listen();
    try{const unprivilegedAddress=unprivilegedServer.address();assert.ok(unprivilegedAddress&&typeof unprivilegedAddress!=='string');
      const unprivilegedClient=createKnowledgeClient({baseUrl:`http://127.0.0.1:${unprivilegedAddress.port}`,
        scope:{projectId,spaceId},headers:{Authorization:`Bearer ${unprivilegedToken}`}});
      await assert.rejects(unprivilegedClient.candidateView(staged.id),error=>error instanceof KnowledgeClientError&&error.code==='CANDIDATE_READ_FORBIDDEN');
    }finally{await new Promise<void>(resolve=>unprivilegedServer.close(()=>resolve()));}
    await assert.rejects(reviewerClient.decideReview(ticket.data.id,{expectedDigest:'a'.repeat(64),decision:'exploration_only',reason:'Wrong frozen hash',
      conditions:[],gaps:[]},{idempotencyKey:randomUUID()}),error=>error instanceof KnowledgeClientError&&error.code==='REVIEW_DIGEST_MISMATCH');
    assert.equal(await store.head(projectId,staged.changes[0].revision.ref.objectId),null,'failed decision must leave candidate unpublished');
    const final=await reviewerClient.decideReview(ticket.data.id,{expectedDigest:staged.contentHash,decision:'exploration_only',reason:'Synthetic engineering fixture accepted for exploration only',
      conditions:[],gaps:['No semantic validation']},{idempotencyKey:randomUUID()});
    assert.equal(final.data.publication?.changeSetId,staged.id);
    assert.equal((await store.head(projectId,staged.changes[0].revision.ref.objectId))?.versionId,staged.changes[0].revision.ref.versionId);
    assert.equal((await proposerClient.researchResult(op.data.id)).data.reviewReceiptId,final.data.reviewReceiptId);
    const afterPublication=await proposerClient.cancelResearch(op.data.id,{reason:'Too late after independent review'},{idempotencyKey:randomUUID()});
    assert.equal(afterPublication.data.state,'too_late');
    assert.equal(afterPublication.data.publication?.changeSetId,staged.id);
    const racingOp=await proposerClient.research({question:'Synthetic cancellation race question',purpose:'exploration_reading',sourceRefs:[],
      knowledgeRefs:[basisRef],baseHeads:[],budget:{maxModelCalls:0,maxReadBytes:10000,deadline:new Date(Date.now()+60_000).toISOString(),maxMoney:null},
      allowExternalAcquisition:false},{idempotencyKey:randomUUID()});
    assert.equal(await worker.runOne(),true);
    const racingResult=await proposerClient.researchResult(racingOp.data.id);
    const racingChange=await store.getChangeSet(projectId,racingResult.data.candidateId!);assert.ok(racingChange);
    const racingTicket=await proposerClient.requestReview({target:{kind:'candidate',candidateId:racingChange.id,contentHash:racingChange.contentHash},
      purpose:'exploration_reading'},{idempotencyKey:randomUUID()});
    const [cancelRace,decideRace]=await Promise.allSettled([
      proposerClient.cancelResearch(racingOp.data.id,{reason:'Cancel before possible publication'},{idempotencyKey:randomUUID()}),
      reviewerClient.decideReview(racingTicket.data.id,{expectedDigest:racingChange.contentHash,decision:'exploration_only',
        reason:'Independent synthetic review race',conditions:[],gaps:[]},{idempotencyKey:randomUUID()})]);
    const racingHead=await store.head(projectId,racingChange.changes[0].revision.ref.objectId);
    if(cancelRace.status==='fulfilled'&&cancelRace.value.data.state==='cancelled'){
      assert.equal(decideRace.status,'rejected');assert.equal(racingHead,null);
      assert.equal((await proposerClient.researchOperation(racingOp.data.id)).data.state,'cancelled');
    }else{
      assert.equal(decideRace.status,'fulfilled');assert.equal(cancelRace.status,'fulfilled');
      if(decideRace.status==='fulfilled'&&cancelRace.status==='fulfilled'){
        assert.equal(cancelRace.value.data.state,'too_late');
        assert.equal(cancelRace.value.data.publication?.changeSetId,decideRace.value.data.publication?.changeSetId);
        assert.equal(racingHead?.versionId,racingChange.changes[0].revision.ref.versionId);
      }
    }
    const noChangeOp=await proposerClient.research({question:'Synthetic unchanged question',purpose:'exploration_reading',sourceRefs:[],knowledgeRefs:[basisRef],
      baseHeads:[],budget:{maxModelCalls:0,maxReadBytes:10000,deadline:new Date(Date.now()+60_000).toISOString(),maxMoney:null},allowExternalAcquisition:false},
      {idempotencyKey:randomUUID()});
    const defaultWorker=await createKnowledgeWorker({pool,projectId,writerGrant:grant});assert.equal(await defaultWorker.runOne(),true);
    const noChangeResult=await proposerClient.researchResult(noChangeOp.data.id);assert.equal(noChangeResult.data.cognitiveOutcome,'no_change');
    const noChangeTicket=await proposerClient.requestReview({target:{kind:'research_result',researchId:noChangeOp.data.id,
      resultDigest:noChangeResult.data.resultDigest},purpose:'exploration_reading'},{idempotencyKey:randomUUID()});
    const reviewedNoChange=await reviewerClient.decideReview(noChangeTicket.data.id,{expectedDigest:noChangeResult.data.resultDigest,
      decision:'exploration_only',reason:'Synthetic no-change result reviewed independently',conditions:[],gaps:[]},{idempotencyKey:randomUUID()});
    assert.equal(reviewedNoChange.data.result,'no_change');assert.equal(reviewedNoChange.data.publication,null);
    assert.equal((await proposerClient.researchOperation(noChangeOp.data.id)).data.state,'succeeded');
  }finally{await new Promise<void>(resolve=>proposerServer?.close(()=>resolve())??resolve());await new Promise<void>(resolve=>reviewerServer?.close(()=>resolve())??resolve());
    await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
