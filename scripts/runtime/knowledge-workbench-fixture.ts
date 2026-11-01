import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { seedKnowledgeSyntheticFixture } from './knowledge-synthetic-fixture.ts';
import { createKnowledgeStore } from '../../packages/knowledge/src/store.ts';
import { digest } from '../../packages/knowledge/src/utils.ts';
import { getWikiPageProfile, wikiPageFrozenDependencies, wikiPageProfileFingerprint, wikiPageReadsetFingerprint, wikiPageInputFingerprint, type WikiPageRevision } from '../../packages/knowledge/src/wiki-page.ts';
import type { Dependency, KnowledgeChangeSet, KnowledgeReview } from '../../packages/knowledge/src/types.ts';
import { createSourceApplication, type CapabilityContext } from '../../packages/knowledge-application/src/sources.ts';
import { createPgSourceRegistry } from '../../packages/adapters/knowledge-service/src/sources.ts';

const uuid = (key: string) => {
  const h = createHash('sha256').update(`unified-workbench:${key}`).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
};
const ref = (key: string, version = '1') => ({ objectId: uuid(key), versionId: uuid(`${key}:${version}`) });

/** Synthetic reading/graphics fixture only; original fixture remains available for same-data comparison. */
export async function seedKnowledgeWorkbenchFixture(pool: Pool) {
  const base = await seedKnowledgeSyntheticFixture(pool, 'knowledge-workbench-synthetic', '认知示例');
  const context: CapabilityContext = { scope: { projectId: base.projectId, spaceId: base.spaceId }, principal: base.principal, purpose: 'exploration_reading', authorization: base.authorization };
  const sources = createSourceApplication(createPgSourceRegistry(pool, { writerGrant: base.writerGrant }));
  const sourceKinds = [
    ['expression', '表达资料', '合成原件：结果镜头和情境叙事承担不同的信息职责。此文本不包含真实观众效果。'],
    ['production', '呈现记录', '合成原件：包装细节与动作呈现需要被逐项核对。此记录不代表真实制作验证。'],
    ['observation', '观察记录', '合成原件：理解故事与辨认商品是不同的观察维度，缺少真实观众测试时应分别保留未知。'],
  ] as const;
  const registered = new Map<string, Awaited<ReturnType<typeof sources.upsert>>>();
  for (const [key, title, text] of sourceKinds) {
    registered.set(key, await sources.upsert(context, {
      externalIdentity: { adapterId: 'document', externalObjectId: `workbench:${key}`, externalVersion: '1' }, expectedSourceHead: null,
      sourceSchemaVersion: 'document-text@1', contentDigest: createHash('sha256').update(text).digest('hex'), custody: { mode: 'managed_copy', text },
      sourceKind: 'document', author: '工程合成资料', publisher: title, acquirer: '隔离工作台演示', publishedAt: null, obtainedAt: new Date().toISOString(),
      assertionKind: 'source_claim', sourceGroups: [{ id: `synthetic:workbench:${key}`, status: 'known', authority: 'synthetic-fixture' }],
      anchors: [{ kind: 'paragraph', value: '1', resolved: true }], actualCoverage: [], limitations: ['合成资料；不同来源组不证明真实独立观察'], rightsPolicyRef: 'synthetic-local-only',
    }, `workbench-source:${key}`));
  }
  const sourceRef = (key: string) => { const r = registered.get(key)!.ref; return { objectId: r.objectId, versionId: r.versionId }; };
  const inputSource = (key: string): Dependency => ({ domain: 'source', ref: sourceRef(key), role: 'derived_from', critical: true, rationale: '合成工程来源；语义和实际效果未验' });
  const inputKnowledge = (key: string, role: Dependency['role'] = 'supports', critical = true): Dependency => ({ domain: 'knowledge', ref: ref(key), role, critical, rationale: role === 'challenges' ? '合成反例：故事理解不能直接推出商品辨认' : '合成关系：须结合各自条件阅读', conditions: ['仅用于合成阅读与图谱交互核对'] });
  const specs = [
    ['a', '先展示可辨认的结果', '结果前置可以作为信息组织思路；在不知道观众能否辨认商品时，不能把吸引注意当作已经准确识别。', 'expression'],
    ['b', '准确信息需要可靠呈现', '表达目标与镜头实现需要分别选择。包装、形态和动作的准确性有自己的前提；当前工程示例没有完成真实制作验证。', 'production'],
    ['d', '看懂故事仍可能未认出商品', '故事理解与商品辨认是两个观察维度。若没有独立观察，应保留未知，不能仅凭叙事完整就推断观众已经识别。', 'observation'],
    ['recognition', '商品辨认与视觉线索', '比较外观线索、命名与理解任务，区分可见信息和推断。', 'observation'],
    ['narrative', '表达职责与情境叙事', '叙事可承担背景与情境，具体识别线索仍需单独检查。', 'expression'],
    ['rendering', '包装形态与动作呈现', '呈现任务需要准确的输入与实际可行条件。', 'production'],
    ['audience', '人群经验与辨认条件', '不同经验的读者可能需要不同的解释；示例没有提供真实人群比较。', 'observation'],
    ['evidence', '共同来源与独立支持', '同一原件的两条引用不会自动成为两份独立支持，来源组与实际观察范围需要分别核对。', 'expression'],
    ['condition', '适用条件与反例边界', '反例需要定位它改变的前提；不必为每一次新资料创建新版本。', 'observation'],
    ['usage', '有条件借用与暂缓', '实际采用需要记录当时版本和理由；阅读本身不等于采用。', 'production'],
  ] as const;
  function make(key: string, title: string, body: string, sourceKeys: string[], dependencies: Dependency[], version = '1'): WikiPageRevision {
    const profile = getWikiPageProfile(key === 'c' ? 'synthesis' : 'concept', '1')!;
    const revision: WikiPageRevision = {
      kind: 'wiki_page', projectId: base.projectId, ref: ref(key, version), title,
      body: `${title}\n\n合成工程示例。${body}\n\n成立条件：仅限给定资料和问题，实际效果仍需独立观察。\n\n反例与未知：吸引注意、理解故事和辨认商品分别核对；当前没有真实经营效果。`,
      scope: { applicability: { productVersionRefs: [], markets: [], languages: ['zh'], audiences: [], goals: [], requiredProduction: [], transferRationale: null }, limitations: ['工程合成资料'], unknowns: ['真实语义质量、观众与业务效果未验证'], reviewDueAt: null },
      content: { schemaVersion: '1.0', profile: { id: profile.id, version: profile.version }, identity: { key: `workbench:${key}`, aliases: [] }, summary: body,
        conditions: version === '2' ? ['先检查商品识别条件，再判断是否沿用表达与镜头分工', '仅为合成工程条件，真实任务需核对'] : ['存在可辨认的结果信息', '具体呈现满足准确性与可行性前提'],
        counterexamples: ['看懂故事未必认出商品'], unknowns: ['没有真实观众与制作观察'], nextQuestions: ['怎样取得可比较的识别观察？'],
        citations: sourceKeys.map(k => ({ kind: 'source' as const, sourceRef: sourceRef(k), locator: 'paragraph:1', supports: '合成来源主张；不是已验证效果' })), navigation: [] },
      binding: { bindingKind: 'wiki_page', spaceId: base.spaceId, specificationId: 'workbench-synthetic', specificationVersion: '1', contentVersion: 'wiki_page/1.0', methodVersion: 'workbench-fixture@1', policyVersion: 'synthetic-review@1', inputFingerprint: '0'.repeat(64), readsetFingerprint: '0'.repeat(64), profileFingerprint: wikiPageProfileFingerprint(profile) },
      dependencies: [...sourceKeys.map(inputSource), ...dependencies], sourceGroups: sourceKeys.map(k => `synthetic:workbench:${k}`), artifactRef: null, createdAt: new Date().toISOString(), analysisQuality: null,
    };
    revision.dependencies = wikiPageFrozenDependencies(revision);
    revision.binding!.readsetFingerprint = wikiPageReadsetFingerprint(revision);
    revision.binding!.inputFingerprint = wikiPageInputFingerprint(revision);
    return revision;
  }
  const leafs = specs.map(([key, title, body, source]) => make(key, title, body, [source], key === 'a' ? [inputKnowledge('narrative', 'uses', false), inputKnowledge('evidence', 'uses', false)] : key === 'b' ? [inputKnowledge('rendering', 'uses', false), inputKnowledge('usage', 'uses', false)] : key === 'd' ? [inputKnowledge('recognition', 'uses', false), inputKnowledge('audience', 'uses', false)] : []));
  const store = createKnowledgeStore(pool, { writerGrant: base.writerGrant });
  async function publish(revisions: WikiPageRevision[], prior = new Map<string, string>()) {
    const changes = revisions.map(revision => ({ revision, effect: prior.has(revision.ref.objectId) ? 'correct' as const : 'create' as const, explanation: 'Synthetic workbench reading fixture' }));
    const proposal: KnowledgeChangeSet = { id: randomUUID(), projectId: base.projectId, requestKey: randomUUID(), requestHash: digest(changes), contentHash: digest(changes), purpose: 'exploration_reading', proposer: 'synthetic-workbench-builder', rationale: 'Engineering fixture, not semantic acceptance', methodVersion: 'workbench-fixture@1', cost: { state: 'known', amount: 0, currency: 'USD' }, baseHeads: revisions.map(r => ({ objectId: r.ref.objectId, versionId: prior.get(r.ref.objectId) ?? null })), inputManifest: revisions.flatMap(r => r.dependencies), changes, createdAt: new Date().toISOString() };
    await store.stage(proposal);
    const review: KnowledgeReview = { id: randomUUID(), projectId: base.projectId, changeSetId: proposal.id, contentHash: proposal.contentHash, reviewer: 'synthetic-workbench-reviewer', purpose: 'exploration_reading', policyVersion: 'synthetic-review@1', decision: 'exploration_only', rationale: prior.size ? '合成修订：加入商品识别条件，区分故事理解与商品辨认；没有真实语义或业务效果验收' : '工程合成示例；内容和业务效果未验收', createdAt: new Date().toISOString() };
    await store.recordReview(review); await store.publish(base.projectId, proposal.id, proposal.contentHash);
  }
  await publish(leafs);
  const cDependencies = specs.map(([k]) => inputKnowledge(k, k === 'd' ? 'challenges' : ['a', 'b'].includes(k) ? 'supports' : 'uses', ['a', 'b', 'd'].includes(k)));
  const first = make('c', '分开选择信息职责与镜头手段', 'A与B分别回答信息组织和可靠呈现。本合成综合将这两个问题分开检查；它不是已验证的观众或经营结论。', ['expression', 'production'], cDependencies);
  await publish([first]);
  const current = make('c', '分开选择信息职责与镜头手段', '在前一版分工的基础上，明确加入商品识别条件。D只提示一个待核边界：若商品未被辨认，应重新检查线索或暂缓使用；不据此推断所有结果前置都无效。', ['expression', 'production', 'observation'], cDependencies, '2');
  await publish([current], new Map([[current.ref.objectId, first.ref.versionId]]));
  return { ...base, root: current.ref, workbench: { a: ref('a'), b: ref('b'), d: ref('d'), current: current.ref, previous: first.ref, sourceCount: 4, synthetic: true } };
}
