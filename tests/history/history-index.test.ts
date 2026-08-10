import { describe, expect, it, vi } from "vitest";
import { validConversation } from "../fixtures";
import { checksumConversation } from "../../src/storage/checksum";
import { HistoryIndex } from "../../src/history/history-index";
import { privateConversationRoots } from "../../src/storage/private-paths";
import { FakeVault } from "../storage/fake-vault";
import type { ConversationFile } from "../../src/domain/types";

async function historicalConversation(
  id: string,
  title: string,
  updatedAt = validConversation().updatedAt
): Promise<ConversationFile> {
  const conversation = structuredClone(validConversation());
  conversation.id = id;
  conversation.title = title;
  conversation.status = "archived";
  conversation.updatedAt = updatedAt;
  conversation.checksum = await checksumConversation(conversation);
  return conversation;
}

async function historical(id: string, title: string): Promise<string> {
  return JSON.stringify(await historicalConversation(id, title));
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

  it("reuses entries when the canonical path inventory is unchanged", async () => {
    const roots = privateConversationRoots(".obsidian");
    const vault = new FakeVault({
      [`${roots.history}/one/tree.json`]: await historical("one", "One")
    });
    const read = vi.spyOn(vault, "read");
    const list = vi.spyOn(vault, "list");
    const index = new HistoryIndex(vault, roots.history);

    await index.ensureFresh();
    await index.ensureFresh();

    expect(list).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(1);
    expect(index.entries()).toMatchObject([{ id: "one" }]);
  });

  it("rebuilds when canonical history paths are added or removed", async () => {
    const roots = privateConversationRoots(".obsidian");
    const onePath = `${roots.history}/one/tree.json`;
    const twoPath = `${roots.history}/two/tree.json`;
    const vault = new FakeVault({
      [onePath]: await historical("one", "One")
    });
    const read = vi.spyOn(vault, "read");
    const index = new HistoryIndex(vault, roots.history);

    await index.ensureFresh();
    expect(read).toHaveBeenCalledTimes(1);

    await vault.write(twoPath, await historical("two", "Two"));
    await index.ensureFresh();
    expect(index.entries().map((entry) => entry.id).sort()).toEqual([
      "one",
      "two"
    ]);
    expect(read).toHaveBeenCalledTimes(3);

    await vault.remove(onePath);
    await index.ensureFresh();
    expect(index.entries().map((entry) => entry.id)).toEqual(["two"]);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("updates entries and known paths through upsert and remove", async () => {
    const roots = privateConversationRoots(".obsidian");
    const onePath = `${roots.history}/one/tree.json`;
    const twoPath = `${roots.history}/two/tree.json`;
    const vault = new FakeVault({
      [onePath]: await historical("one", "One")
    });
    const read = vi.spyOn(vault, "read");
    const index = new HistoryIndex(vault, roots.history);
    await index.ensureFresh();
    const two = await historicalConversation(
      "two",
      "Two",
      "2026-08-10T12:00:00.000Z"
    );
    await vault.write(twoPath, JSON.stringify(two));

    index.upsert(`${roots.history}/two`, two);

    expect(index.entries().map((entry) => entry.id)).toEqual(["two", "one"]);
    await index.ensureFresh();
    expect(read).toHaveBeenCalledTimes(1);

    index.remove("two");
    await vault.remove(twoPath);
    await index.ensureFresh();
    expect(index.entries().map((entry) => entry.id)).toEqual(["one"]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("replaces an existing ID path and rejects active conversations", async () => {
    const roots = privateConversationRoots(".obsidian");
    const oldFolder = `${roots.history}/one`;
    const newFolder = `${roots.history}/renamed`;
    const vault = new FakeVault({
      [`${oldFolder}/tree.json`]: await historical("one", "One")
    });
    const read = vi.spyOn(vault, "read");
    const index = new HistoryIndex(vault, roots.history);
    await index.ensureFresh();
    const renamed = await historicalConversation("one", "Renamed");
    await vault.move(oldFolder, newFolder);

    index.upsert(newFolder, renamed);
    await index.ensureFresh();

    expect(index.entries()).toMatchObject([
      { id: "one", title: "Renamed", folder: newFolder }
    ]);
    expect(read).toHaveBeenCalledTimes(1);

    const active = structuredClone(renamed);
    active.status = "active";
    expect(() => index.upsert(newFolder, active)).toThrow(
      "History index accepts archived conversations only"
    );
  });

  it("does not treat a pre-initialization upsert as a complete index", async () => {
    const roots = privateConversationRoots(".obsidian");
    const two = await historicalConversation("two", "Two");
    const vault = new FakeVault({
      [`${roots.history}/one/tree.json`]: await historical("one", "One"),
      [`${roots.history}/two/tree.json`]: JSON.stringify(two)
    });
    const read = vi.spyOn(vault, "read");
    const index = new HistoryIndex(vault, roots.history);

    index.upsert(`${roots.history}/two`, two);
    await index.ensureFresh();

    expect(index.entries().map((entry) => entry.id).sort()).toEqual([
      "one",
      "two"
    ]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("shares an in-flight ensureFresh refresh", async () => {
    const roots = privateConversationRoots(".obsidian");
    const vault = new FakeVault({
      [`${roots.history}/one/tree.json`]: await historical("one", "One")
    });
    const originalList = vault.list.bind(vault);
    let releaseList: (() => void) | undefined;
    const list = vi.spyOn(vault, "list").mockImplementationOnce(
      async (prefix) => {
        await new Promise<void>((resolve) => {
          releaseList = resolve;
        });
        return originalList(prefix);
      }
    );
    const index = new HistoryIndex(vault, roots.history);

    const first = index.ensureFresh();
    const second = index.ensureFresh();
    expect(list).toHaveBeenCalledTimes(1);
    if (releaseList === undefined) throw new Error("List release is missing");
    releaseList();
    await Promise.all([first, second]);

    expect(index.entries()).toMatchObject([{ id: "one" }]);
  });

  it("loads at most four canonical files concurrently", async () => {
    const roots = privateConversationRoots(".obsidian");
    const initial: Record<string, string> = {};
    for (let index = 0; index < 8; index += 1) {
      initial[`${roots.history}/${index}/tree.json`] = await historical(
        `${index}`,
        `Conversation ${index}`
      );
    }
    const vault = new FakeVault(initial);
    const originalRead = vault.read.bind(vault);
    const releases: Array<() => void> = [];
    let activeReads = 0;
    let maximumActiveReads = 0;
    vi.spyOn(vault, "read").mockImplementation(async (path) => {
      activeReads += 1;
      maximumActiveReads = Math.max(maximumActiveReads, activeReads);
      await new Promise<void>((resolve) => releases.push(resolve));
      activeReads -= 1;
      return originalRead(path);
    });
    const index = new HistoryIndex(vault, roots.history);

    const rebuilding = index.rebuild();
    await vi.waitFor(() => expect(activeReads).toBe(4));
    expect(maximumActiveReads).toBe(4);

    for (let completed = 0; completed < 8; completed += 1) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
      const release = releases.shift();
      if (release === undefined) throw new Error("Missing read release");
      release();
    }
    await rebuilding;

    expect(maximumActiveReads).toBe(4);
    expect(index.entries()).toHaveLength(8);
  });
});
