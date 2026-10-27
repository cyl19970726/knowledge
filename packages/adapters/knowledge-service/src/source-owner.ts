import {createHash} from 'node:crypto';
import {SourceOwnerRequestSchema,SourceRecordSchema,SourceContentSchema,type KnowledgeRef} from '@commerce/knowledge-contracts';
import type {SourceOwnerPort} from '@commerce/knowledge-application';
import {KnowledgeError} from '@commerce/knowledge-core/types';

/** Explicit server-to-server read port. No discovery, redirects, remote writes or publication proof. */
export function createHttpSourceOwner(options:{baseUrl:string;token:string;fetch?:typeof globalThis.fetch}):SourceOwnerPort {
  const url=new URL(options.baseUrl);
  if(url.username||url.password||url.search||url.hash||url.protocol!=='https:'&&
    !(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))||options.token.length<24)
    throw new Error('Source owner requires an explicit trusted HTTPS or loopback URL and secret');
  const endpoint=options.baseUrl.replace(/\/$/,''),fetcher=options.fetch??globalThis.fetch;
  function sameRef(requested:KnowledgeRef,actual:KnowledgeRef){
    if(['projectId','spaceId','domain','objectId','versionId'].some(field=>requested[field as keyof KnowledgeRef]!==actual[field as keyof KnowledgeRef])||
      requested.contentDigest!==null&&requested.contentDigest!==actual.contentDigest)
      throw new KnowledgeError('SOURCE_REF_MISMATCH','Business owner returned a different exact reference',409);
  }
  async function request(operation:'record'|'content',scope:Parameters<SourceOwnerPort['readRecord']>[0],ref:KnowledgeRef,context:Parameters<SourceOwnerPort['readRecord']>[2],anchor?:unknown){
    const body=SourceOwnerRequestSchema.parse({scope,ref,purpose:context.purpose,subjectId:context.principal.id,...(operation==='content'?{anchor:anchor??null}:{})});
    let response:Response;
    try {response=await fetcher(`${endpoint}/${operation}`,{method:'POST',headers:{Authorization:`Bearer ${options.token}`,'Content-Type':'application/json'},
      body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(20_000)});}
    catch {throw new KnowledgeError('SOURCE_OWNER_UNAVAILABLE','Business source owner is unavailable',503);}
    const limit=operation==='content'?7_000_000:100_000;
    if(Number(response.headers.get('content-length'))>limit){await response.body?.cancel();throw new KnowledgeError('SOURCE_OWNER_RESPONSE_INVALID','Business source response exceeds the read limit',502);}
    const reader=response.body?.getReader();let length=0;const chunks:Uint8Array[]=[];
    if(reader)try{for(;;){const chunk=await reader.read();if(chunk.done)break;length+=chunk.value.byteLength;
      if(length>limit){await reader.cancel();throw new KnowledgeError('SOURCE_OWNER_RESPONSE_INVALID','Business source response exceeds the read limit',502);}chunks.push(chunk.value);}}
    catch(error){if(error instanceof KnowledgeError)throw error;throw new KnowledgeError('SOURCE_OWNER_UNAVAILABLE','Business source response was interrupted',503);}
    let value:unknown;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new KnowledgeError('SOURCE_OWNER_RESPONSE_INVALID','Business source response is invalid',502);}
    if(!response.ok){
      if(response.status===404)return null;
      const code=value&&typeof value==='object'&&'code' in value&&typeof value.code==='string'&&/^SOURCE_[A-Z_]{1,80}$/.test(value.code)?value.code:'SOURCE_OWNER_FAILED';
      throw new KnowledgeError(response.status===401||response.status===403?'SOURCE_FORBIDDEN':code,
        response.status===401||response.status===403?'Business source access is forbidden':'Business source read failed',
        [400,403,409,422,503].includes(response.status)?response.status:response.status===401?403:502);
    }
    return value;
  }
  return {async readRecord(scope,ref,context){const value=await request('record',scope,ref,context);if(value===null)return null;
    const parsed=SourceRecordSchema.safeParse(value);if(!parsed.success)throw new KnowledgeError('SOURCE_OWNER_RESPONSE_INVALID','Business source metadata is invalid',502);
    sameRef(ref,parsed.data.ref);if(!parsed.data.readability.metadataVisible)throw new KnowledgeError('SOURCE_FORBIDDEN','Business source metadata is forbidden',403);
    if(parsed.data.actualCoverage.length)throw new KnowledgeError('SOURCE_OWNER_RESPONSE_INVALID','Metadata lookup cannot claim content reads',502);
    return parsed.data;},
    async readContent(scope,ref,anchor,context){const value=await request('content',scope,ref,context,anchor);if(value===null)return null;
      const parsed=SourceContentSchema.safeParse(value);if(!parsed.success)throw new KnowledgeError('SOURCE_OWNER_RESPONSE_INVALID','Business source content is invalid',502);
      const content=parsed.data;sameRef(ref,content.ref);sameRef(content.ref,content.actualCoverage.sourceRef);
      const bytes=content.media?Buffer.from(content.media.base64,'base64'):Buffer.from(content.content,'utf8');
      if(content.ref.contentDigest!==content.contentDigest||createHash('sha256').update(bytes).digest('hex')!==content.contentDigest||
        content.actualCoverage.byteCount!==bytes.length||content.media&&(content.media.digest!==content.contentDigest||content.media.byteCount!==bytes.length)||
        !content.readability.contentReadable||content.readability.assurance!=='read_time_only')
        throw new KnowledgeError('SOURCE_CONTENT_INTEGRITY','Business source content or coverage does not match its exact digest',409);
      return content;}};
}

/** Domains retain their original owner; the managed registry is never populated by this bridge. */
export function routeSourceOwners(managed:SourceOwnerPort,business?:SourceOwnerPort):SourceOwnerPort {
  function owner(ref:KnowledgeRef){if(ref.domain==='source')return managed;
    if(ref.domain!=='analysis'&&ref.domain!=='evidence')throw new KnowledgeError('SOURCE_DOMAIN_UNSUPPORTED','Reference domain is unsupported',422);
    if(!business)throw new KnowledgeError('SOURCE_OWNER_UNCONNECTED','Business source owner is not connected',503);return business;}
  return {readRecord:(scope,ref,context)=>owner(ref).readRecord(scope,ref,context),readContent:(scope,ref,anchor,context)=>owner(ref).readContent(scope,ref,anchor,context)};
}
