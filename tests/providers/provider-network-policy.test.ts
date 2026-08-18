import { describe, expect, it } from "vitest";
import {
  effectiveStreamingOutputEnabled,
  isOfficialMiniMaxAnthropicEndpoint,
  requiresBufferedTransport
} from "../../src/providers/provider-network-policy";
import type { ProviderProfile } from "../../src/providers/types";

function profile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: "default",
    name: "test",
    kind: "anthropic",
    apiKey: "k",
    baseUrl: "https://api.minimaxi.com/anthropic",
    ...overrides
  };
}

describe("provider-network-policy - requiresBufferedTransport", () => {
  it("returns true for the official MiniMax Anthropic endpoint", () => {
    expect(requiresBufferedTransport(profile())).toBe(true);
  });

  it("is case-insensitive on the hostname", () => {
    expect(requiresBufferedTransport(profile({ baseUrl: "https://API.MiniMaxi.com/anthropic" }))).toBe(true);
    expect(requiresBufferedTransport(profile({ baseUrl: "https://API.MiniMaxi.COM/ANTHROPIC" }))).toBe(true);
  });

  it("tolerates trailing slash and any path under /anthropic", () => {
    expect(requiresBufferedTransport(profile({ baseUrl: "https://api.minimaxi.com/anthropic/" }))).toBe(true);
    expect(requiresBufferedTransport(profile({ baseUrl: "https://api.minimaxi.com/anthropic/v1/messages" }))).toBe(true);
  });

  it("returns false for non-anthropic MiniMax traffic (custom proxy / openai-compatible)", () => {
    expect(requiresBufferedTransport(profile({ kind: "openai-compatible", baseUrl: "https://api.minimaxi.com/v1" }))).toBe(false);
    expect(requiresBufferedTransport(profile({ kind: "openai", baseUrl: "https://api.minimaxi.com/v1" }))).toBe(false);
  });

  it("returns false for DeepSeek and Anthropic official (CORS allowed)", () => {
    expect(requiresBufferedTransport(profile({ kind: "deepseek", baseUrl: "https://api.deepseek.com" }))).toBe(false);
    expect(requiresBufferedTransport(profile({ kind: "anthropic", baseUrl: "https://api.anthropic.com" }))).toBe(false);
  });

  it("returns false for a MiniMax-shaped hostname on a custom CORS proxy", () => {
    // User pointed MiniMax at a CORS proxy due to the official endpoint's
    // missing Access-Control-Allow-Headers. Browsing streaming now works.
    expect(requiresBufferedTransport(profile({ baseUrl: "https://my-proxy.example.com/anthropic" }))).toBe(false);
    expect(requiresBufferedTransport(profile({ baseUrl: "https://api.minimaxi.com.proxy.example.com/anthropic" }))).toBe(false);
  });

  it("returns false for an illegal / empty / malformed baseUrl (fail open)", () => {
    expect(requiresBufferedTransport(profile({ baseUrl: "not a url" }))).toBe(false);
    expect(requiresBufferedTransport(profile({ baseUrl: "" }))).toBe(false);
    expect(requiresBufferedTransport(profile({ baseUrl: "javascript:alert(1)" }))).toBe(false);
  });

  it("exports the same predicate as a standalone helper for clarity", () => {
    expect(isOfficialMiniMaxAnthropicEndpoint("https://api.minimaxi.com/anthropic")).toBe(true);
    expect(isOfficialMiniMaxAnthropicEndpoint("https://api.minimaxi.com/anthropic/v1/messages")).toBe(true);
    expect(isOfficialMiniMaxAnthropicEndpoint("https://api.minimaxi.com/v1")).toBe(false);
    expect(isOfficialMiniMaxAnthropicEndpoint("https://api.anthropic.com")).toBe(false);
    expect(isOfficialMiniMaxAnthropicEndpoint("not a url")).toBe(false);
  });
});

describe("provider-network-policy - effectiveStreamingOutputEnabled", () => {
  it("passes through the configured value when the profile does not require buffered", () => {
    const deepseek = profile({ kind: "deepseek", baseUrl: "https://api.deepseek.com" });
    const anthropic = profile({ kind: "anthropic", baseUrl: "https://api.anthropic.com" });
    expect(effectiveStreamingOutputEnabled(true, deepseek)).toBe(true);
    expect(effectiveStreamingOutputEnabled(true, anthropic)).toBe(true);
    expect(effectiveStreamingOutputEnabled(false, deepseek)).toBe(false);
    expect(effectiveStreamingOutputEnabled(false, anthropic)).toBe(false);
  });

  it("forces streaming off for the official MiniMax Anthropic endpoint regardless of user toggle", () => {
    const minimax = profile();
    expect(effectiveStreamingOutputEnabled(true, minimax)).toBe(false);
    expect(effectiveStreamingOutputEnabled(false, minimax)).toBe(false);
  });

  it("does not flip the user toggle when the profile is a non-official MiniMax proxy", () => {
    const proxy = profile({ baseUrl: "https://my-proxy.example.com/anthropic" });
    expect(effectiveStreamingOutputEnabled(true, proxy)).toBe(true);
    expect(effectiveStreamingOutputEnabled(false, proxy)).toBe(false);
  });
});
