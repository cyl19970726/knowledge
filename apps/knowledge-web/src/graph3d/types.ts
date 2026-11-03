import type { GraphViewModel } from '../graph/view-model';

export type Graph3DCamera = {
  position: [number, number, number];
  target: [number, number, number];
};

export type KnowledgeGraph3DProps = {
  graph: GraphViewModel;
  presentation: 'constellation' | 'question';
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  coReadingIds: readonly string[];
  actualReadIds?: readonly string[];
  onNode: (id: string) => void;
  onEdge: (id: string) => void;
  onCamera: (camera: Graph3DCamera) => void;
  rememberedCamera: Graph3DCamera | null;
  resetSignal: number;
  zoomRequest: { sequence: number; direction: 'in' | 'out' };
  visible: boolean;
  onUnavailable: (reason: string) => void;
  onReady?: (counts: { nodes: number; edges: number; groups: number }) => void;
};
