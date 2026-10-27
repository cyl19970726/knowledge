import type { VersionRef } from '../../contracts/src/index.ts';
import { z } from 'zod';
import { VersionRefSchema } from '../../contracts/src/index.ts';

/** The semantic identity belongs to the question and source trigger, never to output heads. */
export const VIDEO_TOPIC_SYNTHESIS_METHOD = 'knowledge.cognition.v1' as const;
/** Narrow, issue-bound review; the v1 job command remains the durable execution envelope. */
export const VIDEO_TOPIC_SYNTHESIS_METHOD_REVIEWED = 'knowledge.cognition.v2' as const;
export type VideoTopicSynthesisMethodVersion=typeof VIDEO_TOPIC_SYNTHESIS_METHOD|typeof VIDEO_TOPIC_SYNTHESIS_METHOD_REVIEWED;
export interface VideoTopicSynthesisEvaluationAuthorization {
  rootRunId:string;
  authorizationRef:string;
  methodVersion:typeof VIDEO_TOPIC_SYNTHESIS_METHOD_REVIEWED;
}
export const VIDEO_TOPIC_SYNTHESIS_PURPOSE = 'exploration_reading' as const;
export type VideoTopicSynthesisChangeKind = 'initial' | 'recognition_changed' | 'basis_added' | 'format_only';
export interface VideoTopicSynthesisBasisPointer {
  caseRef: VersionRef;
  fieldPath: string;
  recordPointer: string;
}
export interface VideoTopicSynthesisFinding {
  text: string;
  conditions: string[];
  basis: VideoTopicSynthesisBasisPointer[];
}
export interface VideoTopicSynthesisMetadata {
  methodVersion: VideoTopicSynthesisMethodVersion;
  problemId: string;
  unitKey: string;
  question: string;
  changeKind: VideoTopicSynthesisChangeKind;
  findings: VideoTopicSynthesisFinding[];
}
export const VideoTopicSynthesisMetadataValidator = z.strictObject({
  methodVersion:z.enum([VIDEO_TOPIC_SYNTHESIS_METHOD,VIDEO_TOPIC_SYNTHESIS_METHOD_REVIEWED]),problemId:z.string().trim().min(1).max(200),
  unitKey:z.string().trim().min(1).max(120),question:z.string().trim().min(1).max(1000),
  changeKind:z.enum(['initial','recognition_changed','basis_added','format_only']),
  findings:z.array(z.strictObject({text:z.string().trim().min(1).max(4000),
    conditions:z.array(z.string().trim().min(1).max(1000)).max(12),
    basis:z.array(z.strictObject({caseRef:VersionRefSchema,fieldPath:z.string().startsWith('/'),
      recordPointer:z.string()})).min(1).max(30)})).min(1).max(12),
});
export interface VideoTopicSynthesisCommand {
  commandVersion: typeof VIDEO_TOPIC_SYNTHESIS_METHOD;
  projectId: string;
  buildId: string;
  manifestHash: string;
}
export type VideoTopicSynthesisOutcome = 'changed' | 'maintained' | 'restricted' | 'failed' | 'unknown';
