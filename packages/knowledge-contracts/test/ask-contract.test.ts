import assert from 'node:assert/strict';
import test from 'node:test';
import { AskRequestSchema, AskClaimSchema, AskEvidenceReceiptSchema, AskProviderAnswerSchema, AskResultSchema, AskLookupResultSchema } from '../src/index.js';

const id='11111111-1111-4111-8111-111111111111';
const at='2026-11-02T00:00:00Z';
const ref={projectId:'test-project',spaceId:'test-space',domain:'knowledge' as const,objectId:id,versionId:id,contentDigest:'a'.repeat(64)};
const budget={maxModelCalls:2,maxReadBytes:1000,deadline:at,maxMoney:null};
const request={question:'What is supported?',purpose:'exploration_reading',limit:20,maxPages:5,includeSourceContent:false,budget};
const claim={text:'An observed pattern',evidenceIds:['page-1']};
const readCoverage={sourceRef:ref,anchors:[],byteCount:100,coverage:'full' as const,exclusions:[],readAt:at,readerAuthority:'test',readProofId:null};
const evidence={id:'page-1',kind:'wiki_page' as const,ref,title:'Page',locator:null,conditions:[],counterexamples:[],unknowns:[],actualReadCoverage:[readCoverage]};
const coverage={scopeDescription:'Test scope',returned:1,loaded:1,hasMore:false,nextCursor:null,completeness:'complete' as const,omittedReasons:[],snapshot:{publicationEpoch:1,consistency:'single_scope_snapshot' as const}};
const cost={modelCalls:{state:'known' as const,value:1},tokens:{state:'unknown' as const,reason:'not recorded'},money:{state:'unknown' as const,reason:'not recorded'}};
const result={id,question:request.question,purpose:request.purpose,state:'answered' as const,claims:[claim],evidence:[evidence],excluded:[],coverage,readsetFingerprint:'b'.repeat(64),cost,provider:{id:'siwc',modelRequested:'gpt-6-luna',modelReturned:null,requestId:null},reason:'Supported by the cited page',gaps:[],createdAt:at,completedAt:at};

test('Ask request enforces strict input and bounded pagination',()=>{
  assert.deepEqual(AskRequestSchema.parse(request),request);
  for(const changed of [{limit:0},{limit:21},{maxPages:0},{maxPages:6},{limit:1.5},{includeSourceContent:'false'},{extra:true}])
    assert.equal(AskRequestSchema.safeParse({...request,...changed}).success,false);
});

test('claims and evidence require citations and reject extra fields',()=>{
  assert.deepEqual(AskClaimSchema.parse(claim),claim);
  assert.deepEqual(AskEvidenceReceiptSchema.parse(evidence),evidence);
  assert.equal(AskClaimSchema.safeParse({...claim,evidenceIds:[]}).success,false);
  assert.equal(AskClaimSchema.safeParse({...claim,evidenceIds:Array(21).fill('page-1')}).success,false);
  assert.equal(AskClaimSchema.safeParse({...claim,evidenceIds:['page-1','page-1']}).success,false);
  assert.equal(AskClaimSchema.safeParse({...claim,evidenceIds:['x'.repeat(101)]}).success,false);
  assert.equal(AskClaimSchema.safeParse({...claim,extra:true}).success,false);
  assert.equal(AskEvidenceReceiptSchema.safeParse({...evidence,unknowns:Array(101).fill('unknown')}).success,false);
  assert.equal(AskEvidenceReceiptSchema.safeParse({...evidence,extra:true}).success,false);
});

test('provider answer and persisted result enforce outcome versus claims',()=>{
  assert.equal(AskProviderAnswerSchema.safeParse({outcome:'answered',claims:[claim],reason:'Evidence',gaps:[]}).success,true);
  assert.equal(AskProviderAnswerSchema.safeParse({outcome:'answered',claims:[{...claim,evidenceIds:['not-in-readset']}],reason:'Syntax only',gaps:[]}).success,true);
  assert.equal(AskProviderAnswerSchema.safeParse({outcome:'answered',claims:[],reason:'Evidence',gaps:[]}).success,false);
  assert.equal(AskProviderAnswerSchema.safeParse({outcome:'needs_evidence',claims:[claim],reason:'Missing',gaps:[]}).success,false);
  assert.equal(AskProviderAnswerSchema.safeParse({outcome:'refused',claims:[],reason:'Refused',gaps:[],extra:true}).success,false);
  assert.deepEqual(AskResultSchema.parse(result),result);
  assert.equal(AskResultSchema.safeParse({...result,claims:[{...claim,evidenceIds:[]}]}).success,false);
  assert.equal(AskResultSchema.safeParse({...result,claims:[{...claim,evidenceIds:['missing'] }]}).success,false);
  assert.equal(AskResultSchema.safeParse({...result,evidence:[evidence,evidence]}).success,false);
  assert.equal(AskResultSchema.safeParse({...result,evidence:[{...evidence,ref:{...ref,domain:'source'}}]}).success,false);
  assert.equal(AskResultSchema.safeParse({...result,evidence:[{...evidence,kind:'source_content'}]}).success,false);
  assert.equal(AskResultSchema.safeParse({...result,evidence:[{...evidence,ref:{...ref,contentDigest:null}}]}).success,false);
  assert.equal(AskResultSchema.safeParse({...result,evidence:[{...evidence,kind:'source_content',ref:{...ref,domain:'source'}}]}).success,true);
  assert.equal(AskResultSchema.safeParse({...result,state:'answered',claims:[]}).success,false);
  for(const state of ['reserved','running','needs_evidence','refused','failed','outcome_unknown']){
    assert.equal(AskResultSchema.safeParse({...result,state,claims:[claim]}).success,false,state);
    assert.equal(AskResultSchema.safeParse({...result,state,claims:[]}).success,true,state);
  }
  for(const state of ['failed','outcome_unknown']){
    assert.equal(AskResultSchema.safeParse({...result,state,claims:[],evidence:[evidence],reason:'Processing stopped after reading evidence'}).success,true,state);
    assert.equal(AskResultSchema.safeParse({...result,state,claims:[claim],evidence:[evidence]}).success,false,state);
    assert.equal(AskResultSchema.safeParse({...result,state,claims:[],evidence:[evidence],reason:'  '}).success,false,state);
  }
  assert.equal(AskResultSchema.safeParse({...result,extra:true}).success,false);
  assert.equal(AskResultSchema.safeParse({...result,provider:{...result.provider,extra:true}}).success,false);
});

test('Ask lookup response distinguishes committed answers from unknown outcomes',()=>{
  assert.equal(AskLookupResultSchema.safeParse({state:'committed',answer:result}).success,true);
  assert.equal(AskLookupResultSchema.safeParse({state:'unknown',answer:null}).success,true);
  assert.equal(AskLookupResultSchema.safeParse({state:'unknown',answer:result}).success,false);
  assert.equal(AskLookupResultSchema.safeParse({state:'committed',answer:null}).success,false);
  assert.equal(AskLookupResultSchema.safeParse({state:'not_committed',answer:null}).success,false);
  assert.equal(AskLookupResultSchema.safeParse({state:'unknown',answer:null,extra:true}).success,false);
  assert.equal(AskLookupResultSchema.safeParse({state:'committed',answer:{...result,claims:[]}}).success,false);
});
