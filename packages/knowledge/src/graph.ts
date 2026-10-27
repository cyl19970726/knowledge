import type { EvidenceAnchor, VersionRef } from '../../contracts/src/index.ts';
import type { KnowledgeService } from './service.ts';
import type { KnowledgeGraphEdge, KnowledgeGraphImpact, KnowledgeGraphNode, KnowledgeGraphProjection } from './graph-types.ts';
import type { KnowledgeRevision, RevisionView } from './types.ts';
import { canonical, citationsOf, refKey } from './utils.ts';

const LIMITS = { knowledge: 200, nodes: 800, edges: 1600 } as const;
export const graphNodeId = (domain: string, ref: VersionRef) => `${domain}:${refKey(ref)}`;
const anchorId = (anchor: EvidenceAnchor) => `evidence:${refKey(anchor.sourceRef)}:${anchor.assetVersionId}:${anchor.scope.kind === 'whole' ? 'whole' : `${anchor.scope.startMs}-${anchor.scope.endMs}`}`;
const anchorIdentity = (anchor: EvidenceAnchor) => `${anchor.assetVersionId}:${anchor.scope.kind === 'whole' ? 'whole' : `${anchor.scope.startMs}-${anchor.scope.endMs}`}`;

/** Exact, project-scoped relation detail. This never scans the bounded display graph. */
export async function getKnowledgeGraphRelation(knowledge:KnowledgeService,projectId:string,source:string,target:string,role:KnowledgeGraphEdge['role']):Promise<KnowledgeGraphEdge|null> {
  const match=/^knowledge:([^/]+)\/([^/]+)$/.exec(target);
  if(!match)return null;
  const view=await knowledge.get(projectId,{objectId:match[1],versionId:match[2]});
  if(!view?.published||view.revision.projectId!==projectId)return null;
  const rev=view.revision;let edge:KnowledgeGraphEdge|null=null;
  const add=(next:KnowledgeGraphEdge)=>{if(next.source!==source||next.target!==target||next.role!==role)return;
    edge=edge?{...edge,...next,critical:edge.critical||next.critical,citations:[...new Map([...(edge.citations??[]),...(next.citations??[])].map(c=>[canonical(c),c])).values()]}:next;
  };
  const overrides=new Map<string,KnowledgeGraphEdge['role']>();
  if(rev.kind==='pattern'){
    rev.content.supportRefs.forEach(ref=>overrides.set(refKey(ref),'supports'));
    rev.content.counterexampleRefs.forEach(ref=>overrides.set(refKey(ref),'challenges'));
  }
  if(rev.kind==='collection')rev.content.members.forEach(member=>overrides.set(refKey(member.ref),'contains'));
  if(rev.kind==='wiki'){
    [...rev.content.claimRefs,...rev.content.patternRefs].forEach(ref=>overrides.set(refKey(ref),'contains'));
    rev.content.relatedRefs.forEach(ref=>overrides.set(refKey(ref),'related'));
  }
  if(rev.kind==='wiki_page')rev.content.navigation.forEach(link=>overrides.set(refKey(link.ref),'related'));
  for(const dep of rev.dependencies){
    const effective=dep.domain==='knowledge'&&!dep.critical?overrides.get(refKey(dep.ref))??dep.role:dep.role;
    const from=graphNodeId(dep.domain,dep.ref);
    add({id:`${from}|${effective}|${target}`,source:from,target,role:effective,critical:dep.critical,label:effective,
      rationale:dep.rationale,conditions:dep.conditions,citations:dep.citations,sourceRef:dep.ref,targetRef:rev.ref,purpose:dep.purpose,reviewRef:dep.reviewRef});
  }
  for(const citation of citationsOf(rev)){
    const from=citation.kind==='source'?graphNodeId('source',citation.sourceRef):graphNodeId('evidence',citation.anchor.sourceRef);
    const anchored=citation.kind==='media'?anchorId(citation.anchor):from;
    if(source!==from&&source!==anchored)continue;
    add({id:`${source}|supports|${target}`,source,target,role:'supports',critical:true,label:'supports',rationale:citation.supports,
      citations:[citation],sourceRef:citation.kind==='source'?citation.sourceRef:citation.anchor.sourceRef,targetRef:rev.ref,purpose:view.review?.purpose});
  }
  return edge;
}

/** A bounded display projection; every edge points from an input to its dependent. */
export async function createKnowledgeGraphProjection(knowledge: KnowledgeService, projectId: string, detail = false, legacy = false): Promise<KnowledgeGraphProjection> {
  const nodes = new Map<string, KnowledgeGraphNode>();
  const edges = new Map<string, KnowledgeGraphEdge>();
  const items = new Map<string, RevisionView>();
  const queue: VersionRef[] = [];
  let truncated = false;
  const addNode = (node: KnowledgeGraphNode) => {
    if (nodes.has(node.id)) return true;
    if (nodes.size >= LIMITS.nodes) { truncated = true; return false; }
    nodes.set(node.id, node); return true;
  };
  const addEdge = (source: string, target: string, role: KnowledgeGraphEdge['role'], critical: boolean, label:string = role, detail?: Partial<KnowledgeGraphEdge>) => {
    if (!nodes.has(source) || !nodes.has(target)) { truncated = true; return; }
    const id = `${source}|${role}|${target}`;
    const prior = edges.get(id);
    if (prior) {
      const details=Object.fromEntries(Object.entries(detail??{}).filter(([,value])=>value!==undefined));
      const citations=[...new Map([...(prior.citations??[]),...(detail?.citations??[])].map(c=>[canonical(c),c])).values()];
      edges.set(id,{...prior,...details,critical:prior.critical||critical,...(citations.length?{citations}:{})});return;
    }
    if (edges.size >= LIMITS.edges) { truncated = true; return; }
    edges.set(id, { id, source, target, role, critical, label, ...detail });
  };
  const enqueue = (ref: VersionRef) => { if (!items.has(refKey(ref))) queue.push(ref); };
  const first = await knowledge.search(projectId, { query: '', limit: LIMITS.knowledge, offset: 0 });
  for (const view of first) { items.set(refKey(view.revision.ref), view); }
  if (first.length === LIMITS.knowledge && (await knowledge.search(projectId, { query: '', limit: 1, offset: LIMITS.knowledge })).length) truncated = true;
  const linkedRefs = (rev: KnowledgeRevision): VersionRef[] => {
    const result = rev.dependencies.filter(d => d.domain === 'knowledge').map(d => d.ref);
    if (rev.kind === 'collection') result.push(...rev.content.members.map(m => m.ref));
    if (rev.kind === 'comparison') result.push(rev.content.collectionRef, ...rev.content.dimensions.flatMap(d => d.observations.map(o => o.memberRef)));
    if (rev.kind === 'pattern') result.push(...rev.content.supportRefs, ...rev.content.counterexampleRefs);
    if (rev.kind === 'wiki') result.push(...rev.content.claimRefs, ...rev.content.patternRefs, ...rev.content.relatedRefs);
    if (rev.kind === 'wiki_page') result.push(...rev.content.navigation.map(link=>link.ref));
    if (rev.kind === 'reference_pack') result.push(...rev.content.decisions.filter(d => d.selected).map(d => d.ref));
    return result;
  };
  for (const view of items.values()) linkedRefs(view.revision).forEach(enqueue);
  const attempted = new Set(items.keys());
  while (queue.length) {
    const ref = queue.shift()!; const key = refKey(ref);
    if (attempted.has(key)) continue; attempted.add(key);
    if (items.size >= LIMITS.knowledge) { truncated = true; break; }
    const view = await knowledge.get(projectId, ref);
    if (!view || !view.published || view.revision.projectId !== projectId) continue;
    items.set(key, view); linkedRefs(view.revision).forEach(enqueue);
  }
  const status = (view: RevisionView): KnowledgeGraphNode['status'] => !view.validity.valid ? 'invalid' : !view.published ? 'pending' : view.review?.decision === 'approved_for_purpose' ? 'adopted' : view.review?.decision === 'exploration_only' ? 'exploration' : 'pending';
  for (const view of items.values()) {
    const r = view.revision;
    addNode({ id: graphNodeId('knowledge', r.ref), kind: r.kind, label: r.title, ref: r.ref, knowledgeRef: r.ref, anchor: null, assetVersionId: null, status: status(view), summary: r.kind === 'case' ? r.content.summary : r.kind === 'claim' ? r.content.statement : r.kind==='wiki_page' ? r.content.summary : r.body.slice(0, 280) });
  }
  // Evidence versions are normally exact anchors. Keep distinct anchor nodes if a
  // malformed/imported graph associates one version with conflicting media scope.
  const evidenceIdentities = new Map<string, Set<string>>();
  for (const view of items.values()) for (const citation of citationsOf(view.revision)) if (citation.kind === 'media') {
    const key = refKey(citation.anchor.sourceRef);
    const identities = evidenceIdentities.get(key) ?? new Set<string>();
    identities.add(anchorIdentity(citation.anchor)); evidenceIdentities.set(key, identities);
  }
  const conflictingEvidence = new Set([...evidenceIdentities].filter(([, identities]) => identities.size > 1).map(([key]) => key));
  if (conflictingEvidence.size) truncated = true;
  const external = (domain: 'analysis' | 'context' | 'source' | 'evidence', ref: VersionRef, label: string, knowledgeRef: VersionRef | null = null) => {
    const id = graphNodeId(domain, ref);
    addNode({ id, kind: domain, label, ref, knowledgeRef, anchor: null, assetVersionId: null, status: 'source', summary: '' });
    return id;
  };
  const linkKnowledge = (ref: VersionRef, target: string, role: KnowledgeGraphEdge['role'], critical: boolean, detail?: Partial<KnowledgeGraphEdge>) => addEdge(graphNodeId('knowledge', ref), target, role, critical, role==='supports' && !detail?.rationale ? 'supports · 未记录论证理由' : role, detail);
  for (const view of items.values()) {
    const rev = view.revision; const target = graphNodeId('knowledge', rev.ref);
    if (!nodes.has(target)) continue;
    const overrides = new Map<string, { role: KnowledgeGraphEdge['role']; critical: boolean }>();
    if (rev.kind === 'pattern') {
      rev.content.supportRefs.forEach(ref => overrides.set(refKey(ref), { role: 'supports', critical: true }));
      rev.content.counterexampleRefs.forEach(ref => overrides.set(refKey(ref), { role: 'challenges', critical: true }));
    }
    if (rev.kind === 'collection') rev.content.members.forEach(member => overrides.set(refKey(member.ref), { role: 'contains', critical: false }));
    if (rev.kind === 'wiki') {
      [...rev.content.claimRefs, ...rev.content.patternRefs].forEach(ref => overrides.set(refKey(ref), { role: 'contains', critical: false }));
      rev.content.relatedRefs.forEach(ref => overrides.set(refKey(ref), { role: 'related', critical: false }));
    }
    if(rev.kind==='wiki_page')rev.content.navigation.forEach(link=>overrides.set(refKey(link.ref),{role:'related',critical:false}));
    for (const dep of rev.dependencies) {
      if (dep.domain === 'knowledge') {
        const override = overrides.get(refKey(dep.ref));
        linkKnowledge(dep.ref, target, override && !dep.critical ? override.role : dep.role, dep.critical, { rationale:dep.rationale,conditions:dep.conditions,citations:dep.citations,sourceRef:dep.ref,targetRef:rev.ref,purpose:dep.purpose,reviewRef:dep.reviewRef });
      } else {
        const label = dep.domain === 'analysis' ? `分析版本 ${dep.ref.versionId.slice(0, 8)}` : dep.domain === 'context' ? `素材上下文 ${dep.ref.versionId.slice(0, 8)}` : dep.domain === 'source' ? `来源版本 ${dep.ref.versionId.slice(0, 8)}` : `证据来源 ${dep.ref.versionId.slice(0, 8)}`;
        const upstream = external(dep.domain, dep.ref, label, rev.ref);
        addEdge(upstream, target, dep.role, dep.critical, dep.role, {rationale:dep.rationale,conditions:dep.conditions,citations:dep.citations,sourceRef:dep.ref,targetRef:rev.ref,purpose:dep.purpose,reviewRef:dep.reviewRef});
      }
    }
    for (const [key, value] of overrides) {
      const [objectId, versionId] = key.split('/');
      if(!rev.dependencies.some(d=>d.domain==='knowledge' && refKey(d.ref)===key)) linkKnowledge({ objectId, versionId }, target, value.role, false);
    }
    if (rev.kind === 'comparison') {
      if(!rev.dependencies.some(d=>d.domain==='knowledge' && refKey(d.ref)===refKey(rev.content.collectionRef))) linkKnowledge(rev.content.collectionRef, target, 'derived_from', true);
      rev.content.dimensions.flatMap(d => d.observations).forEach(o => {if(!rev.dependencies.some(d=>d.domain==='knowledge' && refKey(d.ref)===refKey(o.memberRef))) linkKnowledge(o.memberRef, target, 'derived_from', true);});
    }
    if (rev.kind === 'reference_pack') rev.content.decisions.filter(d => d.selected).forEach(d => linkKnowledge(d.ref, target, 'uses', true));
    for (const citation of citationsOf(rev)) {
      if (citation.kind === 'source') {
        const upstream = external('source', citation.sourceRef, `来源：${citation.supports.slice(0, 100)}`, rev.ref);
        const sourceNode = nodes.get(upstream);
        if (sourceNode) nodes.set(upstream, { ...sourceNode, label: `来源：${citation.supports.slice(0, 100)}`, summary: citation.supports });
        addEdge(upstream,target,'supports',true,'supports',{rationale:citation.supports,citations:[citation],sourceRef:citation.sourceRef,targetRef:rev.ref,purpose:view.review?.purpose});
      } else {
        const anchor = citation.anchor; const conflict = conflictingEvidence.has(refKey(anchor.sourceRef));
        const id = conflict ? anchorId(anchor) : graphNodeId('evidence', anchor.sourceRef);
        const label = `证据 · ${anchor.scope.kind === 'whole' ? '全片' : `${(anchor.scope.startMs / 1000).toFixed(1)}–${(anchor.scope.endMs / 1000).toFixed(1)}s`}`;
        const existingEvidence = nodes.get(id);
        if (existingEvidence && !conflict) nodes.set(id, { ...existingEvidence, label, anchor, assetVersionId: anchor.assetVersionId, summary: citation.supports });
        else addNode({ id, kind: 'evidence', label, ref: anchor.sourceRef, knowledgeRef: rev.ref, anchor, assetVersionId: anchor.assetVersionId, status: 'source', summary: citation.supports });
        addEdge(id,target,'supports',true,'supports',{rationale:citation.supports,citations:[citation],sourceRef:anchor.sourceRef,targetRef:rev.ref,purpose:view.review?.purpose});
        const aid = `asset:${anchor.assetVersionId}`;
        addNode({ id: aid, kind: 'asset', label: `素材 · ${rev.title.slice(0, 20)}`, ref: null, knowledgeRef: rev.ref, anchor: null, assetVersionId: anchor.assetVersionId, status: 'source', summary: rev.title });
        if (rev.kind === 'case' && nodes.has(aid)) nodes.set(aid, { ...nodes.get(aid)!, label: `素材 · ${rev.title.slice(0, 20)}`, knowledgeRef: rev.ref, summary: rev.title });
        addEdge(aid, id, 'contains', true);
        if (conflict) {
          const source = external('evidence', anchor.sourceRef, '证据版本冲突 · 素材或范围不一致', rev.ref);
          const conflictNode = nodes.get(source);
          if (conflictNode) nodes.set(source, { ...conflictNode, status: 'invalid', label: '证据版本冲突 · 素材或范围不一致', summary: '同一证据版本指向不同素材或时间范围；各锚点分开展示，影响范围不完整。' });
          addEdge(source, id, 'derived_from', true);
        }
      }
    }
    // The registered analysis result resolves an exact context and asset; no inferred media relation is added.
    if (rev.kind === 'case') {
      try {
        const { result, snapshot } = await knowledge.readAnalysis(projectId, rev.content.analysisResultRef);
        if (result.projectId === projectId && snapshot.projectId === projectId) {
          const a = external('analysis', result.ref, `分析 ${result.profile} · ${result.quality.candidate}`, rev.ref);
          const analysisNode = nodes.get(a);
          if (analysisNode) nodes.set(a, { ...analysisNode, label: `分析 · ${result.profile}`, assetVersionId: result.assetVersionId, summary: `${result.profile} · ${result.quality.candidate} / ${result.quality.review}` });
          const c = external('context', snapshot.ref, `素材上下文 ${snapshot.ref.versionId.slice(0, 8)}`, rev.ref);
          const asset = `asset:${snapshot.assetVersionId}`;
          addNode({ id: asset, kind: 'asset', label: `素材 · ${rev.title.slice(0, 20)}`, ref: null, knowledgeRef: rev.ref, anchor: null, assetVersionId: snapshot.assetVersionId, status: 'source', summary: rev.title });
          if (nodes.has(asset)) nodes.set(asset, { ...nodes.get(asset)!, label: `素材 · ${rev.title.slice(0, 20)}`, knowledgeRef: rev.ref, summary: rev.title });
          addEdge(asset, c, 'contains', true); addEdge(c, a, 'uses', true); addEdge(a, target, 'derived_from', true);
        }
      } catch { /* Registered dependency remains visible even when the upstream read is unavailable. */ }
    }
  }
  return { schemaVersion: '1.0', projectId, nodes: [...nodes.values()].map(node=>({...node,label:node.label.slice(0,160),summary:node.summary.slice(0,240)})),
    edges: [...edges.values()].map(edge=>detail?edge:({id:edge.id,source:edge.source,target:edge.target,role:edge.role,critical:edge.critical,
      label:edge.label.slice(0,80),sourceRef:edge.sourceRef,targetRef:edge.targetRef,reviewRef:edge.reviewRef,purpose:edge.purpose?.slice(0,160),
      detailAvailable:Boolean(edge.citations?.length||edge.rationale||edge.conditions?.length)})),
    ...(legacy?{items:[...items.values()]}:{}),truncated,scope:'bounded_neighborhood',completeness:'incomplete',limits: { ...LIMITS } };
}

/** Traverses the complete projected critical relation set, independent of UI filters. */
export function computeGraphImpact(graph: KnowledgeGraphProjection, rootId: string): KnowledgeGraphImpact {
  const adjacency = new Map<string, KnowledgeGraphEdge[]>();
  for (const edge of graph.edges) if (edge.critical) adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge]);
  const seen = new Set([rootId]), affectedIds: string[] = [], criticalEdgeIds: string[] = [], queue = [rootId];
  while (queue.length) {
    for (const edge of adjacency.get(queue.shift()!) ?? []) {
      criticalEdgeIds.push(edge.id);
      if (seen.has(edge.target)) continue;
      seen.add(edge.target); affectedIds.push(edge.target); queue.push(edge.target);
    }
  }
  return { rootId, affectedIds, criticalEdgeIds, complete: false };
}
