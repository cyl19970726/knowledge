import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphEdgeView, GraphNodeView, GraphViewModel } from '../src/graph/view-model';
import { constellationLayout, questionLayout } from '../src/graph3d/layout';

function node(id: string, source = false): GraphNodeView {
  return {
    id, ref: {} as GraphNodeView['ref'], title: id, shortLabel: id, degree: 0,
    tone: 'violet', isRoot: id === 'C', document: source ? null : {} as GraphNodeView['document'],
    availability: source ? 'unknown' : 'knowledge',
  };
}

function edge(id: string, from: string, to: string, stance: GraphEdgeView['relation']['stance']): GraphEdgeView {
  return { id, from, to, relation: { id, stance, evidenceStatus: 'unknown' } as GraphEdgeView['relation'] };
}

function fixture(): GraphViewModel {
  const sourceEdges = Array.from({ length: 64 }, (_, index) => edge(`source-${index}`, 'S', index % 2 ? 'A' : 'B', 'context'));
  return {
    nodes: [node('A'), node('B'), node('C'), node('D'), node('E'), node('S', true)],
    edges: [edge('a-c', 'A', 'C', 'supports'), edge('b-c', 'B', 'C', 'supports'), edge('d-c', 'D', 'C', 'challenges'), edge('c-e', 'C', 'E', 'navigation'), ...sourceEdges],
    rootId: 'C', mode: 'global',
  };
}

test('overview groups only returned knowledge connections and keeps a shared source outside groups', () => {
  const graph = fixture();
  const layout = constellationLayout(graph);
  assert.equal(layout.groups.flatMap(group => group.members).length, 5);
  assert.ok(layout.groups.every(group => !group.members.includes('S') && group.name.length > 0));
  assert.ok(layout.positions.S);
  assert.equal(layout.visibleEdges.filter(id => id.startsWith('source-')).length, 0);
  assert.equal(layout.hiddenEdgeCount, 64);
  assert.equal(graph.edges.length, 68);
  assert.deepEqual(layout, constellationLayout(graph));
});

test('question plane keeps two incoming supports and a challenge readable without changing relation direction', () => {
  const graph = fixture();
  const base = constellationLayout(graph);
  const question = questionLayout(graph, base, 'C');
  assert.deepEqual(question.reading?.supports, ['A', 'B']);
  assert.deepEqual(question.reading?.challenges, ['D']);
  assert.deepEqual(question.positions.C, [0, -1.15, 3]);
  assert.ok(question.positions.A[0] < question.positions.B[0]);
  assert.ok(question.positions.A[1] > question.positions.C[1]);
  assert.ok(question.positions.D[1] < question.positions.C[1]);
  assert.ok(question.positions.E[2] < 0);
  assert.deepEqual(question.positions.E, questionLayout(graph, base, 'C').positions.E);
  assert.ok(question.visibleEdges.includes('a-c'));
  assert.ok(question.visibleEdges.includes('b-c'));
  assert.ok(question.visibleEdges.includes('d-c'));
  assert.equal(graph.edges.find(item => item.id === 'd-c')?.from, 'D');
  assert.equal(graph.edges.find(item => item.id === 'd-c')?.to, 'C');
  assert.equal(graph.edges.find(item => item.id === 'd-c')?.relation.evidenceStatus, 'unknown');
});

test('source focus folds duplicate directional lines while every original relation stays available', () => {
  const graph = fixture();
  const question = questionLayout(graph, constellationLayout(graph), 'S');
  assert.equal(question.visibleEdges.filter(id => id.startsWith('source-')).length, 2);
  assert.equal(question.hiddenEdgeCount, graph.edges.length - question.visibleEdges.length);
  assert.equal(graph.edges.filter(item => item.from === 'S').length, 64);
});
