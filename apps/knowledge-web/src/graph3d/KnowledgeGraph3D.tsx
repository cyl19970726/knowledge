import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Html, Line, OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { Quaternion, Shape, Vector3, type WebGLRenderer } from 'three';
import type { GraphEdgeView, GraphNodeView } from '../graph/view-model';
import { constellationLayout, questionLayout, type Graph3DGroup, type Point3 } from './layout';
import type { Graph3DCamera, KnowledgeGraph3DProps } from './types';

export type { Graph3DCamera, KnowledgeGraph3DProps } from './types';

const color = { violet: '#a473ee', blue: '#5c9cf3', amber: '#edae49', grey: '#8c9bb0' } as const;
const font = 'Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
const relationName = { supports: '支持', challenges: '挑战', context: '背景', navigation: '导航' } as const;
const statusName = { observed: '已观察', untested: '未检验', unknown: '未知' } as const;

function cameraFor(groups: Graph3DGroup[], presentation: KnowledgeGraph3DProps['presentation']): Graph3DCamera {
  if (presentation === 'question') return { position: [0, -0.4, 18], target: [0, -0.4, 0] };
  const extent = Math.max(12, ...groups.map(group => Math.hypot(group.center[0], group.center[1]) + 4));
  return { position: [0, -0.7, extent * 1.92], target: [0, -0.7, 0] };
}

function groupOutline(group: Graph3DGroup, scale = 1): { shape: Shape; points: Point3[]; radius: number } {
  const radius = (group.members.length > 12 ? 3.55 : group.members.length > 6 ? 2.75 : group.members.length > 3 ? 2.5 : 2.2) * scale;
  const points: Point3[] = Array.from({ length: 81 }, (_, index) => {
    const angle = index / 80 * Math.PI * 2;
    const wobble = 1 + 0.075 * Math.sin(angle * 3 + group.id.length) + 0.05 * Math.cos(angle * 5 + group.id.length * 0.7);
    return [Math.cos(angle) * radius * wobble * 1.1, Math.sin(angle) * radius * wobble * 0.87, 0];
  });
  const shape = new Shape();
  shape.moveTo(points[0][0], points[0][1]);
  points.slice(1).forEach(point => shape.lineTo(point[0], point[1]));
  return { shape, points, radius };
}

function validCamera(value: Graph3DCamera | null): value is Graph3DCamera {
  return !!value && [...value.position, ...value.target].every(Number.isFinite) &&
    Math.hypot(...value.position.map((part, index) => part - value.target[index]) as Point3) > 0.1;
}

function CameraRig({ initial, remembered, home, presentation, resetSignal, zoomRequest, onCamera, host }: {
  initial: Graph3DCamera; remembered: boolean; home: Graph3DCamera; presentation: KnowledgeGraph3DProps['presentation']; resetSignal: number;
  zoomRequest: KnowledgeGraph3DProps['zoomRequest']; onCamera: KnowledgeGraph3DProps['onCamera'];
  host: React.RefObject<HTMLDivElement | null>;
}) {
  const { camera, invalidate, size } = useThree();
  const controls = useRef<OrbitControlsImpl>(null);
  const resetSeen = useRef(resetSignal), zoomSeen = useRef(zoomRequest.sequence), viewSeen = useRef(presentation);
  const initialRef = useRef(initial), homeRef = useRef(home);
  homeRef.current = home;
  const fittedHome = (): Graph3DCamera => {
    const factor = Math.min(2.6, Math.max(1, size.height / Math.max(1, size.width)));
    return { position: homeRef.current.position.map((part, index) => homeRef.current.target[index] + (part - homeRef.current.target[index]) * factor) as Point3, target: homeRef.current.target };
  };
  const snapshot = () => {
    const target = controls.current?.target;
    if (!target) return;
    const value: Graph3DCamera = { position: [camera.position.x, camera.position.y, camera.position.z], target: [target.x, target.y, target.z] };
    host.current?.setAttribute('data-camera-debug', JSON.stringify(value));
    onCamera(value);
  };
  const apply = (value: Graph3DCamera) => {
    camera.position.set(...value.position);
    controls.current?.target.set(...value.target);
    controls.current?.update();
    camera.updateProjectionMatrix();
    host.current?.setAttribute('data-camera-debug', JSON.stringify(value));
    invalidate();
  };
  useEffect(() => { apply(remembered ? initialRef.current : fittedHome()); }, []);
  useEffect(() => {
    if (resetSeen.current === resetSignal) return;
    resetSeen.current = resetSignal;
    const value = fittedHome();
    apply(value);
    onCamera(value);
  }, [resetSignal]);
  useEffect(() => {
    if (viewSeen.current === presentation) return;
    viewSeen.current = presentation;
    const value = fittedHome();
    apply(value);
    onCamera(value);
  }, [presentation]);
  useEffect(() => {
    if (zoomSeen.current === zoomRequest.sequence) return;
    zoomSeen.current = zoomRequest.sequence;
    const target = controls.current?.target;
    if (!target) return;
    const offset = camera.position.clone().sub(target).multiplyScalar(zoomRequest.direction === 'in' ? 0.78 : 1.28).clampLength(3, 75);
    camera.position.copy(target.clone().add(offset));
    controls.current?.update();
    invalidate();
    snapshot();
  }, [zoomRequest.sequence, zoomRequest.direction]);
  return <OrbitControls ref={controls} enableDamping={false} enablePan enableZoom minDistance={3} maxDistance={75} maxPolarAngle={Math.PI * 0.88} onEnd={snapshot} />;
}

function NodeGlyph({ node, position, selected, prominent, coReadingIndex, dimmed, onNode, groupTone, accent }: {
  node: GraphNodeView; position: Point3; selected: boolean; coReadingIndex: number; dimmed: boolean;
  prominent: boolean; accent?: string;
  onNode: (id: string) => void; groupTone: Graph3DGroup['tone'];
}) {
  const source = node.document === null;
  const tint = selected ? color.violet : coReadingIndex === 0 ? color.violet : coReadingIndex === 1 ? color.blue : accent ?? (source ? color.grey : color[groupTone]);
  const radius = selected ? 0.58 : prominent ? 0.42 : source ? 0.18 : node.degree >= 3 ? 0.23 : 0.15;
  const pick = (event: { stopPropagation: () => void }) => { event.stopPropagation(); onNode(node.id); };
  return <group position={position}>
    <mesh onClick={pick}>
      {source ? <octahedronGeometry args={[radius, 0]} /> : <sphereGeometry args={[radius, 12, 10]} />}
      <meshBasicMaterial color={tint} transparent opacity={dimmed ? 0.35 : 0.95} depthWrite={false} />
    </mesh>
    {selected && <mesh position={[0, 0, radius * 0.45]}><sphereGeometry args={[radius * 0.62, 16, 12]} /><meshBasicMaterial color="#d8b0ff" transparent opacity={0.88} depthWrite={false} /></mesh>}
    {(prominent || coReadingIndex >= 0) && <mesh><torusGeometry args={[radius + 0.1, prominent ? 0.038 : 0.018, 6, 40]} /><meshBasicMaterial color={tint} transparent opacity={0.82} depthWrite={false} /></mesh>}
    {prominent && <mesh><ringGeometry args={[radius + 0.18, radius + 0.39, 48]} /><meshBasicMaterial color={tint} transparent opacity={0.12} depthWrite={false} side={2} /></mesh>}
    <mesh onClick={pick}><sphereGeometry args={[Math.max(0.38, radius), 8, 6]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} /></mesh>
  </group>;
}

function RelationLine({ edge, from, to, highlighted, background, accent, onEdge }: {
  edge: GraphEdgeView; from: Point3; to: Point3; highlighted: boolean; background: boolean; accent?: string; onEdge: (id: string) => void;
}) {
  const delta = new Vector3(...to).sub(new Vector3(...from));
  const length = delta.length();
  if (length < 0.6) return null;
  const direction = delta.normalize();
  const start = new Vector3(...from).addScaledVector(direction, highlighted ? 0.52 : 0.27);
  const end = new Vector3(...to).addScaledVector(direction, highlighted ? -0.68 : -0.3);
  const middle = start.clone().add(end).multiplyScalar(0.5);
  const arrow = end.clone();
  const rotation = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction);
  const stance = edge.relation.stance;
  const tint = accent ?? (stance === 'challenges' ? color.amber : stance === 'supports' ? color.violet : stance === 'navigation' ? color.blue : color.grey);
  const opacity = background ? 0.16 : highlighted ? 0.95 : stance === 'navigation' || stance === 'context' ? 0.34 : 0.62;
  const pick = (event: { stopPropagation: () => void }) => { event.stopPropagation(); onEdge(edge.id); };
  return <group>
    <Line points={[start.toArray(), end.toArray()]} color={tint} lineWidth={highlighted ? 2 : background ? 0.6 : 1.2} transparent opacity={opacity} dashed={!background && (stance === 'challenges' || stance === 'navigation')} dashSize={stance === 'challenges' ? 0.18 : 0.07} gapSize={0.11} onClick={pick} />
    {!background && <mesh position={arrow.toArray()} quaternion={rotation} onClick={pick}><coneGeometry args={[highlighted ? 0.09 : 0.06, highlighted ? 0.2 : 0.14, 5]} /><meshBasicMaterial color={tint} transparent opacity={opacity} depthWrite={false} /></mesh>}
    <mesh position={middle.toArray()} quaternion={rotation} onClick={pick}><cylinderGeometry args={[0.18, 0.18, Math.max(0.1, start.distanceTo(end)), 5]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} /></mesh>
  </group>;
}

function Billboard({ position, children, prominent = false, className = '' }: { position: Point3; children: ReactNode; prominent?: boolean; className?: string }) {
  return <Html position={position} style={{ pointerEvents: 'none', userSelect: 'none' }}>
    <span className={`graph3d-label ${prominent ? 'prominent' : ''} ${className}`}>{children}</span>
  </Html>;
}

function Scene({ graph, layout, presentation, selectedNodeId, selectedEdgeId, coReadingIds, onNode, onEdge, camera, remembered, resetSignal, zoomRequest, onCamera, host }: {
  graph: KnowledgeGraph3DProps['graph']; layout: ReturnType<typeof constellationLayout>;
  presentation: KnowledgeGraph3DProps['presentation']; selectedNodeId: string | null; selectedEdgeId: string | null;
  coReadingIds: readonly string[]; onNode: KnowledgeGraph3DProps['onNode']; onEdge: KnowledgeGraph3DProps['onEdge'];
  camera: Graph3DCamera; remembered: boolean; resetSignal: number; zoomRequest: KnowledgeGraph3DProps['zoomRequest'];
  onCamera: KnowledgeGraph3DProps['onCamera']; host: React.RefObject<HTMLDivElement | null>;
}) {
  const reading = layout.reading;
  const focused = new Set(reading ? [reading.focus, ...reading.supports, ...reading.challenges, ...reading.sources, ...reading.secondary] : [selectedNodeId, ...graph.edges.filter(edge => edge.from === selectedNodeId || edge.to === selectedNodeId).map(edge => edge.from === selectedNodeId ? edge.to : edge.from)]);
  const visibleIds = new Set(layout.visibleEdges);
  if (selectedEdgeId) visibleIds.add(selectedEdgeId);
  const drawn = graph.edges.filter(edge => visibleIds.has(edge.id) && layout.positions[edge.from] && layout.positions[edge.to]);
  const groupTones = new Map(layout.groups.flatMap(group => group.members.map(id => [id, group.tone] as const)));
  const labeled = graph.nodes.filter(node => presentation === 'question' ? reading && [reading.focus, ...reading.supports, ...reading.challenges, ...reading.sources].includes(node.id) : node.id === selectedNodeId)
    .sort((a, b) => Number(b.id === selectedNodeId) - Number(a.id === selectedNodeId) || b.degree - a.degree).slice(0, presentation === 'question' ? 5 : 8);
  const selectedEdge = graph.edges.find(edge => edge.id === selectedEdgeId);
  return <>
    <color attach="background" args={['#070c16']} />
    <CameraRig initial={camera} remembered={remembered} home={cameraFor(layout.groups, presentation)} presentation={presentation} resetSignal={resetSignal} zoomRequest={zoomRequest} onCamera={onCamera} host={host} />
    {layout.groups.map(group => { const outline = groupOutline(group, presentation === 'question' ? 0.77 : 1); return <group key={group.id} position={presentation === 'question' ? [group.center[0] * 0.72, group.center[1] * 0.72, -3] : group.center}>
      <mesh><shapeGeometry args={[outline.shape]} /><meshBasicMaterial color={color[group.tone]} transparent opacity={presentation === 'question' ? 0.018 : 0.085} depthWrite={false} side={2} /></mesh>
      <Line points={outline.points} color={color[group.tone]} lineWidth={0.65} transparent opacity={presentation === 'question' ? 0.06 : 0.28} />
      {presentation === 'constellation' && <Billboard position={[-outline.radius * 0.75, outline.radius * 1.02, 0]} prominent className={`group group-${group.tone}`}>{group.name}<small>{group.members.length} 个当前范围节点</small></Billboard>}
    </group>; })}
    {drawn.map(edge => <RelationLine key={edge.id} edge={edge} from={layout.positions[edge.from]} to={layout.positions[edge.to]} background={!!reading && edge.from !== reading.focus && edge.to !== reading.focus} highlighted={edge.id === selectedEdgeId || (reading ? edge.to === reading.focus && [...reading.supports, ...reading.challenges].includes(edge.from) : edge.from === selectedNodeId || edge.to === selectedNodeId)} accent={reading?.supports[1] === edge.from && edge.to === reading.focus && edge.relation.stance === 'supports' ? color.blue : undefined} onEdge={onEdge} />)}
    {graph.nodes.map(node => layout.positions[node.id] && <NodeGlyph key={node.id} node={node} position={layout.positions[node.id]} selected={node.id === selectedNodeId} prominent={focused.has(node.id) && (presentation === 'constellation' ? node.isRoot || node.degree >= 5 : !!reading && [reading.focus, ...reading.supports, ...reading.challenges].includes(node.id))} coReadingIndex={coReadingIds.indexOf(node.id)} dimmed={presentation === 'question' && !focused.has(node.id)} groupTone={groupTones.get(node.id) ?? 'violet'} accent={reading?.supports[0] === node.id ? color.violet : reading?.supports[1] === node.id ? color.blue : reading?.challenges.includes(node.id) ? color.amber : undefined} onNode={onNode} />)}
    {labeled.map(node => { const point = layout.positions[node.id]; if (!point) return null; const role = reading ? node.id === reading.focus ? 'focus' : reading.supports.includes(node.id) ? 'support' : reading.challenges.includes(node.id) ? 'challenge' : 'source' : 'overview'; const offset = role === 'focus' || role === 'overview' ? [0.8, 0.05] : role === 'source' ? [0.3, -0.5] : role === 'challenge' || role === 'support' && reading?.supports.indexOf(node.id) === 1 ? [-3.3, 0.1] : [0.6, 0.1]; return <Billboard key={node.id} position={[point[0] + offset[0], point[1] + offset[1], point[2] + 0.12]} prominent={node.id === selectedNodeId || role !== 'overview'} className={`role-${role}`}><strong>{role === 'focus' ? '当前认识' : role === 'support' ? '支持来路' : role === 'challenge' ? '挑战' : role === 'source' ? '来源资料' : '所选认识'}</strong><span>{node.shortLabel}</span></Billboard>; })}
    {reading && drawn.filter(edge => edge.to === reading.focus && (reading.supports.includes(edge.from) || reading.challenges.includes(edge.from))).map(edge => { const from = layout.positions[edge.from], to = layout.positions[edge.to]; return <Billboard key={`label:${edge.id}`} position={[(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, 3.1]} className={edge.relation.stance === 'challenges' ? 'edge-challenge' : 'edge-support'}>{relationName[edge.relation.stance]}</Billboard>; })}
    {selectedEdge && layout.positions[selectedEdge.from] && layout.positions[selectedEdge.to] && <Billboard position={[(layout.positions[selectedEdge.from][0] + layout.positions[selectedEdge.to][0]) / 2, (layout.positions[selectedEdge.from][1] + layout.positions[selectedEdge.to][1]) / 2 + 0.38, (layout.positions[selectedEdge.from][2] + layout.positions[selectedEdge.to][2]) / 2]} prominent>{relationName[selectedEdge.relation.stance]} · 依据{statusName[selectedEdge.relation.evidenceStatus]}</Billboard>}
  </>;
}

class RenderBoundary extends Component<{ children: ReactNode; onError: (reason: string) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { this.props.onError(`3D 渲染失败：${error.message}`); }
  render() { return this.state.failed ? null : this.props.children; }
}

export function KnowledgeGraph3D({ graph, presentation, selectedNodeId, selectedEdgeId, coReadingIds, onNode, onEdge, onCamera, rememberedCamera, resetSignal, zoomRequest, visible, onUnavailable, onReady }: KnowledgeGraph3DProps) {
  const host = useRef<HTMLDivElement>(null);
  const [rendererState, setRendererState] = useState<'checking' | 'ready' | 'unavailable'>('checking');
  const failed = useRef(false), cleanup = useRef<(() => void) | null>(null);
  const base = useMemo(() => constellationLayout(graph), [graph]);
  const layout = useMemo(() => presentation === 'question' ? questionLayout(graph, base, selectedNodeId ?? graph.rootId) : base, [graph, base, presentation, selectedNodeId]);
  const initialCamera = useRef(validCamera(rememberedCamera) ? rememberedCamera : cameraFor(base.groups, presentation));
  const initiallyRemembered = useRef(validCamera(rememberedCamera));
  const counts = { nodes: graph.nodes.length, edges: graph.edges.length, groups: base.groups.length };
  const shownEdges = layout.visibleEdges.length + (selectedEdgeId && !layout.visibleEdges.includes(selectedEdgeId) && graph.edges.some(edge => edge.id === selectedEdgeId) ? 1 : 0);
  const unavailable = (reason: string) => {
    if (failed.current) return;
    failed.current = true;
    setRendererState('unavailable');
    onUnavailable(reason);
  };
  useEffect(() => {
    if (typeof document === 'undefined') return;
    try {
      const context = document.createElement('canvas').getContext('webgl2');
      if (!context) { unavailable('此设备无法创建 WebGL2 画布'); return; }
      context.getExtension('WEBGL_lose_context')?.loseContext();
    } catch (error) { unavailable(`WebGL2 检查失败：${String(error)}`); }
  }, []);
  useEffect(() => () => { cleanup.current?.(); }, []);
  useEffect(() => { if (rendererState === 'ready') onReady?.(counts); }, [graph, rendererState]);
  const onCreated = ({ gl }: { gl: WebGLRenderer }) => {
    if (typeof WebGL2RenderingContext === 'undefined' || !(gl.getContext() instanceof WebGL2RenderingContext)) { unavailable('3D 画布未使用 WebGL2'); return; }
    if (!failed.current) setRendererState('ready');
    const lost = (event: Event) => { event.preventDefault(); unavailable('WebGL 画布上下文已丢失'); };
    gl.domElement.addEventListener('webglcontextlost', lost);
    cleanup.current = () => gl.domElement.removeEventListener('webglcontextlost', lost);
  };
  return <div ref={host} data-testid="knowledge-graph-3d" data-renderer-state={rendererState} data-node-count={counts.nodes} data-edge-count={counts.edges} data-group-count={counts.groups} data-visible-edge-count={shownEdges} data-hidden-edge-count={counts.edges - shownEdges}
    data-layout-debug={JSON.stringify({ presentation, groups: base.groups.map(group => ({ id: group.id, name: group.name, members: group.members.length, center: group.center })), positions: layout.positions })}
    style={{ width: '100%', height: '100%', minHeight: 320, position: 'relative', overflow: 'hidden', background: '#070c16', visibility: visible ? 'visible' : 'hidden' }}>
    {rendererState !== 'unavailable' && <RenderBoundary onError={unavailable}><Canvas frameloop="demand" dpr={[1, 1.7]} gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }} camera={{ position: initialCamera.current.position, fov: 48, near: 0.1, far: 200 }} onCreated={onCreated}>
      <Scene graph={graph} layout={layout} presentation={presentation} selectedNodeId={selectedNodeId} selectedEdgeId={selectedEdgeId} coReadingIds={coReadingIds} onNode={onNode} onEdge={onEdge} camera={initialCamera.current} remembered={initiallyRemembered.current} resetSignal={resetSignal} zoomRequest={zoomRequest} onCamera={onCamera} host={host} />
    </Canvas></RenderBoundary>}
    <details style={{ position: 'absolute', left: 12, bottom: 12, maxWidth: 'min(380px, calc(100% - 24px))', color: '#d4dced', font: `12px ${font}`, background: 'rgba(10,16,29,.86)', border: '1px solid #293448', borderRadius: 7, padding: '5px 8px' }}>
      <summary style={{ cursor: 'pointer' }}>当前范围 · {counts.nodes} 节点 · {counts.edges} 关系 · {counts.edges - shownEdges} 条未画出</summary>
      <div style={{ maxHeight: 230, overflow: 'auto', marginTop: 7 }}>
        <p>分组按当前返回连接生成，不代表全库主题。线按来源 → 目标；依据状态以原记录为准。</p>
        {graph.nodes.map(node => <button key={node.id} type="button" onClick={() => onNode(node.id)} style={listButton}>{node.document === null ? '◇ 来源' : '● 认识'} · {node.title}</button>)}
        {graph.edges.map((edge, index) => <button key={edge.id} type="button" onClick={() => onEdge(edge.id)} style={listButton} title={`${edge.id} · ${edge.relation.relationVersion}`} aria-label={`关系 ${index + 1}，${edge.id}，${relationName[edge.relation.stance]}，${edge.from} 到 ${edge.to}，依据${statusName[edge.relation.evidenceStatus]}`}>#{index + 1} {relationName[edge.relation.stance]} · {graph.nodes.find(node => node.id === edge.from)?.shortLabel ?? edge.from} → {graph.nodes.find(node => node.id === edge.to)?.shortLabel ?? edge.to} · 依据{statusName[edge.relation.evidenceStatus]}</button>)}
      </div>
    </details>
  </div>;
}

const listButton = { display: 'block', width: '100%', textAlign: 'left', border: 0, borderBottom: '1px solid #293448', background: 'transparent', color: '#d4dced', padding: '5px 2px', cursor: 'pointer', font: `12px ${font}` } as const;

export default KnowledgeGraph3D;
