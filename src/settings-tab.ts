import {
  PluginSettingTab,
  type App,
  type Plugin,
  type SettingDefinitionItem
} from "obsidian";
import {
  DEFAULT_SETTINGS,
  type RelatedNoteDepth,
  type TreeTalkSettings
} from "./tabs/plugin-data";
import {
  getProviderPreset,
  PROVIDER_PRESETS,
  validateBaseUrl
} from "./providers/presets";
import {
  addProviderProfile,
  deleteProviderProfile,
  profileSecretId,
  renameProviderProfile,
  resolveActiveProfile,
  switchActiveProfile,
  switchProfileProvider,
  type ProviderProfileConfig,
  type ProviderProfilesState
} from "./providers/provider-profiles";
import { Notice } from "obsidian";

function settingsProfile(settings: TreeTalkSettings): ProviderProfileConfig {
  const legacy: ProviderProfileConfig = {
    id: "legacy-fallback",
    label: "默认",
    provider: settings.provider,
    model: settings.model,
    baseUrl: settings.baseUrl
  };
  return resolveActiveProfile(settings.providerProfiles, legacy);
}

function profileState(settings: TreeTalkSettings): ProviderProfilesState {
  return settings.providerProfiles ?? { activeProfileId: null, profiles: [] };
}

function providerOptions(): Record<string, string> {
  const options: Record<string, string> = {};
  for (const preset of Object.values(PROVIDER_PRESETS)) {
    options[preset.key] = preset.name;
  }
  return options;
}

/** Minimal surface of TreeTalkPlugin consumed by the settings tab. */
export interface TreeTalkSettingsPort {
  getSettings(): TreeTalkSettings;
  updateSettings(next: TreeTalkSettings): Promise<void>;
  getApiKey(): string;
  setApiKey(value: string): void;
  clearProfileSecret(profileId: string): void;
  subscribeWebSearch(listener: () => void): () => void;
  subscribeComposerControls(listener: () => void): () => void;
}

const DEPTH_OPTIONS = {
  "1": "1 层",
  "2": "2 层",
  "3": "3 层",
  "5": "5 层",
  "10": "10 层",
  custom: "自定义",
  unlimited: "无限"
} as const;

type DepthMode = keyof typeof DEPTH_OPTIONS;

function relatedNoteDepthMode(value: RelatedNoteDepth): DepthMode {
  if (value === "unlimited") return "unlimited";
  if (value === 1 || value === 2 || value === 3 || value === 5 || value === 10) {
    return String(value) as DepthMode;
  }
  return "custom";
}

/**
 * Declarative settings tab (Obsidian 1.13+). Returning a non-empty
 * getSettingDefinitions() makes the tab render declaratively, keeps settings
 * searchable, and replaces the imperative display() path.
 */
export class TreeTalkSettingTab extends PluginSettingTab {
  private readonly unsubscribeWebSearch: () => void;
  private readonly unsubscribeComposerControls: () => void;

  constructor(
    app: App,
    private readonly plugin: TreeTalkSettingsPort & Plugin
  ) {
    super(app, plugin);
    // External state changes (composer buttons) need a full re-render so
    // control values and disabled/visible predicates stay in sync.
    this.unsubscribeWebSearch = plugin.subscribeWebSearch(() => this.update());
    this.unsubscribeComposerControls = plugin.subscribeComposerControls(() =>
      this.update()
    );
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        type: "group",
        heading: "通用",
        items: [
          {
            name: "上下文发散",
            desc: "开启后，Pi 可在当前权限范围内跨级请求可用上下文；关闭时按相邻层级扩展。",
            control: { type: "toggle", key: "contextDivergenceEnabled" }
          },
          {
            name: "流式输出",
            desc:
              "开启后回答会边生成边显示；关闭后等待完整回答后一次性显示。" +
              "注：MiniMax 官方 Anthropic 端点（api.minimaxi.com/anthropic）" +
              "因 Obsidian CORS 限制会自动改用非流式 buffered 模式回答；" +
              "切回 DeepSeek 等其他供应商时仍按本开关生效。",
            control: { type: "toggle", key: "streamingOutputEnabled" }
          },
          {
            name: "回答思考模式",
            desc: "控制 DeepSeek 是否启用思考；输入框按钮与此处实时同步。",
            control: { type: "toggle", key: "answerThinkingEnabled" }
          }
        ]
      },
      {
        type: "group",
        heading: "模型 API",
        items: [
          {
            name: "活动配置档",
            desc: "切换后供应商、模型、API 地址和 API Key 一起切换。",
            control: {
              type: "dropdown",
              key: "activeProfileId",
              options: Object.fromEntries(profileState(this.plugin.getSettings()).profiles.map((profile) => [profile.id, profile.label]))
            }
          },
          {
            name: "配置档名称",
            desc: "编辑只影响当前活动配置档的显示名称；空值会自动归一为「未命名配置档」。",
            render: (setting) => {
              setting.addText((text) => {
                const profile = settingsProfile(this.plugin.getSettings());
                text
                  .setValue(profile.label)
                  .setPlaceholder("未命名配置档")
                  .onChange(async (value) => {
                    const settings = this.plugin.getSettings();
                    const state = profileState(settings);
                    const next = renameProviderProfile(state, settingsProfile(settings).id, value);
                    if (next === state) return;
                    await this.plugin.updateSettings({ ...settings, providerProfiles: next });
                    this.update();
                  });
              });
            }
          },
          {
            name: "新增配置档",
            render: (setting) => {
              setting.addButton((button) => button.setButtonText("新增").onClick(async () => {
                const settings = this.plugin.getSettings();
                const state = profileState(settings);
                const seed = settingsProfile(settings);
                const next = addProviderProfile(state, {
                  id: crypto.randomUUID(),
                  provider: seed.provider,
                  model: seed.model,
                  baseUrl: seed.baseUrl
                });
                await this.plugin.updateSettings({ ...settings, providerProfiles: next });
                this.update();
              }));
            }
          },
          {
            name: "删除当前配置档",
            desc: "至少保留一个配置档。",
            render: (setting) => {
              setting.addButton((button) => button.setButtonText("删除").onClick(async () => {
                const settings = this.plugin.getSettings();
                const state = profileState(settings);
                if (state.profiles.length <= 1) { new Notice("至少保留一个配置档"); return; }
                const current = settingsProfile(settings);
                const { state: nextState, removedSecretId } = deleteProviderProfile(state, current.id);
                if (nextState === state) return;
                if (removedSecretId !== null) {
                  try {
                    this.plugin.clearProfileSecret(current.id);
                  } catch {
                    // Settings tab is intentionally permissive: a stale secret is
                    // safe — main.ts only reads the active profile's secret.
                  }
                }
                await this.plugin.updateSettings({ ...settings, providerProfiles: nextState });
                this.update();
              }));
            }
          },
          {
            name: "供应商",
            desc: "选择模型供应商；切换后请在下方填写对应模型与 API Key。",
            control: {
              type: "dropdown",
              key: "provider",
              options: providerOptions()
            }
          },
          {
            name: "模型",
            desc: (() => {
              const preset = getProviderPreset(
                settingsProfile(this.plugin.getSettings()).provider
              );
              const models = preset?.models ?? [];
              return models.length > 0
                ? `建议：${models.join(" / ")}`
                : "填写供应商支持的模型 ID";
            })(),
            control: { type: "text", key: "model" }
          },
          {
            name: "API 地址",
            desc: "留空使用供应商官方地址；自定义地址必须使用 https",
            control: {
              type: "text",
              key: "baseUrl",
              placeholder: (() => {
                const preset = getProviderPreset(
                  settingsProfile(this.plugin.getSettings()).provider
                );
                return preset?.baseUrl !== undefined &&
                  preset.baseUrl.length > 0
                  ? preset.baseUrl
                  : "https://…";
              })()
            }
          },
          {
            name: "API Key",
            render: (setting) => {
              setting.addText((text) => {
                text.inputEl.type = "password";
                text
                  .setValue(this.plugin.getApiKey())
                  .onChange((value) => this.plugin.setApiKey(value));
              });
            }
          },
          {
            name: "Obsidian Markdown 兼容模式",
            desc: "约束 AI 输出格式、保护流式未闭合语法，并在完成后保守规范化",
            control: { type: "toggle", key: "obsidianMarkdownCompatibility" }
          },
          {
            name: "联网模式",
            desc: "开启后，DeepSeek 会根据问题自动判断是否需要搜索网页。仅 DeepSeek 支持。",
            control: {
              type: "toggle",
              key: "webSearchEnabled",
              disabled: () => {
                const preset = getProviderPreset(
                  settingsProfile(this.plugin.getSettings()).provider
                );
                return preset?.supportsWebSearch !== true;
              }
            }
          }
        ]
      },
      {
        type: "group",
        heading: "关联笔记",
        items: [
          {
            name: "关联笔记上下文",
            desc: "沿笔记中的正向和反向内部链接读取关联笔记。两种方向享有相同的读取、递归和上下文优先级，并发送按路径去重、保留真实链接方向的关联图。输入框按钮与此处实时同步。",
            control: { type: "toggle", key: "relatedNoteContextEnabled" }
          },
          {
            name: "关联笔记深度",
            desc: "当前框选笔记为第 0 层。无限模式会读取所有通过正向或反向链接可达的 Markdown 笔记，并自动处理循环和重复节点。",
            control: {
              type: "dropdown",
              key: "relatedNoteDepthMode",
              options: { ...DEPTH_OPTIONS },
              disabled: () =>
                !this.plugin.getSettings().relatedNoteContextEnabled
            }
          },
          {
            name: "自定义深度",
            control: {
              type: "number",
              key: "relatedNoteDepthCustom",
              min: 1,
              step: 1,
              placeholder: "自定义深度",
              disabled: () =>
                !this.plugin.getSettings().relatedNoteContextEnabled,
              validate: (value) =>
                Number.isInteger(value) && value >= 1
                  ? undefined
                  : "深度必须是不小于 1 的整数"
            },
            visible: () =>
              relatedNoteDepthMode(
                this.plugin.getSettings().relatedNoteDepth
              ) === "custom"
          }
        ]
      },
      {
        type: "group",
        heading: "知识沉淀",
        items: [
          {
            name: "知识沉淀文件夹",
            desc: "单个回答将保存为可自由编辑的纯 Markdown 笔记",
            control: {
              type: "text",
              key: "knowledgeFolder",
              placeholder: "TreeTalk 知识"
            }
          },
          {
            name: "沉淀对话树目录",
            desc: "每次沉淀会在该目录中创建纯 Markdown 对话树文件夹",
            control: {
              type: "text",
              key: "treeCaptureFolder",
              placeholder: "TreeTalk"
            }
          }
        ]
      }
    ];
  }

  getControlValue(key: string): unknown {
    const settings = this.plugin.getSettings();
    const profile = settingsProfile(settings);
    switch (key) {
      case "contextDivergenceEnabled":
        return settings.contextDivergenceEnabled;
      case "streamingOutputEnabled":
        return settings.streamingOutputEnabled;
      case "answerThinkingEnabled":
        return settings.answerThinkingMode === "enabled";
      case "activeProfileId":
        return profileState(settings).activeProfileId;
      case "profileLabel":
        return profile.label;
      case "provider":
        return profile.provider;
      case "model":
        return profile.model;
      case "baseUrl":
        return profile.baseUrl;
      case "apiKey":
        return this.plugin.getApiKey();
      case "obsidianMarkdownCompatibility":
        return settings.obsidianMarkdownCompatibility;
      case "webSearchEnabled":
        return settings.webSearchEnabled;
      case "relatedNoteContextEnabled":
        return settings.relatedNoteContextEnabled;
      case "relatedNoteDepthMode":
        return relatedNoteDepthMode(settings.relatedNoteDepth);
      case "relatedNoteDepthCustom":
        return typeof settings.relatedNoteDepth === "number"
          ? settings.relatedNoteDepth
          : 1;
      case "knowledgeFolder":
        return settings.knowledgeFolder;
      case "treeCaptureFolder":
        return settings.treeCaptureFolder;
      default:
        return undefined;
    }
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.plugin.getSettings();
    const profile = settingsProfile(settings);
    const state = profileState(settings);
    switch (key) {
      case "contextDivergenceEnabled":
        await this.plugin.updateSettings({
          ...settings,
          contextDivergenceEnabled: Boolean(value)
        });
        break;
      case "streamingOutputEnabled":
        await this.plugin.updateSettings({
          ...settings,
          streamingOutputEnabled: Boolean(value)
        });
        break;
      case "answerThinkingEnabled":
        await this.plugin.updateSettings({
          ...settings,
          answerThinkingMode: value ? "enabled" : "disabled"
        });
        break;
      case "activeProfileId": {
        const next = switchActiveProfile(state, String(value));
        if (next === state) break;
        await this.plugin.updateSettings({ ...settings, providerProfiles: next });
        this.update();
        break;
      }
      case "profileLabel": {
        const next = renameProviderProfile(state, profile.id, String(value));
        if (next === state) break;
        await this.plugin.updateSettings({ ...settings, providerProfiles: next });
        this.update();
        break;
      }
      case "provider": {
        const nextProvider = String(value);
        const next = switchProfileProvider(state, nextProvider);
        if (next === state) break;
        const nextProfile = next.profiles.find((item) => item.id === profile.id) ?? profile;
        await this.plugin.updateSettings({
          ...settings,
          providerProfiles: next,
          provider: nextProfile.provider,
          model: nextProfile.model,
          baseUrl: nextProfile.baseUrl
        });
        this.update();
        break;
      }
      case "model": {
        const model = String(value).trim();
        const profiles = state.profiles.map((item) => item.id === profile.id ? { ...item, model } : item);
        await this.plugin.updateSettings({
          ...settings,
          providerProfiles: { ...state, profiles },
          model
        });
        break;
      }
      case "baseUrl": {
        const nextBaseUrl = String(value);
        const validation = validateBaseUrl(nextBaseUrl);
        if (!validation.ok) {
          new Notice(`API 地址无效：${validation.reason ?? "格式错误"}`);
          this.update();
          break;
        }
        if (validation.warning !== undefined) {
          new Notice(validation.warning);
        }
        const profiles = state.profiles.map((item) => item.id === profile.id ? { ...item, baseUrl: nextBaseUrl } : item);
        await this.plugin.updateSettings({
          ...settings,
          providerProfiles: { ...state, profiles },
          baseUrl: nextBaseUrl
        });
        break;
      }
      case "apiKey":
        this.plugin.setApiKey(String(value));
        break;
      case "obsidianMarkdownCompatibility":
        await this.plugin.updateSettings({
          ...settings,
          obsidianMarkdownCompatibility: Boolean(value)
        });
        break;
      case "webSearchEnabled":
        await this.plugin.updateSettings({
          ...settings,
          webSearchEnabled: Boolean(value)
        });
        break;
      case "relatedNoteContextEnabled":
        await this.plugin.updateSettings({
          ...settings,
          relatedNoteContextEnabled: Boolean(value)
        });
        break;
      case "relatedNoteDepthMode": {
        const mode = String(value);
        if (mode === "unlimited") {
          await this.plugin.updateSettings({
            ...settings,
            relatedNoteDepth: "unlimited"
          });
        } else if (mode !== "custom") {
          const parsed = Number.parseInt(mode, 10);
          if (Number.isInteger(parsed) && parsed >= 1) {
            await this.plugin.updateSettings({
              ...settings,
              relatedNoteDepth: parsed
            });
          }
        }
        this.refreshDomState();
        break;
      }
      case "relatedNoteDepthCustom": {
        const parsed = Number.parseInt(String(value), 10);
        if (Number.isInteger(parsed) && parsed >= 1) {
          await this.plugin.updateSettings({
            ...settings,
            relatedNoteDepth: parsed
          });
        }
        break;
      }
      case "knowledgeFolder": {
        const trimmed = String(value).trim();
        await this.plugin.updateSettings({
          ...settings,
          knowledgeFolder:
            trimmed.length > 0 ? trimmed : DEFAULT_SETTINGS.knowledgeFolder
        });
        break;
      }
      case "treeCaptureFolder": {
        const trimmed = String(value).trim();
        await this.plugin.updateSettings({
          ...settings,
          treeCaptureFolder:
            trimmed.length > 0 ? trimmed : DEFAULT_SETTINGS.treeCaptureFolder
        });
        break;
      }
      default:
        break;
    }
  }

  hide(): void {
    this.unsubscribeWebSearch();
    this.unsubscribeComposerControls();
  }
}

/** Re-exported for tests and for callers that need the same secret id shape. */
export { profileSecretId };