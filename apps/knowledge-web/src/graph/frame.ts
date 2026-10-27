import { nodeSize, type GraphViewModel } from './view-model';
import type { Position } from './layout';

export type ViewportSize = { width: number; height: number };

export function panKeepingWorldCenter(pan: Position, before: ViewportSize, after: ViewportSize): Position {
  if (![before.width, before.height, after.width, after.height].every(value => Number.isFinite(value) && value > 0)) return pan;
  return { x: pan.x + (after.width - before.width) / 2, y: pan.y + (after.height - before.height) / 2 };
}

function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }

/** Rescale the automatic ELK result to the current Canvas, keeping its central knowledge hub visible. */
export function framePositions(graph: GraphViewModel, raw: Record<string, Position>, width: number, height: number): Record<string, Position> {
  const knowledge = graph.nodes.filter(node => node.document !== null && raw[node.id]);
  if (!knowledge.length || width <= 0 || height <= 0) return raw;
  const root = raw[graph.rootId ?? ''] ?? raw[knowledge[0].id];
  const xs = knowledge.map(node => raw[node.id].x), ys = knowledge.map(node => raw[node.id].y);
  const padX = Math.min(125, Math.max(45, width * 0.12));
  const padY = Math.min(70, Math.max(34, height * 0.11));
  const usableX = Math.max(1, width / 2 - padX), usableY = Math.max(1, height / 2 - padY);
  const extentX = Math.max(root.x - Math.min(...xs), Math.max(...xs) - root.x, 1);
  const extentY = Math.max(root.y - Math.min(...ys), Math.max(...ys) - root.y, 1);
  const scaleX = usableX / extentX, scaleY = usableY / extentY;
  const framed: Record<string, Position> = {};
  for (const node of knowledge) framed[node.id] = { x: width / 2 + (raw[node.id].x - root.x) * scaleX, y: height / 2 + (raw[node.id].y - root.y) * scaleY };
  const center = { x: width / 2, y: height / 2 };
  const hubs = graph.mode === 'global' ? knowledge.filter(node => !node.isRoot && node.degree >= 3) : [];
  if (hubs.length >= 3 && graph.rootId) {
    // ELK determines the angular order. A topology-based radial relaxation
    // keeps high-degree centers and their satellites readable at the actual
    // Canvas size; it never changes graph membership or relation facts.
    hubs.sort((a, b) => Math.atan2(raw[a.id].y - root.y, raw[a.id].x - root.x) - Math.atan2(raw[b.id].y - root.y, raw[b.id].x - root.x));
    const radius = Math.max(35, Math.min(width / 2 - padX - 25, height / 2 - padY - 25));
    let phase = Math.atan2(raw[hubs[0].id].y - root.y, raw[hubs[0].id].x - root.x);
    const angles = hubs.map((_, index) => phase + index * Math.PI * 2 / hubs.length);
    if (angles.some(angle => Math.abs(Math.atan2(Math.sin(angle), Math.cos(angle))) < 0.3)) phase += Math.PI / hubs.length;
    hubs.forEach((hub, index) => {
      const angle = phase + index * Math.PI * 2 / hubs.length;
      framed[hub.id] = { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius };
    });
    const anchorIds = [graph.rootId, ...hubs.map(hub => hub.id)];
    const adjacency = new Map(knowledge.map(node => [node.id, new Set<string>()]));
    for (const edge of graph.edges) if (adjacency.has(edge.from) && adjacency.has(edge.to)) {
      adjacency.get(edge.from)!.add(edge.to); adjacency.get(edge.to)!.add(edge.from);
    }
    const distances = anchorIds.map(anchor => {
      const found = new Map([[anchor, 0]]), queue = [anchor];
      for (let index = 0; index < queue.length; index++) for (const neighbor of adjacency.get(queue[index]) ?? []) {
        if (!found.has(neighbor)) { found.set(neighbor, found.get(queue[index])! + 1); queue.push(neighbor); }
      }
      return found;
    });
    const clusters = new Map(anchorIds.map(id => [id, [] as typeof knowledge]));
    for (const node of knowledge) {
      if (anchorIds.includes(node.id)) continue;
      const anchor = anchorIds.map((id, index) => ({ id, path: distances[index].get(node.id) ?? Infinity,
        rawDistance: Math.hypot(raw[node.id].x - raw[id].x, raw[node.id].y - raw[id].y) }))
        .sort((a, b) => a.path - b.path || a.rawDistance - b.rawDistance)[0];
      clusters.get(anchor.id)?.push(node);
    }
    const leafRadius = clamp(radius * 0.31, 35, 58);
    clusters.forEach((members, anchorId) => {
      const anchor = framed[anchorId], rawAnchor = raw[anchorId];
      if (!anchor || !rawAnchor) return;
      members.sort((a, b) => Math.atan2(raw[a.id].y - rawAnchor.y, raw[a.id].x - rawAnchor.x) - Math.atan2(raw[b.id].y - rawAnchor.y, raw[b.id].x - rawAnchor.x));
      const firstAngle = members.length ? Math.atan2(raw[members[0].id].y - rawAnchor.y, raw[members[0].id].x - rawAnchor.x) : 0;
      members.forEach((node, index) => {
        const angle = firstAngle + index * Math.PI * 2 / members.length;
        const margin = nodeSize(node) / 2 + 20;
        framed[node.id] = {
          x: clamp(anchor.x + Math.cos(angle) * leafRadius, margin, width - margin),
          y: clamp(anchor.y + Math.sin(angle) * leafRadius, margin, height - margin),
        };
      });
    });
  }
  const external = graph.nodes.filter(node => node.document === null && raw[node.id]);
  external.forEach((node, index) => {
    const neighbors = graph.edges.filter(edge => edge.from === node.id || edge.to === node.id)
      .map(edge => framed[edge.from === node.id ? edge.to : edge.from]).filter((position): position is Position => !!position);
    if (neighbors.length) {
      const neighborCenter = neighbors.reduce((sum, position) => ({ x: sum.x + position.x, y: sum.y + position.y }), { x: 0, y: 0 });
      const rawAngle = Math.atan2(raw[node.id].y - root.y, raw[node.id].x - root.x);
      const angle = rawAngle + index * 0.6;
      const peripheralRadius = Math.max(45, Math.min(width / 2 - padX - 12, height / 2 - padY - 12));
      framed[node.id] = {
        x: clamp(center.x + Math.cos(angle) * peripheralRadius + (neighborCenter.x / neighbors.length - center.x) * 0.08, padX, width - padX),
        y: clamp(center.y + Math.sin(angle) * peripheralRadius + (neighborCenter.y / neighbors.length - center.y) * 0.08, padY, height - padY),
      };
    } else framed[node.id] = { x: clamp(width / 2 + (raw[node.id].x - root.x) * scaleX, padX, width - padX), y: clamp(height / 2 + (raw[node.id].y - root.y) * scaleY, padY, height - padY) };
  });
  return framed;
}
