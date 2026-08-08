import { describe, expect, it, vi } from "vitest";
import { ConversationTabsStore } from "../../src/tabs/conversation-tabs-store";
import {
  conversationTab,
  conversationTabsStore
} from "../helpers/tab-fixtures";

describe("ConversationTabsStore", () => {
  it("deduplicates conversations and keeps the first tab identity", () => {
    const store = new ConversationTabsStore();
    store.open(conversationTab("one", "TCP"));
    store.open(conversationTab("one", "TCP duplicate"));

    expect(store.getSnapshot().orderedTabIds).toEqual(["one"]);
    expect(store.getSnapshot().activeTabId).toBe("one");
    expect(store.getTab("one")?.title).toBe("TCP");
  });

  it("selects the right neighbor when the active tab is removed", () => {
    const store = conversationTabsStore("one", "two", "three");
    store.select("two");
    store.remove("two");

    expect(store.getSnapshot().activeTabId).toBe("three");
  });

  it("falls back to the left neighbor and then an empty workspace", () => {
    const store = conversationTabsStore("one", "two");
    store.select("two");
    store.remove("two");
    expect(store.getSnapshot().activeTabId).toBe("one");
    store.remove("one");
    expect(store.getSnapshot().activeTabId).toBeNull();
  });

  it("updates a hidden tab without changing the active tab", () => {
    const store = conversationTabsStore("one", "two");
    store.select("one");
    store.updateConversation("two", (conversation) => ({
      ...structuredClone(conversation),
      title: "Updated hidden tab"
    }));

    expect(store.getTab("two")?.conversation.title).toBe("Updated hidden tab");
    expect(store.getSnapshot().activeTabId).toBe("one");
  });

  it("reorders tabs and notifies subscribers", () => {
    const store = conversationTabsStore("one", "two", "three");
    const listener = vi.fn();
    store.subscribe(listener);

    store.reorder("three", 0);

    expect(store.getSnapshot().orderedTabIds).toEqual(["three", "one", "two"]);
    expect(listener).toHaveBeenCalledOnce();
  });
});
