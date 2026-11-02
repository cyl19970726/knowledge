import {Pool} from 'pg';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createKnowledgeStore} from '@commerce/knowledge-core/store';
import {migrateKnowledge} from '@commerce/knowledge-core/migrations';
import {createWikiSearchProjection} from '@commerce/knowledge-core/wiki-search-projection';
import type {KnowledgeWriterGrant} from '@commerce/knowledge-core/writer-authority';
import {createSyntheticResearchService,createMaintenanceApplication,type CapabilityContext,type MaintenanceProcessor,type SyntheticResearchProvider} from '@commerce/knowledge-application';
import {createPgKnowledgeOperations,migrateKnowledgeOperations,createPgKnowledgeReceiptPort,migrateKnowledgeReadReceipts} from '@commerce/knowledge-service-adapter';
import {createPgSourceRegistry,migrateManagedSources,createPgMaintenanceTasks,migrateMaintenanceTasks,createPgWikiLint,migrateWikiLint,migrateSourceIntake,migrateSemanticSweeps,createPgSemanticSweep} from '@commerce/knowledge-service-adapter';

export interface KnowledgeWorkerConfig {pool:Pool;projectId:string;writerGrant:KnowledgeWriterGrant;provider?:SyntheticResearchProvider;enableResearch?:boolean;maintenance?:{context:CapabilityContext;methodVersion:string;rubricVersion:string;processor?:MaintenanceProcessor;searchProjection?:{limit:number};lint?:{cyclePrefix:string;shardCount:number;limit:number};semanticSweep?:{cyclePrefix:string;shardCount:number;limit:number;maxTasksPerShard:number}}}
/** The only built-in provider is explicitly synthetic and performs no paid/model calls. */
export async function createKnowledgeWorker(config:KnowledgeWorkerConfig){
  if(!config.projectId)throw new Error('Explicit knowledge project required');
  await migrateKnowledge(config.pool);
  await migrateKnowledgeReadReceipts(config.pool);await migrateManagedSources(config.pool);await migrateKnowledgeOperations(config.pool);
  const research=createSyntheticResearchService({store:createKnowledgeStore(config.pool,{writerGrant:config.writerGrant}),
    receipts:createPgKnowledgeReceiptPort(config.pool),operations:createPgKnowledgeOperations(config.pool,config.writerGrant),
    sources:createPgSourceRegistry(config.pool,{writerGrant:config.writerGrant}),provider:config.provider});
  const maintenance=config.maintenance;
  const projection=createWikiSearchProjection(config.pool,{writerGrant:config.writerGrant});let projectionProgress:string|undefined;
  let maintained:ReturnType<typeof createMaintenanceApplication>|undefined,shard=0,lastLintCycle='';const lintUpdates=new Map<number,string>();let semanticShard=0,lastSemanticCycle='';const semanticProgress=new Map<number,string>();
  if(maintenance){
    if(maintenance.context.scope.projectId!==config.projectId)throw new Error('Maintenance context must match the configured worker project');
    if(maintenance.lint&&(!Number.isInteger(maintenance.lint.shardCount)||maintenance.lint.shardCount<1||maintenance.lint.shardCount>256))throw new Error('Lint shard count must be 1..256');
    await migrateSourceIntake(config.pool);await migrateMaintenanceTasks(config.pool);await migrateWikiLint(config.pool);
    if(maintenance.semanticSweep){if(!maintenance.processor?.kinds.includes('relation_check'))throw new Error('Periodic Wiki discovery needs an explicit relation processor');await migrateSemanticSweeps(config.pool);}
    maintained=createMaintenanceApplication({tasks:createPgMaintenanceTasks(config.pool,config.writerGrant),lint:createPgWikiLint(config.pool,config.writerGrant),processor:maintenance.processor,semanticSweep:maintenance.semanticSweep?createPgSemanticSweep(config.pool,config.writerGrant):undefined});
  }
  return {async runOne(signal?:AbortSignal){
    signal?.throwIfAborted();let changed=false;
    if(maintenance&&maintained){
      const collected=await maintained.collect(maintenance.context,{methodVersion:maintenance.methodVersion,rubricVersion:maintenance.rubricVersion,limit:100});
      changed=collected.taskIds.length>0||collected.hasMore;
      if(maintenance.searchProjection){
        const state=await projection.runBatch(config.projectId,maintenance.context.scope.spaceId,maintenance.searchProjection);
        const progress=JSON.stringify([state.ready,state.complete,state.lastObjectId,state.scanned,state.blockedRows]);
        changed=changed||progress!==projectionProgress;projectionProgress=progress;
      }
      if(maintenance.lint){const policy=maintenance.lint;
        const cycleKey=`${policy.cyclePrefix}:${new Date().toISOString().slice(0,10)}`;if(cycleKey!==lastLintCycle){lintUpdates.clear();lastLintCycle=cycleKey;}
        const pass=await maintained.runLint(maintenance.context,{cycleKey,shard,shardCount:policy.shardCount,limit:policy.limit,methodVersion:maintenance.methodVersion});
        changed=changed||pass.updatedAt!==lintUpdates.get(shard);lintUpdates.set(shard,pass.updatedAt);if(pass.complete)shard=(shard+1)%policy.shardCount;
      }
      if(maintenance.semanticSweep){const policy=maintenance.semanticSweep;
        const cycleKey=`${policy.cyclePrefix}:${new Date().toISOString().slice(0,10)}`;
        if(cycleKey!==lastSemanticCycle){semanticProgress.clear();lastSemanticCycle=cycleKey;semanticShard=0;}
        const pass=await maintained.runSemanticSweep(maintenance.context,{cycleKey,shard:semanticShard,shardCount:policy.shardCount,
          limit:policy.limit,maxTasksPerShard:policy.maxTasksPerShard,methodVersion:maintenance.methodVersion,rubricVersion:maintenance.rubricVersion});
        const progress=JSON.stringify([pass.scanned,pass.lastObjectId,pass.taskCount,pass.complete,pass.limitReached]);
        changed=changed||progress!==semanticProgress.get(semanticShard);semanticProgress.set(semanticShard,progress);
        if(pass.complete||pass.limitReached)semanticShard=(semanticShard+1)%policy.shardCount;
      }
      if(maintenance.processor)changed=!!await maintained.runOne(maintenance.context,signal)||changed;
    }
    return (config.enableResearch===false?false:await research.processOne(config.projectId))||changed;
  }};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const maintenanceEnabled=process.env.KNOWLEDGE_MAINTENANCE_ENABLED==='1';
  if(process.env.KNOWLEDGE_SYNTHETIC_WRITES!=='1'&&!maintenanceEnabled)throw new Error('Explicit synthetic research or metadata maintenance opt-in required');
  if(maintenanceEnabled&&!process.env.KNOWLEDGE_MAINTENANCE_SPACE_ID?.trim())throw new Error('Metadata maintenance requires an explicit space ID');
  const connectionString=process.env.KNOWLEDGE_DATABASE_URL,projectId=process.env.KNOWLEDGE_API_PROJECT_ID,
    grantJson=process.env.KNOWLEDGE_WRITER_GRANT_JSON;
  if(!connectionString||!projectId||!grantJson)throw new Error('Set KNOWLEDGE_DATABASE_URL, KNOWLEDGE_API_PROJECT_ID, KNOWLEDGE_WRITER_GRANT_JSON');
  const parsed=JSON.parse(grantJson) as Partial<KnowledgeWriterGrant>;
  if(typeof parsed.ownerId!=='string'||!Number.isSafeInteger(parsed.generation)||typeof parsed.token!=='string')
    throw new Error('Knowledge writer grant is malformed');
  const pool=new Pool({connectionString}),worker=await createKnowledgeWorker({pool,projectId,writerGrant:parsed as KnowledgeWriterGrant,enableResearch:process.env.KNOWLEDGE_SYNTHETIC_WRITES==='1',
    ...maintenanceEnabled?{maintenance:{context:{scope:{projectId,spaceId:process.env.KNOWLEDGE_MAINTENANCE_SPACE_ID??'default'},purpose:process.env.KNOWLEDGE_MAINTENANCE_PURPOSE??'exploration_reading',
      principal:{id:process.env.KNOWLEDGE_API_PRINCIPAL_ID??'local-owner',clientInstallationId:process.env.KNOWLEDGE_API_CLIENT_INSTALLATION_ID??'local-api',projectId,spaceIds:[process.env.KNOWLEDGE_MAINTENANCE_SPACE_ID??'default'],purposes:[process.env.KNOWLEDGE_MAINTENANCE_PURPOSE??'exploration_reading']},authorization:{actions:['maintenance:read','maintenance:write'],adapterIds:[],rightsPolicyIds:[]}},
      methodVersion:'wiki-maintenance-v1',rubricVersion:'wiki-relations-v1',searchProjection:{limit:100},lint:{cyclePrefix:'daily',shardCount:16,limit:50}}}:{} });
  let stopped=false;for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{stopped=true;});
  while(!stopped){const worked=await worker.runOne();if(!worked)await new Promise(resolve=>setTimeout(resolve,1000));}
  await pool.end();
}
