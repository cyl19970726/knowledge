import {randomUUID,createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {migrateKnowledge} from '../../packages/knowledge/src/migrations.ts';
import {createKnowledgeStore} from '../../packages/knowledge/src/store.ts';
import {rotateKnowledgeWriterAuthority,type KnowledgeWriterGrant} from '../../packages/knowledge/src/writer-authority.ts';
import {digest} from '../../packages/knowledge/src/utils.ts';
import {getWikiPageProfile,wikiPageProfileFingerprint,wikiPageInputFingerprint,wikiPageReadsetFingerprint,wikiPageFrozenDependencies,type WikiPageRevision} from '../../packages/knowledge/src/wiki-page.ts';
import type {Dependency,KnowledgeChangeSet,KnowledgeReview} from '../../packages/knowledge/src/types.ts';
import {createSourceApplication,type CapabilityContext} from '../../packages/knowledge-application/src/sources.ts';
import {createPgSourceRegistry,migrateManagedSources} from '../../packages/adapters/knowledge-service/src/sources.ts';
const stamp='2026-10-26T10:30:00.000Z';
const uuid=(key:string)=>{const h=createHash('sha256').update(`synthetic-knowledge:${key}`).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
const ref=(key:string,version='1')=>({objectId:uuid(key),versionId:uuid(`${key}:version:${version}`)});
/** Disposable synthetic data only. Never call against a real business schema. */
export async function seedKnowledgeSyntheticFixture(pool:Pool,projectId='knowledge-synthetic',spaceId='synthetic-research'){
 await migrateKnowledge(pool);const writerGrant=await rotateKnowledgeWriterAuthority(pool,projectId,null,{ownerId:'synthetic-local-service',mode:'active'});
 await migrateManagedSources(pool);
 const principal={id:'synthetic-owner',clientInstallationId:'knowledge-demo',projectId,spaceIds:[spaceId],purposes:['exploration_reading']};
 const authorization={actions:['sources:write','sources:revoke','uses:write','feedback:write','feedback:source','research:write','review:request','review:decide'],adapterIds:['document','commerce','manual'],rightsPolicyIds:['synthetic-local-only']};
 const context:CapabilityContext={scope:{projectId,spaceId},principal,purpose:'exploration_reading',authorization};
 const registry=createPgSourceRegistry(pool,{writerGrant}),sourceService=createSourceApplication(registry);
 const sourceText='合成示例：拍摄可见细节，与观众理解或购买效果是不同的观察。\n\n本资料仅用于验证来源、版本和阅读交互，不构成真实经营结论。';
 const source=await sourceService.upsert(context,{externalIdentity:{adapterId:'document',externalObjectId:'synthetic-notes',externalVersion:'1'},expectedSourceHead:null,
 sourceSchemaVersion:'document-text@1',contentDigest:createHash('sha256').update(sourceText).digest('hex'),custody:{mode:'managed_copy',text:sourceText},sourceKind:'document',author:'合成资料作者',publisher:'合成演示',acquirer:'工程测试',publishedAt:null,obtainedAt:stamp,
 assertionKind:'source_claim',sourceGroups:[{id:'synthetic:shared-notes',status:'known',authority:'synthetic-fixture'}],anchors:[{kind:'paragraph',value:'1',resolved:true}],actualCoverage:[],limitations:['完全合成，不可用于业务判断'],rightsPolicyRef:'synthetic-local-only'},'synthetic-source-v1');
 const titles=[
 ['visibility','商品的可展示性'],['features','商品特征'],['audience','人群与需求'],['identity','商品辨认'],['story','情绪与叙事'],['creator','表达与展示'],['handoff','购买承接'],
 ['texture','材质与触感'],['color','颜色与外观'],['size','尺寸与形态'],['craft','工艺与细节'],['parent','儿童与亲子'],['gift','礼赠场景'],['companion','情感陪伴需求'],['collect','收藏与爱好'],['category','类目与命名'],['original','真伪与版本'],['similar','外观相似与区分'],['attention','吸引与辨认是不同问题'],['meaning','剧情赋予物品意义'],['value','情绪价值'],['roles','故事与角色'],['social','社交话题'],['format','内容形式'],['scene','展示场景'],['style','表达风格'],['distribution','平台与传播'],['motive','购买动机'],['conversion','转化路径'],['price','价格与促销'],['service','售后与保障'],['scope','长中文标签：观看兴趣如何转变为可辨认的商品信息，仍须补充条件与反例'],
 ];
 const groups:Record<string,string[]>= {features:['texture','color','size','craft'],audience:['parent','gift','companion','collect'],identity:['category','original','similar','attention'],story:['meaning','value','roles','social'],creator:['format','scene','style','distribution'],handoff:['motive','conversion','price','service']};
 const deps=(key:string):Dependency[]=>{
  const result:Dependency[]=[{domain:'source',ref:{objectId:source.ref.objectId,versionId:source.ref.versionId},role:'derived_from',critical:true,rationale:'合成来源主张；未验证经营效果'}];
  if(key==='visibility')for(const anchor of Object.keys(groups))result.push({domain:'knowledge',ref:ref(anchor),role:'supports',critical:true,rationale:'合成关系：限定条件下有助于理解可展示性',conditions:['资料和问题条件相同']});
  for(const [root,children] of Object.entries(groups))if(key===root)for(const child of children)result.push({domain:'knowledge',ref:ref(child),role:'uses',critical:false,rationale:'主题导航，不计为独立证据'});
  if(key==='visibility')result.push({domain:'knowledge',ref:ref('attention'),role:'challenges',critical:true,rationale:'待核挑战：吸引注意未必支持商品辨认',conditions:['尚无观众识别测试']},{domain:'knowledge',ref:ref('scope'),role:'uses',critical:false,rationale:'尚待补证的条件问题'});
  return result;};
 const make=(key:string,title:string,version='1'):WikiPageRevision=>{const profile=getWikiPageProfile(key==='visibility'?'synthesis':'concept','1')!;
 const value:WikiPageRevision={kind:'wiki_page',projectId,ref:ref(key,version),title,body:`${title}\n\n合成示例。${key==='visibility'?'某些差异能被镜头直接看见，另一些差异需要情境解释。':'这是一个用于工程验证的认识条目。'}\n\n观察：资料中描述了可见信息。解释：这些信息可能帮助理解；解释尚未经过真实观察检验。\n\n适用条件：仅限本合成问题与给定上下文。反例与未知：热度不能推出成交，重复来源不能算独立支持。${version==='2'?'\n\n本次修订：进一步区分吸引注意、辨认商品与购买承接。':'\n\n历史表述：可见信息可能帮助理解。'}`,
 scope:{applicability:{productVersionRefs:[],markets:[],languages:['zh'],audiences:[],goals:[],requiredProduction:[],transferRationale:null},limitations:['合成工程资料'],unknowns:['真实读者效果未验'],reviewDueAt:null},
 content:{schemaVersion:'1.0',profile:{id:profile.id,version:profile.version},identity:{key,aliases:[]},summary:`${title}的有条件理解（合成示例）`,conditions:['仅限给定合成资料与范围'],counterexamples:['吸引注意不代表准确辨认'],unknowns:['缺少真实观众和经营记录'],nextQuestions:['怎样取得可比较的观察？'],citations:[{kind:'source',sourceRef:{objectId:source.ref.objectId,versionId:source.ref.versionId},locator:'paragraph:1',supports:'合成来源主张'}],navigation:[]},
 binding:{bindingKind:'wiki_page',spaceId,specificationId:'generic-knowledge-synthetic',specificationVersion:'1',contentVersion:'wiki_page/1.0',methodVersion:'synthetic-fixture@1',policyVersion:'synthetic-review@1',inputFingerprint:'0'.repeat(64),readsetFingerprint:'0'.repeat(64),profileFingerprint:wikiPageProfileFingerprint(profile)},
 dependencies:deps(key),sourceGroups:['synthetic:shared-notes'],artifactRef:null,createdAt:stamp,analysisQuality:null};
 value.dependencies=wikiPageFrozenDependencies(value);value.binding.readsetFingerprint=wikiPageReadsetFingerprint(value);value.binding.inputFingerprint=wikiPageInputFingerprint(value);return value;};
 const store=createKnowledgeStore(pool,{writerGrant});
 async function publish(revisions:WikiPageRevision[],bases:Map<string,string>=new Map()){
 const changes=revisions.map(revision=>({revision,effect:bases.has(revision.ref.objectId)?'correct' as const:'create' as const,explanation:'Synthetic fixture only'}));
 const proposal:KnowledgeChangeSet={id:randomUUID(),projectId,requestKey:randomUUID(),requestHash:digest(changes),contentHash:digest(changes),purpose:'exploration_reading',proposer:'synthetic-fixture-builder',rationale:'Synthetic fixture, no factual/semantic acceptance',methodVersion:'synthetic-fixture@1',cost:{state:'known',amount:0,currency:'USD'},baseHeads:revisions.map(r=>({objectId:r.ref.objectId,versionId:bases.get(r.ref.objectId)??null})),inputManifest:revisions.flatMap(r=>r.dependencies),changes,createdAt:stamp};
 await store.stage(proposal);const review:KnowledgeReview={id:randomUUID(),projectId,changeSetId:proposal.id,contentHash:proposal.contentHash,reviewer:'synthetic-fixture-reviewer',purpose:'exploration_reading',policyVersion:'synthetic-review@1',decision:'exploration_only',rationale:'Engineering fixture only; content quality not reviewed',createdAt:stamp};
 await store.recordReview(review);await store.publish(projectId,proposal.id,proposal.contentHash);
 }
 // Publish DAG from leaves to roots; no fabricated graph coordinates are seeded.
 const all=titles.map(([k,t])=>make(k,t));await publish(all);
 const current=make('visibility','商品的可展示性','2');await publish([current],new Map([[current.ref.objectId,ref('visibility').versionId]]));
 return {projectId,spaceId,principal,authorization,writerGrant,source,root:current.ref};
}
