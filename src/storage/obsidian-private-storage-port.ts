import { normalizePath, type DataAdapter } from "obsidian";
import type { FolderMovePort } from "../archive/archive-service";
import type { VaultPort } from "./conversation-repository";

export type PrivateDataAdapter = Pick<
  DataAdapter,
  | "exists"
  | "read"
  | "write"
  | "process"
  | "remove"
  | "rmdir"
  | "mkdir"
  | "list"
  | "rename"
>;

export interface FolderDeletePort {
  removeFolder(path: string): Promise<void>;
}

function parentDirectory(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

async function ensureFolder(adapter: PrivateDataAdapter, path: string): Promise<void> {
  const normalized = normalizePath(path);
  if (normalized.length === 0) return;
  const pieces = normalized.split("/");
  let current = "";
  for (const piece of pieces) {
    current = current.length === 0 ? piece : `${current}/${piece}`;
    if (!(await adapter.exists(current))) {
      await adapter.mkdir(current);
    }
  }
}

export class ObsidianPrivateStoragePort
  implements VaultPort, FolderMovePort, FolderDeletePort
{
  constructor(private readonly adapter: PrivateDataAdapter) {}

  exists(path: string): Promise<boolean> {
    return this.adapter.exists(normalizePath(path));
  }

  read(path: string): Promise<string> {
    return this.adapter.read(normalizePath(path));
  }

  async write(path: string, content: string): Promise<void> {
    const normalized = normalizePath(path);
    await ensureFolder(this.adapter, parentDirectory(normalized));
    await this.adapter.write(normalized, content);
  }

  async process(path: string, update: (content: string) => string): Promise<void> {
    await this.adapter.process(normalizePath(path), update);
  }

  async remove(path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (await this.adapter.exists(normalized)) {
      await this.adapter.remove(normalized);
    }
  }

  async list(prefix: string): Promise<string[]> {
    const root = normalizePath(prefix).replace(/\/+$/u, "");
    if (!(await this.adapter.exists(root))) return [];

    const files: string[] = [];
    const visit = async (folder: string): Promise<void> => {
      const listed = await this.adapter.list(folder);
      files.push(...listed.files);
      for (const child of listed.folders) {
        await visit(child);
      }
    };
    await visit(root);
    return files.sort();
  }

  async move(source: string, destination: string): Promise<void> {
    const normalizedSource = normalizePath(source);
    const normalizedDestination = normalizePath(destination);
    if (await this.adapter.exists(normalizedDestination)) {
      throw new Error(`Destination already exists: ${destination}`);
    }
    if (!(await this.adapter.exists(normalizedSource))) {
      throw new Error(`Folder not found: ${source}`);
    }
    await ensureFolder(this.adapter, parentDirectory(normalizedDestination));
    await this.adapter.rename(normalizedSource, normalizedDestination);
  }

  async removeFolder(path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (await this.adapter.exists(normalized)) {
      await this.adapter.rmdir(normalized, true);
    }
  }
}
