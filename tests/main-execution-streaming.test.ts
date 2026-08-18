import { describe, expect, it } from "vitest";
import { resolveExecutionRequestStreaming } from "../src/main";
import {
  resolveProfile,
  type ResolveProfileInput
} from "../src/providers/presets";
import type { ProviderProfile } from "../src/providers/types";

function resolve(
  input: Pick<ResolveProfileInput, "provider" | "model" | "baseUrl">
): ProviderProfile {
  // Mirror main.ts `currentProviderProfile()`: apiKey is filled by the
  // provider-secret lookup at request time; the policy itself must remain
  // pure on the resolved profile shape, so we pass an empty key here.
  return resolveProfile({ ...input, apiKey: "" });
}

describe("main.ts - resolveExecutionRequestStreaming", () => {
  it("keeps streaming on when the global toggle is on and the profile is DeepSeek", () => {
    const profile = resolve({ provider: "deepseek", model: "deepseek-v4-flash", baseUrl: "" });
    expect(resolveExecutionRequestStreaming(true, profile)).toBe(true);
  });

  it("forces streaming off when the global toggle is on but the current profile is the official MiniMax Anthropic endpoint", () => {
    const profile = resolve({ provider: "minimax", model: "MiniMax-M3", baseUrl: "" });
    expect(resolveExecutionRequestStreaming(true, profile)).toBe(false);
  });

  it("still honors the user's toggle when the global toggle is off (so DeepSeek returns to the user's pref)", () => {
    const deepseek = resolve({ provider: "deepseek", model: "deepseek-v4-flash", baseUrl: "" });
    expect(resolveExecutionRequestStreaming(false, deepseek)).toBe(false);
  });

  it("keeps streaming on when the global toggle is on and the user points MiniMax at a custom CORS proxy", () => {
    const profile = resolve({
      provider: "minimax",
      model: "MiniMax-M3",
      baseUrl: "https://my-proxy.example.com/anthropic"
    });
    expect(resolveExecutionRequestStreaming(true, profile)).toBe(true);
  });

  it("keeps streaming on for the official Anthropic endpoint (CORS allowed)", () => {
    const profile = resolve({ provider: "anthropic", model: "claude-3-7-sonnet-latest", baseUrl: "" });
    expect(resolveExecutionRequestStreaming(true, profile)).toBe(true);
  });

  it("does not mutate the configured value when the MiniMax official endpoint is off and the user already disabled streaming", () => {
    const profile = resolve({ provider: "minimax", model: "MiniMax-M3", baseUrl: "" });
    expect(resolveExecutionRequestStreaming(false, profile)).toBe(false);
  });
});
