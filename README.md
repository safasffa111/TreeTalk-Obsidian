# TreeTalk for Obsidian

TreeTalk 是一款运行在 Obsidian 中的树状 AI 对话插件。

你可以从问题、回答或笔记选段继续追问，把不同思路拆成互不干扰的分支，并将有价值的内容沉淀为普通 Markdown 笔记。

## 主要功能

### 冻结压缩对话和缓存命中规范

通过利用统一的markdown规范，裁剪历史上下文并冻结的方式，实现压缩文本的同时提高缓存命中

### 链接保存与纯 Markdown 知识沉淀

你可以沉淀单条回答，也可以沉淀整棵对话树。

当你沉淀整个对话树的时候，TreeTalk会通过你引用的笔记与节点间的层级关系自动生成WikiLink

沉淀结果包含普通 Markdown 和 WikiLink，生成后的笔记可以自由编辑、移动和整理。


### 树状 AI 对话

每次追问都可以继续当前节点，也可以创建新的子分支。

不同分支拥有各自的上下文。点击树上的任意节点，即可回到对应的讨论位置，不必在一条很长的聊天记录中反复翻找。

### 精确框选追问

你可以直接框选：

* TreeTalk 中的问题或回答
* Obsidian 笔记中的文字
* 列表、代码块、表格和公式

框选内容会成为本轮重点上下文，并在原位置留下可点击的 WikiLink，方便以后返回对应的 TreeTalk 节点。

### 与 Obsidian 笔记结合

从笔记中发起追问时，TreeTalk 可以读取当前笔记，并围绕你框选的内容回答。

TreeTalk 中选中的内容也可以拖入 Markdown 编辑器，生成引用块和返回来源节点的链接。

### 多模型支持

当前支持：

* OpenAI
* DeepSeek
* Anthropic
* Gemini
* OpenAI 兼容接口

* 建议主要使用deepseek

## 安装

TreeTalk 当前仅支持桌面端，需要 Obsidian `1.13.0` 或更高版本。

1. 打开仓库的 **Releases** 页面。
2. 下载最新版本的 TreeTalk 插件安装包 ZIP。
3. 解压 ZIP，得到 TreeTalk 插件文件夹。
4. 将解压后的文件夹重命名为：

```text
treetalk
```

5. 将整个文件夹放入当前 Obsidian 仓库：

```text
<Vault>/.obsidian/plugins/treetalk/
```

安装完成后的目录应类似：

```text
<Vault>/.obsidian/plugins/treetalk/
├── main.js
├── manifest.json
├── styles.css
└── README.md
```

6. 重新启动 Obsidian，或重新加载第三方插件。
7. 打开“设置 → 第三方插件”，启用 TreeTalk。
8. 打开“设置 → TreeTalk”，选择模型服务并填写 API Key。

> 如果看不到 `.obsidian` 文件夹，请先在系统文件管理器中开启“显示隐藏文件”。

## 快速开始

1. 点击 Obsidian 侧边栏中的 TreeTalk 图标。
2. 新建一个对话并发送问题。
3. 正常发送会继续当前节点。
4. 创建子分支，围绕同一问题探索不同方向。
5. 框选 TreeTalk 回答或 Obsidian 笔记内容，基于选段继续追问。
6. 点击“沉淀回答”或“沉淀对话树”，将有价值的内容保存为 Markdown。

## 数据与隐私

TreeTalk 的活动对话和历史对话保存在当前 Vault 的插件数据目录中，不会自动出现在普通笔记、搜索结果和关系图谱中。

只有你主动沉淀的内容，才会生成普通 Markdown 笔记。

API Key 使用 Obsidian 的 SecretStorage 保存，不会写入普通笔记。

## 当前版本

**TreeTalk 0.8.23**

这是 TreeTalk 面向大众发布的首个版本。欢迎提交使用反馈、功能建议和问题报告。

