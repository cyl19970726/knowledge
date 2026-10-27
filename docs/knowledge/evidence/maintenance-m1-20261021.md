# 认知维护与日报聚合：M1受限交付记录

2026-10-21。此为隔离候选的工程与验收记录，业务权威仍为两份项目Pages。**旧v1链4次、新v2方法验收2次，共6次真实调用均已结算；v2结构化审阅停在受限态，0发表，M1真实纵向链尚未通过。不进入M2、PR或部署。**前述零模型及v1段落保留历史决策；最新事实见文末。

## 首次受限实跑（历史结果，续审结果见后文）

| 项目 | 实际证据 | 判断 |
| --- | --- | --- |
| 来源登记 | 10月20日既有4份报告，2个独立原片组；准确原值、质量/覆盖状态、未解决问题保留 | 受控登记通过；不是今日新采集，也不是4条独立素材 |
| 共享问题研究 | 1次真实Builder返回，29,577ms；conditions字段返回字符串，原严格解析在独立Reviewer前失败 | 已知失败，0项认识发布；任务执行成功回执不等于业务通过 |
| 日报 | 正常research.daily默认发现新研究ledger并聚合；partial归档，0项认识、4份报告/2组、研究缺口 | 部分日报可回看，确定性聚合0模型调用 |
| 调用复用 | 重启host、重新登记/生成manifest、改requestKey后复用同一已知失败终态 | 未重复模型调用；不以换key重做失败研究 |
| 后续代码修复 | 仅将非空conditions字符串无损包成单元素数组；保留原文、引用和严格拒绝其他类型；提示明确完整JSON类型 | synthetic回归通过，未重放实际失败，不构成语义验收 |
| 阅读核验 | 正式DailyResearchWorkbench读取真实归档；1440与390px宽，无水平溢出；来源按钮打开准确analysis ref/result/payload | 受限日报界面核验通过；未验收新认识内容或读者收益 |

真实调用使用修复前候选；冻结代码hash见私有preparation/summary。当前提交增加类型兼容与阅读文案，不能将旧调用算作当前代码的真实通过。没有独立语义审阅结果，没有视频/经营收益或完整每日闭环证明。

## 工程变化

- 原分析直接登记为Case 1.1，探索用途审核；无媒体alias时仍可保留原记录。重新读取准确analysis payload验证投影一致；拒绝伪造投影、生产审批和同输入重复登记。历史Case 2及原片不改。
- 新共享研究入口接入knowledge.compile。外部已处理fingerprint与执行读集/CAS分开；日期、请求key和自己的输出head变化不触发同批重读。持久预约/结果及未知状态保留，不自动清空重跑。
- 初始不足2独立原片组只登记来源；粗精拉属于同原片不凑足2组。增量单来源研究必须实际读到相关旧认识与原Case。Comparison采用稳定unitKey，允许并列/分条件认识；局部依据Collection随实际改变发表，历史旧认识不作为当前活跃依赖。
- 当前可用认识限定为此host成功发表且审核/有效性通过的准确版本；不晋级旧候选、失败对象或错误用途。按发表时间回看截止版本，保留失效/撤回变化，即使已不在当前有效集合。
- 正常research.daily发现新ledger后用同一冻结快照聚合并归档；basis_added、format_only与实质认识变化分开。业务日起点按时区验证；来源组与报告分母分开。历史快照不被当前失效提醒改写。
- Web展示当前认识、今日变化、原始经验/条件/动作、质量覆盖及研究缺口；引用位置和技术错误放核对区，准确原始记录可打开。复核补齐无媒体alias案例的分析入口及失效变化的准确历史版本入口。未审阅草稿不进入认识栏。

主要文件：`apps/shared/src/knowledge-cognition{,-store}.ts`、`knowledge-source-registration.ts`、`cognition-daily-reader.ts`；`packages/contracts/src/cognition-daily.ts`；`packages/knowledge/src/{service,store,schemas}.ts`；`apps/web/src/features/research/CognitionDailyReport.tsx`。正常worker/API/日报合同与消费入口一并接线。

## 首次受限实跑的验证与私有证据

Node24、PG18.6，专用loopback测试库；所有synthetic调用均为本地stub，不能作为真实认识的质量证明。

- 最后格式兼容与来源跳转改动后，定向6项通过：并发/日期/key复用、精确条件无损、真实服务发表/复用、正常默认日报/失效/历史快照链、Web SSR。UI后续微调另2项通过。
- 最终全量测试865项，862通过、0失败、3项opt-in跳过；最终build（包边界、TypeScript、Vite）通过。记录见本树ignored日志。
- 两次早期全量失败分别为PG17客户端与PG18服务不匹配、隔离测试库max_connections35不足；切换PG18工具与自有隔离实例100连接后通过。未改生产配置或跳过测试。
- synthetic整链以四份/四组、两个问题验证两项独立认识，4次stub调用；来源失效后下一日报只保留另一认识并显示失效标题/原因，旧归档hash不变。此组不是本次真实4份/2组资料。
- 构建、边界、TypeScript、文档生成和diff检查均须在提交前通过。浏览器部分报告不依赖调度器；自动日批状态显示不可用是本地预览缺少调度服务的真实边界。

私有目录：`local/cognition-maintenance-m1-20261021/`（Git忽略）。

| 文件 | 用途 |
| --- | --- |
| `live/preparation.json`、`registration.json`、`restoration.json` | 精确原资料与冻结代码/数据核对 |
| `live/model-1-input.json`、`model-1-output.json`、`provider-events.jsonl` | 唯一真实调用与原始已知返回，仅本机留存 |
| `live/research-result.json`、`daily.json`、`snapshot.json`、`summary.json` | 失败业务回执及部分日报准确归档 |
| `live/reader.html`、`reader-desktop.png`、`reader-390.png` | 正式组件静态阅读与受控实际界面截图 |
| `full-test-final.log`、`final-targeted.log`、`final-ui.log`、`final-build.log` | 最终工程验证记录 |

真实run为`00d066dc-ce7b-47ec-99b9-5914c7388786`，task为`43e769a6-007f-48da-9ddf-93cca2ff14b8`；日报`20c98c16-cc29-4e6d-846c-9bb5c81b8d65`，归档SHA256 `ee1c94929c6e4663825dd9f3725493ee9f81f17665a526d150529782b0f71d2e`。原始响应、媒体、凭证均不入Git；文档不存凭证。

## 首次交付时的未完成项（历史状态）

原会话先审本次失败回执、无损格式兼容和实际部分日报，再决定如何在同一已知结果上受控续接独立审阅；不能改key绕过去或称M1通过。真实新增认识、真实增量维持/纠正/来源撤回、完整14份/10组及内容冷读均未完成。代码回归证明局部失效能力，但不替代真实M2验收。

正常job与日报已接入；从每个后台事件/新日报问题自动安排研究的全日编排未完成。没有新ledger的旧部署保留旧日报路径；一旦存在新ledger，即使研究失败、认识为空也走纯聚合，不回退旧日报选材。扩大使用前须由原会话审查这一产品范围；当前线上未更改。失效旧认识如何受控重研究仍需M2验证。已发布报告的原素材发布时间未知时保留未知，登记日不冒充来源发布日。

收尾核对：本会话持有的58741预览和55451隔离PG已停止并等待退出，端口无监听；保留ignored证据与PG目录供审查，不删除生产或旧工作树。

## M1已知候选续审计划（历史计划，已执行）

前述失败、旧job/run和原始返回全部保留。原会话已独立指出候选的具体引用不精确与认知价值缺口；该意见是核查线索，不冒充独立模型Reviewer结论。原生workflow恢复因Builder validation pending及prompt revision变化会重跑，因此采用显式已知输出导入，而非普通submit换key。

| 决策 | 具体边界与验收 | 实施处/状态 |
| --- | --- | --- |
| 已知输出身份 | 绑定旧研究、workflow run/step、已结算真实Builder、原文件和解析数据hash；只无损规范化conditions，不改原句或引用 | 新显式恢复入口；实现中 |
| 预算与未知 | 旧Builder1＋Reviewer1＋必要Repair1＋FinalReviewer1，总上限4，editor0；跨旧新run共享，未知仍阻断 | 研究usage lineage与预约闸；实现中 |
| 重新进入执行 | 新run/job记root与导入task=reused_known_output；旧failed与原文件不变；每次call/发表前检查源/头/active attempt | 复用现有bridge与任务；不改执行器 |
| 内容验收 | Reviewer核分句/通道/准确记录、每步的信息职责和未解疑问、对照差异的选片/创作意义及相关原经验条件；仅按具体issues修订，不强编共同规律或引用全来源 | 待真实Reviewer |
| 消费与复用 | 成功后新manifest/新key指向明确恢复结果而非重研；默认日报显示真实已审认识，旧部分报告准确保留 | 待真实链及必要回归 |
| 正常前半链 | 5b38400仍由手动register/submit衔接；analysis/ingest/topic日批入口未转到新链，不能声称完整自动贯通 | 已确认边界；已知候选过后、M2前补现有触发接线，等原会话最小建议 |

已知候选内容未过前不重Builder、不重拉片、不跑full14、不部署；不扩大测试矩阵，仅验证实际改动。原会话最终审查仍是M1签收条件。

正常入口接线的最小实现边界（本轮已按此接入，验证见后文）：复用现有ingest事件游标、Topic/membership确认及日批/worker tick；ingest改登记准确Case1.1，正常submitBuilds按确认的具体题与准确membership冻结读集，复用cognition submit及knowledge.compile。宽creative目录仅导航，不生成题相关性；缺少确认、单组或读集超限保留原结构和待处理状态。冻结后新事件保持待处理，提交持久化与水位确认采用现有CAS/回执。正常入口不得同时运行旧topic synthesis；旧命令执行能力只为已存在任务保留。首次无认识run的日报也走来源/待处理聚合，不回旧逐题研究。未作自动相关性筛选能力声明。

## 当前续审结果与最小方法合同（待根审，0新增模型许可）

旧Builder1次＋本轮Reviewer/Repair/FinalReviewer3次，合计4次已知请求，预约账本与provider返回已对齐。最终Reviewer拒绝，恢复run `b6abb642-227a-4b57-8f0e-0099a6df7cbc` 保持restricted，0发表；旧run/job/workflow/步骤及原始文件未改。第5次预约在数据库硬闸被拒绝（无provider请求）。正常聚合新partial日报 `02efdddd-0d0a-4d42-8c27-c684830e4665`，归档hash `0c3bb323ff851f4357ba711788f51c2d43ee74f3ebb31c495c82f3ea52093ff0`；旧partial归档hash不变。新manifest/key/opaque range与trigger复用受限子链，0调用。

根会话另行逐条复核确认：顺序中段有真实漏引；所谓漏引一个已存在的原经验编号是Reviewer误审；通道争议来自源记录本身的粒度不闭合，应保守区分字幕与视觉。修订稿有结构对照与原经验提取价值，但不构成新验证；仍维持未发表。不能因自由文本Reviewer拒绝就宣称所有原记录无支持，也不能绕开拒绝直接发表。私有真实回执和根审查文件保留，不入Git。

| 最小调整 | 准确合同与边界 | 本轮验证方式 |
| --- | --- | --- |
| 原知识由程序呈现 | 继续现有sourceProjection、findings.basis、sourceNavigation；精确读原序列、渠道、关系、条件/动作及unknowns，不让模型重抄整段事实；来源本身不升格独立核验 | 纯派生渲染，原记录逐值保留；不改冻结snapshot |
| 模型输出聚焦比较 | 下一方法只维护题内比较、信息职责、未答疑问与选片/创作意义，引用原条件；不新增知识对象或执行器 | 已接入新submit默认v2 workflow；本轮仅synthetic，不再次运行真实Builder/恢复 |
| 结构化审阅问题 | update/finding准确索引＋必须存在的原片段＋类别＋已读scope记录编号＋说明；程序可辨别已引/未知编号/错片段 | 合成verdict测试明确标记；真实free text不冒充新结构输出 |
| 引用补丁 | 指定draft/issue双hash，仅给指定finding增加已存在scope且明确指出的basis；text/conditions和其他findings逐字不变 | 真漏引可形成可审候选；已引误报不得修订，不返回语义passed/发表 |
| 语义边界 | 通道、事实或认识修改仍需独立判断；源内provenance与逐帧supports不闭合不能自动裁决 | 合成通道争议保持semantic_review_required，原4次restricted不变 |

此次v2方法已接入正常workflow，新增helper/渲染与正常入口接线供根会话审最小合同；未授权新的真实方法实跑，未扩大预算。正常入口仍需准确问题读集与事件水位，不用宽creative目录代替题相关性。


## 零模型续工的当前结果

- 正常 `createKnowledgeHost` 的 ingest 先登记准确 Case1.1，再推进事件游标。旧摘要登记仅保留显式 legacy 使用；正常 submitBuilds/tick 走共享 cognition，不并行运行旧 topic synthesis。既有 v1 命令仍可执行；新方法为 `knowledge.cognition.v2`。
- 业务入口由现有 API 创建 candidate Topic、确认具体问题，再确认准确 analysis membership（`user-question-v1` / `user-question-membership-v1`）；宽导航目录不选材。拒绝、候选、选中理由与准确版本都保留在冻结回执；超过20份直接阻断，不截断。这里只提供已确认问题的调度，不声明自动发现问题或相关性能力。
- 正常 coordinator 复用已知研究身份、原队列、worker 和日批。持久回执与事件水位 CAS 同事务；冻结后新事件仍待处理。停用模型、来源不足及已知失败明确记录；真正未知保留未知，不借换key、日期、opaque范围或方法升级重跑。
- 日报首次 freeze 在确定截止时间前完成无模型 ingest。即使没有研究 ledger 或有效认识也聚合准确来源与缺口，不回旧逐题研究；截止时尚未登记的分析保留水位缺口，不把未来登记倒填历史。
- v2 Reviewer输出准确finding索引、唯一原片段、scope记录编号和类别。已引误报/未知编号/错片段进入冲突终态；真漏引只能程序补basis，再独立终审；语义修订只允许指定片段/条件的局部补丁，再独立终审。任何helper均不签发语义通过。Builder的 `records[].value` 与 Reviewer packet 的 `originalRecord` 显式取自同一准确原值，并有深等测试覆盖嵌套依据、来源与条件。
- 正式阅读组件先展示认识、对照与条件；依据按来源合并，原记录与完整JSON逐层默认折叠。原序列、通道及经验按类别展开，0认识仍可回看来源。此前1440/390px截图属于首次实跑版本；此轮仅定向组件验证，不冒充新浏览器核验。

当前定向测试53项全部通过（0跳过），涵盖公开API→正常日批→worker→归档首轮、协调/水位、v2工作流、引用/局部补丁、日报合同/阅读及状态消费；全部为合成fixture/stub、业务模型0。公开入口测试从已有分析但无Case开始，确认3份准确原值登记（含仅登记不入选的拒绝项）、2份具体问题入选、modelDisabled时operation=blocked且scan=success、无旧Case1.0/旧compile、日报归档完成。日志 `local/cognition-maintenance-m1-20261021/zero-phase-targeted-final.log`。构建、边界、类型和文档检查结果以提交收尾记录为准；不重复宣称旧865项是当前版本全量检查。

真实私有续审证据在 `recovery/`：call-2/3/4 input/output、provider-events、workflow/usage、snapshot/daily与summary；`method-classification.json`仅把真实文本交由合成结构化issue核对，不是新模型审阅。下一次真实v2方法验证及其准确资料/问题范围仍须原会话另定；本轮真实4次预算不增加，M1未签收。


零模型续工收尾：`npm run build`（包边界/TypeScript/Vite）通过；曾发现一处直接导入非公开 cognition-types 的包边界错误，改由公开index导出后通过。协调回执最后补齐真实v1/v2方法版本，受影响的协调与公开入口2项再验证通过；未重跑旧全量矩阵。`make docs`、`make docs-check`、diff检查通过。当前正式组件对实际续审snapshot的静态阅读文件为 `recovery/reader.html`；不改归档内容，不新增模型或浏览器验收。本会话55451隔离PG已停止，58741预览此前已关闭；数据与回执留在ignored目录供根审，无生产变更。

## 同题 v2 单次真实方法验收（2026-10-21）

本节覆盖上文“未授权新的真实方法实跑”等历史表述：原会话随后明确授权一次同题、同四份报告/两组原片的 v2 方法验收。沿正常公开 Topic/membership API、ingest/coordinator、knowledge.compile worker、research.daily 执行。正式 Topic `197c9fcc-0fef-4c0f-a9d1-a69eee3a049d` 持久映射原 `packaging-use-structure`；题句及四份准确 Case1.1 版本/指纹与旧 root 一致。隔离候选 commit `7ec642f` 实施旧链四次已结算的入场及每次预约复核、唯一 `evaluation_of`、新链四次硬上限和每次完整模型输入 500KB 前置闸。入场后 run `d6fc216b-c0dd-4d57-ae73-e9aaa34d4e72`、job `19afe6fc-7767-4583-8932-52d5073e8143` 已排队时模型预约仍为0。

真实 Builder 和结构化 Reviewer 各一次、均有已知响应；输入分别 63,336 与 191,344 字节，低于500KB。Reviewer 报告五个问题：末段液体入杯归属、困惑与改向失败的时序、字幕/抽样画面通道、产品呈现顺序的关系记录，以及制作选项的解释。其中最后一个 `fragment` 只在 update 的 `reason`，不在指定 finding 文本，违反结构化 issue 的准确片段合同；程序因此以 `COGNITION_REVIEW_CONFLICT` 停止，没有将其当作可修订问题，也没有调用 Repair/FinalReviewer 或发表。其余问题是需要分别核对的真实线索，不能以该一次协议错误判定 Builder 内容都正确。新链2次与旧链4次共6次已结算；余额2次未使用，不因本记录自动授权重跑。模型账单金额不可得，不能由已结算请求数推出费用。

正常日报 `65421a78-e96e-4508-954a-a9825bb70456` 为 partial，归档哈希 `a7a17c550f0e7805d4597546fc726754e0e2a5fb3d69868318db3ed1b349fc14`；0认识、0发表、4份准确材料/2组原片，保留受限原因和另10份既有分析尚未在本截止进入准确Case的水位缺口。日历/opaque key变化后的正常 `/builds` 不排新任务；直接相同输入 submit 复用原 v2 run，调用数仍6。此结果验证阻断及复用，不证明内容质量或读者收益。

实跑用的 Builder 提示在 `7ec642f` 中未重复 v1 提示里的“add/null key、revise精确key、omit unchanged、Comparison跨两原片组”等格式规则；Builder 本次仍通过严格本地验证，Reviewer冲突直接原因是无效 finding fragment，不能把两者混同。收到根会话提醒时两次真实调用已结束，故保留原始返回与账本，未改提示并重跑；随后仅补齐提示以吻合现有验证规则。这个后续提示改动**没有真实模型验收**。私有原始证据为 `local/cognition-maintenance-m1-20261021/v2-evaluation/` 下 `preparation.json`、`admission.json`、`call-1/2-{input,output}.json`、`provider-events.jsonl`、`execution.json`、`daily.json`、`reuse.json`，均不入Git。当前项目和Pages仍保持七目标范围；M1签收须原会话审查，不借此次受限结果进入M2。

## v2 已知双输出续审的零模型准备（待根审）

根会话授权沿同一受限 run `d6fc216b-c0dd-4d57-ae73-e9aaa34d4e72` 准备显式续审，并规定先交回审查、再决定是否使用剩余至多两次请求。本轮**未提交真实续审任务、未调用模型、未发表认识**。旧 v1 四次及 v2 Builder/Reviewer 两次仍是六次已知结算；旧 run、workflow、原始输入输出和两次使用账本保持原样。

新入口以原 run、workflow/step/attempt、已结算 usage、两组原始字节及 SHA256 锁定已知 Builder 和 Reviewer。在入场与执行前核对方法、配置、输入、输出、费用记录、原来源与认识头；每次新模型预约前再核对已有调用。它经原 `knowledge.compile` 工作流的 `ctx.task` 导入两次已知输出，后续仅允许一次局部 Repair 和一次独立 FinalReviewer，家族硬上限八次；未知、未结算或证据变化阻断。合成临时库已验证入场与篡改反例，真实库没有新 recovery/job。

原 Reviewer 五条意见逐条保留。第五条所指片段仅在 `update.reason` 唯一出现，程序留存原问题和定位证据后机械归位；第四条范围内的 Case3 第7—9条关系记录仅补入第二 finding 的依据，标为尚未复审的引用修补。根会话另指出第六条独立问题：Case4 第1条只是范围说明，评论纠错与步骤分别在已引的第2、3条；其原话、来源指纹与问题哈希另存，不冒充 Reviewer 原意见。语义文字只可逐问题局部修补，原有条件不得更改，机器编号只留在依据，终稿仍须独立审阅。

Reviewer 输入的本地去重验证把四源56条准确原记录各呈现一次，finding 仅按编号索引；来源身份、质量、渠道及每条原值深等不变。旧输入191,344字节，新形态67,641字节，减少64.65%；这是未送模型的体积测量。仅补依据后的候选和六条待修问题的 Repair 预览输入70,041字节，仍未执行。私有回执 `v2-evaluation/compact-verification.json`、`double-preparation.json`、`repair-preview.json` 与四组原始捕获同处 ignored 目录；仓库不存凭证或媒体副本。

本轮定向15项测试全过（包含真实捕获离线回放、唯一定位、六号问题、提交到执行前证据变化、临时库双输出入场与未知/未结算拒绝）。在同一个隔离项目的合成端到端分支，`submitDoubleRecovery`→worker 实际把两个已知输出写为 task，仅触发一次 Repair 与一次独立终审；终审通过后合成认识发表，家族账本恰为8/8已结算，同题换日期/请求键复用且新增0次。此测试从未接触真实 `local-perseek` 的模型或账本；TypeScript 与包边界通过。工程检查不构成真实语义通过。下一步由根会话核对代码及私有准备回执，再决定是否实际提交续审；M1仍未签收，不进入M2、full14或部署。

根会话随后放行剩余至多两次真实请求；首次显式入场在模型前被 `COGNITION_DOUBLE_RECOVERY_SUPPLEMENT_SOURCE_CHANGED` 拒绝。只读诊断确认：第六条根会话问题所附 `evidenceDigest` 与数据库**已发表原始** Case4 投影相同（`d3f0754e…`），而入场代码将它与 `createSourceCaseReading` 后的**规范化**投影比较（`9b212cd7…`）。这是两种投影形态的指纹合同不一致，不能解释为来源实际变化；现有检查仍正确地阻止入场。拒绝后真实库仍为旧家族6/6结算、0新recovery/job、0新模型调用。私有 `double-before.json` 与 `double-source-digest-diagnosis.json` 保存前置哈希和差异；本轮遵照根会话的拒绝即停条件，未修改指纹、换key或再次提交，未运行 Repair/终审/日报。后续需根会话判断该指纹合同如何修正并重新授权入场；当前M1仍未签收。

根会话进一步确认该零调用错误可在同一授权内纠正。保留原回执与拒绝证据，新 `double-preparation-correction.json` 通过准确 Case ref→analysis ref 关联冻结资产，并验证规范化问题读集哈希 `9b212cd7…` 与 v2 执行快照同一来源指纹完全一致；完整已发表投影与冻结资产哈希均为 `d3f0754e…`。仅准备脚本改为生成入场所需的选中投影哈希，host 保护闸未放宽。已有隔离 PG/worker 测试补入根会话第六条意见，验证原始哈希零调用拒绝、选中哈希导入并局部修补、原 conditions 逐值不变，1项通过。

同一受限 v2 run 随后成功入场为恢复 run `3abc85b9-5bde-45f2-b63e-c499c00e7777`，入场0模型；旧 run/workflow/step/usage 哈希未变。真实 Repair 一次，输入70,041字节、已知返回、耗时27,015毫秒、usage已结算。返回六个局部补丁且未给出 `replacementConditions`；其中对第五条 `update.reason` 问题的 `issueHash` 与片段正确，但把原 Reviewer 指定的 `findingIndex:1` 写为0。本地 `COGNITION_REVIEW_LOCAL_PATCH_ISSUE_MISMATCH` 闸因此拒绝整次修订，恢复 run restricted、0发表，FinalReviewer未调用。家族现为7/7已知结算；按根会话“真实调用后拒绝即停”条件，未改返回、未重跑、未用剩余一次、未跑日报。原始 `double-call-1-{input,output}.json`、`double-execution.json` 与简明 `double-stop-summary.json` 均在 ignored 私有目录；此受限结果不构成M1验收。

根会话随后只授权零模型准备，最终一次真实终审仍待冷读放行。现有显式双输出续审增加已知 Repair 收据：绑定该失败 run、workflow/step/attempt、已结算 usage、原输入输出字节哈希，复用先前 Builder/Reviewer 收据；三份已知输出均由同一 `ctx.task` 工作流导入。`update.reason` 的 findingIndex 只作为问题占位：在 issueHash、updateIndex、targetField 与唯一片段均匹配时，将模型所填0机械纠位为原问题的1并单独记账；finding 文本仍严格核索引。根会话另以冻结源记录分别给第一 finding 补 Case4/6、第二 finding 补 Case3/4；后者的标签4.8—14.2秒与操作8.5—30.5秒重叠，故将已知第四补丁的“标签展示后接操作”局部收窄为“包含包装/标签展示与操作呈现；关系记录明确的是操作后进入体验/主张，再接购买号召”。原六补丁、原条件和旧已发表资料不修改，这三处根审修正独立留痕，仍须终审判断。

真实只读 `known-repair-preparation.json` 的拟终审草稿哈希 `20347fd0…`，与根会话独立 `v2-root-proposed-final.json` 深等；`known-repair-preflight.json` 重核旧 run/workflow/step/attempt/usage 哈希及7/7结算，真实库仍0个后继 recovery/job、0新增模型。PG合成端到端把旧Builder、Reviewer、Repair作为task导入，仅终审调用模型桩1次，家族上限8/8、同题换日期/key复用0调用；真实捕获回放验证六补丁、两处basis、一处局部文字与原conditions逐值不变。此处只是可审准备，不表示已提交下一任务或真实终审通过；M1依然未签收。

## 最后一次真实终审、正常日报与复用（2026-10-21）

根会话冷读后明确放行同一四份报告、两来源组、同题的**最后一次** Luna FinalReviewer；其余三个已知角色不重跑，家族上限8。真实入场前 `prepare-known-repair.ts` 再次确认：旧家族7/7已结算、三个已知输出的原始字节及持久化workflow/step/attempt/usage对应、旧证据哈希不变、根会话拟稿深等。随后显式 `submitDoubleRecovery` 仅建后继run/job，0模型；入场记录 `known-final-admission.json`。执行只开放 `reviewer` 一次，输入/输出分别保存在 `known-final-call-1-{input,output}.json`，原Builder、Reviewer、Repair作为同一workflow内的已知task导入。

实际终审耗时18,001毫秒，返回 `passed=true, issues=[]`。run `6954b9cb-3ae5-4231-9a72-a19726ab16c3` 为 `changed`，job `succeeded`，发布了一个当前Comparison认识及其Collection版本头；新增唯一usage为 `siwc:gpt-6-luna:reviewer`，已结算。旧run/workflow/step/attempt/usage哈希在执行前后相同，家族恰好8/8已知结算。费用金额未由provider证实，usage记为unknown，不把已结算误写为已知货币费用。终审理由明确认可准确编号引文、字幕与抽样视觉/主张与证据的区分、未知和未验证制作建议；这只覆盖受控资料，不能代替根会话独立冷读或读者效果验证。

发表文本两个finding依次解释使用疑问/尝试过程和产品信息/购买路径。第一条给末段液体转移补Case4第6条准确依据；第二条补Case3第4条操作记录，保留标签与操作时间重叠，不再声称标签展示结束才开始操作。两条原conditions逐字保留，剂量、功效、促销/购买结果等未知没有被写成结论。真实发布头、文本、basis、conditions及终审原输出可从私有 `known-final-execution.json` 与 `known-final-daily.json` 逐值核对。

正常 `research.daily` 在模型禁用下生成并归档报告 `e5e1e350-29f5-42ad-8c13-18476bd7efd8`，归档hash `5246c211970e959f76bd4b7468787ea4b1ab9de1bdcd511beb8d0217151a0545`；读取4份材料、2原片组、1条当前认识，新增编辑模型调用0。新日期 `2026-10-22` 与新requestKey再次提交同一准确输入，直接复用已发表run，累计usage仍8，0新模型调用。私有 `known-final-{daily,snapshot,reuse,summary}.json` 保留正常入口的回执、发布文本及账本摘要；`known-final-reader.html` 由正式日报组件静态渲染供根会话阅读，不冒充额外浏览器验收。这完成M1受控方法路径的实际发布/日报/复用证据，尚不构成14份完整流程、M2、独立读者收益、经营效果或部署验收；下一步由根会话审查并决定M1签收及后续范围，不自动启动M2/full14/PR/部署。
