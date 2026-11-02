import type { CandidateView } from '@commerce/knowledge-contracts';

/** Accept only the candidate requested for the active purpose and space. */
export function verifiedCandidateView(candidate: CandidateView, id: string, purpose: string, projectId: string, spaceId: string): CandidateView | null {
  return candidate.candidateId === id && candidate.purpose === purpose && candidate.changes.every(change =>
    change.ref.projectId === projectId && change.ref.spaceId === spaceId) ? candidate : null;
}
