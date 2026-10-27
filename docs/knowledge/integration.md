# 新业务技术接入手册

新业务复用的是同一套知识能力，不是复制一套知识权威，也不是继承其他业务的资料与权限。业务所有者继续管理原始资料、平台身份、采集分析和经营动作；知识服务管理登记后的来源引用、知识版本、关系、研究、审阅发表、采用与反馈。

本页给出技术接入顺序。具体字段、错误码和可调用操作以同一源码版本的 `packages/knowledge-contracts/src/index.ts` 及客户端包出口为准；本页不手写第二套 DTO。当前主线、部署和真实语义验收边界见[当前状态](current-state.md)，能力语义见[能力与接入合同](capabilities.md)。

## 1. 准备源码、Node 24 与 workspaces

在仓库根目录工作，使用 `.node-version` 指定的 Node 24.x 和根锁文件。不要在新业务目录另建一套 lockfile，或用业务应用的包管理配置覆盖根 workspaces。

```sh
git submodule update --init --recursive
npm ci
node --version
```

核心仓根 `package.json` 的 workspaces 包含公共合同、客户端、核心、应用层、服务适配器、普通文档适配器，以及独立 API、Worker 和 Web；commerce 适配器只保留在消费仓。共享执行依赖若由 submodule 分发，必须在安装和构建前初始化；若当前源码包没有相应 submodule 映射或内容，先核对分发包完整性，不能把缺少依赖后的局部成功当作全链路可构建。

新业务通常新增一个 workspace 适配器，或把现有适配器作为宿主应用依赖。包名、导出和脚本以该版本 manifest 为准；通过声明的包出口导入，不跨包读取 `src` 内部文件，也不依赖构建目录中的偶然路径。

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

这段调用完成来源登记、问题查询和读集回执读取。相同键和相同输入重放返回同一结果；相同键配不同输入会冲突，不能换键掩盖错误。完整的采用、反馈、撤权、未知对账和数据库清理路径可执行于 `apps/knowledge-api/test/source-use.integration.test.ts`，不需要再手写一套接入样例。

另一个[真实公开文档接入样例](https://github.com/cyl19970726/knowledge/blob/main/examples/document-onboarding/README.md)使用当前 `AGENTS.md` 和 Git SHA，逐字验证真实文档的登记与读回，再执行查询、采用、合成反馈、撤权和清理。可重复运行 `npm run test:document-onboarding`；它验证真实公开文档与适配器的工程行为，不把合成任务或反馈当作第二个真实业务的效果。

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
| 构建与合同 | Node 24、submodule、workspaces 和依赖顺序可重建；schema/client/adapter 使用同一版本 | 语义质量、真实模型或生产可用 |
| 软件行为 | 准确版本、锚点、权限、用途、幂等、取消、未知对账、唯一发表和重启恢复 | 文档结论正确、业务已接入或已部署 |
| 读者任务 | 新读者能解释依据、条件、未知、版本、变化及返回路径 | 用户已接受视觉或认知价值 |
| 连续两轮 | 第一轮正式综合在第二轮被发现、读取并保留条件地使用，反例能修订后继 | 单次查询、无变化或页面数量证明认知成长 |
| 业务效果 | 业务自己的真实执行、观察和测量支持具体结论 | 采用记录、合成反馈或 API 成功证明经营收益 |

源码合并、本地验证、真实业务来源接通、真实语义研究、生产部署和长期业务效果是不同状态。没有对应证据时必须保留未完成，不用接入手册中的步骤描述代替实际完成记录。
