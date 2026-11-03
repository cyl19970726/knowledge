import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRepairProposal} from '../src/wiki-compile.ts';
import type {RepairTargetPage} from '../src/index.ts';
import type {AskEvidence} from '../src/ask.ts';
import type {WikiCompileProposal,WikiRepair} from '@commerce/knowledge-contracts';

const scope={projectId:'p',spaceId:'s'},id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const target={...scope,domain:'knowledge' as const,objectId:id(1),versionId:id(2),contentDigest:'a'.repeat(64)};
const oldSource={objectId:id(3),versionId:id(4)},newSource={...scope,domain:'source' as const,objectId:id(3),versionId:id(5),contentDigest:'b'.repeat(64)};
const keptWiki={objectId:id(6),versionId:id(7)};
const now=new Date('2026-11-03T00:00:00.000Z');
function page(reviewDueAt:string|null=null):RepairTargetPage{
 return {ref:target,title:'C1',body:'old',conditions:[],counterexamples:[],unknowns:[],citations:[],sourceGroups:[],storageDigest:'c'.repeat(64),payloadBytes:3,admitted:false,
  validity:{valid:false,issues:[{domain:'source',ref:oldSource,reason:'source_superseded'}]},reviewDueAt,
  dependencies:[{domain:'source',ref:oldSource,critical:true,valid:false},{domain:'knowledge',ref:keptWiki,critical:true,valid:true},
   {domain:'knowledge',ref:{objectId:target.objectId,versionId:id(9)},critical:true,valid:false},{domain:'knowledge',ref:{objectId:id(10),versionId:id(11)},critical:false,valid:true}]};
}
const evidence=[{id:'repair:t',kind:'wiki_page',role:'repair_target',ref:target},{id:'source:new',kind:'source_content',ref:newSource}] as unknown as AskEvidence[];
function proposal(repair:Partial<WikiRepair>={},support=['source:new']):WikiCompileProposal{
 return {outcome:'proposed',reason:'r',gaps:[],drafts:[{targetEvidenceId:'repair:t',profile:{id:'question',version:'1',digest:'d'.repeat(64)},identityKey:'k',title:'C',summary:'s',
  conditions:[],counterexamples:[],unknowns:[],nextQuestions:[],supportEvidenceIds:support,rationale:'r',
  repair:{dependencies:[{domain:'source',ref:oldSource,action:'replace',replacementEvidenceId:'source:new',reason:'当前版本'},
   {domain:'knowledge',ref:keptWiki,action:'keep',replacementEvidenceId:null,reason:'仍有效'}],reviewDue:{action:'keep'},...repair}}]};
}
const check=(value:WikiCompileProposal,reviewDueAt:string|null=null)=>assertRepairProposal(value,{evidenceId:'repair:t',page:page(reviewDueAt)},evidence,now);
const code=(value:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&error.code===value;

test('a complete repair replaces invalid lineage with read support and keeps only valid lineage',()=>{
 assert.doesNotThrow(()=>check(proposal()));
});
test('self-history and non-critical edges need no disposition, but every other critical dependency does',()=>{
 assert.throws(()=>check(proposal({dependencies:[proposal().drafts[0].repair!.dependencies[0]]})),code('REPAIR_DISPOSITION_INCOMPLETE'));
});
test('an invalid dependency cannot be kept, and a replacement must be read, distinct and declared support',()=>{
 const keep=proposal({dependencies:[{domain:'source',ref:oldSource,action:'keep',replacementEvidenceId:null,reason:'x'},proposal().drafts[0].repair!.dependencies[1]]});
 assert.throws(()=>check(keep),code('REPAIR_KEEPS_INVALID_DEPENDENCY'));
 const target=proposal({dependencies:[{domain:'source',ref:oldSource,action:'replace',replacementEvidenceId:'repair:t',reason:'x'},proposal().drafts[0].repair!.dependencies[1]]});
 assert.throws(()=>check(target),code('REPAIR_REPLACEMENT_UNREAD'));
 assert.throws(()=>check(proposal({},['repair:t'])),code('REPAIR_REPLACEMENT_UNSUPPORTED'));
});
test('an elapsed review date needs a future date or an explicit clearing reason',()=>{
 const due='2026-10-01T00:00:00.000Z';
 assert.throws(()=>check(proposal(),due),code('REPAIR_REVIEW_DUE_REQUIRED'));
 assert.throws(()=>check(proposal({reviewDue:{action:'set',until:'2026-11-01T00:00:00.000Z',reason:'过去'}}),due),code('REPAIR_REVIEW_DUE_PAST'));
 assert.throws(()=>check(proposal({reviewDue:{action:'clear',reason:'  '}}),due),code('REPAIR_REVIEW_DUE_REASON_REQUIRED'));
 assert.doesNotThrow(()=>check(proposal({reviewDue:{action:'set',until:'2027-01-01T00:00:00.000Z',reason:'重新复核'}}),due));
 assert.doesNotThrow(()=>check(proposal({reviewDue:{action:'clear',reason:'不再需要定期复核'}}),due));
 assert.doesNotThrow(()=>check(proposal(),'2027-01-01T00:00:00.000Z'),'a future review date may be kept');
});
test('a repair revises its exact target exactly once',()=>{
 const other=proposal();other.drafts[0].targetEvidenceId=null;
 assert.throws(()=>check(other),code('REPAIR_DRAFT_INVALID'));
 const missing=proposal();delete missing.drafts[0].repair;
 assert.throws(()=>check(missing),code('REPAIR_DISPOSITION_REQUIRED'));
});
