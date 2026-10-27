import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createKnowledgeGraphProjection, computeGraphImpact, getKnowledgeGraphRelation, graphNodeId } from '../src/graph.ts';
import type { KnowledgeService } from '../src/service.ts';
import type { KnowledgeRevision, RevisionView } from '../src/types.ts';
import { caseRevision, ref, scope, SyntheticAnalysis, timestamp } from './service-fixtures.ts';

const projectId = 'graph-project';
const product = ref();
function row(revision: KnowledgeRevision): RevisionView {
  return { revision, current: true, published: true, review: { id: randomUUID(), projectId, changeSetId: randomUUID(), contentHash: 'a'.repeat(64), reviewer: 'test', policyVersion: 'test', purpose: 'exploration_reading', decision: 'exploration_only', rationale: 'test', createdAt: timestamp }, validity: { valid: true, issues: [] } };
}
function base(kind: KnowledgeRevision['kind'], title: string): Omit<KnowledgeRevision, 'kind' | 'content'> {
  return { ref: ref(), projectId, title, body: title, scope: scope(product), dependencies: [], sourceGroups: [], artifactRef: null, createdAt: timestamp, analysisQuality: null };
}
function fake(rows: RevisionView[], older: RevisionView[] = []): KnowledgeService {
  return { search: async (_project: string, opts: {offset?: number}) => opts.offset ? [] : rows,
    get: async (_project: string, exact: {objectId: string;versionId: string}) => older.find(v => v.revision.ref.objectId === exact.objectId && v.revision.ref.versionId === exact.versionId) ?? null,
    readAnalysis: async () => { throw new Error('unavailable'); } } as unknown as KnowledgeService;
}

test('graph follows stored critical semantics; Wiki containment and navigation do not propagate impact', async () => {
  const source = { ...base('case','Concrete example'), kind: 'case' as const, content: { schemaVersion: '1.0' as const, ref: ref(), projectId, analysisResultRef: ref(), title: 'Concrete example', summary: 'Observed action', citations: [], createdAt: timestamp } };
  source.content.ref = source.ref;
  const counter = { ...base('case','Counterexample'), kind: 'case' as const, content: { schemaVersion: '1.0' as const, ref: ref(), projectId, analysisResultRef: ref(), title: 'Counterexample', summary: 'Observed reversal', citations: [], createdAt: timestamp } };
  counter.content.ref = counter.ref;
  const pattern = { ...base('pattern','Pattern'), kind: 'pattern' as const, content: { ref: ref(), projectId, title: 'Pattern', problem: 'attention', mechanism: 'reveal', sequence: ['setup','turn'], requiredElements: ['turn'], variableSlots: [], applicability: ['short videos'], exclusions: [], supportRefs: [source.ref], counterexampleRefs: [counter.ref], prediction: 'test', evidenceLevel: 'single_case' as const, citations: [] } };
  pattern.content.ref = pattern.ref;
  pattern.dependencies = [{domain:'knowledge',ref:source.ref,role:'supports',critical:true},{domain:'knowledge',ref:counter.ref,role:'challenges',critical:true}];
  const wiki = { ...base('wiki','Topic'), kind: 'wiki' as const, content: { ref: ref(), projectId, title: 'Topic', question: 'How?', claimRefs: [], patternRefs: [pattern.ref], relatedRefs: [counter.ref], disputes: [], nextQuestions: [], citations: [] } };
  wiki.content.ref = wiki.ref;
  wiki.dependencies = [{domain:'knowledge',ref:pattern.ref,role:'uses',critical:false},{domain:'knowledge',ref:counter.ref,role:'uses',critical:false}];
  const graph = await createKnowledgeGraphProjection(fake([row(source),row(counter),row(pattern),row(wiki)]),projectId);
  const s=graphNodeId('knowledge',source.ref),c=graphNodeId('knowledge',counter.ref),p=graphNodeId('knowledge',pattern.ref),w=graphNodeId('knowledge',wiki.ref);
  assert.equal(graph.edges.find(e=>e.source===s&&e.target===p)?.role,'supports');
  assert.equal(graph.edges.find(e=>e.source===c&&e.target===p)?.role,'challenges');
  assert.equal(graph.edges.find(e=>e.source===c&&e.target===w)?.critical,false);
  assert.deepEqual(computeGraphImpact(graph,c).affectedIds,[p]);
  assert.deepEqual(computeGraphImpact(graph,s).affectedIds,[p]);
  assert.equal(computeGraphImpact(graph,w).affectedIds.length,0);
});

test('linked historical versions are exact and project-isolated; truncation makes impact incomplete', async () => {
  const prior = { ...base('claim','Earlier claim'), kind:'claim' as const, content: { schemaVersion:'1.0' as const, ref:ref(), projectId, statement:'Earlier claim', claimKind:'observation' as const, citations:[],conditions:[],limitations:[],adoption:'candidate' as const,approvedPurpose:null,createdAt:timestamp } };
  prior.content.ref = prior.ref;
  const dependent = { ...base('wiki','Current topic'),kind:'wiki' as const,content:{ref:ref(),projectId,title:'Current topic',question:'Why?',claimRefs:[prior.ref],patternRefs:[],relatedRefs:[],disputes:[],nextQuestions:[],citations:[]} };
  dependent.content.ref=dependent.ref;
  const graph=await createKnowledgeGraphProjection(fake([row(dependent)],[row(prior)]),projectId);
  assert.ok(graph.nodes.some(n=>n.id===graphNodeId('knowledge',prior.ref)));
  assert.ok(graph.edges.some(e=>e.source===graphNodeId('knowledge',prior.ref)&&e.target===graphNodeId('knowledge',dependent.ref)&&e.role==='contains'&&!e.critical));
  assert.equal(graph.truncated,false);
  assert.equal(computeGraphImpact({...graph,truncated:true},graphNodeId('knowledge',prior.ref)).complete,false);
  const foreign={...prior,projectId:'foreign'};
  const isolated=await createKnowledgeGraphProjection(fake([row(dependent)],[row(foreign)]),projectId);
  assert.ok(!isolated.nodes.some(n=>n.id===graphNodeId('knowledge',prior.ref)));
});

test('registered media anchor, analysis and context retain exact evidence identities', async () => {
  const media=new SyntheticAnalysis().add(projectId);
  const item=caseRevision(projectId,product,media.result,media.anchor,'hook source');
  assert.ok(item.kind==='case');
  item.dependencies=[{domain:'evidence',ref:media.anchor.sourceRef,role:'supports',critical:true}];
  const reader={...fake([row(item)]),readAnalysis:async()=>({result:media.result,snapshot:media.snapshot})} as KnowledgeService;
  const graph=await createKnowledgeGraphProjection(reader,projectId);
  const evidence=graph.nodes.find(n=>n.kind==='evidence'&&n.anchor?.sourceRef.versionId===media.anchor.sourceRef.versionId);
  assert.ok(evidence);
  assert.equal(evidence.assetVersionId,media.anchor.assetVersionId);
  assert.deepEqual(evidence.knowledgeRef,item.ref);
  assert.equal(evidence.id,graphNodeId('evidence',media.anchor.sourceRef));
  assert.match(evidence.label,/^证据 · 全片$/);
  assert.equal(graph.nodes.filter(n=>n.kind==='evidence').length,1);
  assert.ok(graph.edges.every(e=>e.source!==e.target));
  assert.ok(graph.edges.some(e=>e.source===evidence.id&&e.target===graphNodeId('knowledge',item.ref)&&e.critical));
  const edge=graph.edges.find(e=>e.source===evidence.id&&e.target===graphNodeId('knowledge',item.ref));
  assert.equal(edge?.citations,undefined);
  assert.equal(edge?.rationale,undefined);
  assert.equal(edge?.detailAvailable,true);
  const detailed=await createKnowledgeGraphProjection(reader,projectId,true);
  const exact=detailed.edges.find(e=>e.source===evidence.id&&e.target===graphNodeId('knowledge',item.ref));
  assert.deepEqual(exact?.citations,item.content.citations);
  assert.equal(exact?.rationale,item.content.citations[0].supports);
  const relation=await getKnowledgeGraphRelation({get:async()=>row(item)} as unknown as KnowledgeService,projectId,
    evidence.id,graphNodeId('knowledge',item.ref),'supports');
  assert.deepEqual(relation?.citations,item.content.citations);
  assert.equal(await getKnowledgeGraphRelation({get:async()=>null} as unknown as KnowledgeService,projectId,
    evidence.id,graphNodeId('knowledge',item.ref),'supports'),null);
  assert.deepEqual(edge?.targetRef,item.ref);

  assert.ok(graph.edges.some(e=>e.source===graphNodeId('context',media.snapshot.ref)&&e.target===graphNodeId('analysis',media.result.ref)&&e.critical));
  assert.equal(graph.nodes.find(n=>n.id===graphNodeId('analysis',media.result.ref))?.assetVersionId,media.result.assetVersionId);
  assert.match(graph.nodes.find(n=>n.kind==='asset')?.label??'',/素材 · hook source/);
  assert.ok(computeGraphImpact(graph,evidence.id).affectedIds.includes(graphNodeId('knowledge',item.ref)));
});

test('conflicting asset or scope for one evidence version remains visibly separate and incomplete', async () => {
  const media=new SyntheticAnalysis().add(projectId);
  const first=caseRevision(projectId,product,media.result,media.anchor,'first case');
  const second=caseRevision(projectId,product,media.result,{...media.anchor,assetVersionId:randomUUID()},'second case');
  const reader={...fake([row(first),row(second)]),readAnalysis:async()=>({result:media.result,snapshot:media.snapshot})} as KnowledgeService;
  const graph=await createKnowledgeGraphProjection(reader,projectId);
  const anchors=graph.nodes.filter(n=>n.kind==='evidence'&&n.anchor);
  assert.equal(anchors.length,2);
  assert.notEqual(anchors[0].id,anchors[1].id);
  assert.equal(graph.truncated,true);
  const conflict=graph.nodes.find(n=>n.id===graphNodeId('evidence',media.anchor.sourceRef));
  assert.equal(conflict?.status,'invalid');
  assert.match(conflict?.summary??'',/不同素材或时间范围/);
  assert.ok(graph.edges.some(e=>e.source===conflict?.id&&e.target===anchors[0].id));
  assert.ok(graph.edges.every(e=>e.source!==e.target));
});

test('impact traversal terminates on cycles and counts only reachable critical edges', () => {
  const nodes=['a','b','c'].map(id=>({id}));
  const graph={truncated:false,nodes,edges:[{id:'ab',source:'a',target:'b',critical:true},{id:'ba',source:'b',target:'a',critical:true},{id:'bc',source:'b',target:'c',critical:false}]} as Parameters<typeof computeGraphImpact>[0];
  const impact=computeGraphImpact(graph,'a');
  assert.deepEqual(impact.affectedIds,['b']);
  assert.deepEqual(impact.criticalEdgeIds,['ab','ba']);
  assert.equal(impact.complete,false);
});

test('knowledge scan limit is explicit and does not imply complete impact', async () => {
  const rows=Array.from({length:201},(_,i)=>{
    const item={...base('claim',`claim ${i}`),kind:'claim' as const,content:{schemaVersion:'1.0' as const,ref:ref(),projectId,statement:`claim ${i}`,claimKind:'observation' as const,citations:[],conditions:[],limitations:[],adoption:'candidate' as const,approvedPurpose:null,createdAt:timestamp}};
    item.content.ref=item.ref;return row(item);
  });
  const knowledge={search:async (_project:string,opts:{limit:number;offset:number})=>rows.slice(opts.offset,opts.offset+opts.limit),get:async()=>null} as unknown as KnowledgeService;
  const graph=await createKnowledgeGraphProjection(knowledge,projectId);
  assert.equal(graph.nodes.filter(node=>node.kind==='claim').length,200);
  assert.equal('items' in graph,false);
  assert.equal(graph.truncated,true);
  assert.equal(computeGraphImpact(graph,graph.nodes[0].id).complete,false);
});
