import type { NormalizedUsage, ProviderEvent } from "./types";
import { logWarning } from "../utils/error-log";

export interface SseRecord {
  event: string;
  data: string;
}

export type EventDecoder = (record: SseRecord) => ProviderEvent[];

export interface SseParser {
  push(chunk: string): ProviderEvent[];
  finish(): ProviderEvent[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

let malformedChunkWarned = false;

function truncateDiagnostic(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function parseJson(data: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(data) as unknown);
  } catch {
    if (!malformedChunkWarned) {
      malformedChunkWarned = true;
      logWarning(`模型流式响应解析失败: ${truncateDiagnostic(data, 160)}`);
    }
    return undefined;
  }
}

function textAt(value: unknown, path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    current = asRecord(current)?.[key];
  }
  return typeof current === "string" ? current : undefined;
}

function numberAt(value: unknown, path: string[]): number | undefined {
  let current: unknown = value;
  for (const key of path) {
    current = asRecord(current)?.[key];
  }
  return typeof current === "number" && Number.isFinite(current)
    ? current
    : undefined;
}

export function normalizeOpenAiCompatibleUsage(
  value: unknown
): NormalizedUsage | undefined {
  const source = asRecord(value);
  const usage = asRecord(source?.usage);
  if (usage === undefined) return undefined;
  const promptTokens = numberAt(usage, ["prompt_tokens"]);
  const completionTokens = numberAt(usage, ["completion_tokens"]);
  const reasoningTokens = numberAt(usage, [
    "completion_tokens_details",
    "reasoning_tokens"
  ]);
  const deepSeekHit = numberAt(usage, ["prompt_cache_hit_tokens"]);
  const deepSeekMiss = numberAt(usage, ["prompt_cache_miss_tokens"]);
  const openAiHit = numberAt(usage, ["prompt_tokens_details", "cached_tokens"]);
  const cacheHitTokens = deepSeekHit ?? openAiHit;
  const cacheMissTokens =
    deepSeekMiss ??
    (promptTokens !== undefined && cacheHitTokens !== undefined
      ? Math.max(0, promptTokens - cacheHitTokens)
      : undefined);
  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    reasoningTokens === undefined &&
    cacheHitTokens === undefined &&
    cacheMissTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cacheHitTokens === undefined ? {} : { cacheHitTokens }),
    ...(cacheMissTokens === undefined ? {} : { cacheMissTokens }),
    providerReported: true
  };
}


export function normalizeAnthropicUsage(
  value: unknown
): NormalizedUsage | undefined {
  const usage = asRecord(value);
  if (usage === undefined) return undefined;
  const inputTokens = numberAt(usage, ["input_tokens"]);
  const outputTokens = numberAt(usage, ["output_tokens"]);
  const cacheReadTokens = numberAt(usage, ["cache_read_input_tokens"]);
  const cacheCreationTokens = numberAt(usage, ["cache_creation_input_tokens"]);
  const promptParts = [inputTokens, cacheReadTokens, cacheCreationTokens].filter(
    (entry): entry is number => entry !== undefined
  );
  const promptTokens =
    promptParts.length === 0
      ? undefined
      : promptParts.reduce((total, entry) => total + entry, 0);
  const cacheMissTokens =
    inputTokens === undefined && cacheCreationTokens === undefined
      ? undefined
      : (inputTokens ?? 0) + (cacheCreationTokens ?? 0);
  if (
    promptTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheMissTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(outputTokens === undefined ? {} : { completionTokens: outputTokens }),
    ...(cacheReadTokens === undefined
      ? {}
      : { cacheHitTokens: cacheReadTokens }),
    ...(cacheMissTokens === undefined ? {} : { cacheMissTokens }),
    providerReported: true
  };
}

export function extractWebSearchSources(
  value: unknown
): Array<{ title: string; url: string }> {
  const sources = new Map<string, { title: string; url: string }>();
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const entry of current) visit(entry);
      return;
    }
    const record = asRecord(current);
    if (record === undefined) return;
    const url = typeof record.url === "string" ? record.url.trim() : "";
    if (/^https?:\/\//iu.test(url)) {
      const title =
        typeof record.title === "string" && record.title.trim().length > 0
          ? record.title.trim()
          : url;
      sources.set(url, { title, url });
    }
    for (const nested of Object.values(record)) visit(nested);
  };
  visit(value);
  return [...sources.values()];
}

export function createAnthropicMessageParser(): SseParser {
  const blocks = new Map<number, Record<string, unknown>>();
  const partialInputs = new Map<number, string>();
  let stopReason: string | undefined;
  let malformedPartialWarned = false;

  const decoder: EventDecoder = (record) => {
    const value = parseJson(record.data);
    if (value === undefined) {
      return [{ type: "error", message: "无法解析模型流式响应" }];
    }
    if (record.event === "error" || value.type === "error") {
      return [
        {
          type: "error",
          message: textAt(value, ["error", "message"]) ?? "模型返回流式错误"
        }
      ];
    }

    const type = typeof value.type === "string" ? value.type : record.event;
    if (type === "message_start") {
      const usage = normalizeAnthropicUsage(asRecord(value.message)?.usage);
      return usage === undefined ? [] : [{ type: "usage", usage }];
    }

    if (type === "content_block_start") {
      const index = numberAt(value, ["index"]);
      const block = asRecord(value.content_block);
      if (index === undefined || block === undefined) return [];
      const copy = structuredClone(block);
      blocks.set(index, copy);
      if (copy.type === "server_tool_use" && copy.name === "web_search") {
        return [{ type: "search-status", status: "searching" }];
      }
      if (copy.type === "web_search_tool_result") {
        const sources = extractWebSearchSources(copy);
        return [
          { type: "search-status", status: "complete" },
          ...(sources.length === 0 ? [] : [{ type: "sources" as const, sources }])
        ];
      }
      return [];
    }

    if (type === "content_block_delta") {
      const index = numberAt(value, ["index"]);
      const delta = asRecord(value.delta);
      if (index === undefined || delta === undefined) return [];
      const block = blocks.get(index);
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        if (block !== undefined) {
          block.text = `${typeof block.text === "string" ? block.text : ""}${delta.text}`;
        }
        return [{ type: "delta", text: delta.text }];
      }
      if (
        delta.type === "thinking_delta" &&
        typeof delta.thinking === "string"
      ) {
        if (block !== undefined) {
          block.thinking = `${typeof block.thinking === "string" ? block.thinking : ""}${delta.thinking}`;
        }
        return [{ type: "thinking-delta", text: delta.thinking }];
      }
      if (
        delta.type === "input_json_delta" &&
        typeof delta.partial_json === "string"
      ) {
        partialInputs.set(
          index,
          `${partialInputs.get(index) ?? ""}${delta.partial_json}`
        );
      }
      if (delta.type === "citations_delta" && block !== undefined) {
        const citations = Array.isArray(block.citations)
          ? [...block.citations]
          : [];
        if (delta.citation !== undefined) citations.push(delta.citation);
        block.citations = citations;
      }
      return [];
    }

    if (type === "content_block_stop") {
      const index = numberAt(value, ["index"]);
      if (index === undefined) return [];
      const partial = partialInputs.get(index);
      const block = blocks.get(index);
      if (partial !== undefined && block !== undefined) {
        try {
          block.input = JSON.parse(partial) as unknown;
        } catch {
          if (!malformedPartialWarned) {
            malformedPartialWarned = true;
            logWarning(
              `工具参数 JSON 解析失败: ${truncateDiagnostic(partial, 160)}`
            );
          }
          block.input = partial;
        }
      }
      return [];
    }

    if (type === "message_delta") {
      const events: ProviderEvent[] = [];
      const usage = normalizeAnthropicUsage(value.usage);
      if (usage !== undefined) events.push({ type: "usage", usage });
      const candidate = textAt(value, ["delta", "stop_reason"]);
      if (candidate !== undefined) {
        stopReason = candidate;
        if (candidate !== "pause_turn") {
          events.push(
            candidate === "max_tokens"
              ? { type: "finish", reason: "length" }
              : { type: "finish" }
          );
        }
      }
      return events;
    }

    if (type === "message_stop") {
      const content = [...blocks.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, block]) => structuredClone(block));
      if (stopReason === "pause_turn") return [{ type: "pause", content }];
      return [{ type: "done" }];
    }
    return [];
  };

  return createSseParser(decoder);
}

export function decodeOpenAiEvent(record: SseRecord): ProviderEvent[] {
  if (record.data.trim() === "[DONE]") return [{ type: "done" }];
  const value = parseJson(record.data);
  if (value === undefined) {
    return [{ type: "error", message: "无法解析模型流式响应" }];
  }
  const error = textAt(value, ["error", "message"]);
  if (error !== undefined) return [{ type: "error", message: error }];
  const events: ProviderEvent[] = [];
  const usage = normalizeOpenAiCompatibleUsage(value);
  if (usage !== undefined) events.push({ type: "usage", usage });
  const choices = value.choices;
  if (!Array.isArray(choices)) return events;
  const first = asRecord(choices[0]);
  const thinking = textAt(first, ["delta", "reasoning_content"]);
  if (thinking !== undefined) {
    events.push({ type: "thinking-delta", text: thinking });
  }
  const text = textAt(first, ["delta", "content"]);
  if (text !== undefined) events.push({ type: "delta", text });
  const delta = asRecord(first?.delta);
  const toolCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
  for (const [fallbackIndex, entry] of toolCalls.entries()) {
    const call = asRecord(entry);
    const fn = asRecord(call?.function);
    const index =
      typeof call?.index === "number" && Number.isInteger(call.index)
        ? call.index
        : fallbackIndex;
    const id = typeof call?.id === "string" ? call.id : undefined;
    const name = typeof fn?.name === "string" ? fn.name : undefined;
    const argumentsText =
      typeof fn?.arguments === "string" ? fn.arguments : undefined;
    if (id !== undefined || name !== undefined || argumentsText !== undefined) {
      events.push({
        type: "tool-call-delta",
        index,
        ...(id === undefined ? {} : { id }),
        ...(name === undefined ? {} : { name }),
        ...(argumentsText === undefined ? {} : { argumentsText })
      });
    }
  }
  if (typeof first?.finish_reason === "string") {
    events.push(
      first.finish_reason === "length"
        ? { type: "finish", reason: "length" }
        : first.finish_reason === "tool_calls"
          ? { type: "finish", reason: "tool_calls" }
          : { type: "finish" }
    );
  }
  return events;
}

export function decodeAnthropicEvent(record: SseRecord): ProviderEvent[] {
  const value = parseJson(record.data);
  if (value === undefined) {
    return [{ type: "error", message: "无法解析模型流式响应" }];
  }
  if (record.event === "error" || value.type === "error") {
    return [
      {
        type: "error",
        message: textAt(value, ["error", "message"]) ?? "模型返回流式错误"
      }
    ];
  }
  if (record.event === "message_stop" || value.type === "message_stop") {
    return [{ type: "done" }];
  }
  const text = textAt(value, ["delta", "text"]);
  return text === undefined ? [] : [{ type: "delta", text }];
}

export function decodeGeminiEvent(record: SseRecord): ProviderEvent[] {
  const value = parseJson(record.data);
  if (value === undefined) {
    return [{ type: "error", message: "无法解析模型流式响应" }];
  }
  const error = textAt(value, ["error", "message"]);
  if (error !== undefined) return [{ type: "error", message: error }];
  const candidates = value.candidates;
  if (!Array.isArray(candidates)) return [];
  const first = asRecord(candidates[0]);
  const content = asRecord(first?.content);
  const parts = content?.parts;
  const partText = Array.isArray(parts) ? asRecord(parts[0])?.text : undefined;
  const events: ProviderEvent[] = [];
  if (typeof partText === "string") {
    events.push({ type: "delta", text: partText });
  }
  if (typeof first?.finishReason === "string") {
    events.push({ type: "done" });
  }
  return events;
}

function decodeBlock(block: string, decoder: EventDecoder): ProviderEvent[] {
  let event = "";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/u)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return [];
  return decoder({ event, data: data.join("\n") });
}

export function createSseParser(decoder: EventDecoder): SseParser {
  let buffer = "";
  const drain = (flush: boolean): ProviderEvent[] => {
    const events: ProviderEvent[] = [];
    const blocks = buffer.split(/\r?\n\r?\n/u);
    buffer = flush ? "" : (blocks.pop() ?? "");
    for (const block of blocks) {
      events.push(...decodeBlock(block, decoder));
    }
    if (flush && buffer.length > 0) {
      events.push(...decodeBlock(buffer, decoder));
      buffer = "";
    }
    return events;
  };
  return {
    push(chunk) {
      buffer += chunk;
      return drain(false);
    },
    finish() {
      const final = buffer;
      buffer = "";
      return final.length === 0 ? [] : decodeBlock(final, decoder);
    }
  };
}
