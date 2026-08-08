import { describe, expect, it } from "vitest";
import type { AssistantResponseInput } from "../../src/domain/assistant-response";
import { TabResponseRouter } from "../../src/tabs/tab-response-router";
import { conversationTabsStore } from "../helpers/tab-fixtures";

function answer(content: string): AssistantResponseInput {
  return {
    conversationId: "two",
    nodeId: "child",
    messageId: `answer-${content}`,
    content,
    modelId: "test-model",
    now: "2026-07-29T12:00:00.000Z"
  };
}

describe("TabResponseRouter", () => {
  it("writes a hidden-tab reply to the originating tab and marks it unread", () => {
    const tabsStore = conversationTabsStore("one", "two");
    const router = new TabResponseRouter(tabsStore);
    const ticket = router.capture("two", "child");

    tabsStore.select("one");
    router.append(ticket, answer("hidden"));

    const messages =
      tabsStore.getTab("two")?.conversation.nodes.child?.messages ?? [];
    expect(messages.at(-1)?.content).toBe("hidden");
    expect(tabsStore.getTab("two")?.unread).toBe(true);
    expect(tabsStore.getSnapshot().activeTabId).toBe("one");
  });

  it("rejects a reply after the originating tab begins closing", () => {
    const tabsStore = conversationTabsStore("one");
    const router = new TabResponseRouter(tabsStore);
    const ticket = router.capture("one", "child");
    tabsStore.updateTab("one", (tab) => ({
      ...tab,
      lifecycle: "closing",
      requestEpoch: tab.requestEpoch + 1
    }));

    expect(() =>
      router.append(ticket, {
        ...answer("late"),
        conversationId: "one"
      })
    ).toThrow("stale");
  });

  it("does not invalidate a ticket when another tab is selected", () => {
    const tabsStore = conversationTabsStore("one", "two");
    const router = new TabResponseRouter(tabsStore);
    const ticket = router.capture("one", "child");

    tabsStore.select("two");

    expect(() =>
      router.append(ticket, {
        ...answer("still valid"),
        conversationId: "one"
      })
    ).not.toThrow();
  });

  it("routes streaming deltas to the captured background node", () => {
    const tabsStore = conversationTabsStore("one", "two");
    const router = new TabResponseRouter(tabsStore);
    const ticket = router.capture("two", "child");
    router.start(ticket, {
      conversationId: "two",
      nodeId: "child",
      messageId: "stream",
      modelId: "test-model",
      now: "2026-07-29T12:00:00.000Z"
    });
    tabsStore.select("one");

    router.delta(ticket, {
      conversationId: "two",
      nodeId: "child",
      messageId: "stream",
      delta: "background",
      now: "2026-07-29T12:00:01.000Z"
    });
    router.finish(ticket, {
      conversationId: "two",
      nodeId: "child",
      messageId: "stream",
      status: "complete",
      now: "2026-07-29T12:00:02.000Z"
    });

    expect(
      tabsStore.getTab("two")?.conversation.nodes.child?.messages.at(-1)
    ).toMatchObject({
      content: "background",
      status: "complete"
    });
    expect(tabsStore.getTab("two")?.unread).toBe(true);
    expect(tabsStore.getSnapshot().activeTabId).toBe("one");
  });
});
