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

## 从回答继续研究并核对原键（本地候选）

先读实例能力：`ask`/`answer` 是当前有据问答，`researchAnswer` 要求编纂写权限，`compilation` 要求编纂读权限。只有原结果为 `answered` 且含 `answerFingerprint` 时，才让用户明确选择 claim、填写后续问题及费用上限。旧服务不返回指纹时不能发起这条研究；原答案只是研究线索，新编纂须重新准确读取完整原读集。合成演示可显式选择 0 USD 上限，不代表真实提供方可免费执行。

研究写入用单独固定幂等键。当前标签页仅持久化原键和严格校验的调用者输入，不保存令牌、答案、Wiki 或来源正文。响应丢失、刷新或重新认证后，先用 `compilationLookup(key,purpose)` 或原编纂 ID GET 核对；不要换键自动 POST。候选形成后仍需独立审阅。若原 Ask 因旧 Wiki 换版而不再可读，已发表或拒绝的编纂仍可按原键查看历史 `answerOrigin`；来源撤权后这条历史读取也要拒绝。新键启动研究必须符合当前资格。

本地浏览器走查已覆盖一个含两份 Wiki 和 176 字节来源原文的 Ask、两次用户明确的后续研究，以及第二次研究响应延迟期间刷新后只读恢复；这证明该合成路径的原键恢复行为，不证明真实模型费用、语义质量或自动发表。最终全量构建与回归状态按[当前状态](current-state.md)更新。

## 配置业务来源所有者

PR68 已随 PR69 合入 `main`，保留两个运行边界。业务宿主持有旧分析仓储与对象存储读取凭据，通过私有 `KNOWLEDGE_SOURCE_OWNER_POLICY_PATH`、`KNOWLEDGE_SOURCE_OWNER_TOKEN` 和 `KNOWLEDGE_SOURCE_OWNER_SUBJECT_ID` 显式装配来源读取器。策略由代码中的 `BusinessSourcePolicySchema` 校验，按原项目、空间、来源对象、版本和用途授予权限；同一来源与用途的重复授权视为配置错误，不能靠追加一条撤权记录覆盖旧条目。

独立知识 API 只配置 `KNOWLEDGE_SOURCE_OWNER_URL` 和服务间读取令牌 `KNOWLEDGE_SOURCE_OWNER_TOKEN`，或通过 `sourceOwner` 参数注入等价端口。业务宿主的路由是 `/api/v1/business-source-owner`；独立服务不构造视频分析宿主，也不取得对象存储或平台凭据。不配置该连接时明确显示所有者未连接。只读端口接受显式 HTTPS 或回环地址，不追随重定向或调用者提交的任意网址。

这项读取装配与模型、采集、Worker 执行和发表配置分别处理。原报告、帧与知识行不因接入而重写；成功内容读取单独留回执。重启试用前确认端口、进程所有者、隔离数据库和清理责任，结束后停止自己拥有的服务并核对原记录保全。

## 运行周期元数据维护（2026-11-02 本地候选）

Worker 的维护模式须显式开启，并提供确定的项目、空间、用途及 active writer grant；API 也须显式启用维护能力及相应 `maintenance:read` / `maintenance:write` action。默认 Worker 每轮按来源与知识事件流收集任务，并以日期周期、确定分片和页数上限推进当前 Wiki 页头 Lint。完成的分片移到下一片；进程重启从持久 pass 游标恢复。`collect` 的事件游标与 `lint` 的周期游标分别管理，不用同一个 SDK 幂等 header 键重放下一页。

默认模式只做元数据收集与七类结构提示，不执行语义任务。宿主需要实际任务执行时才注入 `MaintenanceProcessor`，并另行验证提供方授权、费用上限、外发、响应与取消恢复。任务账本保存尝试、租约、取消请求、分发准备及响应 checkpoint；外部调用状态不明时按原任务和回执核对，不换键重发。逐对 `DecisionProvider` 的应用与受保护账本可独立接入；Jev/OpenAI codec 仅处理 wire data，不含网络 transport 或凭据。

要运行来源研究协调，API 须同时显式配置 `sourcePlanner`、`compiler`、`enableMaintenance` 和 `coordinationPolicy`，并使执行端使用注入的维护 processor；CLI 默认不内置真实 planner 或模型连接。先按任务 ID 读取 `/coordination-runs/by-task/:taskId`，必要时用 `POST /maintenance/process-one` 推进一项；按运行 ID、各子操作原键及来源权限核对进度。每步预算和请求已冻结，共享总期限至多五分钟；未知结果只按原键 lookup，取消、租约丢失或 ACK 丢失不能用新键重新调用模型。独立审阅通过同一事务关闭编纂、协调运行和任务；批准与拒绝的任务状态均为 completed，应查看 `compilationOutcome` 区分。过期 ACK 以实际发表或拒绝记录为准。失效旧 Wiki 的 `recompile` 队列任务仍待专门修复与执行接线；周期 `relation_check` 是另一路当前页头核查。

检查一个 Lint 周期时，先看 `complete`、`scanned`、`startEpoch`、`observedEpoch` 和 `omittedReasons`，再看累计 `findingCount`。`findingIds` 仅是最近一页、最多 1000 个的预览；完整发现用 `maintenanceFindings` 分页核对。`incremental_current_heads` 不是时间点快照，周期内页头变化可能使旧 key 未覆盖；新周期才重扫。发现是待审提示，不自动改变知识或触发编纂。完整构建和独立审查以[当前状态](current-state.md)所指的对应回执为准。

## 接入 Claude 模型（K1 开发工作树候选）

独立 API 默认不连接任何模型；规划、编纂、Ask、关系判断和通用模型调用在未配置时返回 503。设 `KNOWLEDGE_CLAUDE_ENABLED=1` 后，CLI 用同一个 Claude 配置装配 `answerer`、`sourcePlanner`、`compiler`、`decisionProvider` 和 `POST /model-calls`。规划和编纂另需 `KNOWLEDGE_SOURCE_INTAKE_ENABLED=1`，所有写路径仍需可信写者资格。

| 环境变量 | 作用 |
| --- | --- |
| `KNOWLEDGE_CLAUDE_API_KEY_FILE` | 私有密钥文件路径，权限须为 600；密钥本身不进环境变量、日志或错误信息。 |
| `KNOWLEDGE_CLAUDE_MODEL` | 默认 `claude-opus-5-5`；只接受价格表内的模型，否则无法限定花费。 |
| `KNOWLEDGE_CLAUDE_EFFORT` | 默认 `high`。 |
| `KNOWLEDGE_CLAUDE_MAX_CALL_USD` / `KNOWLEDGE_CLAUDE_DAILY_USD` | 单次与每日上限，必填、无默认值；单次不得超过每日。 |
| `KNOWLEDGE_CLAUDE_MAX_OUTPUT_TOKENS` | 输出上限，默认 32000。 |
| `KNOWLEDGE_CLAUDE_ROLES` | 只启用部分角色：`ask,source_plan,wiki_compile,relation_judgment,model_call`；默认全部。 |
| `KNOWLEDGE_MODEL_DISCLOSURE_RIGHTS_POLICY_IDS` | 允许发给外部模型的来源权利策略；未列出的来源原文一律不外发。 |
| `KNOWLEDGE_MODEL_DISCLOSURE_WIKI` | `1` 时允许把已发表 Wiki 页发给模型；默认不允许。 |

调用被拒时的错误码：Anthropic 明确拒绝的请求（4xx）为 `MODEL_CALL_REJECTED`，限流为 `MODEL_RATE_LIMITED`，网络或服务故障为 `MODEL_UNAVAILABLE`，这三种都没有计费，可以用同一个键重试；已发出但结果不明的为 `PROVIDER_OUTCOME_UNKNOWN`。Haiku 5.5 按实际提示长度分两档计价。请求体在认证通过后才解析。

每次调用先用免费的 token 计数得到准确输入量，按“输入全部按缓存写入价、输出按上限”计算最坏费用，据此压低 `max_tokens`，并在 `ccl_knowledge_model_spend` 中预留；返回后按实际用量结算。被拒绝且未计费的请求释放预留；结果不明的调用保留全额预留，所以每日上限只会被多算、不会被突破。SDK 自动重试已关闭，避免重试在预留之外重复计费。服务端拒答兜底（fallbacks）未启用：拒答作为 `refused` 结果返回，费用仍可预先限定。

`POST /model-calls` 供评测对照组使用同一模型、同一 effort 与同一账本。调用方需要 `model:call` 能力和认证安装，必须带 `Idempotency-Key` 与美元 `maxMoney`；同键同请求重放返回原结果且不再计费，同键不同请求返回 409，结果不明的键保持占用。路由单独允许 8 MB 请求体，其余路由仍为 1 MB。

真实付费调用、价格表更新和上限取值都需要使用者另行批准；仓库测试只用假 transport，不访问网络。

## 配置多个调用主体（K5 开发工作树候选）

一个独立 API 可以同时服务多个主体，各有自己的令牌、用途、动作和安装标识。设 `KNOWLEDGE_API_PRINCIPALS_FILE` 指向主体文件后，不再使用 `KNOWLEDGE_API_TOKEN`（两者不能同时设置）；项目与空间仍取 `KNOWLEDGE_API_PROJECT_ID` 和 `KNOWLEDGE_API_SPACE_IDS`，主体的 `spaceIds` 只能是其子集。

主体文件只存令牌的 SHA-256。用 `node scripts/runtime/knowledge-principal-token.mjs` 生成一个随机令牌和它的摘要：令牌只交给对应客户端，摘要写入文件。主体 ID 由部署方自行命名，要求稳定且互不相同，例如 `commerce-analysis`、`commerce-publishing`、`review-agent-1`；审阅记录、来源读者和幂等键都按这个 ID 区分，改名等于换一个新主体。

```json
{"principals":[
  {"id":"commerce-analysis","tokenSha256":"<sha256>","clientInstallationId":"commerce-analysis",
   "purposes":["exploration_reading"],"actions":["sources:write","ingest:read","ingest:write","compile:read","compile:write","review:request","review:read","ask:write","model:call"],
   "adapterIds":["commerce-analysis"],"rightsPolicyIds":[],"actor":{"kind":"service","model":null}},
  {"id":"review-agent-1","tokenSha256":"<sha256>","clientInstallationId":"knowledge-review-agent",
   "purposes":["exploration_reading"],"actions":["review:read","review:decide","compile:read"],"actor":{"kind":"agent","model":"claude-opus-5-5"}},
  {"id":"commerce-publishing","tokenSha256":"<sha256>","clientInstallationId":"commerce-publishing",
   "purposes":["publication_feedback"],"actions":["uses:write","feedback:write"],"adapterIds":["commerce-publishing"],"actor":{"kind":"service","model":null}}
]}
```

`actor` 由部署方在服务端声明，调用方不能在请求里自称是人或 agent；只有 `agent` 主体可以写 `model`。独立审阅规则不变：审阅人必须是提议人以外的主体（`SELF_REVIEW_FORBIDDEN`），这个主体可以是审阅 agent。审阅完成后，审阅票据带 `reviewer: {principalId, kind, model}`，便于把 AI 审阅和人工审阅分开统计。未单独设置 `KNOWLEDGE_SOURCE_READER_IDS` 时，所有已配置主体都是新登记来源的读者，审阅主体因此能读取被引用的原文。

## 运行审阅 agent（开发工作树候选）

审阅 agent 是独立进程，以自己的主体（`actor.kind` 为 `agent`）通过 HTTP 访问知识 API，没有数据库权限。每一轮它取出可审的待审票据（`GET /review-requests`：不含自己提议的、不含已转人工的），逐条读取候选页和候选实际读过的每份原文，在全新的模型上下文里判断，然后二选一：

- 全部陈述都有原文支持时作出决定：`approved_for_purpose`、`exploration_only` 或 `rejected`。决定不能新增条件或缺口，agent 的缺口写进理由。
- 否则转人工（`POST /review-requests/:id/escalations`）：涉及非公众人物、法律风险、来源互相矛盾、把握不高，“批准”但有不受支持的陈述，原文不允许发给模型，模型拒答或输出无效，以及候选已取消或已变化的过期票据。票据保持待审，带上 `escalation: {categories, note, by, at}`；人工在 `GET /review-requests?escalated=only` 里处理。转人工后 agent 不再处理这张票据，失败不会反复计费。
- 限流（`MODEL_RATE_LIMITED`）、服务不可用（`MODEL_UNAVAILABLE`）、结果不明或当日额度用完属于暂时性问题：票据留在队列里，下一轮再审，不转人工。agent 只取 `targetKind=candidate` 的票据。

agent 发原文给模型时遵守与服务相同的外发规则（`KNOWLEDGE_MODEL_DISCLOSURE_RIGHTS_POLICY_IDS`、`KNOWLEDGE_MODEL_DISCLOSURE_WIKI`）。它可以使用与编纂不同的模型和上限：Claude 配置沿用同一格式，前缀改为 `KNOWLEDGE_REVIEW_AGENT_CLAUDE_`（例如 `KNOWLEDGE_REVIEW_AGENT_CLAUDE_MODEL`、`..._API_KEY_FILE`、`..._MAX_CALL_USD`、`..._DAILY_USD`）。其余设置：

| 环境变量 | 作用 |
| --- | --- |
| `KNOWLEDGE_REVIEW_AGENT_API_URL` | 知识 API 地址。 |
| `KNOWLEDGE_REVIEW_AGENT_TOKEN_FILE` | agent 主体的令牌文件，权限须为 600。 |
| `KNOWLEDGE_API_PROJECT_ID` / `KNOWLEDGE_REVIEW_AGENT_SPACE_ID` | 审阅范围。 |
| `KNOWLEDGE_REVIEW_AGENT_PURPOSE` | 默认 `exploration_reading`。 |
| `KNOWLEDGE_REVIEW_AGENT_SPEND_FILE` | agent 自己的费用账本（JSONL，单进程使用）。 |
| `KNOWLEDGE_REVIEW_AGENT_INTERVAL_SECONDS` | 轮询间隔，默认 60；加 `--once` 只跑一轮。 |

构建后用 `node apps/knowledge-api/dist/review-agent.js --once` 运行。agent 主体至少需要 `review:read`、`review:decide`、`compile:read`，并且必须是相关来源的读者；来源登记时就要把它纳入读者名单（多主体模式下默认已纳入）。

## 推进当前 Wiki 语义扫描（开发工作树候选）

`SemanticSweep` 只读取当前已发表 Wiki 页头的元数据，不读正文、不执行判断。API 需显式装配编纂器、source intake、协调策略、维护能力与 active writer grant，并授予 `maintenance:read` / `maintenance:write`；`POST /maintenance/semantic-sweeps` 一次仅推进**一个分片的一页**，`GET /maintenance/semantic-sweeps/:passId?purpose=...` 按原范围读取。SDK 对应 `runSemanticSweep({purpose,cycleKey,shard,shardCount,limit,maxTasksPerShard,methodVersion,rubricVersion}, writeOpts)` 与 `semanticSweep(passId,purpose)`。`limit` 为 1–100，`maxTasksPerShard` 为 1–10000；跨页沿用相同周期、分片和方法版本，写入调用使用自己的 header，不能把原写入键当成下一页游标。

检查 `scanned`、`lastObjectId`、`complete`、`limitReached`、`taskCount`、`startEpoch`、`observedEpoch` 和 `omittedReasons`。同一事务读取页头元数据，并提交 `relation_check` 任务、累计数与游标；`taskIds` 只预览最近一页最多 100 个，查全量任务须按维护任务入口分页。`maxTasksPerShard` 到达时若还有页头，`limitReached=true`、`complete=false`，剩余范围明确记录遗漏，不可称为扫描完成。`incremental_current_heads` 可能漏掉周期内新出现的较小键或换版，新周期才重新遍历。提交状态不明时先按原 pass 核对，不盲目新开周期。

Worker 只有宿主显式提供 `maintenance.semanticSweep` 和支持 `relation_check` 的 processor 才按 UTC 日期组成周期键、逐片推进，并避免同一无进展状态忙转。CLI 的默认维护装配**不启用**语义扫描，也没有真实模型 transport；仅有任务不表示已经执行判断。任务处理仍须核对原键、用途、来源权限、外发授权和预算，纯 Wiki 路径见[接入手册](integration.md)。

维护页头扫描的游标、分片和排序与 `ccl_knowledge_revisions_project_scope_uuid_idx` 的 project/space/UUID 顺序一致；准确 head join 继续排除旧版本。该索引由核心迁移创建。统计信息更新后的合成抽样计划使用索引，完整结果与失败对照见[周期维护回执](evidence/wiki-periodic-maintenance-validation-20261102.json)。分片仍可能过滤更多索引项，`LIMIT` 只界定返回页大小，不能解读为数据库只检查同样数量的行。

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


### 当前 Wiki 页与修复任务

工作台侧栏“Wiki页”按当前scope和purpose浏览当前版本，使用 `wikiCatalog` 能力及目录种类过滤；不能用当前图节点数量代替页库总数。失效页仍可按服务许可读取原文核对。

发表事件的superseded与来源更新的supersedes会触发关键依赖闭包的修复任务；Lint的到期和关键依据失效也可回填任务。有效新页交由既有周期扫描处理。2026-11-03 起，配置了编纂器与协调策略的协调 processor 会领取 `recompile`：目标已不是当前版本时按过时结束，目标或关键来源不可读、上游 Wiki 仍待修复或没有可读输入时以待补证结束，三者都不调用模型；其余情况产出带依赖处置的待审候选。入队、候选和发表仍是不同状态，运维不得把已入队或已形成候选写成已修复，须以独立审阅发表和下一轮查询为准。CLI Worker 仍不装配 processor。
