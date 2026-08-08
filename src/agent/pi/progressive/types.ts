import type { ContextTarget } from "./semantic-context";
import type { NoteContextGraphEdge } from "../../../domain/types";
import type { PiConversationNodeSnapshot } from "../../../execution/types";
import type { PiConversationMessage } from "../pi-provider-transport";
import type { NormalizedUsage } from "../../../providers/types";
import type { TokenCalibrationSnapshot } from "./token-calibration";

export type ProgressiveContextLevel = 0 | 1 | 2 | 3 | 4;

export type ProgressiveSourceKind =
  | "selection"
  | "section"
  | "note"
  | "conversation-node";

export interface ProgressiveEvidenceBatch {
  id: string;
  level: ProgressiveContextLevel;
  sourceKind: ProgressiveSourceKind;
  sourceId: string;
  sourceRevision: string;
  title: string;
  relationship: string;
  content: string;
  estimatedTokens: number;
  truncated: boolean;
  hasMoreFromSource: boolean;
  relatedNote: boolean;
  notePaths: string[];
  nodeIds: string[];
  requestedTarget?: ContextTarget;
}

export interface ProgressiveContextState {
  currentLevel: ProgressiveContextLevel;
  initialLevel: ProgressiveContextLevel;
  batchIndexByLevel: Partial<Record<ProgressiveContextLevel, number>>;
  exhaustedLevels: ProgressiveContextLevel[];
  deliveredEvidenceIds: string[];
  deliveredTokens: number;
  expansionCount: number;
  maximumEvidenceTokens: number;
  maximumExpansions: number;
  relatedNotesAllowed: boolean;
  expansionDisabled: boolean;
}

export interface ProgressiveStartPlan {
  initialLevel: ProgressiveContextLevel;
  reason: string;
  maximumEvidenceTokens: number;
}

export interface ProgressiveNoteSource {
  id: string;
  filePath: string;
  fileName: string;
  depth: number;
  root: boolean;
  primaryParentId?: string;
  content: string;
  revision: string;
}

export interface ProgressiveContextSnapshot {
  notes: ProgressiveNoteSource[];
  edges: NoteContextGraphEdge[];
  conversationNodes: PiConversationNodeSnapshot[];
}

export interface ProgressiveExpansionResult {
  state: ProgressiveContextState;
  batch?: ProgressiveEvidenceBatch;
  status: "expanded" | "exhausted" | "limit" | "error";
  message: string;
}

export interface ProgressiveRunCheckpointBatch {
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
  requestedTarget?: ContextTarget;
  crossedLevel?: boolean;
}

export interface ProgressiveRunCheckpointWebResult {
  id: string;
  title: string;
  url: string;
  site: string;
}

/**
 * Serializable engine state captured after every completed tool turn.
 *
 * A failed run can be resumed with this checkpoint: the next run reuses the
 * exact message prefix that was already sent (and persisted into DeepSeek's
 * disk cache), so the first resumed request is byte-identical to the one the
 * failed run would have sent next and hits the cache instead of restarting
 * from scratch.
 */
export interface ProgressiveRunCheckpoint {
  turnIndex: number;
  messages?: PiConversationMessage[];
  state?: ProgressiveContextState;
  batches?: ProgressiveRunCheckpointBatch[];
  calibration?: TokenCalibrationSnapshot;
  usage?: NormalizedUsage;
  invalidToolRequests?: number;
  forcedAnswerToolRequests?: number;
  toolsDisabled?: boolean;
  forcedAnswerAppended?: boolean;
  webSearchAttempts?: number;
  webOpenAttempts?: number;
  webEvidenceTokens?: number;
  nextWebResultId?: number;
  continuationRounds?: number;
  searchedWebQueries?: string[];
  indexedWebResults?: ProgressiveRunCheckpointWebResult[];
  indexedWebResultIdByUrl?: Array<[string, string]>;
  openedWebResultIds?: string[];
}
