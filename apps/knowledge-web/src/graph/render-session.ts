import type { Core } from 'cytoscape';
import { nodeSize, type GraphViewModel } from './view-model';
import type { LabelNode } from './labels';

/** Readiness belongs to this graph instance, independently of React's last committed state. */
export class GraphRenderSession {
  private active = true;
  private ready = false;
  constructor(private readonly cy: Core, private readonly graph: GraphViewModel) {}

  completeLayout(install: (cy: Core) => void): boolean {
    if (!this.active || this.cy.destroyed()) return false;
    install(this.cy);
    for (const item of [...this.graph.nodes, ...this.graph.edges]) {
      if (this.cy.getElementById(item.id).empty()) throw new Error(`图谱缺少元素：${item.id}`);
    }
    this.ready = true;
    return true;
  }

  run(graph: GraphViewModel, action: (cy: Core) => void): boolean {
    if (!this.active || !this.ready || this.graph !== graph || this.cy.destroyed()) return false;
    action(this.cy);
    return true;
  }

  dispose(): void { this.active = false; this.ready = false; }
}

/** Missing or non-finite geometry suppresses only a label, never a node or relation. */
export function renderedLabelCandidates(cy: Core, graph: GraphViewModel, selectedNodeId: string | null): LabelNode[] {
  return graph.nodes.flatMap((node, index) => {
    const element = cy.getElementById(node.id);
    if (element.empty()) return [];
    const position = element.renderedPosition();
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return [];
    return [{ id: node.id, x: position.x, y: position.y, radius: nodeSize(node) * cy.zoom() / 2,
      text: node.isRoot || node.degree >= 2 || index % 4 === 0 || selectedNodeId === node.id ? node.shortLabel : '',
      priority: selectedNodeId === node.id ? 200 : node.isRoot ? 150 : node.degree >= 2 ? 80 + node.degree : 20,
      scale: cy.zoom() }];
  });
}
