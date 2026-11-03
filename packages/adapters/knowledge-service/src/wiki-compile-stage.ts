import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {AskEvidenceReceiptSchema,CandidateReceiptSchema,CostSchema,SourceAccessProofSchema,WikiCompileProposalSchema,WikiCompileRequestSchema,
  type CandidateReceipt,type KnowledgeRef,type SourceAccessProof,type WikiDraftChange} from '@commerce/knowledge-contracts';
import {IdSchema,Sha256Schema} from '@commerce/contract-primitives';
import type {ReadContext} from '@commerce/knowledge-application';
import type {SourceRegistryPort} from '@commerce/knowledge-application';
import {wikiCompileStageRequestHash,type WikiCompileStageInput,type WikiCompileStagePort} from '@commerce/knowledge-application';
import {createKnowledgeStore} from '@commerce/knowledge-core/store';
import {KnowledgeError,type Dependency,type KnowledgeChangeSet,type KnowledgeRevision} from '@commerce/knowledge-core/types';
import {canonical,digest,uniqueDeps} from '@commerce/knowledge-core/utils';
import {getWikiPageProfile,WikiPageContentSchema,matchesWikiPageFrozenBinding,wikiPageFrozenDependencies,
  wikiPageInputFingerprint,wikiPageProfileFingerprint,wikiPageReadsetFingerprint} from '@commerce/knowledge-core/wiki-page';
import {KnowledgeRevisionSchema} from '@commerce/knowledge-core';
import {assertKnowledgeWriterAuthority,type KnowledgeWriterGrant} from '@commerce/knowledge-core/writer-authority';
import {assertLocalSourceProof} from './sources.ts';
import {WikiCompileCommitUnknownError} from './wiki-compile.ts';

function fail(code:string,message:string,status=422):never {throw new KnowledgeError(code,message,status);}
const refKey=(ref:Pick<KnowledgeRef,'objectId'|'versionId'>)=>`${ref.objectId}/${ref.versionId}`;
const sourceKey=(ref:KnowledgeRef)=>`${ref.domain}:${refKey(ref)}`;
const stableUuid=(input:string)=>{const value=createHash('sha256').update(input).digest('hex');
  return `${value.slice(0,8)}-${value.slice(8,12)}-5${value.slice(13,16)}-a${value.slice(17,20)}-${value.slice(20,32)}`;};
const version=(ref:KnowledgeRef)=>({objectId:ref.objectId,versionId:ref.versionId});
const sourceGroups=(items:WikiCompileStageInput['evidence'],base?:KnowledgeRevision)=>[...new Set([
  ...(base?.sourceGroups??[]),...items.flatMap(item=>(item.sourceGroups??[]).flatMap(group=>group.status==='known'&&group.id?[group.id]:[])),
])].sort();
const unsupported=(dependency:Dependency)=>dependency.domain==='analysis'||dependency.domain==='evidence'||dependency.domain==='context';
function assurance():never {return fail('COMPILATION_SOURCE_ASSURANCE_REQUIRED','Complete local publication source assurance is required',409);}

/** Applies explicit repair dispositions. Replaced or removed lineage leaves dependencies, citations and navigation together. */
function repairedBasis(old:KnowledgeRevision,plan:NonNullable<WikiDraftChange['repair']>,
  evidence:ReadonlyMap<string,WikiCompileStageInput['evidence'][number]>,objectId:string){
  if(old.kind!=='wiki_page')fail('COMPILE_TARGET_UNREAD','Update target must be a Wiki page');
  const key=(domain:string,ref:Pick<KnowledgeRef,'objectId'|'versionId'>)=>`${domain}:${refKey(ref)}`;
  const disposition=new Map(plan.dependencies.map(item=>[key(item.domain,item.ref),item]));
  const prior=old.dependencies.filter(dep=>dep.critical&&!(dep.domain==='knowledge'&&dep.ref.objectId===objectId));
  if(prior.some(dep=>!disposition.has(key(dep.domain,dep.ref)))||disposition.size!==new Set(prior.map(dep=>key(dep.domain,dep.ref))).size)
    fail('COMPILE_REPAIR_DISPOSITION_INCOMPLETE','Every prior critical dependency needs one explicit disposition');
  const replaced=new Map<string,Pick<KnowledgeRef,'objectId'|'versionId'>>(),removed=new Set<string>();
  for(const item of plan.dependencies){const id=key(item.domain,item.ref);
    if(item.action==='remove')removed.add(id);
    if(item.action==='replace'){const read=evidence.get(item.replacementEvidenceId!);
      if(!read||read.role==='repair_target'||read.kind!==(item.domain==='knowledge'?'wiki_page':'source_content'))
        fail('COMPILE_REPAIR_REPLACEMENT_UNREAD','A replacement must be exact evidence read by this compilation');
      replaced.set(id,version(read!.ref));}
  }
  const gone=(domain:string,ref:Pick<KnowledgeRef,'objectId'|'versionId'>)=>removed.has(key(domain,ref))||replaced.has(key(domain,ref));
  // Kept critical lineage and unrelated non-critical edges stay; replacement edges arrive as selected support.
  const dependencies=old.dependencies.filter(dep=>!(dep.domain==='knowledge'&&dep.ref.objectId===objectId)&&!gone(dep.domain,dep.ref));
  const citations=old.content.citations.filter(citation=>citation.kind!=='source'||!gone(citation.sourceDomain??'source',citation.sourceRef));
  const navigation=old.content.navigation.flatMap(link=>{const id=key('knowledge',link.ref);
    if(removed.has(id))return [];const next=replaced.get(id);return [next?{...link,ref:next}:link];});
  return {dependencies,citations,navigation};
}

function checkedEvidence(context:ReadContext,input:WikiCompileStageInput){
  const evidence=new Map<string,WikiCompileStageInput['evidence'][number]>();
  for(const item of input.evidence){
    const {body,...receipt}=item;
    AskEvidenceReceiptSchema.parse(receipt);
    if(evidence.has(item.id))fail('COMPILE_EVIDENCE_DUPLICATE','Evidence IDs must be unique');
    if(item.ref.projectId!==context.scope.projectId||item.ref.spaceId!==context.scope.spaceId||!item.ref.contentDigest)
      fail('COMPILE_EVIDENCE_SCOPE','Evidence must be exact and in the authenticated scope',403);
    if(item.kind==='wiki_page'){
      if(item.ref.domain!=='knowledge'||!item.storageDigest||!input.bases.has(item.id))
        fail('COMPILE_WIKI_BASIS_INVALID','Wiki evidence needs its frozen, already read revision');
      const base=input.bases.get(item.id)!;
      if(base.kind!=='wiki_page'||base.projectId!==context.scope.projectId||refKey(base.ref)!==refKey(item.ref)||
        digest(base)!==item.ref.contentDigest||base.binding?.spaceId!==context.scope.spaceId||base.body!==body||
        base.content.profile.id!==item.wiki?.profile.id||base.content.profile.version!==item.wiki?.profile.version||
        base.content.identity.key!==item.wiki?.identity.key||
        canonical([...new Set((item.sourceGroups??[]).flatMap(group=>group.status==='known'&&group.id?[group.id]:[]))].sort())!==
          canonical([...new Set(base.sourceGroups)].sort()))
        fail('COMPILE_WIKI_BASIS_INVALID','Wiki evidence differs from its frozen exact revision');
    }else{
      if(item.ref.domain!=='source'||createHash('sha256').update(body,'utf8').digest('hex')!==item.ref.contentDigest||
        !item.actualReadCoverage.length||item.actualReadCoverage.some(read=>sourceKey(read.sourceRef)!==sourceKey(item.ref)||
          read.sourceRef.contentDigest!==item.ref.contentDigest||read.coverage!=='full'||read.byteCount!==Buffer.byteLength(body,'utf8')))
        assurance();
    }
    evidence.set(item.id,item);
  }
  return evidence;
}

async function matchingCurrent(pool:Pool,context:ReadContext,draft:WikiDraftChange){
  const rows=await pool.query<{object_id:string;version_id:string}>(`SELECT h.object_id,h.version_id
    FROM ccl_knowledge_heads h JOIN ccl_knowledge_revisions r
      ON r.project_id=h.project_id AND r.object_id=h.object_id AND r.version_id=h.version_id
    WHERE h.project_id=$1 AND r.kind='wiki_page' AND r.payload->'binding'->>'spaceId'=$2
      AND r.payload->'content'->'profile'->>'id'=$3 AND r.payload->'content'->'profile'->>'version'=$4
      AND r.payload->'content'->'identity'->>'key'=$5 LIMIT 2`,
  [context.scope.projectId,context.scope.spaceId,draft.profile.id,draft.profile.version,draft.identityKey]);
  if(rows.rows.length>1)fail('COMPILE_IDENTITY_AMBIGUOUS','More than one current Wiki has this exact identity',409);
  return rows.rows[0]??null;
}

function localProofs(context:ReadContext,input:WikiCompileStageInput){
  const proofs=new Map<string,SourceAccessProof>();
  for(const raw of input.sourceProofs){
    const proof=SourceAccessProofSchema.parse(raw);
    if(proof.assurance!=='local_transaction'||proof.sourceRef.domain!=='source'||!proof.sourceRef.contentDigest||
      proof.sourceRef.projectId!==context.scope.projectId||proof.sourceRef.spaceId!==context.scope.spaceId||
      proof.subject!==context.principal.id||proof.purpose!==context.purpose||proof.audience!=='knowledge-publication'||
      proof.digest!==proof.sourceRef.contentDigest)
      assurance();
    const key=sourceKey(proof.sourceRef);
    if(proofs.has(key)&&canonical(proofs.get(key))!==canonical(proof))
      fail('COMPILE_SOURCE_PROOF_CONFLICT','Conflicting proofs for one exact source',409);
    proofs.set(key,proof);
  }
  return proofs;
}

function candidateReceipt(context:ReadContext,change:KnowledgeChangeSet):CandidateReceipt{
  return CandidateReceiptSchema.parse({candidateId:change.id,changeSetId:change.id,
    draftRefs:change.changes.map(item=>({...context.scope,domain:'knowledge',...item.revision.ref,
      contentDigest:digest(item.revision)})),contentHash:change.contentHash,published:false});
}

function assertLookupContext(context:ReadContext):void{
  if(context.scope.projectId!==context.principal.projectId||
    !context.principal.spaceIds.includes(context.scope.spaceId)||
    !context.principal.purposes.includes(context.purpose))
    fail('COMPILE_SCOPE_FORBIDDEN','Compilation scope or purpose is unavailable',403);
}

/** Internal candidate stage only. External owner reads stay in the compilation ledger. */
export function createPgWikiCompileStage(pool:Pool,grant:KnowledgeWriterGrant,sources?:SourceRegistryPort):WikiCompileStagePort{
  const store=createKnowledgeStore(pool,{writerGrant:grant});
  return {async stage(context,input):Promise<CandidateReceipt>{
    WikiCompileRequestSchema.parse(input.request);
    WikiCompileProposalSchema.parse(input.proposal);
    CostSchema.parse(input.cost);
    if(input.request.purpose!==context.purpose||context.scope.projectId!==context.principal.projectId||
      !context.principal.spaceIds.includes(context.scope.spaceId)||!context.principal.purposes.includes(context.purpose))
      fail('COMPILE_SCOPE_FORBIDDEN','Compilation scope or purpose is unavailable',403);
    if(input.proposal.outcome!=='proposed'||!input.proposal.drafts.length)
      fail('COMPILE_PROPOSAL_REQUIRED','Only proposed drafts can enter candidate stage');
    if(!input.methodVersion.trim()||/synthetic/i.test(input.methodVersion)||!Number.isFinite(Date.parse(input.createdAt)))
      fail('COMPILE_METHOD_INVALID','Real compilation needs its own method and creation time');
    const evidence=checkedEvidence(context,input),proofs=localProofs(context,input);
    const repairTarget=input.request.repairTarget??null;
    const repairEvidence=[...evidence.values()].filter(item=>item.role==='repair_target');
    if(repairTarget?(repairEvidence.length!==1||refKey(repairEvidence[0].ref)!==refKey(repairTarget)||
      repairEvidence[0].ref.contentDigest!==repairTarget.contentDigest):repairEvidence.length)
      fail('COMPILE_REPAIR_TARGET_INVALID','A repair target must be the one exact comparison-only input of a repair');
    const seenObjects=new Set<string>();
    const changes:KnowledgeChangeSet['changes']=[],baseHeads:KnowledgeChangeSet['baseHeads']=[];
    const neededSources=new Map<string,KnowledgeRef>();
    const needSource=(ref:KnowledgeRef)=>{
      const key=sourceKey(ref),prior=neededSources.get(key);
      if(ref.domain!=='source'||prior?.contentDigest&&ref.contentDigest&&prior.contentDigest!==ref.contentDigest)assurance();
      neededSources.set(key,prior?.contentDigest?prior:ref);
    };
    const requireLineage=async(item:WikiCompileStageInput['evidence'][number])=>{
      const metadata=await store.inspectFrozen?.(context.scope.projectId,version(item.ref));
      if(metadata&&!metadata.validity.valid&&metadata.validity.issues.some(issue=>issue.domain!=='knowledge'))assurance();
      if(!metadata?.published||!metadata.current||!metadata.validity.valid||metadata.spaceId!==context.scope.spaceId||
        metadata.storageDigest!==item.storageDigest)
        fail('COMPILE_WIKI_BASIS_INVALID','Frozen supporting Wiki is no longer current and valid',409);
      if(!metadata.criticalSourcesComplete)assurance();
      for(const dep of metadata.criticalSources){
        if(dep.domain!=='source')assurance();
        const proof=[...proofs.values()].find(value=>refKey(value.sourceRef)===refKey(dep.ref));
        if(proof)needSource(proof.sourceRef);
        else needSource({...context.scope,domain:'source',...dep.ref,contentDigest:null});
      }
    };
    // The repair target only has to remain the unchanged current head; its invalid lineage is what the repair replaces.
    const requireRepairBase=async(item:WikiCompileStageInput['evidence'][number])=>{
      const metadata=await store.inspectFrozen?.(context.scope.projectId,version(item.ref));
      if(!metadata?.published||!metadata.current||metadata.spaceId!==context.scope.spaceId||metadata.storageDigest!==item.storageDigest)
        fail('COMPILE_BASE_HEAD_CHANGED','The repair target is no longer the unchanged current page',409);
    };
    for(const [index,draft] of input.proposal.drafts.entries()){
      const profile=getWikiPageProfile(draft.profile.id,draft.profile.version);
      if(!profile||wikiPageProfileFingerprint(profile)!==draft.profile.digest)
        fail('COMPILE_PROFILE_INVALID','Draft profile differs from the registered exact profile');
      if(new Set(draft.supportEvidenceIds).size!==draft.supportEvidenceIds.length||
        draft.supportEvidenceIds.some(id=>!evidence.has(id)||evidence.get(id)!.role==='repair_target'))
        fail('COMPILE_SUPPORT_UNREAD','Draft support must name distinct evidence in the exact readset');
      const selected=draft.supportEvidenceIds.map(id=>evidence.get(id)!);
      const target=draft.targetEvidenceId?evidence.get(draft.targetEvidenceId):undefined;
      if(draft.targetEvidenceId&&(!target||target.kind!=='wiki_page'))
        fail('COMPILE_TARGET_UNREAD','Update target must be a Wiki in the exact readset');
      const old=target?input.bases.get(target.id):undefined;
      if(old&&old.kind!=='wiki_page')fail('COMPILE_TARGET_UNREAD','Update target must be a Wiki page');
      if(old&&(old.content.profile.id!==draft.profile.id||old.content.profile.version!==draft.profile.version||
        old.content.identity.key!==draft.identityKey))
        fail('COMPILE_IDENTITY_CHANGED','An update cannot change its profile or identity key',409);
      const repairing=target?.role==='repair_target';
      if(repairing!==(!!draft.repair)||repairTarget&&!repairing)
        fail('COMPILE_REPAIR_TARGET_INVALID','Only the repair draft revises the comparison-only target with explicit dispositions');
      if(target)await (repairing?requireRepairBase(target):requireLineage(target));
      const current=await matchingCurrent(pool,context,draft);
      if(old){
        if(!current||current.object_id!==old.ref.objectId||current.version_id!==old.ref.versionId)
          fail('COMPILE_BASE_HEAD_CHANGED','The exact update target is no longer the current page',409);
      }else if(current)fail('COMPILE_IDENTITY_CONFLICT','A current page already has this exact profile and identity key',409);
      const objectId=old?.ref.objectId??stableUuid(canonical({projectId:context.scope.projectId,spaceId:context.scope.spaceId,
        profile:draft.profile.id,profileVersion:draft.profile.version,identityKey:draft.identityKey.normalize('NFKC')}));
      if(seenObjects.has(objectId))fail('COMPILE_DUPLICATE_TARGET','One candidate cannot change a page twice',409);
      seenObjects.add(objectId);
      if(!old&&(await store.head(context.scope.projectId,objectId)))
        fail('COMPILE_IDENTITY_CONFLICT','Stable page ID is already occupied',409);
      const ref={objectId,versionId:stableUuid(canonical({operationId:input.operationId,index,draft}))};
      const repaired=old&&draft.repair?repairedBasis(old,draft.repair,evidence,objectId):null;
      const inherited=repaired?repaired.dependencies:old?.dependencies.filter(dep=>dep.domain!=='knowledge'||dep.ref.objectId!==objectId)??[];
      const oldCitations=repaired?repaired.citations:old?.content.citations??[];
      if(inherited.some(unsupported)||oldCitations.some(c=>c.kind==='media'||c.sourceDomain&&c.sourceDomain!=='source'))
        assurance();
      const selectedDeps:Dependency[]=selected.map(item=>({domain:item.kind==='wiki_page'?'knowledge':'source',ref:version(item.ref),
        role:'derived_from',critical:true}));
      const dependencies=uniqueDeps([...inherited,...selectedDeps.filter(dep=>dep.domain!=='knowledge'||dep.ref.objectId!==objectId)]);
      const citations=[...oldCitations,...selected.filter(item=>item.kind==='source_content').map(item=>({
        kind:'source' as const,sourceRef:version(item.ref),sourceDomain:'source' as const,locator:item.locator,
        supports:draft.rationale}))];
      const uniqueCitations=[...new Map(citations.map(c=>[canonical(c),c])).values()];
      const content=WikiPageContentSchema.parse({schemaVersion:'1.0',profile:{id:profile.id,version:profile.version},
        identity:{key:draft.identityKey,aliases:old?.content.identity.aliases??[]},summary:draft.summary,
        conditions:draft.conditions,counterexamples:draft.counterexamples,unknowns:draft.unknowns,
        nextQuestions:draft.nextQuestions,citations:uniqueCitations,navigation:repaired?repaired.navigation:old?.content.navigation??[]});
      const frozenDeps=wikiPageFrozenDependencies({content,dependencies});
      if(frozenDeps.some(unsupported))assurance();
      for(const dep of frozenDeps.filter(dep=>dep.domain==='source'&&dep.critical)){
        const match=[...evidence.values()].find(item=>item.kind==='source_content'&&refKey(item.ref)===refKey(dep.ref));
        if(match)needSource(match.ref);
        else{
          const proof=[...proofs.values()].find(item=>refKey(item.sourceRef)===refKey(dep.ref));
          if(proof)needSource(proof.sourceRef);
          else needSource({...context.scope,domain:'source',...dep.ref,contentDigest:null});
        }
      }
      for(const item of selected.filter(item=>item.kind==='wiki_page')){
        await requireLineage(item);
      }
      const base:KnowledgeRevision={kind:'wiki_page',ref,projectId:context.scope.projectId,title:draft.title,body:draft.summary,
        content,scope:{applicability:old?.scope.applicability??{productVersionRefs:[],platforms:[],markets:[],languages:[],
          audiences:[],goals:[],requiredProduction:[],transferRationale:null},
          limitations:[...new Set([...(old?.scope.limitations??[]),'编纂候选：语义、来源和适用范围尚待独立审阅。'])],
          unknowns:[...new Set([...(old?.scope.unknowns??[]),...draft.unknowns])],
          reviewDueAt:draft.repair?.reviewDue.action==='set'?draft.repair.reviewDue.until:draft.repair?.reviewDue.action==='clear'?null:old?.scope.reviewDueAt??null},
        dependencies:frozenDeps,sourceGroups:sourceGroups(selected,old),artifactRef:null,createdAt:input.createdAt,analysisQuality:null};
      const revision:KnowledgeRevision={...base,binding:{bindingKind:'wiki_page',spaceId:context.scope.spaceId,
        specificationId:'wiki-compile-stage',specificationVersion:'1',contentVersion:'wiki_page/1.0',
        methodVersion:input.methodVersion,policyVersion:'knowledge-independent-review-v1',
        inputFingerprint:wikiPageInputFingerprint(base),readsetFingerprint:wikiPageReadsetFingerprint(base),
        profileFingerprint:wikiPageProfileFingerprint(profile)}};
      KnowledgeRevisionSchema.parse(revision);
      if(!matchesWikiPageFrozenBinding(revision))fail('COMPILE_BINDING_INVALID','Frozen Wiki binding is inconsistent');
      changes.push({revision,effect:old?'correct':'create',explanation:draft.rationale});
      baseHeads.push({objectId,versionId:old?.ref.versionId??null});
    }
    const validity=await store.validate(context.scope.projectId,
      changes.flatMap(item=>item.revision.dependencies.filter(dep=>dep.critical)));
    if(!validity.valid){
      if(validity.issues.some(issue=>issue.domain!=='knowledge'))assurance();
      fail('COMPILE_WIKI_BASIS_INVALID','A supporting knowledge version became invalid',409);
    }
    // Refresh only necessary local proofs immediately before the short validation transaction.
    // A changed generation, owner, digest or identity is a new input, never a renewal.
    for(const ref of [...neededSources.values()]){
      const original=proofs.get(sourceKey(ref));
      if(original&&ref.contentDigest&&original.sourceRef.contentDigest!==ref.contentDigest)assurance();
      if(!sources){if(!original)assurance();continue;}
      let fresh:SourceAccessProof;
      try{fresh=SourceAccessProofSchema.parse(await sources.proof(context,original?.sourceRef??ref));}
      catch{return assurance();}
      if(fresh.assurance!=='local_transaction'||fresh.sourceRef.domain!=='source'||
        refKey(fresh.sourceRef)!==refKey(ref)||!fresh.sourceRef.contentDigest||
        ref.contentDigest!==null&&fresh.sourceRef.contentDigest!==ref.contentDigest||
        fresh.digest!==fresh.sourceRef.contentDigest||fresh.subject!==context.principal.id||
        fresh.purpose!==context.purpose||fresh.audience!=='knowledge-publication'||
        original&&(canonical(fresh.sourceRef)!==canonical(original.sourceRef)||fresh.digest!==original.digest||
          fresh.ownerGeneration!==original.ownerGeneration||fresh.ownerId!==original.ownerId||
          fresh.subject!==original.subject||fresh.purpose!==original.purpose||fresh.audience!==original.audience||
          Date.parse(fresh.validUntil)<Date.parse(original.validUntil)))assurance();
      proofs.set(sourceKey(fresh.sourceRef),fresh);neededSources.set(sourceKey(ref),fresh.sourceRef);
    }
    // This short transaction validates current local rights and writer authority. It ends before
    // store.stage starts its own project-locked transaction; review must recheck before publication.
    const client=await pool.connect();
    try{await client.query('BEGIN');
      await assertKnowledgeWriterAuthority(client,context.scope.projectId,grant);
      for(const ref of neededSources.values())try{await assertLocalSourceProof(client,context,proofs.get(sourceKey(ref))!);}catch{assurance();}
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    const hashInput={projectId:context.scope.projectId,requestKey:`wiki-compile:${input.operationId}`,
      purpose:context.purpose,proposer:context.principal.id,rationale:input.proposal.reason,
      methodVersion:input.methodVersion,cost:input.cost.money.state==='known'?{
        state:'known' as const,amount:input.cost.money.amount,currency:input.cost.money.currency}:{
        state:'unknown' as const,reason:input.cost.money.reason},baseHeads,changes};
    const change:KnowledgeChangeSet={...hashInput,id:input.operationId,
      requestHash:wikiCompileStageRequestHash(input),
      contentHash:digest(hashInput),inputManifest:uniqueDeps(changes.flatMap(item=>item.revision.dependencies)),createdAt:input.createdAt};
    let staged:KnowledgeChangeSet;
    try{staged=await store.stage(change);}catch(error){
      // Store's transaction wrapper cannot distinguish an action error from a lost COMMIT
      // acknowledgement. Reconcile this exact operation before classifying the outcome.
      let found:KnowledgeChangeSet|null;
      try{found=await store.getChangeSet(context.scope.projectId,input.operationId);}
      catch{throw new WikiCompileCommitUnknownError(input.operationId);}
      if(found){
        if(found.id!==change.id||found.requestKey!==change.requestKey||found.requestHash!==change.requestHash||
          found.contentHash!==change.contentHash)
          fail('COMPILE_STAGE_CONFLICT','Operation ID is bound to another staged candidate',409);
        staged=found;
      }else if(error instanceof KnowledgeError)throw error;
      else throw new WikiCompileCommitUnknownError(input.operationId);
    }
    return candidateReceipt(context,staged);
  },async lookup(context,operationId,requestHash){
    assertLookupContext(context);IdSchema.parse(operationId);Sha256Schema.parse(requestHash);
    let row:{request_key:string;request_hash:string;content_hash:string;payload:KnowledgeChangeSet|null;published:boolean}|undefined;
    try{row=(await pool.query<NonNullable<typeof row>>(`SELECT request_key,request_hash,content_hash,
      CASE WHEN octet_length(payload::text)<=3000000 THEN payload ELSE NULL END AS payload,
      EXISTS(SELECT 1 FROM ccl_knowledge_publications p
        WHERE p.project_id=c.project_id AND p.changeset_id=c.id) AS published
      FROM ccl_knowledge_changesets c WHERE c.project_id=$1 AND c.id=$2`,
      [context.scope.projectId,operationId])).rows[0];}
    catch{throw new WikiCompileCommitUnknownError(operationId);}
    if(!row)return null;
    const change=row.payload;
    if(!change)fail('COMPILE_STAGE_LOOKUP_TOO_LARGE','Candidate exceeds the bounded lookup size',409);
    if(row.request_key!==`wiki-compile:${operationId}`||change.requestKey!==row.request_key||
      row.request_hash!==requestHash||change.requestHash!==requestHash||
      row.content_hash!==change.contentHash||change.id!==operationId||
      change.projectId!==context.scope.projectId||change.proposer!==context.principal.id||
      change.purpose!==context.purpose||change.changes.length<1||change.changes.length>5||row.published)
      fail('COMPILE_STAGE_LOOKUP_MISMATCH','Staged candidate does not match this operation and scope',409);
    const {id:_,requestHash:__,contentHash:___,inputManifest:____,createdAt:_____,...hashInput}=change;
    if(digest(hashInput)!==change.contentHash||change.changes.some(item=>item.revision.kind!=='wiki_page'||
      item.revision.projectId!==context.scope.projectId||!item.revision.binding||
      !('bindingKind' in item.revision.binding)||item.revision.binding.bindingKind!=='wiki_page'||
      item.revision.binding.spaceId!==context.scope.spaceId||item.revision.binding.methodVersion!==change.methodVersion||
      item.revision.binding.specificationId!=='wiki-compile-stage'||
      item.revision.binding.specificationVersion!=='1'||
      !matchesWikiPageFrozenBinding(item.revision)))
      fail('COMPILE_STAGE_LOOKUP_MISMATCH','Candidate binding or content hash is invalid',409);
    return candidateReceipt(context,change);
  }};
}
