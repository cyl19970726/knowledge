import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createCaseFieldReadingRef, validateCaseFieldReadingRef } from '../src/case-field-reading.ts';
import { createSourceCaseReading } from '../src/source-case-reading.ts';
import { digest } from '../src/utils.ts';
import type { KnowledgeRevision } from '../src/types.ts';
import { caseRevision, ref, scope, SyntheticAnalysis, timestamp } from './service-fixtures.ts';
import { createResearchSourceProjection } from '../src/research-projection.ts';
import { CollectionContentSchema, ComparisonContentSchema } from '../src/schemas.ts';

function fixture(){
  const projectId=`case-reading-${randomUUID()}`,product=ref();
  const {result,snapshot,anchor}=new SyntheticAnalysis().add(projectId);
  const base=caseRevision(projectId,product,result,anchor,'Selected source');
  if(base.kind!=='case')throw new Error('Expected Case');
  const sourceProjection=createResearchSourceProjection({result,sourceGroup:`media-sha256:${snapshot.original.sha256}`,
    payload:{schemaVersion:'video-overview@1',profile:'overview',evidenceIndex:[],
      screening:{creative:{transferConditions:[{condition:'Original condition',action:'Original action'}]}},
      unknowns:['Audio not checked'],otherPrivateField:'Not selected'}});
  const revision:KnowledgeRevision={...base,scope:scope(product),createdAt:timestamp,
    content:{...base.content,schemaVersion:'1.1',sourceProjection}};
  return revision;
}

test('field reading ref binds exact Case revision and complete selected original projection without copying values',()=>{
  const revision=fixture(),reading=createCaseFieldReadingRef(revision);
  if(revision.kind!=='case')throw new Error('Expected Case');
  assert.equal(reading.fullRevisionHash,digest(revision));
  assert.deepEqual(reading.selectedSourceFieldPaths,
    createSourceCaseReading(revision.content.sourceProjection!).selectedSourceFieldPaths);
  assert.equal(validateCaseFieldReadingRef(revision,reading),true);
  assert.equal('originalRecord' in reading,false);
  assert.equal('sourceProjection' in reading,false);
  assert.equal(reading.selectedSourceFieldPaths.includes('/otherPrivateField'),false);
});

test('field reading ref rejects wrong Case, changed revision, changed projection, unread or reordered paths',()=>{
  const revision=fixture(),reading=createCaseFieldReadingRef(revision);
  assert.equal(validateCaseFieldReadingRef(revision,{...reading,caseRef:ref()}),false);
  assert.equal(validateCaseFieldReadingRef(revision,{...reading,fullRevisionHash:'a'.repeat(64)}),false);
  assert.equal(validateCaseFieldReadingRef(revision,{...reading,projectionDigest:'b'.repeat(64)}),false);
  assert.equal(validateCaseFieldReadingRef(revision,{...reading,selectedSourceFieldPaths:[...reading.selectedSourceFieldPaths,'/otherPrivateField']}),false);
  assert.equal(validateCaseFieldReadingRef(revision,{...reading,selectedSourceFieldPaths:[...reading.selectedSourceFieldPaths].reverse()}),false);
  if(revision.kind!=='case')throw new Error('Expected Case');
  const changed=structuredClone(revision);
  if(changed.kind!=='case')throw new Error('Expected Case');
  changed.content.sourceProjection!.source.quality.review='failed';
  assert.equal(validateCaseFieldReadingRef(changed,reading),false);
  changed.content.sourceProjection!.fields.push({path:'/source/quality',presence:'present',value:{review:'shadow'}});
  assert.equal(validateCaseFieldReadingRef(changed,reading),false);
});

test('coarse field basis is limited to descriptive examples and cannot masquerade as support',()=>{
  const revision=fixture(),fieldReading=createCaseFieldReadingRef(revision),collectionRef=ref();
  const member={ref:revision.ref,role:'example',reason:'Exact selected fields',
    evidenceBasis:'case_field_reading',caseFieldReadingRef:fieldReading};
  const collection={ref:collectionRef,projectId:revision.projectId,title:'Descriptive examples',question:'How is it expressed?',
    members:[member],exclusions:[],samplingFrame:'One exact Case',window:null};
  const comparison={ref:ref(),projectId:revision.projectId,title:'Descriptive reading',collectionRef,
    researchKind:'descriptive',crossCaseFindings:[{text:'Two exact examples differ',memberRefs:[revision.ref,ref()]}],
    dimensions:[{name:'Expression',observations:[{memberRef:revision.ref,observation:'Original expression',citations:[],
      evidenceBasis:'case_field_reading',caseFieldReadingRef:fieldReading}]}],incomparable:[],unresolved:[]};
  assert.equal(CollectionContentSchema.safeParse(collection).success,true);
  assert.equal(ComparisonContentSchema.safeParse(comparison).success,true);
  assert.equal(CollectionContentSchema.safeParse({...collection,members:[{...member,role:'support'}]}).success,false);
  assert.equal(ComparisonContentSchema.safeParse({...comparison,researchKind:undefined,crossCaseFindings:undefined}).success,false);
});
