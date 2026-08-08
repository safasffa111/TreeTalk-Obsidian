import {
  applyNodeSummaryFailure,
  applyNodeSummarySuccess,
  buildNodeSummaryPrompt,
  canAttemptNodeSummary,
  cleanNodeSummaryTitle,
  markNodeSummaryPending
} from "../domain/node-summary";
import type { ChatMessage } from "../domain/types";
import type { ConversationTabsStore } from "../tabs/conversation-tabs-store";
import type { ProviderRegistry } from "./provider-registry";
import type {
  ProviderProfile,
  ProviderRequest
} from "./types";
import { logWarning } from "../utils/error-log";

export interface NodeSummaryRequestPort {
  request(request: ProviderRequest, signal: AbortSignal): Promise<unknown>;
}

export interface NodeSummaryRuntime {
  getProfile(): ProviderProfile;
  getModel(): string;
  now(): string;
  persistPending?(tabId: string): Promise<void>;
}

export interface NodeSummaryTrigger {
  tabId: string;
  conversationId: string;
  nodeId: string;
  answerMessageId: string;
}

interface InFlightSummary {
  promise: Promise<void>;
  controller: AbortController;
}

function key(tabId: string, nodeId: string): string {
  return `${tabId}\u0000${nodeId}`;
}

function findQuestion(messages: ChatMessage[]): ChatMessage | undefined {
  return messages.find((message) => message.role === "user");
}

function findFirstCompleteAnswer(messages: ChatMessage[]): ChatMessage | undefined {
  return messages.find(
    (message) => message.role === "assistant" && message.status === "complete"
  );
}

function nodeIdsInTreeOrder(
  rootNodeId: string,
  nodes: Record<string, { childIds: string[] }>
): string[] {
  const ordered: string[] = [];
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visited.has(nodeId) || nodes[nodeId] === undefined) return;
    visited.add(nodeId);
    ordered.push(nodeId);
    for (const childId of nodes[nodeId].childIds) visit(childId);
  };
  visit(rootNodeId);
  for (const nodeId of Object.keys(nodes)) visit(nodeId);
  return ordered;
}

export class NodeSummaryCoordinator {
  private readonly inFlight = new Map<string, InFlightSummary>();
  private disposed = false;

  constructor(
    private readonly tabs: ConversationTabsStore,
    private readonly providers: ProviderRegistry,
    private readonly requests: NodeSummaryRequestPort,
    private readonly runtime: NodeSummaryRuntime
  ) {}

  trigger(input: NodeSummaryTrigger): Promise<void> {
    const identity = key(input.tabId, input.nodeId);
    const existing = this.inFlight.get(identity);
    if (existing !== undefined) return existing.promise;
    if (this.disposed) return Promise.resolve();
    const controller = new AbortController();
    const promise = this.run(input, controller.signal).finally(() => {
      const current = this.inFlight.get(identity);
      if (current?.promise === promise) this.inFlight.delete(identity);
    });
    this.inFlight.set(identity, { promise, controller });
    return promise;
  }

  waitForNode(tabId: string, nodeId: string): Promise<void> {
    return this.inFlight.get(key(tabId, nodeId))?.promise ?? Promise.resolve();
  }

  async repairOpenTabs(): Promise<number> {
    const profile = this.runtime.getProfile();
    if (profile.apiKey.trim().length === 0 || this.runtime.getModel().trim().length === 0) {
      return 0;
    }
    let attempted = 0;
    for (const tabId of this.tabs.getSnapshot().orderedTabIds) {
      const tab = this.tabs.getTab(tabId);
      if (
        tab === undefined ||
        tab.mode !== "active" ||
        tab.lifecycle !== "idle"
      ) {
        continue;
      }
      const nodeIds = nodeIdsInTreeOrder(
        tab.conversation.rootNodeId,
        tab.conversation.nodes
      );
      for (const nodeId of nodeIds) {
        const latestTab = this.tabs.getTab(tabId);
        const node = latestTab?.conversation.nodes[nodeId];
        const answer = node === undefined
          ? undefined
          : findFirstCompleteAnswer(node.messages);
        if (
          latestTab === undefined ||
          latestTab.conversationId !== tab.conversationId ||
          node === undefined ||
          answer === undefined ||
          !canAttemptNodeSummary(node)
        ) {
          continue;
        }
        attempted += 1;
        await this.trigger({
          tabId,
          conversationId: tab.conversationId,
          nodeId,
          answerMessageId: answer.id
        });
        if (this.disposed) return attempted;
      }
    }
    return attempted;
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.inFlight.values()) entry.controller.abort();
    this.inFlight.clear();
  }

  private async run(input: NodeSummaryTrigger, signal: AbortSignal): Promise<void> {
    const tab = this.tabs.getTab(input.tabId);
    if (
      tab === undefined ||
      tab.conversationId !== input.conversationId ||
      tab.mode !== "active" ||
      tab.lifecycle !== "idle"
    ) {
      return;
    }
    const node = tab.conversation.nodes[input.nodeId];
    const answer = node?.messages.find(
      (message) =>
        message.id === input.answerMessageId &&
        message.role === "assistant" &&
        message.status === "complete"
    );
    const question = node === undefined ? undefined : findQuestion(node.messages);
    if (
      node === undefined ||
      answer === undefined ||
      question === undefined ||
      !canAttemptNodeSummary(node)
    ) {
      return;
    }

    const profile = this.runtime.getProfile();
    const model = this.runtime.getModel();
    this.tabs.updateConversation(input.tabId, (conversation) =>
      markNodeSummaryPending(conversation, {
        nodeId: input.nodeId,
        now: this.runtime.now(),
        providerProfileId: profile.id,
        modelId: model
      })
    );

    try {
      await this.runtime.persistPending?.(input.tabId);
      const pendingTab = this.tabs.getTab(input.tabId);
      const pendingNode = pendingTab?.conversation.nodes[input.nodeId];
      const pendingAnswer = pendingNode?.messages.find(
        (message) => message.id === input.answerMessageId
      );
      const pendingQuestion = pendingNode === undefined
        ? undefined
        : findQuestion(pendingNode.messages);
      if (
        pendingTab === undefined ||
        pendingTab.conversationId !== input.conversationId ||
        pendingNode === undefined ||
        pendingAnswer === undefined ||
        pendingQuestion === undefined
      ) {
        return;
      }
      const parentTitle = pendingNode.parentId === null
        ? undefined
        : pendingTab.conversation.nodes[pendingNode.parentId]?.title;
      const prompt = buildNodeSummaryPrompt({
        ...(parentTitle === undefined ? {} : { parentTitle }),
        question: pendingQuestion,
        answer: pendingAnswer
      });
      const adapter = this.providers.get(profile);
      const request = adapter.buildRequest(
        {
          messages: prompt.messages,
          model,
          stream: false,
          webSearchEnabled: false,
          maxOutputTokens: 64,
          thinkingEnabled: false
        },
        profile
      );
      const raw = await this.requests.request(request, signal);
      if (signal.aborted || this.disposed) return;
      const events = adapter.parseBuffered(raw, request);
      let text = "";
      let failed = false;
      for (const event of events) {
        if (event.type === "delta") text += event.text;
        if (event.type === "error") failed = true;
      }
      const cleaned = failed ? undefined : cleanNodeSummaryTitle(text);
      const latest = this.tabs.getTab(input.tabId);
      if (
        latest === undefined ||
        latest.conversationId !== input.conversationId ||
        latest.mode !== "active" ||
        latest.lifecycle !== "idle" ||
        latest.conversation.nodes[input.nodeId] === undefined ||
        signal.aborted ||
        this.disposed
      ) {
        return;
      }
      this.tabs.updateConversation(input.tabId, (conversation) =>
        cleaned === undefined
          ? applyNodeSummaryFailure(conversation, {
              nodeId: input.nodeId,
              now: this.runtime.now()
            })
          : applyNodeSummarySuccess(conversation, {
              nodeId: input.nodeId,
              title: cleaned,
              now: this.runtime.now()
            })
      );
    } catch (error) {
      logWarning(`节点摘要写入失败: ${input.nodeId}`, error);
      if (signal.aborted || this.disposed) return;
      const latest = this.tabs.getTab(input.tabId);
      if (
        latest === undefined ||
        latest.conversationId !== input.conversationId ||
        latest.mode !== "active" ||
        latest.lifecycle !== "idle" ||
        latest.conversation.nodes[input.nodeId] === undefined
      ) {
        return;
      }
      this.tabs.updateConversation(input.tabId, (conversation) =>
        applyNodeSummaryFailure(conversation, {
          nodeId: input.nodeId,
          now: this.runtime.now()
        })
      );
    }
  }
}
