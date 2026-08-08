import type { ContextTarget } from "../agent/pi/progressive/semantic-context";
import type { ProgressiveContextLevel, ProgressiveSourceKind } from "../agent/pi/progressive/types";
import type {
  AgentUsageRecord,
  ExecutionEvent,
  ExecutionMode,
  ExecutionSource,
  SelectorTokenBreakdown
} from "../execution/types";

export type AgentRunStatus = "running" | "completed" | "aborted" | "failed";

export interface AgentStageRecord {
  stageId: string;
  roleId: string;
  routeId: string;
  status: "running" | "completed" | "aborted" | "failed";
  startedAt: string;
  finishedAt?: string;
  usage?: AgentUsageRecord;
  stablePrefixHash?: string;
  stablePrefixEstimatedTokens?: number;
  dynamicTailEstimatedTokens?: number;
  selectorTokenBreakdown?: SelectorTokenBreakdown;
}

export interface AgentContextRoutingRecord {
  phase: "initial" | "supplementary";
  candidateNoteCount?: number;
  candidateNodeCount?: number;
  selectedNoteCount: number;
  selectedNodeCount: number;
  materializedNotePaths: string[];
  materializedNodeIds: string[];
  evidenceEstimatedTokens: number;
  evidenceTokenBudget: number;
  omittedSourceCount: number;
  truncated: boolean;
  supplementaryUsed: boolean;
}

export interface AgentToolExecutionRecord {
  toolCallId: string;
  toolName: string;
  status: "running" | "completed" | "failed";
  arguments: Record<string, unknown>;
  notePaths: string[];
  nodeIds: string[];
  summary?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface AgentProgressiveContextBatchRecord {
  level: ProgressiveContextLevel;
  evidenceId: string;
  sourceKind: ProgressiveSourceKind;
  sourceId: string;
  title: string;
  relationship: string;
  estimatedTokens: number;
  notePaths: string[];
  nodeIds: string[];
  expansionReason: string;
  requestedTarget?: ContextTarget;
  crossedLevel?: boolean;
}

export interface AgentProgressiveContextRecord {
  initialLevel: ProgressiveContextLevel;
  finalLevel: ProgressiveContextLevel;
  startReason: string;
  maximumEvidenceTokens: number;
  maximumExpansions: number;
  deliveredEvidenceTokens: number;
  expansionCount: number;
  relatedNotesAllowed: boolean;
  relatedNotesUsed: boolean;
  contextMode?: "convergent" | "divergent";
  initialContextKind?: "exact-selection" | "structural-parent-digest" | "structural-parent-tail" | "external-fallback" | "request-only";
  batches: AgentProgressiveContextBatchRecord[];
}

export interface AgentRunRecord {
  protocol: "pi-agent-run:v1";
  executionMode: ExecutionMode;
  status: AgentRunStatus;
  roleId: string;
  routeId: string;
  providerId: string;
  modelId: string;
  runtime?:
    | "pi-agent-core-compatible"
    | "pi-agent-core-v0.82.1-vendored";
  stages: AgentStageRecord[];
  toolExecutions: AgentToolExecutionRecord[];
  contextRouting?: AgentContextRoutingRecord;
  progressiveContext?: AgentProgressiveContextRecord;
  sources: ExecutionSource[];
  usage?: AgentUsageRecord;
  startedAt: string;
  finishedAt?: string;
  errorMessage?: string;
}

export interface CreateAgentRunRecordInput {
  executionMode: ExecutionMode;
  roleId: string;
  routeId: string;
  providerId: string;
  modelId: string;
  startedAt: string;
}

function mergeUsage(
  current: AgentUsageRecord | undefined,
  next: AgentUsageRecord
): AgentUsageRecord {
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

export function createAgentRunRecord(
  input: CreateAgentRunRecordInput
): AgentRunRecord {
  return {
    protocol: "pi-agent-run:v1",
    executionMode: input.executionMode,
    status: "running",
    roleId: input.roleId,
    routeId: input.routeId,
    providerId: input.providerId,
    modelId: input.modelId,
    stages: [],
    toolExecutions: [],
    sources: [],
    startedAt: input.startedAt
  };
}

export function applyAgentRunEvent(
  current: AgentRunRecord,
  event: ExecutionEvent
): AgentRunRecord {
  const next = structuredClone(current);
  next.stages ??= [];
  next.toolExecutions ??= [];
  next.sources ??= [];
  if (event.type === "agent-start") {
    next.runtime = event.runtime;
    return next;
  }
  if (event.type === "stage-start") {
    const running = next.stages.find((stage) => stage.status === "running");
    if (running !== undefined) {
      running.status = "completed";
      running.finishedAt = event.startedAt;
    }
    next.stages.push({
      stageId: event.stageId,
      roleId: event.roleId,
      routeId: event.routeId,
      status: "running",
      startedAt: event.startedAt
    });
    return next;
  }
  if (event.type === "stage-usage") {
    const stage = [...next.stages]
      .reverse()
      .find((entry) => entry.stageId === event.stageId);
    if (stage !== undefined) {
      if (event.usage !== undefined) {
        stage.usage = mergeUsage(stage.usage, event.usage);
      }
      if (event.stablePrefixHash !== undefined) {
        stage.stablePrefixHash = event.stablePrefixHash;
      }
      if (event.stablePrefixEstimatedTokens !== undefined) {
        stage.stablePrefixEstimatedTokens = event.stablePrefixEstimatedTokens;
      }
      if (event.dynamicTailEstimatedTokens !== undefined) {
        stage.dynamicTailEstimatedTokens = event.dynamicTailEstimatedTokens;
      }
      if (event.selectorTokenBreakdown !== undefined) {
        stage.selectorTokenBreakdown = structuredClone(event.selectorTokenBreakdown);
      }
    }
    return next;
  }
  if (event.type === "tool-start") {
    next.toolExecutions.push({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      status: "running",
      arguments: structuredClone(event.arguments),
      notePaths: [],
      nodeIds: [],
      startedAt: event.startedAt
    });
    return next;
  }
  if (event.type === "tool-end") {
    const existing = [...next.toolExecutions]
      .reverse()
      .find((entry) => entry.toolCallId === event.toolCallId);
    if (existing !== undefined) {
      existing.status = event.isError ? "failed" : "completed";
      existing.summary = event.summary;
      existing.notePaths = [...new Set(event.notePaths)];
      existing.nodeIds = [...new Set(event.nodeIds ?? [])];
      existing.finishedAt = event.finishedAt;
    }
    return next;
  }
  if (event.type === "progressive-context-start") {
    next.progressiveContext = {
      initialLevel: event.initialLevel,
      finalLevel: event.initialLevel,
      startReason: event.reason,
      maximumEvidenceTokens: event.maximumEvidenceTokens,
      maximumExpansions: event.maximumExpansions,
      deliveredEvidenceTokens: 0,
      expansionCount: 0,
      relatedNotesAllowed: event.relatedNotesAllowed,
      relatedNotesUsed: false,
      ...(event.contextMode === undefined ? {} : { contextMode: event.contextMode }),
      ...(event.initialContextKind === undefined
        ? {}
        : { initialContextKind: event.initialContextKind }),
      batches: []
    };
    return next;
  }
  if (event.type === "progressive-context-batch") {
    const progressive = next.progressiveContext;
    if (progressive === undefined) return next;
    if (progressive.batches.some((batch) => batch.evidenceId === event.evidenceId)) {
      return next;
    }
    const isExpansion = progressive.batches.length > 0;
    progressive.finalLevel = event.level;
    progressive.deliveredEvidenceTokens += event.estimatedTokens;
    if (isExpansion) progressive.expansionCount += 1;
    progressive.relatedNotesUsed ||= event.relatedNote;
    progressive.batches.push({
      level: event.level,
      evidenceId: event.evidenceId,
      sourceKind: event.sourceKind,
      sourceId: event.sourceId,
      title: event.title,
      relationship: event.relationship,
      estimatedTokens: event.estimatedTokens,
      notePaths: [...new Set(event.notePaths)],
      nodeIds: [...new Set(event.nodeIds)],
      expansionReason: event.expansionReason,
      ...(event.requestedTarget === undefined
        ? {}
        : { requestedTarget: event.requestedTarget }),
      ...(event.crossedLevel === undefined
        ? {}
        : { crossedLevel: event.crossedLevel })
    });
    return next;
  }
  if (event.type === "context-routing") {
    next.contextRouting = {
      phase: event.phase,
      ...(event.candidateNoteCount === undefined
        ? {}
        : { candidateNoteCount: event.candidateNoteCount }),
      ...(event.candidateNodeCount === undefined
        ? {}
        : { candidateNodeCount: event.candidateNodeCount }),
      selectedNoteCount: event.selectedNoteCount,
      selectedNodeCount: event.selectedNodeCount,
      materializedNotePaths: [...new Set(event.materializedNotePaths)],
      materializedNodeIds: [...new Set(event.materializedNodeIds)],
      evidenceEstimatedTokens: event.evidenceEstimatedTokens,
      evidenceTokenBudget: event.evidenceTokenBudget,
      omittedSourceCount: event.omittedSourceCount,
      truncated: event.truncated,
      supplementaryUsed: event.supplementaryUsed
    };
    return next;
  }
  if (event.type === "sources") {
    const byUrl = new Map(next.sources.map((source) => [source.url, source]));
    for (const source of event.sources) byUrl.set(source.url, { ...source });
    next.sources = [...byUrl.values()];
    return next;
  }
  if (event.type === "usage") {
    next.usage = mergeUsage(next.usage, event.usage);
    return next;
  }
  if (event.type === "error") {
    next.errorMessage = event.message;
  }
  return next;
}

export interface FinishAgentRunRecordInput {
  status: Exclude<AgentRunStatus, "running">;
  finishedAt: string;
  errorMessage?: string;
}

export function finishAgentRunRecord(
  current: AgentRunRecord,
  input: FinishAgentRunRecordInput
): AgentRunRecord {
  const next = structuredClone(current);
  next.stages ??= [];
  next.toolExecutions ??= [];
  next.sources ??= [];
  next.status = input.status;
  next.finishedAt = input.finishedAt;
  if (input.errorMessage === undefined) {
    delete next.errorMessage;
  } else {
    next.errorMessage = input.errorMessage;
  }
  for (const stage of next.stages) {
    if (stage.status !== "running") continue;
    stage.status =
      input.status === "completed"
        ? "completed"
        : input.status === "aborted"
          ? "aborted"
          : "failed";
    stage.finishedAt = input.finishedAt;
  }
  for (const tool of next.toolExecutions) {
    if (tool.status !== "running") continue;
    tool.status = "failed";
    tool.summary =
      input.status === "aborted"
        ? "Agent run was aborted before the tool completed"
        : "Agent run ended before the tool completed";
    tool.finishedAt = input.finishedAt;
  }
  return next;
}
