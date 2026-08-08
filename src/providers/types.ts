import type { ProviderMessage } from "../domain/context-builder";
import type { SseParser } from "./stream-parser";

export type ProviderKind =
  | "openai"
  | "deepseek"
  | "openai-compatible"
  | "anthropic"
  | "gemini";

export interface ProviderProfile {
  id: string;
  name: string;
  kind: ProviderKind;
  apiKey: string;
  baseUrl: string;
}

export interface ProviderInput {
  messages: ProviderMessage[];
  model: string;
  stream: boolean;
  cacheKey?: string;
  webSearchEnabled?: boolean;
  webSearchMaxUses?: number;
  maxOutputTokens?: number;
  thinkingEnabled?: boolean;
  anthropicContinuation?: unknown[];
}

export interface ProviderRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: Record<string, unknown>;
  responseFormat?: "openai" | "anthropic" | "gemini";
}

export interface NormalizedUsage {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  providerReported: boolean;
}

export type ProviderEvent =
  | { type: "delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | {
      type: "tool-call-delta";
      index: number;
      id?: string;
      name?: string;
      argumentsText?: string;
    }
  | { type: "usage"; usage: NormalizedUsage }
  | { type: "search-status"; status: "searching" | "complete" }
  | { type: "sources"; sources: Array<{ title: string; url: string }> }
  | { type: "pause"; content: unknown[] }
  | { type: "finish"; reason?: "stop" | "length" | "tool_calls" | "unknown" }
  | { type: "done" }
  | { type: "error"; message: string };

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  buildRequest(input: ProviderInput, profile: ProviderProfile): ProviderRequest;
  parseBuffered(value: unknown, request?: ProviderRequest): ProviderEvent[];
  createStreamParser(request?: ProviderRequest): SseParser;
}
