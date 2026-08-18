# 提案：多供应商配置档（Provider Profiles）

## Why

当前 TreeTalk 只有单一 `provider`/`model`/`baseUrl` 设置，且 API Key 存在唯一的
`secretStorage` 槽位 `treetalk-api-key`。用户在 DeepSeek 与 MiniMax 之间切换时，
必须每次手动重填 API Key；切换后旧 key 仍留在唯一槽位，导致新供应商用错 key 而鉴权失败
（MiniMax "Failed to fetch" 的直接原因）。用户需要保存多个完整供应商配置并一键切换。

## What Changes

- 新增「供应商配置档」概念：每个 profile 保存 名称 / 供应商 preset / 模型 / baseUrl，
  并各自绑定一个独立的 `secretStorage` secret ID（key 不进 data.json）。
- 设置页可新增、编辑、删除、切换配置档；下拉选择「活动配置档」。
- 活动配置档驱动 `currentProviderProfile()` 与发送时的 provider/model/baseUrl/key。
- 向后兼容：旧的单一 provider/model/baseUrl 设置 + `treetalk-api-key` 自动迁移为一个
  名为「默认」的配置档，原 key 原样保留，用户无感。
- baseUrl 仍复用现有 `validateBaseUrl` 校验（https / 拒绝内嵌凭据 / loopback 警告）。

## Capabilities

### New Capabilities

- `multi-provider-profiles`：多供应商配置档的存储、迁移、切换与按档取 key。

### Modified Capabilities

无（仓库无 living specs）。

## Non-goals

- 不改动各 provider 的请求构造/wire 路由（DeepSeek chat/completions、MiniMax anthropic 已正确）。
- 不做 profile 云同步 / 导入导出。
- 不引入密钥加密（沿用 Obsidian SecretStorage 现有安全模型）。
- 不做 flash 空正文兜底（属独立问题）。

## Impact

- 新增：`src/providers/provider-profiles.ts`（profile 数据模型 + 迁移 + 校验）、对应测试。
- 修改：`src/tabs/plugin-data.ts`（settings 增加 profiles 结构与迁移）、`src/main.ts`
  （currentProviderProfile / getApiKey 改为读活动 profile + 按档 secret ID）、
  `src/settings-tab.ts`（配置档管理 UI）。
