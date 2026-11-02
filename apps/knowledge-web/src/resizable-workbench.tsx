import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';

export type SplitConfig = { id: string; defaultRatio: number; label: string; paneIds: readonly [string, string] };
export const WORKBENCH_SPLITS = {
  answer: { id: 'answer', defaultRatio: 0.52, label: '调整回答与星图宽度', paneIds: ['workbench-reading', 'workbench-graph'] },
  notes: { id: 'notes', defaultRatio: 0.72, label: '调整星图与研究笔记宽度', paneIds: ['workbench-graph', 'workbench-notes'] },
} as const satisfies Record<string, SplitConfig>;
const KEY = 'knowledge:workbench:split:v1:';
const DEFAULT_SPLIT = 0.52;
const MIN = 0.28;
const MAX = 0.82;

export function clampSplit(value: number): number { return Number.isFinite(value) ? Math.min(MAX, Math.max(MIN, value)) : DEFAULT_SPLIT; }
export function splitForPixels(leftPixels: number, totalPixels: number): number {
  if (!Number.isFinite(totalPixels) || totalPixels <= 0) return DEFAULT_SPLIT;
  // Both panes need 334px; the separator consumes another 14px.
  const min = Math.min(0.5, Math.max(MIN, 334 / totalPixels));
  const max = Math.max(min, Math.min(MAX, 1 - 348 / totalPixels));
  return Math.max(min, Math.min(max, leftPixels / totalPixels));
}
export function splitFromKey(key: string, current: number): number | null {
  return key === 'ArrowLeft' ? current - 0.025 : key === 'ArrowRight' ? current + 0.025 :
    key === 'Home' ? MIN : key === 'End' ? MAX : null;
}
function savedSplit(config: SplitConfig): number {
  try {
    const value = localStorage.getItem(`${KEY}${config.id}`);
    return value === null || value.trim() === '' || !Number.isFinite(Number(value)) ? config.defaultRatio : clampSplit(Number(value));
  } catch { return config.defaultRatio; }
}
function remember(id: string, value: number): void { try { localStorage.setItem(`${KEY}${id}`, String(value)); } catch { /* A preference must not block reading. */ } }

/** Shared split behavior. Callers supply pane IDs and keep their pane nodes mounted while changing layout. */
export function useResizableWorkbench(config: SplitConfig): {
  containerRef: RefObject<HTMLDivElement | null>; ratio: number; style: CSSProperties;
  expanded: boolean; setExpanded: (value: boolean | ((current: boolean) => boolean)) => void;
  separatorProps: { role: 'separator'; tabIndex: number; 'aria-label': string; 'aria-orientation': 'vertical';
    'aria-controls': string;
    'aria-valuemin': number; 'aria-valuemax': number; 'aria-valuenow': number; 'aria-valuetext': string;
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => void; onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => void; onPointerCancel: (event: PointerEvent<HTMLDivElement>) => void;
    onLostPointerCapture: () => void; onDoubleClick: () => void; onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void };
  reset: () => void;
} {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);
  const [ratios, setRatios] = useState<Record<string, number>>({});
  const [expanded, setExpanded] = useState(false);
  const ratio = ratios[config.id] ?? savedSplit(config);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => setWidth(element.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const displayedRatio = width > 0 ? splitForPixels(ratio * width, width) : ratio;
  const commit = (value: number) => {
    const width = containerRef.current?.getBoundingClientRect().width ?? 0;
    const bounded = width > 0 ? splitForPixels(value * width, width) : clampSplit(value);
    setRatios(current => ({ ...current, [config.id]: bounded })); remember(config.id, bounded);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging.current !== event.pointerId) return;
    const bounds = containerRef.current?.getBoundingClientRect();
    if (bounds) commit(splitForPixels(event.clientX - bounds.left, bounds.width));
  };
  const release = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging.current !== event.pointerId) return;
    dragging.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const reset = () => commit(config.defaultRatio);
  return { containerRef, ratio: displayedRatio, style: { '--split-left': `${displayedRatio * 100}%` } as CSSProperties, expanded, setExpanded, reset,
    separatorProps: {
      role: 'separator', tabIndex: 0, 'aria-label': config.label, 'aria-orientation': 'vertical',
      'aria-controls': config.paneIds.join(' '),
      'aria-valuemin': width > 0 ? Math.round(splitForPixels(0, width) * 100) : MIN * 100,
      'aria-valuemax': width > 0 ? Math.round(splitForPixels(width, width) * 100) : MAX * 100,
      'aria-valuenow': Math.round(displayedRatio * 100),
      'aria-valuetext': `左侧 ${Math.round(displayedRatio * 100)}%，右侧 ${Math.round((1 - displayedRatio) * 100)}%`,
      onPointerDown: event => { if (event.button !== 0) return; dragging.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); },
      onPointerMove, onPointerUp: release, onPointerCancel: release, onLostPointerCapture: () => { dragging.current = null; },
      onDoubleClick: reset,
      onKeyDown: event => {
        const next = splitFromKey(event.key, displayedRatio);
        if (next === null) return;
        event.preventDefault(); commit(next);
      },
    } };
}
