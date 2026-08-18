# 提案：供应商目录与设置层解除 DeepSeek 硬编码

## 问题

wire 适配器层已有 openai / anthropic / gemini / deepseek 四套，但配置层把 provider
硬编码为 `"deepseek"`（`plugin-data.ts` 强制 `const provider: ProviderKind = "deepseek"`、
`normalizeConfiguredModel` 把非 `deepseek-*` 模型重置、`main.ts` `currentProviderProfile()`
硬编码），用户无法选择其他供应商。

## 目标

1. 新增 FrameLearn 风格供应商目录（presets → wire 协议 + base_url + 别名），首批：
   deepseek、zhipu(GLM)、minimax、openrouter、kimi/moonshot、siliconflow、
   dashscope(Qwen)、openai、anthropic 原生与自定义 OpenAI 兼容端点。
2. 设置页可选供应商与模型；Pi 引擎的联网搜索仅 DeepSeek 可用（UI 禁用并提示），
   thinking 仅 DeepSeek/Anthropic 可用。
3. baseUrl 校验：默认仅 https，拒绝内嵌凭据，localhost 需显式确认。

## Non-goals

- 不为非 DeepSeek 供应商实现联网搜索工具。
- 不重写 Pi 引擎；非 DeepSeek 的 anthropic/gemini 协议走既有 two-pass 兼容路径。
- 不做多 profile 并存与按档密钥（由后续 `multi-provider-profiles` 变更独立解决）。

## Impact

- 新增：`src/providers/presets.ts`（供应商目录）、`tests/providers/presets.test.ts`
- 修改：`src/main.ts`（`currentProviderProfile` 改为从设置解析）、
  `src/tabs/plugin-data.ts`（provider/model 设置解除硬编码）、
  `src/settings-tab.ts`（供应商/模型选择 UI 与能力降级）
