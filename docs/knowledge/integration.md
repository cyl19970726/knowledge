# 新业务技术接入手册

新业务复用的是同一套知识能力，不是复制一套知识权威，也不是继承其他业务的资料与权限。业务所有者继续管理原始资料、平台身份、采集分析和经营动作；知识服务管理登记后的来源引用、知识版本、关系、研究、审阅发表、采用与反馈。commerce 的具体字段映射由其业务仓的[业务适配指南](https://github.com/cyl19970726/commerce-creative-lab/blob/main/docs/integrations/knowledge.md)维护，访问需要该仓库的读取权限。本机已签出业务仓时，对应源文件是 `commerce-creative-lab/docs/integrations/knowledge.md`。

本页给出技术接入顺序。具体字段、错误码和可调用操作以同一源码版本的 `packages/knowledge-contracts/src/index.ts` 及客户端包出口为准；本页不手写第二套 DTO。当前主线、部署和真实语义验收边界见[当前状态](current-state.md)，能力语义见[能力与接入合同](capabilities.md)。

接入前先用一个业务问题走通概念链：原件由谁持有、哪个版本和段落可读；现有认识回答什么、条件与反例是什么；新问题是否只需查询，还是需要研究候选；一次采用或拒用如何连回准确版本，反馈由谁观察并交回。普通文档可以用“规则资格与提交材料合格是否是两个前提”试走，视频可用[产品篇的 A/B→C 场景](product.md#连续两轮从-ab-到-c再接受反例)。两者使用同一知识能力，业务对象、权限与实际效果各自保留在自己的所有者处。以下工程步骤建立连接，并不自动完成该语义链的真实验收。

## 1. 准备源码、Node 24 与 workspaces

在仓库根目录工作，使用 `.node-version` 指定的 Node 24.x 和根锁文件。不要在新业务目录另建一套 lockfile，或用业务应用的包管理配置覆盖根 workspaces。

```sh
npm ci
node --version
```

独立核心仓当前没有 `.gitmodules`；根 `package.json` 的 workspaces 包含公共合同、客户端、核心、应用层、服务适配器、普通文档适配器，以及独立 API、Worker 和 Web。commerce 适配器只保留在消费仓。若从 commerce 消费仓取得核心源码，应按该仓的 submodule 引用先初始化并核对固定提交；这不是在独立核心仓执行 `npm ci` 的前提。

新业务可以在自己的消费仓实现适配器，普通文档则可先沿用本仓已有的 `@commerce/knowledge-document-adapter` 参考包；只有决定由核心仓维护的通用适配器才需要加入本仓 workspaces。包名、导出和脚本以该版本 manifest 为准；通过声明的包出口导入，不跨包读取 `src` 内部文件，也不依赖构建目录中的偶然路径。

## 2. 按依赖顺序构建

公共合同先于客户端；客户端先于 Web 和业务适配器；核心、应用层和服务适配器先于 API 与 Worker。根脚本已经表达这些顺序：

```sh
npm run build:knowledge-client
npm run build:knowledge-server
npm run build:knowledge-adapters
npm run build:knowledge-web
```

也可以运行聚合命令：

```sh
npm run build:knowledge-foundation
npm run build:knowledge-web
```

不要在 API、Worker 或 Web 内重复编译依赖来绕过公开构建入口。客户端保持浏览器和 Node 可用且不依赖 React、PG、视频处理或业务表；Web 只依赖浏览器安全入口；API 与 Worker 才装配服务端设施。独立 Web 构建不应要求视频 Worker、生产数据库或模型凭据。

定向工程回归可运行 `npm run test:knowledge-product`。需要数据库的验收使用明确、专用、可丢弃的 `TEST_DATABASE_URL`，并按项目规则设置 `TEST_DATABASE_REQUIRED=1`；不能复用业务库，也不能让缺失配置静默跳过后仍声称数据库验收通过。

## 3. 启动一个可操作的合成实例

最快的方式是使用独立演示入口。它每次创建一个新的临时 schema，只写合成资料，退出时删除 schema；必须显式提供一次性数据库，不会使用业务 `DATABASE_URL`。

```sh
export KNOWLEDGE_DEMO_DATABASE_URL='postgresql://localhost:5432/ccl_test_knowledge_demo'
export TEST_DATABASE_REQUIRED=1
npm run dev:knowledge-demo
```

另开终端启动网页：

```sh
npm run dev:knowledge-web
```

演示 API 默认监听 `127.0.0.1:4311`，Web 默认监听 `127.0.0.1:4310`。本地 `local/knowledge-product/demo/connection.json` 提供本次 `baseUrl`、`projectId`、`spaceId` 和 token；该文件含本地连接信息，不进入 Git，也不能复用到其他实例。生产构建预览可运行 `npm run preview -w @commerce/knowledge-web`，默认端口为 4312。

直接启动独立 API 而非演示入口时，至少需要以下配置；下列值只是本地占位示例，不是生产配置：

```sh
export KNOWLEDGE_DATABASE_URL='postgresql://localhost:5432/ccl_test_knowledge_api'
export KNOWLEDGE_API_TOKEN='local-only-change-me-24-chars'
export KNOWLEDGE_API_PROJECT_ID='synthetic-project'
export KNOWLEDGE_API_SPACE_IDS='synthetic-space'
export KNOWLEDGE_API_PRINCIPAL_ID='local-reader'
npm run dev:knowledge-api
```

无 writer grant 时默认是只读装配。研究执行、写者激活、来源权利和用途策略必须分别配置，不能用演示启动证明真实写入、模型研究或生产部署已获授权。

## 4. 初始化客户端并完成第一次调用

以下普通文档示例使用公开包出口。`baseUrl`、`projectId`、`spaceId` 和 token 从当前实例连接信息取得；示例资料是合成文本。先读取实例能力，确认当前实例实际开放的范围：

```ts
import {createKnowledgeClient} from '@commerce/knowledge-client';
import {createDocumentKnowledgeAdapter} from '@commerce/knowledge-document-adapter';

const client = createKnowledgeClient({
  baseUrl: 'http://127.0.0.1:4311',
  scope: {projectId: 'knowledge-synthetic', spaceId: 'synthetic-research'},
  headers: {Authorization: 'Bearer local-only-change-me-24-chars'},
});
const capabilities = await client.capabilities();
console.log(capabilities.data.mode, capabilities.data.permittedActions);
const documents = createDocumentKnowledgeAdapter(client);
```

若使用上面的最小只读 API 配置，只执行 `capabilities`、`catalog`、`query` 和 `receipt`，不要执行下面的来源写入。下面的 `contribute` 仅在带合成 writer grant 的 `dev:knowledge-demo` 演示实例执行；直接 API 的写入首调必须先按实现版本配置 writer authority 和用途策略。

```ts
const source = await documents.contribute({
  externalId: 'onboarding-note', version: '1',
  text: '第一条合成认识。\n\n它只用于验证来源和查询。',
  author: null, publisher: null, acquirer: 'local-demo',
  obtainedAt: new Date().toISOString(),
  rightsPolicyRef: 'synthetic-local-only', expectedSourceHead: null,
  sourceGroups: [], limitations: ['Synthetic demo only'],
}, {idempotencyKey: 'onboarding-note-v1'});

const result = await documents.query({
  question: '合成认识', purpose: 'exploration_reading', limit: 10,
});
const receipt = await client.receipt(result.data.readReceiptId);
console.log(source.data.ref, result.data.items, receipt.data.orderedItems);
```

这段调用完成来源登记、问题查询和读集回执读取。`source.data.ref` 是准确**来源**引用；登记原文并不自动生成或发表一条领域认识，`result.data.items` 也不能仅凭查询返回就解释成“新文档已产生知识”。相同键和相同输入重放返回同一结果；相同键配不同输入会冲突，不能换键掩盖错误。完整的采用、反馈、撤权、未知对账和数据库清理路径可执行于 `apps/knowledge-api/test/source-use.integration.test.ts`，不需要再手写一套接入样例。

另一个[真实公开文档接入样例](https://github.com/cyl19970726/knowledge/blob/main/examples/document-onboarding/README.md)使用当前 `AGENTS.md` 和 Git SHA，逐字验证真实文档的登记与读回，再执行查询、采用、合成反馈、撤权和清理。可重复运行 `npm run test:document-onboarding`；它验证真实公开文档与适配器的工程行为，不把合成任务或反馈当作第二个真实业务的效果。

### 普通文档的最小可核验链

| 交接 | 业务接入者提供 | 从现有接口取得并核对 |
| --- | --- | --- |
| 来源 | 固定文档 ID 与修订、允许托管的原文、作者/发布者、取得者、取得时间、来源组、限制、权利政策；服务端另有对应写者资格和用途政策 | `documents.contribute(..., {idempotencyKey})` 返回准确来源 `ref`；用 `client.source(ref, purpose)` 和 `client.sourceContent(ref, purpose)` 比对外部版本、正文摘要、字节和实际覆盖。参考适配器按段落编号定位托管全文；需要稳定页码或节选时，另按公共来源合同实现适配并标明未覆盖范围 |
| 查询与选择 | 当前项目/空间、获准用途、具体问题；若要记录采用，还须业务任务身份、实际选择及理由 | `documents.query(...)` 返回有界结果和 `readReceiptId`；`client.receipt(id)` 固定本次读集。对返回的**知识**引用再用 `client.document(ref, purpose)` 读准确正文，对来源引用用 `client.sourceContent` 回查；无匹配或读集为空时保留结果，不虚构结论 |
| 使用与反馈 | 实际采用、改编、拒用或暂缓的知识版本、外部任务上下文；之后提供观察、未观察项及测量范围 | `documents.context(...)`、`documents.use(...)` 和 `documents.feedback(...)` 记录可读回的使用与反馈；每次写入保留稳定幂等键，反馈关联对应使用记录。合成反馈只验证记录链，不证明文档判断正确或业务效果 |

最小工程验证是固定一份有权使用的文档，登记后按同一用途准确读回并比对原文与摘要；用一个具体问题检查实际查询范围和读集，对已有且可准确读取的知识作一次有理由的选择，再读回使用和反馈。`examples/document-onboarding` 的公开文档加合成任务可复现软件行为；真实语义研究、独立审阅发表以及真实业务行动仍需另外取证。没有获准写入的实例可先做能力、查询和已有来源的只读核对，不能把只读成功写成来源已登记。

## 5. 分清 API、Worker、Web 与适配器职责

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| knowledge-api | 认证后的项目/空间作用域、公开知识 HTTP 能力、读回执和操作对账入口 | 不因请求正文授予主体、安装、用途或写者权限 |
| knowledge-worker | 在授权、预算和方法配置内执行研究与维护，处理租约、尝试、取消和结果登记 | 不绕开应用层直接改知识 head，不把执行成功当作发表成功 |
| knowledge-web | 探索、正文、来源、历史、研究、采用反馈和返回状态 | 不内置生产知识，不保存 bearer token，不成为第二套业务规则权威 |
| 业务适配器 | 把业务来源、外部任务和反馈映射到公共 client；保存业务外部上下文身份 | 不直接写知识表、伪造审阅票据、复制知识版本权威或继承其他业务范围 |
| 来源所有者端口 | 对准确原件、版本、锚点、范围和用途作当次读取授权 | 不把一次可读当作永久发表租约，不授予采集或经营执行权限 |
| knowledge-service-adapter | 持久化来源、操作、使用和反馈，并连接原知识核心 | 不新建与 `KnowledgeStore` 竞争的版本或发表权威 |

独立 API、Worker 和 Web 的运行变量、端口及授权装配以对应实现版本为准。API 的数据库、项目、空间和 token 配置与 Worker 的研究执行配置分别核对；写能力还需显式 writer authority 和用途策略。Web 只获得用户连接所需的非机密预填值，token 不进入构建产物或浏览器持久存储。真实模型、采集、生产数据库和写者资格不是构建的前置条件，也不是构建成功后的隐含结果。

## 6. 登记来源、版本、锚点、权限与用途

每个来源先回答五组问题：

| 维度 | 接入必须固定什么 | 常见误判 |
| --- | --- | --- |
| 来源身份 | 业务域、原对象、所有者、作者或发布者、取得方式；同源组及分组依据 | 多份报告当成多份独立证据；公开可见当成可任意使用 |
| 准确版本 | 原版本引用、内容摘要、取得时间；当前选择器解析后的准确版本 | 读取时静默换最新版；登记摘要代替实际内容摘要 |
| 定位与覆盖 | 页、段、标题、秒点、字节等适用锚点；实际读取范围与未读部分 | 只读元数据当成正文已读；读一页或一帧当成完整原件 |
| 权限与可读性 | 元数据可见、内容可读、锚点可定位、撤权和重新核验；所有者未连接、禁止、不支持分别表达 | 当次可读当成永久授权；历史可读当成当前权利 |
| 用途 | 阅读、研究、创作执行等经服务政策批准的 purpose，以及必要的市场、语言或业务范围 | 调用者换用途字符串解锁；知识用途批准变成外部行动授权 |

业务原件可以留在业务域，由业务所有者提供显式认证的只读端口；普通文档也可以按托管来源政策登记原文副本。两条路径都必须固定准确版本与锚点。知识服务不跟随调用者提交的任意地址重新抓取，不继承业务平台凭据。

来源更新、撤权和内容纠错通过生命周期交接通知知识服务。外部来源在发表时仍需可证明的权利保证；无法保证跨系统撤权与本地提交原子性时，应拒绝或保留相应限制。托管来源在发表事务内重验版本和权利。来源登记成功不等于知识已审阅、可发表或可产生业务效果。

### 为按需原文回查提供独立有界端口

通用 HTTP owner 必须显式声明 `supportsBoundedContent: true`；CLI 装配对应 `KNOWLEDGE_SOURCE_OWNER_BOUNDED=1`。它只向 `/content-bounded` 发送公共 `BoundedSourceOwnerRequestSchema` 定义的请求，包含 `maxBytes`，不会回退到旧 `/content`。旧手动文本/媒体读取仍使用原入口，有界 Ask 当前只接受文本。

所有者在取正文前核对主体、用途、准确版本、元数据字节数和权限，实际读取也须受限；返回后再次确认权限。HTTP 适配器独立限制 JSON 响应流，即使缺少或谎报 Content-Length 也不能无界下载，再校验准确引用、UTF-8 字节数、内容摘要及读取保证。HTTP 流限额与正文限额口径不同，不能把它们称作数据库磁盘 IO 或全网总流量上限。

来源型引文可用 `sourceDomain` 明确 `source`、`analysis` 或 `evidence`；Wiki 缺省仍为 `source`，旧准确版本不被改写。域标记只解决回查路由，不授予外部来源准入或发表许可。高层发表服务缺少受信任外部准入保证时拒绝该类发表；真实接入还须完成准入/发表保证与用途许可，不能靠写入测试 fixture 证明这些能力。

### 用来源事件连接独立服务

程序装配 `enableSourceIngest: true` 并配置 active writer grant 后，可使用公共 SDK 的 `registerSourceEvent`、`sourceEventLookup`、`sourceEvent`、`recordEntityMentions` 与 `entityMentions`。字段以共享 SourceEvent/EntityMention schema 为准。事件键由生产端稳定保留；登记及提及写入的 Idempotency-Key 分别保持原 eventKey 与 methodVersion。事件登记需要 `ingest:write`，查询需要 `ingest:read`；提及写入还需 `ingest:mentions`，adapter 必须在服务端授权清单内。认证安装 ID 不允许由请求正文替代。

独立 CLI 可用 `KNOWLEDGE_SOURCE_INTAKE_ENABLED=1` 显式启用，并提供已有的可信 writer grant、action/adapter 配置；它不要求同时启用 synthetic research，也不会因此调用模型。`KNOWLEDGE_API_CLIENT_INSTALLATION_ID` 可指定稳定安装身份。原 owner 的有界端口及目的授权仍须独立配置，未配置时明确失败。

生产端复用自己的事务 outbox。消费者先持久意图，再按原键向核心核对或登记，确认准确输入后才推进独立游标。远端已提交但本地确认丢失时保留 pending，下一次核对原键；未知 lookup 不证明此前未提交，安全重投只限本接口同键幂等登记，不适用于付费模型。游标须绑定远端身份和认证 recoveryScope，不能把更换服务/安装后的旧 checkpoint 当成新服务的登记结果。

提及写入只受理调用方已提出的跨度，服务在固定正文限额内回查准确文本、校验字节边界和原字面，再次验权后记录。它不向模型外发材料，也没有提供自动提取质量证明。来源原件不复制到托管来源库；派生提及节选则是知识服务实际保存的资产，受原来源权限约束。

### 接入准确来源规划

显式注入 `SourcePlanner` 后，`POST /source-plans` 以固定键规划一个已登记来源事件；`GET /source-plans/:planId` 和 `/source-plans/lookup` 按原用途只读核对。调用需 `source-plans:write`、`source-plans:read` 与 `ingest:read`；只读入口需后两项。规划读取准确来源元数据与有界全文，要求 UTF-8 摘要和完整覆盖，保存准确读集、来源组、预算与提供方意图。提供方返回的安全 JSON 和已知费用先 checkpoint，再校验 proposal 与实体提及 span；回显完整来源正文的 raw 不留存。提及只属于本次 `model_proposed`、`unresolved` 计划，不写 `caller_proposed` 批次。现有注入式提供方和单测不代表真实模型 transport 或自动消歧。实现见 `packages/knowledge-application/src/source-plan.ts`。

### 接入编纂提供方

程序宿主可为 `createKnowledgeApi` 注入 `compiler: WikiCompiler`，同时明确启用 source intake、active writer 和相应 action。编纂写入需要 `compile:write` 与 `compile:read`；只有请求携带 `sourceEventIds` 时才额外要求 `ingest:read` 及来源 adapter 授权，纯 Wiki 与回答派生路径不因此索取事件读取权。SDK 提供 `compileWiki`、`compilation`、`compilationLookup`。DTO 以共享 WikiCompile schema 为准；写请求保留原幂等 key，读取及核对始终使用原 purpose。

编纂提供方只产生带 evidence ID 的 new/update/no_change/needs_evidence/refused 提案，不能自行提交变化或发表。外部模式须声明可执行的金额上限，宿主再通过 `authorizeCompilerDispatch` 明确核准资料外发；未提供就拒绝调用。本地合成提供方的工程验证不构成真实模型质量或价格证明。通用 `WikiCompiler` 负责生成；逐对关系判断由独立 `DecisionProvider` 应用负责。显式启用的协调器可以把本轮已确认双端判断作为建议送给编纂器。

读取结果区分草稿与正式待审候选：draft_ready 可能缺来源发表保证或 stage 适配器；waiting_for_review 才带 `candidate` receipt，但还不代表审阅已通过、已发表或可用于生产。新的编纂来源使用独立 wiki_compile 审阅识别；候选必须匹配实际 compilation/stageIntent/changeset，旧 synthetic 规则保持独立。不能用构造 changeset 或伪装 synthetic 标识绕过来源准入。

恢复不会再次调用提供方。未知返回后先用原 key lookup；若已存在 stage receipt，服务核验共享 request hash 与实际 changeset，再补齐账本关联。此处是恢复本地记录，不是重新 stage 或发表；没有已存候选时保持原未知/草稿状态。模型提供方本身的请求身份、原始响应及账单对账仍需真实 adapter 配套实现。

### 从回答派生新的研究问题

先从当前有权读取的 `answered` 结果取 `answerFingerprint`，让用户选择 claim 索引并填写新问题、Wiki 页数 `limit`、分页范围和预算。调用 SDK `researchAnswer(answerId, {purpose,expectedAnswerFingerprint,claimIndexes,question,limit,maxPages,budget}, {idempotencyKey})`，对应 `POST /answers/:id/research`。服务需同时声明 `researchAnswer` 写能力与 `compilation` 读能力；请求必须具备 `compile:write`、`compile:read`，不要求调用者创建 API key。旧服务响应没有指纹时禁用此入口。

应用从原回答冻结的**完整实际读集**派生 `selectedRefs` 和 `sourceRefs`，只将所选 claims 作为研究提示；直接准确读取来源，不创建虚假的 `sourceEventIds`。准确引用总数最多 100，`limit` 只约束 Wiki 页数，来源另计。编纂器独立重验当前性、用途、来源权限与预算后才可分发；旧答案的断言不能替代新一轮依据。返回的 `answerOrigin` 记录原问题、原回答指纹和所选索引，编纂 `question` 是新问题。相同键同输入回到原编纂，改输入冲突；丢响应先用 `compilationLookup` 或原 ID 只读核对，不用新键再调提供方。

原回答因 Wiki 换版而不再能从普通 Ask 入口读取时，已发表或拒绝的原编纂仍可按原键、原用途查看历史 origin；历史 Wiki 必须保持完整且经当时用途审阅，来源当前撤权仍拒绝。新键不能借历史资格跳过当前依据检查。实现入口见 `packages/knowledge-application/src/answer-research.ts`、`packages/knowledge-application/src/ask.ts`、`packages/knowledge-application/src/wiki-compile.ts`、`apps/knowledge-api/src/index.ts` 与 `packages/knowledge-client/src/index.ts`。

### 接入维护任务、周期 Lint 与判断端口

宿主显式启用维护能力和 active writer grant，并授予 `maintenance:write` 才可调用 SDK 的 `collectMaintenance`、`lintWiki`、`cancelMaintenance`；`maintenance:read` 用于 `maintenanceTasks`、`maintenanceTask`、`maintenanceFindings`。收集按来源/知识事件流推进独立游标；Lint 按 `cycleKey`、`shardCount`、`shard`、`methodVersion` 与当前页头 UUID 游标推进。对下一页继续使用相同周期与分片输入，检查 collect 的 `hasMore` 或 pass 的 `complete`；不要把每页当成新 SDK 幂等写请求用同一个 header 键重放。HTTP/SDK 的字段与限额以共享 schema 为准。

Lint 只提供七种结构或审阅提示。`findingCount` 是持久累计数，`findingIds` 是至多 1000 个的最近页预览；需要全部发现时按原用途分页读取 `maintenanceFindings`。`startEpoch`、`observedEpoch`、`omittedReasons` 和 `incremental_current_heads` 表明这是变化中的当前页头增量遍历，后加入的较小 key 或期间换版可能未覆盖。新周期重新扫描；不能把一次完成解释为时间点快照或自动矛盾检测。

宿主若要执行维护任务，须另行注入 `MaintenanceProcessor`；默认 Worker 只收集事件并运行元数据 Lint。逐对判断须显式注入 `decisionProvider` 和 active writer grant；调用 `judgeRelation` 需要 `judgments:write` 与 `judgments:read`，`judgment` / `judgmentLookup` 按原用途只读核对。外部提供方还须宿主授权资料外发及可执行的模型/金额预算。结果只是待审提案，不自动发表关系。Jev/OpenAI codec 只处理 wire data 的编码与解码，没有 SDK、网络、密钥或真实模型 transport。

协调器需显式配置 `compiler`、`enableSourceIngest`、`enableMaintenance`、`coordinationPolicy` 与可信 writer grant；来源事件路径另需 `sourcePlanner`。可注入独立 Worker 的 `maintenance.processor`，CLI 默认仍只运行元数据维护。当前协调器受理单一准确来源事件的 `source_research`，也可受理无新来源事件、带准确当前 Wiki `subjectRef` 的 `relation_check`。前者先规划来源，再以 v2 发现有界旧页；后者从准确 Wiki 的标题、身份键和别名发现有界候选。两者最多三次有类型判断，最后将本轮真实读过的双端作为编纂提示。策略将最多五分钟的总期限及金额、模型调用和读取额度分配到固定子步骤，确认回执后累加，不能把未知费用当零。`GET /coordination-runs/:runId`、`GET /coordination-runs/by-task/:taskId` 与 SDK 用于查进度；`POST /maintenance/process-one` 推进一个任务，不把同一写 header 当成下一页。每步原键、请求和预算持久固定，未知时只 lookup，不重新分发提供方。普通任务 reason 不包含私有模型内容；协调详情及计划每次读取都重新核来源资格。实现见 `packages/knowledge-application/src/coordination.ts` 与 `apps/knowledge-api/src/index.ts`。

独立审阅的批准或拒绝在同一事务结束编纂、协调运行和维护任务；两种决定均使任务完成，但 `compilationOutcome` 区分结果。运行中的租约不被抢走，过期 ACK 依据真实发表或拒绝记录核对，旧执行端只收到规范状态元数据。当前 Wiki 的周期语义任务发现与纯 Wiki `relation_check` 已在开发工作树接线；失效旧 Wiki 的 `recompile` 已由同一协调 processor 执行到待审候选，见下文“失效 Wiki 修复”。统一实体消歧、自动挑选答案入维护任务、跨键缓存、无变化提案独立审阅、外部发表保证和完整收件箱仍未完成。

### 失效 Wiki 修复（开发分支候选）

`recompile` 任务的 `subjectRef` 是需要修复的准确当前页 C1。协调 processor 先有界读取 C1：C1 已不是当前版本时任务以 `superseded` 结束；C1 或其关键来源当前不可读、上游 Wiki 仍待修复、或找不到可读输入时以 `needs_evidence` 结束。这三种情况都不调用编纂器。否则 processor 为 C1 的每条关键依赖准备当前输入：仍有效的依赖读取原版本，失效来源读取其可读新版，失效 Wiki 读取其有效当前版本；任务的 `relatedRefs` 按同样规则补充。

编纂请求以 `repairTarget` 携带 C1 的准确引用。C1 进入读集时带 `role:"repair_target"`，只用于修订对照和准确基线，不能出现在 `supportEvidenceIds` 中。`WikiCompiler` 会额外收到 `repairTarget`，其中有失效原因、复核期限和每条依赖是否有效。提案只能修订 C1 一次，并在 `draft.repair` 中为每条关键依赖写明 `keep`、`replace` 或 `remove` 及理由：失效依赖不能保留；替换项必须是本次读过、领域相同的不同版本，并列为新支持；复核期已过时须给出未来日期或写明清除理由。修复不接受 `no_change`，这样的结果记为 `needs_evidence`。stage 按处置重建依赖、引文和导航，不再默认继承旧依赖。

审阅视图的 `changes[].repair` 标明修改前版本只供对照，并列出失效原因与处置。批准时 C1 不必有效，但必须仍是未变化的当前版本，审阅者也须当前能读取其来源；其余新支持仍走原有准入、撤权和并发 head 检查。实现见 `packages/knowledge-application/src/coordination.ts`、`wiki-compile.ts`，以及 `packages/adapters/knowledge-service/src/wiki-compile-stage.ts`、`compilation-review.ts`。

### 接入周期语义扫描与纯 Wiki 关系任务（开发工作树候选）

宿主显式启用 `enableMaintenance`、协调策略、可信 writer grant 与维护 read/write action 后，API 的 `POST /maintenance/semantic-sweeps` 用公共 `SemanticSweepApiRequestSchema` 每次推进一个分片的一页，`GET /maintenance/semantic-sweeps/:passId` 按原 purpose 只读核对。SDK 提供 `runSemanticSweep` 和 `semanticSweep`；字段与 1–100 页限额、1–10000 任务上限以公共 schema 为准。身份、安装、项目、空间、用途与周期/分片/方法版本共同约束 pass；同周期修改 `maxTasksPerShard` 会冲突。`taskCount` 是累计创建数，`taskIds` 只预览最近一页最多 100 个，需按 `maintenanceTasks` 分页看全部任务。到上限时若仍有未扫页头，`limitReached` 为 true 而 `complete` 为 false。游标和任务同事务提交；`incremental_current_heads` 与 epoch/遗漏原因说明它不是时点快照。

程序 Worker 须明确配置 `maintenance.semanticSweep:{cyclePrefix,shardCount,limit,maxTasksPerShard}`，并注入 `kinds` 含 `relation_check` 的 processor；按 UTC 日组成周期命名空间，逐片推进。现有 CLI 默认只装配元数据收集、结构 Lint 与可选搜索投影，不启用该语义扫描，也没有真实提供方。扫描只是元数据任务生产；只有任务处理器执行时，才准确读 `subjectRef` Wiki 正文，从标题/身份键/别名做 v2 词项召回，有界读其他 Wiki，经可选 `DecisionProvider` 至多三组判断，最后让 `WikiCompiler` 用实际选中的准确 `selectedRefs` 编纂。词项未重合的概念关系可能漏召；不足两份已读 Wiki 时留 `needs_evidence`，不能推断无关系。

`WikiCompileRequestSchema` 允许 `sourceEventIds:[]`，条件是 `selectedRefs` 非空、各引用具有 canonical digest；同版本选区去重并受全局读页和字节预算约束。任务保留原键和固定子步骤请求；共同期限至多五分钟，父级模型调用、读量、费用上限约束各步骤。外部模型还须显式 transport、外发授权及可执行预算；缺少这些不会由周期扫描自动补齐。结果只形成待审候选，独立审阅和发表规则不变。当前仅有定向用例，完整回归和真实语义验收待补，见[当前状态](current-state.md)。

### 接入当前页检索投影维护（2026-11-02 本地候选）

API 需显式 `enableMaintenance` 与可信 writer grant；`maintenance:read` 开放 `GET /maintenance/search-index`，`maintenance:write` 开放 `POST /maintenance/search-index`。SDK 对应 `searchProjectionStatus(purpose)` 和 `rebuildSearchProjection({purpose,limit,restart}, writeOpts)`；`limit` 为 1–5000，`restart` 必填。服务从认证上下文确定项目与空间，请求不能指定另一作用域；用途须与认证用途一致。状态包含 `formatVersion`、`ready`、`complete`、`lastObjectId`、`scanned`、`blockedRows` 与 `updatedAt`，尚无空间状态时读取可返回 `null`。一次 POST 只推进一批，不是全库重建的成功承诺；下一批应读取进度并发起新调用，同一个写入 header 键不保证重放同一页。合同与接线见公共 schema (`packages/knowledge-contracts/src/index.ts`)、SDK (`packages/knowledge-client/src/index.ts`)、API 路由 (`apps/knowledge-api/src/index.ts`)和维护应用权限 (`packages/knowledge-application/src/maintenance.ts`)。

Worker 的维护配置可选 `searchProjection:{limit}`；CLI 显式维护模式默认每批 100。投影页头与修订变更在同一数据库事务通过触发器更新；直接修改缓存会使空间失去 `ready` 并清空重建游标。重建在项目锁内分页、清理仅存于缓存的孤儿项，并在标记 `ready` 前核对当前页头覆盖及格式；超大字段导致 `blockedRows>0` 时，修订内容变更后再核对，不应无进展忙转。查询投影路径仍调用原 SQL 评分，未就绪或不适用时整次回退，不能把预筛命中数解释为已获用途许可或来源权利。实现见核心投影 (`packages/knowledge/src/wiki-search-projection.ts`)、检索 SQL (`packages/knowledge/src/store.ts`)与Worker 装配 (`apps/knowledge-worker/src/index.ts`)；操作步骤见[运行说明](operations.md)。

## 7. 查询、研究、采用、反馈与变化

按以下顺序接一条完整使用链，每一步都保留上一步的准确引用：

1. **发现能力与范围。** 读取实例能力、项目/空间、可用用途和写入口限制；不要以静态文档推断该实例已开放全部能力。
2. **查询与阅读。** 提交有界问题，读取相关知识、准确版本、关系、来源路径、分页和遗漏原因。普通查询不隐式采集、收费研究、采用或发表；有界无匹配不等于全库没有知识。
3. **保存读集。** 需要复用本次阅读时，持久化阅读回执，固定实际对象、版本、顺序、范围和当时判断。以后访问仍检查当前权限。
4. **发起研究。** 联读明确旧版发起研究，保留触发问题、预算、读集与结束理由。研究结果是 `candidate`、`no_change` 或 `needs_evidence`；执行受理、研究结果、审阅与发表分别追踪。
5. **候选、审阅与发表。** 普通业务调用者提交候选并请求审阅，不直接发表。独立审阅和唯一发表入口核对准确输入、写者资格、依赖、页头、取消状态和来源证明。
6. **记录使用。** 实际采用、改编、拒用或暂缓时，记录准确知识版本、外部任务身份、用途、理由、条件和改编。只读不自动产生采用，采用不证明已经执行。
7. **记录反馈。** 保存真实观察、未观察项、测量范围、成本和解释，关联原使用记录。反馈不会绕过研究审阅直接改正式知识。
8. **读取变化与维护结果。** 沿原用途查询修订、无变化、待补证及反馈处理关系；新查询使用当前有效版本，历史任务仍按当时准确记录解释。

### 从编纂候选进入独立发表（本地候选）


先读取 `candidateView(candidateId,purpose)` 核对准确修改前后、来源组及 reviewIssues，再以准确 candidateId/contentHash 请求票据。不同获准主体请求同一准确目标会取得同一票据。审阅者使用 `decideReview` 明确理由、决定和 expectedDigest；自审、错用途/摘要、过期head及新增未声明审阅条件都会被拒绝。`sourceReaderIds` 是服务器可信配置，声明注册来源的读者，不能从请求正文或审阅 action 推断权限。

在本地事务来源路径，独立审阅者和原提出者的准确来源资格在发表事务内一并核验。单一事务原子写 review、publication、head、票据及 compilation 终态。故障后保留原键，通过现有 lookup/票据/候选核对；不会重调编纂器。旧票据同键回放仍绑定原用途/摘要并重新核来源权限。

对 published/rejected 的编纂记录，服务使用完整但不必仍为current的历史Wiki资格；关键来源撤权仍拒绝。普通问答/采用仍须当前资格，不能把历史可读误当可采用。实现及合成两轮证据见[持续回执](evidence/wiki-loop-implementation-20261102.md)；真实模型与语义独立性仍待授权材料和实际评估。

## 8. 幂等、撤权、取消与未知结果

所有写操作使用稳定幂等键并保存原始请求摘要。相同键和相同输入返回同一操作结果；相同键配不同输入是冲突。客户端不盲目自动重试。

- 本地合同校验失败属于 `not_committed`，修正后可以形成新的有效请求。
- 请求已发出但响应丢失、响应无法验证或提交状态不明时属于 `unknown`。保留原输入和原键，通过操作 ID 或原键对账；查无记录本身也不是未提交证明。
- 对账完成前锁住同一意图的新提交，不换键重发外部调用。前端可以保留用户输入，但不能把超时显示成失败或成功。
- 取消只是请求。等待执行端确认，已经发生的费用和外部结果保持可见；已取消、取消中、执行成功、候选形成和正式发表是不同状态。
- 来源撤权后，新的读取、使用、反馈重放和变化访问重新检查权利。历史审计记录可以保留，但不能因此继续返回已无权的正文或摘要。
- 无法确定外部是否执行时，保留未知范围、调用账本和对账路径；不能把费用填零，也不能通过取消、换方法或换键清除未知。

用途贯穿反馈、使用关联、操作查询、阅读回执、研究、审阅和取消。对账携带原用途，不能用另一项已获批用途访问旧操作。

## 9. 共享 schema 是唯一接口权威

公开 DTO、运行时校验、合同版本和提交状态由 `@commerce/knowledge-contracts` 统一定义；客户端在发送和接收时校验。业务适配器从该包及其公共类型导入，字段参考和示例从同一版本生成或校验。

不要手写平行 DTO、从 HTTP 示例复制接口、自行放宽必填条件，或在业务侧另造一套 `commitStatus`、研究结果和用途枚举。需要新增字段时，在同一实现变更中更新共享 schema、客户端、服务端校验、适配器和合同测试，并说明兼容策略。旧 `KnowledgeRef` 等存储身份保持原语义，传输 provenance 不构成第二套对象 ID。

Schema 能证明形状与边界，不证明跨字段授权、来源租约、发表 fencing 或认知内容正确；这些仍由应用层、核心与独立审阅负责。

## 10. 普通文档业务端到端接入

以下流程不要求视频、采集平台或媒体 Worker：

1. **选定一组有所有者的文档。** 使用合成资料或有明确授权的隔离副本，记录业务文档 ID、固定修订、摘要、作者/发布者、用途与可读范围。
2. **实现文档来源适配。** 提供固定修订的原文或允许节选，以及稳定页段/标题锚点；不支持全文时明确返回实际节选与未覆盖部分，不伪造完整读取。
3. **登记来源。** 通过 K02 和公共 client 登记准确版本、外部上下文、来源权利和用途；重复提交验证幂等，改变版本则产生新的准确引用。
4. **建立可回答问题。** 选定一个能由文档支持、同时包含条件或反例的问题；保留“直接阅读这些文档”的答案、读取量和成本作为对照。
5. **查询并回查。** 通过 K03–K05 找到相关知识，打开准确正文和来源锚点，核对范围、限制、分页与无匹配语义；返回阅读时恢复原问题和位置。
6. **研究一个变化。** 加入修订文档、反例或新问题，通过 K06–K08 形成候选、无变化或待补证。候选必须经独立审阅与唯一发表；没有把新文档登记成功写成认知研究成功。
7. **记录真实使用。** 通过 K09 记录采用、改编、拒用或暂缓及外部任务；只记录实际发生的选择，保留准确知识版本。
8. **登记反馈并追踪变化。** 通过 K10–K11 保存观察与未观察项，再检查它引起修订、不变还是继续补证。反馈处理不能自动宣称业务效果。
9. **验证撤权和未知。** 撤销一个文档用途后确认正文、使用重放和变化访问被拒绝；模拟写响应丢失，用原键对账，确认没有重复外部动作。
10. **重启复核。** 重启服务后按准确版本找回来源、知识、读集、操作、使用和反馈；核对业务原件未被改写，测试数据按隔离责任清理。

## 11. 验收边界

| 验收层 | 至少要证明 | 不能据此声称 |
| --- | --- | --- |
| 构建与合同 | 独立核心仓的 Node 24、workspaces 和依赖顺序可重建；消费仓另核对 submodule 固定提交；schema/client/adapter 使用同一版本 | 语义质量、真实模型或生产可用 |
| 软件行为 | 准确版本、锚点、权限、用途、幂等、取消、未知对账、唯一发表和重启恢复 | 文档结论正确、业务已接入或已部署 |
| 读者任务 | 新读者能解释依据、条件、未知、版本、变化及返回路径 | 用户已接受视觉或认知价值 |
| 连续两轮 | 第一轮正式综合在第二轮被发现、读取并保留条件地使用，反例能修订后继 | 单次查询、无变化或页面数量证明认知成长 |
| 业务效果 | 业务自己的真实执行、观察和测量支持具体结论 | 采用记录、合成反馈或 API 成功证明经营收益 |

源码合并、本地验证、真实业务来源接通、真实语义研究、生产部署和长期业务效果是不同状态。没有对应证据时必须保留未完成，不用接入手册中的步骤描述代替实际完成记录。
