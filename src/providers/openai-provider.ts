import type {
  ProviderAdapter,
  ProviderEvent,
  ProviderInput,
  ProviderProfile,
  ProviderRequest
} from "./types";
import {
  createSseParser,
  decodeOpenAiEvent,
  normalizeOpenAiCompatibleUsage
} from "./stream-parser";

function join(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`;
}

export class OpenAiProvider implements ProviderAdapter {
  readonly kind = "openai";

  buildRequest(input: ProviderInput, profile: ProviderProfile): ProviderRequest {
    const base =
      profile.baseUrl.trim().length > 0
        ? profile.baseUrl
        : "https://api.openai.com/v1";
    const official = profile.kind === "openai";
    return {
      url: join(base, "chat/completions"),
      method: "POST",
      headers: {
        Authorization: `Bearer ${profile.apiKey}`,
        "Content-Type": "application/json"
      },
      body: {
        model: input.model,
        messages: input.messages,
        stream: input.stream,
        ...(official && input.stream
          ? { stream_options: { include_usage: true } }
          : {}),
        ...(official && input.cacheKey !== undefined
          ? { prompt_cache_key: input.cacheKey }
          : {}),
        ...(input.maxOutputTokens === undefined
          ? {}
          : { max_tokens: input.maxOutputTokens })
      }
    };
  }

  parseBuffered(value: unknown): ProviderEvent[] {
    const body = value as { choices?: Array<{ message?: { content?: unknown } }> };
    const text = body.choices?.[0]?.message?.content;
    const events: ProviderEvent[] = [];
    if (typeof text === "string") events.push({ type: "delta", text });
    const usage = normalizeOpenAiCompatibleUsage(value);
    if (usage !== undefined) events.push({ type: "usage", usage });
    if (typeof text === "string") events.push({ type: "done" });
    return events.length > 0
      ? events
      : [{ type: "error", message: "模型没有返回文本内容" }];
  }

  createStreamParser() {
    return createSseParser(decodeOpenAiEvent);
  }
}
