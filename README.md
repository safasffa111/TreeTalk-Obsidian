# TreeTalk for Obsidian

TreeTalk 是一个以 Obsidian 为载体的树状 AI 对话插件。每个标签页都是独立对话空间，可以继续当前节点，也可以从任意节点创建分支，并把有价值的回答、选段和完整对话树沉淀到 Markdown 笔记中。

## 0.9.0：社区发布候选版

- 当前公开版本只使用完整模式，发送当前根节点到活动节点的完整对话分支，不发送兄弟分支。
- 设置页不包含上下文模式切换入口；从旧测试版升级时，旧模式设置会自动恢复为完整模式。
- 修复单行用户消息气泡高度，使气泡贴合实际文字。
- 完成 Obsidian 公开稳定版兼容、隐私披露、发布资产检查和社区发布准备。

## 主要功能

- 在 Obsidian 右侧栏中并排显示树状节点列表和当前对话。
- 每个标签页是独立对话空间，可展开、切换和恢复。
- 使用 `Alt + F` 切换“继续当前节点 / 创建子分支”。
- 框选 TreeTalk 中的问题或回答后，可精确到字符地创建追问并保留来源痕迹。
- 在当前 Markdown 笔记中框选文字，也可加入本轮上下文。
- 问题和回答使用 Obsidian 原生 Markdown 渲染，支持标题、列表、表格、代码块、内部链接和 LaTeX。
- 支持流式回复、停止生成、后台对话继续生成，以及失败和中断恢复。
- 支持把单条回答或完整对话树沉淀到 Markdown 笔记。
- 历史对话支持搜索、打开、恢复和永久删除。
- 支持 OpenAI、DeepSeek、Anthropic、Gemini 和 OpenAI 兼容 API。
- API Key 使用 Obsidian SecretStorage 保存，不写入普通笔记。

## 隐私、网络与账户要求

TreeTalk 不会收集遥测，不包含广告，也不会把对话或 API Key 发送给 TreeTalk 自有服务器。

使用 AI 对话功能需要用户自行配置所选服务商的 API Key、模型与接口。发送消息时，当前问题以及当前活动分支的上下文会直接发送到用户选择的 OpenAI、DeepSeek、Anthropic、Gemini 或 OpenAI 兼容 API。数据如何被处理取决于对应服务商的条款与隐私政策。

API Key 使用 Obsidian SecretStorage 保存，不写入普通 Markdown 笔记。活动对话和历史对话保存在当前 Vault 的 `.obsidian/treetalk-data/`；只有用户主动沉淀的回答、节点笔记和对话树会写入普通 Markdown 文件。

TreeTalk 不要求注册 TreeTalk 账户，不提供内购或付费订阅。API 服务费用由用户与所选模型服务商直接结算。

## 安装

发布到 Obsidian 社区目录后，可直接在“设置 → 第三方插件 → 浏览”中搜索 TreeTalk 安装。

手动安装时，将 GitHub Release 中的 `main.js`、`manifest.json` 和 `styles.css` 复制到：

```text
<你的 Vault>/.obsidian/plugins/treetalk/
```

重新加载 Obsidian，在“设置 → 第三方插件”中启用 TreeTalk，然后在“设置 → TreeTalk”填写服务类型、模型和 API Key。

## 开发验证

```bash
npm ci
npm run verify
```

发布版本要求 `manifest.json`、`package.json`、`versions.json` 与 GitHub Release 标签保持一致。

## License

TreeTalk 使用 MIT License。详见 [LICENSE](LICENSE)。
