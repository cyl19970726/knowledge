import type { GraphResult, KnowledgeDocument, KnowledgeRef, Relation } from '@commerce/knowledge-contracts';

export type GraphMode = 'global' | 'focused';
export type GraphNodeView = {
  id: string;
  ref: KnowledgeRef;
  title: string;
  shortLabel: string;
  degree: number;
  tone: 'violet' | 'amber' | 'blue' | 'grey';
  isRoot: boolean;
  document: KnowledgeDocument | null;
  availability: 'knowledge' | GraphResult['externalNodes'][number]['availability'];
};
export type GraphEdgeView = { id: string; from: string; to: string; relation: Relation };
export type GraphViewModel = { nodes: GraphNodeView[]; edges: GraphEdgeView[]; rootId: string | null; mode: GraphMode };

export function refKey(ref: KnowledgeRef): string {
  return `${ref.projectId}/${ref.spaceId}/${ref.domain}/${ref.objectId}@${ref.versionId}`;
}

export function shortLabel(title: string, max = 18): string {
  const text = title.trim();
  return Array.from(text).length > max ? `${Array.from(text).slice(0, max).join('')}…` : text;
}

/** Visual hierarchy is graph topology only. It makes no claim about epistemic importance. */
export function toGraphView(result: GraphResult, root: KnowledgeRef | null, mode: GraphMode): GraphViewModel {
  const documents = new Map(result.nodes.map(node => [refKey(node.ref), node]));
  const external = new Map(result.externalNodes.map(node => [refKey(node.ref), node]));
  const degree = new Map<string, number>();
  const edges: GraphEdgeView[] = [];
  for (const relation of result.edges) {
    const from = refKey(relation.from);
    const to = refKey(relation.to);
    if (!(documents.has(from) || external.has(from)) || !(documents.has(to) || external.has(to))) continue;
    const id = `${relation.id}@${relation.relationVersion}`;
    edges.push({ id, from, to, relation });
    if (documents.has(from) && documents.has(to)) {
      degree.set(from, (degree.get(from) ?? 0) + 1);
      degree.set(to, (degree.get(to) ?? 0) + 1);
    }
  }
  const rankedKnowledge = [...documents.keys()].sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || a.localeCompare(b));
  const rootId = mode === 'global' ? rankedKnowledge[0] ?? null : root ? refKey(root) : rankedKnowledge[0] ?? null;
  const allIds = [...new Set([...documents.keys(), ...external.keys()])];
  const neighborhoods = new Map(allIds.map(id => [id, new Set<string>()]));
  for (const edge of edges) if (documents.has(edge.from) && documents.has(edge.to)) { neighborhoods.get(edge.from)?.add(edge.to); neighborhoods.get(edge.to)?.add(edge.from); }
  const ranked = rankedKnowledge.filter(id => id !== rootId);
  const hubs = [rootId, ...ranked.filter(id => (degree.get(id) ?? 0) >= 3)].filter((id): id is string => id !== null).slice(0, 7);
  const tones = ['violet', 'amber', 'blue'] as const;
  const distances = hubs.map(hub => {
    const found = new Map([[hub, 0]]), queue = [hub];
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index];
      for (const neighbor of neighborhoods.get(current) ?? []) if (!found.has(neighbor)) { found.set(neighbor, found.get(current)! + 1); queue.push(neighbor); }
    }
    return found;
  });
  const toneFor = (id: string): GraphNodeView['tone'] => {
    if (!hubs.length) return 'violet';
    let bestDistance = Infinity, bestIndex = 0;
    distances.forEach((map, index) => { const distance = map.get(id) ?? Infinity; if (distance < bestDistance) { bestDistance = distance; bestIndex = index; } });
    return tones[bestIndex % tones.length];
  };
  const knowledgeNodes = [...documents].map(([id, document]) => ({
    id,
    ref: document.ref,
    title: document.title,
    shortLabel: shortLabel(document.title),
    degree: degree.get(id) ?? 0,
    tone: toneFor(id),
    isRoot: id === rootId,
    document,
    availability: 'knowledge' as const,
  }));
  const externalNodes = [...external].filter(([id]) => !documents.has(id)).map(([id, node]) => {
    const label = ({ Source: '来源资料', Analysis: '分析资料', Evidence: '证据资料' } as Record<string, string>)[node.label] ?? node.label;
    return {
    id, ref: node.ref, title: label, shortLabel: shortLabel(label), degree: 0,
    tone: 'grey' as const, isRoot: false,
    document: null, availability: node.availability,
    };
  });
  const nodes: GraphNodeView[] = [...knowledgeNodes, ...externalNodes];
  return { nodes, edges, rootId, mode };
}

export function selectedRelations(graph: GraphViewModel, id: string): GraphEdgeView[] {
  return graph.edges.filter(edge => edge.from === id || edge.to === id);
}

export function nodeSize(node: GraphNodeView): number {
  if (node.document === null) return 11;
  if (node.isRoot) return 48;
  if (node.degree >= 4) return 40;
  if (node.degree >= 2) return 27;
  return 13;
}

/** Layout may use fewer springs than the full graph. Every relation still renders and remains selectable. */
export function layoutEdges(graph: GraphViewModel): GraphEdgeView[] {
  const documents = new Set(graph.nodes.filter(node => node.document !== null).map(node => node.id));
  const degree = new Map(graph.nodes.map(node => [node.id, node.degree]));
  const internal = new Map<string, GraphEdgeView>();
  const external = new Map<string, GraphEdgeView[]>();
  for (const edge of graph.edges) {
    const fromDocument = documents.has(edge.from), toDocument = documents.has(edge.to);
    if (fromDocument && toDocument) {
      const pair = [edge.from, edge.to].sort().join('→');
      if (!internal.has(pair)) internal.set(pair, edge);
    } else {
      const externalId = fromDocument ? edge.to : edge.from;
      const group = external.get(externalId) ?? [];
      group.push(edge);
      external.set(externalId, group);
    }
  }
  const externalSprings = [...external.values()].flatMap(group => {
    const sorted = [...group].sort((a, b) => {
      const aNeighbor = documents.has(a.from) ? a.from : a.to;
      const bNeighbor = documents.has(b.from) ? b.from : b.to;
      return (degree.get(bNeighbor) ?? 0) - (degree.get(aNeighbor) ?? 0) || a.id.localeCompare(b.id);
    });
    const neighbors = new Set<string>();
    return sorted.filter(edge => {
      const neighbor = documents.has(edge.from) ? edge.from : edge.to;
      if (neighbors.has(neighbor) || neighbors.size >= 2) return false;
      neighbors.add(neighbor);
      return true;
    });
  });
  return [...internal.values(), ...externalSprings];
}
