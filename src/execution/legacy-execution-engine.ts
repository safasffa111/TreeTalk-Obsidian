import {
  assertStreamCompleted,
  canUseBufferedFallback as defaultCanUseBufferedFallback
} from "../providers/streaming-transport";
import type {
  NormalizedUsage,
  ProviderAdapter,
  ProviderEvent,
  ProviderProfile,
  ProviderRequest
} from "../providers/types";
import type {
  ExecutionEngine,
  ExecutionEvent,
  ExecutionRequest
} from "./types";
import { resolveAnswerThinkingMode } from "./answer-thinking";

export interface BufferedProviderResponse {
  status: number;
  json: unknown;
}

export interface LegacyExecutionEngineDependencies {
  resolveAdapter(profile: ProviderProfile): ProviderAdapter;
  stream(
    adapter: ProviderAdapter,
    request: ProviderRequest,
    signal: AbortSignal
  ): AsyncIterable<ProviderEvent>;
  bufferedRequest(request: ProviderRequest): Promise<BufferedProviderResponse>;
  canUseBufferedFallback?(error: unknown): boolean;
  now?(): string;
}

function mergeUsage(
  current: NormalizedUsage | undefined,
  next: NormalizedUsage
): NormalizedUsage {
  const promptTokens = next.promptTokens ?? current?.promptTokens;
  const completionTokens = next.completionTokens ?? current?.completionTokens;
  const reasoningTokens = next.reasoningTokens ?? current?.reasoningTokens;
  const cacheHitTokens = next.cacheHitTokens ?? current?.cacheHitTokens;
  const cacheMissTokens = next.cacheMissTokens ?? current?.cacheMissTokens;
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cacheHitTokens === undefined ? {} : { cacheHitTokens }),
    ...(cacheMissTokens === undefined ? {} : { cacheMissTokens }),
    providerReported: next.providerReported || (current?.providerReported ?? false)
  };
}

function addUsageTotals(
  current: NormalizedUsage | undefined,
  next: NormalizedUsage | undefined
): NormalizedUsage | undefined {
  if (next === undefined) return current;
  const sum = (
    left: number | undefined,
    right: number | undefined
  ): number | undefined =>
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

const DEEPSEEK_FINAL_MAX_OUTPUT_TOKENS = 16_384;

function finalAnswerMaxOutputTokens(
  profile: ProviderProfile
): number | undefined {
  return profile.kind === "deepseek"
    ? DEEPSEEK_FINAL_MAX_OUTPUT_TOKENS
    : undefined;
}

export class LegacyExecutionEngine implements ExecutionEngine {
  private readonly canUseBufferedFallback: (error: unknown) => boolean;
  private readonly now: () => string;

  constructor(private readonly dependencies: LegacyExecutionEngineDependencies) {
    this.canUseBufferedFallback =
      dependencies.canUseBufferedFallback ?? defaultCanUseBufferedFallback;
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  async *execute(
    request: ExecutionRequest,
    signal: AbortSignal
  ): AsyncIterable<ExecutionEvent> {
    yield {
      type: "stage-start",
      stageId: request.roleId,
      roleId: request.roleId,
      routeId: request.route.routeId,
      startedAt: this.now()
    };
    yield {
      type: "response-status",
      progress: {
        status: request.webSearchEnabled
          ? "deciding-web-search"
          : "preparing-context"
      }
    };

    const adapter = this.dependencies.resolveAdapter(
      request.route.providerProfile
    );
    const answerThinking = resolveAnswerThinkingMode({
      mode: request.answerThinkingMode ?? "auto",
      currentQuestion:
        request.currentQuestion ??
        [...request.contextMessages]
          .reverse()
          .find((message) => message.role === "user")?.content ??
        "",
      ...(request.selectionCount === undefined
        ? {}
        : { selectionCount: request.selectionCount }),
      sourceCount: request.contextMessages.length
    });
    const maxOutputTokens = finalAnswerMaxOutputTokens(
      request.route.providerProfile
    );
    let receivedText = false;
    let receivedDone = false;
    let usage: NormalizedUsage | undefined;
    let anthropicContinuation: unknown[] | undefined;
    let continuationCount = 0;
    let lastSearchStatus: "searching" | "complete" | undefined;

    try {
      while (!receivedDone) {
        let turnReceivedText = false;
        let turnFinished = false;
        let turnDone = false;
        let pauseContent: unknown[] | undefined;
        let turnUsage: NormalizedUsage | undefined;
        let streamFailure: unknown;
        let turnFinishReason: "stop" | "length" | "tool_calls" | "unknown" | undefined;
        const providerRequest = adapter.buildRequest(
          {
            messages: request.contextMessages,
            model: request.route.modelId,
            stream: request.streamingOutputEnabled !== false,
            webSearchEnabled: request.webSearchEnabled,
            thinkingEnabled: answerThinking.enabled,
            ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
            ...(anthropicContinuation === undefined
              ? {}
              : { anthropicContinuation }),
            ...(request.contextCacheKey === undefined
              ? {}
              : { cacheKey: request.contextCacheKey })
          },
          request.route.providerProfile
        );

        if (!request.webSearchEnabled) {
          yield {
            type: "response-status",
            progress: { status: "generating-final-answer" }
          };
        }

        const handle = function* (
          event: ProviderEvent
        ): Generator<ExecutionEvent> {
          if (event.type === "delta" && event.text.length > 0) {
            receivedText = true;
            turnReceivedText = true;
            yield { type: "text-delta", text: event.text };
            return;
          }
          if (event.type === "thinking-delta" && event.text.length > 0) {
            yield { type: "thinking-delta", text: event.text };
            return;
          }
          if (event.type === "usage") {
            turnUsage = mergeUsage(turnUsage, event.usage);
            return;
          }
          if (event.type === "sources") {
            yield {
              type: "sources",
              sources: event.sources.map((source) => ({ ...source }))
            };
            return;
          }
          if (event.type === "search-status") {
            if (lastSearchStatus === event.status) return;
            lastSearchStatus = event.status;
            yield {
              type: "response-status",
              progress: {
                status:
                  event.status === "searching"
                    ? "searching-web"
                    : "organizing-web-results"
              }
            };
            return;
          }
          if (event.type === "pause") {
            pauseContent = event.content;
            return;
          }
          if (event.type === "error") {
            throw new Error(event.message);
          }
          if (event.type === "finish") {
            turnFinished = true;
            turnFinishReason = event.reason;
          }
          if (event.type === "done") {
            turnDone = true;
            turnFinished = true;
          }
        };

        if (request.streamingOutputEnabled !== false) {
          try {
            for await (const event of this.dependencies.stream(
              adapter,
              providerRequest,
              signal
            )) {
              for (const normalized of handle(event)) yield normalized;
              if (event.type === "pause" || event.type === "done") break;
            }
          } catch (error) {
            streamFailure = error;
          }
        } else {
          const bufferedProviderRequest = adapter.buildRequest(
            {
              messages: request.contextMessages,
              model: request.route.modelId,
              stream: false,
              webSearchEnabled: request.webSearchEnabled,
              thinkingEnabled: answerThinking.enabled,
              ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
              ...(anthropicContinuation === undefined
                ? {}
                : { anthropicContinuation }),
              ...(request.contextCacheKey === undefined
                ? {}
                : { cacheKey: request.contextCacheKey })
            },
            request.route.providerProfile
          );
          const response = await this.dependencies.bufferedRequest(
            bufferedProviderRequest
          );
          if (response.status >= 400) {
            throw new Error(`HTTP ${String(response.status)}`);
          }
          let bufferedText = "";
          for (const event of adapter.parseBuffered(
            response.json,
            bufferedProviderRequest
          )) {
            if (event.type === "delta") {
              bufferedText += event.text;
              continue;
            }
            for (const normalized of handle(event)) yield normalized;
          }
          if (bufferedText.length > 0) {
            receivedText = true;
            turnReceivedText = true;
            yield { type: "text-delta", text: bufferedText };
          }
        }

        if (signal.aborted) {
          yield { type: "finish", reason: "aborted" };
          return;
        }

        if (
          request.streamingOutputEnabled !== false &&
          !turnReceivedText &&
          this.canUseBufferedFallback(streamFailure)
        ) {
          const fallbackRequest = adapter.buildRequest(
            {
              messages: request.contextMessages,
              model: request.route.modelId,
              stream: false,
              webSearchEnabled: request.webSearchEnabled,
              thinkingEnabled: answerThinking.enabled,
              ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
              ...(anthropicContinuation === undefined
                ? {}
                : { anthropicContinuation }),
              ...(request.contextCacheKey === undefined
                ? {}
                : { cacheKey: request.contextCacheKey })
            },
            request.route.providerProfile
          );
          const response = await this.dependencies.bufferedRequest(
            fallbackRequest
          );
          if (response.status >= 400) {
            throw new Error(`HTTP ${String(response.status)}`);
          }
          for (const event of adapter.parseBuffered(
            response.json,
            fallbackRequest
          )) {
            for (const normalized of handle(event)) yield normalized;
          }
          streamFailure = undefined;
        }

        if (
          answerThinking.enabled &&
          !turnReceivedText &&
          turnFinishReason === "length"
        ) {
          const thinkingAttemptUsage = turnUsage;
          turnUsage = undefined;
          const retryWithoutThinking = adapter.buildRequest(
            {
              messages: request.contextMessages,
              model: request.route.modelId,
              stream: false,
              webSearchEnabled: request.webSearchEnabled,
              thinkingEnabled: false,
              ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
              ...(anthropicContinuation === undefined
                ? {}
                : { anthropicContinuation }),
              ...(request.contextCacheKey === undefined
                ? {}
                : { cacheKey: request.contextCacheKey })
            },
            request.route.providerProfile
          );
          const response = await this.dependencies.bufferedRequest(
            retryWithoutThinking
          );
          if (response.status >= 400) {
            throw new Error(`HTTP ${String(response.status)}`);
          }
          turnFinished = false;
          turnDone = false;
          turnFinishReason = undefined;
          for (const event of adapter.parseBuffered(
            response.json,
            retryWithoutThinking
          )) {
            for (const normalized of handle(event)) yield normalized;
          }
          turnUsage = addUsageTotals(thinkingAttemptUsage, turnUsage);
        }

        if (streamFailure !== undefined) throw streamFailure;
        usage = addUsageTotals(usage, turnUsage);
        if (usage !== undefined) {
          yield { type: "usage", usage };
        }

        if (pauseContent !== undefined) {
          if (!request.webSearchEnabled || continuationCount >= 2) {
            throw new Error("联网搜索未能在限定轮次内完成");
          }
          anthropicContinuation = [
            ...(anthropicContinuation ?? []),
            ...pauseContent
          ];
          continuationCount += 1;
          continue;
        }

        if (turnDone || turnFinished) {
          receivedDone = true;
          break;
        }
        throw new Error("Streaming response ended without a completion frame");
      }

      assertStreamCompleted(receivedText, receivedDone);
      yield { type: "finish", reason: "stop" };
    } catch (error) {
      if (signal.aborted) {
        yield { type: "finish", reason: "aborted" };
        return;
      }
      yield {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        retryable: true
      };
    }
  }
}
