import { KnowledgeClientError } from '@commerce/knowledge-client';
import type { LookupResult, Operation } from '@commerce/knowledge-contracts';

export type ReconciliationRead = {
  lookup: (action: string, key: string, purpose: string) => Promise<LookupResult>;
  operation: (id: string, purpose: string) => Promise<Operation>;
};
export type IntentPhase = 'sending' | 'unknown' | 'checking' | 'committed_needs_result';
export type IntentView = { scope: string; action: string; label: string; key: string; phase: IntentPhase; message: string };
type Intent<T> = IntentView & {
  input: T;
  purpose: string;
  operationId?: string;
  send: (input: T, key: string) => Promise<unknown>;
  complete: (result: unknown, operation?: Operation) => void;
  operationIsResult: boolean;
  verifiedCommitted: boolean;
  observe?: (reads: ReconciliationRead, input: T, purpose: string) => Promise<unknown | null>;
};

/** A scope owns at most one unresolved write. The lock is taken before the first await. */
export class WriteIntents {
  private readonly pending = new Map<string, Intent<unknown>>();
  constructor(private readonly changed: () => void, private readonly newKey: () => string = () => crypto.randomUUID()) {}

  view(scope: string): IntentView | null {
    const intent = this.pending.get(scope);
    return intent ? { scope, action: intent.action, label: intent.label, key: intent.key, phase: intent.phase, message: intent.message } : null;
  }

  start<T>(spec: { scope: string; purpose: string; action: string; label: string; input: T; send: (input: T, key: string) => Promise<unknown>; complete: (result: unknown, operation?: Operation) => void; operationIsResult?: boolean; observe?: (reads: ReconciliationRead, input: T, purpose: string) => Promise<unknown | null> }): boolean {
    if (this.pending.has(spec.scope)) return false;
    const intent: Intent<T> = { ...spec, input: structuredClone(spec.input), key: this.newKey(), phase: 'sending', message: '正在提交…', operationIsResult: !!spec.operationIsResult, verifiedCommitted: false };
    this.pending.set(spec.scope, intent as Intent<unknown>);
    this.changed();
    void this.send(intent as Intent<unknown>);
    return true;
  }

  private async send(intent: Intent<unknown>): Promise<void> {
    try {
      const result = await intent.send(intent.input, intent.key);
      this.pending.delete(intent.scope);
      this.changed();
      intent.complete(result);
    } catch (error) {
      if (error instanceof KnowledgeClientError && error.commitStatus === 'not_committed') {
        this.pending.delete(intent.scope);
        this.changed();
        intent.complete(error);
        return;
      }
      intent.operationId = error instanceof KnowledgeClientError ? error.operationId : undefined;
      intent.phase = 'unknown';
      intent.message = '提交结果未知。请先只读核对；查无记录也不能证明未提交。';
      this.changed();
    }
  }

  async reconcile(scope: string, reads: ReconciliationRead): Promise<void> {
    const intent = this.pending.get(scope);
    if (!intent || intent.phase === 'sending' || intent.phase === 'checking') return;
    intent.phase = 'checking'; intent.message = '正在按原操作键核对…'; this.changed();
    try {
      const lookup = intent.verifiedCommitted ? null : await reads.lookup(intent.action, intent.key, intent.purpose);
      if (lookup?.state === 'definitively_not_committed') {
        this.pending.delete(scope); this.changed();
        intent.complete(new Error('服务确认此意图未提交。请检查当前字段后重新提交；新提交会生成新操作键。'));
        return;
      }
      const id = lookup?.operation?.id ?? intent.operationId;
      if (lookup?.state !== 'committed' && !id) {
        const observed = await intent.observe?.(reads, intent.input, intent.purpose);
        if (observed) { this.pending.delete(scope); this.changed(); intent.complete(observed); return; }
        intent.phase = 'unknown'; intent.message = '核对仍为未知。保留原意图与操作键，暂不接受新写入。'; this.changed(); return;
      }
      if (!id) throw new Error('服务报告已提交，但未返回操作标识。');
      const operation = await reads.operation(id, intent.purpose);
      if (operation.commitStatus !== 'committed') throw new Error('操作详情尚未确认提交。');
      const alreadyVerified = intent.verifiedCommitted;
      intent.operationId = id;
      intent.verifiedCommitted = true;
      if (intent.operationIsResult) {
        this.pending.delete(scope); this.changed(); intent.complete(operation, operation); return;
      }
      intent.phase = 'committed_needs_result';
      intent.message = '已只读核实提交。可用原键和冻结参数取回同一结果。'; this.changed();
      if (!alreadyVerified) return;
      const result = await intent.send(intent.input, intent.key);
      this.pending.delete(scope); this.changed(); intent.complete(result, operation);
    } catch (error) {
      intent.phase = intent.verifiedCommitted ? 'committed_needs_result' : 'unknown';
      intent.message = intent.verifiedCommitted ? '已确认提交，但结果暂未取回。可再次核对并用原键取回。' : `核对未完成：${error instanceof Error ? error.message : String(error)}。保留原意图，暂不接受新写入。`;
      this.changed();
    }
  }
}
