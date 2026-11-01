import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Html, Line, OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { AdditiveBlending, CanvasTexture, Quaternion, Shape, SRGBColorSpace, Vector3, type WebGLRenderer } from 'three';
import type { GraphEdgeView, GraphNodeView } from '../graph/view-model';
import { constellationLayout, questionLayout, type Graph3DGroup, type GraphTone, type Point3 } from './layout';
import type { Graph3DCamera, KnowledgeGraph3DProps } from './types';

export type { Graph3DCamera, KnowledgeGraph3DProps } from './types';

const color: Record<GraphTone | 'grey' | 'amber', string> = {
  violet: '#b989ff', blue: '#73b5ff', cyan: '#6edee8', rose: '#d99bdd', teal: '#73d9c8', grey: '#9eb2c9', amber: '#efb55a',
};
const starTints: Record<GraphTone, string[]> = {
  violet: ['#c49aff', '#ad86ee', '#e0b9ff'],
  blue: ['#7fbcff', '#6fa5f6', '#8bd5ff'],
  cyan: ['#72e1e7', '#61cbd9', '#9bdadd'],
  rose: ['#db9ee1', '#c88ed3', '#efb9e8'],
  teal: ['#82e4d3', '#68cabb', '#a0eadf'],
};
const font = 'Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
const relationName = { supports: '支持', challenges: '挑战', context: '背景', navigation: '导航' } as const;
const statusName = { observed: '已观察', untested: '未检验', unknown: '未知' } as const;

function createGlowTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const context = canvas.getContext('2d')!;
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(255,255,255,0.95)');
  gradient.addColorStop(0.12, 'rgba(255,255,255,0.64)');
  gradient.addColorStop(0.38, 'rgba(255,255,255,0.18)');
  gradient.addColorStop(0.72, 'rgba(255,255,255,0.045)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function stableTint(id: string, tone: GraphTone): string {
  const palette = starTints[tone];
  let hash = 0;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return palette[(hash >>> 0) % palette.length];
}

function cameraFor(groups: Graph3DGroup[], presentation: KnowledgeGraph3DProps['presentation']): Graph3DCamera {
  if (presentation === 'question') return { position: [0.7, -0.25, 14.6], target: [0, -0.4, 0] };
  const extent = Math.max(12, ...groups.map(group => Math.hypot(group.center[0], group.center[1]) + 4));
  const depth = extent * 1.9;
  return { position: [depth * 0.065, -0.72 - depth * 0.025, depth], target: [0, -0.35, 0] };
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
  initialRef.current = initial;
  const transition = useRef<{ position: Vector3; target: Vector3; fromPosition: Vector3; fromTarget: Vector3; started: number; duration: number } | null>(null);
  homeRef.current = home;
  const fittedHome = (): Graph3DCamera => {
    const responsiveMargin = size.width < 520 ? 1.1 : 1;
    const factor = Math.min(2.6, Math.max(1, size.height / Math.max(1, size.width)) * responsiveMargin);
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
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const moveTo = (value: Graph3DCamera, duration = 340) => {
    const target = controls.current?.target;
    if (!target || reducedMotion()) {
      apply(value);
      onCamera(value);
      return;
    }
    transition.current = {
      position: new Vector3(...value.position), target: new Vector3(...value.target),
      fromPosition: camera.position.clone(), fromTarget: target.clone(), started: performance.now(), duration,
    };
    invalidate();
  };
  useFrame(() => {
    const current = transition.current;
    const controlsTarget = controls.current?.target;
    if (!current || !controlsTarget) return;
    const progress = Math.min(1, (performance.now() - current.started) / current.duration);
    const eased = 1 - (1 - progress) ** 3;
    camera.position.lerpVectors(current.fromPosition, current.position, eased);
    controlsTarget.lerpVectors(current.fromTarget, current.target, eased);
    controls.current?.update();
    host.current?.setAttribute('data-camera-debug', JSON.stringify({
      position: camera.position.toArray(), target: controlsTarget.toArray(),
    }));
    if (progress < 1) invalidate();
    else {
      transition.current = null;
      snapshot();
    }
  });
  useEffect(() => {
    const value = remembered ? initialRef.current : fittedHome();
    if (remembered || reducedMotion()) {
      apply(value);
      return;
    }
    const target = new Vector3(...value.target);
    const start: Graph3DCamera = {
      position: target.clone().add(new Vector3(...value.position).sub(target).multiplyScalar(1.075)).toArray() as Point3,
      target: value.target,
    };
    apply(start);
    transition.current = {
      position: new Vector3(...value.position), target: new Vector3(...value.target),
      fromPosition: new Vector3(...start.position), fromTarget: target.clone(), started: performance.now(), duration: 700,
    };
    invalidate();
  }, []);
  useEffect(() => {
    if (resetSeen.current === resetSignal) return;
    resetSeen.current = resetSignal;
    moveTo(fittedHome());
  }, [resetSignal]);
  useEffect(() => {
    if (viewSeen.current === presentation) return;
    viewSeen.current = presentation;
    const value = remembered ? initialRef.current : fittedHome();
    moveTo(value, 320);
  }, [presentation]);
  useEffect(() => {
    if (zoomSeen.current === zoomRequest.sequence) return;
    zoomSeen.current = zoomRequest.sequence;
    const target = controls.current?.target;
    if (!target) return;
    const offset = camera.position.clone().sub(target).multiplyScalar(zoomRequest.direction === 'in' ? 0.78 : 1.28).clampLength(3, 75);
    moveTo({ position: target.clone().add(offset).toArray() as Point3, target: target.toArray() as Point3 });
  }, [zoomRequest.sequence, zoomRequest.direction]);
  return <OrbitControls ref={controls} enableDamping={false} enablePan enableZoom minDistance={3} maxDistance={75} maxPolarAngle={Math.PI * 0.88} onStart={() => { transition.current = null; }} onEnd={snapshot} />;
}

function NodeGlyph({ node, position, selected, prominent, coReadingIndex, dimmed, onNode, groupTone, accent, glowTexture, connectionCount }: {
  node: GraphNodeView; position: Point3; selected: boolean; coReadingIndex: number; dimmed: boolean;
  prominent: boolean; accent?: string; glowTexture: CanvasTexture; connectionCount: number;
  onNode: (id: string) => void; groupTone: Graph3DGroup['tone'];
}) {
  const [hovered, setHovered] = useState(false);
  const source = node.document === null;
  const hollow = prominent && !selected && coReadingIndex < 0 && !source;
  const tint = selected ? color.violet : coReadingIndex === 0 ? color.violet : coReadingIndex === 1 ? color.blue : accent ?? (source ? color.grey : stableTint(node.id, groupTone));
  const radius = selected ? 0.4 : prominent ? 0.3 : source ? connectionCount >= 20 ? 0.27 : connectionCount >= 8 ? 0.21 : 0.18 : node.degree >= 3 ? 0.24 : 0.17;
  const glowScale = selected ? 8.4 : prominent ? 7.2 : source ? connectionCount >= 20 ? 7.8 : 6.6 : node.degree >= 3 ? 6.8 : 5.8;
  const glowOpacity = dimmed ? 0.07 : selected ? 0.34 : prominent ? 0.19 : source ? connectionCount >= 20 ? 0.18 : 0.13 : node.degree >= 3 ? 0.17 : 0.12;
  const sourceHub = source && connectionCount >= 8;
  const pick = (event: { stopPropagation: () => void }) => { event.stopPropagation(); onNode(node.id); };
  const hover = (next: boolean) => (event: { stopPropagation: () => void }) => { event.stopPropagation(); setHovered(next); };
  return <group position={position}>
    <sprite scale={[radius * glowScale, radius * glowScale, 1]} renderOrder={1}>
      <spriteMaterial map={glowTexture} color={tint} transparent opacity={glowOpacity} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
    </sprite>
    <mesh rotation={source ? [0, 0, -0.12] : [0, 0, 0]} onClick={pick} onPointerOver={hover(true)} onPointerOut={hover(false)}>
      {source ? <boxGeometry args={[radius * 1.15, radius * 1.48, radius * 0.22]} /> : <sphereGeometry args={[radius, 12, 10]} />}
      <meshBasicMaterial color={tint} transparent opacity={dimmed ? 0.28 : source ? 1 : selected ? 0.56 : hollow ? 0.15 : prominent ? 0.38 : 0.82} blending={!source && (selected || prominent) ? AdditiveBlending : undefined} depthWrite={false} toneMapped={false} />
    </mesh>
    <mesh position={[0, 0, radius * 0.5]}>
      {source ? <boxGeometry args={[radius * 0.52, radius * 0.1, radius * 0.06]} /> : <sphereGeometry args={[radius * (hollow ? 0.18 : 0.26), 16, 12]} />}
      <meshBasicMaterial color={source ? '#dbf5ff' : '#fff8ff'} transparent opacity={dimmed ? 0.28 : hollow ? 0.9 : 0.76} depthWrite={false} toneMapped={false} />
    </mesh>
    {(selected || coReadingIndex >= 0 || sourceHub || hollow) && <mesh><torusGeometry args={[radius + 0.1, selected ? 0.018 : hollow ? 0.008 : sourceHub ? 0.01 : 0.013, 6, 40]} /><meshBasicMaterial color={tint} transparent opacity={hollow ? 0.54 : 0.68} blending={AdditiveBlending} depthWrite={false} toneMapped={false} /></mesh>}
    {selected && <mesh><ringGeometry args={[radius + 0.22, radius + 0.31, 48]} /><meshBasicMaterial color={tint} transparent opacity={0.07} blending={AdditiveBlending} depthWrite={false} side={2} toneMapped={false} /></mesh>}
    <mesh onClick={pick} onPointerOver={hover(true)} onPointerOut={hover(false)}><sphereGeometry args={[Math.max(0.38, radius), 8, 6]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} /></mesh>
    {hovered && <Billboard position={[0, radius + 0.62, 0.25]} className={source ? 'role-source source-hover' : 'role-overview hover-card'} title={node.title}><strong><b>{source ? 'S' : 'i'}</b>{source ? '来源资料' : '认识'}</strong><span>{source ? `${connectionCount} 个相邻认识` : node.shortLabel}</span></Billboard>}
  </group>;
}

function RelationLine({ edge, from, to, highlighted, background, bridge, accent, onEdge }: {
  edge: GraphEdgeView; from: Point3; to: Point3; highlighted: boolean; background: boolean; bridge: boolean; accent?: string; onEdge: (id: string) => void;
}) {
  const delta = new Vector3(...to).sub(new Vector3(...from));
  const length = delta.length();
  if (length < 0.6) return null;
  const direction = delta.normalize();
  const start = new Vector3(...from).addScaledVector(direction, highlighted ? 0.52 : 0.27);
  const end = new Vector3(...to).addScaledVector(direction, highlighted ? -0.68 : -0.3);
  const middle = start.clone().add(end).multiplyScalar(0.5);
  const bendSeed = [...edge.id].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 2 ? 1 : -1;
  const perpendicular = new Vector3(-direction.y, direction.x, 0);
  const curved = bridge || edge.relation.stance === 'context' || edge.relation.stance === 'navigation';
  const curveSize = bridge ? 0.42 : edge.relation.stance === 'context' ? 0.14 : 0.09;
  const control = middle.clone().addScaledVector(perpendicular, curved ? bendSeed * curveSize : 0);
  const linePoints: Point3[] = curved
    ? Array.from({ length: 13 }, (_, index) => {
      const t = index / 12, oneMinus = 1 - t;
      return [
        oneMinus * oneMinus * start.x + 2 * oneMinus * t * control.x + t * t * end.x,
        oneMinus * oneMinus * start.y + 2 * oneMinus * t * control.y + t * t * end.y,
        oneMinus * oneMinus * start.z + 2 * oneMinus * t * control.z + t * t * end.z,
      ];
    })
    : [start.toArray() as Point3, end.toArray() as Point3];
  const arrow = end.clone();
  const tangent = bridge ? end.clone().sub(control).normalize() : direction;
  const rotation = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), tangent);
  const stance = edge.relation.stance;
  const tint = accent ?? (stance === 'challenges' ? color.amber : stance === 'supports' ? color.violet : stance === 'navigation' ? color.blue : color.grey);
  const opacity = background ? 0.08 : highlighted ? 0.95 : bridge ? stance === 'navigation' || stance === 'context' ? 0.34 : 0.8 : stance === 'navigation' || stance === 'context' ? 0.22 : 0.62;
  const pick = (event: { stopPropagation: () => void }) => { event.stopPropagation(); onEdge(edge.id); };
  return <group>
    {(highlighted || bridge) && !background && <Line points={linePoints} color={tint} lineWidth={highlighted ? 5.5 : 3.6} transparent opacity={highlighted ? 0.1 : 0.055} blending={AdditiveBlending} depthWrite={false} />}
    <Line points={linePoints} color={tint} lineWidth={highlighted ? 2 : bridge ? 1.55 : background ? 0.6 : 1.2} transparent opacity={opacity} dashed={!background && (stance === 'challenges' || stance === 'navigation')} dashSize={stance === 'challenges' ? 0.18 : 0.07} gapSize={0.11} onClick={pick} />
    {!background && <mesh position={arrow.toArray()} quaternion={rotation} onClick={pick}><coneGeometry args={[highlighted ? 0.09 : bridge ? 0.075 : 0.06, highlighted ? 0.2 : bridge ? 0.17 : 0.14, 5]} /><meshBasicMaterial color={tint} transparent opacity={opacity} depthWrite={false} /></mesh>}
    <mesh position={middle.toArray()} quaternion={rotation} onClick={pick}><cylinderGeometry args={[0.18, 0.18, Math.max(0.1, start.distanceTo(end)), 5]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} /></mesh>
  </group>;
}

function Billboard({ position, children, prominent = false, className = '', delayMs = 0, title }: { position: Point3; children: ReactNode; prominent?: boolean; className?: string; delayMs?: number; title?: string }) {
  return <Html position={position} style={{ pointerEvents: 'none', userSelect: 'none' }}>
    <span className={`graph3d-label ${prominent ? 'prominent' : ''} ${className}`} style={{ animationDelay: `${delayMs}ms` }} title={title}>{children}</span>
  </Html>;
}

function SpatialField({ presentation }: { presentation: KnowledgeGraph3DProps['presentation'] }) {
  if (presentation === 'question') {
    const lines: Point3[][] = [];
    for (let x = -8; x <= 8; x += 2) lines.push([[x, -6, 0], [x, 6, 0]]);
    for (let y = -6; y <= 6; y += 2) lines.push([[-8, y, 0], [8, y, 0]]);
    return <group position={[0, -0.45, -4.3]} rotation={[-0.035, 0, -0.045]}>
      <mesh><planeGeometry args={[18.5, 12.5]} /><meshBasicMaterial color="#57708f" transparent opacity={0.024} depthWrite={false} side={2} /></mesh>
      {lines.map((points, index) => <Line key={index} points={points} color="#7186a5" lineWidth={0.45} transparent opacity={index % 6 === 0 ? 0.045 : 0.022} depthWrite={false} />)}
    </group>;
  }
  return <group position={[0, -0.1, -4.4]} rotation={[0, 0, -0.06]}>
    {[7.1, 9.6, 12.1].map((radius, index) => {
      const points: Point3[] = Array.from({ length: 97 }, (_, point) => {
        const angle = point / 96 * Math.PI * 2;
        return [Math.cos(angle) * radius * 1.16, Math.sin(angle) * radius * 0.74, index * 0.08];
      });
      return <Line key={radius} points={points} color={index === 1 ? '#a58ad5' : '#6f8daf'} lineWidth={0.55} transparent opacity={index === 1 ? 0.07 : 0.045} />;
    })}
  </group>;
}

function Scene({ graph, layout, presentation, selectedNodeId, selectedEdgeId, coReadingIds, onNode, onEdge, camera, remembered, resetSignal, zoomRequest, onCamera, host }: {
  graph: KnowledgeGraph3DProps['graph']; layout: ReturnType<typeof constellationLayout>;
  presentation: KnowledgeGraph3DProps['presentation']; selectedNodeId: string | null; selectedEdgeId: string | null;
  coReadingIds: readonly string[]; onNode: KnowledgeGraph3DProps['onNode']; onEdge: KnowledgeGraph3DProps['onEdge'];
  camera: Graph3DCamera; remembered: boolean; resetSignal: number; zoomRequest: KnowledgeGraph3DProps['zoomRequest'];
  onCamera: KnowledgeGraph3DProps['onCamera']; host: React.RefObject<HTMLDivElement | null>;
}) {
  const glowTexture = useMemo(createGlowTexture, []);
  useEffect(() => () => glowTexture.dispose(), [glowTexture]);
  const reading = layout.reading;
  const focused = new Set(reading ? [reading.focus, ...reading.supports, ...reading.challenges, ...reading.sources, ...reading.secondary] : [selectedNodeId, ...graph.edges.filter(edge => edge.from === selectedNodeId || edge.to === selectedNodeId).map(edge => edge.from === selectedNodeId ? edge.to : edge.from)]);
  const visibleIds = new Set(layout.visibleEdges);
  if (selectedEdgeId) visibleIds.add(selectedEdgeId);
  const drawn = graph.edges.filter(edge => visibleIds.has(edge.id) && layout.positions[edge.from] && layout.positions[edge.to]);
  const groupTones = new Map(layout.groups.flatMap(group => group.members.map(id => [id, group.tone] as const)));
  const groupByNode = new Map(layout.groups.flatMap(group => group.members.map(id => [id, group] as const)));
  const edgeById = new Map(graph.edges.map(edge => [edge.id, edge]));
  const bridgeIds = new Set(layout.bridgeEdges);
  const bridgeKinds = new Map<string, { supports: number; challenges: number; context: number; navigation: number }>();
  for (const id of layout.bridgeEdges) {
    const edge = edgeById.get(id);
    const fromGroup = edge ? groupByNode.get(edge.from) : undefined, toGroup = edge ? groupByNode.get(edge.to) : undefined;
    if (!edge) continue;
    for (const group of [fromGroup, toGroup]) {
      if (!group) continue;
      const kinds = bridgeKinds.get(group.id) ?? { supports: 0, challenges: 0, context: 0, navigation: 0 };
      kinds[edge.relation.stance] += 1;
      bridgeKinds.set(group.id, kinds);
    }
  }
  const pathRoles = new Map<string, 'support' | 'challenge'>();
  if (!reading && presentation === 'constellation' && selectedNodeId) {
    for (const edge of graph.edges) {
      if (edge.to !== selectedNodeId || !['supports', 'challenges'].includes(edge.relation.stance) || pathRoles.has(edge.from)) continue;
      pathRoles.set(edge.from, edge.relation.stance === 'supports' ? 'support' : 'challenge');
    }
  }
  const pathRank = (id: string) => pathRoles.get(id) === 'support' ? 0 : pathRoles.get(id) === 'challenge' ? 1 : 2;
  const labeled = graph.nodes.filter(node => presentation === 'question'
    ? reading && [reading.focus, ...reading.supports, ...reading.challenges, ...reading.sources].includes(node.id)
    : node.id === selectedNodeId || pathRoles.has(node.id))
    .sort((a, b) => Number(b.id === selectedNodeId) - Number(a.id === selectedNodeId) || pathRank(a.id) - pathRank(b.id) || b.degree - a.degree)
    .slice(0, presentation === 'question' ? 5 : 4);
  const pathGroupIds = new Set(labeled.filter(node => pathRoles.has(node.id)).map(node => groupByNode.get(node.id)?.id).filter((id): id is string => !!id));
  const constellationSupportOrder = new Map(labeled.filter(node => pathRoles.get(node.id) === 'support').map((node, index) => [node.id, index]));
  const pathAccents = new Map(labeled.filter(node => pathRoles.has(node.id)).map(node => [
    node.id,
    pathRoles.get(node.id) === 'challenge' ? color.amber : constellationSupportOrder.get(node.id) === 0 ? color.violet : color.blue,
  ] as const));
  const selectedEdge = graph.edges.find(edge => edge.id === selectedEdgeId);
  const focusPoint = selectedNodeId ? layout.positions[selectedNodeId] : undefined;
  const selectedGroup = selectedNodeId ? layout.groups.find(group => group.members.includes(selectedNodeId)) : undefined;
  return <>
    <color attach="background" args={['#070c16']} />
    <SpatialField presentation={presentation} />
    <CameraRig initial={camera} remembered={remembered} home={cameraFor(layout.groups, presentation)} presentation={presentation} resetSignal={resetSignal} zoomRequest={zoomRequest} onCamera={onCamera} host={host} />
    {layout.groups.map((group, groupIndex) => { const outline = groupOutline(group, presentation === 'question' ? 0.77 : 1); const activeGroup = group.id === selectedGroup?.id; const bridgeKindsForGroup = bridgeKinds.get(group.id); const bridgeSummary = [
      bridgeKindsForGroup?.supports ? `${bridgeKindsForGroup.supports} 支持桥` : '',
      bridgeKindsForGroup?.challenges ? `${bridgeKindsForGroup.challenges} 挑战桥` : '',
    ].filter(Boolean).join(' · '); return <group key={group.id} position={presentation === 'question' ? [group.center[0] * 0.72, group.center[1] * 0.72, -3] : group.center}>
      <sprite position={[0, 0, -0.08]} scale={[outline.radius * 2.8, outline.radius * 1.92, 1]} renderOrder={-1}>
        <spriteMaterial map={glowTexture} color={color[group.tone]} transparent opacity={presentation === 'question' ? 0.04 : activeGroup ? 0.15 : 0.09} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
      </sprite>
      <mesh><shapeGeometry args={[outline.shape]} /><meshBasicMaterial color={color[group.tone]} transparent opacity={presentation === 'question' ? 0.022 : activeGroup ? 0.14 : 0.085} depthWrite={false} side={2} /></mesh>
      <Line points={outline.points} color={color[group.tone]} lineWidth={activeGroup ? 0.85 : 0.6} transparent opacity={presentation === 'question' ? 0.06 : activeGroup ? 0.44 : 0.28} dashed={!activeGroup} dashSize={0.1} gapSize={0.14} />
      <Line points={outline.points.map(([x, y, z]) => [x * 0.82, y * 0.82, z + 0.03] as Point3)} color={color[group.tone]} lineWidth={0.32} transparent opacity={presentation === 'question' ? 0.032 : activeGroup ? 0.15 : 0.09} dashed />
      {presentation === 'constellation' && group.id !== selectedGroup?.id && <Billboard position={[-outline.radius * 0.75, outline.radius * 1.02 - 0.2, 0]} prominent className={`group group-${group.tone} group-index-${groupIndex}${pathGroupIds.has(group.id) ? ' group-path' : ''}`} delayMs={groupIndex * 45}>{group.name}<small>{group.members.length} 节点{bridgeSummary ? ` · ${bridgeSummary}` : ''}</small></Billboard>}
    </group>; })}
    {drawn.map(edge => <RelationLine key={edge.id} edge={edge} from={layout.positions[edge.from]} to={layout.positions[edge.to]} bridge={bridgeIds.has(edge.id)} background={edge.id !== selectedEdgeId && (presentation === 'constellation' ? edge.relation.stance === 'context' || edge.relation.stance === 'navigation' : !!reading && edge.from !== reading.focus && edge.to !== reading.focus)} highlighted={edge.id === selectedEdgeId || (reading ? edge.to === reading.focus && [...reading.supports, ...reading.challenges].includes(edge.from) : edge.from === selectedNodeId || edge.to === selectedNodeId)} accent={reading?.supports[1] === edge.from && edge.to === reading.focus && edge.relation.stance === 'supports' ? color.blue : undefined} onEdge={onEdge} />)}
    {graph.nodes.map(node => layout.positions[node.id] && <NodeGlyph key={node.id} node={node} position={layout.positions[node.id]} selected={node.id === selectedNodeId} prominent={focused.has(node.id) && (presentation === 'constellation' ? node.isRoot || node.degree >= 5 : !!reading && [reading.focus, ...reading.supports, ...reading.challenges].includes(node.id))} coReadingIndex={coReadingIds.indexOf(node.id)} dimmed={presentation === 'question' && !focused.has(node.id)} groupTone={groupTones.get(node.id) ?? 'violet'} accent={reading?.supports[0] === node.id ? color.violet : reading?.supports[1] === node.id ? color.blue : reading?.challenges.includes(node.id) ? color.amber : pathAccents.get(node.id)} glowTexture={glowTexture} connectionCount={layout.connectionCounts[node.id] ?? 0} onNode={onNode} />)}
    {labeled.map((node, labelIndex) => {
      const point = layout.positions[node.id];
      if (!point) return null;
      const role = reading ? node.id === reading.focus ? 'focus' : reading.supports.includes(node.id) ? 'support' : reading.challenges.includes(node.id) ? 'challenge' : 'source' : node.id === selectedNodeId ? 'overview' : pathRoles.get(node.id) ?? 'source';
      const pathRole = !reading && pathRoles.has(node.id);
      let offset: Point3 = [0.6, 0.1, 0];
      if (role === 'focus') offset = [0.8, 0.05, 0];
      else if (role === 'overview') offset = [0.85, 1, 0];
      else if (role === 'source') offset = [0.3, -0.5, 0];
      else if (pathRole && focusPoint) {
        const dx = point[0] - focusPoint[0], dy = point[1] - focusPoint[1], distance = Math.max(1, Math.hypot(dx, dy));
        const spread = role === 'challenge' ? 1 : 0.88;
        offset = [dx / distance * spread, dy / distance * spread, 0];
      } else if (role === 'challenge' || role === 'support' && reading?.supports.indexOf(node.id) === 1) offset = [-3.3, 0.1, 0];
      const supportIndex = reading ? reading.supports.indexOf(node.id) : constellationSupportOrder.get(node.id) ?? -1;
      const sourceIndex = reading ? reading.sources.indexOf(node.id) : -1;
      const badge = role === 'focus' || role === 'overview' ? 'C' : role === 'support' && supportIndex >= 0 ? String.fromCharCode(65 + supportIndex) : role === 'challenge' ? 'D' : role === 'source' && sourceIndex >= 0 ? `S${sourceIndex + 1}` : '';
      const labelPosition: Point3 = [point[0] + offset[0], point[1] + offset[1], point[2] + 0.12];
      const labelTint = role === 'challenge' ? color.amber : role === 'support' && supportIndex === 1 ? color.blue : role === 'source' ? color.grey : color.violet;
      return <group key={node.id}>
        {(pathRole || role !== 'overview') && <Line points={[point, labelPosition]} color={labelTint} lineWidth={0.45} transparent opacity={role === 'source' ? 0.16 : 0.26} dashed={role === 'challenge'} dashSize={0.08} gapSize={0.08} />}
        <Billboard position={labelPosition} prominent={node.id === selectedNodeId || role !== 'overview'} className={`role-${role}${role === 'support' && supportIndex >= 0 ? ` support-${supportIndex}` : ''}${pathRole ? ' role-path' : ''}`} delayMs={presentation === 'question' ? 120 + labelIndex * 48 : pathRole ? 260 + labelIndex * 42 : 310} title={`${badge} ${role === 'support' ? '支持来路' : role === 'challenge' ? '挑战' : role === 'source' ? '来源资料' : '当前认识'}：${node.title}`}><strong><b>{badge}</b>{role === 'focus' ? '当前认识' : role === 'support' ? '支持' : role === 'challenge' ? '挑战' : role === 'source' ? '来源' : '当前认识'}</strong><span>{node.shortLabel}</span></Billboard>
      </group>;
    })}
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
  const initialCamera = validCamera(rememberedCamera) ? rememberedCamera : cameraFor(base.groups, presentation);
  const counts = { nodes: graph.nodes.length, edges: graph.edges.length, groups: base.groups.length };
  const shownEdges = layout.visibleEdges.length + (selectedEdgeId && !layout.visibleEdges.includes(selectedEdgeId) && graph.edges.some(edge => edge.id === selectedEdgeId) ? 1 : 0);
  const edgesById = new Map(graph.edges.map(edge => [edge.id, edge]));
  const judgmentBridgeCount = base.bridgeEdges.filter(id => ['supports', 'challenges'].includes(edgesById.get(id)?.relation.stance ?? '')).length;
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
  const scopeSummary = `当前范围 · ${counts.nodes} 节点 · ${counts.edges} 关系 · ${counts.edges - shownEdges ? `${counts.edges - shownEdges} 条未画出` : '全部已画出'}${base.bridgeEdges.length ? ` · ${base.bridgeEdges.length} 跨群/${judgmentBridgeCount} 判断` : ''}`;
  return <div ref={host} data-testid="knowledge-graph-3d" data-renderer-state={rendererState} data-node-count={counts.nodes} data-edge-count={counts.edges} data-group-count={counts.groups} data-visible-edge-count={shownEdges} data-hidden-edge-count={counts.edges - shownEdges} data-bridge-count={base.bridgeEdges.length} data-judgment-bridge-count={judgmentBridgeCount}
    data-layout-debug={JSON.stringify({ presentation, groups: base.groups.map(group => ({ id: group.id, name: group.name, members: group.members.length, center: group.center })), bridges: base.bridgeEdges, positions: layout.positions })}
    style={{ width: '100%', height: '100%', minHeight: 320, position: 'relative', overflow: 'hidden', background: '#070c16', visibility: visible ? 'visible' : 'hidden' }}>
    {rendererState !== 'unavailable' && <RenderBoundary onError={unavailable}><Canvas frameloop="demand" dpr={[1, 1.7]} gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }} camera={{ position: initialCamera.position, fov: 48, near: 0.1, far: 200 }} onCreated={onCreated}>
      <Scene graph={graph} layout={layout} presentation={presentation} selectedNodeId={selectedNodeId} selectedEdgeId={selectedEdgeId} coReadingIds={coReadingIds} onNode={onNode} onEdge={onEdge} camera={initialCamera} remembered={validCamera(rememberedCamera)} resetSignal={resetSignal} zoomRequest={zoomRequest} onCamera={onCamera} host={host} />
    </Canvas></RenderBoundary>}
    <details className="graph-scope-details">
      <summary title={scopeSummary}>{scopeSummary}</summary>
      <div style={{ maxHeight: 230, overflow: 'auto', marginTop: 7 }}>
        <p>分组按当前返回连接生成，不代表全库主题。来源靠近其主要连接群落；跨群支持/挑战使用更明显的桥梁。A/B/C/D只表示本次视角的阅读位置。线按来源 → 目标，依据状态以原记录为准。</p>
        {graph.nodes.map(node => <button key={node.id} type="button" onClick={() => onNode(node.id)} style={listButton}>{node.document === null ? '◇ 来源' : '● 认识'} · {node.title}</button>)}
        {graph.edges.map((edge, index) => <button key={edge.id} type="button" onClick={() => onEdge(edge.id)} style={listButton} title={`${edge.id} · ${edge.relation.relationVersion}`} aria-label={`关系 ${index + 1}，${edge.id}，${relationName[edge.relation.stance]}，${edge.from} 到 ${edge.to}，依据${statusName[edge.relation.evidenceStatus]}`}>#{index + 1} {relationName[edge.relation.stance]} · {graph.nodes.find(node => node.id === edge.from)?.shortLabel ?? edge.from} → {graph.nodes.find(node => node.id === edge.to)?.shortLabel ?? edge.to} · 依据{statusName[edge.relation.evidenceStatus]}</button>)}
      </div>
    </details>
  </div>;
}

const listButton = { display: 'block', width: '100%', textAlign: 'left', border: 0, borderBottom: '1px solid #293448', background: 'transparent', color: '#d4dced', padding: '5px 2px', cursor: 'pointer', font: `12px ${font}` } as const;

export default KnowledgeGraph3D;
