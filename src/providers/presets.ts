import type { ProviderKind, ProviderProfile } from "./types";

/**
 * Provider catalog, modeled on FrameLearn's `llm/catalog.py`:
 * a preset maps a user-facing provider key to a wire format, a default
 * endpoint, alias resolution, suggested models, and capability bits.
 *
 * The wire format is the only thing that selects a request builder, and it
 * always maps onto an existing {@link ProviderKind} adapter — this module
 * never introduces a new protocol, only new endpoints/branding.
 */
export type WireFormat = "openai_chat" | "anthropic" | "deepseek" | "gemini";

export interface ProviderPreset {
  /** Canonical key accepted by settings `provider`. */
  key: string;
  /** Human-facing name for the settings dropdown. */
  name: string;
  wire: WireFormat;
  /** Default API base; user may override via settings `baseUrl`. */
  baseUrl: string;
  /** Alternative keys that resolve to this preset. */
  aliases: readonly string[];
  /** Suggested model ids (datalist hints; free text still allowed). */
  models: readonly string[];
  defaultModel: string;
  /** Pi 引擎联网搜索目前仅 DeepSeek 支持。 */
  supportsWebSearch: boolean;
  /** thinking 模式仅 DeepSeek / Anthropic 协议支持。 */
  supportsThinking: boolean;
}

/**
 * Map a preset wire format onto an existing adapter kind. Official OpenAI is
 * distinguished from compatible endpoints so it can enable usage streaming and
 * prompt caching (see OpenAiProvider).
 */
export function kindForWire(
  wire: WireFormat,
  official: boolean
): ProviderKind {
  if (wire === "deepseek") return "deepseek";
  if (wire === "anthropic") return "anthropic";
  if (wire === "gemini") return "gemini";
  return official ? "openai" : "openai-compatible";
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  deepseek: {
    key: "deepseek",
    name: "DeepSeek",
    wire: "deepseek",
    baseUrl: "https://api.deepseek.com",
    aliases: [],
    models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
    defaultModel: "deepseek-v4-flash",
    supportsWebSearch: true,
    supportsThinking: true
  },
  zhipu: {
    key: "zhipu",
    name: "智谱 GLM",
    wire: "openai_chat",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    aliases: ["glm", "bigmodel", "zhipuai"],
    models: ["glm-4.6", "glm-4.5", "glm-4-plus"],
    defaultModel: "glm-4.6",
    supportsWebSearch: false,
    supportsThinking: false
  },
  minimax: {
    key: "minimax",
    name: "MiniMax",
    wire: "anthropic",
    baseUrl: "https://api.minimaxi.com/anthropic",
    aliases: ["minimaxi", "minimax-anthropic"],
    models: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5", "MiniMax-M2"],
    defaultModel: "MiniMax-M3",
    supportsWebSearch: false,
    supportsThinking: true
  },
  openrouter: {
    key: "openrouter",
    name: "OpenRouter",
    wire: "openai_chat",
    baseUrl: "https://openrouter.ai/api/v1",
    aliases: [],
    models: [
      "anthropic/claude-3.7-sonnet",
      "openai/gpt-4o",
      "google/gemini-2.5-pro"
    ],
    defaultModel: "anthropic/claude-3.7-sonnet",
    supportsWebSearch: false,
    supportsThinking: false
  },
  kimi: {
    key: "kimi",
    name: "Moonshot (Kimi)",
    wire: "openai_chat",
    baseUrl: "https://api.moonshot.cn/v1",
    aliases: ["moonshot"],
    models: ["kimi-k2-0905-preview", "moonshot-v1-128k"],
    defaultModel: "kimi-k2-0905-preview",
    supportsWebSearch: false,
    supportsThinking: false
  },
  siliconflow: {
    key: "siliconflow",
    name: "SiliconFlow",
    wire: "openai_chat",
    baseUrl: "https://api.siliconflow.cn/v1",
    aliases: ["silicon_flow"],
    models: [
      "deepseek-ai/DeepSeek-V3",
      "Qwen/Qwen3-VL-32B-Instruct",
      "moonshotai/Kimi-K2-Instruct"
    ],
    defaultModel: "deepseek-ai/DeepSeek-V3",
    supportsWebSearch: false,
    supportsThinking: false
  },
  dashscope: {
    key: "dashscope",
    name: "阿里云百炼 DashScope",
    wire: "openai_chat",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    aliases: ["qwen", "bailian"],
    models: ["qwen-max", "qwen-plus", "qwen3-max"],
    defaultModel: "qwen-plus",
    supportsWebSearch: false,
    supportsThinking: false
  },
  openai: {
    key: "openai",
    name: "OpenAI",
    wire: "openai_chat",
    baseUrl: "https://api.openai.com/v1",
    aliases: [],
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1"],
    defaultModel: "gpt-4o",
    supportsWebSearch: false,
    supportsThinking: false
  },
  anthropic: {
    key: "anthropic",
    name: "Claude (Anthropic)",
    wire: "anthropic",
    baseUrl: "https://api.anthropic.com",
    aliases: ["claude"],
    models: [
      "claude-3-7-sonnet-latest",
      "claude-3-5-sonnet-latest",
      "claude-3-5-haiku-latest"
    ],
    defaultModel: "claude-3-7-sonnet-latest",
    supportsWebSearch: false,
    supportsThinking: true
  },
  gemini: {
    key: "gemini",
    name: "Google Gemini",
    wire: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    aliases: ["google"],
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
    defaultModel: "gemini-2.5-flash",
    supportsWebSearch: false,
    supportsThinking: false
  },
  "openai-compatible": {
    key: "openai-compatible",
    name: "OpenAI 兼容（自定义端点）",
    wire: "openai_chat",
    baseUrl: "",
    aliases: ["custom", "compatible"],
    models: [],
    defaultModel: "",
    supportsWebSearch: false,
    supportsThinking: false
  }
};

const ALIAS_TO_KEY: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const preset of Object.values(PROVIDER_PRESETS)) {
    for (const alias of preset.aliases) map[alias] = preset.key;
  }
  return map;
})();

/** Canonical provider key for a configured value (key or alias, case-insensitive). */
export function normalizeProviderKey(provider: string): string {
  const value = provider.trim().toLowerCase();
  if (value in PROVIDER_PRESETS) return value;
  return ALIAS_TO_KEY[value] ?? value;
}

export function getProviderPreset(provider: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS[normalizeProviderKey(provider)];
}

/** All accepted provider values (canonical keys plus aliases), for UI listing. */
export function providerDisplayKeys(): string[] {
  return Object.keys(PROVIDER_PRESETS);
}

export interface ResolveProfileInput {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

/**
 * Materialize a {@link ProviderProfile} from settings: resolves the preset,
 * picks the wire adapter kind, and applies the user's baseUrl override (falling
 * back to the preset default). Unknown providers pass through as an
 * openai-compatible custom endpoint so bespoke deployments still work.
 */
export function resolveProfile(input: ResolveProfileInput): ProviderProfile {
  const preset = getProviderPreset(input.provider);
  const trimmedBase = input.baseUrl.trim();
  if (preset === undefined) {
    return {
      id: "default",
      name: input.provider,
      kind: "openai-compatible",
      apiKey: input.apiKey,
      baseUrl: trimmedBase
    };
  }
  const official = preset.key === "openai";
  return {
    id: "default",
    name: preset.name,
    kind: kindForWire(preset.wire, official),
    apiKey: input.apiKey,
    baseUrl: trimmedBase.length > 0 ? trimmedBase : preset.baseUrl
  };
}

export interface BaseUrlValidation {
  ok: boolean;
  reason?: string;
  warning?: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Validate a user-entered base URL. Empty is allowed (falls back to preset).
 * Requires https except for loopback (allowed with a plaintext warning), and
 * rejects embedded credentials.
 */
export function validateBaseUrl(value: string): BaseUrlValidation {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "API 地址不是合法 URL" };
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return { ok: false, reason: "API 地址不得内嵌用户名或密码" };
  }
  const host = url.hostname.toLowerCase();
  const loopback = LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost");
  if (url.protocol === "https:") return { ok: true };
  if (url.protocol === "http:") {
    if (loopback) {
      return {
        ok: true,
        warning: "本地地址使用明文 HTTP，仅建议用于开发调试"
      };
    }
    return { ok: false, reason: "远程 API 地址必须使用 https" };
  }
  return { ok: false, reason: "API 地址必须使用 https" };
}
