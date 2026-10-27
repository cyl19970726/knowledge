import type { KnowledgeScope, NavigationWikiMetadata } from './types.ts';

export function navigationWikiScope():KnowledgeScope {
  return {applicability:{productVersionRefs:[],markets:[],languages:[],audiences:[],goals:[],
    platforms:[],requiredProduction:[],transferRationale:null},
    limitations:['仅为已审研究页导航，不新增独立支持或跨页结论。','准确报告的市场、语言、产品和商业适用性须分别核验。'],
    unknowns:['各研究页之间是否存在可迁移机制，尚未独立审阅。'],
    goalTags:['testing_learning'],reviewDueAt:null};
}

/** Navigation text is a deterministic index, never a synthesis or a new evidence claim. */
export function renderNavigationWiki(metadata:NavigationWikiMetadata):string {
  const pageList=metadata.recentPages.length
    ? `\n\n最近已审研究页：${metadata.recentPages.map(page=>
      `${page.title}（${page.ref.objectId}/${page.ref.versionId}）`).join('；')}`
    : '\n\n本批独立审阅尚未形成研究页。';
  return `本次冻结队列共 ${metadata.total} 份准确报告；已覆盖 ${metadata.covered} 份，待处理 ${metadata.pending} 份。`+
    `这里仅列最近 ${metadata.recentPages.length} 条已审研究页，另有 ${metadata.omittedPages} 条更早研究页未列出。`+
    '本页仅供导航；各研究页的证据、适用范围和限制须分别核查，不产生跨页综合、产品事实或商业结论。'+pageList;
}
