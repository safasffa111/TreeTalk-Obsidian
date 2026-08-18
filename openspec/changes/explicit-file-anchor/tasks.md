# 任务列表：显式文件锚定（原子）

## 1. 锚定领域层

- [x] 1.1 `tree-commands.ts`：`continueNode`/`submitChildDraft` 锚点写入条件改为「对话无任何用户消息」+ 仅 `.md`；抽取 `isMarkdownPath()`；补测试（首条锁定、后续不补写、非 md 拒绝、老对话兼容）
- [x] 1.2 `main.ts` `sendMessage`：pending anchor 优先，`getActiveFile()` 兜底（仅当对话无用户消息）；移除「任意消息可写锚点」路径

## 2. 右键锚定入口

- [x] 2.1 注册 `editor-menu`（正文右键）与 `file-menu`（文件管理器）菜单项「锚定 TreeTalk 对话到此笔记」；仅对 `.md` 且对话无用户消息时可用；无活动对话时先新建对话空间
- [x] 2.2 插件层 `pendingAnchors` + Notice 反馈；持久化仅在首条消息时发生（注：输入区 chip UI 降级为后续项，右键已有 Notice 确认；「pending → 落库单次 revision」原子性由 `tests/domain/anchor-file-path.test.ts` 覆盖）

## 3. 回归与收尾

- [x] 3.1 `npm run check` 全绿（vitest + tsc + eslint + build + regression）
- [x] 3.2 更新 CHANGELOG.md
