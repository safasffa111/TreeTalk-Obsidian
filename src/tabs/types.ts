import type { ConversationFile } from "../domain/types";

export type TabMode = "active" | "archived";
export type TabLifecycle = "idle" | "closing" | "restoring";

export interface ConversationTab {
  id: string;
  conversationId: string;
  folder: string;
  title: string;
  mode: TabMode;
  lifecycle: TabLifecycle;
  unread: boolean;
  requestEpoch: number;
  conversation: ConversationFile;
}

export interface ConversationTabsState {
  schemaVersion: 1;
  activeTabId: string | null;
  orderedTabIds: string[];
  tabs: Record<string, ConversationTab>;
}
