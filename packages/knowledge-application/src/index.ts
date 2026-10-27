import { randomUUID } from 'node:crypto';
import type { KnowledgeStore, RevisionView } from '@commerce/knowledge-core/types';
import { KnowledgeError } from '@commerce/knowledge-core/types';
import { digest } from '@commerce/knowledge-core/utils';
import { planWikiLexicalQuery } from '@commerce/knowledge-core/wiki-lexical-query';
import {evaluateKnowledgeRevision,knowledgeRevisionSpace} from './status-policy.ts';
import type { CatalogRequest, CompareRequest, Coverage, GraphRequest, HistoryRequest, KnowledgeCitation, KnowledgeDocument, KnowledgeRef, QueryRequest, ReadReceipt, Relation, Scope, SourceContent, SourceRecord } from '@commerce/knowledge-contracts';
import { fromVersionRef, toVersionRef } from '@commerce/knowledge-contracts';

export interface Principal { id:string; clientInstallationId:string; projectId:string; spaceIds:readonly string[]; purposes:readonly string[] }
export interface ReadContext { scope:Scope; principal:Principal; purpose:string }
export interface ReceiptPort {
  save(receipt:ReadReceipt, expectedEpoch:number):Promise<void>;
  get(scope:Scope, principalId:string, receiptId:string):Promise<ReadReceipt|null>;
}
export interface SourceOwnerPort {
  readRecord(scope:Scope, ref:KnowledgeRef, context:ReadContext):Promise<SourceRecord|null>;
  readContent(scope:Scope, ref:KnowledgeRef, anchor:unknown, context:ReadContext):Promise<SourceContent|null>;
}
export interface KnowledgeApplicationOptions {store:KnowledgeStore; receipts:ReceiptPort; sources?:SourceOwnerPort; now?:()=>Date; policyVersion?:string; receiptTtlMs?:number}

const sameScope=(a:Scope,b:Scope)=>a.projectId===b.projectId&&a.spaceId===b.spaceId;
const version=(ref:KnowledgeRef)=>toVersionRef(ref);
const summary=(view:RevisionView)=> view.revision.kind==='wiki_page'?view.revision.content.summary:view.revision.body.slice(0,240);
const spaceOf=knowledgeRevisionSpace;
function assertContext(context:ReadContext):void {
  if(context.scope.projectId!==context.principal.projectId||!context.principal.spaceIds.includes(context.scope.spaceId))
    throw new KnowledgeError('SCOPE_FORBIDDEN','Principal cannot access this knowledge scope',403);
  if(!context.principal.purposes.includes(context.purpose))
    throw new KnowledgeError('PURPOSE_FORBIDDEN','Purpose is not authorized for this principal',403);
}
function assertRef(context:ReadContext,ref:KnowledgeRef,domain:KnowledgeRef['domain']='knowledge'):void {
  if(!sameScope(context.scope,ref)||ref.domain!==domain)throw new KnowledgeError('REF_SCOPE_MISMATCH','Exact reference is outside the authorized scope',403);
}
function pageCoverage(scope:Scope,epoch:number,returned:number,hasMore=false,nextCursor:string|null=null,reason:string[]=[]):Coverage {
  return {scopeDescription:`${scope.projectId}/${scope.spaceId}`,returned,loaded:returned,hasMore,nextCursor,
    completeness:hasMore?'bounded':'complete',omittedReasons:reason,
    snapshot:{publicationEpoch:epoch,consistency:'single_scope_snapshot'}};
}
function cursorOffset(cursor:string|undefined,binding:unknown,epoch:number):number {
  if(!cursor)return 0;
  try{const parsed=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
    if(parsed.binding!==digest(binding)||parsed.epoch!==epoch||!Number.isSafeInteger(parsed.offset)||parsed.offset<0||parsed.offset>100_000)
      throw new Error('cursor mismatch');
    return parsed.offset;
  }catch{throw new KnowledgeError('INVALID_CURSOR','Cursor does not match the exact query and knowledge epoch',400);}
}
function nextCursor(binding:unknown,epoch:number,offset:number):string{
  return Buffer.from(JSON.stringify({binding:digest(binding),epoch,offset})).toString('base64url');
}

/** Application policy and composition. KnowledgeStore remains the only revision/head authority. */
export function createKnowledgeApplication(options:KnowledgeApplicationOptions){
  const clock=()=>options.now?.()??new Date(),policyVersion=options.policyVersion??'knowledge-read-v1';
  const ttl=options.receiptTtlMs??15*60_000;
  function refOf(context:ReadContext,view:RevisionView):KnowledgeRef {
    return fromVersionRef(view.revision.ref,context.scope,'knowledge',digest(view.revision));
  }
  async function document(context:ReadContext,view:RevisionView):Promise<KnowledgeDocument>{
    const policy=evaluateKnowledgeRevision(view,context.purpose);
    if(!view.published||policy.spaceId!==context.scope.spaceId)throw new KnowledgeError('NOT_FOUND','Exact knowledge version is unavailable in this space',404);
    const revision=view.revision,ref=refOf(context,view),head=await options.store.head(context.scope.projectId,revision.ref.objectId);
    // A historical head is resolved from the same authoritative store; never substitute its body for this exact version.
    const actualHead=head&&head.versionId!==revision.ref.versionId?await options.store.get(context.scope.projectId,head):null;
    const headRef=actualHead?.published&&spaceOf(actualHead)===context.scope.spaceId?refOf(context,actualHead):head?.versionId===revision.ref.versionId?ref:null;
    const content=revision.kind==='wiki_page'?revision.content:null;
    const inheritedBasis:KnowledgeRef[]=[];
    for(const dependency of revision.dependencies.filter(item=>item.domain==='knowledge'&&item.critical).slice(0,100)){
      const basis=await options.store.get(context.scope.projectId,dependency.ref);
      if(basis?.published&&spaceOf(basis)===context.scope.spaceId)inheritedBasis.push(refOf(context,basis));
    }
    // A citation is a visible link to an exact cited version; resolving metadata does not claim a content read.
    const rawCitations='citations' in revision.content&&Array.isArray(revision.content.citations)?revision.content.citations:[];
    const citations:KnowledgeCitation[]=await Promise.all(rawCitations.slice(0,100).map(async citation=>{
      if(citation.kind==='media')return {ref:fromVersionRef(citation.anchor.sourceRef,context.scope,'evidence',null),
        locator:`record:${JSON.stringify(citation.anchor)}`,supports:citation.supports};
      const domains=[...new Set(revision.dependencies.filter(dep=>dep.ref.objectId===citation.sourceRef.objectId&&dep.ref.versionId===citation.sourceRef.versionId&&dep.domain!=='knowledge').map(dep=>dep.domain))];
      const citedDomain=domains.length===1&&['source','analysis','evidence'].includes(domains[0])?domains[0] as 'source'|'analysis'|'evidence':'source';
      let citedRef=fromVersionRef(citation.sourceRef,context.scope,citedDomain,null);
      if(options.sources){let record:SourceRecord|null=null;try{record=await options.sources.readRecord(context.scope,citedRef,context);}catch(error){
        if(!(error instanceof KnowledgeError)||![403,404,503].includes(error.status))throw error;
      }
        if(record){
          if(!sameScope(context.scope,record.ref)||record.ref.domain!==citedDomain||
            record.ref.objectId!==citedRef.objectId||record.ref.versionId!==citedRef.versionId)
            throw new KnowledgeError('SOURCE_REF_MISMATCH','Source owner returned a different cited version',409);
          citedRef=record.ref;
        }
      }
      return {ref:citedRef,locator:citation.locator,supports:citation.supports};
    }));
    return {ref,title:revision.title,body:revision.body,contentSchemaVersion:content?.schemaVersion??'legacy',
      profile:policy.profile,
      status:{current:view.current,currentRef:headRef,published:true,reviewDecision:view.review?.decision??null,policyVersion:view.review?.policyVersion??null,
        validity:{valid:view.validity.valid,issues:view.validity.issues.map(issue=>issue.reason),checkedAt:clock().toISOString(),reviewDueAt:revision.scope.reviewDueAt},
        purpose:{requested:context.purpose,admitted:policy.admitted,reasons:policy.reasons},contentSupported:policy.contentSupported,historicalAt:view.current?null:revision.createdAt},
      conditions:content?.conditions??[],counterexamples:content?.counterexamples??[],unknowns:content?.unknowns??revision.scope.unknowns,
      nextQuestions:content?.nextQuestions??[],sourceGroups:revision.sourceGroups.map(id=>({id,status:'known' as const,authority:null})),
      inheritedBasis,actualReadCoverage:[],citations};
  }
  async function receipt(context:ReadContext,request:ReadReceipt['request'],items:KnowledgeDocument[],epoch:number,coverage:Coverage){
    const createdAt=clock(),readsetFingerprint=digest(items.map(item=>({ref:item.ref,status:item.status,sourceGroups:item.sourceGroups}))),
      pageFingerprint=digest({request,orderedRefs:items.map(item=>item.ref),coverage}),requestDigest=digest(request);
    const value:ReadReceipt={id:randomUUID(),requestDigest,request,orderedItems:items.map(item=>({ref:item.ref,revisionDigest:item.ref.contentDigest!,
      statusAtRead:item.status,sourceGroups:item.sourceGroups,title:item.title,summary:item.body.slice(0,240)})),
      readsetFingerprint,pageFingerprint,coverage,purpose:context.purpose,policyVersion,effectiveScope:context.scope,
      principalId:context.principal.id,clientInstallationId:context.principal.clientInstallationId,actualReads:[],
      createdAt:createdAt.toISOString(),expiresAt:new Date(createdAt.getTime()+ttl).toISOString()};
    await options.receipts.save(value,epoch);
    return value;
  }
  async function query(context:ReadContext,request:QueryRequest){
    assertContext(context);if(request.purpose!==context.purpose)throw new KnowledgeError('PURPOSE_MISMATCH','Requested purpose differs from authenticated context',403);
    if(request.profileIds?.length||request.topics?.length||request.kinds?.some(kind=>kind!=='wiki_page'))
      throw new KnowledgeError('QUERY_FILTER_UNSUPPORTED','This bounded lexical reader supports wiki_page only; profile and topic filters are unavailable',422);
    const epoch=await options.store.epoch(context.scope.projectId),plan=planWikiLexicalQuery(request.question);
    const binding={scope:context.scope,principalId:context.principal.id,purpose:context.purpose,question:request.question,limit:request.limit,
      profileIds:request.profileIds??[],kinds:request.kinds??[],topics:request.topics??[]};
    const offset=cursorOffset(request.cursor,binding,epoch);
    const views=await options.store.search(context.scope.projectId,{kinds:['wiki_page'],spaceId:context.scope.spaceId,
      lexical:{methodVersion:plan.methodVersion,terms:plan.terms},limit:request.limit+1,offset});
    const selected=views.slice(0,request.limit),items=await Promise.all(selected.map(view=>document(context,view))),hasMore=views.length>request.limit;
    const coverage=pageCoverage(context.scope,epoch,items.length,hasMore,hasMore?nextCursor(binding,epoch,offset+items.length):null,
      hasMore?['Additional lexical matches are available on the next page']:[]);
    const saved=await receipt(context,{kind:'query',payload:request},items,epoch,coverage);
    return {data:{items,originalQuestion:request.question,retrieval:{methodVersion:plan.methodVersion,terms:plan.terms,truncated:plan.termsTruncated},
      readReceiptId:saved.id,readsetFingerprint:saved.readsetFingerprint,pageFingerprint:saved.pageFingerprint,
      emptyState:items.length?null:plan.terms.length?'no_matches_in_scope':'unclassified'},coverage};
  }
  async function catalog(context:ReadContext,request:CatalogRequest){
    assertContext(context);if(request.profileIds?.length)throw new KnowledgeError('CATALOG_FILTER_UNSUPPORTED','Profile filtering is not supported by the current bounded catalog',422);if(request.purpose!==context.purpose)throw new KnowledgeError('PURPOSE_MISMATCH','Purpose mismatch',403);
    const epoch=await options.store.epoch(context.scope.projectId);
    const binding={scope:context.scope,principalId:context.principal.id,purpose:context.purpose,query:request.query??'',limit:request.limit,
      profileIds:request.profileIds??[]};
    const offset=cursorOffset(request.cursor,binding,epoch);
    // Existing catalog has no space filter; authoritative search does, and is bounded here.
    const views=await options.store.search(context.scope.projectId,{query:request.query??'',spaceId:context.scope.spaceId,limit:request.limit+1,offset});
    const items=await Promise.all(views.slice(0,request.limit).map(view=>document(context,view)));
    const hasMore=views.length>request.limit;
    const coverage=pageCoverage(context.scope,epoch,items.length,hasMore,hasMore?nextCursor(binding,epoch,offset+items.length):null,
      hasMore?['Additional items are available on the next page']:[]);
    const saved=await receipt(context,{kind:'catalog',payload:request},items,epoch,coverage);
    return {data:{items,emptyState:items.length?null:'no_matches_in_scope',readReceiptId:saved.id},coverage};
  }
  async function exact(context:ReadContext,ref:KnowledgeRef){
    assertContext(context);assertRef(context,ref);const epoch=await options.store.epoch(context.scope.projectId);
    const view=await options.store.get(context.scope.projectId,version(ref));
    if(!view?.published||digest(view.revision)!==ref.contentDigest)throw new KnowledgeError('NOT_FOUND','Exact knowledge version or digest is unavailable',404);
    const item=await document(context,view),coverage=pageCoverage(context.scope,epoch,1);
    const saved=await receipt(context,{kind:'exact',payload:{ref,purpose:context.purpose}},[item],epoch,coverage);
    return {data:item,coverage,receiptId:saved.id};
  }
  async function history(context:ReadContext,request:HistoryRequest){
    assertContext(context);if(request.purpose!==context.purpose)throw new KnowledgeError('PURPOSE_MISMATCH','Purpose mismatch',403);
    if(request.asOf)throw new KnowledgeError('HISTORICAL_CUTOFF_UNSUPPORTED','Historical cutoff is unavailable for this history view',422);
    const epoch=await options.store.epoch(context.scope.projectId),views=(await options.store.history(context.scope.projectId,request.objectId))
      .filter(view=>view.published&&spaceOf(view)===context.scope.spaceId);
    const binding={scope:context.scope,principalId:context.principal.id,purpose:context.purpose,objectId:request.objectId,limit:request.limit};
    const offset=cursorOffset(request.cursor,binding,epoch),selected=views.slice(offset,offset+request.limit);
    const items=await Promise.all(selected.map(view=>document(context,view))),hasMore=views.length>offset+items.length;
    const coverage=pageCoverage(context.scope,epoch,items.length,hasMore,hasMore?nextCursor(binding,epoch,offset+items.length):null);
    await receipt(context,{kind:'history',payload:request},items,epoch,coverage);
    return {data:{versions:items.map((item,index)=>({ref:item.ref,publishedAt:selected[index]?.publishedAt??null,reason:selected[index]?.review?.rationale??'not_recorded'}))},coverage};
  }
  async function compare(context:ReadContext,request:CompareRequest){
    assertContext(context);if(request.purpose!==context.purpose)throw new KnowledgeError('PURPOSE_MISMATCH','Purpose mismatch',403);
    assertRef(context,request.before);assertRef(context,request.after);
    const before=(await exact(context,request.before)).data,after=(await exact(context,request.after)).data;
    const differences: Array<{field:string;before:unknown;after:unknown;reason:string|null}>=[];
    for(const field of ['title','body','conditions','counterexamples','unknowns','nextQuestions','sourceGroups'] as const)
      if(digest(before[field])!==digest(after[field]))differences.push({field,before:before[field],after:after[field],reason:null});
    return {data:{before,after,differences}};
  }
  async function graph(context:ReadContext,request:GraphRequest){
    assertContext(context);if(request.purpose!==context.purpose)throw new KnowledgeError('PURPOSE_MISMATCH','Purpose mismatch',403);
    if(request.asOf||request.cursor)throw new KnowledgeError('GRAPH_OPTION_UNSUPPORTED','Historical cutoff and graph continuation are unavailable',422);
    let roots:KnowledgeRef[]=[];
    if('ref' in request.root){assertRef(context,request.root.ref);roots=[request.root.ref];}
    else {const saved=await options.receipts.get(context.scope,context.principal.id,request.root.readReceiptId);
      if(!saved||Date.parse(saved.expiresAt)<=clock().getTime()||saved.purpose!==context.purpose)throw new KnowledgeError('RECEIPT_UNAVAILABLE','Exact read receipt is unavailable',404);
      roots=saved.orderedItems.map(item=>item.ref);}
    const epoch=await options.store.epoch(context.scope.projectId),queue=roots.map(ref=>({ref,depth:0})),seen=new Set<string>(),nodes:KnowledgeDocument[]=[],edges:import('@commerce/knowledge-contracts').Relation[]=[],
      externalNodes: import('@commerce/knowledge-contracts').GraphResult['externalNodes']=[],externalSeen=new Set<string>();
    let truncated=false;
    while(queue.length&&nodes.length+externalNodes.length<request.maxNodes){const {ref,depth}=queue.shift()!,key=`${ref.objectId}/${ref.versionId}`;if(seen.has(key))continue;seen.add(key);
      const view=await options.store.get(context.scope.projectId,version(ref));
      if(!view?.published||spaceOf(view)!==context.scope.spaceId||digest(view.revision)!==ref.contentDigest)continue;
      const nextDocument=await document(context,view);
      if(Buffer.byteLength(JSON.stringify({nodes:[...nodes,nextDocument],edges,externalNodes}),'utf8')>request.maxBytes){truncated=true;break;}
      nodes.push(nextDocument);if(depth>=request.maxDepth)continue;
      for(const dep of view.revision.dependencies.filter(dep=>dep.domain==='knowledge')){
        const basis=await options.store.get(context.scope.projectId,dep.ref);if(!basis?.published||spaceOf(basis)!==context.scope.spaceId)continue;
        const upstream=refOf(context,basis),stance=dep.role==='challenges'?'challenges':dep.critical?'supports':'navigation';
        if(!request.relationKinds.includes(stance))continue;
        const edge:Relation={id:`${upstream.objectId}/${upstream.versionId}:${dep.role}:${stance}:${ref.objectId}/${ref.versionId}`,relationVersion:'legacy-dependency-v1',from:upstream,to:ref,stance,critical:dep.critical,
          targetStatementAnchor:null,rationale:dep.rationale??null,conditions:dep.conditions??[],evidenceStatus:'unknown',sourceGroups:basis.revision.sourceGroups.map(id=>({id,status:'known',authority:null}))};
        if(edges.length>=500||Buffer.byteLength(JSON.stringify({nodes,externalNodes,edges:[...edges,edge]}),'utf8')>request.maxBytes){truncated=true;continue;}
        edges.push(edge);
        queue.push({ref:upstream,depth:depth+1});
      }
      for(const dep of view.revision.dependencies.filter(dep=>['source','analysis','evidence'].includes(dep.domain))){
        const domain=dep.domain as 'source'|'analysis'|'evidence';
        let upstream=fromVersionRef(dep.ref,context.scope,domain,null),availability:import('@commerce/knowledge-contracts').GraphResult['externalNodes'][number]['availability']=options.sources?'unknown':'owner_unconnected';
        const stance:Relation['stance']=dep.role==='supports'?'supports':dep.role==='challenges'?'challenges':'context';
        if(!request.relationKinds.includes(stance))continue;
        const externalKey=`${domain}:${dep.ref.objectId}/${dep.ref.versionId}`;
        if(!externalSeen.has(externalKey)){
          if(nodes.length+externalNodes.length>=request.maxNodes){truncated=true;continue;}
          if(options.sources){
            try { const found=await options.sources.readRecord(context.scope,upstream,context);
            if(found){
              if(!sameScope(context.scope,found.ref)||found.ref.domain!==domain||found.ref.objectId!==upstream.objectId||found.ref.versionId!==upstream.versionId)
                throw new KnowledgeError('SOURCE_REF_MISMATCH','Source owner returned a different exact version',409);
              upstream=found.ref;
              availability=found.readability.reasons.includes('SOURCE_CONTENT_UNSUPPORTED')?'unsupported':found.readability.contentReadable?'content_readable':found.readability.metadataVisible?'metadata_only':'unknown';
            }
            } catch(error) {
              if(!(error instanceof KnowledgeError))throw error;
              if(error.status===403)availability='forbidden';
              else if(error.code==='SOURCE_OWNER_UNCONNECTED'||error.code==='SOURCE_OWNER_UNAVAILABLE')availability='owner_unconnected';
              else if(error.code==='SOURCE_DOMAIN_UNSUPPORTED')availability='unsupported';
              else throw error;
            }
          }
          const candidate={ref:upstream,label:domain==='source'?'Source':domain==='analysis'?'Analysis':'Evidence',availability};
          if(Buffer.byteLength(JSON.stringify({nodes,externalNodes:[...externalNodes,candidate],edges}),'utf8')>request.maxBytes){truncated=true;continue;}
          externalNodes.push(candidate);externalSeen.add(externalKey);
        }else upstream=externalNodes.find(node=>`${node.ref.domain}:${node.ref.objectId}/${node.ref.versionId}`===externalKey)!.ref;
        if(edges.length>=500){truncated=true;continue;}
        const edge={id:`${externalKey}:${dep.role}:${stance}:${ref.objectId}/${ref.versionId}`,relationVersion:'legacy-dependency-v1',from:upstream,to:ref,stance,
          critical:dep.critical,targetStatementAnchor:null,rationale:dep.rationale??null,conditions:dep.conditions??[],
          evidenceStatus:'unknown' as const,sourceGroups:view.revision.sourceGroups.map(id=>({id,status:'known' as const,authority:null}))};
        if(Buffer.byteLength(JSON.stringify({nodes,externalNodes,edges:[...edges,edge]}),'utf8')>request.maxBytes){truncated=true;continue;}
        edges.push(edge);
      }
    }
    if(await options.store.epoch(context.scope.projectId)!==epoch)throw new KnowledgeError('READSET_CHANGED','Knowledge or source rights changed during graph projection',409);
    const hasMore=queue.length>0||truncated;
    const coverage=pageCoverage(context.scope,epoch,nodes.length,hasMore,null,hasMore?['Graph traversal was bounded']:[]);
    return {data:{nodes,externalNodes,edges},coverage};
  }
  async function readReceipt(context:ReadContext,id:string){assertContext(context);const saved=await options.receipts.get(context.scope,context.principal.id,id);
    if(!saved||saved.purpose!==context.purpose||Date.parse(saved.expiresAt)<=clock().getTime())throw new KnowledgeError('RECEIPT_UNAVAILABLE','Read receipt is unavailable',404);
    return saved;}
  function assertOwnerRef(requested:KnowledgeRef,actual:KnowledgeRef):void {
    if(!sameScope(requested,actual)||requested.domain!==actual.domain||requested.objectId!==actual.objectId||requested.versionId!==actual.versionId||
      requested.contentDigest!==null&&requested.contentDigest!==actual.contentDigest)
      throw new KnowledgeError('SOURCE_REF_MISMATCH','Source owner returned a different exact reference',409);
  }
  async function sourceRecord(context:ReadContext,ref:KnowledgeRef){assertContext(context);assertRef(context,ref,ref.domain);if(ref.domain==='knowledge')throw new KnowledgeError('SOURCE_DOMAIN_UNSUPPORTED','Use exact knowledge read for this domain',422);
    if(!options.sources)throw new KnowledgeError('SOURCE_READER_UNAVAILABLE','No authenticated source-owner reader is configured',503);
    const record=await options.sources.readRecord(context.scope,ref,context);if(!record)throw new KnowledgeError('NOT_FOUND','Exact source record unavailable',404);assertOwnerRef(ref,record.ref);return record;}
  async function sourceContent(context:ReadContext,ref:KnowledgeRef,anchor:unknown){assertContext(context);assertRef(context,ref,ref.domain);if(ref.domain==='knowledge')throw new KnowledgeError('SOURCE_DOMAIN_UNSUPPORTED','Use exact knowledge read for this domain',422);
    if(!options.sources)throw new KnowledgeError('SOURCE_READER_UNAVAILABLE','No authenticated source-owner reader is configured',503);
    const content=await options.sources.readContent(context.scope,ref,anchor,context);if(!content)throw new KnowledgeError('NOT_FOUND','Exact source content unavailable',404);assertOwnerRef(ref,content.ref);assertOwnerRef(content.ref,content.actualCoverage.sourceRef);
    if(content.ref.contentDigest!==content.contentDigest)throw new KnowledgeError('SOURCE_DIGEST_MISMATCH','Source content digest differs from its exact reference',409);return content;}
  return {query,catalog,exact,history,compare,graph,readReceipt,sourceRecord,sourceContent,policyVersion};
}
export type KnowledgeApplication=ReturnType<typeof createKnowledgeApplication>;
export * from './sources.ts';
export * from './research.ts';
export * from './uses.ts';
export * from './reviews.ts';
export * from './feedback-source.ts';
export * from './status-policy.ts';
