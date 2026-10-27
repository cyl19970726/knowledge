import { z } from 'zod';
import { AnalysisAdoptionRecordSchema,MediaScopeSchema,VersionRefSchema,type VersionRef } from '../../contracts/src/index.ts';
import { ScopedUseDecisionSchema } from './admission.ts';
import { digest } from './utils.ts';

export const COVERAGE_CONTRACT_VERSION='report-evidence-admission-v1' as const;

export interface EvidenceReport {
  ref:VersionRef; coverage:unknown; adoptionEpoch:number; adoptions:unknown[];
  scopedDecisions:unknown[]; membership?:{id:string;version:number}; validityFingerprint?:string;
}
export interface EvidenceTopic {id:string;version:number;question:string}

const coverageSchema=z.strictObject({requested:MediaScopeSchema,observed:z.array(MediaScopeSchema).max(1000),
  gaps:z.array(z.string().min(1)).max(100),channels:z.array(z.enum(['visual','audio','captions'])).max(3)});
const legacyFields=new Set(['ref','coverage','adoptionEpoch','adoptions','scopedDecisions','membership',
  'validityFingerprint','estimatedInputBytes','processingFingerprint']);
const currentFields=new Set([...legacyFields,'evidenceAdmissionFingerprint']);

/** Daily research and byte estimates can change synthesis, but cannot revoke admitted evidence. */
export function evidenceAdmissionFingerprint(report:EvidenceReport,topic:EvidenceTopic,
  options:{legacyFrozen?:boolean;allowStoredFingerprint?:boolean}={}):string|null {
  if(!report||typeof report!=='object')return null;
  const record=report as unknown as Record<string,unknown>;
  const allowed=options.legacyFrozen&&!options.allowStoredFingerprint?legacyFields:currentFields;
  if(Object.keys(record).some(key=>!allowed.has(key))||
    !VersionRefSchema.safeParse(report.ref).success||!coverageSchema.safeParse(report.coverage).success||
    !Number.isSafeInteger(report.adoptionEpoch)||!Array.isArray(report.adoptions)||
    report.adoptions.some(item=>!AnalysisAdoptionRecordSchema.safeParse(item).success)||
    !Array.isArray(report.scopedDecisions)||
    report.scopedDecisions.some(item=>!ScopedUseDecisionSchema.safeParse(item).success)||
    !report.membership||Object.keys(report.membership).some(key=>key!=='id'&&key!=='version')||
    typeof report.membership.id!=='string'||!Number.isSafeInteger(report.membership.version)||
    typeof report.validityFingerprint!=='string'||
    (options.legacyFrozen&&typeof record.processingFingerprint!=='string')||
    (record.estimatedInputBytes!==undefined&&(!Number.isSafeInteger(record.estimatedInputBytes)||Number(record.estimatedInputBytes)<0))||
    !topic||typeof topic.id!=='string'||!Number.isSafeInteger(topic.version)||typeof topic.question!=='string')return null;
  return digest({coverageContractVersion:COVERAGE_CONTRACT_VERSION,
    topic:{id:topic.id,version:topic.version,question:topic.question},
    report:{ref:report.ref,coverage:report.coverage,adoptionEpoch:report.adoptionEpoch,
      adoptions:report.adoptions,scopedDecisions:report.scopedDecisions,
      membership:report.membership,validityFingerprint:report.validityFingerprint}});
}
