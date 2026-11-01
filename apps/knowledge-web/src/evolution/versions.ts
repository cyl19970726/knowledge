import type { HistoryResult, KnowledgeRef } from '@commerce/knowledge-contracts';
import { refKey } from '../graph/view-model';

/** Display a publication instant with an explicit zone, independent of the reader's device zone. */
export function versionDate(value: string | null | undefined): string {
  if (!value) return '发表时间未记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '发表时间无效';
  return `${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)}（台北）`;
}

/** Only exact references returned by published history may enter compare. */
export function publishedPair(versions: HistoryResult['versions'], before: string, after: string): { before: KnowledgeRef; after: KnowledgeRef } | null {
  if (!before || !after || before === after) return null;
  const first = versions.find(version => refKey(version.ref) === before);
  const second = versions.find(version => refKey(version.ref) === after);
  return first && second ? { before: first.ref, after: second.ref } : null;
}
