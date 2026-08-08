import type {
  ProviderAdapter,
  ProviderEvent,
  ProviderInput,
  ProviderProfile,
  ProviderRequest
} from "./types";
import {
  createAnthropicMessageParser,
  createSseParser,
  decodeOpenAiEvent,
  extractWebSearchSources,
  normalizeAnthropicUsage,
  normalizeOpenAiCompatibleUsage
} from "./stream-parser";

function join(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`;
}

function deepSeekApiRoot(baseUrl: string): string {
  const configured =
    baseUrl.trim().length > 0 ? baseUrl.trim() : "https://api.deepseek.com";
  try {
    const parsed = new URL(configured);
    if (parsed.hostname.toLowerCase() === "api.deepseek.com") {
      return `${parsed.protocol}//${parsed.host}`;
    }
  } catch {
    // Fall through to tolerant path cleanup for custom compatible endpoints.
  }
  return configured
    .replace(/\/+$/u, "")
    .replace(/\/(?:anthropic(?:\/v1(?:\/messages)?)?|chat\/completions)$/u, "");
}

function anthropicBaseUrl(baseUrl: string): string {
  return join(deepSeekApiRoot(baseUrl), "anthropic");
}

function anthropicMessages(input: ProviderInput): {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: unknown }>;
} {
  const system = input.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const messages: Array<{
    role: "user" | "assistant";
    content: unknown;
  }> = input.messages.flatMap((message) => {
    if (message.role === "system") return [];
    return [
      {
        role: message.role,
        content: [{ type: "text", text: message.content }]
      }
    ];
  });
  if (input.anthropicContinuation !== undefined) {
    messages.push({
      role: "assistant",
      content: input.anthropicContinuation
    });
  }
  return { system, messages };
}

function parseAnthropicBuffered(value: unknown): ProviderEvent[] {
  const body = value as {
    content?: unknown[];
    stop_reason?: unknown;
    usage?: unknown;
    error?: { message?: unknown };
  };
  if (typeof body.error?.message === "string") {
    return [{ type: "error", message: body.error.message }];
  }
  const content = Array.isArray(body.content) ? body.content : [];
  const events: ProviderEvent[] = [];
  const usage = normalizeAnthropicUsage(body.usage);
  if (usage !== undefined) events.push({ type: "usage", usage });
  for (const entry of content) {
    const block = entry as {
      type?: unknown;
      name?: unknown;
      text?: unknown;
      thinking?: unknown;
    };
    if (block.type === "server_tool_use" && block.name === "web_search") {
      events.push({ type: "search-status", status: "searching" });
    }
    if (block.type === "web_search_tool_result") {
      events.push({ type: "search-status", status: "complete" });
      const sources = extractWebSearchSources(block);
      if (sources.length > 0) events.push({ type: "sources", sources });
    }
    if (
      (block.type === "thinking" || block.type === "redacted_thinking") &&
      typeof block.thinking === "string"
    ) {
      events.push({ type: "thinking-delta", text: block.thinking });
    }
    if (block.type === "text" && typeof block.text === "string") {
      events.push({ type: "delta", text: block.text });
    }
  }
  if (body.stop_reason === "pause_turn") {
    events.push({ type: "pause", content: structuredClone(content) });
  } else {
    events.push(
      body.stop_reason === "max_tokens"
        ? { type: "finish", reason: "length" }
        : { type: "finish" }
    );
    events.push({ type: "done" });
  }
  return events;
}

function shouldUseAnthropicTransport(baseUrl: string): boolean {
  const configured = baseUrl.trim();
  if (configured.length === 0) return true;
  try {
    return new URL(configured).hostname.toLowerCase() === "api.deepseek.com";
  } catch {
    return /api\.deepseek\.com/iu.test(configured);
  }
}

function anthropicRequest(
  input: ProviderInput,
  profile: ProviderProfile
): ProviderRequest {
  const { system, messages } = anthropicMessages(input);
  const webSearch = input.webSearchEnabled === true;
  const webSearchMaxUses = Math.max(
    1,
    Math.min(5, Math.trunc(input.webSearchMaxUses ?? 5))
  );
  return {
    url: join(anthropicBaseUrl(profile.baseUrl), "v1/messages"),
    method: "POST",
    headers: {
      "x-api-key": profile.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    },
    body: {
      model: input.model,
      max_tokens: input.maxOutputTokens ?? 8192,
      stream: input.stream,
      system,
      messages,
      ...(input.thinkingEnabled === undefined
        ? {}
        : { thinking: { type: input.thinkingEnabled ? "enabled" : "disabled" } }),
      ...(webSearch
        ? {
            tools: [
              {
                type: "web_search_20250305",
                name: "web_search",
                max_uses: webSearchMaxUses
              }
            ],
            tool_choice: { type: "auto" }
          }
        : {})
    },
    responseFormat: "anthropic"
  };
}

export class DeepSeekProvider implements ProviderAdapter {
  readonly kind = "deepseek";

  buildRequest(input: ProviderInput, profile: ProviderProfile): ProviderRequest {
    if (input.webSearchEnabled === true || shouldUseAnthropicTransport(profile.baseUrl)) {
      return anthropicRequest(input, profile);
    }

    const base = deepSeekApiRoot(profile.baseUrl);
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
        ...(input.stream ? { stream_options: { include_usage: true } } : {}),
        ...(input.maxOutputTokens === undefined
          ? {}
          : { max_tokens: input.maxOutputTokens }),
        ...(input.thinkingEnabled === undefined
          ? {}
          : { thinking: { type: input.thinkingEnabled ? "enabled" : "disabled" } })
      },
      responseFormat: "openai"
    };
  }

  parseBuffered(value: unknown, request?: ProviderRequest): ProviderEvent[] {
    if (request?.responseFormat === "anthropic") {
      return parseAnthropicBuffered(value);
    }
    const body = value as {
      choices?: Array<{
        message?: { content?: unknown; reasoning_content?: unknown };
        finish_reason?: unknown;
      }>;
    };
    const message = body.choices?.[0]?.message;
    const text = message?.content;
    const thinking = message?.reasoning_content;
    const events: ProviderEvent[] = [];
    if (typeof thinking === "string" && thinking.length > 0) {
      events.push({ type: "thinking-delta", text: thinking });
    }
    if (typeof text === "string") events.push({ type: "delta", text });
    const usage = normalizeOpenAiCompatibleUsage(value);
    if (usage !== undefined) events.push({ type: "usage", usage });
    const finishReason = body.choices?.[0]?.finish_reason;
    if (typeof finishReason === "string") {
      events.push(
        finishReason === "length"
          ? { type: "finish", reason: "length" }
          : { type: "finish" }
      );
    }
    if (typeof text === "string" || typeof finishReason === "string") {
      events.push({ type: "done" });
    }
    return events.length > 0
      ? events
      : [{ type: "error", message: "模型没有返回文本内容" }];
  }

  createStreamParser(request?: ProviderRequest) {
    return request?.responseFormat === "anthropic"
      ? createAnthropicMessageParser()
      : createSseParser(decodeOpenAiEvent);
  }
}
