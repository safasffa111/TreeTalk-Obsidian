import { finishAgentRunRecord, type AgentRunRecord } from "../domain/agent-run";
import type { TabResponseRouter, TabResponseTicket } from "../tabs/tab-response-router";

export interface ActiveResponseHandle {
  conversationId: string;
  ticket: TabResponseTicket;
  messageId: string;
  controller: AbortController;
  finalized: boolean;
  agentRun?: AgentRunRecord;
  /** True while a coalesced router publish is scheduled for this handle. */
  agentRunPublishScheduled?: boolean;
  /** Latest record + timestamp waiting to be published by the scheduler. */
  pendingAgentRun?: { agentRun: AgentRunRecord; now: string };
}

export type AgentRunScheduler = (run: () => void) => void;

function defaultAgentRunScheduler(run: () => void): void {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => run());
  } else {
    queueMicrotask(run);
  }
}

export class ActiveResponseRequests {
  private readonly requests = new Map<string, ActiveResponseHandle>();

  constructor(
    private readonly router: TabResponseRouter,
    private readonly schedule: AgentRunScheduler = defaultAgentRunScheduler
  ) {}

  has(conversationId: string): boolean {
    return this.requests.has(conversationId);
  }

  begin(
    conversationId: string,
    ticket: TabResponseTicket,
    messageId: string,
    agentRun?: AgentRunRecord
  ): ActiveResponseHandle {
    if (this.requests.has(conversationId)) {
      throw new Error("A response is already active for this conversation");
    }
    const handle: ActiveResponseHandle = {
      conversationId,
      ticket,
      messageId,
      controller: new AbortController(),
      finalized: false,
      ...(agentRun === undefined ? {} : { agentRun: structuredClone(agentRun) })
    };
    this.requests.set(conversationId, handle);
    return handle;
  }

  finish(
    handle: ActiveResponseHandle,
    status: "complete" | "interrupted" | "failed",
    now: string,
    finalContent?: string,
    referencedNoteNames?: string[]
  ): void {
    if (
      handle.finalized ||
      this.requests.get(handle.conversationId) !== handle
    ) {
      return;
    }
    const agentRun =
      handle.agentRun === undefined
        ? undefined
        : finishAgentRunRecord(handle.agentRun, {
            status:
              status === "complete"
                ? "completed"
                : status === "interrupted"
                  ? "aborted"
                  : "failed",
            finishedAt: now,
            ...(status === "failed" && handle.agentRun.errorMessage !== undefined
              ? { errorMessage: handle.agentRun.errorMessage }
              : {})
          });
    this.router.finish(handle.ticket, {
      conversationId: handle.ticket.conversationId,
      nodeId: handle.ticket.nodeId,
      messageId: handle.messageId,
      status,
      now,
      ...(finalContent === undefined ? {} : { finalContent }),
      ...(status !== "complete" || referencedNoteNames === undefined
        ? {}
        : { referencedNoteNames: [...referencedNoteNames] }),
      ...(agentRun === undefined ? {} : { agentRun })
    });
    handle.finalized = true;
  }

  updateAgentRun(
    handle: ActiveResponseHandle,
    agentRun: AgentRunRecord,
    now: string
  ): void {
    if (
      handle.finalized ||
      this.requests.get(handle.conversationId) !== handle
    ) {
      return;
    }
    // The recorder hands out fresh immutable snapshots per event; the router
    // deep-copies the record into the conversation store, so holding the
    // reference here is safe and avoids one full clone per event.
    handle.agentRun = agentRun;
    handle.pendingAgentRun = { agentRun, now };
    if (handle.agentRunPublishScheduled) return;
    handle.agentRunPublishScheduled = true;
    this.schedule(() => {
      handle.agentRunPublishScheduled = false;
      const pending = handle.pendingAgentRun;
      delete handle.pendingAgentRun;
      if (
        handle.finalized ||
        this.requests.get(handle.conversationId) !== handle ||
        pending === undefined
      ) {
        return;
      }
      this.router.agentRun(handle.ticket, {
        conversationId: handle.ticket.conversationId,
        nodeId: handle.ticket.nodeId,
        messageId: handle.messageId,
        agentRun: pending.agentRun,
        now: pending.now
      });
    });
  }

  interrupt(conversationId: string, now: string): boolean {
    const handle = this.requests.get(conversationId);
    if (handle === undefined) return false;
    try {
      this.finish(handle, "interrupted", now);
    } finally {
      handle.controller.abort();
    }
    return true;
  }

  interruptAll(now: string): void {
    for (const conversationId of [...this.requests.keys()]) {
      this.interrupt(conversationId, now);
    }
  }

  release(handle: ActiveResponseHandle): void {
    if (this.requests.get(handle.conversationId) === handle) {
      this.requests.delete(handle.conversationId);
    }
  }
}
