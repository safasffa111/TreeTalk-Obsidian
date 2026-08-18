import { describe, expect, it } from "vitest";
import {
  kindForWire,
  normalizeProviderKey,
  PROVIDER_PRESETS,
  resolveProfile,
  validateBaseUrl
} from "../../src/providers/presets";

describe("provider presets catalog", () => {
  it("maps every preset wire format onto an existing adapter kind", () => {
    const validKinds = new Set([
      "openai",
      "openai-compatible",
      "deepseek",
      "anthropic",
      "gemini"
    ]);
    for (const preset of Object.values(PROVIDER_PRESETS)) {
      const official = preset.key === "openai";
      const kind = kindForWire(preset.wire, official);
      expect(validKinds.has(kind)).toBe(true);
    }
  });

  it("includes all first-batch providers", () => {
    for (const key of [
      "deepseek",
      "zhipu",
      "minimax",
      "openrouter",
      "kimi",
      "siliconflow",
      "dashscope",
      "openai",
      "anthropic",
      "gemini"
    ]) {
      expect(PROVIDER_PRESETS[key]).toBeDefined();
    }
  });

  it("resolves aliases to canonical keys", () => {
    expect(normalizeProviderKey("glm")).toBe("zhipu");
    expect(normalizeProviderKey("moonshot")).toBe("kimi");
    expect(normalizeProviderKey("qwen")).toBe("dashscope");
    expect(normalizeProviderKey("claude")).toBe("anthropic");
    expect(normalizeProviderKey("DeepSeek")).toBe("deepseek");
  });

  it("only DeepSeek advertises web search", () => {
    const webCapable = Object.values(PROVIDER_PRESETS)
      .filter((preset) => preset.supportsWebSearch)
      .map((preset) => preset.key);
    expect(webCapable).toEqual(["deepseek"]);
  });
});

describe("resolveProfile", () => {
  it("resolves zhipu to an openai-compatible endpoint", () => {
    const profile = resolveProfile({
      provider: "zhipu",
      model: "glm-4.6",
      baseUrl: "",
      apiKey: "k"
    });
    expect(profile.kind).toBe("openai-compatible");
    expect(profile.baseUrl).toBe("https://open.bigmodel.cn/api/paas/v4");
  });

  it("resolves official OpenAI to the openai kind", () => {
    const profile = resolveProfile({
      provider: "openai",
      model: "gpt-4o",
      baseUrl: "",
      apiKey: "k"
    });
    expect(profile.kind).toBe("openai");
  });

  it("resolves DeepSeek to its dedicated adapter kind", () => {
    expect(
      resolveProfile({
        provider: "deepseek",
        model: "deepseek-v4-flash",
        baseUrl: "",
        apiKey: "secret"
      }).kind
    ).toBe("deepseek");
  });

  it("resolves minimax and anthropic to the anthropic wire kind", () => {
    expect(
      resolveProfile({ provider: "minimax", model: "MiniMax-M2", baseUrl: "", apiKey: "secret" }).kind
    ).toBe("anthropic");
    expect(
      resolveProfile({ provider: "claude", model: "x", baseUrl: "", apiKey: "secret" }).kind
    ).toBe("anthropic");
  });

  it("honors a user baseUrl override", () => {
    const profile = resolveProfile({
      provider: "deepseek",
      model: "deepseek-chat",
      baseUrl: "https://proxy.example.com",
      apiKey: "k"
    });
    expect(profile.baseUrl).toBe("https://proxy.example.com");
  });

  it("passes unknown providers through as a custom openai-compatible endpoint", () => {
    const profile = resolveProfile({
      provider: "my-local-llm",
      model: "x",
      baseUrl: "https://localhost:1234/v1",
      apiKey: "k"
    });
    expect(profile.kind).toBe("openai-compatible");
    expect(profile.baseUrl).toBe("https://localhost:1234/v1");
  });

  it("carries the API key onto the profile", () => {
    expect(
      resolveProfile({ provider: "openai", model: "gpt-4o", baseUrl: "", apiKey: "secret" }).apiKey
    ).toBe("secret");
  });
});

describe("validateBaseUrl", () => {
  it("allows empty (falls back to preset)", () => {
    expect(validateBaseUrl("")).toEqual({ ok: true });
  });

  it("accepts https", () => {
    expect(validateBaseUrl("https://api.example.com").ok).toBe(true);
  });

  it("rejects plaintext remote http", () => {
    const result = validateBaseUrl("http://api.example.com");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/https/u);
  });

  it("allows loopback http with a plaintext warning", () => {
    const result = validateBaseUrl("http://localhost:1234/v1");
    expect(result.ok).toBe(true);
    expect(result.warning).toBeDefined();
  });

  it("rejects embedded credentials", () => {
    const result = validateBaseUrl("https://user:pass@api.example.com");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/用户名|密码/u);
  });

  it("rejects a non-URL string", () => {
    expect(validateBaseUrl("not a url").ok).toBe(false);
  });
});
