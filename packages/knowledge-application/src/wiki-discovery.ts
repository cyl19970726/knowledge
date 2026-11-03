import type {CoordinationRun,KnowledgeRef} from '@commerce/knowledge-contracts';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import type {KnowledgeApplication,ReadContext,BoundedWikiPage} from './index.ts';

type Reader=Pick<KnowledgeApplication,'inspectWikiCandidate'|'readCandidate'|'queryCandidates'|'assertReadEpoch'|'validateFrozenWiki'>;
type Discovery=NonNullable<CoordinationRun['discovery']>;
const receipt=(page:BoundedWikiPage):Discovery['evidence'][number]=>({id:`candidate:${page.ref.objectId}`,kind:'wiki_page',
 ref:page.ref,title:page.title,locator:null,conditions:page.conditions,counterexamples:page.counterexamples,
 unknowns:page.unknowns,storageDigest:page.storageDigest,actualReadCoverage:[],
 sourceGroups:page.sourceGroups.map(id=>({id,status:'known',authority:'knowledge-revision-lineage'}))});

/** Seed from a frozen Wiki identity and title, then read only bounded current candidates. No model runs here. */
export async function discoverFromWiki(reader:Reader,context:ReadContext,subject:KnowledgeRef,
 policy:{maxCandidates:number;queryLimit:number;maxReadBytes:number},check:()=>Promise<void>,onRead:(bytes:number)=>void=()=>{}){
 await check();const metadata=await reader.inspectWikiCandidate(context,subject);
 if(metadata.payloadBytes>policy.maxReadBytes)throw new KnowledgeError('KNOWLEDGE_READ_BUDGET_EXCEEDED','The exact Wiki subject exceeds the discovery budget',422);
 const anchor=await reader.readCandidate(context,metadata,policy.maxReadBytes);onRead(anchor.payloadBytes);
 if(subject.contentDigest!==null&&anchor.ref.contentDigest!==subject.contentDigest)
  throw new KnowledgeError('EXACT_REF_MISMATCH','The periodic subject digest no longer matches',409);
 if(!anchor.admitted||!anchor.frozenRevision||anchor.frozenRevision.kind!=='wiki_page')
  throw new KnowledgeError('CANDIDATE_NOT_ADMITTED','The periodic Wiki is unavailable for current research',403);
 const identity=anchor.frozenRevision.content.identity;
 const queries=[...new Set([anchor.title,...identity.aliases,identity.key].map(x=>x.trim().slice(0,500)).filter(Boolean))].slice(0,5);
 if(!queries.length)throw new KnowledgeError('WIKI_DISCOVERY_QUERY_EMPTY','This Wiki has no usable identity or title query',422);
 const refs:KnowledgeRef[]=[anchor.ref],evidence:Discovery['evidence']=[receipt(anchor)];
 let readBytes=anchor.payloadBytes,epoch:number|null=null,hasMore=false;
 const seen=new Set([`${anchor.ref.objectId}/${anchor.ref.versionId}`]);
 for(const query of queries){
  await check();const found=await reader.queryCandidates(context,{question:query,purpose:context.purpose,
   kinds:['wiki_page'],limit:policy.queryLimit,retrievalMethod:'wiki-lexical-v2'});
  const observed=found.coverage.snapshot.publicationEpoch;
  if(epoch!==null&&epoch!==observed)throw new KnowledgeError('READSET_CHANGED','Knowledge changed during periodic discovery',409);
  epoch=observed;hasMore=hasMore||found.coverage.hasMore;
  for(const candidate of found.data.items){
   const key=`${candidate.ref.objectId}/${candidate.ref.versionId}`;if(seen.has(key))continue;seen.add(key);
   if(refs.length>=policy.maxCandidates||candidate.payloadBytes>policy.maxReadBytes-readBytes){hasMore=true;continue;}
   await check();let page:BoundedWikiPage;
   try{page=await reader.readCandidate(context,candidate,policy.maxReadBytes-readBytes);}
   catch(error){if(error instanceof KnowledgeError&&error.code==='CANDIDATE_NOT_ADMITTED'){hasMore=true;continue;}throw error;}
   readBytes+=page.payloadBytes;onRead(readBytes);if(!page.admitted){hasMore=true;continue;}
   refs.push(page.ref);evidence.push(receipt(page));
  }
  if(refs.length>=policy.maxCandidates){hasMore=true;break;}
 }
 await check();for(const item of evidence)await reader.validateFrozenWiki(context,item.ref,item.storageDigest!);await reader.assertReadEpoch(context,epoch);
 return {candidateRefs:refs,readBytes,discovery:{epoch,evidence,hasMore,queries,
  question:`核对“${anchor.title.slice(0,500)}”与已有认识的支持、挑战、成立条件和待补依据。`} satisfies Discovery};
}
