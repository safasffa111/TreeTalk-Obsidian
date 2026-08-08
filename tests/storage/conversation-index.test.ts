import { describe, expect, it } from "vitest";
import { checksumConversation } from "../../src/storage/checksum";
import { ConversationIndex } from "../../src/storage/conversation-index";
import { validConversation } from "../fixtures";
import { FakeVault } from "./fake-vault";

async function serialized(id: string): Promise<string> {
  const value = structuredClone(validConversation());
  value.id = id;
  value.checksum = await checksumConversation(value);
  return JSON.stringify(value);
}

describe("ConversationIndex", () => {
  it("rebuilds from canonical conversation files and ignores backups", async () => {
    const vault = new FakeVault({
      "TreeTalk/活动对话/one/tree.json": await serialized("one"),
      "TreeTalk/活动对话/one/tree.backup.json": await serialized("old-one"),
      "TreeTalk/历史对话/two/tree.json": await serialized("two"),
      "Other/tree.json": await serialized("outside")
    });
    const index = new ConversationIndex(vault, "TreeTalk");

    await index.rebuild();

    expect(index.resolve("one")).toBe("TreeTalk/活动对话/one");
    expect(index.resolve("two")).toBe("TreeTalk/历史对话/two");
    expect(index.resolve("outside")).toBeUndefined();
  });

  it("updates a known folder after a Vault rename event", async () => {
    const vault = new FakeVault({
      "TreeTalk/活动对话/one/tree.json": await serialized("one")
    });
    const index = new ConversationIndex(vault, "TreeTalk");
    await index.rebuild();

    index.onRename("TreeTalk/活动对话/one", "TreeTalk/活动对话/renamed");

    expect(index.resolve("one")).toBe("TreeTalk/活动对话/renamed");
  });
});
