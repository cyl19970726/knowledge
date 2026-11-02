import type { AskResult, KnowledgeRef } from '@commerce/knowledge-contracts';
import type { GraphViewModel } from './graph/view-model';

/** A title, object ID, or older head alone never proves that this graph node was read. */
export function sameExactRef(left: KnowledgeRef, right: KnowledgeRef): boolean {
  return left.projectId === right.projectId && left.spaceId === right.spaceId && left.domain === right.domain &&
    left.objectId === right.objectId && left.versionId === right.versionId &&
    left.contentDigest !== null && left.contentDigest === right.contentDigest;
}

export function actualWikiRefs(result: AskResult | null): KnowledgeRef[] {
  return result && ['answered', 'needs_evidence', 'refused'].includes(result.state) ? result.evidence.filter(item => item.kind === 'wiki_page' && item.ref.domain === 'knowledge')
    .map(item => item.ref) : [];
}

export function graphNodeForExactRef(graph: GraphViewModel | null, ref: KnowledgeRef): string | null {
  return graph?.nodes.find(node => sameExactRef(node.ref, ref))?.id ?? null;
}

export function actualGraphReadIds(graph: GraphViewModel | null, refs: readonly KnowledgeRef[]): string[] {
  if (!graph) return [];
  return graph.nodes.filter(node => node.document !== null && refs.some(ref => sameExactRef(node.ref, ref))).map(node => node.id);
}
