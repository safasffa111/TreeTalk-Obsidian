import type { ProgressiveRunCheckpoint } from "../agent/pi/progressive/types";
import type { ContextPlan } from "../domain/context-engine";
import type { ExecutionRequest } from "../execution/types";

export interface ProgressiveRunCheckpointRecord {
  userMessageId: string;
  assistantMessageId: string;
  request: ExecutionRequest;
  checkpoint: ProgressiveRunCheckpoint;
  contextPlan: ContextPlan;
  updatedAt: string;
}

/**
 * In-memory store of the latest Progressive Pi checkpoint for each assistant
 * message, so a failed run can be retried in place with the exact message
 * prefix that was already sent (preserving DeepSeek's context-cache hits).
 */
export class ProgressiveRunCheckpointStore {
  private readonly entries = new Map<string, ProgressiveRunCheckpointRecord>();

  set(record: ProgressiveRunCheckpointRecord): void {
    this.entries.set(record.assistantMessageId, record);
  }

  get(assistantMessageId: string): ProgressiveRunCheckpointRecord | undefined {
    return this.entries.get(assistantMessageId);
  }

  delete(assistantMessageId: string): void {
    this.entries.delete(assistantMessageId);
  }

  prune(conversationId: string): void {
    for (const [assistantMessageId, record] of this.entries) {
      if (record.request.conversationId === conversationId) {
        this.entries.delete(assistantMessageId);
      }
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
