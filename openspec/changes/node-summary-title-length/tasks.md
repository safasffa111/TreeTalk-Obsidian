# 任务列表：放宽节点摘要标题的中文硬截断

- [x] 1.1 `node-summary.ts`：prompt 第 2 条上限 12 → 50；`cleanNodeSummaryTitle` 中文 slice 12 → 50
- [x] 1.2 更新 `tests/domain/node-summary.test.ts` 与 `regression/node-summary.node.test.mjs` 的期望值（15 字标题完整保留）
- [x] 1.3 `npm run check` 全绿
- [x] 1.4 更新 CHANGELOG.md
