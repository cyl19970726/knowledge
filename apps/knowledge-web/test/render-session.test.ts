import assert from 'node:assert/strict';
import { test } from 'node:test';
import cytoscape, { type Core } from 'cytoscape';
import type { GraphResult, KnowledgeDocument, KnowledgeRef, Relation } from '@commerce/knowledge-contracts';
import { GraphRenderSession, renderedLabelCandidates } from '../src/graph/render-session.ts';
import { toGraphView, type GraphViewModel } from '../src/graph/view-model.ts';
import { placeLabels } from '../src/graph/labels.ts';

const ref = (objectId: string, domain: KnowledgeRef['domain'] = 'knowledge'): KnowledgeRef =>
  ({ projectId: 'synthetic', spaceId: 'space', objectId, versionId: 'v1', domain, contentDigest: null }) as KnowledgeRef;
const claims = Array.from({ length: 3 }, (_, i) => ref(`claim-${i}`));
const evidence = Array.from({ length: 9 }, (_, i) => ref(`evidence-${i}`, 'evidence'));
const result: GraphResult = {
  nodes: claims.map(value => ({ ref: value, title: value.objectId }) as KnowledgeDocument),
  externalNodes: evidence.map(value => ({ ref: value, label: 'Evidence', availability: 'unknown' })),
  edges: [...evidence.map((value, i) => [value, claims[i % 3]]), ...claims.map((value, i) => [value, claims[(i + 1) % 3]])]
    .map(([from, to], i) => ({ id: `relation-${i}`, relationVersion: 'v1', from, to, stance: 'context' }) as Relation),
};
function install(cy: Core, graph: GraphViewModel): void {
  cy.add([
    ...graph.nodes.map((node, i) => ({ data: { id: node.id }, position: { x: 50 + i * 30, y: 100 + i * 12 } })),
    ...graph.edges.map(edge => ({ data: { id: edge.id, source: edge.from, target: edge.to } })),
  ]);
}

test('global → query delayed layout cannot use stale ready state on an empty canvas; retains every node and relation', async () => {
  const global = toGraphView(result, null, 'global'), query = toGraphView(result, claims[1], 'focused');
  const oldCy = cytoscape({ headless: true }), cy = cytoscape({ headless: true });
  const old = new GraphRenderSession(oldCy, global), current = new GraphRenderSession(cy, query);
  try {
    old.completeLayout(value => install(value, global));
    old.dispose(); oldCy.destroy();
    let resolveLayout!: () => void;
    const layout = new Promise<void>(resolve => { resolveLayout = resolve; }).then(() => current.completeLayout(value => install(value, query)));
    let selectionRuns = 0;
    const selectAndLabel = (value: Core) => { selectionRuns++; value.getElementById(query.rootId!).select(); placeLabels(renderedLabelCandidates(value, query, query.rootId), 800, 600); };
    // React's previous layoutState can still be 'ready' in this commit, while the new instance has no elements.
    assert.equal(cy.nodes().length, 0);
    assert.equal(current.run(query, selectAndLabel), false);
    assert.deepEqual(renderedLabelCandidates(cy, query, query.rootId), []);
    assert.equal(selectionRuns, 0);
    resolveLayout(); assert.equal(await layout, true);
    assert.equal(current.run(global, selectAndLabel), false, 'shared IDs do not make the previous graph instance current');
    assert.equal(current.run(query, selectAndLabel), true);
    assert.equal(selectionRuns, 1);
    assert.deepEqual(cy.nodes().map(node => node.id()).sort(), query.nodes.map(node => node.id).sort());
    assert.deepEqual(cy.edges().map(edge => edge.id()).sort(), query.edges.map(edge => edge.id).sort());
    assert.equal(cy.nodes(':selected').length, 1);
    assert.equal(renderedLabelCandidates(cy, query, query.rootId).length, 12);
    assert.equal(cy.edges().length, 12);
  } finally { current.dispose(); cy.destroy(); if (!oldCy.destroyed()) oldCy.destroy(); }
});

test('superseded layout and scheduled effects cannot mutate a disposed graph', async () => {
  const graph = toGraphView(result, null, 'global'), cy = cytoscape({ headless: true });
  const session = new GraphRenderSession(cy, graph);
  let installs = 0, effects = 0;
  const delayed = Promise.resolve().then(() => session.completeLayout(value => { installs++; install(value, graph); }));
  session.dispose(); cy.destroy();
  assert.equal(await delayed, false);
  assert.equal(session.run(graph, () => { effects++; }), false);
  assert.equal(installs, 0); assert.equal(effects, 0);
});

test('non-finite rendered geometry suppresses labels only; incomplete installation reports an error', () => {
  const graph = toGraphView(result, null, 'global'), cy = cytoscape({ headless: true });
  try {
    install(cy, graph);
    cy.getElementById(graph.nodes[0].id).position({ x: Number.NaN, y: 100 });
    const labels = renderedLabelCandidates(cy, graph, null);
    assert.equal(labels.length, 11);
    assert.ok(labels.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)));
    assert.equal(cy.nodes().length, 12); assert.equal(cy.edges().length, 12);
    const incomplete = new GraphRenderSession(cy, { ...graph, nodes: [...graph.nodes, { ...graph.nodes[0], id: 'not-installed' }] });
    assert.throws(() => incomplete.completeLayout(() => {}), /图谱缺少元素/);
    assert.equal(incomplete.run(graph, () => assert.fail('incomplete graph must not be ready')), false);
  } finally { cy.destroy(); }
});
