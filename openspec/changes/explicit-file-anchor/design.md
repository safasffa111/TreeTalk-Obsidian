# 设计：显式文件锚定（原子）

## Context

- 锚点字段 `anchorFilePath` 已存在于 `ConversationFile`，沉淀目录派生逻辑（`buildTreeExportPlan`）已工作。
- 会话写入已有原子保障：tree command 是纯函数（clone → 变更 → `parseConversation` 校验），持久化走 checksum + tmp 文件 + revision 冲突检测。

## Decisions

### D1: pending anchor 放在 conversation 外、UI 层

锚点未落库前保存在插件层的 `pendingAnchorByTab: Map<tabId, string>`，不进 `ConversationFile`。理由：conversation 是 canonical 数据，加临时字段会污染 schema、参与 checksum、增加回滚复杂度。落库发生在首条消息的 tree command 内——`continueNode`/`submitChildDraft` 的输入增加可选 `anchorFilePath`，与消息 append 在同一个纯函数调用里完成，天然原子。

### D2: 锚点写入条件收紧为「对话无任何用户消息」

现有条件是 `anchorFilePath 为空`（导致后续消息可补写）。改为对话无任何用户消息时才接受写入；`isMarkdownPath` 以 `.md`（大小写不敏感）结尾。锚点一旦写入即冻结（含"显式锚定"与"隐式当前文件"两种来源），对话中途换文件不再影响。`revertTreeCommand` 撤销首条消息时不撤锚点（锚点代表"对话的归属"）。

### D3: 右键菜单通过 obsidian Plugin API 注册

- `editor-menu`：主编辑区正文右键，`ctx.file` 为当前 md 文件。
- `file-menu`：文件管理器/标签页右键。
- 菜单项：「锚定 TreeTalk 对话到此笔记」（当前对话无用户消息且 file 是 .md 时可用）。点击 → 写 `pendingAnchorByTab` → Notice 确认。
- 新对话场景（右键时无活动对话或活动对话已有消息）：自动 `createConversationTab()` 后锚定。

## Risks / Trade-offs

- **右键菜单在非 md 文件（PDF）上**：`file instanceof TFile && extension === "md"` 过滤，PDF/Canvas 不显示菜单项。
- **数据迁移**：已存在的 `anchorFilePath` 数据不变；只是写入路径收紧，老对话读取完全兼容。
