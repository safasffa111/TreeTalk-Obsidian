import type { ConversationTabsStore } from "../tabs/conversation-tabs-store";

export function observeActiveTabLeaves(
  tabs: ConversationTabsStore,
  onLeave: (tabId: string) => void
): () => void {
  let previousActiveTabId = tabs.getSnapshot().activeTabId;
  return tabs.subscribe(() => {
    const nextActiveTabId = tabs.getSnapshot().activeTabId;
    if (nextActiveTabId === previousActiveTabId) return;
    const leavingTabId = previousActiveTabId;
    previousActiveTabId = nextActiveTabId;
    if (leavingTabId !== null) onLeave(leavingTabId);
  });
}
