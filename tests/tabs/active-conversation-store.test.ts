import { describe, expect, it, vi } from "vitest";
import { ActiveConversationStore } from "../../src/tabs/active-conversation-store";
import { conversationTabsStore } from "../helpers/tab-fixtures";

describe("ActiveConversationStore", () => {
  it("exposes the selected conversation and follows tab switches", () => {
    const tabsStore = conversationTabsStore("one", "two");
    const active = new ActiveConversationStore(tabsStore);

    expect(active.getSnapshot()?.id).toBe("one");
    tabsStore.select("two");
    expect(active.getSnapshot()?.id).toBe("two");
  });

  it("returns undefined after the final tab closes", () => {
    const tabsStore = conversationTabsStore("one");
    const active = new ActiveConversationStore(tabsStore);
    tabsStore.remove("one");

    expect(active.getSnapshot()).toBeUndefined();
  });

  it("updates and selects nodes only in the active tab", () => {
    const tabsStore = conversationTabsStore("one", "two");
    const active = new ActiveConversationStore(tabsStore);
    active.selectNode("root");
    active.update((conversation) => ({
      ...structuredClone(conversation),
      title: "Only one"
    }));

    expect(tabsStore.getTab("one")?.conversation.currentNodeId).toBe("root");
    expect(tabsStore.getTab("one")?.conversation.title).toBe("Only one");
    expect(tabsStore.getTab("two")?.conversation.title).toBe("two");
  });

  it("forwards workspace notifications", () => {
    const tabsStore = conversationTabsStore("one", "two");
    const active = new ActiveConversationStore(tabsStore);
    const listener = vi.fn();
    active.subscribe(listener);

    tabsStore.select("two");

    expect(listener).toHaveBeenCalledOnce();
  });

  it("does not notify the active view when only a hidden tab changes", () => {
    const tabsStore = conversationTabsStore("one", "two");
    const active = new ActiveConversationStore(tabsStore);
    const listener = vi.fn();
    active.subscribe(listener);

    tabsStore.updateConversation("two", (conversation) => ({
      ...structuredClone(conversation),
      revision: conversation.revision + 1
    }));

    expect(listener).not.toHaveBeenCalled();
  });

  it("checkpoints graph positions into the owning hidden conversation", () => {
    const tabsStore = conversationTabsStore("one", "two");
    const active = new ActiveConversationStore(tabsStore);
    tabsStore.select("two");
    const listener = vi.fn();
    active.subscribe(listener);

    active.checkpointGraphPositions("one", {
      "conversation:root": { x: 321, y: 123, fixed: false }
    });

    expect(
      tabsStore.getTab("one")?.conversation.depositGraphState
        ?.nodePositions["conversation:root"]
    ).toEqual({ x: 321, y: 123, fixed: false });
    expect(
      tabsStore.getTab("two")?.conversation.depositGraphState
        ?.nodePositions["conversation:root"]
    ).not.toEqual({ x: 321, y: 123, fixed: false });
    expect(listener).not.toHaveBeenCalled();
  });

  it("notifies and becomes immutable when the active tab begins closing", () => {
    const tabsStore = conversationTabsStore("one");
    const active = new ActiveConversationStore(tabsStore);
    const listener = vi.fn();
    active.subscribe(listener);

    tabsStore.updateTab("one", (tab) => ({
      ...tab,
      lifecycle: "closing",
      requestEpoch: tab.requestEpoch + 1
    }));

    expect(listener).toHaveBeenCalledOnce();
    expect(active.canMutate()).toBe(false);
    expect(() =>
      active.update((conversation) => ({
        ...structuredClone(conversation),
        revision: conversation.revision + 1
      }))
    ).toThrow("read-only");
  });

  it("allows branch navigation while lifecycle work keeps mutations locked", () => {
    const tabsStore = conversationTabsStore("one");
    const active = new ActiveConversationStore(tabsStore);
    tabsStore.updateTab("one", (tab) => ({
      ...tab,
      lifecycle: "restoring"
    }));

    active.selectNode("root");

    expect(active.getSnapshot()?.currentNodeId).toBe("root");
    expect(active.canMutate()).toBe(false);
  });
});
