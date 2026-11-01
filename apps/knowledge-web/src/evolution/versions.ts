import type { HistoryResult, KnowledgeRef } from '@commerce/knowledge-contracts';
import { refKey } from '../graph/view-model';

export function versionDateParts(value: string | null | undefined): { date: string; time: string | null; zone: string | null } {
  if (!value) return { date: '发表时间未记录', time: null, zone: null };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { date: '发表时间无效', time: null, zone: null };
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? '';
  return { date: `${part('year')}/${part('month')}/${part('day')}`, time: `${part('hour')}:${part('minute')}`, zone: '台北' };
}

/** Display a publication instant with an explicit zone, independent of the reader's device zone. */
export function versionDate(value: string | null | undefined): string {
  const parts = versionDateParts(value);
  return parts.time && parts.zone ? `${parts.date} ${parts.time}（${parts.zone}）` : parts.date;
}

/** Only exact references returned by published history may enter compare. */
export function publishedPair(versions: HistoryResult['versions'], before: string, after: string): { before: KnowledgeRef; after: KnowledgeRef } | null {
  if (!before || !after || before === after) return null;
  const first = versions.find(version => refKey(version.ref) === before);
  const second = versions.find(version => refKey(version.ref) === after);
  return first && second ? { before: first.ref, after: second.ref } : null;
}
