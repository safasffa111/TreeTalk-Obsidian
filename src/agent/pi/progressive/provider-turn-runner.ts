import { estimateTextTokens } from "../../../domain/context-engine";
import { canUseBufferedFallback as defaultCanUseBufferedFallback } from "../../../providers/streaming-transport";
import type {
  NormalizedUsage,
  ProviderEvent,
  ProviderProfile,
  ProviderRequest
} from "../../../providers/types";
import type {
  ExecutionEvent,
  ExecutionRequest
} from "../../../execution/types";
import {
  buildPiProviderRequest,
  parsePiProviderResponse,
  type PiConversationMessage,
  type PiToolCall
} from "../pi-provider-transport";
import type { PiToolDefinition } from "../context-workspace";
import type { PiBufferedResponse } from "../two-pass-execution-engine";
import {
  isTransientHttpError,
  isTransientProviderStatus,
  TransientProviderError
} from "./transient-provider-error";

export interface ProgressiveProviderTurnDependencies {
  bufferedRequest(request: ProviderRequest): Promise<PiBufferedResponse>;
  streamRequest?(
    profile: ProviderProfile,
    request: ProviderRequest,
    signal: AbortSignal
  ): AsyncIterable<ProviderEvent>;
  canUseBufferedFallback?(error: unknown): boolean;
}

export type ProgressiveProviderAttemptKind =
  | "primary"
  | "buffered-fallback"
  | "thinking-disabled-recovery";

export interface ProgressiveProviderAttempt {
  kind: ProgressiveProviderAttemptKind;
  usage?: NormalizedUsage;
  estimatedInputTokens?: number;
}

export interface ProgressiveProviderTurnResult {
  mode: "final" | "tool";
  text: string;
  thinking: string;
  toolCalls: PiToolCall[];
  usage?: NormalizedUsage;
  estimatedInputTokens?: number;
  attempts: ProgressiveProviderAttempt[];
  stopReason: "stop" | "tool_calls" | "length";
  releasedText: boolean;
}

export interface RunProgressiveProviderTurnInput {
  dependencies: ProgressiveProviderTurnDependencies;
  request: ExecutionRequest;
  signal: AbortSignal;
  systemPrompt: string;
  messages: PiConversationMessage[];
  tools: PiToolDefinition[];
  toolChoice?: "auto" | "none";
  maxOutputTokens: number;
  thinkingEnabled: boolean;
  cacheKey?: string;
}

const TRANSIENT_RETRY_DELAY_MS = 250;

function addUsage(
  current: NormalizedUsage | undefined,
  next: NormalizedUsage | undefined
): NormalizedUsage | undefined {
  if (next === undefined) return current;
  const sum = (left: number | undefined, right: number | undefined): number | undefined =>
    left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
  const promptTokens = sum(current?.promptTokens, next.promptTokens);
  const completionTokens = sum(current?.completionTokens, next.completionTokens);
  const reasoningTokens = sum(current?.reasoningTokens, next.reasoningTokens);
  const cacheHitTokens = sum(current?.cacheHitTokens, next.cacheHitTokens);
  const cacheMissTokens = sum(current?.cacheMissTokens, next.cacheMissTokens);
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cacheHitTokens === undefined ? {} : { cacheHitTokens }),
    ...(cacheMissTokens === undefined ? {} : { cacheMissTokens }),
    providerReported: next.providerReported || (current?.providerReported ?? false)
  };
}

function errorMessage(status: number, body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const source = body as Record<string, unknown>;
    const error = source.error;
    if (typeof error === "object" && error !== null) {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string" && message.length > 0) return message;
    }
    if (typeof source.message === "string" && source.message.length > 0) {
      return source.message;
    }
  }
  return `HTTP ${String(status)}`;
}

function validateResult(input: {
  text: string;
  thinking: string;
  toolCalls: PiToolCall[];
  usage?: NormalizedUsage;
  attempts?: ProgressiveProviderAttempt[];
  stopReason: "stop" | "tool_calls" | "length";
  releasedText: boolean;
}): ProgressiveProviderTurnResult {
  const hasText = input.text.trim().length > 0;
  if (hasText && input.toolCalls.length > 0) {
    throw new Error("Pi tool turn also emitted answer text");
  }
  if (!hasText && input.toolCalls.length === 0 && input.stopReason !== "length") {
    throw new Error("Pi progressive turn returned neither answer text nor a tool call");
  }
  const attempts = input.attempts ?? [
    {
      kind: "primary" as const,
      ...(input.usage === undefined ? {} : { usage: input.usage })
    }
  ];
  const estimatedInputTokens = estimatedInputTokensForAttempts(attempts);
  return {
    mode: input.toolCalls.length > 0 ? "tool" : "final",
    text: input.text,
    thinking: input.thinking,
    toolCalls: input.toolCalls,
    ...(input.usage === undefined ? {} : { usage: input.usage }),
    ...(estimatedInputTokens > 0 ? { estimatedInputTokens } : {}),
    attempts,
    stopReason: input.stopReason,
    releasedText: input.releasedText
  };
}

function estimatedInputTokensForAttempts(
  attempts: readonly ProgressiveProviderAttempt[]
): number {
  return attempts.reduce(
    (total, attempt) => total + (attempt.estimatedInputTokens ?? 0),
    0
  );
}

function withEstimatedInput(
  result: ProgressiveProviderTurnResult
): ProgressiveProviderTurnResult {
  const estimated = estimatedInputTokensForAttempts(result.attempts);
  if (estimated <= 0) return result;
  return { ...result, estimatedInputTokens: estimated };
}

function parseToolFragments(
  fragments: Map<number, { id: string; name: string; argumentsText: string }>
): PiToolCall[] {
  return [...fragments.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, fragment]) => {
      if (fragment.name.length === 0) {
        throw new Error("Pi progressive tool call has no name");
      }
      let args: unknown = {};
      if (fragment.argumentsText.trim().length > 0) {
        try {
          args = JSON.parse(fragment.argumentsText) as unknown;
        } catch {
          throw new Error(`Pi tool arguments are not valid JSON: ${fragment.argumentsText}`);
        }
      }
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        throw new Error("Pi tool arguments must be a JSON object");
      }
      return {
        id: fragment.id.length > 0 ? fragment.id : `pi-tool-${String(index)}`,
        name: fragment.name,
        arguments: args as Record<string, unknown>
      };
    });
}

export async function* runProgressiveProviderTurn(
  input: RunProgressiveProviderTurnInput
): AsyncGenerator<ExecutionEvent, ProgressiveProviderTurnResult> {
  const providerBase = {
    profile: input.request.route.providerProfile,
    modelId: input.request.route.modelId,
    systemPrompt: input.systemPrompt,
    messages: input.messages,
    tools: input.tools,
    ...(input.toolChoice === undefined
      ? {}
      : { toolChoice: input.toolChoice }),
    maxOutputTokens: input.maxOutputTokens,
    ...(input.cacheKey === undefined ? {} : { cacheKey: input.cacheKey })
  };

  const runBufferedOnce = async (
    thinkingEnabled: boolean,
    attemptKind: ProgressiveProviderAttemptKind
  ): Promise<ProgressiveProviderTurnResult> => {
    const providerRequest = buildPiProviderRequest({
      ...providerBase,
      stream: false,
      thinkingEnabled
    });
    const estimatedInputTokens = estimateTextTokens(
      JSON.stringify(providerRequest.body)
    );
    const response = await input.dependencies.bufferedRequest(providerRequest);
    if (response.status >= 400) {
      const message = errorMessage(response.status, response.json);
      if (isTransientProviderStatus(response.status)) {
        throw new TransientProviderError(message);
      }
      throw new Error(message);
    }
    const parsed = parsePiProviderResponse(
      input.request.route.providerProfile,
      response.json
    );
    return validateResult({
      text: parsed.text,
      thinking: parsed.thinking,
      toolCalls: parsed.toolCalls,
      ...(parsed.usage === undefined ? {} : { usage: parsed.usage }),
      attempts: [
        {
          kind: attemptKind,
          ...(parsed.usage === undefined ? {} : { usage: parsed.usage }),
          estimatedInputTokens
        }
      ],
      stopReason: parsed.stopReason,
      releasedText: false
    });
  };

  const runBufferedOnceWithTransientRetry = async (
    thinkingEnabled: boolean,
    attemptKind: ProgressiveProviderAttemptKind
  ): Promise<ProgressiveProviderTurnResult> => {
    try {
      return await runBufferedOnce(thinkingEnabled, attemptKind);
    } catch (error) {
      if (!isTransientHttpError(error)) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS)
      );
      return await runBufferedOnce(thinkingEnabled, attemptKind);
    }
  };

  const runBuffered = async (
    thinkingEnabled: boolean,
    attemptKind: ProgressiveProviderAttemptKind = "primary"
  ): Promise<ProgressiveProviderTurnResult> => {
    const first = await runBufferedOnceWithTransientRetry(
      thinkingEnabled,
      attemptKind
    );
    if (
      first.stopReason === "length" &&
      first.text.trim().length === 0 &&
      first.toolCalls.length === 0 &&
      thinkingEnabled
    ) {
      const retry = await runBufferedOnceWithTransientRetry(
        false,
        "thinking-disabled-recovery"
      );
      const combinedUsage = addUsage(first.usage, retry.usage);
      return {
        ...withEstimatedInput({
          ...retry,
          attempts: [...first.attempts, ...retry.attempts]
        }),
        ...(combinedUsage === undefined ? {} : { usage: combinedUsage }),
        thinking: [first.thinking, retry.thinking]
          .filter((entry) => entry.length > 0)
          .join("\n")
      };
    }
    return first;
  };

  const useBuffered =
    input.request.streamingOutputEnabled === false ||
    input.dependencies.streamRequest === undefined;
  if (useBuffered) {
    const result = await runBuffered(input.thinkingEnabled);
    if (result.thinking.length > 0) {
      yield { type: "thinking-delta", text: result.thinking };
    }
    if (result.mode === "final" && result.text.length > 0) {
      yield {
        type: "response-status",
        progress: { status: "generating-final-answer" }
      };
      yield { type: "text-delta", text: result.text };
      result.releasedText = true;
    }
    return result;
  }

  const providerRequest = buildPiProviderRequest({
    ...providerBase,
    stream: true,
    thinkingEnabled: input.thinkingEnabled
  });
  const primaryEstimatedInputTokens = estimateTextTokens(
    JSON.stringify(providerRequest.body)
  );
  let mode: "undecided" | "final" | "tool" = "undecided";
  let text = "";
  let thinking = "";
  let usage: NormalizedUsage | undefined;
  let stopReason: "stop" | "tool_calls" | "length" = "stop";
  let releasedText = false;
  let completed = false;
  let failure: unknown;
  const fragments = new Map<number, { id: string; name: string; argumentsText: string }>();
  try {
    for await (const event of input.dependencies.streamRequest!(
      input.request.route.providerProfile,
      providerRequest,
      input.signal
    )) {
      if (event.type === "delta" && event.text.length > 0) {
        if (mode === "tool") {
          throw new Error("Pi tool turn also emitted answer text");
        }
        mode = "final";
        text += event.text;
        releasedText = true;
        yield { type: "text-delta", text: event.text };
        continue;
      }
      if (event.type === "thinking-delta") {
        thinking += event.text;
        if (event.text.length > 0) {
          yield { type: "thinking-delta", text: event.text };
        }
        continue;
      }
      if (event.type === "tool-call-delta") {
        if (mode === "final") {
          throw new Error("Pi answer turn also emitted a tool call");
        }
        mode = "tool";
        const current = fragments.get(event.index) ?? {
          id: "",
          name: "",
          argumentsText: ""
        };
        if (event.id !== undefined) current.id = event.id;
        if (event.name !== undefined) current.name += event.name;
        if (event.argumentsText !== undefined) {
          current.argumentsText += event.argumentsText;
        }
        fragments.set(event.index, current);
        continue;
      }
      if (event.type === "usage") {
        usage = addUsage(usage, event.usage);
        continue;
      }
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "finish") {
        completed = true;
        stopReason =
          event.reason === "length"
            ? "length"
            : event.reason === "tool_calls"
              ? "tool_calls"
              : "stop";
        continue;
      }
      if (event.type === "done") completed = true;
    }
  } catch (error) {
    failure = error;
  }

  if (input.signal.aborted) throw new DOMException("Aborted", "AbortError");
  if (failure !== undefined) {
    const canFallback =
      input.dependencies.canUseBufferedFallback ?? defaultCanUseBufferedFallback;
    if (!releasedText && (canFallback(failure) || isTransientHttpError(failure))) {
      let fallback = await runBuffered(
        input.thinkingEnabled,
        "buffered-fallback"
      );
      if (usage !== undefined) {
        const combinedUsage = addUsage(usage, fallback.usage);
        if (combinedUsage !== undefined) fallback.usage = combinedUsage;
        fallback.attempts = [
          {
            kind: "primary",
            usage,
            estimatedInputTokens: primaryEstimatedInputTokens
          },
          ...fallback.attempts
        ];
        fallback = withEstimatedInput(fallback);
      }
      if (fallback.mode === "final" && fallback.text.length > 0) {
        yield {
          type: "response-status",
          progress: { status: "generating-final-answer" }
        };
        yield { type: "text-delta", text: fallback.text };
        fallback.releasedText = true;
      }
      return fallback;
    }
    throw failure;
  }
  if (!completed) {
    throw new Error("Streaming response ended without a completion frame");
  }

  if (
    stopReason === "length" &&
    !releasedText &&
    fragments.size === 0 &&
    input.thinkingEnabled
  ) {
    let retry = await runBuffered(
      false,
      "thinking-disabled-recovery"
    );
    const combined = addUsage(usage, retry.usage);
    if (combined !== undefined) retry.usage = combined;
    retry.attempts = [
      {
        kind: "primary",
        ...(usage === undefined ? {} : { usage }),
        estimatedInputTokens: primaryEstimatedInputTokens
      },
      ...retry.attempts
    ];
    retry = withEstimatedInput(retry);
    retry.thinking = [thinking, retry.thinking]
      .filter((entry) => entry.length > 0)
      .join("\n");
    if (retry.mode === "final" && retry.text.length > 0) {
      yield {
        type: "response-status",
        progress: { status: "generating-final-answer" }
      };
      yield { type: "text-delta", text: retry.text };
      retry.releasedText = true;
    }
    return retry;
  }

  const toolCalls = parseToolFragments(fragments);
  return validateResult({
    text,
    thinking,
    toolCalls,
    ...(usage === undefined ? {} : { usage }),
    attempts: [
      {
        kind: "primary",
        ...(usage === undefined ? {} : { usage }),
        estimatedInputTokens: primaryEstimatedInputTokens
      }
    ],
    stopReason,
    releasedText
  });
}
