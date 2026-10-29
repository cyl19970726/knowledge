# 知识文档迁移与旧入口

2026-10-26 · 用户批准按职责拆分文档，并要求随最新目标和实现调整。本轮在独立文档分支推进，不改变业务来源、知识数据或生产服务。

## 本轮交付与完成线

现行入口分为产品、通用认知模型、架构、技术接入与能力合同、运行、当前状态、权威继承和维护；业务适配指南留在业务文档。16 份知识相关原文完整移入本集，189 个标题段落保留原文与原日期，仅调整相对链接。三份长文按章节拆出通用核心和业务适配，阶段研究与旧验收作为依据，不直接充当新产品完成清单。

独立 catalog 由总 catalog 导入，正文和元数据各保留一个维护位置。独立 HTML 只搜索知识内容；总报告仍能打开全部文档。原文档 ID 和已有 HTML 标题锚点保持，旧总报告链接继续定位原章节。

| 工作 | 当前状态 | 验证 |
| --- | --- | --- |
| 归属与正文 | 已建立现行入口，原文已迁移 | 完整文本/标题映射 |
| 双入口构建 | 已通过 | 知识集及总报告分别构建与检查 |
| 链接与阅读器 | 已通过本地检查 | 旧锚点、跨集、独立搜索、声明与越界回归 |
| 实际阅读 | 桌面及390px走查完成 | 入口、能力、业务适配、旧锚点与搜索；真人理解仍待验 |
| 源码/文档整合 | PR66源码已合main，文档随PR67交付 | 源码合并2d24c74；已验实现ccda123，实施回执保持原阶段事实，部署另行验收 |

## 全文去处

| 原位置（docs 下） | 当前全文 | 原记录日期 |
| --- | --- | --- |
| product/knowledge-memory.md | [memory](reference/commerce-product.md) | 2026-10-19 |
| architecture/modules/knowledge.md | [knowledge-architecture](reference/commerce-architecture.md) | 2026-10-16 |
| research/knowledge-purpose-architecture-20261022.md | [knowledge-purpose-architecture](research/purpose-architecture-20261022.md) | 2026-10-22 |
| research/knowledge-architecture-review-20261022.md | [knowledge-architecture-review](research/architecture-review-20261022.md) | 2026-10-22 |
| research/2026-10-15-graphify-knowledge-frontend-research.md | [graphify-research](research/graphify-frontend-20261015.md) | 2026-10-15 |
| implementation/knowledge-workbench.md | [knowledge-workbench](evidence/workbench-20261015.md) | 2026-10-15 |
| implementation/knowledge-module.md | [knowledge-module](evidence/module-20261015.md) | 2026-10-15 |
| implementation/knowledge-learning-loop.md | [knowledge-learning-loop](evidence/learning-loop-20261016.md) | 2026-10-16 |
| implementation/knowledge-main-workbench-acceptance.md | [knowledge-main-workbench-acceptance](evidence/main-workbench-20261016.md) | 2026-10-16 |
| implementation/knowledge-resilience.md | [knowledge-resilience](evidence/resilience-20261018.md) | 2026-10-18 |
| implementation/knowledge-recovery-progress.md | [knowledge-recovery-progress](evidence/recovery-20261019.md) | 2026-10-19 |
| implementation/knowledge-decision-value.md | [knowledge-decision-value](evidence/decision-value-20261019.md) | 2026-10-19 |
| implementation/cognition-maintenance-m0-20261021.md | [cognition-maintenance-m0](evidence/maintenance-m0-20261021.md) | 2026-10-21 |
| implementation/cognition-maintenance-m1-20261021.md | [cognition-maintenance-m1](evidence/maintenance-m1-20261021.md) | 2026-10-21 |
| implementation/knowledge-domain-pilot-20261021.md | [knowledge-domain-pilot](evidence/domain-pilot-20261021.md) | 2026-10-21 |
| implementation/knowledge-task-use-20261023.md | [knowledge-task-use-20261023](evidence/task-use-20261023.md) | 2026-10-23 |

## 业务和共享说明保留在哪里

采集、拉片以及粗精报告语境仍由业务文档维护；抖音认知成长的真实评估记录、日报产品与运行机制保持原业务归属。来源纳入与采用反馈的交接维护在[业务适配指南](https://github.com/cyl19970726/commerce-creative-lab/blob/main/docs/integrations/knowledge.md)。模型、任务和存储仍引用共享架构说明。

2026-10-14 的 37 份原文与 247 节迁移账本继续保留，仅更新其现行目标路径。迁移映射不因存在摘要而删掉完整专题。

## 怎样验证保留

机器可读映射在 `migration-map.json`，逐份记录基线摘要、目标路径、原 ID、每个标题锚点及具体现行继任章节。`check_knowledge_docs_migration.py` 检查实际原文、标题、两个生成报告，以及继任文件是否存在、仍为现行或操作说明且章节有效；current 内容降为 record 时没有现行继任者会被拒绝。原迁移检查继续验证早期来源。验证不以篇数或标题数代替内容审查。

Markdown 文件移动后，仓库内部引用改到实际位置；已有总报告的文档 ID 和标题链接仍有效。原 Git 路径和日期通过本表及版本历史回查。后续移动新增实现回执时追加记录，不改写原验收事实。

## 修复一项既有保全缺口

原 37 份迁移检查在本轮基线已失败：指标刷新实施记录被后续修改，但账本仍要求原稿哈希。本轮从 Git 固定版本 `e7b0e19` 恢复完整原稿至独立档案并更新 retained_path，当前指标刷新说明保持原样；原校验哈希与正文要求均保留。没有通过改期望值来跳过内容差异。

## 实现会话回执归口

文档分支基于 PR66 的准确候选 `ccda123792c0014ecbb2d417ceaf5a74557cc5a5`。实现会话维护的 `implementation/knowledge-product-split-20261026.md` 全文移到[本集实施回执](evidence/standalone-product-20261026.md)，原文档 ID 保留；正文采用原实现者在修正版本中的原稿，仅调整相对链接；测试、视觉和范围事实保持原记录。这是本轮新增回执，独立于上表 16 份历史原文。迁移映射固定其准确源码版本，保留原有标题及新增评审修正节；主会话的浏览器复验另在当前状态页与结构化记录中说明。

源码 PR66 已于本轮合入 `main`，合并提交 `2d24c74a56942e9019bca46c8a2b271a25febe8b`。后续开发以更新后的 `origin/main` 为基底。原实施回执完整保留合并前的事实，不将其中历史“未合并”语句当作当前状态；文档主线状态可从 PR67 的合并记录回查。
