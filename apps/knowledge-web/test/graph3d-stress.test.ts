import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphEdgeView, GraphNodeView, GraphViewModel } from '../src/graph/view-model';
import { constellationLayout, questionLayout } from '../src/graph3d/layout';

function node(index: number): GraphNodeView {
  const id = `node-${String(index).padStart(3, '0')}`;
  return {
    id,
    ref: {} as GraphNodeView['ref'],
    title: `压力认识 ${index}`,
    shortLabel: `认识 ${index}`,
    degree: 0,
    tone: 'violet',
    isRoot: index === 0,
    document: {} as GraphNodeView['document'],
    availability: 'knowledge',
  };
}

function edge(index: number, from: number, to: number): GraphEdgeView {
  const stance = index % 47 === 0 ? 'challenges' : index % 11 === 0 ? 'supports' : index % 5 === 0 ? 'navigation' : 'context';
  return {
    id: `edge-${String(index).padStart(3, '0')}`,
    from: `node-${String(from).padStart(3, '0')}`,
    to: `node-${String(to).padStart(3, '0')}`,
    relation: { id: `edge-${index}`, stance, evidenceStatus: 'unknown' } as GraphEdgeView['relation'],
  };
}

function stressFixture(): GraphViewModel {
  const nodes = Array.from({ length: 200 }, (_, index) => node(index));
  const edges: GraphEdgeView[] = [];
  for (let cluster = 0; cluster < 10; cluster += 1) {
    const start = cluster * 20;
    for (let offset = 0; offset < 20; offset += 1) {
      edges.push(edge(edges.length, start + offset, start + (offset + 1) % 20));
    }
  }
  for (let cluster = 1; cluster < 10; cluster += 1) {
    edges.push(edge(edges.length, cluster * 20, (cluster - 1) * 20 + 7));
  }
  while (edges.length < 500) {
    const index = edges.length;
    const from = index % 200;
    const to = (from + 1 + (index * 37) % 199) % 200;
    edges.push(edge(index, from, to));
  }
  return { nodes, edges: edges.slice(0, 500), rootId: nodes[0].id, mode: 'global' };
}

test('200-node and 500-edge layout remains finite within the pressure budget', () => {
  const graph = stressFixture();
  const started = performance.now();
  const layout = constellationLayout(graph);
  const question = questionLayout(graph, layout, graph.nodes[0].id);
  const elapsed = performance.now() - started;
  assert.equal(layout.visibleEdges.length, 500);
  assert.ok(layout.connectionCounts[graph.nodes[0].id] > 0);
  assert.equal(Object.keys(layout.positions).length, 200);
  assert.ok(Object.values(layout.positions).every(point => point.every(Number.isFinite)));
  assert.ok(question.visibleEdges.length > 0);
  assert.ok(elapsed < 3000, `layout took ${elapsed.toFixed(0)}ms`);
});
