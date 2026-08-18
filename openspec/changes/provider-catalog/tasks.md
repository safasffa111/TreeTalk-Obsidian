# 任务列表：供应商目录与设置层解除 DeepSeek 硬编码

## 1. 供应商目录与配置层

- [x] 1.1 新增 `src/providers/presets.ts`：`WireFormat`/`ProviderPreset`/`PROVIDER_PRESETS`（deepseek/zhipu/minimax/openrouter/kimi/siliconflow/dashscope/openai/anthropic/gemini/openai-compatible）+ `resolveProfile` + `normalizeProviderKey` 别名解析；`tests/providers/presets.test.ts` 覆盖 wire 映射与 base_url
- [x] 1.2 `plugin-data.ts`：`provider` 字段解除硬编码（string key），`normalizeConfiguredModel` 改为按 preset 补默认而非强制 deepseek 前缀；`parseSettings` 兼容旧值 `"deepseek"`
- [x] 1.3 `main.ts`：`currentProviderProfile()` 改用 `resolveProfile`
- [x] 1.4 baseUrl 安全校验：https 默认、拒绝内嵌凭据、localhost 警告放行；`validateBaseUrl` 测试覆盖

## 2. 设置 UI 与能力降级

- [x] 2.1 `settings-tab.ts`：新增「供应商」下拉（preset 名称）+「模型」文本框（附 preset.models 建议）；「API 地址」placeholder 按 preset 显示默认端点
- [x] 2.2 能力降级：webSearch 控件在 provider 不支持时禁用（`supportsWebSearch` 能力位）；描述说明仅 DeepSeek 支持

## 3. 回归与收尾

- [x] 3.1 `npm run check` 全绿（vitest + tsc + eslint + build + regression）
- [x] 3.2 更新 CHANGELOG.md
