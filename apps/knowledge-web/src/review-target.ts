import type { CandidateView, ResearchResult, ReviewRequest } from '@commerce/knowledge-contracts';

/** Candidate review is bound to the fetched staged content, never the result digest. */
export function reviewTargetFor(result: ResearchResult | null, candidate: CandidateView | null): ReviewRequest['target'] | null {
  if (!result) return null;
  if (result.cognitiveOutcome === 'candidate') {
    if (!result.candidateId || !candidate || candidate.candidateId !== result.candidateId || candidate.state !== 'waiting_for_review') return null;
    return { kind: 'candidate', candidateId: candidate.candidateId, contentHash: candidate.contentHash };
  }
  return { kind: 'research_result', researchId: result.researchId, resultDigest: result.resultDigest };
}
