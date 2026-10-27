import { randomUUID } from 'node:crypto';
import { AnalysisAdoptionRecordSchema, AnalysisContextSnapshotSchema, AnalysisResultSchema, CaseAnalysisLinkSchema, EvidenceAnchorSchema, ObjectRefSchema, type AnalysisReadPort, type AnalysisResult, type Citation, type EvidenceAnchor, type MediaScope, type ResearchSourceProjection, type VerifiedResearchEvidenceEntry, type VersionRef } from '../../contracts/src/index.ts';
import type { PoolClient } from 'pg';
import { evaluateScopedUse, ScopedUseDecisionSchema, type ScopedUseDecisionStore } from './admission.ts';
import { KnowledgeError, type Applicability, type ArtifactWritePort, type Dependency, type EvidenceReadPort, type KnowledgeChangeSet, type KnowledgeReview, type KnowledgeRevision, type KnowledgeScope, type KnowledgeStore, type RegisteredSource, type SourceReadPort } from './types.ts';
import { applicablePlatforms,platformOfAnalysis } from './platform-applicability.ts';
import { ProposeChangeSchema, RegisteredSourceSchema, ReviewInputSchema, type ProposeChange } from './schemas.ts';
import { canonical, citationsOf, digest, refKey, sameRef, uniqueDeps } from './utils.ts';
import { createResearchSourceProjection } from './research-projection.ts';
import { validateSourceRecordRef } from './source-record.ts';
import { validateCaseFieldReadingRef } from './case-field-reading.ts';
import { validateCaseFactRef } from './case-fact.ts';
import { navigationWikiScope, renderNavigationWiki } from './navigation-wiki.ts';
import { getWikiPageProfile, matchesWikiPageFrozenBinding } from './wiki-page.ts';
import type { PublicationAuthorityScopeV1, PublicationScopeFacts } from './wiki-publication-authority.ts';

export interface KnowledgeReviewPolicy {
  version: string;
  review(change: KnowledgeChangeSet, signal?: AbortSignal): Promise<Pick<KnowledgeReview, 'reviewer' | 'decision' | 'rationale'>>;
}
export interface KnowledgeServiceOptions {
  store: KnowledgeStore; analysis: AnalysisReadPort; sources?: SourceReadPort;
  scopedUseDecisions?: ScopedUseDecisionStore;
  artifacts?: ArtifactWritePort; evidence?: EvidenceReadPort; reviewPolicy?: KnowledgeReviewPolicy; now?: () => Date;
  archiveThresholdBytes?: number;
  sourceProjectionReader?: {readPayload(projectId:string,result:AnalysisResult):Promise<unknown>;
    readEvidenceCatalog?(projectId:string,result:AnalysisResult):Promise<readonly VerifiedResearchEvidenceEntry[]>};
}
export function createKnowledgeService(options: KnowledgeServiceOptions) {
  const now = () => (options.now?.() ?? new Date()).toISOString();
  function assertSourcePurpose(change:Pick<KnowledgeChangeSet,'purpose'|'changes'>) {
    if(change.changes.some(c=>c.revision.kind==='case'&&c.revision.content.schemaVersion==='1.1')&&change.purpose!=='exploration_reading')
      throw new KnowledgeError('SOURCE_CASE_EXPLORATION_ONLY','Source registration is exploration reading only',422);
  }
  async function assertNavigationChange(change:Pick<KnowledgeChangeSet,'projectId'|'purpose'|'changes'>):Promise<boolean> {
    const siblings=new Map(change.changes.map(item=>[refKey(item.revision.ref),item.revision]));
    let hasNavigation=false;
    for(const item of change.changes) {
      const revision=item.revision;
      if(revision.kind!=='wiki'||!revision.content.navigationOnly)continue;
      hasNavigation=true;
      if(change.purpose!=='exploration_reading')
        throw new KnowledgeError('NAVIGATION_PURPOSE_REQUIRED','Navigation-only Wikis require exploration_reading purpose',422);
      if(item.effect==='withdraw')continue;
      const metadata=revision.content.navigation;
      if(!metadata||revision.body!==renderNavigationWiki(metadata)||
        canonical(revision.scope)!==canonical(navigationWikiScope()))
        throw new KnowledgeError('NAVIGATION_CONTENT_INVALID','Navigation-only Wiki body and scope must match the shared deterministic renderer',422);
      if(revision.sourceGroups.length)
        throw new KnowledgeError('NAVIGATION_SOURCE_GROUPS_INVALID','Navigation-only Wiki cannot inherit independent source groups',422);
      for(const page of metadata.recentPages) {
        const sibling=siblings.get(refKey(page.ref));
        const view=sibling?null:await options.store.get(change.projectId,page.ref);
        const target=sibling??view?.revision;
        if(target?.kind!=='wiki'||target.content.navigationOnly||target.title!==page.title||
          (!sibling&&(!view?.published||!view.current||!view.validity.valid||
            view.review?.purpose!=='exploration_reading'||
            !['exploration_only','approved_for_purpose'].includes(view.review.decision))))
          throw new KnowledgeError('NAVIGATION_PAGE_INVALID','Navigation entries must name exact current reviewed research pages',422);
      }
    }
    return hasNavigation;
  }
  async function assertNavigationReview(change:KnowledgeChangeSet):Promise<void> {
    if(!await assertNavigationChange(change))return;
    const first=await options.store.get(change.projectId,change.changes[0].revision.ref);
    if(first?.review?.decision==='approved_for_purpose')
      throw new KnowledgeError('NAVIGATION_EXPLORATION_ONLY','Navigation-only Wikis cannot be approved for production purpose',422);
  }
  async function source(projectId: string, ref: VersionRef): Promise<RegisteredSource> {
    const raw = await options.sources?.getSource(projectId, ref);
    if (!raw) throw new KnowledgeError('SOURCE_NOT_FOUND', 'Independent source version is unavailable', 422);
    const value = RegisteredSourceSchema.parse(raw);
    if (value.projectId !== projectId || !sameRef(value.ref, ref)) throw new KnowledgeError('SOURCE_MISMATCH', 'Source port returned a different project or version', 422);
    if (!value.valid || (value.reviewDueAt && Date.parse(value.reviewDueAt) <= Date.parse(now()))) throw new KnowledgeError('SOURCE_INVALID', 'Source needs revalidation');
    return value;
  }
  async function analysis(projectId: string, ref: VersionRef) {
    const raw = await options.analysis.getResult(projectId, ref);
    if (!raw) throw new KnowledgeError('ANALYSIS_NOT_FOUND', 'Exact registered analysis result not found', 422);
    const result = AnalysisResultSchema.parse(raw);
    if (result.projectId !== projectId || !sameRef(result.ref, ref)) throw new KnowledgeError('ANALYSIS_MISMATCH', 'Analysis port returned another project or revision', 422);
    const rawSnapshot = await options.analysis.getContextSnapshot(projectId, result.contextSnapshotId);
    if (!rawSnapshot) throw new KnowledgeError('CONTEXT_NOT_FOUND', 'Exact context snapshot not found', 422);
    const snapshot = AnalysisContextSnapshotSchema.parse(rawSnapshot);
    if (snapshot.projectId !== projectId || snapshot.ref.versionId !== result.contextSnapshotId || snapshot.assetVersionId !== result.assetVersionId)
      throw new KnowledgeError('CONTEXT_MISMATCH', 'Analysis context identity differs', 422);
    if (snapshot.durationMs !== null && result.evidence.some(e=>e.scope.kind === 'segment' && e.scope.endMs > snapshot.durationMs!))
      throw new KnowledgeError('ANCHOR_OUT_OF_RANGE', 'Evidence exceeds media duration', 422);
    return { result, snapshot };
  }
  async function revalidate(projectId: string, dependencies: Dependency[], purpose?: string, policy?:{allowExplorationKnowledge?:boolean}, claimRef?:VersionRef) {
    const critical = dependencies.filter(d=>d.critical);
    const validity = await options.store.validate(projectId, critical);
    if (!validity.valid) throw new KnowledgeError('DEPENDENCY_INVALID', validity.issues.map(i=>i.reason).join('; '));
    // Re-read source and result identities. Source owners must also deliver invalidation events
    // to the knowledge barrier; signed URL expiry is not such an event.
    for (const dep of critical) {
      if (dep.domain === 'analysis') {
        const {result,snapshot}=await analysis(projectId, dep.ref);
        if(dep.useScope?.claimRef && (!claimRef || !sameRef(dep.useScope.claimRef,claimRef)))
          throw new KnowledgeError('ANALYSIS_CLAIM_MISMATCH','Analysis use names a Claim other than the Claim being validated',422);
        const useScope=dep.useScope && claimRef?{...dep.useScope,claimRef}:dep.useScope;
        if (purpose) {
          if(useScope) {
            const requested=useScope.mediaScope;
            if(useScope.channels.some(channel=>!result.coverage.channels.includes(channel))) throw new KnowledgeError('ANALYSIS_CHANNEL_UNOBSERVED','Requested use includes a channel absent from the exact report coverage');
            if(!mediaContains(result.coverage.requested,requested)) throw new KnowledgeError('ANALYSIS_SCOPE_OUTSIDE_REQUEST','Requested use exceeds the report request range');
            if(useScope.anchor && (!result.evidence.some(anchor=>canonical(anchor)===canonical(useScope.anchor)) || !mediaContains(useScope.anchor.scope,requested)))
              throw new KnowledgeError('ANALYSIS_ANCHOR_UNREGISTERED','Requested use is outside its exact registered evidence anchor');
            const exploration=purpose==='exploration_reading';
            if(!exploration || requested.kind==='segment') {
              if(!observedCovers(result.coverage.observed,requested,snapshot.durationMs)) throw new KnowledgeError('ANALYSIS_SCOPE_UNOBSERVED','Requested use includes seconds not observed by the exact report');
            } else if(!result.coverage.observed.length) throw new KnowledgeError('ANALYSIS_SCOPE_UNOBSERVED','Exploration still requires some observed coverage');
          }
          const getter = options.analysis.getCurrentAdoption;
          const raw = getter ? await getter.call(options.analysis,projectId,dep.ref,purpose) : null;
          const record = raw ? AnalysisAdoptionRecordSchema.parse(raw) : null;
          if (record && (!sameRef(record.analysisResultRef,dep.ref) || record.purpose!==purpose)) throw new KnowledgeError('ADOPTION_MISMATCH','Adoption record belongs to another result or purpose',422);
          if(record?.decision==='rejected') throw new KnowledgeError('ANALYSIS_REJECTED','This report is rejected for the requested purpose');
          const exploration=purpose==='exploration_reading';
          if(!record || record.decision!=='approved') {
            if(!exploration) throw new KnowledgeError('ANALYSIS_NOT_ADOPTED','Current independent report adoption is required for this purpose');
          }
          if(!useScope) {
            if(!exploration) throw new KnowledgeError('ANALYSIS_SCOPE_REQUIRED','Production use must identify covered channels and media seconds');
            const records=(await options.scopedUseDecisions?.current(projectId,dep.ref,purpose) ?? []).map(raw=>ScopedUseDecisionSchema.parse(raw));
            if(records.some(row=>row.projectId!==projectId || !sameRef(row.reportRef,dep.ref) || row.purpose!==purpose)) throw new KnowledgeError('SCOPED_USE_MISMATCH','Scoped decision belongs to another report or purpose',422);
            if(records.some(row=>row.decision==='rejected')) throw new KnowledgeError('SCOPED_USE_REJECTED','An unscoped exploration use cannot exclude a rejected channel or segment');
          }
          if(useScope) {
            const records=(await options.scopedUseDecisions?.current(projectId,dep.ref,purpose) ?? []).map(raw=>ScopedUseDecisionSchema.parse(raw));
            if(records.some(row=>row.projectId!==projectId || !sameRef(row.reportRef,dep.ref) || row.purpose!==purpose)) throw new KnowledgeError('SCOPED_USE_MISMATCH','Scoped decision belongs to another report or purpose',422);
            const decision=evaluateScopedUse(records,useScope,exploration);
            if(decision==='rejected') throw new KnowledgeError('SCOPED_USE_REJECTED','A channel or segment is rejected for this purpose');
            if(decision==='unknown' && !exploration || decision==='exploration_only' && !exploration) throw new KnowledgeError('SCOPED_USE_NOT_APPROVED','Exact channel and segment approval is required');
          }
        }
      }
      if (dep.domain === 'source') await source(projectId, dep.ref);
      if (dep.domain === 'knowledge') {
        const view = await options.store.get(projectId, dep.ref);
        if (!view?.published || !view.validity.valid || !view.current) throw new KnowledgeError('DEPENDENCY_INVALID', 'Knowledge dependency is not current and valid');
        if (purpose && (view.review?.purpose !== purpose || view.review.decision !== 'approved_for_purpose' && !(policy?.allowExplorationKnowledge && view.review.decision === 'exploration_only')))
          throw new KnowledgeError('DEPENDENCY_NOT_ADOPTED', 'Every supporting knowledge version must be independently adopted for this purpose');
        // Exact transitive external dependencies are rechecked, not only indexed state.
        await revalidate(projectId, view.revision.dependencies, purpose, policy, view.revision.kind==='claim'?view.revision.ref:claimRef);
      }
    }
  }
  async function revalidateChanges(projectId:string,changes:Array<{effect:string;revision:KnowledgeRevision}>,purpose?:string,policy?:{allowExplorationKnowledge?:boolean}) {
    const own=new Map(changes.filter(change=>change.effect!=='withdraw').map(change=>[refKey(change.revision.ref),change.revision]));
    async function walk(revision:KnowledgeRevision,claimRef:VersionRef|undefined,path:Set<string>):Promise<void> {
      const key=refKey(revision.ref);
      if(path.has(key)) throw new KnowledgeError('DEPENDENCY_CYCLE','Staged knowledge dependencies form a cycle',422);
      const nextPath=new Set(path);nextPath.add(key);
      const activeClaim=revision.kind==='claim'?revision.ref:claimRef;
      const external=revision.dependencies.filter(dep=>dep.domain!=='knowledge'||!own.has(refKey(dep.ref)));
      await revalidate(projectId,external,purpose,policy,activeClaim);
      for(const dep of revision.dependencies.filter(dep=>dep.domain==='knowledge'&&dep.critical&&own.has(refKey(dep.ref))))
        await walk(own.get(refKey(dep.ref))!,activeClaim,nextPath);
    }
    for(const change of changes) {
      if(change.effect==='withdraw') continue;
      await walk(change.revision,undefined,new Set());
    }
  }
  async function normalizeRevision(rev: KnowledgeRevision, staged: Map<string, KnowledgeRevision>): Promise<KnowledgeRevision> {
    if(rev.kind==='wiki_page') {
      const profile=getWikiPageProfile(rev.content.profile.id,rev.content.profile.version);
      if(!profile)throw new KnowledgeError('WIKI_PAGE_PROFILE_UNKNOWN','Wiki page profile is not registered',422);
      // An object-level basis is valid without fabricating finer media anchors.
      // Its exact identity and availability are still checked by the readers below.
      if(!rev.content.citations.length && !rev.dependencies.some(dep=>dep.critical&&
        (dep.domain==='source'||dep.domain==='analysis'||dep.domain==='knowledge')))
        throw new KnowledgeError('WIKI_PAGE_BASIS_REQUIRED','Page needs accurate citations or a critical exact source, analysis, or knowledge basis',422);
    }
    let dependencies: Dependency[] = [];
    const groups = new Set<string>();
    const selectedAnalyses: AnalysisResult[] = [];
    const resolveKnowledge = async (ref: VersionRef, critical = true, role:Dependency['role']=critical?'derived_from':'uses') => {
      const sibling = staged.get(refKey(ref));
      const view = sibling ? null : await options.store.get(rev.projectId, ref);
      const target = sibling ?? view?.revision;
      if (!target || target.projectId !== rev.projectId || (!sibling && !view?.published)) throw new KnowledgeError('KNOWLEDGE_NOT_FOUND', 'Referenced knowledge version is unavailable', 422);
      if (critical && !sibling && (!view?.validity.valid || !view.current)) throw new KnowledgeError('KNOWLEDGE_NOT_FOUND','Critical referenced version is not currently usable',422);
      dependencies.push({ domain:'knowledge', ref, role, critical });
      target.sourceGroups.forEach(g=>groups.add(g));
      return target;
    };
    const linked: KnowledgeRevision[] = [];
    // Explicit links remain auditable. A critical exact knowledge dependency can
    // also authenticate a citation inherited from that version.
    for (const dep of rev.dependencies) {
      if (dep.domain === 'knowledge') { const target=await resolveKnowledge(dep.ref,dep.critical,dep.role);
        if(dep.critical)linked.push(target); }
      else if (dep.domain === 'source') { const s = await source(rev.projectId, dep.ref); groups.add(s.sourceGroup); }
      else if (dep.domain === 'analysis') { const a = await analysis(rev.projectId, dep.ref); selectedAnalyses.push(a.result); groups.add(`media-sha256:${a.snapshot.original.sha256}`); }
      dependencies.push(dep);
    }
    let analysisResult: AnalysisResult | null = null;
    if (rev.kind === 'case') {
      const {result, snapshot} = await analysis(rev.projectId, rev.content.analysisResultRef);
      CaseAnalysisLinkSchema.parse({ analysisResult:result, caseVersion:rev.content });
      if(rev.content.schemaVersion==='1.1') {
        const projection=rev.content.sourceProjection;
        if(!projection)throw new KnowledgeError('CASE_SOURCE_PROJECTION_REQUIRED','Registered source Case needs its exact projection',422);
        if(!options.sourceProjectionReader)throw new KnowledgeError('SOURCE_PROJECTION_READER_REQUIRED','Exact original payload reader is required',503);
        const expected=createResearchSourceProjection({result,payload:await options.sourceProjectionReader.readPayload(rev.projectId,result),
          sourceGroup:`media-sha256:${snapshot.original.sha256}`,
          ...(Object.hasOwn(projection.source,'platform')?{platform:snapshot.original.mimeType.startsWith('video/')?platformOfAnalysis(snapshot):'unknown' as const}:{}),
          ...(Object.hasOwn(projection.source,'contentType')?{contentType:snapshot.original.mimeType.startsWith('video/')?'video' as const:snapshot.original.mimeType.startsWith('image/')?'image_post' as const:'unknown' as const}:{}),
          registeredEvidence:await options.sourceProjectionReader.readEvidenceCatalog?.(rev.projectId,result)});
        if(canonical(expected)!==canonical(projection))throw new KnowledgeError('CASE_SOURCE_PROJECTION_MISMATCH','Source fields must exactly match original payload and evidence catalog',422);
        if(projection.source.platform!==undefined&&
          canonical(rev.scope.applicability.platforms)!==canonical([projection.source.platform]))
          throw new KnowledgeError('CASE_PLATFORM_SCOPE_MISMATCH','Registered Case platform must match the exact source snapshot',422);
      }
      if (rev.content.schemaVersion!=='1.1'&&!rev.content.citations.some(c=>c.kind==='media')) throw new KnowledgeError('CASE_MEDIA_REQUIRED', 'A video case requires a registered media anchor', 422);
      analysisResult = result;
      selectedAnalyses.push(result);
      const mediaUses=rev.content.citations.filter(c=>c.kind==='media').map(c=>({domain:'analysis' as const,ref:result.ref,role:'derived_from' as const,critical:true,
        ...(result.coverage.channels.length?{useScope:{anchor:c.anchor,channels:result.coverage.channels,mediaScope:c.anchor.scope}}:{})}));
      if(rev.content.schemaVersion==='1.1')dependencies.push({domain:'analysis',ref:result.ref,role:'derived_from',critical:true});
      dependencies.push(...mediaUses, {domain:'context',ref:snapshot.ref,role:'uses',critical:true});
      groups.add(`media-sha256:${snapshot.original.sha256}`);
      rev = { ...rev, analysisQuality:result.quality, scope:{...rev.scope, limitations:[...new Set([...rev.scope.limitations, `仅覆盖 ${result.coverage.channels.join('/')} 通道；${result.profile} 结果不证明商业效果`, '同源去重目前依据原片 SHA-256；剪辑变体或共同作者关系仍需来源核查'])], unknowns:[...new Set([...rev.scope.unknowns,...result.coverage.gaps,...snapshot.unknowns])]} };
    }
    const checkBasis=(target:KnowledgeRevision,item:{evidenceBasis?:string;sourceRecordRefs?:import('./source-record.ts').SourceRecordRef[];caseFieldReadingRef?:import('./case-field-reading.ts').CaseFieldReadingRef;caseFactRefs?:import('./case-fact.ts').CaseFactRef[]})=>{
      if(target.kind!=='case')throw new KnowledgeError('INVALID_MEMBER','Comparison inputs must be exact Cases',422);
      if(item.evidenceBasis==='source_record'&&(!item.sourceRecordRefs?.length||item.sourceRecordRefs.some(record=>!validateSourceRecordRef({ref:target.ref,sourceProjection:target.content.sourceProjection},record))))
        throw new KnowledgeError('SOURCE_RECORD_MISMATCH','Source basis must match complete original Case records',422);
      if(item.evidenceBasis==='case_field_reading'&&(!item.caseFieldReadingRef||!validateCaseFieldReadingRef(target,item.caseFieldReadingRef)))
        throw new KnowledgeError('CASE_FIELD_READING_MISMATCH','Field reading must match exact source scope',422);
      if(item.evidenceBasis==='case_metadata'&&(!item.caseFactRefs?.length||item.caseFactRefs.some(f=>!validateCaseFactRef({ref:target.ref,sourceProjection:target.content.sourceProjection},f))))
        throw new KnowledgeError('CASE_FACT_MISMATCH','Metadata basis must match original boundary facts',422);
    };
    if (rev.kind === 'collection') for (const member of rev.content.members) {
      const target=await resolveKnowledge(member.ref,!!member.evidenceBasis);checkBasis(target,member);linked.push(target);
    }
    if (rev.kind === 'comparison') {
      const collection=await resolveKnowledge(rev.content.collectionRef);
      if(collection.kind!=='collection') throw new KnowledgeError('INVALID_COLLECTION','Comparison requires a collection',422);
      for(const dimension of rev.content.dimensions) for(const o of dimension.observations) {
        if(!collection.content.members.some(m=>sameRef(m.ref,o.memberRef))) throw new KnowledgeError('NOT_IN_COLLECTION','Comparison member is outside frozen collection',422);
        const target=await resolveKnowledge(o.memberRef);checkBasis(target,o);linked.push(target);
      }
      for(const finding of rev.content.crossCaseFindings??[]) {
        if(new Set(finding.memberRefs.map(refKey)).size<2||finding.memberRefs.some(ref=>!collection.content.members.some(m=>sameRef(m.ref,ref))))
          throw new KnowledgeError('CROSS_CASE_MEMBERS_INVALID','Descriptive findings require distinct exact Collection members',422);
      }
      if(rev.content.cognition) for(const finding of rev.content.cognition.findings) for(const basis of finding.basis) {
        const target=linked.find(r=>sameRef(r.ref,basis.caseRef));
        const observation=rev.content.dimensions.flatMap(d=>d.observations).some(o=>sameRef(o.memberRef,basis.caseRef)&&o.sourceRecordRefs?.some(record=>
          record.fieldPath===basis.fieldPath&&record.recordPointer===basis.recordPointer));
        if(!target||!observation)throw new KnowledgeError('COGNITION_BASIS_INVALID','Recognition must bind an exact validated observation record',422);
      }
    }
    if (rev.kind === 'pattern') {
      for(const ref of rev.content.supportRefs) linked.push(await resolveKnowledge(ref,true,'supports'));
      for(const ref of rev.content.counterexampleRefs) linked.push(await resolveKnowledge(ref,true,'challenges'));
      const supports = linked.filter(r=>rev.kind==='pattern' && rev.content.supportRefs.some(x=>sameRef(x,r.ref)));
      const independent = new Set(supports.flatMap(r=>r.sourceGroups));
      const expected = independent.size > 1 ? 'repeated_observation' : 'single_case';
      if(rev.content.evidenceLevel!=='inconclusive' && rev.content.evidenceLevel!==expected) throw new KnowledgeError('EVIDENCE_LEVEL_MISMATCH','Repeated rows do not increase independent support',422);
      if(!rev.content.counterexampleRefs.length) rev={...rev,scope:{...rev.scope,unknowns:[...rev.scope.unknowns,'尚无相关反例；重复观察不证明效果']}};
    }
    if(rev.kind==='wiki') {
      // Earlier versions of this same page are comparison records, not causal
      // dependencies of their replacement. Verify the immutable published ref.
      for(const item of rev.content.comparisonContext??[]){
        const view=await options.store.get(rev.projectId,item.ref);
        if(!view?.published||view.revision.projectId!==rev.projectId)
          throw new KnowledgeError('COMPARISON_VERSION_NOT_FOUND','Comparison requires an exact published historical version',422);
        if(item.ref.objectId===rev.ref.objectId&&item.ref.versionId===rev.ref.versionId)
          throw new KnowledgeError('DEPENDENCY_CYCLE','A revision cannot compare itself',422);
      }
      for(const ref of rev.content.claimRefs) { const r=await resolveKnowledge(ref,false); if(r.kind!=='claim') throw new KnowledgeError('INVALID_CLAIM','Wiki claim reference is not a claim',422); linked.push(r); }
      for(const ref of rev.content.patternRefs) {const r=await resolveKnowledge(ref,false); if(r.kind!=='pattern') throw new KnowledgeError('INVALID_PATTERN','Wiki pattern reference is not a pattern',422); linked.push(r);}
      // Navigation is not support, but it still must point to an accessible exact version.
      for(const ref of rev.content.relatedRefs) {
        const target=staged.get(refKey(ref)) ?? (await options.store.get(rev.projectId,ref))?.revision;
        if(!target || target.projectId!==rev.projectId) throw new KnowledgeError('RELATED_VERSION_NOT_FOUND','Wiki navigation target does not exist in this project',422);
        dependencies.push({domain:'knowledge',ref,role:'uses',critical:false});
        linked.push(target);
      }
    }
    if(rev.kind==='wiki_page') for(const link of rev.content.navigation) {
      const target=staged.get(refKey(link.ref)) ?? (await options.store.get(rev.projectId,link.ref))?.revision;
      if(!target||target.projectId!==rev.projectId)
        throw new KnowledgeError('RELATED_VERSION_NOT_FOUND','Page navigation target does not exist in this project',422);
      dependencies.push({domain:'knowledge',ref:link.ref,role:'uses',critical:false});
    }
    if(rev.kind==='claim') for(const dep of [...dependencies].filter(d=>d.domain==='knowledge')) linked.push(await resolveKnowledge(dep.ref,dep.critical,dep.role));
    const sourceRecords: RegisteredSource[] = [];
    for(const citation of citationsOf(rev)) {
      if(citation.kind==='source') {
        const record=await source(rev.projectId,citation.sourceRef); sourceRecords.push(record); groups.add(record.sourceGroup);
        dependencies.push({domain:'source',ref:record.ref,role:rev.kind==='wiki_page'?'uses':'supports',critical:true});
      } else {
        const registered = selectedAnalyses.some(result=>result.evidence.some(a=>canonical(a)===canonical(citation.anchor))) || linked.some(r=>citationsOf(r).some(c=>c.kind==='media' && canonical(c.anchor)===canonical(citation.anchor)));
        if(!registered) throw new KnowledgeError('UNREGISTERED_ANCHOR','Citation is not in its exact registered result or linked knowledge',422);
        dependencies.push({domain:'evidence',ref:citation.anchor.sourceRef,role:rev.kind==='wiki_page'?'uses':'supports',critical:true});
      }
    }
    if(rev.kind==='claim' && rev.content.claimKind==='product_fact') {
      const statement = rev.content.statement;
      if(!sourceRecords.some(s=>s.kind==='product_fact' && s.statement===statement && s.productVersionRef && rev.scope.applicability.productVersionRefs.some(ref=>sameRef(ref,s.productVersionRef!))))
        throw new KnowledgeError('INDEPENDENT_PRODUCT_SOURCE_REQUIRED','Product facts require an exact independently registered product statement for the same SKU version',422);
    }
    if(rev.kind==='claim' && rev.content.claimKind==='outcome' && !sourceRecords.some(s=>s.kind==='business_record'&&!s.taskFeedback))
      throw new KnowledgeError('BUSINESS_SOURCE_REQUIRED','Outcome claims need an independent business record',422);
    if(rev.kind==='claim' && rev.content.claimKind==='rule' &&
      !sourceRecords.some(s=>(s.kind==='document_rule'||s.kind==='platform_rule')&&s.statement===rev.content.statement))
      throw new KnowledgeError('RULE_SOURCE_REQUIRED','A literal rule needs the exact independently readable rule statement',422);
    const ownCitations=citationsOf(rev);
    for(const dep of dependencies) {
      if(dep.citations?.some(citation=>!ownCitations.some(own=>canonical(own)===canonical(citation))))
        throw new KnowledgeError('UNREGISTERED_RELATION_CITATION','Relation explanation must cite evidence already checked on this exact revision',422);
      if(dep.rationale && !dep.citations?.length && ['supports','challenges'].includes(dep.role))
        throw new KnowledgeError('RELATION_EVIDENCE_REQUIRED','A new support or challenge rationale requires checked citations',422);
    }
    const normalized={...rev,dependencies:uniqueDeps(dependencies),
      sourceGroups:rev.kind==='wiki'&&rev.content.navigationOnly?[]:[...groups].sort()};
    if(normalized.kind==='wiki_page'&&!matchesWikiPageFrozenBinding(normalized))
      throw new KnowledgeError('WIKI_PAGE_BINDING_MISMATCH','Wiki page binding does not match its profile and normalized exact inputs',422);
    return normalized;
  }
  async function stageProposal(raw: ProposeChange, allowNavigation:boolean, signal?: AbortSignal, requestIdentity?: unknown): Promise<KnowledgeChangeSet> {
    const input=ProposeChangeSchema.parse(raw); signal?.throwIfAborted();
    if(input.changes.some(item=>item.revision.binding&&item.revision.binding.methodVersion!==input.methodVersion))
      throw new KnowledgeError('METHOD_BINDING_MISMATCH','Frozen revision method must match the actual change method',422);
    assertSourcePurpose(input);
    const hasNavigation=input.changes.some(change=>change.revision.kind==='wiki'&&change.revision.content.navigationOnly);
    if(hasNavigation&&!allowNavigation)
      throw new KnowledgeError('NAVIGATION_BUILDER_REQUIRED','Navigation-only Wikis require the internal topic navigation builder',422);
    if(allowNavigation&&!hasNavigation)
      throw new KnowledgeError('NAVIGATION_REQUIRED','The topic navigation builder requires a navigation-only Wiki',422);
    await assertNavigationChange(input);
    const requestHash=digest(requestIdentity ?? {...input, changes:input.changes.map(c=>({...c,revision:{...c.revision,createdAt:null,artifactRef:null,sourceGroups:[],analysisQuality:null,content:{...c.revision.content,createdAt:null}}}))});
    const previous=await options.store.getByRequestKey(input.projectId,input.requestKey);
    if(previous) {
      if(previous.requestHash!==requestHash) throw new KnowledgeError('IDEMPOTENCY_CONFLICT','Request key was used for another knowledge command');
      return previous;
    }
    if(new Set(input.baseHeads.map(h=>h.objectId)).size!==input.baseHeads.length || new Set(input.changes.map(c=>c.revision.ref.objectId)).size!==input.changes.length || input.baseHeads.length!==input.changes.length)
      throw new KnowledgeError('INVALID_BASE_HEADS','Each changed object needs exactly one base head',422);
    const staged = new Map<string,KnowledgeRevision>();
    const normalized: KnowledgeChangeSet['changes']=[];
    for(const change of input.changes) {
      const rev=change.revision;
      if(rev.kind==='reference_pack')throw new KnowledgeError('PACK_BUILDER_REQUIRED','Reference packs can only be frozen by task selection, not proposed by a model',422);
      if(rev.projectId!==input.projectId || !input.baseHeads.some(b=>b.objectId===rev.ref.objectId)) throw new KnowledgeError('PROJECT_OR_BASE_MISMATCH','Revision is outside project/base heads',422);
      const base=input.baseHeads.find(b=>b.objectId===rev.ref.objectId)!;
      if((change.effect==='create') !== (base.versionId===null)) throw new KnowledgeError('INVALID_EFFECT','Creation requires an empty base; revisions require an exact base',422);
      const old=base.versionId ? await options.store.get(input.projectId,{objectId:base.objectId,versionId:base.versionId}) : null;
      if(base.versionId && !old?.published) throw new KnowledgeError('BASE_NOT_FOUND','Base knowledge version is not published',422);
      if(old && old.revision.kind!==rev.kind) throw new KnowledgeError('KIND_CHANGED','Stable objects cannot change knowledge kind',422);
      if(old?.revision.kind==='wiki_page' && rev.kind==='wiki_page' &&
        old.revision.content.identity.key!==rev.content.identity.key)
        throw new KnowledgeError('WIKI_PAGE_IDENTITY_CHANGED','Page identity key must remain stable across revisions',422);
      let revision:KnowledgeRevision;
      if(change.effect==='withdraw' && old) {
        const prior=old.revision;
        revision=prior.kind==='wiki_page' ? {...prior,ref:rev.ref,createdAt:rev.createdAt,artifactRef:null} : prior.kind==='reference_pack' ? {...prior,ref:rev.ref,createdAt:rev.createdAt,artifactRef:null,content:{...prior.content,pack:{...prior.content.pack,ref:rev.ref,createdAt:rev.createdAt}}} :
          {...prior,ref:rev.ref,createdAt:rev.createdAt,artifactRef:null,content:{...prior.content,ref:rev.ref,...('createdAt' in prior.content?{createdAt:rev.createdAt}:{})}} as KnowledgeRevision;
      } else revision=await normalizeRevision(rev,staged);
      if(old) {
        const newEvidence=revision.dependencies.some(d=>!old.revision.dependencies.some(o=>o.domain===d.domain && sameRef(o.ref,d.ref)));
        if(!newEvidence && !['withdraw','correct'].includes(change.effect)) throw new KnowledgeError('NEW_EVIDENCE_REQUIRED','Support, narrowing and dispute need new evidence',422);
        if(change.effect==='support' && old.revision.dependencies.some(d=>!revision.dependencies.some(n=>n.domain===d.domain && sameRef(n.ref,d.ref)))) throw new KnowledgeError('SUPPORT_DROPPED','Adding support cannot silently drop old evidence',422);
        if(change.effect==='narrow' && !isStrictNarrowing(old.revision.scope.applicability,revision.scope.applicability)) throw new KnowledgeError('SCOPE_NOT_NARROWED','Narrowing must strictly restrict applicability without expanding another axis',422);
      }
      if(revision.dependencies.some(dep=>dep.purpose && dep.purpose!==input.purpose)) throw new KnowledgeError('RELATION_PURPOSE_MISMATCH','Relation purpose must match the reviewed change set purpose',422);
      signal?.throwIfAborted();
      const bytes=Buffer.from(canonical({content:revision.content,body:revision.body}));
      if(bytes.byteLength >= (options.archiveThresholdBytes ?? 32768)) {
        if(!options.artifacts) throw new KnowledgeError('ARTIFACT_WRITER_REQUIRED','Large knowledge bodies need the shared verified artifact writer',503);
        revision={...revision,artifactRef:await options.artifacts.writeArtifact(bytes,'application/json',signal)};
      } else revision={...revision,artifactRef:null};
      staged.set(refKey(revision.ref),revision); normalized.push({...change,revision});
    }
    const deps=uniqueDeps(normalized.flatMap(c=>c.revision.dependencies));
    await assertNavigationChange({...input,changes:normalized});
    await revalidateChanges(input.projectId,normalized);
    const hashInput={...input,changes:normalized};
    const change:KnowledgeChangeSet={...hashInput,id:randomUUID(),requestHash,contentHash:digest(hashInput),inputManifest:deps,createdAt:now()};
    signal?.throwIfAborted(); return options.store.stage(change);
  }
  function propose(raw: ProposeChange, signal?: AbortSignal, requestIdentity?: unknown): Promise<KnowledgeChangeSet> {
    return stageProposal(raw,false,signal,requestIdentity);
  }
  function proposeTopicNavigation(raw: ProposeChange, signal?: AbortSignal, requestIdentity?: unknown): Promise<KnowledgeChangeSet> {
    return stageProposal(raw,true,signal,requestIdentity);
  }
  async function reviewChangeSet(raw: {projectId:string;changeSetId:string;contentHash:string;purpose:string}, signal?:AbortSignal) {
    const input=ReviewInputSchema.parse(raw);
    const change=await options.store.getChangeSet(input.projectId,input.changeSetId);
    if(!change) throw new KnowledgeError('NOT_FOUND','Change set not found',404);
    if(change.contentHash!==input.contentHash || change.purpose!==input.purpose) throw new KnowledgeError('REVIEW_MISMATCH','Review must bind exact content and purpose');
    assertSourcePurpose(change);
    const hasNavigation=await assertNavigationChange(change);
    if(!options.reviewPolicy) throw new KnowledgeError('REVIEW_POLICY_UNAVAILABLE','No independent review policy is configured',503);
    if(change.changes.some(item=>item.revision.kind==='wiki_page' &&
      (!item.revision.binding || !('bindingKind' in item.revision.binding) || item.revision.binding.bindingKind!=='wiki_page' ||
        item.revision.binding.policyVersion!==options.reviewPolicy!.version)))
      throw new KnowledgeError('WIKI_PAGE_POLICY_MISMATCH','Wiki page binding must name the actual independent review policy',422);
    await revalidateChanges(input.projectId,change.changes);
    const result=await options.reviewPolicy.review(change,signal); signal?.throwIfAborted();
    if(!result.reviewer.trim() || result.reviewer===change.proposer || !result.rationale.trim()) throw new KnowledgeError('INDEPENDENT_REVIEW_REQUIRED','Review must be independent and explain its decision',422);
    if(result.decision==='approved_for_purpose'&&change.changes.some(c=>c.revision.kind==='case'&&c.revision.content.schemaVersion==='1.1'))
      throw new KnowledgeError('SOURCE_CASE_EXPLORATION_ONLY','Source preservation cannot approve production semantics',422);
    if(result.decision==='approved_for_purpose' && change.changes.some(c=>c.effect==='dispute')) throw new KnowledgeError('DISPUTE_NEEDS_EXPLORATION','Unresolved disputes cannot become approved production references');
    if(hasNavigation&&result.decision==='approved_for_purpose')
      throw new KnowledgeError('NAVIGATION_EXPLORATION_ONLY','Navigation-only Wikis cannot be approved for production purpose',422);
    if(result.decision==='approved_for_purpose' || result.decision==='exploration_only') await revalidateChanges(input.projectId,change.changes,change.purpose,
      {allowExplorationKnowledge:change.purpose==='exploration_reading' && result.decision==='exploration_only'});
    return options.store.recordReview({...result,id:randomUUID(),projectId:input.projectId,changeSetId:change.id,contentHash:change.contentHash,purpose:change.purpose,policyVersion:options.reviewPolicy.version,createdAt:now()});
  }
  async function preparePublication(projectId:string,changeSetId:string,contentHash:string) {
    const knowledgeEpoch=await options.store.epoch(projectId);
    const change=await options.store.getChangeSet(projectId,changeSetId);
    if(!change) throw new KnowledgeError('NOT_FOUND','Change set not found',404);
    if(change.contentHash!==contentHash) throw new KnowledgeError('CHANGESET_MISMATCH','Change set hash changed');
    await assertNavigationReview(change);
    const candidate=await options.store.get(projectId,change.changes[0].revision.ref);
    if(!candidate?.published) await revalidateChanges(projectId,change.changes,change.purpose,
      {allowExplorationKnowledge:change.purpose==='exploration_reading' && candidate?.review?.decision==='exploration_only'});
    if(await options.store.epoch(projectId)!==knowledgeEpoch) throw new KnowledgeError('BUILD_INPUT_CHANGED','Knowledge or scoped use decisions changed during publication preflight');
    return {projectId,changeSetId,contentHash,knowledgeEpoch};
  }
  async function publishRevision(projectId:string,changeSetId:string,contentHash:string,client?:Pick<PoolClient,'query'>) {
    const prepared=await preparePublication(projectId,changeSetId,contentHash);
    if(client) return publishPrepared(prepared,client);
    return options.store.publish(projectId,changeSetId,contentHash,undefined,prepared.knowledgeEpoch);
  }
  async function assertEpoch(projectId:string,expectedEpoch:number,client:Pick<PoolClient,'query'>) {
    if(!Number.isSafeInteger(expectedEpoch) || expectedEpoch<0) throw new KnowledgeError('KNOWLEDGE_EPOCH_INVALID','Expected knowledge epoch must be a nonnegative integer',422);
    const row=await client.query<{epoch:string}>('SELECT epoch FROM ccl_knowledge_projects WHERE project_id=$1 FOR UPDATE',[projectId]);
    if(Number(row.rows[0]?.epoch??0)!==expectedEpoch) throw new KnowledgeError('BUILD_INPUT_CHANGED','Knowledge or scoped use decisions changed after input revalidation');
  }
  async function publishPrepared(prepared:{projectId:string;changeSetId:string;contentHash:string;knowledgeEpoch:number},client:Pick<PoolClient,'query'>) {
    const change=await options.store.getChangeSet(prepared.projectId,prepared.changeSetId);
    if(!change||change.contentHash!==prepared.contentHash)
      throw new KnowledgeError('CHANGESET_MISMATCH','Change set hash changed');
    await assertNavigationReview(change);
    await assertEpoch(prepared.projectId,prepared.knowledgeEpoch,client);
    return options.store.publish(prepared.projectId,prepared.changeSetId,prepared.contentHash,client);
  }
  return { propose, proposeTopicNavigation, reviewChangeSet, preparePublication, publishRevision, publishPrepared, assertEpoch,
    capturePublicationPermit: (projectId:string, facts:PublicationScopeFacts, methodVersion:string) => options.store.capturePublicationPermit(projectId,facts,methodVersion),
    isPublicationScopeProtected: (projectId:string, facts:PublicationScopeFacts) => options.store.isPublicationScopeProtected(projectId,facts),
    setPublicationAuthorityScope: (projectId:string, expectedGeneration:number|null, scope:Omit<PublicationAuthorityScopeV1,'generation'>) => options.store.setPublicationAuthorityScope(projectId,expectedGeneration,scope),
    getByRequestKey:options.store.getByRequestKey.bind(options.store), readAnalysis:analysis, readSource:source, revalidate,
    get:options.store.get.bind(options.store), history:options.store.history.bind(options.store), search:options.store.search.bind(options.store),
    catalog:options.store.catalog.bind(options.store), impact:options.store.impact.bind(options.store), countCurrent:options.store.countCurrent.bind(options.store),
    invalidate:options.store.invalidate.bind(options.store), dependents:options.store.dependents.bind(options.store), events:options.store.events.bind(options.store),
    async researchNeeds(projectId:string,query='',limit=30) {
      const rows=await options.store.search(projectId,{query,limit:Math.min(Math.max(limit,1),200)});
      return rows.map(view=>({ref:view.revision.ref,title:view.revision.title,valid:view.validity.valid,
        questions:[...new Set([...view.revision.scope.unknowns,...view.validity.issues.map(i=>`复核依据：${i.reason}`),
          ...(view.revision.kind==='wiki'||view.revision.kind==='wiki_page'?view.revision.content.nextQuestions:[]),
          ...(view.revision.kind==='pattern'?[`待测预测：${view.revision.content.prediction}`]:[])])],
        restrictions:view.revision.scope.limitations,
      })).filter(row=>row.questions.length>0);
    },
    async readEvidence(projectId:string,knowledgeRef:VersionRef,rawAnchor:EvidenceAnchor,signal?:AbortSignal) {
      const anchor=EvidenceAnchorSchema.parse(rawAnchor);
      const view=await options.store.get(projectId,knowledgeRef);
      if(!view?.published || !citationsOf(view.revision).some(c=>c.kind==='media'&&canonical(c.anchor)===canonical(anchor))) throw new KnowledgeError('UNREGISTERED_ANCHOR','Anchor is outside the requested knowledge version',422);
      await revalidate(projectId,[{domain:'knowledge',ref:knowledgeRef,role:'uses',critical:true}]);
      if(!options.evidence) throw new KnowledgeError('EVIDENCE_READER_UNAVAILABLE','Evidence reader has not been connected',503);
      const value=await options.evidence.readEvidence(projectId,anchor,signal);
      if(canonical(value.anchor)!==canonical(anchor)) throw new KnowledgeError('EVIDENCE_MISMATCH','Reader returned another anchor',422);
      if(value.text!==null && Buffer.byteLength(value.text)>16000) throw new KnowledgeError('EVIDENCE_READ_LIMIT','Evidence text exceeds the bounded supplementary read',422);
      if(value.objectRef) ObjectRefSchema.parse(value.objectRef);
      signal?.throwIfAborted();return value;
    },
    async proposeCase(input:{projectId:string;requestKey:string;purpose:string;proposer:string;analysisResultRef:VersionRef;title:string;summary:string;citations:Citation[];scope:KnowledgeScope;ref:VersionRef;baseHead:string|null;sourceProjection?:ResearchSourceProjection;body?:string},signal?:AbortSignal) {
      const createdAt=now();
      return propose({projectId:input.projectId,requestKey:input.requestKey,purpose:input.purpose,proposer:input.proposer,rationale:'从准确分析版本提出单片案例；用途另行核查',methodVersion:'knowledge-case-v1',cost:{state:'unknown',reason:'No model billing observation supplied'},baseHeads:[{objectId:input.ref.objectId,versionId:input.baseHead}],changes:[{effect:input.baseHead?'correct':'create',explanation:'保留准确分析版本、覆盖和限制',revision:{kind:'case',ref:input.ref,projectId:input.projectId,title:input.title,content:{schemaVersion:input.sourceProjection?'1.1':'1.0',...(input.sourceProjection?{sourceProjection:input.sourceProjection}:{}),ref:input.ref,projectId:input.projectId,analysisResultRef:input.analysisResultRef,title:input.title,summary:input.summary,citations:input.citations,createdAt},scope:input.scope,dependencies:[],sourceGroups:[],body:input.body??input.summary,artifactRef:null,createdAt,analysisQuality:null}}]},signal);
    }
  };
}
function mediaContains(outer:MediaScope,inner:MediaScope):boolean {
  return outer.kind==='whole' || inner.kind==='segment' && outer.startMs<=inner.startMs && outer.endMs>=inner.endMs;
}
function observedCovers(observed:MediaScope[],requested:MediaScope,durationMs:number|null):boolean {
  if(observed.some(scope=>scope.kind==='whole')) return true;
  const start=requested.kind==='segment'?requested.startMs:0;
  const end=requested.kind==='segment'?requested.endMs:durationMs;
  if(end===null || end<=start) return false;
  let cursor=start;
  for(const scope of observed.filter((scope):scope is Extract<MediaScope,{kind:'segment'}>=>scope.kind==='segment').sort((a,b)=>a.startMs-b.startMs)) {
    if(scope.startMs>cursor) return false;
    if(scope.endMs>cursor) cursor=scope.endMs;
    if(cursor>=end) return true;
  }
  return false;
}
export type KnowledgeService = ReturnType<typeof createKnowledgeService>;

function isStrictNarrowing(before:Applicability,after:Applicability):boolean {
  let strict=false;
  const oldPlatforms=new Set(applicablePlatforms(before)),nextPlatforms=new Set(applicablePlatforms(after));
  if([...nextPlatforms].some(value=>!oldPlatforms.has(value)))return false;
  if(nextPlatforms.size<oldPlatforms.size)strict=true;
  const oldTransfers=new Map((before.platformTransfers??[]).map(item=>[item.to,item.rationale]));
  const nextTransfers=new Map((after.platformTransfers??[]).map(item=>[item.to,item.rationale]));
  if([...nextTransfers].some(([to,rationale])=>oldTransfers.get(to)!==rationale))return false;
  if(nextTransfers.size<oldTransfers.size)strict=true;
  for(const key of ['markets','languages','audiences','goals'] as const) {
    const old=new Set(before[key].map(x=>x.toLowerCase())); const next=new Set(after[key].map(x=>x.toLowerCase()));
    // Empty is unknown, not global permission. New evidence can establish a concrete scope.
    if(!next.size) {if(old.size)return false;continue;}
    if(old.has('*') || !old.size) {if(!next.has('*'))strict=true;else if(!old.size)return false;continue;}
    if([...next].some(x=>!old.has(x)))return false;
    if(next.size<old.size)strict=true;
  }
  const oldProducts=new Set(before.productVersionRefs.map(refKey)),newProducts=new Set(after.productVersionRefs.map(refKey));
  if(oldProducts.size && (!newProducts.size || [...newProducts].some(x=>!oldProducts.has(x))))return false;
  if((!oldProducts.size && newProducts.size) || (oldProducts.size && newProducts.size<oldProducts.size))strict=true;
  if(before.requiredProduction.some(x=>!after.requiredProduction.includes(x)))return false;
  if(after.requiredProduction.some(x=>!before.requiredProduction.includes(x)))strict=true;
  // Adding cross-product transfer permission widens the scope.
  if(!before.transferRationale && after.transferRationale)return false;
  if(before.transferRationale && !after.transferRationale)strict=true;
  return strict;
}
