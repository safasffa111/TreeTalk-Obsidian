import type { ConversationFile, DepositGraphPosition } from "../domain/types";
import { setRelationshipNodePositions } from "../relationship-graph/state";
import type { ConversationTabsStore } from "./conversation-tabs-store";
import type { TabMode } from "./types";

export type ConversationStoreChange =
  | { kind: "full" }
  | { kind: "message-delta"; nodeId: string; messageId: string };
export type ConversationStoreListener = (
  change?: ConversationStoreChange
) => void;
export type ConversationStoreUpdater = (
  conversation: ConversationFile
) => ConversationFile;

export interface ConversationStorePort {
  getSnapshot(): ConversationFile | undefined;
  subscribe(listener: ConversationStoreListener): () => void;
  update(updater: ConversationStoreUpdater): void;
  selectNode(nodeId: string): void;
  checkpointGraphPositions?(
    conversationId: string,
    positions: Record<string, DepositGraphPosition>
  ): void;
  canMutate?(): boolean;
  getMode?(): TabMode | undefined;
}

export class ActiveConversationStore implements ConversationStorePort {
  constructor(private readonly tabs: ConversationTabsStore) {}

  getSnapshot(): ConversationFile | undefined {
    return this.tabs.getActiveTab()?.conversation;
  }

  subscribe(listener: ConversationStoreListener): () => void {
    let previous = this.tabs.getActiveTab();
    return this.tabs.subscribe((change) => {
      const next = this.tabs.getActiveTab();
      if (next === previous) return;
      const previousTab = previous;
      previous = next;
      if (
        change.kind === "message-delta" &&
        previousTab?.id === change.tabId &&
        next?.id === change.tabId
      ) {
        listener({
          kind: "message-delta",
          nodeId: change.nodeId,
          messageId: change.messageId
        });
        return;
      }
      listener({ kind: "full" });
    });
  }

  getMode(): TabMode | undefined {
    return this.tabs.getActiveTab()?.mode;
  }

  canMutate(): boolean {
    const tab = this.tabs.getActiveTab();
    return (
      tab !== undefined &&
      tab.mode === "active" &&
      tab.lifecycle === "idle"
    );
  }

  update(updater: ConversationStoreUpdater): void {
    const tab = this.requireMutableActiveTab();
    this.tabs.updateConversation(tab.id, updater);
  }

  selectNode(nodeId: string): void {
    const tab = this.tabs.getActiveTab();
    if (tab === undefined) throw new Error("No active conversation tab");
    if (tab.conversation.nodes[nodeId] === undefined) {
      throw new Error(`Node not found: ${nodeId}`);
    }
    this.tabs.updateConversation(tab.id, (current) => ({
      ...structuredClone(current),
      currentNodeId: nodeId
    }));
  }

  checkpointGraphPositions(
    conversationId: string,
    positions: Record<string, DepositGraphPosition>
  ): void {
    const tab = Object.values(this.tabs.getSnapshot().tabs).find(
      (candidate) => candidate.conversationId === conversationId
    );
    if (tab === undefined || tab.mode !== "active") return;
    this.tabs.updateConversation(tab.id, (conversation) => ({
      ...structuredClone(conversation),
      revision: conversation.revision + 1,
      updatedAt: new Date().toISOString(),
      depositGraphState: setRelationshipNodePositions(
        conversation.depositGraphState,
        positions
      )
    }));
  }

  private requireMutableActiveTab() {
    const tab = this.tabs.getActiveTab();
    if (tab === undefined) throw new Error("No active conversation tab");
    if (tab.mode !== "active" || tab.lifecycle !== "idle") {
      throw new Error("Active conversation tab is read-only");
    }
    return tab;
  }

}
