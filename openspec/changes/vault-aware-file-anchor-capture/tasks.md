# 任务列表：Vault 感知的文件锚点与沉淀路由

## 1. Vault 身份与领域模型

- [x] 1.1 以 TDD 新增 `VaultIdentityStore`：创建、复用、非法 marker 拒绝；marker 位于 `<configDir>/treetalk-vault-id.json`
- [x] 1.2 扩展 `ConversationFile`/schema：支持 `anchorVaultId`、`anchorFileCtime`，保持路径-only 旧会话可读
- [x] 1.3 扩展 tree commands：首条消息原子写入完整锚点三元组，后续消息不得补写或覆盖；补 RED→GREEN 测试

## 2. 锚点状态与路径解析

- [x] 2.1 新增纯领域锚点状态判定及路径前缀重映射函数，覆盖 none/verified/foreign/legacy/missing/ambiguous
- [x] 2.2 新增 Obsidian 文件目录适配器：按路径读取 Markdown ctime，并按 ctime 查找唯一候选
- [x] 2.3 实现启动/沉淀前重定位：同 Vault 唯一候选更新路径；零候选或多候选拒绝猜测

## 3. Rename 同步与显式重新绑定

- [x] 3.1 注册 Vault rename 事件，串行更新 pending 锚点和全部打开会话
- [x] 3.2 更新未打开 active/history 会话，跳过已打开 conversation ID，使用 repository revision 保存并隔离单会话错误
- [x] 3.3 文件右键支持对 legacy/foreign/missing/ambiguous 锚点显式重新绑定；有效同 Vault 锚点仍冻结

## 4. 沉淀路由和用户反馈

- [x] 4.1 `KnowledgeCaptureService` 在首次 write 前完成锚点状态预检；外来、未验证、缺失和歧义状态保证零写入
- [x] 4.2 保证同一最新锚点路径统一使用 `<anchorDir>/<anchorStem>-tree/` 归组根目录，多个会话和目录预存在场景均有测试
- [x] 4.3 `main.ts` 将锚点错误 code 映射为中文 Notice，不再显示笼统沉淀失败

## 5. 回归与文档

- [x] 5.1 增加路径修改、文件 rename/move、插件停用期间 rename 的唯一 ctime 恢复、删除、同路径异 Vault、旧数据重绑测试
- [x] 5.2 更新 README 和 CHANGELOG，说明 Vault 身份、重新绑定和沉淀目录规则
- [x] 5.3 执行 `openspec validate vault-aware-file-anchor-capture --strict` 与 `npm run check`，记录真实结果
- [x] 5.4 审计补充（严格 RED→GREEN）：以 deferred gate/active counter 证明旧 `AnchorRenamer` 会并发 load；新增 whole-workflow 排队、深冻结 repository load 克隆保存、closed active/history 重定位及 tree capture 持久化重定位测试。
- [x] 5.5 早期独立审计复核（严格 RED→GREEN）：answer/tree 在任何写入前统一 anchor preflight；rename queue 在 operation 内读取最新 open tabs；closed record fresh-load 仅在 observed anchor 三元组仍匹配时合并保存；显式 pending 锚点无法验证时 fail closed 并保留 pending。
- [x] 5.6 最终 reviewer blocker（严格 RED→GREEN）：新增唯一纯领域 Vault-relative Markdown path validator；verified 三元组、重定位、Obsidian 文件索引及 answer/tree capture 全部 fail closed，legacy path-only 继续可读但未验证。
- [x] 5.7 最终 reviewer blocker 补充（严格 RED→GREEN）：`AnchorRenamer` stored/open 的 exact 与 folder 路由复用 `isVaultRelativeMarkdownPath`；只重写 current/observed 均合法的当前 Vault 完整三元组，PDF 等无效路径不得经 Vault rename 升级；pending 保持显式 Markdown 选择后的独立重映射。

### 审计 TDD 证据

- RED：本次依次运行 `npx vitest run tests/knowledge/capture-service-anchor.test.ts`（4 个 answer invalid-anchor case 错误地成功写入）、`npx vitest run tests/domain/anchor-rename-workflow.test.ts`（callback API 前等待 gate 超时）、`npx vitest run tests/domain/stored-anchor-workflow.test.ts`（save 返回 `undefined` 而非 saved/stale）、`npx vitest run tests/domain/anchor-renamer.test.ts`（stale save 仍被计入 update），以及 `npx vitest run tests/domain/first-message-anchor-decision.test.ts`（模块不存在）。
- GREEN：聚焦套件 `npx vitest run tests/knowledge/capture-service-anchor.test.ts tests/domain/anchor-rename-workflow.test.ts tests/domain/anchor-renamer.test.ts tests/domain/stored-anchor-workflow.test.ts tests/domain/first-message-anchor-decision.test.ts` 为 5 files / 47 tests 通过；`openspec validate vault-aware-file-anchor-capture --strict` 通过；`npm run check` 为 108 files / 645 Vitest tests、328 regression tests 通过。
- 最终 reviewer blocker RED：先新增 validator 及 consumer 回归测试后运行 `npx vitest run tests/domain/anchor-path.test.ts tests/domain/anchor-status.test.ts tests/domain/verified-first-message-anchor.test.ts tests/domain/anchor-relocator.test.ts tests/storage/obsidian-anchor-file-index.test.ts tests/knowledge/capture-service-anchor.test.ts`，得到 1 个缺失模块 suite error 与 8 个预期失败：PDF/绝对/`..` 完整三元组错误成为 verified、非 Markdown TFile 被索引、relocator 未跳过 PDF、answer/tree verified PDF 在首次 write 前未拒绝。
- 最终 reviewer blocker GREEN：实现后运行 `npx vitest run tests/domain/anchor-path.test.ts tests/domain/schema-vault-anchor.test.ts tests/domain/anchor-status.test.ts tests/domain/tree-commands-vault-anchor.test.ts tests/domain/verified-first-message-anchor.test.ts tests/domain/anchor-relocator.test.ts tests/storage/obsidian-anchor-file-index.test.ts tests/knowledge/capture-service-anchor.test.ts`，8 files / 76 tests 通过；`openspec validate vault-aware-file-anchor-capture --strict` 通过；`npm run check` 通过（109 Vitest files / 666 tests，TypeScript、ESLint、production build、328 regression tests 均通过）。
- reviewer rename blocker RED：先添加 stored/open `attachments/scan.pdf` → `attachments/scan.md` 与 folder route 回归测试，再运行 `npx vitest run tests/domain/anchor-rename-workflow.test.ts`；2 个新断言按预期失败，旧实现各调用一次 `saveStored` 并准备将 PDF 路径改为 Markdown/新 folder 路径。
- reviewer rename blocker GREEN：实现后运行 `npx vitest run tests/domain/anchor-renamer.test.ts tests/domain/anchor-rename-workflow.test.ts`，2 files / 23 tests 通过；PDF stored/open 保持原路径和 revision，`saveStored` 未调用，folder route 同样不升级无效路径。最终 `openspec validate vault-aware-file-anchor-capture --strict` 通过；`npm run check` 通过（109 Vitest files / 668 tests，TypeScript、ESLint、production build、328 regression tests 均通过）。
