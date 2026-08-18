# multi-provider-profiles 变更

## ADDED Requirements

### Requirement: 多供应商配置档存储
系统 SHALL 支持保存多个供应商配置档，每档包含名称、供应商 preset、模型、baseUrl，并各自绑定独立的 secret ID。API Key MUST NOT 写入 data.json，只存 Obsidian SecretStorage。

#### Scenario: 保存两个不同供应商配置档
- **WHEN** 用户创建 DeepSeek 与 MiniMax 两个配置档并各填 API Key
- **THEN** 两个 key 分别存于 `treetalk-key-<profileId>`，data.json 中只有非敏感元数据

#### Scenario: 删除配置档清除其密钥
- **WHEN** 用户删除一个配置档
- **THEN** 该档对应的 secret 被清除，且系统至少保留一个配置档

### Requirement: 活动配置档驱动请求
系统 SHALL 以活动配置档的 供应商/模型/baseUrl/key 构造 provider profile 与发送请求。切换活动配置档后，后续请求 MUST 使用新档的全部字段与其独立 key。

#### Scenario: 切换配置档后使用对应 key
- **WHEN** 用户从 DeepSeek 档切换到 MiniMax 档并发送消息
- **THEN** 请求使用 MiniMax 的 baseUrl、模型与 MiniMax 自己的 key，不复用 DeepSeek 的 key

#### Scenario: 活动 id 失效时回退
- **WHEN** activeProfileId 指向不存在的配置档
- **THEN** 系统回退到第一个可用配置档，不崩溃

### Requirement: 旧配置向后兼容迁移
系统 SHALL 在配置档为空时，用旧的单一 provider/model/baseUrl 与 `treetalk-api-key` 自动迁移出一个「默认」配置档，原 key 原样保留。迁移 MUST 幂等，已有配置档时不得覆盖。

#### Scenario: 旧用户首次升级
- **WHEN** 旧版本用户升级后首次加载，providerProfiles 为空
- **THEN** 系统用旧 provider/model/baseUrl 建「默认」档，并把旧 key 复制到该档的 secret ID，用户无需重填

#### Scenario: 已迁移用户再次加载不重复迁移
- **WHEN** 用户已存在至少一个配置档时再次加载
- **THEN** 系统不执行迁移，不覆盖用户已有配置档
