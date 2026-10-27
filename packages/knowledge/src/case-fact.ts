import { z } from 'zod';
import { VersionRefSchema, type VersionRef } from '../../contracts/src/index.ts';
import type { ResearchSourceProjection } from '../../contracts/src/index.ts';
import { canonical } from './utils.ts';

export const CASE_FACT_PATHS=[
  '/source/coverage/channels','/source/coverage/gaps','/source/quality',
  '/coverageState','/reconstruction/coverageState','/coverageMatrix','/reconstruction/coverageMatrix',
  '/metaGate','/reconstruction/metaGate','/screening','/screening/product','/screening/creative','/unknowns',
  '/reconstruction/builderLenses/finalSummary/limits',
] as const;
export const CASE_FACT_BASES=['coverage_boundary','registered_unknown','screening_record','source_quality','source_limit'] as const;
const BASIS_BY_PATH:Record<(typeof CASE_FACT_PATHS)[number],(typeof CASE_FACT_BASES)[number]>={
  '/source/coverage/channels':'coverage_boundary','/source/coverage/gaps':'coverage_boundary',
  '/source/quality':'source_quality','/coverageState':'coverage_boundary','/reconstruction/coverageState':'coverage_boundary',
  '/coverageMatrix':'coverage_boundary','/reconstruction/coverageMatrix':'coverage_boundary',
  '/metaGate':'coverage_boundary','/reconstruction/metaGate':'coverage_boundary',
  '/screening':'screening_record','/screening/product':'screening_record','/screening/creative':'screening_record',
  '/unknowns':'registered_unknown','/reconstruction/builderLenses/finalSummary/limits':'source_limit',
};
export const CaseFactRefSchema=z.strictObject({caseRef:VersionRefSchema,basis:z.enum(CASE_FACT_BASES),
  path:z.enum(CASE_FACT_PATHS),value:z.json()}).superRefine((fact,context)=>{
  if(BASIS_BY_PATH[fact.path]!==fact.basis)context.addIssue({code:'custom',path:['basis'],message:'Case fact basis does not match its whitelisted metadata path'});
});
export type CaseFactRef=z.infer<typeof CaseFactRefSchema>;

/** Reads only host-registered boundary and source metadata, never a free-form Case body. */
export function readCaseFact(projection:ResearchSourceProjection,path:string):unknown{
  switch(path){
    case '/source/coverage/channels':return projection.source.coverage.channels;
    case '/source/coverage/gaps':return projection.source.coverage.gaps;
    case '/source/quality':return projection.source.quality;
    default:{
      if(!(CASE_FACT_PATHS as readonly string[]).includes(path)||path.startsWith('/source/'))return undefined;
      const matches=projection.fields.filter(item=>item.path===path);
      return matches.length===1&&matches[0]!.presence==='present'?matches[0]!.value:undefined;
    }
  }
}

export function caseFactBasis(path:string):CaseFactRef['basis']|null{
  return (CASE_FACT_PATHS as readonly string[]).includes(path)?BASIS_BY_PATH[path as keyof typeof BASIS_BY_PATH]:null;
}

export function validateCaseFactRef(input:{ref:VersionRef;sourceProjection?:ResearchSourceProjection},fact:CaseFactRef):boolean{
  if(input.ref.objectId!==fact.caseRef.objectId||input.ref.versionId!==fact.caseRef.versionId||!input.sourceProjection)return false;
  const parsed=CaseFactRefSchema.safeParse(fact);
  if(!parsed.success)return false;
  const actual=readCaseFact(input.sourceProjection,fact.path);
  return actual!==undefined&&canonical(actual)===canonical(fact.value);
}
