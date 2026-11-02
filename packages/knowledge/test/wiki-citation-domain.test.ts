import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {CitationSchema} from '../../contracts/src/index.ts';
import {WikiPageContentSchema,wikiPageFrozenDependencies} from '../src/wiki-page.ts';
import {createKnowledgeGraphProjection} from '../src/graph.ts';
import type {KnowledgeService} from '../src/service.ts';
import type {KnowledgeRevision,RevisionView} from '../src/types.ts';

const sourceRef={objectId:randomUUID(),versionId:randomUUID()};
function content(sourceDomain?:'source'|'analysis'|'evidence'){
  return WikiPageContentSchema.parse({schemaVersion:'1.0',profile:{id:'question',version:'1'},identity:{key:'test',aliases:[]},summary:'test',
    conditions:[],counterexamples:[],unknowns:[],nextQuestions:[],navigation:[],
    citations:[{kind:'source',sourceRef,...sourceDomain?{sourceDomain}:{},locator:null,supports:'Exact synthetic origin'}]});
}
test('source citations retain an explicit domain while old citations preserve the source default',()=>{
  for(const domain of ['source','analysis','evidence'] as const){
    const dependencies=wikiPageFrozenDependencies({content:content(domain),dependencies:[]});
    assert.deepEqual(dependencies,[{domain,ref:sourceRef,role:'uses',critical:true}]);
  }
  assert.deepEqual(wikiPageFrozenDependencies({content:content(),dependencies:[]}),[{domain:'source',ref:sourceRef,role:'uses',critical:true}]);
  assert.equal(CitationSchema.safeParse({kind:'source',sourceRef,sourceDomain:'knowledge',locator:null,supports:'test'}).success,false);
  const dependencies=wikiPageFrozenDependencies({content:content('analysis'),dependencies:[{domain:'analysis',ref:sourceRef,role:'uses',critical:true}]});
  assert.equal(dependencies.length,1,'an analysis citation must not invent a second managed-source dependency');
});

test('graph projection routes report citations to analysis instead of a fictitious managed source',async()=>{
  const ref={objectId:randomUUID(),versionId:randomUUID()},projectId='synthetic-citation-domain';
  const revision:KnowledgeRevision={kind:'wiki_page',ref,projectId,title:'Synthetic report Wiki',body:'Synthetic only',content:content('analysis'),
    scope:{applicability:{productVersionRefs:[],markets:[],languages:[],audiences:[],goals:[],requiredProduction:[],transferRationale:null},limitations:[],unknowns:[],reviewDueAt:null},
    dependencies:[],sourceGroups:['same-original'],artifactRef:null,createdAt:new Date().toISOString(),analysisQuality:null};
  const view:RevisionView={revision,published:true,current:true,review:null,validity:{valid:true,issues:[]}};
  const service={async search(){return [view];},async get(){return null;}} as unknown as KnowledgeService;
  const graph=await createKnowledgeGraphProjection(service,projectId);
  assert.ok(graph.nodes.some(node=>node.id===`analysis:${sourceRef.objectId}/${sourceRef.versionId}`));
  assert.equal(graph.nodes.some(node=>node.id===`source:${sourceRef.objectId}/${sourceRef.versionId}`),false);
});
