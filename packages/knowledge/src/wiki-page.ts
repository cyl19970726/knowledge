import { z } from 'zod';
import { CitationSchema, Sha256Schema, VersionRefSchema } from '../../contracts/src/index.ts';
import type { Citation, VersionRef } from '../../contracts/src/index.ts';
import type { Dependency, KnowledgeRevision, WikiPageBinding } from './types.ts';
import { canonical, digest, uniqueDeps } from './utils.ts';

const label = z.string().trim().min(1).max(300);
const paragraph = z.string().trim().min(1).max(12000);
const paragraphs = z.array(paragraph).max(50);
const profileId = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/);
const version = z.string().regex(/^[1-9]\d*(?:\.[0-9]+){0,2}$/);

export const WikiPageProfileSpecSchema = z.strictObject({
  id: profileId, version, description: paragraph,
  identityGuidance: paragraph, evidenceGuidance: paragraph,
});
export type WikiPageProfileSpec = z.infer<typeof WikiPageProfileSpecSchema>;
const profiles = new Map<string, WikiPageProfileSpec>();
const profileKey = (id:string, version:string) => `${id}@${version}`;
export function wikiPageProfileFingerprint(spec:WikiPageProfileSpec):string {
  return digest(WikiPageProfileSpecSchema.parse(spec));
}
export function registerWikiPageProfile(raw:WikiPageProfileSpec):WikiPageProfileSpec {
  const spec=WikiPageProfileSpecSchema.parse(raw), key=profileKey(spec.id,spec.version);
  const prior=profiles.get(key);
  if(prior && wikiPageProfileFingerprint(prior)!==wikiPageProfileFingerprint(spec))
    throw new Error(`Wiki page profile ${key} is already registered with different guidance`);
  const frozen=Object.freeze(spec);
  profiles.set(key,frozen);return frozen;
}
export function getWikiPageProfile(id:string, version:string):WikiPageProfileSpec|undefined {
  return profiles.get(profileKey(id,version));
}
for(const [id,description,identityGuidance,evidenceGuidance] of [
  ['entity','A named person, product, organization, or other durable entity.','Use one stable real-world referent per key.','Separate observed facts from unknown attributes.'],
  ['concept','A reusable term and its bounded meaning.','Use one meaning per key; use aliases for names of that meaning.','Cite definitions and note competing uses.'],
  ['question','A durable question with current answers and unresolved parts.','Use the question itself as the stable key.','Retain conflicting evidence and missing answers.'],
  ['method','A reproducible procedure and its conditions.','Use one procedure per key.','Distinguish tested steps from proposed steps.'],
  ['synthesis','An evidence-linked interpretation across sources or pages.','Use the stable topic or claim as the key.','Preserve exact supporting and challenging revisions.'],
] as const) registerWikiPageProfile({id,version:'1',description,identityGuidance,evidenceGuidance});

export const WikiPageContentSchema = z.strictObject({
  schemaVersion:z.literal('1.0'),
  profile:z.strictObject({id:profileId,version}),
  identity:z.strictObject({key:label,aliases:z.array(label).max(30)}),
  summary:paragraph, conditions:paragraphs, counterexamples:paragraphs,
  unknowns:paragraphs, nextQuestions:paragraphs,
  citations:z.array(CitationSchema).max(100),
  /** Named navigation is a link, never independent evidence. */
  navigation:z.array(z.strictObject({ref:VersionRefSchema,label,reason:paragraph})).max(100),
}).superRefine((page,ctx)=>{
  if(new Set([page.identity.key,...page.identity.aliases].map(x=>x.toLocaleLowerCase())).size!==page.identity.aliases.length+1)
    ctx.addIssue({code:'custom',path:['identity'],message:'Identity key and aliases must be distinct'});
  if(new Set(page.navigation.map(x=>`${x.ref.objectId}/${x.ref.versionId}`)).size!==page.navigation.length)
    ctx.addIssue({code:'custom',path:['navigation'],message:'Navigation versions must be distinct'});
});
export type WikiPageContent = z.infer<typeof WikiPageContentSchema>;
export const WikiPageBindingSchema = z.strictObject({
  bindingKind:z.literal('wiki_page'),spaceId:label,specificationId:label,specificationVersion:label,
  contentVersion:z.literal('wiki_page/1.0'),methodVersion:label,policyVersion:label,
  inputFingerprint:Sha256Schema,readsetFingerprint:Sha256Schema,profileFingerprint:Sha256Schema,
});

/** Canonicalize the dependencies the service will persist from selected inputs. */
export function wikiPageFrozenDependencies(input:{content:WikiPageContent;dependencies:readonly Dependency[]}):Dependency[] {
  const navigation:Dependency[]=input.content.navigation.map(link=>({domain:'knowledge',ref:link.ref,role:'uses',critical:false}));
  // Citation location establishes an exact critical read, not the argument's stance.
  // The selected basis dependency alone records whether that material supports or challenges.
  const cited:Dependency[]=input.content.citations.map(citation=>citation.kind==='source'
    ? {domain:'source',ref:citation.sourceRef,role:'uses',critical:true}
    : {domain:'evidence',ref:citation.anchor.sourceRef,role:'uses',critical:true});
  // Persisted JSONB drops undefined optional fields; hash the same JSON values.
  const selected=JSON.parse(JSON.stringify(input.dependencies)) as Dependency[];
  return uniqueDeps([...selected,...navigation,...cited]).sort((a,b)=>canonical(a).localeCompare(canonical(b)));
}
/** Exact persisted dependencies, including derived citation and navigation refs. */
export function wikiPageReadsetFingerprint(input:{content:WikiPageContent;dependencies:readonly Dependency[]}):string {
  return digest(wikiPageFrozenDependencies(input));
}
export function wikiPageInputFingerprint(input:{content:WikiPageContent;body:string;title:string;scope:unknown;dependencies:readonly Dependency[]}):string {
  return digest(JSON.parse(JSON.stringify({content:input.content,body:input.body,title:input.title,scope:input.scope,
    readsetFingerprint:wikiPageReadsetFingerprint(input)})));
}
export type WikiPageRevision = Extract<KnowledgeRevision,{kind:'wiki_page'}> & {binding:WikiPageBinding};
export function isWikiPageRevision(revision:KnowledgeRevision):revision is WikiPageRevision {
  return revision.kind==='wiki_page' && revision.binding!==undefined &&
    'bindingKind' in revision.binding && revision.binding.bindingKind==='wiki_page';
}
/** Persisted pages must contain every derived edge, not merely hash as if they did. */
export function matchesWikiPageFrozenBinding(revision:KnowledgeRevision):revision is WikiPageRevision {
  if(!isWikiPageRevision(revision))return false;
  const profile=getWikiPageProfile(revision.content.profile.id,revision.content.profile.version);
  if(!profile)return false;
  const actual=(JSON.parse(JSON.stringify(revision.dependencies)) as Dependency[]).sort((a,b)=>canonical(a).localeCompare(canonical(b)));
  return canonical(actual)===canonical(wikiPageFrozenDependencies(revision)) &&
    revision.binding.profileFingerprint===wikiPageProfileFingerprint(profile) &&
    revision.binding.readsetFingerprint===wikiPageReadsetFingerprint(revision) &&
    revision.binding.inputFingerprint===wikiPageInputFingerprint(revision);
}
export type WikiPageNavigation = {ref:VersionRef;label:string;reason:string};
export type WikiPageCitation = Citation;

/** Registered profile specifications, without exposing the mutable registry. */
export function listWikiPageProfiles(): readonly WikiPageProfileSpec[] {
  return [...profiles.values()].map(profile=>({...profile}));
}
