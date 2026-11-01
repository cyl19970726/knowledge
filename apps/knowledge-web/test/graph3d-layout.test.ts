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

function sourceFixture(): GraphViewModel {
  return {
    nodes: [node('A'), node('B'), node('C'), node('D'), node('S', true)],
    edges: [
      edge('a-b', 'A', 'B', 'context'),
      edge('c-d', 'C', 'D', 'context'),
      edge('s-a', 'S', 'A', 'context'),
      edge('s-b', 'S', 'B', 'context'),
      edge('s-c', 'S', 'C', 'supports'),
    ],
    rootId: 'C', mode: 'global',
  };
}

function duplicateSourceFixture(): GraphViewModel {
  return {
    nodes: [node('A'), node('B'), node('C'), node('D'), node('S', true)],
    edges: [
      edge('a-b', 'A', 'B', 'context'),
      edge('c-d', 'C', 'D', 'context'),
      edge('s-a-1', 'S', 'A', 'context'),
      edge('s-a-2', 'S', 'A', 'context'),
      edge('s-c', 'S', 'C', 'context'),
      edge('s-d', 'S', 'D', 'context'),
    ],
    rootId: 'C', mode: 'global',
  };
}

test('overview groups knowledge connections, keeps shared sources outside groups, and retains every returned relation', () => {
  const graph = fixture();
  const layout = constellationLayout(graph);
  assert.equal(layout.groups.flatMap(group => group.members).length, 5);
  assert.ok(layout.groups.every(group => !group.members.includes('S') && group.name.length > 0));
  assert.ok(layout.positions.S);
  assert.equal(layout.visibleEdges.filter(id => id.startsWith('source-')).length, 64);
  assert.equal(layout.visibleEdges.length, graph.edges.length);
  assert.equal(layout.hiddenEdgeCount, 0);
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

test('a shared source sits near its dominant connected group without dropping other links', () => {
  const graph = sourceFixture();
  const layout = constellationLayout(graph);
  const dominant = layout.groups.find(group => group.members.includes('A'));
  assert.ok(dominant);
  const source = layout.positions.S;
  assert.ok(Math.hypot(source[0] - dominant.center[0], source[1] - dominant.center[1]) < 3.1);
  assert.equal(layout.visibleEdges.length, graph.edges.length);
  assert.equal(layout.hiddenEdgeCount, 0);
  assert.equal(layout.bridgeEdges.length, 0);
});

test('cross-group judgment edges are identified as bridges from the same returned relations', () => {
  const ids = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
  const chain = ids.slice(1).map((id, index) => edge(`chain-${index}`, ids[index], id, 'navigation'));
  const graph: GraphViewModel = { nodes: ids.map(id => node(id)), edges: chain, rootId: 'C', mode: 'global' };
  const bridgeId = constellationLayout(graph).bridgeEdges[0];
  assert.ok(bridgeId);
  const upgraded: GraphViewModel = {
    ...graph,
    edges: chain.map(item => item.id === bridgeId ? { ...item, relation: { ...item.relation, stance: 'supports' } } : item),
  };
  const layout = constellationLayout(upgraded);
  const groupOf = new Map(layout.groups.flatMap(group => group.members.map(id => [id, group.id] as const)));
  assert.ok(layout.bridgeEdges.includes(bridgeId));
  assert.ok(layout.bridgeEdges.every(id => {
    const relation = upgraded.edges.find(item => item.id === id)!;
    const fromGroup = groupOf.get(relation.from), toGroup = groupOf.get(relation.to);
    return !!fromGroup && !!toGroup && fromGroup !== toGroup;
  }));
});

test('duplicate source relations do not inflate its dominant group or visible degree', () => {
  const graph = duplicateSourceFixture();
  const layout = constellationLayout(graph);
  const dominant = layout.groups.find(group => group.members.includes('C'));
  const other = layout.groups.find(group => group.members.includes('A'));
  assert.ok(dominant && other);
  const source = layout.positions.S;
  assert.ok(Math.hypot(source[0] - dominant.center[0], source[1] - dominant.center[1]) < 3.1);
  assert.ok(Math.hypot(source[0] - dominant.center[0], source[1] - dominant.center[1]) < Math.hypot(source[0] - other.center[0], source[1] - other.center[1]));
  assert.equal(layout.connectionCounts.S, 3);
});

test('empty and single-node graphs keep bridge and source layout state finite', () => {
  const empty = constellationLayout({ nodes: [], edges: [], rootId: null, mode: 'global' });
  assert.deepEqual(empty.groups, []);
  assert.deepEqual(empty.visibleEdges, []);
  assert.deepEqual(empty.bridgeEdges, []);
  assert.deepEqual(empty.connectionCounts, {});
  const single = constellationLayout({ nodes: [node('A')], edges: [], rootId: 'A', mode: 'global' });
  assert.deepEqual(single.positions.A, [0, 0, 0.6]);
  assert.deepEqual(single.bridgeEdges, []);
  assert.equal(single.connectionCounts.A, 0);
});
