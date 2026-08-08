import { estimateTextTokens } from "../../domain/context-engine";
import { canUseBufferedFallback as defaultCanUseBufferedFallback } from "../../providers/streaming-transport";
import { resolveAnswerThinkingMode } from "../../execution/answer-thinking";
import type {
  NormalizedUsage,
  ProviderEvent,
  ProviderProfile,
  ProviderRequest
} from "../../providers/types";
import type {
  ExecutionEngine,
  ExecutionEvent,
  ExecutionRequest,
  PiFocusScope
} from "../../execution/types";
import {
  materializePiEvidence,
  type PiMaterializedEvidence
} from "./evidence-materializer";
import {
  materializePiFocusEvidence,
  resolvePiFocusDecisions
} from "./focus-evidence";
import {
  mergePiContextSelections,
  parsePiContextSelection,
  parsePiNeedMoreContext,
  type PiContextSelection,
  type PiNeedMoreContextRequest
} from "./context-selection";
import { PiContextWorkspace } from "./context-workspace";
import {
  buildPiProviderRequest,
  parsePiProviderResponse
} from "./pi-provider-transport";
import {
  PiAnswerStreamDecoder,
  parsePiAnswerEnvelope
} from "./answer-stream-protocol";
import {
  buildPiAnswerPrompt,
  buildPiSelectorPrompt,
  buildPiSupplementarySelectorPrompt,
  type PiBuiltPrompt
} from "./two-pass-prompts";

export interface PiBufferedResponse {
  status: number;
  json: unknown;
}

export interface PiWebPageResponse {
  status: number;
  text: string;
  contentType?: string;
}

export interface TwoPassPiExecutionEngineDependencies {
  bufferedRequest(request: ProviderRequest): Promise<PiBufferedResponse>;
  webPageRequest?(url: string, signal: AbortSignal): Promise<PiWebPageResponse>;
  streamRequest?(
    profile: ProviderProfile,
    request: ProviderRequest,
    signal: AbortSignal
  ): AsyncIterable<ProviderEvent>;
  canUseBufferedFallback?(error: unknown): boolean;
  now?(): string;
  maxTurns?: number;
  maxOutputTokens?: number;
  initialEvidenceTokenBudget?: number;
  supplementaryEvidenceTokenBudget?: number;
  selectorInputTokenBudget?: number;
}

const PI_RUNTIME = "pi-agent-core-v0.82.1-vendored" as const;
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const DEEPSEEK_FINAL_MAX_OUTPUT_TOKENS = 16_384;
const DEFAULT_INITIAL_EVIDENCE_TOKENS = 12_000;
const DEFAULT_SUPPLEMENTARY_EVIDENCE_TOKENS = 6_000;
const DEFAULT_SELECTOR_INPUT_TOKENS = 2_000;
const SELECTOR_MAX_OUTPUT_TOKENS = 1024;

function finalAnswerMaxOutputTokens(
  profile: ProviderProfile,
  configured: number
): number {
  return profile.kind === "deepseek"
    ? Math.max(configured, DEEPSEEK_FINAL_MAX_OUTPUT_TOKENS)
    : configured;
}

function fallbackPiContextSelection(
  fallbackFocusScope: PiFocusScope
): PiContextSelection {
  return {
    focusScope: fallbackFocusScope,
    focusReason: "",
    focusDecisions: [],
    notes: [],
    nodes: []
  };
}

function parsePiContextSelectionOrFallback(
  value: string,
  fallbackFocusScope: PiFocusScope
): PiContextSelection {
  try {
    return parsePiContextSelection(value, fallbackFocusScope);
  } catch {
    return fallbackPiContextSelection(fallbackFocusScope);
  }
}

function addUsage(
  current: NormalizedUsage | undefined,
  next: NormalizedUsage | undefined
): NormalizedUsage | undefined {
  if (next === undefined) return current;
  const sum = (
    left: number | undefined,
    right: number | undefined
  ): number | undefined =>
    left === undefined && right === undefined
      ? undefined
      : (left ?? 0) + (right ?? 0);
  const promptTokens = sum(current?.promptTokens, next.promptTokens);
  const completionTokens = sum(
    current?.completionTokens,
    next.completionTokens
  );
  const reasoningTokens = sum(current?.reasoningTokens, next.reasoningTokens);
  const cacheHitTokens = sum(current?.cacheHitTokens, next.cacheHitTokens);
  const cacheMissTokens = sum(current?.cacheMissTokens, next.cacheMissTokens);
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cacheHitTokens === undefined ? {} : { cacheHitTokens }),
    ...(cacheMissTokens === undefined ? {} : { cacheMissTokens }),
    providerReported:
      next.providerReported || (current?.providerReported ?? false)
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

function combineEvidence(
  focus: PiMaterializedEvidence,
  selected: PiMaterializedEvidence,
  supplementary?: PiMaterializedEvidence
): string {
  const parts: string[] = [];
  if (focus.markdown.trim().length > 0) parts.push(focus.markdown);
  if (selected.materializedKeys.length > 0) parts.push(selected.markdown);
  if (supplementary !== undefined && supplementary.materializedKeys.length > 0) {
    const supplementBody = supplementary.markdown.replace(
      /^# Selected Evidence\s*/u,
      ""
    );
    parts.push(`# Supplementary Evidence\n\n${supplementBody}`);
  }
  return parts.join("\n\n");
}

function union(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right])];
}

interface PiAnswerPassResult {
  text: string;
  usage?: NormalizedUsage;
  thinking: string;
  needMoreContext?: PiNeedMoreContextRequest;
  releasedText: boolean;
}

interface PiAnswerPassInput {
  dependencies: TwoPassPiExecutionEngineDependencies;
  request: ExecutionRequest;
  signal: AbortSignal;
  prompt: PiBuiltPrompt;
  maxOutputTokens: number;
  cacheNamespace: string;
  allowNeedMoreContext: boolean;
  thinkingEnabled: boolean;
  canUseBufferedFallback(error: unknown): boolean;
}

async function* executePiAnswerPass(
  input: PiAnswerPassInput
): AsyncGenerator<ExecutionEvent, PiAnswerPassResult> {
  const providerInput = {
    profile: input.request.route.providerProfile,
    modelId: input.request.route.modelId,
    systemPrompt: input.prompt.systemPrompt,
    messages: [{ role: "user" as const, content: input.prompt.userPrompt }],
    tools: [],
    maxOutputTokens: input.maxOutputTokens,
    thinkingEnabled: input.thinkingEnabled,
    cacheKey: `${input.cacheNamespace}:${input.prompt.stablePrefixHash}`
  };

  const buffered = async (
    thinkingEnabled = input.thinkingEnabled
  ): Promise<PiAnswerPassResult> => {
    const providerRequest = buildPiProviderRequest({
      ...providerInput,
      stream: false,
      thinkingEnabled
    });
    const response = await input.dependencies.bufferedRequest(providerRequest);
    if (response.status >= 400) {
      throw new Error(errorMessage(response.status, response.json));
    }
    const parsed = parsePiProviderResponse(
      input.request.route.providerProfile,
      response.json
    );
    if (parsed.toolCalls.length > 0) {
      throw new Error("Pi two-pass request unexpectedly returned a tool call");
    }
    if (parsed.stopReason === "length") {
      if (thinkingEnabled) {
        const retry = await buffered(false);
        const combinedUsage = addUsage(parsed.usage, retry.usage);
        const { usage: _retryUsage, ...retryWithoutUsage } = retry;
        return {
          ...retryWithoutUsage,
          ...(combinedUsage === undefined ? {} : { usage: combinedUsage }),
          thinking: [parsed.thinking, retry.thinking]
            .filter((entry) => entry.length > 0)
            .join("\n")
        };
      }
      throw new Error("Pi response reached the model token limit before completion");
    }
    const envelope = parsePiAnswerEnvelope(parsed.text);
    const needMoreContext = input.allowNeedMoreContext
      ? parsePiNeedMoreContext(envelope.text)
      : undefined;
    if (envelope.mode === "need_more_context" || needMoreContext !== undefined) {
      const resolvedNeedMoreContext =
        needMoreContext ?? parsePiNeedMoreContext(envelope.text);
      if (resolvedNeedMoreContext === undefined) {
        throw new Error("Pi need-more-context response is not valid JSON");
      }
      return {
        text: envelope.text,
        ...(parsed.usage === undefined ? {} : { usage: parsed.usage }),
        thinking: parsed.thinking,
        needMoreContext: resolvedNeedMoreContext,
        releasedText: false
      };
    }
    if (envelope.text.trim().length === 0) {
      throw new Error("Pi answer pass returned no text");
    }
    return {
      text: envelope.text,
      ...(parsed.usage === undefined ? {} : { usage: parsed.usage }),
      thinking: parsed.thinking,
      releasedText: false
    };
  };

  if (
    input.request.streamingOutputEnabled === false ||
    input.dependencies.streamRequest === undefined
  ) {
    const result = await buffered();
    if (result.needMoreContext === undefined) {
      yield {
        type: "response-status",
        progress: { status: "generating-final-answer" }
      };
      yield { type: "text-delta", text: result.text };
      result.releasedText = true;
    }
    return result;
  }

  const providerRequest = buildPiProviderRequest({ ...providerInput, stream: true });
  const decoder = new PiAnswerStreamDecoder();
  let usage: NormalizedUsage | undefined;
  let releasedText = false;
  let completed = false;
  let finishReason: "stop" | "length" | "tool_calls" | "unknown" | undefined;
  let failure: unknown;
  let announcedFinal = false;
  try {
    for await (const event of input.dependencies.streamRequest(
      input.request.route.providerProfile,
      providerRequest,
      input.signal
    )) {
      if (event.type === "delta") {
        const chunks = decoder.push(event.text);
        if (decoder.mode === "final" && !announcedFinal) {
          announcedFinal = true;
          yield {
            type: "response-status",
            progress: { status: "generating-final-answer" }
          };
        }
        for (const chunk of chunks) {
          if (chunk.length === 0) continue;
          releasedText = true;
          yield { type: "text-delta", text: chunk };
        }
        continue;
      }
      if (event.type === "thinking-delta") {
        if (event.text.length > 0) {
          yield { type: "thinking-delta", text: event.text };
        }
        continue;
      }
      if (event.type === "usage") {
        usage = addUsage(usage, event.usage);
        continue;
      }
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "finish") {
        completed = true;
        finishReason = event.reason;
      }
      if (event.type === "done") completed = true;
    }
  } catch (error) {
    failure = error;
  }

  if (input.signal.aborted) throw new DOMException("Aborted", "AbortError");
  if (failure !== undefined) {
    if (!releasedText && input.canUseBufferedFallback(failure)) {
      const result = await buffered();
      if (result.needMoreContext === undefined) {
        yield {
          type: "response-status",
          progress: { status: "generating-final-answer" }
        };
        yield { type: "text-delta", text: result.text };
        result.releasedText = true;
      }
      return result;
    }
    throw failure;
  }
  if (!completed) throw new Error("Streaming response ended without a completion frame");
  if (finishReason === "length" && !releasedText && input.thinkingEnabled) {
    const retryWithoutThinking = await buffered(false);
    const combinedRetryUsage = addUsage(usage, retryWithoutThinking.usage);
    if (combinedRetryUsage !== undefined) {
      retryWithoutThinking.usage = combinedRetryUsage;
    }
    if (retryWithoutThinking.needMoreContext === undefined) {
      yield {
        type: "response-status",
        progress: { status: "generating-final-answer" }
      };
      yield { type: "text-delta", text: retryWithoutThinking.text };
      retryWithoutThinking.releasedText = true;
    }
    return retryWithoutThinking;
  }

  const envelope = decoder.finish();
  const needMoreContext = input.allowNeedMoreContext
    ? parsePiNeedMoreContext(envelope.text)
    : undefined;
  if (envelope.mode === "need_more_context" || needMoreContext !== undefined) {
    const resolvedNeedMoreContext =
      needMoreContext ?? parsePiNeedMoreContext(envelope.text);
    if (resolvedNeedMoreContext === undefined) {
      throw new Error("Pi need-more-context response is not valid JSON");
    }
    return {
      text: envelope.text,
      ...(usage === undefined ? {} : { usage }),
      thinking: "",
      needMoreContext: resolvedNeedMoreContext,
      releasedText
    };
  }
  if (envelope.text.trim().length === 0) {
    throw new Error("Pi answer pass returned no text");
  }
  if (!releasedText) {
    yield {
      type: "response-status",
      progress: { status: "generating-final-answer" }
    };
    yield { type: "text-delta", text: envelope.text };
    releasedText = true;
  }
  return {
    text: envelope.text,
    ...(usage === undefined ? {} : { usage }),
    thinking: "",
    releasedText
  };
}


/**
 * TreeTalk's Obsidian-safe Pi execution runtime.
 *
 * Alpha.10 keeps target-locked two-pass routing while allowing the final answer
 * pass to stream without exposing selector or control-protocol output:
 * 1. selector sees the compact index plus explicit targets and scoped context;
 * 2. TreeTalk materializes target, structural, and expansion evidence separately;
 * 3. answer model receives a clean request with a repeated target lock;
 * 4. one supplementary evidence request is allowed, without carrying selector
 *    transcripts or tool schemas into the answer context.
 */
export class TwoPassPiExecutionEngine implements ExecutionEngine {
  private readonly now: () => string;
  private readonly maxOutputTokens: number;
  private readonly initialEvidenceTokenBudget: number;
  private readonly supplementaryEvidenceTokenBudget: number;
  private readonly selectorInputTokenBudget: number;
  private readonly canUseBufferedFallback: (error: unknown) => boolean;

  constructor(private readonly dependencies: TwoPassPiExecutionEngineDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.maxOutputTokens = Math.max(
      512,
      dependencies.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
    );
    this.initialEvidenceTokenBudget = Math.max(
      0,
      dependencies.initialEvidenceTokenBudget ?? DEFAULT_INITIAL_EVIDENCE_TOKENS
    );
    this.supplementaryEvidenceTokenBudget = Math.max(
      0,
      dependencies.supplementaryEvidenceTokenBudget ??
        DEFAULT_SUPPLEMENTARY_EVIDENCE_TOKENS
    );
    this.selectorInputTokenBudget = Math.max(
      512,
      dependencies.selectorInputTokenBudget ?? DEFAULT_SELECTOR_INPUT_TOKENS
    );
    this.canUseBufferedFallback =
      dependencies.canUseBufferedFallback ?? defaultCanUseBufferedFallback;
  }

  async *execute(
    request: ExecutionRequest,
    signal: AbortSignal
  ): AsyncIterable<ExecutionEvent> {
    yield {
      type: "agent-start",
      runtime: PI_RUNTIME,
      roleId: request.roleId
    };
    yield {
      type: "response-status",
      progress: {
        status:
          (request.piContext?.focus?.targets?.length ?? 0) > 0
            ? "identifying-focus"
            : "preparing-context"
      }
    };
    yield {
      type: "response-status",
      progress: { status: "selecting-context" }
    };

    const workspace = new PiContextWorkspace(
      request.piContext?.noteContextGraph,
      request.piContext?.conversationNodes ?? []
    );
    const catalogQueryText = [
      request.piContext?.currentQuestion ?? "",
      ...(request.piContext?.selectedQuotes ?? []),
      ...((request.piContext?.focus?.targets ?? []).flatMap((target) =>
        target.kind === "exact-selection" ? [target.text] : []
      ))
    ].filter(Boolean).join(" ");
    const catalog = workspace.catalogSnapshot({ queryText: catalogQueryText });
    let usage: NormalizedUsage | undefined;

    const callBuffered = async (
      prompt: PiBuiltPrompt,
      maxOutputTokens: number,
      cacheNamespace: string
    ) => {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const providerRequest = buildPiProviderRequest({
        profile: request.route.providerProfile,
        modelId: request.route.modelId,
        systemPrompt: prompt.systemPrompt,
        messages: [{ role: "user", content: prompt.userPrompt }],
        tools: [],
        maxOutputTokens,
        cacheKey: `${cacheNamespace}:${prompt.stablePrefixHash}`,
        stream: false,
        thinkingEnabled: false
      });
      const response = await this.dependencies.bufferedRequest(providerRequest);
      if (response.status >= 400) {
        throw new Error(errorMessage(response.status, response.json));
      }
      const parsed = parsePiProviderResponse(
        request.route.providerProfile,
        response.json
      );
      if (parsed.toolCalls.length > 0) {
        throw new Error("Pi two-pass request unexpectedly returned a tool call");
      }
      return parsed;
    };

    try {
      yield {
        type: "stage-start",
        stageId: "pi-context-selector",
        roleId: request.roleId,
        routeId: request.route.routeId,
        startedAt: this.now()
      };
      const selectorPrompt = buildPiSelectorPrompt(request, catalog, {
        tokenBudget: this.selectorInputTokenBudget
      });
      const selector = await callBuffered(
        selectorPrompt,
        SELECTOR_MAX_OUTPUT_TOKENS,
        "treetalk-selector-v1"
      );
      yield {
        type: "stage-usage",
        stageId: "pi-context-selector",
        ...(selector.usage === undefined ? {} : { usage: selector.usage }),
        stablePrefixHash: selectorPrompt.stablePrefixHash,
        stablePrefixEstimatedTokens: selectorPrompt.stablePrefixEstimatedTokens,
        dynamicTailEstimatedTokens: selectorPrompt.dynamicTailEstimatedTokens,
        ...(selectorPrompt.tokenBreakdown === undefined
          ? {}
          : { selectorTokenBreakdown: selectorPrompt.tokenBreakdown })
      };
      usage = addUsage(usage, selector.usage);
      if (usage !== undefined) yield { type: "usage", usage };
      const fallbackFocusScope =
        request.piContext?.focus?.defaultScope ?? "latest_round";
      const initialSelection = parsePiContextSelectionOrFallback(
        selector.text,
        fallbackFocusScope
      );
      const requestedFocusPlan = initialSelection.focusDecisions.length > 0
        ? initialSelection.focusDecisions
        : initialSelection.focusScope;
      const initialFocusPlan = resolvePiFocusDecisions(
        request.piContext?.focus,
        requestedFocusPlan
      );
      const focusEvidence = materializePiFocusEvidence(
        workspace,
        request.piContext?.focus,
        initialFocusPlan,
        { tokenBudget: this.initialEvidenceTokenBudget }
      );
      const initialEvidence = materializePiEvidence(
        workspace,
        initialSelection,
        {
          tokenBudget: Math.max(
            0,
            this.initialEvidenceTokenBudget - focusEvidence.estimatedTokens
          ),
          alreadyMaterializedKeys: new Set(focusEvidence.materializedKeys)
        }
      );
      const initialCombinedEvidence = combineEvidence(
        focusEvidence,
        initialEvidence
      );
      const initialMaterializedNotePaths = union(
        focusEvidence.materializedNotePaths,
        initialEvidence.materializedNotePaths
      );
      const initialMaterializedNodeIds = union(
        focusEvidence.materializedNodeIds,
        initialEvidence.materializedNodeIds
      );
      yield {
        type: "context-routing",
        phase: "initial",
        candidateNoteCount: request.piContext?.noteContextGraph?.nodes.length ?? 0,
        candidateNodeCount: request.piContext?.conversationNodes?.length ?? 0,
        selectedNoteCount: initialSelection.notes.length,
        selectedNodeCount: initialSelection.nodes.length,
        materializedNotePaths: initialMaterializedNotePaths,
        materializedNodeIds: initialMaterializedNodeIds,
        evidenceEstimatedTokens: estimateTextTokens(initialCombinedEvidence),
        evidenceTokenBudget: this.initialEvidenceTokenBudget,
        omittedSourceCount:
          focusEvidence.omitted.length + initialEvidence.omitted.length,
        truncated: focusEvidence.truncated || initialEvidence.truncated,
        supplementaryUsed: false
      };
      yield {
        type: "response-status",
        progress: {
          status: "context-selected",
          selectedNodeCount: initialMaterializedNodeIds.length,
          selectedNoteCount: initialMaterializedNotePaths.length,
          supplementary: false
        }
      };
      yield {
        type: "response-status",
        progress: { status: "reading-context" }
      };
      yield {
        type: "response-status",
        progress: { status: "organizing-answer" }
      };

      const answerThinking = resolveAnswerThinkingMode({
        mode: request.answerThinkingMode ?? "auto",
        currentQuestion:
          request.currentQuestion ?? request.piContext?.currentQuestion ?? "",
        ...(request.selectionCount === undefined
          ? {}
          : { selectionCount: request.selectionCount }),
        sourceCount:
          initialMaterializedNotePaths.length + initialMaterializedNodeIds.length
      });

      yield {
        type: "stage-start",
        stageId: "pi-evidence-answer",
        roleId: request.roleId,
        routeId: request.route.routeId,
        startedAt: this.now()
      };
      const answerPrompt = buildPiAnswerPrompt(
        request,
        initialCombinedEvidence,
        this.supplementaryEvidenceTokenBudget > 0,
        initialFocusPlan
      );
      const firstAnswerIterator = executePiAnswerPass({
        dependencies: this.dependencies,
        request,
        signal,
        prompt: answerPrompt,
        maxOutputTokens: finalAnswerMaxOutputTokens(
          request.route.providerProfile,
          this.maxOutputTokens
        ),
        cacheNamespace: "treetalk-answer-v1",
        allowNeedMoreContext: this.supplementaryEvidenceTokenBudget > 0,
        thinkingEnabled: answerThinking.enabled,
        canUseBufferedFallback: this.canUseBufferedFallback
      });
      let firstAnswerStep = await firstAnswerIterator.next();
      while (!firstAnswerStep.done) {
        yield firstAnswerStep.value;
        firstAnswerStep = await firstAnswerIterator.next();
      }
      const firstAnswer = firstAnswerStep.value;
      yield {
        type: "stage-usage",
        stageId: "pi-evidence-answer",
        ...(firstAnswer.usage === undefined ? {} : { usage: firstAnswer.usage }),
        stablePrefixHash: answerPrompt.stablePrefixHash,
        stablePrefixEstimatedTokens: answerPrompt.stablePrefixEstimatedTokens,
        dynamicTailEstimatedTokens: answerPrompt.dynamicTailEstimatedTokens
      };
      usage = addUsage(usage, firstAnswer.usage);
      if (usage !== undefined) yield { type: "usage", usage };
      if (firstAnswer.thinking.length > 0) {
        yield { type: "thinking-delta", text: firstAnswer.thinking };
      }
      const supplementarySelection = firstAnswer.needMoreContext;
      if (supplementarySelection === undefined) {
        yield { type: "finish", reason: "stop" };
        return;
      }

      yield {
        type: "response-status",
        progress: { status: "supplementing-context" }
      };
      yield {
        type: "stage-start",
        stageId: "pi-supplementary-selector",
        roleId: request.roleId,
        routeId: request.route.routeId,
        startedAt: this.now()
      };
      const supplementarySelectorPrompt = buildPiSupplementarySelectorPrompt(
        request,
        catalog,
        initialSelection,
        supplementarySelection.missing,
        { tokenBudget: this.selectorInputTokenBudget }
      );
      const supplementarySelector = await callBuffered(
        supplementarySelectorPrompt,
        SELECTOR_MAX_OUTPUT_TOKENS,
        "treetalk-selector-v1"
      );
      yield {
        type: "stage-usage",
        stageId: "pi-supplementary-selector",
        ...(supplementarySelector.usage === undefined
          ? {}
          : { usage: supplementarySelector.usage }),
        stablePrefixHash: supplementarySelectorPrompt.stablePrefixHash,
        stablePrefixEstimatedTokens:
          supplementarySelectorPrompt.stablePrefixEstimatedTokens,
        dynamicTailEstimatedTokens:
          supplementarySelectorPrompt.dynamicTailEstimatedTokens,
        ...(supplementarySelectorPrompt.tokenBreakdown === undefined
          ? {}
          : { selectorTokenBreakdown: supplementarySelectorPrompt.tokenBreakdown })
      };
      usage = addUsage(usage, supplementarySelector.usage);
      if (usage !== undefined) yield { type: "usage", usage };
      const supplementaryContextSelection = parsePiContextSelectionOrFallback(
        supplementarySelector.text,
        initialSelection.focusScope
      );
      const mergedSelection: PiContextSelection = mergePiContextSelections(
        initialSelection,
        supplementaryContextSelection
      );
      const supplementaryEvidence = materializePiEvidence(
        workspace,
        supplementaryContextSelection,
        {
          tokenBudget: this.supplementaryEvidenceTokenBudget,
          alreadyMaterializedKeys: new Set([
            ...focusEvidence.materializedKeys,
            ...initialEvidence.materializedKeys
          ])
        }
      );
      const combinedEvidence = combineEvidence(
        focusEvidence,
        initialEvidence,
        supplementaryEvidence
      );
      const totalEvidenceTokens = estimateTextTokens(combinedEvidence);
      const supplementaryMaterializedNotePaths = union(
        focusEvidence.materializedNotePaths,
        union(
          initialEvidence.materializedNotePaths,
          supplementaryEvidence.materializedNotePaths
        )
      );
      const supplementaryMaterializedNodeIds = union(
        focusEvidence.materializedNodeIds,
        union(
          initialEvidence.materializedNodeIds,
          supplementaryEvidence.materializedNodeIds
        )
      );
      yield {
        type: "context-routing",
        phase: "supplementary",
        candidateNoteCount: request.piContext?.noteContextGraph?.nodes.length ?? 0,
        candidateNodeCount: request.piContext?.conversationNodes?.length ?? 0,
        selectedNoteCount: mergedSelection.notes.length,
        selectedNodeCount: mergedSelection.nodes.length,
        materializedNotePaths: supplementaryMaterializedNotePaths,
        materializedNodeIds: supplementaryMaterializedNodeIds,
        evidenceEstimatedTokens: totalEvidenceTokens,
        evidenceTokenBudget:
          this.initialEvidenceTokenBudget + this.supplementaryEvidenceTokenBudget,
        omittedSourceCount:
          focusEvidence.omitted.length +
          initialEvidence.omitted.length +
          supplementaryEvidence.omitted.length,
        truncated:
          focusEvidence.truncated ||
          initialEvidence.truncated ||
          supplementaryEvidence.truncated,
        supplementaryUsed: true
      };
      yield {
        type: "response-status",
        progress: {
          status: "context-selected",
          selectedNodeCount: supplementaryMaterializedNodeIds.length,
          selectedNoteCount: supplementaryMaterializedNotePaths.length,
          supplementary: true
        }
      };
      yield {
        type: "response-status",
        progress: { status: "reading-context" }
      };

      yield {
        type: "stage-start",
        stageId: "pi-supplementary-answer",
        roleId: request.roleId,
        routeId: request.route.routeId,
        startedAt: this.now()
      };
      const finalPrompt = buildPiAnswerPrompt(
        request,
        combinedEvidence,
        false,
        resolvePiFocusDecisions(
          request.piContext?.focus,
          mergedSelection.focusDecisions.length > 0
            ? mergedSelection.focusDecisions
            : initialSelection.focusScope
        )
      );
      const finalAnswerIterator = executePiAnswerPass({
        dependencies: this.dependencies,
        request,
        signal,
        prompt: finalPrompt,
        maxOutputTokens: finalAnswerMaxOutputTokens(
          request.route.providerProfile,
          this.maxOutputTokens
        ),
        cacheNamespace: "treetalk-answer-v1",
        allowNeedMoreContext: false,
        thinkingEnabled: answerThinking.enabled,
        canUseBufferedFallback: this.canUseBufferedFallback
      });
      let finalAnswerStep = await finalAnswerIterator.next();
      while (!finalAnswerStep.done) {
        yield finalAnswerStep.value;
        finalAnswerStep = await finalAnswerIterator.next();
      }
      const finalAnswer = finalAnswerStep.value;
      yield {
        type: "stage-usage",
        stageId: "pi-supplementary-answer",
        ...(finalAnswer.usage === undefined ? {} : { usage: finalAnswer.usage }),
        stablePrefixHash: finalPrompt.stablePrefixHash,
        stablePrefixEstimatedTokens: finalPrompt.stablePrefixEstimatedTokens,
        dynamicTailEstimatedTokens: finalPrompt.dynamicTailEstimatedTokens
      };
      usage = addUsage(usage, finalAnswer.usage);
      if (usage !== undefined) yield { type: "usage", usage };
      if (finalAnswer.thinking.length > 0) {
        yield { type: "thinking-delta", text: finalAnswer.thinking };
      }
      if (finalAnswer.needMoreContext !== undefined) {
        throw new Error("Pi requested more context after the one allowed supplementary cycle");
      }
      yield { type: "finish", reason: "stop" };
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
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
