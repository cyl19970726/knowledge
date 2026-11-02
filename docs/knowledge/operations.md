# 独立阅读、运行与验证

先确定要阅读文档、检查固定主线，还是运行独立产品候选；三者的版本与依赖不同。本页不保存凭据、私有连接串或客户资料。为新业务进行源码准备、分包构建、适配和普通文档端到端验收时，使用[技术接入手册](integration.md)。

## 单独构建文档

在仓库根目录使用已有文档依赖，运行：

```sh
make docs-knowledge
make docs-knowledge-check
```

输出为 `docs/knowledge/index.html`，目录与全文搜索仅含知识文档。共享阅读器和离线 Mermaid 由仓库文档设施提供。业务适配或其他共享说明通过明确的跨集链接打开。

`make docs` 与 `make docs-check` 构建和检查根目录的核心总入口；根 `docs/catalog.json` 只导入 `knowledge/catalog.json`。根阅读器和知识专属阅读器使用同一份知识文档元数据及正文，两套生成产物都由源文件重建。

## 核对独立产品候选

独立核心仓已公开为 [cyl19970726/knowledge](https://github.com/cyl19970726/knowledge)，本次独立仓验收基线为 `eecf30e90d6700d06b70d09402ab45a1567b28fb`，最新 `main` 以远程提交为准。commerce 通过 [PR69](https://github.com/cyl19970726/commerce-creative-lab/pull/69) 以 `vendor/knowledge` submodule 接入，合并提交为 `1b96c6d8830b17b86b3dff9b62c9fd530abfd573`；PR68 也随集成完成合并。新工作从核心仓最新 `main` 开始，消费仓再 bump submodule 版本。历史 PR66/67 与早期已验实现用于来源追查，本集[唯一实施回执](evidence/standalone-product-20261026.md)保留合并前的完整记录，其“未合并”语句按当时阶段解释。

实现候选需要分别证明：客户端与公开合同可构建，独立网页不依赖视频或数据库配置完成构建，API 和 Worker 有明确装配与入口，两种业务适配通过同一能力接入。当前包名、参数、端口和命令以[技术接入手册](integration.md)与本页为准，固定日期的实施回执只用于历史追查。

本地工程演示使用明确可丢弃的测试数据库和合成资料，连接参数保留在本地运行配置中。真实模型、采集、生产数据库、来源授权和写者资格需要各自满足条件；演示跑通不代表这些条件已满足。

## 独立试用怎样验收

用户批准的后续顺序是接通真实业务来源、走完一个真实问题的知识使用流程、据此细化前端，再形成独立试用交付。保留已确认的星群主布局；每项按实际结果更新[当前状态](current-state.md)。

真实资料试用使用有明确所有者的隔离副本，开始前核对原库与副本的来源、版本和页头摘要。业务原件通过所有者读取，实际报告与帧分别核对准确版本、字节摘要、定位与范围。错项目、用途、版本或摘要以及撤权后的读取需要拒绝；合法且获授权的历史准确版本是成功对照，不应因它不是现版而拒绝读取。

随后沿同一个问题完成检索、准确正文、依据定位、返回阅读位置、条件比较、采用或拒用、反馈和修订判断。验收要能解释具体依据、成立条件、未知以及为何改变或保留；接口成功、图谱可见和报告数量各自只证明对应的工程行为。

AI 案头判断、真人脚本复述、实物与制作核验、真实观看结果分别记录。未执行的类别保持未观察；有据保留旧知识也是有效结果。私有原稿、真实响应、帧图、连接配置和参与者记录不进入可公开文档或版本库。

## 配置业务来源所有者

PR68 已随 PR69 合入 `main`，保留两个运行边界。业务宿主持有旧分析仓储与对象存储读取凭据，通过私有 `KNOWLEDGE_SOURCE_OWNER_POLICY_PATH`、`KNOWLEDGE_SOURCE_OWNER_TOKEN` 和 `KNOWLEDGE_SOURCE_OWNER_SUBJECT_ID` 显式装配来源读取器。策略由代码中的 `BusinessSourcePolicySchema` 校验，按原项目、空间、来源对象、版本和用途授予权限；同一来源与用途的重复授权视为配置错误，不能靠追加一条撤权记录覆盖旧条目。

独立知识 API 只配置 `KNOWLEDGE_SOURCE_OWNER_URL` 和服务间读取令牌 `KNOWLEDGE_SOURCE_OWNER_TOKEN`，或通过 `sourceOwner` 参数注入等价端口。业务宿主的路由是 `/api/v1/business-source-owner`；独立服务不构造视频分析宿主，也不取得对象存储或平台凭据。不配置该连接时明确显示所有者未连接。只读端口接受显式 HTTPS 或回环地址，不追随重定向或调用者提交的任意网址。

这项读取装配与模型、采集、Worker 执行和发表配置分别处理。原报告、帧与知识行不因接入而重写；成功内容读取单独留回执。重启试用前确认端口、进程所有者、隔离数据库和清理责任，结束后停止自己拥有的服务并核对原记录保全。

## 运行周期元数据维护（2026-11-02 本地候选）

Worker 的维护模式须显式开启，并提供确定的项目、空间、用途及 active writer grant；API 也须显式启用维护能力及相应 `maintenance:read` / `maintenance:write` action。默认 Worker 每轮按来源与知识事件流收集任务，并以日期周期、确定分片和页数上限推进当前 Wiki 页头 Lint。完成的分片移到下一片；进程重启从持久 pass 游标恢复。`collect` 的事件游标与 `lint` 的周期游标分别管理，不用同一个 SDK 幂等 header 键重放下一页。

默认模式只做元数据收集与七类结构提示，不执行语义任务。宿主需要实际任务执行时才注入 `MaintenanceProcessor`，并另行验证提供方授权、费用上限、外发、响应与取消恢复。任务账本保存尝试、租约、取消请求、分发准备及响应 checkpoint；外部调用状态不明时按原任务和回执核对，不换键重发。逐对 `DecisionProvider` 的应用与受保护账本可独立接入；Jev/OpenAI codec 仅处理 wire data，不含网络 transport 或凭据。

要运行来源研究协调，API 须同时显式配置 `sourcePlanner`、`compiler`、`enableMaintenance` 和 `coordinationPolicy`，并使执行端使用注入的维护 processor；CLI 默认不内置真实 planner 或模型连接。先按任务 ID 读取 `/coordination-runs/by-task/:taskId`，必要时用 `POST /maintenance/process-one` 推进一项；按运行 ID、各子操作原键及来源权限核对进度。每步预算和请求已冻结，共享总期限至多五分钟；未知结果只按原键 lookup，取消、租约丢失或 ACK 丢失不能用新键重新调用模型。独立审阅通过同一事务关闭编纂、协调运行和任务；批准与拒绝的任务状态均为 completed，应查看 `compilationOutcome` 区分。过期 ACK 以实际发表或拒绝记录为准。旧 Wiki 的 `recompile` 队列任务目前仍待语义发现与执行接线。

检查一个 Lint 周期时，先看 `complete`、`scanned`、`startEpoch`、`observedEpoch` 和 `omittedReasons`，再看累计 `findingCount`。`findingIds` 仅是最近一页、最多 1000 个的预览；完整发现用 `maintenanceFindings` 分页核对。`incremental_current_heads` 不是时间点快照，周期内页头变化可能使旧 key 未覆盖；新周期才重扫。发现是待审提示，不自动改变知识或触发编纂。完整构建和独立审查以[当前状态](current-state.md)所指的对应回执为准。

## 重建当前页检索投影（G5 本地候选）

先确认 API 显式启用维护、当前主体拥有相应 `maintenance:read` / `maintenance:write`，并已配置 active writer grant。用 SDK `searchProjectionStatus(purpose)` 或 `GET /maintenance/search-index?purpose=...` 读取认证项目与空间的状态；`null` 表示尚无该空间状态。`ready=false` 时查询会回退原词项 SQL，服务可继续检索。`ready=true` 也只是预筛可用，不是问答、权限或性能验收。

每次用 `rebuildSearchProjection({purpose,limit,restart:false}, writeOpts)` 或对应 POST 推进有界一批，`limit` 取 1–5000；CLI 维护模式默认 100/批。观察 `lastObjectId`、`scanned`、`blockedRows`、`complete` 和 `ready` 后再决定是否继续。只有明确要重新从头覆盖核验时才传 `restart:true`；后续批次恢复 `false`。每次写调用使用自身的操作 header，不把同一个 header 键当作“下一页”游标或重放保证。状态与异常提交结果按原作用域核对，未知提交不推定该批未执行。Worker 可选 `searchProjection:{limit}`，遇到已 `ready` 或受超大字段阻塞而无进展时不会把它持续当成新工作忙转。

重建在项目锁与受保护表内执行，按当前页头分页，清理仅存于缓存的孤儿项，核对页头版本、空间、格式与阻塞数后才标记 `ready`。标题、正文、身份键及别名规范化后合计超过 200000 UTF-8 字节会使该页不可索引、`blockedRows>0`；反复调用同一批不会修复该内容，应先通过正常修订路径处理再重验。手工改缓存会使空间失去 `ready` 并重置游标；页头或修订触发器在同一事务刷新投影。普通页头变化若不改变覆盖与阻塞状态，不额外重写同一空间状态；同值重建也不重写已有 gram 行。`updatedAt` 表示重建状态变化，不是每个页头的最新刷新时间；准确 head 与项目 epoch 才是对应版本权威。单字 Unicode 词项、格式不符、未就绪或诊断关闭时整次查询走原 SQL，原评分与权限路径不变。源码依据：重建和触发器 (`packages/knowledge/src/wiki-search-projection.ts`)、检索回退 (`packages/knowledge/src/store.ts`)、Worker 进度 (`apps/knowledge-worker/src/index.ts`)。G5 的完整构建、规模数据和最终差异证据仍以[当前状态](current-state.md)所列待回执为准。

## 修改文档后的检查

```sh
make docs
make docs-check
python3 scripts/check_knowledge_docs_migration.py --external-business
python3 -m unittest tests.test_build_docs -v
```

当前独立核心仓没有 `scripts/check_docs_migration.py`；`make docs-check` 已调用适用于核心仓的迁移检查，单独运行时须带 `--external-business`。校验检查完整文本、标题和原锚点；阅读器测试检查链接、导入、权限边界与生成行为。浏览器还应实际走通入口、目录、搜索、旧链接与跨集返回，并检查窄屏可读性。自动检查不代替内容与读者任务验收。

## 合并、部署与回滚

源码与文档分别通过 PR 交付，整合时解决 catalog 和实施回执归属，再重新生成与检查两套 HTML。Git 合并记录不证明服务已切换；正式部署另按明确授权与运行回执处理。

文档回滚依靠 Git 中的完整源文件、稳定文档 ID 和迁移映射。不要删除原业务数据或改写历史回执来让当前说明显得一致。
