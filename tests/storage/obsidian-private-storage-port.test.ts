import { describe, expect, it } from "vitest";
import {
  ObsidianPrivateStoragePort,
  type PrivateDataAdapter
} from "../../src/storage/obsidian-private-storage-port";

class MemoryDataAdapter implements PrivateDataAdapter {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>([""]);

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path) || this.folders.has(path));
  }

  read(path: string): Promise<string> {
    const value = this.files.get(path);
    return value === undefined
      ? Promise.reject(new Error(`Missing file: ${path}`))
      : Promise.resolve(value);
  }

  write(path: string, content: string): Promise<void> {
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (!this.folders.has(parent)) {
      return Promise.reject(new Error(`Missing parent: ${parent}`));
    }
    this.files.set(path, content);
    return Promise.resolve();
  }

  async process(path: string, update: (content: string) => string): Promise<string> {
    const next = update(await this.read(path));
    this.files.set(path, next);
    return next;
  }

  remove(path: string): Promise<void> {
    if (!this.files.delete(path)) {
      return Promise.reject(new Error(`Missing file: ${path}`));
    }
    return Promise.resolve();
  }

  rmdir(path: string, recursive: boolean): Promise<void> {
    if (!recursive || !this.folders.has(path)) {
      return Promise.reject(new Error(`Missing folder: ${path}`));
    }
    for (const file of [...this.files.keys()]) {
      if (file.startsWith(`${path}/`)) this.files.delete(file);
    }
    for (const folder of [...this.folders]) {
      if (folder === path || folder.startsWith(`${path}/`)) {
        this.folders.delete(folder);
      }
    }
    return Promise.resolve();
  }

  mkdir(path: string): Promise<void> {
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (!this.folders.has(parent)) {
      return Promise.reject(new Error(`Missing parent: ${parent}`));
    }
    this.folders.add(path);
    return Promise.resolve();
  }

  list(path: string): Promise<{ files: string[]; folders: string[] }> {
    if (!this.folders.has(path)) {
      return Promise.reject(new Error(`Missing folder: ${path}`));
    }
    const prefix = path.length === 0 ? "" : `${path}/`;
    const direct = (candidate: string): boolean => {
      const remainder = candidate.slice(prefix.length);
      return candidate.startsWith(prefix) && !remainder.includes("/");
    };
    return Promise.resolve({
      files: [...this.files.keys()].filter(direct).sort(),
      folders: [...this.folders].filter((folder) => folder !== path && direct(folder)).sort()
    });
  }

  rename(source: string, destination: string): Promise<void> {
    if (!this.folders.has(source)) {
      return Promise.reject(new Error(`Missing folder: ${source}`));
    }
    if (this.folders.has(destination) || this.files.has(destination)) {
      return Promise.reject(new Error(`Destination exists: ${destination}`));
    }
    const folders = [...this.folders].filter(
      (folder) => folder === source || folder.startsWith(`${source}/`)
    );
    const files = [...this.files.entries()].filter(([path]) =>
      path.startsWith(`${source}/`)
    );
    for (const folder of folders) this.folders.delete(folder);
    for (const [path] of files) this.files.delete(path);
    for (const folder of folders) {
      this.folders.add(`${destination}${folder.slice(source.length)}`);
    }
    for (const [path, content] of files) {
      this.files.set(`${destination}${path.slice(source.length)}`, content);
    }
    return Promise.resolve();
  }
}

describe("ObsidianPrivateStoragePort", () => {
  it("creates private parent folders before writing", async () => {
    const adapter = new MemoryDataAdapter();
    const port = new ObsidianPrivateStoragePort(adapter);

    await port.write(".obsidian/treetalk-data/active/one/tree.json", "{}");

    expect([...adapter.folders]).toEqual([
      "",
      ".obsidian",
      ".obsidian/treetalk-data",
      ".obsidian/treetalk-data/active",
      ".obsidian/treetalk-data/active/one"
    ]);
    expect(await port.read(".obsidian/treetalk-data/active/one/tree.json")).toBe("{}");
  });

  it("processes and safely removes files", async () => {
    const adapter = new MemoryDataAdapter();
    const port = new ObsidianPrivateStoragePort(adapter);
    const path = ".obsidian/treetalk-data/active/one/tree.json";
    await port.write(path, "old");

    await port.process(path, (content) => `${content}-new`);
    await port.remove(".obsidian/treetalk-data/active/one/missing.json");

    expect(await port.read(path)).toBe("old-new");
  });

  it("recursively lists files below a private root", async () => {
    const adapter = new MemoryDataAdapter();
    const port = new ObsidianPrivateStoragePort(adapter);
    await port.write(".obsidian/treetalk-data/active/one/tree.json", "one");
    await port.write(".obsidian/treetalk-data/active/two/nested/data.json", "two");

    expect(await port.list(".obsidian/treetalk-data/active")).toEqual([
      ".obsidian/treetalk-data/active/one/tree.json",
      ".obsidian/treetalk-data/active/two/nested/data.json"
    ]);
  });

  it("moves a complete conversation folder and rejects occupied destinations", async () => {
    const adapter = new MemoryDataAdapter();
    const port = new ObsidianPrivateStoragePort(adapter);
    const source = ".obsidian/treetalk-data/active/one";
    const destination = ".obsidian/treetalk-data/history/one";
    await port.write(`${source}/tree.json`, "one");

    await port.move(source, destination);

    expect(await port.exists(source)).toBe(false);
    expect(await port.read(`${destination}/tree.json`)).toBe("one");
    await expect(port.move(destination, destination)).rejects.toThrow(
      "Destination already exists"
    );
  });

  it("removes a private conversation folder recursively and ignores a missing folder", async () => {
    const adapter = new MemoryDataAdapter();
    const port = new ObsidianPrivateStoragePort(adapter);
    const folder = ".obsidian/treetalk-data/history/one";
    await port.write(`${folder}/tree.json`, "one");
    await port.write(`${folder}/nested/backup.json`, "backup");

    await port.removeFolder(folder);
    await port.removeFolder(folder);

    expect(await port.exists(folder)).toBe(false);
    expect(
      [...adapter.files.keys()].some((path) => path.startsWith(folder))
    ).toBe(false);
  });
});
