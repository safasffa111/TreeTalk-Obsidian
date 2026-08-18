# 提案：放宽节点摘要标题的中文硬截断

## Why

节点摘要（树状列表回溯用的短索引标题）目前把中文标题硬截断到 12 字符。模型
返回 13～20 字的合格标题时会被切成语义不完整的半句话（如「旧回答冻结裁剪机制
说明补」），反而损害树状列表的可读性。

## What Changes

- `cleanNodeSummaryTitle` 的中文硬截断从 12 字符放宽到 50 字符。
- system prompt 目标保持「4～10 个汉字」不变（短标题优先），仅把上限从
  「必要时最多 12 个字符」改为「最长不超过 50 个字符」。
- 英文规则不变（2～6 个单词、40 字符截断）。

## Non-goals

- 不升级 `node-summary:v3` 协议号；已生成的存量摘要不重算（标题只在节点缺失
  summary 时生成一次）。
- 不调整英文标题规则与摘要触发时机。

## Impact

- 修改：`src/domain/node-summary.ts`（1 行 prompt + 1 行截断）、
  `tests/domain/node-summary.test.ts`、`regression/node-summary.node.test.mjs`
