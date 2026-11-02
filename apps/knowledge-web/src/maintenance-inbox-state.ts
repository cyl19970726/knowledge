import { KnowledgeClientError, type KnowledgeClient } from '@commerce/knowledge-client';
import type { CoordinationRun, Envelope, MaintenanceFinding, MaintenanceTask, RelationJudgment, SearchProjectionStatus, WikiCompileResult } from '@commerce/knowledge-contracts';

export type MaintenanceClient = Pick<KnowledgeClient, 'maintenanceTasks' | 'maintenanceFindings' | 'maintenanceTask' | 'cancelMaintenance' | 'searchProjectionStatus' | 'compilation' | 'judgment'> & {
  coordinationForTask?: (taskId: string, purpose: string, opts?: { signal?: AbortSignal }) => Promise<Envelope<CoordinationRun | null>>;
};
export type PendingCancel = { taskId: string; key: string; phase: 'sending' | 'unknown'; message: string };
export type MaintenanceSnapshot = {
  tasks: MaintenanceTask[]; findings: MaintenanceFinding[]; taskCursor: string | null; findingCursor: string | null;
  tasksMore: boolean; findingsMore: boolean; tasksLoading: boolean; findingsLoading: boolean;
  selectedId: string | null; selected: MaintenanceTask | null; detailLoading: boolean;
  compilation: WikiCompileResult | null; judgment: RelationJudgment | null; coordination: CoordinationRun | null;
  coordinationLoaded: boolean; relatedLoading: 'compilation' | 'judgment' | 'coordination' | null;
  projection: SearchProjectionStatus | null; projectionLoaded: boolean;
  error: string; detailError: string; denied: boolean; cancel: PendingCancel | null;
};

const empty = (): MaintenanceSnapshot => ({ tasks: [], findings: [], taskCursor: null, findingCursor: null,
  tasksMore: false, findingsMore: false, tasksLoading: false, findingsLoading: false,
  selectedId: null, selected: null, detailLoading: false, compilation: null, judgment: null, coordination: null,
  coordinationLoaded: false, relatedLoading: null,
  projection: null, projectionLoaded: false, error: '', detailError: '', denied: false, cancel: null });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const forbidden = (error: unknown) => error instanceof KnowledgeClientError && (error.httpStatus === 403 || error.code === 'FORBIDDEN');
const mergeById = <T extends { id: string }>(before: T[], after: T[]): T[] => {
  const ids = new Set(before.map(item => item.id));
  return [...before, ...after.filter(item => !ids.has(item.id))];
};

/** A scope-local read controller. Disposal and 403 revoke every displayed derived value. */
export class MaintenanceInboxState {
  private current = empty();
  private generation = 0;
  private disposed = false;
  private controllers = new Set<AbortController>();
  private detailController: AbortController | null = null;
  private relatedController: AbortController | null = null;
  constructor(private readonly client: MaintenanceClient, private readonly purpose: string,
    private readonly changed: (view: MaintenanceSnapshot) => void,
    private readonly keyFactory: () => string = () => crypto.randomUUID(),
    private readonly canReadCoordination = false) {}
  view(): MaintenanceSnapshot { return { ...this.current, tasks: [...this.current.tasks], findings: [...this.current.findings], cancel: this.current.cancel && { ...this.current.cancel } }; }
  private emit(patch: Partial<MaintenanceSnapshot>): void {
    if (this.disposed) return;
    this.current = { ...this.current, ...patch };
    this.changed(this.view());
  }
  private controller(): AbortController {
    const controller = new AbortController(); this.controllers.add(controller); return controller;
  }
  private active(generation: number, controller: AbortController): boolean {
    return !this.disposed && !this.current.denied && generation === this.generation && !controller.signal.aborted;
  }
  private failed(error: unknown, detail = false): void {
    if (forbidden(error)) {
      this.generation++;
      for (const controller of this.controllers) controller.abort();
      this.controllers.clear();
      this.current = { ...empty(), denied: true, error: '当前身份无权读取维护内容，请重新连接并核对授权。' };
      this.changed(this.view());
      return;
    }
    this.emit(detail ? { detailError: message(error) } : { error: message(error) });
  }
  start(readProjection: boolean): void {
    this.disposed = false; this.generation++;
    this.current = empty(); this.changed(this.view());
    void this.loadTasks(); void this.loadFindings();
    if (readProjection) void this.loadProjection();
  }
  dispose(): void {
    this.disposed = true; this.generation++;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear(); this.detailController = null; this.relatedController = null;
    this.current = empty();
  }
  async loadTasks(): Promise<void> {
    if (this.disposed || this.current.denied || this.current.tasksLoading || (this.current.tasks.length > 0 && !this.current.tasksMore)) return;
    const cursor = this.current.taskCursor;
    const controller = this.controller(), generation = this.generation;
    this.emit({ tasksLoading: true, error: '' });
    try {
      const response = await this.client.maintenanceTasks(this.purpose, { limit: 20, ...cursor ? { cursor } : {} }, { signal: controller.signal });
      if (!this.active(generation, controller)) return;
      this.emit({ tasks: mergeById(this.current.tasks, response.data.items), taskCursor: response.data.nextCursor,
        tasksMore: response.data.hasMore && !!response.data.nextCursor });
    } catch (error) { if (this.active(generation, controller)) this.failed(error); }
    finally { this.controllers.delete(controller); if (this.active(generation, controller)) this.emit({ tasksLoading: false }); }
  }
  async loadFindings(): Promise<void> {
    if (this.disposed || this.current.denied || this.current.findingsLoading || (this.current.findings.length > 0 && !this.current.findingsMore)) return;
    const cursor = this.current.findingCursor;
    const controller = this.controller(), generation = this.generation;
    this.emit({ findingsLoading: true, error: '' });
    try {
      const response = await this.client.maintenanceFindings(this.purpose, { limit: 20, ...cursor ? { cursor } : {} }, { signal: controller.signal });
      if (!this.active(generation, controller)) return;
      this.emit({ findings: mergeById(this.current.findings, response.data.items), findingCursor: response.data.nextCursor,
        findingsMore: response.data.hasMore && !!response.data.nextCursor });
    } catch (error) { if (this.active(generation, controller)) this.failed(error); }
    finally { this.controllers.delete(controller); if (this.active(generation, controller)) this.emit({ findingsLoading: false }); }
  }
  async loadProjection(): Promise<void> {
    if (this.disposed || this.current.denied) return;
    const controller = this.controller(), generation = this.generation;
    try { const response = await this.client.searchProjectionStatus(this.purpose, { signal: controller.signal });
      if (this.active(generation, controller)) this.emit({ projection: response.data, projectionLoaded: true });
    } catch (error) { if (this.active(generation, controller)) this.failed(error); }
    finally { this.controllers.delete(controller); }
  }
  select(id: string): void {
    if (this.disposed || this.current.denied || !this.current.tasks.some(item => item.id === id)) return;
    this.detailController?.abort(); this.relatedController?.abort();
    this.emit({ selectedId: id, selected: null, compilation: null, judgment: null, coordination: null,
      coordinationLoaded: false, relatedLoading: null, detailError: '' });
    void this.refreshTask();
  }
  async refreshTask(): Promise<void> {
    const id = this.current.selectedId;
    if (!id || this.disposed || this.current.denied) return;
    this.detailController?.abort(); this.relatedController?.abort();
    const controller = this.controller(), generation = this.generation;
    this.detailController = controller;
    this.emit({ detailLoading: true, detailError: '', compilation: null, judgment: null, coordination: null,
      coordinationLoaded: false, relatedLoading: null });
    try { const response = await this.client.maintenanceTask(id, this.purpose, { signal: controller.signal });
      if (!this.active(generation, controller) || this.current.selectedId !== id || this.detailController !== controller) return;
      this.emit({ selected: response.data, tasks: this.current.tasks.map(item => item.id === id ? response.data : item) });
      if (this.current.cancel?.taskId === id && (response.data.cancelRequested || response.data.state === 'cancelled')) this.emit({ cancel: null });
    } catch (error) { if (this.active(generation, controller) && this.current.selectedId === id) this.failed(error, true); }
    finally { this.controllers.delete(controller); if (this.active(generation, controller) && this.detailController === controller) this.emit({ detailLoading: false }); }
  }
  async loadRelated(kind: 'compilation' | 'judgment'): Promise<void> {
    const task = this.current.selected;
    const id = kind === 'compilation' ? task?.outcome?.compilationId ?? this.current.coordination?.compilationId
      : task?.outcome?.judgmentId ?? this.current.coordination?.judgmentIds[0];
    if (!task || !id || this.disposed || this.current.denied) return;
    this.relatedController?.abort();
    const controller = this.controller(), generation = this.generation;
    this.relatedController = controller;
    this.emit({ relatedLoading: kind, detailError: '', [kind]: null });
    try {
      const response = kind === 'compilation' ? await this.client.compilation(id, this.purpose, { signal: controller.signal })
        : await this.client.judgment(id, this.purpose, { signal: controller.signal });
      if (!this.active(generation, controller) || this.current.selected?.id !== task.id || this.relatedController !== controller) return;
      if (kind === 'compilation') this.emit({ compilation: response.data as WikiCompileResult });
      else this.emit({ judgment: response.data as RelationJudgment });
    } catch (error) { if (this.active(generation, controller) && this.current.selected?.id === task.id) this.failed(error, true); }
    finally { this.controllers.delete(controller); if (this.active(generation, controller) && this.relatedController === controller) this.emit({ relatedLoading: null }); }
  }
  async loadCoordination(): Promise<void> {
    const taskId = this.current.selected?.id;
    if (!taskId || !this.canReadCoordination || this.disposed || this.current.denied) return;
    if (!this.client.coordinationForTask) { this.emit({ detailError: '当前客户端版本暂不支持读取协调记录。' }); return; }
    this.relatedController?.abort();
    const controller = this.controller(), generation = this.generation;
    this.relatedController = controller;
    this.emit({ relatedLoading: 'coordination', detailError: '', coordination: null, coordinationLoaded: false });
    try {
      const response = await this.client.coordinationForTask(taskId, this.purpose, { signal: controller.signal });
      if (!this.active(generation, controller) || this.current.selected?.id !== taskId || this.relatedController !== controller) return;
      if (response.data && (response.data.request.taskId !== taskId || response.data.request.purpose !== this.purpose)) {
        this.emit({ detailError: '协调记录与当前任务或用途不一致，已拒绝展示。' }); return;
      }
      this.emit({ coordination: response.data, coordinationLoaded: true });
    } catch (error) { if (this.active(generation, controller) && this.current.selected?.id === taskId) this.failed(error, true); }
    finally { this.controllers.delete(controller); if (this.active(generation, controller) && this.relatedController === controller) this.emit({ relatedLoading: null }); }
  }
  async cancel(): Promise<void> {
    const task = this.current.selected;
    if (!task || !['queued', 'running'].includes(task.state) || task.cancelRequested || this.current.cancel || this.disposed || this.current.denied) return;
    const key = this.keyFactory(), controller = this.controller(), generation = this.generation;
    this.emit({ cancel: { taskId: task.id, key, phase: 'sending', message: '正在提交取消请求…' } });
    try {
      const response = await this.client.cancelMaintenance(task.id, this.purpose, { idempotencyKey: key, signal: controller.signal });
      if (!this.active(generation, controller)) return;
      this.emit({ cancel: null, selected: this.current.selectedId === task.id ? response.data : this.current.selected,
        tasks: this.current.tasks.map(item => item.id === task.id ? response.data : item) });
    } catch (error) {
      if (!this.active(generation, controller)) return;
      if (forbidden(error)) this.failed(error, true);
      else this.emit({ cancel: { taskId: task.id, key, phase: 'unknown', message: `${message(error)}。提交结果未知；仅可只读核对原任务，不会重发取消。` } });
    } finally { this.controllers.delete(controller); }
  }
  async reconcileCancel(): Promise<void> {
    const pending = this.current.cancel;
    if (!pending || pending.phase !== 'unknown' || this.disposed || this.current.denied) return;
    const controller = this.controller(), generation = this.generation;
    try { const response = await this.client.maintenanceTask(pending.taskId, this.purpose, { signal: controller.signal });
      if (!this.active(generation, controller) || this.current.cancel?.key !== pending.key) return;
      this.emit({ selected: this.current.selectedId === pending.taskId ? response.data : this.current.selected,
        tasks: this.current.tasks.map(item => item.id === pending.taskId ? response.data : item),
        cancel: response.data.cancelRequested || response.data.state === 'cancelled' ? null : pending });
    } catch (error) { if (this.active(generation, controller)) this.failed(error, true); }
    finally { this.controllers.delete(controller); }
  }
}
