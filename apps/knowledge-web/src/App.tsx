import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type FormEvent, type ReactNode } from 'react';
import { Component } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronDown, ChevronRight, CircleHelp, Clock3, Compass, FileText, History, Link2, Maximize2, Search, Settings2, Sparkles, X, ZoomIn, ZoomOut } from 'lucide-react';
import { createKnowledgeClient, KnowledgeClientError, type KnowledgeClient } from '@commerce/knowledge-client';
import type { CandidateView, ChangeItem, Coverage, GraphResult, KnowledgeDocument, KnowledgeRef, Relation, ResearchResult, SourceRecord } from '@commerce/knowledge-contracts';
import { GraphCanvas, type GraphCamera } from './graph/GraphCanvas';
import { refKey, selectedRelations, toGraphView, type GraphMode } from './graph/view-model';
import { WriteIntents } from './write-intents';
import { SourceReads } from './source-reads';
import { matchingCoReadingReceipt, resolveCoReading, toggleCoReading } from './co-reading';
import { reviewTargetFor } from './review-target';
import { CitationList, SourceContentView, sourceKindName, sourceAssertionName, sourceAssuranceName, sourceReasonName, sourceLimitation } from './source-view';
import { EvolutionPanel } from './evolution/EvolutionPanel';
import type { Graph3DCamera } from './graph3d/KnowledgeGraph3D';
import { AskPanel } from './ask-panel';
import { CandidateReview, candidateTerminalMessage, hasCandidateReviewControls } from './candidate-review';
import { MaintenanceInbox } from './maintenance-inbox';

const KnowledgeGraph3D = lazy(() => import('./graph3d/KnowledgeGraph3D'));
type Perspective = 'constellation' | 'question' | 'evolution';
class GraphFailureBoundary extends Component<{ children: ReactNode; onFailure: (reason: string) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, _info: ErrorInfo) { this.props.onFailure(error.message); }
  render() { return this.state.failed ? null : this.props.children; }
}

type Page = 'explore' | 'read' | 'sources' | 'changes' | 'research' | 'maintenance';
type Config = { baseUrl: string; projectId: string; spaceId: string; token: string; purpose: string };
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
const knowledgeMark = new URL('./assets/knowledge-mark.png', import.meta.url).href;
const DEFAULT_CONFIG: Config = {
  baseUrl: '',
  projectId: environment.VITE_KNOWLEDGE_PROJECT_ID ?? '',
  spaceId: environment.VITE_KNOWLEDGE_SPACE_ID ?? '',
  token: '', purpose: environment.VITE_KNOWLEDGE_PURPOSE ?? '',
};
const unknownCost = { modelCalls: { state: 'unknown' as const, reason: '此界面未测量' }, tokens: { state: 'unknown' as const, reason: '此界面未测量' }, money: { state: 'unknown' as const, reason: '此界面未测量' } };
const outcomeName: Record<string, string> = { candidate: '形成候选认识', no_change: '有依据地保持不变', needs_evidence: '仍需补证' };
const stanceName: Record<Relation['stance'], string> = { supports: '支持', challenges: '挑战', context: '联读背景', navigation: '导航关联' };
const statusName: Record<string, string> = { queued: '排队中', running: '研究中', waiting_for_source: '等待来源', waiting_for_review: '等待审阅', cancel_requested: '请求取消', succeeded: '已完成', failed: '失败', cancelled: '已取消', outcome_unknown: '结果待核对', pending: '等待独立审阅', finalized: '审阅已处理' };
const availabilityName: Record<string, string> = { content_readable: '内容可读', metadata_only: '仅元数据可见', unknown: '状态未知', owner_unconnected:'所有者未连接', unsupported:'来源格式不支持', forbidden:'禁止访问' };

function friendlyError(error: unknown): string {
  if (error instanceof KnowledgeClientError && ['SOURCE_OWNER_UNCONNECTED','SOURCE_READER_UNAVAILABLE'].includes(error.code)) return '业务来源所有者未连接；尚未读取原件。';
  if (error instanceof KnowledgeClientError && ['SOURCE_FORBIDDEN','SOURCE_METADATA_ONLY'].includes(error.code)) return '当前用途或身份禁止读取来源内容。';
  if (error instanceof KnowledgeClientError && ['SOURCE_CONTENT_UNSUPPORTED','SOURCE_DOMAIN_UNSUPPORTED'].includes(error.code)) return '来源格式或定位方式尚不支持；尚未读取原件。';
  if (error instanceof KnowledgeClientError) return `${error.message}（${error.code}${error.commitStatus === 'unknown' ? '；提交结果未知，请先核对操作' : ''}）`;
  return error instanceof Error ? error.message : String(error);
}
function researchReason(value: string): string { return /^Synthetic engineering candidate; independent semantic review required\.?$/.test(value) ? '合成工程候选，须经独立语义审阅。' : value; }
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
  const [maintenanceVisited, setMaintenanceVisited] = useState(false);
  const [maintenanceReturnCandidateId, setMaintenanceReturnCandidateId] = useState<string | null>(null);
  const [askOpen, setAskOpen] = useState(false);
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
  const [coReading, setCoReading] = useState<KnowledgeRef[]>([]);
  const [perspective, setPerspective] = useState<Perspective>('question');
  const [exploreView, setExploreView] = useState<'2d' | '3d' | 'list'>('3d');
  const [graph3dError, setGraph3dError] = useState('');
  const [researchOpen, setResearchOpen] = useState(false);
  const [cameras2d, setCameras2d] = useState<Record<'constellation' | 'question', GraphCamera | null>>({ constellation: null, question: null });
  const [cameras3d, setCameras3d] = useState<Record<'constellation' | 'question', Graph3DCamera | null>>({ constellation: null, question: null });
  const [resetSignal, setResetSignal] = useState(0);
  const [zoomRequest, setZoomRequest] = useState<{ sequence: number; direction: 'in' | 'out' }>({ sequence: 0, direction: 'in' });
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
  const [candidateLookupId, setCandidateLookupId] = useState('');
  const [candidateLoading, setCandidateLoading] = useState(false);
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
  const inspectorScroll = useRef<HTMLElement>(null);
  const readerRequestSeq = useRef(0);
  const graphRequestSeq = useRef(0);
  const connectionSeq = useRef(0);
  const queryAbort = useRef<AbortController | null>(null);
  const scopeEpoch = useRef(0);
  const candidateRequestSeq = useRef(0);
  const candidateRequestedId = useRef('');
  const [, setIntentVersion] = useState(0);
  const writeIntents = useState(() => new WriteIntents(() => setIntentVersion(value => value + 1)))[0];
  const writeScope = config ? JSON.stringify([config.projectId, config.spaceId, config.purpose]) : '';
  const pendingWrite = writeIntents.view(writeScope);
  const writeBlocked = !!pendingWrite;
  const canReadMaintenance = !!capabilities?.permittedActions.includes('maintenanceTasks') && !!capabilities?.permittedActions.includes('maintenanceFindings');
  useEffect(() => { if (!canReadMaintenance) setMaintenanceReturnCandidateId(null); }, [canReadMaintenance]);

  const client = useMemo(() => config ? createKnowledgeClient({ baseUrl: config.baseUrl, scope: { projectId: config.projectId, spaceId: config.spaceId }, headers: () => ({ Authorization: `Bearer ${config.token}` }) }) : null, [config]);
  const graph = useMemo(() => graphResult ? toGraphView(graphResult, graphRoot, graphMode) : null, [graphResult, graphRoot, graphMode]);
  const selectedDocument = graph?.nodes.find(node => node.id === selectedNodeId)?.document ?? documents.find(doc => refKey(doc.ref) === selectedNodeId) ?? catalogDocuments.find(doc => refKey(doc.ref) === selectedNodeId) ?? null;
  const selectedExternal = graph?.nodes.find(node => node.id === selectedNodeId && node.document === null) ?? null;
  const selectedRelation = graph?.edges.find(edge => edge.id === selectedEdgeId)?.relation ?? null;
  const coReadingDocuments = resolveCoReading(coReading, [...catalogDocuments, ...documents, ...(graph?.nodes.flatMap(node => node.document ? [node.document] : []) ?? [])]);
  const currentCandidate = researchResult?.candidateId && candidateView?.candidateId === researchResult.candidateId ? candidateView : null;
  const candidateUsesOwnReview = !!currentCandidate && hasCandidateReviewControls(currentCandidate);
  const reviewTarget = reviewTargetFor(researchResult, candidateView);
  const reviewEligible = !!reviewTarget && operation?.state === 'waiting_for_review' && !candidateUsesOwnReview;
  const reviewNotice = researchResult?.cognitiveOutcome === 'candidate' && !reviewTarget
    ? '候选正文尚未读取或与当前结果不匹配，暂不能请求审阅。'
    : researchResult && operation?.state !== 'waiting_for_review' ? '当前研究活动尚未进入可请求审阅状态。' : '';
  const browseDocuments = [...new Map([...(readReceiptId ? documents : catalogDocuments), ...(graph?.nodes.flatMap(node => node.document ? [node.document] : []) ?? [])].map(document => [refKey(document.ref), document])).values()];
  const selectionFull = coReading.length === 2 && (!selectedDocument || !coReading.some(ref => refKey(ref) === refKey(selectedDocument.ref)));
  const relatedChallenges = graph?.edges.filter(edge => edge.relation.stance === 'challenges' && (coReading.some(ref => [edge.from, edge.to].includes(refKey(ref))) || (selectedNodeId && [edge.from, edge.to].includes(selectedNodeId)))) ?? [];
  const queryIncludesReader = !!reader && documents.some(item => refKey(item.ref) === refKey(reader.ref));
  const receiptForReader = readerReceiptId ?? (queryIncludesReader ? readReceiptId : null);
  const graphPerspective = perspective === 'evolution' ? 'question' : perspective;
  const evolutionDocument = selectedDocument ?? (selectedRelation ? graph?.nodes.find(node => node.id === refKey(selectedRelation.to))?.document ?? graph?.nodes.find(node => node.id === refKey(selectedRelation.from))?.document : null) ?? graph?.nodes.find(node => node.id === graph.rootId)?.document ?? browseDocuments[0] ?? null;
  const selectedEvolutionRef = evolutionDocument?.ref ?? null;
  const trailNodes = graph ? [graph.nodes.find(node => node.id === selectedNodeId || node.id === graph.rootId), ...graph.edges.filter(edge => edge.to === (selectedNodeId ?? graph.rootId) && ['supports', 'challenges'].includes(edge.relation.stance)).sort((a, b) => (a.relation.stance === 'supports' ? 0 : 1) - (b.relation.stance === 'supports' ? 0 : 1)).map(edge => graph.nodes.find(node => node.id === edge.from))].filter((node): node is NonNullable<typeof node> => !!node && !!node.document).filter((node, index, nodes) => nodes.findIndex(other => other.id === node.id) === index).slice(0, 8) : [];

  function graph3dUnavailable(reason: string) { setGraph3dError(reason || '此设备无法显示 3D 图。'); setExploreView('2d'); }

  const loadGraph = useCallback(async (activeClient: KnowledgeClient, root: { ref: KnowledgeRef } | { readReceiptId: string }, mode: GraphMode, purpose: string, signal?: AbortSignal) => {
    const epoch = scopeEpoch.current;
    const sequence = ++graphRequestSeq.current;
    setGraphLoading(true); setGraphError('');
    try {
      const response = await activeClient.graph({ root, purpose, relationKinds: ['supports', 'challenges', 'context', 'navigation'], maxDepth: mode === 'focused' ? 2 : 3, maxNodes: mode === 'focused' ? 70 : 110, maxBytes: 800_000 }, { signal });
      if (epoch !== scopeEpoch.current || sequence !== graphRequestSeq.current || signal?.aborted) return;
      setGraphResult(response.data);
      setActiveGraphReceiptId('readReceiptId' in root ? root.readReceiptId : null);
      setReceipt(null);
      const rootRef = 'ref' in root ? root.ref : response.data.nodes[0]?.ref ?? null;
      setGraphRoot(rootRef);
      setGraphMode(mode);
      setSelectedNodeId(toGraphView(response.data, rootRef, mode).rootId);
      setSelectedEdgeId(null);
      setCameras2d({ constellation: null, question: null }); setCameras3d({ constellation: null, question: null });
      setCoverage(response.coverage);
    } catch (error) { if (epoch === scopeEpoch.current && sequence === graphRequestSeq.current && !signal?.aborted) setGraphError(friendlyError(error)); }
    finally { if (epoch === scopeEpoch.current && sequence === graphRequestSeq.current && !signal?.aborted) setGraphLoading(false); }
  }, []);

  async function importLocalConnection(file: File | undefined) {
    if (!file) return;
    if (file.size > 16_384) { setConnectionError('连接文件过大，请检查文件。'); return; }
    try {
      const value: unknown = JSON.parse(await file.text());
      if (!value || typeof value !== 'object') throw new Error('连接文件格式无效');
      const record = value as Record<string, unknown>;
      if (typeof record.projectId !== 'string' || typeof record.spaceId !== 'string' || typeof record.purpose !== 'string' || typeof record.token !== 'string') throw new Error('连接文件缺少项目、空间、用途或令牌');
      setDraftConfig({ baseUrl: '', projectId: record.projectId, spaceId: record.spaceId, purpose: record.purpose, token: record.token });
      setConnectionError('');
    } catch (error) { setConnectionError(error instanceof Error ? error.message : '无法读取连接文件'); }
  }

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (!draftConfig.projectId.trim() || !draftConfig.spaceId.trim() || !draftConfig.token.trim()) { setConnectionError('请填写项目、空间和本地访问令牌。'); return; }
    const connectionRequest = ++connectionSeq.current;
    setConnection('loading'); setConnectionError('');
    try {
      const next: Config = { ...draftConfig, baseUrl: window.location.origin, projectId: draftConfig.projectId.trim(), spaceId: draftConfig.spaceId.trim(), purpose: draftConfig.purpose.trim() };
      const testClient = createKnowledgeClient({ baseUrl: next.baseUrl, scope: { projectId: next.projectId, spaceId: next.spaceId }, headers: { Authorization: `Bearer ${next.token}` } });
      const available = await testClient.capabilities({includeRecoveryScope:true});
      next.purpose ||= available.data.purposes[0] ?? '';
      if (!next.purpose || !available.data.purposes.includes(next.purpose)) throw new Error(`当前服务不支持此用途。可用用途：${available.data.purposes.join('、') || '无'}`);
      const catalog = await testClient.catalog({ purpose: next.purpose, limit: 60 });
      if (connectionRequest !== connectionSeq.current) return;
      queryAbort.current?.abort();
      scopeEpoch.current += 1;
      graphRequestSeq.current += 1;
      candidateRequestSeq.current += 1;
      candidateRequestedId.current = '';
      setAskOpen(false);
      setConfig(next); setConfigOpen(false); setConnection('ready');
      setMaintenanceVisited(false);
      setMaintenanceReturnCandidateId(null);
      setDraftConfig(next);
      setCapabilities(available.data);
      setSyntheticFixture(available.warnings.includes('synthetic_engineering_fixture'));
      setGraphResult(null); setGraphRoot(null); setSelectedNodeId(null); setSelectedEdgeId(null); setCoReading([]); setQuestion(''); setResearchOpen(false); setPerspective('question'); setExploreView('3d'); setGraph3dError(''); setCameras2d({ constellation: null, question: null }); setCameras3d({ constellation: null, question: null }); setActiveGraphReceiptId(null);
      setGraphLoading(false); setGraphError(''); setQueryLoading(false); setReaderLoading(false); setChangesLoading(false);
      readerRequestSeq.current += 1;
      setReader(null); setReaderRef(null); setReaderReceiptId(null); setSource(null); setSourceRef(null); setSourceReturnRef(null); setSourceLocator(null);
      setOperation(null); setResearchResult(null); setCandidateView(null); setCandidateLookupId(''); setCandidateLoading(false); setCandidateError(''); setReviewTicket(null); setChanges([]); setUseId(null); setFeedbackRecord(null); setFeedbackSource(null); setFeedbackResolutions([]);
      setResearchError(''); setReviewError(''); setUseStatus(''); setFeedbackStatus(''); setFeedbackLinkStatus('');
      setDocuments(catalog.data.items); setCatalogDocuments(catalog.data.items); setCatalogReceiptId(catalog.data.readReceiptId); setEmptyState(catalog.data.emptyState); setCoverage(catalog.coverage);
      setReadReceiptId(null); setReceipt(null); setPage('explore');
      if (catalog.data.items[0]) void loadGraph(testClient, { readReceiptId: catalog.data.readReceiptId }, 'global', next.purpose);
      else { setGraphResult(null); setGraphRoot(null); }
    } catch (error) { if (connectionRequest === connectionSeq.current) { setConnection('error'); setConnectionError(friendlyError(error)); } }
  }

  async function submitQuery(event: FormEvent) {
    event.preventDefault();
    if (!client || !question.trim()) return;
    const epoch = scopeEpoch.current;
    queryAbort.current?.abort();
    const controller = new AbortController(); queryAbort.current = controller;
    setQueryLoading(true); setQueryError('');
    try {
      const response = await client.query({ question: question.trim(), purpose: config!.purpose, limit: 60,
        ...(Number(capabilities?.limits.queryIdentityLexicalVersion ?? 0) >= 2 ? { retrievalMethod: 'wiki-lexical-v2' as const } : {}) }, { signal: controller.signal });
      if (epoch !== scopeEpoch.current || controller.signal.aborted) return;
      setDocuments(response.data.items); setEmptyState(response.data.emptyState); setCoverage(response.coverage);
      setReadReceiptId(response.data.readReceiptId); setReceipt(null);
      if (response.data.items.length) {
        await loadGraph(client, { readReceiptId: response.data.readReceiptId }, 'focused', config!.purpose, controller.signal);
      } else { setGraphResult(null); setGraphRoot(null); setSelectedNodeId(null); setActiveGraphReceiptId(null); }
      if (epoch !== scopeEpoch.current || controller.signal.aborted) return;
      setPerspective('question');
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
    const researchReceiptId = coReading.length === 2
      ? matchingCoReadingReceipt(receipt, config!.purpose, coReading)
      : reader ? receiptForReader : selectedDocument && documents.some(item => refKey(item.ref) === refKey(selectedDocument.ref)) ? readReceiptId : null;
    const input = {
      question: researchQuestion.trim(), purpose: config!.purpose,
      sourceRefs: [], knowledgeRefs: coReading.length === 2 ? coReading : reader ? [reader.ref] : selectedDocument ? [selectedDocument.ref] : [],
      ...(researchReceiptId ? { readReceiptId: researchReceiptId } : {}),
      baseHeads: coReading.length === 2 ? [] : reader ? [{ objectId: reader.ref.objectId, versionId: reader.status.currentRef?.versionId ?? null }] : [],
      budget: { maxModelCalls: 0, maxReadBytes: 100_000, deadline: new Date(Date.now() + 30 * 60_000).toISOString(), maxMoney: null },
      allowExternalAcquisition: false as const,
    };
    const started = writeIntents.start({ scope: writeScope, purpose: config!.purpose, action: 'research', label: '研究提交', input,
      send: (frozen, key) => client.research(frozen, { idempotencyKey: key }), operationIsResult: true,
      complete: result => { if (epoch !== scopeEpoch.current) return; if (result instanceof Error) setResearchError(friendlyError(result)); else setOperation((result as Awaited<ReturnType<KnowledgeClient['research']>>).data ?? result as Operation); },
    });
    if (started) { candidateRequestSeq.current += 1; candidateRequestedId.current = '';
      setResearchError(''); setResearchResult(null); setCandidateView(null); setCandidateLoading(false); setCandidateError(''); setReviewTicket(null); }
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

  async function loadCandidate(candidateId: string, fromMaintenance = false) {
    if (!client || !candidateId.trim()) return;
    setMaintenanceReturnCandidateId(fromMaintenance ? candidateId.trim() : null);
    const epoch = scopeEpoch.current;
    const sequence = ++candidateRequestSeq.current;
    candidateRequestedId.current = candidateId.trim();
    setCandidateView(null); setCandidateError(''); setCandidateLoading(true);
    try { const response = await client.candidateView(candidateId.trim(), config!.purpose);
      if (epoch === scopeEpoch.current && sequence === candidateRequestSeq.current) setCandidateView(response.data); }
    catch (error) { if (epoch === scopeEpoch.current && sequence === candidateRequestSeq.current) setCandidateError(friendlyError(error)); }
    finally { if (epoch === scopeEpoch.current && sequence === candidateRequestSeq.current) setCandidateLoading(false); }
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
    const target = reviewTargetFor(researchResult, candidateView);
    if (!client || !target || operation?.state !== 'waiting_for_review' || capabilities?.mode !== 'ready' || !capabilities.permittedActions.includes('requestReview')) return;
    const epoch = scopeEpoch.current;
    const input = { target, purpose: config!.purpose };
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
  useEffect(() => { inspectorScroll.current?.scrollTo({ top: 0 }); }, [selectedNodeId, selectedEdgeId, perspective]);

  function selectNode(id: string) { setSelectedNodeId(id); setSelectedEdgeId(null); if (perspective === 'constellation') setPerspective('question'); }
  function selectEdge(id: string) { setSelectedEdgeId(id); setSelectedNodeId(null); }
  function navigate(next: Page) { captureReadingPosition(); setMaintenanceReturnCandidateId(null); if (next === 'sources') setSourceReturnRef(null); if (next === 'maintenance') setMaintenanceVisited(true); if (next === 'changes') void loadChanges(); else setPage(next); }
  function backToGraph() { setPage('explore'); }
  function switchPerspective(next: Perspective) { setPerspective(next); setPage('explore'); }
  function compareCoReading() {
    if (coReading.length !== 2) return;
    setResearchQuestion(current => current.trim() || question.trim() || `比较“${coReadingDocuments[0]?.document?.title ?? '第一条认识'}”与“${coReadingDocuments[1]?.document?.title ?? '第二条认识'}”的成立条件、支持与挑战`);
    setResearchOpen(true);
    inspectorScroll.current?.scrollTo({ top: 0 });
  }

  const renderedScopeEpoch = scopeEpoch.current;
  const renderedCandidateSeq = candidateRequestSeq.current;
  return <div className={syntheticFixture ? 'app-shell has-synthetic' : 'app-shell'}>
    <header className="topbar">
      <button className="brand" onClick={backToGraph} aria-label="返回知识探索"><span className="brand-mark"><img src={knowledgeMark} alt="" width="30" height="30" /></span><span>联读研究台</span></button>
      <button className="space-switcher" onClick={() => setConfigOpen(true)}><span>{config?.spaceId ?? '选择知识空间'}</span><ChevronDown size={16} /></button>
      {syntheticFixture && <span className="synthetic-badge" role="status" title="合成工程样例：页面内容与研究结果仅用于验证，不代表真实业务知识">合成样例</span>}
      <span className="topbar-spacer" />
      {config && page === 'explore' && !askOpen && <form className="header-search" onSubmit={submitQuery}><Search size={18} /><input value={question} onChange={event => setQuestion(event.target.value)} placeholder="在此知识空间中查询…" aria-label="知识查询" /><button type="submit" disabled={queryLoading || !question.trim()}>{queryLoading ? '查询中' : '查询'}</button></form>}
      <button className="icon-button" onClick={() => setConfigOpen(true)} aria-label="连接设置"><Settings2 size={19} /></button>
    </header>
    <div className={page === 'explore' ? 'body-shell view-explore' : 'body-shell'}>
      <nav className="sidebar" aria-label="主导航">
        <div className="nav-primary">
          <button className={page === 'explore' ? 'nav-link active' : 'nav-link'} onClick={() => { setPerspective('constellation'); navigate('explore'); }} title="研究图谱"><Compass size={21} /><span>研究</span></button>
          <button className={page === 'research' ? 'nav-link active' : 'nav-link'} onClick={() => navigate('research')} title="问题研究"><CircleHelp size={21} /><span>问题</span></button>
          <button className={page === 'sources' ? 'nav-link active' : 'nav-link'} onClick={() => navigate('sources')} title="来源资料"><FileText size={21} /><span>来源</span></button>
          <button className={page === 'changes' ? 'nav-link active' : 'nav-link'} onClick={() => navigate('changes')} title="变化记录"><History size={21} /><span>变化</span></button>
          {canReadMaintenance && <button className={page === 'maintenance' ? 'nav-link active' : 'nav-link'} onClick={() => navigate('maintenance')} title="维护"><Settings2 size={21} /><span>维护</span></button>}
        </div>
        <button className="rail-settings" onClick={() => setConfigOpen(true)} title="连接设置" aria-label="连接设置"><Settings2 size={20} /><span>设置</span></button>
      </nav>
      {config && page === 'explore' && <aside className="research-trail" aria-label="研究脉络">
        <h2>研究脉络</h2>
        <section><h3>当前问题</h3><p>{question.trim() || '从已有认识出发'}</p></section>
        <section><h3>{perspective === 'constellation' ? '当前有界范围' : '相关认识'} <span>{graph?.nodes.filter(node => node.document).length ?? documents.length}</span></h3>
          <div className="trail-list">{(trailNodes.length ? trailNodes : graph?.nodes.filter(node => node.document).slice(0, 8) ?? documents.slice(0, 8).map(document => ({ id: refKey(document.ref), title: document.title, ref: document.ref, document }))).map(node => <button key={node.id} className={node.id === selectedNodeId ? 'trail-item current' : coReading.some(ref => refKey(ref) === node.id) ? 'trail-item chosen' : 'trail-item'} onClick={() => selectNode(node.id)}><span className="trail-dot" />{node.title}</button>)}</div>
          {!graph && !documents.length && <p className="minor-note">当前范围尚无可显示认识。</p>}
        </section>
        <section><h3>联读选择 <span>{coReading.length}/2</span></h3>{coReadingDocuments.length ? coReadingDocuments.map(({ ref, document }) => <button className="trail-item chosen" key={refKey(ref)} onClick={() => setCoReading(current => toggleCoReading(current, ref))}><span className="trail-dot" />{document?.title ?? '准确版本未在当前范围加载'} <X size={13} /></button>) : <p className="minor-note">在星图或右侧笔记选择两条认识。</p>}</section>
        {coverage && <p className="trail-coverage">{coverage.completeness === 'complete' ? '当前返回范围完整' : '有界投影 · 可能还有其他认识'}</p>}
      </aside>}
      <main className="main-content">
        <div className="mobile-nav" aria-label="移动导航">
          <button className={page === 'explore' ? 'active' : ''} onClick={() => navigate('explore')}>探索</button>
          <button className={page === 'research' ? 'active' : ''} onClick={() => navigate('research')}>研究</button>
          <button className={page === 'sources' ? 'active' : ''} onClick={() => navigate('sources')}>来源</button>
          <button className={page === 'changes' ? 'active' : ''} onClick={() => navigate('changes')}>变化</button>
          {canReadMaintenance && <button className={page === 'maintenance' ? 'active' : ''} onClick={() => navigate('maintenance')}>维护</button>}
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
            <div className="page-heading workbench-heading"><div className="workbench-heading-copy"><h1>{askOpen ? '有据问答' : perspective === 'constellation' ? '哪些认识把这些主题连起来？' : perspective === 'evolution' ? '这条认识如何演化？' : question.trim() || '这条认识为什么成立，又在哪里可能失效？'}</h1></div><div className="workbench-heading-actions">
              {capabilities?.mode === 'ready' && capabilities.permittedActions.includes('ask') && <button type="button" className="ask-entry secondary-button" onClick={() => setAskOpen(value => !value)} aria-pressed={askOpen}>{askOpen ? '返回星图' : '有据问答'}</button>}
              <div className="perspective-tabs" role="group" aria-label="认知视角"><button className={perspective === 'constellation' && !askOpen ? 'selected' : ''} onClick={() => { setAskOpen(false); switchPerspective('constellation'); }} aria-pressed={perspective === 'constellation' && !askOpen}>星群</button><button className={perspective === 'question' && !askOpen ? 'selected' : ''} onClick={() => { setAskOpen(false); switchPerspective('question'); }} aria-pressed={perspective === 'question' && !askOpen}>问题</button><button className={perspective === 'evolution' && !askOpen ? 'selected' : ''} onClick={() => { setAskOpen(false); switchPerspective('evolution'); }} aria-pressed={perspective === 'evolution' && !askOpen}>演化</button></div>
            </div></div>
            {queryError && <div className="inline-error" role="alert">{queryError}</div>}
            <AskPanel key={renderedScopeEpoch} client={client!} purpose={config.purpose} question={question} onQuestionChange={setQuestion} permitted={capabilities?.mode === 'ready' && capabilities.permittedActions.includes('ask')} selected={coReadingDocuments.map(({ ref, document }) => ({ ref, title: document?.title ?? null }))} selectionPermitted={capabilities?.mode === 'ready' && capabilities.permittedActions.includes('askSelection')} recoveryScope={capabilities?.recoveryScope ?? null} visible={askOpen && page === 'explore'} syntheticFixture={syntheticFixture} onRead={ref => void openReader(ref)} onSource={(ref, locator) => void openSource(ref, locator)} onClose={() => setAskOpen(false)} />
            <div hidden={askOpen}>
            <div className="explore-grid">
              <section className="graph-card" aria-label="知识图谱">
                {perspective !== 'evolution' && <div className="graph-toolbar"><div className="view-switch" role="group" aria-label="图形方式"><button className={exploreView === '2d' ? 'seg selected' : 'seg'} onClick={() => setExploreView('2d')} aria-pressed={exploreView === '2d'}>2D</button><button className={exploreView === '3d' ? 'seg selected' : 'seg'} onClick={() => { setGraph3dError(''); setExploreView('3d'); }} aria-pressed={exploreView === '3d'}>3D</button><button className={exploreView === 'list' ? 'seg selected' : 'seg'} onClick={() => setExploreView('list')} aria-pressed={exploreView === 'list'}>列表</button></div><div className="toolbar-actions">{exploreView !== 'list' && <><button className="seg" onClick={() => { if (catalogReceiptId && client) void loadGraph(client, { readReceiptId: catalogReceiptId }, 'global', config.purpose); }}>当前范围</button><button className="seg" onClick={() => { const ref = selectedDocument?.ref ?? documents[0]?.ref ?? catalogDocuments[0]?.ref; if (ref && client) void loadGraph(client, { ref }, 'focused', config.purpose); }}>展开所选</button><span className="toolbar-separator" /><button className="small-icon" onClick={() => setZoomRequest(value => ({ sequence: value.sequence + 1, direction: 'in' }))} aria-label="放大图谱" title="放大图谱"><ZoomIn size={17} /></button><button className="small-icon" onClick={() => setZoomRequest(value => ({ sequence: value.sequence + 1, direction: 'out' }))} aria-label="缩小图谱" title="缩小图谱"><ZoomOut size={17} /></button><button className="small-icon" onClick={() => setResetSignal(value => value + 1)} aria-label="适配画布"><Maximize2 size={17} /></button></>}</div></div>}
                {graph3dError && <div className="graph-status error" role="status">3D 不可用：{graph3dError}。已返回 2D，可切换列表阅读。</div>}
                {graphLoading && <div className="graph-status">正在获取知识关系…</div>}
                {graphError && <div className="graph-status error" role="alert">{graphError}</div>}
                {perspective === 'evolution' ? <EvolutionPanel client={client!} purpose={config.purpose} selected={selectedEvolutionRef} title={evolutionDocument?.title ?? null} candidate={currentCandidate} research={researchResult} onRead={openReader} onBack={() => switchPerspective('question')} /> : exploreView !== 'list' ? <>{graph ? exploreView === '3d' ? <div className="graph-surface graph-surface-3d"><GraphFailureBoundary key={`${config.spaceId}:${config.purpose}:${graphResult?.edges.length ?? 0}`} onFailure={graph3dUnavailable}><Suspense fallback={<div className="graph-status">正在加载 3D 星图…</div>}><KnowledgeGraph3D graph={graph} presentation={graphPerspective} selectedNodeId={selectedNodeId} selectedEdgeId={selectedEdgeId} coReadingIds={coReading.map(refKey)} onNode={selectNode} onEdge={selectEdge} onCamera={value => setCameras3d(current => ({ ...current, [graphPerspective]: value }))} rememberedCamera={cameras3d[graphPerspective]} resetSignal={resetSignal} zoomRequest={zoomRequest} visible={page === 'explore'} onUnavailable={graph3dUnavailable} /></Suspense></GraphFailureBoundary></div> : <GraphCanvas graph={graph} selectedNodeId={selectedNodeId} selectedEdgeId={selectedEdgeId} coReadingIds={coReading.map(refKey)} onNode={selectNode} onEdge={selectEdge} onCamera={value => setCameras2d(current => ({ ...current, [graphPerspective]: value }))} rememberedCamera={cameras2d[graphPerspective]} resetSignal={resetSignal} zoomRequest={zoomRequest} visible={page === 'explore'} /> : <StateNote state={emptyState}>{graphLoading ? '正在读取图谱…' : emptyState ? EMPTY[emptyState] : '选择一条认识以展开关联。'}</StateNote>}<div className="graph-caption"><span>颜色是当前有界投影的视觉分组，不表示真伪；关系方向、条件和未知状态以笔记与正文为准。</span><span>{graph ? `有界投影：${graph.nodes.length} 节点 · ${graph.edges.length} 关系。` : ''}</span></div></> : <div className="graph-list-pane"><div className="section-heading"><h2>当前范围的认识（{browseDocuments.length}）</h2></div>{browseDocuments.length ? <div className="browse-list">{browseDocuments.map(document => { const chosen = coReading.some(ref => refKey(ref) === refKey(document.ref)); return <article key={refKey(document.ref)}><h3>{document.title}</h3><p>{document.body.slice(0, 140)}{document.body.length > 140 ? '…' : ''}</p><div className="button-row"><button className="text-button" onClick={() => { if (graph?.nodes.some(node => node.id === refKey(document.ref))) selectNode(refKey(document.ref)); else if (client) void loadGraph(client, { ref: document.ref }, 'focused', config.purpose); setExploreView('2d'); }}>图中定位</button><button className="text-button" onClick={() => void openReader(document.ref)}>阅读正文</button><button className="text-button" disabled={!chosen && coReading.length === 2} onClick={() => setCoReading(current => toggleCoReading(current, document.ref))}>{chosen ? '移出联读' : '加入联读'}</button></div></article>; })}</div> : <StateNote state={emptyState} />}{graph && <><details className="browse-relations"><summary>查看当前图谱的 {graph.nodes.filter(node => !node.document).length} 个外部节点</summary><div className="graph-list">{graph.nodes.filter(node => !node.document).map(node => <button key={node.id} onClick={() => { selectNode(node.id); setExploreView('2d'); }}>{node.title}<small>{availabilityName[node.availability]} · {trimRef(node.ref)}</small></button>)}</div></details><details className="browse-relations"><summary>查看当前图谱的 {graph.edges.length} 条关系</summary><div className="graph-list">{graph.edges.map(edge => <button key={edge.id} onClick={() => { selectEdge(edge.id); setExploreView('2d'); }}>{stanceName[edge.relation.stance]} · {graph.nodes.find(node => node.id === edge.from)?.title} → {graph.nodes.find(node => node.id === edge.to)?.title}<small>{edge.relation.rationale ?? '关系理由未提供'}</small></button>)}</div></details></>}<CoverageNote coverage={coverage} /></div>}
              </section>
              <aside className="inspector-card" aria-label="研究笔记" ref={inspectorScroll}>
                <div className="inspector-kicker">研究笔记 <span>···</span></div>
                <div className="notebook-section notebook-selection"><h3>联读选择 · {coReading.length}/2</h3>{coReadingDocuments.length ? coReadingDocuments.map(({ ref, document }, index) => <div className="notebook-choice" key={refKey(ref)} title={`${ref.objectId}@${ref.versionId}`}><strong>{index + 1}. {document?.title ?? '准确版本未在当前范围加载'}</strong><small>{document?.status.current ? '当前版' : document ? '历史版' : '准确版本'}</small></div>) : <p>选择两条认识后，可以围绕同一星图研究。</p>}<p className="minor-note">本地选择尚非服务读集；结果以准确读集为准。</p></div>
                {researchOpen && <section className="notebook-research" aria-label="联读研究准备"><div className="section-heading"><h2>比较两条认识</h2><button className="text-button" onClick={() => setResearchOpen(false)} aria-label="收起研究准备"><X size={16} /></button></div><p className="minor-note">{operation ? '活动已提交；待结果返回后核对服务准确读集。' : `拟提交 ${coReading.length} 条准确版本；提交前尚未形成服务读集。`}预算为 0 次模型调用、无付费额度。</p><form onSubmit={startResearch}><label>想核对的问题<textarea value={researchQuestion} onChange={event => setResearchQuestion(event.target.value)} required /></label><button className="primary-button" disabled={coReading.length !== 2 || writeBlocked || researchBusy || capabilities?.mode !== 'ready' || !capabilities.permittedActions.includes('research')}>提交联读研究 <ArrowRight size={16} /></button></form>{capabilities?.mode !== 'ready' || !capabilities.permittedActions.includes('research') ? <p className="minor-note">当前服务未开放研究提交。</p> : null}{researchError && <p className="inline-error" role="status">{researchError}</p>}{operation && <div className="notebook-outcome"><strong>研究活动 · {statusName[operation.state] ?? operation.state}</strong><p>{operation.reason ?? '活动状态来自服务；请刷新读取结果。'}</p><div className="button-row"><button className="secondary-button" onClick={() => void refreshResearch()} disabled={researchBusy}>刷新状态</button>{!['succeeded', 'failed', 'cancelled'].includes(operation.state) && <button className="text-button" onClick={() => void cancelResearch()} disabled={writeBlocked || researchBusy}>请求取消</button>}</div></div>}{researchResult && <div className="notebook-outcome"><h3>{outcomeName[researchResult.cognitiveOutcome]}</h3><p>服务准确读集 {researchResult.exactReadset.length} 项 · 审阅 {statusName[researchResult.reviewState] ?? researchResult.reviewState}</p><p>{researchReason(researchResult.reason)}</p>{reviewNotice && <p className="minor-note">{reviewNotice}</p>}{researchResult.gaps.length > 0 && <InfoList title="仍需补证" items={researchResult.gaps} />}{researchResult.cognitiveOutcome === 'candidate' && (currentCandidate ? <div className="notebook-candidate"><strong>候选正文 · 尚非正式认识</strong>{currentCandidate.changes.map(change => <article key={refKey(change.ref)}><h3>{change.title}</h3><p>{change.body}</p><InfoList title="成立条件" items={change.conditions} /><InfoList title="反例" items={change.counterexamples} /></article>)}</div> : <p className="minor-note">{candidateError || '候选正文尚未读取。'}{researchResult.candidateId && <button className="text-button" onClick={() => void loadCandidate(researchResult.candidateId!)}>读取候选正文</button>}</p>)}<div className="button-row">{!candidateUsesOwnReview ? <button className="secondary-button" onClick={() => void requestReview()} disabled={!reviewEligible || writeBlocked || reviewBusy || !!reviewTicket || capabilities?.mode !== 'ready' || !capabilities.permittedActions.includes('requestReview')}>请求独立审阅</button> : <button className="text-button" onClick={() => setPage('research')}>查看候选的独立审阅</button>}{reviewTicket && <button className="text-button" onClick={() => void refreshReview()} disabled={reviewBusy}>刷新审阅</button>}</div>{reviewTicket && <p>审阅请求：{statusName[reviewTicket.status] ?? reviewTicket.status}</p>}{reviewError && <p className="inline-error" role="status">{reviewError}</p>}</div>}<button className="text-button" onClick={() => setPage('research')}>查看完整研究 <ArrowRight size={14} /></button></section>}
                {selectedDocument && <><button className="secondary-button notebook-add" disabled={selectionFull} onClick={() => setCoReading(current => toggleCoReading(current, selectedDocument.ref))}>{coReading.some(ref => refKey(ref) === refKey(selectedDocument.ref)) ? <Check size={16} /> : <Link2 size={16} />}{coReading.some(ref => refKey(ref) === refKey(selectedDocument.ref)) ? '移出联读选区' : '加入联读选区'}</button>{selectionFull && <p className="minor-note selection-limit">已选满两条；先移除一条再加入。</p>}</>}
                {selectedRelation ? <RelationInspector relation={selectedRelation} graph={graph} onRead={openReader} onSource={openSource} /> : selectedDocument ? <DocumentInspector document={selectedDocument} graph={graph} onRead={() => void openReader(selectedDocument.ref)} onSource={openSource} onSelectRelation={selectEdge} /> : selectedExternal ? <div className="inspector-body"><span className="eyebrow">{selectedExternal.ref.domain} · {availabilityName[selectedExternal.availability]}</span><h2>{selectedExternal.title}</h2><p className="inspector-summary">这是外部来源或分析节点，内容状态由服务提供；图谱不把它当作已经验证的认识。</p><RefButton refValue={selectedExternal.ref} onRead={openReader} onSource={openSource} /></div> : <StateNote>点选一条认识或关系，查看它的准确版本和依据。</StateNote>}
                {relatedChallenges.length > 0 && <div className="notebook-section"><h3>挑战关系</h3>{relatedChallenges.slice(0, 3).map(edge => <button className="notebook-relation" key={edge.id} onClick={() => selectEdge(edge.id)}>{edge.relation.rationale ?? '关系理由未记录'}<small>{edge.relation.evidenceStatus === 'observed' ? '已观察' : edge.relation.evidenceStatus === 'untested' ? '未检验' : '证据状态未知'}</small></button>)}</div>}
                {!researchOpen && researchResult && <div className="notebook-section"><h3>最近研究结果</h3><p>{outcomeName[researchResult.cognitiveOutcome]} · 服务准确读集 {researchResult.exactReadset.length} 项</p><button className="text-button" onClick={() => setResearchOpen(true)}>展开研究结果 <ArrowRight size={14} /></button></div>}
                <div className="inspector-footer"><Clock3 size={17} />{activeGraphReceiptId ? <button onClick={() => void loadReceipt()}>查看这张图的读取记录</button> : <span>此图按所选认识展开</span>}</div>
                {receipt && <div className="notebook-section"><h3>本次准确读取</h3><p>{date(receipt.createdAt)} · 用途 {receipt.purpose}</p><p>有序读集 {receipt.orderedItems.length} 项；实际读取来源 {receipt.actualReads.length} 项。</p><details><summary>查看准确读取标识</summary><p>{receipt.id}</p></details><CoverageNote coverage={receipt.coverage} /></div>}
              </aside>
            </div>
            {coReading.length > 0 && <section className="co-reading-bar" aria-label="联读选区"><div className="co-reading-heading"><strong>联读选区（{coReading.length}/2）</strong><span>本地准备 · 服务读集在提交后核对</span></div><div className="co-reading-items">{coReadingDocuments.map(({ ref, document }, index) => <div className="co-reading-chip" key={refKey(ref)} title={`${ref.projectId}/${ref.spaceId}/${ref.domain}/${ref.objectId}@${ref.versionId} · digest ${ref.contentDigest ?? '未记录'}`}><span>{index + 1}. {document?.title ?? '准确版本未在当前范围加载'}</span><small>{document?.status.current ? '当前版' : document ? '历史版' : '准确版本'}</small><button onClick={() => setCoReading(current => toggleCoReading(current, ref))} aria-label={`移除第${index + 1}条联读认识`}><X size={15} /></button></div>)}<button className="primary-button" onClick={compareCoReading} disabled={coReading.length !== 2}>比较选中的两条认识 <ArrowRight size={16} /></button></div></section>}
            </div>
          </section>
          {page === 'read' && <section className="reader-page" ref={readerScroll} onScroll={event => { readingScroll.current = event.currentTarget.scrollTop; }}>
            <button className="back-link" onClick={backToGraph}><ArrowLeft size={17} />{askOpen ? '返回有据问答' : '返回原视角与选择'}</button>
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
          {page === 'sources' && askOpen && !sourceReturnRef && <button className="back-link" onClick={backToGraph}><ArrowLeft size={17} />返回有据问答</button>}
          {page === 'sources' && <section className="simple-page">{sourceReturnRef && <button className="back-link" onClick={() => void openReader(sourceReturnRef, true)}><ArrowLeft size={17} />返回刚才的阅读位置</button>}<div className="page-heading"><h1>来源资料</h1><p>先看来源身份、可读状态与实际覆盖，再打开原文。</p></div>{sourceRef && <p className="minor-note">准确来源：{trimRef(sourceRef)}</p>}{sourceLocator && <details className="source-locator"><summary>查看原始引用定位</summary><p>{sourceLocator}</p></details>}{sourceAnchorStatus && <p className="source-anchor-status" role="status">{sourceAnchorStatus}</p>}{sourceError && <div className="inline-error" role="alert">{sourceError}</div>}{source ? <div className="source-layout"><article className="content-card"><div className="eyebrow">{sourceKindName(source.sourceKind)} · {sourceAssertionName(source.assertionKind)}</div><h2>{trimRef(source.ref)}</h2><dl><dt>内容可读</dt><dd>{source.readability.contentReadable ? '内容可读' : source.readability.reasons.includes('SOURCE_CONTENT_UNSUPPORTED') ? '格式不支持' : '仅元数据可见'}</dd><dt>锚点可达</dt><dd>{source.readability.anchorResolved ? '是' : '否'}</dd><dt>权限检查</dt><dd>{sourceAssuranceName(source.readability.assurance)}</dd></dl>{source.readability.reasons.map(reason => <p key={reason}>{sourceReasonName(reason)}</p>)}{sourceContent ? <SourceContentView source={sourceContent} /> : <StateNote state={source.readability.contentReadable ? 'not_loaded' : 'source_unreadable'} />}</article><aside className="content-card"><h2>来源身份</h2><SourceProvenanceView source={source} /><h2>来源链与覆盖</h2>{source.supersedes && <RefButton refValue={source.supersedes} onRead={openReader} onSource={openSource} />}{source.sourceGroups.map((group, index) => <p className="source-group" key={index}>{group.id ?? '未知同源组'} · {group.authority === 'commerce-asset-version' ? '业务素材版本' : group.authority ?? '权威未记录'}</p>)}{source.actualCoverage.map((item, index) => <div className="coverage-item" key={index}><span>{item.coverage} · {item.byteCount} 字节</span><small>{item.anchors.map(anchor => anchor.value).join('、') || '无锚点'}</small></div>)}{source.limitations.map((item, index) => <p className="minor-note" key={index}>{sourceLimitation(item)}</p>)}</aside></div> : <StateNote>在认识的“继承依据”或“实际读取”中选择来源。</StateNote>}</section>}
          {page === 'changes' && <section className="simple-page"><div className="page-heading"><h1>使用与反馈活动</h1><p>此列表按当前作用域返回活动记录；单条认识的正式版本请在「演化」中读取。活动不能拼成整网历史。</p></div>{changesLoading && <StateNote>正在读取变化…</StateNote>}{changesError && <div className="inline-error" role="alert">{changesError}</div>}{changes.length ? <div className="change-list">{changes.map(change => <article className="content-card" key={change.id}><div className="eyebrow">{change.kind} · {change.cognitiveOutcome ? outcomeName[change.cognitiveOutcome] : '未标记研究结果'}</div><h2>{change.reason}</h2><p>{change.before ? trimRef(change.before) : '无先前版本'} → {change.after ? trimRef(change.after) : '无后续版本'}</p>{change.after && <button className="text-button" onClick={() => void openReader(change.after!)}>阅读准确版本 <ArrowRight size={15} /></button>}</article>)}</div> : !changesLoading && <StateNote state="no_matches_in_scope" />}<CoverageNote coverage={coverage} /></section>}
          {maintenanceVisited && canReadMaintenance && <div className="maintenance-shell" hidden={page !== 'maintenance'}><MaintenanceInbox key={renderedScopeEpoch} client={client!} purpose={config.purpose}
            canCancel={!!capabilities?.permittedActions.includes('cancelMaintenance')}
            canReadProjection={!!capabilities?.permittedActions.includes('searchProjectionStatus')}
            canReadCoordination={!!capabilities?.permittedActions.includes('coordinationRun')}
            onCandidate={id => { setPage('research'); void loadCandidate(id, true); }} /></div>}
          {page === 'research' && <section className="simple-page research-page">
            <div className="page-heading">{maintenanceReturnCandidateId && canReadMaintenance && <button type="button" className="back-link" onClick={() => { setPage('maintenance'); setMaintenanceReturnCandidateId(null); }}>返回维护任务</button>}<h1>围绕问题继续研究</h1><p>旧认识、研究产出与条件挑战并列核对；活动结果不自动成为正式认识。</p>{coReading.length === 2 && <div className="research-selection">本次拟提交的准确版本：{coReadingDocuments.map(({ ref, document }) => `${document?.title ?? '未加载标题'}（${ref.versionId}）`).join('、')}。提交前尚无服务器读集。</div>}</div>
            <form className="research-form content-card" onSubmit={startResearch}>
              <label>想进一步弄清的问题<textarea value={researchQuestion} onChange={event => setResearchQuestion(event.target.value)} placeholder="写下一个需要核对的具体问题" required /></label>
              <p className="minor-note">本地预算设为 0 次模型调用、无付费额度。{capabilities?.mode !== 'ready' || !capabilities.permittedActions.includes('research') ? '当前服务未开放研究提交，仍可浏览现有知识。' : '研究提交后可在下方跟踪活动与结果。'}</p>
              <button className="primary-button" disabled={writeBlocked || researchBusy || capabilities?.mode !== 'ready' || !capabilities.permittedActions.includes('research')}>{coReading.length === 2 ? '比较选中的两条认识' : '开始研究'} <ArrowRight size={17} /></button>
            </form>
            {researchError && <div className="inline-error" role="status">{researchError}</div>}
            {operation && <section className="content-card operation-card"><div className="section-heading"><h2>研究活动</h2><StatusPill tone={operation.state === 'succeeded' ? 'blue' : 'amber'}>{statusName[operation.state] ?? operation.state}</StatusPill></div><p>活动 {operation.researchId ?? operation.id} · 提交状态 {operation.commitStatus}</p>{operation.reason && <p>{operation.reason}</p>}<div className="button-row"><button className="secondary-button" onClick={() => void refreshResearch()} disabled={researchBusy}>刷新状态</button>{!['succeeded', 'failed', 'cancelled'].includes(operation.state) && <button className="text-button" onClick={() => void cancelResearch()} disabled={writeBlocked || researchBusy}>请求取消</button>}</div></section>}
            <CandidateLookupPanel value={candidateLookupId} onChange={setCandidateLookupId}
              onSubmit={event => { event.preventDefault(); void loadCandidate(candidateLookupId); }}
              loading={candidateLoading} error={candidateError} candidate={candidateView} result={researchResult} onRead={openReader} />
            <ResearchTriptychWhenRelevant documents={browseDocuments} coReadingDocuments={coReadingDocuments} selectedDocument={selectedDocument} graph={graph} result={researchResult}
              candidate={candidateView}
              candidateError={candidateRequestedId.current === researchResult?.candidateId ? candidateError : ''}
              operation={operation} onRead={openReader} onSource={openSource} onReloadCandidate={id => void loadCandidate(id)} />
            {client && candidateView && hasCandidateReviewControls(candidateView) &&
              <CandidateReview key={`${renderedScopeEpoch}:${candidateView.candidateId}:${candidateView.contentHash}`}
                candidate={candidateView} client={client} actions={{
                  request:!writeBlocked && capabilities?.mode === 'ready' && capabilities.permittedActions.includes('requestReview'),
                  decide:!writeBlocked && capabilities?.mode === 'ready' && capabilities.permittedActions.includes('decideReview'),
                }} recoveryKey={config && capabilities?.recoveryScope ? candidateReviewRecoveryKey(config,capabilities.recoveryScope,candidateView) : undefined}
                onCandidate={value => { if (renderedScopeEpoch === scopeEpoch.current && renderedCandidateSeq === candidateRequestSeq.current && config && value.purpose === config.purpose && value.candidateId === candidateView.candidateId) setCandidateView(value); }} />}
            {researchResult && !candidateUsesOwnReview && showLegacyResearchContext(researchResult,candidateView) && <section className="content-card review-panel">
              <div className="section-heading"><h2>独立审阅</h2><StatusPill tone="amber">{statusName[reviewTicket?.status ?? researchResult.reviewState] ?? reviewTicket?.status ?? researchResult.reviewState}</StatusPill></div>
              <p className="minor-note">审阅请求只提交当前研究结果的准确摘要。此界面不替审阅者作决定；发表状态由服务返回。</p>
              <div className="button-row">
                <button className="secondary-button" onClick={() => void requestReview()} disabled={!reviewEligible || writeBlocked || reviewBusy || !!reviewTicket || capabilities?.mode !== 'ready' || !capabilities.permittedActions.includes('requestReview')}>请求独立审阅</button>
                {reviewTicket && <button className="secondary-button" onClick={() => void refreshReview()} disabled={reviewBusy}>刷新审阅状态</button>}
              </div>
              {reviewTicket && <p className="minor-note">审阅请求 {reviewTicket.id} · {statusName[reviewTicket.status] ?? reviewTicket.status}</p>}
              {!capabilities?.permittedActions.includes('requestReview') && <p className="minor-note">当前身份不能发起审阅；需要有相应授权的审阅者独立处理。</p>}
              {reviewError && <div className="inline-error" role="status">{reviewError}</div>}
            </section>}
          </section>}
        </>}
      </main>
    </div>
    {configOpen && <div className="modal-backdrop"><form className="config-modal" onSubmit={connect}><div className="section-heading"><div><div className="eyebrow">本地知识服务</div><h2>连接知识空间</h2></div>{config && <button type="button" onClick={() => setConfigOpen(false)} aria-label="关闭"><X size={19} /></button>}</div><p>输入服务已授权的项目、空间和本地令牌。令牌仅保留在当前页面内存中。</p><label>从本机连接文件导入<input type="file" accept="application/json,.json" onChange={event => void importLocalConnection(event.target.files?.[0])} /></label><label>项目 ID<input value={draftConfig.projectId} onChange={event => setDraftConfig(value => ({ ...value, projectId: event.target.value }))} placeholder="项目 ID" required /></label><label>空间 ID<input value={draftConfig.spaceId} onChange={event => setDraftConfig(value => ({ ...value, spaceId: event.target.value }))} placeholder="空间 ID" required /></label><label>用途（可留空）<input value={draftConfig.purpose} onChange={event => setDraftConfig(value => ({ ...value, purpose: event.target.value }))} placeholder="使用服务的第一个可用用途" /></label><label>本地访问令牌<input type="password" autoComplete="off" value={draftConfig.token} onChange={event => setDraftConfig(value => ({ ...value, token: event.target.value }))} placeholder="不会写入 URL 或本地存储" required /></label>{connectionError && <div className="inline-error" role="alert">{connectionError}</div>}<button className="primary-button" disabled={connection === 'loading'}>{connection === 'loading' ? '正在连接…' : '连接并读取'}</button></form></div>}
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
export function candidateReviewRecoveryKey(config:Pick<Config,'baseUrl'|'projectId'|'spaceId'|'purpose'>,
  recoveryScope:string,candidate:Pick<CandidateView,'candidateId'|'contentHash'>):string{
  return `knowledge-candidate-review:${JSON.stringify([config.baseUrl,config.projectId,config.spaceId,
    config.purpose,recoveryScope,candidate.candidateId,candidate.contentHash])}`;
}
export function candidateBelongsToResearch(result:Pick<ResearchResult,'candidateId'|'cognitiveOutcome'>|null,
  candidate:Pick<CandidateView,'candidateId'>|null):boolean{
  return !!result && !!candidate && result.cognitiveOutcome==='candidate' && result.candidateId===candidate.candidateId;
}
export function showLegacyResearchContext(result:Pick<ResearchResult,'candidateId'|'cognitiveOutcome'>|null,
  candidate:Pick<CandidateView,'candidateId'>|null):boolean{
  return !candidate || candidateBelongsToResearch(result,candidate);
}
export function CandidateLookupPanel({value,onChange,onSubmit,loading,error,candidate,result,onRead}: {
  value:string;onChange:(value:string)=>void;onSubmit:(event:FormEvent<HTMLFormElement>)=>void;
  loading:boolean;error:string;candidate:CandidateView|null;result:ResearchResult|null;onRead:(ref:KnowledgeRef)=>void;
}){
  return <section className="content-card candidate-lookup">
    <h2>按 ID 读取待审候选</h2>
    <form onSubmit={onSubmit} className="candidate-lookup-form">
      <label>待审候选 ID<input value={value} onChange={event=>onChange(event.target.value)}
        placeholder="输入候选 UUID" autoComplete="off" spellCheck={false} maxLength={80} required /></label>
      <button className="secondary-button" type="submit" disabled={loading||!value.trim()}>{loading?'正在读取…':'只读读取候选'}</button>
    </form>
    <p className="minor-note">仅按当前知识空间和用途读取准确候选；候选 ID 不会写入浏览器地址。</p>
    {error&&<div className="inline-error" role="alert">候选读取失败：{error}</div>}
    {candidate&&!candidateBelongsToResearch(result,candidate)&&<div className="candidate-standalone">
      <h2>独立读取的候选 · 修改前后</h2><CandidatePreview candidate={candidate} onRead={onRead} />
    </div>}
  </section>;
}
type ResearchTriptychProps = {
  documents: KnowledgeDocument[]; coReadingDocuments?: { ref: KnowledgeRef; document: KnowledgeDocument | null }[]; selectedDocument: KnowledgeDocument | null; graph: ReturnType<typeof toGraphView> | null;
  result: ResearchResult | null; candidate: CandidateView | null; candidateError: string; operation: Operation | null;
  onRead: (ref: KnowledgeRef) => void; onSource: (ref: KnowledgeRef) => void; onReloadCandidate: (id: string) => void;
};
export function ResearchTriptychWhenRelevant(props:ResearchTriptychProps){
  return showLegacyResearchContext(props.result,props.candidate)?<ResearchTriptych {...props}/>:null;
}
function ResearchTriptych({ documents, coReadingDocuments = [], selectedDocument, graph, result, candidate, candidateError, operation, onRead, onSource, onReloadCandidate }: ResearchTriptychProps) {
  const oldRefs = result?.exactReadset ?? [];
  const oldDocuments = oldRefs.map(ref => ({ ref, document: documents.find(item => refKey(item.ref) === refKey(ref)) ?? (selectedDocument && refKey(selectedDocument.ref) === refKey(ref) ? selectedDocument : null) }));
  const challenges = graph?.edges.filter(edge => edge.relation.stance === 'challenges') ?? [];
  return <div className="research-triptych">
    <section className="content-card research-column">
      <div className="eyebrow">01 · 研究前</div><h2>已有认识与准确读集</h2>
      {result ? <>
        <p className="minor-note">准确读集 {oldRefs.length} 项 · 继承依据 {result.inheritedBasis.length} 项 · 实际读取来源 {result.actualReadCoverage.length} 项。这三者含义不同。</p>
        {oldDocuments.length ? oldDocuments.map(({ ref, document }) => <div className="research-basis" key={refKey(ref)}><strong>{document?.title ?? '准确版本（正文未在当前列表加载）'}</strong>{document && <p>{document.body.slice(0, 130)}{document.body.length > 130 ? '…' : ''}</p>}<RefButton refValue={ref} onRead={onRead} onSource={onSource} /></div>) : <StateNote>研究结果没有列出旧认识读集。</StateNote>}
      </> : coReadingDocuments.length ? <><p className="minor-note">以下 {coReadingDocuments.length} 条为本地拟选；{operation ? '活动结果的准确读集尚未返回。' : '提交前尚未形成服务读集。'}</p>{coReadingDocuments.map(({ ref, document }) => <div className="research-basis" key={refKey(ref)}><strong>{document?.title ?? '准确版本正文未在当前范围加载'}</strong>{document && <p>{document.body.slice(0, 150)}{document.body.length > 150 ? '…' : ''}</p>}<RefButton refValue={ref} onRead={onRead} onSource={onSource} /></div>)}</> : selectedDocument ? <><p className="minor-note">以下仅为当前选择，尚未证明研究活动已读取。</p><div className="research-basis"><strong>{selectedDocument.title}</strong><p>{selectedDocument.body.slice(0, 150)}{selectedDocument.body.length > 150 ? '…' : ''}</p><RefButton refValue={selectedDocument.ref} onRead={onRead} onSource={onSource} /></div></> : <StateNote>选择图谱认识或通过问题查询后，可在这里核对旧认识。研究开始前没有已确认读集。</StateNote>}
    </section>
    <section className="content-card research-column research-middle">
      <div className="eyebrow">02 · 研究产出</div><h2>候选综合或研究结论</h2>
      {!result ? <StateNote>{operation ? `活动当前${statusName[operation.state] ?? operation.state}；还没有可核对的研究结论。` : '尚未提交研究，也没有候选正文。'}</StateNote> : <>
        <StatusPill tone={result.cognitiveOutcome === 'candidate' ? 'violet' : result.cognitiveOutcome === 'needs_evidence' ? 'amber' : 'blue'}>{outcomeName[result.cognitiveOutcome]}</StatusPill>
        <p className="research-reason">{researchReason(result.reason)}</p>
        {result.cognitiveOutcome === 'candidate' && (candidate ? <CandidatePreview candidate={candidate} onRead={onRead} /> : <div className="candidate-unloaded"><StateNote>{candidateError || '候选正文尚未从服务读取；不能凭结果摘要推断具体修订。'}</StateNote>{result.candidateId && <button className="secondary-button" onClick={() => onReloadCandidate(result.candidateId!)}>读取候选正文</button>}</div>)}
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

export function CandidatePreview({ candidate, onRead }: { candidate: CandidateView; onRead: (ref: KnowledgeRef) => void }) {
  const terminalMessage=candidateTerminalMessage(candidate.state);
  return <div className="candidate-body">
    <div className="candidate-meta">候选 {candidate.candidateId} · {candidate.state} · 提出者 {candidate.proposer}<br />内容摘要 {candidate.contentHash}</div>
    <p className="research-reason">{researchReason(candidate.rationale)}</p>
    {terminalMessage ? <p className="minor-note">{terminalMessage}此处保留修改前后的历史记录。</p>
      : candidate.state==='outcome_unknown' ? <p className="minor-note">候选状态待核对；当前不能审批。</p> : null}
    {candidate.state==='waiting_for_review' && candidate.reviewable === false && <div className="candidate-review-block" role="alert">
      <strong>当前候选不可批准</strong>
      {candidate.reviewIssues?.length ? <ul>{candidate.reviewIssues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>
        : <p>服务未附具体原因，请核对审阅状态。</p>}
    </div>}
    {candidate.state==='waiting_for_review' && candidate.reviewable === undefined && <p className="minor-note">服务未返回可批准判定；不能从候选状态推断可批准。</p>}
    {candidate.changes.map(change => <article className="candidate-change" key={refKey(change.ref)}>
      <h3>{change.title}</h3>
      {change.effect && <p className="candidate-meta">变更类型：{change.effect}</p>}
      <div className="candidate-compare">
        <section className="candidate-version candidate-version-before">
          <h4>修改前 · 准确版本</h4>
          {change.before === null ? <p className="minor-note">新建页：没有修改前版本。</p>
            : change.before ? <>
              <strong>{change.before.title}</strong>
              <p className="candidate-ref">历史准确版本 {change.before.ref.objectId} / {change.before.ref.versionId}</p>
              {change.before.ref.domain === 'knowledge' && change.before.ref.contentDigest &&
                change.before.ref.projectId === change.ref.projectId && change.before.ref.spaceId === change.ref.spaceId
                ? <button className="text-button" type="button" onClick={() => onRead(change.before!.ref)}>打开修改前准确版本</button>
                : <p className="minor-note">历史引用缺少当前空间内的准确内容摘要，暂不能直接打开。</p>}
              <p className="minor-note">此历史版本仅用于比较；能否按当前用途读取，以打开时的服务核对为准。</p>
              <div className="prose">{change.before.body}</div>
              <InfoList title="成立条件" items={change.before.conditions} />
              <InfoList title="反例" items={change.before.counterexamples} />
              <InfoList title="未知" items={change.before.unknowns} />
            </> : <p className="minor-note">旧候选未提供修改前版本；无法据此判断新建或修改。</p>}
        </section>
        <section className="candidate-version candidate-version-after">
          <h4>{change.before === null ? '新建候选' : '修改后 · 候选版本'}</h4>
          <strong>{change.title}</strong>
          <p className="candidate-ref">候选准确标识 {change.ref.objectId} / {change.ref.versionId}</p>
          <div className="prose">{change.body}</div>
          <InfoList title="成立条件" items={change.conditions} />
          <InfoList title="反例" items={change.counterexamples} />
          <InfoList title="未知" items={change.unknowns} />
          <InfoList title="后续问题" items={change.nextQuestions} />
          <div className="candidate-groups"><h5>来源组</h5>{change.sourceGroups.length ? <ul>{change.sourceGroups.map((group, index) =>
            <li key={`${group.id ?? 'unknown'}-${index}`}>{group.id ?? '未知同源组'} · {group.status} · {group.authority ?? '权威未记录'}</li>)}</ul>
            : <p className="muted">未列出来源组</p>}</div>
          <p className="minor-note">{candidate.state === 'published' ? '服务记录此候选曾发表；当前状态仍须打开准确版本核对。' : '候选尚不能作为当前认识使用。'}</p>
        </section>
      </div>
    </article>)}
  </div>;
}
function RefButton({ refValue, onRead, onSource }: { refValue: KnowledgeRef; onRead: (ref: KnowledgeRef) => void; onSource: (ref: KnowledgeRef) => void }) { return <button className="ref-button" onClick={() => { if (refValue.domain === 'knowledge') void onRead(refValue); else void onSource(refValue); }}><span>{refValue.domain} · {trimRef(refValue)}</span><ArrowRight size={15} /></button>; }
function DocumentInspector({ document, graph, onRead, onSource, onSelectRelation }: { document: KnowledgeDocument; graph: ReturnType<typeof toGraphView> | null; onRead: () => void; onSource: (ref: KnowledgeRef, locator: string | null) => void; onSelectRelation: (id: string) => void }) {
  const relations = graph ? selectedRelations(graph, refKey(document.ref)).sort((a, b) => ({ supports: 0, challenges: 1, context: 2, navigation: 3 })[a.relation.stance] - ({ supports: 0, challenges: 1, context: 2, navigation: 3 })[b.relation.stance] || a.id.localeCompare(b.id)) : [];
  const paragraphs = document.body.split(/\n\n+/).map(item => item.trim()).filter(item => item && item !== document.title);
  const summary = paragraphs.find(item => !/^(成立条件|反例与未知|反例与边界|尚不确定)[：:]/.test(item)) ?? document.body;
  return <><div className="inspector-body"><span className="eyebrow">准确认识 · {document.profile.id}</span><h2>{document.title}</h2><StatusPill tone={document.status.current ? 'violet' : 'amber'}>{document.status.current ? '当前版' : '历史版'}</StatusPill><p className="inspector-summary">{summary.length > 240 ? `${summary.slice(0, 240)}…` : summary}</p><InfoList title="成立条件" items={document.conditions} /><InfoList title="反例与边界" items={document.counterexamples} /><InfoList title="尚不确定" items={document.unknowns} /><div className="inspector-divider" /><h3>相关关系与挑战</h3>{relations.length ? relations.slice(0, 4).map(edge => <button className="relation-card" key={edge.id} onClick={() => onSelectRelation(edge.id)}><span className={`relation-dot stance-${edge.relation.stance}`} /><span><strong>{stanceName[edge.relation.stance]}</strong><small>{edge.relation.rationale ?? '理由未记录，打开关系查看准确范围'}</small><small>{edge.relation.targetStatementAnchor ? '已提供命题定位' : '未定位到具体句'} · {edge.relation.evidenceStatus === 'unknown' ? '依据状态未知' : edge.relation.evidenceStatus === 'observed' ? '已观察' : '未检验'}</small></span><ChevronRight size={18} /></button>) : <p className="muted">当前范围未返回关联依据。</p>}<section className="notebook-sources"><h3>原始依据</h3><p className="minor-note">{document.citations ? `${document.citations.length} 条直接引用 · ${document.sourceGroups.length} 个来源组` : '当前投影未提供直接引用'}。引用数量不代表独立支持数量，也不表示本次已读原件。</p>{document.citations?.map((citation, index) => <article key={`${refKey(citation.ref)}-${index}`}><span className="eyebrow">{citation.ref.domain === 'knowledge' ? '知识引用' : citation.ref.domain === 'source' ? '来源主张' : citation.ref.domain === 'analysis' ? '分析资料' : '证据原件'}</span><p>{citation.supports}</p><button className="text-button" onClick={() => onSource(citation.ref, citation.locator)}>查看准确来源 →</button><details><summary>准确标识与定位</summary><code>{refKey(citation.ref)} · {citation.locator ?? '定位未提供'}</code></details></article>)}{document.citations?.length === 0 && <p className="muted">此版本未列出直接引用。</p>}</section><details className="technical-ref"><summary>准确版本标识</summary><code>{refKey(document.ref)}</code></details><button className="read-button" onClick={onRead}><BookOpen size={19} />阅读完整正文与来源 <ArrowRight size={17} /></button></div></>;
}
function RelationInspector({ relation, graph, onRead, onSource }: { relation: Relation; graph: ReturnType<typeof toGraphView> | null; onRead: (ref: KnowledgeRef) => void; onSource: (ref: KnowledgeRef) => void }) {
  const from = graph?.nodes.find(node => node.id === refKey(relation.from));
  const to = graph?.nodes.find(node => node.id === refKey(relation.to));
  return <div className="inspector-body"><span className="eyebrow">关系 · {stanceName[relation.stance]}</span><h2>{from?.title ?? trimRef(relation.from)} → {to?.title ?? trimRef(relation.to)}</h2><StatusPill tone={relation.evidenceStatus === 'observed' ? 'blue' : 'amber'}>{relation.evidenceStatus === 'observed' ? '已观察' : relation.evidenceStatus === 'untested' ? '未检验' : '证据状态未知'}</StatusPill><p className="inspector-summary">{relation.rationale ?? '这条关系没有提供理由；界面不补造论证。'}</p><dl><dt>指向的判断</dt><dd>{relation.targetStatementAnchor ? `${relation.targetStatementAnchor.kind} · ${relation.targetStatementAnchor.value}` : '未定位到具体句'}</dd><dt>关键关系</dt><dd>{relation.critical ? '是' : '否'}</dd><dt>关系版本</dt><dd>{relation.relationVersion}</dd></dl><InfoList title="成立条件" items={relation.conditions} /><h3>连接的认识</h3><RefButton refValue={relation.from} onRead={onRead} onSource={onSource} /><RefButton refValue={relation.to} onRead={onRead} onSource={onSource} />{relation.sourceGroups.length > 0 && <p className="minor-note">来源组：{relation.sourceGroups.map(group => group.id ?? '未知').join('、')}</p>}</div>;
}
