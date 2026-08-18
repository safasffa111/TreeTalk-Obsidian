# vault-aware-file-anchor-capture 变更

## ADDED Requirements

### Requirement: 每个 Vault 具有独立持久身份
系统 SHALL 在插件目录和会话数据目录之外保存当前 Vault 的 UUID。复制 `data.json`、插件目录或 `treetalk-data` 到另一 Vault MUST NOT 复制或改变目标 Vault 的身份。

#### Scenario: 插件目录被复制到另一 Vault
- **WHEN** 用户把插件目录和会话数据复制到具有不同 Vault UUID 的 Vault
- **THEN** 原会话中的 `anchorVaultId` 与当前 Vault 不匹配，系统将锚点判定为外来锚点

#### Scenario: Vault 根目录被整体移动
- **WHEN** 用户移动包含 Vault marker 的完整 Vault 根目录
- **THEN** 当前 Vault UUID 保持不变

#### Scenario: Vault marker 损坏
- **WHEN** 已存在的 Vault marker 不是受支持的结构或 UUID 非法
- **THEN** 系统 MUST 报错且 MUST NOT 静默生成新 UUID

### Requirement: 首条消息原子保存已验证锚点
系统 SHALL 把 `anchorVaultId`、`anchorFilePath` 和 `anchorFileCtime` 与首条用户消息在同一次 tree command 中保存，只增加一次 revision。三项不完整的旧锚点 SHALL 被视为未验证。

#### Scenario: 锚定 Markdown 后发送首条消息
- **WHEN** 用户显式锚定当前 Vault 的 Markdown 文件并发送首条消息
- **THEN** 会话在同一个不可分割的状态变更中包含首条消息和完整锚点三元组

#### Scenario: 后续消息尝试改变锚点
- **WHEN** 会话已经存在用户消息
- **THEN** 普通发送 MUST NOT 补写、覆盖或清除任一锚点字段

#### Scenario: 读取旧路径锚点
- **WHEN** 会话只有 `anchorFilePath` 而没有 Vault ID 或 ctime
- **THEN** schema 仍可读取该会话，但锚点状态为 `legacy-unverified`

### Requirement: 锚点跟随原 Vault 内文件重命名和移动
系统 SHALL 在当前 Vault 内维护已验证 Markdown 锚点文件的最新路径。正文修改 MUST NOT 改变锚点；rename 事件 SHALL 仅更新 stored/open 中完整三元组、Vault ID 等于当前 Vault 且当前路径（stored 同时包括 observed 路径）为 Vault-relative Markdown 的会话路径。显式 Markdown 选择产生的 pending 路径 SHALL 保持其独立重映射语义。

#### Scenario: 修改锚点文件正文
- **WHEN** 用户修改锚点 Markdown 的内容但没有删除或替换文件
- **THEN** 锚点仍为 verified，沉淀继续使用该文件当前路径

#### Scenario: 重命名锚点文件
- **WHEN** Obsidian 把锚点文件从 `A/旧名.md` 重命名为 `A/新名.md`
- **THEN** 所有锚定该文件的会话更新为 `A/新名.md`

#### Scenario: 移动包含锚点的文件夹
- **WHEN** Obsidian 把 `A/` 移动为 `B/`，锚点原路径为 `A/note.md`
- **THEN** 锚点路径更新为 `B/note.md`

#### Scenario: 插件未运行期间移动文件
- **WHEN** 已保存路径不存在、Vault ID 匹配且当前 Vault 中恰有一个 Markdown 文件的 ctime 与锚点一致
- **THEN** 系统更新锚点为该唯一候选的最新路径

#### Scenario: ctime 候选不唯一
- **WHEN** 当前 Vault 中存在多个具有相同锚点 ctime 的 Markdown 候选
- **THEN** 系统 MUST NOT 猜测目标文件，并将状态标记为 ambiguous

#### Scenario: 非 Markdown 路径经 rename 事件
- **WHEN** 完整三元组的 stored 或 open 路径为 `attachments/scan.pdf`，Vault 把它重命名为 `attachments/scan.md` 或移动其父文件夹
- **THEN** 系统 MUST NOT 保存、更新路径、递增 revision 或将其升级为 verified

### Requirement: 沉淀前阻止错误 Vault 写入
系统 MUST 在创建任何沉淀文件或目录前验证锚点状态。外来、未验证、缺失或歧义锚点 MUST NOT 回退到当前 Vault 的 `treeCaptureFolder` 或相同相对路径。

#### Scenario: 当前 Vault 存在相同相对路径
- **WHEN** 外来会话锚定 `Notes/a.md`，当前 Vault 也存在 `Notes/a.md`，但 Vault UUID 不同
- **THEN** 系统显示“会话锚定文件不在当前 Vault”并保证本次沉淀零写入

#### Scenario: 锚点文件已删除
- **WHEN** 锚点 Vault 匹配但路径和 ctime 都无法解析到现有 Markdown
- **THEN** 系统显示锚定文件不存在或已删除，并保证本次沉淀零写入

#### Scenario: 未锚定旧会话
- **WHEN** 会话从未设置任何锚点字段
- **THEN** 系统继续按设置中的 `treeCaptureFolder` 沉淀

### Requirement: 同一文件的会话共享确定性归组目录
系统 SHALL 根据已验证锚点的最新路径计算 `<anchorDir>/<anchorStem>-tree/`，并把每次对话树沉淀放在该根目录下的唯一子目录。归组根目录的计算 MUST NOT 依赖目录是否已存在或该会话是否曾经沉淀。

#### Scenario: 多个会话锚定同一文件
- **WHEN** 两个不同 conversation ID 都锚定 `Projects/design.md` 并分别沉淀
- **THEN** 两次沉淀路径均位于 `Projects/design-tree/` 下，且各自内容不互相覆盖

#### Scenario: 归组目录尚不存在
- **WHEN** 第一个锚定会话首次沉淀且 `Projects/design-tree/` 不存在
- **THEN** 系统按同一确定性规则创建该归组目录

#### Scenario: 锚点文件改名后再次沉淀
- **WHEN** `Projects/design.md` 已重命名为 `Projects/system-design.md`
- **THEN** 新的沉淀位于 `Projects/system-design-tree/` 下

### Requirement: 无效锚点只能显式重新绑定
系统 SHALL 允许用户从目标 Markdown 文件右键，把 legacy、foreign、missing 或 ambiguous 锚点显式重新绑定到当前 Vault。有效的同 Vault 锚点 MUST 保持冻结。

#### Scenario: 外来会话重新绑定
- **WHEN** 用户在当前 Vault 的 Markdown 文件上选择重新绑定当前会话
- **THEN** 系统以一次 revision 更新完整锚点三元组，之后允许沉淀到新文件同级目录

#### Scenario: 有效锚点尝试更换文件
- **WHEN** 当前会话锚点在当前 Vault 中仍然 verified
- **THEN** 系统拒绝普通重新绑定并保留原锚点
