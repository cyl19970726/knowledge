# 独立知识产品：实现与验收边界（2026-10-26）

本记录描述当前分支的 M0–M3 **本地工程候选**，不替代 [项目范围与七目标](https://chatgpt.com/space/page_d2cb3d9f4fc8819188ac80363db3f30d)或[持续更新的项目理解](https://chatgpt.com/space/page_35e0d83c4f14819180a5b50a5995a1d4)，也不等于用户视觉、真实认知质量或业务效果验收。基线是 `origin/main@8fc92cf`；代码仍在独立工作树中，未部署、未合入主线。旧知识版本的 `objectId`、`versionId`、内容哈希和幂等键语义保持原样；新增传输范围和来源摘要不构成第二套存储 ID。原 `KnowledgeStore` 仍是版本、head 与发布权威。

## 分包与运行依赖

```mermaid
flowchart LR
  W[knowledge-web] --> L[knowledge-client]
  D[document adapter] --> L
  M[commerce adapter] --> L
  L --> C[knowledge-contracts]
  C --> P[contract-primitives]
  API[knowledge-api] --> A[knowledge-application]
  API --> S[knowledge-service-adapter]
  Worker[knowledge-worker] --> A
  Worker --> S
  A --> K[@commerce/knowledge-core and ports]
  A --> C
  S --> K
  S --> A
```

公共 DTO 与运行时校验只有 [`packages/knowledge-contracts`](https://github.com/cyl19970726/commerce-creative-lab/blob/codex/knowledge-product-20261026/packages/knowledge-contracts/README.md) 一处；它只复用浏览器安全的旧合同基础类型。[`packages/knowledge-client`](https://github.com/cyl19970726/commerce-creative-lab/blob/codex/knowledge-product-20261026/packages/knowledge-client/README.md) 可在浏览器和 Node 使用，调用前后校验合同，不含 React、PG 或业务装配。原核心现由 `packages/knowledge/package.json` 作为 `@commerce/knowledge-core` 构建，提供实际 `dist` JavaScript、类型声明和 `./store`、`./types`、`./wiki-page`、`./writer-authority` 等显式子路径出口；消费者经包出口加载，不靠重定向到源文件。应用层处理准入、阅读回执和研究策略；服务适配层持久化来源、操作、使用和反馈；独立 API 与 worker 只装配知识能力。网页只从知识 client 和合同读取。文档与 commerce 适配器通过同一个 client 接入。包各有 manifest、`dist` JavaScript 和类型声明出口，仍在单仓、单根锁文件内；没有新仓库或第二个数据库权威。

## 工程状态

| 阶段 | 当前可核对能力 | 尚不能据此声称 |
| --- | --- | --- |
| M0 | 严格、有界的公共合同；原版本 ref 显式映射；范围、用途、鉴权回执；浏览器/Node client；未知提交状态和原 key 对账 | 旧数据已迁移或新内容已获事实审核 |
| M1 | 独立网页、只读 API、准确版本/历史/来源、分页目录与查询、阅读回执、关系图及来源祖先；正式 ELK Worker 在真实浏览器运行 | 用户已接受最终视觉；全量历史时间旅行 |
| M2 | 本地托管来源的登记、owner/CAS、撤权、同事务来源证明与发表；合成研究、候选、独立审核、取消与操作对账 | 外部来源已有可证明的发表租约；合成研究代表真实认知质量 |
| M3 | 文档与 commerce 两种外部上下文的使用决策、准确读集、反馈、变化流；当前来源权利撤销后拒绝使用记录读取及重放 | 反馈等于实际用户效果或经营收益 |
| M4/M5 | 未执行 | 生产切换、旧路径搬迁或真实业务验收 |

研究结果允许 `candidate`、`no_change`、`needs_evidence` 三种；候选仍需独立审核。合成 provider 默认只给出 `no_change` 或 `needs_evidence`，`candidate` 由内部注入的工程夹具验证，不代表真实模型发现新认识。原文、观察、解释与反馈分开存放。外部来源没有可证明的 lease 时拒绝发表，不以本地引用冒充权利证明；本地托管来源在同一 PG 事务和项目锁内复核。历史 `asOf`、图谱 `asOf` 与图谱 cursor 明确返回 422，避免把当前读误称为历史快照。已存的使用记录保留审计，但读取和同 key 重放会重新检查当前来源权利。

## 本地验证与预览

从仓库根目录安装依赖后，可分别构建 `npm run build:knowledge-client`、`npm run build:knowledge-server`、`npm run build:knowledge-adapters`、`npm run build:knowledge-web`。`npm run test:knowledge-product` 使用显式 `TEST_DATABASE_URL` 运行工程测试；测试源见 [`apps/knowledge-api/test`](https://github.com/cyl19970726/commerce-creative-lab/tree/codex/knowledge-product-20261026/apps/knowledge-api/test)、[`packages/knowledge-contracts/test`](https://github.com/cyl19970726/commerce-creative-lab/tree/codex/knowledge-product-20261026/packages/knowledge-contracts/test) 和 [`packages/knowledge-client/test`](https://github.com/cyl19970726/commerce-creative-lab/tree/codex/knowledge-product-20261026/packages/knowledge-client/test)。已取得的隔离 PG/HTTP 证据覆盖核心权威、准确读、来源/使用、丢失 COMMIT 确认和独立构建进程；同一测试可能被多条命令覆盖，故不累计重复数量。数据与文案均为合成测试材料，不是业务结论。

专用演示入口 [`scripts/runtime/knowledge-product-demo.ts`](https://github.com/cyl19970726/commerce-creative-lab/blob/codex/knowledge-product-20261026/scripts/runtime/knowledge-product-demo.ts) 必须显式提供 `KNOWLEDGE_DEMO_DATABASE_URL` 指向可丢弃的测试数据库，再运行 `npm run dev:knowledge-demo`。它每次创建独立 schema，只写合成数据，退出时删除 schema；连接资料写在本地 `local/knowledge-product/demo/connection.json`，不应提交。另开终端运行 `npm run dev:knowledge-web`，在 `127.0.0.1:4310` 打开网页；构建预览用 `npm run preview -w @commerce/knowledge-web`，端口 `4312`。两者把 `/api` 代理到独立 API 的 `127.0.0.1:4311`。演示生成的本地 token 由连接界面输入，不写入前端构建。

不使用演示脚本时，独立 API 需要 `KNOWLEDGE_DATABASE_URL`、`KNOWLEDGE_API_TOKEN`（至少 24 字符）、`KNOWLEDGE_API_PROJECT_ID`、`KNOWLEDGE_API_SPACE_IDS`；可设 `KNOWLEDGE_API_PRINCIPAL_ID` 和 `KNOWLEDGE_API_PORT`，再运行 `npm run dev:knowledge-api`。无授权 grant 时为只读装配。独立 worker 的合成写入路径要求 `KNOWLEDGE_SYNTHETIC_WRITES=1`、同一测试库与项目 ID，以及可信的 `KNOWLEDGE_WRITER_GRANT_JSON`；API 的合成写入也须该开关、grant 与相应动作/适配器/权利策略许可。不要将真实 token 或 grant 写入文档。写权威 trigger 需要针对目标项目显式激活，现有构建和演示不等于生产配置或授权。

首轮交付的 `npm run build` 与独立 web build 成功；当时 `npm test` 共 1090 项，其中 1084 通过、0 失败、6 项因既有环境条件跳过。`make test` 18 项通过。`make docs` 与 `make docs-check` 对本次最终说明重生成并校验。真实浏览器已在 1440×960 与 390×844 查看正式 ELK Worker 图谱：33 个节点、96 条关系，页面无横向溢出；一次布局记录为约 165 ms，这只是单次观察，不是性能基准。问题查询→阅读准确正文→打开来源准确版本与锚点→返回、以及历史/现版正文对照均已操作；手机端已实测正文滚动 500 → 来源顶部 0 → 返回正文 500，窗口位置恢复正确。工程演示截图不等于用户批准最终视觉。

没有真实媒体采集、真实模型或付费模型调用、生产数据库写入、上线、主线合并、M4 切换、M5 搬迁或全局技能安装授权。合成工程夹具与浏览器操作只能证明本地机制可运行，不证明真实认知结论和业务效果。


工程截图与页面实测回执：[全局星图](../../assets/knowledge-product/global-1440.jpg)、[研究三列核对](../../assets/knowledge-product/research-1440.jpg)、[390 像素阅读](../../assets/knowledge-product/reader-390.jpg)、[390 像素准确来源](../../assets/knowledge-product/source-390.jpg)、[结构化验证记录](../../assets/knowledge-product/validation.json)。这些是合成材料的实际页面截图；节点密集处仍有标签重叠，未获用户视觉验收，也未覆盖大图压力性能。

最终复核补充：来源登记与反馈转来源的旧 key 重放会在源 head/权利改变后以 `SOURCE_REPLAY_STALE` 拒绝，避免将历史可读性当成当前保证；来源撤权后仍可由独立审阅者作不发表的拒绝结案，批准仍需有效来源证明；审阅票据仅对请求者、提出者或有审阅权限的主体可见。新增两项真实 PG 回归，完整套件已覆盖。六项跳过为既有的 API+S3 集成开关、三项私有捕获模型调用、私有本地验收回执及 Caddy 环境；本次新工程测试均未跳过。

独立文档正文、目录与阅读器迁移由主会话的 `docs/knowledge-docset-20261026` 分支另行维护；本分支只新增此实施记录和实际页面证据。合并审查时需有意整合 catalog 条目与生成 HTML，不能将文档拆分建议视为本分支已完成。

交付：[草稿 PR #66](https://github.com/cyl19970726/commerce-creative-lab/pull/66)，核心源码提交 `21e913989c67ebe456889be52915427e29c36ffa`；代码未合并或部署。提交前扫描检查 85 个文本文件与 4 张合成页面截图，未发现凭据或私有材料。该扫描只覆盖本次提交，不是完整的数据防泄漏审计。


## 2026-10-26 交付后评审修正

主会话对草稿 PR66 冷读后提出六项后端问题。本轮先以合成 PG/HTTP 回归复现，再修复：

| 问题 | 修正与界限 |
| --- | --- |
| 未适配内容仍能采用 | 阅读、使用、研究共用当前版本资格；未知 profile/不匹配冻结 binding 不允许采用或改编。准确读集保留读时状态，写记录保存当前资格。普通无资格版本仍能拒用、暂缓和反馈纠错。 |
| 反馈/变化的用途隔离 | 反馈输入、来源登记和对账显式带 purpose；存储、关联 use、GET、cursor、变化流及研究审阅均绑定原用途。旧行只迁移可证明的授权列，原 payload/digest/key 不改；未知用途保留私有。 |
| 撤权后的回执和变化 | 首次使用、反馈新键/旧键/读取及变化重验当前来源权利，撤权不返回旧正文摘要或受限引用；普通失效与撤权区分。反馈形成的托管来源副本也按其持久用途校验。 |
| 历史发表时间 | core 的 get/getAsOf/history/search 返回 DB published_at，history 只投影它或未知，不用 createdAt 补。 |
| 迁移被当作写激活 | 独立入口配置 grant 时要求匹配的已激活 authority；无 grant 的旧项目保留原兼容边界。 |
| 准确 ref 被改标空间 | 提交与 worker 执行前都核对实际 revision binding 或明确的 legacy 空间映射，不能用调用方 ref 标签代替存储事实。 |

相邻回归同时覆盖：可证明原用途的旧反馈 key 精确重放而不重算原哈希；research_result 的审阅票据和定稿绑定原研究用途；本地 SDK 校验在 fetch 前明确返回 `CLIENT_VALIDATION_ERROR / not_committed`，真实传输丢失仍是 `unknown`。ReadOptions/WriteOptions 支持显式 `purpose`，实际 HTTP 已验证第二用途的研究结果、阅读回执、审阅与取消链路。

本轮前端改动来自主会话审阅的受管补丁，后端负责人未手改 App：首份补丁 SHA256 `77a1137c7c99daa6b92bf2a517e7832bb05f3e21078256ad3514654c6c88106e`。它处理写入意图/key 的未知结果锁定及同键对账、标签几何与展示；后续增量由同一前端负责人补齐用途传递和窄屏 resize/fit。两份补丁已原子接合；增量补丁 SHA256 `6c1112c42f4ff88cf85f962a5ad12a2f38e71566baff2f4fb1d5b1070e68286a`。Node24 根构建、独立网页构建及最终完整测试通过：1115项，1109通过、0失败、6项既有环境跳过，新工程回归未跳过。首版1090项回执保留为历史验证。

逐项结构化证据见 [后端评审回归记录](../../assets/knowledge-product/backend-review-validation.json)。所有新回归仍是合成工程证据，未扩大为真实模型、内容质量、业务或生产切流验收。

最终运行状态：旧合成 demo 进程22861已停止且独立schema已删除；以新代码重建的演示进程29186在API4311运行，网页预览4312保留。连接资料和新token只在ignored本地文件中，旧token已失效；主会话负责刷新连接后的真实浏览器复验。用户视觉、真实内容与业务验收仍未完成。


## 2026-10-26 独立启动与切图修正

真实案例复验暴露两处演示流程未覆盖的问题，本轮只修正入口和画布生命周期。独立 API 在安装受能力保护的触发器前执行已有公开 core migration，空 schema 和缺少 writer 函数的旧 schema 可直接启动，不依赖 demo seed。迁移不激活写权威；隔离测试用已发表的合成旧 ledger 比较全部九张 core 表，确认原 revision、head、review、发表时间、hash、key、epoch 均未改写。构建后的 CLI 也直接连接空 schema 运行，读能力正常且写操作仍被拒绝。

切图时 React 上一轮的 ready 状态可能与新建的空 Cytoscape 实例同时存在。画布现在将就绪状态绑定到具体图实例，完整安装所有节点和关系后才允许选择、标签、可见性和重置效果访问；废弃实例的延迟布局和帧回调不能继续作用。缺失或非有限的渲染坐标只暂停该标签，布局缺失节点位置则显示错误，不删除节点或关系掩盖问题。真实 Cytoscape 合成回归覆盖全局图到延迟查询图、共享节点 ID、废弃布局及无效坐标，保留全部 3 个知识节点、9 个外部节点和 12 条关系。这些数量来自工程夹具，不是新业务证据。

定向检查 15 项通过、0 失败、0 跳过（含三条真实隔离 PG/CLI 启动路径、三条画布回归及包边界检查）。Node24 根构建、独立网页构建、完整测试及文档构建检查通过；完整测试为 1122 项、1116 通过、0 失败、6 项既有环境跳过，新回归无跳过。主会话负责真实浏览器复验及文档重基；本轮没有改动其真实评估副本、数据库、运行配置、旧来源 owner 或 ref。来源归属 unknown 的迁移边界保持原状。
