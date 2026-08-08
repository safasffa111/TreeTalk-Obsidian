import type {
  ExecutionResponseProgress,
  ExecutionResponseStatus
} from "../execution/types";

export type ResponseProgressStatus = ExecutionResponseStatus;
export type ResponseProgressRecord = ExecutionResponseProgress;

export interface TransientResponseStatusPort {
  get(messageId: string): ResponseProgressRecord | undefined;
  clear(): void;
  subscribe(listener: () => void): () => void;
}

export class TransientResponseStatusStore
  implements TransientResponseStatusPort
{
  private readonly records = new Map<string, ResponseProgressRecord>();
  private readonly listeners = new Set<() => void>();

  get(messageId: string): ResponseProgressRecord | undefined {
    const record = this.records.get(messageId);
    return record === undefined ? undefined : { ...record };
  }

  set(
    messageId: string,
    progress: ResponseProgressRecord | ResponseProgressStatus
  ): void {
    const next = typeof progress === "string" ? { status: progress } : { ...progress };
    const current = this.records.get(messageId);
    if (current !== undefined && JSON.stringify(current) === JSON.stringify(next)) return;
    this.records.set(messageId, next);
    this.emit();
  }

  delete(messageId: string): void {
    if (!this.records.delete(messageId)) return;
    this.emit();
  }

  clear(): void {
    if (this.records.size === 0) return;
    this.records.clear();
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
