import test from 'node:test';
import assert from 'node:assert/strict';
import {createSourceCaseReading} from '../src/source-case-reading.ts';
import {ResearchSourceProjectionSchema} from '../../contracts/src/index.ts';

test('source reading keeps complete selected records and only their original aliases',()=>{
  const source=ResearchSourceProjectionSchema.parse({schemaVersion:'research-source-projection@1',
    source:{projectId:'sample',sourceGroup:`media-sha256:${'a'.repeat(64)}`,
      analysisRef:{objectId:'11111111-1111-4111-8111-111111111111',versionId:'22222222-2222-4222-8222-222222222222'},
      assetVersionId:'33333333-3333-4333-8333-333333333333',profile:'fine',payloadSchemaVersion:'video-fine@1',
      createdAt:'2026-10-20T00:00:00.000Z',question:'What happens?',purpose:'exploration',
      quality:{candidate:'original_reviewed',review:'completed_with_findings'},
      coverage:{requested:{kind:'whole'},observed:[{kind:'whole'}],gaps:['no audio'],channels:['visual']}},
    fields:[{path:'/reconstruction/knowledgeUnits',presence:'present',value:[{id:'KU1',detail:'Full original unit',evidenceRefs:['A']}]},
      {path:'/reconstruction/builderLenses/finalSummary/reusableLessons',presence:'present',value:[
        {conditions:'Exact condition',action:'Exact action',evidenceRefs:['A']}]},
      {path:'/reconstruction/coverageMatrix',presence:'present',value:[{large:'Host-only field',evidenceRefs:['B']}]}],
    evidenceAliases:[{localId:'A',status:'unresolved',reason:'not_registered'},
      {localId:'B',status:'unresolved',reason:'not_registered'}]});
  const reading=createSourceCaseReading(source);
  assert.deepEqual(reading.sourceProjection.fields,source.fields.slice(0,2));
  assert.deepEqual(reading.sourceProjection.evidenceAliases,source.evidenceAliases.slice(0,1));
  assert.deepEqual(reading.selectedSourceFieldPaths,source.fields.slice(0,2).map(x=>x.path));
  assert.deepEqual(reading.omittedSourceFieldPaths,['/reconstruction/coverageMatrix']);
  assert.deepEqual(reading.sourceProjection.source,source.source);
  assert.throws(()=>createSourceCaseReading({...source,evidenceAliases:[]}),/SOURCE_CASE_READING_MISSING_ALIAS:A/);
  assert.throws(()=>createSourceCaseReading({...source,evidenceAliases:[...source.evidenceAliases,source.evidenceAliases[0]!]}),
    /SOURCE_CASE_READING_DUPLICATE_ALIAS:A/);
});
