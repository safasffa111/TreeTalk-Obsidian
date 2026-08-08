import type { ConversationFile } from "../domain/types";
import type { ConversationTabsStore } from "./conversation-tabs-store";

export interface FolderRenamePort {
  renameFolder(oldFolder: string, newFolder: string): void;
}

export function openConversationTab(
  store: ConversationTabsStore,
  folder: string,
  conversation: ConversationFile
): string {
  return store.open({
    id: conversation.id,
    conversationId: conversation.id,
    folder,
    title: conversation.title,
    mode: conversation.status,
    lifecycle: "idle",
    unread: false,
    requestEpoch: 0,
    conversation
  });
}

export function selectAdjacentTab(
  store: ConversationTabsStore,
  direction: -1 | 1
): void {
  const state = store.getSnapshot();
  if (state.orderedTabIds.length === 0) return;
  const currentIndex =
    state.activeTabId === null
      ? 0
      : state.orderedTabIds.indexOf(state.activeTabId);
  const nextIndex =
    (currentIndex + direction + state.orderedTabIds.length) %
    state.orderedTabIds.length;
  const nextTabId = state.orderedTabIds[nextIndex];
  if (nextTabId !== undefined) store.select(nextTabId);
}

export function updateTabsForRename(
  store: ConversationTabsStore,
  persistence: FolderRenamePort,
  oldPath: string,
  newPath: string
): number {
  let changed = 0;
  for (const tabId of store.getSnapshot().orderedTabIds) {
    const tab = store.getTab(tabId);
    if (
      tab === undefined ||
      (tab.folder !== oldPath && !tab.folder.startsWith(`${oldPath}/`))
    ) {
      continue;
    }
    const previousFolder = tab.folder;
    const renamedFolder = `${newPath}${previousFolder.slice(oldPath.length)}`;
    persistence.renameFolder(previousFolder, renamedFolder);
    store.updateTab(tabId, (current) => ({
      ...current,
      folder: renamedFolder
    }));
    changed += 1;
  }
  return changed;
}
