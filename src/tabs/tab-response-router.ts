import {
  appendAssistantDelta,
  appendAssistantResponse,
  finishAssistantResponse,
  startAssistantResponse,
  updateAssistantAgentRun,
  type AssistantDeltaInput,
  type AssistantResponseInput,
  type FinishAssistantResponseInput,
  type StartAssistantResponseInput,
  type UpdateAssistantAgentRunInput
} from "../domain/assistant-response";
import type { ConversationFile } from "../domain/types";
import type { ConversationTabsStore } from "./conversation-tabs-store";

export interface TabResponseTicket {
  tabId: string;
  conversationId: string;
  nodeId: string;
  requestEpoch: number;
}

export class TabResponseRouter {
  constructor(private readonly store: ConversationTabsStore) {}

  capture(tabId: string, nodeId: string): TabResponseTicket {
    const tab = this.store.getTab(tabId);
    if (
      tab === undefined ||
      tab.mode !== "active" ||
      tab.lifecycle !== "idle" ||
      tab.conversation.nodes[nodeId] === undefined
    ) {
      throw new Error("Cannot capture a response ticket for an inactive tab");
    }
    return Object.freeze({
      tabId,
      conversationId: tab.conversationId,
      nodeId,
      requestEpoch: tab.requestEpoch
    });
  }

  append(ticket: TabResponseTicket, response: AssistantResponseInput): void {
    this.update(ticket, response, (conversation) =>
      appendAssistantResponse(conversation, response)
    );
  }

  start(ticket: TabResponseTicket, response: StartAssistantResponseInput): void {
    this.update(ticket, response, (conversation) =>
      startAssistantResponse(conversation, response)
    );
  }

  delta(ticket: TabResponseTicket, response: AssistantDeltaInput): void {
    this.update(ticket, response, (conversation) =>
      appendAssistantDelta(conversation, response)
    );
  }

  agentRun(
    ticket: TabResponseTicket,
    response: UpdateAssistantAgentRunInput
  ): void {
    this.update(ticket, response, (conversation) =>
      updateAssistantAgentRun(conversation, response)
    );
  }

  finish(ticket: TabResponseTicket, response: FinishAssistantResponseInput): void {
    this.update(ticket, response, (conversation) =>
      finishAssistantResponse(conversation, response)
    );
  }

  private update(
    ticket: TabResponseTicket,
    response: { conversationId: string; nodeId: string },
    mutate: (conversation: ConversationFile) => ConversationFile
  ): void {
    const tab = this.store.getTab(ticket.tabId);
    if (
      tab === undefined ||
      tab.conversationId !== ticket.conversationId ||
      tab.mode !== "active" ||
      tab.lifecycle !== "idle" ||
      tab.requestEpoch !== ticket.requestEpoch ||
      tab.conversation.nodes[ticket.nodeId] === undefined ||
      response.conversationId !== ticket.conversationId ||
      response.nodeId !== ticket.nodeId
    ) {
      throw new Error("Response ticket is stale");
    }
    const hidden = this.store.getSnapshot().activeTabId !== ticket.tabId;
    this.store.updateTab(ticket.tabId, (current) => {
      const conversation = mutate(current.conversation);
      return {
        ...current,
        title: conversation.title,
        unread: current.unread || hidden,
        conversation
      };
    });
  }
}
