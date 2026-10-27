import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiErrorSchema, EnvelopeSchema, KnowledgeRefSchema, QueryRequestSchema, ResearchResultSchema, SourceReadabilitySchema, SourceUpsertSchema, toVersionRef, fromVersionRef, CONTRACT_VERSION } from '../src/index.js';
const objectId='11111111-1111-4111-8111-111111111111';
const versionId='22222222-2222-4222-8222-222222222222';
const digest='a'.repeat(64);
const scope={projectId:'local-perseek',spaceId:'demo'};
test('transport ref preserves existing stored identity without inventing source digest',()=>{
  const stored={objectId,versionId};
  const transported=fromVersionRef(stored,scope,'source',null);
  assert.deepEqual(toVersionRef(transported),stored);
  assert.equal(transported.contentDigest,null);
  assert.equal(KnowledgeRefSchema.safeParse({...transported,versionId:'current'}).success,false);
  assert.equal(KnowledgeRefSchema.safeParse({...transported,extra:'x'}).success,false);
});
test('strict bounded requests and response envelopes reject malformed payloads',()=>{
  assert.equal(QueryRequestSchema.safeParse({question:'q',purpose:'exploration_reading',limit:101}).success,false);
  assert.equal(EnvelopeSchema(QueryRequestSchema).safeParse({contractVersion:CONTRACT_VERSION,requestId:'r',effectiveScope:scope,observedAt:'2026-10-26T01:00:00Z',data:{question:'q',purpose:'exploration_reading',limit:1},warnings:[]}).success,true);
  assert.equal(EnvelopeSchema(QueryRequestSchema).safeParse({contractVersion:'2',requestId:'r',effectiveScope:scope,observedAt:'2026-10-26T01:00:00Z',data:{question:'q',purpose:'exploration_reading',limit:1},warnings:[]}).success,false);
  assert.equal(ApiErrorSchema.safeParse({requestId:'r',code:'OUTCOME_UNKNOWN',message:'unknown',retryable:false,commitStatus:'unknown'}).success,true);
  assert.equal(SourceReadabilitySchema.safeParse({metadataVisible:true,contentReadable:true,anchorResolved:true,assurance:'sure',reasons:[]}).success,false);
  assert.equal(ResearchResultSchema.safeParse({cognitiveOutcome:'published'}).success,false);
});

test('managed source content preserves exact leading and trailing whitespace',()=>{
  const text='  exact source text\n\n';
  const parsed=SourceUpsertSchema.parse({
    externalIdentity:{adapterId:'document',externalObjectId:'doc-1',externalVersion:'v1'},
    expectedSourceHead:null,sourceSchemaVersion:'document-text@1',contentDigest:digest,
    custody:{mode:'managed_copy',text},sourceKind:'document',author:null,publisher:null,acquirer:'test',
    publishedAt:null,obtainedAt:'2026-10-28T00:00:00Z',assertionKind:'source_claim',sourceGroups:[],anchors:[],actualCoverage:[],limitations:[],rightsPolicyRef:'test',
  });
  assert.equal(parsed.custody.mode,'managed_copy');
  assert.equal(parsed.custody.text,text);
});
