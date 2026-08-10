import { describe, expect, it } from "vitest";
import { observeActiveTabLeaves } from "../../src/storage/tabs-persistence-observer";
import {
  conversationTab,
  conversationTabsStore
} from "../helpers/tab-fixtures";

describe("observeActiveTabLeaves", () => {
  it("reports only real active-tab departures and stops after unsubscribe", () => {
    const tabs = conversationTabsStore("one", "two");
    const leftTabIds: string[] = [];
    const unsubscribe = observeActiveTabLeaves(
      tabs,
      (tabId) => leftTabIds.push(tabId)
    );

    tabs.select("two");
    expect(leftTabIds).toEqual(["one"]);

    tabs.updateConversation("two", (conversation) => ({
      ...structuredClone(conversation),
      title: "updated without leaving"
    }));
    expect(leftTabIds).toEqual(["one"]);

    tabs.remove("one");
    tabs.remove("two");
    expect(leftTabIds).toEqual(["one", "two"]);

    unsubscribe();
    tabs.open(conversationTab("three"));
    tabs.open(conversationTab("four"));
    expect(leftTabIds).toEqual(["one", "two"]);
  });
});
