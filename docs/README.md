# Commerce Creative Lab 文档入口

2026-10-26 · 通用知识库已建立[独立文档入口](knowledge/README.md)与[专属 HTML 阅读器](knowledge/index.html)，说明产品交互、架构、对外能力、运行与当前状态。业务字段及来源交接见[业务适配指南](integrations/knowledge.md)。知识正文与元数据各维护一份，总报告导入同一文档集；历史知识说明与阶段验收全文见[迁移记录](knowledge/migration.md)。

2026-10-17 · 产品目标是AI每天自主发现热门素材、分析与积累知识、创作原创视频，再用自家作品的真实反馈改进下一轮。工作台用于观察和控制循环；产品与架构文档按这一主线组织。全文由这些 Markdown 生成 [HTML 阅读报告](index.html)。业务范围以[七目标](https://chatgpt.com/space/page_d2cb3d9f4fc8819188ac80363db3f30d)和[持续认知](https://chatgpt.com/space/page_35e0d83c4f14819180a5b50a5995a1d4)为准。

第一次接手可从[每日学习闭环问题导航](product/questions.md)开始：先看当前部署与开关，再按 Q1–Q26 找到简答、实现状态、前置问题和负责文档的具体章节。

接下来做什么、怎样证明整套闭环跑通，读[下一阶段目标与闭环验收](planning/closed-loop-acceptance.md)：已有资料的真实研究与知识使用→受控日更→持续运行→用户创作及真实结果→第二轮学习。

2026-10-22 阶段研究保留：[认知自我成长的目标、内容模型、行为与验收](knowledge/research/purpose-architecture-20261022.md)保存当时的完整推导，[固定版本实现与外部LLM Wiki对照](knowledge/research/architecture-review-20261022.md)保存源码与研究证据。最新通用产品说明从[知识库独立入口](knowledge/README.md)阅读；业务细节和历史合同保留，不将旧日报Workflow方案当成现行目标。自营抖音与历史TikTok研究范围各自保留。

## 产品文档

先看[产品全景主图](diagrams/product-learning-loop.html)：三平台获取 → 材料与案例 → 持续知识 → 有限参考与原创制作 → 账号发布 → 定时反馈 → 下一轮。

| 阅读问题 | 完整文档 |
| --- | --- |
| AI怎样每天自主学习、创作并利用反馈改进 | [产品总纲](product/overview.md) |
| 怎样观察、调整和控制整个循环 | [工作台与任务中心](product/workbench.md) |
| 每天有什么新素材、怎样持续发现 | [订阅与发现](product/discovery.md) |
| 怎样筛选、看片和核对来源/指标 | [素材库](product/materials.md) |
| 怎样研究规则、市场、竞品和自己 | [经营研究](product/business-research.md) |
| 粗拉后哪些精品值得精拉、其余素材去哪里 | [拉片与报告](product/video-analysis.md) |
| 怎样积累案例、范式，供创作检索 | [知识与记忆](knowledge/reference/commerce-product.md) |
| 怎样用两种方法形成原创方案与成片 | [创作与制作](product/creation.md) |
| 先研究哪些素材、如何比较和选择创作方法 | [创作试点](planning/creation-pilot.md) |
| 成片怎样进账号、定时发布并取回反馈 | [账号管理与发布](product/accounts.md) |
| 怎样用真实结果决定继续、修改或停止 | [实验与反馈](product/outcomes.md) |
| 分阶段如何验收 | [产品路线图](product/roadmap.md) |

阅读器把上述章节分为“总体与路线、获取与理解、知识与创作、发布与学习”四组。章内先看核心图与输入输出，再按问题进入细节。[拉片模块](product/video-analysis.md)展示先粗拉、产品与创意两组排序、精品精拉及缺证分流；[工具与数据边界](architecture/modules/analysis.md)解释谁访问本地文件、PG 和 R2；[Worker 演进](architecture/workers.md)区分当前实现、近期独立进程和后置容器。文档是否有效用[具体阅读任务](implementation/documentation-evaluation.md)检查，不以文字数量判断。

## 架构文档

先读[总体架构](architecture/overview.md)，再沿以下五组按需阅读；这是查找文档的路线，组序不表示进程顺序或代码依赖。

| 阅读路线 | 文档 |
| --- | --- |
| 系统与代码组织 | [仓库关系](architecture/repository-boundaries.md) · [包结构](architecture/packages.md) |
| 执行与数据底座 | [任务运行](architecture/runtime.md) · [Worker](architecture/workers.md) · [存储](architecture/storage.md) · [实体与版本](architecture/data-model.md) · [跨模块合同](architecture/contracts.md) |
| 采集与拉片 | [发现](architecture/modules/discovery.md) · [素材](architecture/modules/assets.md) · [拉片任务与结果](architecture/modules/analysis.md) · [粗精方法](architecture/modules/video-analysis.md) |
| 知识与创作 | [知识](knowledge/reference/commerce-architecture.md) · [创作执行](architecture/modules/creation.md) |
| 交互与发布 | [工作台与 API](architecture/modules/workbench.md) · [账号发布与反馈采集](architecture/modules/accounts.md) |

页面、产品模块、代码包、进程分别说明，不能用同一个名称替代所有职责。

## 开发从哪里开始

[开发任务与集成计划](implementation/integration-plan.md)按 24 项任务列出前置、产物和验收。第一批接通真实原片到工作台报告；单片知识与首条原创短片随后推进，三平台发现并行。具体状态与验收结果进入实施记录，不把任务清单当成功能已完成。

## 当前做到哪里

[当前实现与运行状态](implementation/current-state.md)是当前部署、数据迁移、业务能力和测试边界的唯一摘要入口。本文不重复动态数量或服务状态；后文仍保留带日期的历史验收证据，并应按其记录日期解读。

[工程集成计划](implementation/integration-plan.md)定义下一步工作包；[运行配置](operations/local-development.md)及[采集媒体操作](operations/collection-and-media.md)记录当前可执行程序。文档迁移没有启动模型、调度或生成。

## 口径、研究与决策

[共享口径](reference/evidence-and-metrics.md)定义身份、来源、地区、广告和指标；[三平台能力](reference/provider-capabilities.md)保留不同日期实测的边界。精拉、粗拉和Wiki研究完整保留在 research，重要取舍见[决策记录](decisions/README.md)，图源与状态见[图表入口](diagrams/README.md)。

## 文档迁移与维护

[迁移记录](implementation/documentation-migration.md)列出原文保全、逐节去向和检查结果；[结构规划](planning/documentation-architecture.md)保留此次批准的组织依据。[维护规则](maintenance.md)规定图文写法、唯一维护位置与三层评估；[本轮评估](implementation/documentation-evaluation.md)记录实际检查和未测试项。历史稿可以查阅，但不参与决定当前接口；与现行规格冲突时须查看对应决策和更正记录。
