import {createServer as createHttpServer} from 'node:http';
import type {Server} from 'node:http';
import {timingSafeEqual,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import express from 'express';
import type {Express} from 'express';
import {Pool} from 'pg';
import {ZodError} from 'zod';
import {createKnowledgeStore} from '@commerce/knowledge-core/store';
import {migrateKnowledge} from '@commerce/knowledge-core/migrations';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import type {KnowledgeWriterGrant} from '@commerce/knowledge-core/writer-authority';
import {listWikiPageProfiles,wikiPageProfileFingerprint} from '@commerce/knowledge-core/wiki-page';
import {createKnowledgeApplication,createSourceApplication,createSyntheticResearchService,createUseFeedbackApplication,createReviewApplication,createFeedbackSourceApplication,
  type KnowledgeApplication,type Principal,type ReadContext,type CapabilityContext,type CapabilityPrincipal,type SyntheticResearchProvider,type SourceOwnerPort} from '@commerce/knowledge-application';
import {createPgKnowledgeReceiptPort,migrateKnowledgeReadReceipts,createPgKnowledgeOperations,migrateKnowledgeOperations,
  createPgSourceRegistry,migrateManagedSources,createHttpSourceOwner,routeSourceOwners,createPgUseFeedbackPort,migrateKnowledgeUses} from '@commerce/knowledge-service-adapter';
import {createPgReviewPort,migrateKnowledgeReviews,lookupCapabilityOperation,getCapabilityOperation,createPgFeedbackSourcePort,
  createPgFeedbackResearchPort} from '@commerce/knowledge-service-adapter';
import {CONTRACT_VERSION,CatalogRequestSchema,CompareRequestSchema,GraphRequestSchema,HistoryRequestSchema,KnowledgeRefSchema,QueryRequestSchema,ReadReceiptSchema,
  SourceUpsertSchema,ResearchRequestSchema,CancelRequestSchema,OperationLookupSchema,UseInputSchema,FeedbackInputSchema,ChangesRequestSchema,
  ReviewRequestSchema,ReviewDecisionSchema,FeedbackSourceRequestSchema} from '@commerce/knowledge-contracts';

export interface KnowledgeApiConfig {pool:Pool;token:string;principal:Principal;port?:number;host?:string;
  writerGrant?:KnowledgeWriterGrant;enableSyntheticResearch?:boolean;researchProvider?:SyntheticResearchProvider;capabilities?:CapabilityPrincipal;
  syntheticFixture?:boolean;feedbackSourceRightsPolicyRef?:string;sourceOwner?:SourceOwnerPort}
export interface KnowledgeApi {app:Express;service:KnowledgeApplication;research:ReturnType<typeof createSyntheticResearchService>|null;listen():Promise<Server>}
function equalSecret(actual:string,expected:string):boolean {const a=Buffer.from(actual),b=Buffer.from(expected);return a.length===b.length&&timingSafeEqual(a,b);}
const message=(error:unknown)=>error instanceof Error?error.message:'Unexpected error';

/** Standalone knowledge-only API. No AnalysisHost, Foundation, video, or model construction. */
export async function createKnowledgeApi(config:KnowledgeApiConfig):Promise<KnowledgeApi>{
  if(!config.token||config.token.length<24)throw new Error('KNOWLEDGE_API_TOKEN must be a nonempty random secret of at least 24 characters');
  if(!config.principal.projectId||!config.principal.spaceIds.length||!config.principal.purposes.length)throw new Error('Explicit project, space and purpose scope required');
  // Core tables and guard functions must exist before any adapter installs its triggers. Migration does not activate a writer.
  await migrateKnowledge(config.pool);
  await migrateKnowledgeReadReceipts(config.pool);
  await migrateManagedSources(config.pool);
  await migrateKnowledgeUses(config.pool,{writerGrant:config.writerGrant});
  await migrateKnowledgeReviews(config.pool);
  if(config.enableSyntheticResearch){if(!config.writerGrant)throw new Error('Synthetic research requires a trusted writer grant');await migrateKnowledgeOperations(config.pool);}
  const app=express();app.disable('x-powered-by');app.use(express.json({limit:'1mb'}));
  const store=createKnowledgeStore(config.pool,{writerGrant:config.writerGrant}),receipts=createPgKnowledgeReceiptPort(config.pool);
  const sourceRegistry=createPgSourceRegistry(config.pool,{writerGrant:config.writerGrant,readerIds:[config.principal.id]});
  const sources=createSourceApplication(sourceRegistry);
  const useFeedback=createUseFeedbackApplication(createPgUseFeedbackPort(config.pool,{writerGrant:config.writerGrant}));
  const reviews=config.writerGrant?createReviewApplication(createPgReviewPort(config.pool,config.writerGrant,sourceRegistry)):null;
  const feedbackSources=config.writerGrant&&config.feedbackSourceRightsPolicyRef?
    createFeedbackSourceApplication(createPgFeedbackSourcePort(config.pool,{writerGrant:config.writerGrant,rightsPolicyRef:config.feedbackSourceRightsPolicyRef})):null;
  const service=createKnowledgeApplication({store,receipts,sources:routeSourceOwners(sourceRegistry,config.sourceOwner)});
  const operations=config.enableSyntheticResearch&&config.writerGrant?createPgKnowledgeOperations(config.pool,config.writerGrant):null;
  const research=operations?createSyntheticResearchService({store,receipts,operations,sources:sourceRegistry,
    feedback:createPgFeedbackResearchPort(config.pool),provider:config.researchProvider}):null;
  const profiles=listWikiPageProfiles().map(profile=>({id:profile.id,version:profile.version,digest:wikiPageProfileFingerprint(profile)}));
  app.use((req,res,next)=>{const bearer=/^Bearer (.+)$/.exec(req.header('authorization')??'');
    if(!bearer||!equalSecret(bearer[1],config.token)){res.status(401).json({requestId:randomUUID(),code:'UNAUTHORIZED',message:'Authenticated token required',retryable:false,commitStatus:'not_committed'});return;}next();});
  const base='/api/v1/projects/:projectId/spaces/:spaceId/knowledge';
  const route=(handler:(context:ReadContext,req:express.Request)=>Promise<{data:unknown;coverage?:unknown;receiptId?:string}>|{data:unknown;coverage?:unknown;receiptId?:string})=>
    async(req:express.Request,res:express.Response)=>{const requestId=randomUUID();try{
      const projectId=String(req.params.projectId),spaceId=String(req.params.spaceId),purpose=String(req.body?.purpose??req.query.purpose??'exploration_reading');
      const context:ReadContext={scope:{projectId,spaceId},principal:config.principal,purpose};
      if(projectId!==config.principal.projectId||!config.principal.spaceIds.includes(spaceId)||!config.principal.purposes.includes(purpose))
        throw new KnowledgeError('SCOPE_FORBIDDEN','Project, space or purpose is not authorized',403);
      const result=await handler(context,req);
      res.setHeader('cache-control','no-store');res.json({contractVersion:CONTRACT_VERSION,requestId,effectiveScope:context.scope,
        observedAt:new Date().toISOString(),data:result.data,warnings:config.syntheticFixture?['synthetic_engineering_fixture']:[],
        ...(result.coverage?{coverage:result.coverage}:{}),...(result.receiptId?{readReceiptId:result.receiptId}:{})});
    }catch(error){const known=typeof error==='object'&&error!==null&&'code' in error&&'status' in error&&
        typeof error.code==='string'&&typeof error.status==='number'&&error.status>=400&&error.status<600;
      const status=known?Number(error.status):error instanceof ZodError?400:500;
      const code=known?String(error.code):error instanceof ZodError?'INVALID_REQUEST':'INTERNAL_ERROR';
      res.status(status).json({requestId,code,message:status===500?'Knowledge request failed':message(error),retryable:status===409||status===503,
        commitStatus:typeof error==='object'&&error&&'commitStatus' in error?error.commitStatus:'not_committed',
        ...(typeof error==='object'&&error&&'operationId' in error?{operationId:error.operationId}:{})});
    }};
  app.get(`${base}/capabilities`,route(async context=>({data:{permittedActions:['query','catalog','exact','history','compare','graph','read_receipt',
    ...config.writerGrant&&config.capabilities?.actions.includes('sources:write')?['registerSource']:[],
    ...config.writerGrant&&config.capabilities?.actions.includes('uses:write')?['recordUse']:[],
    ...config.writerGrant&&config.capabilities?.actions.includes('feedback:write')?['recordFeedback']:[],
    ...feedbackSources&&config.capabilities?.actions.includes('feedback:source')?['registerFeedbackSource']:[],
    ...config.enableSyntheticResearch&&config.writerGrant&&config.capabilities?.actions.includes('research:write')?['research']:[],
    ...config.writerGrant&&config.capabilities?.actions.includes('review:request')?['requestReview']:[]],
    purposes:config.principal.purposes,profiles,mode:config.writerGrant?'ready':'read_only',contractVersion:CONTRACT_VERSION,policyVersion:service.policyVersion,
    limits:{queryItems:100,graphNodes:200,receiptTtlSeconds:900}}})));
  app.get(`${base}/profiles`,route(async()=>({data:profiles})));
  app.post(`${base}/query`,route((context,req)=>service.query(context,QueryRequestSchema.parse(req.body))));
  app.get(`${base}/catalog`,route((context,req)=>service.catalog(context,CatalogRequestSchema.parse({
    purpose:req.query.purpose,query:req.query.query,limit:Number(req.query.limit??50),cursor:req.query.cursor}))));
  app.get(`${base}/objects/:objectId/versions/:versionId`,route((context,req)=>service.exact(context,KnowledgeRefSchema.parse({
    ...context.scope,domain:'knowledge',objectId:req.params.objectId,versionId:req.params.versionId,contentDigest:req.query.digest}))));
  app.get(`${base}/objects/:objectId/history`,route((context,req)=>service.history(context,HistoryRequestSchema.parse({
    objectId:req.params.objectId,purpose:req.query.purpose,limit:Number(req.query.limit??50),cursor:req.query.cursor,asOf:req.query.asOf}))));
  app.post(`${base}/compare`,route((context,req)=>service.compare(context,CompareRequestSchema.parse(req.body))));
  app.post(`${base}/graph`,route((context,req)=>service.graph(context,GraphRequestSchema.parse(req.body))));
  app.get(`${base}/receipts/:receiptId`,route(async(context,req)=>({data:ReadReceiptSchema.parse(await service.readReceipt(context,String(req.params.receiptId)))})));
  app.get(`${base}/sources/:objectId/versions/:versionId`,route(async(context,req)=>({data:await service.sourceRecord(context,KnowledgeRefSchema.parse({
    ...context.scope,domain:req.query.domain??'source',objectId:req.params.objectId,versionId:req.params.versionId,contentDigest:req.query.digest??null}))})));
  app.get(`${base}/sources/:objectId/versions/:versionId/content`,route(async(context,req)=>({data:await service.sourceContent(context,KnowledgeRefSchema.parse({
    ...context.scope,domain:req.query.domain??'source',objectId:req.params.objectId,versionId:req.params.versionId,contentDigest:req.query.digest??null}),
    typeof req.query.anchor==='string'?JSON.parse(req.query.anchor):null)})));
  const capability=(context:ReadContext):CapabilityContext=>({...context,authorization:config.capabilities??{actions:[],adapterIds:[],rightsPolicyIds:[]}});
  const requireWrites=()=>{if(!config.writerGrant)throw new KnowledgeError('WRITES_DISABLED','Knowledge writes are disabled in this API',503);};
  app.post(`${base}/sources`,route(async(context,req)=>{requireWrites();return {data:await sources.upsert(capability(context),SourceUpsertSchema.parse(req.body),
    String(req.header('Idempotency-Key')??''))};}));
  app.post(`${base}/sources/:objectId/versions/:versionId/revoke`,route(async(context,req)=>{requireWrites();return {data:await sources.revoke(capability(context),
    KnowledgeRefSchema.parse({...context.scope,domain:'source',objectId:req.params.objectId,versionId:req.params.versionId,contentDigest:req.body?.contentDigest??null}),
    Number(req.body?.expectedGeneration),String(req.header('Idempotency-Key')??''))};}));
  app.post(`${base}/research`,route(async(context,req)=>{if(!research)throw new KnowledgeError('RESEARCH_DISABLED','Synthetic research is disabled',503);
    return {data:await research.submit(capability(context),ResearchRequestSchema.parse(req.body),String(req.header('Idempotency-Key')??''))};}));
  app.get(`${base}/research/:researchId`,route(async(context,req)=>{if(!operations)throw new KnowledgeError('RESEARCH_DISABLED','Research is disabled',503);
    const found=await operations.get(context.scope,context.principal.id,String(req.params.researchId),context.purpose);if(!found)throw new KnowledgeError('NOT_FOUND','Research unavailable',404);return {data:found.operation};}));
  app.get(`${base}/research/:researchId/result`,route(async(context,req)=>{if(!operations)throw new KnowledgeError('RESEARCH_DISABLED','Research is disabled',503);
    const found=await operations.get(context.scope,context.principal.id,String(req.params.researchId),context.purpose);if(!found?.result)throw new KnowledgeError('RESULT_UNAVAILABLE','Research result unavailable',404);return {data:found.result};}));
  app.get(`${base}/candidates/:candidateId`,route(async(context,req)=>{if(!reviews)throw new KnowledgeError('CANDIDATE_VIEW_DISABLED','Candidate review view is disabled',503);
    const found=await reviews.viewCandidate(capability(context),String(req.params.candidateId));
    if(!found)throw new KnowledgeError('NOT_FOUND','Candidate unavailable for this scope and purpose',404);
    return {data:found};}));
  app.post(`${base}/research/:researchId/cancel`,route(async(context,req)=>{if(!operations)throw new KnowledgeError('RESEARCH_DISABLED','Research is disabled',503);
    CancelRequestSchema.parse(req.body);return {data:await operations.cancel(context.scope,context.principal.id,String(req.params.researchId),context.purpose)};}));
  app.get(`${base}/operations/lookup`,route(async(context,req)=>{const q=OperationLookupSchema.parse({operation:req.query.operation,key:req.query.key,purpose:req.query.purpose});
    if(q.operation==='research')return {data:operations?await operations.lookup(context.scope,context.principal.id,q.operation,q.key,context.purpose):
      {state:'unknown',operation:null,reservationState:null}};
    return {data:await lookupCapabilityOperation(config.pool,context,q.operation,q.key)};}));
  app.get(`${base}/operations/:operationId`,route(async(context,req)=>{
    const id=String(req.params.operationId),found=operations?await operations.get(context.scope,context.principal.id,id,context.purpose):null;
    const operation=found?.operation??await getCapabilityOperation(config.pool,context,id);
    if(!operation)throw new KnowledgeError('NOT_FOUND','Operation unavailable',404);return {data:operation};}));
  app.post(`${base}/uses`,route(async(context,req)=>{requireWrites();return {data:await useFeedback.use(capability(context),UseInputSchema.parse(req.body),
    String(req.header('Idempotency-Key')??''))};}));
  app.get(`${base}/uses/:useId`,route(async(context,req)=>{const found=await useFeedback.getUse(context,String(req.params.useId));
    if(!found)throw new KnowledgeError('NOT_FOUND','Use record unavailable',404);return {data:found};}));
  app.post(`${base}/feedback`,route(async(context,req)=>{requireWrites();return {data:await useFeedback.feedback(capability(context),FeedbackInputSchema.parse(req.body),
    String(req.header('Idempotency-Key')??''))};}));
  app.get(`${base}/feedback/:feedbackId`,route(async(context,req)=>{const found=await useFeedback.getFeedback(context,String(req.params.feedbackId));
    if(!found)throw new KnowledgeError('NOT_FOUND','Feedback record unavailable',404);return {data:found};}));
  app.post(`${base}/feedback/:feedbackId/source-registration`,route(async(context,req)=>{
    if(!feedbackSources)throw new KnowledgeError('FEEDBACK_SOURCE_DISABLED','Feedback source registration needs an explicit rights policy',503);
    return {data:await feedbackSources.register(capability(context),String(req.params.feedbackId),FeedbackSourceRequestSchema.parse(req.body),
      String(req.header('Idempotency-Key')??''))};}));
  const changes=route(async(context,req)=>{const q=ChangesRequestSchema.parse({purpose:req.query.purpose,after:req.query.after,
    limit:Number(req.query.limit??50),useId:req.query.useId,feedbackId:req.query.feedbackId});
    if(q.purpose!==context.purpose)throw new KnowledgeError('PURPOSE_MISMATCH','Purpose mismatch',403);
    const page=await useFeedback.changes(context,q.after,q.limit,q.useId,q.feedbackId);
    const epoch=await store.epoch(context.scope.projectId);
    return {data:page.data,coverage:{scopeDescription:`${context.scope.projectId}/${context.scope.spaceId}`,returned:page.data.items.length,
      loaded:page.data.items.length,hasMore:page.hasMore,nextCursor:page.nextCursor,completeness:page.hasMore?'bounded':'complete',omittedReasons:[],
      snapshot:{publicationEpoch:epoch,consistency:'single_scope_snapshot'}}};});
  app.get(`${base}/changes`,changes);
  app.get(`${base}/feedback/:feedbackId/resolutions`,route(async(context,req)=>{
    const q=ChangesRequestSchema.parse({purpose:req.query.purpose,after:req.query.after,limit:Number(req.query.limit??50)});
    const page=await useFeedback.changes(context,q.after,q.limit,undefined,String(req.params.feedbackId));
    return {data:page.data};}));
  app.post(`${base}/review-requests`,route(async(context,req)=>{if(!reviews)throw new KnowledgeError('REVIEW_DISABLED','Review writes are disabled',503);
    return {data:await reviews.request(capability(context),ReviewRequestSchema.parse(req.body),String(req.header('Idempotency-Key')??''))};}));
  app.get(`${base}/review-requests/:reviewRequestId`,route(async(context,req)=>{if(!reviews)throw new KnowledgeError('REVIEW_DISABLED','Reviews are disabled',503);
    const found=await reviews.ticket(capability(context),String(req.params.reviewRequestId));if(!found)throw new KnowledgeError('NOT_FOUND','Review ticket unavailable',404);return {data:found};}));
  app.post(`${base}/review-requests/:reviewRequestId/decisions`,route(async(context,req)=>{if(!reviews)throw new KnowledgeError('REVIEW_DISABLED','Reviews are disabled',503);
    return {data:await reviews.decide(capability(context),String(req.params.reviewRequestId),ReviewDecisionSchema.parse(req.body),
      String(req.header('Idempotency-Key')??''))};}));
  return {app,service,research,listen:()=>new Promise<ReturnType<typeof createHttpServer>>((resolve,reject)=>{const server=createHttpServer(app);
    server.once('error',reject);server.listen(config.port??4311,config.host??'127.0.0.1',()=>resolve(server));})};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const databaseUrl=process.env.KNOWLEDGE_DATABASE_URL,token=process.env.KNOWLEDGE_API_TOKEN,
    projectId=process.env.KNOWLEDGE_API_PROJECT_ID,spaceIds=process.env.KNOWLEDGE_API_SPACE_IDS?.split(',').map(x=>x.trim()).filter(Boolean);
  if(!databaseUrl||!token||!projectId||!spaceIds?.length)throw new Error('Set KNOWLEDGE_DATABASE_URL, KNOWLEDGE_API_TOKEN, KNOWLEDGE_API_PROJECT_ID, KNOWLEDGE_API_SPACE_IDS');
  const syntheticWrites=process.env.KNOWLEDGE_SYNTHETIC_WRITES==='1';
  const grantRaw=syntheticWrites?process.env.KNOWLEDGE_WRITER_GRANT_JSON:undefined;
  if(syntheticWrites&&!grantRaw)throw new Error('Synthetic writes require a trusted KNOWLEDGE_WRITER_GRANT_JSON capability');
  const grant=grantRaw?JSON.parse(grantRaw) as Partial<KnowledgeWriterGrant>:undefined;
  if(grant&&(typeof grant.ownerId!=='string'||!Number.isSafeInteger(grant.generation)||typeof grant.token!=='string'))
    throw new Error('Knowledge writer grant is malformed');
  const list=(value:string|undefined)=>value?.split(',').map(x=>x.trim()).filter(Boolean)??[];
  const pool=new Pool({connectionString:databaseUrl});
  const api=await createKnowledgeApi({pool,token,principal:{id:process.env.KNOWLEDGE_API_PRINCIPAL_ID??'local-owner',
    clientInstallationId:'local-api',projectId,spaceIds,purposes:['exploration_reading']},
    ...(grant?{writerGrant:grant as KnowledgeWriterGrant,enableSyntheticResearch:true,
      capabilities:{actions:list(process.env.KNOWLEDGE_API_ACTIONS),adapterIds:list(process.env.KNOWLEDGE_API_ADAPTER_IDS),
        rightsPolicyIds:list(process.env.KNOWLEDGE_API_RIGHTS_POLICY_IDS)},
      ...(process.env.KNOWLEDGE_FEEDBACK_SOURCE_RIGHTS_POLICY_REF?{feedbackSourceRightsPolicyRef:process.env.KNOWLEDGE_FEEDBACK_SOURCE_RIGHTS_POLICY_REF}:{})}:{}),
    ...(process.env.KNOWLEDGE_SOURCE_OWNER_URL?{sourceOwner:createHttpSourceOwner({baseUrl:process.env.KNOWLEDGE_SOURCE_OWNER_URL,token:process.env.KNOWLEDGE_SOURCE_OWNER_TOKEN??''})}:{}),
    syntheticFixture:process.env.KNOWLEDGE_SYNTHETIC_FIXTURE==='1',
    port:Number(process.env.KNOWLEDGE_API_PORT??4311)});
  const server=await api.listen();process.stdout.write(`Knowledge API listening on ${JSON.stringify(server.address())}\n`);
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>void pool.end()));
}
