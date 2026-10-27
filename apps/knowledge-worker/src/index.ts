import {Pool} from 'pg';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createKnowledgeStore} from '@commerce/knowledge-core/store';
import type {KnowledgeWriterGrant} from '@commerce/knowledge-core/writer-authority';
import {createSyntheticResearchService,type SyntheticResearchProvider} from '@commerce/knowledge-application';
import {createPgKnowledgeOperations,migrateKnowledgeOperations,createPgKnowledgeReceiptPort,migrateKnowledgeReadReceipts} from '@commerce/knowledge-service-adapter';
import {createPgSourceRegistry,migrateManagedSources} from '@commerce/knowledge-service-adapter';

export interface KnowledgeWorkerConfig {pool:Pool;projectId:string;writerGrant:KnowledgeWriterGrant;provider?:SyntheticResearchProvider}
/** The only built-in provider is explicitly synthetic and performs no paid/model calls. */
export async function createKnowledgeWorker(config:KnowledgeWorkerConfig){
  if(!config.projectId)throw new Error('Explicit knowledge project required');
  await migrateKnowledgeReadReceipts(config.pool);await migrateManagedSources(config.pool);await migrateKnowledgeOperations(config.pool);
  const research=createSyntheticResearchService({store:createKnowledgeStore(config.pool,{writerGrant:config.writerGrant}),
    receipts:createPgKnowledgeReceiptPort(config.pool),operations:createPgKnowledgeOperations(config.pool,config.writerGrant),
    sources:createPgSourceRegistry(config.pool,{writerGrant:config.writerGrant}),provider:config.provider});
  return {runOne:()=>research.processOne(config.projectId)};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.env.KNOWLEDGE_SYNTHETIC_WRITES!=='1')throw new Error('Set KNOWLEDGE_SYNTHETIC_WRITES=1 for isolated engineering research');
  const connectionString=process.env.KNOWLEDGE_DATABASE_URL,projectId=process.env.KNOWLEDGE_API_PROJECT_ID,
    grantJson=process.env.KNOWLEDGE_WRITER_GRANT_JSON;
  if(!connectionString||!projectId||!grantJson)throw new Error('Set KNOWLEDGE_DATABASE_URL, KNOWLEDGE_API_PROJECT_ID, KNOWLEDGE_WRITER_GRANT_JSON');
  const parsed=JSON.parse(grantJson) as Partial<KnowledgeWriterGrant>;
  if(typeof parsed.ownerId!=='string'||!Number.isSafeInteger(parsed.generation)||typeof parsed.token!=='string')
    throw new Error('Knowledge writer grant is malformed');
  const pool=new Pool({connectionString}),worker=await createKnowledgeWorker({pool,projectId,writerGrant:parsed as KnowledgeWriterGrant});
  let stopped=false;for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{stopped=true;});
  while(!stopped){const worked=await worker.runOne();if(!worked)await new Promise(resolve=>setTimeout(resolve,1000));}
  await pool.end();
}
