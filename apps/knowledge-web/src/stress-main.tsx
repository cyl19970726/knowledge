import React, { useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { GraphEdgeView, GraphNodeView, GraphViewModel } from './graph/view-model';
import KnowledgeGraph3D from './graph3d/KnowledgeGraph3D';
import './styles.css';
import './stress.css';

function node(index: number): GraphNodeView {
  const id = `stress-${String(index).padStart(3, '0')}`;
  return {
    id,
    ref: {} as GraphNodeView['ref'],
    title: `压力节点 ${index + 1}`,
    shortLabel: `节点 ${index + 1}`,
    degree: 0,
    tone: 'violet',
    isRoot: index === 0,
    document: {} as GraphNodeView['document'],
    availability: 'knowledge',
  };
}

function stressGraph(): GraphViewModel {
  const nodes = Array.from({ length: 200 }, (_, index) => node(index));
  const edges: GraphEdgeView[] = [];
  for (let cluster = 0; cluster < 10; cluster += 1) {
    const start = cluster * 20;
    for (let offset = 0; offset < 20; offset += 1) {
      const from = nodes[start + offset], to = nodes[start + (offset + 1) % 20];
      edges.push({
        id: `internal-${cluster}-${offset}`,
        from: from.id,
        to: to.id,
        relation: { id: `internal-${cluster}-${offset}`, stance: offset % 9 === 0 ? 'supports' : 'context', evidenceStatus: 'unknown' } as GraphEdgeView['relation'],
      });
    }
  }
  for (let cluster = 1; cluster < 10; cluster += 1) {
    const from = nodes[cluster * 20], to = nodes[(cluster - 1) * 20 + 7];
    edges.push({
      id: `bridge-${cluster}`,
      from: from.id,
      to: to.id,
      relation: { id: `bridge-${cluster}`, stance: cluster % 4 === 0 ? 'challenges' : 'supports', evidenceStatus: 'unknown' } as GraphEdgeView['relation'],
    });
  }
  while (edges.length < 500) {
    const edgeIndex: number = edges.length, fromIndex = edgeIndex % 200;
    const toIndex = (fromIndex + 1 + (edgeIndex * 37) % 199) % 200;
    edges.push({
      id: `edge-${edgeIndex}`,
      from: nodes[fromIndex].id,
      to: nodes[toIndex].id,
      relation: { id: `edge-${edgeIndex}`, stance: edgeIndex % 29 === 0 ? 'navigation' : 'context', evidenceStatus: 'unknown' } as GraphEdgeView['relation'],
    });
  }
  return { nodes, edges, rootId: nodes[0].id, mode: 'global' };
}

function StressApp() {
  const graph = useMemo(stressGraph, []);
  const [status, setStatus] = useState('正在创建 WebGL2 画布');
  const probing = useRef(false);
  const onReady = () => {
    document.documentElement.dataset.stressReadyMs = String(Math.round(performance.now()));
    if (probing.current) return;
    probing.current = true;
    const host = document.querySelector('[data-testid="knowledge-graph-3d"]');
    const stamps: number[] = [];
    const observer = new MutationObserver(() => stamps.push(performance.now()));
    if (host) observer.observe(host, { attributes: true, attributeFilter: ['data-camera-debug'] });
    window.setTimeout(() => {
      observer.disconnect();
      const intervals = stamps.slice(1).map((value, index) => value - stamps[index]).sort((a, b) => a - b);
      if (intervals.length) {
        const median = intervals[Math.floor(intervals.length * 0.5)];
        const p95 = intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * 0.95))];
        document.documentElement.dataset.stressMedianFrameMs = median.toFixed(2);
        document.documentElement.dataset.stressP95FrameMs = p95.toFixed(2);
        document.documentElement.dataset.stressFrameSamples = String(intervals.length);
        setStatus(`ready · ${intervals.length} 帧 · 中位 ${median.toFixed(1)}ms`);
      } else setStatus('ready · 未取得帧样本');
    }, 1100);
  };
  return <main className="stress-shell">
    <header><strong>图谱压力测试</strong><span>200 节点 / 500 关系 / 合成数据</span><small data-testid="stress-status">{status}</small></header>
    <div className="stress-graph">
      <KnowledgeGraph3D
        graph={graph}
        presentation="constellation"
        selectedNodeId={graph.rootId}
        selectedEdgeId={null}
        coReadingIds={[]}
        onNode={() => undefined}
        onEdge={() => undefined}
        onCamera={() => undefined}
        rememberedCamera={null}
        resetSignal={0}
        zoomRequest={{ sequence: 0, direction: 'in' }}
        visible
        onUnavailable={reason => setStatus(`不可用：${reason}`)}
        onReady={() => {
          document.documentElement.dataset.stressReady = 'true';
          onReady();
        }}
      />
    </div>
  </main>;
}

const root = createRoot(document.getElementById('root')!);
root.render(<React.StrictMode><StressApp /></React.StrictMode>);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
