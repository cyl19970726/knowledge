import type { GraphEdgeView, GraphNodeView, GraphViewModel } from '../graph/view-model';

export type Point3 = [number, number, number];
export type GraphTone = 'violet' | 'blue' | 'cyan' | 'rose' | 'teal';
export type Graph3DGroup = { id: string; name: string; members: string[]; center: Point3; tone: GraphTone };
export type Graph3DLayout = { positions: Record<string, Point3>; groups: Graph3DGroup[]; visibleEdges: string[]; bridgeEdges: string[]; connectionCounts: Record<string, number>; hiddenEdgeCount: number; reading?: { focus: string; supports: string[]; challenges: string[]; sources: string[]; secondary: string[] } };

const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const relationWeight = (stance: GraphEdgeView['relation']['stance']) => stance === 'supports' || stance === 'challenges' ? 2 : stance === 'context' ? 1 : 0.4;

function hashId(id: string): number {
  let value = 2166136261;
  for (const character of id) value = Math.imul(value ^ character.charCodeAt(0), 16777619);
  return value >>> 0;
}

function docLinks(graph: GraphViewModel): Map<string, Map<string, number>> {
  const documents = new Set(graph.nodes.filter(node => node.document !== null).map(node => node.id));
  const links = new Map([...documents].map(id => [id, new Map<string, number>()]));
  for (const edge of graph.edges) {
    if (!documents.has(edge.from) || !documents.has(edge.to) || edge.from === edge.to) continue;
    const weight = edge.relation.stance === 'supports' || edge.relation.stance === 'challenges' ? 2 : edge.relation.stance === 'context' ? 1 : 0.6;
    for (const [from, to] of [[edge.from, edge.to], [edge.to, edge.from]]) {
      const neighbors = links.get(from)!;
      neighbors.set(to, Math.max(neighbors.get(to) ?? 0, weight));
    }
  }
  return links;
}

function distances(start: string, links: Map<string, Map<string, number>>): Map<string, number> {
  const result = new Map([[start, 0]]);
  const pending = new Set(links.keys());
  while (pending.size) {
    let current: string | null = null;
    for (const id of pending) if (result.has(id) && (current === null || result.get(id)! < result.get(current)! || result.get(id) === result.get(current) && compareId(id, current) < 0)) current = id;
    if (current === null) break;
    pending.delete(current);
    for (const [neighbor, weight] of links.get(current) ?? []) {
      const next = result.get(current)! + 1 / weight;
      if (next < (result.get(neighbor) ?? Infinity)) result.set(neighbor, next);
    }
  }
  return result;
}

function connectedSets(links: Map<string, Map<string, number>>): string[][] {
  const remaining = new Set(links.keys()), groups: string[][] = [];
  while (remaining.size) {
    const queue = [[...remaining].sort(compareId)[0]], members: string[] = [];
    remaining.delete(queue[0]);
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index];
      members.push(id);
      for (const neighbor of links.get(id)?.keys() ?? []) if (remaining.delete(neighbor)) queue.push(neighbor);
    }
    groups.push(members.sort(compareId));
  }
  return groups.sort((a, b) => b.length - a.length || compareId(a[0], b[0]));
}

function groupForDocuments(graph: GraphViewModel): { id: string; name: string; members: string[] }[] {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const links = docLinks(graph), components = connectedSets(links);
  const groups: { id: string; name: string; members: string[] }[] = [];
  const isolated: string[] = [];
  for (const component of components) {
    if (component.length === 1 && !links.get(component[0])?.size) { isolated.push(component[0]); continue; }
    const rank = (a: string, b: string) => (links.get(b)?.size ?? 0) - (links.get(a)?.size ?? 0) || compareId(a, b);
    const seeds = [...component].sort(rank).slice(0, Math.min(5, Math.max(1, Math.round(Math.sqrt(component.length) / 1.6))));
    const distanceMaps = seeds.map(seed => distances(seed, links));
    const members = new Map(seeds.map(seed => [seed, [] as string[]]));
    for (const id of component) {
      const choice = seeds.map((seed, index) => ({ seed, distance: distanceMaps[index].get(id) ?? Infinity }))
        .sort((a, b) => a.distance - b.distance || compareId(a.seed, b.seed))[0].seed;
      members.get(choice)!.push(id);
    }
    for (const seed of seeds) {
      const assigned = members.get(seed)!;
      if (!assigned.length) continue;
      groups.push({ id: seed, name: nodes.get(seed)?.shortLabel ?? '认识', members: assigned.sort(compareId) });
    }
  }
  if (isolated.length) groups.push({ id: 'isolated', name: '未连接的认识', members: isolated.sort(compareId) });
  return groups.sort((a, b) => b.members.length - a.members.length || compareId(a.id, b.id));
}

function nodePosition(center: Point3, index: number, total: number, id: string): Point3 {
  if (index === 0) return center;
  const angle = index * 2.399963229728653 + (hashId(id) % 180) / 180;
  const radius = Math.min(total > 12 ? 3.15 : total > 6 ? 2.25 : 1.65, 0.76 * Math.sqrt(index));
  return [center[0] + Math.cos(angle) * radius * 1.13, center[1] + Math.sin(angle) * radius * 0.88, center[2] + (hashId(`${id}:z`) % 1000 / 1000 - 0.5) * 0.75];
}

function externalPosition(node: GraphNodeView, positions: Record<string, Point3>, groups: Graph3DGroup[], groupOf: Map<string, Graph3DGroup>, neighborWeights: Map<string, Map<string, number>>): Point3 {
  const targetsByGroup = new Map<string, Map<string, number>>();
  for (const [other, weight] of neighborWeights.get(node.id) ?? []) {
    const group = groupOf.get(other);
    if (!group) continue;
    const targets = targetsByGroup.get(group.id) ?? new Map<string, number>();
    targets.set(other, Math.max(targets.get(other) ?? 0, weight));
    targetsByGroup.set(group.id, targets);
  }
  const dominant = groups.map(group => ({ group, score: [...(targetsByGroup.get(group.id)?.values() ?? [])].reduce((sum, weight) => sum + weight, 0) }))
    .sort((a, b) => b.score - a.score || compareId(a.group.id, b.group.id))[0];
  if (dominant?.score) {
    const angle = (hashId(`${node.id}:source`) % 10000) / 10000 * Math.PI * 2;
    const radius = dominant.group.members.length > 12 ? 4.7 : dominant.group.members.length > 6 ? 3.75 : dominant.group.members.length > 3 ? 3.4 : 2.95;
    return [
      dominant.group.center[0] + Math.cos(angle) * radius,
      dominant.group.center[1] + Math.sin(angle) * radius * 0.78,
      dominant.group.center[2] - 1.45,
    ];
  }
  const connected = [...(neighborWeights.get(node.id)?.keys() ?? [])].map(id => positions[id]).filter((point): point is Point3 => !!point);
  if (connected.length) {
    const x = connected.reduce((sum, point) => sum + point[0], 0) / connected.length;
    const y = connected.reduce((sum, point) => sum + point[1], 0) / connected.length;
    return [x, y - 2.6, -2.2];
  }
  const angle = hashId(node.id) % 10000 / 10000 * Math.PI * 2;
  return [Math.cos(angle) * 8, Math.sin(angle) * 6, -2.2];
}

/** Positions depend on the returned graph and exact IDs, never on selection or random state. */
export function constellationLayout(graph: GraphViewModel): Graph3DLayout {
  const rawGroups = groupForDocuments(graph);
  const tones: GraphTone[] = ['violet', 'blue', 'cyan', 'violet', 'rose', 'teal'];
  const groups: Graph3DGroup[] = rawGroups.map((group, index) => {
    const six: [number, number, number][] = [[-7.2, 3.25, 0.8], [0.55, 0.85, -0.35], [6.65, 3.2, -1.1], [-5.45, -3.7, -1.35], [5.2, -3.25, 0.55], [-0.75, -6.25, -0.7]];
    const columns = rawGroups.length <= 4 ? 2 : 3, rows = Math.ceil(rawGroups.length / columns);
    const row = Math.floor(index / columns), column = index % columns;
    const [x, y, z] = rawGroups.length === 6 ? six[index] : rawGroups.length === 1 ? [0, 0, 0.6] : [((column + 0.5) - columns / 2) * 7, ((rows - 1) / 2 - row) * 7, index % 2 ? -0.8 : 0.6];
    const center: Point3 = [x, y, z];
    return { ...group, center, tone: tones[index % tones.length] };
  });
  const positions: Record<string, Point3> = {};
  for (const group of groups) [group.id, ...group.members.filter(id => id !== group.id)].filter(id => group.members.includes(id)).forEach((id, index) => { positions[id] = nodePosition(group.center, index, group.members.length, id); });
  const groupOf = new Map(groups.flatMap(group => group.members.map(id => [id, group] as const)));
  const neighborWeights = new Map(graph.nodes.map(node => [node.id, new Map<string, number>()]));
  for (const edge of graph.edges) {
    const from = neighborWeights.get(edge.from), to = neighborWeights.get(edge.to);
    if (!from || !to) continue;
    const weight = relationWeight(edge.relation.stance);
    from.set(edge.to, Math.max(from.get(edge.to) ?? 0, weight));
    to.set(edge.from, Math.max(to.get(edge.from) ?? 0, weight));
  }
  graph.nodes.filter(node => node.document === null).sort((a, b) => compareId(a.id, b.id)).forEach(node => { positions[node.id] = externalPosition(node, positions, groups, groupOf, neighborWeights); });
  const neighbors = new Map(graph.nodes.map(node => [node.id, new Set<string>()]));
  for (const edge of graph.edges) {
    neighbors.get(edge.from)?.add(edge.to);
    neighbors.get(edge.to)?.add(edge.from);
  }
  const connectionCounts = Object.fromEntries([...neighbors].map(([id, ids]) => [id, ids.size]));
  const groupIdOf = new Map([...groupOf].map(([id, group]) => [id, group.id] as const));
  const bridgePriority = (edge: GraphEdgeView) => edge.relation.stance === 'challenges' ? 0 : edge.relation.stance === 'supports' ? 1 : edge.relation.stance === 'context' ? 2 : 3;
  const bridgeEdges = graph.edges.filter(edge => groupIdOf.has(edge.from) && groupIdOf.has(edge.to) && groupIdOf.get(edge.from) !== groupIdOf.get(edge.to))
    .sort((a, b) => bridgePriority(a) - bridgePriority(b) || compareId(a.id, b.id)).map(edge => edge.id);
  const priority = (edge: GraphEdgeView) => edge.relation.stance === 'challenges' ? 0 : edge.relation.stance === 'supports' ? 1 : edge.relation.stance === 'context' ? 2 : 3;
  // Keep every returned relation in the overview. Quiet evidence and navigation
  // edges become texture while support and challenge relations remain legible.
  const visible = [...graph.edges].sort((a, b) => priority(a) - priority(b) || compareId(a.id, b.id)).map(edge => edge.id);
  return { positions, groups, visibleEdges: visible, bridgeEdges, connectionCounts, hiddenEdgeCount: graph.edges.length - visible.length };
}

/** Only the focus and its directly returned neighbors move into a reading plane. */
export function questionLayout(graph: GraphViewModel, base: Graph3DLayout, focusId: string | null): Graph3DLayout {
  if (!focusId || !base.positions[focusId]) return base;
  // Keep the surrounding constellation as context, but reserve a wide, nearly
  // planar reading frame for relationships whose direction is actually known.
  const positions = Object.fromEntries(Object.entries(base.positions).map(([id, point]) => [id, [point[0] * 0.72, point[1] * 0.72, -3 + point[2] * 0.3] as Point3]));
  const adjacent = graph.edges.filter(edge => edge.from === focusId || edge.to === focusId);
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const neighbors = (stance: GraphEdgeView['relation']['stance'], limit: number) => [...new Set(adjacent.filter(edge => edge.to === focusId && edge.relation.stance === stance && nodes.get(edge.from)?.document).map(edge => edge.from))]
    .sort((a, b) => (nodes.get(b)?.degree ?? 0) - (nodes.get(a)?.degree ?? 0) || compareId(a, b)).slice(0, limit);
  const supports = neighbors('supports', 2);
  const challenges = neighbors('challenges', 1);
  const sources = [...new Set(adjacent.filter(edge => nodes.get(edge.from === focusId ? edge.to : edge.from)?.document === null).map(edge => edge.from === focusId ? edge.to : edge.from))].sort(compareId).slice(0, 1);
  const used = new Set([focusId, ...supports, ...challenges, ...sources]);
  const secondary = [...new Set(adjacent.map(edge => edge.from === focusId ? edge.to : edge.from))].filter(id => !used.has(id) && nodes.get(id)?.document).sort((a, b) => (nodes.get(b)?.degree ?? 0) - (nodes.get(a)?.degree ?? 0) || compareId(a, b)).slice(0, 3);
  positions[focusId] = [0, -1.15, 3];
  supports.forEach((id, index) => { positions[id] = [supports.length === 1 ? -3.6 : index === 0 ? -4.2 : 4.2, 2.65, 2.5]; });
  challenges.forEach((id, index) => { positions[id] = [4.4 + index * 1.5, -4.05, 2.4]; });
  sources.forEach((id, index) => { positions[id] = [-3.8 - index, -4.25, 1.5]; });
  secondary.forEach((id, index) => { positions[id] = [-6.4 + index * 1.6, -0.7 - index * 0.8, -0.6]; });
  const foreground = new Set([...used, ...secondary]);
  const eligible = adjacent.filter(edge => foreground.has(edge.from) && foreground.has(edge.to))
    .sort((a, b) => ({ supports: 0, challenges: 1, context: 2, navigation: 3 })[a.relation.stance] - ({ supports: 0, challenges: 1, context: 2, navigation: 3 })[b.relation.stance] || compareId(a.id, b.id));
  // One visual line per directional pair and stance. The original relation
  // records remain in graph.edges and in the component's selectable DOM list.
  const pairs = new Set<string>();
  const primaryEdges = eligible.filter(edge => {
    const key = JSON.stringify([edge.from, edge.to, edge.relation.stance]);
    if (pairs.has(key) || pairs.size >= 10) return false;
    pairs.add(key);
    return true;
  }).map(edge => edge.id);
  const primaryEdgeIds = new Set(primaryEdges), adjacentEdgeIds = new Set(adjacent.map(edge => edge.id));
  const backgroundEdges = base.visibleEdges.filter(id => !primaryEdgeIds.has(id) && !adjacentEdgeIds.has(id)).slice(0, 48);
  const visibleEdges = [...backgroundEdges, ...primaryEdges];
  return { positions, groups: base.groups, visibleEdges, bridgeEdges: base.bridgeEdges, connectionCounts: base.connectionCounts, hiddenEdgeCount: graph.edges.length - visibleEdges.length, reading: { focus: focusId, supports, challenges, sources, secondary } };
}
