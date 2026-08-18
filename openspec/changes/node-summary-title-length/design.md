# 设计：放宽节点摘要标题的中文硬截断

## Context

`NODE_SUMMARY_SYSTEM_PROMPT` 要求 4～10 个汉字，`cleanNodeSummaryTitle` 再做
代码层硬截断。实测模型偶尔返回 13～20 字标题，12 字硬切产生语义残缺。

## Decisions

### D1: 只放宽截断，不放宽目标

prompt 的「4～10 个汉字」目标保留——标题仍应短；50 字符只是防御性上限，
保证合格的长标题不被切半。

### D2: 不升协议版本

`node-summary:v3` 不变：标题只在节点缺 summary 时生成，存量数据无需重算；
升 v4 只会让修复逻辑（`canRepairLegacySummary` 只认 v1）变复杂，无收益。

## Risks / Trade-offs

- 新旧节点标题风格可能混排（旧 12 字、新最长 50 字）——树状列表可接受。
