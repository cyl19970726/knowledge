import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { clampSplit, splitForPixels, splitFromKey, useResizableWorkbench, WORKBENCH_SPLITS, type SplitConfig } from '../src/resizable-workbench.tsx';

test('pointer proportions are bounded by readable widths and reject invalid geometry', () => {
  assert.equal(splitForPixels(520, 1000), 0.52);
  assert.equal(splitForPixels(10, 1000), 0.334);
  assert.ok(Math.abs(splitForPixels(990, 1000) - 0.652) < 1e-10);
  const savedWidePreference = 0.82;
  assert.equal(splitForPixels(savedWidePreference * 2000, 2000), 0.82);
  assert.equal(splitForPixels(savedWidePreference * 1000, 1000), 0.652);
  assert.equal(savedWidePreference, 0.82);
  assert.equal(splitForPixels(0, 0), 0.52);
  assert.equal(clampSplit(Number.NaN), 0.52);
});

test('separator keys move in both directions and expose bounded home/end targets', () => {
  assert.equal(splitFromKey('ArrowLeft', 0.52), 0.495);
  assert.equal(splitFromKey('ArrowRight', 0.52), 0.545);
  assert.equal(splitFromKey('Home', 0.52), 0.28);
  assert.equal(splitFromKey('End', 0.52), 0.82);
  assert.equal(splitFromKey('Enter', 0.52), null);
});

test('both workbench modes expose one keyboard focusable separator with separate default proportions', () => {
  function Fixture({ mode }: { mode: 'answer' | 'notes' }) {
    const split = useResizableWorkbench(WORKBENCH_SPLITS[mode]);
    return createElement('div', { style: split.style }, createElement('div', split.separatorProps));
  }
  const answer = renderToStaticMarkup(createElement(Fixture, { mode: 'answer' }));
  const notes = renderToStaticMarkup(createElement(Fixture, { mode: 'notes' }));
  assert.match(answer, /--split-left:52%/);
  assert.match(notes, /--split-left:72%/);
  assert.match(answer, /role="separator"[^>]*tabindex="0"/);
  assert.match(answer, /aria-controls="workbench-reading workbench-graph"/);
  assert.match(notes, /aria-controls="workbench-graph workbench-notes"/);
  assert.match(answer, /aria-label="调整回答与星图宽度"/);
  assert.match(notes, /aria-label="调整星图与研究笔记宽度"/);
});

test('a new detail pair can reuse the same split behavior by supplying configuration', () => {
  function Fixture() {
    const config: SplitConfig = { id: 'source-detail', defaultRatio: 0.6, label: '调整正文与详情宽度', paneIds: ['source-body', 'source-detail'] };
    const split = useResizableWorkbench(config);
    return createElement('div', { style: split.style }, createElement('div', split.separatorProps));
  }
  const markup = renderToStaticMarkup(createElement(Fixture));
  assert.match(markup, /--split-left:60%/);
  assert.match(markup, /aria-controls="source-body source-detail"/);
  assert.match(markup, /aria-label="调整正文与详情宽度"/);
});
