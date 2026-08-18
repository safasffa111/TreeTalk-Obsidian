# 设计：供应商目录与设置层解除 DeepSeek 硬编码

## Context

- wire 适配器已存在四套；缺的是"供应商 → 协议 + 端点"映射层与设置层解除 deepseek 硬编码。

## Decisions

### D1: 供应商目录 = 纯数据 + 解析函数（对照 FrameLearn catalog.ts）

```ts
export type WireFormat = "openai_chat" | "anthropic" | "gemini";
export interface ProviderPreset {
  key: string; name: string; wire: WireFormat;
  baseUrl: string; aliases: readonly string[];
  models: readonly string[]; defaultModel: string;
  supportsThinking: boolean; supportsWebSearch: boolean;
}
export const PROVIDER_PRESETS: Record<string, ProviderPreset> = { deepseek, zhipu, minimax, openrouter, kimi, siliconflow, dashscope, openai, anthropic, "openai-compatible" }
```
映射到既有 ProviderKind：`openai_chat` → `openai`（官方）或 `openai-compatible`；`anthropic` → `anthropic`；`gemini` → `gemini`。`currentProviderProfile()` 改为 `resolveProfile(settings)`：preset → kind + baseUrl + key。模型自由文本但按 preset.models 提供建议下拉（datalist 风格），不再强制 `deepseek-*` 前缀。

### D2: baseUrl 安全校验

设置保存时解析 URL：scheme 必须 https（`http://localhost`/`http://127.0.0.1` 放行但 Notice 警告明文）；拒绝 `user:pass@`；无 scheme 或解析失败报错不保存。

### D3: 能力降级 UI

`webSearchEnabled` 与 `answerThinkingMode` 的设置项和输入框按钮在当前 provider 不支持时 `disabled` + 描述说明「当前供应商不支持，仅 DeepSeek 支持联网」。引擎层已有 two-pass 回退（anthropic/gemini），无需改执行路由。

## Risks / Trade-offs

- **模型名错误**：自由文本，错误模型名由供应商 API 报错，错误信息已会显示在消息状态里；preset 建议列表降低出错率。

## Migration Path

`data.json` 里旧的 `provider:"deepseek"` 值在 `parseSettings` 中无损映射到新枚举。
