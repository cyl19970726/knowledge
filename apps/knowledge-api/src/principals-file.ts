import {readFileSync} from 'node:fs';
import {z} from 'zod';
import type {ApiPrincipal} from './index.ts';

const Name=z.string().trim().min(1).max(200);
const PrincipalsFileSchema=z.strictObject({principals:z.array(z.strictObject({
  id:Name,tokenSha256:z.string().regex(/^[a-f0-9]{64}$/,'tokenSha256 must be a lowercase SHA-256 hex digest'),
  clientInstallationId:Name,purposes:z.array(Name).min(1).max(20),spaceIds:z.array(Name).min(1).max(100).optional(),
  actions:z.array(Name).max(100),adapterIds:z.array(Name).max(100).default([]),rightsPolicyIds:z.array(Name).max(100).default([]),
  actor:z.strictObject({kind:z.enum(['human','agent','service']),model:Name.nullable()}).refine(actor=>actor.kind==='agent'||actor.model===null,
    {message:'Only agent principals name a model'})})).min(1).max(50)});

/** Parses a principals file. Only token digests live here; each raw token is handed to its client separately. */
export function parsePrincipalsFile(text:string,scope:{projectId:string;spaceIds:readonly string[]}):ApiPrincipal[]{
  const file=PrincipalsFileSchema.parse(JSON.parse(text));
  return file.principals.map(entry=>{
    const spaceIds=entry.spaceIds??[...scope.spaceIds];
    if(spaceIds.some(space=>!scope.spaceIds.includes(space)))throw new Error(`Principal ${entry.id} names a space outside KNOWLEDGE_API_SPACE_IDS`);
    return {tokenSha256:entry.tokenSha256,
      principal:{id:entry.id,clientInstallationId:entry.clientInstallationId,projectId:scope.projectId,spaceIds,purposes:entry.purposes,actor:entry.actor},
      capabilities:{actions:entry.actions,adapterIds:entry.adapterIds,rightsPolicyIds:entry.rightsPolicyIds}};
  });
}
export const readPrincipalsFile=(path:string,scope:{projectId:string;spaceIds:readonly string[]})=>parsePrincipalsFile(readFileSync(path,'utf8'),scope);
