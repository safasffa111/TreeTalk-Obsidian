# TreeTalk for Obsidian

TreeTalk 把 AI 对话组织成树形结构：每条追问都可以继续或分支，框选笔记与对话内容作为上下文，回答与依据可沉淀回纯 Markdown。插件基于 DeepSeek，在 Obsidian 内直接提问，支持按需取证、流式输出、失败续跑与长回答续写。

> 当前为 0.9.0 首发版（beta 质量阶段）。

## 特性

- 树形对话：继续当前节点或创建子分支，任意节点可独立回答。
- 框选即上下文：框选笔记、问题或回答加入上下文数组，来源可点击留痕。
- 渐进取证：按需从当前笔记、祖先节点与关联笔记提取证据，控制 token 成本。
- 续问衔接：继续提问时自动带上上一轮结论摘要与依据清单，回答不割裂。
- 流式输出与中断恢复：流式回复、停止生成，失败或中断后原地重试续跑。
- 知识沉淀：单条回答与整棵对话树可一键沉淀为纯 Markdown 笔记。
- 摘录回链：框选内容可拖入笔记，生成带来源链接的引用块。
- 联网模式：DeepSeek 按需搜索网页（可在设置中关闭）。

## 安装

社区目录安装：设置 → 第三方插件 → 浏览 → 搜索 TreeTalk → 安装并启用。

手动安装：将 `main.js`、`manifest.json`、`styles.css`、`versions.json` 复制到：

```text
<你的 Vault>/.obsidian/plugins/treetalk/
```

重新加载 Obsidian，在“设置 → 第三方插件”启用 TreeTalk，然后在“设置 → TreeTalk”填写模型、API 地址和 API Key（API Key 使用 Obsidian SecretStorage 保存，不写入普通笔记）。

## 快速开始

- 点击侧边栏图标打开 TreeTalk，输入问题并发送：继续当前节点。
- 输入区右键切换到分支模式后发送：在当前节点下创建子节点。
- 框选笔记或对话中的内容：加入上下文，再基于它提问。
- 回答末尾点击“沉淀回答”：把答案保存为纯 Markdown 笔记。
- 完整操作见下方“基本操作”。

## 基本操作

- 点击 TreeTalk 侧边栏图标：打开或关闭 TreeTalk。
- 点击树状列表第一行“对话列表”：展开或收起当前打开的对话。
- 正常发送：继续当前节点。
- 在输入区域单击鼠标右键切换到分支模式后发送：在当前节点下创建子节点。
- 框选 TreeTalk 问题或回答：加入上下文并切换到子分支模式；移除最后一个 TreeTalk 框选后恢复原模式。
- 框选当前 Markdown 笔记：加入上下文，但保持当前提问模式。
- 点击上下文条目右侧的 `×`：删除该项上下文。
- 拖动框选原文或上下文条目到 Markdown 笔记：生成 TreeTalk 摘录。
- 点击摘录中的“返回 TreeTalk 来源”：按活动对话、历史对话的顺序定位来源。
- 点击原文留痕：进入使用该选段提问的节点。
- 在完整 AI 回答末尾点击“沉淀回答”：创建纯 Markdown 回答笔记。
- 点击“沉淀对话树”：创建纯 Markdown 目录页和节点笔记；框选追问链接会保留在对应内容附近。
- 点击生成按钮中的停止图标：保留当前内容并标记为中断。
- 关闭活动对话空间：保存并归档。

## 网络与隐私

- 对话内容、框选上下文与关联笔记正文会发送到你配置的 API 服务（默认 DeepSeek），用于生成回答。
- 联网模式开启时，DeepSeek 可能执行网页搜索，被打开的页面正文会作为外部证据参与回答。
- API Key 只保存在本机 Obsidian SecretStorage，不写入笔记或对话数据。
- 对话数据保存在 `<Vault>/.obsidian/treetalk-data/`，不进入 Obsidian 文件列表、搜索结果或关系图谱。

## TreeTalk 摘录格式

拖入 Markdown 编辑器后，会在准确落点插入：

```markdown
> [!quote] TreeTalk 摘录
> 被选中的原文
>
> [返回 TreeTalk 来源](obsidian://treetalk-open?...)
```

引用块是普通 Markdown，可以随笔记复制和迁移。来源链接内含精确锚点，可定位当前活动对话或仍保存在 TreeTalk 私有历史中的对话；原对话被永久删除后，链接会提示来源不存在。

## 数据位置

活动对话和历史对话保存在：

```text
<Vault>/.obsidian/treetalk-data/
├── active/
└── history/
```

这些内部数据不会显示在 Obsidian 文件列表、搜索结果或关系图谱中。

只有主动沉淀的节点笔记、回答笔记以及拖入笔记的引用块会成为普通 Markdown。

- 单条回答默认保存在 `TreeTalk 知识/`，可通过“知识沉淀文件夹”修改。
- 对话树默认保存在 `TreeTalk/`，可通过“沉淀对话树目录”修改。

每次沉淀都会创建独立的纯 Markdown 文件夹。目录页保存树状 WikiLink，节点笔记可自由编辑、移动、重命名和整理；TreeTalk 不会扫描或修复这些笔记。

## 命令面板

- `TreeTalk: 打开或关闭 TreeTalk`
- `TreeTalk: 新建对话空间`
- `TreeTalk: 关闭当前对话空间`
- `TreeTalk: 切换到下一个对话空间`
- `TreeTalk: 切换到上一个对话空间`
- `TreeTalk: 打开历史对话`
- `TreeTalk: 恢复当前历史对话`

TreeTalk 不会覆盖 Obsidian 全局的 `Ctrl+W`。

## 更新日志

历史变更见 [CHANGELOG.md](CHANGELOG.md)。
