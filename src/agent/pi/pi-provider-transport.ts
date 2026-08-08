import {
  normalizeAnthropicUsage,
  normalizeOpenAiCompatibleUsage
} from "../../providers/stream-parser";
import type {
  NormalizedUsage,
  ProviderProfile,
  ProviderRequest
} from "../../providers/types";
import type { PiToolDefinition } from "./context-workspace";

export interface PiToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type PiConversationMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      reasoningContent?: string;
      toolCalls: PiToolCall[];
    }
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: string;
      isError: boolean;
    };

export interface PiProviderTurnInput {
  profile: ProviderProfile;
  modelId: string;
  systemPrompt: string;
  messages: PiConversationMessage[];
  tools: PiToolDefinition[];
  toolChoice?: "auto" | "none";
  maxOutputTokens?: number;
  cacheKey?: string;
  stream?: boolean;
  thinkingEnabled?: boolean;
}

export interface PiProviderTurnResult {
  text: string;
  thinking: string;
  toolCalls: PiToolCall[];
  usage?: NormalizedUsage;
  stopReason: "stop" | "tool_calls" | "length";
}

function join(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => {
      const record = asRecord(entry);
      return record?.type === "text" && typeof record.text === "string"
        ? record.text
        : "";
    })
    .join("");
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || value.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return asRecord(parsed) ?? {};
  } catch {
    throw new Error(`Pi tool arguments are not valid JSON: ${value}`);
  }
}

function openAiMessages(
  messages: PiConversationMessage[],
  providerKind: ProviderProfile["kind"]
): unknown[] {
  return messages.map((message) => {
    if (message.role === "user") {
      return { role: "user", content: message.content };
    }
    if (message.role === "toolResult") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content
      };
    }
    return {
      role: "assistant",
      content: message.content.length === 0 ? null : message.content,
      ...((providerKind === "deepseek" || providerKind === "openai-compatible") &&
      message.reasoningContent !== undefined &&
      message.reasoningContent.length > 0
        ? { reasoning_content: message.reasoningContent }
        : {}),
      ...(message.toolCalls.length === 0
        ? {}
        : {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments)
              }
            }))
          })
    };
  });
}

function openAiRequest(input: PiProviderTurnInput): ProviderRequest {
  const { profile } = input;
  const base =
    profile.baseUrl.trim().length > 0
      ? profile.baseUrl.trim()
      : profile.kind === "deepseek"
        ? "https://api.deepseek.com"
        : "https://api.openai.com/v1";
  const messages = [
    ...(input.systemPrompt.length === 0
      ? []
      : [{ role: "system", content: input.systemPrompt }]),
    ...openAiMessages(input.messages, profile.kind)
  ];
  return {
    url: join(base, "chat/completions"),
    method: "POST",
    headers: {
      Authorization: `Bearer ${profile.apiKey}`,
      "Content-Type": "application/json"
    },
    body: {
      model: input.modelId,
      messages,
      stream: input.stream === true,
      ...(input.stream === true ? { stream_options: { include_usage: true } } : {}),
      ...(input.tools.length === 0
        ? {}
        : {
            tools: input.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters
              }
            })),
            ...(input.toolChoice === undefined
              ? {}
              : { tool_choice: input.toolChoice })
          }),
      ...(input.maxOutputTokens === undefined
        ? {}
        : profile.kind === "openai"
          ? { max_completion_tokens: input.maxOutputTokens }
          : { max_tokens: input.maxOutputTokens }),
      ...(profile.kind === "deepseek" && input.thinkingEnabled !== undefined
        ? {
            thinking: {
              type: input.thinkingEnabled ? "enabled" : "disabled"
            }
          }
        : {}),
      ...(profile.kind === "openai" && input.cacheKey !== undefined
        ? { prompt_cache_key: input.cacheKey }
        : {})
    },
    responseFormat: "openai"
  };
}

function anthropicMessages(messages: PiConversationMessage[]): unknown[] {
  const result: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "user") {
      result.push({
        role: "user",
        content: [{ type: "text", text: message.content }]
      });
      continue;
    }
    if (message.role === "assistant") {
      result.push({
        role: "assistant",
        content: [
          ...(message.content.length === 0
            ? []
            : [{ type: "text", text: message.content }]),
          ...message.toolCalls.map((call) => ({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: call.arguments
          }))
        ]
      });
      continue;
    }
    const previous = result.at(-1);
    const toolResult = {
      type: "tool_result",
      tool_use_id: message.toolCallId,
      content: message.content,
      is_error: message.isError
    };
    if (previous?.role === "user" && Array.isArray(previous.content)) {
      const content = previous.content as unknown[];
      const onlyToolResults = content.every(
        (entry) => asRecord(entry)?.type === "tool_result"
      );
      if (onlyToolResults) {
        content.push(toolResult);
        continue;
      }
    }
    result.push({ role: "user", content: [toolResult] });
  }
  return result;
}

function anthropicRequest(input: PiProviderTurnInput): ProviderRequest {
  const base =
    input.profile.baseUrl.trim().length > 0
      ? input.profile.baseUrl.trim()
      : "https://api.anthropic.com";
  return {
    url: join(base, "v1/messages"),
    method: "POST",
    headers: {
      "x-api-key": input.profile.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    },
    body: {
      model: input.modelId,
      max_tokens: input.maxOutputTokens ?? 8192,
      stream: input.stream === true,
      system: input.systemPrompt,
      messages: anthropicMessages(input.messages),
      ...(input.tools.length === 0
        ? {}
        : {
            tools: input.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters
            })),
            tool_choice: { type: "auto" }
          })
    },
    responseFormat: "anthropic"
  };
}

function geminiContents(messages: PiConversationMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === "user") {
      return { role: "user", parts: [{ text: message.content }] };
    }
    if (message.role === "assistant") {
      return {
        role: "model",
        parts: [
          ...(message.content.length === 0 ? [] : [{ text: message.content }]),
          ...message.toolCalls.map((call) => ({
            functionCall: {
              name: call.name,
              args: call.arguments
            }
          }))
        ]
      };
    }
    return {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: message.toolName,
            response: {
              toolCallId: message.toolCallId,
              isError: message.isError,
              result: message.content
            }
          }
        }
      ]
    };
  });
}


function geminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => geminiSchema(entry));
  const source = asRecord(value);
  if (source === undefined) return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (key === "additionalProperties") continue;
    result[key] = geminiSchema(entry);
  }
  return result;
}

function geminiRequest(input: PiProviderTurnInput): ProviderRequest {
  const base =
    input.profile.baseUrl.trim().length > 0
      ? input.profile.baseUrl.trim()
      : "https://generativelanguage.googleapis.com/v1beta";
  return {
    url: `${base.replace(/\/+$/u, "")}/models/${encodeURIComponent(
      input.modelId
    )}:${input.stream === true ? "streamGenerateContent?alt=sse" : "generateContent"}`,
    method: "POST",
    headers: {
      "x-goog-api-key": input.profile.apiKey,
      "Content-Type": "application/json"
    },
    body: {
      systemInstruction: { parts: [{ text: input.systemPrompt }] },
      contents: geminiContents(input.messages),
      ...(input.tools.length === 0
        ? {}
        : {
            tools: [
              {
                functionDeclarations: input.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: geminiSchema(tool.parameters)
                }))
              }
            ],
            toolConfig: {
              functionCallingConfig: { mode: "AUTO" }
            }
          }),
      ...(input.maxOutputTokens === undefined
        ? {}
        : { generationConfig: { maxOutputTokens: input.maxOutputTokens } })
    },
    responseFormat: "gemini"
  };
}

export function buildPiProviderRequest(
  input: PiProviderTurnInput
): ProviderRequest {
  if (input.profile.kind === "anthropic") return anthropicRequest(input);
  if (input.profile.kind === "gemini") return geminiRequest(input);
  return openAiRequest(input);
}

function parseOpenAi(value: unknown): PiProviderTurnResult {
  const body = asRecord(value);
  const error = asRecord(body?.error);
  if (typeof error?.message === "string") throw new Error(error.message);
  const choices = Array.isArray(body?.choices) ? body?.choices : [];
  const first = asRecord(choices[0]);
  const message = asRecord(first?.message);
  if (message === undefined) throw new Error("Pi provider returned no assistant message");
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls = calls.map((entry, index) => {
    const record = asRecord(entry);
    const fn = asRecord(record?.function);
    const name = typeof fn?.name === "string" ? fn.name : "";
    if (name.length === 0) throw new Error("Pi provider returned a nameless tool call");
    return {
      id:
        typeof record?.id === "string" && record.id.length > 0
          ? record.id
          : `pi-tool-${String(index)}`,
      name,
      arguments: parseArguments(fn?.arguments)
    };
  });
  const finishReason = first?.finish_reason;
  const usage = normalizeOpenAiCompatibleUsage(value);
  return {
    text: textContent(message.content),
    thinking:
      typeof message.reasoning_content === "string"
        ? message.reasoning_content
        : "",
    toolCalls,
    ...(usage === undefined ? {} : { usage }),
    stopReason:
      finishReason === "length"
        ? "length"
        : toolCalls.length > 0
          ? "tool_calls"
          : "stop"
  };
}

function parseAnthropic(value: unknown): PiProviderTurnResult {
  const body = asRecord(value);
  const error = asRecord(body?.error);
  if (typeof error?.message === "string") throw new Error(error.message);
  const blocks = Array.isArray(body?.content) ? body.content : [];
  const text: string[] = [];
  const thinking: string[] = [];
  const toolCalls: PiToolCall[] = [];
  for (const [index, entry] of blocks.entries()) {
    const block = asRecord(entry);
    if (block?.type === "text" && typeof block.text === "string") {
      text.push(block.text);
    }
    if (
      (block?.type === "thinking" || block?.type === "redacted_thinking") &&
      typeof block.thinking === "string"
    ) {
      thinking.push(block.thinking);
    }
    if (block?.type === "tool_use" && typeof block.name === "string") {
      toolCalls.push({
        id:
          typeof block.id === "string" && block.id.length > 0
            ? block.id
            : `pi-tool-${String(index)}`,
        name: block.name,
        arguments: parseArguments(block.input)
      });
    }
  }
  const usage = normalizeAnthropicUsage(body?.usage);
  return {
    text: text.join(""),
    thinking: thinking.join("\n"),
    toolCalls,
    ...(usage === undefined ? {} : { usage }),
    stopReason:
      body?.stop_reason === "max_tokens"
        ? "length"
        : toolCalls.length > 0
          ? "tool_calls"
          : "stop"
  };
}

function normalizeGeminiUsage(value: unknown): NormalizedUsage | undefined {
  const usage = asRecord(asRecord(value)?.usageMetadata);
  if (usage === undefined) return undefined;
  const promptTokens =
    typeof usage.promptTokenCount === "number"
      ? usage.promptTokenCount
      : undefined;
  const completionTokens =
    typeof usage.candidatesTokenCount === "number"
      ? usage.candidatesTokenCount
      : undefined;
  const cacheHitTokens =
    typeof usage.cachedContentTokenCount === "number"
      ? usage.cachedContentTokenCount
      : undefined;
  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    cacheHitTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(cacheHitTokens === undefined ? {} : { cacheHitTokens }),
    ...(promptTokens === undefined || cacheHitTokens === undefined
      ? {}
      : { cacheMissTokens: Math.max(0, promptTokens - cacheHitTokens) }),
    providerReported: true
  };
}

function parseGemini(value: unknown): PiProviderTurnResult {
  const body = asRecord(value);
  const error = asRecord(body?.error);
  if (typeof error?.message === "string") throw new Error(error.message);
  const candidates = Array.isArray(body?.candidates) ? body.candidates : [];
  const first = asRecord(candidates[0]);
  const content = asRecord(first?.content);
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const text: string[] = [];
  const thinking: string[] = [];
  const toolCalls: PiToolCall[] = [];
  for (const [index, entry] of parts.entries()) {
    const part = asRecord(entry);
    if (typeof part?.text === "string") {
      if (part.thought === true) thinking.push(part.text);
      else text.push(part.text);
    }
    const call = asRecord(part?.functionCall);
    if (typeof call?.name === "string") {
      toolCalls.push({
        id: `gemini-${String(index)}-${call.name}`,
        name: call.name,
        arguments: parseArguments(call.args)
      });
    }
  }
  const usage = normalizeGeminiUsage(value);
  return {
    text: text.join(""),
    thinking: thinking.join("\n"),
    toolCalls,
    ...(usage === undefined ? {} : { usage }),
    stopReason:
      first?.finishReason === "MAX_TOKENS"
        ? "length"
        : toolCalls.length > 0
          ? "tool_calls"
          : "stop"
  };
}

export function parsePiProviderResponse(
  profile: ProviderProfile,
  value: unknown
): PiProviderTurnResult {
  if (profile.kind === "anthropic") return parseAnthropic(value);
  if (profile.kind === "gemini") return parseGemini(value);
  return parseOpenAi(value);
}
