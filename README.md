# 独立知识产品

本仓实现可独立构建、运行和验证的知识产品：登记来源并保留准确版本，查询知识，记录采用与反馈，维护撤权、权限和幂等边界。普通文档适配器是第二业务接入参考；电商适配器、业务来源 owner 和其他业务运行内容不属于本仓。

## 文档权威

产品、架构、能力、运行、当前状态与维护规则的唯一权威入口是 [docs/knowledge/README.md](docs/knowledge/README.md)。[docs/README.md](docs/README.md) 只负责核心文档导航；根 `docs/catalog.json` 导入同一知识目录，不维护第二份业务文档清单。生成的 HTML 由 `make docs` 构建，不直接编辑。

## 本机开发

使用 `.node-version` 指定的 Node.js 24，Python 依赖见 `pyproject.toml`。

```sh
npm ci
python3 -m pip install '.[docs]'
npm run build
```

常用入口：

```sh
npm run dev:knowledge-api
npm run dev:knowledge-worker
npm run dev:knowledge-web
```

三个进程分别启动，网页配置见 `apps/knowledge-web/`。合成演示使用显式指定的可丢弃数据库：

```sh
KNOWLEDGE_DEMO_DATABASE_URL=postgresql://localhost/ccl_test_knowledge_demo npm run dev:knowledge-demo
```

演示数据只用于工程验证，不代表真实业务知识或效果验收。

## 测试与文档检查

```sh
npm test
npm run test:knowledge-product
make docs
make docs-check
python3 -m unittest tests.test_build_docs -v
```

数据库测试只读取显式 `TEST_DATABASE_URL`，每次创建并销毁独立 schema。必须使用专用、可丢弃的测试数据库，不读取业务 `.env`，也不复用应用数据库。验收时设置 `TEST_DATABASE_REQUIRED=1`，缺少配置会失败而不是静默跳过：

```sh
TEST_DATABASE_URL=postgresql://localhost/ccl_test_knowledge TEST_DATABASE_REQUIRED=1 npm test
```

## 核心边界与发布

- `packages/contracts`：共享基础 primitives。
- `packages/knowledge*`：知识合同、客户端、核心与应用能力。
- `packages/adapters/knowledge-service`：PostgreSQL 服务适配。
- `packages/adapters/knowledge-document`：普通文档接入参考。
- `apps/knowledge-*`：API、Worker 与 Web。

代码合入不等于部署或业务验收。发布时分别记录构建、测试、文档检查、数据库验收和实际部署状态；不得把本地合成验证、工程测试或文档生成描述成真实业务效果。
