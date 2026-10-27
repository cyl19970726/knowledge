import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GraphResult, KnowledgeDocument, KnowledgeRef, Relation } from '@commerce/knowledge-contracts';
import { layoutEdges, refKey, selectedRelations, shortLabel, toGraphView } from '../src/graph/view-model.ts';
import { framePositions, panKeepingWorldCenter } from '../src/graph/frame.ts';

test('resizing keeps the same world point under the viewport center', () => {
  const before = { width: 795, height: 500 }, after = { width: 368, height: 390 };
  const zoom = 1.35, pan = { x: -60, y: 25 };
  const worldCenter = { x: (before.width / 2 - pan.x) / zoom, y: (before.height / 2 - pan.y) / zoom };
  const resized = panKeepingWorldCenter(pan, before, after);
  assert.deepEqual({ x: worldCenter.x * zoom + resized.x, y: worldCenter.y * zoom + resized.y }, { x: after.width / 2, y: after.height / 2 });
  assert.equal(panKeepingWorldCenter(resized, after, { width: 0, height: 0 }), resized);
});

const scope = { projectId: 'project', spaceId: 'space' };
const ref = (objectId: string, versionId: string, domain: KnowledgeRef['domain'] = 'knowledge'): KnowledgeRef => ({ ...scope, objectId, versionId, domain, contentDigest: null }) as KnowledgeRef;
const document = (value: KnowledgeRef, title: string): KnowledgeDocument => ({ ref: value, title }) as KnowledgeDocument;
const relation = (id: string, from: KnowledgeRef, to: KnowledgeRef, stance: Relation['stance']): Relation => ({ id, relationVersion: 'v1', from, to, stance }) as Relation;

test('keeps exact versions and parallel relations separate', () => {
  const v1 = ref('object-a', 'v1');
  const v2 = ref('object-a', 'v2');
  const other = ref('object-b', 'v1');
  const graph: GraphResult = { nodes: [document(v1, '旧判断'), document(v2, '新判断'), document(other, '其他判断')], externalNodes: [], edges: [relation('supports-1', v1, other, 'supports'), relation('challenges-1', v1, other, 'challenges'), relation('history', v2, v1, 'navigation')] };
  const view = toGraphView(graph, v1, 'focused');
  assert.equal(view.nodes.length, 3);
  assert.equal(view.edges.length, 3);
  assert.notEqual(refKey(v1), refKey(v2));
  assert.deepEqual(selectedRelations(view, refKey(v1)).map(edge => edge.relation.stance), ['supports', 'challenges', 'navigation']);
});

test('retains multi-source ancestry as edges, without compound parenting', () => {
  const claim = ref('claim', 'v1');
  const sourceA = ref('source-a', 'v1', 'source');
  const sourceB = ref('source-b', 'v1', 'source');
  const graph: GraphResult = {
    nodes: [document(claim, '一个有条件的解释')],
    externalNodes: [{ ref: sourceA, label: '来源甲', availability: 'metadata_only' }, { ref: sourceB, label: '来源乙', availability: 'unknown' }],
    edges: [relation('basis-a', sourceA, claim, 'supports'), relation('basis-b', sourceB, claim, 'context')],
  };
  const view = toGraphView(graph, claim, 'focused');
  assert.equal(view.nodes.length, 3);
  assert.equal(view.edges.length, 2);
  assert.deepEqual(view.nodes.filter(node => node.document === null).map(node => node.availability), ['metadata_only', 'unknown']);
  assert.ok(view.edges.every(edge => edge.to === refKey(claim)));
});

test('long Chinese labels are shortened only on canvas', () => {
  const title = '有些差异能被镜头直接看见，有些差异需要情境解释';
  const claim = ref('claim', 'v1');
  const view = toGraphView({ nodes: [document(claim, title)], externalNodes: [], edges: [] }, claim, 'global');
  assert.equal(view.nodes[0].title, title);
  assert.equal(view.nodes[0].shortLabel, shortLabel(title));
  assert.ok(view.nodes[0].shortLabel.endsWith('…'));
});

test('shared source and parallel relations do not dominate visual layout springs', () => {
  const source = ref('shared-source', 'v1', 'source');
  const claims = Array.from({ length: 6 }, (_, index) => ref(`claim-${index}`, 'v1'));
  const graph: GraphResult = {
    nodes: claims.map((item, index) => document(item, `认识${index}`)),
    externalNodes: [{ ref: source, label: '同一原片', availability: 'metadata_only' }],
    edges: [
      ...claims.map((item, index) => relation(`source-${index}`, source, item, 'context')),
      relation('parallel-a', claims[0], claims[1], 'supports'),
      relation('parallel-b', claims[0], claims[1], 'challenges'),
    ],
  };
  const view = toGraphView(graph, claims[0], 'global');
  assert.equal(view.edges.length, 8);
  assert.equal(layoutEdges(view).length, 3);
  assert.equal(layoutEdges(view).filter(edge => edge.from === refKey(source)).length, 2);
});

test('global hub and colors derive from knowledge links rather than common-source degree', () => {
  const shared = ref('shared', 'v1', 'source');
  const center = ref('center', 'v1');
  const leaves = Array.from({ length: 6 }, (_, index) => ref(`leaf-${index}`, 'v1'));
  const graph: GraphResult = {
    nodes: [document(leaves[0], '第一条'), document(center, '中心综合'), ...leaves.slice(1).map((item, index) => document(item, `叶${index}`))],
    externalNodes: [{ ref: shared, label: '共同来源', availability: 'unknown' }],
    edges: [...leaves.map((item, index) => relation(`internal-${index}`, center, item, 'navigation')), ...leaves.map((item, index) => relation(`external-${index}`, shared, item, 'context'))],
  };
  const view = toGraphView(graph, leaves[0], 'global');
  assert.equal(view.rootId, refKey(center));
  assert.equal(view.nodes.find(node => node.id === refKey(shared))?.degree, 0);
  assert.equal(view.nodes.find(node => node.id === refKey(shared))?.tone, 'grey');
});

test('automatic coordinates are framed to viewport without source outlier compressing knowledge', () => {
  const center = ref('center', 'v1'), left = ref('left', 'v1'), right = ref('right', 'v1'), source = ref('source', 'v1', 'source');
  const graph: GraphResult = { nodes: [document(center, '中心'), document(left, '左'), document(right, '右')], externalNodes: [{ ref: source, label: '来源', availability: 'unknown' }], edges: [relation('l', center, left, 'supports'), relation('r', center, right, 'supports'), relation('s', source, center, 'context')] };
  const view = toGraphView(graph, center, 'global');
  const raw = { [refKey(center)]: { x: 1100, y: 1500 }, [refKey(left)]: { x: 100, y: 100 }, [refKey(right)]: { x: 2100, y: 2900 }, [refKey(source)]: { x: -10000, y: -10000 } };
  const framed = framePositions(view, raw, 900, 500);
  assert.deepEqual(framed[refKey(center)], { x: 450, y: 250 });
  assert.ok(framed[refKey(left)].x < 450 && framed[refKey(right)].x > 450);
  assert.ok(Object.values(framed).every(position => Number.isFinite(position.x) && Number.isFinite(position.y) && position.x >= 0 && position.x <= 900 && position.y >= 0 && position.y <= 500));
  assert.ok(framed[refKey(right)].x - framed[refKey(left)].x > 500);
});

test('six topology hubs remain separate, centered and finite after crowded ELK output', () => {
  const center = ref('center', 'v1');
  const hubs = Array.from({ length: 6 }, (_, index) => ref(`hub-${index}`, 'v1'));
  const leaves = hubs.flatMap((_, hub) => Array.from({ length: 3 }, (_, leaf) => ref(`leaf-${hub}-${leaf}`, 'v1')));
  const graph: GraphResult = {
    nodes: [document(center, '中心综合'), ...hubs.map((item, index) => document(item, `主题${index}`)), ...leaves.map((item, index) => document(item, `细节${index}`))], externalNodes: [],
    edges: [...hubs.map((item, index) => relation(`hub-${index}`, center, item, 'navigation')),
      ...hubs.flatMap((item, hub) => leaves.slice(hub * 3, hub * 3 + 3).map((leaf, index) => relation(`leaf-${hub}-${index}`, item, leaf, 'navigation')))],
  };
  const view = toGraphView(graph, center, 'global');
  const raw: Record<string, { x: number; y: number }> = { [refKey(center)]: { x: 1000, y: 1000 } };
  hubs.forEach((item, index) => { raw[refKey(item)] = { x: 1070 + index * 8, y: 1000 + index * 6 }; });
  leaves.forEach((item, index) => { raw[refKey(item)] = { x: 1100 + index * 7, y: 1030 + index * 5 }; });
  const framed = framePositions(view, raw, 800, 520), centerPoint = framed[refKey(center)];
  assert.deepEqual(centerPoint, { x: 400, y: 260 });
  const hubPositions = hubs.map(item => framed[refKey(item)]);
  assert.ok(hubPositions.every(position => Math.hypot(position.x - 400, position.y - 260) >= 140));
  for (let i = 0; i < hubPositions.length; i++) for (let j = i + 1; j < hubPositions.length; j++)
    assert.ok(Math.hypot(hubPositions[i].x - hubPositions[j].x, hubPositions[i].y - hubPositions[j].y) >= 140);
  assert.ok(Object.values(framed).every(position => Number.isFinite(position.x) && Number.isFinite(position.y) && position.x >= 0 && position.x <= 800 && position.y >= 0 && position.y <= 520));
});
