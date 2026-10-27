# 真实公开文档接入样例

这个样例演示一个非视频业务怎样使用普通文档适配器接入知识库。

- **真实输入：**当前仓库公开的 `AGENTS.md`、当前 Git SHA、实际文本摘要和字节数。
- **合成任务：**查询、采用选择、观察者及反馈只用于工程验证。
- **不声称：**第二个真实组织已接入、真人已试读、真实语义研究已完成或业务效果已成立。

在核心仓根目录使用一次性 PostgreSQL 数据库运行：

```sh
export TEST_DATABASE_URL='postgresql://localhost:5432/ccl_test_document_onboarding'
export TEST_DATABASE_REQUIRED=1
npm run test:document-onboarding
```

脚本会完成来源登记、准确原文读取、查询、采用、反馈、幂等重放、撤权和清理。JSON 证据写入被 Git 忽略的 `local/document-onboarding/evidence.json`，不包含 token 或业务私有资料。
