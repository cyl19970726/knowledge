import assert from 'node:assert/strict';
import test from 'node:test';
import type { AskResult, KnowledgeRef } from '@commerce/knowledge-contracts';
import type { GraphViewModel } from '../src/graph/view-model.ts';
import { actualGraphReadIds, actualWikiRefs, graphNodeForExactRef } from '../src/ask-graph.ts';

const ref: KnowledgeRef = { projectId: 'project', spaceId: 'space', domain: 'knowledge', objectId: 'one', versionId: 'v2', contentDigest: 'a'.repeat(64) };
const node = (id: string, value: KnowledgeRef) => ({ id, ref: value, title: '同名认识', shortLabel: '同名认识', degree: 0, tone: 'violet' as const,
  isRoot: false, document: {} as GraphViewModel['nodes'][number]['document'], availability: 'knowledge' as const });
const graph: GraphViewModel = { rootId: 'current', mode: 'global', edges: [], nodes: [
  node('current', ref), node('old-head', { ...ref, versionId: 'v1' }), node('other-digest', { ...ref, contentDigest: 'b'.repeat(64) }),
] };

test('only exact scope/domain/object/version/digest joins an answered Wiki read to the graph', () => {
  const result = { state: 'answered', evidence: [{ kind: 'wiki_page', ref }] } as AskResult;
  assert.deepEqual(actualGraphReadIds(graph, actualWikiRefs(result)), ['current']);
  for (const altered of [{ versionId: 'v1' }, { contentDigest: 'b'.repeat(64) }, { spaceId: 'other' }, { projectId: 'other' },
    { domain: 'commerce-asset-version' as KnowledgeRef['domain'] }, { objectId: 'other' }, { contentDigest: null }]) {
    assert.equal(graphNodeForExactRef(graph, { ...ref, ...altered }), altered.versionId === 'v1' ? 'old-head' : altered.contentDigest === 'b'.repeat(64) ? 'other-digest' : null);
  }
  assert.deepEqual(actualWikiRefs({ ...result, state: 'outcome_unknown' } as AskResult), []);
  assert.deepEqual(actualWikiRefs({ ...result, state: 'needs_evidence' } as AskResult), [ref]);
  assert.deepEqual(actualGraphReadIds(null, [ref]), []);
});

test('a same-title old head and an excluded version do not gain an actual-read marker', () => {
  assert.deepEqual(actualGraphReadIds(graph, [{ ...ref, versionId: 'v3' }]), []);
  assert.deepEqual(actualWikiRefs({ state: 'answered', evidence: [], excluded: [{ ref }] } as unknown as AskResult), []);
});
