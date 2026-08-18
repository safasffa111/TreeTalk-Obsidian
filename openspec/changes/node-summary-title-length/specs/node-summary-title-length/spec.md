# node-summary-title-length 变更

## ADDED Requirements

### Requirement: 中文摘要标题硬截断上限 50
`cleanNodeSummaryTitle` SHALL 把中文标题截断到最长 50 个字符；system prompt 的标题目标 SHALL 保持「4～10 个汉字」（短标题优先）。英文规则不变（2～6 个单词、40 字符截断）。

#### Scenario: 15 字标题完整保留
- **WHEN** 模型返回 15 字标题「旧回答冻结裁剪机制说明补充文字」
- **THEN** 清理后的标题完整保留，不再被截断为 12 字
