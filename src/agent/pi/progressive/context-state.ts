import type {
  ProgressiveContextLevel,
  ProgressiveContextState,
  ProgressiveEvidenceBatch
} from "./types";

export interface CreateProgressiveContextStateInput {
  initialLevel: ProgressiveContextLevel;
  relatedNotesAllowed: boolean;
  maximumEvidenceTokens: number;
  maximumExpansions: number;
}

export function createProgressiveContextState(
  input: CreateProgressiveContextStateInput
): ProgressiveContextState {
  return {
    currentLevel: input.initialLevel,
    initialLevel: input.initialLevel,
    batchIndexByLevel: {},
    exhaustedLevels: [],
    deliveredEvidenceIds: [],
    deliveredTokens: 0,
    expansionCount: 0,
    maximumEvidenceTokens: Math.max(0, Math.trunc(input.maximumEvidenceTokens)),
    maximumExpansions: Math.max(0, Math.trunc(input.maximumExpansions)),
    relatedNotesAllowed: input.relatedNotesAllowed,
    expansionDisabled:
      input.maximumEvidenceTokens <= 0 || input.maximumExpansions <= 0
  };
}

export function canExpandContext(state: ProgressiveContextState): boolean {
  return !state.expansionDisabled && state.currentLevel <= 4;
}

function recordBatch(
  current: ProgressiveContextState,
  batch: ProgressiveEvidenceBatch,
  countExpansion: boolean
): ProgressiveContextState {
  if (current.deliveredEvidenceIds.includes(batch.id)) {
    throw new Error(`Progressive evidence already delivered: ${batch.id}`);
  }
  if (batch.level < current.currentLevel) {
    throw new Error("Progressive context cannot move to a lower level");
  }
  if (
    batch.relatedNote &&
    !current.relatedNotesAllowed
  ) {
    throw new Error("Related-note evidence is not allowed for this request");
  }
  if (
    current.deliveredTokens + batch.estimatedTokens >
    current.maximumEvidenceTokens
  ) {
    throw new Error("Progressive evidence budget would be exceeded");
  }
  if (countExpansion && current.expansionCount >= current.maximumExpansions) {
    throw new Error("Progressive expansion limit has been reached");
  }
  const next: ProgressiveContextState = structuredClone(current);
  next.currentLevel = batch.level;
  next.deliveredEvidenceIds.push(batch.id);
  next.deliveredTokens += batch.estimatedTokens;
  if (countExpansion) next.expansionCount += 1;
  next.batchIndexByLevel[batch.level] =
    (next.batchIndexByLevel[batch.level] ?? 0) + 1;
  next.expansionDisabled =
    next.expansionCount >= next.maximumExpansions ||
    next.deliveredTokens >= next.maximumEvidenceTokens;
  return next;
}

export function recordInitialProgressiveBatch(
  current: ProgressiveContextState,
  batch: ProgressiveEvidenceBatch
): ProgressiveContextState {
  return recordBatch(current, batch, false);
}

export function recordExpandedProgressiveBatch(
  current: ProgressiveContextState,
  batch: ProgressiveEvidenceBatch
): ProgressiveContextState {
  return recordBatch(current, batch, true);
}

export function markProgressiveLevelExhausted(
  current: ProgressiveContextState,
  level: ProgressiveContextLevel
): ProgressiveContextState {
  const next: ProgressiveContextState = structuredClone(current);
  if (!next.exhaustedLevels.includes(level)) next.exhaustedLevels.push(level);
  return next;
}

export function disableProgressiveExpansion(
  current: ProgressiveContextState
): ProgressiveContextState {
  return { ...structuredClone(current), expansionDisabled: true };
}
