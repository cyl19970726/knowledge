import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { KnowledgeClient } from '@commerce/knowledge-client';
import type { KnowledgeRef } from '@commerce/knowledge-contracts';
import { AskPanel, askGapLabel } from '../src/ask-panel.tsx';

const ref: KnowledgeRef = {
  projectId: 'project', spaceId: 'space', domain: 'knowledge',
  objectId: '00000000-0000-4000-8000-000000000002', versionId: '00000000-0000-4000-8000-000000000003',
  contentDigest: 'b'.repeat(64),
};
const client = { scope: { projectId: 'project', spaceId: 'space' } } as KnowledgeClient;
function html(selectionPermitted: boolean) {
  return renderToStaticMarkup(createElement(AskPanel, {
    client, purpose: 'reading', question: 'A 与 B 的条件何时冲突？', permitted: true,
    selected: [{ ref, title: '条件 A' }], selectionPermitted, recoveryScope: null,
    visible: true, syntheticFixture: false, onRead: () => {}, onSource: () => {}, onClose: () => {},
  }));
}

test('Ask describes the current graph choice as proposed, not yet read', () => {
  const markup = html(true);
  assert.match(markup, /问题星群/);
  assert.match(markup, /A 与 B 的条件何时冲突？/);
  assert.match(markup, /拟纳入 A\/B（尚未读取）/);
  assert.match(markup, /条件 A/);
  assert.match(markup, /实际能否读取，以服务返回的依据与排除项为准/);
});

test('legacy server explains question-only retrieval instead of promising graph selection', () => {
  const markup = html(false);
  assert.match(markup, /本次只按问题检索，联读选区尚未自动纳入/);
  assert.doesNotMatch(markup, /提交时固定这些准确版本/);
});

test('unknown exact-read byte usage stays a visible gap instead of a zero-byte claim', () => {
  const raw = 'An excluded exact Wiki read has unknown byte usage; further content reads were stopped';
  assert.match(askGapLabel(raw), /字节用量无法确认/);
  assert.match(askGapLabel(raw), /停止继续读取/);
  assert.equal(askGapLabel('caller-provided gap'), 'caller-provided gap');
});
