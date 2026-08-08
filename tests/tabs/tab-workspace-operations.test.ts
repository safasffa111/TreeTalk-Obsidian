import { describe, expect, it, vi } from "vitest";
import {
  openConversationTab,
  selectAdjacentTab,
  updateTabsForRename
} from "../../src/tabs/tab-workspace-operations";
import { conversationTab, conversationTabsStore } from "../helpers/tab-fixtures";

describe("tab workspace operations", () => {
  it("opens one deduplicated tab for the same conversation", () => {
    const store = conversationTabsStore();
    const tab = conversationTab("one");

    openConversationTab(store, tab.folder, tab.conversation);
    openConversationTab(store, "TreeTalk/历史对话/duplicate", tab.conversation);

    expect(store.getSnapshot().orderedTabIds).toEqual(["one"]);
    expect(store.getSnapshot().activeTabId).toBe("one");
  });

  it("cycles through tabs in both directions", () => {
    const store = conversationTabsStore("one", "two", "three");

    selectAdjacentTab(store, -1);
    expect(store.getSnapshot().activeTabId).toBe("three");
    selectAdjacentTab(store, 1);
    expect(store.getSnapshot().activeTabId).toBe("one");
  });

  it("updates only matching folder paths after a native rename", () => {
    const store = conversationTabsStore("one", "two");
    store.updateTab("one", (tab) => ({
      ...tab,
      folder: "TreeTalk/活动对话/one"
    }));
    store.updateTab("two", (tab) => ({
      ...tab,
      folder: "TreeTalk/活动对话/two"
    }));
    const renameFolder = vi.fn();

    const changed = updateTabsForRename(
      store,
      { renameFolder },
      "TreeTalk/活动对话/one",
      "TreeTalk/活动对话/renamed"
    );

    expect(changed).toBe(1);
    expect(store.getTab("one")?.folder).toBe(
      "TreeTalk/活动对话/renamed"
    );
    expect(store.getTab("two")?.folder).toBe("TreeTalk/活动对话/two");
    expect(renameFolder).toHaveBeenCalledWith(
      "TreeTalk/活动对话/one",
      "TreeTalk/活动对话/renamed"
    );
  });
});
