# 任务：多供应商配置档

## 1. 数据模型与迁移（领域层，TDD）

- [x] 1.1 新增 `src/providers/provider-profiles.ts`：`ProviderProfileConfig` / `ProviderProfilesState` 类型，
- [x] 1.2 `plugin-data.ts`：`TreeTalkSettings` 增加 `providerProfiles?: ProviderProfilesState`；
- [x] 1.3 补测试：空 state、含多个 profile、active 指向不存在 id 时的回退。

## 2. 运行期迁移与活动 profile（main.ts，TDD 用可注入的 secret port）

- [x] 2.1 抽一个可测的 secret 访问接口（getSecret/setSecret/listSecrets 的最小封装或直接注入），
- [x] 2.2 onload 迁移：providerProfiles 为空时，用旧字段建「默认」profile，
- [x] 2.3 `activeProfileConfig()` / `getApiKey()` / `currentProviderProfile()` 改为读活动 profile 与其 secret。
- [x] 2.4 发送路径：`webSearchEnabled`（provider==="deepseek"）、`modelId` 改取活动 profile。补测试。

## 3. 设置 UI（settings-tab.ts）

- [x] 3.1 「模型 API」组重构：活动配置档下拉（切换 activeProfileId）、新增配置档、删除当前配置档（至少留一个）。
- [x] 3.2 当前 profile 的 供应商/模型/baseUrl/APIKey 编辑写入活动 profile 与对应 secret；baseUrl 用 validateBaseUrl 校验。
- [x] 3.3 切换/新增/删除后刷新 UI 并持久化。

## 4. 回归与验证

- [x] 4.1 确认 provider wire 路由未改动（DeepSeek chat/completions、MiniMax anthropic 端点、thinking）。
- [x] 4.2 `openspec validate multi-provider-profiles --strict` 通过。
- [x] 4.3 `npm run check` 全绿（vitest+tsc+eslint+build+regression），重新生成 main.js。
- [x] 4.4 README/CHANGELOG 记录多配置档功能与迁移说明。

## 5. TDD evidence（第二轮评审修复）

### 5.1 真实 bug 修复

- [x] 5.1.1 settings-tab 中"模型 desc""API 地址 placeholder""联网模式 disabled"改读 `settingsProfile(settings).provider`，不再读 `settings.provider`。TDD：tests/tabs/settings-tab-profiles.test.ts > "reads provider-specific desc/placeholder/disabled from the active profile, not the legacy top-level field"。
- [x] 5.1.2 删除 profile 后 `await this.plugin.updateSettings(...)` 后立即 `this.update()`，UI 立刻刷新。TDD：同一文件 > "deleting a profile clears its secret and refreshes the UI"。
- [x] 5.1.3 新增 profile 也 `await updateSettings` + `this.update()`，并把 active 指向新档。TDD：同一文件 > "adding a profile makes the new one active and refreshes the UI"。

### 5.2 需求缺口补齐

- [x] 5.2.1 配置档名称：`settings-tab.ts` 新增「配置档名称」text 控件，写活动 profile.label；空值归一为「未命名配置档」。TDD：provider-profiles.test.ts > "renames the active profile and persists to settings"、"normalizes empty rename labels back to the fallback name"；settings-tab-profiles.test.ts > "renames the active profile and refreshes the dropdown options"、"normalizes an empty rename to the default label"。
- [x] 5.2.2 provider 切换归一：`switchProfileProvider` 在 provider 真实变化时使用新 preset.defaultModel 并清空 baseUrl；旧 provider 的非空模型不再串档；未知 custom provider 保留模型但仍清空 baseUrl（行为显式记录）。TDD：provider-profiles.test.ts > "switches provider to a built-in preset using its defaultModel and clears baseUrl"、"does not leak the previous preset's model or baseUrl when switching providers"、"switching provider on an unknown custom key keeps the existing model and clears baseUrl"；settings-tab-profiles.test.ts > "switching provider replaces the model and clears baseUrl with the preset default"、"does not leak the previous preset's model or baseUrl when switching back"。
- [x] 5.2.3 parseProviderProfiles 校验：纯领域 `isValidProfileId`（小写字母数字和连字符，非空）；解析时过滤非法 id 和重复 id（first wins）；label trim 后空值归一为「未命名配置档」；active id 被过滤后回退到第一个有效 id；无 profile 时 active 为 null。TDD：provider-profiles.test.ts > "validates profile ids (lowercase alphanumeric and hyphens, non-empty)"、"filters out profiles with illegal or missing fields"、"de-duplicates profiles that share the same id (first wins)"、"normalizes empty / whitespace labels to the fallback name"、"falls back active id to the first valid profile when the recorded id was filtered out"、"yields null active id when no profiles survive filtering"、"keeps the recorded active id when it points at a valid, surviving profile"。
- [x] 5.2.4 纯函数抽取：`renameProviderProfile` / `addProviderProfile` / `deleteProviderProfile` / `switchActiveProfile` / `switchProfileProvider` 全部落在 `src/providers/provider-profiles.ts`，纯函数、不直接接触 SecretStorage 或 UI；`settings-tab.ts` 只调用它们，再 `await updateSettings` 与 `this.update()`。
- [x] 5.2.5 删除 profile 清 secret：`provider-profiles.ts` 的 `deleteProviderProfile` 返回 `removedSecretId`；`settings-tab.ts` 调用新加的 `plugin.clearProfileSecret(profileId)`；`main.ts` 实现 `clearProfileSecret`（容忍 SecretStorage 无 removeSecret API）。TDD：settings-tab-profiles.test.ts > "deleting a profile clears its secret and refreshes the UI"。

### 5.3 验证

- [x] 5.3.1 `npx vitest run` — 112 个文件 / 709 个测试全过（含本轮新增 34 个测试）。
- [x] 5.3.2 `npm run typecheck` — 0 error。
- [x] 5.3.3 `npm run lint` — 0 warning。
- [x] 5.3.4 `npm run build` — main.js 重新生成。
- [x] 5.3.5 `npm run regression` — 328 个 node 测试全过。
- [x] 5.3.6 `openspec validate multi-provider-profiles --strict` — 通过。
- [x] 5.3.7 provider wire 路由未改动（DeepSeek chat/completions、MiniMax anthropic、thinking adaptive/disabled）。