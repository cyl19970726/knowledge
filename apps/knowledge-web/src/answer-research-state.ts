import { AnswerResearchRequestSchema, AnswerSeedSchema, type AnswerResearchRequest, type Envelope, type WikiCompileResult } from '@commerce/knowledge-contracts';
import { KnowledgeClientError, type KnowledgeClient, type WriteOptions } from '@commerce/knowledge-client';

type ResearchClient = KnowledgeClient & {
  researchAnswer?: (answerId: string, data: AnswerResearchRequest, opts: WriteOptions) => Promise<Envelope<WikiCompileResult>>;
};
export type AnswerResearchPhase = 'idle' | 'sending' | 'checking' | 'unknown' | WikiCompileResult['state'];
type FrozenIntent = { answerId: string; input: AnswerResearchRequest };
export type AnswerResearchView = { phase: AnswerResearchPhase; key: string | null; intent: FrozenIntent | null; result: WikiCompileResult | null; error: string; blocked: boolean };
export function actualCandidateId(view: AnswerResearchView): string | null { return view.result?.candidate?.candidateId ?? null; }
export function isKnownResearchResult(result: WikiCompileResult | null): boolean {
  return !!result && !['reserved', 'running', 'outcome_unknown'].includes(result.state);
}
type Entry = AnswerResearchView & { revision: number };
export type AnswerResearchStorage = Pick<Storage, 'getItem' | 'setItem'>;
const PREFIX = 'knowledge:answer-research:v1:';
const RECORD_LIMIT = 8192;
const empty = (): Entry => ({ phase: 'idle', key: null, intent: null, result: null, error: '', blocked: false, revision: 0 });
const locked = (phase: AnswerResearchPhase) => ['sending', 'checking', 'unknown', 'reserved', 'running', 'outcome_unknown'].includes(phase);
function browserStorage(): AnswerResearchStorage | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; } catch { return null; }
}
function deny(message: string): Entry { return { ...empty(), blocked: true, error: message }; }

/** Only caller input and the original key enter session storage. No answer, evidence, token, or source body is stored. */
export function makeAnswerResearchIntent(answerId: string, fingerprint: string, claimIndexes: readonly number[], question: string,
  moneyText: string, purpose: string, now = Date.now()): FrozenIntent {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(moneyText) || !Number.isFinite(Number(moneyText)))
    throw new Error('研究预算须为非负美元金额，最多两位小数。');
  const seed = AnswerSeedSchema.parse({ answerId, expectedAnswerFingerprint: fingerprint, claimIndexes: [...claimIndexes] });
  const input = AnswerResearchRequestSchema.parse({ purpose, expectedAnswerFingerprint: seed.expectedAnswerFingerprint, claimIndexes: seed.claimIndexes,
    question: question.trim(), limit: 100, maxPages: 1,
    budget: { maxModelCalls: 1, maxReadBytes: 500000, deadline: new Date(now + 120000).toISOString(),
      maxMoney: { amount: Number(moneyText), currency: 'USD' } } });
  return { answerId: seed.answerId, input };
}

/** One latest research intent per authenticated scope; only GET may reconcile an uncertain POST. */
export class AnswerResearchState {
  private binding: { scope: string; identity: string; recoveryScope: string | null; client: ResearchClient; submitAllowed: boolean; canRead: boolean; revision: number } | null = null;
  private readonly entries = new Map<string, Entry>();
  private revision = 0;
  constructor(private readonly changed: () => void, private readonly newKey: () => string = () => crypto.randomUUID(),
    private readonly storage: AnswerResearchStorage | null = browserStorage()) {}

  private storageKey(scope: string, client: ResearchClient, recoveryScope: string): string | null {
    if (!/^[a-f0-9]{64}$/.test(recoveryScope)) return null;
    try {
      const parts: unknown = JSON.parse(scope);
      if (!Array.isArray(parts) || parts.length !== 3 || parts[0] !== client.scope.projectId || parts[1] !== client.scope.spaceId ||
        typeof parts[2] !== 'string' || !parts[2] || scope !== JSON.stringify(parts)) return null;
      return `${PREFIX}${recoveryScope}:${scope}`;
    } catch { return null; }
  }

  private restore(scope: string, client: ResearchClient, recoveryScope: string): Entry {
    const key = this.storageKey(scope, client, recoveryScope);
    if (!key || !this.storage) return deny('会话恢复范围不可用，已阻止新的研究提交。');
    try {
      const raw = this.storage.getItem(key);
      if (raw === null) return empty();
      if (raw.length > RECORD_LIMIT) throw new Error('record too large');
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'answerId,input,key,v') throw new Error('invalid record');
      const record = value as Record<string, unknown>;
      const input = AnswerResearchRequestSchema.safeParse(record.input);
      const seed = input.success ? AnswerSeedSchema.safeParse({ answerId: record.answerId,
        expectedAnswerFingerprint: input.data.expectedAnswerFingerprint, claimIndexes: input.data.claimIndexes }) : null;
      if (record.v !== 1 || typeof record.key !== 'string' || record.key.length < 1 || record.key.length > 200 || !seed?.success || !input.success ||
        input.data.purpose !== (JSON.parse(scope) as string[])[2]) throw new Error('invalid intent');
      return { ...empty(), key: record.key, intent: { answerId: seed.data.answerId, input: input.data }, phase: 'unknown',
        error: '已恢复原研究操作；仅用原键只读核对。' };
    } catch { return deny('原研究操作记录无法验证，已阻止新提交以免重复付费。'); }
  }

  private save(scope: string, client: ResearchClient, recoveryScope: string, key: string, intent: FrozenIntent): boolean {
    const storageKey = this.storageKey(scope, client, recoveryScope);
    if (!storageKey || !this.storage || intent.input.purpose !== (JSON.parse(scope) as string[])[2]) return false;
    const value = JSON.stringify({ v: 1, key, answerId: intent.answerId, input: intent.input });
    if (value.length > RECORD_LIMIT) return false;
    try { this.storage.setItem(storageKey, value); return true; } catch { return false; }
  }

  bind(scope: string, client: ResearchClient, submitAllowed: boolean, recoveryScope: string | null, canRead: boolean): void {
    const identity = JSON.stringify([scope, recoveryScope]);
    if (this.binding?.identity === identity && this.binding.client === client &&
      this.binding.submitAllowed === submitAllowed && this.binding.canRead === canRead) return;
    const entry = this.entries.get(identity) ?? (recoveryScope ? this.restore(scope, client, recoveryScope) : deny('会话恢复范围不可用，已阻止新的研究提交。'));
    if (entry.key) {
      entry.phase = 'unknown';
      entry.error = canRead ? '连接或权限已变化，请只读核对原操作。' : '当前身份未开放编纂读取；旧结果已隐藏，原键保留。';
    }
    entry.result = null;
    entry.revision = ++this.revision;
    this.entries.set(identity, entry);
    this.binding = { scope, identity, recoveryScope, client, submitAllowed, canRead, revision: entry.revision };
    this.changed();
  }

  view(scope: string, client: ResearchClient, recoveryScope: string | null): AnswerResearchView {
    if (this.binding?.scope !== scope || this.binding.client !== client || this.binding.recoveryScope !== recoveryScope) return empty();
    const { phase, key, intent, result, error, blocked } = this.entries.get(this.binding.identity) ?? empty();
    return { phase, key, intent, result: this.binding.canRead ? result : null, error, blocked };
  }

  private current(scope: string, client: ResearchClient, revision: number): Entry | null {
    if (this.binding?.scope !== scope || this.binding.client !== client || this.binding.revision !== revision) return null;
    const entry = this.entries.get(this.binding.identity);
    return entry?.revision === revision ? entry : null;
  }

  start(scope: string, client: ResearchClient, intent: FrozenIntent, recoveryScope: string | null): boolean {
    const binding = this.binding;
    const entry = binding ? this.entries.get(binding.identity) : null;
    if (!binding || binding.scope !== scope || binding.client !== client || binding.recoveryScope !== recoveryScope ||
      !binding.submitAllowed || !binding.canRead || !client.researchAnswer || !entry || entry.blocked || locked(entry.phase) || !recoveryScope) return false;
    const parsed = AnswerResearchRequestSchema.parse(intent.input);
    const seed = AnswerSeedSchema.parse({ answerId: intent.answerId, expectedAnswerFingerprint: parsed.expectedAnswerFingerprint,
      claimIndexes: parsed.claimIndexes });
    const frozen: FrozenIntent = { answerId: seed.answerId, input: structuredClone(parsed) };
    const key = this.newKey();
    if (!this.save(scope, client, recoveryScope, key, frozen)) {
      entry.error = '原操作键无法保存；本次没有提交。'; this.changed(); return false;
    }
    Object.assign(entry, { phase: 'sending', key, intent: frozen, result: null, error: '', blocked: false });
    this.changed();
    void Promise.resolve().then(() => client.researchAnswer!(frozen.answerId, frozen.input, { idempotencyKey: key })).then(response => {
      const active = this.current(scope, client, binding.revision);
      if (active?.key !== key) return;
      if (this.binding?.canRead) this.receive(active, response.data);
      else { active.result = null; active.phase = 'unknown'; active.error = '当前身份未开放编纂读取；原键保留，结果已隐藏。'; this.changed(); }
    }).catch(error => {
      const active = this.current(scope, client, binding.revision);
      if (!active || active.key !== key) return;
      active.result = null;
      active.phase = 'unknown';
      active.blocked = error instanceof KnowledgeClientError && [401, 403, 409].includes(error.httpStatus ?? 0);
      active.error = active.blocked ? '原回答或依据已失效，或当前身份无权读取；研究结果已隐藏，原键保留。' : '提交结果尚未核对；原键保留，仅可只读核对。';
      this.changed();
    });
    return true;
  }

  private receive(entry: Entry, result: WikiCompileResult): void {
    const origin = result.answerOrigin;
    const intent = entry.intent;
    if (!intent || !origin || result.purpose !== intent.input.purpose || result.question !== intent.input.question ||
      origin.answerId !== intent.answerId || origin.answerFingerprint !== intent.input.expectedAnswerFingerprint ||
      JSON.stringify(origin.claimIndexes) !== JSON.stringify(intent.input.claimIndexes)) {
      entry.result = null; entry.phase = 'unknown'; entry.blocked = true;
      entry.error = '编纂回执与原研究输入不一致；已隐藏结果并锁定原键。'; this.changed(); return;
    }
    entry.result = result; entry.phase = result.state; entry.error = ''; this.changed();
  }

  async check(scope: string, client: ResearchClient, recoveryScope: string | null): Promise<boolean> {
    const binding = this.binding;
    const entry = binding ? this.entries.get(binding.identity) : null;
    if (!binding || binding.scope !== scope || binding.client !== client || binding.recoveryScope !== recoveryScope || !binding.canRead ||
      !entry?.key || !entry.intent || entry.phase === 'sending' || entry.phase === 'checking') return false;
    const key = entry.key;
    const compilationId = entry.result?.id;
    entry.result = null; entry.phase = 'checking'; entry.error = ''; this.changed();
    try {
      const result = compilationId ? (await client.compilation(compilationId, entry.intent.input.purpose)).data :
        await client.compilationLookup(key, entry.intent.input.purpose).then(response => response.data.state === 'known' ? response.data.compilation : null);
      const active = this.current(scope, client, binding.revision);
      if (!active || active.key !== key) return true;
      if (result) this.receive(active, result);
      else { active.phase = 'unknown'; active.error = '原键尚无确定回执，请稍后只读核对。'; this.changed(); }
    } catch (error) {
      const active = this.current(scope, client, binding.revision);
      if (!active || active.key !== key) return true;
      active.result = null; active.phase = 'unknown';
      active.blocked = error instanceof KnowledgeClientError && [401, 403, 409].includes(error.httpStatus ?? 0);
      active.error = active.blocked ? '资料已撤权或版本已变化，当前不能读取研究回执；原键保留。' : '暂时无法核对研究结果；原键保留。';
      this.changed();
    }
    return true;
  }
}
