export interface TransientThinkingRecord {
  content: string;
}

export interface TransientThinkingChange {
  messageIds: readonly string[];
}

export interface TransientThinkingPort {
  get(messageId: string): TransientThinkingRecord | undefined;
  clear(): void;
  subscribe(listener: (change: TransientThinkingChange) => void): () => void;
}

export interface TransientThinkingStoreOptions {
  schedule?(callback: () => void, delayMs: number): unknown;
  cancel?(handle: unknown): void;
  throttleMs?: number;
}

const DEFAULT_THROTTLE_MS = 50;

export class TransientThinkingStore implements TransientThinkingPort {
  private readonly records = new Map<string, TransientThinkingRecord>();
  private readonly listeners = new Set<(change: TransientThinkingChange) => void>();
  private readonly pendingMessageIds = new Set<string>();
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly throttleMs: number;
  private pendingHandle: unknown | undefined;

  constructor(options: TransientThinkingStoreOptions = {}) {
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.throttleMs = Math.max(0, options.throttleMs ?? DEFAULT_THROTTLE_MS);
  }

  get(messageId: string): TransientThinkingRecord | undefined {
    const record = this.records.get(messageId);
    return record === undefined ? undefined : { ...record };
  }

  append(messageId: string, text: string): void {
    if (text.length === 0) return;
    const current = this.records.get(messageId)?.content ?? "";
    this.records.set(messageId, { content: `${current}${text}` });
    this.pendingMessageIds.add(messageId);
    this.scheduleEmit();
  }

  delete(messageId: string): void {
    const changed = this.records.delete(messageId);
    if (!changed && !this.pendingMessageIds.has(messageId)) return;
    this.pendingMessageIds.add(messageId);
    this.flush();
  }

  clear(): void {
    if (this.records.size === 0 && this.pendingMessageIds.size === 0) return;
    for (const messageId of this.records.keys()) this.pendingMessageIds.add(messageId);
    this.records.clear();
    this.flush();
  }

  subscribe(listener: (change: TransientThinkingChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private scheduleEmit(): void {
    if (this.pendingHandle !== undefined) return;
    this.pendingHandle = this.schedule(() => {
      this.pendingHandle = undefined;
      this.emitPending();
    }, this.throttleMs);
  }

  private flush(): void {
    if (this.pendingHandle !== undefined) {
      this.cancel(this.pendingHandle);
      this.pendingHandle = undefined;
    }
    this.emitPending();
  }

  private emitPending(): void {
    if (this.pendingMessageIds.size === 0) return;
    const change: TransientThinkingChange = {
      messageIds: [...this.pendingMessageIds]
    };
    this.pendingMessageIds.clear();
    for (const listener of this.listeners) listener(change);
  }
}
