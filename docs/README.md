# 独立知识产品文档入口

本目录只提供核心知识产品文档导航。产品目标、架构、能力语义、运行方式、当前状态和维护规则均以[知识产品文档集](knowledge/README.md)为唯一权威来源；根目录不保留电商或其他业务文档清单。

## 阅读入口

- [产品与交互](knowledge/product.md)：为什么需要知识产品，以及人如何查询、采用和反馈。
- [架构与模型](knowledge/architecture.md)：来源、准确版本、读取回执、权限与写入边界。
- [对外能力](knowledge/capabilities.md)：客户端和普通文档适配器可调用的能力及限制。
- [运行与开发](knowledge/operations.md)：本地进程、数据库隔离和故障处理。
- [当前状态](knowledge/current-state.md)：已经实现的工程行为与尚未完成的验收。
- [维护规则](knowledge/maintenance.md)：文档归属、更新和生成方式。
- [迁移与历史保全](knowledge/migration.md)：稳定 ID、原文保全和现行章节去向。

可打开[核心 HTML 阅读器](index.html)连续阅读和搜索，也可使用[知识专属阅读器](knowledge/index.html)。两者都由构建命令生成；原稿和目录维护后运行 `make docs` 与 `make docs-check`，不要直接编辑 HTML。

普通文档接入是本仓保留的第二业务参考。具体业务字段、业务 source owner、commerce adapter 及其业务文档由外部业务仓负责，不纳入核心发布边界。
