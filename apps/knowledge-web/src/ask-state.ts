import { AskRequestSchema, type AskRequest, type AskResult, type KnowledgeRef } from '@commerce/knowledge-contracts';
import { KnowledgeClientError, type KnowledgeClient } from '@commerce/knowledge-client';

export type AskPhase = 'idle' | 'sending' | 'checking' | 'unknown' | AskResult['state'];
export type AskView = { phase: AskPhase; key: string | null; input: AskRequest | null; result: AskResult | null; error: string };
type Entry = AskView & { revision: number };
export type AskSessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const RECORD_LIMIT = 8192;
const SESSION_PREFIX = 'knowledge:ask:v1:';
const empty = (): Entry => ({ phase: 'idle', key: null, input: null, result: null, error: '', revision: 0 });
const unresolved = (phase: AskPhase) => ['sending', 'checking', 'unknown', 'reserved', 'running', 'outcome_unknown'].includes(phase);
function browserStorage(): AskSessionStorage | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; }
  catch { return null; }
}
function blocked(message: string): Entry { return { ...empty(), phase: 'unknown', error: message }; }

/** USD is entered explicitly in cents precision; the deadline is frozen with the submitted input. */
export function makeAskRequest(question: string, purpose: string, moneyText: string, includeSourceContent: boolean,
  nowOrSelectedRefs: number | readonly KnowledgeRef[] = Date.now(), selectedAt = Date.now()): AskRequest {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(moneyText) || !Number.isFinite(Number(moneyText)))
    throw new Error('预算上限须为非负美元金额，最多两位小数。');
  const now = typeof nowOrSelectedRefs === 'number' ? nowOrSelectedRefs : selectedAt;
  const selectedRefs = typeof nowOrSelectedRefs === 'number' ? undefined : [...nowOrSelectedRefs];
  return AskRequestSchema.parse({ question: question.trim(), purpose, limit: 10, maxPages: 2, includeSourceContent,
    ...(selectedRefs?.length ? { selectedRefs } : {}),
    budget: { maxModelCalls: 1, maxReadBytes: 60000, deadline: new Date(now + 60000).toISOString(), maxMoney: { amount: Number(moneyText), currency: 'USD' } } });
}

export type AskSelectionComparison = { ref: KnowledgeRef; status: 'pending' | 'read' | 'excluded' | 'not_read'; reason: string | null };
function sameVersion(left: KnowledgeRef, right: KnowledgeRef): boolean {
  return left.projectId === right.projectId && left.spaceId === right.spaceId && left.domain === right.domain &&
    left.objectId === right.objectId && left.versionId === right.versionId;
}

/** Only an exact Wiki evidence receipt establishes a read. Exclusions may lack a digest because no body was fetched. */
export function compareAskSelection(input: AskRequest | null, result: AskResult | null): AskSelectionComparison[] {
  return (input?.selectedRefs ?? []).map(ref => {
    if (!result) return { ref, status: 'pending', reason: null };
    if (result.evidence.some(item => item.kind === 'wiki_page' && sameVersion(ref, item.ref) && ref.contentDigest === item.ref.contentDigest))
      return { ref, status: 'read', reason: null };
    const excluded = result.excluded.find(item => sameVersion(ref, item.ref) &&
      (item.ref.contentDigest === null || item.ref.contentDigest === ref.contentDigest));
    if (excluded) return { ref, status: 'excluded', reason: excluded.reason };
    return { ref, status: ['reserved', 'running', 'outcome_unknown'].includes(result.state) ? 'pending' : 'not_read', reason: null };
  });
}

/** Keeps one paid intent per authenticated scope. Session storage holds only its key and validated input. */
export class AskState {
  private readonly entries = new Map<string, Entry>();
  private binding: { scope: string; identity: string; recoveryScope: string | null; client: KnowledgeClient; permitted: boolean; revision: number } | null = null;
  private revision = 0;
  constructor(private readonly changed: () => void, private readonly newKey: () => string = () => crypto.randomUUID(),
    private readonly storage: AskSessionStorage | null = browserStorage()) {}

  private storageKey(scope: string, client: KnowledgeClient, recoveryScope: string): string | null {
    if (!/^[a-f0-9]{64}$/.test(recoveryScope)) return null;
    try {
      const parts: unknown = JSON.parse(scope);
      if (!Array.isArray(parts) || parts.length !== 3 || parts[0] !== client.scope.projectId || parts[1] !== client.scope.spaceId ||
        typeof parts[2] !== 'string' || !parts[2] || scope !== JSON.stringify(parts)) return null;
      return `${SESSION_PREFIX}${recoveryScope}:${scope}`;
    } catch { return null; }
  }

  private restore(scope: string, client: KnowledgeClient, recoveryScope: string): Entry {
    const storageKey = this.storageKey(scope, client, recoveryScope);
    if (!storageKey || !this.storage) return blocked('无法读取本会话的原操作记录；已阻止新的付费提交。');
    try {
      const raw = this.storage.getItem(storageKey);
      if (raw === null) return empty();
      if (raw.length > RECORD_LIMIT) throw new Error('record too large');
      const record: unknown = JSON.parse(raw);
      if (!record || typeof record !== 'object' || Array.isArray(record) ||
        Object.keys(record).sort().join(',') !== 'input,key,v') throw new Error('invalid record');
      const fields = record as Record<string, unknown>;
      if (fields.v !== 1 || typeof fields.key !== 'string' || fields.key.length < 1 || fields.key.length > 200) throw new Error('unsupported record');
      const parsed = AskRequestSchema.safeParse(fields.input);
      const purpose = JSON.parse(scope)[2] as string;
      if (!parsed.success || parsed.data.purpose !== purpose) throw new Error('invalid request');
      return { ...empty(), phase: 'unknown', key: fields.key, input: parsed.data, error: '已恢复原操作。仅用原键只读核对，暂不接受新提交。' };
    } catch { return blocked('会话中的原操作记录无法验证；已阻止新的付费提交，避免重复付费。'); }
  }

  private save(scope: string, client: KnowledgeClient, recoveryScope: string, key: string, input: AskRequest): boolean {
    const storageKey = this.storageKey(scope, client, recoveryScope);
    if (!storageKey || !this.storage || input.purpose !== JSON.parse(scope)[2]) return false;
    const value = JSON.stringify({ v: 1, key, input });
    if (value.length > RECORD_LIMIT) return false;
    try { this.storage.setItem(storageKey, value); return true; }
    catch { return false; }
  }

  private forget(scope: string, client: KnowledgeClient, recoveryScope: string, key: string): void {
    const storageKey = this.storageKey(scope, client, recoveryScope);
    if (!storageKey || !this.storage) return;
    try {
      const raw = this.storage.getItem(storageKey);
      if (raw && raw.length <= RECORD_LIMIT && (JSON.parse(raw) as { key?: unknown }).key === key) this.storage.removeItem(storageKey);
    } catch { /* An unreadable record stays conservative on the next load. */ }
  }

  bind(scope: string, client: KnowledgeClient, permitted: boolean, recoveryScope: string | null = null): void {
    const identity = JSON.stringify([scope, recoveryScope]);
    if (this.binding?.identity === identity && this.binding.client === client && this.binding.permitted === permitted) return;
    const entry = this.entries.get(identity) ?? (recoveryScope ? this.restore(scope, client, recoveryScope) : empty());
    // A connection change invalidates an in-flight response. Its key remains locked for a read-only check.
    if (entry.phase === 'sending' || entry.phase === 'checking') { entry.phase = 'unknown'; entry.error = '连接已切换，请用原操作键只读核对。'; }
    entry.result = null;
    entry.revision = ++this.revision;
    this.entries.set(identity, entry);
    this.binding = { scope, identity, recoveryScope, client, permitted, revision: entry.revision };
    this.changed();
  }

  view(scope: string, client: KnowledgeClient, recoveryScope: string | null = null): AskView {
    if (this.binding?.scope !== scope || this.binding.client !== client || this.binding.recoveryScope !== recoveryScope) return empty();
    const { phase, key, input, result, error } = this.entries.get(this.binding.identity) ?? empty();
    return { phase, key, input, result: this.binding.permitted ? result : null, error };
  }

  private current(scope: string, client: KnowledgeClient, revision: number): Entry | null {
    if (this.binding?.scope !== scope || this.binding.client !== client || this.binding.revision !== revision) return null;
    const entry = this.entries.get(this.binding.identity);
    return entry?.revision === revision ? entry : null;
  }

  start(scope: string, client: KnowledgeClient, input: AskRequest, recoveryScope: string | null = null): boolean {
    const binding = this.binding;
    const entry = binding ? this.entries.get(binding.identity) : null;
    if (!binding || binding.scope !== scope || binding.client !== client || binding.recoveryScope !== recoveryScope || !binding.permitted || !entry || unresolved(entry.phase)) return false;
    const parsed = AskRequestSchema.parse(input);
    const key = this.newKey();
    if (recoveryScope && !this.save(scope, client, recoveryScope, key, parsed)) {
      entry.error = '无法保存原操作记录。本次没有提交；请检查会话存储后重试。'; this.changed(); return false;
    }
    // Lock synchronously, before SDK work or any await.
    Object.assign(entry, { phase: 'sending', key, input: structuredClone(parsed), result: null, error: '' });
    this.changed();
    void Promise.resolve().then(() => client.ask(entry.input!, { idempotencyKey: key })).then(response => {
      const active = this.current(scope, client, binding.revision);
      if (!active || active.key !== key) return;
      this.receive(active, response.data);
    }).catch(error => {
      const active = this.current(scope, client, binding.revision);
      if (!active || active.key !== key) return;
      active.result = null;
      if (error instanceof KnowledgeClientError && error.commitStatus === 'not_committed') {
        if (recoveryScope) this.forget(scope, client, recoveryScope, key);
        active.phase = 'idle'; active.key = null; active.input = null;
        active.error = `未提交：${error.message}`;
      } else {
        active.phase = 'unknown'; active.error = '提交结果未知。原操作键已保留；请只读核对，不要再次提交。';
      }
      this.changed();
    });
    return true;
  }

  private receive(entry: Entry, result: AskResult): void {
    entry.result = result;
    entry.phase = result.state;
    entry.error = '';
    this.changed();
  }

  async check(scope: string, client: KnowledgeClient, recoveryScope: string | null = null): Promise<boolean> {
    const binding = this.binding;
    const entry = binding ? this.entries.get(binding.identity) : null;
    if (!binding || binding.scope !== scope || binding.client !== client || binding.recoveryScope !== recoveryScope || !binding.permitted || !entry?.key || !entry.input ||
      entry.phase === 'sending' || entry.phase === 'checking') return false;
    const answerId = entry.result?.id;
    // Hide the cached answer before checking its current authorization and readset validity.
    entry.result = null;
    entry.phase = 'checking'; entry.error = ''; this.changed();
    try {
      const result = answerId
        ? (await client.answer(answerId, entry.input.purpose)).data
        : await client.lookupAnswer(entry.key, entry.input.purpose).then(response => response.data.state === 'committed' ? response.data.answer : null);
      const active = this.current(scope, client, binding.revision);
      if (!active || active.key !== entry.key) return true;
      if (result) this.receive(active, result);
      else { active.phase = 'unknown'; active.result = null; active.error = '原操作键仍未查到确定结果，保持锁定。'; this.changed(); }
    } catch (error) {
      const active = this.current(scope, client, binding.revision);
      if (!active || active.key !== entry.key) return true;
      active.phase = 'unknown';
      active.error = error instanceof KnowledgeClientError && (error.httpStatus === 409 || error.httpStatus === 403 || error.httpStatus === 401)
        ? '依据已变化，或当前身份与用途不再允许读取。旧答案已隐藏；请先核对原操作。'
        : '暂时无法确认原操作的结果。旧答案已隐藏，请稍后只读核对。';
      active.result = null;
      this.changed();
    }
    return true;
  }
}
