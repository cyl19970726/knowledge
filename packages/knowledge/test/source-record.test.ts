import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { ResearchSourceProjection } from '../../contracts/src/index.ts';
import { ComparisonContentSchema, CollectionContentSchema } from '../src/schemas.ts';
import { enumerateSourceCaseRecords, validateSourceRecordRef } from '../src/source-record.ts';

const ref=()=>({objectId:randomUUID(),versionId:randomUUID()});
const caseRef=ref(),analysisRef=ref();
const source={schemaVersion:'research-source-projection@1',source:{projectId:'local-perseek',sourceGroup:'media-sha256:test',
  analysisRef,assetVersionId:randomUUID(),profile:'overview',payloadSchemaVersion:'video-overview@2',
  createdAt:'2026-10-20T00:00:00.000Z',question:'What is shown?',purpose:'exploration_reading',
  quality:{candidate:'original_reviewed',review:'completed_no_findings'},coverage:{requested:{kind:'whole'},
    observed:[{kind:'whole'}],gaps:['Audio not checked'],channels:['visual']}},
  fields:[{path:'/commonObservations',presence:'present',value:[
    {text:'Post says read the written answer',evidenceRefs:['POST-1'],conditions:['post exists']},
    {text:'ASR transcript is registration metadata',evidenceRefs:['ASR-1']} ]},
    {path:'/screening',presence:'present',value:{creative:{priority:'high',transferConditions:[
      {condition:'Reader opens the post',action:'Show the next step',evidenceRefs:['POST-1']}]}}},
    {path:'/missing',presence:'absent'}],evidenceAliases:[]} as unknown as ResearchSourceProjection;

test('enumerates whole original units with canonical pointers and fixed metadata only',()=>{
  const records=enumerateSourceCaseRecords(source);
  assert.deepEqual(records.filter(row=>row.fieldPath==='/commonObservations').map(row=>row.recordPointer),['/0','/1']);
  assert.deepEqual(records.find(row=>row.recordPointer==='/0')?.originalRecord,
    {text:'Post says read the written answer',evidenceRefs:['POST-1'],conditions:['post exists']});
  assert.ok(records.some(row=>row.fieldPath==='/screening'&&row.recordPointer==='/creative'));
  assert.ok(records.some(row=>row.fieldPath==='/source/coverage/channels'&&row.recordPointer===''));
  assert.ok(records.some(row=>row.fieldPath==='/source/quality'&&row.recordPointer===''));
  assert.equal(records.some(row=>row.fieldPath==='/missing'),false);
  assert.equal(records.some(row=>row.fieldPath==='/source/assetVersionId'),false);
});

test('exact record rejects changed value, pointer, case, duplicate field and scalar fragment',()=>{
  const record={caseRef,...enumerateSourceCaseRecords(source).find(row=>row.recordPointer==='/0')!};
  assert.equal(validateSourceRecordRef({ref:caseRef,sourceProjection:source},record),true);
  assert.equal(validateSourceRecordRef({ref:caseRef,sourceProjection:source},{...record,recordPointer:'/00'}),false);
  assert.equal(validateSourceRecordRef({ref:caseRef,sourceProjection:source},{...record,originalRecord:{text:'fabricated frame'}}),false);
  assert.equal(validateSourceRecordRef({ref:ref(),sourceProjection:source},record),false);
  assert.equal(validateSourceRecordRef({ref:caseRef,sourceProjection:{...source,fields:[...source.fields,source.fields[0]!]}},record),false);
  assert.equal(validateSourceRecordRef({ref:caseRef,sourceProjection:source},{...record,recordPointer:'/0/text',originalRecord:'Post says read the written answer'}),false);
});

test('reserved source metadata cannot be shadowed by a same-path source field',()=>{
  const shadow={...source,fields:[...source.fields,
    {path:'/source/quality',presence:'present',value:{candidate:'invented_media_quality'}},
    {path:'/source/coverage/channels',presence:'present',value:['audio']}] } as ResearchSourceProjection;
  const records=enumerateSourceCaseRecords(shadow);
  assert.deepEqual(records.filter(row=>row.fieldPath==='/source/quality'),
    [{fieldPath:'/source/quality',recordPointer:'',originalRecord:source.source.quality}]);
  assert.deepEqual(records.filter(row=>row.fieldPath==='/source/coverage/channels'),
    [{fieldPath:'/source/coverage/channels',recordPointer:'',originalRecord:['visual']}]);
  assert.equal(validateSourceRecordRef({ref:caseRef,sourceProjection:shadow},
    {caseRef,fieldPath:'/source/quality',recordPointer:'',originalRecord:{candidate:'invented_media_quality'}}),false);
  assert.equal(validateSourceRecordRef({ref:caseRef,sourceProjection:shadow},
    {caseRef,fieldPath:'/source/quality',recordPointer:'',originalRecord:source.source.quality}),true);
});

test('source_record persists post and ASR records without pretending either is a media citation; old branches remain readable',()=>{
  const [post,asr]=enumerateSourceCaseRecords(source).filter(row=>row.fieldPath==='/commonObservations');
  const refs=[post!,asr!].map(row=>({caseRef,...row}));
  const collection={ref:ref(),projectId:'local-perseek',title:'Source records',question:'What is in the source?',
    members:[{ref:caseRef,role:'support',reason:'Written post supplies the next step',evidenceBasis:'source_record',sourceRecordRefs:refs}],
    exclusions:[],samplingFrame:'One exact source Case',window:null};
  const comparison={ref:ref(),projectId:'local-perseek',title:'Source comparison',collectionRef:collection.ref,
    dimensions:[{name:'Content',observations:[{memberRef:caseRef,observation:'Post and ASR are distinct source records',
      citations:[],evidenceBasis:'source_record',sourceRecordRefs:refs}]}],incomparable:[],unresolved:[]};
  assert.equal(CollectionContentSchema.safeParse(collection).success,true);
  assert.equal(ComparisonContentSchema.safeParse(comparison).success,true);
  const forged=structuredClone(comparison);forged.dimensions[0]!.observations[0]!.citations=[{kind:'media'}] as never;
  assert.equal(ComparisonContentSchema.safeParse(forged).success,false);
  const mixed=structuredClone(comparison);(mixed.dimensions[0]!.observations[0] as Record<string,unknown>).caseFactRefs=[{caseRef}];
  assert.equal(ComparisonContentSchema.safeParse(mixed).success,false);
  assert.equal(ComparisonContentSchema.safeParse({...comparison,dimensions:[{name:'可比范围',observations:[
    {memberRef:caseRef,observation:'Registered quality',citations:[],evidenceBasis:'case_metadata',
      caseFactRefs:[{caseRef,basis:'source_quality',path:'/source/quality',value:source.source.quality}]}]}]}).success,true);
});

test('source_record retains eleven through thirty exact refs and rejects the thirty-first',()=>{
  const base=enumerateSourceCaseRecords(source).find(row=>row.fieldPath==='/commonObservations'&&row.recordPointer==='/0')!;
  const sourceRecordRefs=Array.from({length:30},()=>({caseRef,...base}));
  const collection={ref:ref(),projectId:'local-perseek',title:'Complete source chain',question:'What does the source say?',
    members:[{ref:caseRef,role:'support',reason:'All records are retained',evidenceBasis:'source_record',sourceRecordRefs}],
    exclusions:[],samplingFrame:'One exact source Case',window:null};
  const comparison={ref:ref(),projectId:'local-perseek',title:'Complete source comparison',collectionRef:collection.ref,
    dimensions:[{name:'Original chain',observations:[{memberRef:caseRef,observation:'All exact source records remain attached',
      citations:[],evidenceBasis:'source_record',sourceRecordRefs}]}],incomparable:[],unresolved:[]};
  const parsedCollection=CollectionContentSchema.parse(collection),parsedComparison=ComparisonContentSchema.parse(comparison);
  assert.equal(parsedCollection.members[0]!.sourceRecordRefs?.length,30);
  assert.equal(parsedComparison.dimensions[0]!.observations[0]!.sourceRecordRefs?.length,30);
  const tooMany=[...sourceRecordRefs,{caseRef,...base}];
  assert.equal(CollectionContentSchema.safeParse({...collection,members:[{...collection.members[0],sourceRecordRefs:tooMany}]}).success,false);
  assert.equal(ComparisonContentSchema.safeParse({...comparison,dimensions:[{name:'Original chain',observations:[
    {...comparison.dimensions[0]!.observations[0],sourceRecordRefs:tooMany}]}]}).success,false);
});

test('descriptive comparison requires cross-case references while legacy roles remain readable',()=>{
  const otherCaseRef=ref(),collectionRef=ref(),comparisonRef=ref();
  const collection={ref:collectionRef,projectId:'local-perseek',title:'Descriptive set',question:'How do two examples differ?',
    members:[{ref:caseRef,role:'example',reason:'First exact source'},
      {ref:otherCaseRef,role:'example',reason:'Second exact source'}],
    exclusions:[],samplingFrame:'Two exact original groups',window:null};
  const comparison={ref:comparisonRef,projectId:'local-perseek',title:'Descriptive comparison',collectionRef,
    researchKind:'descriptive',crossCaseFindings:[{text:'The recorded structures differ',memberRefs:[caseRef,otherCaseRef]}],
    dimensions:[{name:'Expression',observations:[{memberRef:caseRef,observation:'First structure',citations:[],
      evidenceBasis:'source_record',sourceRecordRefs:[{caseRef,...enumerateSourceCaseRecords(source)[0]!}]}]}],
    incomparable:[],unresolved:[]};
  assert.equal(CollectionContentSchema.safeParse(collection).success,true);
  assert.equal(ComparisonContentSchema.safeParse(comparison).success,true);
  assert.equal(ComparisonContentSchema.safeParse({...comparison,crossCaseFindings:[]}).success,false);
  assert.equal(ComparisonContentSchema.safeParse({...comparison,crossCaseFindings:[{text:'Single',memberRefs:[caseRef]}]}).success,false);
  assert.equal(ComparisonContentSchema.safeParse({...comparison,researchKind:undefined}).success,false);
  assert.equal(CollectionContentSchema.safeParse({...collection,members:[{...collection.members[0],role:'support'}]}).success,true);
  assert.equal(ComparisonContentSchema.safeParse({...comparison,researchKind:undefined,crossCaseFindings:undefined}).success,true);
});
