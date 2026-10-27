import ELKModule from 'elkjs/lib/elk-api.js';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import { layoutEdges, nodeSize, type GraphViewModel } from './view-model';

export type Position = { x: number; y: number };
export type LayoutResult = { positions: Record<string, Position>; durationMs: number; springCount: number };

// The package ships UMD. Vite can expose its default export through an
// interop wrapper; normalize that shape before using the official Worker URL.
function elkConstructor(value: unknown): typeof ELKModule {
  let current = value;
  for (let depth = 0; depth < 4; depth++) {
    if (typeof current === 'function') return current as typeof ELKModule;
    if (current && typeof current === 'object' && 'default' in current) current = current.default;
    else break;
  }
  throw new Error('ELK 布局模块缺少可用构造器');
}

export async function layoutGraph(graph: GraphViewModel): Promise<LayoutResult> {
  const springs = layoutEdges(graph);
  const elk = new (elkConstructor(ELKModule))({ workerUrl: elkWorkerUrl });
  const started = performance.now();
  let timeout: number | undefined;
  try {
    const result = await Promise.race([
      elk.layout({
        id: 'knowledge',
        layoutOptions: {
          'elk.algorithm': graph.mode === 'focused' ? 'radial' : 'force',
          'elk.spacing.nodeNode': graph.mode === 'focused' ? '72' : '86',
          'elk.spacing.edgeNode': '35',
          'elk.padding': '[top=90,left=110,bottom=90,right=110]',
          'elk.randomSeed': '7',
          ...(graph.mode === 'focused' ? { 'org.eclipse.elk.radial.centerOnRoot': 'true' } : {}),
        },
        children: [...graph.nodes]
          .sort((a, b) => Number(b.id === graph.rootId) - Number(a.id === graph.rootId))
          .map(node => ({ id: node.id, width: nodeSize(node), height: nodeSize(node) })),
        edges: springs.map(edge => ({ id: edge.id, sources: [edge.from], targets: [edge.to] })),
      }),
      new Promise<never>((_, reject) => { timeout = window.setTimeout(() => reject(new Error('布局超过 20 秒，请缩小图谱范围后重试。')), 20_000); }),
    ]);
    const positions = Object.fromEntries((result.children ?? []).map(node => [node.id, {
      x: (node.x ?? 0) + (node.width ?? 0) / 2,
      y: (node.y ?? 0) + (node.height ?? 0) / 2,
    }]));
    return { positions, durationMs: performance.now() - started, springCount: springs.length };
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
    elk.terminateWorker();
  }
}
