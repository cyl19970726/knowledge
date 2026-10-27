import type {createKnowledgeClient,WriteOptions} from '@commerce/knowledge-client';
import type {SourceUpsert,FeedbackInput,UseInput} from '@commerce/knowledge-contracts';
type Client=ReturnType<typeof createKnowledgeClient>;
async function sha(text:string){return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(x=>x.toString(16).padStart(2,'0')).join('');}
export interface DocumentContribution {
 externalId:string;version:string;text:string;author:string|null;publisher:string|null;acquirer:string;obtainedAt:string;
 rightsPolicyRef:string;expectedSourceHead:string|null;existingObjectId?:string;
 sourceGroups:SourceUpsert['sourceGroups'];limitations:string[];
}
/** Plain document integration uses the same public capability client as all other businesses. */
export function createDocumentKnowledgeAdapter(client:Client,adapterId='document'){return{
 async contribute(input:DocumentContribution,write:WriteOptions){const source:SourceUpsert={
  externalIdentity:{adapterId,externalObjectId:input.externalId,externalVersion:input.version},expectedSourceHead:input.expectedSourceHead,
  ...(input.existingObjectId?{existingObjectId:input.existingObjectId}:{}),sourceSchemaVersion:'document-text@1',contentDigest:await sha(input.text),
  custody:{mode:'managed_copy',text:input.text},sourceKind:'document',author:input.author,publisher:input.publisher,acquirer:input.acquirer,publishedAt:null,obtainedAt:input.obtainedAt,
  assertionKind:'source_claim',sourceGroups:input.sourceGroups,anchors:input.text.split(/\n\s*\n/).map((_,i)=>({kind:'paragraph' as const,value:String(i+1),resolved:true})),
  actualCoverage:[],limitations:input.limitations,rightsPolicyRef:input.rightsPolicyRef};return client.registerSource(source,write);},
 context:(externalId:string,contextVersion:string,inputDigest:string,description:string):UseInput['context']=>({adapterId,externalId,contextVersion,inputDigest,authority:'caller_reported',description}),
 query:client.query,
 use:(input:UseInput,write:WriteOptions)=>{if(input.context.adapterId!==adapterId)throw new TypeError('Use context adapter differs');return client.recordUse(input,write);},
 feedback:(input:FeedbackInput,write:WriteOptions)=>{if(input.context.adapterId!==adapterId)throw new TypeError('Feedback context adapter differs');return client.recordFeedback(input,write);},
};}
