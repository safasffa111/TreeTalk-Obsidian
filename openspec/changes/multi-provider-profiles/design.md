# 设计：多供应商配置档

## Context

- 单 provider/model/baseUrl 在 `TreeTalkSettings`；单 key 在 `secretStorage["treetalk-api-key"]`。
- `secretStorage` 支持多 ID：`setSecret(id)` / `getSecret(id)` / `listSecrets()`（Obsidian ≥1.11.4）。
  ID 约束：小写字母数字加连字符。
- provider 读取点集中在 main.ts：`currentProviderProfile()`（resolveProfile）、`getApiKey()`、
  发送时 `webSearchEnabled` 判断 `provider === "deepseek"`、`modelId = pluginSettings.model`。
- 设置页是声明式（getSettingDefinitions），API Key 项已用命令式 `render` 回调（可放自定义 UI）。

## Decisions

### D1：profile 数据结构，key 不入 data.json

```ts
interface ProviderProfileConfig {
  id: string;            // crypto.randomUUID()，稳定，用于派生 secret ID
  label: string;         // 用户可见名称，如 "DeepSeek 主号"
  provider: string;      // preset key（deepseek / minimax / ...）
  model: string;
  baseUrl: string;       // 空=用 preset 默认
}
interface ProviderProfilesState {
  activeProfileId: string | null;
  profiles: ProviderProfileConfig[];
}
```

`ProviderProfilesState` 存进 `TreeTalkSettings.providerProfiles`。key 不放这里，
存 `secretStorage`，secret ID = `treetalk-key-<profileId>`（profileId 已是合法 uuid，
拼接后满足小写字母数字加连字符约束）。删除 profile 时一并清除其 secret（若 API 无删除则置空串）。

### D2：向后兼容迁移（一次性，幂等）

`parsePluginData` / settings 解析时：若 `providerProfiles` 缺失或 profiles 为空，
用旧字段构造一个默认 profile：
```
{ id: <新uuid>, label: "默认", provider: settings.provider,
  model: settings.model, baseUrl: settings.baseUrl }
```
并把旧 `secretStorage["treetalk-api-key"]` 的值复制到 `treetalk-key-<新uuid>`
（迁移在 main.ts 运行期做，因为纯 settings 解析层不该碰 secretStorage）。
保留旧 provider/model/baseUrl 字段与旧 key 槽不删除（回滚安全）；活动 profile 为准。

### D3：活动 profile 驱动一切

新增 `activeProfileConfig()`：返回 activeProfileId 对应的 profile，
找不到则回退第一个，再无则回退旧字段构造的临时 profile。
- `currentProviderProfile()` 改为 resolveProfile({ provider/model/baseUrl 取自活动 profile,
  apiKey: getSecret("treetalk-key-<activeId>") })。
- `getApiKey()` 改为读活动 profile 的 secret。
- 发送时 `webSearchEnabled`、`modelId` 均取活动 profile。

### D4：设置 UI

「模型 API」组重构：
- 顶部下拉「活动配置档」：列出所有 profile.label，选择即切换 activeProfileId。
- 「新增配置档」按钮：建空 profile 并激活。
- 当前 profile 的 供应商(dropdown) / 模型(text) / API 地址(text) / API Key(password) 编辑区，
  改动写入活动 profile 对象（key 写对应 secret ID）。
- 「删除当前配置档」按钮：删除并清 secret；至少保留一个 profile。
- baseUrl 保存时用 validateBaseUrl 校验（沿用现有 Notice 提示）。

### D5：不碰 wire 路由

DeepSeek chat/completions、MiniMax anthropic/v1/messages、thinking adaptive/disabled
逻辑全部不动。本 change 只改「provider/model/baseUrl/key 从哪来」，不改「怎么发请求」。

## Risks / Trade-offs

- 迁移时机：必须在插件 onload 且 secretStorage 可用后执行一次，避免覆盖用户已建 profile。
  用「providerProfiles 为空」作幂等判据。
- 删除 profile 若 SecretStorage 无 removeSecret，则 setSecret 空串清除（listSecrets 可核查）。
- data.json 只存非敏感 profile 元数据；key 始终在 secretStorage，符合现有安全模型。

## Migration Path

1. 解析层给 settings 增加 providerProfiles（缺失=空）。
2. main.ts onload 检测空 profiles → 用旧字段 + 旧 key 迁移出「默认」profile。
3. 之后所有 provider 读取走活动 profile。旧字段保留但不再是真相源。

## Open Questions

无。SecretStorage 多 ID 已由类型确认（setSecret/getSecret/listSecrets）。
