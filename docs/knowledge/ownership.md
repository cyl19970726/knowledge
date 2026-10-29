# 文档权威、章节继承与旧链接

本页回答三个问题：每份文档现在负责什么；仍有通用价值的旧章节由哪一份现行正文继承；旧链接应继续打开哪里。分类中的“通用核心”是可跨业务复用的知识合同，“业务适配”是特定业务的方法、字段或使用场景，“真正历史”是固定日期的实现、部署、评审和验收证据。

**唯一现行继任者**指该内容的规范维护位置，不表示旧原文被删除。旧全文和原锚点永久保留在“旧全文与旧链接目标”列；`migration-map.json` 的 `retainedAt` 继续指向这些位置，`currentGuide` 指向继任文件的有效章节。三份长文的章级拆分以本文为准，不把整份 rich 原文简单改标为 current。

## 25 份既有文档逐份归属

下表覆盖本次恢复权威前的 25 份 catalog 文档。新增的[通用认知模型](model.md)、[技术接入手册](integration.md)和本页分别承接模型、接入步骤和归属索引，不替代表内历史证据。

| 文档 | 当前角色与生命周期 | 唯一现行继任者 | 旧全文与旧链接目标 |
| --- | --- | --- | --- |
| [通用认知知识库](README.md) | 文档集入口；current | [本页入口](README.md#从你要做的事开始) | 同左，稳定 ID `knowledge-overview` |
| [产品与交互](product.md) | 方向、场景和交互；current | [产品与交互](product.md#我们要去哪里) | 同左，稳定 ID `knowledge-product` |
| [职责与架构](architecture.md) | 通用技术核心与适配边界；current | [职责与架构](architecture.md#通用知识核心) | 同左，稳定 ID `knowledge-system` |
| [能力与接入合同](capabilities.md) | 能力语义；current | [能力目录](capabilities.md#能力目录) | 同左，稳定 ID `knowledge-capabilities` |
| [运行与验证](operations.md) | 构建、运行和验证操作；instructions | [运行与验证](operations.md#单独构建文档) | 同左，稳定 ID `knowledge-operations` |
| [当前状态与证据](current-state.md) | 固定主线、合并、部署和未验项；current | [当前状态](current-state.md) | 同左，稳定 ID `knowledge-current-state` |
| [文档归属与更新](maintenance.md) | 更新联动规则；instructions | [归属与更新](maintenance.md#哪一份负责什么) | 同左，稳定 ID `knowledge-doc-maintenance` |
| [迁移与旧入口](migration.md) | 全文迁移和旧 ID 保全；current | [迁移与旧入口](migration.md#全文去处) | 同左，稳定 ID `knowledge-doc-migration` |
| [独立知识产品实施回执](evidence/standalone-product-20261026.md) | 固定日期工程证据；record | [当前状态](current-state.md)与[运行与验证](operations.md#核对独立产品候选) | 原文及全部原锚点留在本文件 |
| [原 commerce 产品说明](reference/commerce-product.md) | 通用内容已拆出，余为业务适配与历史；record | [通用认知模型](model.md#认知成长的目标) | 原文及全部 `memory--*` 锚点留在本文件；逐章见下 |
| [原 commerce 架构说明](reference/commerce-architecture.md) | 通用机制已拆出，视频方法和固定实现保留；record | [通用技术核心](architecture.md#通用知识核心) | 原文及全部 `knowledge-architecture--*` 锚点留在本文件；逐章见下 |
| [认知成长阶段研究](research/purpose-architecture-20261022.md) | 通用目标与行为已承接，原评估证据保留；record | [通用认知模型](model.md#认知成长的目标) | 原文及全部 `knowledge-purpose-architecture--*` 锚点留在本文件；逐章见下 |
| [固定版本架构评审](research/architecture-review-20261022.md) | 固定源码与外部方案评审；record | [架构](architecture.md)与[通用认知模型](model.md)按职责继承 | 原文及全部原锚点留在本文件 |
| [知识工作台历史验收](evidence/workbench-20261015.md) | 固定日期 UI/工程证据；record | [产品与交互](product.md#三种工作状态) | 原文及全部原锚点留在本文件 |
| [知识模块历史交付](evidence/module-20261015.md) | 固定日期交付证据；record | [架构](architecture.md#阅读研究与唯一发表) | 原文及全部原锚点留在本文件 |
| [持续更新历史验收](evidence/learning-loop-20261016.md) | 固定日期调度与工程证据；record | [研究停止与维护](model.md#研究行为停止与维护) | 原文及全部原锚点留在本文件 |
| [Graphify 阶段研究](research/graphify-frontend-20261015.md) | 前端推导和固定实测；record | [产品与交互](product.md#三种工作状态) | 原文及全部原锚点留在本文件 |
| [主工作台历史验收](evidence/main-workbench-20261016.md) | 固定日期部署与 UI 证据；record | [当前状态](current-state.md) | 原文及全部原锚点留在本文件 |
| [覆盖与未知页历史修复](evidence/resilience-20261018.md) | 固定日期实现证据；record | [异步与恢复边界](architecture.md#阅读研究与唯一发表) | 原文及全部原锚点留在本文件 |
| [失败恢复历史记录](evidence/recovery-20261019.md) | 固定日期恢复与部署证据；record | [运行与验证](operations.md#独立试用怎样验收) | 原文及全部原锚点留在本文件 |
| [决策阅读层历史记录](evidence/decision-value-20261019.md) | 固定日期本地实现和未验项；record | [查询采用与反馈](model.md#查询采用与反馈) | 原文及全部原锚点留在本文件 |
| [认知维护 M0 审查](evidence/maintenance-m0-20261021.md) | 固定日期设计审查；record | [通用认知模型](model.md) | 原文及全部原锚点留在本文件 |
| [认知维护 M1 实跑](evidence/maintenance-m1-20261021.md) | 固定日期受限实跑证据；record | [连续两轮验收](model.md#连续两轮怎样验收认知成长) | 原文及全部原锚点留在本文件 |
| [非视频来源受限试点](evidence/domain-pilot-20261021.md) | 固定日期普通文档试点；record | [普通文档端到端接入](integration.md#10-普通文档业务端到端接入) | 原文及全部原锚点留在本文件 |
| [查询采用反馈历史记录](evidence/task-use-20261023.md) | 固定日期真实任务读取证据；record | [使用与变化流程](integration.md#7-查询研究采用反馈与变化) | 原文及全部原锚点留在本文件 |

历史文档仍可提供事实与推导依据，但其“当前”“已部署”“待实现”和数量只按原日期解释。现行通用正文不得反向复制这些状态。

## `reference/commerce-product.md` 逐章继承

文档级唯一继任者是[通用认知模型](model.md)。业务专章的规范业务正文仍在[业务适配指南](https://github.com/cyl19970726/commerce-creative-lab/blob/main/docs/integrations/knowledge.md)及相应业务文档；这里只指明该旧章节的通用解释入口，不在核心仓复制业务规则。

| 原章节 | 分类 | 唯一现行继任章节 | 旧链接目标 |
| --- | --- | --- | --- |
| 知识与记忆：让持续研究服务下一次决定 | 通用核心；页首状态为真正历史 | [认知成长的目标](model.md#认知成长的目标) | [原章](reference/commerce-product.md#知识与记忆让持续研究服务下一次决定) |
| 日报研究怎样建立和修订知识关联 | 业务适配 | [研究行为：触发与读取范围](model.md#研究行为触发与读取范围) | [原章](reference/commerce-product.md#日报研究怎样建立和修订知识关联) |
| 关联的单位是带条件的命题 | 通用核心 | [带条件的命题与内容关系](model.md#带条件的命题与内容关系) | [原章](reference/commerce-product.md#关联的单位是带条件的命题) |
| 从新材料到新认识，再回到日报 | 通用核心；日报出口为业务适配 | [研究行为：触发与读取范围](model.md#研究行为触发与读取范围) | [原章](reference/commerce-product.md#从新材料到新认识再回到日报) |
| 以认识变化而非产出数量验收 | 通用核心 | [连续两轮怎样验收认知成长](model.md#连续两轮怎样验收认知成长) | [原章](reference/commerce-product.md#以认识变化而非产出数量验收) |
| 一眼看懂本模块 | 通用核心 | [来源、认知与关联](model.md#来源认知与关联) | [原章](reference/commerce-product.md#一眼看懂本模块) |
| 为什么要分层 | 通用核心 | [来源、认知与关联](model.md#来源认知与关联) | [原章](reference/commerce-product.md#为什么要分层) |
| 记忆究竟保存什么 | 通用核心 | [来源、认知与关联](model.md#来源认知与关联) | [原章](reference/commerce-product.md#记忆究竟保存什么) |
| 类型、身份和标签各回答什么 | 通用核心 | [稳定身份与正文权威](model.md#稳定身份与正文权威) | [原章](reference/commerce-product.md#类型身份和标签各回答什么) |
| 粗精拉进入知识时保留哪些语境 | 业务适配 | [登记来源、版本、锚点、权限与用途](integration.md#6-登记来源版本锚点权限与用途) | [原章](reference/commerce-product.md#粗精拉进入知识时保留哪些语境) |
| LLM Wiki 的核心：把新材料编进已有认识 | 通用核心 | [研究行为：触发与读取范围](model.md#研究行为触发与读取范围) | [原章](reference/commerce-product.md#llm-wiki-的核心把新材料编进已有认识) |
| 持续构建的三种节奏（目标设计） | 通用核心；固定参数和状态为真正历史 | [研究行为：停止与维护](model.md#研究行为停止与维护) | [原章](reference/commerce-product.md#持续构建的三种节奏目标设计) |
| 从单片到专题 | 通用核心 | [研究行为：什么值得保存](model.md#研究行为什么值得保存) | [原章](reference/commerce-product.md#从单片到专题) |
| 粗拉与精拉都可以提供可用知识 | 业务适配 | [登记来源、版本、锚点、权限与用途](integration.md#6-登记来源版本锚点权限与用途) | [原章](reference/commerce-product.md#粗拉与精拉都可以提供可用知识) |
| 范式要能指导一次新的创作 | 业务适配 | [查询、采用与反馈](model.md#查询采用与反馈) | [原章](reference/commerce-product.md#范式要能指导一次新的创作) |
| 多片比较先固定比较范围 | 通用核心 | [带条件的命题与内容关系](model.md#带条件的命题与内容关系) | [原章](reference/commerce-product.md#多片比较先固定比较范围) |
| 采用、纠错和失效 | 通用核心 | [查询、采用与反馈](model.md#查询采用与反馈) | [原章](reference/commerce-product.md#采用纠错和失效) |
| 工作台怎样展示一条知识 | 通用核心；界面状态为真正历史 | [产品与交互](product.md#阅读准确版本与来源) | [原章](reference/commerce-product.md#工作台怎样展示一条知识) |
| 发现错误后会发生什么 | 通用核心 | [研究行为：停止与维护](model.md#研究行为停止与维护) | [原章](reference/commerce-product.md#发现错误后会发生什么) |
| 缺口怎样变成下一轮研究 | 通用核心 | [研究行为：停止与维护](model.md#研究行为停止与维护) | [原章](reference/commerce-product.md#缺口怎样变成下一轮研究) |
| 一次创作只读什么 | 业务适配 | [查询、研究、采用、反馈与变化](integration.md#7-查询研究采用反馈与变化) | [原章](reference/commerce-product.md#一次创作只读什么) |
| 从任务开始筛选 | 业务适配 | [查询、采用与反馈](model.md#查询采用与反馈) | [原章](reference/commerce-product.md#从任务开始筛选) |
| 参考包的最小交付 | 业务适配 | [查询、采用与反馈](model.md#查询采用与反馈) | [原章](reference/commerce-product.md#参考包的最小交付) |
| 实际结果怎样修正知识 | 通用核心 | [查询、采用与反馈](model.md#查询采用与反馈) | [原章](reference/commerce-product.md#实际结果怎样修正知识) |
| 虚构示例：反例怎样改变下一次创作 | 业务适配 | [查询、采用与反馈](model.md#查询采用与反馈) | [原章](reference/commerce-product.md#虚构示例反例怎样改变下一次创作) |
| 一条新材料怎样改动已有 Wiki | 业务适配 | [研究行为：综合与循环放大](model.md#研究行为综合与循环放大) | [原章](reference/commerce-product.md#一条新材料怎样改动已有-wiki) |
| 什么证据才能把 P1 改成 P2 | 业务适配 | [研究行为：综合与循环放大](model.md#研究行为综合与循环放大) | [原章](reference/commerce-product.md#什么证据才能把-p1-改成-p2) |
| 下一次创作实际读什么、做什么 | 业务适配 | [查询、采用与反馈](model.md#查询采用与反馈) | [原章](reference/commerce-product.md#下一次创作实际读什么做什么) |
| 产品验收与未决 | 通用核心；未决清单为真正历史 | [连续两轮怎样验收认知成长](model.md#连续两轮怎样验收认知成长) | [原章](reference/commerce-product.md#产品验收与未决) |
| 怎样证明知识真的有用 | 通用核心 | [连续两轮怎样验收认知成长](model.md#连续两轮怎样验收认知成长) | [原章](reference/commerce-product.md#怎样证明知识真的有用) |
| 哪些还没确定 | 真正历史 | [当前状态](current-state.md) | [原章](reference/commerce-product.md#哪些还没确定) |
| 每日研究报告的归档与构建 | 业务适配 | [业务适配指南](https://github.com/cyl19970726/commerce-creative-lab/blob/main/docs/integrations/knowledge.md) | [原章](reference/commerce-product.md#每日研究报告的归档与构建) |
| 日报更新与未知页面的连续构建（2026-10-18 实施合同） | 真正历史 | [当前状态](current-state.md) | [原章](reference/commerce-product.md#日报更新与未知页面的连续构建2026-10-18-实施合同) |
| 待确认变化与安全恢复（2026-10-19） | 真正历史 | [当前状态](current-state.md) | [原章](reference/commerce-product.md#待确认变化与安全恢复2026-10-19) |
| 独立研究页的覆盖复用 | 真正历史 | [当前状态](current-state.md) | [原章](reference/commerce-product.md#独立研究页的覆盖复用) |
| 采集身份与内容主张分开核验 | 业务适配；恢复规则为真正历史 | [登记来源、版本、锚点、权限与用途](integration.md#6-登记来源版本锚点权限与用途) | [原章](reference/commerce-product.md#采集身份与内容主张分开核验) |

## `research/purpose-architecture-20261022.md` 逐章继承

文档级唯一继任者是[通用认知模型](model.md)。原设计评估、固定代码距离和实施状态只作 record；它们不再充当当前完成清单。

| 原章节 | 分类 | 唯一现行继任章节 | 旧链接目标 |
| --- | --- | --- | --- |
| 知识库如何让认知自我成长：目标、例子与完整架构 | 通用核心；页首状态为真正历史 | [认知成长的目标](model.md#认知成长的目标) | [原章](research/purpose-architecture-20261022.md#知识库如何让认知自我成长目标例子与完整架构) |
| 设计评估结论 | 真正历史 | [连续两轮怎样验收认知成长](model.md#连续两轮怎样验收认知成长) | [原章](research/purpose-architecture-20261022.md#设计评估结论) |
| 先看知识内容，再看对它的操作 | 通用核心 | [来源、认知与关联](model.md#来源认知与关联) | [原章](research/purpose-architecture-20261022.md#先看知识内容再看对它的操作) |
| 图一 知识库保存什么，认知凭什么成立 | 通用核心 | [来源、认知与关联](model.md#来源认知与关联) | [原章](research/purpose-architecture-20261022.md#图一-知识库保存什么认知凭什么成立) |
| 图二 Ingest、Query、Lint 怎样作用于同一知识库 | 通用核心 | [研究行为：触发与读取范围](model.md#研究行为触发与读取范围) | [原章](research/purpose-architecture-20261022.md#图二-ingestquerylint-怎样作用于同一知识库) |
| 为什么这套结构有机会实现认知自我成长 | 通用核心 | [认知成长的目标](model.md#认知成长的目标) | [原章](research/purpose-architecture-20261022.md#为什么这套结构有机会实现认知自我成长) |
| 目标：让认知自我成长，并被人和 Agent 继承、检验与修正 | 通用核心 | [认知成长的目标](model.md#认知成长的目标) | [原章](research/purpose-architecture-20261022.md#目标让认知自我成长并被人和-agent-继承检验与修正) |
| 没有这层知识时，具体会失去什么 | 通用核心 | [认知成长的目标](model.md#认知成长的目标) | [原章](research/purpose-architecture-20261022.md#没有这层知识时具体会失去什么) |
| 例一（真实）：本轮问题怎样推动我们理解知识库 | 真正历史 | [认知成长的目标](model.md#认知成长的目标) | [原章](research/purpose-architecture-20261022.md#例一真实本轮问题怎样推动我们理解知识库) |
| 例二（假设）：拉片认知与创作认知怎样合成新认知 | 业务适配 | [研究行为：综合与循环放大](model.md#研究行为综合与循环放大) | [原章](research/purpose-architecture-20261022.md#例二假设拉片认知与创作认知怎样合成新认知) |
| 认知研究与更新的最小行为合同 | 通用核心 | [研究行为：什么值得保存](model.md#研究行为什么值得保存) | [原章](research/purpose-architecture-20261022.md#认知研究与更新的最小行为合同) |
| 一 什么变化值得成为持久认知 | 通用核心 | [研究行为：什么值得保存](model.md#研究行为什么值得保存) | [原章](research/purpose-architecture-20261022.md#一-什么变化值得成为持久认知) |
| 二 谁触发研究，为什么读取这些知识 | 通用核心 | [研究行为：触发与读取范围](model.md#研究行为触发与读取范围) | [原章](research/purpose-architecture-20261022.md#二-谁触发研究为什么读取这些知识) |
| 三 稳定身份、正文权威与更新方式 | 通用核心 | [稳定身份与正文权威](model.md#稳定身份与正文权威) | [原章](research/purpose-architecture-20261022.md#三-稳定身份正文权威与更新方式) |
| 四 综合凭什么成立，怎样避免循环放大 | 通用核心 | [研究行为：综合与循环放大](model.md#研究行为综合与循环放大) | [原章](research/purpose-architecture-20261022.md#四-综合凭什么成立怎样避免循环放大) |
| 五 何时停止，旧认识变化后维护到哪里 | 通用核心 | [研究行为：停止与维护](model.md#研究行为停止与维护) | [原章](research/purpose-architecture-20261022.md#五-何时停止旧认识变化后维护到哪里) |
| 六 何时可发布，怎样证明下一轮真的用到了 | 通用核心 | [研究行为：审阅、发表与继承](model.md#研究行为审阅发表与继承) | [原章](research/purpose-architecture-20261022.md#六-何时可发布怎样证明下一轮真的用到了) |
| 架构职责怎样支撑认知成长 | 通用核心 | [通用知识核心](architecture.md#通用知识核心) | [原章](research/purpose-architecture-20261022.md#架构职责怎样支撑认知成长) |
| 当前实现与建议的距离 | 真正历史 | [当前状态](current-state.md) | [原章](research/purpose-architecture-20261022.md#当前实现与建议的距离) |
| 还有哪些地方需要在实现中定准 | 真正历史 | [当前状态](current-state.md) | [原章](research/purpose-architecture-20261022.md#还有哪些地方需要在实现中定准) |
| 连续两轮怎样验收认知成长 | 通用核心 | [连续两轮怎样验收认知成长](model.md#连续两轮怎样验收认知成长) | [原章](research/purpose-architecture-20261022.md#连续两轮怎样验收认知成长) |

## `reference/commerce-architecture.md` 逐章继承

文档级唯一继任者是[架构](architecture.md)。视频研究、创作交接和带版本号的实施合同留在 commerce 或 record；通用核心只继承跨业务成立的机制。

| 原章节 | 分类 | 唯一现行继任章节 | 旧链接目标 |
| --- | --- | --- | --- |
| 案例、主张、范式、Wiki 与参考包 | 通用核心；页首实现为真正历史 | [通用知识核心](architecture.md#通用知识核心) | [原章](reference/commerce-architecture.md#案例主张范式wiki-与参考包) |
| 3. 粗拉、精拉都能入知识库，但入库不等于升格 | 业务适配 | [登记来源、版本、锚点、权限与用途](integration.md#6-登记来源版本锚点权限与用途) | [原章](reference/commerce-architecture.md#3-粗拉精拉都能入知识库但入库不等于升格) |
| 4. 单条与多条怎样形成知识 | 业务适配；通用审阅机制入核心 | [阅读、研究与唯一发表](architecture.md#阅读研究与唯一发表) | [原章](reference/commerce-architecture.md#4-单条与多条怎样形成知识) |
| 4.1 单片、范式与参考包的最小内容 | 业务适配 | [查询、采用与反馈](model.md#查询采用与反馈) | [原章](reference/commerce-architecture.md#41-单片范式与参考包的最小内容) |
| 4.2 类型、身份与分类：目标合同 | 通用核心；旧代码说明为真正历史 | [稳定身份与正文权威](model.md#稳定身份与正文权威) | [原章](reference/commerce-architecture.md#42-类型身份与分类目标合同) |
| 4.3 关系与失效：目标合同 | 通用核心；早期实现问题为真正历史 | [内容关系与失效](architecture.md#内容关系与失效) | [原章](reference/commerce-architecture.md#43-关系与失效目标合同) |
| 4.4 持续构建：目标执行合同 | 通用核心；参数与实现状态为真正历史 | [研究执行与维护](architecture.md#研究执行与维护) | [原章](reference/commerce-architecture.md#44-持续构建目标执行合同) |
| 6. 创作实际读取什么 | 业务适配 | [业务适配职责](architecture.md#业务适配职责) | [原章](reference/commerce-architecture.md#6-创作实际读取什么) |
| 原文与证据 | 真正历史 | [迁移与旧入口](migration.md#全文去处) | [原章](reference/commerce-architecture.md#原文与证据) |
| 构建失败的有界自修复（v7，实施中） | 真正历史 | [当前状态](current-state.md) | [原章](reference/commerce-architecture.md#构建失败的有界自修复v7实施中) |
| 覆盖身份与未知页隔离（2026-10-18 实施合同） | 真正历史 | [当前状态](current-state.md) | [原章](reference/commerce-architecture.md#覆盖身份与未知页隔离2026-10-18-实施合同) |
| 变化计数与受限页恢复（2026-10-19 实施合同） | 真正历史 | [当前状态](current-state.md) | [原章](reference/commerce-architecture.md#变化计数与受限页恢复2026-10-19-实施合同) |
| 同水位成功页与提交冲突 | 真正历史 | [当前状态](current-state.md) | [原章](reference/commerce-architecture.md#同水位成功页与提交冲突) |
| 身份补证的一次性准入 | 真正历史 | [当前状态](current-state.md) | [原章](reference/commerce-architecture.md#身份补证的一次性准入) |

## 链接维护规则

1. 新引用通用规则时，直接链接本表给出的现行文件和章节；不要先跳到旧长文再让读者自行判断状态。
2. 引用固定实现、数量、部署或一次研究结论时，链接原证据并写明其日期和范围，不把它改写成当前事实。
3. 旧链接的目标文件、文档 ID、标题和原锚点不改；需要提升旧内容时，在现行正文承接，再只更新 `currentGuide`。
4. 一项通用规则只能有一个现行正文。业务适配可以补充自己的来源字段与执行条件，但不能复制出第二套知识版本、审阅或发表权威。
5. 后续若 current 文档降为 record，必须在 catalog 和迁移映射中同时给出有效继任者；校验器会拒绝没有具体现行章节的迁移目标。
