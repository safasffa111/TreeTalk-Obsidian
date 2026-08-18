# 提案：Vault 感知的文件锚点与沉淀路由

## Why

当前会话只保存 Vault 内相对路径 `anchorFilePath`。锚点文件重命名或移动后路径会失效；把 `data.json`、插件目录或私有会话数据复制到另一 Vault 后，相同相对路径可能被误认为原文件，沉淀会在错误 Vault 创建目录。该问题必须在继续扩展锚点功能前解决。

## What Changes

- 为每个 Vault 建立独立、持久的 UUID；新锚点原子保存 `vaultId + filePath + fileCtime`，与首条消息同一次 revision 落库。
- 文件正文修改不影响锚点；rename/move 事件更新全部活动与历史会话。插件未运行期间发生移动时，使用 Vault 内文件创建时间安全重定位，候选不唯一时拒绝猜测。
- 沉淀前验证锚点属于当前 Vault 且文件仍存在。外来、未验证、缺失或歧义锚点不得回退到当前 Vault 创建目录，并显示明确提示。
- 所有锚定到同一文件的会话统一沉淀在该文件最新路径同级的 `<当前文件名>-tree/` 下；目录是否已存在、其他会话是否已沉淀不改变归组规则。
- 旧的仅路径锚点保持可读取，但标记为未验证；用户可通过文件右键显式重新绑定。

## Capabilities

### New Capabilities

- `vault-aware-file-anchor-capture`：Vault 身份、文件锚点重定位、跨 Vault 防误写、确定性沉淀归组和显式重新绑定。

### Modified Capabilities

无。仓库当前没有 living specs。

## Non-goals

- 不跨 Vault 自动写文件；本变更只检测并阻止错误沉淀。
- 不自动迁移重命名前已经生成的 Markdown 沉淀目录。
- 不在用户 Markdown 正文或 frontmatter 中写入 TreeTalk 文件 ID。
- 不解决整树多文件写入的全目录事务化；本变更保证锚点与首条消息原子提交，并保证沉淀校验失败时零写入。

## Impact

- 新增 Vault 身份存储、锚点解析/重命名服务及测试。
- 扩展 `ConversationFile` 锚点字段、schema、tree commands、pending anchor。
- 修改 `main.ts` 的 Vault rename 监听、显式重新绑定和沉淀错误提示。
- 修改 `KnowledgeCaptureService` 的预检与确定性锚点归组测试。
