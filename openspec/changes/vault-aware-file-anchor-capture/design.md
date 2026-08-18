# 设计：Vault 感知的文件锚点与沉淀路由

## Context

当前 `ConversationFile.anchorFilePath` 只表示当前 Vault 内的相对路径。首次发送已在 tree command 中原子写入路径，但没有来源 Vault 身份和可用于重定位的文件特征。`buildTreeExportPlan()` 根据该路径计算 `<anchorStem>-tree/`，未验证路径是否仍指向原文件。Obsidian 提供 Vault rename 事件和 `TFile.stat.ctime`，可在不修改用户 Markdown 的前提下提供安全的运行时同步和启动后恢复。

## Decisions

### D1：Vault 身份保存在插件目录之外

新增 `VaultIdentityStore`，在 `<vault.configDir>/treetalk-vault-id.json` 保存：

```json
{"version":1,"vaultId":"<uuid>"}
```

该文件不位于插件目录、`data.json` 或 `treetalk-data` 中，因此单独复制插件或会话数据不会复制 Vault 身份。文件已存在但格式非法时 MUST 报错，不得静默生成新 ID。Vault 根目录整体移动时 marker 随 Vault 移动，身份不变。

### D2：已验证锚点使用三个字段

为保持 schema v1 和旧数据兼容，保留 `anchorFilePath`，新增：

```ts
anchorVaultId?: string;
anchorFileCtime?: number;
```

三个字段齐全才是 verified anchor。pending anchor 改为 `{ vaultId, filePath, fileCtime }`。`continueNode`/`submitChildDraft` 在首条用户消息的同一次纯函数调用中同时写入三个字段，只增加一次 revision。路径字段仍只接受 Markdown。

仅有 `anchorFilePath` 的旧会话为 `legacy-unverified`，不得自动归属于当前 Vault，即使当前 Vault 存在相同相对路径。

### D3：文件身份以 Vault UUID 为边界，以 ctime 进行安全重定位

当前路径存在且其 `TFile.stat.ctime` 等于 `anchorFileCtime` 时，锚点有效。路径失效时，仅在 `anchorVaultId === currentVaultId` 的前提下扫描 Markdown 文件：

- 恰有一个文件 ctime 相同：更新为该文件最新路径；
- 没有候选：视为删除或不可恢复；
- 多个候选：视为歧义，拒绝选择。

正文修改不改变路径或创建时间。Vault `rename` 事件是主路径：对精确文件路径及被移动文件夹下的路径做前缀替换；同时更新 pending anchor、打开标签页和未打开的 active/history 会话。ctime 扫描负责插件未运行期间的重命名恢复，并且只在原 Vault 内执行。

### D4：锚点状态是显式领域结果

新增纯领域判定：

```ts
type AnchorStatus =
  | { kind: "none" }
  | { kind: "verified"; filePath: string }
  | { kind: "foreign-vault" }
  | { kind: "legacy-unverified" }
  | { kind: "missing" }
  | { kind: "ambiguous" };
```

沉淀只接受 `none` 或 `verified`：

- `none`：保持旧行为，使用 `treeCaptureFolder`；
- `verified`：使用最新文件路径；
- 其他状态：在任何 `write()` 之前抛出带 code 的错误。

主插件把错误映射为明确 Notice。不得把外来或失效锚点回退到当前 Vault。

### D5：沉淀归组只由已验证锚点最新路径决定

锚定会话的归组根目录始终为：

```text
<anchorDir>/<anchorStem>-tree/
```

每次沉淀仍在该根目录下创建唯一的 `<timestamp>-<conversationTitle>/` 子目录，避免不同会话或重复沉淀互相覆盖。多个会话锚定同一文件时必然共享同一归组根目录；是否已经存在该目录不改变路径计算。未锚定会话继续使用设置中的 `treeCaptureFolder`。

### D6：旧锚点和外来锚点只能显式重新绑定

文件右键菜单在以下状态提供“重新绑定当前 TreeTalk 对话到此笔记”：

- `legacy-unverified`；
- `foreign-vault`；
- `missing` 或 `ambiguous`。

显式重新绑定写入当前 Vault ID、目标文件路径和 ctime，并增加一次 revision。有效的同 Vault 锚点仍不可更改。重新绑定不复制或删除原 Vault 的文件。

### D7：重命名更新使用串行队列和 revision 保存

rename 处理按事件串行。打开会话先更新 store，再通过现有 persistence 保存；未打开会话按 active/history 目录枚举，使用 repository `load/save` 和 expected revision 更新。打开会话 ID 在持久化扫描中跳过，避免双写。单个损坏会话只记录错误，不阻断其他会话。stored/open 的 exact 与 folder 路由 SHALL 仅重写当前 Vault 的完整 verified 三元组：当前路径（stored 同时包括 enumeration 时 observed 路径）必须是 Vault-relative Markdown，Vault ID 必须等于 currentVaultId，ctime 必须存在；rename 不得将 PDF、绝对路径或 traversal 路径升级为 verified。显式选择产生的 pending anchor 保持独立的 remap 语义。

### D8：审计补充的事务与持久化边界

rename 的 stored、open 与 pending 阶段 SHALL 由同一个长生命周期 `AnchorRenameWorkflow` 按事件完整串行，不能让后一个事件插入前一个事件的两个阶段之间。`AnchorRenamer` 的队尾必须在每次 enqueue 后回写为一个可恢复的 Promise，单次 rejection 不得毒化后续事件。

repository `load()` 返回值视为不可变：stored rename 与 closed-session relocation SHALL 使用 `structuredClone` 生成候选、更新 path/revision/updatedAt，并以 load 时观察到的 revision 保存。启动除已打开标签外还 SHALL 枚举 closed active/history；仅 currentVaultId 匹配且 ctime 候选唯一时保存。tree capture 在任何写入前 SHALL 同步同 Vault verified relocation 到 tab store 并 flush 持久化；foreign、legacy、missing 与 ambiguous 保持原对象，由 preflight 以零写入拒绝。

## Risks / Trade-offs

- `ctime` 不是跨文件系统的永久 ID。使用 Vault UUID 限定范围、候选唯一性检查和拒绝猜测，优先保证不写错位置。若外部工具在移动时重建文件并改变 ctime，状态会是 missing，用户需要显式重新绑定。
- rename 时扫描未打开会话有 I/O 成本，但 rename 事件频率低；实现应限制并发并复用 direct-conversation-folder 枚举。
- 旧锚点升级后需要一次显式重新绑定，这是防止复制数据后静默误写的必要代价。

## Migration Path

1. 启动时确保 Vault marker 存在。
2. schema 接受新字段和旧路径-only 数据，不自动填充 Vault ID。
3. 新锚点全部写入 verified 三元组。
4. 旧锚点沉淀时提示重新绑定；用户从目标 Markdown 文件右键完成修复。

## Open Questions

无。默认策略为：不跨 Vault 自动写入，不猜测旧锚点归属。
