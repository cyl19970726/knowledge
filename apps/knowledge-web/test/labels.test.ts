import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placeLabels, type LabelNode } from '../src/graph/labels.ts';

function intersects(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

test('selected center title avoids the adjacent long title and every node circle', () => {
  const nodes: LabelNode[] = [
    { id: 'center', x: 390, y: 305, radius: 28, text: '商品的可展示性', priority: 200 },
    { id: 'question', x: 453, y: 307, radius: 12, text: '吸引与辨认是不同问题', priority: 80 },
    { id: 'source', x: 257, y: 415, radius: 19, text: '来源资料承接', priority: 85 },
    { id: 'purchase', x: 307, y: 420, radius: 9, text: '购买承接', priority: 20 },
  ];
  const labels = placeLabels(nodes, 795, 500);
  assert.equal(labels.has('center'), true);
  assert.notEqual(labels.get('center')?.side, 'right');
  for (const [id, placement] of labels) {
    for (const node of nodes) if (node.id !== id) {
      assert.equal(intersects(placement.box, { x: node.x - node.radius, y: node.y - node.radius, width: 2 * node.radius, height: 2 * node.radius }), false, `${id} overlaps ${node.id}`);
    }
    for (const [otherId, other] of labels) if (id < otherId) assert.equal(intersects(placement.box, other.box), false, `${id} overlaps ${otherId}`);
  }
});
