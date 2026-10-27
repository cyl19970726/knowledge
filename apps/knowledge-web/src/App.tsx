import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, ChevronDown, ChevronRight, CircleHelp, Clock3, Compass, FileText, History, Layers3, Link2, Maximize2, Search, Settings2, Sparkles, X } from 'lucide-react';
import { createKnowledgeClient, KnowledgeClientError, type KnowledgeClient } from '@commerce/knowledge-client';
import type { CandidateView, ChangeItem, Coverage, GraphResult, KnowledgeDocument, KnowledgeRef, Relation, ResearchResult, SourceRecord } from '@commerce/knowledge-contracts';
import { GraphCanvas, type GraphCamera } from './graph/GraphCanvas';
import { refKey, selectedRelations, toGraphView, type GraphMode } from './graph/view-model';
import { WriteIntents } from './write-intents';
import { SourceReads } from './source-reads';
import { CitationList, SourceContentView, sourceKindName, sourceAssertionName, sourceAssuranceName, sourceReasonName, sourceLimitation } from './source-view';

type Page = 'explore' | 'read' | 'sources' | 'changes' | 'research';
type Config = { projectId: string; spaceId: string; token: string; purpose: string };
type HistoryData = Awaited<ReturnType<KnowledgeClient['history']>>['data'];
type Comparison = Awaited<ReturnType<KnowledgeClient['compare']>>['data'];
type ReadReceipt = Awaited<ReturnType<KnowledgeClient['receipt']>>['data'];
type Capabilities = Awaited<ReturnType<KnowledgeClient['capabilities']>>['data'];
type SourceContent = Awaited<ReturnType<KnowledgeClient['sourceContent']>>['data'];
type Operation = Awaited<ReturnType<KnowledgeClient['research']>>['data'];
type ReviewTicket = Awaited<ReturnType<KnowledgeClient['requestReview']>>['data'];
type FeedbackRecord = Awaited<ReturnType<KnowledgeClient['recordFeedback']>>['data'];
type EmptyState = 'not_loaded' | 'unclassified' | 'content_version_unsupported' | 'source_unreadable' | 'no_matches_in_scope' | 'restricted_for_purpose' | 'partial_result' | null;

const EMPTY: Record<Exclude<EmptyState, null>, string> = {
  not_loaded: '这一范围尚未加载。', unclassified: '尚未归类到可显示的知识。', content_version_unsupported: '此内容版本暂不受支持。',
  source_unreadable: '来源内容当前不可读取，可先检查元数据和引用。', no_matches_in_scope: '在当前空间与用途下没有匹配结果。',
  restricted_for_purpose: '当前用途没有读取权限。', partial_result: '结果不完整，请留意范围说明。',
};
const environment = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};
const DEFAULT_CONFIG: Config = {
  projectId: environment.VITE_KNOWLEDGE_PROJECT_ID ?? '',
  spaceId: environment.VITE_KNOWLEDGE_SPACE_ID ?? '',
  token: '', purpose: environment.VITE_KNOWLEDGE_PURPOSE ?? '',
};
const unknownCost = { modelCalls: { state: 'unknown' as const, reason: '此界面未测量' }, tokens: { state: 'unknown' as const, reason: '此界面未测量' }, money: { state: 'unknown' as const, reason: '此界面未测量' } };
const outcomeName: Record<string, string> = { candidate: '形成候选认识', no_change: '有依据地保持不变', needs_evidence: '仍需补证' };
const stanceName: Record<Relation['stance'], string> = { supports: '支持', challenges: '挑战', context: '联读背景', navigation: '导航关联' };
const statusName: Record<string, string> = { queued: '排队中', running: '研究中', waiting_for_source: '等待来源', waiting_for_review: '等待审阅', cancel_requested: '请求取消', succeeded: '已完成', failed: '失败', cancelled: '已取消', outcome_unknown: '结果待核对' };
const availabilityName: Record<string, string> = { content_readable: '内容可读', metadata_only: '仅元数据可见', unknown: '状态未知', owner_unconnected:'所有者未连接', unsupported:'来源格式不支持', forbidden:'禁止访问' };

function friendlyError(error: unknown): string {
  if (error instanceof KnowledgeClientError && ['SOURCE_OWNER_UNCONNECTED','SOURCE_READER_UNAVAILABLE'].includes(error.code)) return '业务来源所有者未连接；尚未读取原件。';
  if (error instanceof KnowledgeClientError && ['SOURCE_FORBIDDEN','SOURCE_METADATA_ONLY'].includes(error.code)) return '当前用途或身份禁止读取来源内容。';
  if (error instanceof KnowledgeClientError && ['SOURCE_CONTENT_UNSUPPORTED','SOURCE_DOMAIN_UNSUPPORTED'].includes(error.code)) return '来源格式或定位方式尚不支持；尚未读取原件。';
  if (error instanceof KnowledgeClientError) return `${error.message}（${error.code}${error.commitStatus === 'unknown' ? '；提交结果未知，请先核对操作' : ''}）`;
  return error instanceof Error ? error.message : String(error);
}
function date(value: string | null | undefined): string { return value ? new Date(value).toLocaleString('zh-CN') : '未记录'; }
function trimRef(ref: KnowledgeRef): string { return `${ref.objectId.slice(0, 8)} · ${ref.versionId.slice(0, 8)}`; }
function StateNote({ state, children }: { state?: EmptyState; children?: ReactNode }) { return <div className="state-note">{children ?? (state ? EMPTY[state] : '暂无内容。')}</div>; }
function StatusPill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'violet' | 'amber' | 'blue' }) { return <span className={`status-pill status-${tone}`}>{children}</span>; }
function CoverageNote({ coverage }: { coverage: Coverage | undefined }) {
  if (!coverage) return <p className="coverage-note">接口未附范围说明，页面不推断库中不存在其他内容。</p>;
  return <p className="coverage-note">范围：{coverage.scopeDescription} · 已返回 {coverage.returned} / 已加载 {coverage.loaded} · {coverage.completeness === 'complete' ? '当前范围完整' : coverage.completeness === 'bounded' ? '有界结果' : '完整性未知'}{coverage.hasMore ? ' · 仍有后续页' : ''}{coverage.omittedReasons.length ? ` · 未包含：${coverage.omittedReasons.join('、')}` : ''}</p>;
}

export function App() {
  const [draftConfig, setDraftConfig] = useState<Config>(DEFAULT_CONFIG);
  const [config, setConfig] = useState<Config | null>(null);
  const [configOpen, setConfigOpen] = useState(true);
  const [page, setPage] = useState<Page>('explore');
  const [connection, setConnection] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [connectionError, setConnectionError] = useState('');
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [syntheticFixture, setSyntheticFixture] = useState(false);
  const [question, setQuestion] = useState('');
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState('');
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [catalogDocuments, setCatalogDocuments] = useState<KnowledgeDocument[]>([]);
  const [catalogReceiptId, setCatalogReceiptId] = useState<string | null>(null);
  const [emptyState, setEmptyState] = useState<EmptyState>('not_loaded');
  const [coverage, setCoverage] = useState<Coverage>();
  const [readReceiptId, setReadReceiptId] = useState<string | null>(null);
  const [activeGraphReceiptId, setActiveGraphReceiptId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ReadReceipt | null>(null);
  const [graphResult, setGraphResult] = useState<GraphResult | null>(null);
  const [graphRoot, setGraphRoot] = useState<KnowledgeRef | null>(null);
  const [graphMode, setGraphMode] = useState<GraphMode>('global');
  const [graphError, setGraphError] = useState('');
  const [graphLoading, setGraphLoading] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [camera, setCamera] = useState<GraphCamera | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const [readerRef, setReaderRef] = useState<KnowledgeRef | null>(null);
  const [reader, setReader] = useState<KnowledgeDocument | null>(null);
  const [readerReceiptId, setReaderReceiptId] = useState<string | null>(null);
  const [readerError, setReaderError] = useState('');
  const [readerLoading, setReaderLoading] = useState(false);
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [sourceRef, setSourceRef] = useState<KnowledgeRef | null>(null);
  const [sourceLocator, setSourceLocator] = useState<string | null>(null);
  const [sourceAnchorStatus, setSourceAnchorStatus] = useState('');
  const [sourceReturnRef, setSourceReturnRef] = useState<KnowledgeRef | null>(null);
  const [source, setSource] = useState<SourceRecord | null>(null);
  const sourceReads = useRef(new SourceReads());
  const [sourceContent, setSourceContent] = useState<SourceContent | null>(null);
  const [sourceError, setSourceError] = useState('');
  const [changes, setChanges] = useState<ChangeItem[]>([]);
  const [changesError, setChangesError] = useState('');
  const [changesLoading, setChangesLoading] = useState(false);
  const [researchQuestion, setResearchQuestion] = useState('');
  const [operation, setOperation] = useState<Operation | null>(null);
  const [researchResult, setResearchResult] = useState<ResearchResult | null>(null);
  const [candidateView, setCandidateView] = useState<CandidateView | null>(null);
  const [candidateError, setCandidateError] = useState('');
  const [researchError, setResearchError] = useState('');
  const [researchBusy, setResearchBusy] = useState(false);
  const [reviewTicket, setReviewTicket] = useState<ReviewTicket | null>(null);
  const [reviewError, setReviewError] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);
  const [externalAdapterId, setExternalAdapterId] = useState('manual');
  const [externalId, setExternalId] = useState('');
  const [externalVersion, setExternalVersion] = useState('1');
  const [externalDescription, setExternalDescription] = useState('');
  const [useDecision, setUseDecision] = useState<'adopted' | 'adapted' | 'rejected' | 'deferred'>('deferred');
  const [useReason, setUseReason] = useState('');
  const [beforeText, setBeforeText] = useState('');
  const [afterText, setAfterText] = useState('');
  const [useStatus, setUseStatus] = useState('');
  const [useId, setUseId] = useState<string | null>(null);
  const [observation, setObservation] = useState('');
  const [interpretation, setInterpretation] = useState('');
  const [feedbackStatus, setFeedbackStatus] = useState('');
  const [feedbackRecord, setFeedbackRecord] = useState<FeedbackRecord | null>(null);
  const [feedbackSource, setFeedbackSource] = useState<SourceRecord | null>(null);
  const [feedbackResolutions, setFeedbackResolutions] = useState<ChangeItem[]>([]);
  const [feedbackLinkStatus, setFeedbackLinkStatus] = useState('');
  const readingScroll = useRef(0);
  const readingWindowScroll = useRef(0);
  const restoreReadingPosition = useRef(false);
  const readerScroll = useRef<HTMLDivElement>(null);
  const readerRequestSeq = useRef(0);
  const queryAbort = useRef<AbortController | null>(null);
  const scopeEpoch = useRef(0);
  const [, setIntentVersion] = useState(0);
  const writeIntents = useState(() => new WriteIntents(() => setIntentVersion(value => value + 1)))[0];
  const writeScope = config ? JSON.stringify([config.projectId, config.spaceId, config.purpose]) : '';
  const pendingWrite = writeIntents.view(writeScope);
  const writeBlocked = !!pendingWrite;

  const client = useMemo(() => config ? createKnowledgeClient({ baseUrl: window.location.origin, scope: { projectId: config.projectId, spaceId: config.spaceId }, headers: () => ({ Authorization: `Bearer ${config.token}` }) }) : null, [config]);
  const graph = useMemo(() => graphResult ? toGraphView(graphResult, graphRoot, graphMode) : null, [graphResult, graphRoot, graphMode]);
  const selectedDocument = graph?.nodes.find(node => node.id === selectedNodeId)?.document ?? documents.find(doc => refKey(doc.ref) === selectedNodeId) ?? null;
  const selectedExternal = graph?.nodes.find(node => node.id === selectedNodeId && node.document === null) ?? null;
  const selectedRelation = graph?.edges.find(edge => edge.id === selectedEdgeId)?.relation ?? null;
  const queryIncludesReader = !!reader && documents.some(item => refKey(item.ref) === refKey(reader.ref));
  const receiptForReader = readerReceiptId ?? (queryIncludesReader ? readReceiptId : null);

  const loadGraph = useCallback(async (activeClient: KnowledgeClient, root: { ref: KnowledgeRef } | { readReceiptId: string }, mode: GraphMode, purpose: string, signal?: AbortSignal) => {
    const epoch = scopeEpoch.current;
    setGraphLoading(true); setGraphError('');
    try {
      const response = await activeClient.graph({ root, purpose, relationKinds: ['supports', 'challenges', 'context', 'navigation'], maxDepth: mode === 'focused' ? 2 : 3, maxNodes: mode === 'focused' ? 70 : 110, maxBytes: 800_000 }, { signal });
      if (epoch !== scopeEpoch.current || signal?.aborted) return;
      setGraphResult(response.data);
      setActiveGraphReceiptId('readReceiptId' in root ? root.readReceiptId : null);
      setReceipt(null);
      const rootRef = 'ref' in root ? root.ref : response.data.nodes[0]?.ref ?? null;
      setGraphRoot(rootRef);
      setGraphMode(mode);
      setSelectedNodeId(toGraphView(response.data, rootRef, mode).rootId);
      setSelectedEdgeId(null);
      setCamera(null);
      setCoverage(response.coverage);
    } catch (error) { if (epoch === scopeEpoch.current && !signal?.aborted) setGraphError(friendlyError(error)); }
    finally { if (epoch === scopeEpoch.current && !signal?.aborted) setGraphLoading(false); }
  }, []);

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (!draftConfig.projectId.trim() || !draftConfig.spaceId.trim() || !draftConfig.token.trim()) { setConnectionError('请填写项目、空间和本地访问令牌。'); return; }
    setConnection('loading'); setConnectionError('');
    try {
      const next: Config = { ...draftConfig, projectId: draftConfig.projectId.trim(), spaceId: draftConfig.spaceId.trim(), purpose: draftConfig.purpose.trim() };
      const testClient = createKnowledgeClient({ baseUrl: window.location.origin, scope: { projectId: next.projectId, spaceId: next.spaceId }, headers: { Authorization: `Bearer ${next.token}` } });
      const available = await testClient.capabilities();
      next.purpose ||= available.data.purposes[0] ?? '';
      if (!next.purpose || !available.data.purposes.includes(next.purpose)) throw new Error(`当前服务不支持此用途。可用用途：${available.data.purposes.join('、') || '无'}`);
      const catalog = await testClient.catalog({ purpose: next.purpose, limit: 60 });
      queryAbort.current?.abort();
      scopeEpoch.current += 1;
      setConfig(next); setConfigOpen(false); setConnection('ready');
      setDraftConfig(next);
      setCapabilities(available.data);
      setSyntheticFixture(available.warnings.includes('synthetic_engineering_fixture'));
      setGraphResult(null); setGraphRoot(null); setSelectedNodeId(null); setSelectedEdgeId(null); setCamera(null); setActiveGraphReceiptId(null);
      setGraphLoading(false); setGraphError(''); setQueryLoading(false); setReaderLoading(false); setChangesLoading(false);
      readerRequestSeq.current += 1;
      setReader(null); setReaderRef(null); setReaderReceiptId(null); setSource(null); setSourceRef(null); setSourceReturnRef(null); setSourceLocator(null);
      setOperation(null); setResearchResult(null); setCandidateView(null); setReviewTicket(null); setChanges([]); setUseId(null); setFeedbackRecord(null); setFeedbackSource(null); setFeedbackResolutions([]);
      setResearchError(''); setReviewError(''); setUseStatus(''); setFeedbackStatus(''); setFeedbackLinkStatus('');
      setDocuments(catalog.data.items); setCatalogDocuments(catalog.data.items); setCatalogReceiptId(catalog.data.readReceiptId); setEmptyState(catalog.data.emptyState); setCoverage(catalog.coverage);
      setReadReceiptId(null); setReceipt(null); setPage('explore');
      if (catalog.data.items[0]) void loadGraph(testClient, { readReceiptId: catalog.data.readReceiptId }, 'global', next.purpose);
      else { setGraphResult(null); setGraphRoot(null); }
    } catch (error) { setConnection('error'); setConnectionError(friendlyError(error)); }
  }

  async function submitQuery(event: FormEvent) {
    event.preventDefault();
    if (!client || !question.trim()) return;
    const epoch = scopeEpoch.current;
    queryAbort.current?.abort();
    const controller = new AbortController(); queryAbort.current = controller;
    setQueryLoading(true); setQueryError('');
    try {
      const response = await client.query({ question: question.trim(), purpose: config!.purpose, limit: 60 }, { signal: controller.signal });
      if (epoch !== scopeEpoch.current || controller.signal.aborted) return;
      setDocuments(response.data.items); setEmptyState(response.data.emptyState); setCoverage(response.coverage);
      setReadReceiptId(response.data.readReceiptId); setReceipt(null);
      if (response.data.items.length) {
        await loadGraph(client, { readReceiptId: response.data.readReceiptId }, 'focused', config!.purpose, controller.signal);
      } else { setGraphResult(null); setGraphRoot(null); setSelectedNodeId(null); setActiveGraphReceiptId(null); }
      if (epoch !== scopeEpoch.current || controller.signal.aborted) return;
      setPage('explore');
    } catch (error) { if (epoch === scopeEpoch.current && !controller.signal.aborted) setQueryError(friendlyError(error)); }
    finally { if (epoch === scopeEpoch.current && !controller.signal.aborted) setQueryLoading(false); }
  }

  function captureReadingPosition() {
    if (page !== 'read') return;
    readingScroll.current = readerScroll.current?.scrollTop ?? 0;
    readingWindowScroll.current = window.scrollY;
  }

  async function openReader(ref: KnowledgeRef, preserveReadingPosition = false) {
    if (!client) return;
    const epoch = scopeEpoch.current;
    const requestSeq = ++readerRequestSeq.current;
    captureReadingPosition();
    restoreReadingPosition.current = preserveReadingPosition || page === 'read';
    if (!restoreReadingPosition.current) { readingScroll.current = 0; readingWindowScroll.current = 0; }
    setUseId(null); setUseStatus(''); setFeedbackRecord(null); setFeedbackSource(null); setFeedbackResolutions([]); setFeedbackStatus(''); setFeedbackLinkStatus('');
    setReaderRef(ref); setReader(null); setReaderReceiptId(null); setPage('read'); setReaderLoading(true); setReaderError(''); setComparison(null); setHistory(null); setHistoryError('');
    try {
      const [documentResult, historyResult] = await Promise.allSettled([
        client.document(ref, config!.purpose), client.history({ objectId: ref.objectId, purpose: config!.purpose, limit: 50 }),
      ]);
      if (epoch !== scopeEpoch.current || requestSeq !== readerRequestSeq.current) return;
      if (documentResult.status === 'fulfilled') {
        setReader(documentResult.value.data);
        setReaderReceiptId(documentResult.value.readReceiptId ?? null);
      } else { setReader(null); setReaderReceiptId(null); setReaderError(friendlyError(documentResult.reason)); }
      if (historyResult.status === 'fulfilled') setHistory(historyResult.value.data);
      else setHistoryError(friendlyError(historyResult.reason));
    } finally { if (epoch === scopeEpoch.current && requestSeq === readerRequestSeq.current) setReaderLoading(false); }
  }

  async function openSource(ref: KnowledgeRef, locator: string | null = null) {
    if (!client) return;
    captureReadingPosition();
    setSourceReturnRef(page === 'read' ? readerRef : null);
    setSourceRef(ref); setSourceLocator(locator); setPage('sources');
    await sourceReads.current.open(client, ref, config!.purpose, locator, {
      start: () => { setSourceAnchorStatus(''); setSource(null); setSourceContent(null); setSourceError(''); },
      metadata: setSource, content: setSourceContent, anchor: setSourceAnchorStatus,
      error: error => setSourceError(friendlyError(error)),
    });
  }

  async function compareVersion(before: KnowledgeRef, after: KnowledgeRef) {
    if (!client) return;
    const epoch = scopeEpoch.current, readerSeq = readerRequestSeq.current;
    try { const result = await client.compare({ before, after, purpose: config!.purpose }); if (epoch === scopeEpoch.current && readerSeq === readerRequestSeq.current) setComparison(result.data); }
    catch (error) { if (epoch === scopeEpoch.current && readerSeq === readerRequestSeq.current) setReaderError(friendlyError(error)); }
  }

  async function loadChanges() {
    if (!client) return;
    const epoch = scopeEpoch.current;
    setPage('changes'); setChangesLoading(true); setChangesError('');
    try { const response = await client.changes({ purpose: config!.purpose, limit: 50 }); if (epoch === scopeEpoch.current) { setChanges(response.data.items); setCoverage(response.coverage); } }
    catch (error) { if (epoch === scopeEpoch.current) setChangesError(friendlyError(error)); }
    finally { if (epoch === scopeEpoch.current) setChangesLoading(false); }
  }

  async function loadReceipt() {
    if (!client || !activeGraphReceiptId) return;
    const epoch = scopeEpoch.current;
    try { const response = await client.receipt(activeGraphReceiptId, { purpose: config!.purpose }); if (epoch === scopeEpoch.current) setReceipt(response.data); }
    catch (error) { if (epoch === scopeEpoch.current) setQueryError(friendlyError(error)); }
  }

  async function startResearch(event: FormEvent) {
    event.preventDefault();
    if (!client || !researchQuestion.trim() || capabilities?.mode !== 'ready' || !capabilities.permittedActions.includes('research')) return;
    const epoch = scopeEpoch.current;
    const researchReceiptId = reader ? receiptForReader : selectedDocument && documents.some(item => refKey(item.ref) === refKey(selectedDocument.ref)) ? readReceiptId : null;
    const input = {
      question: researchQuestion.trim(), purpose: config!.purpose,
      sourceRefs: [], knowledgeRefs: reader ? [reader.ref] : selectedDocument ? [selectedDocument.ref] : [],
      ...(researchReceiptId ? { readReceiptId: researchReceiptId } : {}),
      baseHeads: reader ? [{ objectId: reader.ref.objectId, versionId: reader.status.currentRef?.versionId ?? null }] : [],
      budget: { maxModelCalls: 0, maxReadBytes: 100_000, deadline: new Date(Date.now() + 30 * 60_000).toISOString(), maxMoney: null },
      allowExternalAcquisition: false as const,
    };
    const started = writeIntents.start({ scope: writeScope, purpose: config!.purpose, action: 'research', label: '研究提交', input,
      send: (frozen, key) => client.research(frozen, { idempotencyKey: key }), operationIsResult: true,
      complete: result => { if (epoch !== scopeEpoch.current) return; if (result instanceof Error) setResearchError(friendlyError(result)); else setOperation((result as Awaited<ReturnType<KnowledgeClient['research']>>).data ?? result as Operation); },
    });
    if (started) { setResearchError(''); setResearchResult(null); setCandidateView(null); setCandidateError(''); setReviewTicket(null); }
  }

  async function refreshResearch() {
    if (!client || !operation) return;
    const epoch = scopeEpoch.current;
    setResearchBusy(true); setResearchError('');
    try {
      const next = await client.operation(operation.id, config!.purpose);
      if (epoch !== scopeEpoch.current) return;
      setOperation(next.data);
      if (next.data.researchId && ['waiting_for_review', 'waiting_for_source', 'succeeded'].includes(next.data.state)) {
        try {
          const result = await client.researchResult(next.data.researchId, { purpose: config!.purpose });
          if (epoch !== scopeEpoch.current) return;
          setResearchResult(result.data);
          if (result.data.candidateId) void loadCandidate(result.data.candidateId);
        } catch (error) {
          if (epoch !== scopeEpoch.current) return;
          if (error instanceof KnowledgeClientError && error.code === 'RESULT_UNAVAILABLE') setResearchError('活动还没有形成可读取的研究结果，请稍后刷新。');
          else throw error;
        }
      }
    } catch (error) { if (epoch === scopeEpoch.current) setResearchError(friendlyError(error)); }
    finally { if (epoch === scopeEpoch.current) setResearchBusy(false); }
  }

  async function loadCandidate(candidateId: string) {
    if (!client) return;
    const epoch = scopeEpoch.current;
    setCandidateError('');
    try { const response = await client.candidateView(candidateId, config!.purpose); if (epoch === scopeEpoch.current) setCandidateView(response.data); }
    catch (error) { if (epoch === scopeEpoch.current) setCandidateError(friendlyError(error)); }
  }

  async function cancelResearch() {
    if (!client || !operation?.researchId) return;
    const epoch = scopeEpoch.current;
    if (writeIntents.start({ scope: writeScope, purpose: config!.purpose, action: 'research:cancel', label: '取消研究', input: { operationId: operation.id, researchId: operation.researchId, reason: '用户在知识前端取消', purpose: config!.purpose },
      send: (frozen, key) => client.cancelResearch(frozen.researchId, { reason: frozen.reason }, { idempotencyKey: key, purpose: frozen.purpose }),
      observe: async (reads, frozen, purpose) => { const state = await reads.operation(frozen.operationId, purpose); return ['cancel_requested', 'cancelled'].includes(state.state) ? { data: { state: state.state, operationId: state.id } } : null; },
      complete: result => { if (epoch === scopeEpoch.current) setResearchError(result instanceof Error ? friendlyError(result) : `活动状态已核对：${(result as Awaited<ReturnType<KnowledgeClient['cancelResearch']>>).data.state}。请刷新活动状态确认最终结果。`); },
    })) setResearchError('');
  }

  async function requestReview() {
    if (!client || !researchResult || capabilities?.mode !== 'ready' || !capabilities.permittedActions.includes('requestReview')) return;
    const epoch = scopeEpoch.current;
    const input = { target: { kind: 'research_result' as const, researchId: researchResult.researchId, resultDigest: researchResult.resultDigest }, purpose: config!.purpose };
    if (writeIntents.start({ scope: writeScope, purpose: config!.purpose, action: 'review:request', label: '独立审阅请求', input,
      send: (frozen, key) => client.requestReview(frozen, { idempotencyKey: key }),
      complete: result => { if (epoch !== scopeEpoch.current) return; if (result instanceof Error) setReviewError(friendlyError(result)); else setReviewTicket((result as Awaited<ReturnType<KnowledgeClient['requestReview']>>).data); },
    })) setReviewError('');
  }
  async function refreshReview() {
    if (!client || !reviewTicket) return;
    const epoch = scopeEpoch.current;
    setReviewBusy(true); setReviewError('');
    try { const response = await client.reviewTicket(reviewTicket.id, { purpose: config!.purpose }); if (epoch === scopeEpoch.current) setReviewTicket(response.data); }
    catch (error) { if (epoch === scopeEpoch.current) setReviewError(friendlyError(error)); }
    finally { if (epoch === scopeEpoch.current) setReviewBusy(false); }
  }

  async function contextDigest(value: string): Promise<string> {
    const bytes = new TextEncoder().encode(value);
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  async function externalContext(fields: { adapterId: string; externalId: string; version: string; description: string }) {
    const adapterId = fields.adapterId.trim(), externalIdValue = fields.externalId.trim(), contextVersion = fields.version.trim();
    if (!adapterId || !externalIdValue || !contextVersion) throw new Error('请填写场景类型、标识和版本。');
    return { adapterId, externalId: externalIdValue, contextVersion,
      inputDigest: await contextDigest(JSON.stringify({ adapterId, externalId: externalIdValue, contextVersion, description: fields.description.trim() })),
      authority: 'caller_reported' as const, description: fields.description.trim() || '由使用者在知识前端登记的外部场景' };
  }
  function contextFields() { return { adapterId: externalAdapterId, externalId, version: externalVersion, description: externalDescription }; }
  async function recordUse(event: FormEvent) {
    event.preventDefault();
    if (!client || !reader || !receiptForReader || !externalAdapterId.trim() || !externalId.trim() || !externalVersion.trim() || !useReason.trim() || capabilities?.mode !== 'ready' || !capabilities.permittedActions.includes('recordUse')) return;
    const epoch = scopeEpoch.current, readerSeq = readerRequestSeq.current;
    const input = { fields: contextFields(), readReceiptId: receiptForReader, purpose: config!.purpose,
      considered: [{ ref: reader.ref, decision: useDecision, reason: useReason.trim(), before: beforeText.trim() || null, after: afterText.trim() || null }] };
    if (writeIntents.start({ scope: writeScope, purpose: config!.purpose, action: 'uses:write', label: '记录取舍', input,
      send: async (frozen, key) => client.recordUse({ context: await externalContext(frozen.fields), readReceiptId: frozen.readReceiptId, purpose: frozen.purpose, considered: frozen.considered, gaps: [], cost: unknownCost }, { idempotencyKey: key }),
      complete: result => { if (epoch !== scopeEpoch.current || readerSeq !== readerRequestSeq.current) return; if (result instanceof Error) setUseStatus(friendlyError(result)); else { const record = (result as Awaited<ReturnType<KnowledgeClient['recordUse']>>).data; setUseId(record.id); setUseStatus(`已记录取舍 ${record.id.slice(0, 8)}。阅读本身不会自动采用。`); } },
    })) setUseStatus('提交中…');
  }
  async function recordFeedback(event: FormEvent) {
    event.preventDefault();
    if (!client || !reader || !externalAdapterId.trim() || !externalId.trim() || !externalVersion.trim() || !observation.trim() || capabilities?.mode !== 'ready' || !capabilities.permittedActions.includes('recordFeedback')) return;
    const epoch = scopeEpoch.current, readerSeq = readerRequestSeq.current;
    const input = { fields: contextFields(), purpose: config!.purpose, useId, knowledgeRefs: [reader.ref], feedbackKey: crypto.randomUUID(), observedAt: new Date().toISOString(), observation: observation.trim(), interpretation: interpretation.trim() || null };
    if (writeIntents.start({ scope: writeScope, purpose: config!.purpose, action: 'feedback:write', label: '记录反馈', input,
      send: async (frozen, key) => client.recordFeedback({ purpose: frozen.purpose, useId: frozen.useId, context: await externalContext(frozen.fields), knowledgeRefs: frozen.knowledgeRefs, feedbackKey: frozen.feedbackKey, status: 'observed', observedAt: frozen.observedAt, observation: frozen.observation, rawQuotation: null, interpretation: frozen.interpretation, recommendation: null, artifactDigest: null, measurementScope: null, cost: unknownCost, gaps: [] }, { idempotencyKey: key }),
      complete: result => { if (epoch !== scopeEpoch.current || readerSeq !== readerRequestSeq.current) return; if (result instanceof Error) setFeedbackStatus(friendlyError(result)); else { const record = (result as Awaited<ReturnType<KnowledgeClient['recordFeedback']>>).data; setFeedbackRecord(record); setFeedbackSource(null); setFeedbackResolutions([]); setFeedbackStatus(`已记录观察 ${record.id.slice(0, 8)}；解释与观察分别保存。`); } },
    })) setFeedbackStatus('提交中…');
  }

  async function registerFeedbackSource() {
    if (!client || !feedbackRecord || capabilities?.mode !== 'ready' || !capabilities.permittedActions.includes('registerFeedbackSource')) return;
    const epoch = scopeEpoch.current, readerSeq = readerRequestSeq.current;
    const input = { feedbackId: feedbackRecord.id, expectedFeedbackDigest: feedbackRecord.digest, purpose: config!.purpose };
    if (writeIntents.start({ scope: writeScope, purpose: config!.purpose, action: 'feedback:source', label: '反馈来源登记', input,
      send: (frozen, key) => client.registerFeedbackSource(frozen.feedbackId, { expectedFeedbackDigest: frozen.expectedFeedbackDigest, purpose: frozen.purpose }, { idempotencyKey: key }),
      complete: result => { if (epoch !== scopeEpoch.current || readerSeq !== readerRequestSeq.current) return; if (result instanceof Error) setFeedbackLinkStatus(friendlyError(result)); else { setFeedbackSource((result as Awaited<ReturnType<KnowledgeClient['registerFeedbackSource']>>).data); setFeedbackLinkStatus('反馈已登记为来源；这并不自动改变正式认识。'); } },
    })) setFeedbackLinkStatus('正在登记反馈来源…');
  }
  async function loadFeedbackResolutions() {
    if (!client || !feedbackRecord) return;
    const epoch = scopeEpoch.current, readerSeq = readerRequestSeq.current;
    setFeedbackLinkStatus('正在读取处理记录…');
    try { const response = await client.feedbackResolutions(feedbackRecord.id, { purpose: config!.purpose, limit: 30 }); if (epoch === scopeEpoch.current && readerSeq === readerRequestSeq.current) { setFeedbackResolutions(response.data.items); setFeedbackLinkStatus(response.data.items.length ? '已加载处理记录。' : '当前范围尚无处理记录。'); } }
    catch (error) { if (epoch === scopeEpoch.current && readerSeq === readerRequestSeq.current) setFeedbackLinkStatus(friendlyError(error)); }
  }

  useEffect(() => {
    if (page !== 'read' || !reader) return;
    const frame = requestAnimationFrame(() => {
      if (readerScroll.current) readerScroll.current.scrollTop = restoreReadingPosition.current ? readingScroll.current : 0;
      window.scrollTo(0, restoreReadingPosition.current ? readingWindowScroll.current : 0);
      restoreReadingPosition.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [page, readerRef, reader]);
  useEffect(() => {
    if (page !== 'sources') { sourceReads.current.cancel(); setSourceContent(null); setSourceError(''); return; }
    const frame = requestAnimationFrame(() => window.scrollTo(0, 0));
    return () => cancelAnimationFrame(frame);
  }, [page]);

  useEffect(() => () => sourceReads.current.cancel(), [config]);

  function selectNode(id: string) { setSelectedNodeId(id); setSelectedEdgeId(null); }
  function selectEdge(id: string) { setSelectedEdgeId(id); setSelectedNodeId(null); }
  function navigate(next: Page) { captureReadingPosition(); if (next === 'sources') setSourceReturnRef(null); if (next === 'changes') void loadChanges(); else setPage(next); }
  function backToGraph() { setPage('explore'); }

  return <div className={syntheticFixture ? 'app-shell has-synthetic' : 'app-shell'}>
    <header className="topbar">
      <button className="brand" onClick={backToGraph} aria-label="返回知识探索"><span className="brand-mark">知</span><span>知库</span></button>
      <button className="space-switcher" onClick={() => setConfigOpen(true)}><span>{config?.spaceId ?? '选择知识空间'}</span><ChevronDown size={16} /></button>
      <span className="topbar-spacer" />
      <span className="topbar-context">{config ? `${config.projectId} · ${config.purpose}` : '连接本地知识服务'}</span>
      <button className="icon-button" onClick={() => setConfigOpen(true)} aria-label="连接设置"><Settings2 size={19} /></button>
    </header>
    {syntheticFixture && <div className="synthetic-ribbon" role="status">合成工程样例 · 页面内容与研究结果仅用于验证，不代表真实业务知识</div>}
    <div className="body-shell">
      <nav className="sidebar" aria-label="主导航">
        <div className="nav-primary">
          <button className={page === 'explore' ? 'nav-link active' : 'nav-link'} onClick={() => navigate('explore')}><Compass size={20} /><span>知识探索</span></button>
          <button className={page === 'research' ? 'nav-link active' : 'nav-link'} onClick={() => navigate('research')}><CircleHelp size={20} /><span>问题研究</span></button>
          <button className={page === 'sources' ? 'nav-link active' : 'nav-link'} onClick={() => navigate('sources')}><FileText size={20} /><span>来源资料</span></button>
          <button className={page === 'changes' ? 'nav-link active' : 'nav-link'} onClick={() => navigate('changes')}><History size={20} /><span>变化记录</span></button>
        </div>
        <div className="sidebar-meta">
          <p>当前空间：{config?.spaceId ?? '未连接'}</p>
          <button onClick={() => navigate('explore')}><Layers3 size={17} />认识 <span>{documents.length}</span></button>
          <button onClick={() => navigate('explore')}><Link2 size={17} />关系 <span>{graphResult?.edges.length ?? '—'}</span></button>
          <button onClick={() => navigate('research')}><CircleHelp size={17} />研究活动</button>
        </div>
      </nav>
      <main className="main-content">
        <div className="mobile-nav" aria-label="移动导航">
          <button className={page === 'explore' ? 'active' : ''} onClick={() => navigate('explore')}>探索</button>
          <button className={page === 'research' ? 'active' : ''} onClick={() => navigate('research')}>研究</button>
          <button className={page === 'sources' ? 'active' : ''} onClick={() => navigate('sources')}>来源</button>
          <button className={page === 'changes' ? 'active' : ''} onClick={() => navigate('changes')}>变化</button>
        </div>
        {pendingWrite && <section className="write-reconciliation" role="status" aria-live="polite">
          <strong>{pendingWrite.label} · {pendingWrite.phase === 'sending' ? '提交中' : pendingWrite.phase === 'checking' ? '核对中' : '待核对'}</strong>
          <p>{pendingWrite.message}</p>
          <small>原操作键：{pendingWrite.key}。字段变动不会更改这个待核意图；新提交须等核对完成。</small>
          {pendingWrite.phase !== 'sending' && pendingWrite.phase !== 'checking' && <button className="secondary-button" type="button" onClick={() => { if (client) void writeIntents.reconcile(writeScope, {
            lookup: async (action, key, purpose) => (await client.lookupOperation({ operation: action, key, purpose })).data,
            operation: async (id, purpose) => (await client.operation(id, purpose)).data,
          }); }}>{pendingWrite.phase === 'committed_needs_result' ? '用原键取回已提交结果' : '只读核对原操作'}</button>}
        </section>}
        {!config && <div className="connect-placeholder"><Sparkles size={26} /><h1>从已有认识出发</h1><p>连接一个知识空间后，查询、星图和准确版本会从知识服务读取。</p><button className="primary-button" onClick={() => setConfigOpen(true)}>连接知识空间 <ArrowRight size={17} /></button></div>}
        {config && <>
          <section className={page === 'explore' ? 'explore-page' : 'explore-page hidden-page'} aria-hidden={page !== 'explore'}>
            <div className="page-heading"><h1>从已有认识，发现新的问题</h1><p>探索知识的来源、关联、分歧与变化。</p></div>
            <form className="search-box" onSubmit={submitQuery}><Search size={20} /><input value={question} onChange={event => setQuestion(event.target.value)} placeholder="提出问题，或寻找一条认识…" aria-label="知识查询" /><button type="submit" disabled={queryLoading || !question.trim()}>{queryLoading ? '查询中' : '探索'}</button></form>
            {queryError && <div className="inline-error" role="alert">{queryError}</div>}
            <div className="explore-grid">
              <section className="graph-card" aria-label="知识图谱">
                <div className="graph-toolbar"><div className="toolbar-label"><span className="pulse-dot" />{graphMode === 'focused' ? '聚焦依据' : '知识星图'}</div><div className="toolbar-actions"><button className={graphMode === 'global' ? 'seg selected' : 'seg'} onClick={() => { if (catalogReceiptId && client) void loadGraph(client, { readReceiptId: catalogReceiptId }, 'global', config.purpose); }}>全局</button><button className={graphMode === 'focused' ? 'seg selected' : 'seg'} onClick={() => { const ref = selectedDocument?.ref ?? documents[0]?.ref ?? catalogDocuments[0]?.ref; if (ref && client) void loadGraph(client, { ref }, 'focused', config.purpose); }}>聚焦</button><span className="toolbar-separator" /><button className="small-icon" onClick={() => setResetSignal(value => value + 1)} aria-label="适配画布"><Maximize2 size={17} /></button></div></div>
                {graphLoading && <div className="graph-status">正在获取知识关系…</div>}
                {graphError && <div className="graph-status error" role="alert">{graphError}</div>}
                {graph ? <GraphCanvas graph={graph} selectedNodeId={selectedNodeId} selectedEdgeId={selectedEdgeId} onNode={selectNode} onEdge={selectEdge} onCamera={setCamera} rememberedCamera={camera} resetSignal={resetSignal} visible={page === 'explore'} /> : <StateNote state={emptyState}>{graphLoading ? '正在读取图谱…' : emptyState ? EMPTY[emptyState] : '选择一条认识以展开关联。'}</StateNote>}
                <div className="graph-caption"><span>圆点是准确版本或外部资料；线表示关系。颜色仅辅助导航。</span><span>{graph ? `${graph.nodes.length} 个节点 · ${graph.edges.length} 条关系` : ''}</span></div>
                {graph && <div className="graph-accessible"><details><summary>用列表浏览图谱节点与关系</summary><div className="graph-list"><h3>节点</h3>{graph.nodes.map(node => <button key={node.id} onClick={() => selectNode(node.id)}>{node.title}<small>{node.document ? '认识' : `外部节点 · ${availabilityName[node.availability]}`} · {trimRef(node.ref)}</small></button>)}<h3>关系</h3>{graph.edges.map(edge => <button key={edge.id} onClick={() => selectEdge(edge.id)}>{stanceName[edge.relation.stance]} · {graph.nodes.find(node => node.id === edge.from)?.title} → {graph.nodes.find(node => node.id === edge.to)?.title}<small>{edge.relation.rationale ?? '关系理由未提供'}</small></button>)}</div></details></div>}
              </section>
              <aside className="inspector-card" aria-label="当前选择">
                <div className="inspector-kicker">当前认识 <span>···</span></div>
                {selectedRelation ? <RelationInspector relation={selectedRelation} graph={graph} onRead={openReader} onSource={openSource} /> : selectedDocument ? <DocumentInspector document={selectedDocument} graph={graph} onRead={() => void openReader(selectedDocument.ref)} onSelectRelation={selectEdge} /> : selectedExternal ? <div className="inspector-body"><span className="eyebrow">{selectedExternal.ref.domain} · {availabilityName[selectedExternal.availability]}</span><h2>{selectedExternal.title}</h2><p className="inspector-summary">这是外部来源或分析节点，内容状态由服务提供；图谱不把它当作已经验证的认识。</p><RefButton refValue={selectedExternal.ref} onRead={openReader} onSource={openSource} /></div> : <StateNote>点选一条认识或关系，查看它的准确版本和依据。</StateNote>}
                <div className="inspector-footer"><Clock3 size={17} />{activeGraphReceiptId ? <button onClick={() => void loadReceipt()}>查看这张图的读取记录</button> : <span>此图按所选认识展开</span>}</div>
              </aside>
            </div>
            {documents.length > 0 && <section className="results-strip"><div className="section-heading"><h2>{readReceiptId ? '本次问题的认识' : '当前空间的认识'}</h2><span>{documents.length} 条</span></div><div className="result-list">{documents.map(document => <button key={refKey(document.ref)} onClick={() => { selectNode(refKey(document.ref)); void openReader(document.ref); }}><span className="result-dot" /><span><strong>{document.title}</strong><small>{document.body.slice(0, 94)}{document.body.length > 94 ? '…' : ''}</small></span><ChevronRight size={17} /></button>)}</div></section>}
            {receipt && <section className="receipt-panel"><div className="section-heading"><h2>本次准确读取</h2><button onClick={() => setReceipt(null)} aria-label="关闭读取记录"><X size={17} /></button></div><p>读取记录 {receipt.id} · {date(receipt.createdAt)} · 用途 {receipt.purpose}</p><p>有序读集 {receipt.orderedItems.length} 项；实际读取来源 {receipt.actualReads.length} 项。继承依据与本次读取分开记录。</p><CoverageNote coverage={receipt.coverage} /></section>}
            <CoverageNote coverage={coverage} />
          </section>
          {page === 'read' && <section className="reader-page" ref={readerScroll} onScroll={event => { readingScroll.current = event.currentTarget.scrollTop; }}>
            <button className="back-link" onClick={backToGraph}><ArrowLeft size={17} />返回原图谱位置</button>
            {readerLoading && <StateNote>正在读取准确版本与历史…</StateNote>}
            {readerError && <div className="inline-error" role="alert">{readerError}</div>}
            {reader && <><div className="reader-heading"><div className="eyebrow">知识阅读 · {reader.profile.id}</div><h1>{reader.title}</h1><div className="reader-meta"><StatusPill tone={reader.status.current ? 'violet' : 'amber'}>{reader.status.current ? '当前版本' : '历史版本'}</StatusPill><StatusPill tone={reader.status.published ? 'blue' : 'neutral'}>{reader.status.published ? '已发表' : '未发表'}</StatusPill><span>版本 {trimRef(reader.ref)}</span></div></div><div className="reader-grid"><article className="reader-article"><h2>认识正文</h2>{reader.status.contentSupported ? <div className="prose">{reader.body.split(/\n\n+/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div> : <StateNote state="content_version_unsupported" />}<CitationList citations={reader.citations} onOpen={openSource} /><InfoList title="成立条件" items={reader.conditions} /><InfoList title="反例与边界" items={reader.counterexamples} /><InfoList title="尚不确定" items={reader.unknowns} /><InfoList title="接下来可问" items={reader.nextQuestions} /></article><aside className="reader-aside"><section><h2>版本与用途</h2><dl><dt>当前指针</dt><dd>{reader.status.currentRef ? trimRef(reader.status.currentRef) : '无'}</dd><dt>审阅决定</dt><dd>{reader.status.reviewDecision ?? '未记录'}</dd><dt>有效性</dt><dd>{reader.status.validity.valid ? '当前检查有效' : `需复核：${reader.status.validity.issues.join('、') || '原因未给出'}`}</dd><dt>检查时间</dt><dd>{date(reader.status.validity.checkedAt)}</dd><dt>复核期限</dt><dd>{date(reader.status.validity.reviewDueAt)}</dd><dt>当前用途</dt><dd>{reader.status.purpose.requested} · {reader.status.purpose.admitted ? '允许' : '不允许'}</dd></dl>{reader.status.purpose.reasons.map(reason => <p className="minor-note" key={reason}>{reason}</p>)}</section><section><h2>来源与继承</h2><p className="minor-note">继承的依据和本次实际读取分别列出；来源组可能重叠。</p><h3>继承依据</h3>{reader.inheritedBasis.length ? reader.inheritedBasis.map(ref => <RefButton key={refKey(ref)} refValue={ref} onRead={openReader} onSource={openSource} />) : <p className="muted">没有列出继承依据</p>}<h3>本次实际读取</h3>{reader.actualReadCoverage.length ? reader.actualReadCoverage.map((item, index) => <div className="coverage-item" key={`${refKey(item.sourceRef)}-${index}`}><RefButton refValue={item.sourceRef} onRead={openReader} onSource={openSource} /><span>{item.coverage} · {item.byteCount} 字节 · {item.anchors.length} 个锚点</span>{item.exclusions.length > 0 && <small>未读：{item.exclusions.join('、')}</small>}</div>) : <p className="muted">没有本次实际读取记录</p>}<h3>来源组</h3>{reader.sourceGroups.length ? reader.sourceGroups.map((group, index) => <p className="source-group" key={`${group.id}-${index}`}>{group.id ?? '未知同源组'} · {group.status} · {group.authority === 'commerce-asset-version' ? '业务素材版本' : group.authority ?? '权威未记录'}</p>) : <p className="muted">未列出来源组</p>}</section><section><h2>历史与现版</h2>{historyError && <p className="inline-error">{historyError}</p>}{history?.versions.length ? history.versions.map(version => <div className="history-row" key={refKey(version.ref)}><button onClick={() => void openReader(version.ref)}>{trimRef(version.ref)}<span>{date(version.publishedAt)}</span></button>{reader.status.currentRef && refKey(version.ref) !== refKey(reader.status.currentRef) && <button className="text-button" onClick={() => void compareVersion(version.ref, reader.status.currentRef!)}>与现版比较</button>}</div>) : <p className="muted">暂无可读历史版本</p>}</section></aside></div>{comparison && <ComparisonPanel comparison={comparison} onClose={() => setComparison(null)} />}
            <section className="use-panel">
              <div className="section-heading"><h2>取舍与反馈</h2><span>可选</span></div>
              <p className="minor-note">阅读不会自动采用。先说明外部场景，再选择采用、改编、拒用或暂缓；观察与解释分别记录。</p>
              {capabilities?.mode !== 'ready' && <p className="minor-note">当前服务为只读模式，取舍与反馈暂不可提交。</p>}
              <div className="context-fields">
                <label>场景类型<input value={externalAdapterId} onChange={event => setExternalAdapterId(event.target.value)} placeholder="例如：manual、planning" /></label>
                <label>外部场景标识<input value={externalId} onChange={event => setExternalId(event.target.value)} placeholder="例如：方案或任务编号" /></label>
                <label>场景版本<input value={externalVersion} onChange={event => setExternalVersion(event.target.value)} placeholder="1" /></label>
                <label>场景说明<input value={externalDescription} onChange={event => setExternalDescription(event.target.value)} placeholder="这条知识用在什么地方？" /></label>
              </div>
              <form onSubmit={recordUse}>
                <label>取舍<select value={useDecision} onChange={event => setUseDecision(event.target.value as typeof useDecision)}><option value="deferred">暂缓</option><option value="adopted">采用</option><option value="adapted">改编</option><option value="rejected">拒用</option></select></label>
                <label>理由<textarea value={useReason} onChange={event => setUseReason(event.target.value)} placeholder="为什么这样取舍？" required /></label>
                {useDecision === 'adapted' && <><label>改编前<textarea value={beforeText} onChange={event => setBeforeText(event.target.value)} placeholder="原来的表达或做法" /></label><label>改编后<textarea value={afterText} onChange={event => setAfterText(event.target.value)} placeholder="实际修改成什么" /></label></>}
                <button className="secondary-button" disabled={writeBlocked || !receiptForReader || capabilities?.mode !== 'ready' || !capabilities.permittedActions.includes('recordUse')}>记录取舍</button>
                {!receiptForReader && <small>当前阅读未返回可用于取舍的准确读取记录。</small>}
                {useStatus && pendingWrite?.action !== 'uses:write' && <p role="status">{useStatus}</p>}
              </form>
              <form onSubmit={recordFeedback}>
                <h3>记录观察</h3>
                <label>观察到的事实<textarea value={observation} onChange={event => setObservation(event.target.value)} placeholder="写下实际观察，不把解释当作事实" required /></label>
                <label>你的解释<textarea value={interpretation} onChange={event => setInterpretation(event.target.value)} placeholder="可选，和观察分别保存" /></label>
                <button className="secondary-button" disabled={writeBlocked || capabilities?.mode !== 'ready' || !capabilities.permittedActions.includes('recordFeedback')}>记录反馈</button>
                {feedbackStatus && pendingWrite?.action !== 'feedback:write' && <p role="status">{feedbackStatus}</p>}
              </form>
              {feedbackRecord && <div className="feedback-followup">
                <h3>反馈后续</h3><p className="minor-note">反馈 {feedbackRecord.id.slice(0, 8)} · 维护状态 {feedbackRecord.maintenanceState}</p>
                <div className="button-row">
                  <button className="secondary-button" onClick={() => void registerFeedbackSource()} disabled={writeBlocked || capabilities?.mode !== 'ready' || !capabilities.permittedActions.includes('registerFeedbackSource')}>显式登记为来源</button>
                  <button className="secondary-button" onClick={() => void loadFeedbackResolutions()}>查看处理记录</button>
                </div>
                {!capabilities?.permittedActions.includes('registerFeedbackSource') && <p className="minor-note">当前身份没有反馈来源登记权限。</p>}
                {feedbackLinkStatus && pendingWrite?.action !== 'feedback:source' && <p role="status" className="minor-note">{feedbackLinkStatus}</p>}
                {feedbackSource && <RefButton refValue={feedbackSource.ref} onRead={openReader} onSource={openSource} />}
                {feedbackResolutions.map(change => <div className="difference-row" key={change.id}><strong>{change.kind}</strong><span>{change.reason}</span>{change.after && <button className="text-button" onClick={() => void openReader(change.after!)}>阅读处理后的版本</button>}</div>)}
              </div>}
            </section></>}
            {!reader && !readerLoading && !readerError && <StateNote>从图谱选择一条认识开始阅读。</StateNote>}
          </section>}
          {page === 'sources' && <section className="simple-page">{sourceReturnRef && <button className="back-link" onClick={() => void openReader(sourceReturnRef, true)}><ArrowLeft size={17} />返回刚才的阅读位置</button>}<div className="page-heading"><h1>来源资料</h1><p>先看来源身份、可读状态与实际覆盖，再打开原文。</p></div>{sourceRef && <p className="minor-note">准确来源：{trimRef(sourceRef)}</p>}{sourceLocator && <details className="source-locator"><summary>查看原始引用定位</summary><p>{sourceLocator}</p></details>}{sourceAnchorStatus && <p className="source-anchor-status" role="status">{sourceAnchorStatus}</p>}{sourceError && <div className="inline-error" role="alert">{sourceError}</div>}{source ? <div className="source-layout"><article className="content-card"><div className="eyebrow">{sourceKindName(source.sourceKind)} · {sourceAssertionName(source.assertionKind)}</div><h2>{trimRef(source.ref)}</h2><dl><dt>内容可读</dt><dd>{source.readability.contentReadable ? '内容可读' : source.readability.reasons.includes('SOURCE_CONTENT_UNSUPPORTED') ? '格式不支持' : '仅元数据可见'}</dd><dt>锚点可达</dt><dd>{source.readability.anchorResolved ? '是' : '否'}</dd><dt>权限检查</dt><dd>{sourceAssuranceName(source.readability.assurance)}</dd></dl>{source.readability.reasons.map(reason => <p key={reason}>{sourceReasonName(reason)}</p>)}{sourceContent ? <SourceContentView source={sourceContent} /> : <StateNote state={source.readability.contentReadable ? 'not_loaded' : 'source_unreadable'} />}</article><aside className="content-card"><h2>来源身份</h2><SourceProvenanceView source={source} /><h2>来源链与覆盖</h2>{source.supersedes && <RefButton refValue={source.supersedes} onRead={openReader} onSource={openSource} />}{source.sourceGroups.map((group, index) => <p className="source-group" key={index}>{group.id ?? '未知同源组'} · {group.authority === 'commerce-asset-version' ? '业务素材版本' : group.authority ?? '权威未记录'}</p>)}{source.actualCoverage.map((item, index) => <div className="coverage-item" key={index}><span>{item.coverage} · {item.byteCount} 字节</span><small>{item.anchors.map(anchor => anchor.value).join('、') || '无锚点'}</small></div>)}{source.limitations.map((item, index) => <p className="minor-note" key={index}>{sourceLimitation(item)}</p>)}</aside></div> : <StateNote>在认识的“继承依据”或“实际读取”中选择来源。</StateNote>}</section>}
          {page === 'changes' && <section className="simple-page"><div className="page-heading"><h1>变化记录</h1><p>分别查看认识版本变化、审阅和研究结果。</p></div>{changesLoading && <StateNote>正在读取变化…</StateNote>}{changesError && <div className="inline-error" role="alert">{changesError}</div>}{changes.length ? <div className="change-list">{changes.map(change => <article className="content-card" key={change.id}><div className="eyebrow">{change.kind} · {change.cognitiveOutcome ? outcomeName[change.cognitiveOutcome] : '未标记研究结果'}</div><h2>{change.reason}</h2><p>{change.before ? trimRef(change.before) : '无先前版本'} → {change.after ? trimRef(change.after) : '无后续版本'}</p>{change.after && <button className="text-button" onClick={() => void openReader(change.after!)}>阅读准确版本 <ArrowRight size={15} /></button>}</article>)}</div> : !changesLoading && <StateNote state="no_matches_in_scope" />}<CoverageNote coverage={coverage} /></section>}
          {page === 'research' && <section className="simple-page research-page">
            <div className="page-heading"><h1>围绕问题继续研究</h1><p>旧认识、研究产出与条件挑战并列核对；活动结果不自动成为正式认识。</p></div>
            <form className="research-form content-card" onSubmit={startResearch}>
              <label>想进一步弄清的问题<textarea value={researchQuestion} onChange={event => setResearchQuestion(event.target.value)} placeholder="写下一个需要核对的具体问题" required /></label>
              <p className="minor-note">本地预算设为 0 次模型调用、无付费额度。{capabilities?.mode !== 'ready' || !capabilities.permittedActions.includes('research') ? '当前服务未开放研究提交，仍可浏览现有知识。' : '研究提交后可在下方跟踪活动与结果。'}</p>
              <button className="primary-button" disabled={writeBlocked || researchBusy || capabilities?.mode !== 'ready' || !capabilities.permittedActions.includes('research')}>开始研究 <ArrowRight size={17} /></button>
            </form>
            {researchError && <div className="inline-error" role="status">{researchError}</div>}
            {operation && <section className="content-card operation-card"><div className="section-heading"><h2>研究活动</h2><StatusPill tone={operation.state === 'succeeded' ? 'blue' : 'amber'}>{statusName[operation.state] ?? operation.state}</StatusPill></div><p>活动 {operation.researchId ?? operation.id} · 提交状态 {operation.commitStatus}</p>{operation.reason && <p>{operation.reason}</p>}<div className="button-row"><button className="secondary-button" onClick={() => void refreshResearch()} disabled={researchBusy}>刷新状态</button>{!['succeeded', 'failed', 'cancelled'].includes(operation.state) && <button className="text-button" onClick={() => void cancelResearch()} disabled={writeBlocked || researchBusy}>请求取消</button>}</div></section>}
            <ResearchTriptych documents={documents} selectedDocument={selectedDocument} graph={graph} result={researchResult} candidate={candidateView} candidateError={candidateError} operation={operation} onRead={openReader} onSource={openSource} onReloadCandidate={id => void loadCandidate(id)} />
            {researchResult && <section className="content-card review-panel">
              <div className="section-heading"><h2>独立审阅</h2><StatusPill tone="amber">{reviewTicket?.status ?? researchResult.reviewState}</StatusPill></div>
              <p className="minor-note">审阅请求只提交当前研究结果的准确摘要。此界面不替审阅者作决定；发表状态由服务返回。</p>
              <div className="button-row">
                <button className="secondary-button" onClick={() => void requestReview()} disabled={writeBlocked || reviewBusy || !!reviewTicket || capabilities?.mode !== 'ready' || !capabilities.permittedActions.includes('requestReview')}>请求独立审阅</button>
                {reviewTicket && <button className="secondary-button" onClick={() => void refreshReview()} disabled={reviewBusy}>刷新审阅状态</button>}
              </div>
              {reviewTicket && <p className="minor-note">审阅请求 {reviewTicket.id} · {reviewTicket.status}</p>}
              {!capabilities?.permittedActions.includes('requestReview') && <p className="minor-note">当前身份不能发起审阅；需要有相应授权的审阅者独立处理。</p>}
              {reviewError && <div className="inline-error" role="status">{reviewError}</div>}
            </section>}
          </section>}
        </>}
      </main>
    </div>
    {configOpen && <div className="modal-backdrop"><form className="config-modal" onSubmit={connect}><div className="section-heading"><div><div className="eyebrow">本地知识服务</div><h2>连接知识空间</h2></div>{config && <button type="button" onClick={() => setConfigOpen(false)} aria-label="关闭"><X size={19} /></button>}</div><p>输入服务已授权的项目、空间和本地令牌。令牌仅保留在当前页面内存中。</p><label>项目 ID<input value={draftConfig.projectId} onChange={event => setDraftConfig(value => ({ ...value, projectId: event.target.value }))} placeholder="项目 ID" required /></label><label>空间 ID<input value={draftConfig.spaceId} onChange={event => setDraftConfig(value => ({ ...value, spaceId: event.target.value }))} placeholder="空间 ID" required /></label><label>用途（可留空）<input value={draftConfig.purpose} onChange={event => setDraftConfig(value => ({ ...value, purpose: event.target.value }))} placeholder="使用服务的第一个可用用途" /></label><label>本地访问令牌<input type="password" autoComplete="off" value={draftConfig.token} onChange={event => setDraftConfig(value => ({ ...value, token: event.target.value }))} placeholder="不会写入 URL 或本地存储" required /></label>{connectionError && <div className="inline-error" role="alert">{connectionError}</div>}<button className="primary-button" disabled={connection === 'loading'}>{connection === 'loading' ? '正在连接…' : '连接并读取'}</button></form></div>}
  </div>;
}

function InfoList({ title, items }: { title: string; items: string[] }) { return <section className="info-list"><h3>{title}</h3>{items.length ? <ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p className="muted">未列出</p>}</section>; }
function SourceProvenanceView({ source }: { source: SourceRecord }) {
  const provenance = source.provenance;
  if (!provenance) return <p className="minor-note">当前来源所有者未提供作者、发布者和取得者元数据；不能从文件名或标签推断。</p>;
  return <dl className="provenance-list">
    <dt>外部身份</dt><dd>{provenance.externalIdentity.adapterId} · {provenance.externalIdentity.externalObjectId} · {provenance.externalIdentity.externalVersion}</dd>
    <dt>作者或创作者</dt><dd>{provenance.author ?? '未知'}</dd>
    <dt>发布者</dt><dd>{provenance.publisher ?? '未知'}</dd>
    <dt>取得者</dt><dd>{provenance.acquirer}</dd>
    <dt>发表时间</dt><dd>{date(provenance.publishedAt)}</dd>
    <dt>取得时间</dt><dd>{date(provenance.obtainedAt)}</dd>
    <dt>保管方式</dt><dd>{provenance.custody.mode === 'managed_copy' ? '知识服务管理副本' : '仅保留来源引用'}</dd>
    <dt>权利政策</dt><dd>{provenance.rightsPolicyRef}</dd>
  </dl>;
}
const comparedFieldName: Record<string, string> = {
  title: '标题', body: '认识正文', conditions: '成立条件', counterexamples: '反例与边界',
  unknowns: '尚不确定', nextQuestions: '接下来可问', sourceGroups: '来源组', citations: '直接引用',
};
function comparisonText(value: unknown): string {
  if (value === null || value === undefined) return '未记录';
  if (typeof value === 'string') return value || '空文本';
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value.length ? value.map(item => `• ${item}`).join('\n') : '未列出';
  return JSON.stringify(value, null, 2);
}
function ComparisonPanel({ comparison, onClose }: { comparison: Comparison; onClose: () => void }) {
  return <section className="comparison-panel">
    <div className="section-heading"><h2>准确版本比较</h2><button onClick={onClose} aria-label="关闭版本比较"><X size={17} /></button></div>
    <p>历史 {trimRef(comparison.before.ref)} → 当前 {trimRef(comparison.after.ref)}</p>
    <div className="compare-columns compare-titles"><strong>{comparison.before.title}</strong><strong>{comparison.after.title}</strong></div>
    {comparison.differences.length ? comparison.differences.map((difference, index) => <article className="compare-difference" key={`${difference.field}-${index}`}>
      <h3>{comparedFieldName[difference.field] ?? difference.field}</h3>
      <div className="compare-columns"><div><span className="eyebrow">历史版本</span><pre>{comparisonText(difference.before)}</pre></div><div><span className="eyebrow">当前版本</span><pre>{comparisonText(difference.after)}</pre></div></div>
      {difference.reason && <p className="minor-note">变更说明：{difference.reason}</p>}
    </article>) : <StateNote>这两个准确版本没有结构化差异。</StateNote>}
  </section>;
}
function ResearchTriptych({ documents, selectedDocument, graph, result, candidate, candidateError, operation, onRead, onSource, onReloadCandidate }: {
  documents: KnowledgeDocument[]; selectedDocument: KnowledgeDocument | null; graph: ReturnType<typeof toGraphView> | null;
  result: ResearchResult | null; candidate: CandidateView | null; candidateError: string; operation: Operation | null;
  onRead: (ref: KnowledgeRef) => void; onSource: (ref: KnowledgeRef) => void; onReloadCandidate: (id: string) => void;
}) {
  const oldRefs = result?.exactReadset ?? [];
  const oldDocuments = oldRefs.map(ref => ({ ref, document: documents.find(item => refKey(item.ref) === refKey(ref)) ?? (selectedDocument && refKey(selectedDocument.ref) === refKey(ref) ? selectedDocument : null) }));
  const challenges = graph?.edges.filter(edge => edge.relation.stance === 'challenges') ?? [];
  return <div className="research-triptych">
    <section className="content-card research-column">
      <div className="eyebrow">01 · 研究前</div><h2>已有认识与准确读集</h2>
      {result ? <>
        <p className="minor-note">准确读集 {oldRefs.length} 项 · 继承依据 {result.inheritedBasis.length} 项 · 实际读取来源 {result.actualReadCoverage.length} 项。这三者含义不同。</p>
        {oldDocuments.length ? oldDocuments.map(({ ref, document }) => <div className="research-basis" key={refKey(ref)}><strong>{document?.title ?? '准确版本（正文未在当前列表加载）'}</strong>{document && <p>{document.body.slice(0, 130)}{document.body.length > 130 ? '…' : ''}</p>}<RefButton refValue={ref} onRead={onRead} onSource={onSource} /></div>) : <StateNote>研究结果没有列出旧认识读集。</StateNote>}
      </> : selectedDocument ? <><p className="minor-note">以下仅为当前选择，尚未证明研究活动已读取。</p><div className="research-basis"><strong>{selectedDocument.title}</strong><p>{selectedDocument.body.slice(0, 150)}{selectedDocument.body.length > 150 ? '…' : ''}</p><RefButton refValue={selectedDocument.ref} onRead={onRead} onSource={onSource} /></div></> : <StateNote>选择图谱认识或通过问题查询后，可在这里核对旧认识。研究开始前没有已确认读集。</StateNote>}
    </section>
    <section className="content-card research-column research-middle">
      <div className="eyebrow">02 · 研究产出</div><h2>候选综合或研究结论</h2>
      {!result ? <StateNote>{operation ? `活动当前${statusName[operation.state] ?? operation.state}；还没有可核对的研究结论。` : '尚未提交研究，也没有候选正文。'}</StateNote> : <>
        <StatusPill tone={result.cognitiveOutcome === 'candidate' ? 'violet' : result.cognitiveOutcome === 'needs_evidence' ? 'amber' : 'blue'}>{outcomeName[result.cognitiveOutcome]}</StatusPill>
        <p className="research-reason">{result.reason}</p>
        {result.cognitiveOutcome === 'candidate' && (candidate ? <div className="candidate-body"><div className="candidate-meta">候选 {candidate.candidateId.slice(0, 8)} · {candidate.state} · 提出者 {candidate.proposer}<br />内容摘要 {candidate.contentHash.slice(0, 16)}…</div><p>{candidate.rationale}</p>{candidate.changes.map(change => <article key={refKey(change.ref)}><h3>{change.title}</h3><div className="prose">{change.body}</div><InfoList title="条件" items={change.conditions} /><InfoList title="反例" items={change.counterexamples} /><p className="minor-note">候选对应的准确标识：{trimRef(change.ref)}。发表前不能按正式认识阅读。</p></article>)}</div> : <div className="candidate-unloaded"><StateNote>{candidateError || '候选正文尚未从服务读取；不能凭结果摘要推断具体修订。'}</StateNote>{result.candidateId && <button className="secondary-button" onClick={() => onReloadCandidate(result.candidateId!)}>读取候选正文</button>}</div>)}
        <p className="minor-note">{result.publication ? `已发表：${date(result.publication.publishedAt)}` : '尚未发表；候选不等于现版认识。'} · 审阅状态 {result.reviewState}</p>
      </>}
    </section>
    <section className="content-card research-column">
      <div className="eyebrow">03 · 核对边界</div><h2>条件、挑战与缺口</h2>
      {selectedDocument && <><InfoList title="当前认识的成立条件" items={selectedDocument.conditions} /><InfoList title="当前认识的反例" items={selectedDocument.counterexamples} /></>}
      {result && <><InfoList title="研究仍缺什么" items={result.gaps} /><InfoList title="需要的来源" items={result.sourceNeeds} />{result.excluded.length > 0 && <div className="research-exclusions"><h3>排除的依据</h3>{result.excluded.map(item => <p key={refKey(item.ref)}>{item.reason} · {trimRef(item.ref)}</p>)}</div>}</>}
      {challenges.length > 0 && <div className="research-challenges"><h3>图谱中的挑战关系</h3>{challenges.slice(0, 3).map(edge => <p key={edge.id}>{edge.relation.rationale ?? '理由未记录'} · {edge.relation.evidenceStatus === 'observed' ? '已观察' : edge.relation.evidenceStatus === 'untested' ? '未检验' : '状态未知'}</p>)}</div>}
      {!selectedDocument && !result && !challenges.length && <StateNote>当前没有加载条件、挑战或研究缺口。</StateNote>}
    </section>
  </div>;
}
function RefButton({ refValue, onRead, onSource }: { refValue: KnowledgeRef; onRead: (ref: KnowledgeRef) => void; onSource: (ref: KnowledgeRef) => void }) { return <button className="ref-button" onClick={() => { if (refValue.domain === 'knowledge') void onRead(refValue); else void onSource(refValue); }}><span>{refValue.domain} · {trimRef(refValue)}</span><ArrowRight size={15} /></button>; }
function DocumentInspector({ document, graph, onRead, onSelectRelation }: { document: KnowledgeDocument; graph: ReturnType<typeof toGraphView> | null; onRead: () => void; onSelectRelation: (id: string) => void }) {
  const relations = graph ? selectedRelations(graph, refKey(document.ref)) : [];
  return <><div className="inspector-body"><span className="eyebrow">准确认识 · {document.profile.id}</span><h2>{document.title}</h2><StatusPill tone={document.status.validity.valid ? 'amber' : 'neutral'}>{document.status.validity.valid ? '当前检查有效' : '有效性待复核'}</StatusPill><p className="inspector-summary">{document.body.slice(0, 150)}{document.body.length > 150 ? '…' : ''}</p>{document.conditions.length > 0 && <div className="condition-preview"><strong>成立条件</strong><span>{document.conditions.slice(0, 2).join('；')}</span></div>}<div className="inspector-divider" /><h3>为什么值得联读</h3>{relations.length ? relations.slice(0, 2).map(edge => <button className="relation-card" key={edge.id} onClick={() => onSelectRelation(edge.id)}><span className={`relation-dot stance-${edge.relation.stance}`} /><span><strong>{stanceName[edge.relation.stance]}</strong><small>{edge.relation.rationale ?? '理由未记录，打开关系查看准确范围'}</small></span><ChevronRight size={18} /></button>) : <p className="muted">当前范围未返回关联依据。</p>}<button className="read-button" onClick={onRead}><BookOpen size={19} />阅读这条认识 <ArrowRight size={17} /></button></div></>;
}
function RelationInspector({ relation, graph, onRead, onSource }: { relation: Relation; graph: ReturnType<typeof toGraphView> | null; onRead: (ref: KnowledgeRef) => void; onSource: (ref: KnowledgeRef) => void }) {
  const from = graph?.nodes.find(node => node.id === refKey(relation.from));
  const to = graph?.nodes.find(node => node.id === refKey(relation.to));
  return <div className="inspector-body"><span className="eyebrow">关系 · {stanceName[relation.stance]}</span><h2>{from?.title ?? trimRef(relation.from)} → {to?.title ?? trimRef(relation.to)}</h2><StatusPill tone={relation.evidenceStatus === 'observed' ? 'blue' : 'amber'}>{relation.evidenceStatus === 'observed' ? '已观察' : relation.evidenceStatus === 'untested' ? '未检验' : '证据状态未知'}</StatusPill><p className="inspector-summary">{relation.rationale ?? '这条关系没有提供理由；界面不补造论证。'}</p><dl><dt>指向的判断</dt><dd>{relation.targetStatementAnchor ? `${relation.targetStatementAnchor.kind} · ${relation.targetStatementAnchor.value}` : '未定位到具体句'}</dd><dt>关键关系</dt><dd>{relation.critical ? '是' : '否'}</dd><dt>关系版本</dt><dd>{relation.relationVersion}</dd></dl><InfoList title="成立条件" items={relation.conditions} /><h3>连接的认识</h3><RefButton refValue={relation.from} onRead={onRead} onSource={onSource} /><RefButton refValue={relation.to} onRead={onRead} onSource={onSource} />{relation.sourceGroups.length > 0 && <p className="minor-note">来源组：{relation.sourceGroups.map(group => group.id ?? '未知').join('、')}</p>}</div>;
}
