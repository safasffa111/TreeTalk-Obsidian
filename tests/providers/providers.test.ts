import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../../src/providers/anthropic-provider";
import { DeepSeekProvider } from "../../src/providers/deepseek-provider";
import { GeminiProvider } from "../../src/providers/gemini-provider";
import { OpenAiProvider } from "../../src/providers/openai-provider";
import type { ProviderInput, ProviderProfile } from "../../src/providers/types";

const INPUT: ProviderInput = {
  messages: [
    { role: "system", content: "Be precise" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" }
  ],
  model: "model-1",
  stream: true,
  cacheKey: "treetalk-session"
};

function profile(kind: ProviderProfile["kind"]): ProviderProfile {
  return {
    id: kind,
    name: kind,
    kind,
    apiKey: "secret",
    baseUrl: ""
  };
}

describe("provider request adapters", () => {
  it("builds an OpenAI chat completion request", () => {
    const request = new OpenAiProvider().buildRequest(INPUT, profile("openai"));
    expect(request.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(request.headers.Authorization).toBe("Bearer secret");
    expect(request.body).toMatchObject({
      model: "model-1",
      stream: true,
      stream_options: { include_usage: true },
      prompt_cache_key: "treetalk-session"
    });
  });


  it("uses the official DeepSeek Anthropic transport without enabling web search", () => {
    const request = new DeepSeekProvider().buildRequest(
      { ...INPUT, model: "deepseek-v4-flash" },
      profile("deepseek")
    );
    expect(request.url).toBe("https://api.deepseek.com/anthropic/v1/messages");
    expect(request.responseFormat).toBe("anthropic");
    expect(request.body).toMatchObject({
      model: "deepseek-v4-flash",
      stream: true,
      system: "Be precise"
    });
    expect(request.body).not.toHaveProperty("tools");
    expect(request.body).not.toHaveProperty("tool_choice");
    expect(request.body).not.toHaveProperty("prompt_cache_key");
  });

  it("keeps the official DeepSeek Anthropic transport after web search is disabled", () => {
    const provider = new DeepSeekProvider();
    const deepseekProfile = profile("deepseek");
    deepseekProfile.baseUrl = "https://api.deepseek.com/anthropic";

    const online = provider.buildRequest(
      { ...INPUT, model: "deepseek-v4-flash", webSearchEnabled: true },
      deepseekProfile
    );
    const offline = provider.buildRequest(
      { ...INPUT, model: "deepseek-v4-flash", webSearchEnabled: false },
      deepseekProfile
    );

    expect(online.url).toBe("https://api.deepseek.com/anthropic/v1/messages");
    expect(offline.url).toBe("https://api.deepseek.com/anthropic/v1/messages");
    expect(offline.responseFormat).toBe("anthropic");
    expect(offline.body).not.toHaveProperty("tools");
    expect(offline.body).not.toHaveProperty("tool_choice");
  });

  it("canonicalizes official DeepSeek base URL variants", () => {
    const provider = new DeepSeekProvider();
    for (const baseUrl of [
      "https://api.deepseek.com",
      "https://api.deepseek.com/v1",
      "https://api.deepseek.com/chat/completions",
      "https://api.deepseek.com/anthropic/v1/messages"
    ]) {
      const current = profile("deepseek");
      current.baseUrl = baseUrl;
      const request = provider.buildRequest(
        { ...INPUT, model: "deepseek-v4-flash", webSearchEnabled: false },
        current
      );
      expect(request.url).toBe("https://api.deepseek.com/anthropic/v1/messages");
    }
  });

  it("preserves an OpenAI-compatible custom DeepSeek endpoint when web search is off", () => {
    const custom = profile("deepseek");
    custom.baseUrl = "https://proxy.example.test/v1";
    const request = new DeepSeekProvider().buildRequest(
      { ...INPUT, model: "deepseek-v4-flash", webSearchEnabled: false },
      custom
    );
    expect(request.url).toBe("https://proxy.example.test/v1/chat/completions");
    expect(request.responseFormat).toBe("openai");
  });

  it("builds a DeepSeek Anthropic request with native web search", () => {
    const request = new DeepSeekProvider().buildRequest(
      {
        ...INPUT,
        model: "deepseek-v4-flash",
        webSearchEnabled: true
      },
      profile("deepseek")
    );

    expect(request.url).toBe("https://api.deepseek.com/anthropic/v1/messages");
    expect(request.responseFormat).toBe("anthropic");
    expect(request.headers["x-api-key"]).toBe("secret");
    expect(request.headers.Authorization).toBeUndefined();
    expect(request.body).toMatchObject({
      model: "deepseek-v4-flash",
      system: "Be precise",
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 5
        }
      ],
      tool_choice: { type: "auto" },
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [{ type: "text", text: "hi" }] }
      ]
    });
  });

  it("maps normalized messages to Anthropic content blocks", () => {
    const request = new AnthropicProvider().buildRequest(INPUT, profile("anthropic"));
    expect(request.body.system).toBe("Be precise");
    expect(request.body).toMatchObject({
      system: "Be precise",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }]
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "hi" }]
        }
      ]
    });
  });

  it("maps normalized messages to Gemini contents", () => {
    const request = new GeminiProvider().buildRequest(INPUT, profile("gemini"));
    expect(request.url).toContain("models/model-1:streamGenerateContent");
    expect(request.body.systemInstruction).toEqual({
      parts: [{ text: "Be precise" }]
    });
    expect(request.body).toMatchObject({
      contents: [
        { role: "user", parts: [{ text: "hello" }] },
        { role: "model", parts: [{ text: "hi" }] }
      ]
    });
  });

  it("uses an OpenAI-compatible custom base URL", () => {
    const custom = profile("openai-compatible");
    custom.baseUrl = "https://example.test/v1/";
    const request = new OpenAiProvider().buildRequest(INPUT, custom);
    expect(request.url).toBe("https://example.test/v1/chat/completions");
    expect(request.body).not.toHaveProperty("stream_options");
    expect(request.body).not.toHaveProperty("prompt_cache_key");
  });

  it("disables DeepSeek thinking for small node-summary requests", () => {
    const request = new DeepSeekProvider().buildRequest(
      {
        ...INPUT,
        model: "deepseek-v4-flash",
        stream: false,
        maxOutputTokens: 64,
        thinkingEnabled: false
      },
      profile("deepseek")
    );
    expect(request.body).toMatchObject({
      max_tokens: 64,
      thinking: { type: "disabled" }
    });
  });

  it("maps a 32-token summary cap without changing normal requests", () => {
    const summary = { ...INPUT, stream: false, maxOutputTokens: 32 };
    expect(
      new OpenAiProvider().buildRequest(summary, profile("openai")).body
    ).toMatchObject({ max_tokens: 32 });
    expect(
      new AnthropicProvider().buildRequest(summary, profile("anthropic")).body
    ).toMatchObject({ max_tokens: 32 });
    expect(
      new DeepSeekProvider().buildRequest(
        { ...summary, model: "deepseek-v4-flash" },
        profile("deepseek")
      ).body
    ).toMatchObject({ max_tokens: 32 });
    expect(
      new GeminiProvider().buildRequest(summary, profile("gemini")).body
    ).toMatchObject({ generationConfig: { maxOutputTokens: 32 } });
    expect(
      new OpenAiProvider().buildRequest(
        { messages: INPUT.messages, model: INPUT.model, stream: false },
        profile("openai")
      ).body
    ).not.toHaveProperty("max_tokens");
  });

});
