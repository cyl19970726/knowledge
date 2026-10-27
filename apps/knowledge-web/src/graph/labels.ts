export type LabelNode = { id: string; x: number; y: number; radius: number; text: string; priority: number; scale?: number };
export type LabelSide = 'right' | 'left' | 'top' | 'bottom';
export type LabelBox = { x: number; y: number; width: number; height: number };
export type LabelPlacement = { side: LabelSide; box: LabelBox };

function overlaps(a: LabelBox, b: LabelBox, gap = 3): boolean {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}

function boxFor(node: LabelNode, side: LabelSide): LabelBox {
  const scale = node.scale ?? 1;
  const font = (node.priority >= 100 ? 15 : 11) * scale;
  const glyphs = [...node.text].reduce((sum, char) => sum + (/^[\x00-\x7F]$/.test(char) ? .58 : 1), 0);
  const width = Math.min(110 * scale, Math.max(16 * scale, Math.ceil(glyphs * font)));
  const height = Math.ceil(glyphs * font / width) * (font + 4 * scale) + 4 * scale;
  const gap = node.radius + 11 * scale;
  if (side === 'left') return { x: node.x - gap - width, y: node.y - height / 2, width, height };
  if (side === 'top') return { x: node.x - width / 2, y: node.y - gap - height, width, height };
  if (side === 'bottom') return { x: node.x - width / 2, y: node.y + gap, width, height };
  return { x: node.x + gap, y: node.y - height / 2, width, height };
}

/** Place only visible labels. The Canvas still contains every node and relation. */
export function placeLabels(nodes: readonly LabelNode[], width: number, height: number): Map<string, LabelPlacement> {
  const labels = new Map<string, LabelPlacement>();
  const occupied: LabelBox[] = [];
  const circles = nodes.map(node => ({ id: node.id, box: { x: node.x - node.radius, y: node.y - node.radius, width: node.radius * 2, height: node.radius * 2 } }));
  for (const node of [...nodes].filter(item => item.text).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))) {
    for (const side of ['right', 'left', 'top', 'bottom'] as const) {
      const box = boxFor(node, side);
      if (box.x < 6 || box.y < 6 || box.x + box.width > width - 6 || box.y + box.height > height - 6) continue;
      if (occupied.some(other => overlaps(box, other))) continue;
      if (circles.some(other => other.id !== node.id && overlaps(box, other.box, 1))) continue;
      labels.set(node.id, { side, box }); occupied.push(box); break;
    }
  }
  return labels;
}
