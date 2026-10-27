import type { Citation, EvidenceAnchor, VersionRef } from '../../contracts/src/index.ts';
import type { KnowledgeKind } from './types.ts';

/** Display projection of authoritative versions. Positions and selection are UI state. */
export type GraphNodeKind = KnowledgeKind | 'analysis' | 'context' | 'source' | 'evidence' | 'asset';
export interface KnowledgeGraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  ref: VersionRef | null;
  knowledgeRef: VersionRef | null;
  anchor: EvidenceAnchor | null;
  assetVersionId: string | null;
  status: 'adopted' | 'exploration' | 'pending' | 'invalid' | 'source';
  summary: string;
}
export interface KnowledgeGraphEdge {
  id: string;
  source: string;
  target: string;
  role: 'derived_from' | 'supports' | 'challenges' | 'uses' | 'related' | 'contains';
  critical: boolean;
  label: string;
  detailAvailable?: boolean;
  rationale?: string; conditions?: string[]; citations?: Citation[];
  sourceRef?: VersionRef; targetRef?: VersionRef; purpose?: string; reviewRef?: VersionRef;
}
export interface KnowledgeGraphProjection {
  schemaVersion: '1.0';
  projectId: string;
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  truncated: boolean;
  scope: 'bounded_neighborhood';
  completeness: 'incomplete';
  limits: { knowledge: number; nodes: number; edges: number };
}
export interface KnowledgeGraphImpact {
  rootId: string;
  affectedIds: string[];
  criticalEdgeIds: string[];
  complete: boolean;
}
