import { describe, expect, it, vi } from "vitest";
import { ObsidianVaultPort } from "../../src/storage/obsidian-vault-port";

describe("ObsidianVaultPort.list", () => {
  it("adds a directory boundary when callers omit the trailing slash", async () => {
    const vault = {
      getFiles: vi.fn(() => [
        { path: "TreeTalk/历史对话/one/tree.json" },
        { path: "TreeTalk/历史对话-old/two/tree.json" }
      ])
    };
    const port = new ObsidianVaultPort(vault as never);
    expect(await port.list("TreeTalk/历史对话")).toEqual([
      "TreeTalk/历史对话/one/tree.json"
    ]);
  });
});

describe("ObsidianVaultPort.move", () => {
  it("uses FileManager so Obsidian can update links during a folder move", async () => {
    const source = { path: "TreeTalk/活动对话/one" };
    const vault = {
      getAbstractFileByPath: vi.fn((path: string) =>
        path === source.path || path === "TreeTalk/历史对话" ? source : null
      ),
      createFolder: vi.fn(),
      getFiles: vi.fn(() => [])
    };
    const fileManager = {
      renameFile: vi.fn(() => Promise.resolve())
    };
    const port = new ObsidianVaultPort(vault as never, fileManager);

    await port.move(source.path, "TreeTalk/历史对话/one");

    expect(fileManager.renameFile).toHaveBeenCalledWith(
      source,
      "TreeTalk/历史对话/one"
    );
  });

  it("checks the final destination again before renaming", async () => {
    const source = { path: "TreeTalk/活动对话/one" };
    const destination = { path: "TreeTalk/历史对话/one" };
    const vault = {
      getAbstractFileByPath: vi.fn((path: string) => {
        if (path === source.path) return source;
        if (path === destination.path) return destination;
        if (path === "TreeTalk/历史对话") return {};
        return null;
      }),
      createFolder: vi.fn(),
      getFiles: vi.fn(() => [])
    };
    const fileManager = {
      renameFile: vi.fn(() => Promise.resolve())
    };
    const port = new ObsidianVaultPort(vault as never, fileManager);

    await expect(port.move(source.path, destination.path)).rejects.toThrow(
      "Destination already exists"
    );
    expect(fileManager.renameFile).not.toHaveBeenCalled();
  });
});


describe("ObsidianVaultPort hidden files", () => {
  it("reads, writes, and lists dotfiles through the Adapter API", async () => {
    const hiddenPath = "TreeTalk/snapshot/.treetalk-archive.md";
    const adapter = {
      exists: vi.fn((path: string) => Promise.resolve(path === hiddenPath)),
      read: vi.fn(() => Promise.resolve("archive")),
      write: vi.fn(() => Promise.resolve()),
      process: vi.fn(() => Promise.resolve("updated")),
      remove: vi.fn(() => Promise.resolve()),
      list: vi.fn((path: string) => {
        if (path === "") return Promise.resolve({ files: [], folders: ["TreeTalk"] });
        if (path === "TreeTalk") {
          return Promise.resolve({ files: [], folders: ["TreeTalk/snapshot"] });
        }
        if (path === "TreeTalk/snapshot") {
          return Promise.resolve({ files: [hiddenPath], folders: [] });
        }
        return Promise.resolve({ files: [], folders: [] });
      })
    };
    const vault = {
      configDir: ".obsidian",
      adapter,
      getAbstractFileByPath: vi.fn(() => null),
      getFiles: vi.fn(() => []),
      createFolder: vi.fn(() => Promise.resolve()),
      create: vi.fn(() => Promise.resolve()),
      modify: vi.fn(() => Promise.resolve()),
      read: vi.fn(() => Promise.resolve("")),
      process: vi.fn(() => Promise.resolve()),
      delete: vi.fn(() => Promise.resolve())
    };
    const port = new ObsidianVaultPort(vault as never);

    await expect(port.read(hiddenPath)).resolves.toBe("archive");
    await port.write(hiddenPath, "updated");
    expect(adapter.write).toHaveBeenCalledWith(hiddenPath, "updated");
    await expect(port.listAll("")).resolves.toContain(hiddenPath);
  });
});
