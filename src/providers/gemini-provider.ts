import type {
  ProviderAdapter,
  ProviderEvent,
  ProviderInput,
  ProviderProfile,
  ProviderRequest
} from "./types";
import { createSseParser, decodeGeminiEvent } from "./stream-parser";

export class GeminiProvider implements ProviderAdapter {
  readonly kind = "gemini";

  buildRequest(input: ProviderInput, profile: ProviderProfile): ProviderRequest {
    const base = (profile.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(
      /\/+$/u,
      ""
    );
    const system = input.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    return {
      url: `${base}/models/${encodeURIComponent(input.model)}:${
        input.stream ? "streamGenerateContent?alt=sse" : "generateContent"
      }`,
      method: "POST",
      headers: {
        "x-goog-api-key": profile.apiKey,
        "Content-Type": "application/json"
      },
      body: {
        systemInstruction: { parts: [{ text: system }] },
        ...(input.maxOutputTokens === undefined
          ? {}
          : { generationConfig: { maxOutputTokens: input.maxOutputTokens } }),
        contents: input.messages
          .filter((message) => message.role !== "system")
          .map((message) => ({
            role: message.role === "assistant" ? "model" : "user",
            parts: [{ text: message.content }]
          }))
      }
    };
  }

  parseBuffered(value: unknown): ProviderEvent[] {
    const body = value as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
    };
    const text = body.candidates?.[0]?.content?.parts
      ?.map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("");
    return text === undefined
      ? [{ type: "error", message: "模型没有返回文本内容" }]
      : [{ type: "delta", text }, { type: "done" }];
  }

  createStreamParser() {
    return createSseParser(decodeGeminiEvent);
  }
}
