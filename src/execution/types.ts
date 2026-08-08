import type {
  ProgressiveContextLevel,
  ProgressiveRunCheckpoint,
  ProgressiveSourceKind
} from "../agent/pi/progressive/types";
import type { ContextTarget } from "../agent/pi/progressive/semantic-context";
import type { ProviderMessage } from "../domain/context-builder";
import type { AnswerThinkingMode } from "./answer-thinking";
import type { MessageRole, MessageStatus, NoteContextGraphSnapshot } from "../domain/types";
import type {
  NormalizedUsage,
  ProviderProfile
} from "../providers/types";

export type ExecutionMode = "legacy" | "pi";

export interface ResolvedExecutionRoute {
  routeId: string;
  providerProfile: ProviderProfile;
  modelId: string;
}

export interface PiConversationMessageSnapshot {
  id: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  selectionQuotes: string[];
  /**
   * Compact record of the evidence batches a completed assistant run
   * delivered, so a follow-up turn can re-anchor on the same sources
   * instead of re-deriving context from scratch.
   */
  provenance?: PiEvidenceProvenanceEntry[];
}

export interface PiEvidenceProvenanceEntry {
  level: number;
  title: string;
  relationship: string;
  notePaths: string[];
  nodeIds: string[];
}

export interface PiConversationNodeSnapshot {
  id: string;
  parentId: string | null;
  title: string;
  depth: number;
  root: boolean;
  current: boolean;
  messages: PiConversationMessageSnapshot[];
}


export type PiFocusScope =
  | "selection_only"
  | "containing_section"
  | "source_message"
  | "latest_round"
  | "full_source";

interface PiFocusAnchorBase {
  id?: string;
  defaultScope?: PiFocusScope;
}

export type PiFocusAnchor =
  | (PiFocusAnchorBase & {
      kind: "message-selection";
      sourceNodeId: string;
      sourceMessageId: string;
      sourceRole: MessageRole;
      quote: string;
      prefix: string;
      suffix: string;
    })
  | (PiFocusAnchorBase & {
      kind: "note-selection";
      filePath: string;
      fileName: string;
      quote: string;
      prefix: string;
      suffix: string;
      selectionStartOffset?: number;
      selectionEndOffset?: number;
    })
  | (PiFocusAnchorBase & {
      kind: "conversation-round";
      sourceNodeId: string;
      sourceMessageId?: string;
      reason: "direct-parent" | "previous-turn";
    });

export interface PiFocusDecision {
  anchorId: string;
  scope: PiFocusScope;
  reason: string;
}

export type PiResponseTarget =
  | {
      kind: "exact-selection";
      anchorId: string;
      text: string;
      source:
        | {
            type: "conversation-message";
            nodeId: string;
            messageId: string;
            role: MessageRole;
          }
        | {
            type: "note";
            filePath: string;
            fileName: string;
          };
    }
  | {
      kind: "conversation-round";
      anchorId: string;
      sourceNodeId: string;
      sourceMessageId?: string;
      reason: "direct-parent" | "previous-turn";
    };

export interface PiFocusContext {
  interactionMode: "child" | "continue";
  defaultScope: PiFocusScope;
  anchors: PiFocusAnchor[];
  /** Execution-only target lock. Optional for alpha.7 request compatibility. */
  targets?: PiResponseTarget[];
}

export interface PiSelectedContext {
  currentQuestion: string;
  selectedQuotes: string[];
  conversationNodes?: PiConversationNodeSnapshot[];
  noteContextGraph?: NoteContextGraphSnapshot;
  /** Permission only: related notes remain unused until progressive expansion reaches them. */
  relatedNotesAllowed?: boolean;
  focus?: PiFocusContext;
}

export interface ExecutionRequest {
  conversationId: string;
  nodeId: string;
  assistantMessageId: string;
  contextMessages: ProviderMessage[];
  piContext?: PiSelectedContext;
  contextCacheKey?: string;
  roleId: string;
  route: ResolvedExecutionRoute;
  webSearchEnabled: boolean;
  streamingOutputEnabled?: boolean;
  currentQuestion?: string;
  answerThinkingMode?: AnswerThinkingMode;
  selectionCount?: number;
  contextDivergenceEnabled?: boolean;
  progressiveResume?: ProgressiveRunCheckpoint;
}

export interface AgentUsageRecord extends NormalizedUsage {}

export interface ExecutionSource {
  title: string;
  url: string;
}

export type ExecutionResponseStatus =
  | "thinking"
  | "preparing-context"
  | "identifying-focus"
  | "selecting-context"
  | "context-selected"
  | "reading-context"
  | "organizing-answer"
  | "supplementing-context"
  | "generating-final-answer"
  | "deciding-web-search"
  | "searching-web"
  | "organizing-web-results";

export interface ExecutionResponseProgress {
  status: ExecutionResponseStatus;
  selectedNodeCount?: number;
  selectedNoteCount?: number;
  supplementary?: boolean;
}

export interface SelectorTokenBreakdown {
  systemPrompt: number;
  noteCatalog: number;
  conversationBranch: number;
  localFocus: number;
  currentRequest: number;
  outputContract: number;
  total: number;
  budget: number;
  detailedNoteCount: number;
  compactNoteCount: number;
  omittedNoteCount: number;
}

export type ExecutionEvent =
  | {
      type: "agent-start";
      runtime:
        | "pi-agent-core-compatible"
        | "pi-agent-core-v0.82.1-vendored";
      roleId: string;
    }
  | {
      type: "stage-start";
      stageId: string;
      roleId: string;
      routeId: string;
      startedAt: string;
    }
  | {
      type: "stage-usage";
      stageId: string;
      usage?: AgentUsageRecord;
      stablePrefixHash?: string;
      stablePrefixEstimatedTokens?: number;
      dynamicTailEstimatedTokens?: number;
      selectorTokenBreakdown?: SelectorTokenBreakdown;
    }
  | {
      type: "tool-start";
      toolCallId: string;
      toolName: string;
      arguments: Record<string, unknown>;
      startedAt: string;
    }
  | {
      type: "tool-end";
      toolCallId: string;
      toolName: string;
      isError: boolean;
      summary: string;
      notePaths: string[];
      nodeIds?: string[];
      finishedAt: string;
    }
  | {
      type: "progressive-context-start";
      initialLevel: ProgressiveContextLevel;
      reason: string;
      maximumEvidenceTokens: number;
      maximumExpansions: number;
      relatedNotesAllowed: boolean;
      contextMode?: "convergent" | "divergent";
      initialContextKind?: "exact-selection" | "structural-parent-digest" | "structural-parent-tail" | "external-fallback" | "request-only";
    }
  | {
      type: "progressive-context-batch";
      level: ProgressiveContextLevel;
      evidenceId: string;
      sourceKind: ProgressiveSourceKind;
      sourceId: string;
      title: string;
      relationship: string;
      estimatedTokens: number;
      notePaths: string[];
      nodeIds: string[];
      relatedNote: boolean;
      expansionReason: string;
      exhausted: boolean;
      requestedTarget?: ContextTarget;
      crossedLevel?: boolean;
    }
  | {
      type: "progressive-prefix-check";
      turnIndex: number;
      preserved: boolean;
      messageCount: number;
    }
  | {
      type: "progressive-run-checkpoint";
      checkpoint: ProgressiveRunCheckpoint;
    }
  | {
      type: "context-routing";
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
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | {
      type: "response-status";
      progress?: ExecutionResponseProgress;
      status?: ExecutionResponseStatus;
    }
  | { type: "sources"; sources: ExecutionSource[] }
  | { type: "usage"; usage: AgentUsageRecord }
  | { type: "finish"; reason: "stop" | "length" | "aborted" }
  | { type: "error"; message: string; retryable: boolean };

export interface ExecutionEngine {
  execute(
    request: ExecutionRequest,
    signal: AbortSignal
  ): AsyncIterable<ExecutionEvent>;
}
