# Commerce Creative Lab

面向 TikTok 电商的素材、广告和证据研究工作台。当前以 Perseek NAD+ 为业务项目，连接 FastMoss、Redfox、TikHub 的既有批次数据，以及甲方提供的参考原片。

正式环境已部署到 Mac mini，媒体与完整证据保存在 Cloudflare R2。[当前实现与运行状态](docs/implementation/current-state.md)集中记录部署版本、私有访问入口、能力与历史验收；下方命令用于本机开发。

## 从这里阅读

完整的产品、架构与数据说明均在 `docs/`。打开 [HTML 阅读报告](docs/index.html)，可搜索全文、切换章节、查看交互图或打印；[Markdown 总入口](docs/README.md)用于维护原稿。继续使用本仓库，拉片方法按已确认方向迁入本仓独立维护；通用agent-workflow复用另见仓库边界，当前仍为建议。

| 想了解什么 | 文档 |
| --- | --- |
| 六阶段交付与当前进度 | [阶段计划](docs/product/roadmap.md) · [本地实施](docs/implementation/phase-1.md) |
| 完整产品与技术设计 | [产品总纲](docs/product/overview.md) · [总体架构](docs/architecture/overview.md) · [Worker](docs/architecture/workers.md) |
| 我们现在有什么、哪些没做 | [产品现状](docs/implementation/current-state.md) |
| 三个平台各自已用/未用能力 | [能力矩阵](docs/reference/provider-capabilities.md) |
| 数据现在怎么采、哪些没覆盖 | [采集流程与缺口](docs/architecture/modules/discovery.md) |
| 代码和运行方式 | [当前架构](docs/implementation/current-state.md) |
| 本地密钥和加载方式 | [环境配置](docs/operations/local-development.md) |
| 原片、帖子、广告、商品怎样区分 | [数据与证据口径](docs/reference/evidence-and-metrics.md) |
| 哪些源代码被保留、依赖什么 | [实现清单](implementation-manifest.json) |
| 可交互的现状图 | [图表索引](docs/diagrams/README.md) |

独立知识产品从[专属文档入口](docs/knowledge/README.md)开始，M0–M3 本地工程候选见[唯一实现回执](docs/knowledge/evidence/standalone-product-20261026.md)。使用可丢弃的本地测试数据库并显式设置 `KNOWLEDGE_DEMO_DATABASE_URL` 后，分别运行 `npm run dev:knowledge-demo` 与 `npm run dev:knowledge-web`；知识网页在 `http://127.0.0.1:4310`。演示内容是合成数据，不代表真实业务知识。

## 本机开发

Node.js 24.21.0（支持 24.x），Docker 运行中。只启动本项目隔离的开发服务与本地 PostgreSQL，不连接 Mac mini 的业务库。

```sh
npm ci
npm run setup:local
npm run infra:up
npm run dev
```

打开 `http://127.0.0.1:5174`。这是开发实例；R2 模式下开发入口也可能启动 Worker。不要把它当作连接主站生产库的方式。测试库必须通过显式 `TEST_DATABASE_URL` 指定，并与历史、主站数据库隔离。环境和测试规则见[本地开发](docs/operations/local-development.md)。

## 旧工作台

Python 3.10+。可运行界面与本地查看器仅用Python标准库，不需要API密钥。原历史工具可能需要各自的媒体工具和数据依赖。

```sh
python3 scripts/serve.py
```

打开 `http://127.0.0.1:8765/`。默认是**合成演示数据**，只用来验证界面，不代表真实素材表现，也不会发起采集或生成任务。

已持有原研究资料时：

```sh
python3 scripts/serve.py --local-data /absolute/path/to/研究执行/内容工作台/data.json
```

此模式只读本地快照，并映射其中已有的本地媒体引用；不复制客户原片，不回写原始数据，也不向GitHub上传。原页面与新localhost页面的收藏/笔记分属浏览器不同来源，不自动迁移。远程媒体链接失效时仍需回源核查。

采集脚本通过统一入口加载仓库根目录的 `.env`；工作台网页不读取密钥。配置与检查方法见[环境配置](docs/operations/local-development.md)。安装项目依赖后可运行完整检查：

```sh
make check
```

## 仓库边界

- `apps/workbench/`：现有网页界面与交互。
- `apps/web/`、`apps/api/`、`apps/worker/`、`apps/shared/`：新版 TS 界面、API、唯一任务 Worker 与连接/基础设施装配；Worker 执行 `asset.verify`，并在分析执行启用时执行 `analysis.execute`。
- `packages/contracts/`、`packages/assets/`、`packages/runtime/`、`packages/adapters/storage/`：公共 v1 schema、素材/对象版本与旧表桥接、PG 持久任务和私有 R2 读写/校验适配器。
- `packages/domain/`：旧 TS 工作台仍在使用的兼容领域类型与选材逻辑；迁移期间保留，不是新版公共合同包。
- `scripts/migration/`、`scripts/acquisition/`：先小样后全量的导入、媒体核验、有界三平台发现与候选整理；原始响应和报告保存在被忽略的本地目录。
- `infra/`、`scripts/runtime/`：本地 PostgreSQL、R2配置/本地S3测试存储与启动工具。
- `scripts/serve.py`：本轮增加的便携查看入口，支持演示或指定本地快照。
- `scripts/run_pipeline.py`：手动运行历史脚本的统一入口，先加载本地 `.env`，也支持只检查配置。
- `pipeline/legacy/研究执行/`：既有采集、构建、市场复算、报告和证据工具。保留历史路径布局；部分凭据入口改成环境变量。**新clone缺少原始私有证据时，不能重建真实420条快照。**
- `examples/`：明确标记的合成数据。
- `docs/`：产品与架构原稿、数据口径、交互图、规格及生成的 HTML 报告。运行 `make docs` 重建、`make docs-check` 检查；依赖和分享方式见[维护说明](docs/maintenance.md)。
- `.archify/`：历史图表生成与验收档案；读者所需的图和规格已归到 `docs/diagrams/`。

原始API响应、真实数据快照、客户视频/聊天、密钥、个人笔记不进入Git。仓库不提供客户原片的再发布授权。

## 保持业务与软件边界

[七目标与验收范围](https://chatgpt.com/space/page_d2cb3d9f4fc8819188ac80363db3f30d)和[持续认知Page](https://chatgpt.com/space/page_35e0d83c4f14819180a5b50a5995a1d4)仍是项目的权威文档。这里整理软件实现，不把已有界面等同于完成经营测试，也不把未来分析或创作设想画成现有功能。
