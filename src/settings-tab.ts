import {
  PluginSettingTab,
  type App,
  type Plugin,
  type SettingDefinitionItem
} from "obsidian";
import {
  DEFAULT_SETTINGS,
  normalizeConfiguredModel,
  type RelatedNoteDepth,
  type TreeTalkSettings
} from "./tabs/plugin-data";

/** Minimal surface of TreeTalkPlugin consumed by the settings tab. */
export interface TreeTalkSettingsPort {
  getSettings(): TreeTalkSettings;
  updateSettings(next: TreeTalkSettings): Promise<void>;
  getApiKey(): string;
  setApiKey(value: string): void;
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
    this.unsubscribeComposerControls = plugin.subscribeComposerControls(() => {
      // Re-rendering while a multi-line control has focus would drop the caret,
      // so a settings change typed into the default prompt keeps its input
      // untouched and only refreshes the other controls afterwards.
      const active = this.containerEl.ownerDocument.activeElement;
      if (
        active instanceof HTMLTextAreaElement &&
        this.containerEl.contains(active)
      ) {
        return;
      }
      this.update();
    });
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
            desc: "开启后回答会边生成边显示；关闭后等待完整回答后一次性显示。",
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
        heading: "提示词",
        items: [
          {
            name: "默认提示词",
            desc: "填写后会作为系统指令附加到每次提问。留空则等同于未配置；聊天输入框右下角的小按钮可随时开关。",
            control: {
              type: "textarea",
              key: "defaultPrompt",
              rows: 5,
              placeholder: "例如：请用中文回答，先给结论，再列出可执行步骤。"
            }
          },
          {
            name: "启用默认提示词",
            desc: "关闭后即使已填写默认提示词，也不会随提问发送。与输入框按钮实时同步。",
            control: {
              type: "toggle",
              key: "defaultPromptEnabled",
              disabled: () =>
                this.plugin.getSettings().defaultPrompt.trim().length === 0
            }
          }
        ]
      },
      {
        type: "group",
        heading: "DeepSeek API",
        items: [
          {
            name: "模型",
            control: { type: "text", key: "model" }
          },
          {
            name: "API 地址",
            desc: "留空使用 DeepSeek 官方地址",
            control: {
              type: "text",
              key: "baseUrl",
              placeholder: "留空使用 DeepSeek 官方地址"
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
            desc: "开启后，DeepSeek 会根据问题自动判断是否需要搜索网页。当前仅支持 DeepSeek。",
            control: {
              type: "toggle",
              key: "webSearchEnabled",
              disabled: () =>
                this.plugin.getSettings().provider !== "deepseek"
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
    switch (key) {
      case "contextDivergenceEnabled":
        return settings.contextDivergenceEnabled;
      case "streamingOutputEnabled":
        return settings.streamingOutputEnabled;
      case "answerThinkingEnabled":
        return settings.answerThinkingMode === "enabled";
      case "defaultPrompt":
        return settings.defaultPrompt;
      case "defaultPromptEnabled":
        return settings.defaultPromptEnabled;
      case "model":
        return settings.model;
      case "baseUrl":
        return settings.baseUrl;
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
      case "defaultPrompt":
        await this.plugin.updateSettings({
          ...settings,
          defaultPrompt: String(value)
        });
        break;
      case "defaultPromptEnabled":
        await this.plugin.updateSettings({
          ...settings,
          defaultPromptEnabled: Boolean(value)
        });
        break;
      case "model":
        await this.plugin.updateSettings({
          ...settings,
          model: normalizeConfiguredModel("deepseek", String(value))
        });
        break;
      case "baseUrl":
        await this.plugin.updateSettings({
          ...settings,
          baseUrl: String(value)
        });
        break;
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
