import {createServer as createHttpServer} from 'node:http';
import type {Server} from 'node:http';
import {timingSafeEqual,randomUUID,createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import express from 'express';
import {readPrincipalsFile} from './principals-file.ts';
import type {Express} from 'express';
import {Pool} from 'pg';
import {ZodError} from 'zod';
import {createKnowledgeStore} from '@commerce/knowledge-core/store';
import {migrateKnowledge} from '@commerce/knowledge-core/migrations';
import {createWikiSearchProjection} from '@commerce/knowledge-core/wiki-search-projection';
import {KnowledgeError} from '@commerce/knowledge-core/types';
import {digest} from '@commerce/knowledge-core/utils';
import type {KnowledgeWriterGrant} from '@commerce/knowledge-core/writer-authority';
import {listWikiPageProfiles,wikiPageProfileFingerprint} from '@commerce/knowledge-core/wiki-page';
import {createKnowledgeApplication,createSourceApplication,createSyntheticResearchService,createUseFeedbackApplication,createReviewApplication,createFeedbackSourceApplication,
  createAskWikiService,createAskAnswerReader,createAnswerResearchApplication,createSourceIntakeApplication,createWikiCompileApplication,createMaintenanceApplication,createRelationJudgmentApplication,createSourcePlanApplication,createCoordinationProcessor,type SourcePlanner,type CoordinationPolicy,type DecisionProvider,type WikiCompiler,type QueryAnswerer,
  type KnowledgeApplication,type Principal,type ReadContext,type CapabilityContext,type CapabilityPrincipal,type SyntheticResearchProvider,type SourceOwnerPort} from '@commerce/knowledge-application';
import {createPgKnowledgeReceiptPort,migrateKnowledgeReadReceipts,createPgKnowledgeOperations,migrateKnowledgeOperations,
  createPgSourceRegistry,migrateManagedSources,createHttpSourceOwner,routeSourceOwners,createPgUseFeedbackPort,migrateKnowledgeUses} from '@commerce/knowledge-service-adapter';
import {createPgReviewPort,migrateKnowledgeReviews,lookupCapabilityOperation,getCapabilityOperation,createPgFeedbackSourcePort,
  createPgFeedbackResearchPort,createPgKnowledgeAnswers,migrateKnowledgeAnswers,createPgSourceIntake,migrateSourceIntake,createPgWikiCompilations,migrateWikiCompilations,createPgWikiCompileStage,migrateMaintenanceTasks,createPgMaintenanceTasks,migrateWikiLint,createPgWikiLint,migrateRelationJudgments,createPgRelationJudgments,migrateSourcePlans,createPgSourcePlans,migrateCoordinationRuns,createPgCoordinationRuns,migrateSemanticSweeps,createPgSemanticSweep} from '@commerce/knowledge-service-adapter';
import {createModelDisclosureAuthorizer,type ModelDisclosurePolicy,createModelCallService,readClaudeRuntimeConfig,readApiKeyFile,createAnthropicTransport,
  createPgSpendLedger,migrateModelSpend,createClaudeModelPort,createClaudeAnswerer,createClaudeSourcePlanner,createClaudeWikiCompiler,createClaudeDecisionProvider,
  createPgModelCallStore,migrateModelCalls} from '@commerce/knowledge-claude-adapter';
import {ModelCallRequestSchema,ReviewQueueRequestSchema,CONTRACT_VERSION,CatalogRequestSchema,CompareRequestSchema,GraphRequestSchema,HistoryRequestSchema,KnowledgeRefSchema,QueryRequestSchema,ReadReceiptSchema,
  SourceUpsertSchema,ResearchRequestSchema,CancelRequestSchema,OperationLookupSchema,UseInputSchema,FeedbackInputSchema,ChangesRequestSchema,
  ReviewRequestSchema,ReviewDecisionSchema,FeedbackSourceRequestSchema,AskRequestSchema,SourceEventRequestSchema,EntityMentionExtractionSchema,WikiCompileRequestSchema,MaintenanceCollectRequestSchema,LintRequestSchema,RelationJudgmentRequestSchema,SearchProjectionBuildRequestSchema,SourcePlanRequestSchema,SemanticSweepApiRequestSchema,AnswerResearchRequestSchema} from '@commerce/knowledge-contracts';

/** One authenticated party. Only the SHA-256 of its bearer token is configured; actions and purposes are per principal. */
export interface ApiPrincipal {tokenSha256:string;principal:Principal;capabilities:CapabilityPrincipal}
export interface KnowledgeApiConfig {pool:Pool;
  /** Legacy single principal; ignored when principals is set. */
  token?:string;principal?:Principal;principals?:readonly ApiPrincipal[];port?:number;host?:string;
  writerGrant?:KnowledgeWriterGrant;enableSyntheticResearch?:boolean;researchProvider?:SyntheticResearchProvider;capabilities?:CapabilityPrincipal;
  syntheticFixture?:boolean;feedbackSourceRightsPolicyRef?:string;
  /** External model disclosure policy; builds dispatch authorizers that are not supplied explicitly. */
  modelDisclosure?:ModelDisclosurePolicy;authorizeAskDispatch?:Parameters<typeof createAskWikiService>[0]['authorizeExternalDispatch'];
  modelCalls?:ReturnType<typeof createModelCallService>;sourceOwner?:SourceOwnerPort;answerer?:QueryAnswerer;enableSourceIngest?:boolean;compiler?:WikiCompiler;authorizeCompilerDispatch?:Parameters<typeof createWikiCompileApplication>[0]['authorizeExternalDispatch'];sourceReaderIds?:readonly string[];enableMaintenance?:boolean;decisionProvider?:DecisionProvider;authorizeDecisionDispatch?:Parameters<typeof createRelationJudgmentApplication>[0]['authorizeExternalDispatch'];sourcePlanner?:SourcePlanner;authorizeSourcePlannerDispatch?:Parameters<typeof createSourcePlanApplication>[0]['authorizeExternalDispatch'];coordinationPolicy?:Omit<CoordinationPolicy,'providerFingerprint'>}
export interface KnowledgeApi {app:Express;service:KnowledgeApplication;research:ReturnType<typeof createSyntheticResearchService>|null;coordination:ReturnType<typeof createCoordinationProcessor>|null;listen():Promise<Server>}
export const tokenSha256=(token:string)=>createHash('sha256').update(token,'utf8').digest('hex');
function equalDigest(actual:string,expected:string):boolean {const a=Buffer.from(actual,'hex'),b=Buffer.from(expected,'hex');return a.length===32&&b.length===32&&timingSafeEqual(a,b);}
const emptyCapabilities:CapabilityPrincipal={actions:[],adapterIds:[],rightsPolicyIds:[]};
function apiPrincipals(config:KnowledgeApiConfig):readonly ApiPrincipal[]{
  if(!config.principals){
    if(!config.token||config.token.length<24)throw new Error('KNOWLEDGE_API_TOKEN must be a nonempty random secret of at least 24 characters');
    if(!config.principal)throw new Error('Explicit principal required');
    return [{tokenSha256:tokenSha256(config.token),principal:config.principal,capabilities:config.capabilities??emptyCapabilities}];
  }
  const entries=config.principals;
  if(!entries.length||entries.length>50)throw new Error('Configure 1..50 API principals');
  const ids=new Set<string>(),tokens=new Set<string>();
  for(const entry of entries){
    if(!/^[a-f0-9]{64}$/.test(entry.tokenSha256))throw new Error('Each principal needs a lowercase SHA-256 token digest');
    if(!entry.principal.id.trim()||ids.has(entry.principal.id))throw new Error('Principal ids must be nonempty and distinct');
    if(tokens.has(entry.tokenSha256))throw new Error('Principals must not share a token');
    ids.add(entry.principal.id);tokens.add(entry.tokenSha256);
  }
  return entries;
}
const message=(error:unknown)=>error instanceof Error?error.message:'Unexpected error';

/** Standalone knowledge-only API. No AnalysisHost, Foundation, video, or model construction. */
export async function createKnowledgeApi(config:KnowledgeApiConfig):Promise<KnowledgeApi>{
  const principals=apiPrincipals(config);
  for(const {principal} of principals)
    if(!principal.projectId||!principal.spaceIds.length||!principal.purposes.length)throw new Error('Explicit project, space and purpose scope required');
  const capabilitiesOf=new Map(principals.map(entry=>[entry.principal.id,entry.capabilities]));
  // Core tables and guard functions must exist before any adapter installs its triggers. Migration does not activate a writer.
  await migrateKnowledge(config.pool);
  await migrateKnowledgeReadReceipts(config.pool);
  await migrateManagedSources(config.pool);
  await migrateKnowledgeUses(config.pool,{writerGrant:config.writerGrant});
  await migrateKnowledgeReviews(config.pool);
  if(config.enableSyntheticResearch&&!config.writerGrant)throw new Error('Synthetic research requires a trusted writer grant');
  // Reviews inspect operation lineage even when synthetic execution itself is disabled.
  if(config.writerGrant)await migrateKnowledgeOperations(config.pool);
  if(config.answerer||config.compiler){if(!config.writerGrant)throw new Error('AskWiki requires a trusted operation writer grant');await migrateKnowledgeAnswers(config.pool);}
  if(config.enableSourceIngest){if(!config.writerGrant)throw new Error('Source intake requires a trusted writer grant');await migrateSourceIntake(config.pool);}
  if(config.compiler){if(!config.writerGrant||!config.enableSourceIngest)throw new Error('Wiki compiler requires an active writer configuration and explicit source intake');await migrateWikiCompilations(config.pool);}
  if(config.sourceReaderIds&&(config.sourceReaderIds.length>100||config.sourceReaderIds.some(id=>!id.trim()||id.length>200)))throw new Error('Source reader IDs require bounded authenticated identities');
  if(config.enableMaintenance){if(!config.writerGrant)throw new Error('Maintenance requires an active writer configuration');await migrateSourceIntake(config.pool);await migrateMaintenanceTasks(config.pool);await migrateWikiLint(config.pool);}
  if(config.decisionProvider){if(!config.writerGrant)throw new Error('Decision judgment requires an active writer configuration');await migrateRelationJudgments(config.pool);}
  if(config.sourcePlanner){if(!config.writerGrant||!config.enableSourceIngest)throw new Error('Source planner requires explicit source intake and writer');await migrateSourcePlans(config.pool);}
  if(config.coordinationPolicy){if(!config.compiler||!config.enableMaintenance)throw new Error('Coordination requires explicit compiler and maintenance');await migrateCoordinationRuns(config.pool);await migrateSemanticSweeps(config.pool);}
  const app=express();app.disable('x-powered-by');
  // Model-call evaluation arms may carry a full source text; every other route keeps the 1 MB body limit.
  const smallJson=express.json({limit:'1mb'}),modelCallJson=express.json({limit:'8mb'});
  app.use((req,res,next)=>(req.method==='POST'&&/\/knowledge\/model-calls$/.test(req.path)?modelCallJson:smallJson)(req,res,next));
  const store=createKnowledgeStore(config.pool,{writerGrant:config.writerGrant}),receipts=createPgKnowledgeReceiptPort(config.pool);
  const sourceRegistry=createPgSourceRegistry(config.pool,{writerGrant:config.writerGrant,readerIds:config.sourceReaderIds??principals.map(entry=>entry.principal.id)});
  const sources=createSourceApplication(sourceRegistry);
  const useFeedback=createUseFeedbackApplication(createPgUseFeedbackPort(config.pool,{writerGrant:config.writerGrant}));
  const reviews=config.writerGrant?createReviewApplication(createPgReviewPort(config.pool,config.writerGrant,sourceRegistry)):null;
  const feedbackSources=config.writerGrant&&config.feedbackSourceRightsPolicyRef?
    createFeedbackSourceApplication(createPgFeedbackSourcePort(config.pool,{writerGrant:config.writerGrant,rightsPolicyRef:config.feedbackSourceRightsPolicyRef})):null;
  const service=createKnowledgeApplication({store,receipts,sources:routeSourceOwners(sourceRegistry,config.sourceOwner)});
  const disclose=config.modelDisclosure?createModelDisclosureAuthorizer({policy:config.modelDisclosure,sourceRecord:(context,ref)=>service.sourceRecord(context,ref)}):null;
  const authorizeAsk=config.authorizeAskDispatch??(disclose?((context,evidence)=>disclose(context,evidence)) satisfies NonNullable<KnowledgeApiConfig['authorizeAskDispatch']>:undefined);
  const authorizeDecision=config.authorizeDecisionDispatch??(disclose?((context,evidence)=>disclose(context,evidence)) satisfies NonNullable<KnowledgeApiConfig['authorizeDecisionDispatch']>:undefined);
  const authorizePlanner=config.authorizeSourcePlannerDispatch??(disclose?((context,source)=>disclose(context,source)) satisfies NonNullable<KnowledgeApiConfig['authorizeSourcePlannerDispatch']>:undefined);
  const authorizeCompiler=config.authorizeCompilerDispatch??(disclose?((context,evidence)=>disclose(context,evidence)) satisfies NonNullable<KnowledgeApiConfig['authorizeCompilerDispatch']>:undefined);
  const answerOperations=config.writerGrant&&(config.answerer||config.compiler)?createPgKnowledgeAnswers(config.pool,config.writerGrant):null;
  const answerReader=answerOperations?createAskAnswerReader({reader:service,operations:answerOperations}):null;
  const sourceIntake=config.enableSourceIngest&&config.writerGrant?createSourceIntakeApplication({reader:service,port:createPgSourceIntake(config.pool,config.writerGrant)}):null;
  const judgment=config.decisionProvider&&config.writerGrant?createRelationJudgmentApplication({reader:service,operations:createPgRelationJudgments(config.pool,config.writerGrant),provider:config.decisionProvider,authorizeExternalDispatch:authorizeDecision}):null;
  const sourcePlan=config.sourcePlanner&&config.writerGrant&&sourceIntake?createSourcePlanApplication({reader:service,intake:sourceIntake,operations:createPgSourcePlans(config.pool,config.writerGrant),provider:config.sourcePlanner,authorizeExternalDispatch:authorizePlanner}):null;
  const wikiCompile=config.compiler&&config.writerGrant&&sourceIntake?createWikiCompileApplication({reader:service,intake:sourceIntake,operations:createPgWikiCompilations(config.pool,config.writerGrant),provider:config.compiler,
    sources:sourceRegistry,stage:createPgWikiCompileStage(config.pool,config.writerGrant,sourceRegistry),judgments:judgment??undefined,answers:answerReader??undefined,authorizeExternalDispatch:authorizeCompiler}):null;
  const answerResearch=wikiCompile&&answerReader?createAnswerResearchApplication({answers:answerReader,compiler:wikiCompile}):null;
  const coordination=config.coordinationPolicy&&wikiCompile&&config.writerGrant?createCoordinationProcessor({reader:service,intake:sourceIntake??undefined,planner:sourcePlan??undefined,compiler:wikiCompile,judgments:judgment??undefined,operations:createPgCoordinationRuns(config.pool,config.writerGrant),tasks:createPgMaintenanceTasks(config.pool,config.writerGrant),
    policy:{...config.coordinationPolicy,providerFingerprint:digest({planner:config.sourcePlanner&&{id:config.sourcePlanner.id,version:config.sourcePlanner.version,model:config.sourcePlanner.model},compiler:config.compiler&&{id:config.compiler.id,version:config.compiler.methodVersion,model:config.compiler.model},judgment:config.decisionProvider&&{id:config.decisionProvider.id,version:config.decisionProvider.version,model:config.decisionProvider.model}})},
    execution:[config.sourcePlanner?.execution,config.compiler?.execution,config.decisionProvider?.execution].includes('external')?'external':'local_deterministic'}):null;
  const projection=config.enableMaintenance&&config.writerGrant?createWikiSearchProjection(config.pool,{writerGrant:config.writerGrant}):null;
  const maintenance=config.enableMaintenance&&config.writerGrant?createMaintenanceApplication({tasks:createPgMaintenanceTasks(config.pool,config.writerGrant),lint:createPgWikiLint(config.pool,config.writerGrant),processor:coordination??undefined,semanticSweep:coordination?createPgSemanticSweep(config.pool,config.writerGrant):undefined,
    searchProjection:{status:context=>projection!.status(context.scope.projectId,context.scope.spaceId),runBatch:(context,input)=>projection!.runBatch(context.scope.projectId,context.scope.spaceId,input)}}):null;
  const askWiki=config.answerer&&config.writerGrant?createAskWikiService({reader:service,
    operations:answerOperations!,provider:config.answerer,authorizeExternalDispatch:authorizeAsk}):null;
  const operations=config.enableSyntheticResearch&&config.writerGrant?createPgKnowledgeOperations(config.pool,config.writerGrant):null;
  const research=operations?createSyntheticResearchService({store,receipts,operations,sources:sourceRegistry,
    feedback:createPgFeedbackResearchPort(config.pool),provider:config.researchProvider}):null;
  const profiles=listWikiPageProfiles().map(profile=>({id:profile.id,version:profile.version,digest:wikiPageProfileFingerprint(profile)}));
  app.use((req,res,next)=>{const bearer=/^Bearer (.+)$/.exec(req.header('authorization')??'');
    const presented=bearer?tokenSha256(bearer[1]):'';
    // Compare against every principal so timing does not reveal which entry matched.
    let found:ApiPrincipal|undefined;for(const entry of principals)if(bearer&&equalDigest(presented,entry.tokenSha256))found=entry;
    if(!found){res.status(401).json({requestId:randomUUID(),code:'UNAUTHORIZED',message:'Authenticated token required',retryable:false,commitStatus:'not_committed'});return;}
    res.locals.principal=found.principal;next();});
  const base='/api/v1/projects/:projectId/spaces/:spaceId/knowledge';
  const route=(handler:(context:ReadContext,req:express.Request)=>Promise<{data:unknown;coverage?:unknown;receiptId?:string}>|{data:unknown;coverage?:unknown;receiptId?:string})=>
    async(req:express.Request,res:express.Response)=>{const requestId=randomUUID();try{
      const projectId=String(req.params.projectId),spaceId=String(req.params.spaceId),purpose=String(req.body?.purpose??req.query.purpose??'exploration_reading');
      const principal=res.locals.principal as Principal;
      const context:ReadContext={scope:{projectId,spaceId},principal,purpose};
      if(projectId!==principal.projectId||!principal.spaceIds.includes(spaceId)||!principal.purposes.includes(purpose))
        throw new KnowledgeError('SCOPE_FORBIDDEN','Project, space or purpose is not authorized',403);
      const result=await handler(context,req);
      res.setHeader('cache-control','no-store');res.json({contractVersion:CONTRACT_VERSION,requestId,effectiveScope:context.scope,
        observedAt:new Date().toISOString(),data:result.data,warnings:config.syntheticFixture?['synthetic_engineering_fixture']:[],
        ...(result.coverage?{coverage:result.coverage}:{}),...(result.receiptId?{readReceiptId:result.receiptId}:{})});
    }catch(error){const known=typeof error==='object'&&error!==null&&'code' in error&&'status' in error&&
        typeof error.code==='string'&&typeof error.status==='number'&&error.status>=400&&error.status<600;
      const status=known?Number(error.status):error instanceof ZodError?400:500;
      const code=known?String(error.code):error instanceof ZodError?'INVALID_REQUEST':'INTERNAL_ERROR';
      res.status(status).json({requestId,code,message:status===500?'Knowledge request failed':message(error),
        retryable:(status===409||status===503)&&!(typeof error==='object'&&error&&'commitStatus' in error&&error.commitStatus==='unknown'),
        commitStatus:typeof error==='object'&&error&&'commitStatus' in error?error.commitStatus:'not_committed',
        ...(typeof error==='object'&&error&&'operationId' in error?{operationId:error.operationId}:{})});
    }};
  app.get(`${base}/capabilities`,route(async(context,req)=>{const caps=capabilitiesOf.get(context.principal.id)??emptyCapabilities;return {data:{permittedActions:['query','catalog','wikiCatalog','exact','history','compare','graph','read_receipt',
    ...config.writerGrant&&caps.actions.includes('sources:write')?['registerSource']:[],
    ...config.writerGrant&&caps.actions.includes('uses:write')?['recordUse']:[],
    ...config.writerGrant&&caps.actions.includes('feedback:write')?['recordFeedback']:[],
    ...feedbackSources&&caps.actions.includes('feedback:source')?['registerFeedbackSource']:[],
    ...config.enableSyntheticResearch&&config.writerGrant&&caps.actions.includes('research:write')?['research']:[],
    ...config.writerGrant&&caps.actions.includes('review:request')?['requestReview']:[],
    ...config.writerGrant&&caps.actions.includes('review:decide')?['decideReview']:[],
    ...config.writerGrant&&caps.actions.some(action=>['review:read','review:request','review:decide'].includes(action))?['reviewTicket']:[],
    ...askWiki&&caps.actions.includes('ask:write')?['ask','answer','askSelection']:[],
    ...sourceIntake&&caps.actions.includes('ingest:write')?['registerSourceEvent']:[],
    ...maintenance&&caps.actions.includes('maintenance:read')?['maintenanceTasks','maintenanceFindings','searchProjectionStatus']:[],
    ...sourcePlan&&caps.actions.includes('source-plans:read')&&caps.actions.includes('ingest:read')?['sourcePlan']:[],
    ...sourcePlan&&caps.actions.includes('source-plans:write')&&caps.actions.includes('source-plans:read')&&caps.actions.includes('ingest:read')?['planSource']:[],
    ...coordination&&caps.actions.includes('maintenance:read')?['coordinationRun','semanticSweep']:[],
    ...coordination&&caps.actions.includes('maintenance:write')?['processMaintenance','runSemanticSweep']:[],
    ...maintenance&&caps.actions.includes('maintenance:write')?['collectMaintenance','lintWiki','cancelMaintenance','rebuildSearchProjection']:[],
    ...judgment&&caps.actions.includes('judgments:write')&&caps.actions.includes('judgments:read')?['judgeRelation']:[],
    ...judgment&&caps.actions.includes('judgments:read')?['judgment']:[],
    ...sourceIntake&&caps.actions.includes('ingest:read')?['sourceEvent']:[],
    ...wikiCompile&&caps.actions.includes('compile:write')&&caps.actions.includes('compile:read')?['compileWiki']:[],
    ...wikiCompile&&caps.actions.includes('compile:read')?['compilation']:[],
    ...answerResearch&&caps.actions.includes('compile:write')&&caps.actions.includes('compile:read')?['researchAnswer']:[],
    ...config.modelCalls&&caps.actions.includes('model:call')?['modelCall']:[],
    ...sourceIntake&&caps.actions.includes('ingest:mentions')&&caps.actions.includes('ingest:read')?['recordEntityMentions']:[]],
    purposes:context.principal.purposes,profiles,mode:config.writerGrant?'ready':'read_only',contractVersion:CONTRACT_VERSION,policyVersion:service.policyVersion,
    ...(req.query.recovery==='1'?{recoveryScope:digest({principalId:context.principal.id,clientInstallationId:context.principal.clientInstallationId,projectId:context.scope.projectId,spaceId:context.scope.spaceId})}:{}),
    limits:{queryItems:100,graphNodes:200,receiptTtlSeconds:900,queryIdentityLexicalVersion:2}}};}));
  app.get(`${base}/profiles`,route(async()=>({data:profiles})));
  app.post(`${base}/query`,route((context,req)=>service.query(context,QueryRequestSchema.parse(req.body))));
  app.get(`${base}/catalog`,route((context,req)=>service.catalog(context,CatalogRequestSchema.parse({
    purpose:req.query.purpose,query:req.query.query,kinds:req.query.kinds===undefined?undefined:Array.isArray(req.query.kinds)?req.query.kinds:[req.query.kinds],limit:Number(req.query.limit??50),cursor:req.query.cursor}))));
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
  const capability=(context:ReadContext):CapabilityContext=>({...context,authorization:capabilitiesOf.get(context.principal.id)??emptyCapabilities});
  const intake=()=>{if(!sourceIntake)throw new KnowledgeError('SOURCE_INTAKE_DISABLED','Source intake is not configured',503);return sourceIntake;};
  app.post(`${base}/source-events`,route(async(context,req)=>{
    const input=SourceEventRequestSchema.parse(req.body);
    if(req.header('Idempotency-Key')!==input.eventKey)throw new KnowledgeError('IDEMPOTENCY_KEY_MISMATCH','Header must retain the producer event key',409);
    return {data:await intake().receive(capability(context),input)};
  }));
  app.get(`${base}/source-events/lookup`,route(async(context,req)=>{
    const found=await intake().lookup(capability(context),SourceEventRequestSchema.shape.adapterId.parse(req.query.adapterId),SourceEventRequestSchema.shape.eventKey.parse(req.query.eventKey));
    return {data:found?{state:'known',event:found}:{state:'unknown',event:null}};
  }));
  app.get(`${base}/source-events/:eventId`,route(async(context,req)=>({data:await intake().get(capability(context),ReadReceiptSchema.shape.id.parse(req.params.eventId))})));
  app.post(`${base}/source-events/:eventId/mentions`,route(async(context,req)=>{
    const input=EntityMentionExtractionSchema.parse(req.body);
    if(req.header('Idempotency-Key')!==input.methodVersion)throw new KnowledgeError('IDEMPOTENCY_KEY_MISMATCH','Header must retain the extraction method version',409);
    return {data:await intake().recordMentions(capability(context),ReadReceiptSchema.shape.id.parse(req.params.eventId),input,100_000)};
  }));
  app.get(`${base}/source-events/:eventId/mentions`,route(async(context,req)=>({data:await intake().mentions(capability(context),ReadReceiptSchema.shape.id.parse(req.params.eventId),EntityMentionExtractionSchema.shape.methodVersion.parse(req.query.methodVersion))})));
  const planner=()=>{if(!sourcePlan)throw new KnowledgeError('SOURCE_PLANNER_DISABLED','Source planner is not configured',503);return sourcePlan;};
  app.post(`${base}/source-plans`,route(async(context,req)=>({data:await planner().plan(capability(context),SourcePlanRequestSchema.parse(req.body),String(req.header('Idempotency-Key')??''))})));
  app.get(`${base}/source-plans/lookup`,route(async(context,req)=>{const found=await planner().lookup(capability(context),String(req.query.key??''));return {data:found?{state:'known',plan:found}:{state:'unknown',plan:null}};}));
  app.get(`${base}/source-plans/:planId`,route(async(context,req)=>({data:await planner().get(capability(context),ReadReceiptSchema.shape.id.parse(req.params.planId))})));
  const coordinated=()=>{if(!coordination)throw new KnowledgeError('COORDINATION_DISABLED','Coordination is not configured',503);return coordination;};
  app.get(`${base}/coordination-runs/by-task/:taskId`,route(async(context,req)=>({data:await coordinated().byTask(capability(context),ReadReceiptSchema.shape.id.parse(req.params.taskId))})));
  app.get(`${base}/coordination-runs/:runId`,route(async(context,req)=>({data:await coordinated().get(capability(context),ReadReceiptSchema.shape.id.parse(req.params.runId))})));
  const compiler=()=>{if(!wikiCompile)throw new KnowledgeError('WIKI_COMPILER_DISABLED','Wiki compiler is not configured',503);return wikiCompile;};
  app.post(`${base}/compilations`,route(async(context,req)=>({data:await compiler().compile(capability(context),WikiCompileRequestSchema.parse(req.body),String(req.header('Idempotency-Key')??''))})));
  app.get(`${base}/compilations/lookup`,route(async(context,req)=>{const found=await compiler().lookup(capability(context),String(req.query.key??''));return {data:found?{state:'known',compilation:found}:{state:'unknown',compilation:null}};}));
  app.get(`${base}/compilations/:compilationId`,route(async(context,req)=>({data:await compiler().get(capability(context),ReadReceiptSchema.shape.id.parse(req.params.compilationId))})));
  const maintained=()=>{if(!maintenance)throw new KnowledgeError('MAINTENANCE_DISABLED','Maintenance is not configured',503);return maintenance;};
  app.get(`${base}/maintenance/search-index`,route(async(context)=>({data:await maintained().searchProjectionStatus(capability(context))})));
  app.post(`${base}/maintenance/search-index`,route(async(context,req)=>{const {purpose,...input}=SearchProjectionBuildRequestSchema.parse(req.body);if(purpose!==context.purpose)throw new KnowledgeError('PURPOSE_MISMATCH','Search build purpose differs',403);return {data:await maintained().rebuildSearchProjection(capability(context),input)};}));
  app.post(`${base}/maintenance/semantic-sweeps`,route(async(context,req)=>{coordinated();const {purpose,...input}=SemanticSweepApiRequestSchema.parse(req.body);if(purpose!==context.purpose)throw new KnowledgeError('PURPOSE_MISMATCH','Sweep purpose differs',403);return {data:await maintained().runSemanticSweep(capability(context),input)};}));
  app.get(`${base}/maintenance/semantic-sweeps/:passId`,route(async(context,req)=>({data:await maintained().semanticSweep(capability(context),ReadReceiptSchema.shape.id.parse(req.params.passId))})));
  app.post(`${base}/maintenance/process-one`,route(async(context)=>{coordinated();return {data:await maintained().runOne(capability(context))};}));
  app.post(`${base}/maintenance/collect`,route(async(context,req)=>{const input=MaintenanceCollectRequestSchema.parse(req.body);if(input.purpose!==context.purpose)throw new KnowledgeError('PURPOSE_MISMATCH','Maintenance purpose differs',403);return {data:await maintained().collect(capability(context),input)};}));
  app.post(`${base}/maintenance/lint`,route(async(context,req)=>{const {purpose,...input}=LintRequestSchema.parse(req.body);if(purpose!==context.purpose)throw new KnowledgeError('PURPOSE_MISMATCH','Lint purpose differs',403);return {data:await maintained().runLint(capability(context),input)};}));
  app.get(`${base}/maintenance/tasks`,route(async(context,req)=>({data:await maintained().list(capability(context),{limit:Number(req.query.limit??50),...typeof req.query.cursor==='string'?{cursor:req.query.cursor}:{}})})));
  app.get(`${base}/maintenance/tasks/:taskId`,route(async(context,req)=>({data:await maintained().get(capability(context),ReadReceiptSchema.shape.id.parse(req.params.taskId))})));
  app.post(`${base}/maintenance/tasks/:taskId/cancel`,route(async(context,req)=>({data:await maintained().cancel(capability(context),ReadReceiptSchema.shape.id.parse(req.params.taskId))})));
  app.get(`${base}/maintenance/findings`,route(async(context,req)=>({data:await maintained().findings(capability(context),{limit:Number(req.query.limit??50),...typeof req.query.cursor==='string'?{cursor:req.query.cursor}:{},...typeof req.query.status==='string'?{status:req.query.status as 'open'|'superseded'|'resolved'}:{}})})));
  const judgments=()=>{if(!judgment)throw new KnowledgeError('JUDGMENT_DISABLED','Decision provider is not configured',503);return judgment;};
  app.post(`${base}/judgments`,route(async(context,req)=>({data:await judgments().judge(capability(context),RelationJudgmentRequestSchema.parse(req.body),String(req.header('Idempotency-Key')??''))})));
  app.get(`${base}/judgments/lookup`,route(async(context,req)=>{const found=await judgments().lookup(capability(context),String(req.query.key??''));return {data:found?{state:'known',judgment:found}:{state:'unknown',judgment:null}};}));
  app.get(`${base}/judgments/:judgmentId`,route(async(context,req)=>({data:await judgments().get(capability(context),ReadReceiptSchema.shape.id.parse(req.params.judgmentId))})));
  app.post(`${base}/model-calls`,route(async(context,req)=>{if(!config.modelCalls)throw new KnowledgeError('MODEL_CALLS_DISABLED','Model calls are not configured',503);
    return {data:await config.modelCalls.call(capability(context),ModelCallRequestSchema.parse(req.body),String(req.header('Idempotency-Key')??''))};}));
  app.post(`${base}/ask`,route(async(context,req)=>{
    if(!askWiki)throw new KnowledgeError('ASK_DISABLED','AskWiki provider is not configured',503);
    return {data:await askWiki.ask(capability(context),AskRequestSchema.parse(req.body),String(req.header('Idempotency-Key')??''))};
  }));
  app.get(`${base}/answers/lookup`,route(async(context,req)=>{
    if(!askWiki)throw new KnowledgeError('ASK_DISABLED','AskWiki is not configured',503);
    return {data:await askWiki.lookup(context,String(req.query.key??''))};
  }));
  app.post(`${base}/answers/:answerId/research`,route(async(context,req)=>{
    if(!answerResearch)throw new KnowledgeError('ANSWER_RESEARCH_DISABLED','Answer research compiler is not configured',503);
    return {data:await answerResearch.research(capability(context),ReadReceiptSchema.shape.id.parse(req.params.answerId),AnswerResearchRequestSchema.parse(req.body),String(req.header('Idempotency-Key')??''))};
  }));
  app.get(`${base}/answers/:answerId`,route(async(context,req)=>{
    if(!askWiki)throw new KnowledgeError('ASK_DISABLED','AskWiki is not configured',503);
    return {data:await askWiki.get(context,ReadReceiptSchema.shape.id.parse(req.params.answerId))};
  }));
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
  app.get(`${base}/review-requests`,route(async(context,req)=>{if(!reviews)throw new KnowledgeError('REVIEW_DISABLED','Reviews are disabled',503);
    const q=ReviewQueueRequestSchema.parse({purpose:context.purpose,escalated:req.query.escalated,limit:req.query.limit===undefined?undefined:Number(req.query.limit)});
    return {data:{items:await reviews.queue(capability(context),{escalated:q.escalated,limit:q.limit})}};}));
  app.post(`${base}/review-requests/:reviewRequestId/escalations`,route(async(context,req)=>{if(!reviews)throw new KnowledgeError('REVIEW_DISABLED','Review writes are disabled',503);
    return {data:await reviews.escalate(capability(context),String(req.params.reviewRequestId),req.body,String(req.header('Idempotency-Key')??''))};}));
  app.get(`${base}/review-requests/:reviewRequestId`,route(async(context,req)=>{if(!reviews)throw new KnowledgeError('REVIEW_DISABLED','Reviews are disabled',503);
    const found=await reviews.ticket(capability(context),String(req.params.reviewRequestId));if(!found)throw new KnowledgeError('NOT_FOUND','Review ticket unavailable',404);return {data:found};}));
  app.post(`${base}/review-requests/:reviewRequestId/decisions`,route(async(context,req)=>{if(!reviews)throw new KnowledgeError('REVIEW_DISABLED','Reviews are disabled',503);
    return {data:await reviews.decide(capability(context),String(req.params.reviewRequestId),ReviewDecisionSchema.parse(req.body),
      String(req.header('Idempotency-Key')??''))};}));
  return {app,service,research,coordination,listen:()=>new Promise<ReturnType<typeof createHttpServer>>((resolve,reject)=>{const server=createHttpServer(app);
    server.once('error',reject);server.listen(config.port??4311,config.host??'127.0.0.1',()=>resolve(server));})};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const databaseUrl=process.env.KNOWLEDGE_DATABASE_URL,token=process.env.KNOWLEDGE_API_TOKEN,
    projectId=process.env.KNOWLEDGE_API_PROJECT_ID,spaceIds=process.env.KNOWLEDGE_API_SPACE_IDS?.split(',').map(x=>x.trim()).filter(Boolean);
  const principalsFile=process.env.KNOWLEDGE_API_PRINCIPALS_FILE?.trim();
  if(!databaseUrl||!(token||principalsFile)||!projectId||!spaceIds?.length)
    throw new Error('Set KNOWLEDGE_DATABASE_URL, KNOWLEDGE_API_TOKEN or KNOWLEDGE_API_PRINCIPALS_FILE, KNOWLEDGE_API_PROJECT_ID, KNOWLEDGE_API_SPACE_IDS');
  if(token&&principalsFile)throw new Error('Use either KNOWLEDGE_API_TOKEN or KNOWLEDGE_API_PRINCIPALS_FILE, not both');
  const principals=principalsFile?readPrincipalsFile(principalsFile,{projectId,spaceIds}):undefined;
  const syntheticWrites=process.env.KNOWLEDGE_SYNTHETIC_WRITES==='1';
  const sourceIntakeFlag=process.env.KNOWLEDGE_SOURCE_INTAKE_ENABLED;
  if(sourceIntakeFlag!==undefined&&!['0','1'].includes(sourceIntakeFlag))throw new Error('KNOWLEDGE_SOURCE_INTAKE_ENABLED must be 0 or 1');
  const sourceIntakeEnabled=sourceIntakeFlag==='1';
  const grantRaw=syntheticWrites||sourceIntakeEnabled?process.env.KNOWLEDGE_WRITER_GRANT_JSON:undefined;
  if(sourceIntakeEnabled&&!grantRaw)throw new Error('Source intake requires a trusted KNOWLEDGE_WRITER_GRANT_JSON capability');
  if(syntheticWrites&&!grantRaw)throw new Error('Synthetic writes require a trusted KNOWLEDGE_WRITER_GRANT_JSON capability');
  const grant=grantRaw?JSON.parse(grantRaw) as Partial<KnowledgeWriterGrant>:undefined;
  if(grant&&(typeof grant.ownerId!=='string'||!Number.isSafeInteger(grant.generation)||typeof grant.token!=='string'))
    throw new Error('Knowledge writer grant is malformed');
  const list=(value:string|undefined)=>value?.split(',').map(x=>x.trim()).filter(Boolean)??[];
  const pool=new Pool({connectionString:databaseUrl});
  const claude=readClaudeRuntimeConfig(process.env);
  let models:Partial<KnowledgeApiConfig>={};
  if(claude){
    if(!grant)throw new Error('Claude providers require a trusted KNOWLEDGE_WRITER_GRANT_JSON capability');
    await migrateModelSpend(pool);await migrateModelCalls(pool);
    const port=createClaudeModelPort({transport:createAnthropicTransport({apiKey:readApiKeyFile(claude.apiKeyFile)}),ledger:createPgSpendLedger(pool),config:claude.model});
    const has=(role:Parameters<typeof claude.roles.has>[0])=>claude.roles.has(role);
    models={modelDisclosure:claude.disclosure,
      ...has('ask')?{answerer:createClaudeAnswerer(port)}:{},
      ...has('source_plan')&&sourceIntakeEnabled?{sourcePlanner:createClaudeSourcePlanner(port)}:{},
      ...has('wiki_compile')&&sourceIntakeEnabled?{compiler:createClaudeWikiCompiler(port)}:{},
      ...has('relation_judgment')?{decisionProvider:createClaudeDecisionProvider(port)}:{},
      ...has('model_call')?{modelCalls:createModelCallService({port,store:createPgModelCallStore(pool)})}:{}};
    process.stdout.write(`Claude providers enabled: model=${claude.model.model} roles=${[...claude.roles].join(',')} perCallUsd=${claude.model.maxCallUsd} dailyUsd=${claude.model.dailyCapUsd}\n`);
  }
  const api=await createKnowledgeApi({pool,...principals?{principals}:{token},principal:{id:process.env.KNOWLEDGE_API_PRINCIPAL_ID??'local-owner',
    clientInstallationId:process.env.KNOWLEDGE_API_CLIENT_INSTALLATION_ID?.trim()||'local-api',projectId,spaceIds,purposes:['exploration_reading']},
    ...(grant?{writerGrant:grant as KnowledgeWriterGrant,enableSyntheticResearch:syntheticWrites,enableSourceIngest:sourceIntakeEnabled,
      capabilities:{actions:list(process.env.KNOWLEDGE_API_ACTIONS),adapterIds:list(process.env.KNOWLEDGE_API_ADAPTER_IDS),
        rightsPolicyIds:list(process.env.KNOWLEDGE_API_RIGHTS_POLICY_IDS)},
      ...(process.env.KNOWLEDGE_FEEDBACK_SOURCE_RIGHTS_POLICY_REF?{feedbackSourceRightsPolicyRef:process.env.KNOWLEDGE_FEEDBACK_SOURCE_RIGHTS_POLICY_REF}:{})}:{}),
    ...(process.env.KNOWLEDGE_SOURCE_OWNER_URL?{sourceOwner:createHttpSourceOwner({baseUrl:process.env.KNOWLEDGE_SOURCE_OWNER_URL,token:process.env.KNOWLEDGE_SOURCE_OWNER_TOKEN??'',
      supportsBoundedContent:process.env.KNOWLEDGE_SOURCE_OWNER_BOUNDED==='1'})}:{}),
    ...(process.env.KNOWLEDGE_SOURCE_READER_IDS?{sourceReaderIds:list(process.env.KNOWLEDGE_SOURCE_READER_IDS)}:{}),
    syntheticFixture:process.env.KNOWLEDGE_SYNTHETIC_FIXTURE==='1',...models,
    port:Number(process.env.KNOWLEDGE_API_PORT??4311)});
  const server=await api.listen();process.stdout.write(`Knowledge API listening on ${JSON.stringify(server.address())}\n`);
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>void pool.end()));
}
