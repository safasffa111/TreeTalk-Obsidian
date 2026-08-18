# TDD 证据记录：vault-aware-file-anchor-capture

本文件按 OpenSpec 任务逐项记录 RED→GREEN 命令与精简观察结果。
命令遵循 `npx vitest run <path>`（vitest 默认 reporter），便于精确聚焦每个测试文件。

## 总览
- 起始 baseline：`npx vitest run` → Test Files 95 passed (95), Tests 540 passed (540)。
- 每个 cycle 都在 commit 之前以真实命令验证。

## Cycle 记录

### Task 1.1 VaultIdentityStore — RED
- 命令：`npx vitest run tests/storage/vault-identity-store.test.ts`
- 观察：`Cannot find module '../../src/storage/vault-identity-store'`，测试集合加载失败（0 test）。符合 RED。

### Task 1.1 VaultIdentityStore — GREEN
- 命令：`npx vitest run tests/storage/vault-identity-store.test.ts`
- 观察：Test Files 1 passed (1)，Tests 7 passed (7)。覆盖创建、复用、非法 marker、版本号、UUID 校验、路径外置、斜杠规范化。

### Task 1.2 schema 扩展 anchorVaultId/anchorFileCtime — RED
- 命令：`npx vitest run tests/domain/schema-vault-anchor.test.ts`
- 观察：Tests 4 failed | 1 passed (5)，schema 尚未解析/校验新字段（仅遗留 anchorFilePath 路径可读）。符合 RED。

### Task 1.2 schema 扩展 — GREEN
- 命令：`npx vitest run tests/domain/schema-vault-anchor.test.ts tests/domain/anchor-file-path.test.ts`
- 观察：Test Files 2 passed (2)，Tests 13 passed (13)。新字段全部解析并校验通过，旧路径-only 数据兼容。

### Task 1.3 tree commands 原子三元组写入 — RED
- 命令：`npx vitest run tests/domain/tree-commands-vault-anchor.test.ts`
- 观察：Tests 5 failed | 3 passed (8)，领域层尚未写入 anchorVaultId/anchorFileCtime，负 ctime 也被接受。符合 RED。

### Task 1.3 tree commands — GREEN
- 命令：`npx vitest run tests/domain/tree-commands-vault-anchor.test.ts tests/domain/anchor-file-path.test.ts tests/domain/schema-vault-anchor.test.ts`
- 观察：Test Files 3 passed (3)，Tests 21 passed (21)。三元组原子写入、legacy 路径-only 兼容、缺字段/非法 ctime/非 md 全部拒绝、后续消息不覆盖。

### Task 1.* 全量回归 — GREEN
- 命令：`npx vitest run`
- 观察：Test Files 98 passed (98)，Tests 560 passed (560)。无回归。

### Task 2.1 锚点状态纯领域判定 — RED
- 命令：`npx vitest run tests/domain/anchor-status.test.ts`
- 观察：`Cannot find module '../../src/domain/anchor-status'`，测试集合加载失败（0 test）。符合 RED。

### Task 2.1 锚点状态 — GREEN
- 命令：`npx vitest run tests/domain/anchor-status.test.ts`
- 观察：Tests 19 passed (19)。覆盖 none/verified/foreign/legacy/missing/ambiguous + 路径回写 + 前缀重映射。

### Task 2.* 阶段性回归 — GREEN
- 命令：`npx vitest run`
- 观察：Test Files 99 passed (99)，Tests 579 passed (579)。无回归。

### Task 2.2 Obsidian 锚点文件目录适配器 — RED
- 命令：`npx vitest run tests/storage/obsidian-anchor-file-index.test.ts`
- 观察：`Cannot find module '../../src/storage/obsidian-anchor-file-index'`，测试集合加载失败（0 test）。符合 RED。

### Task 2.2 适配器 — GREEN
- 命令：`npx vitest run tests/storage/obsidian-anchor-file-index.test.ts`
- 观察：Tests 3 passed (3)。覆盖路径解析、ctime 读取、按 ctime 扫描候选（0/1/多）。

### Task 2.* 全量回归 — GREEN
- 命令：`npx vitest run`
- 观察：Test Files 100 passed (100)，Tests 582 passed (582)。无回归。

### Task 2.3 启动/沉淀前锚点重定位 — RED
- 命令：`npx vitest run tests/domain/anchor-relocator.test.ts`
- 观察：`Cannot find module '../../src/domain/anchor-relocator'`，测试集合加载失败（0 test）。符合 RED。

### Task 2.3 重定位 — GREEN
- 命令：`npx vitest run tests/domain/anchor-relocator.test.ts`
- 观察：Tests 6 passed (6)。覆盖 unchanged/relocated/ambiguous/missing/skipped + 当前路径 ctime 不匹配回退到 ctime 唯一候选。

### Task 2.* 全量回归 — GREEN
- 命令：`npx vitest run`
- 观察：Test Files 101 passed (101)，Tests 588 passed (588)。无回归。

### Task 3.1/3.2 Vault rename 串行处理与 pending 锚点 — RED
- 命令：`npx vitest run tests/domain/anchor-renamer.test.ts`
- 观察：`Cannot find module '../../src/domain/anchor-renamer'`，测试集合加载失败（0 test）。符合 RED。

### Task 3.1/3.2 Vault rename 串行处理与 pending 锚点 — GREEN
- 命令：`npx vitest run tests/domain/anchor-renamer.test.ts`
- 观察：Tests 14 passed (14)。覆盖精确改名、前缀移动、跳过已打开会话、单条损坏隔离、打开会话内存同步、pending 锚点按精确/前缀 remap、串行队列保证。

### Task 3.* 阶段性回归 — GREEN
- 命令：`npx vitest run`
- 观察：Test Files 102 passed (102)，Tests 602 passed (602)。无回归。

### Task 4.1/4.2 锚点预检与确定性归组 — RED
- 命令：`npx vitest run tests/knowledge/capture-service-anchor.test.ts`
- 观察：Tests 5 failed | 3 passed (8)，沉淀服务尚未接入 anchorStatusResolver，外来/缺失/歧义仍走 treeCaptureFolder 旧路径。符合 RED。

### Task 4.1/4.2 沉淀预检与归组 — GREEN
- 命令：`npx vitest run tests/knowledge/capture-service-anchor.test.ts`
- 观察：Tests 8 passed (8)。覆盖 verified 归组根目录、改名后归组根目录、外来/缺失/歧义/legacy 全部零写入、none 旧行为、多会话共享同一根目录。

### Task 4.3 锚点错误 Notice 映射 — RED
- 命令：`npx vitest run tests/knowledge/anchor-notice-mapping.test.ts`
- 观察：`TypeError: mapAnchorCaptureErrorToNotice is not a function`，5 个测试全部失败。符合 RED。

### Task 4.3 Notice 映射 — GREEN
- 命令：`npx vitest run tests/knowledge/anchor-notice-mapping.test.ts`
- 观察：Tests 5 passed (5)。`main.ts` 的 `captureKnowledge` 改为调用此纯函数，code 缺失时回退到通用沉淀失败文案。

### Task 5.1 启动时 Vault marker 使用 TDD — RED/GREEN
- 命令：`npx vitest run tests/storage/vault-identity-store.test.ts`
- 观察：Test Files 1 passed (1)，Tests 10 passed (10)。新增 `describe('startup usage')`：首次加载创建并持久化、复用而不重读磁盘、marker 损坏 fail-closed 不覆盖原文件。

### Task 5.* 全量回归 — GREEN
- 命令：`npx vitest run`
- 观察：Test Files 104 passed (104)，Tests 616 passed (616)。无回归。

### OpenSpec strict 校验
- 命令：`openspec validate vault-aware-file-anchor-capture --strict`
- 观察：`Change 'vault-aware-file-anchor-capture' is valid`。通过。

### 类型检查与构建
- 命令：`npx tsc --noEmit`
- 观察：无输出，类型检查通过。

### 审查修正：rename 路由与首条消息 verified 三元组 — RED
- 命令：`npx vitest run tests/domain/anchor-rename-workflow.test.ts`
- 观察：新增的 frozen store conversation 场景失败，`Object.assign` 尝试写入冻结状态；同时审查发现 `main.ts` 将文件跨目录移动错误扩展为父目录 remap，且首条消息只传递 `anchorFilePath`，会生成 legacy 锚点。

### 审查修正：rename 路由与首条消息 verified 三元组 — GREEN
- 命令：`npx vitest run tests/domain/anchor-rename-workflow.test.ts tests/domain/verified-first-message-anchor.test.ts && npm run typecheck`
- 观察：2 个测试文件、5 个测试全部通过；`tsc --noEmit` 通过。文件与文件夹 rename 分流；工作流复制冻结 store state 后返回已更新会话供 store 持久化；首条消息只会写入完整 Vault/path/ctime 三元组，元数据不可用时零锚点写入。

### 审查修正：最终质量门 — GREEN
- 命令：`openspec validate vault-aware-file-anchor-capture --strict && npm run check`
- 观察：OpenSpec strict 验证通过；Vitest 106 个文件、621 个测试通过；类型检查、ESLint、生产构建与 Node regression（328 个测试）全部通过。

### 审查修正：Vault-aware rename 与最新 revision — RED
- 命令：`npx vitest run tests/domain/anchor-renamer.test.ts`
- 观察：新增同路径 foreign stored anchor 场景失败（Tests 1 failed | 13 passed）；旧实现仍返回更新并准备保存。符合 RED。
- 命令：`npx vitest run tests/domain/anchor-renamer.test.ts tests/domain/anchor-rename-workflow.test.ts tests/domain/stored-anchor-workflow.test.ts`
- 观察：新增 loaded revision=10、enumerated record revision=4 的保存场景失败（Tests 1 failed | 28 passed）；候选错误地使用 revision=4 而非 11。符合 RED。

### 审查修正：Vault-aware rename 与最新 revision — GREEN
- 命令：`npx vitest run tests/domain/anchor-renamer.test.ts tests/domain/anchor-rename-workflow.test.ts tests/domain/stored-anchor-workflow.test.ts`
- 观察：Test Files 3 passed (3)，Tests 29 passed (29)。`AnchorRenameWorkflow` 在插件字段中仅初始化一次，并用单个队列验证第二事件直到第一事件 stored 与 open 阶段均结束才开始；workflow 接收 currentVaultId，foreign/legacy/partial 锚点不参与 stored/open 路径改写，pending anchor 仍随事件更新；持久化保存从真实 loaded conversation 生成 candidate，保留最新内容并以 `loaded.revision + 1` 保存（expected revision=loaded.revision）。

### 审查修正：最终门禁 — GREEN
- 命令：`openspec validate vault-aware-file-anchor-capture --strict`
- 观察：`Change 'vault-aware-file-anchor-capture' is valid`。
- 命令：`npm run check`
- 观察：Vitest 107 个文件、635 个测试通过；`tsc --noEmit`、ESLint、生产构建通过；Node regression 328 个测试通过。