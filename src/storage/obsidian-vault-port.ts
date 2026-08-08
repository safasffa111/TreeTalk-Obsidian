import {
  normalizePath,
  TFile,
  type FileManager,
  type Vault
} from "obsidian";
import type { VaultPort } from "./conversation-repository";
import { logWarning } from "../utils/error-log";

async function ensureFolder(vault: Vault, path: string): Promise<void> {
  const pieces = normalizePath(path).split("/");
  let current = "";
  for (const piece of pieces) {
    current = current.length === 0 ? piece : `${current}/${piece}`;
    if (vault.getAbstractFileByPath(current) === null) {
      await vault.createFolder(current);
    }
  }
}


async function listAdapterFiles(
  vault: Vault,
  prefix: string
): Promise<string[]> {
  const normalized = normalizePath(prefix).replace(/\/+$/u, "");
  const excludedRoots = new Set([
    normalizePath(vault.configDir),
    ".git",
    ".trash"
  ]);
  const files: string[] = [];
  const queue = [normalized];
  while (queue.length > 0) {
    const folder = queue.shift();
    if (folder === undefined) continue;
    let listed: Awaited<ReturnType<Vault["adapter"]["list"]>>;
    try {
      listed = await vault.adapter.list(folder);
    } catch (error) {
      logWarning(`列举目录失败: ${folder}`, error);
      continue;
    }
    files.push(...listed.files.map((path) => normalizePath(path)));
    for (const child of listed.folders.map((path) => normalizePath(path))) {
      const root = child.split("/")[0] ?? child;
      if (excludedRoots.has(child) || excludedRoots.has(root)) continue;
      queue.push(child);
    }
  }
  return [...new Set(files)].sort();
}

export class ObsidianVaultPort implements VaultPort {
  constructor(
    private readonly vault: Vault,
    private readonly fileManager?: Pick<FileManager, "renameFile">
  ) {}

  async exists(path: string): Promise<boolean> {
    const normalized = normalizePath(path);
    if (this.vault.getAbstractFileByPath(normalized) !== null) return true;
    return this.vault.adapter.exists(normalized);
  }

  async read(path: string): Promise<string> {
    const normalized = normalizePath(path);
    const file = this.vault.getAbstractFileByPath(normalized);
    if (file instanceof TFile) return this.vault.read(file);
    if (await this.vault.adapter.exists(normalized)) {
      return this.vault.adapter.read(normalized);
    }
    throw new Error(`File not found: ${path}`);
  }

  async write(path: string, content: string): Promise<void> {
    const normalized = normalizePath(path);
    const existing = this.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFile) {
      await this.vault.modify(existing, content);
      return;
    }
    const slash = normalized.lastIndexOf("/");
    if (slash > 0) await ensureFolder(this.vault, normalized.slice(0, slash));
    const fileName = normalized.slice(slash + 1);
    if (fileName.startsWith(".") || (await this.vault.adapter.exists(normalized))) {
      await this.vault.adapter.write(normalized, content);
      return;
    }
    await this.vault.create(normalized, content);
  }

  async process(path: string, update: (content: string) => string): Promise<void> {
    const normalized = normalizePath(path);
    const file = this.vault.getAbstractFileByPath(normalized);
    if (file instanceof TFile) {
      await this.vault.process(file, update);
      return;
    }
    if (!(await this.vault.adapter.exists(normalized))) {
      throw new Error(`File not found: ${path}`);
    }
    await this.vault.adapter.process(normalized, update);
  }

  async remove(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const file = this.vault.getAbstractFileByPath(normalized);
    if (file !== null) {
      await this.vault.delete(file);
      return;
    }
    if (await this.vault.adapter.exists(normalized)) {
      await this.vault.adapter.remove(normalized);
    }
  }

  list(prefix: string): Promise<string[]> {
    const normalized = normalizePath(prefix).replace(/\/+$/u, "");
    const directoryPrefix = normalized.length === 0 ? "" : `${normalized}/`;
    return Promise.resolve(
      this.vault
        .getFiles()
        .map((file) => file.path)
        .filter((path) => path.startsWith(directoryPrefix))
        .sort()
    );
  }

  listAll(prefix: string): Promise<string[]> {
    return listAdapterFiles(this.vault, prefix);
  }

  async move(source: string, destination: string): Promise<void> {
    const normalizedSource = normalizePath(source);
    const normalizedDestination = normalizePath(destination);
    const target = this.vault.getAbstractFileByPath(normalizedSource);
    if (target === null) throw new Error(`Folder not found: ${source}`);
    if (this.fileManager === undefined) {
      throw new Error("FileManager is required for link-safe folder moves");
    }
    const slash = normalizedDestination.lastIndexOf("/");
    if (slash > 0) await ensureFolder(this.vault, normalizedDestination.slice(0, slash));
    if (this.vault.getAbstractFileByPath(normalizedDestination) !== null) {
      throw new Error(`Destination already exists: ${destination}`);
    }
    await this.fileManager.renameFile(target, normalizedDestination);
  }
}
