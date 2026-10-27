import { useEffect, useRef, useState } from 'react';
import cytoscape, { type Core } from 'cytoscape';
import { layoutGraph } from './layout';
import { framePositions, panKeepingWorldCenter, type ViewportSize } from './frame';
import { nodeSize, type GraphViewModel } from './view-model';
import { placeLabels } from './labels';
import { GraphRenderSession, renderedLabelCandidates } from './render-session';

export type GraphCamera = { zoom: number; pan: { x: number; y: number } };
declare global {
  interface Window {
    __knowledgeGraphDebug?: { nodeCount: number; edgeCount: number; layoutSpringCount: number | null; layoutDurationMs: number | null; positions: Record<string, { x: number; y: number }>; camera: GraphCamera | null; layoutState: string };
  }
}

const style = [
  { selector: 'node', style: { 'background-color': '#a796db', 'background-opacity': 0.96, 'border-color': '#fff', 'border-width': 2, 'width': 'data(size)', 'height': 'data(size)', 'label': 'data(label)', 'color': '#263257', 'font-size': 11, 'font-weight': 600, 'font-family': 'Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif', 'text-valign': 'center', 'text-halign': 'right', 'text-margin-x': 12, 'text-wrap': 'wrap', 'text-overflow-wrap': 'anywhere', 'text-max-width': 110, 'text-background-color': '#fbfaf8', 'text-background-opacity': 0.78, 'text-background-padding': '2px', 'shadow-blur': 13, 'shadow-color': '#ac9cda', 'shadow-opacity': 0.35, 'overlay-opacity': 0 } },
  { selector: 'node.label-left', style: { 'text-halign': 'left', 'text-margin-x': -12 } },
  { selector: 'node.label-top', style: { 'text-halign': 'center', 'text-valign': 'top', 'text-margin-x': 0, 'text-margin-y': -12 } },
  { selector: 'node.label-bottom', style: { 'text-halign': 'center', 'text-valign': 'bottom', 'text-margin-x': 0, 'text-margin-y': 12 } },
  { selector: 'node[tone = "amber"]', style: { 'background-color': '#e8bd79' } },
  { selector: 'node[tone = "blue"]', style: { 'background-color': '#8bbbe6' } },
  { selector: 'node[tone = "grey"]', style: { 'background-color': '#c4cad6', 'shadow-opacity': 0.13 } },
  { selector: 'node[isRoot = "yes"]', style: { 'background-color': '#7653b9', 'border-color': '#e6ddf8', 'border-width': 9, 'font-size': 15, 'font-weight': 700, 'text-background-opacity': 0.9, 'shadow-blur': 25, 'shadow-opacity': 0.5 } },
  { selector: 'node[availability = "metadata_only"]', style: { 'background-opacity': 0.5, 'border-color': '#d3dae9', 'border-width': 3 } },
  { selector: 'node[availability = "unknown"]', style: { 'background-opacity': 0.3, 'border-color': '#d3dae9', 'border-width': 2 } },
  { selector: 'node:selected', style: { 'border-color': '#cab9ed', 'border-width': 12, 'background-color': '#6e4ab0', 'z-index': 20 } },
  { selector: 'edge', style: { 'curve-style': 'bezier', 'control-point-step-size': 24, 'width': 1, 'line-color': '#cbd1de', 'opacity': 0.54, 'target-arrow-shape': 'none', 'overlay-opacity': 0 } },
  { selector: 'edge[stance = "supports"]', style: { 'line-color': '#afa0d6', 'width': 1.25, 'opacity': 0.62 } },
  { selector: 'edge[stance = "challenges"]', style: { 'line-color': '#d6b28d', 'width': 1.3, 'line-style': 'dashed', 'opacity': 0.69 } },
  { selector: 'edge[stance = "navigation"]', style: { 'line-color': '#a9c7e2', 'line-style': 'dotted' } },
  { selector: 'edge[external = "yes"]', style: { 'line-color': '#c8cdd8', 'width': 0.85, 'opacity': 0.22 } },
  { selector: 'edge.emphasis', style: { 'width': 2.2, 'opacity': 0.96, 'z-index': 15 } },
  { selector: 'edge:selected', style: { 'width': 3.2, 'opacity': 1, 'z-index': 25 } },
];

function updateLabels(cy: Core, graph: GraphViewModel, selectedNodeId: string | null): void {
  const bounds = cy.container()?.getBoundingClientRect();
  if (!bounds?.width || !bounds.height) return;
  const placements = placeLabels(renderedLabelCandidates(cy, graph, selectedNodeId), bounds.width, bounds.height);
  cy.batch(() => graph.nodes.forEach(node => {
    const element = cy.getElementById(node.id), placement = placements.get(node.id);
    element.removeClass('label-left label-top label-bottom');
    if (placement?.side !== 'right' && placement) element.addClass(`label-${placement.side}`);
    element.data('label', placement ? node.shortLabel : '');
  }));
  cy.container()?.setAttribute('data-label-layout', JSON.stringify(Object.fromEntries(placements)));
}

type Props = {
  graph: GraphViewModel;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onNode: (id: string) => void;
  onEdge: (id: string) => void;
  onCamera: (camera: GraphCamera) => void;
  rememberedCamera: GraphCamera | null;
  resetSignal: number;
  visible: boolean;
};

export function GraphCanvas({ graph, selectedNodeId, selectedEdgeId, onNode, onEdge, onCamera, rememberedCamera, resetSignal, visible }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<GraphRenderSession | null>(null);
  const handlers = useRef({ onNode, onEdge, onCamera });
  const initialCamera = useRef(rememberedCamera);
  const selectedId = useRef(selectedNodeId);
  selectedId.current = selectedNodeId;
  const [layoutState, setLayoutState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [layoutError, setLayoutError] = useState('');
  handlers.current = { onNode, onEdge, onCamera };
  const publishDebug = (value: NonNullable<Window['__knowledgeGraphDebug']>) => {
    window.__knowledgeGraphDebug = value;
    surface.current?.setAttribute('data-graph-debug', JSON.stringify(value));
  };

  useEffect(() => {
    if (!container.current) return;
    let cancelled = false;
    setLayoutState('loading');
    setLayoutError('');
    const cy = cytoscape({ container: container.current, elements: [], style: style as never, layout: { name: 'preset' }, minZoom: 0.2, maxZoom: 2.6, wheelSensitivity: 0.18, boxSelectionEnabled: false });
    const session = new GraphRenderSession(cy, graph);
    sessionRef.current = session;
    let viewport: ViewportSize | null = null;
    let resizeObserver: ResizeObserver | null = null;
    const measuredViewport = (): ViewportSize | null => {
      const width = container.current?.clientWidth ?? 0, height = container.current?.clientHeight ?? 0;
      return width > 0 && height > 0 ? { width, height } : null;
    };
    cy.on('tap', 'node', event => handlers.current.onNode(event.target.id()));
    cy.on('tap', 'edge', event => handlers.current.onEdge(event.target.id()));
    let labelFrame = 0;
    const scheduleLabels = () => { cancelAnimationFrame(labelFrame); labelFrame = requestAnimationFrame(() => session.run(graph, current => updateLabels(current, graph, selectedId.current))); };
    const saveCamera = () => {
      if (!viewport) return;
      const camera = { zoom: cy.zoom(), pan: cy.pan() };
      handlers.current.onCamera(camera);
      if (window.__knowledgeGraphDebug) publishDebug({ ...window.__knowledgeGraphDebug, camera });
      scheduleLabels();
    };
    cy.on('pan zoom', saveCamera);
    publishDebug({ nodeCount: graph.nodes.length, edgeCount: graph.edges.length, layoutSpringCount: null, layoutDurationMs: null, positions: {}, camera: null, layoutState: 'loading' });
    void layoutGraph(graph).then(layout => {
      if (cancelled) return;
      const missing = graph.nodes.filter(node => !Number.isFinite(layout.positions[node.id]?.x) || !Number.isFinite(layout.positions[node.id]?.y));
      if (missing.length) throw new Error(`布局缺少 ${missing.length} 个节点的位置`);
      viewport = measuredViewport();
      const positions = framePositions(graph, layout.positions, viewport?.width ?? 0, viewport?.height ?? 0);
      if (!session.completeLayout(current => current.add([
        ...graph.nodes.map((node, index) => ({ group: 'nodes' as const, data: { id: node.id, label: node.isRoot || node.degree >= 2 || index % 4 === 0 ? node.shortLabel : '', tone: node.tone, availability: node.availability, isRoot: node.isRoot ? 'yes' : 'no', size: nodeSize(node) }, position: positions[node.id] })),
        ...graph.edges.map(edge => ({ group: 'edges' as const, data: { id: edge.id, source: edge.from, target: edge.to, stance: edge.relation.stance, external: graph.nodes.some(node => (node.id === edge.from || node.id === edge.to) && node.document === null) ? 'yes' : 'no' } })),
      ]))) return;
      cy.resize();
      if (initialCamera.current) { cy.zoom(initialCamera.current.zoom); cy.pan(initialCamera.current.pan); }
      else { cy.zoom(1); cy.pan({ x: 0, y: 0 }); }
      updateLabels(cy, graph, selectedId.current);
      const actualPositions = Object.fromEntries(cy.nodes().toArray().map(node => [node.id(), node.position()]));
      publishDebug({ nodeCount: cy.nodes().length, edgeCount: cy.edges().length, layoutSpringCount: layout.springCount, layoutDurationMs: Math.round(layout.durationMs), positions: actualPositions, camera: { zoom: cy.zoom(), pan: cy.pan() }, layoutState: 'ready' });
      resizeObserver = new ResizeObserver(() => {
        if (cancelled) return;
        const next = measuredViewport();
        if (!next) return;
        cy.resize();
        if (viewport) {
          const pan = panKeepingWorldCenter(cy.pan(), viewport, next);
          viewport = next;
          cy.pan(pan);
        } else {
          viewport = next;
          cy.fit(cy.nodes(), 20);
        }
        updateLabels(cy, graph, selectedId.current);
      });
      if (container.current) resizeObserver.observe(container.current);
      setLayoutState('ready');
    }).catch(error => {
      if (cancelled) return;
      const message = error instanceof Error ? error.message : String(error);
      setLayoutError(message);
      setLayoutState('error');
      if (window.__knowledgeGraphDebug) publishDebug({ ...window.__knowledgeGraphDebug, layoutState: 'error' });
    });
    return () => { cancelled = true; resizeObserver?.disconnect(); cancelAnimationFrame(labelFrame); session.dispose(); cy.destroy(); if (sessionRef.current === session) sessionRef.current = null; };
  }, [graph]);

  useEffect(() => {
    if (layoutState !== 'ready') return;
    sessionRef.current?.run(graph, cy => {
      cy.elements().unselect();
      if (selectedNodeId) cy.getElementById(selectedNodeId).select();
      if (selectedEdgeId) cy.getElementById(selectedEdgeId).select();
      cy.edges().removeClass('emphasis');
      if (selectedNodeId) cy.getElementById(selectedNodeId).connectedEdges().addClass('emphasis');
      updateLabels(cy, graph, selectedNodeId);
    });
  }, [selectedNodeId, selectedEdgeId, layoutState, graph]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!session || layoutState !== 'ready' || !visible) return;
    const frame = requestAnimationFrame(() => session.run(graph, cy => { cy.resize(); updateLabels(cy, graph, selectedId.current); }));
    return () => cancelAnimationFrame(frame);
  }, [visible, layoutState, graph]);

  useEffect(() => {
    if (!resetSignal || layoutState !== 'ready') return;
    if (!container.current?.clientWidth || !container.current?.clientHeight) return;
    sessionRef.current?.run(graph, cy => {
      cy.resize();
      cy.fit(cy.nodes(), 20);
      updateLabels(cy, graph, selectedId.current);
    });
  }, [resetSignal, layoutState, graph]);

  return <div ref={surface} className="graph-surface" data-testid="knowledge-graph" data-layout-state={layoutState}>
    <div ref={container} className="graph-canvas" aria-hidden="true" />
    {layoutState === 'loading' && <div className="graph-overlay">正在整理这片知识星图…</div>}
    {layoutState === 'error' && <div className="graph-overlay graph-error" role="alert">无法排列图谱：{layoutError}</div>}
  </div>;
}
