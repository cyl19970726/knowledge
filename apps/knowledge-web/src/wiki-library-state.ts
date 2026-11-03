import { KnowledgeClientError, type KnowledgeClient } from '@commerce/knowledge-client';
import type { Coverage, KnowledgeDocument, KnowledgeRef } from '@commerce/knowledge-contracts';
import { sameExactRef } from './ask-graph';

export type WikiLibraryClient = Pick<KnowledgeClient, 'scope' | 'catalog' | 'document'>;
export type WikiLibraryItem = Pick<KnowledgeDocument, 'ref' | 'title' | 'profile' | 'status'>;
export type WikiLibraryView = {
  draft: string; query: string; items: WikiLibraryItem[]; loaded: boolean; loading: boolean;
  coverage: Coverage | null; nextCursor: string | null; hasMore: boolean; error: string; denied: boolean;
  selectedRef: KnowledgeRef | null; document: KnowledgeDocument | null; documentLoading: boolean;
  documentError: string; documentReceiptId: string | null; listPosition: number; documentPosition: number;
  listWindowPosition: number; documentWindowPosition: number;
};
const empty = (): WikiLibraryView => ({ draft: '', query: '', items: [], loaded: false, loading: false,
  coverage: null, nextCursor: null, hasMore: false, error: '', denied: false, selectedRef: null,
  document: null, documentLoading: false, documentError: '', documentReceiptId: null, listPosition: 0, documentPosition: 0,
  listWindowPosition: 0, documentWindowPosition: 0 });
class MismatchedWikiResponse extends Error {}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const catalogKey = (ref: KnowledgeRef) => JSON.stringify([ref.projectId, ref.spaceId, ref.domain, ref.objectId, ref.versionId, ref.contentDigest]);

/** The catalog retains metadata only. A document is populated exclusively by an exact document GET. */
export class WikiLibraryState {
  private current = empty();
  private generation = 0;
  private disposed = false;
  private listController: AbortController | null = null;
  private documentController: AbortController | null = null;
  private readonly scope: { projectId: string; spaceId: string };
  constructor(private readonly client: WikiLibraryClient, private readonly purpose: string,
    private readonly permitted: boolean, private readonly changed: () => void) {
    this.scope = { ...client.scope };
  }
  view(): WikiLibraryView { return { ...this.current, items: [...this.current.items] }; }
  activate(): void { this.disposed = false; }
  private emit(update: Partial<WikiLibraryView>): void { this.current = { ...this.current, ...update }; this.changed(); }
  private active(generation: number, controller: AbortController): boolean {
    return !this.disposed && this.permitted && !this.current.denied && generation === this.generation && !controller.signal.aborted;
  }
  private inScope(ref: KnowledgeRef): boolean {
    return ref.projectId === this.scope.projectId && ref.spaceId === this.scope.spaceId && ref.domain === 'knowledge';
  }
  private sameScope(scope: { projectId: string; spaceId: string }): boolean {
    return scope.projectId === this.scope.projectId && scope.spaceId === this.scope.spaceId;
  }
  private abortReads(): void { this.listController?.abort(); this.documentController?.abort(); }
  dispose(): void { this.disposed = true; this.generation++; this.abortReads(); this.current = empty(); }
  setDraft(draft: string): void { if (!this.disposed) this.emit({ draft }); }
  rememberPosition(position: number): void {
    if (this.disposed || !Number.isFinite(position)) return;
    if (this.current.selectedRef) this.current.documentPosition = Math.max(0, position);
    else this.current.listPosition = Math.max(0, position);
  }
  rememberWindowPosition(position: number): void {
    if (this.disposed || !Number.isFinite(position)) return;
    if (this.current.selectedRef) this.current.documentWindowPosition = Math.max(0, position);
    else this.current.listWindowPosition = Math.max(0, position);
  }
  async ensureLoaded(): Promise<void> {
    if (!this.current.loaded && !this.current.loading && !this.current.error) await this.loadPage(false);
  }
  async search(raw = this.current.draft): Promise<void> {
    if (this.disposed || !this.permitted || this.current.denied) return;
    const query = raw.trim();
    if (query.length > 2000) { this.emit({ error: '搜索词最多 2000 字。' }); return; }
    this.generation++; this.abortReads();
    this.current = { ...empty(), draft: raw, query }; this.changed();
    await this.loadPage(false);
  }
  async loadMore(): Promise<void> {
    if (!this.current.hasMore || !this.current.nextCursor) return;
    await this.loadPage(true);
  }
  private failed(error: unknown, documentRead = false): void {
    if (error instanceof KnowledgeClientError && [401, 403].includes(error.httpStatus ?? 0)) {
      this.generation++; this.abortReads();
      this.current = { ...empty(), denied: true, error: '当前身份或用途无法继续读取，目录与正文已清空。请重新连接后核对权限。' };
      this.changed(); return;
    }
    if (error instanceof MismatchedWikiResponse || (!documentRead && error instanceof KnowledgeClientError && error.httpStatus === 409)) {
      this.generation++; this.abortReads();
      this.emit({ items: [], selectedRef: null, document: null, documentReceiptId: null, documentLoading: false,
        loading: false, loaded: false, coverage: null, hasMore: false, nextCursor: null, listPosition: 0, documentPosition: 0,
        listWindowPosition: 0, documentWindowPosition: 0,
        error: error instanceof MismatchedWikiResponse ? message(error) : '目录已变化，本次分页已清空。请重新加载当前搜索。' });
      return;
    }
    this.emit(documentRead ? { document: null, documentReceiptId: null, documentError: message(error) }
      : { error: message(error) });
  }
  private async loadPage(more: boolean): Promise<void> {
    if (this.disposed || !this.permitted || this.current.denied || this.current.loading) return;
    const controller = new AbortController(), generation = this.generation;
    this.listController?.abort(); this.listController = controller;
    const cursor = more ? this.current.nextCursor ?? undefined : undefined;
    const request = { purpose: this.purpose, limit: 24, kinds: ['wiki_page'] as ['wiki_page'],
      query: this.current.query || undefined, cursor };
    this.emit({ loading: true, error: '' });
    try {
      const response = await this.client.catalog(request, { signal: controller.signal });
      if (!this.active(generation, controller)) return;
      if (!this.sameScope(response.effectiveScope) || response.data.items.some(item => !this.inScope(item.ref) ||
        !item.status.current || item.status.purpose.requested !== this.purpose))
        throw new MismatchedWikiResponse('目录回执与当前空间、用途或当前版本不一致，已拒绝展示。');
      const coverage = response.coverage ?? null;
      if (coverage?.hasMore && (!coverage.nextCursor || coverage.nextCursor === cursor))
        throw new MismatchedWikiResponse('服务未返回可继续的分页位置，请重新加载目录。');
      const incoming = response.data.items.map(({ ref, title, profile, status }) => ({ ref, title, profile, status }));
      const items = more ? [...this.current.items] : [];
      const keys = new Set(items.map(item => catalogKey(item.ref)));
      for (const item of incoming) if (!keys.has(catalogKey(item.ref))) { items.push(item); keys.add(catalogKey(item.ref)); }
      this.emit({ items, loaded: true, coverage, nextCursor: coverage?.nextCursor ?? null, hasMore: coverage?.hasMore ?? false });
    } catch (error) { if (this.active(generation, controller)) this.failed(error); }
    finally { if (this.active(generation, controller)) this.emit({ loading: false }); }
  }
  async open(ref: KnowledgeRef): Promise<void> {
    if (this.disposed || !this.permitted || this.current.denied) return;
    this.documentController?.abort();
    if (!this.inScope(ref) || !ref.contentDigest || !this.current.items.some(item => sameExactRef(item.ref, ref))) {
      this.emit({ selectedRef: { ...ref }, document: null, documentLoading: false, documentReceiptId: null,
        documentError: '该准确版本不在当前已加载目录中，请返回列表重新选择。' }); return;
    }
    const controller = new AbortController(), generation = this.generation, requested = { ...ref };
    this.documentController = controller;
    this.emit({ selectedRef: requested, document: null, documentReceiptId: null, documentLoading: true, documentError: '', documentPosition: 0, documentWindowPosition: 0 });
    try {
      const response = await this.client.document(requested, this.purpose, { signal: controller.signal });
      if (!this.active(generation, controller) || this.documentController !== controller) return;
      if (!this.sameScope(response.effectiveScope) || !sameExactRef(requested, response.data.ref) || response.data.status.purpose.requested !== this.purpose)
        throw new MismatchedWikiResponse('正文回执与所选准确版本、用途或空间不一致，已拒绝展示。');
      this.emit({ document: response.data, documentReceiptId: response.readReceiptId ?? null });
    } catch (error) { if (this.active(generation, controller) && this.documentController === controller) this.failed(error, true); }
    finally { if (this.active(generation, controller) && this.documentController === controller) this.emit({ documentLoading: false }); }
  }
  backToList(): void {
    this.documentController?.abort();
    this.emit({ selectedRef: null, document: null, documentLoading: false, documentError: '', documentReceiptId: null, documentPosition: 0, documentWindowPosition: 0 });
  }
}
