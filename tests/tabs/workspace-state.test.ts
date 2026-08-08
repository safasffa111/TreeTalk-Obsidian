import { describe, expect, it } from "vitest";
import {
  parseTabsWorkspaceData,
  restoreTabsWorkspace,
  serializeTabsWorkspace,
  type RestoredTabDescriptor,
  type TabsWorkspaceData
} from "../../src/tabs/workspace-state";
import {
  conversationTab,
  conversationTabsStore
} from "../helpers/tab-fixtures";

describe("tabs workspace state", () => {
  it("parses a valid ordered workspace and rejects duplicate IDs", () => {
    expect(
      parseTabsWorkspaceData({
        schemaVersion: 1,
        activeConversationId: "two",
        openConversationIds: ["one", "two"]
      })
    ).toEqual({
      schemaVersion: 1,
      activeConversationId: "two",
      openConversationIds: ["one", "two"]
    });
    expect(() =>
      parseTabsWorkspaceData({
        schemaVersion: 1,
        activeConversationId: "one",
        openConversationIds: ["one", "one"]
      })
    ).toThrow("duplicate");
  });

  it("serializes tab order and active conversation without conversation data", () => {
    const store = conversationTabsStore("one", "two");
    store.select("two");

    expect(serializeTabsWorkspace(store.getSnapshot())).toEqual({
      schemaVersion: 1,
      activeConversationId: "two",
      openConversationIds: ["one", "two"]
    });
  });

  it("falls back to the first valid restored tab when the active entry is missing", async () => {
    const data: TabsWorkspaceData = {
      schemaVersion: 1,
      activeConversationId: "missing",
      openConversationIds: ["one", "missing"]
    };
    const one = conversationTab("one");
    const loader = (
      conversationId: string
    ): Promise<RestoredTabDescriptor | undefined> =>
      Promise.resolve(
        conversationId === "one"
          ? {
              conversationId: "one",
              folder: one.folder,
              conversation: one.conversation
            }
          : undefined
      );

    const restored = await restoreTabsWorkspace(data, loader);

    expect(restored.activeConversationId).toBe("one");
    expect(restored.tabs.map((tab) => tab.conversationId)).toEqual(["one"]);
  });

  it("preserves archived mode and the saved active tab when both load", async () => {
    const active = conversationTab("one");
    const archived = conversationTab("two", "History", "archived");
    const descriptors = new Map<string, RestoredTabDescriptor>([
      [
        "one",
        {
          conversationId: "one",
          folder: active.folder,
          conversation: active.conversation
        }
      ],
      [
        "two",
        {
          conversationId: "two",
          folder: archived.folder,
          conversation: archived.conversation
        }
      ]
    ]);

    const restored = await restoreTabsWorkspace(
      {
        schemaVersion: 1,
        activeConversationId: "two",
        openConversationIds: ["one", "two"]
      },
      (id) => Promise.resolve(descriptors.get(id))
    );

    expect(restored.activeConversationId).toBe("two");
    expect(restored.tabs[1]?.mode).toBe("archived");
  });
});
