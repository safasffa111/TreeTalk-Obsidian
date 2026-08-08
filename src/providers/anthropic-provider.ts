import type {
  ProviderAdapter,
  ProviderEvent,
  ProviderInput,
  ProviderProfile,
  ProviderRequest
} from "./types";
import { createSseParser, decodeAnthropicEvent } from "./stream-parser";

export class AnthropicProvider implements ProviderAdapter {
  readonly kind = "anthropic";

  buildRequest(input: ProviderInput, profile: ProviderProfile): ProviderRequest {
    const system = input.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const messages = input.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role,
        content: [{ type: "text", text: message.content }]
      }));
    return {
      url: `${(profile.baseUrl || "https://api.anthropic.com").replace(/\/+$/u, "")}/v1/messages`,
      method: "POST",
      headers: {
        "x-api-key": profile.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: {
        model: input.model,
        max_tokens: input.maxOutputTokens ?? 4096,
        stream: input.stream,
        system,
        messages
      }
    };
  }

  parseBuffered(value: unknown): ProviderEvent[] {
    const body = value as { content?: Array<{ type?: unknown; text?: unknown }> };
    const text = body.content
      ?.filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");
    return text === undefined
      ? [{ type: "error", message: "模型没有返回文本内容" }]
      : [{ type: "delta", text }, { type: "done" }];
  }

  createStreamParser() {
    return createSseParser(decodeAnthropicEvent);
  }
}
