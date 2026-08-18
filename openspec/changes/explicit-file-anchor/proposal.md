# 提案：显式文件锚定（原子）

## 问题

**锚定不可控**：`anchorFilePath` 只能在发首条消息时由 `getActiveFile()` 隐式决定，用户无法显式选择锚定哪个文件；且实现有缺陷——任意后续消息都可能补写锚点、不筛 `.md`、PDF/Canvas 也会被当成锚点。锚定会话的对话树沉淀目录需要跟随锚点文件（`<笔记名>-tree/`），而不是固定的 `treeCaptureFolder`。

## 目标

1. 用户可以在**编辑器正文右键**和**文件管理器右键**中发起/锚定 TreeTalk 对话：右键笔记 →「锚定 TreeTalk 对话到此笔记」→ 发首条消息时，锚点在同一次 tree command 中原子落库（一次校验、一次 revision、一次持久化）。
2. 锚点语义收紧：仅 `.md` 可为锚；仅在对话尚无用户消息时写入；一次决定后不再变更；无锚对话永久回退 `treeCaptureFolder`。

## Non-goals

- 不引入异步锁库，原子性依赖现有 revision 机制。
- 不做锚点 chip 选择器弹窗（右键 + Notice 确认为第一版入口）。
- 不改动 provider 配置（由独立的 provider-catalog 变更解决）。

## Impact

- 修改：`src/domain/tree-commands.ts`（锚点写入条件收紧 + pending anchor 输入）、
  `src/main.ts`（右键菜单注册、sendMessage 锚点来源优先级）
- 新增：`tests/domain/anchor-file-path.test.ts`
