import type { PiConversationMessage } from "../pi-provider-transport";
import type { NormalizedUsage } from "../../../providers/types";
import { isStrictMessagePrefix } from "./prefix-integrity";
import { TokenCalibrator } from "./token-calibration";
import type {
  ProgressiveContextState,
  ProgressiveRunCheckpoint,
  ProgressiveRunCheckpointBatch
} from "./types";

export interface IndexedWebResult {
  id: string;
  title: string;
  url: string;
  site: string;
}

export interface CreateProgressiveRunStateInput {
  state: ProgressiveContextState;
  messages: PiConversationMessage[];
  initialBatch: ProgressiveRunCheckpointBatch;
  maximumModelSubrequests: number;
}

/**
 * Owns every mutable piece of a Progressive Pi run so checkpoint creation,
 * restoration, and budget accounting stay in one place instead of being
 * scattered across the execution engine.
 */
export class ProgressiveRunState {
  turnIndex = 0;
  messages: PiConversationMessage[];
  state: ProgressiveContextState;
  progressBatches: ProgressiveRunCheckpointBatch[];
  calibration = new TokenCalibrator();
  usage: NormalizedUsage | undefined;
  forcedAnswerAppended = false;
  invalidToolRequests = 0;
  forcedAnswerToolRequests = 0;
  toolsDisabled = false;
  webSearchAttempts = 0;
  webOpenAttempts = 0;
  webEvidenceTokens = 0;
  nextWebResultId = 1;
  continuationRounds = 0;
  searchedWebQueries = new Set<string>();
  indexedWebResults = new Map<string, IndexedWebResult>();
  indexedWebResultIdByUrl = new Map<string, string>();
  openedWebResultIds = new Set<string>();
  lastSentMessages: PiConversationMessage[];
  restored = false;

  constructor(input: CreateProgressiveRunStateInput) {
    this.state = input.state;
    this.messages = input.messages;
    this.progressBatches = [structuredClone(input.initialBatch)];
    this.lastSentMessages = structuredClone(input.messages);
  }

  /**
   * Restores a run from a checkpoint when the checkpoint is compatible with
   * the freshly derived initial state; otherwise returns a fresh run so a
   * stale or mismatched checkpoint can never corrupt the conversation prefix.
   */
  static restore(
    checkpoint: ProgressiveRunCheckpoint | undefined,
    input: CreateProgressiveRunStateInput
  ): ProgressiveRunState {
    const run = new ProgressiveRunState(input);
    if (
      checkpoint === undefined ||
      checkpoint.state === undefined ||
      checkpoint.state.maximumEvidenceTokens !==
        input.state.maximumEvidenceTokens ||
      checkpoint.state.maximumExpansions !== input.state.maximumExpansions ||
      checkpoint.state.relatedNotesAllowed !== input.state.relatedNotesAllowed ||
      checkpoint.state.initialLevel !== input.state.initialLevel ||
      !Array.isArray(checkpoint.messages) ||
      checkpoint.messages.length === 0 ||
      !isStrictMessagePrefix(input.messages, checkpoint.messages)
    ) {
      return run;
    }
    run.state = structuredClone(checkpoint.state);
    run.messages = structuredClone(checkpoint.messages);
    run.lastSentMessages = structuredClone(run.messages);
    run.turnIndex = Math.min(
      Math.max(0, Math.trunc(checkpoint.turnIndex)),
      Math.max(0, input.maximumModelSubrequests - 1)
    );
    run.calibration = TokenCalibrator.restore(checkpoint.calibration);
    run.usage =
      checkpoint.usage === undefined
        ? undefined
        : structuredClone(checkpoint.usage);
    run.forcedAnswerAppended = checkpoint.forcedAnswerAppended ?? false;
    run.invalidToolRequests = checkpoint.invalidToolRequests ?? 0;
    run.forcedAnswerToolRequests = checkpoint.forcedAnswerToolRequests ?? 0;
    run.toolsDisabled = checkpoint.toolsDisabled ?? false;
    run.webSearchAttempts = checkpoint.webSearchAttempts ?? 0;
    run.webOpenAttempts = checkpoint.webOpenAttempts ?? 0;
    run.webEvidenceTokens = checkpoint.webEvidenceTokens ?? 0;
    run.nextWebResultId = checkpoint.nextWebResultId ?? 1;
    run.continuationRounds = checkpoint.continuationRounds ?? 0;
    run.searchedWebQueries = new Set(checkpoint.searchedWebQueries ?? []);
    run.indexedWebResults = new Map(
      (checkpoint.indexedWebResults ?? []).map((entry) => [
        entry.id,
        { ...entry }
      ])
    );
    run.indexedWebResultIdByUrl = new Map(
      checkpoint.indexedWebResultIdByUrl ?? []
    );
    run.openedWebResultIds = new Set(checkpoint.openedWebResultIds ?? []);
    for (const batch of checkpoint.batches ?? []) {
      if (batch.expansionReason === "initial") continue;
      run.progressBatches.push(structuredClone(batch));
    }
    run.restored = true;
    return run;
  }

  toCheckpoint(): ProgressiveRunCheckpoint {
    return {
      turnIndex: this.turnIndex + 1,
      messages: structuredClone(this.messages),
      state: structuredClone(this.state),
      batches: this.progressBatches.map((batch) => ({ ...batch })),
      calibration: this.calibration.snapshot(),
      ...(this.usage === undefined
        ? {}
        : { usage: structuredClone(this.usage) }),
      invalidToolRequests: this.invalidToolRequests,
      forcedAnswerToolRequests: this.forcedAnswerToolRequests,
      toolsDisabled: this.toolsDisabled,
      forcedAnswerAppended: this.forcedAnswerAppended,
      webSearchAttempts: this.webSearchAttempts,
      webOpenAttempts: this.webOpenAttempts,
      webEvidenceTokens: this.webEvidenceTokens,
      nextWebResultId: this.nextWebResultId,
      continuationRounds: this.continuationRounds,
      searchedWebQueries: [...this.searchedWebQueries],
      indexedWebResults: [...this.indexedWebResults.values()].map((entry) => ({
        ...entry
      })),
      indexedWebResultIdByUrl: [...this.indexedWebResultIdByUrl.entries()].map(
        ([id, url]) => [id, url]
      ),
      openedWebResultIds: [...this.openedWebResultIds]
    };
  }
}
