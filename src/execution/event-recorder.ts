import {
  applyAgentRunEvent,
  createAgentRunRecord,
  finishAgentRunRecord,
  type AgentRunRecord,
  type AgentRunStatus,
  type CreateAgentRunRecordInput
} from "../domain/agent-run";
import type { ExecutionEvent } from "./types";

export class ExecutionEventRecorder {
  private record: AgentRunRecord;

  constructor(input: CreateAgentRunRecordInput) {
    this.record = createAgentRunRecord(input);
  }

  apply(event: ExecutionEvent): AgentRunRecord {
    this.record = applyAgentRunEvent(this.record, event);
    // applyAgentRunEvent already returns a fresh deep clone, so the internal
    // record is unique to this recorder until the next event replaces it.
    // Returning it directly avoids a second full copy per event.
    return this.record;
  }

  finish(
    status: Exclude<AgentRunStatus, "running">,
    finishedAt: string,
    errorMessage?: string
  ): AgentRunRecord {
    this.record = finishAgentRunRecord(this.record, {
      status,
      finishedAt,
      ...(errorMessage === undefined ? {} : { errorMessage })
    });
    // finishAgentRunRecord also returns a fresh deep clone; no extra copy.
    return this.record;
  }

  /** Returns an independent deep copy for callers that retain the record. */
  snapshot(): AgentRunRecord {
    return structuredClone(this.record);
  }
}
