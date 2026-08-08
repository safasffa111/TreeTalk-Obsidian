import { parseConversation } from "../domain/schema";
import type { ConversationFile } from "../domain/types";
import type {
  ConversationTab,
  ConversationTabsState
} from "./types";

export type TabsListener = () => void;
export type TabUpdater = (tab: ConversationTab) => ConversationTab;
export type ConversationUpdater = (
  conversation: ConversationFile
) => ConversationFile;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeTab(tab: ConversationTab): ConversationTab {
  const conversation = parseConversation(structuredClone(tab.conversation));
  if (tab.id.length === 0 || tab.conversationId.length === 0) {
    throw new Error("Tab identity cannot be empty");
  }
  if (conversation.id !== tab.conversationId) {
    throw new Error("Tab conversation ID does not match its conversation");
  }
  if (
    (tab.mode === "active" && conversation.status !== "active") ||
    (tab.mode === "archived" && conversation.status !== "archived")
  ) {
    throw new Error("Tab mode does not match conversation status");
  }
  return deepFreeze({
    ...structuredClone(tab),
    title: tab.title.trim().length > 0 ? tab.title : conversation.title,
    conversation
  });
}

function emptyState(): ConversationTabsState {
  return deepFreeze({
    schemaVersion: 1,
    activeTabId: null,
    orderedTabIds: [],
    tabs: {}
  });
}

function validateState(state: ConversationTabsState): void {
  if (new Set(state.orderedTabIds).size !== state.orderedTabIds.length) {
    throw new Error("Tab order contains duplicate IDs");
  }
  const tabIds = Object.keys(state.tabs);
  if (
    tabIds.length !== state.orderedTabIds.length ||
    tabIds.some((tabId) => !state.orderedTabIds.includes(tabId))
  ) {
    throw new Error("Tab order does not match the tabs record");
  }
  if (
    state.activeTabId !== null &&
    state.tabs[state.activeTabId] === undefined
  ) {
    throw new Error("Active tab does not exist");
  }
}

export class ConversationTabsStore {
  private state = emptyState();
  private readonly listeners = new Set<TabsListener>();

  getSnapshot(): ConversationTabsState {
    return this.state;
  }

  getTab(tabId: string): ConversationTab | undefined {
    return this.state.tabs[tabId];
  }

  getActiveTab(): ConversationTab | undefined {
    return this.state.activeTabId === null
      ? undefined
      : this.state.tabs[this.state.activeTabId];
  }

  subscribe(listener: TabsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  open(tab: ConversationTab): string {
    const existing = Object.values(this.state.tabs).find(
      (entry) => entry.conversationId === tab.conversationId
    );
    if (existing !== undefined) {
      this.select(existing.id);
      return existing.id;
    }
    const normalized = normalizeTab(tab);
    if (this.state.tabs[normalized.id] !== undefined) {
      throw new Error(`Tab already exists: ${normalized.id}`);
    }
    this.replace({
      ...structuredClone(this.state),
      activeTabId: normalized.id,
      orderedTabIds: [...this.state.orderedTabIds, normalized.id],
      tabs: { ...this.state.tabs, [normalized.id]: normalized }
    });
    return normalized.id;
  }

  select(tabId: string): void {
    const selected = this.state.tabs[tabId];
    if (selected === undefined) throw new Error(`Tab not found: ${tabId}`);
    if (this.state.activeTabId === tabId && !selected.unread) return;
    this.replace({
      ...structuredClone(this.state),
      activeTabId: tabId,
      tabs: {
        ...this.state.tabs,
        [tabId]: normalizeTab({ ...structuredClone(selected), unread: false })
      }
    });
  }

  remove(tabId: string): void {
    if (this.state.tabs[tabId] === undefined) {
      throw new Error(`Tab not found: ${tabId}`);
    }
    const previousOrder = this.state.orderedTabIds;
    const removedIndex = previousOrder.indexOf(tabId);
    const orderedTabIds = previousOrder.filter((id) => id !== tabId);
    const tabs = Object.fromEntries(
      Object.entries(this.state.tabs).filter(([id]) => id !== tabId)
    );
    let activeTabId = this.state.activeTabId;
    if (activeTabId === tabId) {
      activeTabId =
        orderedTabIds[removedIndex] ??
        orderedTabIds[removedIndex - 1] ??
        null;
    }
    this.replace({
      schemaVersion: 1,
      activeTabId,
      orderedTabIds,
      tabs
    });
  }

  reorder(tabId: string, targetIndex: number): void {
    const sourceIndex = this.state.orderedTabIds.indexOf(tabId);
    if (sourceIndex < 0) throw new Error(`Tab not found: ${tabId}`);
    const boundedTarget = Math.max(
      0,
      Math.min(Math.trunc(targetIndex), this.state.orderedTabIds.length - 1)
    );
    if (sourceIndex === boundedTarget) return;
    const orderedTabIds = [...this.state.orderedTabIds];
    orderedTabIds.splice(sourceIndex, 1);
    orderedTabIds.splice(boundedTarget, 0, tabId);
    this.replace({ ...structuredClone(this.state), orderedTabIds });
  }

  updateTab(tabId: string, updater: TabUpdater): void {
    const current = this.state.tabs[tabId];
    if (current === undefined) throw new Error(`Tab not found: ${tabId}`);
    const updated = normalizeTab(updater(structuredClone(current)));
    if (updated.id !== tabId || updated.conversationId !== current.conversationId) {
      throw new Error("Tab updater cannot change tab identity");
    }
    this.replace({
      ...structuredClone(this.state),
      tabs: { ...this.state.tabs, [tabId]: updated }
    });
  }

  updateConversation(tabId: string, updater: ConversationUpdater): void {
    this.updateTab(tabId, (tab) => {
      const conversation = parseConversation(updater(tab.conversation));
      return {
        ...tab,
        title: conversation.title,
        mode: conversation.status,
        conversation
      };
    });
  }

  private replace(next: ConversationTabsState): void {
    validateState(next);
    this.state = deepFreeze(structuredClone(next));
    for (const listener of this.listeners) listener();
  }
}
