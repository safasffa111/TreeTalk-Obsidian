import { describe, expect, it } from "vitest";
import { validConversation } from "../fixtures";
import { checksumConversation } from "../../src/storage/checksum";
import { HistoryIndex } from "../../src/history/history-index";
import { privateConversationRoots } from "../../src/storage/private-paths";
import { FakeVault } from "../storage/fake-vault";

async function historical(id: string, title: string): Promise<string> {
  const conversation = structuredClone(validConversation());
  conversation.id = id;
  conversation.title = title;
  conversation.status = "archived";
  conversation.checksum = await checksumConversation(conversation);
  return JSON.stringify(conversation);
}

describe("HistoryIndex", () => {
  it("indexes only canonical archived conversations under the history root", async () => {
    const roots = privateConversationRoots(".obsidian");
    const vault = new FakeVault({
      [`${roots.history}/one/tree.json`]: await historical("one", "TCP"),
      [`${roots.history}/one/tree.backup.json`]: await historical("old", "Old"),
      [`${roots.history}/group/nested/tree.json`]: await historical("nested", "Nested"),
      [`${roots.history}/tree.json`]: await historical("root", "Root"),
      [`${roots.active}/two/tree.json`]: await historical("two", "Active path"),
      "Other/tree.json": await historical("outside", "Outside")
    });
    const index = new HistoryIndex(vault, roots.history);

    await index.rebuild();

    expect(index.entries()).toEqual([
      {
        id: "one",
        title: "TCP",
        folder: `${roots.history}/one`,
        updatedAt: validConversation().updatedAt
      }
    ]);
  });

  it("returns defensive entry copies", async () => {
    const roots = privateConversationRoots(".obsidian");
    const vault = new FakeVault({
      [`${roots.history}/one/tree.json`]: await historical("one", "TCP")
    });
    const index = new HistoryIndex(vault, roots.history);
    await index.rebuild();
    const entries = index.entries();
    const first = entries[0];
    if (first === undefined) throw new Error("History entry is missing");
    first.title = "mutated";
    expect(index.entries()[0]?.title).toBe("TCP");
  });
});
