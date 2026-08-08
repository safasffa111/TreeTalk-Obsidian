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

## 关系图谱操作

通过命令“TreeTalk: 打开沉淀关系图谱”打开沉淀后的关系图谱窗口。

- 平移：按住左键在空白处拖动画布。
- 缩放：滚轮以光标为中心缩放；键盘 `+` / `-` 缩放，`0` 复位视图。
- 节点：
  - 左键单击：对话节点 → 切换到该对话节点；笔记节点 → 在 Obsidian 中打开对应笔记。
  - 左键拖动：调整节点位置，位置会自动保存。
  - 右键单击：排除或恢复该节点。被排除的节点与连线会变暗，其余部分保持高亮，便于聚焦查看局部关系；再次右键恢复。
  - 悬停：节点及其相连连线高亮，标签淡入。
- 连线：右键单击排除或恢复该连线。
- 窗口：标题栏拖动移动，右下角拖拽调整大小；工具栏“适配”复位视角、“暂停/继续”停止或恢复动画、“—”最小化、“□”最大化/恢复、“×”关闭。
- 按 `Esc` 取消正在进行的节点拖动。

## 框选与对话树操作

- 树面板：点击节点行切换当前对话节点，当前节点高亮显示；点击来源留痕可跳转到使用该选段提问的节点。
- 分支模式：在输入区单击鼠标右键切换“继续当前节点 / 创建子分支”，发送时按当前模式继续或创建子节点。
- 框选 TreeTalk 消息：选段加入当前草稿的上下文数组，并自动进入子分支模式；删除最后一个 TreeTalk 框选后恢复原模式。
- 框选笔记正文：加入上下文，但不强制创建分支。
- 上下文条目：可逐项删除（`×`）；框选来源会生成可点击留痕，同一选段关联多个分支时可选择目标分支。
- 公式框选：框选经过渲染后的公式时临时显示原始 LaTeX，取消选区后恢复渲染结果。
- 拖拽框选内容或上下文条目到 Markdown 笔记：生成 TreeTalk 摘录引用块（见下节）。
- 停止与重试：点击生成按钮中的停止图标保留当前内容并标记为中断；失败或中断的回答可原地重试续跑。
- 沉淀：回答末尾点击“沉淀回答”保存单条回答；“沉淀对话树”把整棵对话树保存为纯 Markdown 目录页与节点笔记。
- 输入框控制按钮：发散模式、回答思考、关联笔记、联网搜索开关与设置页实时同步。

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

---

## English

TreeTalk organizes AI conversations into a tree: every follow-up can continue or branch, selections from notes and conversations become context, and answers can be captured back into plain Markdown. It runs inside Obsidian and is powered by DeepSeek, with on-demand evidence retrieval, streaming output, and failure recovery.

> Current version: 0.9.2 (beta quality).

## Features

- Tree conversations: continue the current node or create child branches; every node can be answered independently.
- Selection as context: select text in notes, questions, or answers to add context with clickable source traces.
- Progressive evidence: retrieves note sections, ancestor nodes, and related notes on demand to keep token usage low.
- Follow-up continuity: continuing a node seeds the next turn with the previous answer's conclusion digest and evidence provenance, so consecutive answers stay anchored.
- Streaming and recovery: streaming output, stop generation, in-place retry after failure or interruption, and long-answer continuation.
- Knowledge capture: save a single answer or the whole conversation tree as plain Markdown.
- Excerpt backlinks: drag selected text into a note to create a quote block with a source link.
- Relationship graph: visualize deposited conversation trees and notes, with focus and dimming controls.
- Web search: DeepSeek can search the web on demand (toggle in settings).

## Installation

From the community directory: Settings → Community plugins → Browse → search "TreeTalk" → Install and enable.

Manual install: copy `main.js`, `manifest.json`, `styles.css`, and `versions.json` into:

```text
<Your Vault>/.obsidian/plugins/treetalk/
```

Reload Obsidian, enable TreeTalk under Community plugins, then open Settings → TreeTalk to configure the model, API endpoint, and API key. The API key is stored in Obsidian's SecretStorage and is never written into notes.

## Quick start

- Click the sidebar icon to open TreeTalk, type a question, and send: the answer continues the current node.
- Right-click inside the input area to switch to branch mode, then send: creates a child node under the current node.
- Select text in a note or conversation to add it as context before asking.
- Click "沉淀回答" (Capture answer) at the end of an answer to save it as a plain Markdown note.
- Click "沉淀对话树" (Capture tree) to save the whole conversation tree as Markdown.

## Usage

- Click the TreeTalk sidebar icon to open or close TreeTalk.
- Click "对话列表" (conversation list) at the top of the tree to expand or collapse the open conversation.
- Normal send: continue the current node.
- Right-click inside the input area to switch to branch mode, then send: create a child node under the current node.
- Select TreeTalk messages: adds the selection to the context and switches to child-branch mode; removing the last TreeTalk selection restores the previous mode.
- Select the current Markdown note: adds to the context without forcing a branch.
- Click the `×` on a context item to remove it.
- Drag selected text or a context item into a Markdown note: creates a TreeTalk excerpt (see below).
- Click "返回 TreeTalk 来源" in an excerpt: locates the source in the active conversation or history.
- Click a source trace: jumps to the node that used that selection.
- Click "沉淀回答" at the end of a complete answer: creates a plain Markdown answer note.
- Click "沉淀对话树": creates a plain Markdown index page and node notes; selected follow-up links stay near their content.
- Click the stop icon in the send button: keeps the current content and marks it as interrupted.
- Close an active conversation space: saves and archives it.

## Relationship graph operations

Open the graph with the command "TreeTalk: 打开沉淀关系图谱" (Open deposit relationship graph).

- Pan: drag on empty space with the left mouse button.
- Zoom: mouse wheel zooms at the cursor; keyboard `+` / `-` zoom in/out; `0` resets the view.
- Nodes:
  - Left-click: conversation node → switch to that conversation node; note node → open the note in Obsidian.
  - Drag: move a node; positions are saved automatically.
  - Right-click: exclude or restore a node. Excluded nodes and edges are dimmed while the rest stay highlighted, so you can focus on part of the graph; right-click again to restore.
  - Hover: highlights the node and its connected edges; labels fade in.
- Edges: right-click to exclude or restore an edge.
- Window: drag the title bar to move it, drag the bottom-right corner to resize; toolbar buttons fit view, pause/resume animation, minimize, maximize/restore, and close.
- Press `Esc` to cancel an in-progress node drag.

## Selection and conversation tree operations

- Tree panel: click a row to switch the current conversation node; the active node is highlighted. Click a source trace to jump to the node that used the selection.
- Branch mode: right-click inside the input area to toggle between "continue current node" and "create child branch"; sending follows the current mode.
- Select TreeTalk messages: the selection joins the context list and switches to child-branch mode automatically; removing the last TreeTalk selection restores the previous mode.
- Select note text: adds to the context without forcing a branch.
- Context items: remove one by one with `×`; selections create clickable source traces, and if the same selection is used by multiple branches you can choose the target branch.
- Formula selections: temporarily show the raw LaTeX while selected; the rendered result returns when the selection is cleared.
- Drag selected text or a context item into a Markdown note: creates a TreeTalk excerpt quote block (see below).
- Stop and retry: click the stop icon to keep the current content and mark it as interrupted; failed or interrupted answers can be retried in place.
- Capture: "沉淀回答" saves a single answer; "沉淀对话树" saves the whole conversation tree as plain Markdown.
- Composer buttons: divergence mode, answer thinking, related notes, and web search stay in sync with the settings page.

## Privacy and network

- Conversation content, selected context, and related-note text are sent to the API service you configure (DeepSeek by default) to generate answers.
- With web search enabled, DeepSeek may search the web; opened pages are used as external evidence.
- The API key is stored only in Obsidian SecretStorage and is never written into notes or conversation data.
- Conversation data is stored under `<Vault>/.obsidian/treetalk-data/` and does not appear in the file explorer, search, or graph.

## TreeTalk excerpt format

Dragging a selection into the Markdown editor inserts a quote block at the exact drop point:

```markdown
> [!quote] TreeTalk 摘录
> 被选中的原文
>
> [返回 TreeTalk 来源](obsidian://treetalk-open?...)
```

The quote block is plain Markdown and can be copied and moved freely. The source link carries an exact anchor to the active conversation or a conversation kept in TreeTalk's private history; after the source conversation is permanently deleted, the link reports that the source no longer exists.

## Data location

- Active and archived conversations: `<Vault>/.obsidian/treetalk-data/` (`active/` and `history/`)
- Captured single answers: `TreeTalk 知识/` (configurable via "知识沉淀文件夹")
- Captured conversation trees: `TreeTalk/` (configurable via "沉淀对话树目录")

Internal data never appears in the file explorer, search results, or relationship graph. Only deliberately captured notes, answer notes, and dropped excerpt quote blocks become ordinary Markdown. TreeTalk does not scan or repair deposited notes.

## Commands

- `TreeTalk: 打开或关闭 TreeTalk` (open or close TreeTalk)
- `TreeTalk: 新建对话空间` (new conversation space)
- `TreeTalk: 关闭当前对话空间` (close current conversation space)
- `TreeTalk: 切换到下一个对话空间` (switch to the next conversation space)
- `TreeTalk: 切换到上一个对话空间` (switch to the previous conversation space)
- `TreeTalk: 打开历史对话` (open history)
- `TreeTalk: 恢复当前历史对话` (restore current history)

TreeTalk does not override Obsidian's global `Ctrl+W`.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
