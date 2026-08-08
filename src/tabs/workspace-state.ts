import { parseConversation } from "../domain/schema";
import type { ConversationFile } from "../domain/types";
import type { ConversationTab, ConversationTabsState } from "./types";
import { logWarning } from "../utils/error-log";

export interface TabsWorkspaceData {
  schemaVersion: 1;
  activeConversationId: string | null;
  openConversationIds: string[];
}

export interface RestoredTabDescriptor {
  conversationId: string;
  folder: string;
  conversation: ConversationFile;
}

export interface RestoredTabsWorkspace {
  activeConversationId: string | null;
  tabs: ConversationTab[];
}

export type WorkspaceTabLoader = (
  conversationId: string
) => Promise<RestoredTabDescriptor | undefined>;

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Tabs workspace data must be an object");
  }
  return value as Record<string, unknown>;
}

export function parseTabsWorkspaceData(value: unknown): TabsWorkspaceData {
  const source = requireObject(value);
  if (source.schemaVersion !== 1) {
    throw new TypeError("Unsupported tabs workspace schema");
  }
  if (
    source.activeConversationId !== null &&
    typeof source.activeConversationId !== "string"
  ) {
    throw new TypeError("activeConversationId must be a string or null");
  }
  if (
    !Array.isArray(source.openConversationIds) ||
    source.openConversationIds.some((id) => typeof id !== "string")
  ) {
    throw new TypeError("openConversationIds must be a string array");
  }
  const openConversationIds = source.openConversationIds as string[];
  if (new Set(openConversationIds).size !== openConversationIds.length) {
    throw new TypeError("openConversationIds contains duplicate IDs");
  }
  return {
    schemaVersion: 1,
    activeConversationId: source.activeConversationId,
    openConversationIds: [...openConversationIds]
  };
}

export function serializeTabsWorkspace(
  state: ConversationTabsState
): TabsWorkspaceData {
  const activeTab =
    state.activeTabId === null ? undefined : state.tabs[state.activeTabId];
  return {
    schemaVersion: 1,
    activeConversationId: activeTab?.conversationId ?? null,
    openConversationIds: state.orderedTabIds.flatMap((tabId) => {
      const tab = state.tabs[tabId];
      return tab === undefined ? [] : [tab.conversationId];
    })
  };
}

export async function restoreTabsWorkspace(
  data: TabsWorkspaceData,
  load: WorkspaceTabLoader
): Promise<RestoredTabsWorkspace> {
  const parsed = parseTabsWorkspaceData(data);
  const tabs: ConversationTab[] = [];
  for (const conversationId of parsed.openConversationIds) {
    try {
      const descriptor = await load(conversationId);
      if (
        descriptor === undefined ||
        descriptor.conversationId !== conversationId
      ) {
        continue;
      }
      const conversation = parseConversation(descriptor.conversation);
      if (conversation.id !== conversationId) continue;
      tabs.push({
        id: conversationId,
        conversationId,
        folder: descriptor.folder,
        title: conversation.title,
        mode: conversation.status,
        lifecycle: "idle",
        unread: false,
        requestEpoch: 0,
        conversation
      });
    } catch (error) {
      logWarning(`恢复打开标签失败: ${conversationId}`, error);
      // Missing or corrupt conversations remain untouched in the Vault.
    }
  }
  const restoredIds = new Set(tabs.map((tab) => tab.conversationId));
  return {
    activeConversationId:
      parsed.activeConversationId !== null &&
      restoredIds.has(parsed.activeConversationId)
        ? parsed.activeConversationId
        : tabs[0]?.conversationId ?? null,
    tabs
  };
}
