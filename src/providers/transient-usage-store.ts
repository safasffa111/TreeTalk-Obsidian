import type { ContextMode } from "../domain/context-engine";

export interface TokenStatsRecord {
  mode: ContextMode;
  fullEstimatedTokens: number;
  sentEstimatedTokens: number;
  reducedTokens: number;
  reductionRatio: number;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  noteContextOriginalEstimatedTokens?: number;
  noteContextSentEstimatedTokens?: number;
  noteContextTrimmed?: boolean;
}

export interface TokenStatsDisplayInput {
  mode?: ContextMode;
  sentEstimatedTokens?: number;
  reducedTokens: number;
  reductionRatio: number;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  cacheHitTokens?: number;
}

export function shouldDisplayTokenStats(input: TokenStatsDisplayInput): boolean {
  if (input.mode === "full") {
    return (
      (input.sentEstimatedTokens ?? 0) > 0 ||
      input.promptTokens !== undefined ||
      input.completionTokens !== undefined ||
      (input.cacheHitTokens ?? 0) > 0
    );
  }
  return (
    input.reducedTokens >= 256 ||
    input.reductionRatio >= 0.05 ||
    (input.cacheHitTokens ?? 0) > 0
  );
}

export interface TransientUsagePort {
  get(messageId: string): TokenStatsRecord | undefined;
  clear(): void;
  subscribe(listener: () => void): () => void;
}

export class TransientUsageStore implements TransientUsagePort {
  private readonly records = new Map<string, TokenStatsRecord>();
  private readonly listeners = new Set<() => void>();

  get(messageId: string): TokenStatsRecord | undefined {
    const record = this.records.get(messageId);
    return record === undefined ? undefined : { ...record };
  }

  set(messageId: string, record: TokenStatsRecord): void {
    this.records.set(messageId, { ...record });
    for (const listener of this.listeners) listener();
  }

  delete(messageId: string): void {
    if (!this.records.delete(messageId)) return;
    for (const listener of this.listeners) listener();
  }

  clear(): void {
    if (this.records.size === 0) return;
    this.records.clear();
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
