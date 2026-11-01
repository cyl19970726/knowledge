import type { KnowledgeDocument, KnowledgeRef, ReadReceipt } from '@commerce/knowledge-contracts';
import { refKey, type GraphViewModel } from './graph/view-model';

/** Local choices are exact knowledge versions, never a server read receipt. */
export function toggleCoReading(current: readonly KnowledgeRef[], ref: KnowledgeRef): KnowledgeRef[] {
  if (ref.domain !== 'knowledge') return [...current];
  const key = refKey(ref);
  if (current.some(item => refKey(item) === key)) return current.filter(item => refKey(item) !== key);
  return current.length >= 2 ? [...current] : [...current, ref];
}

export function resolveCoReading(current: readonly KnowledgeRef[], documents: readonly KnowledgeDocument[]): { ref: KnowledgeRef; document: KnowledgeDocument | null }[] {
  const byRef = new Map(documents.map(document => [refKey(document.ref), document]));
  return current.map(ref => ({ ref, document: byRef.get(refKey(ref)) ?? null }));
}

export function matchingCoReadingReceipt(receipt: ReadReceipt | null, purpose: string, refs: readonly KnowledgeRef[], now = Date.now()): string | null {
  if (!receipt || refs.length !== 2 || receipt.purpose !== purpose || Date.parse(receipt.expiresAt) <= now) return null;
  if (refs.some(ref => ref.projectId !== receipt.effectiveScope.projectId || ref.spaceId !== receipt.effectiveScope.spaceId)) return null;
  return refs.every(ref => receipt.orderedItems.some(item => refKey(item.ref) === refKey(ref) && item.ref.contentDigest === ref.contentDigest)) ? receipt.id : null;
}

/** A visual route through returned relations, without claiming that the route is evidence. */
export function coReadingPath(graph: GraphViewModel, start: string, end: string): string[] {
  if (start === end || !graph.nodes.some(node => node.id === start) || !graph.nodes.some(node => node.id === end)) return [];
  const queue = [start], visited = new Set(queue), prior = new Map<string, { node: string; edge: string }>();
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    for (const edge of graph.edges) {
      const next = edge.from === current ? edge.to : edge.to === current ? edge.from : null;
      if (!next || visited.has(next)) continue;
      visited.add(next); prior.set(next, { node: current, edge: edge.id }); queue.push(next);
      if (next === end) {
        const path: string[] = [];
        for (let step = end; step !== start;) { const link = prior.get(step)!; path.unshift(link.edge); step = link.node; }
        return path;
      }
    }
  }
  return [];
}
