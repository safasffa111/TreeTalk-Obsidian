import { describe, expect, it, vi } from "vitest";
import { HistoryDeleteService } from "../../src/history/history-delete-service";
import { HistoryIndex, type HistoryEntry } from "../../src/history/history-index";
import { checksumConversation } from "../../src/storage/checksum";
import { privateConversationRoots } from "../../src/storage/private-paths";
import { validConversation } from "../fixtures";
import { FakeVault } from "../storage/fake-vault";

async function historical(id: string): Promise<string> {
  const conversation = structuredClone(validConversation());
  conversation.id = id;
  conversation.title = id.toUpperCase();
  conversation.status = "archived";
  conversation.checksum = await checksumConversation(conversation);
  return JSON.stringify(conversation);
}

describe("HistoryDeleteService", () => {
  it("deletes the private folder, rebuilds the index, and closes an open history view", async () => {
    const roots = privateConversationRoots(".obsidian");
    const oneFolder = `${roots.history}/one`;
    const twoFolder = `${roots.history}/two`;
    const vault = new FakeVault({
      [`${oneFolder}/tree.json`]: await historical("one"),
      [`${twoFolder}/tree.json`]: await historical("two")
    });
    const index = new HistoryIndex(vault, roots.history);
    await index.rebuild();
    const removeFolder = vi.fn(async (folder: string) => {
      for (const path of vault.paths()) {
        if (path.startsWith(`${folder}/`)) await vault.remove(path);
      }
    });
    const closeOpenHistory = vi.fn(() => Promise.resolve());
    const service = new HistoryDeleteService(
      { removeFolder },
      index,
      closeOpenHistory
    );
    const entry = index.entries().find((item) => item.id === "one");
    if (entry === undefined) throw new Error("History entry is missing");

    await expect(service.delete(entry)).resolves.toMatchObject([
      { id: "two" }
    ]);
    expect(removeFolder).toHaveBeenCalledWith(oneFolder);
    expect(closeOpenHistory).toHaveBeenCalledWith("one");
  });

  it("keeps the indexed entry when private storage deletion fails", async () => {
    const roots = privateConversationRoots(".obsidian");
    const folder = `${roots.history}/one`;
    const vault = new FakeVault({
      [`${folder}/tree.json`]: await historical("one")
    });
    const index = new HistoryIndex(vault, roots.history);
    await index.rebuild();
    const entry = index.entries()[0] as HistoryEntry;
    const service = new HistoryDeleteService(
      {
        removeFolder: () => Promise.reject(new Error("disk failure"))
      },
      index,
      vi.fn(() => Promise.resolve())
    );

    await expect(service.delete(entry)).rejects.toThrow("disk failure");
    expect(index.entries()).toMatchObject([{ id: "one" }]);
  });

  it("reports deletion as applied when post-delete index or tab cleanup fails", async () => {
    const roots = privateConversationRoots(".obsidian");
    const folder = `${roots.history}/one`;
    const vault = new FakeVault({
      [`${folder}/tree.json`]: await historical("one")
    });
    const index = new HistoryIndex(vault, roots.history);
    await index.rebuild();
    const entry = index.entries()[0] as HistoryEntry;
    const cleanupErrors: unknown[] = [];
    const service = new HistoryDeleteService(
      {
        removeFolder: async (target) => {
          for (const path of vault.paths()) {
            if (path.startsWith(`${target}/`)) await vault.remove(path);
          }
        }
      },
      index,
      () => Promise.resolve(),
      (errors) => cleanupErrors.push(...errors)
    );
    vi.spyOn(index, "rebuild").mockRejectedValueOnce(
      new Error("index refresh failed")
    );

    await expect(service.delete(entry)).resolves.toEqual([]);
    expect(index.entries()).toEqual([]);
    expect(cleanupErrors).toHaveLength(1);
  });

  it("closes an open history tab before deleting its private folder", async () => {
    const roots = privateConversationRoots(".obsidian");
    const folder = `${roots.history}/one`;
    const vault = new FakeVault({
      [`${folder}/tree.json`]: await historical("one")
    });
    const index = new HistoryIndex(vault, roots.history);
    await index.rebuild();
    const entry = index.entries()[0] as HistoryEntry;
    const removeFolder = vi.fn(() => Promise.resolve());
    const service = new HistoryDeleteService(
      { removeFolder },
      index,
      () => Promise.reject(new Error("tab close failed"))
    );

    await expect(service.delete(entry)).rejects.toThrow("tab close failed");
    expect(removeFolder).not.toHaveBeenCalled();
    expect(index.entries()).toMatchObject([{ id: "one" }]);
  });
});
