import { z } from 'zod';
import { VersionRefSchema, type ResearchSourceProjection, type VersionRef } from '../../contracts/src/index.ts';
import { canonical } from './utils.ts';

export const SourceRecordRefSchema=z.strictObject({caseRef:VersionRefSchema,
  fieldPath:z.string().startsWith('/'),recordPointer:z.string(),originalRecord:z.json()});
export type SourceRecordRef=z.infer<typeof SourceRecordRefSchema>;
export type SourceRecord=Pick<SourceRecordRef,'fieldPath'|'recordPointer'|'originalRecord'>;

const escapeToken=(token:string)=>token.replaceAll('~','~0').replaceAll('/','~1');
const isRecord=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const metadataPaths=new Set(['/source/coverage/channels','/source/coverage/gaps','/source/quality']);

/** Enumerates exact, bounded units within present source fields; pointers are relative to field.value. */
export function enumerateSourceCaseRecords(source:ResearchSourceProjection):SourceRecord[]{
  const records:SourceRecord[]=[];
  const emit=(fieldPath:string,recordPointer:string,originalRecord:unknown)=>{
    if(z.json().safeParse(originalRecord).success)
      records.push({fieldPath,recordPointer,originalRecord:structuredClone(originalRecord) as SourceRecord['originalRecord']});
  };
  const visit=(fieldPath:string,pointer:string,value:unknown):void=>{
    if(Array.isArray(value)){
      value.forEach((item,index)=>emit(fieldPath,`${pointer}/${index}`,item));
      return;
    }
    if(!isRecord(value)){emit(fieldPath,pointer,value);return;}
    if(Object.hasOwn(value,'evidenceRefs')){emit(fieldPath,pointer,value);return;}
    if(Object.values(value).some(child=>child===null||typeof child!=='object')){
      emit(fieldPath,pointer,value);return;
    }
    const children=Object.entries(value).filter(([,child])=>child!==null&&typeof child==='object');
    if(!children.length){emit(fieldPath,pointer,value);return;}
    for(const [key,child] of children)visit(fieldPath,`${pointer}/${escapeToken(key)}`,child);
  };
  for(const field of source.fields)if(field.presence==='present'&&!metadataPaths.has(field.path))visit(field.path,'',field.value);
  emit('/source/coverage/channels','',source.source.coverage.channels);
  emit('/source/coverage/gaps','',source.source.coverage.gaps);
  emit('/source/quality','',source.source.quality);
  return records;
}

/** Exact Case identity, unique present field, canonical pointer and original JSON value. */
export function validateSourceRecordRef(input:{ref:VersionRef;sourceProjection?:ResearchSourceProjection},record:SourceRecordRef):boolean{
  if(!SourceRecordRefSchema.safeParse(record).success||!input.sourceProjection||
    input.ref.objectId!==record.caseRef.objectId||input.ref.versionId!==record.caseRef.versionId)return false;
  if(!metadataPaths.has(record.fieldPath)&&
    (input.sourceProjection.fields.filter(field=>field.path===record.fieldPath&&field.presence==='present').length!==1||
      input.sourceProjection.fields.filter(field=>field.path===record.fieldPath).length!==1))return false;
  return enumerateSourceCaseRecords(input.sourceProjection).some(item=>item.fieldPath===record.fieldPath&&
    item.recordPointer===record.recordPointer&&canonical(item.originalRecord)===canonical(record.originalRecord));
}
