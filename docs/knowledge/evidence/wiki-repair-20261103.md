# 失效 Wiki 修复执行验证

2026-11-03 · 本轮在分支 `codex/wiki-recompile-repair` 上接通 Issue #10 的第一组工作：失效 Wiki 的修复执行。所有提供方都是本地确定性夹具，不证明真实模型、语义质量或业务效果。

## 实现的行为

- **修复目标读取。** 新增 `readRepairTarget`、`validateRepairTarget` 与 `currentWikiRef`。失效或到期的当前页可以有界读取，但只用于修订对照和准确基线；读取时仍检查当前来源权限。普通 Ask 和编纂的准入没有放宽。
- **处理器。** 协调 processor 领取 `recompile`。目标不再是当前版本时以 `superseded` 结束；目标或关键来源不可读、上游 Wiki 仍待修复、没有可读输入时以 `needs_evidence` 结束；三者都不调用模型。否则为每条关键依赖准备当前输入，再发起一次带 `repairTarget` 的编纂。解析出的输入只冻结在编纂步骤的请求里。
- **依赖处置。** 提案只能修订目标一次，并为每条关键依赖写明 `keep`、`replace` 或 `remove` 及理由。失效依赖不能保留；替换项必须是本次读过、领域相同的不同版本，且列为新支持；目标本身不能作支持。复核期已过时须给出未来日期或写明清除理由。修复不接受 `no_change`，这类结果记为 `needs_evidence`。
- **stage。** 按处置重建依赖、引文和导航，旧依赖不再默认继承；保留的依赖仍须当前有效。
- **审阅与发表。** 审阅视图通过 `changes[].repair` 标明修改前版本只供对照，并列出失效原因与处置。批准时目标不必有效，但必须仍是未变化的当前版本，审阅者也须当前能读取其来源。自审、撤权、并发 head 和整体回滚沿用原有约束。
- **界面。** 候选预览新增修复说明块，维护收件箱补上 `superseded` 状态的文案。

## 实际验证

- `npm run build` 通过；核心测试 `TEST_DATABASE_REQUIRED=1 npm test` 共 **501 项，通过 501，失败 0，跳过 0**。数据库测试使用一次性 PostgreSQL 17 容器，每个测试独立建删 schema。
- `apps/knowledge-api/test/wiki-repair.integration.test.ts` 走真实 HTTP、PG 和 SDK：A1→A2 使 C1 及其下游 D1 失效；C1 修复成待审候选，D1 因上游未修好以待补证结束且不调用编纂器；审阅视图把 C1 标为只供对照；发表的 C2 依赖 A2，不含 A1 或 C1；C2 发表后 D1 用 C2 替换 C1、保留仍有效的 B，再经审阅发表 D2；下一轮 Ask 读到 C2，从不读 C1。
- 同一测试的负例：保留失效依赖、以目标作支持、处置不完整都在 stage 前失败；`no_change` 记为待补证；针对旧 head 的并行修复在 C2 发表后批准失败，发表数不变，随后拒审也不发表；C2 发表后针对 C1 的旧任务以 `superseded` 结束；撤回来源 B 后 D2 的修复任务以待补证结束，编纂器调用数不变；丢失处理响应后，按任务只读取回协调记录和编纂结果，没有再次分发。
- `packages/knowledge-application/test/wiki-repair-proposal.test.ts` 覆盖处置与复核期规则；`apps/knowledge-web/test/candidate-view.test.tsx` 覆盖修复说明的渲染与转义。

## 仍未完成

- 真实到期页的端到端路径未在 PG 中构造：发表时已过期的候选会被拒绝，因此复核期规则只有单元测试。
- 失效依赖没有后继、又没有其他可读输入时，任务以待补证结束；纯移除型修复需要人工发起。
- CLI Worker 仍不装配 processor；需要显式配置的宿主才会执行修复。
- 独立 `no_change` 审阅、未 stage 草稿重试、实体消歧、外部来源发表保证，以及真实模型、人工金标和业务效果验收，仍按 Issue #10 的后续顺序进行。
