# 冷读者与合成实例接入验收

2026-10-27 · 本记录只证明文档可理解性和普通文档参考接入的工程行为。AI 冷读不是真人试读，合成实例不是第二个真实业务接入，也不证明认知或经营效果。

## 冷读者任务

未参与撰写的 AI 读者只读取 `README.md`、`product.md`、`model.md`、`architecture.md`、`capabilities.md`、`integration.md`、`operations.md`、`current-state.md`、`ownership.md` 和 `maintenance.md`，不读取聊天、源码、外部记忆或参考答案。

| 任务 | 初测结果 | 主要发现 |
| --- | --- | --- |
| 产品目标、非目标和完整反馈闭环 | 通过 | 能解释旧认识如何参与新判断，以及候选、不变、待补证、采用和反馈的边界 |
| 历史复盘、当前用途和来源权利 | 通过 | 能区分历史准确版本、当前有效版本和撤权后的新读取 |
| 当前交付状态 | 通过但发现过时描述 | 原文仍停留在 PR68 和本地迁移阶段，没有反映公开核心仓和 PR69 已合并 |
| 普通文档技术接入 | 部分通过 | 能复述构建和职责，但缺少启动实例、初始化客户端及第一次调用的可执行说明 |

没有发现把 AI 或合成验证写成真人或业务验收的情况。需要修正的是状态时效和接入可执行性，而不是产品目标本身。

## 文档修正

- `current-state.md` 更新为公开核心仓 `eecf30e`、commerce PR69 合并提交 `1b96c6d`、PR68 已合并以及双仓 Verify 通过。
- 明确普通文档操作使用合成资料：它证明参考接入的软件行为，不是第二个真实业务已接入或经营效果成立。
- `integration.md` 新增合成实例启动、独立 API 配置、公开客户端初始化及第一次来源登记、查询和读集回执调用。
- `operations.md` 将独立源码和 PR68 状态更新到当前合并边界。

## 合成实例实测

使用一次性 PostgreSQL 容器和独立 worktree，依次执行：

1. `npm ci`。
2. `KNOWLEDGE_DEMO_DATABASE_URL=... npm run dev:knowledge-demo`。
3. `npm run dev:knowledge-web`，确认 `127.0.0.1:4310` 可访问。
4. `npm run build:knowledge-foundation && npm run build:knowledge-web`，确认公开包出口可用。
5. 通过 `@commerce/knowledge-client` 和 `@commerce/knowledge-document-adapter` 登记合成文档、执行问题查询并读取读集回执。

首次客户端调用在未构建时出现 `dist/index.js` 不存在，随后按文档的依赖顺序构建并重试成功。这验证了先构建再调用的必要性，没有把失败步骤省略。

最终返回：

```json
{"sourceDomain":"source","queryItems":10,"receiptItems":10,"readReceiptResolved":true}
```

演示 API、Web 和一次性数据库均在验收后停止或删除。未使用业务 `.env`、生产数据库、真实客户资料或付费模型。

## 修正后复核

同一读者复核确认：核心仓公开、PR68/69 合并与生产/数据库未切分的状态一致；合成资料与真实业务边界清楚；演示写入首调可执行；直接 API 的最小只读配置只执行 `capabilities`、`catalog`、`query` 和 `receipt`，不会把只读实例误用于 `contribute` 写入。最终复核结果为通过，但仍只限文档口径与上述合成工程范围。

## 仍未验证

- 真人新读者能否理解并正确使用产品。
- 第二个真实业务能否在自有资料、权限和运行环境中完成接入。
- 真实语义研究能否形成有效增量，以及长期认知与业务效果。
