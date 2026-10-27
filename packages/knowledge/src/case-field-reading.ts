import { z } from 'zod';
import { Sha256Schema, VersionRefSchema } from '../../contracts/src/index.ts';
import type { KnowledgeRevision } from './types.ts';
import { createSourceCaseReading } from './source-case-reading.ts';
import { digest, sameRef } from './utils.ts';

/** Exact Case and selected original fields read as one coarse-grained source basis. */
export const CaseFieldReadingRefSchema=z.strictObject({caseRef:VersionRefSchema,
  fullRevisionHash:Sha256Schema,selectedSourceFieldPaths:z.array(z.string().startsWith('/')).max(100),
  projectionDigest:Sha256Schema});
export type CaseFieldReadingRef=z.infer<typeof CaseFieldReadingRefSchema>;

export function createCaseFieldReadingRef(revision:KnowledgeRevision):CaseFieldReadingRef{
  if(revision.kind!=='case'||!revision.content.sourceProjection||
    !['1.1','2.0'].includes(revision.content.schemaVersion)||!sameRef(revision.ref,revision.content.ref)||
    !sameRef(revision.content.analysisResultRef,revision.content.sourceProjection.source.analysisRef)||
    revision.projectId!==revision.content.sourceProjection.source.projectId)
    throw new Error('CASE_FIELD_READING_SOURCE_INVALID');
  const selected=createSourceCaseReading(revision.content.sourceProjection);
  const fullRevisionHash=digest(revision);
  const projectionDigest=digest({caseRef:revision.ref,fullRevisionHash,
    selectedSourceFieldPaths:selected.selectedSourceFieldPaths,sourceProjection:selected.sourceProjection});
  return CaseFieldReadingRefSchema.parse({caseRef:revision.ref,fullRevisionHash,
    selectedSourceFieldPaths:selected.selectedSourceFieldPaths,projectionDigest});
}

export function validateCaseFieldReadingRef(revision:KnowledgeRevision,ref:CaseFieldReadingRef):boolean{
  if(!CaseFieldReadingRefSchema.safeParse(ref).success)return false;
  try{
    const exact=createCaseFieldReadingRef(revision);
    return sameRef(exact.caseRef,ref.caseRef)&&exact.fullRevisionHash===ref.fullRevisionHash&&
      exact.projectionDigest===ref.projectionDigest&&
      exact.selectedSourceFieldPaths.length===ref.selectedSourceFieldPaths.length&&
      exact.selectedSourceFieldPaths.every((path,index)=>path===ref.selectedSourceFieldPaths[index]);
  }catch{return false;}
}
