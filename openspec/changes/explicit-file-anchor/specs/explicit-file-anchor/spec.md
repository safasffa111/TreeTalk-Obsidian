# explicit-file-anchor 变更

## ADDED Requirements

### Requirement: 锚点仅可显式或首条消息隐式确定一次
系统 SHALL 仅在对话尚不存在任何用户消息时写入 `anchorFilePath`。锚点来源优先级为：显式右键锚定（pending anchor）> 发送时的活动 `.md` 文件。一旦写入，后续任何操作 MUST NOT 修改或清除锚点。

#### Scenario: 右键锚定后发送首条消息
- **WHEN** 用户在笔记正文右键选择「锚定 TreeTalk 对话到此笔记」，随后发送首条消息
- **THEN** 该消息所在 tree command 在同一 revision 内写入 `anchorFilePath`，对话树沉淀目录为 `<笔记名>-tree/`

#### Scenario: 后续消息不能补写锚点
- **WHEN** 对话首条消息发出时没有任何锚点来源（无 pending、无活动 md 文件）
- **THEN** 之后任何消息发送都不得写入 `anchorFilePath`，沉淀回退到设置的 `treeCaptureFolder`

#### Scenario: 非 Markdown 文件不能成为锚点
- **WHEN** 锚点来源路径不以 `.md` 结尾（大小写不敏感）
- **THEN** 系统拒绝写入锚点，右键菜单项不显示

### Requirement: 锚定是原子操作
pending anchor MUST NOT 进入 canonical 会话数据；`anchorFilePath` MUST 与首条用户消息在同一次 `continueNode`/`submitChildDraft` 调用中落库，经 `parseConversation` 校验并只递增一次 revision。

#### Scenario: 首条消息落锚与消息原子提交
- **WHEN** 带有 pending anchor 的首条消息被提交
- **THEN** 结果会话同时包含新消息与锚点，revision 恰好 +1，任何中间状态不可被其他观察者看到
